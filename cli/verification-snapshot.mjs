import { writeFileAtomic } from './atomic-files.mjs';
import { boundedProcessTimings } from './diagnostics.mjs';
import { runProcess } from './execution.mjs';
import { createLifecycleTemporaryDirectory, removeLifecycleTemporaryDirectory } from './lifecycle-resources.mjs';
import { planDriftDiagnostics } from './plan-diagnostics.mjs';
import { findGodot } from './project-config.mjs';
import { ResultClassificationError } from './result-envelope.mjs';
import { pathIsInside } from './safety.mjs';
import { ERROR_PATTERN } from './tool-context.mjs';
import { assertVerificationPlanDigest, canonicalVerificationPlanJson, resolveVerificationPlan } from './verification-plan.mjs';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

function verificationPlanOptions(plan, project = plan.project, outputPath = plan.outputPath) {
  const historicalRetention = resolve(project) === resolve(plan.project)
    ? plan.evidenceBinding.retentionCandidates
    : [];
  return {
    project,
    outputPath,
    timeoutSeconds: plan.timeoutSeconds,
    verificationProfile: plan.verificationProfile,
    invocationIdentity: plan.invocationIdentity,
    retentionCandidateManifest: historicalRetention,
    retentionEffectsMayBeFulfilled: true,
  };
}

export function assertCurrentVerificationPlanForEffect(plan, context) {
  try {
    const current = resolveVerificationPlan(verificationPlanOptions(plan));
    assertVerificationPlanDigest(current, plan.digest);
    return current;
  } catch (error) {
    throw new Error(`Verification Plan changed ${context}: ${error.message}`);
  }
}

export function assertVerificationSnapshotInputs(plan, executionProject) {
  const snapshotPlan = resolveVerificationPlan(verificationPlanOptions(
    plan,
    executionProject,
    join(executionProject, '.gdeck', 'reports', 'verification-snapshot.json'),
  ));
  const expectedUidPaths = new Set((plan.inputs.find((input) => input.kind === 'uid-sidecars')?.files ?? []).map((file) => file.path));
  const comparableInputs = (inputs) => inputs.map((input) => {
    if (input.kind === 'project-tree') {
      const { exclusions: _exclusions, ...fingerprint } = input;
      return fingerprint;
    }
    if (input.kind === 'uid-sidecars') {
      return {
        ...input,
        files: input.files.filter((file) => {
          if (expectedUidPaths.has(file.path)) return true;
          const generatedForPlannedScript = file.path.endsWith('.gd.uid')
            && existsSync(resolve(plan.project, file.path.slice(0, -'.uid'.length)));
          return !generatedForPlannedScript;
        }),
      };
    }
    return input;
  });
  if (canonicalVerificationPlanJson(comparableInputs(snapshotPlan.inputs)) !== canonicalVerificationPlanJson(comparableInputs(plan.inputs))) {
    const error = new ResultClassificationError('plan_drift', 'Verification Plan input changed while preparing the immutable execution snapshot. Nothing was started; invoke verify again.');
    error.planDrift = planDriftDiagnostics(plan, { ...snapshotPlan, inputs: comparableInputs(snapshotPlan.inputs) }, { phase: 'snapshot_validation' });
    throw error;
  }
}

const GODOT_IMPORT_EXTENSIONS = new Set([
  '.bmp', '.dds', '.exr', '.hdr', '.jpeg', '.jpg', '.ktx', '.png', '.svg', '.svgz', '.tga', '.webp',
  '.mp3', '.ogg', '.wav', '.flac', '.ttf', '.otf', '.woff', '.woff2', '.ogv',
  '.dae', '.gltf', '.glb', '.blend', '.obj', '.fbx', '.csv', '.po', '.mo',
]);

export function verificationImportableAssetCount(root) {
  let importableAssets = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relation = relative(root, path).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (!['.godot', '.gdeck'].includes(relation)) visit(path);
        continue;
      }
      if (entry.isFile() && !entry.name.endsWith('.import') && GODOT_IMPORT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        importableAssets += 1;
      }
    }
  };
  visit(root);
  return importableAssets;
}

