import { createHash } from 'node:crypto';
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync, statSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { pathContainsSymlink, pathIsInside } from './safety.mjs';
import { ResultClassificationError } from './result-envelope.mjs';
import { sourceCategory, planDriftDiagnostics } from './plan-diagnostics.mjs';
export { verificationPlanSummary } from './plan-diagnostics.mjs';
import { resolveEvidenceRetention } from './evidence-retention.mjs';
import {
  canonicalEvidenceJson,
  EVIDENCE_BINDING_SCHEMA_VERSION,
  EVIDENCE_RESOLVER_CONTRACT,
  requireInvocationIdentity,
  verificationEvidencePaths,
} from './evidence-contract.mjs';

const DEFAULT_TIMEOUT_SECONDS = 300;
const VERIFICATION_PROCESS_CLEANUP_MS = 750;
const VERIFICATION_REPORT_PUBLICATION_MS = 5_000;
const GODOT_IMPORT_EXTENSIONS = new Set([
  '.bmp', '.dds', '.exr', '.hdr', '.jpeg', '.jpg', '.ktx', '.png', '.svg', '.svgz', '.tga', '.webp',
  '.mp3', '.ogg', '.wav', '.flac', '.ttf', '.otf', '.woff', '.woff2', '.ogv',
  '.dae', '.gltf', '.glb', '.blend', '.obj', '.fbx', '.csv', '.po', '.mo',
]);
const DEFAULT_PROFILE = Object.freeze({
  description: 'Main project scene', frames: 30, benchmarkWarmupFrames: 60, seed: 42, userArgs: [],
});
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const VERIFICATION_PROFILE_FIELDS = new Set(['description', 'doctor', 'check', 'unit', 'scenarios', 'visuals', 'benchmarks', 'exports']);
const BUDGET_KEYS = new Set([
  'averageFpsGte', 'worstProcessMsLte', 'averageProcessMsLte', 'averagePhysicsMsLte',
  'nodesLte', 'objectsLte', 'active2dObjectsLte', 'staticMemoryMbLte', 'drawCallsLte',
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalVerificationPlanJson(value) {
  return canonicalEvidenceJson(value);
}

function digestValue(value) {
  return createHash('sha256').update(canonicalVerificationPlanJson(value)).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function createObservationBudget(value) {
  if (value === undefined) return null;
  if (!isRecord(value) || !Number.isInteger(value.maxFiles) || value.maxFiles < 1
    || !Number.isInteger(value.maxBytes) || value.maxBytes < 1) {
    throw new Error('Verification Plan observation limits are invalid');
  }
  return { maxFiles: value.maxFiles, maxBytes: value.maxBytes, files: 0, bytes: 0, seen: new Set() };
}

function readPlanFile(path, observation) {
  if (!observation) return readFileSync(path);
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error(`Verification Plan observed a non-file input: ${path}`);
    if (!observation.seen.has(resolve(path))) {
      if (observation.files + 1 > observation.maxFiles) throw new Error('Verification Plan observation file limit exceeded');
      if (observation.bytes + metadata.size > observation.maxBytes) throw new Error('Verification Plan observation byte limit exceeded');
      observation.seen.add(resolve(path));
      observation.files += 1;
      observation.bytes += metadata.size;
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (metadata.dev !== after.dev || metadata.ino !== after.ino || metadata.size !== after.size
      || metadata.mtimeMs !== after.mtimeMs || metadata.ctimeMs !== after.ctimeMs
      || pathAfter.dev !== metadata.dev || pathAfter.ino !== metadata.ino || pathAfter.size !== metadata.size
      || pathAfter.mtimeMs !== metadata.mtimeMs || pathAfter.ctimeMs !== metadata.ctimeMs || pathAfter.isSymbolicLink()) {
      throw new Error(`Verification Plan input changed while it was observed: ${path}`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function requireProject(projectCandidate) {
  const project = resolve(projectCandidate ?? '.');
  const projectFile = join(project, 'project.godot');
  if (!existsSync(projectFile)) throw new Error(`Not a Godot project: ${project}`);
  if (pathContainsSymlink(project, projectFile)) throw new Error(`Godot project file must not contain symbolic links: ${projectFile}`);
  return project;
}

function configPath(project) {
  return join(project, '.gdeck', 'config.json');
}

function loadPlanConfig(project, observation = null) {
  const path = configPath(project);
  if (!existsSync(path)) return { profiles: { default: { ...DEFAULT_PROFILE } } };
  if (pathContainsSymlink(project, path)) throw new Error(`Flight Deck config path must not contain symbolic links: ${path}`);
  let parsed;
  try { parsed = JSON.parse(readPlanFile(path, observation).toString('utf8')); }
  catch (error) { throw new Error(`Invalid Flight Deck config at ${path}: ${error.message}`); }
  if (!isRecord(parsed)) throw new Error(`Invalid Flight Deck config at ${path}: config root must be an object`);
  const profiles = parsed.profiles ?? { default: { ...DEFAULT_PROFILE } };
  if (!isRecord(profiles)) throw new Error('Flight Deck config profiles must be an object');
  return { ...parsed, profiles };
}

function timeoutMs(value) {
  const seconds = Number(value ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout must be a positive number of seconds');
  return Math.max(1, Math.round(seconds * 1000));
}

function fileFingerprint(project, path, kind, observation = null) {
  if (!existsSync(path)) return { kind, path: relative(project, path), state: 'missing' };
  const metadata = statSync(path);
  if (!metadata.isFile()) return { kind, path: relative(project, path), state: 'other' };
  return {
    kind,
    path: relative(project, path),
    state: 'file',
    size: metadata.size,
    sha256: createHash('sha256').update(readPlanFile(path, observation)).digest('hex'),
  };
}

function semanticFingerprint(kind, value) {
  return { kind, state: 'semantic', sha256: digestValue(value) };
}

function projectTreeFingerprint(project, generatedEffects, config, observation = null) {
  const exclusions = [
    { path: join(project, '.git'), subtree: true },
    { path: join(project, '.godot'), subtree: true },
    { path: join(project, '.gdeck'), subtree: true },
    { path: join(project, 'build', 'release-manifest.json'), subtree: false },
    ...generatedEffects
      .filter((effect) => typeof effect?.path === 'string')
      .map((effect) => ({ path: resolve(effect.path), subtree: effect.kind === 'replace-directory' })),
    ...Object.values(isRecord(config.exports?.targets) ? config.exports.targets : {})
      .filter((definition) => isRecord(definition) && typeof definition.path === 'string')
      .map((definition) => ({ path: dirname(resolve(project, definition.path)), subtree: true })),
  ]
    .filter((item) => pathIsInside(project, item.path))
    .filter((item, index, values) => values.findIndex((candidate) => candidate.path === item.path && candidate.subtree === item.subtree) === index)
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : Number(left.subtree) - Number(right.subtree));
  const exclusionAncestors = new Set();
  for (const exclusion of exclusions) {
    let ancestor = dirname(exclusion.path);
    while (pathIsInside(project, ancestor)) {
      exclusionAncestors.add(ancestor);
      ancestor = dirname(ancestor);
    }
  }
  const hash = createHash('sha256');
  const categories = new Map();
  const recordCategory = (path, header, bytes) => {
    const category = sourceCategory(path);
    if (!categories.has(category)) categories.set(category, { category, fileCount: 0, directoryCount: 0, totalBytes: 0, hash: createHash('sha256') });
    const item = categories.get(category);
    item.hash.update(header);
    if (bytes) { item.fileCount += 1; item.totalBytes += bytes.length; item.hash.update(bytes); item.hash.update('\0'); }
    else item.directoryCount += 1;
  };
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  let importableAssetCount = 0;
  const uidFiles = [];
  const visit = (directory) => {
    let descriptor;
    let directoryIdentity;
    if (observation) {
      descriptor = openSync(
        directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
      );
      directoryIdentity = fstatSync(descriptor);
      if (!directoryIdentity.isDirectory()) {
        closeSync(descriptor);
        descriptor = undefined;
        throw new Error(`Verification source tree contains an unsafe directory: ${directory}`);
      }
    }
    try {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relation = relative(project, path);
      if (exclusions.some((item) => path === item.path || (item.subtree && pathIsInside(item.path, path)))) continue;
      if (entry.isSymbolicLink()) throw new Error(`Verification source tree must not contain symbolic links: ${path}`);
      if (entry.isFile() && entry.name.endsWith('.import')) continue;
      if (entry.isFile() && entry.name.endsWith('.uid')) {
        const bytes = readPlanFile(path, observation);
        uidFiles.push({
          path: relation.replaceAll('\\', '/'),
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
        continue;
      }
      if (entry.isDirectory()) {
        if (!exclusionAncestors.has(path)) {
          directoryCount += 1;
          hash.update(`directory\0${relation}\0`);
          recordCategory(relation, `directory\0${relation}\0`);
        }
        visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Verification source tree contains an unsupported entry: ${path}`);
      const metadataBefore = observation ? lstatSync(path) : null;
      const bytes = readPlanFile(path, observation);
      const metadataAfter = observation ? lstatSync(path) : statSync(path);
      if (observation && (metadataBefore.dev !== metadataAfter.dev || metadataBefore.ino !== metadataAfter.ino
        || metadataBefore.size !== metadataAfter.size || metadataBefore.mode !== metadataAfter.mode
        || metadataBefore.mtimeMs !== metadataAfter.mtimeMs || metadataBefore.ctimeMs !== metadataAfter.ctimeMs
        || metadataAfter.isSymbolicLink())) {
        throw new Error(`Verification source tree file changed while it was observed: ${path}`);
      }
      const executable = Boolean(metadataAfter.mode & 0o111);
      if (GODOT_IMPORT_EXTENSIONS.has(extname(entry.name).toLowerCase())) importableAssetCount += 1;
      fileCount += 1;
      totalBytes += bytes.length;
      hash.update(`file\0${relation}\0${bytes.length}\0${executable ? 'x' : '-'}\0`);
      hash.update(bytes);
      hash.update('\0');
      recordCategory(relation, `file\0${relation}\0${bytes.length}\0${executable ? 'x' : '-'}\0`, bytes);
    }
    if (observation) {
      const entriesAfter = readdirSync(directory, { withFileTypes: true })
        .map((entry) => [entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink()])
        .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
      const entriesBefore = entries
        .map((entry) => [entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink()]);
      const descriptorAfter = fstatSync(descriptor);
      const pathAfter = lstatSync(directory);
      if (JSON.stringify(entriesBefore) !== JSON.stringify(entriesAfter)
        || descriptorAfter.dev !== directoryIdentity.dev || descriptorAfter.ino !== directoryIdentity.ino
        || descriptorAfter.mtimeMs !== directoryIdentity.mtimeMs || descriptorAfter.ctimeMs !== directoryIdentity.ctimeMs
        || pathAfter.dev !== directoryIdentity.dev || pathAfter.ino !== directoryIdentity.ino
        || pathAfter.mtimeMs !== directoryIdentity.mtimeMs || pathAfter.ctimeMs !== directoryIdentity.ctimeMs
        || pathAfter.isSymbolicLink()) {
        throw new Error(`Verification source tree directory changed while it was observed: ${directory}`);
      }
    }
    } finally {
      if (Number.isInteger(descriptor)) closeSync(descriptor);
    }
  };
  visit(project);
  return {
    fingerprint: { kind: 'project-tree', state: 'tree', fileCount, directoryCount, totalBytes, sha256: hash.digest('hex'),
      categories: [...categories.values()].sort((a, b) => a.category.localeCompare(b.category))
        .map(({ hash: categoryHash, ...item }) => ({ ...item, sha256: categoryHash.digest('hex') })) },
    uidFingerprint: { kind: 'uid-sidecars', state: 'files', files: uidFiles },
    importableAssetCount,
    exclusions: exclusions.map((item) => ({ path: relative(project, item.path).replaceAll('\\', '/'), subtree: item.subtree })),
  };
}

function discoverNames(directory, extension) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(extension))
    .map((name) => name.slice(0, -extension.length))
    .sort();
}

function discoverTestFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const child = join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith('_test.gd')) files.push(child);
    }
  };
  visit(directory);
  return files.sort();
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...value];
}

function projectTarget(value, label, extension = '') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160) throw new Error(`${label} must be a non-empty target name of at most 160 characters`);
  const name = extension && value.endsWith(extension) ? value.slice(0, -extension.length) : value;
  if (!name || name === '.' || name === '..' || name.startsWith('-') || /[\\/\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`${label} contains an unsafe target name: ${value}`);
  }
  return name;
}

function namedSelector(value, label, discover, extension = '') {
  if (value === undefined) return { mode: 'omitted', values: [] };
  if (value === 'auto') return { mode: 'auto', values: discover() };
  return { mode: 'explicit', values: stringArray(value, label).map((item) => projectTarget(item, label, extension)) };
}

function selectedVerificationConfig(config, requestedName) {
  if (requestedName === undefined || requestedName === null) {
    return { name: null, named: false, verify: config.verify ?? {} };
  }
  if (typeof requestedName !== 'string' || requestedName.length > 100 || !TARGET_PATTERN.test(requestedName)) throw new Error(`Invalid Verification Profile name: ${requestedName}`);
  const profiles = config.verificationProfiles;
  if (!isRecord(profiles)) throw new Error('Verification Profiles are not configured');
  const profile = profiles[requestedName];
  if (!isRecord(profile)) {
    const choices = Object.keys(profiles).join(', ') || '(none)';
    throw new Error(`Unknown Verification Profile "${requestedName}". Available: ${choices}`);
  }
  const unknown = Object.keys(profile).filter((key) => !VERIFICATION_PROFILE_FIELDS.has(key));
  if (unknown.length > 0) throw new Error(`Verification Profile "${requestedName}" contains unknown field(s): ${unknown.join(', ')}`);
  if (profile.description !== undefined && (typeof profile.description !== 'string' || profile.description.length > 500)) {
    throw new Error(`Verification Profile "${requestedName}" description must be a string of at most 500 characters`);
  }
  const { description: _description, ...verify } = profile;
  return { name: requestedName, named: true, verify };
}

function selectedProfile(config, name) {
  const profile = config.profiles?.[name];
  if (!isRecord(profile)) {
    const choices = Object.keys(config.profiles ?? {}).join(', ') || '(none)';
    throw new Error(`Unknown capture profile "${name}". Available: ${choices}`);
  }
  return profile;
}

function userArguments(value, label) {
  const args = value ?? [];
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  if (args.some((argument) => argument.startsWith('--gdeck-fixture-adapter='))) {
    throw new ResultClassificationError('fixture_isolation', 'Fixture adapters must be declared with profile.fixtureAdapter, not userArgs');
  }
  return [...args];
}

function fixtureAdapter(project, profile) {
  const adapter = profile.fixtureAdapter;
  if (adapter === undefined || adapter === null) return '';
  if (typeof adapter !== 'string' || adapter.length === 0) {
    throw new ResultClassificationError('fixture_isolation', 'Profile fixtureAdapter must be a non-empty res://tests/ or res://qa/ .gd path');
  }
  const components = adapter.startsWith('res://') ? adapter.slice('res://'.length).split('/') : [];
  if (!['tests', 'qa'].includes(components[0]) || components.length < 2
    || components.some((component) => !component || component === '.' || component === '..' || component.includes('\\'))
    || !components.at(-1).endsWith('.gd')) {
    throw new ResultClassificationError('fixture_isolation', `Profile fixtureAdapter must be a res://tests/ or res://qa/ .gd path: ${adapter}`);
  }
  const absolute = resolve(project, ...components);
  if (!pathIsInside(project, absolute)) throw new ResultClassificationError('fixture_isolation', `Profile fixtureAdapter escapes the project: ${adapter}`);
  if (pathContainsSymlink(project, absolute)) throw new ResultClassificationError('fixture_isolation', `Profile fixtureAdapter path must not contain symbolic links: ${adapter}`);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new ResultClassificationError('fixture_isolation', `Profile fixtureAdapter file is missing: ${adapter}`);
  const allowedRoot = resolve(project, components[0]);
  if (!existsSync(allowedRoot) || !pathIsInside(realpathSync(allowedRoot), realpathSync(absolute))) {
    throw new ResultClassificationError('fixture_isolation', `Profile fixtureAdapter escapes its test root: ${adapter}`);
  }
  return adapter;
}

function positiveInteger(value, label, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${label} must be a positive integer`);
  return resolved;
}

function nonNegativeInteger(value, label, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) throw new Error(`${label} must be a non-negative integer`);
  return resolved;
}

function finiteNumber(value, label, fallback) {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'number' || !Number.isFinite(resolved)) throw new Error(`${label} must be a finite number`);
  return resolved;
}

function stageReportPath(evidencePaths, kind, target) {
  const targetToken = createHash('sha256').update(`${kind}\0${String(target)}`).digest('hex').slice(0, 24);
  return join(evidencePaths.stageReportRoot, `${kind}-${targetToken}.json`);
}

function reason(code, message, evidence = undefined) {
  return evidence === undefined ? { code, message } : { code, message, evidence };
}

function planStage(stages, value) {
  stages.push({
    id: `stage-${String(stages.length + 1).padStart(3, '0')}`,
    order: stages.length,
    includeInLegacyReport: value.includeInLegacyReport ?? ['run', 'blocked'].includes(value.disposition),
    reportPath: null,
    commandArgs: [],
    generatedEffects: [],
    confirmationEffects: [],
    runtime: null,
    ...value,
  });
}

function scenarioDefinition(project, target, observation = null) {
  const path = join(project, 'qa', 'scenarios', `${target}.json`);
  if (!existsSync(path) || !statSync(path).isFile()) return { path, definition: null };
  if (pathContainsSymlink(project, path)) throw new Error(`Scenario path must not contain symbolic links: ${path}`);
  let definition;
  try { definition = JSON.parse(readPlanFile(path, observation).toString('utf8')); }
  catch (error) { throw new Error(`Invalid scenario at ${path}: ${error.message}`); }
  if (!isRecord(definition)) throw new Error(`Invalid scenario at ${path}: definition must be an object`);
  return { path, definition };
}

function runtimeProfile(project, config, profileName, targetUserArgs = [], overrides = {}) {
  const profile = selectedProfile(config, profileName);
  const profileUserArgs = userArguments(profile.userArgs, `profiles.${profileName}.userArgs`);
  const declaredTargetArgs = userArguments(targetUserArgs, 'scenario userArgs');
  const adapter = fixtureAdapter(project, profile);
  return {
    godotPath: typeof config.godotPath === 'string' ? config.godotPath : '',
    profile: profileName,
    profileUserArgs,
    targetUserArgs: declaredTargetArgs,
    fixtureAdapter: adapter,
    isolateUserData: Boolean(adapter),
    ...overrides,
  };
}

function validateBudgets(value, label, strict = true) {
  const budgets = value ?? {};
  if (!isRecord(budgets)) throw new Error(`${label} must be an object`);
  const result = {};
  for (const [key, limit] of Object.entries(budgets)) {
    if (!BUDGET_KEYS.has(key)) {
      if (strict) throw new Error(`${label} contains unknown budget: ${key}`);
      continue;
    }
    if (typeof limit !== 'number' || !Number.isFinite(limit)) throw new Error(`${label}.${key} must be a finite number`);
    result[key] = limit;
  }
  return result;
}

function exportPlanning(project, config, targets, observation = null) {
  if (targets.length === 0) return { stages: [], confirmationEffects: [], generatedEffects: [], fingerprints: [] };
  const exportsConfig = config.exports;
  const presetsPath = join(project, 'export_presets.cfg');
  const presetsPresent = existsSync(presetsPath) && statSync(presetsPath).isFile();
  if (presetsPresent && pathContainsSymlink(project, presetsPath)) throw new Error(`Export presets path must not contain symbolic links: ${presetsPath}`);
  if (exportsConfig !== undefined && !isRecord(exportsConfig)) throw new Error('Export configuration must be an object');
  if (exportsConfig?.targets !== undefined && !isRecord(exportsConfig.targets)) throw new Error('Export targets configuration must be an object');
  const occupiedOutputs = new Map();
  const directories = [];
  const planned = [];
  for (const target of targets) {
    const definition = exportsConfig?.targets?.[target];
    if (!isRecord(definition)) {
      planned.push({ target, blocked: `Unknown export target: ${target}` });
      continue;
    }
    if (typeof definition.preset !== 'string' || definition.preset.length === 0 || /[\u0000-\u001f\u007f]/.test(definition.preset)) {
      throw new Error(`Export target ${target} preset must be a non-empty string without control characters`);
    }
    if (typeof definition.path !== 'string' || definition.path.length === 0 || /[\u0000-\u001f\u007f]/.test(definition.path)) {
      throw new Error(`Export target ${target} path must be a non-empty string without control characters`);
    }
    const finalOutput = resolve(project, definition.path);
    if (!pathIsInside(project, finalOutput)) throw new Error(`Export output must stay inside the project: ${finalOutput}`);
    if (pathContainsSymlink(project, finalOutput)) throw new Error(`Export output path must not contain symbolic links: ${finalOutput}`);
    const finalDirectory = dirname(finalOutput);
    if (finalDirectory === project) throw new Error(`Export output must use a dedicated subdirectory, not the project root: ${finalOutput}`);
    const outputs = target === 'macos' ? [finalOutput] : [finalOutput, finalOutput.replace(/\.(?:exe|x86_64)$/i, '.pck')];
    const item = { target, definition: { ...definition }, finalOutput, finalDirectory, outputs, blocked: presetsPresent ? '' : 'export_presets.cfg missing. Run gdeck export-init first.' };
    for (const output of outputs) {
      const owner = occupiedOutputs.get(output);
      if (owner) {
        const message = `Export artifact path collides between ${owner.target} and ${target}: ${output}`;
        owner.blocked = message;
        item.blocked = message;
      } else {
        occupiedOutputs.set(output, item);
      }
    }
    directories.push(finalDirectory);
    planned.push(item);
  }
  const uniqueDirectories = [...new Set(directories)];
  for (let left = 0; left < uniqueDirectories.length; left += 1) {
    for (let right = left + 1; right < uniqueDirectories.length; right += 1) {
      if (pathIsInside(uniqueDirectories[left], uniqueDirectories[right]) || pathIsInside(uniqueDirectories[right], uniqueDirectories[left])) {
        throw new Error(`Export directories must not be nested: ${uniqueDirectories[left]} and ${uniqueDirectories[right]}`);
      }
    }
  }
  const manifest = join(project, 'build', 'release-manifest.json');
  if (pathContainsSymlink(project, manifest)) throw new Error(`Release manifest path must not contain symbolic links: ${manifest}`);
  const runnable = planned.filter((item) => !item.blocked);
  const confirmationEffects = [...new Set(runnable.map((item) => item.finalDirectory))].map((path) => {
    const effectTargets = runnable.filter((item) => item.finalDirectory === path).map((item) => item.target);
    return { kind: 'replace-directory', target: effectTargets.join(','), targets: effectTargets, path };
  });
  confirmationEffects.push({ kind: 'replace-file', target: 'release-manifest', targets: ['release-manifest'], path: manifest });
  const generatedEffects = [
    ...runnable.flatMap((item) => item.outputs.map((path) => ({ kind: 'export-artifact', target: item.target, path }))),
    { kind: 'release-manifest', target: 'release-manifest', path: manifest },
  ];
  return {
    stages: planned,
    confirmationEffects,
    generatedEffects,
    fingerprints: [fileFingerprint(project, presetsPath, 'export-presets', observation)],
  };
}

function uniqueEffects(effects) {
  const seen = new Set();
  return effects.filter((effect) => {
    const key = canonicalVerificationPlanJson(effect);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resolveVerificationPlan(options = {}) {
  const project = requireProject(options.project);
  const outputPath = resolve(options.outputPath ?? join(project, '.gdeck', 'reports', 'verify.json'));
  const invocationIdentity = requireInvocationIdentity(options.invocationIdentity);
  const evidencePaths = verificationEvidencePaths(project, outputPath, invocationIdentity);
  const markdownPath = outputPath.replace(/\.json$/i, '.md');
  const diagnosticLogPath = evidencePaths.diagnosticLogPath;
  if (new Set([outputPath, markdownPath, diagnosticLogPath]).size !== 3) throw new Error('Verification report and diagnostic paths must be distinct');
  for (const path of [outputPath, markdownPath, diagnosticLogPath]) {
    if (!pathIsInside(project, path)) throw new Error(`Verification report path must stay inside the project: ${path}`);
    if (pathContainsSymlink(project, path)) throw new Error(`Verification report path must not contain symbolic links: ${path}`);
  }
  const resolvedTimeoutMs = timeoutMs(options.timeoutSeconds);
  const timeoutSeconds = String(resolvedTimeoutMs / 1000);
  const observation = createObservationBudget(options.observationLimits);
  const loadedConfig = loadPlanConfig(project, observation);
  const selection = selectedVerificationConfig(loadedConfig, options.verificationProfile);
  const verify = selection.verify;
  if (!isRecord(verify)) throw new Error(selection.named ? `Verification Profile "${selection.name}" must be an object` : 'verify configuration must be an object');
  const config = { ...loadedConfig, verify };
  delete config.verificationProfiles;
  for (const key of ['doctor', 'check']) {
    if (verify[key] !== undefined && typeof verify[key] !== 'boolean') throw new Error(`${selection.named ? `Verification Profile ${selection.name}` : 'verify'}.${key} must be true, false, or omitted`);
  }
  if (selection.named) {
    if (verify.unit !== undefined && verify.unit !== true && verify.unit !== false && verify.unit !== 'auto') {
      throw new Error(`Verification Profile ${selection.name}.unit must be true, false, "auto", or omitted`);
    }
  } else if (verify.unit !== undefined && typeof verify.unit !== 'boolean') {
    throw new Error('verify.unit must be true, false, or omitted');
  }
  const scenarioSelector = selection.named
    ? namedSelector(verify.scenarios, `Verification Profile ${selection.name}.scenarios`, () => discoverNames(join(project, 'qa', 'scenarios'), '.json'), '.json')
    : verify.scenarios === undefined
      ? { mode: 'auto', values: discoverNames(join(project, 'qa', 'scenarios'), '.json') }
      : { mode: 'explicit', values: stringArray(verify.scenarios, 'verify.scenarios').map((value) => projectTarget(value, 'verify.scenarios', '.json')) };
  const visualSelector = selection.named
    ? namedSelector(verify.visuals, `Verification Profile ${selection.name}.visuals`, () => discoverNames(join(project, 'qa', 'baselines'), '.png'))
    : verify.visuals === undefined
      ? { mode: 'auto', values: discoverNames(join(project, 'qa', 'baselines'), '.png') }
      : { mode: 'explicit', values: stringArray(verify.visuals, 'verify.visuals').map((value) => projectTarget(value, 'verify.visuals')) };
  const benchmarkSelector = verify.benchmarks === undefined
    ? { mode: 'omitted', values: [] }
    : (() => {
      if (!Array.isArray(verify.benchmarks)) throw new Error(`${selection.named ? `Verification Profile ${selection.name}` : 'verify'}.benchmarks must be an array`);
      return { mode: 'explicit', values: [...verify.benchmarks] };
    })();
  const exportSelector = verify.exports === undefined
    ? { mode: 'omitted', values: [] }
    : { mode: 'explicit', values: stringArray(verify.exports, `${selection.named ? `Verification Profile ${selection.name}` : 'verify'}.exports`).map((value) => projectTarget(value, `${selection.named ? `Verification Profile ${selection.name}` : 'verify'}.exports`)) };
  const scenarios = scenarioSelector.values;
  const visuals = visualSelector.values;
  const benchmarks = benchmarkSelector.values;
  const exportTargets = exportSelector.values;
  const stages = [];
  const fingerprints = [
    semanticFingerprint('config', config),
    fileFingerprint(project, join(project, 'project.godot'), 'project', observation),
  ];

  if (selection.named && verify.doctor === undefined) {
    planStage(stages, { kind: 'doctor', target: 'environment', disposition: 'not_configured', includeInLegacyReport: false, reason: reason('not-declared', `Verification Profile ${selection.name} does not declare doctor`) });
  } else {
    planStage(stages, verify.doctor === false
      ? { kind: 'doctor', target: 'environment', disposition: 'skipped', includeInLegacyReport: selection.named, reason: reason('disabled', `${selection.named ? `Verification Profile ${selection.name}` : 'verify'}.doctor is false`) }
      : { kind: 'doctor', target: 'environment', disposition: 'run', reason: reason('enabled', 'Environment diagnostics are enabled'), commandArgs: ['doctor', project, '--json'], runtime: { config } });
  }
  if (selection.named && verify.check === undefined) {
    planStage(stages, { kind: 'check', target: 'GDScript', disposition: 'not_configured', includeInLegacyReport: false, reason: reason('not-declared', `Verification Profile ${selection.name} does not declare check`) });
  } else {
    planStage(stages, verify.check === false
      ? { kind: 'check', target: 'GDScript', disposition: 'skipped', includeInLegacyReport: selection.named, reason: reason('disabled', `${selection.named ? `Verification Profile ${selection.name}` : 'verify'}.check is false`) }
      : { kind: 'check', target: 'GDScript', disposition: 'run', reason: reason('enabled', 'GDScript validation is enabled'), commandArgs: ['check', project], runtime: { godotPath: typeof config.godotPath === 'string' ? config.godotPath : '' } });
  }

  const testsDirectory = join(project, 'tests');
  if (verify.unit !== false && (!selection.named || verify.unit !== undefined) && existsSync(testsDirectory) && pathContainsSymlink(project, testsDirectory)) {
    throw new Error(`Unit test path must not contain symbolic links: ${testsDirectory}`);
  }
  const testFiles = verify.unit === false || (selection.named && verify.unit === undefined) ? [] : discoverTestFiles(testsDirectory);
  fingerprints.push(...testFiles.map((path) => fileFingerprint(project, path, 'unit-test', observation)));
  if (selection.named && verify.unit === undefined) {
    planStage(stages, { kind: 'unit', target: 'logic', disposition: 'not_configured', includeInLegacyReport: false, reason: reason('not-declared', `Verification Profile ${selection.name} does not declare unit`) });
  } else if (verify.unit === true && testFiles.length === 0) {
    planStage(stages, {
      kind: 'unit', target: 'logic', disposition: 'blocked', includeInLegacyReport: true,
      reason: reason('required-tests-missing', existsSync(testsDirectory)
        ? `Required unit tests were not found under: ${testsDirectory}`
        : `Required tests directory is missing: ${testsDirectory}`),
    });
  } else if (verify.unit !== false && testFiles.length > 0) {
    const reportPath = stageReportPath(evidencePaths, 'unit', 'logic');
    planStage(stages, {
      kind: 'unit', target: 'logic', disposition: 'run', reason: reason('discovered', `Discovered ${testFiles.length} unit test file(s)`),
      reportPath, commandArgs: ['unit', project, '--output', reportPath],
      runtime: { godotPath: typeof config.godotPath === 'string' ? config.godotPath : '', testFiles: testFiles.map((path) => relative(project, path)) },
      generatedEffects: [{ kind: 'stage-report', target: 'unit:logic', path: reportPath }],
    });
  } else if (verify.unit === undefined || verify.unit === 'auto') {
    planStage(stages, {
      kind: 'unit', target: 'logic', disposition: 'skipped', includeInLegacyReport: true,
      reason: reason('no-tests-discovered', 'No tests/**/*_test.gd files discovered; unit coverage was not verified.'),
    });
  } else {
    planStage(stages, { kind: 'unit', target: 'logic', disposition: 'skipped', includeInLegacyReport: selection.named, reason: reason('disabled', `${selection.named ? `Verification Profile ${selection.name}` : 'verify'}.unit is false`) });
  }

  if (scenarios.length === 0) {
    const omitted = selection.named && scenarioSelector.mode === 'omitted';
    planStage(stages, {
      kind: 'scenario', target: '*', disposition: omitted || !selection.named ? 'not_configured' : 'skipped',
      includeInLegacyReport: selection.named && !omitted,
      reason: omitted
        ? reason('not-declared', `Verification Profile ${selection.name} does not declare scenarios`)
        : reason(scenarioSelector.mode === 'auto' ? 'auto-none-discovered' : 'explicit-empty', scenarioSelector.mode === 'auto' ? 'Scenario auto-discovery found no targets' : 'Verification Profile explicitly selects no scenarios'),
    });
  }
  for (const target of scenarios) {
    const { path, definition } = scenarioDefinition(project, target, observation);
    if (!definition) {
      planStage(stages, { kind: 'scenario', target, disposition: 'blocked', reason: reason('scenario-missing', `Scenario not found: ${target}`, { path }) });
      continue;
    }
    fingerprints.push(fileFingerprint(project, path, 'scenario', observation));
    const scenarioName = definition.name ?? target;
    if (typeof scenarioName !== 'string' || scenarioName.length === 0) throw new Error(`Scenario ${target} name must be a non-empty string`);
    const profileName = projectTarget(definition.profile ?? 'default', `Scenario ${target} profile`);
    const frames = positiveInteger(definition.timeoutFrames, `Scenario ${target} timeoutFrames`, 3600);
    const profile = config.profiles?.[profileName];
    if (!isRecord(profile)) {
      planStage(stages, { kind: 'scenario', target, disposition: 'blocked', reason: reason('profile-missing', `Unknown capture profile "${profileName}" for scenario ${target}`) });
      continue;
    }
    const seed = finiteNumber(definition.seed, `Scenario ${target} seed`, finiteNumber(profile.seed, `profiles.${profileName}.seed`, 42));
    const runtime = runtimeProfile(project, config, profileName, definition.userArgs, {
      scenarioName,
      scenarioStem: target,
      scenarioPath: path,
      capture: definition.capture !== false,
      frames,
      seed,
    });
    if (runtime.fixtureAdapter) fingerprints.push(fileFingerprint(
      project, resolve(project, runtime.fixtureAdapter.slice('res://'.length)), 'fixture-adapter', observation,
    ));
    const reportPath = stageReportPath(evidencePaths, 'scenario', target);
    planStage(stages, {
      kind: 'scenario', target, disposition: 'run', reason: reason('selected', `Scenario ${target} is selected`),
      reportPath, commandArgs: ['scenario', target, project, '--report', reportPath], runtime,
      generatedEffects: [
        { kind: 'stage-report', target: `scenario:${target}`, path: reportPath },
        ...(definition.capture === false ? [] : [{ kind: 'capture-directory', target: `scenario:${target}`, path: join(project, '.gdeck', 'captures') }]),
      ],
    });
  }

  if (visuals.length === 0) {
    const omitted = selection.named && visualSelector.mode === 'omitted';
    planStage(stages, {
      kind: 'visual', target: '*', disposition: omitted || !selection.named ? 'not_configured' : 'skipped',
      includeInLegacyReport: selection.named && !omitted,
      reason: omitted
        ? reason('not-declared', `Verification Profile ${selection.name} does not declare visuals`)
        : reason(visualSelector.mode === 'auto' ? 'auto-none-discovered' : 'explicit-empty', visualSelector.mode === 'auto' ? 'Visual auto-discovery found no baselines' : 'Verification Profile explicitly selects no visuals'),
    });
  }
  for (const target of visuals) {
    const baseline = join(project, 'qa', 'baselines', `${target}.png`);
    if (!existsSync(baseline) || !statSync(baseline).isFile()) {
      planStage(stages, { kind: 'visual', target, disposition: 'blocked', reason: reason('baseline-missing', `Visual baseline missing: ${baseline}`) });
      continue;
    }
    if (pathContainsSymlink(project, baseline)) throw new Error(`Visual baseline path must not contain symbolic links: ${baseline}`);
    const metadataPath = join(project, 'qa', 'baselines', `${target}.json`);
    let metadata = {};
    if (existsSync(metadataPath)) {
      if (pathContainsSymlink(project, metadataPath)) throw new Error(`Visual metadata path must not contain symbolic links: ${metadataPath}`);
      try { metadata = JSON.parse(readPlanFile(metadataPath, observation).toString('utf8')); }
      catch (error) { throw new Error(`Invalid visual metadata at ${metadataPath}: ${error.message}`); }
      if (!isRecord(metadata)) throw new Error(`Invalid visual metadata at ${metadataPath}: metadata must be an object`);
      fingerprints.push(fileFingerprint(project, metadataPath, 'visual-metadata', observation));
    }
    fingerprints.push(fileFingerprint(project, baseline, 'visual-baseline', observation));
    const profile = config.profiles?.[target];
    if (!isRecord(profile)) {
      planStage(stages, { kind: 'visual', target, disposition: 'blocked', reason: reason('profile-missing', `Unknown capture profile "${target}" for visual baseline ${target}`) });
      continue;
    }
    const runtime = runtimeProfile(project, config, target, [], {
      baselinePath: baseline,
      frames: positiveInteger(metadata.frames, `Visual ${target} frames`, positiveInteger(profile.frames, `profiles.${target}.frames`, 30)),
      seed: finiteNumber(metadata.seed, `Visual ${target} seed`, finiteNumber(profile.seed, `profiles.${target}.seed`, 42)),
      threshold: finiteNumber(metadata.pixelThreshold, `Visual ${target} pixelThreshold`, 0.05),
      tolerance: finiteNumber(metadata.tolerance, `Visual ${target} tolerance`, 0.001),
    });
    if (runtime.fixtureAdapter) fingerprints.push(fileFingerprint(
      project, resolve(project, runtime.fixtureAdapter.slice('res://'.length)), 'fixture-adapter', observation,
    ));
    const reportPath = stageReportPath(evidencePaths, 'visual', target);
    planStage(stages, {
      kind: 'visual', target, disposition: 'run', reason: reason('selected', `Visual baseline ${target} is selected`),
      reportPath, commandArgs: ['visual-test', target, project, '--report', reportPath], runtime,
      generatedEffects: [
        { kind: 'stage-report', target: `visual:${target}`, path: reportPath },
        { kind: 'capture-directory', target: `visual:${target}`, path: join(project, '.gdeck', 'captures') },
        { kind: 'diff-directory', target: `visual:${target}`, path: join(project, '.gdeck', 'reports') },
      ],
    });
  }

  if (benchmarks.length === 0) {
    const omitted = selection.named && benchmarkSelector.mode === 'omitted';
    planStage(stages, {
      kind: 'benchmark', target: '*', disposition: omitted || !selection.named ? 'not_configured' : 'skipped',
      includeInLegacyReport: selection.named && !omitted,
      reason: omitted ? reason('not-declared', `Verification Profile ${selection.name} does not declare benchmarks`) : reason('explicit-empty', 'Verification Profile explicitly selects no benchmarks'),
    });
  }
  for (let index = 0; index < benchmarks.length; index += 1) {
    const descriptor = benchmarks[index];
    const descriptorLabel = `${selection.named ? `Verification Profile ${selection.name}` : 'verify'}.benchmarks[${index}]`;
    if (typeof descriptor !== 'string' && !isRecord(descriptor)) throw new Error(`${descriptorLabel} must be a profile name or object`);
    if (selection.named && isRecord(descriptor)) {
      const unknown = Object.keys(descriptor).filter((key) => !['profile', 'frames', 'budgets'].includes(key));
      if (unknown.length > 0) throw new Error(`${descriptorLabel} contains unknown field(s): ${unknown.join(', ')}`);
    }
    const profileName = projectTarget(typeof descriptor === 'string' ? descriptor : descriptor.profile, `${descriptorLabel}.profile`);
    const profile = config.profiles?.[profileName];
    if (!isRecord(profile)) {
      planStage(stages, { kind: 'benchmark', target: profileName, disposition: 'blocked', reason: reason('profile-missing', `Unknown capture profile "${profileName}" for benchmark`) });
      continue;
    }
    const frames = positiveInteger(typeof descriptor === 'string' ? undefined : descriptor.frames, `Benchmark ${profileName} frames`, positiveInteger(profile.benchmarkFrames, `profiles.${profileName}.benchmarkFrames`, 600));
    const warmupFrames = nonNegativeInteger(profile.benchmarkWarmupFrames, `profiles.${profileName}.benchmarkWarmupFrames`, 60);
    const budgets = validateBudgets(typeof descriptor === 'string' ? {} : descriptor.budgets, `${descriptorLabel}.budgets`, selection.named);
    const runtime = runtimeProfile(project, config, profileName, [], {
      frames, warmupFrames, seed: finiteNumber(profile.seed, `profiles.${profileName}.seed`, 42), budgets,
    });
    if (runtime.fixtureAdapter) fingerprints.push(fileFingerprint(
      project, resolve(project, runtime.fixtureAdapter.slice('res://'.length)), 'fixture-adapter', observation,
    ));
    const reportPath = stageReportPath(evidencePaths, 'benchmark', profileName);
    const commandArgs = ['benchmark', profileName, project, '--output', reportPath];
    if (typeof descriptor !== 'string' && descriptor.frames !== undefined) commandArgs.push('--frames', String(frames));
    planStage(stages, {
      kind: 'benchmark', target: profileName, disposition: 'run', reason: reason('selected', `Benchmark ${profileName} is selected`),
      reportPath, commandArgs, runtime,
      generatedEffects: [{ kind: 'stage-report', target: `benchmark:${profileName}`, path: reportPath }],
    });
  }

  const exports = exportPlanning(project, config, exportTargets, observation);
  fingerprints.push(...exports.fingerprints);
  if (exportTargets.length === 0) {
    const omitted = selection.named && exportSelector.mode === 'omitted';
    planStage(stages, {
      kind: 'export', target: '*', disposition: omitted || !selection.named ? 'not_configured' : 'skipped',
      includeInLegacyReport: selection.named && !omitted,
      reason: omitted ? reason('not-declared', `Verification Profile ${selection.name} does not declare exports`) : reason('explicit-empty', 'Verification Profile explicitly selects no exports'),
    });
  }
  for (const item of exports.stages) {
    if (item.blocked) {
      planStage(stages, { kind: 'export', target: item.target, disposition: 'blocked', reason: reason('export-prerequisite', item.blocked) });
    } else {
      const journalReportPath = stageReportPath(evidencePaths, 'export', item.target);
      const stageEffects = [
        ...item.outputs.map((path) => ({ kind: 'export-artifact', target: item.target, path })),
        { kind: 'stage-report', target: `export:${item.target}`, path: journalReportPath },
      ];
      const stageConfirmation = [{ kind: 'replace-directory', target: item.target, path: item.finalDirectory }];
      planStage(stages, {
        kind: 'export', target: item.target, disposition: 'run', reason: reason('selected', `Export ${item.target} is selected`),
        commandArgs: ['export', item.target, project], journalReportPath, runtime: {
          godotPath: typeof config.godotPath === 'string' ? config.godotPath : '',
          exportsConfig: config.exports,
          preset: item.definition.preset,
          output: item.finalOutput,
        },
        generatedEffects: stageEffects, confirmationEffects: stageConfirmation,
      });
    }
  }

  for (const stage of stages) {
    stage.timeoutMs = resolvedTimeoutMs;
    if (stage.disposition === 'run' && stage.includeInLegacyReport) {
      const stem = stageReportPath(evidencePaths, stage.kind, stage.target).replace(/\.json$/, '');
      stage.diagnosticLogPaths = { stdout: `${stem}.stdout.log`, stderr: `${stem}.stderr.log` };
      stage.generatedEffects.push(...Object.entries(stage.diagnosticLogPaths).map(([stream, path]) => ({
        kind: 'stage-diagnostic-log', target: `${stage.kind}:${stage.target}:${stream}`, path,
      })));
    }
  }
  const retentionCandidates = resolveEvidenceRetention({
    project,
    evidenceRoot: evidencePaths.root,
    currentNamespace: evidencePaths.namespace,
    outputPath,
    invocationIdentity,
  }, {
    retentionCandidateManifest: options.retentionCandidateManifest,
    retentionEffectsMayBeFulfilled: options.retentionEffectsMayBeFulfilled === true,
  });
  const generatedEffects = uniqueEffects([
    { kind: 'verification-report', target: 'json', path: outputPath },
    { kind: 'verification-report', target: 'markdown', path: markdownPath },
    ...retentionCandidates.map((candidate) => ({
      kind: 'verification-retention-delete', target: candidate.invocationIdentity ?? 'owner-lock',
      path: candidate.path, candidate,
    })),
    { kind: 'verification-evidence-lock', target: invocationIdentity, path: evidencePaths.lockPath },
    { kind: 'verification-evidence-namespace', target: invocationIdentity, path: evidencePaths.namespace },
    { kind: 'verification-evidence-owner', target: invocationIdentity, path: evidencePaths.ownerPath },
    { kind: 'verification-journal', target: invocationIdentity, path: evidencePaths.journalPath },
    { kind: 'verification-stage-report-directory', target: invocationIdentity, path: evidencePaths.stageReportRoot },
    { kind: 'verification-diagnostic-log', target: 'preflight', path: diagnosticLogPath },
    ...stages.flatMap((stage) => stage.generatedEffects),
    ...exports.generatedEffects,
  ]);
  const confirmationEffects = exportTargets.length > 0 ? uniqueEffects(exports.confirmationEffects) : [];
  for (const effect of generatedEffects) {
    if (typeof effect.path !== 'string') continue;
    const path = resolve(effect.path);
    if (!pathIsInside(project, path)) throw new Error(`Verification generated path must stay inside the project: ${path}`);
    if (pathContainsSymlink(project, path)) throw new Error(`Verification generated path must not contain symbolic links: ${path}`);
  }
  const sourceTree = projectTreeFingerprint(project, generatedEffects, config, observation);
  fingerprints.push(sourceTree.fingerprint, sourceTree.uidFingerprint);
  const preparation = {
    godotImportRequired: sourceTree.importableAssetCount > 0
      || stages.some((stage) => stage.disposition === 'run' && stage.kind === 'unit'),
    godotPath: typeof config.godotPath === 'string' ? config.godotPath : '',
  };
  const evidenceBindingCore = {
    schemaVersion: EVIDENCE_BINDING_SCHEMA_VERSION,
    invocationIdentity,
    project,
    strategy: selection.name ? { mode: 'profile', profile: selection.name } : { mode: 'legacy', profile: null },
    outputPath,
    timeoutMs: resolvedTimeoutMs,
    resolver: { verificationPlanSchemaVersion: 1, contract: EVIDENCE_RESOLVER_CONTRACT },
    inputsDigest: digestValue(fingerprints),
    namespacePath: evidencePaths.namespace,
    lockPath: evidencePaths.lockPath,
    ownerPath: evidencePaths.ownerPath,
    journalPath: evidencePaths.journalPath,
    stageReportRoot: evidencePaths.stageReportRoot,
    retentionCandidates,
  };
  const planCore = {
    schemaVersion: 1,
    project,
    invocationIdentity,
    verificationProfile: selection.name,
    outputPath,
    markdownPath,
    diagnosticLogPath,
    timeoutMs: resolvedTimeoutMs,
    timeoutSeconds,
    inputs: fingerprints,
    sourceExclusions: sourceTree.exclusions,
    preparation,
    stages,
    generatedEffects,
    confirmationEffects,
    evidenceBindingCore,
  };
  const authorizationCore = {
    schemaVersion: planCore.schemaVersion,
    project,
    verificationProfile: selection.name,
    timeoutMs: resolvedTimeoutMs,
    inputs: fingerprints,
    stages: stages.map((stage) => ({
      kind: stage.kind, target: stage.target, disposition: stage.disposition, reason: stage.reason,
      runtime: stage.runtime, confirmationEffects: stage.confirmationEffects,
    })),
    confirmationEffects,
  };
  const digest = digestValue(planCore);
  const plan = {
    ...planCore,
    digest,
    authorizationDigest: digestValue(authorizationCore),
    evidenceBinding: { ...evidenceBindingCore, planDigest: digest },
  };
  if (observation && isRecord(options.observationSink)) {
    options.observationSink.files = observation.files;
    options.observationSink.bytes = observation.bytes;
  }
  return deepFreeze(plan);
}

export function verificationStagePreparationBudgetMilliseconds(plan) {
  if (!plan) throw new Error('Stage preparation budget requires a resolved Verification Plan');
  const sourceTree = (Array.isArray(plan.inputs) ? plan.inputs : []).find((input) => input?.kind === 'project-tree');
  const fileCount = Number(sourceTree?.fileCount ?? 0);
  const totalBytes = Number(sourceTree?.totalBytes ?? 0);
  const scaled = Math.max(0, fileCount) * 2 + Math.ceil(Math.max(0, totalBytes) / (1024 * 1024)) * 100;
  return Math.min(10_000, 1_000 + scaled);
}

export function verificationPlanExecutionBudgetMilliseconds(plan) {
  if (!plan || !Array.isArray(plan.stages)) throw new Error('Execution budget requires a resolved Verification Plan');
  const preparationBudget = verificationStagePreparationBudgetMilliseconds(plan);
  const runnable = plan.stages.filter((stage) => stage?.disposition === 'run' && stage?.includeInLegacyReport !== false);
  const stageBudget = runnable.reduce((total, stage) => {
    const stageTimeoutMs = Number(stage.timeoutMs);
    if (!Number.isFinite(stageTimeoutMs) || stageTimeoutMs <= 0) throw new Error('Verification Plan contains an invalid stage timeout');
    return total + stageTimeoutMs + preparationBudget + VERIFICATION_PROCESS_CLEANUP_MS;
  }, 0);
  const planTimeoutMs = Number(plan.timeoutMs);
  if (!Number.isFinite(planTimeoutMs) || planTimeoutMs <= 0) throw new Error('Verification Plan contains an invalid timeout');
  const importBudget = plan.preparation?.godotImportRequired === true
    ? planTimeoutMs + preparationBudget + VERIFICATION_PROCESS_CLEANUP_MS
    : 0;
  const budget = stageBudget + importBudget + VERIFICATION_REPORT_PUBLICATION_MS;
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('Verification Plan produced an invalid execution budget');
  return Math.ceil(budget);
}

export function assertVerificationPlanDigest(plan, expectedDigest, originalPlan, context = {}) {
  if (expectedDigest === undefined || expectedDigest === '') return;
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error('Invalid expected verification plan digest');
  }
  if (plan.digest !== expectedDigest) {
    const error = new ResultClassificationError('plan_drift', 'Verification Plan changed after preflight; evidence cannot be bound to the changed inputs. Invoke verify again to review the current plan.');
    if (originalPlan) error.planDrift = planDriftDiagnostics(originalPlan, plan, context);
    throw error;
  }
}

export function verificationPlanConfirmation(plan) {
  const effects = Array.isArray(plan?.confirmationEffects) ? plan.confirmationEffects : [];
  return {
    required: effects.length > 0,
    targets: [...new Set(effects.filter((effect) => effect.kind === 'replace-directory').flatMap((effect) => effect.targets ?? [effect.target]))],
    effects,
    authorizationDigest: plan?.authorizationDigest,
  };
}
