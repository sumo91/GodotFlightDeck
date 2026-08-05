import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectVerificationJournalSeal, readVerificationJournal } from './evidence-journal.mjs';
import { pathContainsSymlink, pathIsInside } from './safety.mjs';

const DEFAULT_MAX_FILES = 512;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_MILLISECONDS = 2_000;
const DEFAULT_RESULT_LIMIT = 32;
const MAX_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;
const VERDICTS = new Set(['PASSED', 'FAILED', 'INCONCLUSIVE', 'CANCELLED']);
const PLAN_PROBE_FILE = fileURLToPath(new URL('./evidence-plan-probe.mjs', import.meta.url));

function positiveBound(value, fallback, allowZero = false) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) throw new Error('Evidence Index bounds must be non-negative integers');
  return value;
}

function stableRead(path, budget) {
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > MAX_EVIDENCE_FILE_BYTES) throw new Error('unsafe evidence file');
    if (budget.filesObserved + 1 > budget.maxFiles || budget.bytesObserved + before.size > budget.maxBytes) {
      budget.truncated = true;
      throw new Error('Evidence read budget exceeded');
    }
    budget.filesObserved += 1;
    budget.bytesObserved += before.size;
    if (performance.now() - budget.started >= budget.maxMilliseconds) {
      budget.truncated = true;
      throw new Error('scan time limit');
    }
    const bytes = readFileSync(descriptor);
    if (performance.now() - budget.started >= budget.maxMilliseconds) {
      budget.truncated = true;
      throw new Error('Evidence read deadline exceeded');
    }
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== before.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size
      || pathAfter.mtimeMs !== before.mtimeMs || pathAfter.ctimeMs !== before.ctimeMs || pathAfter.isSymbolicLink()) {
      throw new Error('unstable evidence file');
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function validBinding(binding) {
  return binding && typeof binding === 'object' && !Array.isArray(binding)
    && binding.schemaVersion === 1
    && /^[a-f0-9]{64}$/.test(binding.invocationIdentity ?? '')
    && typeof binding.project === 'string'
    && binding.strategy && ['legacy', 'profile'].includes(binding.strategy.mode)
    && (binding.strategy.profile === null || typeof binding.strategy.profile === 'string')
    && typeof binding.outputPath === 'string'
    && Number.isInteger(binding.timeoutMs) && binding.timeoutMs > 0
    && binding.resolver?.verificationPlanSchemaVersion === 1
    && binding.resolver?.contract === 'gdeck-verification-plan/1'
    && /^[a-f0-9]{64}$/.test(binding.inputsDigest ?? '')
    && /^[a-f0-9]{64}$/.test(binding.planDigest ?? '')
    && typeof binding.journalPath === 'string';
}

function runPlanProbe(project, binding, budget) {
  const elapsed = performance.now() - budget.started;
  const remainingMilliseconds = Math.floor(budget.maxMilliseconds - elapsed);
  const remainingFiles = budget.maxFiles - budget.filesObserved;
  const remainingBytes = budget.maxBytes - budget.bytesObserved;
  if (remainingMilliseconds < 1 || remainingFiles < 1 || remainingBytes < 1) {
    budget.truncated = true;
    throw new Error('Evidence freshness probe budget is exhausted');
  }
  const spec = JSON.stringify({
    project,
    binding,
    maxFiles: remainingFiles,
    maxBytes: remainingBytes,
  });
  const result = spawnSync(process.execPath, [PLAN_PROBE_FILE, '--spec-stdin'], {
    cwd: project,
    input: spec,
    encoding: 'utf8',
    timeout: remainingMilliseconds,
    maxBuffer: 64 * 1024,
    env: process.env,
  });
  if (result.status !== 0 || result.signal || result.error) {
    if (result.status === 2 || result.error?.code === 'ETIMEDOUT' || result.signal) budget.truncated = true;
    throw new Error('Evidence freshness Plan reconstruction failed');
  }
  const observed = JSON.parse(result.stdout);
  if (!/^[a-f0-9]{64}$/.test(observed?.digest ?? '') || !/^[a-f0-9]{64}$/.test(observed?.inputsDigest ?? '')
    || !Number.isInteger(observed.filesObserved) || observed.filesObserved < 0
    || !Number.isInteger(observed.bytesObserved) || observed.bytesObserved < 0) {
    throw new Error('Evidence freshness Plan reconstruction returned an invalid result');
  }
  budget.filesObserved += observed.filesObserved;
  budget.bytesObserved += observed.bytesObserved;
  if (budget.filesObserved > budget.maxFiles || budget.bytesObserved > budget.maxBytes) {
    budget.truncated = true;
    throw new Error('Evidence freshness Plan reconstruction exceeded its observation budget');
  }
  return observed;
}

function freshnessForBinding(project, binding, currentPath = undefined, budget = undefined) {
  if (!validBinding(binding)) return 'unverifiable';
  try {
    if (budget && performance.now() - budget.started >= budget.maxMilliseconds) {
      budget.truncated = true;
      return 'unverifiable';
    }
    const projectPath = resolve(project);
    if (resolve(binding.project) !== projectPath) return 'unverifiable';
    if (!pathIsInside(projectPath, binding.outputPath) || pathContainsSymlink(projectPath, binding.outputPath)) return 'unverifiable';
    if (!budget) return 'unverifiable';
    const plan = runPlanProbe(projectPath, binding, budget);
    const stablePlan = runPlanProbe(projectPath, binding, budget);
    if (plan.digest !== stablePlan.digest || plan.inputsDigest !== stablePlan.inputsDigest) return 'unverifiable';
    if (currentPath && resolve(currentPath) !== resolve(binding.outputPath)) return 'stale';
    return plan.digest === binding.planDigest && plan.inputsDigest === binding.inputsDigest
      ? 'current'
      : 'stale';
  } catch {
    return 'unverifiable';
  }
}

function finalReportEntry(project, path, budget) {
  try {
    if (pathContainsSymlink(project, path)) {
      return { kind: 'unverifiable', entry: null };
    }
    const report = JSON.parse(stableRead(path, budget).toString('utf8'));
    if (report?.schemaVersion !== 2 || report?.resultEnvelope?.schemaVersion !== 1) {
      return { kind: 'invalid', entry: null };
    }
    const reportedVerdict = VERDICTS.has(report?.resultEnvelope?.verdict) ? report.resultEnvelope.verdict : null;
    const freshness = freshnessForBinding(project, report?.evidenceBinding, path, budget);
    const bindingUsable = validBinding(report?.evidenceBinding) && freshness !== 'unverifiable';
    if (!bindingUsable) {
      return { kind: freshness === 'unverifiable' ? 'unverifiable' : 'invalid', entry: null };
    }
    const location = resolve(path) === resolve(report.evidenceBinding.outputPath) ? 'bound' : 'transplanted';
    const seal = location === 'bound'
      ? projectVerificationJournalSeal(report.evidenceBinding.journalPath).seal
      : 'unverifiable';
    const entry = {
      path: report.evidenceBinding.outputPath,
      location,
      freshness,
      seal,
      reportedVerdict,
      invocationIdentity: report.evidenceBinding.invocationIdentity,
      journalPath: report.evidenceBinding.journalPath,
      timeoutMs: report.evidenceBinding.timeoutMs,
    };
    if (seal === 'sealed' && location === 'bound') return { kind: 'sealed_bound', entry };
    if (freshness === 'stale') return { kind: 'stale', entry };
    if (seal === 'unverifiable' && location !== 'bound') return { kind: 'unverifiable', entry: null };
    return { kind: 'valid', entry };
  } catch (error) {
    if (String(error?.message ?? '').includes('budget') || String(error?.message ?? '').includes('limit')) {
      return { kind: 'truncated', entry: null };
    }
    return { kind: 'invalid', entry: null };
  }
}

function journalEntry(project, path, budget) {
  const projected = projectVerificationJournalSeal(path);
  if (projected.seal === 'sealed') return null;
  const observed = readVerificationJournal(path);
  const binding = observed.integrity === 'valid' ? observed.evidenceBinding : null;
  return {
    path: binding?.journalPath ?? path,
    observedPath: path,
    integrity: projected.integrity,
    seal: projected.seal,
    freshness: binding ? freshnessForBinding(project, binding, undefined, budget) : 'unverifiable',
    invocationIdentity: binding?.invocationIdentity ?? null,
    timeoutMs: binding?.timeoutMs ?? null,
    preflightObserved: projected.preflightObserved ?? false,
    lastSequence: Number.isInteger(projected.lastSequence) ? projected.lastSequence : null,
    completedStageCount: Number.isInteger(projected.completedStageCount) ? projected.completedStageCount : 0,
    currentStage: projected.currentStage ?? null,
  };
}

function sealRank(entry) {
  if (entry.seal === 'sealed' && entry.location === 'bound') return 0;
  if (entry.seal === 'incomplete') return 1;
  if (entry.location === 'bound') return 2;
  return 3;
}

function freshnessRank(entry) {
  if (entry.freshness === 'current') return 0;
  if (entry.freshness === 'stale') return 1;
  return 2;
}

function compareFinalReports(left, right) {
  return sealRank(left) - sealRank(right)
    || freshnessRank(left) - freshnessRank(right)
    || String(left.path).localeCompare(String(right.path));
}

export function buildEvidenceIndex(projectCandidate, options = {}) {
  const project = resolve(projectCandidate);
  const projectFile = join(project, 'project.godot');
  if (!existsSync(projectFile) || pathContainsSymlink(project, projectFile)) throw new Error(`Not a safe Godot project: ${project}`);
  const reportsRoot = join(project, '.gdeck', 'reports');
  const maxMilliseconds = options.timeoutMs !== undefined
    ? positiveBound(Math.floor(Number(options.timeoutMs)), DEFAULT_MAX_MILLISECONDS, true)
    : positiveBound(options.maxMilliseconds, DEFAULT_MAX_MILLISECONDS, true);
  const resultLimit = positiveBound(options.limit, DEFAULT_RESULT_LIMIT, false);
  const budget = {
    maxFiles: positiveBound(options.maxFiles, DEFAULT_MAX_FILES, true),
    maxBytes: positiveBound(options.maxBytes, DEFAULT_MAX_BYTES, true),
    maxMilliseconds,
    filesObserved: 0,
    bytesObserved: 0,
    started: performance.now(),
    truncated: false,
  };
  const finalPaths = [];
  const journalPaths = [];
  let unstable = false;

  const observe = (path) => {
    if (budget.filesObserved >= budget.maxFiles || performance.now() - budget.started >= budget.maxMilliseconds) {
      budget.truncated = true;
      throw new Error('scan limit');
    }
    const metadata = lstatSync(path);
    const observedBytes = metadata.isFile() || metadata.isSymbolicLink() ? metadata.size : 0;
    if (budget.bytesObserved + observedBytes > budget.maxBytes) {
      budget.truncated = true;
      throw new Error('scan byte limit');
    }
    budget.filesObserved += 1;
    budget.bytesObserved += observedBytes;
    if (performance.now() - budget.started >= budget.maxMilliseconds) {
      budget.truncated = true;
      throw new Error('scan time limit');
    }
  };

  const visit = (directory) => {
    const descriptor = openSync(
      directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const directoryBefore = fstatSync(descriptor);
    if (!directoryBefore.isDirectory()) {
      closeSync(descriptor);
      throw new Error('unsafe evidence directory');
    }
    try {
    const entriesBefore = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entriesBefore) {
      const path = join(directory, entry.name);
      observe(path);
      const relation = relative(reportsRoot, path).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) {
        if (!relation.startsWith('private/') && entry.name.endsWith('.json')) finalPaths.push(path);
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === 'journal' && relation.startsWith('private/evidence/')) journalPaths.push(path);
        else visit(path);
      } else if (entry.isFile() && !relation.startsWith('private/') && entry.name.endsWith('.json')) {
        finalPaths.push(path);
      }
    }
    const entriesAfter = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    const entryProjection = (entries) => entries.map((entry) => [
      entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink(),
    ]);
    const descriptorAfter = fstatSync(descriptor);
    const directoryAfter = lstatSync(directory);
    if (JSON.stringify(entryProjection(entriesBefore)) !== JSON.stringify(entryProjection(entriesAfter))
      || directoryBefore.dev !== descriptorAfter.dev || directoryBefore.ino !== descriptorAfter.ino
      || directoryBefore.mtimeMs !== descriptorAfter.mtimeMs || directoryBefore.ctimeMs !== descriptorAfter.ctimeMs
      || directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino
      || directoryBefore.mtimeMs !== directoryAfter.mtimeMs || directoryBefore.ctimeMs !== directoryAfter.ctimeMs
      || directoryAfter.isSymbolicLink()) throw new Error('unstable evidence directory');
    } finally {
      closeSync(descriptor);
    }
  };

  if (existsSync(reportsRoot)) {
    try {
      if (pathContainsSymlink(project, reportsRoot)) throw new Error('unsafe reports root');
      visit(reportsRoot);
    } catch {
      unstable = true;
      budget.truncated = true;
    }
  }

  for (const journalPath of journalPaths.sort()) {
    if (performance.now() - budget.started >= budget.maxMilliseconds) { budget.truncated = true; break; }
    try {
      const observed = readVerificationJournal(journalPath);
      const binding = observed.integrity === 'valid' ? observed.evidenceBinding : null;
      const outputPath = binding?.outputPath;
      if (validBinding(binding) && resolve(binding.project) === project && pathIsInside(project, outputPath)
        && existsSync(outputPath) && !pathContainsSymlink(project, outputPath)) finalPaths.push(resolve(outputPath));
    } catch { /* malformed Journals remain incomplete/unverifiable projections below */ }
  }

  const counts = {
    sealed_bound: 0,
    valid: 0,
    stale: 0,
    unverifiable: 0,
    invalid: 0,
    truncated_reads: 0,
    incomplete_journals: 0,
  };
  const ranked = [];
  for (const path of [...new Set(finalPaths.map((item) => resolve(item)))].sort()) {
    if (performance.now() - budget.started >= budget.maxMilliseconds) { budget.truncated = true; break; }
    const classified = finalReportEntry(project, path, budget);
    if (classified.kind === 'truncated') {
      counts.truncated_reads += 1;
      budget.truncated = true;
      break;
    }
    counts[classified.kind] = (counts[classified.kind] ?? 0) + 1;
    if (classified.entry?.path) ranked.push(classified.entry);
  }
  ranked.sort(compareFinalReports);
  const finalReports = ranked.slice(0, resultLimit);
  const incompleteJournals = [];
  for (const path of journalPaths.sort()) {
    if (performance.now() - budget.started >= budget.maxMilliseconds) { budget.truncated = true; break; }
    const entry = journalEntry(project, path, budget);
    if (!entry) continue;
    counts.incomplete_journals += 1;
    if (incompleteJournals.length < resultLimit) incompleteJournals.push(entry);
  }
  if (performance.now() - budget.started >= budget.maxMilliseconds) budget.truncated = true;
  const scanStatus = unstable ? 'unverifiable' : budget.truncated ? 'incomplete' : 'complete';
  return {
    schemaVersion: 2,
    project,
    scan: {
      status: scanStatus,
      filesObserved: budget.filesObserved,
      bytesObserved: budget.bytesObserved,
      truncated: budget.truncated,
      maxMilliseconds: budget.maxMilliseconds,
      resultLimit,
      retainedValidReports: finalReports.length,
      rankedValidReports: ranked.length,
    },
    counts,
    finalReports,
    incompleteJournals,
    actions: ['start_new_invocation', 'inspect_preconditions'],
  };
}

export { DEFAULT_RESULT_LIMIT, DEFAULT_MAX_MILLISECONDS };