export function sealableProjectFingerprint(root) {
  const hash = createHash('sha256');
  const visit = (path) => {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error(`Project prepared for sealing contains a symbolic link: ${path}`);
    const relation = relative(root, path).replaceAll('\\', '/');
    if (metadata.isDirectory()) {
      if (relation === '.godot') return;
      hash.update(`directory\0${relation}\0`);
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    if (!metadata.isFile() || path.endsWith('.import')) return;
    const bytes = readFileSync(path);
    hash.update(`file\0${relation}\0${metadata.mode & 0o111 ? 'executable' : 'regular'}\0${bytes.length}\0`);
    hash.update(bytes);
  };
  visit(root);
  return hash.digest('hex');
}

export async function prepareProjectImportsForSealing(root, runtime) {
  if (!runtime?.godot || !Number.isFinite(runtime.timeoutMs) || runtime.timeoutMs <= 0) {
    throw new ResultClassificationError('configuration', 'Godot import preparation requires a bounded executable runtime');
  }
  const projectFile = join(root, 'project.godot');
  if (!existsSync(projectFile)) {
    throw new ResultClassificationError('precondition', 'Godot import preparation requires project.godot in the sealed snapshot');
  }
  const originalProjectGodot = readFileSync(projectFile, 'utf8');
  const importProjectGodot = projectGodotWithoutFlightDeckEditorPlugin(originalProjectGodot);
  let result;
  try {
    if (importProjectGodot !== originalProjectGodot) {
      writeFileAtomic(projectFile, importProjectGodot);
    }
    // Single bounded attempt — never auto-retry or warm up for green.
    result = await runProcess(runtime.godot, ['--headless', '--path', root, '--import'], {
      cwd: root,
      timeoutMs: runtime.timeoutMs,
      phase: 'import_preflight',
      quiet: true,
    });
  } finally {
    writeFileAtomic(projectFile, originalProjectGodot);
  }
  let error;
  if (result.timedOut) error = new ResultClassificationError('timeout', 'Godot import preparation timed out before the project could be sealed', 'process_result');
  else if (result.status === 127) error = new ResultClassificationError('process_spawn', 'Configured Godot process could not be started during bounded import preparation', 'process_result');
  else if (result.status === 125) error = new ResultClassificationError('cleanup_timeout', 'Godot import preparation cleanup exceeded its bounded deadline', 'process_result');
  else if (result.status !== 0 || ERROR_PATTERN.test(result.output)) {
    error = new ResultClassificationError('precondition', 'Godot import preparation failed before the project could be sealed; no verification stage was started');
  }
  if (!error) return boundedProcessTimings(result.timings);
  error.resultPhase = 'import_preflight';
  error.resultDiagnosticOutput = String(result.output ?? '');
  error.resultProcessEvidence = {
    phase: 'import_preflight',
    exitCode: Number(result.status),
    reason: result.reason ?? null,
    timedOut: result.timedOut === true,
    cleanupTimedOut: result.cleanupTimedOut === true,
    outputTruncated: result.outputTruncated === true,
    stdoutBytes: Number(result.supervisor?.stdoutBytes ?? Buffer.byteLength(result.stdout ?? '')),
    stderrBytes: Number(result.supervisor?.stderrBytes ?? Buffer.byteLength(result.stderr ?? '')),
    engineError: ERROR_PATTERN.test(result.output),
    timings: boundedProcessTimings(result.timings),
  };
  throw error;
}

export function setVerificationTreeReadOnly(root) {
  const visit = (path) => {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error(`Verification snapshot contains a symbolic link: ${path}`);
    const relativePath = relative(root, path).replaceAll('\\', '/');
    const isGodotCache = relativePath === '.godot' || relativePath.startsWith('.godot/');
    if (!metadata.isDirectory()) {
      if (isGodotCache || path.endsWith('.import')) chmodSync(path, 0o600);
      else chmodSync(path, metadata.mode & 0o111 ? 0o555 : 0o444);
      return;
    }
    for (const entry of readdirSync(path)) visit(join(path, entry));
    chmodSync(path, isGodotCache ? 0o700 : 0o555);
  };
  visit(root);
}

export function removeVerificationSnapshot(snapshot) {
  if (!snapshot) return;
  removeLifecycleTemporaryDirectory(snapshot.root);
}

export async function createVerificationSnapshot(plan) {
  const timings = { clock: 'monotonic', scope: 'verification_preparation', phases: {} };
  let activePhase = 'snapshot_copy';
  const measure = async (name, action) => {
    activePhase = name;
    const started = process.hrtime.bigint();
    try { return await action(); }
    finally { timings.phases[name] = (timings.phases[name] ?? 0) + Number(process.hrtime.bigint() - started) / 1_000_000; }
  };
  const root = createLifecycleTemporaryDirectory('gdeck-verification-snapshot-');
  const executionProject = join(root, 'project');
  const sourceExclusions = (plan.sourceExclusions ?? []).map((item) => ({
    path: resolve(plan.project, item.path), subtree: item.subtree === true,
  }));
  try {
    await measure('snapshot_copy', () => cpSync(plan.project, executionProject, {
      recursive: true,
      force: true,
      filter: (source) => {
        const relation = relative(plan.project, source);
        if (!relation) return true;
        const parts = relation.split(sep);
        if (['.git', '.godot'].includes(parts[0]) || source.endsWith('.import')) return false;
        if (parts[0] === '.gdeck') return parts.length === 1 || (parts.length === 2 && parts[1] === 'config.json');
        return !sourceExclusions.some((item) => source === item.path || (item.subtree && pathIsInside(item.path, source)));
      },
    }));
    await measure('snapshot_validation', () => assertVerificationSnapshotInputs(plan, executionProject));
    mkdirSync(join(executionProject, '.godot'), { recursive: true });
    const importableAssets = verificationImportableAssetCount(executionProject);
    const runtimeNeedsClassCache = plan.stages.some((stage) => stage.disposition === 'run' && ['unit', 'scenario', 'visual', 'benchmark'].includes(stage.kind));
    if (plan.preparation?.godotImportRequired !== (importableAssets > 0 || runtimeNeedsClassCache)) {
      throw new ResultClassificationError('plan_drift', 'Verification import preparation no longer matches the approved Plan');
    }
    if (plan.preparation.godotImportRequired) {
      const godot = findGodot({ godotPath: plan.preparation.godotPath });
      timings.importProcess = await measure('import', async () => await prepareProjectImportsForSealing(executionProject, { godot, timeoutMs: plan.timeoutMs }));
      await measure('snapshot_validation', () => assertVerificationSnapshotInputs(plan, executionProject));
    }
    await measure('snapshot_seal', () => setVerificationTreeReadOnly(executionProject));
    return { root, project: executionProject, timings };
  } catch (error) {
    error.resultPhase ??= activePhase;
    await measure('snapshot_cleanup', () => removeVerificationSnapshot({ root, project: executionProject }));
    error.resultTimings = timings;
    throw error;
  }
}

const FLIGHT_DECK_EDITOR_PLUGIN = 'res://addons/flight_deck/plugin.cfg';

/** Remove only the Flight Deck Editor plugin entry; keep other plugins / importers / GDExtension. */
function projectGodotWithoutFlightDeckEditorPlugin(source) {
  const enabledPattern = /^enabled=PackedStringArray\((.*)\)$/m;
  const match = source.match(enabledPattern);
  if (!match || !match[1].includes(FLIGHT_DECK_EDITOR_PLUGIN)) return source;
  const items = match[1]
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && item !== `"${FLIGHT_DECK_EDITOR_PLUGIN}"`);
  return source.replace(enabledPattern, `enabled=PackedStringArray(${items.join(', ')})`);
}

