#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  constants as fsConstants,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathContainsSymlink, pathIsInside } from './safety.mjs';
import {
  assessDoctorCapabilities, capabilityRelevanceForPlan, DOCTOR_CAPABILITY_IDS, DOCTOR_CAPABILITY_NAMES,
} from './doctor-capabilities.mjs';
import { generateInvocationIdentity, requireInvocationIdentity } from './evidence-contract.mjs';
import {
  appendVerificationJournalRecord,
  closeVerificationJournal,
  createVerificationJournal,
  projectVerificationJournalSeal,
} from './evidence-journal.mjs';
import { buildEvidenceIndex } from './evidence-index.mjs';
import { formatScenarioLintWarnings, lintScenarioDefinition } from './scenario-lint.mjs';
import {
  AGENT_DECISION_TREE,
  describeEditorAction,
  EDITOR_ACTION_CATALOG,
  HELP_DOMAINS,
  listEditorActionsByLayer,
  resolveEditorBridgePolicy,
  validateBatchOperations,
} from './editor-catalog.mjs';
import {
  createUnitExecutionBinding,
  createUnitProgressStream,
  normalizeVerbosity,
  projectUnitProgress,
  projectUnitSlowestCases,
  unitExecutionBindingMatches,
  unitReportDisposition,
} from './unit-progress.mjs';
import { renderVerificationProgress, startVerificationProgressObserver } from './progress-observer.mjs';
import { applyEvidenceRetention } from './evidence-retention.mjs';
import {
  buildResultEnvelope,
  renderResultEnvelopeMarkdown,
  renderResultEnvelopeText,
  ResultClassificationError,
} from './result-envelope.mjs';
import {
  assertVerificationPlanDigest,
  canonicalVerificationPlanJson,
  resolveVerificationPlan,
  verificationPlanExecutionBudgetMilliseconds,
  verificationStagePreparationBudgetMilliseconds,
} from './verification-plan.mjs';
import {
  CLI_COMMANDS,
  parseCliArguments,
  publicCommandDescription,
} from '../registry/commands.mjs';

const CLI_FILE = fileURLToPath(import.meta.url);
const TOOL_ROOT = resolve(dirname(CLI_FILE), '..');
const ADDON_SOURCE = join(TOOL_ROOT, 'godot', 'addons', 'flight_deck');
const PROCESS_RUNNER = join(TOOL_ROOT, 'cli', 'process-runner.mjs');
const DEFAULT_TIMEOUT_SECONDS = 300;
const TOOL_VERSION = JSON.parse(readFileSync(join(TOOL_ROOT, 'package.json'), 'utf8')).version;
const ERROR_PATTERN = /SCRIPT ERROR|Parse Error|ERROR:|FATAL:/;
const PROCESS_CLEANUP_TIMEOUT_MS = 750;
const PROCESS_WATCHDOG_GRACE_MS = 750;
const PROCESS_OUTPUT_OVERHEAD_BYTES = 256 * 1024;
let internalStageOutcomeSink = null;

const color = {
  green: (value) => process.stdout.isTTY ? `\u001b[32m${value}\u001b[0m` : value,
  yellow: (value) => process.stdout.isTTY ? `\u001b[33m${value}\u001b[0m` : value,
  red: (value) => process.stdout.isTTY ? `\u001b[31m${value}\u001b[0m` : value,
  muted: (value) => process.stdout.isTTY ? `\u001b[2m${value}\u001b[0m` : value,
};

function printHelp(domainCandidate = undefined) {
  const domainName = domainCandidate && HELP_DOMAINS[domainCandidate] ? domainCandidate : undefined;
  if (domainCandidate && !domainName) {
    throw new Error(`Unknown help domain: ${domainCandidate}. Allowed: ${Object.keys(HELP_DOMAINS).join(', ')}`);
  }
  if (domainName) {
    const domain = HELP_DOMAINS[domainName];
    console.log(`Godot Flight Deck ${TOOL_VERSION} — domain: ${domainName}

${domain.summary}

When:
  ${domain.when}

Suggested next commands:
${domain.next.map((line) => `  ${line}`).join('\n')}
`);
    if (domainName === 'editor') {
      const layers = listEditorActionsByLayer();
      console.log('Editor layers:');
      for (const [layer, actions] of Object.entries(layers)) {
        if (!actions.length) continue;
        console.log(`  ${layer}: ${actions.join(', ')}`);
      }
      console.log('\nPolicy: allowWrites gates writes; supplementaryEnabled gates reorder/resource-*; destructive needs --apply.');
      console.log('Describe one action: gdeck editor describe <action> [--json]');
    }
    return;
  }
  const commands = Object.entries(CLI_COMMANDS).filter(([name]) => !['help', 'version', 'describe'].includes(name));
  const usages = commands.map(([, definition]) => `  ${definition.usage}`).join('\n');
  const summaries = commands.map(([name, definition]) => `  ${name.padEnd(12)} ${definition.summary}`).join('\n');
  console.log(`Godot Flight Deck ${TOOL_VERSION}

Usage:
${usages}
  gdeck help [verify|editor|scenario|project]
  gdeck describe <command> --json
  gdeck editor describe [action]

Commands:
${summaries}
  describe     Describe the strict contract for a command
  help         Show full help or a domain guide for Agents

Domains:
${Object.entries(HELP_DOMAINS).map(([name, item]) => `  ${name.padEnd(10)} ${item.summary}`).join('\n')}

Agent decision tree:
${AGENT_DECISION_TREE.map((item) => `  - ${item.id}: prefer ${item.prefer}`).join('\n')}

Environment:
  GODOT_BIN  Absolute path to the preferred Godot executable
  GDECK_CURSOR_COMPAT  Default on in this fork (set 0 to restore nested supervisors)

Options are command-specific and unknown options fail before execution.
Only gdeck run accepts arbitrary game arguments after --.
All Godot and verify stages have a finite wall-clock timeout (default 300 seconds).
`);
}

function describeCommand(name, json = false) {
  const description = publicCommandDescription(name);
  if (!description) throw new Error(`Unknown command to describe: ${name}`);
  const output = { ...description, toolVersion: TOOL_VERSION };
  if (json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`${name}: ${description.summary}`);
    console.log(`Usage: ${description.usage}`);
    const options = Object.keys(description.options);
    console.log(`Options: ${options.length ? options.map((key) => `--${key}`).join(', ') : '(none)'}`);
    if (description.actions) console.log(`Actions: ${Object.keys(description.actions).join(', ')}`);
  }
}

function isProjectDirectory(candidate) {
  if (!candidate) return false;
  const directory = resolve(candidate);
  return existsSync(join(directory, 'project.godot'));
}

function resolveProject(candidate) {
  const project = resolve(candidate ?? process.cwd());
  if (!existsSync(join(project, 'project.godot'))) {
    throw new Error(`Not a Godot project: ${project}`);
  }
  return project;
}

function projectAndProfile(positional) {
  if (positional.length === 0) return { project: resolveProject(), profile: 'default' };
  if (isProjectDirectory(positional[0])) {
    return { project: resolveProject(positional[0]), profile: 'default' };
  }
  return {
    profile: positional[0],
    project: resolveProject(positional[1] ?? process.cwd()),
  };
}

function configPath(project) {
  return join(project, '.gdeck', 'config.json');
}

function defaultConfig() {
  return {
    schemaVersion: 1,
    flightDeckVersion: TOOL_VERSION,
    godotPath: '',
    editorBridge: {
      host: '127.0.0.1',
      port: 47835,
      allowWrites: false,
      // reorder / resource-* writes; keep false unless Agent needs them
      supplementaryEnabled: false,
      resourceRoots: ['res://resources/'],
    },
    pi: {
      confirmationTimeoutSeconds: 90,
      approvalLeaseSeconds: 120,
    },
    profiles: {
      default: {
        description: 'Main project scene',
        frames: 30,
        benchmarkWarmupFrames: 60,
        seed: 42,
        userArgs: [],
      },
    },
  };
}

function loadConfig(project) {
  const path = configPath(project);
  if (!existsSync(path)) return defaultConfig();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config root must be an object');
    const defaults = defaultConfig();
    return {
      ...defaults,
      ...parsed,
      editorBridge: { ...defaults.editorBridge, ...(parsed.editorBridge ?? {}) },
      pi: { ...defaults.pi, ...(parsed.pi ?? {}) },
      profiles: parsed.profiles ?? defaults.profiles,
    };
  } catch (error) {
    throw new Error(`Invalid Flight Deck config at ${path}: ${error.message}`);
  }
}

function executableExists(path) {
  if (!path) return false;
  if (isAbsolute(path)) return existsSync(path);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  const candidates = String(process.env.PATH ?? '').split(delimiter).filter(Boolean)
      .flatMap((directory) => extensions.map((extension) => join(directory, `${path}${extension}`)));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function findGodot(config = {}, override = '') {
  const candidates = [
    override,
    process.env.GODOT_BIN,
    config.godotPath,
    'godot',
    'godot4',
    '/Applications/Godot.app/Contents/MacOS/Godot',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (executableExists(candidate)) return candidate;
  }
  throw new Error('Godot executable not found. Set GODOT_BIN or .gdeck/config.json godotPath.');
}

function timeoutMilliseconds(options = {}) {
  const seconds = Number(options.timeout ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout must be a positive number of seconds');
  return Math.max(1, Math.round(seconds * 1000));
}

function processDeadlineNs(timeoutMs) {
  const local = process.hrtime.bigint() + BigInt(Math.max(1, Math.round(timeoutMs))) * 1_000_000n;
  const inherited = process.env.GDECK_EXECUTION_DEADLINE_NS;
  if (!privateLifecycleRegistry() || !/^\d+$/.test(inherited ?? '')) return local;
  const inheritedDeadline = BigInt(inherited);
  return inheritedDeadline < local ? inheritedDeadline : local;
}

function remainingDeadlineMilliseconds(deadlineNs) {
  const remainingNs = deadlineNs - process.hrtime.bigint();
  return remainingNs <= 0n ? 0 : Math.max(1, Number((remainingNs + 999_999n) / 1_000_000n));
}

function cursorCompatEnabled() {
  // Cursor fork default: avoid nested Job Object supervisors under agent shells.
  // Set GDECK_CURSOR_COMPAT=0 to restore upstream process-runner supervision.
  const raw = process.env.GDECK_CURSOR_COMPAT;
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  return true;
}

function runSyncDirect(executable, args, options = {}) {
  const requestedTimeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000);
  if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) throw new Error('Process timeout must be a positive finite number');
  const deadlineNs = processDeadlineNs(requestedTimeoutMs);
  const timeoutMs = remainingDeadlineMilliseconds(deadlineNs);
  const phase = String(options.phase ?? 'process').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'process';
  if (timeoutMs === 0) {
    const output = `Flight Deck: ${phase} deadline expired before process start\n`;
    if (!options.quiet) process.stdout.write(output);
    publishInternalStageOutcome('timeout', 'process_result', `${phase} deadline expired before process start`, { phase, reason: `${phase}_timeout`, started: false });
    return { status: 124, stdout: '', stderr: output, output, timedOut: true, phase, reason: `${phase}_timeout` };
  }
  const maximumOutputBytes = Math.max(16 * 1024, Math.min(64 * 1024 * 1024,
    Number(options.maxOutputBytes ?? options.maxBuffer ?? 32 * 1024 * 1024)));
  const env = options.inheritEnv === false ? { ...(options.env ?? {}) } : { ...process.env, ...(options.env ?? {}) };
  const result = spawnSync(executable, args, {
    cwd: options.cwd || undefined,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: maximumOutputBytes + PROCESS_OUTPUT_OVERHEAD_BYTES,
    killSignal: 'SIGTERM',
    windowsHide: true,
    shell: false,
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const spawnFailed = Boolean(result.error) && !timedOut;
  const status = timedOut ? 124 : spawnFailed ? 127 : (result.status ?? 1);
  const stdout = String(result.stdout ?? '');
  const stderr = timedOut
    ? `${String(result.stderr ?? '')}Flight Deck: ${phase} timed out\n`
    : spawnFailed
      ? `${String(result.stderr ?? '')}Flight Deck: could not start process: ${result.error.message}\n`
      : String(result.stderr ?? '');
  const output = `${stdout}${stderr}`;
  if (!options.quiet && output) process.stdout.write(output);
  const lifecycleEvidence = { phase, reason: timedOut ? `${phase}_timeout` : spawnFailed ? 'process_spawn' : null, timedOut, cleanupTimedOut: false, outputTruncated: false };
  if (status === 127) publishInternalStageOutcome('process_spawn', 'process_result', `Configured ${phase} process could not be started`, lifecycleEvidence);
  else if (status === 124) publishInternalStageOutcome('timeout', 'process_result', `${phase} timed out`, lifecycleEvidence);
  return {
    ...result,
    status,
    stdout,
    stderr,
    output,
    timedOut,
    cleanupTimedOut: false,
    cancelled: false,
    phase,
    reason: lifecycleEvidence.reason,
  };
}

function runSync(executable, args, options = {}) {
  if (cursorCompatEnabled()) return runSyncDirect(executable, args, options);
  const requestedTimeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000);
  if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) throw new Error('Process timeout must be a positive finite number');
  const cleanupTimeoutMs = Number(options.cleanupTimeoutMs ?? PROCESS_CLEANUP_TIMEOUT_MS);
  if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs < 500 || cleanupTimeoutMs > 10_000) {
    throw new Error('Process cleanup timeout must be between 500 and 10000 milliseconds');
  }
  const deadlineNs = processDeadlineNs(requestedTimeoutMs);
  const timeoutMs = remainingDeadlineMilliseconds(deadlineNs);
  const phase = String(options.phase ?? 'process').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'process';
  if (timeoutMs === 0) {
    const output = `Flight Deck: ${phase} deadline expired before process start\n`;
    if (!options.quiet) process.stdout.write(output);
    publishInternalStageOutcome('timeout', 'process_result', `${phase} deadline expired before process start`, { phase, reason: `${phase}_timeout`, started: false });
    return { status: 124, stdout: '', stderr: output, output, timedOut: true, phase, reason: `${phase}_timeout` };
  }
  const maximumOutputBytes = Math.max(16 * 1024, Math.min(64 * 1024 * 1024,
    Number(options.maxOutputBytes ?? options.maxBuffer ?? 32 * 1024 * 1024)));
  const nonce = randomBytes(32).toString('hex');
  const specification = JSON.stringify({
    executable,
    args,
    cwd: options.cwd ?? '',
    env: options.inheritEnv === false ? { ...(options.env ?? {}) } : { ...process.env, ...(options.env ?? {}) },
    timeoutMs,
    deadlineNs: String(deadlineNs),
    cleanupTimeoutMs,
    maxOutputBytes: maximumOutputBytes,
    phase,
    nonce,
    propagateLifecycleRegistry: options.propagateLifecycleRegistry === true,
  });
  const lifecycleDescriptor = privateLifecycleRegistry();
  const supervisorStdio = ['pipe', 'pipe', 'pipe', 'pipe'];
  if (lifecycleDescriptor !== null) supervisorStdio.push(lifecycleDescriptor);
  const result = spawnSync(process.execPath, [PROCESS_RUNNER, '--spec-stdin'], {
    encoding: 'utf8',
    input: specification,
    stdio: supervisorStdio,
    maxBuffer: maximumOutputBytes + PROCESS_OUTPUT_OVERHEAD_BYTES,
    timeout: timeoutMs + cleanupTimeoutMs + PROCESS_WATCHDOG_GRACE_MS,
    killSignal: 'SIGTERM',
  });
  let supervisor = null;
  try {
    const candidate = JSON.parse(String(result.output?.[3] ?? '').trim());
    if (candidate?.schemaVersion === 1 && candidate.nonce === nonce && candidate.phase === phase
      && Number.isInteger(candidate.status)) supervisor = candidate;
  } catch { /* missing metadata is handled as a supervisor failure below */ }
  const watchdogExpired = result.error?.code === 'ETIMEDOUT';
  const status = watchdogExpired ? 125 : supervisor?.status ?? result.status ?? 1;
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const output = `${stdout}${stderr}`;
  if (!options.quiet && output) process.stdout.write(output);
  const lifecycleEvidence = {
    phase,
    reason: supervisor?.reason ?? (watchdogExpired ? 'supervisor_watchdog_timeout' : null),
    timedOut: status === 124,
    cleanupTimedOut: status === 125 || supervisor?.cleanupTimedOut === true,
    outputTruncated: supervisor?.stdoutTruncated === true || supervisor?.stderrTruncated === true,
  };
  if (status === 127) publishInternalStageOutcome('process_spawn', 'process_result', `Configured ${phase} process could not be started`, lifecycleEvidence);
  else if (status === 124) publishInternalStageOutcome('timeout', 'process_result', `${phase} timed out`, lifecycleEvidence);
  else if (status === 125) publishInternalStageOutcome('cleanup_timeout', 'process_result', `${phase} supervisor exceeded its cleanup deadline`, lifecycleEvidence);
  return {
    ...result,
    status,
    stdout,
    stderr,
    output,
    timedOut: status === 124,
    cleanupTimedOut: status === 125 || supervisor?.cleanupTimedOut === true,
    cancelled: supervisor?.cancelled === true,
    outputTruncated: supervisor?.stdoutTruncated === true || supervisor?.stderrTruncated === true,
    phase,
    reason: supervisor?.reason ?? (watchdogExpired ? 'supervisor_watchdog_timeout' : undefined),
    supervisor,
  };
}

const LIFECYCLE_TEMPORARY_PREFIXES = [
  'gdeck-fixture-run-', 'gdeck-verification-snapshot-', 'gdeck-release-project-', 'gdeck-native-smoke-',
];

function privateLifecycleRegistry() {
  if (process.env.GDECK_LIFECYCLE_FD !== '4') return null;
  try {
    const metadata = fstatSync(4);
    // Windows has no POSIX permission bits (Node chmod cannot restrict ACLs);
    // the fd identity itself is the trust boundary there.
    const privateMode = process.platform === 'win32' || (metadata.mode & 0o077) === 0;
    return metadata.isFile() && privateMode ? 4 : null;
  } catch {
    return null;
  }
}

function lifecycleRegistryEvent(event, path) {
  const registryDescriptor = privateLifecycleRegistry();
  if (registryDescriptor === null) return;
  const absolute = resolve(path);
  const temporaryResource = resolve(dirname(absolute)) === resolve(tmpdir())
    && LIFECYCLE_TEMPORARY_PREFIXES.some((prefix) => basename(absolute).startsWith(prefix));
  const exportStagingResource = basename(dirname(absolute)) === 'export-staging'
    && basename(dirname(dirname(absolute))) === '.gdeck';
  if (!temporaryResource && !exportStagingResource) {
    throw new ResultClassificationError('configuration', `Lifecycle resource path is outside an allowed invocation staging namespace: ${absolute}`);
  }
  try {
    writeSync(registryDescriptor, Buffer.from(`${JSON.stringify({ event, path: absolute, owner: process.pid })}\n`));
  } catch (error) {
    throw new ResultClassificationError('cleanup_timeout', `Cannot update the private lifecycle registry: ${error.message}`, 'process_result');
  }
}

function createLifecycleTemporaryDirectory(prefix) {
  if (!LIFECYCLE_TEMPORARY_PREFIXES.includes(prefix)) throw new Error(`Unsupported lifecycle temporary prefix: ${prefix}`);
  const path = mkdtempSync(join(tmpdir(), prefix));
  try {
    lifecycleRegistryEvent('resource_add', path);
    return path;
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

function removeLifecycleTemporaryDirectory(path) {
  if (!path) return;
  try { makeVerificationTreeWritable(path); } catch { /* removal below remains authoritative */ }
  try { rmSync(path, { recursive: true, force: true }); }
  catch (error) { throw new ResultClassificationError('cleanup_timeout', `Cannot remove lifecycle temporary directory ${path}: ${error.message}`, 'process_result'); }
  if (existsSync(path)) throw new ResultClassificationError('cleanup_timeout', `Lifecycle temporary directory remained after cleanup: ${path}`, 'process_result');
  lifecycleRegistryEvent('resource_remove', path);
}

function processStatusOr(result, fallback = 1) {
  return [124, 125, 127].includes(result?.status) ? result.status : fallback;
}

function publishInternalStageOutcome(classification, source, summary, actual = undefined) {
  if (!internalStageOutcomeSink) return;
  writeFileAtomic(internalStageOutcomeSink.path, `${JSON.stringify({
    nonce: internalStageOutcomeSink.nonce,
    classification,
    source,
    summary,
    ...(actual ? { actual } : {}),
  })}\n`, { mode: 0o600 });
}

function syncDirectoryBestEffort(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    fsyncBestEffort(descriptor);
  } catch (error) {
    const unsupported = new Set(['EINVAL', 'ENOTSUP', 'EISDIR']);
    if (process.platform === 'win32') unsupported.add('EPERM').add('EACCES');
    if (!unsupported.has(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fsyncBestEffort(descriptor) {
  try {
    fsyncSync(descriptor);
  } catch (error) {
    const unsupported = new Set(['EINVAL', 'ENOTSUP', 'EISDIR']);
    if (process.platform === 'win32') unsupported.add('EPERM').add('EACCES');
    if (!unsupported.has(error?.code)) throw error;
  }
}

function writeFileAtomic(path, content, options = {}) {
  const temporary = `${path}.gdeck-${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const existingMode = existsSync(path) && statSync(path).isFile() ? statSync(path).mode & 0o777 : undefined;
  const mode = options.mode ?? existingMode ?? (0o666 & ~process.umask());
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    try { fchmodSync(descriptor, mode); } catch (error) {
      if (!(process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'ENOSYS' || error?.code === 'EINVAL'))) throw error;
    }
    writeFileSync(descriptor, content);
    fsyncBestEffort(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    syncDirectoryBestEffort(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function writeFileAtomicNoReplace(path, content, options = {}) {
  const temporary = `${path}.gdeck-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
  const mode = options.mode ?? (0o666 & ~process.umask());
  let descriptor;
  let temporaryIdentity;
  let published = false;
  try {
    descriptor = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), mode);
    try { fchmodSync(descriptor, mode); } catch (error) {
      if (!(process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'ENOSYS' || error?.code === 'EINVAL'))) throw error;
    }
    writeFileSync(descriptor, content);
    fsyncBestEffort(descriptor);
    const metadata = fstatSync(descriptor);
    temporaryIdentity = { dev: metadata.dev, ino: metadata.ino };
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
    published = true;
    const visible = lstatSync(path);
    if (!visible.isFile() || visible.isSymbolicLink() || visible.dev !== temporaryIdentity.dev || visible.ino !== temporaryIdentity.ino) {
      throw new Error(`Atomic no-replace publication identity mismatch: ${path}`);
    }
    unlinkSync(temporary);
    temporaryIdentity = undefined;
    syncDirectoryBestEffort(dirname(path));
    return { dev: visible.dev, ino: visible.ino };
  } catch (error) {
    if (published && existsSync(path)) {
      const visible = lstatSync(path);
      if (visible.isFile() && !visible.isSymbolicLink()
        && visible.dev === temporaryIdentity?.dev && visible.ino === temporaryIdentity?.ino) unlinkSync(path);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryIdentity && existsSync(temporary)) {
      const visible = lstatSync(temporary);
      if (visible.isFile() && !visible.isSymbolicLink()
        && visible.dev === temporaryIdentity.dev && visible.ino === temporaryIdentity.ino) unlinkSync(temporary);
    }
  }
}

function fileFingerprint(path) {
  if (!existsSync(path)) return { kind: 'missing' };
  const metadata = statSync(path);
  if (!metadata.isFile()) return { kind: 'other' };
  return {
    kind: 'file',
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    mode: metadata.mode & 0o777,
  };
}

function sameFingerprint(left, right) {
  return left?.kind === right?.kind && left?.sha256 === right?.sha256 && left?.mode === right?.mode;
}

function addonTreeFingerprint(root) {
  if (!existsSync(root)) return null;
  const hash = createHash('sha256');
  const visit = (directory, relativeDirectory = '') => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`Flight Deck addon transaction refuses symbolic links: ${absolute}`);
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}\0${relativePath}\0${metadata.mode & 0o777}\0`);
      if (entry.isDirectory()) visit(absolute, relativePath);
      else if (entry.isFile()) hash.update(readFileSync(absolute));
      else throw new Error(`Flight Deck addon transaction found unsupported entry: ${absolute}`);
    }
  };
  visit(root);
  return hash.digest('hex');
}

function syncTreeDurably(root) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`Flight Deck staged addon contains a symbolic link: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const descriptor = openSync(absolute, 'r');
        try { fsyncBestEffort(descriptor); } finally { closeSync(descriptor); }
      } else throw new Error(`Flight Deck staged addon contains an unsupported entry: ${absolute}`);
    }
    syncDirectoryBestEffort(directory);
  };
  visit(root);
}

function fileSnapshot(path) {
  if (!existsSync(path)) return { exists: false };
  const metadata = statSync(path);
  if (!metadata.isFile()) throw new Error(`Flight Deck managed path is not a file: ${path}`);
  return { exists: true, content: readFileSync(path), mode: metadata.mode & 0o777 };
}

function restoreFileSnapshot(path, snapshot) {
  rmSync(path, { recursive: true, force: true });
  if (snapshot.exists) writeFileAtomic(path, snapshot.content, { mode: snapshot.mode });
}

function addAutoload(project) {
  const path = join(project, 'project.godot');
  let source = readFileSync(path, 'utf8');
  const declaration = 'FlightDeckProbe="*res://addons/flight_deck/runtime_probe.gd"';
  if (/^FlightDeckProbe=.*$/m.test(source)) {
    source = source.replace(/^FlightDeckProbe=.*$/m, declaration);
  } else if (/^\[autoload\]\s*$/m.test(source)) {
    source = source.replace(/^\[autoload\]\s*$/m, `[autoload]\n\n${declaration}`);
  } else {
    source = `${source.trimEnd()}\n\n[autoload]\n\n${declaration}\n`;
  }
  writeFileAtomic(path, source);
}

function enableEditorPlugin(project) {
  const path = join(project, 'project.godot');
  let source = readFileSync(path, 'utf8');
  const plugin = 'res://addons/flight_deck/plugin.cfg';
  const enabledPattern = /^enabled=PackedStringArray\((.*)\)$/m;
  const match = source.match(enabledPattern);
  if (match) {
    if (!match[1].includes(plugin)) {
      const items = match[1].trim();
      const replacement = `enabled=PackedStringArray(${items ? `${items}, ` : ''}"${plugin}")`;
      source = source.replace(enabledPattern, replacement);
    }
  } else if (/^\[editor_plugins\]\s*$/m.test(source)) {
    source = source.replace(/^\[editor_plugins\]\s*$/m, `[editor_plugins]\n\nenabled=PackedStringArray("${plugin}")`);
  } else {
    source = `${source.trimEnd()}\n\n[editor_plugins]\n\nenabled=PackedStringArray("${plugin}")\n`;
  }
  writeFileAtomic(path, source);
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

function ensureBridgeToken(project) {
  const path = join(project, '.gdeck', 'editor-token');
  if (!existsSync(path)) writeFileAtomic(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  return path;
}

function ensureGitignore(project) {
  const path = join(project, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = [];
  if (!existing.includes('.gdeck/reports/')) lines.push('.gdeck/reports/');
  if (!existing.includes('.gdeck/captures/')) lines.push('.gdeck/captures/');
  if (!existing.includes('.gdeck/editor-token')) lines.push('.gdeck/editor-token');
  if (!existing.includes('.gdeck/editor-session.json')) lines.push('.gdeck/editor-session.json');
  if (!existing.includes('.gdeck/editor-session-*.json')) lines.push('.gdeck/editor-session-*.json');
  if (!existing.includes('.gdeck-init.lock')) lines.push('.gdeck-init.lock');
  if (!existing.includes('.gdeck-init-transaction.json')) lines.push('.gdeck-init-transaction.json');
  if (!existing.includes('.gdeck-init-key-*')) lines.push('.gdeck-init-key-*');
  if (lines.length > 0) {
    writeFileAtomic(path, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}\n# Godot Flight Deck generated output\n${lines.join('\n')}\n`);
  }
}

function acquireInitLock(project) {
  const path = join(project, '.gdeck-init.lock');
  if (pathContainsSymlink(project, path)) throw new Error(`Flight Deck init lock path contains a symbolic link: ${path}`);
  const token = `${process.pid}-${randomBytes(12).toString('hex')}`;
  const create = () => {
    const descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`);
    fsyncBestEffort(descriptor);
    closeSync(descriptor);
    syncDirectoryBestEffort(project);
  };
  try {
    create();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let owner = null;
    try { owner = JSON.parse(readFileSync(path, 'utf8')); } catch {}
    const ownerDetail = Number.isInteger(owner?.pid) && owner.pid > 0 ? ` (recorded pid ${owner.pid})` : '';
    throw new Error(`Flight Deck init lock already exists${ownerDetail}. Init fails closed; after verifying no init process is active, remove ${path} and run init again.`);
  }
  return () => {
    try {
      const owner = JSON.parse(readFileSync(path, 'utf8'));
      if (owner.token === token) rmSync(path, { force: true });
    } catch {}
  };
}

function initJournalPath(project) { return join(project, '.gdeck-init-transaction.json'); }
function initJournalKeyPath(project, transaction) { return join(project, `.gdeck-init-key-${transaction}`); }

function maybeFailInitStep(step) {
  if (process.env.GDECK_TEST_INIT_FAIL_STEP === step) throw new Error(`Injected init failure after ${step}`);
  if (process.env.GDECK_TEST_INIT_CRASH_STEP === step) process.exit(86);
}

function journalSignature(journal, secret) {
  const unsigned = { ...journal };
  delete unsigned.signature;
  return createHmac('sha256', secret).update(JSON.stringify(unsigned)).digest('hex');
}

function writeInitJournal(project, journal, secret) {
  const signed = { ...journal, signature: journalSignature(journal, secret) };
  writeFileAtomic(initJournalPath(project), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
}

function recoverInterruptedInit(project) {
  const journalPath = initJournalPath(project);
  if (pathContainsSymlink(project, journalPath)) throw new Error(`Flight Deck init journal path contains a symbolic link: ${journalPath}`);
  if (!existsSync(journalPath)) return;
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  if (journal.schemaVersion !== 1 || typeof journal.transaction !== 'string' || !/^[0-9]+-[0-9a-f]{10}$/.test(journal.transaction)) {
    throw new Error(`Invalid Flight Deck init recovery journal: ${journalPath}`);
  }
  const keyPath = initJournalKeyPath(project, journal.transaction);
  if (pathContainsSymlink(project, keyPath) || !existsSync(keyPath)) throw new Error(`Flight Deck init recovery key is missing or unsafe: ${keyPath}`);
  const secret = readFileSync(keyPath, 'utf8').trim();
  const expectedSignature = journalSignature(journal, secret);
  const suppliedSignature = String(journal.signature ?? '');
  if (!/^[0-9a-f]{64}$/.test(suppliedSignature)
      || !timingSafeEqual(Buffer.from(expectedSignature, 'hex'), Buffer.from(suppliedSignature, 'hex'))) {
    throw new Error(`Flight Deck init recovery journal failed its integrity check: ${journalPath}`);
  }
  const validPhases = new Set(['preparing', 'addon_backed_up', 'addon_installed', 'committed']);
  const validHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (!validPhases.has(journal.phase) || typeof journal.hadAddon !== 'boolean' || !validHash(journal.stagedFingerprint)
      || (journal.hadAddon && !validHash(journal.backupFingerprint)) || (!journal.hadAddon && journal.backupFingerprint !== null)) {
    throw new Error(`Invalid Flight Deck init recovery journal: ${journalPath}`);
  }
  const addonsDirectory = join(project, 'addons');
  const addonTarget = join(addonsDirectory, 'flight_deck');
  const stagedAddon = join(addonsDirectory, `.flight_deck-stage-${journal.transaction}`);
  const backupAddon = join(addonsDirectory, `.flight_deck-backup-${journal.transaction}`);
  if (typeof journal.targetVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(journal.targetVersion)) {
    throw new Error(`Invalid target version in Flight Deck init recovery journal: ${journalPath}`);
  }
  for (const path of [addonsDirectory, addonTarget, stagedAddon, backupAddon]) {
    if (pathContainsSymlink(project, path)) throw new Error(`Flight Deck init recovery refuses a symbolic link: ${path}`);
  }
  const requireFingerprint = (path, expected, label) => {
    if (!existsSync(path)) return false;
    const actual = addonTreeFingerprint(path);
    if (actual !== expected) throw new Error(`Interrupted init found a modified ${label}; preserved for manual recovery: ${path}`);
    return true;
  };
  const stageExists = requireFingerprint(stagedAddon, journal.stagedFingerprint, 'staged addon');
  if (!journal.hadAddon && existsSync(backupAddon)) throw new Error(`Interrupted init journal contradicts the preserved addon backup: ${backupAddon}`);
  const backupExists = journal.hadAddon ? requireFingerprint(backupAddon, journal.backupFingerprint, 'addon backup') : false;
  if (journal.phase === 'committed') {
    requireFingerprint(addonTarget, journal.stagedFingerprint, 'committed installed addon');
    if (stageExists) rmSync(stagedAddon, { recursive: true, force: true });
    if (backupExists) rmSync(backupAddon, { recursive: true, force: true });
    rmSync(journalPath, { force: true });
    rmSync(keyPath, { force: true });
    syncDirectoryBestEffort(addonsDirectory);
    syncDirectoryBestEffort(project);
    return;
  }
  if (backupExists) {
    if (existsSync(addonTarget)) {
      requireFingerprint(addonTarget, journal.stagedFingerprint, 'installed transaction addon');
      rmSync(addonTarget, { recursive: true, force: true });
    }
    renameSync(backupAddon, addonTarget);
  } else if (journal.hadAddon) {
    if (!existsSync(addonTarget) || addonTreeFingerprint(addonTarget) !== journal.backupFingerprint || journal.phase !== 'preparing') {
      throw new Error(`Interrupted init backup is missing; refusing automatic recovery: ${backupAddon}`);
    }
  } else if (existsSync(addonTarget)) {
    requireFingerprint(addonTarget, journal.stagedFingerprint, 'installed transaction addon');
    rmSync(addonTarget, { recursive: true, force: true });
  }
  if (stageExists) rmSync(stagedAddon, { recursive: true, force: true });
  rmSync(journalPath, { force: true });
  rmSync(keyPath, { force: true });
  syncDirectoryBestEffort(addonsDirectory);
  syncDirectoryBestEffort(project);
}

function initProject(projectCandidate) {
  const project = resolveProject(projectCandidate);
  const releaseLock = acquireInitLock(project);
  try {
    recoverInterruptedInit(project);
  const addonsDirectory = join(project, 'addons');
  const addonTarget = join(addonsDirectory, 'flight_deck');
  const transaction = `${process.pid}-${randomBytes(5).toString('hex')}`;
  const journalSecret = randomBytes(32).toString('hex');
  const journalKeyPath = initJournalKeyPath(project, transaction);
  const stagedAddon = join(addonsDirectory, `.flight_deck-stage-${transaction}`);
  const backupAddon = join(addonsDirectory, `.flight_deck-backup-${transaction}`);
  const gdeckDirectory = join(project, '.gdeck');
  if (pathContainsSymlink(project, gdeckDirectory)) throw new Error(`Flight Deck init refuses a managed path containing a symbolic link: ${gdeckDirectory}`);
  const managedFiles = [
    configPath(project), join(project, 'project.godot'), join(project, '.gitignore'),
    join(project, '.gdeck', 'editor-token'),
  ];
  const assertManagedPathsSafe = () => {
    for (const path of [addonsDirectory, addonTarget, join(project, '.gdeck'), ...managedFiles]) {
      if (pathContainsSymlink(project, path)) throw new Error(`Flight Deck init refuses a managed path containing a symbolic link: ${path}`);
    }
  };
  assertManagedPathsSafe();
  const snapshots = new Map(managedFiles.map((path) => [path, fileSnapshot(path)]));
  const expectedFingerprints = new Map(managedFiles.map((path) => [path, fileFingerprint(path)]));
  const directoryState = new Map([
    [addonsDirectory, existsSync(addonsDirectory)],
    [join(project, '.gdeck'), existsSync(join(project, '.gdeck'))],
    [join(project, '.gdeck', 'captures'), existsSync(join(project, '.gdeck', 'captures'))],
    [join(project, '.gdeck', 'reports'), existsSync(join(project, '.gdeck', 'reports'))],
  ]);
  let addonBackedUp = false;
  let addonInstalled = false;
  const writtenFingerprints = new Map();
  const assertWritePrecondition = (path) => {
    if (!sameFingerprint(fileFingerprint(path), expectedFingerprints.get(path))) {
      throw new Error(`Flight Deck init detected a concurrent change before writing: ${path}`);
    }
  };
  const recordWrite = (path) => {
    const fingerprint = fileFingerprint(path);
    writtenFingerprints.set(path, fingerprint);
    expectedFingerprints.set(path, fingerprint);
  };
  const journal = {
    schemaVersion: 1, transaction, targetVersion: TOOL_VERSION, hadAddon: existsSync(addonTarget), phase: 'preparing',
    stagedFingerprint: null, backupFingerprint: null,
  };
  try {
    mkdirSync(addonsDirectory, { recursive: true });
    cpSync(ADDON_SOURCE, stagedAddon, { recursive: true, force: false, errorOnExist: true });
    for (const required of ['plugin.cfg', 'plugin.gd', 'runtime_probe.gd', 'scenario_runner.gd', 'unit_runner.gd']) {
      if (!existsSync(join(stagedAddon, required))) throw new Error(`Staged Flight Deck addon is incomplete: ${required}`);
    }
    const stagedPlugin = readFileSync(join(stagedAddon, 'plugin.cfg'), 'utf8');
    if (!stagedPlugin.includes(`version="${TOOL_VERSION}"`)) throw new Error(`Staged Flight Deck addon version does not match ${TOOL_VERSION}`);
    syncTreeDurably(stagedAddon);
    journal.stagedFingerprint = addonTreeFingerprint(stagedAddon);
    journal.backupFingerprint = journal.hadAddon ? addonTreeFingerprint(addonTarget) : null;
    assertManagedPathsSafe();
    writeFileAtomic(journalKeyPath, `${journalSecret}\n`, { mode: 0o600 });
    writeInitJournal(project, journal, journalSecret);
    if (existsSync(addonTarget)) {
      renameSync(addonTarget, backupAddon);
      addonBackedUp = true;
      syncDirectoryBestEffort(addonsDirectory);
    }
    journal.phase = 'addon_backed_up';
    writeInitJournal(project, journal, journalSecret);
    maybeFailInitStep('addon_backed_up');
    renameSync(stagedAddon, addonTarget);
    addonInstalled = true;
    syncDirectoryBestEffort(addonsDirectory);
    journal.phase = 'addon_installed';
    writeInitJournal(project, journal, journalSecret);

    assertManagedPathsSafe();
    mkdirSync(join(project, '.gdeck', 'captures'), { recursive: true });
    mkdirSync(join(project, '.gdeck', 'reports'), { recursive: true });
    const path = configPath(project);
    assertWritePrecondition(path);
    if (!existsSync(path)) {
      writeFileAtomic(path, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
      recordWrite(path);
    } else {
      const existingConfig = JSON.parse(readFileSync(path, 'utf8'));
      existingConfig.flightDeckVersion = TOOL_VERSION;
      existingConfig.editorBridge = { ...defaultConfig().editorBridge, ...(existingConfig.editorBridge ?? {}) };
      existingConfig.pi = { ...defaultConfig().pi, ...(existingConfig.pi ?? {}) };
      writeFileAtomic(path, `${JSON.stringify(existingConfig, null, 2)}\n`);
      recordWrite(path);
    }
    assertWritePrecondition(join(project, 'project.godot'));
    addAutoload(project);
    recordWrite(join(project, 'project.godot'));
    assertWritePrecondition(join(project, 'project.godot'));
    enableEditorPlugin(project);
    recordWrite(join(project, 'project.godot'));
    if (process.env.GDECK_TEST_INIT_CREATE_TOKEN === '1') writeFileSync(join(project, '.gdeck', 'editor-token'), 'concurrent-token\n', { mode: 0o600 });
    assertWritePrecondition(join(project, '.gdeck', 'editor-token'));
    ensureBridgeToken(project);
    recordWrite(join(project, '.gdeck', 'editor-token'));
    assertWritePrecondition(join(project, '.gitignore'));
    ensureGitignore(project);
    recordWrite(join(project, '.gitignore'));
    maybeFailInitStep('gitignore');
    journal.phase = 'committed';
    writeInitJournal(project, journal, journalSecret);
    maybeFailInitStep('committed');
    rmSync(backupAddon, { recursive: true, force: true });
    addonBackedUp = false;
    rmSync(initJournalPath(project), { force: true });
    rmSync(journalKeyPath, { force: true });
    console.log(color.green('Flight Deck installed'));
    console.log(`  Project: ${project}`);
    console.log(`  Addon:   ${addonTarget}`);
    console.log(`  Config:  ${path}`);
    console.log('  Editor:  restart required if this project was already open');
  } catch (error) {
    const rollbackErrors = [];
    try {
      if (addonInstalled) {
        const installedFingerprint = addonTreeFingerprint(addonTarget);
        if (installedFingerprint !== journal.stagedFingerprint) throw new Error('installed addon changed after this transaction wrote it');
        rmSync(addonTarget, { recursive: true, force: true });
      }
    } catch (rollbackError) { rollbackErrors.push(`cannot remove partial addon: ${rollbackError.message}`); }
    if (addonBackedUp && existsSync(backupAddon)) {
      try {
        renameSync(backupAddon, addonTarget);
        addonBackedUp = false;
      } catch (rollbackError) {
        rollbackErrors.push(`cannot restore addon backup at ${backupAddon}: ${rollbackError.message}`);
      }
    }
    for (const [path, snapshot] of snapshots) {
      const written = writtenFingerprints.get(path);
      if (!written) continue;
      try {
        if (!sameFingerprint(fileFingerprint(path), written)) {
          rollbackErrors.push(`refused to overwrite a concurrently changed file: ${path}`);
          continue;
        }
        restoreFileSnapshot(path, snapshot);
      } catch (rollbackError) { rollbackErrors.push(`cannot restore ${path}: ${rollbackError.message}`); }
    }
    for (const [path, existed] of [...directoryState.entries()].reverse()) {
      if (!existed && existsSync(path)) {
        try { if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true }); }
        catch (rollbackError) { rollbackErrors.push(`cannot clean ${path}: ${rollbackError.message}`); }
      }
    }
    if (rollbackErrors.length) {
      throw new Error(`Flight Deck init failed and rollback is incomplete: ${error.message}. ${rollbackErrors.join('; ')}`);
    }
    rmSync(initJournalPath(project), { force: true });
    rmSync(journalKeyPath, { force: true });
    throw new Error(`Flight Deck init rolled back without keeping partial changes: ${error.message}`);
  } finally {
    rmSync(stagedAddon, { recursive: true, force: true });
    if (!addonBackedUp) rmSync(backupAddon, { recursive: true, force: true });
  }
  } finally {
    releaseLock();
  }
}

function godotVersion(godot, options = {}) {
  const result = runSync(godot, ['--version'], {
    quiet: true, timeoutMs: timeoutMilliseconds(options), maxOutputBytes: 16 * 1024, phase: 'godot_version',
  });
  if ([124, 125, 127].includes(result.status)) {
    const message = result.status === 124 ? 'Godot version check timed out'
      : result.status === 125 ? 'Godot version check cleanup exceeded its deadline'
        : 'Godot version process could not be started';
    const error = new Error(message);
    error.exitCode = result.status;
    throw error;
  }
  if (result.status !== 0) throw new Error(`Godot version check failed with exit code ${result.status}`);
  const output = result.stdout.trim();
  if (!output) throw new Error('Godot version check returned empty output');
  if (Buffer.byteLength(output) > 256 || output.includes('\n') || !/^\d+\.\d+(?:\.\d+)?(?:\.[A-Za-z0-9]+)*$/.test(output)) {
    throw new Error('Godot version check returned malformed output');
  }
  return output;
}

function templateDirectories() {
  // Always include the platform install root (Windows uses %APPDATA%\Godot\export_templates).
  // Keep legacy macOS/Linux paths for side-by-side installs and Flatpak.
  const roots = [
    exportTemplateRoot(),
    join(homedir(), 'Library', 'Application Support', 'Godot', 'export_templates'),
    join(homedir(), '.local', 'share', 'godot', 'export_templates'),
    join(homedir(), '.var', 'app', 'org.godotengine.Godot', 'data', 'godot', 'export_templates'),
  ];
  const seenRoots = new Set();
  const versions = [];
  for (const root of roots) {
    if (!root || seenRoots.has(root) || !existsSync(root)) continue;
    seenRoots.add(root);
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      if (statSync(full).isDirectory()) versions.push(full);
    }
  }
  return versions;
}

function exportTemplateRoot() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Godot', 'export_templates');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Godot', 'export_templates');
  }
  return join(homedir(), '.local', 'share', 'godot', 'export_templates');
}

function templateVersionFromGodot(versionString) {
  // Godot 4.x reports both "4.3.stable.official" and "4.7.1.stable.official…".
  // Template folders use "<version>.<channel>", e.g. 4.7.1.stable.
  const match = String(versionString).trim().match(
    /^(\d+\.\d+(?:\.\d+)?)\.(stable|beta\d*|rc\d*|dev\d*)(?:\.|$)/,
  );
  if (!match) throw new Error(`Cannot derive export template version from Godot: ${versionString}`);
  return `${match[1]}.${match[2]}`;
}

function releaseTagFromTemplateVersion(templateVersion) {
  // 4.7.1.stable → 4.7.1-stable; 4.3.stable → 4.3-stable
  const match = String(templateVersion).trim().match(
    /^(\d+\.\d+(?:\.\d+)?)\.(stable|beta\d*|rc\d*|dev\d*)$/,
  );
  if (!match) throw new Error(`Cannot derive release tag from template version: ${templateVersion}`);
  return `${match[1]}-${match[2]}`;
}

async function officialTemplateAsset(templateVersion) {
  const tag = releaseTagFromTemplateVersion(templateVersion);
  const response = await fetch(`https://api.github.com/repos/godotengine/godot/releases/tags/${tag}`, {
    headers: { 'User-Agent': `godot-flight-deck/${TOOL_VERSION}`, Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`Cannot query Godot release ${tag}: HTTP ${response.status}`);
  const release = await response.json();
  const expectedName = `Godot_v${tag.replace('-', '-')}_export_templates.tpz`;
  const asset = release.assets?.find((candidate) => candidate.name === expectedName)
    ?? release.assets?.find((candidate) => candidate.name.includes('export_templates.tpz') && !candidate.name.includes('mono'));
  if (!asset) throw new Error(`Official export template asset not found for ${tag}`);
  return {
    tag,
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    sha256: String(asset.digest ?? '').replace(/^sha256:/, ''),
  };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': `godot-flight-deck/${TOOL_VERSION}` } });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  mkdirSync(dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function templatesCommand(positional, options) {
  const action = positional[0] ?? 'status';
  const projectCandidate = positional[1];
  const project = projectCandidate ? resolveProject(projectCandidate) : (isProjectDirectory(process.cwd()) ? resolveProject() : null);
  const config = project ? loadConfig(project) : defaultConfig();
  const godot = findGodot(config, options.godot);
  const versionString = godotVersion(godot, options);
  const templateVersion = templateVersionFromGodot(versionString);
  const destination = join(exportTemplateRoot(), templateVersion);
  const installed = existsSync(destination) && readdirSync(destination).length > 0;
  if (action === 'status') {
    console.log(`Godot:     ${versionString}`);
    console.log(`Templates: ${destination}`);
    console.log(`Status:    ${installed ? color.green('installed') : color.yellow('missing')}`);
    return installed ? 0 : 1;
  }
  if (action !== 'install') throw new Error(`Unknown templates action: ${action}`);
  if (installed && !options.force) {
    console.log(color.green(`Export templates already installed: ${destination}`));
    return 0;
  }
  const asset = await officialTemplateAsset(templateVersion);
  const cacheDirectory = join(homedir(), '.cache', 'godot-flight-deck', 'templates');
  const archive = join(cacheDirectory, asset.name);
  console.log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
  if (!existsSync(archive) || statSync(archive).size !== asset.size || options.force) {
    await downloadFile(asset.url, archive);
  } else {
    console.log(color.muted(`Using cached archive: ${archive}`));
  }
  if (asset.sha256) {
    console.log('Verifying SHA-256…');
    const digest = await sha256File(archive);
    if (digest !== asset.sha256) {
      rmSync(archive, { force: true });
      throw new Error(`Template checksum mismatch: expected ${asset.sha256}, received ${digest}`);
    }
  }
  const extraction = join(tmpdir(), `gdeck-templates-${process.pid}-${Date.now()}`);
  mkdirSync(extraction, { recursive: true });
  const unzip = runSync('unzip', ['-q', '-o', archive, '-d', extraction], { quiet: true, timeoutMs: timeoutMilliseconds(options) });
  if (unzip.status !== 0) {
    rmSync(extraction, { recursive: true, force: true });
    throw new Error(`Cannot extract export templates: ${unzip.output}`);
  }
  const source = existsSync(join(extraction, 'templates')) ? join(extraction, 'templates') : extraction;
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
  rmSync(extraction, { recursive: true, force: true });
  console.log(color.green(`Export templates installed: ${destination}`));
  return 0;
}

function defaultExports(project) {
  const projectSettings = readFileSync(join(project, 'project.godot'), 'utf8');
  const nameMatch = projectSettings.match(/^config\/name="([^"]+)"/m);
  const projectName = nameMatch?.[1] ?? 'GodotGame';
  const fileName = projectName.replace(/[^a-zA-Z0-9_-]+/g, '') || 'GodotGame';
  const bundleName = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') || 'godot.game';
  return {
    bundleIdentifier: `com.flightdeck.${bundleName}`,
    targets: {
      macos: { preset: 'macOS', path: `build/macos/${fileName}.zip` },
      windows: { preset: 'Windows Desktop', path: `build/windows/${fileName}.exe` },
      linux: { preset: 'Linux', path: `build/linux/${fileName}.x86_64` },
    },
  };
}

function exportPresetText(exportsConfig) {
  const targets = [
    ['macOS', 'macOS', exportsConfig.targets.macos.path, `application/bundle_identifier="${exportsConfig.bundleIdentifier}"\nbinary_format/architecture="universal"\ncodesign/codesign=1\nnotarization/notarization=0`],
    ['Windows Desktop', 'Windows Desktop', exportsConfig.targets.windows.path, 'binary_format/architecture="x86_64"\ncodesign/enable=false'],
    ['Linux', 'Linux', exportsConfig.targets.linux.path, 'binary_format/architecture="x86_64"'],
  ];
  return `${targets.map(([name, platform, output, options], index) => `[preset.${index}]\n\nname="${name}"\nplatform="${platform}"\nrunnable=${index === 0 ? 'true' : 'false'}\nadvanced_options=false\ndedicated_server=false\ncustom_features=""\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=".gdeck/**,qa/**,tests/**,docs/**,README.md,addons/flight_deck/**"\nexport_path="${output}"\nencryption_include_filters=""\nencryption_exclude_filters=""\nencrypt_pck=false\nencrypt_directory=false\n\n[preset.${index}.options]\n\ncustom_template/debug=""\ncustom_template/release=""\n${options}\n`).join('\n')}\n`;
}

function exportInit(projectCandidate) {
  const project = resolveProject(projectCandidate);
  const path = configPath(project);
  const config = loadConfig(project);
  config.flightDeckVersion = TOOL_VERSION;
  config.exports = config.exports ?? defaultExports(project);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  const presetsPath = join(project, 'export_presets.cfg');
  if (!existsSync(presetsPath)) {
    writeFileSync(presetsPath, exportPresetText(config.exports));
    console.log(color.green(`Created ${presetsPath}`));
  } else {
    console.log(color.yellow(`Preserved existing ${presetsPath}`));
  }
  console.log(`Bundle ID: ${config.exports.bundleIdentifier}`);
  return 0;
}

function sanitizedProjectSettings(source) {
  let result = source.replace(/^FlightDeckProbe=.*(?:\r?\n)?/m, '');
  result = result.replace(/"res:\/\/addons\/flight_deck\/plugin\.cfg"\s*,?\s*/g, '');
  result = result.replace(/PackedStringArray\(\s*,/g, 'PackedStringArray(').replace(/,\s*\)/g, ')');
  return result;
}

function exportSourceExclusions(project, exportsConfig) {
  return [
    { path: join(project, 'build', 'release-manifest.json'), subtree: false },
    ...Object.values(exportsConfig?.targets ?? {})
      .filter((definition) => definition && typeof definition === 'object' && typeof definition.path === 'string')
      .map((definition) => ({ path: dirname(resolve(project, definition.path)), subtree: true })),
  ].filter((item) => pathIsInside(project, item.path));
}

function stageReleaseProject(project, sourceExclusions = [], importRuntime = null) {
  const stagingRoot = createLifecycleTemporaryDirectory('gdeck-release-project-');
  const ignored = new Set(['.git', '.godot', '.gdeck', 'tests', 'qa', 'docs']);
  try {
    cpSync(project, stagingRoot, {
      recursive: true,
      force: true,
      filter: (source) => {
        const relation = relative(project, source);
        if (!relation) return true;
        const parts = relation.split(sep);
        if (ignored.has(parts[0]) || source.endsWith('.import')) return false;
        if (sourceExclusions.some((item) => source === item.path || (item.subtree && pathIsInside(item.path, source)))) return false;
        return !(parts[0] === 'addons' && parts[1] === 'flight_deck');
      },
    });
    makeVerificationTreeWritable(stagingRoot);
    const settingsPath = join(stagingRoot, 'project.godot');
    writeFileSync(settingsPath, sanitizedProjectSettings(readFileSync(settingsPath, 'utf8')));
    rmSync(join(stagingRoot, 'addons', 'flight_deck'), { recursive: true, force: true });
    mkdirSync(join(stagingRoot, '.godot'), { recursive: true });
    const sourceFingerprint = sealableProjectFingerprint(stagingRoot);
    const importableAssets = verificationImportableAssetCount(stagingRoot);
    if (importableAssets > 0) {
      prepareProjectImportsForSealing(stagingRoot, importRuntime);
      if (sealableProjectFingerprint(stagingRoot) !== sourceFingerprint) {
        throw new ResultClassificationError('plan_drift', 'Release source changed while Godot imports were being prepared; export was not started.');
      }
    }
    setVerificationTreeReadOnly(stagingRoot);
    return stagingRoot;
  } catch (error) {
    removeLifecycleTemporaryDirectory(stagingRoot);
    throw error;
  }
}

function macosNativeSmokeOptions(exportsConfig) {
  const definition = exportsConfig.nativeSmoke?.macos;
  if (definition === undefined) return { enabled: false, timeoutMs: 10_000 };
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('exports.nativeSmoke.macos must be an object');
  }
  if (definition.enabled !== undefined && typeof definition.enabled !== 'boolean') {
    throw new Error('exports.nativeSmoke.macos.enabled must be boolean');
  }
  const timeoutSeconds = Number(definition.timeoutSeconds ?? 10);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 30) {
    throw new Error('exports.nativeSmoke.macos.timeoutSeconds must be between 1 and 30');
  }
  return { enabled: definition.enabled === true, timeoutMs: Math.round(timeoutSeconds * 1000) };
}

function validateZipEntryNames(names) {
  for (const name of names) {
    const normalized = String(name);
    const parts = normalized.split('/');
    if (!normalized || normalized.includes('\\') || normalized.includes('\0') || normalized.startsWith('/')
      || /^[A-Za-z]:\//.test(normalized) || parts.includes('..')) {
      throw new Error(`Unsafe macOS archive entry: ${name}`);
    }
  }
}

function nativeMacosSmoke(output, executableEntry, options) {
  const sandbox = createLifecycleTemporaryDirectory('gdeck-native-smoke-');
  const extraction = join(sandbox, 'archive');
  const isolatedHome = join(sandbox, 'home');
  const isolatedTemp = join(sandbox, 'tmp');
  const isolatedData = join(sandbox, 'data');
  const isolatedConfig = join(sandbox, 'config');
  try {
    for (const directory of [extraction, isolatedHome, isolatedTemp, isolatedData, isolatedConfig]) mkdirSync(directory, { recursive: true });
    const metadata = runSync('unzip', ['-Z', '-l', output], { quiet: true, timeoutMs: 30_000 });
    if (metadata.status !== 0) return { passed: false, nativeRun: false, reason: 'cannot inspect macOS archive metadata' };
    if (metadata.stdout.split(/\r?\n/).some((line) => /^l[rwx-]{9}\s/.test(line))) {
      return { passed: false, nativeRun: false, reason: 'macOS archive contains symbolic links' };
    }
    const unzip = runSync('unzip', ['-q', output, '-d', extraction], { quiet: true, timeoutMs: 30_000 });
    if (unzip.status !== 0) return { passed: false, nativeRun: false, reason: 'cannot extract macOS archive for native smoke' };
    const executable = resolve(extraction, executableEntry);
    if (!pathIsInside(extraction, executable) || pathContainsSymlink(extraction, executable) || !existsSync(executable) || !statSync(executable).isFile()) {
      return { passed: false, nativeRun: false, reason: 'macOS app executable is unsafe or missing after extraction' };
    }
    const result = runSync(executable, ['--headless', '--quit-after', '2'], {
      cwd: dirname(executable),
      quiet: true,
      timeoutMs: options.timeoutMs,
      phase: 'native_smoke',
      inheritEnv: false,
      env: {
        HOME: isolatedHome,
        TMPDIR: isolatedTemp,
        XDG_DATA_HOME: isolatedData,
        XDG_CONFIG_HOME: isolatedConfig,
        APPDATA: isolatedData,
        LOCALAPPDATA: isolatedData,
        PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        LC_ALL: process.env.LC_ALL ?? '',
      },
    });
    const passed = result.status === 0 && !ERROR_PATTERN.test(result.output);
    return {
      passed,
      check: 'macOS .app executable launched with isolated user directories',
      nativeRun: passed,
      exitCode: result.status,
      timedOut: result.timedOut,
      reason: passed ? undefined : result.timedOut ? 'native macOS smoke timed out' : 'native macOS smoke failed',
    };
  } finally {
    removeLifecycleTemporaryDirectory(sandbox);
  }
}

function smokeExport(target, output, nativeSmokeOptions = { enabled: false }) {
  const status = statSync(output);
  if (!status.isFile() || status.size <= 0) return { passed: false, reason: 'primary artifact is empty' };
  if (target === 'macos') {
    const listing = runSync('unzip', ['-Z1', output], { quiet: true, timeoutMs: 30_000 });
    const names = listing.stdout.split(/\r?\n/).filter(Boolean);
    if (listing.status !== 0) return { passed: false, reason: 'cannot inspect macOS archive', nativeRun: false };
    try { validateZipEntryNames(names); } catch (error) { return { passed: false, reason: error.message, nativeRun: false }; }
    const executableEntry = names.find((name) => /\.app\/Contents\/MacOS\/[^/]+$/.test(name));
    if (!executableEntry) return { passed: false, reason: 'archive does not contain a macOS .app executable', nativeRun: false };
    if (nativeSmokeOptions.enabled) {
      if (process.platform !== 'darwin') {
        return { passed: false, reason: 'native macOS smoke was requested on a non-macOS host', nativeRun: false };
      }
      return nativeMacosSmoke(output, executableEntry, nativeSmokeOptions);
    }
    return {
      passed: true,
      check: 'archive contains a macOS .app executable',
      nativeRun: false,
      note: 'Structure smoke only; enable exports.nativeSmoke.macos for an isolated native launch on macOS.',
    };
  }
  const companion = output.replace(/\.(?:exe|x86_64)$/i, '.pck');
  const passed = existsSync(companion) && statSync(companion).size > 0;
  return {
    passed,
    check: target === 'windows' ? 'Windows .exe and .pck structure' : 'Linux executable and .pck structure',
    nativeRun: false,
    note: 'Structure smoke only; no Windows/Linux native execution was claimed.',
  };
}

function beginDirectoryReplacement(stagedDirectory, destinationDirectory, backupRoot = dirname(destinationDirectory)) {
  const backup = join(backupRoot, `${basename(destinationDirectory)}.backup-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dirname(destinationDirectory), { recursive: true });
  let hadDestination = false;
  try {
    if (existsSync(destinationDirectory)) {
      renameSync(destinationDirectory, backup);
      hadDestination = true;
    }
    renameSync(stagedDirectory, destinationDirectory);
    return { destinationDirectory, backup, hadDestination };
  } catch (error) {
    if (existsSync(destinationDirectory)) rmSync(destinationDirectory, { recursive: true, force: true });
    if (hadDestination && existsSync(backup)) renameSync(backup, destinationDirectory);
    throw error;
  }
}

function commitDirectoryReplacement(transaction) {
  rmSync(transaction.backup, { recursive: true, force: true });
}

function rollbackDirectoryReplacement(transaction) {
  if (existsSync(transaction.destinationDirectory)) rmSync(transaction.destinationDirectory, { recursive: true, force: true });
  if (transaction.hadDestination && existsSync(transaction.backup)) renameSync(transaction.backup, transaction.destinationDirectory);
}

function replaceDirectoryAtomically(stagedDirectory, destinationDirectory) {
  const transaction = beginDirectoryReplacement(stagedDirectory, destinationDirectory);
  commitDirectoryReplacement(transaction);
}

function fileRollbackSnapshot(path) {
  return existsSync(path) ? { path, existed: true, bytes: readFileSync(path), mode: statSync(path).mode & 0o777 } : { path, existed: false };
}

function restoreFileRollbackSnapshot(snapshot) {
  if (!snapshot.existed) {
    rmSync(snapshot.path, { force: true });
    return;
  }
  mkdirSync(dirname(snapshot.path), { recursive: true });
  const temporary = `${snapshot.path}.rollback-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, snapshot.bytes, { mode: snapshot.mode });
  rmSync(snapshot.path, { force: true });
  renameSync(temporary, snapshot.path);
}

function releaseManifestPath(project) {
  const path = join(project, 'build', 'release-manifest.json');
  if (pathContainsSymlink(project, path)) {
    throw new Error(`Release manifest path must not contain symbolic links: ${path}`);
  }
  return path;
}

function releaseGitSha(project) {
  const result = runSync('git', ['-C', project, 'rev-parse', 'HEAD'], { quiet: true, timeoutMs: 10_000 });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function writeReleaseManifest(project, values) {
  const manifest = {
    schemaVersion: 1,
    flightDeckVersion: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    gitSha: values.gitSha ?? releaseGitSha(project),
    debug: Boolean(values.debug),
    publishRequested: Boolean(values.publishRequested),
    publishReady: false,
    artifacts: values.artifacts ?? [],
  };
  const manifestPath = releaseManifestPath(project);
  mkdirSync(dirname(manifestPath), { recursive: true });
  const temporaryManifest = `${manifestPath}.partial-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporaryManifest, manifestPath);
  return manifest;
}

function exportProject(positional, options, internalStage = null) {
  const targetName = internalStage?.stage.target ?? positional[0] ?? 'all';
  const project = internalStage?.plan.project ?? resolveProject(positional[1] ?? process.cwd());
  const sourceProject = verificationExecutionProject(internalStage) ?? project;
  const config = internalStage
    ? { godotPath: internalStage.stage.runtime.godotPath, exports: internalStage.stage.runtime.exportsConfig }
    : loadConfig(project);
  const exportsConfig = config.exports;
  if (!exportsConfig) throw new Error('Export configuration missing. Run gdeck export-init first.');
  if (!existsSync(join(sourceProject, 'export_presets.cfg'))) throw new Error('export_presets.cfg missing. Run gdeck export-init first.');
  if (options.publish) {
    throw new Error('--publish is unavailable until Flight Deck implements and verifies target-specific signing and notarization.');
  }
  const godot = findGodot(config, options.godot);
  const requested = targetName === 'all' ? ['macos', 'windows', 'linux'] : [targetName];
  const nativeSmokeByTarget = new Map();
  if (requested.includes('macos')) nativeSmokeByTarget.set('macos', macosNativeSmokeOptions(exportsConfig));
  const occupiedOutputs = new Set();
  const plans = requested.map((target) => {
    const definition = exportsConfig.targets?.[target];
    if (!definition) throw new Error(`Unknown export target: ${target}`);
    const finalOutput = resolve(project, options.output && requested.length === 1 ? options.output : definition.path);
    if (!pathIsInside(project, finalOutput)) throw new Error(`Export output must stay inside the project: ${finalOutput}`);
    if (pathContainsSymlink(project, finalOutput)) throw new Error(`Export output path must not contain symbolic links: ${finalOutput}`);
    const finalDirectory = dirname(finalOutput);
    if (finalDirectory === project) {
      throw new Error(`Export output must use a dedicated subdirectory, not the project root: ${finalOutput}`);
    }
    const outputs = target === 'macos'
      ? [finalOutput]
      : [finalOutput, finalOutput.replace(/\.(?:exe|x86_64)$/i, '.pck')];
    for (const output of outputs) {
      if (occupiedOutputs.has(output)) throw new Error(`Export targets resolve to the same artifact path: ${output}`);
      occupiedOutputs.add(output);
    }
    return { target, definition, finalOutput, finalDirectory };
  });
  const directories = [...new Set(plans.map((plan) => plan.finalDirectory))];
  for (let left = 0; left < directories.length; left += 1) {
    for (let right = left + 1; right < directories.length; right += 1) {
      if (pathIsInside(directories[left], directories[right]) || pathIsInside(directories[right], directories[left])) {
        throw new Error(`Export directories must not be nested: ${directories[left]} and ${directories[right]}`);
      }
    }
  }

  const manifestPath = releaseManifestPath(project);
  const groups = new Map();
  const exportStagingRoot = join(project, '.gdeck', 'export-staging');
  if (pathContainsSymlink(project, exportStagingRoot)) throw new Error(`Export staging path must not contain symbolic links: ${exportStagingRoot}`);
  const sourceStage = stageReleaseProject(sourceProject, exportSourceExclusions(sourceProject, exportsConfig), {
    godot,
    timeoutMs: timeoutMilliseconds(options),
  });
  const artifacts = [];
  const replacements = [];
  const manifestRollback = internalStage ? fileRollbackSnapshot(manifestPath) : null;
  let manifestWritten = false;
  let failed = false;
  let timedOut = false;
  let lifecycleStatus = 0;
  try {
    for (const finalDirectory of directories) {
      const stagedDirectory = join(exportStagingRoot, `${basename(finalDirectory)}-${process.pid}-${Date.now()}-${groups.size}`);
      lifecycleRegistryEvent('resource_add', stagedDirectory);
      rmSync(stagedDirectory, { recursive: true, force: true });
      if (existsSync(finalDirectory)) {
        if (!statSync(finalDirectory).isDirectory()) throw new Error(`Export destination is not a directory: ${finalDirectory}`);
        cpSync(finalDirectory, stagedDirectory, { recursive: true });
      } else {
        mkdirSync(stagedDirectory, { recursive: true });
      }
      groups.set(finalDirectory, { stagedDirectory, changed: false });
    }

    for (const plan of plans) {
      const group = groups.get(plan.finalDirectory);
      const stagedOutput = join(group.stagedDirectory, basename(plan.finalOutput));
      rmSync(stagedOutput, { force: true });
      if (plan.target !== 'macos') rmSync(stagedOutput.replace(/\.(?:exe|x86_64)$/i, '.pck'), { force: true });
      console.log(`Exporting ${plan.target} → ${plan.finalOutput}`);
      const mode = options.debug ? '--export-debug' : '--export-release';
      const result = runSync(godot, ['--headless', '--path', sourceStage, mode, plan.definition.preset, stagedOutput], {
        cwd: sourceStage,
        timeoutMs: timeoutMilliseconds(options),
        phase: 'export',
      });
      timedOut ||= result.timedOut;
      if ([124, 125, 127].includes(result.status)) lifecycleStatus = result.status;
      const smoke = result.status === 0 && !ERROR_PATTERN.test(result.output) && existsSync(stagedOutput)
        ? smokeExport(plan.target, stagedOutput, nativeSmokeByTarget.get(plan.target))
        : { passed: false, reason: result.timedOut ? 'export timed out' : 'Godot export failed' };
      if (!smoke.passed) {
        console.log(color.red(`Export failed: ${plan.target}`));
        failed = true;
        if ([124, 125, 127].includes(smoke.exitCode)) lifecycleStatus = smoke.exitCode;
        if (lifecycleStatus !== 0) break;
        continue;
      }
      const stagedFiles = plan.target === 'macos'
        ? [stagedOutput]
        : [stagedOutput, stagedOutput.replace(/\.(?:exe|x86_64)$/i, '.pck')];
      const files = stagedFiles.map((file) => ({
        path: relative(group.stagedDirectory, file),
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
        size: statSync(file).size,
      }));
      group.changed = true;
      artifacts.push({
        target: plan.target,
        path: relative(project, plan.finalOutput),
        sha256: files[0].sha256,
        size: files[0].size,
        files,
        smoke,
      });
    }

    if (internalStage) assertCurrentVerificationPlanForEffect(internalStage.plan, 'before export commit; final artifacts were not replaced');
    for (const [finalDirectory, group] of groups) {
      if (!group.changed) continue;
      if (internalStage) replacements.push(beginDirectoryReplacement(group.stagedDirectory, finalDirectory, exportStagingRoot));
      else replaceDirectoryAtomically(group.stagedDirectory, finalDirectory);
    }
    for (const artifact of artifacts) console.log(color.green(`Export complete: ${artifact.target}`));
    writeReleaseManifest(project, {
      debug: options.debug,
      publishRequested: options.publish,
      artifacts,
    });
    manifestWritten = true;
    if (internalStage) {
      assertCurrentVerificationPlanForEffect(internalStage.plan, 'while export effects were committing; the export transaction was rolled back');
      for (const replacement of replacements) {
        try { commitDirectoryReplacement(replacement); } catch {}
      }
    }
  } catch (error) {
    if (internalStage) {
      const rollbackErrors = [];
      for (const replacement of [...replacements].reverse()) {
        try { rollbackDirectoryReplacement(replacement); } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
      }
      if (manifestWritten) {
        try { restoreFileRollbackSnapshot(manifestRollback); } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
      }
      if (rollbackErrors.length > 0) throw new Error(`${error.message}; export rollback failed: ${rollbackErrors.join('; ')}`);
    }
    throw error;
  } finally {
    const cleanupErrors = [];
    try { removeLifecycleTemporaryDirectory(sourceStage); } catch (error) { cleanupErrors.push(error.message); }
    for (const group of groups.values()) {
      try {
        rmSync(group.stagedDirectory, { recursive: true, force: true });
        if (existsSync(group.stagedDirectory)) throw new Error('path still exists');
        lifecycleRegistryEvent('resource_remove', group.stagedDirectory);
      } catch (error) { cleanupErrors.push(`Cannot remove export staging directory ${group.stagedDirectory}: ${error.message}`); }
    }
    try {
      if (existsSync(exportStagingRoot) && readdirSync(exportStagingRoot).length === 0) rmSync(exportStagingRoot, { recursive: true });
    } catch (error) { cleanupErrors.push(`Cannot remove export staging root ${exportStagingRoot}: ${error.message}`); }
    if (cleanupErrors.length > 0) throw new ResultClassificationError('cleanup_timeout', cleanupErrors.join('; '), 'process_result');
  }
  return lifecycleStatus || (timedOut ? 124 : failed || artifacts.length !== requested.length ? 1 : 0);
}

function gitRoot(project, options = {}) {
  const result = runSync('git', ['-C', project, 'rev-parse', '--show-toplevel'], {
    quiet: true, timeoutMs: timeoutMilliseconds(options), phase: 'git_root',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function sameExistingPath(left, right) {
  try { return realpathSync(resolve(left)) === realpathSync(resolve(right)); }
  catch { return resolve(left) === resolve(right); }
}

function editorSessionPaths(project) {
  const directory = join(project, '.gdeck');
  if (pathContainsSymlink(project, directory)) throw new Error('Editor session directory contains a symbolic link');
  if (!existsSync(directory)) return [];
  const paths = readdirSync(directory)
    .filter((name) => /^editor-session(?:-[0-9a-f]{32})?\.json$/.test(name))
    .sort()
    .map((name) => join(directory, name));
  if (paths.length > 128) throw new Error('Editor session inventory exceeds the safe limit of 128 files');
  return paths;
}

function inspectEditorSessionMetadata(project, path) {
  const base = { path, file: basename(path), fingerprint: { kind: 'unsafe' } };
  if (pathContainsSymlink(project, path)) {
    return { ...base, state: 'unsafe-preserved', detail: `${basename(path)} contains a symbolic link` };
  }
  const fingerprint = fileFingerprint(path);
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size > 16 * 1024) throw new Error('session metadata is not a bounded file');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof data.project !== 'string' || data.project.length === 0) throw new Error('session project is missing');
    const sessionProject = resolve(data.project);
    const host = String(data.host ?? '').toLowerCase();
    const port = Number(data.port);
    if (!sameExistingPath(sessionProject, project)) throw new Error(`session belongs to another project: ${data.project ?? '(unknown)'}`);
    if (data.schema_version !== 1) throw new Error(`unsupported session schema: ${data.schema_version}`);
    if (typeof data.bridge_version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(data.bridge_version)) throw new Error('invalid session bridge version');
    if (host !== '127.0.0.1') throw new Error(`session host must be exactly 127.0.0.1, received ${host}`);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`invalid session port: ${data.port}`);
    if (typeof data.instance_id !== 'string' || !/^[0-9a-f]{32}$/.test(data.instance_id)) throw new Error('invalid session instance id');
    if (!basename(path).includes(data.instance_id)) throw new Error('session filename does not match its instance id');
    if (!Number.isInteger(data.pid) || data.pid <= 0) throw new Error('invalid session process id');
    if (typeof data.started_unix !== 'number' || !Number.isFinite(data.started_unix) || data.started_unix <= 0 || data.started_unix > Date.now() / 1000 + 300) throw new Error('invalid session start time');
    let state = 'metadata-live';
    try {
      process.kill(data.pid, 0);
    } catch (probeError) {
      if (probeError?.code === 'ESRCH') state = 'stale-dead';
      else if (probeError?.code !== 'EPERM') throw new Error(`cannot determine session process state: ${probeError?.code ?? probeError?.message}`);
    }
    return {
      ...base,
      fingerprint,
      state,
      detail: state === 'stale-dead'
        ? `session process is not running: ${data.pid}`
        : `instance ${data.instance_id.slice(0, 12)} on ${host}:${port}, version ${data.bridge_version}`,
      data: { ...data, host, port },
    };
  } catch (error) {
    return { ...base, fingerprint, state: 'invalid-preserved', detail: `${basename(path)} is invalid and was preserved: ${error.message}` };
  }
}

function editorSessionInventory(project) {
  return editorSessionPaths(project).map((path) => inspectEditorSessionMetadata(project, path));
}

function publicEditorSession(item) {
  return {
    file: item.file,
    state: item.state,
    detail: item.detail,
    instanceId: item.data?.instance_id,
    pid: item.data?.pid,
    host: item.data?.host,
    port: item.data?.port,
    bridgeVersion: item.data?.bridge_version,
    startedUnix: item.data?.started_unix,
  };
}

async function inspectEditorSessions(project) {
  const inventory = editorSessionInventory(project);
  const tokenPath = join(project, '.gdeck', 'editor-token');
  const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
  await Promise.all(inventory.filter((item) => item.state === 'metadata-live').map(async (item) => {
    if (!token) {
      item.state = 'live-unreachable';
      item.detail += '; Editor token is missing';
      return;
    }
    try {
      const response = await requestEditorBridge({
        host: item.data.host,
        port: item.data.port,
        token,
        expectedInstanceId: item.data.instance_id,
        action: 'status',
        params: {},
      });
      const problem = bridgeHandshakeProblem(response, project, true, item.data);
      if (problem) {
        item.state = 'live-unreachable';
        item.detail += `; ${problem}`;
      } else {
        item.state = 'authenticated-live';
        item.detail += '; authenticated and reachable';
      }
    } catch (error) {
      item.state = 'live-unreachable';
      item.detail += `; ${error.message}`;
    }
  }));
  return { project, sessions: inventory.map(publicEditorSession) };
}

function cleanupEditorSessions(project) {
  const inventory = editorSessionInventory(project);
  const removed = [];
  for (const item of inventory) {
    if (item.state !== 'stale-dead') continue;
    if (pathContainsSymlink(project, item.path)) continue;
    const refreshed = inspectEditorSessionMetadata(project, item.path);
    if (refreshed.state !== 'stale-dead' || !sameFingerprint(refreshed.fingerprint, item.fingerprint)) continue;
    rmSync(item.path, { force: true });
    syncDirectoryBestEffort(dirname(item.path));
    removed.push(publicEditorSession(refreshed));
  }
  return {
    project,
    removed,
    preserved: inventory.filter((item) => !removed.some((candidate) => candidate.file === item.file)).map(publicEditorSession),
  };
}

function readEditorSession(project) {
  const directory = join(project, '.gdeck');
  let results;
  try { results = editorSessionInventory(project); }
  catch (error) { return { path: directory, status: 'invalid', detail: error.message }; }
  if (results.length === 0) return { path: directory, status: 'missing', detail: 'No Editor session metadata; the Editor may be closed or require a restart' };
  const valid = results.filter((result) => result.state === 'metadata-live');
  if (valid.length === 1) {
    const ignoredCount = results.length - 1;
    return {
      path: valid[0].path,
      status: 'valid',
      data: valid[0].data,
      detail: `${valid[0].detail}${ignoredCount ? `; ${ignoredCount} non-live session file(s) preserved` : ''}`,
    };
  }
  if (valid.length > 1) return { path: directory, status: 'ambiguous', detail: `${valid.length} live Editor sessions found; close all but one before Bridge operations` };
  return { path: directory, status: 'invalid', detail: results.map((result) => result.detail).join('; ') };
}

function editorEndpoint(project, bridgeConfig) {
  const session = readEditorSession(project);
  if (session.status === 'valid') return { host: session.data.host, port: session.data.port, session };
  return {
    host: String(bridgeConfig.host ?? '127.0.0.1').toLowerCase(),
    port: Number(bridgeConfig.port ?? 47835),
    session,
  };
}

function regularFileWithoutSymlink(path, maximumBytes = Infinity) {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= maximumBytes;
  } catch {
    return false;
  }
}

function managedRuntimeProbeInstalled(sourceProject) {
  try {
    const installed = join(sourceProject, 'addons', 'flight_deck', 'runtime_probe.gd');
    const expected = join(ADDON_SOURCE, 'runtime_probe.gd');
    if (!regularFileWithoutSymlink(installed, 4 * 1024 * 1024) || !regularFileWithoutSymlink(expected, 4 * 1024 * 1024)) return false;
    return timingSafeEqual(
      createHash('sha256').update(readFileSync(installed)).digest(),
      createHash('sha256').update(readFileSync(expected)).digest(),
    );
  } catch {
    return false;
  }
}

function exactRuntimeAutoloadInstalled(projectFile) {
  const declarations = [];
  let active = false;
  for (const line of String(projectFile).split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = trimmed.match(/^\[([^\]]+)\]$/);
    if (header) {
      active = header[1] === 'autoload';
      continue;
    }
    if (active && /^FlightDeckProbe\s*=/.test(trimmed)) declarations.push(trimmed);
  }
  return declarations.length === 1 && declarations[0] === 'FlightDeckProbe="*res://addons/flight_deck/runtime_probe.gd"';
}

async function doctor(projectCandidate, options, internalStage = null) {
  const project = internalStage?.plan.project ?? resolveProject(projectCandidate);
  const sourceProject = verificationExecutionProject(internalStage) ?? project;
  const checks = [];
  const projectConfigPath = configPath(project);
  const configExists = existsSync(projectConfigPath);
  let config = defaultConfig();
  let configError = '';
  if (internalStage?.stage.runtime.config) {
    config = internalStage.stage.runtime.config;
  } else if (configExists) {
    try {
      if (!regularFileWithoutSymlink(projectConfigPath, 1024 * 1024)) throw new Error('configuration must be a regular non-symbolic-link file of at most 1048576 bytes');
      config = loadConfig(project);
    } catch (error) {
      configError = error.message;
    }
  }
  let godot = '';
  let godotVersionProbeRan = false;
  let lifecycleStatus = 0;
  try {
    godot = findGodot(config, options.godot);
    checks.push({ id: 'godot-executable', name: 'Godot executable', status: 'ok', detail: godot });
  } catch (error) {
    if ([124, 125, 127].includes(error.exitCode)) lifecycleStatus = error.exitCode;
    checks.push({ id: 'godot-executable', name: 'Godot executable', status: 'error', detail: error.message });
  }
  if (godot) {
    try {
      godotVersionProbeRan = true;
      checks.push({ id: 'godot-version', name: 'Godot version', status: 'ok', detail: godotVersion(godot, options) });
    } catch (error) {
      if ([124, 125, 127].includes(error.exitCode)) lifecycleStatus = error.exitCode;
      checks.push({ id: 'godot-version', name: 'Godot version', status: 'error', detail: error.message });
    }
  } else {
    checks.push({ id: 'godot-version', name: 'Godot version', status: 'warn', detail: 'Not probed because the Godot executable is unavailable' });
  }
  checks.push({
    id: 'flight-deck-config',
    name: 'Flight Deck config',
    status: configError ? 'error' : configExists ? 'ok' : 'warn',
    detail: configError || (configExists ? projectConfigPath : 'Run gdeck init'),
  });
  const projectFilePath = join(sourceProject, 'project.godot');
  let projectFile = '';
  let projectFileError = '';
  try {
    if (!regularFileWithoutSymlink(projectFilePath, 4 * 1024 * 1024)) throw new Error('project.godot must be a regular non-symbolic-link file of at most 4194304 bytes');
    projectFile = readFileSync(projectFilePath, 'utf8');
    if (!/^config_version\s*=\s*\d+\s*$/m.test(projectFile)) throw new Error('project.godot is missing a valid config_version declaration');
  } catch (error) {
    projectFileError = error.message;
  }
  checks.push({
    id: 'project-file',
    name: 'Project file',
    status: projectFileError ? 'error' : 'ok',
    detail: projectFileError || projectFilePath,
  });
  const runtimeProbeInstalled = managedRuntimeProbeInstalled(sourceProject);
  checks.push({
    id: 'runtime-probe',
    name: 'Runtime probe',
    status: runtimeProbeInstalled ? 'ok' : 'error',
    detail: runtimeProbeInstalled ? 'managed runtime probe matches this Flight Deck build' : 'Run gdeck init to install the managed runtime probe',
  });
  const runtimeAutoloadInstalled = !projectFileError && exactRuntimeAutoloadInstalled(projectFile);
  checks.push({
    id: 'runtime-autoload',
    name: 'Runtime autoload',
    status: runtimeAutoloadInstalled ? 'ok' : 'error',
    detail: runtimeAutoloadInstalled ? 'FlightDeckProbe uses the managed runtime path in [autoload]' : projectFileError || 'Run gdeck init to install the exact active FlightDeckProbe autoload',
  });
  const bridgeToken = join(project, '.gdeck', 'editor-token');
  const bridgeConfig = config.editorBridge ?? {};
  const editorIntegrationRequired = internalStage === null;
  const bridgeScriptInstalled = regularFileWithoutSymlink(join(sourceProject, 'addons', 'flight_deck', 'editor_bridge.gd'), 4 * 1024 * 1024);
  const editorPluginEnabled = !projectFileError && projectFile.includes('res://addons/flight_deck/plugin.cfg');
  const tokenInstalled = regularFileWithoutSymlink(bridgeToken, 64 * 1024);
  const endpoint = editorIntegrationRequired ? editorEndpoint(project, bridgeConfig) : {
    host: String(bridgeConfig.host ?? '127.0.0.1').toLowerCase(),
    port: Number(bridgeConfig.port ?? 47835),
    session: { status: 'not_selected', detail: 'Optional Editor integration was not selected by this verification stage' },
  };
  const bridgeHost = endpoint.host;
  const bridgePort = endpoint.port;
  checks.push({
    id: 'editor-bridge-addon',
    name: 'Editor bridge addon',
    status: bridgeScriptInstalled ? 'ok' : editorIntegrationRequired ? 'error' : 'warn',
    detail: bridgeScriptInstalled ? 'installed' : 'Run gdeck init',
  });
  checks.push({
    id: 'editor-plugin-enabled',
    name: 'Editor plugin enabled',
    status: editorPluginEnabled ? 'ok' : editorIntegrationRequired ? 'error' : 'warn',
    detail: editorPluginEnabled ? 'res://addons/flight_deck/plugin.cfg' : 'Run gdeck init, or enable Godot Flight Deck under Project Settings > Plugins',
  });
  checks.push({
    id: 'editor-auth-token',
    name: 'Editor auth token',
    status: tokenInstalled ? 'ok' : editorIntegrationRequired ? 'error' : 'warn',
    detail: tokenInstalled ? bridgeToken : 'Run gdeck init',
  });
  const editorWritesAllowed = bridgeConfig.allowWrites === true;
  const editorSupplementary = bridgeConfig.supplementaryEnabled === true;
  checks.push({
    id: 'editor-write-policy',
    name: 'Editor write policy',
    status: editorWritesAllowed ? 'ok' : 'warn',
    detail: `allowWrites=${editorWritesAllowed ? 'true' : 'false'}; supplementaryEnabled=${editorSupplementary ? 'true' : 'false'}; destructive requires --apply`,
  });
  checks.push({
    id: 'editor-bridge-session',
    name: 'Editor bridge session',
    status: endpoint.session.status === 'valid' && endpoint.session.data.bridge_version === TOOL_VERSION ? 'ok' : 'warn',
    detail: endpoint.session.status === 'valid' && endpoint.session.data.bridge_version !== TOOL_VERSION
      ? `${endpoint.session.detail}; installed CLI is ${TOOL_VERSION}`
      : endpoint.session.detail,
  });
  let editorBridgeProbeRan = false;
  let bridgeAvailability = {
    id: 'editor-bridge-availability',
    name: 'Editor bridge availability',
    status: 'warn',
    detail: 'Bridge not probed because installation prerequisites are incomplete',
  };
  if (!editorIntegrationRequired) {
    bridgeAvailability = {
      id: 'editor-bridge-availability',
      name: 'Editor bridge availability',
      status: 'warn',
      detail: 'Optional Editor integration was not selected; no Bridge connection was attempted',
    };
  } else if (configError) {
    bridgeAvailability = {
      id: 'editor-bridge-availability',
      name: 'Editor bridge availability',
      status: 'warn',
      detail: 'Bridge not probed because Flight Deck configuration is invalid',
    };
  } else if (bridgeHost !== '127.0.0.1') {
    bridgeAvailability = {
      id: 'editor-bridge-availability',
      name: 'Editor bridge availability',
      status: 'error',
      detail: `Bridge host must be exactly 127.0.0.1, received ${bridgeHost}`,
    };
  } else if (!Number.isInteger(bridgePort) || bridgePort < 1024 || bridgePort > 65535) {
    bridgeAvailability = {
      id: 'editor-bridge-availability',
      name: 'Editor bridge availability',
      status: 'error',
      detail: `Invalid Editor Bridge port: ${bridgePort}`,
    };
  } else if (bridgeScriptInstalled && editorPluginEnabled && tokenInstalled) {
    try {
      editorBridgeProbeRan = true;
      const response = await requestEditorBridge({
        host: bridgeHost,
        port: bridgePort,
        token: readFileSync(bridgeToken, 'utf8').trim(),
        action: 'status',
        params: {},
      });
      const connectedProjectValue = String(response.result?.project ?? '');
      const connectedProject = response.ok && connectedProjectValue ? resolve(connectedProjectValue) : '';
      const bridgeVersion = String(response.version ?? response.result?.flight_deck_version ?? 'unknown');
      const expectedSession = endpoint.session.status === 'valid' ? endpoint.session.data : null;
      const expectedInstanceId = expectedSession ? String(expectedSession.instance_id) : '';
      const instanceMatches = expectedSession
        && String(response.result?.instance_id ?? '') === expectedInstanceId
        && Number(response.result?.pid) === Number(expectedSession.pid)
        && Number(response.result?.started_unix) === Number(expectedSession.started_unix);
      bridgeAvailability = response.ok && sameExistingPath(connectedProject, project) && bridgeVersion === TOOL_VERSION && instanceMatches
        ? { id: 'editor-bridge-availability', name: 'Editor bridge availability', status: 'ok', detail: `connected at ${bridgeHost}:${bridgePort}, version ${bridgeVersion}, instance ${expectedInstanceId.slice(0, 12)}` }
        : response.ok && sameExistingPath(connectedProject, project) && bridgeVersion === TOOL_VERSION
          ? { id: 'editor-bridge-availability', name: 'Editor bridge availability', status: 'warn', detail: 'Bridge responded, but its instance does not match valid live session metadata. Restart the Editor before writing.' }
          : response.ok && sameExistingPath(connectedProject, project)
            ? { id: 'editor-bridge-availability', name: 'Editor bridge availability', status: 'warn', detail: `Bridge version mismatch: CLI ${TOOL_VERSION}, Editor ${bridgeVersion}. Restart the Editor before any write operation.` }
            : response.ok
              ? { id: 'editor-bridge-availability', name: 'Editor bridge availability', status: 'warn', detail: `Bridge belongs to another project: ${response.result?.project ?? '(unknown)'}. Open this project in Godot Editor or use its session endpoint.` }
              : { id: 'editor-bridge-availability', name: 'Editor bridge availability', status: 'warn', detail: `Bridge rejected authentication (${response.error ?? 'unknown'}, version ${bridgeVersion}). The port may belong to another project, or the running Editor may have an old token.` };
    } catch (error) {
      bridgeAvailability = {
        id: 'editor-bridge-availability',
        name: 'Editor bridge availability',
        status: 'warn',
        detail: `Bridge unavailable at ${bridgeHost}:${bridgePort}: ${error.message}. If gdeck init ran while the Editor was open, restart it; otherwise enable Godot Flight Deck under Project Settings > Plugins.`,
      };
    }
  }
  checks.push(bridgeAvailability);
  let templates = [];
  let templateError = '';
  try { templates = templateDirectories(); }
  catch (error) { templateError = error.message; }
  checks.push({
    id: 'export-templates',
    name: 'Export templates',
    status: templateError ? 'error' : templates.length > 0 ? 'ok' : 'warn',
    detail: templateError || (templates.length > 0 ? templates.join(', ') : 'No templates installed'),
  });
  const root = gitRoot(project, options);
  checks.push({
    id: 'git-repository',
    name: 'Git repository',
    status: root ? 'ok' : 'warn',
    detail: root || 'Not initialized',
  });
  checks.push({ id: 'project-root', name: 'Project', status: 'ok', detail: project });
  checks.push({
    id: 'cursor-compat-mode',
    name: 'Cursor compat mode',
    status: 'ok',
    detail: cursorCompatEnabled()
      ? 'enabled (in-process CLI; nested Job supervisors skipped)'
      : 'disabled (nested process-runner supervision active; set GDECK_CURSOR_COMPAT=1 for Cursor shells)',
  });
  const addonPluginPath = join(sourceProject, 'addons', 'flight_deck', 'plugin.cfg');
  let installedAddonVersion = '';
  if (existsSync(addonPluginPath)) {
    try {
      installedAddonVersion = String(readFileSync(addonPluginPath, 'utf8').match(/^version="([^"]+)"/m)?.[1] ?? '');
    } catch { installedAddonVersion = ''; }
  }
  const addonFingerprintMatch = managedRuntimeProbeInstalled(sourceProject);
  const addonVersionMatch = Boolean(installedAddonVersion) && installedAddonVersion === TOOL_VERSION && addonFingerprintMatch;
  checks.push({
    id: 'addon-version-match',
    name: 'Addon version match',
    status: !existsSync(join(sourceProject, 'addons', 'flight_deck'))
      ? 'warn'
      : addonVersionMatch ? 'ok' : 'error',
    detail: !existsSync(join(sourceProject, 'addons', 'flight_deck'))
      ? 'Addon not installed; run gdeck init or gdeck sync-addon'
      : addonVersionMatch
        ? `${installedAddonVersion} matches CLI ${TOOL_VERSION}`
        : `Project addon ${installedAddonVersion || 'unknown'} does not match CLI ${TOOL_VERSION}${addonFingerprintMatch ? '' : ' (fingerprint drift)'}; run gdeck sync-addon`,
  });

  const relevance = internalStage ? capabilityRelevanceForPlan(internalStage.plan) : null;
  const capabilities = assessDoctorCapabilities(checks, {
    probes: { godotVersion: godotVersionProbeRan, editorBridge: editorBridgeProbeRan },
  }).map((capability) => relevance ? { ...capability, relevance: relevance[capability.id] } : capability);

  if (options.json) {
    console.log(JSON.stringify({
      toolVersion: TOOL_VERSION,
      project,
      capabilitySchemaVersion: 1,
      probes: { godotVersion: godotVersionProbeRan, editorBridge: editorBridgeProbeRan },
      checks,
      capabilities,
    }, null, 2));
  } else {
    console.log(`Godot Flight Deck ${TOOL_VERSION}\n`);
    for (const check of checks) {
      const marker = check.status === 'ok' ? color.green('✓') : check.status === 'warn' ? color.yellow('!') : color.red('✗');
      console.log(`${marker} ${check.name.padEnd(20)} ${check.detail}`);
    }
    console.log('\nCapabilities');
    for (const capability of capabilities) {
      const marker = capability.status === 'available' ? color.green('✓')
        : capability.status === 'degraded' ? color.yellow('!')
          : capability.status === 'unavailable' ? color.red('✗') : color.muted('?');
      const relevanceLabel = capability.relevance ? ` / ${capability.relevance}` : '';
      console.log(`${marker} ${capability.name.padEnd(26)} ${capability.status}${relevanceLabel}: ${capability.summary}`);
    }
  }
  return lifecycleStatus || (checks.some((check) => check.status === 'error') ? 1 : 0);
}

function checkScriptFile(project, godot, file, options) {
  const target = resolve(project, file);
  if (!pathIsInside(project, target)) throw new Error(`check --file must be inside the project: ${file}`);
  if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`check --file does not exist: ${file}`);
  if (!target.toLowerCase().endsWith('.gd')) throw new Error(`check --file must be a .gd script: ${file}`);
  const runner = join(TOOL_ROOT, 'godot', 'check_script_runner.gd');
  if (!existsSync(runner)) throw new Error(`check script runner missing: ${runner}`);
  console.log(color.muted(`Checking ${target}`));
  const result = runSync(godot, ['--headless', '--path', project, '-s', runner, '--', target], {
    cwd: project, timeoutMs: timeoutMilliseconds(options), phase: 'check-file',
  });
  const failed = result.status !== 0 || ERROR_PATTERN.test(result.output);
  if (failed) {
    console.log(color.red('Flight Deck check failed'));
    const lines = result.output.split(/\r?\n/);
    const digest = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (ERROR_PATTERN.test(lines[index])) {
        digest.push(lines[index].trim());
        if (lines[index + 1]?.includes('at: GDScript::reload')) digest.push(lines[index + 1].trim());
      }
    }
    if (digest.length) console.log(digest.join('\n'));
  } else {
    console.log(color.green('Flight Deck check passed'));
  }
  return failed ? 1 : 0;
}

function checkProject(projectCandidate, options, internalStage = null) {
  const project = internalStage?.plan.project ?? resolveProject(projectCandidate);
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const config = internalStage ? { godotPath: internalStage.stage.runtime.godotPath } : loadConfig(project);
  const godot = findGodot(config, options.godot);
  if (options.file) return checkScriptFile(executionProject, godot, options.file, options);
  console.log(color.muted(`Checking ${project}`));
  const result = runSync(godot, ['--headless', '--path', executionProject, '--editor', '--quit'], {
    cwd: executionProject, timeoutMs: timeoutMilliseconds(options), phase: 'check',
  });
  const failed = result.status !== 0 || ERROR_PATTERN.test(result.output);
  console.log(failed ? color.red('Flight Deck check failed') : color.green('Flight Deck check passed'));
  return failed ? processStatusOr(result) : 0;
}

function resolveRunQuery(options) {
  if (options.query && options['query-file']) throw new Error('Use either --query or --query-file, not both');
  let raw = '';
  if (options.query) raw = String(options.query);
  if (options['query-file']) {
    const file = resolve(options['query-file']);
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`--query-file does not exist: ${file}`);
    raw = readFileSync(file, 'utf8');
  }
  if (!raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--query must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('--query must be a JSON array of query definitions');
  const allowedTypes = new Set(['property', 'tree', 'signals', 'group']);
  const definitions = parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`--query[${index}] must be an object`);
    const type = String(entry.type ?? '');
    if (!allowedTypes.has(type)) throw new Error(`--query[${index}] type must be property/tree/signals/group, got: ${type}`);
    return { ...entry, type, id: String(entry.id ?? `query-${index + 1}`) };
  });
  return definitions;
}

function printQueryResults(reportPath, options) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const queries = report?.queries;
  if (!queries) {
    console.log(color.yellow('No query results in report (query flag was not forwarded to the probe).'));
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(queries, null, 2));
    return;
  }
  console.log(color.green('Query results'));
  console.log(`  seed: ${queries.seed}  frames: ${queries.frames}  count: ${queries.count}`);
  for (const result of queries.results ?? []) {
    const marker = result.ok ? color.green('ok') : color.red('failed');
    console.log(`  [${result.id}] ${result.type} ${marker}`);
    const payload = result.ok ? result.result : { error: result.error };
    console.log(`    ${JSON.stringify(payload)?.slice(0, 600)}`);
  }
}

async function runProject(projectCandidate, options, passthrough) {
  const reserved = passthrough.find((argument) => typeof argument === 'string' && argument.startsWith('--gdeck-'));
  if (reserved) throw new Error(`Game passthrough arguments use the reserved --gdeck- namespace: ${reserved}`);
  const project = resolveProject(projectCandidate);
  const config = loadConfig(project);
  const godot = findGodot(config, options.godot);
  const query = resolveRunQuery(options);
  if (options.watch && query) throw new Error('--watch and --query are mutually exclusive');
  if (options.watch) {
    return runProjectWatched(godot, project, options, passthrough);
  }  if (query) {
    const frames = Number(options.frames ?? 30);
    const seedValue = Number(options.seed ?? 42);
    const report = join(project, '.gdeck', 'reports', `query-${timestamp()}.json`);
    mkdirSync(dirname(report), { recursive: true });
    const userArgs = [
      `--gdeck-query=${JSON.stringify(query)}`,
      `--gdeck-report=${report}`,
      `--gdeck-after-frames=${frames}`,
      `--gdeck-seed=${seedValue}`,
      ...passthrough,
    ];
    console.log(color.muted(`Observing ${project} for ${frames} frames (seed ${seedValue})`));
    const result = runSync(godot, ['--path', project, '--', ...userArgs], {
      cwd: project,
      timeoutMs: timeoutMilliseconds(options),
      phase: 'run-query',
    });
    const failed = result.status !== 0 || ERROR_PATTERN.test(result.output);
    if (failed && !existsSync(report)) {
      console.error(color.red('Query run failed before the report was written'));
      return processStatusOr(result);
    }
    printQueryResults(report, options);
    return failed ? processStatusOr(result) : 0;
  }
  const result = runSync(godot, ['--path', project, ...(passthrough.length ? ['--', ...passthrough] : [])], {
    cwd: project,
    timeoutMs: timeoutMilliseconds(options),
    phase: 'run',
  });
  return result.status;
}

function runProjectWatched(godot, project, options, passthrough) {
  return new Promise((resolvePromise) => {
    const godotArgs = ['--path', project];
    if (options['main-scene']) {
      if (!options['main-scene'].startsWith('res://')) {
        throw new Error('--main-scene must be a res:// path');
      }
      godotArgs.push('--main-scene', options['main-scene']);
    }
    const args = [...godotArgs, ...(passthrough.length ? ['--', ...passthrough] : [])];
    const child = spawn(godot, args, { cwd: project, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timeoutMs = timeoutMilliseconds(options);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.log(color.yellow(`\n[gdeck] watch timeout after ${timeoutMs}ms; terminating game`));
      child.kill();
    }, timeoutMs);
    const errorPattern = /SCRIPT ERROR|Parse Error|ERROR:|FATAL:/;
    const forward = (chunk, streamName) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        if (errorPattern.test(line)) {
          console.log(color.red(`[gdeck:${streamName}] ${line}`));
        } else if (line.startsWith('GDECK_')) {
          console.log(color.muted(`[gdeck:${streamName}] ${line}`));
        } else {
          console.log(`[gdeck:${streamName}] ${line}`);
        }
      }
    };
    child.stdout.on('data', (chunk) => forward(chunk, 'out'));
    child.stderr.on('data', (chunk) => forward(chunk, 'err'));
    let errored = false;
    child.on('error', (error) => {
      errored = true;
      clearTimeout(timer);
      console.error(color.red(`[gdeck] failed to start game: ${error.message}`));
      resolvePromise(1);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      console.log(color.muted(`\n[gdeck] game exited (code ${code ?? '?'}${signal ? `, signal ${signal}` : ''})`));
      // A watch window that ended by our own timeout is a successful observation,
      // not a game failure; only premature exit or error output count as failures.
      const failed = !timedOut && (errored || code !== 0 || signal != null);
      resolvePromise(failed ? 1 : 0);
    });
  });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Oracle chain: the Godot-side cross-client verification scripts from the
// repository's `npm run check` chain, plus the reference baseline check.
// Kept in sync with package.json scripts.check; Web-side steps (npm test,
// build) are intentionally outside the Godot-focused oracle command.
const ORACLE_CHAIN_SCRIPTS = [
  'godot:program-check',
  'godot:domain-data:check',
  'godot:parity-regression:verify',
  'godot:full-loop:verify',
  'godot:migration-check',
  'godot:project:verify',
  'godot:application-session:verify',
  'godot:tactical-battle:verify',
  'godot:tactical-movement:verify',
  'godot:tactical-attack:verify',
  'godot:tactical-skill:verify',
  'godot:tactical-ai:verify',
  'godot:tactical-outcome:verify',
  'godot:tactical-settlement:verify',
  'godot:production-save:verify',
  'godot:campaign-entry:verify',
  'godot:campaign-setup:presentation',
  'godot:tactical-presentation:verify',
  'reference:check',
];

function oracleVerify(projectCandidate, options) {
  const project = resolveProject(projectCandidate);
  let packageFile = join(project, 'package.json');
  let cursor = project;
  while (!existsSync(packageFile)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`oracle-verify requires the repository package.json (searched from ${project})`);
    cursor = parent;
    packageFile = join(cursor, 'package.json');
  }
  const repoRoot = dirname(packageFile);
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const perScriptTimeoutMs = timeoutMilliseconds(options);
  const started = Date.now();
  const results = [];
  let failed = 0;
  for (const script of ORACLE_CHAIN_SCRIPTS) {
    const scriptStarted = Date.now();
    let status;
    let durationMs;
    try {
      const npmResult = spawnSync(npmCommand, ['run', script, '--silent'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: perScriptTimeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        shell: true,
      });
      const timedOut = npmResult.error?.code === 'ETIMEDOUT';
      status = !timedOut && npmResult.status === 0 ? 'passed' : 'failed';
      durationMs = Date.now() - scriptStarted;
      if (status !== 'passed') failed += 1;
      if (timedOut) console.error(color.red(`  ${script}: timed out after ${perScriptTimeoutMs}ms`));
      else if (npmResult.status !== 0 && !options.quiet) {
        const tail = String(npmResult.stdout ?? '').split(/\r?\n/).filter((line) => line.trim()).slice(-4).join('\n');
        if (tail) console.error(color.muted(`    ${tail.slice(0, 600)}`));
      }
    } catch (error) {
      status = 'failed';
      durationMs = Date.now() - scriptStarted;
      failed += 1;
      if (error.message) console.error(color.red(`  ${script}: ${error.message.slice(0, 300)}`));
    }
    results.push({ script, status, durationMs });
    const marker = status === 'passed' ? color.green('passed') : color.red('failed');
    console.log(`  ${marker.padEnd(7)} ${script.padEnd(38)} ${(durationMs / 1000).toFixed(1)}s`);
  }
  const totalMs = Date.now() - started;
  const report = {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    project,
    chain: 'npm run check (Godot side + reference)',
    totalSeconds: totalMs / 1000,
    passed: results.filter((item) => item.status === 'passed').length,
    failed,
    results,
  };
  const reportPath = join(project, '.gdeck', 'reports', `oracle-${timestamp()}.json`);
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch { /* report write is best-effort */ }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Oracle chain: ${report.passed} passed, ${report.failed} failed, ${(totalMs / 1000).toFixed(1)}s`);
    console.log(`  Report: ${reportPath}`);
  }
  return failed > 0 ? 1 : 0;
}

const SCENE_RESOURCE_TYPES = new Map([
  ['Script', ['.gd']],
  ['Texture2D', ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.svg']],
  ['Theme', ['.tres', '.res']],
  ['VideoStream', ['.ogv', '.webm', '.mp4']],
  ['AudioStream', ['.ogg', '.mp3', '.wav']],
  ['Shader', ['.gdshader']],
  ['FontFile', ['.ttf', '.otf', '.woff', '.woff2']],
  ['PackedScene', ['.tscn', '.scn']],
]);

function sceneSet(positional, options, internalStage = null) {
  const project = internalStage?.plan.project ?? (positional[5] ? resolveProject(positional[5]) : resolveProject());
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const config = internalStage ? { godotPath: internalStage.stage.runtime.godotPath } : loadConfig(project);
  const godot = findGodot(config, options.godot);
  const sceneArg = positional[1];
  const nodePath = positional[2] ?? '.';
  const property = positional[3];
  const jsonValue = positional[4];
  if (!sceneArg || !property || jsonValue === undefined) {
    throw new Error('scene set requires <scene> <node-path> <property> <json-value>');
  }
  const scenePath = sceneArg.startsWith('res://') ? sceneArg : `res://${sceneArg.replaceAll('\\', '/')}`;
  const sceneFile = resolve(project, scenePath.slice('res://'.length));
  if (!pathIsInside(project, sceneFile) || !existsSync(sceneFile) || !statSync(sceneFile).isFile()) {
    throw new Error(`scene set: scene not found inside project: ${sceneArg}`);
  }
  if (!scenePath.endsWith('.tscn')) throw new Error(`scene set: target must be a .tscn: ${sceneArg}`);
  try {
    JSON.parse(jsonValue);
  } catch (error) {
    throw new Error(`scene set: value must be valid JSON: ${error.message}`);
  }
  const mode = options.apply ? 'apply' : 'dry';
  let snapshot = '';
  if (mode === 'apply') {
    const snapshotsRoot = join(project, '.gdeck', 'snapshots');
    mkdirSync(snapshotsRoot, { recursive: true });
    const sceneRelative = relative(join(project, 'scenes'), sceneFile).replaceAll('\\', '/').replaceAll('/', '__');
    snapshot = join(snapshotsRoot, `${sceneRelative.replace('.tscn', '')}-${timestamp()}.tscn`);
    cpSync(sceneFile, snapshot);
    console.log(color.muted(`Snapshot: ${snapshot}`));
  }
  const runner = join(TOOL_ROOT, 'godot', 'scene_edit_runner.gd');
  const result = runSync(godot, ['--headless', '--path', executionProject, '-s', runner, '--', scenePath, nodePath, property, jsonValue, mode], {
    cwd: executionProject, timeoutMs: timeoutMilliseconds(options), phase: 'scene-set',
  });
  const failed = result.status !== 0 || ERROR_PATTERN.test(result.output);
  const preview = result.output.split(/\r?\n/).find((line) => line.startsWith('EDIT_PREVIEW')) ?? '';
  if (preview) {
    console.log(color.muted(preview.replace('EDIT_PREVIEW ', 'Preview: ')));
  }
  if (failed) {
    console.error(color.red(`scene set ${mode} failed`));
    if (snapshot) console.error(color.yellow(`  Restore with: gdeck scene restore ${snapshot} --apply`));
    return 1;
  }
  if (mode === 'apply') {
    console.log(color.green(`Applied ${property}=${jsonValue} to ${scenePath}`));
    console.log(color.muted('  Note: ResourceSaver rewrites the whole scene (canonical Godot style); expected.'));
    const doctorResult = sceneDoctor(['doctor', project], { ...options, json: false });
    if (doctorResult !== 0) {
      console.error(color.yellow(`  scene doctor found broken scenes after edit; restore with: gdeck scene restore ${snapshot} --apply`));
    }
    return doctorResult;
  }
  console.log(color.yellow('Dry-run: nothing written. Re-run with --apply to commit.'));
  return 0;
}

function sceneRestore(positional, options, internalStage = null) {
  const project = internalStage?.plan.project ?? (positional[2] ? resolveProject(positional[2]) : resolveProject());
  const snapshotArg = positional[1];
  if (!snapshotArg) throw new Error('scene restore requires <snapshot-path>');
  const snapshotCandidates = [
    resolve(project, '.gdeck', 'snapshots', snapshotArg),
    resolve(project, snapshotArg),
  ];
  const snapshot = snapshotCandidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!snapshot || !pathIsInside(project, snapshot)) {
    throw new Error(`scene restore: snapshot not found inside project: ${snapshotArg}`);
  }
  const sceneFile = resolve(project, 'scenes', `${basename(snapshot, '.tscn').replace(/-\d{4}-\d{2}-\d{2}T[\d-]+Z$/, '').replaceAll('__', '/')}.tscn`);
  const scenePath = `res://${relative(project, sceneFile).replaceAll('\\', '/')}`;
  if (!existsSync(sceneFile)) throw new Error(`scene restore: cannot derive scene path from snapshot: ${snapshotArg}`);
  if (!options.apply) {
    console.log(color.muted(`Would restore ${scenePath} from ${snapshot}`));
    console.log(color.yellow('Dry-run: nothing written. Re-run with --apply to commit.'));
    return 0;
  }
  cpSync(snapshot, sceneFile);
  console.log(color.green(`Restored ${scenePath} from snapshot`));
  return 0;
}

function sceneDoctor(positional, options, internalStage = null) {
  const project = internalStage?.plan.project ?? (positional[1] ? resolveProject(positional[1]) : resolveProject());
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const config = internalStage ? { godotPath: internalStage.stage.runtime.godotPath } : loadConfig(project);
  const godot = findGodot(config, options.godot);
  const sceneRoot = join(project, 'scenes');
  if (!existsSync(sceneRoot) || !statSync(sceneRoot).isDirectory()) {
    throw new Error(`No scenes directory under project: ${sceneRoot}`);
  }
  const findings = [];
  const files = collectSceneFiles(sceneRoot);
  const started = Date.now();
  for (const file of files) {
    scanSceneFile(file, project, findings);
  }
  const staticDurationMs = Date.now() - started;
  const report = runSync(godot, ['--headless', '--path', executionProject, '-s', join(TOOL_ROOT, 'godot', 'scene_scan_runner.gd'), '--', 'res://scenes'], {
    cwd: executionProject, timeoutMs: timeoutMilliseconds(options), phase: 'scene-doctor',
  });
  const loadFindings = parseSceneScanOutput(report.output);
  for (const loadFinding of loadFindings) {
    const alreadyReported = findings.some((item) => item.severity === loadFinding.severity && item.file === loadFinding.file);
    if (!alreadyReported) findings.push(loadFinding);
  }
  const broken = findings.filter((item) => item.severity === 'broken');
  const warnings = findings.filter((item) => item.severity === 'warning');
  const result = {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    project,
    scanned: files.length,
    broken: broken.length,
    warnings: warnings.length,
    staticDurationMs,
    loadDurationMs: report.durationMs ?? null,
    findings,
  };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(color.muted(`Scene doctor: ${files.length} scenes under res://scenes`));
    for (const finding of findings) {
      const marker = finding.severity === 'broken' ? color.red('broken') : finding.severity === 'warning' ? color.yellow('warn') : color.green('ok');
      console.log(`  ${marker.padEnd(7)} ${finding.file}${finding.detail ? ` — ${finding.detail}` : ''}`);
    }
    console.log(broken.length || warnings.length
      ? `${broken.length} broken, ${warnings.length} warnings`
      : color.green(`All ${files.length} scenes OK`));
  }
  return broken.length ? 1 : 0;
}

function collectSceneFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith('.tscn')) files.push(full);
    }
  }
  return files.sort();
}

function scanSceneFile(file, project, findings) {
  const relativePath = `res://${relative(project, file).replaceAll('\\', '/')}`;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const subResourceIds = new Set();
  const nodePaths = new Set();
  let extResources = 0;
  let subResources = 0;
  let loadSteps = 0;
  for (const line of lines) {
    const ext = line.match(/^\[ext_resource(?: type="([^"]*)")? path="([^"]+)" id="([^"]+)"\]/);
    if (ext) {
      extResources += 1;
      const [, type, path, id] = ext;
      const target = path.startsWith('res://') ? path.slice('res://'.length) : path;
      const absolute = resolve(project, target);
      if (!path.startsWith('res://') || !existsSync(absolute) || !statSync(absolute).isFile()) {
        findings.push({ severity: 'broken', file: relativePath, detail: `ext_resource ${id} path missing: ${path}` });
      } else if (type && SCENE_RESOURCE_TYPES.has(type)) {
        const allowed = SCENE_RESOURCE_TYPES.get(type);
        const extnameLower = extname(absolute).toLowerCase();
        if (!allowed.includes(extnameLower)) {
          findings.push({ severity: 'warning', file: relativePath, detail: `ext_resource ${id} type ${type} with unexpected extension ${extnameLower}` });
        }
      }
      continue;
    }
    const sub = line.match(/^\[sub_resource type="([^"]*)" id="([^"]*)"\]/);
    if (sub) {
      subResources += 1;
      const [, , id] = sub;
      if (subResourceIds.has(id)) {
        findings.push({ severity: 'broken', file: relativePath, detail: `duplicate sub_resource id ${id}` });
      }
      subResourceIds.add(id);
      continue;
    }
    const node = line.match(/^\[node name="([^"]*)"(?: type="([^"]*)")?(?: parent="([^"]*)")?(?: instance=ExtResource\("([^"]*)"\))?\]/);
    if (node) {
      const [, name, , parent] = node;
      const fullPath = parent && parent !== '.' ? `${parent}/${name}` : name;
      if (parent && parent !== '.' && !nodePaths.has(parent)) {
        findings.push({ severity: 'warning', file: relativePath, detail: `node ${name} references unknown parent: ${parent}` });
      }
      nodePaths.add(fullPath);
      continue;
    }
    const header = line.match(/^\[gd_scene load_steps=(\d+) format=(\d+)\]/);
    if (header) loadSteps = Number(header[1]);
  }
  if (loadSteps > 0 && loadSteps !== extResources + subResources + 1) {
    findings.push({ severity: 'warning', file: relativePath, detail: `load_steps ${loadSteps} != ext ${extResources} + sub ${subResources} + 1` });
  }
}

function parseSceneScanOutput(output) {
  const findings = [];
  for (const line of output.split(/\r?\n/)) {
    const fail = line.match(/^SCENE_FAIL (.+)$/);
    if (fail) {
      findings.push({ severity: 'broken', file: fail[1], detail: 'Godot load() returned null (see load errors above)' });
      continue;
    }
    const sceneError = line.match(/^ERROR: (res:\/\/[^:]+):\d+ - (.*)$/);
    if (sceneError) {
      findings.push({ severity: 'broken', file: sceneError[1], detail: sceneError[2].trim().slice(0, 300) });
      continue;
    }
    const plainError = line.match(/^ERROR: Resource file not found: (res:\/\/[^ ]+)/);
    if (plainError) {
      findings.push({ severity: 'warning', file: plainError[1], detail: 'Resource file not found during load (see load errors above)' });
    }
  }
  return findings;
}

function unitFailureDetails(stage) {
  const aggregate = stage?.report;
  let cases = null;
  if (typeof stage?.reportPath === 'string' && existsSync(stage.reportPath)) {
    try {
      const parsed = JSON.parse(readFileSync(stage.reportPath, 'utf8'));
      if (Array.isArray(parsed?.cases)) cases = parsed.cases;
    } catch { /* fall back to aggregate projection when the stage report is unreadable */ }
  }
  if (!cases && Array.isArray(aggregate?.cases)) cases = aggregate.cases;
  if (!cases) return [];
  return cases
    .filter((item) => item?.passed === false)
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name : null,
      file: typeof item.file === 'string' ? item.file : null,
      failureKind: typeof item.failure_kind === 'string' ? item.failure_kind : null,
      failures: Array.isArray(item.failures) ? item.failures : [],
      failureDetails: Array.isArray(item.failure_details) ? item.failure_details : [],
    }));
}

function printVerificationFailureDigest(report, output, markdown, options = {}) {
  const stages = Array.isArray(report?.stages) ? report.stages : [];
  const failedStages = stages.filter((stage) => stage?.status === 'failed'
    || stage?.outcome?.classification
    || stage?.resultEnvelope?.verdict === 'FAILED');
  const decisive = failedStages.at(-1) ?? stages.find((stage) => stage?.status && !['passed', 'skipped'].includes(stage.status));
  const recent = stages.slice(-3).map((stage) => {
    const id = stage?.id ?? stage?.name ?? stage?.kind ?? '?';
    const status = stage?.status ?? '?';
    const classification = stage?.outcome?.classification;
    return classification ? `${id}:${status}/${classification}` : `${id}:${status}`;
  });
  const summary = String(decisive?.outcome?.summary ?? decisive?.summary ?? report?.resultEnvelope?.summary ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, 220);
  if (options.json) {
    const unitFailures = decisive ? unitFailureDetails(decisive) : [];
    const classification = decisive?.outcome?.classification ?? decisive?.failure_kind
      ?? (unitFailures.length ? unitFailures[0].failureKind ?? 'unit_assertion' : null)
      ?? 'unknown';
    const digest = {
      schemaVersion: 1,
      toolVersion: TOOL_VERSION,
      verdict: report?.resultEnvelope?.verdict ?? report?.status ?? 'FAILED',
      decisiveStage: decisive ? {
        id: decisive.id ?? decisive.name ?? decisive.kind ?? '?',
        kind: decisive.kind ?? 'stage',
        classification,
        summary: summary || null,
        reportPath: decisive.reportPath ?? null,
        exitCode: decisive.exitCode ?? null,
        outputTail: typeof decisive.outputTail === 'string' ? decisive.outputTail.slice(0, 500) : null,
        failures: unitFailures,
      } : null,
      failedStages: failedStages.map((stage) => ({
        id: stage.id ?? stage.name ?? stage.kind ?? '?',
        kind: stage.kind ?? 'stage',
        status: stage.status ?? '?',
        classification: stage.outcome?.classification ?? stage.failure_kind ?? 'unknown',
        summary: String(stage.outcome?.summary ?? stage.summary ?? '').replace(/\s+/g, ' ').slice(0, 220) || null,
        reportPath: stage.reportPath ?? null,
        failures: unitFailureDetails(stage),
      })),
      recentStages: recent,
      reports: { json: output, markdown },
    };
    console.log(JSON.stringify(digest, null, 2));
    return;
  }
  console.log('\nVerification Failure Digest');
  console.log(`  Verdict: ${report?.resultEnvelope?.verdict ?? report?.status ?? 'FAILED'}`);
  if (decisive) {
    console.log(`  Decisive stage: ${decisive.id ?? decisive.name ?? decisive.kind ?? '?'} (${decisive.kind ?? 'stage'})`);
    console.log(`  Classification: ${decisive.outcome?.classification ?? decisive.failure_kind ?? 'unknown'}`);
  }
  if (summary) console.log(`  Summary: ${summary}`);
  if (recent.length) console.log(`  Recent stages: ${recent.join(', ')}`);
  const capture = decisive?.report?.capture || decisive?.artifacts?.find?.((item) => item?.kind === 'capture')?.path;
  if (capture) console.log(`  Capture: ${capture}`);
  console.log(`  JSON: ${output}`);
  console.log(`  Markdown: ${markdown}`);
}

function profileFor(config, name) {
  const profile = config.profiles?.[name];
  if (!profile) {
    const choices = Object.keys(config.profiles ?? {}).join(', ') || '(none)';
    throw new Error(`Unknown capture profile "${name}". Available: ${choices}`);
  }
  return profile;
}

function fixtureAdapterFor(project, profile) {
  const adapter = profile.fixtureAdapter;
  if (adapter === undefined || adapter === null) return '';
  if (typeof adapter !== 'string' || adapter.length === 0) {
    throw new Error('Profile fixtureAdapter must be a non-empty res://tests/ or res://qa/ .gd path');
  }
  const components = adapter.startsWith('res://') ? adapter.slice('res://'.length).split('/') : [];
  if (!['tests', 'qa'].includes(components[0]) || components.length < 2
    || components.some((component) => !component || component === '.' || component === '..' || component.includes('\\'))
    || !components.at(-1).endsWith('.gd')) {
    throw new Error(`Profile fixtureAdapter must be a res://tests/ or res://qa/ .gd path: ${adapter}`);
  }
  const absolute = resolve(project, ...components);
  if (!pathIsInside(project, absolute)) throw new Error(`Profile fixtureAdapter escapes the project: ${adapter}`);
  if (pathContainsSymlink(project, absolute)) throw new Error(`Profile fixtureAdapter path must not contain symbolic links: ${adapter}`);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`Profile fixtureAdapter file is missing: ${adapter}`);
  const allowedRoot = resolve(project, components[0]);
  if (!pathIsInside(realpathSync(allowedRoot), realpathSync(absolute))) throw new Error(`Profile fixtureAdapter escapes its test root: ${adapter}`);
  return adapter;
}

function ensureFixtureAdapterIsProfileDeclared(userArgs) {
  if (userArgs.some((argument) => typeof argument === 'string' && argument.startsWith('--gdeck-fixture-adapter='))) {
    throw new Error('Fixture adapters must be declared with profile.fixtureAdapter, not userArgs');
  }
}

function runProfileGodot(godot, args, options, fixtureAdapter) {
  if (!fixtureAdapter) return runSync(godot, args, options);
  const isolationRoot = createLifecycleTemporaryDirectory('gdeck-fixture-run-');
  const capability = randomBytes(32).toString('hex');
  const directories = {
    HOME: join(isolationRoot, 'home'),
    USERPROFILE: join(isolationRoot, 'home'),
    XDG_DATA_HOME: join(isolationRoot, 'xdg-data'),
    XDG_CONFIG_HOME: join(isolationRoot, 'xdg-config'),
    XDG_CACHE_HOME: join(isolationRoot, 'xdg-cache'),
    XDG_STATE_HOME: join(isolationRoot, 'xdg-state'),
    APPDATA: join(isolationRoot, 'app-data'),
    LOCALAPPDATA: join(isolationRoot, 'local-app-data'),
  };
  for (const directory of new Set(Object.values(directories))) mkdirSync(directory, { recursive: true });
  try {
    return runSync(godot, [...args, `--gdeck-fixture-capability=${capability}`], {
      ...options,
      env: { ...(options.env ?? {}), ...directories, GDECK_FIXTURE_CAPABILITY: capability },
    });
  } finally {
    removeLifecycleTemporaryDirectory(isolationRoot);
  }
}

function captureProject(positional, options, internalStage = null) {
  const runtime = internalStage?.stage.runtime;
  const selected = internalStage ? { project: internalStage.plan.project, profile: internalStage.stage.target } : projectAndProfile(positional);
  const { project, profile: profileName } = selected;
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const config = runtime ? { godotPath: runtime.godotPath } : loadConfig(project);
  const profile = runtime ? null : profileFor(config, profileName);
  const godot = findGodot(config, options.godot);
  const frames = Number(runtime?.frames ?? options.frames ?? profile?.frames ?? 30);
  const seedValue = Number(runtime?.seed ?? options.seed ?? profile?.seed ?? 42);
  const output = resolve(options.output ?? join(project, '.gdeck', 'captures', `${profileName}-${timestamp()}.png`));
  const report = join(project, '.gdeck', 'reports', `${profileName}-${timestamp()}.json`);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(dirname(report), { recursive: true });
  const profileUserArgs = runtime?.profileUserArgs ?? profile.userArgs ?? [];
  ensureFixtureAdapterIsProfileDeclared(profileUserArgs);
  const fixtureAdapter = runtime?.fixtureAdapter ?? fixtureAdapterFor(project, profile);
  const userArgs = [
    ...profileUserArgs,
    ...(fixtureAdapter ? [`--gdeck-fixture-adapter=${fixtureAdapter}`] : []),
    `--gdeck-capture=${output}`,
    `--gdeck-report=${report}`,
    `--gdeck-after-frames=${frames}`,
    `--gdeck-seed=${seedValue}`,
  ];
  const result = runProfileGodot(godot, ['--path', executionProject, '--fixed-fps', '60', '--', ...userArgs], {
    cwd: executionProject, timeoutMs: timeoutMilliseconds(options), phase: 'capture',
  }, fixtureAdapter);
  const failed = result.status !== 0 || ERROR_PATTERN.test(result.output) || !existsSync(output);
  if (failed) {
    console.error(color.red('Capture failed'));
    return processStatusOr(result);
  }
  console.log(color.green('Capture complete'));
  console.log(`  Image:  ${output}`);
  console.log(`  Report: ${report}`);
  return 0;
}

function scenarioFile(project, candidate) {
  const fileName = candidate.endsWith('.json') ? candidate : `${candidate}.json`;
  const projectScenario = join(project, 'qa', 'scenarios', fileName);
  if (existsSync(projectScenario)) return projectScenario;
  const direct = resolve(candidate);
  if (existsSync(direct)) return direct;
  throw new Error(`Scenario not found: ${candidate}`);
}

function runScenario(positional, options, internalStage = null) {
  if (positional.length === 0) throw new Error('Scenario name or JSON file is required.');
  const runtime = internalStage?.stage.runtime;
  const project = internalStage?.plan.project ?? resolveProject(positional[1] ?? process.cwd());
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  let config;
  let path;
  let frames;
  let seedValue;
  let scenarioName;
  let scenarioStem;
  let capturesOutput;
  let profileUserArgs;
  let scenarioUserArgs;
  let fixtureAdapter;
  if (runtime) {
    config = { godotPath: runtime.godotPath };
    path = verificationExecutionPath(internalStage, runtime.scenarioPath);
    frames = runtime.frames;
    seedValue = runtime.seed;
    scenarioName = runtime.scenarioName;
    scenarioStem = runtime.scenarioStem;
    capturesOutput = runtime.capture || Boolean(options.output);
    profileUserArgs = runtime.profileUserArgs;
    scenarioUserArgs = runtime.targetUserArgs;
    fixtureAdapter = runtime.fixtureAdapter;
  } else {
    const scenarioCandidate = positional[0];
    config = loadConfig(project);
    path = scenarioFile(project, scenarioCandidate);
    const definition = JSON.parse(readFileSync(path, 'utf8'));
    const profileName = options.profile ?? definition.profile ?? 'default';
    const profile = profileFor(config, profileName);
    frames = Number(options.frames ?? definition.timeoutFrames ?? 3600);
    seedValue = Number(options.seed ?? definition.seed ?? profile.seed ?? 42);
    scenarioName = definition.name ?? path.split('/').at(-1).replace(/\.json$/, '');
    scenarioStem = path.split('/').at(-1).replace(/\.json$/, '').replace(/[^A-Za-z0-9_-]+/g, '_') || 'scenario';
    capturesOutput = definition.capture !== false || Boolean(options.output);
    profileUserArgs = profile.userArgs ?? [];
    scenarioUserArgs = definition.userArgs ?? [];
    fixtureAdapter = fixtureAdapterFor(project, profile);
  }
  if (typeof scenarioName !== 'string' || scenarioName.length === 0) throw new Error('Scenario name must be a non-empty string');
  ensureFixtureAdapterIsProfileDeclared([...profileUserArgs, ...scenarioUserArgs]);
  const godot = findGodot(config, options.godot);
  const runTimestamp = timestamp();
  const output = resolve(options.output ?? join(project, '.gdeck', 'captures', `scenario-${scenarioStem}-${runTimestamp}.png`));
  const report = resolve(options.report ?? join(project, '.gdeck', 'reports', `scenario-${scenarioStem}-${runTimestamp}.json`));
  if (capturesOutput) mkdirSync(dirname(output), { recursive: true });
  mkdirSync(dirname(report), { recursive: true });
  const traceEvents = options['trace-events'] === true || process.env.GDECK_TRACE_EVENTS === '1';
  if (!runtime) {
    try {
      const definition = JSON.parse(readFileSync(path, 'utf8'));
      const lintWarnings = lintScenarioDefinition(definition, { traceEvents });
      for (const line of formatScenarioLintWarnings(lintWarnings.filter((item) => item.code !== 'trace_events_enabled'))) {
        console.error(color.yellow(line));
      }
    } catch { /* lint is best-effort */ }
  }
  const userArgs = [
    ...profileUserArgs,
    ...scenarioUserArgs,
    ...(fixtureAdapter ? [`--gdeck-fixture-adapter=${fixtureAdapter}`] : []),
    `--gdeck-scenario=${path}`,
    `--gdeck-report=${report}`,
    `--gdeck-after-frames=${frames}`,
    `--gdeck-seed=${seedValue}`,
  ];
  if (capturesOutput) userArgs.push(`--gdeck-capture=${output}`);
  const result = runProfileGodot(godot, ['--path', executionProject, '--fixed-fps', '60', '--', ...userArgs], {
    cwd: executionProject,
    timeoutMs: timeoutMilliseconds(options),
    phase: 'scenario',
    env: traceEvents ? { GDECK_TRACE_EVENTS: '1' } : undefined,
  }, fixtureAdapter);
  if (!existsSync(report)) {
    console.error(color.red('Scenario failed without producing a report'));
    return processStatusOr(result);
  }
  const data = JSON.parse(readFileSync(report, 'utf8'));
  const scenarioResult = data.scenario ?? {};
  const passed = result.status === 0 && !ERROR_PATTERN.test(result.output) && scenarioResult.status === 'passed';
  console.log(passed ? color.green('Scenario passed') : color.red('Scenario failed'));
  console.log(`  Name:       ${scenarioResult.name ?? scenarioName}`);
  console.log(`  Steps:      ${scenarioResult.steps_completed ?? 0}/${scenarioResult.steps_total ?? 0}`);
  console.log(`  Assertions: ${(scenarioResult.assertions ?? []).filter((item) => item.passed).length}/${(scenarioResult.assertions ?? []).length}`);
  if (scenarioResult.failure) console.log(`  Failure:    ${scenarioResult.failure}`);
  if (!passed && scenarioResult.failure_details?.kind === 'wait_event_timeout') {
    const details = scenarioResult.failure_details;
    console.log(`  Event window: [${details.event_window_start ?? '?'}, ${details.event_window_end ?? '?'}); matches=${details.matches_in_window ?? 0}; prior=${details.prior_matches ?? 0}`);
    if ((traceEvents || scenarioResult.trace_events) && details.trace?.recent_events) {
      for (const event of details.trace.recent_events.slice(-6)) {
        console.log(`  Event #${event.index} frame=${event.frame}: ${event.name}`);
      }
    }
  }
  if (capturesOutput) console.log(`  Image:      ${output}`);
  console.log(`  Report:     ${report}`);
  return passed ? 0 : processStatusOr(result);
}

function baselineProject(positional, options) {
  const { project, profile } = projectAndProfile(positional);
  const output = join(project, 'qa', 'baselines', `${profile}.png`);
  const metadataPath = join(project, 'qa', 'baselines', `${profile}.json`);
  const config = loadConfig(project);
  const profileConfig = profileFor(config, profile);
  const frames = Number(options.frames ?? profileConfig.frames ?? 30);
  const seedValue = Number(options.seed ?? profileConfig.seed ?? 42);
  mkdirSync(dirname(output), { recursive: true });
  const status = captureProject(positional, { ...options, frames, seed: seedValue, output });
  if (status === 0) {
    const metadata = {
      schemaVersion: 1,
      flightDeckVersion: TOOL_VERSION,
      profile,
      frames,
      seed: seedValue,
      pixelThreshold: Number(options.threshold ?? 0.05),
      tolerance: Number(options.tolerance ?? 0.001),
    };
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    console.log(color.green(`Baseline updated: ${output}`));
    console.log(`  Metadata: ${metadataPath}`);
  }
  return status;
}

function visualTest(positional, options, internalStage = null) {
  const runtime = internalStage?.stage.runtime;
  const selected = internalStage ? { project: internalStage.plan.project, profile: internalStage.stage.target } : projectAndProfile(positional);
  const { project, profile } = selected;
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const baseline = runtime ? verificationExecutionPath(internalStage, runtime.baselinePath) : join(project, 'qa', 'baselines', `${profile}.png`);
  if (!existsSync(baseline)) {
    console.error(color.red(`Visual baseline missing: ${baseline}`));
    console.error(`Run: gdeck baseline ${profile} ${project}`);
    return 1;
  }
  const metadataPath = join(project, 'qa', 'baselines', `${profile}.json`);
  const metadata = runtime ? {} : existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, 'utf8')) : {};
  const runTimestamp = timestamp();
  const actual = join(project, '.gdeck', 'captures', `visual-${profile}-${runTimestamp}.png`);
  const diff = join(project, '.gdeck', 'reports', `visual-${profile}-${runTimestamp}-diff.png`);
  const report = resolve(options.report ?? join(project, '.gdeck', 'reports', `visual-${profile}-${runTimestamp}.json`));
  const captureOptions = {
    ...options,
    frames: runtime?.frames ?? options.frames ?? metadata.frames,
    seed: runtime?.seed ?? options.seed ?? metadata.seed,
    output: actual,
  };
  const captureStatus = captureProject(positional, captureOptions, internalStage);
  if (captureStatus !== 0) return captureStatus;
  const config = runtime ? { godotPath: runtime.godotPath } : loadConfig(project);
  const godot = findGodot(config, options.godot);
  const threshold = Number(runtime?.threshold ?? options.threshold ?? metadata.pixelThreshold ?? 0.05);
  const tolerance = Number(runtime?.tolerance ?? options.tolerance ?? metadata.tolerance ?? 0.001);
  const diffScript = 'res://addons/flight_deck/visual_diff.gd';
  const args = [
    '--headless', '--path', executionProject, '--script', diffScript, '--',
    `--baseline=${baseline}`,
    `--actual=${actual}`,
    `--diff=${diff}`,
    `--report=${report}`,
    `--threshold=${threshold}`,
    `--tolerance=${tolerance}`,
  ];
  const result = runSync(godot, args, {
    cwd: executionProject, timeoutMs: timeoutMilliseconds(options), phase: 'visual_diff',
  });
  if (!existsSync(report)) {
    console.error(color.red('Visual comparison failed without producing a report'));
    return processStatusOr(result);
  }
  const data = JSON.parse(readFileSync(report, 'utf8'));
  const passed = result.status === 0 && data.passed === true;
  console.log(passed ? color.green('Visual test passed') : color.red('Visual test failed'));
  console.log(`  Profile:       ${profile}`);
  console.log(`  Changed:       ${(Number(data.changed_ratio) * 100).toFixed(4)}%`);
  console.log(`  Mean error:    ${(Number(data.mean_absolute_error) * 100).toFixed(4)}%`);
  console.log(`  Pixel limit:   ${(threshold * 100).toFixed(2)}%`);
  console.log(`  Ratio limit:   ${(tolerance * 100).toFixed(4)}%`);
  console.log(`  Baseline:      ${baseline}`);
  console.log(`  Actual:        ${actual}`);
  console.log(`  Diff heatmap:  ${diff}`);
  console.log(`  Report:        ${report}`);
  return passed ? 0 : processStatusOr(result);
}

function benchmarkProject(positional, options, internalStage = null) {
  const runtime = internalStage?.stage.runtime;
  const selected = internalStage ? { project: internalStage.plan.project, profile: internalStage.stage.target } : projectAndProfile(positional);
  const { project, profile: profileName } = selected;
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const config = runtime ? { godotPath: runtime.godotPath } : loadConfig(project);
  const profile = runtime ? null : profileFor(config, profileName);
  const godot = findGodot(config, options.godot);
  const frames = Number(runtime?.frames ?? options.frames ?? profile?.benchmarkFrames ?? 600);
  const warmupFrames = Number(runtime?.warmupFrames ?? options.warmup ?? profile?.benchmarkWarmupFrames ?? 60);
  if (!Number.isInteger(frames) || frames < 1) throw new Error('Benchmark frames must be a positive integer');
  if (!Number.isInteger(warmupFrames) || warmupFrames < 0) throw new Error('Benchmark warmup frames must be a non-negative integer');
  const seedValue = Number(runtime?.seed ?? options.seed ?? profile?.seed ?? 42);
  const report = resolve(options.output ?? join(project, '.gdeck', 'reports', `${profileName}-benchmark-${timestamp()}.json`));
  mkdirSync(dirname(report), { recursive: true });
  const profileUserArgs = runtime?.profileUserArgs ?? profile.userArgs ?? [];
  ensureFixtureAdapterIsProfileDeclared(profileUserArgs);
  const fixtureAdapter = runtime?.fixtureAdapter ?? fixtureAdapterFor(project, profile);
  const userArgs = [
    ...profileUserArgs,
    ...(fixtureAdapter ? [`--gdeck-fixture-adapter=${fixtureAdapter}`] : []),
    '--gdeck-benchmark',
    `--gdeck-report=${report}`,
    `--gdeck-warmup-frames=${warmupFrames}`,
    `--gdeck-after-frames=${warmupFrames + frames}`,
    `--gdeck-seed=${seedValue}`,
  ];
  const result = runProfileGodot(godot, ['--path', executionProject, '--', ...userArgs], {
    cwd: executionProject, timeoutMs: timeoutMilliseconds(options), phase: 'benchmark',
  }, fixtureAdapter);
  const failed = result.status !== 0 || ERROR_PATTERN.test(result.output) || !existsSync(report);
  if (failed) {
    console.error(color.red('Benchmark failed'));
    return processStatusOr(result);
  }
  const data = JSON.parse(readFileSync(report, 'utf8'));
  console.log(color.green('Benchmark complete'));
  console.log(`  Warmup frames:   ${data.benchmark_window?.warmup_frames ?? warmupFrames}`);
  console.log(`  Measured frames: ${data.benchmark_window?.stable_frames ?? data.frames}`);
  console.log(`  Stable avg FPS:  ${Number(data.performance.average_fps).toFixed(1)}`);
  if (Number.isFinite(Number(data.performance.average_frame_ms))) {
    console.log(`  Avg frame:       ${Number(data.performance.average_frame_ms).toFixed(2)} ms`);
  }
  if (Number.isFinite(Number(data.performance.worst_frame_ms))) {
    console.log(`  Worst frame:     ${Number(data.performance.worst_frame_ms).toFixed(2)} ms`);
  }
  console.log(`  Worst process*:  ${Number(data.performance.worst_process_ms).toFixed(2)} ms (*TIME_PROCESS monitor, not per-frame)`);
  if (data.performance_timing) {
    console.log(`  Timing samples:  ${(data.performance_timing.samples ?? []).length}/${data.performance_timing.sample_count ?? 0}`);
    console.log(`  Slowest retained: ${(data.performance_timing.slowest_frames ?? []).length}`);
  }
  console.log(`  Nodes:           ${data.performance.nodes}`);
  console.log(`  Active 2D:       ${data.performance.active_2d_objects}`);
  console.log(`  Godot static MB: ${(Number(data.performance.static_memory_bytes) / (1024 * 1024)).toFixed(1)} (snapshot, not RSS/peak)`);
  console.log(`  Report:          ${report}`);
  return 0;
}

function unitRuntimeArguments(options) {
  return ['--tests=res://tests', ...(options.filter ? [`--filter=${options.filter}`] : [])];
}

function verificationUnitOwnerNonce(plan, stage) {
  return createHash('sha256').update(`${plan.invocationIdentity}\0${stage.id}\0unit-owner`).digest('hex');
}

function unitBindingForExecution({ project, report, timeoutMs, options, invocationIdentity, ownerNonce }) {
  return createUnitExecutionBinding({
    invocationIdentity,
    ownerNonce,
    project,
    outputPath: report,
    timeoutMs,
    runtimeArguments: unitRuntimeArguments(options),
  });
}

function reserveDirectUnitReport(report, binding) {
  mkdirSync(dirname(report), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(report, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    const bytes = Buffer.from(JSON.stringify({
      schema_version: 2,
      complete: false,
      unit_binding: binding,
      progress: { sequence: 0, elapsed_ms: 0, completed_cases: 0, total_cases: 0, current_case: null },
    }));
    writeSync(descriptor, bytes);
    fsyncBestEffort(descriptor);
    try { fchmodSync(descriptor, 0o600); } catch (error) {
      if (!(process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'ENOSYS' || error?.code === 'EINVAL'))) throw error;
    }
  } catch (error) {
    throw new ResultClassificationError('report_io', `Cannot reserve invocation-owned Unit report path ${report}: ${error.message}`);
  } finally {
    if (Number.isInteger(descriptor)) closeSync(descriptor);
  }
}

function readUnitReportStable(report, maximumBytes = 64 * 1024 * 1024) {
  let descriptor;
  try {
    descriptor = openSync(report, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) throw new Error('Unit report is empty, unsafe, or oversized');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(report);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.isSymbolicLink()) {
      throw new Error('Unit report changed while it was being read');
    }
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    if (Number.isInteger(descriptor)) closeSync(descriptor);
  }
}

function runUnitTests(projectCandidate, options, internalStage = null, directUnitBinding = null) {
  const project = internalStage?.plan.project ?? resolveProject(projectCandidate);
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const testsDirectory = join(executionProject, 'tests');
  if (!existsSync(testsDirectory)) {
    console.error(color.red(`Tests directory missing: ${testsDirectory}`));
    return 1;
  }
  const config = internalStage ? { godotPath: internalStage.stage.runtime.godotPath } : loadConfig(project);
  const godot = findGodot(config, options.godot);
  const report = resolve(options.output ?? join(project, '.gdeck', 'reports', `unit-${timestamp()}.json`));
  const timeoutMs = timeoutMilliseconds(options);
  const expectedBinding = internalStage
    ? unitBindingForExecution({
      project,
      report,
      timeoutMs,
      options,
      invocationIdentity: internalStage.plan.invocationIdentity,
      ownerNonce: verificationUnitOwnerNonce(internalStage.plan, internalStage.stage),
    })
    : directUnitBinding;
  if (!expectedBinding) throw new ResultClassificationError('configuration', 'Direct Unit requires a GDeck-owned execution binding');
  const reconstructedBinding = unitBindingForExecution({
    project,
    report,
    timeoutMs,
    options,
    invocationIdentity: expectedBinding.invocation_identity,
    ownerNonce: expectedBinding.owner_nonce,
  });
  if (!unitExecutionBindingMatches(expectedBinding, reconstructedBinding)) {
    throw new ResultClassificationError('configuration', 'Direct Unit execution binding does not match its exact project, output, timeout, or runtime arguments');
  }
  if (internalStage) {
    if (existsSync(report)) throw new ResultClassificationError('report_io', `Invocation-owned Unit report path is unexpectedly occupied: ${report}`);
    mkdirSync(dirname(report), { recursive: true });
  } else reserveDirectUnitReport(report, expectedBinding);
  const runtimeArguments = unitRuntimeArguments(options);
  const args = [
    '--headless', '--path', executionProject,
    '--script', 'res://addons/flight_deck/unit_runner.gd', '--',
    ...runtimeArguments,
    `--report=${report}`,
    `--gdeck-unit-binding=${Buffer.from(JSON.stringify(expectedBinding)).toString('base64url')}`,
  ];
  const result = runSync(godot, args, {
    cwd: executionProject, timeoutMs, phase: 'unit', quiet: true,
  });
  if (!existsSync(report)) {
    console.error(color.red('Unit tests failed without producing a report'));
    return processStatusOr(result);
  }
  let data;
  try { data = readUnitReportStable(report); }
  catch (error) {
    console.error(color.red(`Unit tests produced an unreadable report: ${error.message}`));
    return processStatusOr(result);
  }
  const disposition = unitReportDisposition(data, data.schema_version === 2 ? expectedBinding : undefined);
  if (disposition.state !== 'terminal') {
    console.error(color.red(disposition.state === 'incomplete'
      ? 'Unit execution ended with operational-only incomplete evidence'
      : 'Unit execution produced corrupt or mismatched evidence'));
    console.log(`  Report:     ${report}`);
    return processStatusOr(result);
  }
  const passed = result.status === 0 && !ERROR_PATTERN.test(result.output) && data.status === 'passed' && Number(data.summary?.total ?? 0) > 0;
  console.log(passed ? color.green('Unit tests passed') : color.red('Unit tests failed'));
  console.log(`  Cases:      ${data.summary?.passed ?? 0}/${data.summary?.total ?? 0}`);
  console.log(`  Assertions: ${data.summary?.assertions ?? 0}`);
  console.log(`  Duration:   ${data.summary?.duration_ms ?? 0} ms`);
  if (normalizeVerbosity(options.verbosity, 'compact') !== 'compact') {
    for (const item of projectUnitSlowestCases(data, data.schema_version === 2 ? expectedBinding : undefined, { limit: 5 })) {
      console.log(`  Slow case:  #${item.ordinal} ${item.identifier} ${item.durationMs} ms`);
    }
  }
  console.log(`  Report:     ${report}`);
  return passed ? 0 : processStatusOr(result);
}

function requestEditorBridge({ host, port, token, expectedInstanceId = '', action, params }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = connect({ host, port });
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      rejectRequest(new Error(`Editor bridge timed out at ${host}:${port}`));
    }, 3000);
    const finish = (callback, value) => {
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: Date.now(), token, client_version: TOOL_VERSION, expected_instance_id: expectedInstanceId, action, params })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(resolveRequest, JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        finish(rejectRequest, new Error(`Invalid editor bridge response: ${error.message}`));
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      rejectRequest(new Error(`Cannot connect to editor bridge at ${host}:${port}: ${error.message}`));
    });
  });
}

const EDITOR_READ_ACTIONS = new Set(
  Object.entries(EDITOR_ACTION_CATALOG)
    .filter(([, meta]) => meta.layer === 'core-read' || meta.layer === 'meta')
    .map(([name]) => name),
);

function bridgeHandshakeProblem(response, project, requireCompatibleVersion, expectedSession = null) {
  if (!response.ok) return `Editor bridge handshake failed: ${response.error ?? 'unknown error'}`;
  const bridgeProject = String(response.result?.project ?? '');
  if (!bridgeProject || !sameExistingPath(bridgeProject, project)) return `Editor bridge belongs to another project: ${bridgeProject || '(unknown)'}`;
  const bridgeVersion = String(response.version ?? response.result?.flight_deck_version ?? 'unknown');
  if (expectedSession) {
    const identityMatches = String(response.result?.instance_id ?? '') === String(expectedSession.instance_id)
      && Number(response.result?.pid) === Number(expectedSession.pid)
      && Number(response.result?.started_unix) === Number(expectedSession.started_unix);
    if (!identityMatches) return 'Editor bridge identity does not match the active project session. Restart the Editor before writing.';
  }
  if (requireCompatibleVersion && bridgeVersion !== TOOL_VERSION) return `Editor bridge version mismatch: CLI ${TOOL_VERSION}, Editor ${bridgeVersion}. Restart the Editor before writing.`;
  return '';
}

function printEditorResult(action, result) {
  if (action === 'batch') {
    const label = result.dry_run ? 'Batch preflight passed' : 'Batch committed';
    console.log(color.green(`${label}: ${result.name}`));
    console.log(`  Operations: ${result.count}`);
    console.log(`  Dry run:    ${result.dry_run ? 'yes' : 'no'}`);
    if (result.undo_registered) console.log('  Undo:       registered');
    for (const operation of result.operations ?? []) {
      console.log(`  - ${operation.action} ${operation.target}:${operation.property}`);
    }
    return;
  }
  if (action === 'status') {
    console.log(color.green('Godot editor connected'));
    console.log(`  Godot:    ${result.godot_version}`);
    console.log(`  Project:  ${result.project}`);
    console.log(`  Scene:    ${result.edited_scene || '(none)'}`);
    console.log(`  Running:  ${result.is_playing ? 'yes' : 'no'}`);
    console.log(`  Selected: ${(result.selected_nodes ?? []).length}`);
    console.log(`  Writes:   ${result.allow_writes ? 'enabled' : 'disabled'}`);
    console.log(`  Undo:     ${result.can_undo ? 'available' : 'empty'}`);
    return;
  }
  if (action === 'tree') {
    console.log(`Edited scene: ${result.scene || '(none)'}`);
    for (const node of result.nodes ?? []) {
      console.log(`${'  '.repeat(node.depth)}${node.name}  ${color.muted(`[${node.class}] ${node.path}`)}`);
    }
    if (result.truncated) console.log(color.yellow(`… truncated at ${result.limit} nodes`));
    return;
  }
  if (action === 'inspect') {
    console.log(`${result.name} [${result.class}]`);
    console.log(`Path: ${result.path}`);
    if (result.script) console.log(`Script: ${result.script}`);
    for (const property of result.properties ?? []) {
      console.log(`  ${property.name}: ${JSON.stringify(property.value)} ${color.muted(`[${property.type}]`)}`);
    }
    return;
  }
  if (action === 'resource-inspect') {
    console.log(`${result.path} [${result.class}]`);
    for (const property of result.properties ?? []) {
      console.log(`  ${property.name}: ${JSON.stringify(property.value)} ${color.muted(`[${property.type}${property.class ? `:${property.class}` : ''}]`)}`);
    }
    return;
  }
  if (action === 'resource-create') {
    console.log(color.green(`Created ${result.path} [${result.class}]`));
    console.log('  Undo: registered');
    return;
  }
  if (action === 'resource-set') {
    console.log(color.green(`Updated ${result.path}:${result.property}`));
    console.log(`  Old: ${JSON.stringify(result.old_value)}`);
    console.log(`  New: ${JSON.stringify(result.value)}`);
    console.log('  Undo: registered');
    return;
  }
  if (action === 'resource-delete') {
    console.log(color.green(`Deleted ${result.path} [${result.class}]`));
    console.log('  Undo: registered');
    return;
  }
  if (action === 'resource-assign') {
    console.log(color.green(`Assigned ${result.resource} to ${result.path}:${result.property}`));
    console.log('  Undo: registered');
    return;
  }
  if (action === 'create') {
    console.log(color.green(`Created ${result.path} [${result.class}]`));
    console.log('  Undo: registered');
    return;
  }
  if (action === 'delete') {
    console.log(color.green(`Deleted ${result.path}`));
    console.log('  Undo: registered');
    return;
  }
  if (action === 'reorder') {
    console.log(color.green(`Moved ${result.path}: ${result.old_index} → ${result.index}`));
    console.log('  Undo: registered');
    return;
  }
  if (action === 'set') {
    console.log(color.green(`Updated ${result.path}:${result.property}`));
    console.log(`  Type: ${result.type}`);
    console.log(`  Old:  ${JSON.stringify(result.old_value)}`);
    console.log(`  New:  ${JSON.stringify(result.value)}`);
    console.log('  Undo: registered');
    return;
  }
  if (action === 'undo' || action === 'redo') {
    console.log(color.green(action === 'undo' ? `Undid ${result.action ?? 'last action'}` : 'Redid last action'));
    return;
  }
  if (action === 'save') {
    console.log(color.green(`Saved ${result.scene}`));
    return;
  }
  if (action === 'logs') {
    const modified = result.modified_unix ? new Date(result.modified_unix * 1000).toISOString() : 'unknown';
    console.log(`Runtime log: ${result.path || '(unavailable)'} (modified ${modified})`);
    for (const line of result.lines ?? []) console.log(line);
    if ((result.bridge_events ?? []).length > 0) {
      console.log('\nEditor bridge events:');
      for (const line of result.bridge_events) console.log(line);
    }
  }
}

async function editorCommand(positional, options) {
  const action = positional[0] ?? 'status';
  const supported = new Set(Object.keys(CLI_COMMANDS.editor.actions));
  if (!supported.has(action)) {
    console.error(color.red(`Unsupported editor action: ${action}`));
    return 1;
  }
  if (action === 'describe') {
    const targetAction = positional[1];
    const description = describeEditorAction(targetAction);
    if (targetAction && !description) {
      console.error(color.red(`Unknown editor action: ${targetAction}`));
      console.error(`Allowed: ${Object.keys(EDITOR_ACTION_CATALOG).join(', ')}`);
      return 1;
    }
    if (options.json) console.log(JSON.stringify(description, null, 2));
    else if (targetAction) {
      console.log(`editor ${targetAction}`);
      console.log(`  Layer:    ${description.layer}`);
      console.log(`  Risk:     ${description.risk}`);
      console.log(`  Summary:  ${description.summary}`);
      console.log(`  Live Editor: ${description.requiresLiveEditor ? 'required' : 'not required'}`);
      console.log(`  allowWrites: ${description.requiresAllowWrites ? 'required' : 'not required'}`);
      console.log(`  supplementaryEnabled: ${description.requiresSupplementary ? 'required' : 'not required'}`);
      console.log(`  --apply:  ${description.requiresApply ? 'required to mutate' : 'not required'}`);
    } else {
      const layers = listEditorActionsByLayer();
      console.log(`Editor Bridge catalog (${TOOL_VERSION})`);
      for (const [layer, actions] of Object.entries(layers)) {
        if (!actions.length) continue;
        console.log(`  ${layer}: ${actions.join(', ')}`);
      }
      console.log('\nDecision tree:');
      for (const item of AGENT_DECISION_TREE) {
        console.log(`  - ${item.id}: ${item.prefer}`);
      }
      console.log('\nTip: gdeck editor describe <action> --json');
    }
    return 0;
  }
  let target = '';
  let property = '';
  let value;
  let parent = '';
  let className = '';
  let nodeName = '';
  let index = -1;
  let resourcePath = '';
  let resourceClass = '';
  let batch;
  let projectCandidate;
  if (action === 'batch') {
    const batchPath = positional[1];
    if (!batchPath) {
      console.error(color.red('Usage: gdeck editor batch <batch.json> [project] [--dry-run|--apply]'));
      return 1;
    }
    const resolvedBatch = resolve(batchPath);
    if (!existsSync(resolvedBatch)) {
      console.error(color.red(`Batch file not found: ${resolvedBatch}`));
      return 1;
    }
    try { batch = JSON.parse(readFileSync(resolvedBatch, 'utf8')); } catch (error) {
      console.error(color.red(`Invalid batch JSON: ${error.message}`));
      return 1;
    }
    if (!batch || !Array.isArray(batch.operations)) {
      console.error(color.red('Batch JSON must contain an operations array'));
      return 1;
    }
    projectCandidate = positional[2];
  } else if (action === 'inspect') {
    target = positional[1] ?? '.';
    projectCandidate = positional[2];
  } else if (action === 'set') {
    target = positional[1] ?? '.';
    property = positional[2] ?? '';
    const rawValue = positional[3];
    if (!property || rawValue === undefined) {
      console.error(color.red('Usage: gdeck editor set <node-path> <property> <json-value> [project]'));
      return 1;
    }
    try { value = JSON.parse(rawValue); } catch { value = rawValue; }
    projectCandidate = positional[4];
  } else if (action === 'resource-inspect' || action === 'resource-delete') {
    resourcePath = positional[1] ?? '';
    if (!resourcePath) {
      console.error(color.red(`Usage: gdeck editor ${action} <res://path.tres> [project]${action === 'resource-delete' ? ' --apply' : ''}`));
      return 1;
    }
    projectCandidate = positional[2];
  } else if (action === 'resource-create') {
    resourceClass = positional[1] ?? '';
    resourcePath = positional[2] ?? '';
    if (!resourceClass || !resourcePath) {
      console.error(color.red('Usage: gdeck editor resource-create <class> <res://path.tres> [project]'));
      return 1;
    }
    projectCandidate = positional[3];
  } else if (action === 'resource-set') {
    resourcePath = positional[1] ?? '';
    property = positional[2] ?? '';
    const rawValue = positional[3];
    if (!resourcePath || !property || rawValue === undefined) {
      console.error(color.red('Usage: gdeck editor resource-set <res://path.tres> <property> <json-value> [project]'));
      return 1;
    }
    try { value = JSON.parse(rawValue); } catch { value = rawValue; }
    projectCandidate = positional[4];
  } else if (action === 'resource-assign') {
    target = positional[1] ?? '.';
    property = positional[2] ?? '';
    resourcePath = positional[3] ?? '';
    if (!property || !resourcePath) {
      console.error(color.red('Usage: gdeck editor resource-assign <node-path> <property> <res://path.tres> [project]'));
      return 1;
    }
    projectCandidate = positional[4];
  } else if (action === 'create') {
    parent = positional[1] ?? '.';
    className = positional[2] ?? '';
    nodeName = positional[3] ?? '';
    if (!className || !nodeName) {
      console.error(color.red('Usage: gdeck editor create <parent-path> <class> <name> [project]'));
      return 1;
    }
    projectCandidate = positional[4];
  } else if (action === 'delete') {
    target = positional[1] ?? '';
    if (!target) {
      console.error(color.red('Usage: gdeck editor delete <node-path> [project] --apply'));
      return 1;
    }
    projectCandidate = positional[2];
  } else if (action === 'reorder') {
    target = positional[1] ?? '';
    index = Number(positional[2] ?? -1);
    if (!target || !Number.isInteger(index) || index < 0) {
      console.error(color.red('Usage: gdeck editor reorder <node-path> <index> [project]'));
      return 1;
    }
    projectCandidate = positional[3];
  } else {
    projectCandidate = positional[1];
  }
  const project = resolveProject(projectCandidate);
  const actionMeta = EDITOR_ACTION_CATALOG[action];
  // batch defaults to preview without --apply; other destructive actions hard-require --apply
  if (action !== 'batch' && actionMeta?.requiresApply && options.apply !== true) {
    console.error(color.red(`Editor action '${action}' is destructive. Re-run with --apply after explicit human approval.`));
    return 1;
  }
  if (action === 'batch' && options.apply === true && options['dry-run'] === true) {
    console.error(color.red('Conflicting flags: use either --dry-run (preview) or --apply (commit), not both.'));
    return 1;
  }
  // Batch defaults to preview unless --apply is present.
  const batchDryRun = action === 'batch' ? options.apply !== true : Boolean(options['dry-run']);
  if (action === 'batch' && batchDryRun) {
    console.log(color.muted('Batch preview mode (no mutations). Pass --apply to commit after approval.'));
  }
  if (action === 'sessions') {
    const inventory = await inspectEditorSessions(project);
    if (options.json) console.log(JSON.stringify(inventory, null, 2));
    else {
      console.log(`Editor sessions for ${project}`);
      if (inventory.sessions.length === 0) console.log('  No session metadata found.');
      for (const session of inventory.sessions) console.log(`  ${session.state.padEnd(20)} ${session.file}: ${session.detail}`);
    }
    return 0;
  }
  if (action === 'cleanup-sessions') {
    const cleanup = cleanupEditorSessions(project);
    if (options.json) console.log(JSON.stringify(cleanup, null, 2));
    else {
      console.log(`Editor session cleanup for ${project}`);
      console.log(`  Removed:   ${cleanup.removed.length}`);
      console.log(`  Preserved: ${cleanup.preserved.length}`);
      for (const session of cleanup.removed) console.log(`  removed ${session.file}: ${session.detail}`);
    }
    return 0;
  }
  const config = loadConfig(project);
  const bridge = config.editorBridge ?? defaultConfig().editorBridge;
  const policy = resolveEditorBridgePolicy(bridge);
  if (action === 'batch') {
    // Preview and commit both enforce operation-level layer policy (no supplementary bypass).
    const batchGate = validateBatchOperations(batch?.operations ?? [], {
      // Preview may run with allowWrites=false; only enforce allowWrites when committing.
      allowWrites: batchDryRun ? true : policy.allowWrites,
      supplementaryEnabled: policy.supplementaryEnabled,
    });
    if (!batchGate.ok) {
      console.error(color.red(batchGate.error));
      return 1;
    }
    if (!batchDryRun && !policy.allowWrites) {
      console.error(color.red('Editor writes are disabled. Set editorBridge.allowWrites=true in .gdeck/config.json after human approval.'));
      return 1;
    }
  }
  if (actionMeta?.requiresAllowWrites && !policy.allowWrites && !(action === 'batch' && batchDryRun)) {
    console.error(color.red('Editor writes are disabled. Set editorBridge.allowWrites=true in .gdeck/config.json after human approval.'));
    return 1;
  }
  if (actionMeta?.requiresSupplementary && !policy.supplementaryEnabled) {
    console.error(color.red(`Editor action '${action}' requires editorBridge.supplementaryEnabled=true in .gdeck/config.json.`));
    return 1;
  }
  const endpoint = editorEndpoint(project, bridge);
  const bridgeHost = endpoint.host;
  if (bridgeHost !== '127.0.0.1') {
    console.error(color.red(`Editor bridge host must be exactly 127.0.0.1: ${bridgeHost}`));
    return 1;
  }
  const tokenPath = join(project, '.gdeck', 'editor-token');
  const requiresWriteIdentity = !EDITOR_READ_ACTIONS.has(action) && !(action === 'batch' && batchDryRun);
  if (requiresWriteIdentity && endpoint.session.status !== 'valid') {
    console.error(color.red(`Editor writes require valid live session metadata: ${endpoint.session.detail}. Restart the Editor before writing.`));
    return 1;
  }
  const expectedInstanceId = endpoint.session.status === 'valid' ? String(endpoint.session.data.instance_id) : '';
  if (!existsSync(tokenPath)) {
    console.error(color.red('Editor bridge token missing. Run gdeck init first.'));
    return 1;
  }
  const params = {
    path: target,
    property,
    value,
    parent,
    class: className,
    name: batch?.name ?? nodeName,
    index,
    resource: resourcePath,
    resource_class: resourceClass,
    operations: batch?.operations,
    dry_run: batchDryRun,
    // Bridge defense-in-depth: destructive/batch commit must carry confirm_apply.
    confirm_apply: options.apply === true,
    depth: Number(options.depth ?? 8),
    limit: Number(options.limit ?? 500),
  };
  try {
    const token = readFileSync(tokenPath, 'utf8').trim();
    if (action !== 'status') {
      const handshake = await requestEditorBridge({ host: bridgeHost, port: endpoint.port, token, expectedInstanceId, action: 'status', params: {} });
      const problem = bridgeHandshakeProblem(handshake, project, requiresWriteIdentity, requiresWriteIdentity ? endpoint.session.data : null);
      if (problem) {
        console.error(color.red(problem));
        return 1;
      }
      const bridgeVersion = String(handshake.version ?? handshake.result?.flight_deck_version ?? 'unknown');
      if (bridgeVersion !== TOOL_VERSION) console.error(color.yellow(`Editor bridge version mismatch: CLI ${TOOL_VERSION}, Editor ${bridgeVersion}; read-only action allowed.`));
    }
    const response = await requestEditorBridge({
      host: bridgeHost,
      port: endpoint.port,
      token,
      expectedInstanceId,
      action,
      params,
    });
    if (!response.ok) {
      console.error(color.red(`Editor bridge error: ${response.error ?? 'unknown error'}`));
      return 1;
    }
    if (action === 'status') {
      const problem = bridgeHandshakeProblem(response, project, false);
      if (problem) {
        console.error(color.red(problem));
        return 1;
      }
      const bridgeVersion = String(response.version ?? response.result?.flight_deck_version ?? 'unknown');
      if (bridgeVersion !== TOOL_VERSION) console.error(color.yellow(`Editor bridge version mismatch: CLI ${TOOL_VERSION}, Editor ${bridgeVersion}; read-only status allowed.`));
    }
    if (options.json) console.log(JSON.stringify(response.result, null, 2));
    else printEditorResult(action, response.result);
    return 0;
  } catch (error) {
    console.error(color.red(error.message));
    console.error(color.muted('Open the project in Godot Editor and ensure the Flight Deck plugin is enabled.'));
    return 1;
  }
}

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

function assertCurrentVerificationPlanForEffect(plan, context) {
  try {
    const current = resolveVerificationPlan(verificationPlanOptions(plan));
    assertVerificationPlanDigest(current, plan.digest);
    return current;
  } catch (error) {
    throw new Error(`Verification Plan changed ${context}: ${error.message}`);
  }
}

function assertVerificationSnapshotInputs(plan, executionProject) {
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
    throw new ResultClassificationError('plan_drift', 'Verification Plan input changed while preparing the immutable execution snapshot. Nothing was started; invoke verify again.');
  }
}

const GODOT_IMPORT_EXTENSIONS = new Set([
  '.bmp', '.dds', '.exr', '.hdr', '.jpeg', '.jpg', '.ktx', '.png', '.svg', '.svgz', '.tga', '.webp',
  '.mp3', '.ogg', '.wav', '.flac', '.ttf', '.otf', '.woff', '.woff2', '.ogv',
  '.dae', '.gltf', '.glb', '.blend', '.obj', '.fbx', '.csv', '.po', '.mo',
]);

function verificationImportableAssetCount(root) {
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

function sealableProjectFingerprint(root) {
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

function prepareProjectImportsForSealing(root, runtime) {
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
    result = runSync(runtime.godot, ['--headless', '--path', root, '--import'], {
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
  if (!error) return;
  error.resultPhase = 'import_preflight';
  error.resultDiagnosticOutput = String(result.output ?? '');
  error.resultProcessEvidence = {
    phase: 'import_preflight',
    exitCode: Number(result.status),
    reason: result.reason ?? null,
    timedOut: result.timedOut === true,
    cleanupTimedOut: result.cleanupTimedOut === true,
    outputTruncated: result.outputTruncated === true,
    stdoutBytes: Number(result.supervisor?.stdoutBytes ?? 0),
    stderrBytes: Number(result.supervisor?.stderrBytes ?? 0),
    engineError: ERROR_PATTERN.test(result.output),
  };
  throw error;
}

function setVerificationTreeReadOnly(root) {
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

function makeVerificationTreeWritable(root) {
  if (!existsSync(root)) return;
  const visit = (path) => {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) return;
    if (!metadata.isDirectory()) {
      chmodSync(path, metadata.mode & 0o111 ? 0o700 : 0o600);
      return;
    }
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(root);
}

function removeVerificationSnapshot(snapshot) {
  if (!snapshot) return;
  removeLifecycleTemporaryDirectory(snapshot.root);
}

function createVerificationSnapshot(plan) {
  const root = createLifecycleTemporaryDirectory('gdeck-verification-snapshot-');
  const executionProject = join(root, 'project');
  const sourceExclusions = (plan.sourceExclusions ?? []).map((item) => ({
    path: resolve(plan.project, item.path), subtree: item.subtree === true,
  }));
  try {
    cpSync(plan.project, executionProject, {
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
    });
    assertVerificationSnapshotInputs(plan, executionProject);
    mkdirSync(join(executionProject, '.godot'), { recursive: true });
    const importableAssets = verificationImportableAssetCount(executionProject);
    const unitNeedsClassCache = plan.stages.some((stage) => stage.disposition === 'run' && stage.kind === 'unit');
    if (plan.preparation?.godotImportRequired !== (importableAssets > 0 || unitNeedsClassCache)) {
      throw new ResultClassificationError('plan_drift', 'Verification import preparation no longer matches the approved Plan');
    }
    if (plan.preparation.godotImportRequired) {
      const godot = findGodot({ godotPath: plan.preparation.godotPath });
      prepareProjectImportsForSealing(executionProject, { godot, timeoutMs: plan.timeoutMs });
      assertVerificationSnapshotInputs(plan, executionProject);
    }
    setVerificationTreeReadOnly(executionProject);
    return { root, project: executionProject };
  } catch (error) {
    removeVerificationSnapshot({ root, project: executionProject });
    throw error;
  }
}

function verificationExecutionProject(internalStage) {
  return internalStage?.executionProject ?? internalStage?.plan.project;
}

function verificationExecutionPath(internalStage, plannedPath) {
  if (!internalStage) return plannedPath;
  const source = resolve(internalStage.plan.project);
  const absolute = resolve(plannedPath);
  if (absolute !== source && !pathIsInside(source, absolute)) throw new Error(`Planned verification input escapes the project: ${plannedPath}`);
  return resolve(verificationExecutionProject(internalStage), relative(source, absolute));
}

function boundedDoctorVerificationOutput(stdout) {
  try {
    const report = JSON.parse(String(stdout ?? ''));
    const byId = new Map((Array.isArray(report.capabilities) ? report.capabilities : []).map((item) => [item?.id, item]));
    if (byId.size !== DOCTOR_CAPABILITY_IDS.length) throw new Error('incomplete capability projection');
    const lines = DOCTOR_CAPABILITY_IDS.map((id) => {
      const item = byId.get(id);
      if (!item || !['available', 'degraded', 'unavailable', 'not_probed'].includes(item.status)
        || !['required', 'optional', 'irrelevant'].includes(item.relevance)) throw new Error('invalid capability projection');
      return `${DOCTOR_CAPABILITY_NAMES[id]} ${item.status} / ${item.relevance}`;
    });
    if (['editor_bridge_read', 'editor_bridge_write'].every((id) => byId.get(id)?.relevance === 'irrelevant')) {
      lines.unshift('Optional Editor integration was not selected; no Bridge connection was attempted.');
    }
    return lines.join('\n');
  } catch {
    return 'Doctor capability projection was unavailable; raw output withheld.';
  }
}

function executeVerificationCommand(planned, plan, executionProject) {
  const started = process.hrtime.bigint();
  const argumentsList = [...planned.commandArgs, '--timeout', String(planned.timeoutMs / 1000)];
  const outcomeNonce = randomBytes(32).toString('hex');
  const outcomePath = join(dirname(executionProject), `.gdeck-stage-outcome-${randomBytes(8).toString('hex')}.json`);
  const stageContext = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    project: plan.project,
    outputPath: plan.outputPath,
    timeoutSeconds: plan.timeoutSeconds,
    verificationProfile: plan.verificationProfile,
    invocationIdentity: plan.invocationIdentity,
    retentionCandidateManifest: plan.evidenceBinding.retentionCandidates,
    planDigest: plan.digest,
    stageId: planned.id,
    executionProject,
    outcomePath,
    outcomeNonce,
  })).toString('base64url');
  let result;
  let outcome;
  try {
    result = runSync(process.execPath, [CLI_FILE, ...argumentsList], {
      maxBuffer: 64 * 1024 * 1024,
      timeoutMs: planned.timeoutMs + verificationStagePreparationBudgetMilliseconds(plan),
      cleanupTimeoutMs: PROCESS_CLEANUP_TIMEOUT_MS,
      phase: 'stage_wrapper',
      quiet: true,
      propagateLifecycleRegistry: true,
      env: { GDECK_INTERNAL_VERIFY_STAGE: stageContext },
    });
    if (existsSync(outcomePath)) {
      const metadata = statSync(outcomePath);
      if (!metadata.isFile() || metadata.size > 8 * 1024) throw new Error('Internal stage outcome is malformed');
      const candidate = JSON.parse(readFileSync(outcomePath, 'utf8'));
      const allowedClassifications = new Set(['process_spawn', 'configuration', 'precondition', 'fixture_isolation', 'plan_drift', 'report_io', 'timeout', 'cleanup_timeout']);
      if (candidate?.nonce !== outcomeNonce || !allowedClassifications.has(candidate?.classification)
        || !['structured_report', 'preflight', 'process_result'].includes(candidate?.source)) {
        throw new Error('Internal stage outcome is not bound to this invocation');
      }
      outcome = {
        classification: candidate.classification, source: candidate.source, summary: candidate.summary,
        ...(candidate.actual && typeof candidate.actual === 'object' ? { actual: candidate.actual } : {}),
      };
    }
    if (!outcome && result.status === 124) outcome = { classification: 'timeout', source: 'process_result', summary: 'Stage wrapper exceeded its execution deadline' };
    else if (!outcome && result.status === 125) outcome = { classification: 'cleanup_timeout', source: 'process_result', summary: 'Stage wrapper exceeded its cleanup deadline' };
    else if (!outcome && result.status === 127) outcome = { classification: 'process_spawn', source: 'process_result', summary: 'Stage wrapper could not be started' };
  } finally {
    rmSync(outcomePath, { force: true });
  }
  return {
    exitCode: result.status,
    durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    outputTail: planned.kind === 'doctor'
      ? boundedDoctorVerificationOutput(result.stdout)
      : result.status === 0
        ? ''
        : `Stage process exited with code ${Number.isInteger(result.status) ? result.status : 1}; raw stdout/stderr withheld.`,
    outcome,
    processEvidence: {
      phase: result.phase,
      reason: result.reason ?? null,
      timedOut: result.timedOut === true,
      cleanupTimedOut: result.cleanupTimedOut === true,
      cancelled: result.cancelled === true,
      outputTruncated: result.outputTruncated === true,
      stdoutBytes: Number(result.supervisor?.stdoutBytes ?? 0),
      stderrBytes: Number(result.supervisor?.stderrBytes ?? 0),
    },
  };
}

function boundedReportText(value, maximum = 500) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function boundedProjectIdentifier(value, prefix, maximum = 240) {
  const text = boundedReportText(value, maximum);
  return text ? `${prefix}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}` : text;
}

function boundedReportEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function boundedReportNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boundedReportEvidenceValue(value) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (value && typeof value === 'object' && value.type === 'String' && Number.isFinite(value.length)) {
    return { type: 'String', length: value.length };
  }
  if (typeof value === 'string') return { type: 'String', length: value.length };
  return value === undefined ? undefined : { type: Array.isArray(value) ? 'Array' : typeof value };
}

function boundedPerformanceReport(report) {
  const performance = report?.performance;
  if (!performance || typeof performance !== 'object') return undefined;
  const allowed = [
    'average_fps', 'average_frame_ms', 'worst_frame_ms',
    'average_process_ms', 'average_physics_ms', 'worst_process_ms', 'draw_calls',
    'nodes', 'objects', 'static_memory_bytes', 'active_2d_objects',
  ];
  return Object.fromEntries(allowed.filter((key) => typeof performance[key] === 'number' && Number.isFinite(performance[key]))
    .map((key) => [key, performance[key]]));
}

function boundedPerformanceTiming(report) {
  const timing = report?.performance_timing;
  if (!timing || typeof timing !== 'object') return undefined;
  const boundedFacts = (items, limit) => (Array.isArray(items) ? items : []).slice(0, limit).map((item) => ({
    sample_index: boundedReportNumber(item?.sample_index),
    frame: boundedReportNumber(item?.frame),
    fps: boundedReportNumber(item?.fps),
    frame_ms: boundedReportNumber(item?.frame_ms),
    process_ms: boundedReportNumber(item?.process_ms),
    physics_ms: boundedReportNumber(item?.physics_ms),
  }));
  return {
    sample_limit: boundedReportNumber(timing.sample_limit),
    slowest_frame_limit: boundedReportNumber(timing.slowest_frame_limit),
    sample_count: boundedReportNumber(timing.sample_count),
    ...(typeof timing.frame_timing === 'string' ? { frame_timing: boundedReportText(timing.frame_timing, 80) } : {}),
    ...(typeof timing.process_monitor_note === 'string' ? { process_monitor_note: boundedReportText(timing.process_monitor_note, 120) } : {}),
    samples: boundedFacts(timing.samples, 32),
    samples_truncated: timing.samples_truncated === true,
    slowest_frames: boundedFacts(timing.slowest_frames, 8),
  };
}

function boundedStageReport(kind, report) {
  if (!report || typeof report !== 'object') return report;
  const originalBytes = Buffer.byteLength(JSON.stringify(report));
  const common = {
    aggregate_projection: { reason: 'privacy_bounded_stage_projection', originalBytes },
    ...(Number.isInteger(report.schema_version) && report.schema_version >= 1 && report.schema_version <= 100
      ? { schema_version: report.schema_version } : {}),
    ...(typeof report.status === 'string' ? { status: boundedReportEnum(report.status, ['passed', 'failed', 'skipped', 'blocked'], 'unknown') } : {}),
    ...(typeof report.marker === 'string' ? { marker: boundedProjectIdentifier(report.marker, 'marker', 100) } : {}),
  };
  if (kind === 'unit') {
    const allCases = Array.isArray(report.cases) ? report.cases : [];
    const ordered = [...allCases.filter((item) => item?.passed !== true), ...allCases.filter((item) => item?.passed === true)];
    return {
      ...common,
      ...(report.schema_version === 2 && report.complete === true ? { complete: true, unit_binding_accepted: true } : {}),
      summary: report.summary && typeof report.summary === 'object'
        ? Object.fromEntries(['total', 'passed', 'failed', 'skipped', 'assertions', 'duration_ms']
          .filter((key) => typeof report.summary[key] === 'number' && Number.isFinite(report.summary[key]))
          .map((key) => [key, report.summary[key]]))
        : undefined,
      cases: ordered.slice(0, 50).map((item) => ({
        name: boundedProjectIdentifier(item?.name, 'case', 300),
        passed: item?.passed === true,
        assertions: boundedReportNumber(item?.assertions),
        duration_ms: boundedReportNumber(item?.duration_ms),
        failure_kind: boundedReportEnum(item?.failure_kind, ['assertion', 'test_load', 'test_contract', 'precondition', 'error', 'none'], 'unknown'),
        failure_details: (Array.isArray(item?.failure_details) ? item.failure_details : []).slice(0, 3).map((detail) => ({
          assertion: boundedReportEnum(detail?.assertion, ['fail', 'equal', 'not_equal', 'approx', 'true', 'false', 'greater', 'greater_equal', 'less_equal', 'has_key'], 'unknown'),
          expected: boundedReportEvidenceValue(detail?.expected),
          actual: boundedReportEvidenceValue(detail?.actual),
          ...(boundedReportNumber(detail?.epsilon) !== undefined ? { epsilon: detail.epsilon } : {}),
        })),
      })),
      case_list_truncated: allCases.length > 50,
    };
  }
  const performance = boundedPerformanceReport(report);
  const performanceTiming = boundedPerformanceTiming(report);
  const benchmarkWindow = report.benchmark_window && typeof report.benchmark_window === 'object'
    ? Object.fromEntries(['warmup_frames', 'stable_frames', 'total_frames']
      .filter((key) => typeof report.benchmark_window[key] === 'number' && Number.isFinite(report.benchmark_window[key]))
      .map((key) => [key, report.benchmark_window[key]]))
    : undefined;
  if (kind === 'scenario') {
    const scenario = report.scenario;
    const assertions = Array.isArray(scenario?.assertions) ? scenario.assertions : [];
    const orderedAssertions = [...assertions.filter((item) => item?.passed !== true), ...assertions.filter((item) => item?.passed === true)];
    const details = scenario?.failure_details;
    return {
      ...common,
      capture: boundedReportText(report.capture, 1000),
      capture_error: boundedReportNumber(report.capture_error),
      performance,
      performance_timing: performanceTiming,
      benchmark_window: benchmarkWindow,
      scenario: scenario && typeof scenario === 'object' ? {
        name: boundedProjectIdentifier(scenario.name, 'scenario', 200),
        status: boundedReportEnum(scenario.status, ['passed', 'failed', 'skipped', 'blocked'], 'unknown'),
        steps_completed: boundedReportNumber(scenario.steps_completed),
        steps_total: boundedReportNumber(scenario.steps_total),
        failure_kind: boundedReportEnum(scenario.failure_kind, ['expectation', 'precondition', 'error', 'none'], 'unknown'),
        failure_details: details && typeof details === 'object' ? {
          kind: boundedReportEnum(details.kind, ['expectation', 'precondition', 'timeout', 'error'], 'unknown'),
          step_index: boundedReportNumber(details.step_index),
          event: boundedProjectIdentifier(details.event, 'event', 160),
          required_count: boundedReportNumber(details.required_count),
          matches_in_window: boundedReportNumber(details.matches_in_window),
          event_window_start: boundedReportNumber(details.event_window_start),
          event_window_end: boundedReportNumber(details.event_window_end),
          prior_matches: details.prior_matches && typeof details.prior_matches === 'object' ? {
            total: boundedReportNumber(details.prior_matches.total),
            limit: boundedReportNumber(details.prior_matches.limit),
            truncated: details.prior_matches.truncated === true,
          } : undefined,
        } : undefined,
        assertions: orderedAssertions.slice(0, 40).map((item) => ({
          index: boundedReportNumber(item?.index),
          passed: item?.passed === true,
          failure_kind: boundedReportEnum(item?.failure_kind, ['expectation', 'precondition', 'error', 'none'], 'unknown'),
          event: boundedProjectIdentifier(item?.event, 'event', 160),
          count: boundedReportNumber(item?.count),
          expected_count_gte: boundedReportNumber(item?.expected_count_gte),
          expected_count_lte: boundedReportNumber(item?.expected_count_lte),
        })),
        assertion_list_truncated: assertions.length > 40,
      } : null,
    };
  }
  if (kind === 'benchmark') return { ...common, performance, performance_timing: performanceTiming, benchmark_window: benchmarkWindow };
  if (kind === 'visual') {
    const allowed = [
      'passed', 'reason', 'baseline', 'actual', 'diff', 'diff_error', 'width', 'height', 'changed_pixels',
      'total_pixels', 'changed_ratio', 'mean_absolute_error', 'maximum_channel_error', 'pixel_threshold', 'tolerance',
      'baseline_size', 'actual_size',
    ];
    return { ...common, ...Object.fromEntries(allowed.filter((key) => report[key] !== undefined).map((key) => {
      const value = report[key];
      if (typeof value === 'string') {
        if (['actual', 'diff'].includes(key)) return [key, boundedReportText(value, 1000)];
        return [key, boundedProjectIdentifier(value, key, 1000)];
      }
      if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return [key, value];
      if (Array.isArray(value)) return [key, value.slice(0, 4).map((item) => boundedReportNumber(item))];
      return [key, undefined];
    })) };
  }
  return { ...common, performance, benchmark_window: benchmarkWindow };
}

function boundedOutputTail(output, maximumLines = 24, maximumLineCharacters = 1000) {
  return String(output ?? '').trim().split('\n').slice(-maximumLines)
    .map((line) => boundedReportText(line, maximumLineCharacters) ?? '').join('\n');
}

function performanceBudgetResults(performance, budgets = {}) {
  const definitions = [
    ['averageFpsGte', 'average_fps', 'average_fps', '>=', 1],
    ['worstFrameMsLte', 'worst_frame_ms', 'worst_frame_ms', '<=', 1],
    ['averageFrameMsLte', 'average_frame_ms', 'average_frame_ms', '<=', 1],
    ['worstProcessMsLte', 'worst_process_ms', 'worst_process_ms', '<=', 1],
    ['averageProcessMsLte', 'average_process_ms', 'average_process_ms', '<=', 1],
    ['averagePhysicsMsLte', 'average_physics_ms', 'average_physics_ms', '<=', 1],
    ['nodesLte', 'nodes', 'nodes', '<=', 1],
    ['objectsLte', 'objects', 'objects', '<=', 1],
    ['active2dObjectsLte', 'active_2d_objects', 'active_2d_objects', '<=', 1],
    ['staticMemoryMbLte', 'static_memory_bytes', 'static_memory_mb', '<=', 1024 * 1024],
    ['drawCallsLte', 'draw_calls', 'draw_calls', '<=', 1],
  ];
  const results = [];
  for (const [budgetName, sourceMetric, displayMetric, operator, divisor] of definitions) {
    if (budgets[budgetName] === undefined) continue;
    const actual = Number(performance?.[sourceMetric] ?? Number.NaN) / divisor;
    const limit = Number(budgets[budgetName]);
    const passed = Number.isFinite(actual) && (operator === '>=' ? actual >= limit : actual <= limit);
    results.push({ budget: budgetName, metric: displayMetric, operator, actual, limit, passed });
  }
  return results;
}

function boundedVerificationReportJson(report, maximumBytes = 7 * 1024 * 1024) {
  const serialize = () => `${JSON.stringify(report, null, 2)}\n`;
  let json = serialize();
  if (Buffer.byteLength(json) <= maximumBytes) return json;
  const originalStageCount = report.stages.length;
  const originalCoverageCount = report.coverage.length;
  report.aggregateTruncation = { embeddedStageReports: 0, outputTails: 0, stageEntries: 0, coverageEntries: 0 };
  for (const stage of report.stages) {
    if (stage.report !== null && stage.report !== undefined) {
      stage.report = null;
      stage.reportOmittedFromAggregate = true;
      report.aggregateTruncation.embeddedStageReports += 1;
    }
    if (stage.outputTail) {
      stage.outputTail = boundedReportText(stage.outputTail, 500) ?? '';
      report.aggregateTruncation.outputTails += 1;
    }
  }
  for (const item of report.coverage) {
    if (item?.reason?.message) item.reason.message = boundedReportText(item.reason.message, 200);
  }
  json = serialize();
  let stageLimit = report.stages.length;
  let coverageLimit = report.coverage.length;
  while (Buffer.byteLength(json) > maximumBytes && (stageLimit > 1 || coverageLimit > 1)) {
    if (stageLimit >= coverageLimit && stageLimit > 1) stageLimit = Math.max(1, Math.floor(stageLimit / 2));
    else if (coverageLimit > 1) coverageLimit = Math.max(1, Math.floor(coverageLimit / 2));
    const failedStages = report.stages.filter((stage) => stage.status === 'failed');
    const otherStages = report.stages.filter((stage) => stage.status !== 'failed');
    report.stages = [...failedStages, ...otherStages].slice(0, stageLimit);
    report.coverage = report.coverage.slice(0, coverageLimit);
    report.aggregateTruncation.stageEntries = originalStageCount - report.stages.length;
    report.aggregateTruncation.coverageEntries = originalCoverageCount - report.coverage.length;
    json = serialize();
  }
  if (Buffer.byteLength(json) > maximumBytes) {
    throw new ResultClassificationError('report_io', `Bounded verification report still exceeds ${maximumBytes} bytes after deterministic projection`);
  }
  report.resultEnvelope.truncation.occurred = true;
  report.resultEnvelope.truncation.aggregateReport = { ...report.aggregateTruncation };
  const bounded = serialize();
  if (Buffer.byteLength(bounded) > maximumBytes) {
    throw new ResultClassificationError('report_io', `Bounded verification report exceeds ${maximumBytes} bytes after truncation disclosure`);
  }
  return bounded;
}

function verificationMarkdown(report) {
  const envelopeMarkdown = renderResultEnvelopeMarkdown(report.resultEnvelope).trimEnd().split('\n');
  const lines = [
    '# Godot Flight Deck Verification',
    '',
    ...envelopeMarkdown,
    '',
    `- Status: **${report.status.toUpperCase()}**`,
    `- Project: \`${report.project}\``,
    `- Verification Profile: \`${report.verificationProfile ?? '(legacy verify)'}\``,
    `- Flight Deck: \`${report.flightDeckVersion}\``,
    `- Duration: \`${(report.durationMs / 1000).toFixed(2)}s\``,
    '',
    '| Stage | Target | Status | Duration |',
    '|---|---|---:|---:|',
  ];
  for (const stage of report.stages) {
    const label = stage.status === 'passed' ? 'PASS' : stage.status === 'skipped' ? 'SKIP' : 'FAIL';
    lines.push(`| ${stage.kind} | ${stage.target.replaceAll('|', '\\|')} | ${label} | ${(stage.durationMs / 1000).toFixed(2)}s |`);
  }
  if (Array.isArray(report.coverage) && report.coverage.length > 0) {
    lines.push('', '## Planned coverage', '', '| Kind | Target | Disposition | Execution | Reason |', '|---|---|---:|---:|---|');
    for (const item of report.coverage) {
      lines.push(`| ${String(item.kind).replaceAll('|', '\\|')} | ${String(item.target).replaceAll('|', '\\|')} | ${item.disposition} | ${item.execution} | ${String(item.reason?.message ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ')} |`);
    }
  }
  const budgetStages = report.stages.filter((stage) => stage.budgets?.length);
  if (budgetStages.length) {
    lines.push('', '## Performance budgets', '', '| Profile | Metric | Actual | Budget | Status |', '|---|---|---:|---:|---:|');
    for (const stage of budgetStages) {
      for (const budget of stage.budgets) {
        lines.push(`| ${stage.target} | ${budget.metric} | ${budget.actual.toFixed(2)} | ${budget.operator} ${budget.limit} | ${budget.passed ? 'PASS' : 'FAIL'} |`);
      }
    }
  }
  lines.push('', `Passed: ${report.summary.passed}, Skipped: ${report.summary.skipped}, Failed: ${report.summary.failed}`, '');
  return `${lines.join('\n')}\n`;
}

function preflightReportForVerificationPlan(plan) {
  return {
    verificationProfile: plan.verificationProfile,
    coverage: plan.stages.map((stage) => ({
      kind: stage.kind,
      target: stage.target,
      disposition: stage.disposition,
      execution: stage.disposition === 'run' ? 'not_attempted' : 'not_applicable',
      reason: stage.reason,
    })),
  };
}

function reportIoFailure(summary, error = undefined) {
  if (error?.resultClassification === 'report_io') return error;
  const suffix = typeof error?.code === 'string' ? ` (${error.code})` : '';
  return new ResultClassificationError('report_io', `${summary}${suffix}`);
}

function removeVerificationPublicationFile(plan, path, label, expectedIdentity = undefined) {
  let fileDescriptor;
  let directoryDescriptor;
  let quarantinePath;
  try {
    if (!existsSync(path)) return;
    if (pathContainsSymlink(plan.project, path)) {
      throw new ResultClassificationError('report_io', `${label} is not a safe regular file: ${path}`);
    }
    fileDescriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fileDescriptor);
    const visible = lstatSync(path);
    if (!opened.isFile() || visible.isSymbolicLink() || visible.dev !== opened.dev || visible.ino !== opened.ino
      || (expectedIdentity && (opened.dev !== expectedIdentity.dev || opened.ino !== expectedIdentity.ino))) {
      throw new ResultClassificationError('report_io', `${label} is not a safe regular file: ${path}`);
    }
    directoryDescriptor = openSync(
      dirname(path), fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
    quarantinePath = join(dirname(path), `.gdeck-remove-${randomBytes(12).toString('hex')}`);
    renameSync(path, quarantinePath);
    const quarantined = lstatSync(quarantinePath);
    if (!quarantined.isFile() || quarantined.isSymbolicLink() || quarantined.dev !== opened.dev || quarantined.ino !== opened.ino) {
      if (!existsSync(path)) renameSync(quarantinePath, path);
      throw new ResultClassificationError('report_io', `${label} changed while it was being invalidated: ${path}`);
    }
    unlinkSync(quarantinePath);
    quarantinePath = undefined;
    fsyncBestEffort(directoryDescriptor);
    if (existsSync(path)) {
      throw new ResultClassificationError('report_io', `${label} replacement appeared during invalidation: ${path}`);
    }
  } catch (error) {
    throw reportIoFailure(`Cannot invalidate ${label}: ${path}`, error);
  } finally {
    if (Number.isInteger(fileDescriptor)) try { closeSync(fileDescriptor); } catch { /* invalidation already decided */ }
    if (Number.isInteger(directoryDescriptor)) try { closeSync(directoryDescriptor); } catch { /* invalidation already decided */ }
    if (quarantinePath && existsSync(quarantinePath)) {
      // Never delete an identity-mismatched quarantine target.
    }
  }
}

function invalidateVerificationPublicationArtifacts(plan) {
  removeVerificationPublicationFile(plan, plan.outputPath, 'verification JSON report');
  removeVerificationPublicationFile(plan, plan.markdownPath, 'verification Markdown report');
  removeVerificationPublicationFile(plan, plan.diagnosticLogPath, 'verification preflight log');
}

function openVerificationPublicationDirectory(project, directory, label, mode = undefined) {
  let descriptor;
  try {
    if (pathContainsSymlink(project, directory)) throw new ResultClassificationError('report_io', `${label} must not contain symbolic links: ${directory}`);
    mkdirSync(directory, { recursive: true, ...(mode === undefined ? {} : { mode }) });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ResultClassificationError('report_io', `${label} must be a real directory: ${directory}`);
    if (mode !== undefined && process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new ResultClassificationError('report_io', `${label} must be private: ${directory}`);
    }
    descriptor = openSync(directory, 'r');
    const opened = fstatSync(descriptor);
    const identity = { project, directory, label, descriptor, device: opened.dev, inode: opened.ino, realpath: realpathSync(directory) };
    assertVerificationPublicationDirectory(identity);
    return identity;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* opening already failed */ }
    }
    throw reportIoFailure(`Cannot open ${label}: ${directory}`, error);
  }
}

function assertVerificationPublicationDirectory(identity) {
  try {
    const current = lstatSync(identity.directory);
    const opened = fstatSync(identity.descriptor);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.device || current.ino !== identity.inode
      || opened.dev !== identity.device || opened.ino !== identity.inode || realpathSync(identity.directory) !== identity.realpath
      || pathContainsSymlink(identity.project, identity.directory)) {
      throw new ResultClassificationError('report_io', `${identity.label} changed during publication: ${identity.directory}`);
    }
  } catch (error) {
    throw reportIoFailure(`Cannot revalidate ${identity.label}: ${identity.directory}`, error);
  }
}

function closeVerificationPublicationDirectory(identity) {
  if (!identity) return;
  try { closeSync(identity.descriptor); } catch { /* publication result already determined */ }
}

function openVerificationPublicationDirectories(plan) {
  const report = openVerificationPublicationDirectory(plan.project, dirname(plan.outputPath), 'verification report directory');
  try {
    const diagnostic = openVerificationPublicationDirectory(plan.project, dirname(plan.diagnosticLogPath), 'verification diagnostic directory', 0o700);
    return { report, diagnostic };
  } catch (error) {
    closeVerificationPublicationDirectory(report);
    throw error;
  }
}

function closeVerificationPublicationDirectories(directories) {
  closeVerificationPublicationDirectory(directories?.report);
  closeVerificationPublicationDirectory(directories?.diagnostic);
}

function assertVerificationPublicationDirectories(directories) {
  assertVerificationPublicationDirectory(directories.report);
  assertVerificationPublicationDirectory(directories.diagnostic);
}

function printVerificationReportReceipt(plan, reportPath, reportJson) {
  const receipt = {
    schemaVersion: 1,
    invocationIdentity: plan.invocationIdentity,
    reportPath,
    sha256: createHash('sha256').update(reportJson).digest('hex'),
    size: Buffer.byteLength(reportJson),
  };
  console.log(`GDECK_VERIFY_REPORT_RECEIPT ${Buffer.from(JSON.stringify(receipt)).toString('base64url')}`);
}

function publishVerificationPreflightFailure(
  plan, started, error, existingDirectories = undefined, verificationJournal = undefined, journalElapsedMs = undefined,
) {
  const project = plan.project;
  const output = plan.outputPath;
  const markdown = plan.markdownPath;
  const artifacts = [];
  const diagnosticOutput = typeof error.resultDiagnosticOutput === 'string' ? error.resultDiagnosticOutput : '';
  const publicationDirectories = existingDirectories ?? openVerificationPublicationDirectories(plan);
  const ownsPublicationDirectories = existingDirectories === undefined;
  const diagnosticDirectoryIdentity = publicationDirectories.diagnostic;
  const reportDirectoryIdentity = publicationDirectories.report;
  let markdownIdentity;
  try {
    assertVerificationPublicationDirectories(publicationDirectories);
  if (diagnosticOutput) {
    const diagnosticPath = plan.diagnosticLogPath;
    if (pathContainsSymlink(project, diagnosticPath)) throw new ResultClassificationError('report_io', `Verification diagnostic path must not contain symbolic links: ${diagnosticPath}`);
    if (pathContainsSymlink(project, diagnosticPath)) throw new ResultClassificationError('report_io', `Verification diagnostic path changed to a symbolic link before publication: ${diagnosticPath}`);
    assertVerificationPublicationDirectory(diagnosticDirectoryIdentity);
    writeFileAtomicNoReplace(diagnosticPath, diagnosticOutput, { mode: 0o600 });
    assertVerificationPublicationDirectory(diagnosticDirectoryIdentity);
    artifacts.push({ kind: 'preflight_log', path: diagnosticPath });
  }
  const classification = error.resultClassification ?? 'configuration';
  const source = error.resultSource ?? 'preflight';
  const report = {
    schemaVersion: 2,
    flightDeckVersion: TOOL_VERSION,
    project,
    verificationProfile: plan.verificationProfile,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    status: 'failed',
    summary: { total: 0, passed: 0, skipped: 0, failed: 0 },
    stages: [],
    verificationPlanDigest: plan.digest,
    evidenceBinding: plan.evidenceBinding,
    coverage: preflightReportForVerificationPlan(plan).coverage,
    preflightFailure: {
      phase: error.resultPhase ?? 'verification_preflight',
      classification,
      source,
      summary: error.message,
      ...(error.resultProcessEvidence ? { processEvidence: error.resultProcessEvidence } : {}),
    },
    artifacts,
    journal: { path: plan.evidenceBinding.journalPath, invocationIdentity: plan.invocationIdentity },
  };
  report.resultEnvelope = buildResultEnvelope({
    report,
    reportPath: output,
    markdownPath: markdown,
    strategy: plan.verificationProfile ? { mode: 'profile', profile: plan.verificationProfile } : { mode: 'legacy', profile: null },
    event: { classification, source, summary: error.message },
  });
  if (artifacts.length > 0) {
    report.resultEnvelope.truncation.outputWithheld = true;
    report.resultEnvelope.truncation.fullLogPath = artifacts[0].path;
    report.resultEnvelope.truncation.occurred = true;
  }
  for (const path of [output, markdown]) {
    if (!pathIsInside(project, path)) throw new ResultClassificationError('report_io', `Verification report path must stay inside the project: ${path}`);
    if (pathContainsSymlink(project, path)) throw new ResultClassificationError('report_io', `Verification report path must not contain symbolic links: ${path}`);
  }
  if (pathContainsSymlink(project, output) || pathContainsSymlink(project, markdown)) {
    throw new ResultClassificationError('report_io', 'Verification report path changed to a symbolic link before preflight publication');
  }
  const reportJson = boundedVerificationReportJson(report);
  assertVerificationPublicationDirectory(reportDirectoryIdentity);
  if (diagnosticDirectoryIdentity) assertVerificationPublicationDirectory(diagnosticDirectoryIdentity);
  markdownIdentity = writeFileAtomicNoReplace(markdown, verificationMarkdown(report));
  assertVerificationPublicationDirectory(reportDirectoryIdentity);
  if (verificationJournal) {
    appendVerificationJournalRecord(verificationJournal, 'report_binding', {
      outputPath: output,
      sha256: createHash('sha256').update(reportJson).digest('hex'),
      size: Buffer.byteLength(reportJson),
    }, journalElapsedMs());
  }
  writeFileAtomicNoReplace(output, reportJson);
  assertVerificationPublicationDirectory(reportDirectoryIdentity);
  printVerificationReportReceipt(plan, output, reportJson);
  return report;
  } catch (publicationError) {
    if (markdownIdentity) {
      try { removeVerificationPublicationFile(plan, markdown, 'verification Markdown report', markdownIdentity); }
      catch { /* preserve the publication failure and never delete a replacement */ }
    }
    throw reportIoFailure('Cannot publish verification preflight artifacts', publicationError);
  } finally {
    if (ownsPublicationDirectories) closeVerificationPublicationDirectories(publicationDirectories);
  }
}

function verifyProject(projectCandidate, options, expectedPlanDigest = '', invocationIdentity = '') {
  const project = resolveProject(projectCandidate);
  const started = Date.now();
  const output = resolve(options.output ?? join(project, '.gdeck', 'reports', `verify-${timestamp()}.json`));
  const planOptions = {
    project,
    outputPath: output,
    timeoutSeconds: options.timeout ?? DEFAULT_TIMEOUT_SECONDS,
    verificationProfile: options.profile,
    invocationIdentity: requireInvocationIdentity(invocationIdentity),
  };
  const plan = resolveVerificationPlan(planOptions);
  let executionSnapshot;
  let publicationDirectories;
  let verificationJournal;
  let journalFailure = false;
  let finalReportVerdict = '';
  const journalStarted = process.hrtime.bigint();
  const journalElapsedMs = () => Number((process.hrtime.bigint() - journalStarted) / 1_000_000n);
  assertVerificationPlanDigest(plan, expectedPlanDigest);
  try {
    applyEvidenceRetention(plan);
    planOptions.retentionCandidateManifest = plan.evidenceBinding.retentionCandidates;
    planOptions.retentionEffectsMayBeFulfilled = true;
    verificationJournal = createVerificationJournal(plan);
    invalidateVerificationPublicationArtifacts(plan);
    publicationDirectories = openVerificationPublicationDirectories(plan);
    executionSnapshot = plan.stages.some((stage) => stage.disposition === 'run' && stage.includeInLegacyReport)
      ? createVerificationSnapshot(plan)
      : null;
    appendVerificationJournalRecord(verificationJournal, 'preflight_completed', {}, journalElapsedMs());
  } catch (error) {
    if (!verificationJournal || error?.code === 'evidence_owner_conflict') throw error;
    try {
      error.resultReport = publishVerificationPreflightFailure(
        plan, started, error, publicationDirectories, verificationJournal, journalElapsedMs,
      );
    } catch (publicationError) {
      publicationError.resultReport = preflightReportForVerificationPlan(plan);
      throw publicationError;
    } finally {
      closeVerificationPublicationDirectories(publicationDirectories);
      publicationDirectories = undefined;
      if (verificationJournal) {
        try { closeVerificationJournal(verificationJournal); }
        catch (error) { throw reportIoFailure('Cannot close verification Journal ownership', error); }
        verificationJournal = undefined;
      }
    }
    throw error;
  }
  try {
  const stages = [];
  const verifiedExportRecords = [];
  const pendingExportStages = [];
  let exportExecutionAttempted = false;
  let planDrifted = false;
  const journalStages = plan.stages.filter((stage) => stage.includeInLegacyReport);
  const journalOrdinal = new Map(journalStages.map((stage, index) => [stage.id, index + 1]));

  function commitJournal(type, payload) {
    try {
      appendVerificationJournalRecord(verificationJournal, type, payload, journalElapsedMs());
      return true;
    } catch {
      journalFailure = true;
      return false;
    }
  }

  function journalReportReference(stage) {
    if (stage.journalReportReference) return stage.journalReportReference;
    const reportPath = stage.journalReportPath ?? stage.reportPath;
    if (!reportPath || stage.evidenceAccepted === false || !existsSync(reportPath)) return null;
    const bytes = readFileSync(reportPath);
    return {
      path: reportPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  }

  function commitStageTerminal(planned, stage, state = stage.status) {
    const outcome = stage.outcome && typeof stage.outcome.classification === 'string' && typeof stage.outcome.source === 'string'
      ? { classification: stage.outcome.classification, source: stage.outcome.source }
      : undefined;
    return commitJournal('stage_terminal', {
      ordinal: journalOrdinal.get(planned.id),
      stageId: planned.id,
      state,
      report: journalReportReference(stage),
      ...(outcome ? { outcome } : {}),
    });
  }

  function legacyStage(planned, values) {
    const stage = {
      planStageId: planned.id,
      kind: planned.kind,
      target: planned.target,
      status: values.status,
      exitCode: values.exitCode,
      durationMs: values.durationMs ?? 0,
      reportPath: values.reportPath ?? null,
      report: values.report ?? null,
      outputTail: values.outputTail ?? '',
      replay: {
        verificationProfile: plan.verificationProfile,
        runtimeProfile: planned.runtime?.profile ?? null,
        seed: planned.runtime?.seed ?? null,
        fixtureAdapter: planned.runtime?.fixtureAdapter ?? null,
        timeoutMs: planned.timeoutMs,
      },
      ...(values.outcome ? { outcome: values.outcome } : {}),
      ...(values.processEvidence ? { processEvidence: values.processEvidence } : {}),
      ...(values.evidenceAccepted === false ? { evidenceAccepted: false } : {}),
      ...(values.relatedOutcomes?.length ? { relatedOutcomes: values.relatedOutcomes } : {}),
      ...(values.artifacts ? { artifacts: values.artifacts } : {}),
    };
    stages.push(stage);
    return stage;
  }

  function ensurePlanIsCurrent(planned) {
    try {
      const current = resolveVerificationPlan(planOptions);
      assertVerificationPlanDigest(current, plan.digest);
      return true;
    } catch (error) {
      console.log(`\n${color.muted(`── ${planned.kind}: ${planned.target}`)}`);
      console.error(color.red(error.message));
      legacyStage(planned, {
        status: 'failed', exitCode: 1, outputTail: error.message,
        outcome: { classification: 'plan_drift', source: 'preflight', summary: error.message },
      });
      planDrifted = true;
      return false;
    }
  }

  function executePlannedStage(planned) {
    console.log(`\n${color.muted(`── ${planned.kind}: ${planned.target}`)}`);
    if (planned.reportPath && existsSync(planned.reportPath)) {
      throw new ResultClassificationError('report_io', `Invocation-owned stage report path is unexpectedly occupied: ${planned.reportPath}`);
    }
    const command = executeVerificationCommand(planned, plan, executionSnapshot?.project ?? project);
    let detail = null;
    let reportError = '';
    let reportClassification = 'report_corrupt';
    let operationalIncompleteUnit = false;
    let journalReport;
    if (planned.reportPath) {
      if (!existsSync(planned.reportPath)) reportError = `Expected stage report was not produced: ${planned.reportPath}`;
      else if (pathContainsSymlink(project, planned.reportPath)) reportError = `Exact stage report path contains a symbolic link: ${planned.reportPath}`;
      else {
        let descriptor;
        try {
          descriptor = openSync(planned.reportPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
          const before = fstatSync(descriptor);
          const reportStageCount = Math.max(1, plan.stages.filter((stage) => Boolean(stage.reportPath)).length);
          const maximumStageReportBytes = Math.min(64 * 1024 * 1024, Math.floor((128 * 1024 * 1024) / reportStageCount));
          if (!before.isFile() || before.size > maximumStageReportBytes) {
            throw new Error(`Exact stage report is not a file or exceeds its invocation-bound ${maximumStageReportBytes} byte budget: ${planned.reportPath}`);
          }
          fchmodSync(descriptor, 0o600);
          const bytes = readFileSync(descriptor);
          const after = fstatSync(descriptor);
          const pathAfter = lstatSync(planned.reportPath);
          if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.isSymbolicLink()) {
            throw new Error(`Exact stage report changed while it was being bound: ${planned.reportPath}`);
          }
          const rawReport = JSON.parse(bytes.toString('utf8'));
          if (planned.kind === 'unit') {
            const parsedUnitCommand = parseCliArguments(planned.commandArgs);
            const expectedUnitBinding = unitBindingForExecution({
              project: plan.project,
              report: planned.reportPath,
              timeoutMs: planned.timeoutMs,
              options: parsedUnitCommand.options,
              invocationIdentity: plan.invocationIdentity,
              ownerNonce: verificationUnitOwnerNonce(plan, planned),
            });
            const disposition = unitReportDisposition(rawReport, rawReport.schema_version === 2 ? expectedUnitBinding : undefined);
            if (disposition.state !== 'terminal') {
              operationalIncompleteUnit = disposition.state === 'incomplete';
              reportClassification = disposition.state === 'incomplete' ? 'report_incomplete' : 'report_corrupt';
              throw new Error(disposition.state === 'incomplete'
                ? 'Unit report is incomplete operational evidence and cannot qualify a stage result'
                : 'Unit report schema, owner, invocation, output, timeout, or runtime binding is invalid');
            }
          }
          detail = boundedStageReport(planned.kind, rawReport);
          journalReport = {
            path: planned.reportPath,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
          };
        } catch (error) { reportError = `Cannot read exact stage report: ${error.message}`; }
        finally { if (Number.isInteger(descriptor)) closeSync(descriptor); }
      }
    }
    const stage = legacyStage(planned, {
      status: command.exitCode === 0 && !reportError ? 'passed' : 'failed',
      exitCode: command.exitCode,
      durationMs: command.durationMs,
      reportPath: planned.reportPath,
      report: detail,
      outputTail: [command.outputTail, reportError].filter(Boolean).join('\n'),
      processEvidence: command.processEvidence,
      outcome: reportError ? (operationalIncompleteUnit && command.outcome ? command.outcome : {
        classification: existsSync(planned.reportPath) ? reportClassification : 'report_missing',
        source: 'preflight',
        summary: reportError,
      }) : command.outcome,
      relatedOutcomes: reportError && command.outcome && !(operationalIncompleteUnit && command.outcome)
        ? [command.outcome]
        : operationalIncompleteUnit ? [{ classification: 'report_incomplete', source: 'preflight', summary: reportError }] : undefined,
    });
    if (journalReport) Object.defineProperty(stage, 'journalReportReference', { value: journalReport, enumerable: false });
    if (planned.kind === 'benchmark') {
      if (stage.report?.performance) {
        stage.budgets = performanceBudgetResults(stage.report.performance, planned.runtime?.budgets ?? {});
        if (stage.budgets.some((budget) => !budget.passed)) stage.status = 'failed';
      } else if (Object.keys(planned.runtime?.budgets ?? {}).length > 0) {
        stage.status = 'failed';
        stage.budgets = [];
      }
    }
    return stage;
  }

  for (const planned of plan.stages) {
    if (!planned.includeInLegacyReport) continue;
    if (planned.disposition === 'skipped') {
      console.log(`\n${color.muted(`── ${planned.kind}: ${planned.target}`)}`);
      console.log(color.yellow(`Stage skipped: ${planned.reason.message}`));
      const stage = legacyStage(planned, { status: 'skipped', exitCode: 0, outputTail: planned.reason.message });
      if (!commitStageTerminal(planned, stage, 'skipped')) break;
      continue;
    }
    if (planned.disposition === 'blocked') {
      console.log(`\n${color.muted(`── ${planned.kind}: ${planned.target}`)}`);
      console.error(color.red(planned.reason.message));
      const blockedClassification = planned.reason.code === 'profile-missing' ? 'configuration' : 'precondition';
      legacyStage(planned, {
        status: 'failed', exitCode: 1, outputTail: planned.reason.message,
        outcome: { classification: blockedClassification, source: 'preflight', summary: planned.reason.message },
      });
      if (planned.kind === 'export') {
        if (plan.confirmationEffects.length > 0) exportExecutionAttempted = true;
        pendingExportStages.push({ planned, stage: stages.at(-1) });
      } else if (!commitStageTerminal(planned, stages.at(-1), 'blocked')) break;
      continue;
    }
    if (planned.disposition !== 'run') continue;
    if (!ensurePlanIsCurrent(planned)) break;
    if (planned.reportPath && existsSync(planned.reportPath)) {
      journalFailure = true;
      legacyStage(planned, {
        status: 'failed', exitCode: 126,
        outputTail: 'Invocation-owned stage report path is unexpectedly occupied.',
        outcome: {
          classification: 'report_io', source: 'preflight',
          summary: 'Invocation-owned stage report path is unexpectedly occupied.',
        },
      });
      break;
    }
    if (!commitJournal('stage_started', {
      ordinal: journalOrdinal.get(planned.id), total: journalStages.length, stageId: planned.id,
    })) break;
    let stage;
    try { stage = executePlannedStage(planned); }
    catch (error) {
      stage = legacyStage(planned, {
        status: 'failed', exitCode: Number(error.exitCode ?? 126), outputTail: error.message,
        outcome: {
          classification: error.resultClassification ?? 'report_io',
          source: error.resultSource ?? 'preflight',
          summary: error.message,
        },
      });
      journalFailure = true;
      commitStageTerminal(planned, stage, 'failed');
      break;
    }
    try {
      const current = resolveVerificationPlan(planOptions);
      assertVerificationPlanDigest(current, plan.digest);
    } catch (error) {
      stage.status = 'failed';
      stage.outputTail = [stage.outputTail, `Verification Plan input changed while the stage was running; its result was rejected: ${error.message}`].filter(Boolean).join('\n');
      stage.outcome = { classification: 'plan_drift', source: 'preflight', summary: error.message };
      stage.evidenceAccepted = false;
      planDrifted = true;
      if (planned.kind === 'export') exportExecutionAttempted = true;
      commitStageTerminal(planned, stage, 'failed');
      break;
    }
    if (planned.kind !== 'export') {
      if (!commitStageTerminal(planned, stage)) break;
      continue;
    }
    exportExecutionAttempted = true;
    if (stage.status === 'passed') {
    const manifestPath = releaseManifestPath(project);
    try {
      if (!existsSync(manifestPath)) throw new Error('export did not produce a release manifest');
      if (pathContainsSymlink(project, manifestPath)) throw new Error('export release manifest contains a symbolic link');
      const before = lstatSync(manifestPath);
      const manifestBytes = readFileSync(manifestPath);
      const after = lstatSync(manifestPath);
      if (!before.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
        throw new Error('export release manifest changed while it was being bound');
      }
      const stageManifest = JSON.parse(manifestBytes.toString('utf8'));
      if (!Array.isArray(stageManifest.artifacts) || stageManifest.artifacts.length !== 1) {
        throw new Error('export manifest must contain exactly one artifact');
      }
      const artifact = stageManifest.artifacts[0];
      if (artifact.target !== planned.target) throw new Error(`export manifest target mismatch: expected ${planned.target}`);
      try { writeFileAtomicNoReplace(planned.journalReportPath, manifestBytes, { mode: 0o600 }); }
      catch (error) { throw new ResultClassificationError('report_io', `Cannot bind private export stage evidence: ${error.message}`); }
      Object.defineProperty(stage, 'journalReportReference', {
        value: {
          path: planned.journalReportPath,
          sha256: createHash('sha256').update(manifestBytes).digest('hex'),
          size: manifestBytes.length,
        },
        enumerable: false,
      });
      verifiedExportRecords.push({ artifact, stage, errors: [], integrityEvidence: [] });
    } catch (error) {
      stage.status = 'failed';
      stage.outputTail = [stage.outputTail, `Cannot aggregate export manifest: ${error.message}`].filter(Boolean).join('\n');
      stage.outcome = {
        classification: error.resultClassification ?? 'export_integrity',
        source: error.resultSource ?? 'preflight',
        summary: error.message,
      };
      if (error.resultClassification === 'report_io') journalFailure = true;
    }
    }
    pendingExportStages.push({ planned, stage });
    if (journalFailure) break;
  }

  const outputOwners = new Map();
  for (const record of verifiedExportRecords) {
    const artifact = record.artifact;
    const primary = resolve(project, artifact.path ?? '');
    const artifactDirectory = dirname(primary);
    if (!artifact.path || !pathIsInside(project, primary) || pathContainsSymlink(project, primary)) {
      record.errors.push(`unsafe artifact path: ${artifact.path ?? ''}`);
      continue;
    }
    if (!Array.isArray(artifact.files) || artifact.files.length === 0) {
      record.errors.push('artifact file list is empty');
      continue;
    }
    for (let index = 0; index < artifact.files.length; index += 1) {
      const file = artifact.files[index];
      const absolute = resolve(artifactDirectory, file.path ?? '');
      if (!file.path || !pathIsInside(artifactDirectory, absolute) || pathContainsSymlink(project, absolute)) {
        record.errors.push(`unsafe artifact file path: ${file.path ?? ''}`);
        continue;
      }
      if (index === 0 && absolute !== primary) record.errors.push('primary artifact path does not match its file list');
      const previous = outputOwners.get(absolute);
      if (previous) {
        record.errors.push(`artifact path collides with ${previous.artifact.target}: ${absolute}`);
        previous.errors.push(`artifact path collides with ${artifact.target}: ${absolute}`);
      } else {
        outputOwners.set(absolute, record);
      }
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        record.errors.push(`artifact file is missing: ${absolute}`);
        record.integrityEvidence.push({
          summary: `Artifact file is missing: ${absolute}`,
          expected: { path: absolute, sha256: file.sha256, size: file.size },
          actual: { state: 'missing' },
        });
        continue;
      }
      const bytes = readFileSync(absolute);
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== file.sha256 || bytes.length !== file.size) {
        record.errors.push(`artifact file changed after export: ${absolute}`);
        record.integrityEvidence.push({
          summary: `Artifact file changed after export: ${absolute}`,
          expected: { sha256: file.sha256, size: file.size },
          actual: { sha256: actualHash, size: bytes.length },
        });
      }
    }
  }
  for (const record of verifiedExportRecords) {
    if (record.errors.length === 0) {
      const artifactDirectory = dirname(resolve(project, record.artifact.path));
      record.stage.artifacts = [
        { kind: 'release_manifest', path: releaseManifestPath(project) },
        ...record.artifact.files.map((file) => ({ kind: 'release_artifact', path: resolve(artifactDirectory, file.path) })),
      ];
      continue;
    }
    record.stage.status = 'failed';
    const evidence = record.integrityEvidence[0];
    record.stage.outcome = {
      classification: 'export_integrity', source: 'preflight', summary: evidence?.summary ?? record.errors[0],
      ...(evidence?.expected ? { expected: evidence.expected } : {}),
      ...(evidence?.actual ? { actual: evidence.actual } : {}),
    };
    record.stage.outputTail = [record.stage.outputTail, ...record.errors.map((error) => `Cannot aggregate export manifest: ${error}`)].filter(Boolean).join('\n');
  }
  if (exportExecutionAttempted && !planDrifted) {
    try {
      assertCurrentVerificationPlanForEffect(plan, 'before aggregate manifest publication; the aggregate manifest was not replaced');
    } catch (error) {
      planDrifted = true;
      const lastExportStage = [...stages].reverse().find((stage) => stage.kind === 'export');
      if (lastExportStage) {
        lastExportStage.status = 'failed';
        lastExportStage.exitCode = 1;
        lastExportStage.outcome = { classification: 'plan_drift', source: 'preflight', summary: error.message };
        lastExportStage.evidenceAccepted = false;
        lastExportStage.outputTail = [lastExportStage.outputTail, error.message].filter(Boolean).join('\n');
      }
    }
  }
  if (exportExecutionAttempted && !planDrifted) {
    const gitSha = releaseGitSha(project);
    for (const record of verifiedExportRecords) {
      if (record.errors.length > 0) continue;
      const artifactDirectory = dirname(resolve(project, record.artifact.path));
      for (const file of record.artifact.files) {
        const absolute = resolve(artifactDirectory, file.path);
        if (!existsSync(absolute) || !statSync(absolute).isFile()) {
          record.errors.push(`artifact file disappeared during manifest preparation: ${absolute}`);
          record.integrityEvidence.push({
            summary: `Artifact file disappeared during manifest preparation: ${absolute}`,
            expected: { path: absolute, sha256: file.sha256, size: file.size },
            actual: { state: 'missing' },
          });
          continue;
        }
        const bytes = readFileSync(absolute);
        const actualHash = createHash('sha256').update(bytes).digest('hex');
        if (actualHash !== file.sha256 || bytes.length !== file.size) {
          record.errors.push(`artifact file changed during manifest preparation: ${absolute}`);
          record.integrityEvidence.push({
            summary: `Artifact file changed during manifest preparation: ${absolute}`,
            expected: { sha256: file.sha256, size: file.size },
            actual: { sha256: actualHash, size: bytes.length },
          });
        }
      }
      if (record.errors.length > 0) {
        record.stage.status = 'failed';
        record.stage.exitCode = 1;
        const evidence = record.integrityEvidence[0];
        record.stage.outcome = {
          classification: 'export_integrity', source: 'preflight', summary: evidence?.summary ?? record.errors[0],
          ...(evidence?.expected ? { expected: evidence.expected } : {}),
          ...(evidence?.actual ? { actual: evidence.actual } : {}),
        };
        record.stage.outputTail = [record.stage.outputTail, ...record.errors.map((error) => `Cannot publish aggregate export manifest: ${error}`)].filter(Boolean).join('\n');
      }
    }
    const verifiedExportArtifacts = verifiedExportRecords
      .filter((record) => record.errors.length === 0)
      .map((record) => record.artifact);
    writeReleaseManifest(project, { debug: false, publishRequested: false, artifacts: verifiedExportArtifacts, gitSha });
  }

  for (const pending of pendingExportStages) {
    if (!commitStageTerminal(pending.planned, pending.stage)) break;
  }

  const completedSnapshot = executionSnapshot;
  executionSnapshot = null;
  removeVerificationSnapshot(completedSnapshot);

  for (const stage of stages) stage.outputTail = boundedOutputTail(stage.outputTail);
  const failed = stages.filter((stage) => stage.status === 'failed').length;
  const skipped = stages.filter((stage) => stage.status === 'skipped').length;
  const passed = stages.filter((stage) => stage.status === 'passed').length;
  const markdown = plan.markdownPath;
  const report = {
    schemaVersion: 2,
    flightDeckVersion: TOOL_VERSION,
    project,
    verificationProfile: plan.verificationProfile,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    status: failed === 0 && !planDrifted ? 'passed' : 'failed',
    summary: { total: stages.length, passed, skipped, failed },
    stages,
    verificationPlanDigest: plan.digest,
    evidenceBinding: plan.evidenceBinding,
    journal: { path: plan.evidenceBinding.journalPath, invocationIdentity: plan.invocationIdentity },
    coverage: plan.stages.map((stage) => ({
      kind: stage.kind,
      target: stage.target,
      disposition: stage.disposition,
      execution: stage.disposition === 'run'
        ? stages.some((result) => result.planStageId === stage.id) ? 'attempted' : 'not_attempted'
        : 'not_applicable',
      reason: stage.reason,
    })),
  };
  report.resultEnvelope = buildResultEnvelope({ report, reportPath: output, markdownPath: markdown });
  const applyJournalFailure = () => {
    report.journal.writeStatus = 'failed';
    report.operationalEvidence = [{ kind: 'verification_journal', classification: 'report_io', source: 'preflight' }];
    if (report.resultEnvelope.verdict !== 'FAILED') {
      report.status = 'failed';
      report.resultEnvelope = buildResultEnvelope({
        report,
        reportPath: output,
        markdownPath: markdown,
        event: {
          classification: 'report_io', source: 'preflight',
          summary: 'Incremental evidence Journal could not commit; no later stage was started.',
        },
      });
    }
  };
  if (journalFailure) applyJournalFailure();
  finalReportVerdict = report.resultEnvelope.verdict;
  const reportDirectoryIdentity = publicationDirectories.report;
  let markdownIdentity;
  try {
    for (const path of [output, markdown]) {
      if (!pathIsInside(project, path)) throw new ResultClassificationError('report_io', `Verification report path must stay inside the project: ${path}`);
      if (pathContainsSymlink(project, path)) throw new ResultClassificationError('report_io', `Verification report path changed to a symbolic link before publication: ${path}`);
    }
    assertVerificationPublicationDirectories(publicationDirectories);
    let reportJson = boundedVerificationReportJson(report);
    assertVerificationPublicationDirectory(reportDirectoryIdentity);
    markdownIdentity = writeFileAtomicNoReplace(markdown, verificationMarkdown(report));
    assertVerificationPublicationDirectory(reportDirectoryIdentity);
    if (!journalFailure) {
      try {
        appendVerificationJournalRecord(verificationJournal, 'report_binding', {
          outputPath: output,
          sha256: createHash('sha256').update(reportJson).digest('hex'),
          size: Buffer.byteLength(reportJson),
        }, journalElapsedMs());
      } catch {
        journalFailure = true;
        applyJournalFailure();
        finalReportVerdict = report.resultEnvelope.verdict;
        reportJson = boundedVerificationReportJson(report);
        removeVerificationPublicationFile(plan, markdown, 'verification Markdown report', markdownIdentity);
        markdownIdentity = writeFileAtomicNoReplace(markdown, verificationMarkdown(report));
        assertVerificationPublicationDirectory(reportDirectoryIdentity);
      }
    }
    if (process.env.GDECK_TEST_FAIL_AGGREGATE_PUBLICATION === '1') {
      throw new ResultClassificationError('report_io', 'Injected aggregate publication failure after Journal report binding');
    }
    writeFileAtomicNoReplace(output, reportJson);
    assertVerificationPublicationDirectory(reportDirectoryIdentity);
    printVerificationReportReceipt(plan, output, reportJson);
  } catch (publicationError) {
    if (markdownIdentity) {
      try { removeVerificationPublicationFile(plan, markdown, 'verification Markdown report', markdownIdentity); }
      catch { /* preserve the publication failure and never delete a replacement */ }
    }
    throw reportIoFailure('Cannot publish verification aggregate artifacts', publicationError);
  }
  console.log(`\n${renderResultEnvelopeText(report.resultEnvelope)}`);
  console.log(`\n${report.status === 'passed' ? color.green('Verification passed') : color.red('Verification failed')}`);
  console.log(`  Stages:   ${report.summary.passed} passed, ${report.summary.skipped} skipped, ${report.summary.failed} failed`);
  console.log(`  JSON:     ${output}`);
  console.log(`  Markdown: ${markdown}`);
  if (report.status !== 'passed') printVerificationFailureDigest(report, output, markdown, options);
  if (journalFailure && report.resultEnvelope.verdict !== 'FAILED') return 126;
  return report.status === 'passed' ? 0 : 1;
  } finally {
    removeVerificationSnapshot(executionSnapshot);
    closeVerificationPublicationDirectories(publicationDirectories);
    if (verificationJournal) {
      try { closeVerificationJournal(verificationJournal); }
      catch (error) {
        if (!journalFailure && finalReportVerdict !== 'FAILED') {
          throw reportIoFailure('Cannot close verification Journal ownership', error);
        }
        if (!journalFailure) {
          console.error(color.yellow('Verification Journal ownership cleanup failed after qualified product evidence; aggregate FAILED remains authoritative.'));
        }
      }
    }
  }
}

function evidenceIndexCommand(projectCandidate, options) {
  const project = resolveProject(projectCandidate);
  const timeoutMs = options.timeout !== undefined ? Math.floor(Number(options.timeout) * 1000) : undefined;
  const limit = options.limit !== undefined ? Math.floor(Number(options.limit)) : undefined;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0)) {
    throw new Error('Evidence Index --timeout must be a non-negative number of seconds');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('Evidence Index --limit must be a positive integer');
  }
  const index = buildEvidenceIndex(project, {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  if (options.json) console.log(JSON.stringify(index, null, 2));
  else {
    console.log(`Evidence scan: ${index.scan.status} (${index.scan.filesObserved} files, ${index.scan.bytesObserved} bytes)`);
    if (index.counts) {
      console.log(`  Counts: sealed/bound=${index.counts.sealed_bound}, valid=${index.counts.valid}, stale=${index.counts.stale}, unverifiable=${index.counts.unverifiable}, invalid=${index.counts.invalid}, incomplete_journals=${index.counts.incomplete_journals}`);
    }
    for (const report of index.finalReports) {
      console.log(`  Final ${report.seal}/${report.freshness}: ${report.path}${report.reportedVerdict ? ` [reported ${report.reportedVerdict}]` : ''}`);
    }
    for (const journal of index.incompleteJournals) {
      console.log(`  Journal ${journal.seal}/${journal.freshness}: ${journal.path}`);
    }
  }
  // incomplete means budget truncated but retained valid finds — not a hard failure
  return index.scan.status === 'unverifiable' ? 1 : 0;
}

function validateInternalVerificationStage(argv) {
  const encoded = process.env.GDECK_INTERNAL_VERIFY_STAGE;
  if (!encoded) return null;
  delete process.env.GDECK_INTERNAL_VERIFY_STAGE;
  if (encoded.length > 8 * 1024) throw new Error('Internal verification stage context is too large');
  let context;
  try { context = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch (error) { throw new Error(`Invalid internal verification stage context: ${error.message}`); }
  if (context?.schemaVersion !== 2 || typeof context.project !== 'string' || typeof context.outputPath !== 'string'
    || typeof context.stageId !== 'string' || typeof context.planDigest !== 'string' || typeof context.executionProject !== 'string'
    || !/^[a-f0-9]{64}$/.test(context.invocationIdentity ?? '')
    || !Array.isArray(context.retentionCandidateManifest) || context.retentionCandidateManifest.length > 65
    || typeof context.outcomePath !== 'string' || !/^[a-f0-9]{64}$/.test(context.outcomeNonce ?? '')) {
    throw new Error('Invalid internal verification stage context');
  }
  const plan = resolveVerificationPlan({
    project: context.project,
    outputPath: context.outputPath,
    timeoutSeconds: context.timeoutSeconds,
    verificationProfile: context.verificationProfile,
    invocationIdentity: context.invocationIdentity,
    retentionCandidateManifest: context.retentionCandidateManifest,
    retentionEffectsMayBeFulfilled: true,
  });
  assertVerificationPlanDigest(plan, context.planDigest);
  const executionProject = resolveProject(context.executionProject);
  if (sameExistingPath(plan.project, executionProject)) throw new Error('Internal verification stage requires an immutable execution snapshot');
  const outcomePath = resolve(context.outcomePath);
  const snapshotRoot = realpathSync(dirname(executionProject));
  if (realpathSync(dirname(outcomePath)) !== snapshotRoot || !basename(outcomePath).startsWith('.gdeck-stage-outcome-')
    || pathContainsSymlink(dirname(outcomePath), outcomePath)) {
    throw new Error('Invalid internal stage outcome path');
  }
  internalStageOutcomeSink = { path: outcomePath, nonce: context.outcomeNonce };
  assertVerificationSnapshotInputs(plan, executionProject);
  const stage = plan.stages.find((item) => item.id === context.stageId);
  if (!stage || stage.disposition !== 'run') throw new Error(`Verification stage is no longer runnable: ${context.stageId}`);
  const expected = [...stage.commandArgs, '--timeout', String(stage.timeoutMs / 1000)];
  if (JSON.stringify(argv) !== JSON.stringify(expected)) {
    throw new Error(`Verification stage invocation does not match its Plan: ${context.stageId}`);
  }
  return { plan, stage, executionProject };
}

function extractInternalVerificationExpectation(argv) {
  const digestPrefix = '--gdeck-internal-verify-plan-digest=';
  const identityPrefix = '--gdeck-internal-invocation-identity=';
  const unitBindingPrefix = '--gdeck-internal-unit-binding=';
  const digestValues = argv.filter((argument) => argument.startsWith(digestPrefix));
  const identityValues = argv.filter((argument) => argument.startsWith(identityPrefix));
  const unitBindingValues = argv.filter((argument) => argument.startsWith(unitBindingPrefix));
  if (digestValues.length > 1) throw new Error('Duplicate internal verification plan digest');
  if (identityValues.length > 1) throw new Error('Duplicate internal verification invocation identity');
  if (unitBindingValues.length > 1) throw new Error('Duplicate internal Unit binding');
  const args = argv.filter((argument) => !argument.startsWith(digestPrefix)
    && !argument.startsWith(identityPrefix) && !argument.startsWith(unitBindingPrefix));
  if ((digestValues.length > 0 || identityValues.length > 0) && args[0] !== 'verify') {
    throw new Error('Internal verification bindings are valid only for verify');
  }
  if (unitBindingValues.length > 0 && args[0] !== 'unit') throw new Error('Internal Unit binding is valid only for unit');
  const expectedPlanDigest = digestValues.length === 0 ? '' : digestValues[0].slice(digestPrefix.length);
  if (expectedPlanDigest && !/^[a-f0-9]{64}$/.test(expectedPlanDigest)) throw new Error('Invalid internal verification plan digest');
  const invocationIdentity = identityValues.length === 0 ? '' : requireInvocationIdentity(identityValues[0].slice(identityPrefix.length));
  let unitBinding = null;
  if (unitBindingValues.length > 0) {
    try { unitBinding = JSON.parse(Buffer.from(unitBindingValues[0].slice(unitBindingPrefix.length), 'base64url').toString('utf8')); }
    catch { throw new Error('Invalid internal Unit binding'); }
    if (!unitExecutionBindingMatches(unitBinding, unitBinding)) throw new Error('Invalid internal Unit binding');
  }
  return { args, expectedPlanDigest, invocationIdentity, unitBinding };
}

function verificationStrategyFromArgs(argv) {
  let profile = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') profile = argv[index + 1] ?? '';
    else if (argv[index].startsWith('--profile=')) profile = argv[index].slice('--profile='.length);
  }
  return profile ? { mode: 'profile', profile } : { mode: 'legacy', profile: null };
}

function cliInvocationBudgetMilliseconds(rawArguments) {
  try {
    const internal = extractInternalVerificationExpectation(rawArguments);
    const parsed = parseCliArguments(internal.args);
    const timeoutMs = timeoutMilliseconds(parsed.options);
    if (parsed.command === 'verify') {
      const project = resolveProject(parsed.positional[0]);
      const outputPath = resolve(parsed.options.output ?? join(project, '.gdeck', 'reports', 'supervised-verification.json'));
      const plan = resolveVerificationPlan({
        project,
        outputPath,
        timeoutSeconds: parsed.options.timeout ?? DEFAULT_TIMEOUT_SECONDS,
        verificationProfile: parsed.options.profile,
        invocationIdentity: internal.invocationIdentity,
      });
      return verificationPlanExecutionBudgetMilliseconds(plan);
    }
    if (parsed.command === 'export') {
      const project = resolveProject(parsed.positional[1] ?? process.cwd());
      const config = loadConfig(project);
      const target = parsed.positional[0] ?? 'all';
      const targets = config.exports?.targets ?? defaultExports(project).targets;
      const targetCount = target === 'all' ? Math.max(1, Object.keys(targets).length) : 1;
      const nativeSmoke = macosNativeSmokeOptions(config.exports ?? defaultExports(project));
      const nativeSmokeBudget = nativeSmoke.enabled && (target === 'all' || target === 'macos') ? nativeSmoke.timeoutMs : 0;
      return (targetCount + 1) * timeoutMs + nativeSmokeBudget
        + (targetCount + 2) * PROCESS_CLEANUP_TIMEOUT_MS + 5_000;
    }
    if (parsed.command === 'visual-test') return 2 * timeoutMs + 5_000;
    return timeoutMs + 5_000;
  } catch {
    return 30_000;
  }
}

function cliInvocationLifecycleProjectRoots(rawArguments) {
  try {
    const internal = extractInternalVerificationExpectation(rawArguments);
    const parsed = parseCliArguments(internal.args);
    const candidate = parsed.command === 'verify' || parsed.command === 'unit' ? parsed.positional[0]
      : parsed.command === 'export' ? parsed.positional[1] ?? process.cwd() : null;
    return candidate ? [resolveProject(candidate)] : [];
  } catch { return []; }
}

function unitProgressTargetsForPlan(plan, verbosity) {
  const visibleStages = plan.stages.filter((stage) => stage.includeInLegacyReport);
  return visibleStages.flatMap((stage, index) => {
    if (stage.kind !== 'unit' || stage.disposition !== 'run' || !stage.reportPath) return [];
    const parsed = parseCliArguments(stage.commandArgs);
    return [{
      report: stage.reportPath,
      binding: unitBindingForExecution({
        project: plan.project,
        report: stage.reportPath,
        timeoutMs: stage.timeoutMs,
        options: parsed.options,
        invocationIdentity: plan.invocationIdentity,
        ownerNonce: verificationUnitOwnerNonce(plan, stage),
      }),
      verbosity,
      stageOrdinal: index + 1,
      stageTotal: visibleStages.length,
    }];
  });
}

function startUnitProgressObserver(targets, render = (line) => console.error(line)) {
  const states = targets.map((target) => ({
    ...target,
    stream: createUnitProgressStream({
      verbosity: target.verbosity,
      timeoutMs: target.binding?.timeout_ms ?? target.timeoutMs,
    }),
    observed: false,
    rendererFailed: false,
    finished: false,
    displayedUpdates: 0,
  }));
  const poll = () => {
    for (const state of states) {
      if (state.finished) continue;
      try {
        if (!existsSync(state.report)) continue;
        const report = readUnitReportStable(state.report, 256 * 1024);
        const disposition = unitReportDisposition(report, report?.schema_version === 2 ? state.binding : undefined);
        if (disposition.state === 'terminal' || disposition.state === 'corrupt') {
          state.finished = true;
          continue;
        }
        const projected = projectUnitProgress(report, state.binding, {
          verbosity: state.verbosity,
          stageOrdinal: state.stageOrdinal,
          stageTotal: state.stageTotal,
        });
        const sequence = report?.progress?.sequence;
        if (!projected || !Number.isInteger(sequence)) continue;
        const accepted = state.stream.observe(projected, sequence);
        if (!accepted) continue;
        state.observed = true;
        state.displayedUpdates += 1;
        const current = accepted.unit.current
          ? `; current #${accepted.unit.current.ordinal}${state.verbosity === 'compact' ? '' : (accepted.unit.current.token ? ` ${accepted.unit.current.token}` : '')}` : '';
        const privateReference = state.verbosity === 'diagnostic' ? `; private report ${state.report}` : '';
        try {
          const total = accepted.unit.total === null ? '?' : accepted.unit.total;
          render(`Unit progress ${accepted.stage.ordinal}/${accepted.stage.total}: ${accepted.unit.completed}/${total} cases; elapsed ${accepted.elapsedMs} ms${current}${privateReference}`);
        } catch { state.rendererFailed = true; }
      } catch { /* incomplete progress is best-effort and never affects execution */ }
    }
  };
  poll();
  const timer = setInterval(poll, 250);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      poll();
      const disclosures = [];
      for (const state of states) {
        if (!state.observed) continue;
        const terminal = state.stream.finish();
        const snapshot = state.stream.snapshot();
        const displayed = snapshot.displayedUpdates ?? state.displayedUpdates;
        disclosures.push(`Unit progress updates displayed: ${displayed}.`);
        if (terminal?.progressTruncated || snapshot.progressTruncated) disclosures.push('Unit progress was rate-limited or truncated.');
        if (state.rendererFailed) disclosures.push('Unit progress renderer failed; execution and evidence were unaffected.');
      }
      return [...new Set(disclosures)];
    },
  };
}

async function prepareCoordinatedInvocation(rawArguments) {
  if (rawArguments.some((argument) => argument.startsWith('--gdeck-internal-invocation-identity=')
    || argument.startsWith('--gdeck-internal-verify-plan-digest=')
    || argument.startsWith('--gdeck-internal-unit-binding='))) {
    const error = new Error('Internal verification bindings cannot be supplied by a direct caller');
    error.exitCode = 1;
    throw error;
  }
  let coordinatedArguments = rawArguments;
  let timeoutMs;
  let coordinatedVerificationPlan;
  let coordinatedUnit;
  if (rawArguments[0] === 'verify') {
    const parsed = parseCliArguments(rawArguments);
    const project = resolveProject(parsed.positional[0]);
    const outputPath = resolve(parsed.options.output ?? join(project, '.gdeck', 'reports', `verify-${timestamp()}.json`));
    const invocationIdentity = generateInvocationIdentity();
    const plan = resolveVerificationPlan({
      project,
      outputPath,
      timeoutSeconds: parsed.options.timeout ?? DEFAULT_TIMEOUT_SECONDS,
      verificationProfile: parsed.options.profile,
      invocationIdentity,
    });
    coordinatedVerificationPlan = plan;
    coordinatedArguments = [
      ...rawArguments,
      ...(parsed.options.output === undefined ? ['--output', outputPath] : []),
      `--gdeck-internal-verify-plan-digest=${plan.digest}`,
      `--gdeck-internal-invocation-identity=${invocationIdentity}`,
    ];
    timeoutMs = verificationPlanExecutionBudgetMilliseconds(plan);
  } else if (rawArguments[0] === 'unit') {
    const parsed = parseCliArguments(rawArguments);
    const project = resolveProject(parsed.positional[0]);
    const report = resolve(parsed.options.output ?? join(project, '.gdeck', 'reports', `unit-${timestamp()}.json`));
    const invocationIdentity = generateInvocationIdentity();
    const ownerNonce = randomBytes(32).toString('hex');
    const binding = unitBindingForExecution({
      project,
      report,
      timeoutMs: timeoutMilliseconds(parsed.options),
      options: parsed.options,
      invocationIdentity,
      ownerNonce,
    });
    coordinatedUnit = { project, report, binding, verbosity: normalizeVerbosity(parsed.options.verbosity, 'compact') };
    coordinatedArguments = [
      ...rawArguments,
      ...(parsed.options.output === undefined ? ['--output', report] : []),
      `--gdeck-internal-unit-binding=${Buffer.from(JSON.stringify(binding)).toString('base64url')}`,
    ];
    timeoutMs = cliInvocationBudgetMilliseconds(coordinatedArguments);
  } else {
    timeoutMs = cliInvocationBudgetMilliseconds(coordinatedArguments);
  }
  return { coordinatedArguments, timeoutMs, coordinatedVerificationPlan, coordinatedUnit };
}

async function runCursorCompatInvocation(rawArguments) {
  let prepared;
  try {
    prepared = await prepareCoordinatedInvocation(rawArguments);
  } catch (error) {
    if (rawArguments[0] === 'verify') {
      console.error(renderResultEnvelopeText(buildResultEnvelope({
        strategy: verificationStrategyFromArgs(rawArguments),
        event: {
          classification: error.resultClassification ?? 'configuration',
          source: error.resultSource ?? 'preflight',
          summary: error.message,
        },
      })));
    }
    console.error(color.red(`Flight Deck: ${error.message}`));
    return Number(error.exitCode ?? 1);
  }
  const { coordinatedArguments, coordinatedVerificationPlan, coordinatedUnit } = prepared;
  const progressTargets = coordinatedUnit ? [{
    ...coordinatedUnit,
    stageOrdinal: 1,
    stageTotal: 1,
  }] : coordinatedVerificationPlan
    ? unitProgressTargetsForPlan(coordinatedVerificationPlan, normalizeVerbosity(parseCliArguments(rawArguments).options.verbosity, 'compact'))
    : [];
  const progressObserver = startUnitProgressObserver(progressTargets);
  const stageProgressObserver = coordinatedVerificationPlan ? startVerificationProgressObserver({
    plan: coordinatedVerificationPlan,
    verbosity: normalizeVerbosity(parseCliArguments(rawArguments).options.verbosity, 'compact'),
    render: (progress) => console.error(renderVerificationProgress(progress)),
  }) : null;

  const originalArgv = process.argv.slice();
  process.argv = [originalArgv[0], originalArgv[1], ...coordinatedArguments];
  process.exitCode = 0;
  try {
    await main();
  } finally {
    process.argv = originalArgv;
    for (const disclosure of progressObserver.stop()) console.error(disclosure);
    const stageProgress = stageProgressObserver?.stop();
    if (stageProgress?.truncated) console.error('Verify stage progress was truncated.');
    if (stageProgress?.rendererFailed) console.error('Verify stage progress renderer failed; execution and evidence were unaffected.');
  }
  const finalStatus = Number(process.exitCode ?? 0);
  if (coordinatedVerificationPlan && (finalStatus !== 0 || !existsSync(coordinatedVerificationPlan.outputPath))) {
    const interruption = projectVerificationJournalSeal(coordinatedVerificationPlan.evidenceBinding.journalPath);
    if (interruption.seal !== 'sealed') {
      console.error('Incremental evidence (non-authoritative):');
      console.error(`  Integrity: ${interruption.integrity}; seal: ${interruption.seal}`);
      console.error(`  Preflight observed: ${interruption.preflightObserved === true ? 'yes' : 'no'}; completed stages: ${interruption.completedStageCount ?? 0}`);
      if (interruption.currentStage) {
        console.error(`  Current stage: ${interruption.currentStage.ordinal} (${interruption.currentStage.stageId})`);
      }
    }
  }
  return finalStatus;
}

async function superviseCliInvocation(rawArguments) {
  let prepared;
  try {
    prepared = await prepareCoordinatedInvocation(rawArguments);
  } catch (error) {
    if (rawArguments[0] === 'verify') {
      console.error(renderResultEnvelopeText(buildResultEnvelope({
        strategy: verificationStrategyFromArgs(rawArguments),
        event: {
          classification: error.resultClassification ?? 'configuration',
          source: error.resultSource ?? 'preflight',
          summary: error.message,
        },
      })));
    }
    console.error(color.red(`Flight Deck: ${error.message}`));
    return Number(error.exitCode ?? 1);
  }
  const { coordinatedArguments, timeoutMs, coordinatedVerificationPlan, coordinatedUnit } = prepared;
  const progressTargets = coordinatedUnit ? [{
    ...coordinatedUnit,
    stageOrdinal: 1,
    stageTotal: 1,
  }] : coordinatedVerificationPlan
    ? unitProgressTargetsForPlan(coordinatedVerificationPlan, normalizeVerbosity(parseCliArguments(rawArguments).options.verbosity, 'compact'))
    : [];
  const progressObserver = startUnitProgressObserver(progressTargets);
  const stageProgressObserver = coordinatedVerificationPlan ? startVerificationProgressObserver({
    plan: coordinatedVerificationPlan,
    verbosity: normalizeVerbosity(parseCliArguments(rawArguments).options.verbosity, 'compact'),
    render: (progress) => console.error(renderVerificationProgress(progress)),
  }) : null;
  const specification = JSON.stringify({
    executable: process.execPath,
    args: [CLI_FILE, ...coordinatedArguments],
    cwd: process.cwd(),
    env: { ...process.env },
    timeoutMs,
    cleanupTimeoutMs: PROCESS_CLEANUP_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024 * 1024,
    phase: 'cli_invocation',
    nonce: randomBytes(32).toString('hex'),
    propagateLifecycleRegistry: true,
    lifecycleProjectRoots: cliInvocationLifecycleProjectRoots(coordinatedArguments),
  });
  const supervisor = spawn(process.execPath, [PROCESS_RUNNER, '--spec-stdin'], { stdio: ['pipe', 'inherit', 'inherit'] });
  supervisor.stdin.on('error', () => { /* supervisor startup failure is reported through its exit */ });
  supervisor.stdin.end(specification);
  let watchdogEscalation;
  let watchdogExpired = false;
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    supervisor.kill('SIGTERM');
    watchdogEscalation = setTimeout(() => supervisor.kill('SIGKILL'), PROCESS_CLEANUP_TIMEOUT_MS + PROCESS_WATCHDOG_GRACE_MS);
  }, timeoutMs + PROCESS_CLEANUP_TIMEOUT_MS + PROCESS_WATCHDOG_GRACE_MS);
  const forwardedSignals = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => supervisor.kill(signal);
    forwardedSignals.set(signal, handler);
    process.on(signal, handler);
  }
  const status = await new Promise((resolveStatus) => {
    supervisor.once('error', () => resolveStatus(127));
    supervisor.once('exit', (code, signal) => resolveStatus(code ?? (signal ? 128 : 1)));
  });
  clearTimeout(watchdog);
  if (watchdogEscalation) clearTimeout(watchdogEscalation);
  for (const [signal, handler] of forwardedSignals) process.off(signal, handler);
  for (const disclosure of progressObserver.stop()) console.error(disclosure);
  const stageProgress = stageProgressObserver?.stop();
  if (stageProgress?.truncated) console.error('Verify stage progress was truncated.');
  if (stageProgress?.rendererFailed) console.error('Verify stage progress renderer failed; execution and evidence were unaffected.');
  const finalStatus = watchdogExpired ? 125 : status;
  if (coordinatedVerificationPlan && (finalStatus !== 0 || !existsSync(coordinatedVerificationPlan.outputPath))) {
    const interruption = projectVerificationJournalSeal(coordinatedVerificationPlan.evidenceBinding.journalPath);
    if (interruption.seal !== 'sealed') {
      console.error('Incremental evidence (non-authoritative):');
      console.error(`  Integrity: ${interruption.integrity}; seal: ${interruption.seal}`);
      console.error(`  Preflight observed: ${interruption.preflightObserved === true ? 'yes' : 'no'}; completed stages: ${interruption.completedStageCount ?? 0}`);
      if (interruption.currentStage) {
        console.error(`  Current stage: ${interruption.currentStage.ordinal} (${interruption.currentStage.stageId})`);
      }
    }
  }
  return finalStatus;
}

async function main() {
  const rawArguments = process.argv.slice(2);
  try {
    const internalVerification = extractInternalVerificationExpectation(process.argv.slice(2));
    const internalVerificationStage = validateInternalVerificationStage(internalVerification.args);
    const parsed = parseCliArguments(internalVerification.args);
    let status = 0;
    switch (parsed.command) {
      case 'help':
      case '--help':
      case '-h':
        printHelp(parsed.options.domain ?? parsed.positional[0]);
        break;
      case 'version':
        console.log(TOOL_VERSION);
        break;
      case 'describe':
        describeCommand(parsed.positional[0], parsed.options.json === true);
        break;
      case 'init':
        initProject(parsed.positional[0]);
        break;
      case 'sync-addon':
        // Reuses init's transactional addon install + config version bump.
        initProject(parsed.positional[0]);
        break;
      case 'doctor':
        status = await doctor(parsed.positional[0], parsed.options, internalVerificationStage);
        break;
      case 'evidence-index':
        status = evidenceIndexCommand(parsed.positional[0], parsed.options);
        break;
      case 'check':
        status = checkProject(parsed.positional[0], parsed.options, internalVerificationStage);
        break;
      case 'run':
        status = await runProject(parsed.positional[0], parsed.options, parsed.passthrough);
        break;
      case 'capture':
        status = captureProject(parsed.positional, parsed.options);
        break;
      case 'benchmark':
        status = benchmarkProject(parsed.positional, parsed.options, internalVerificationStage);
        break;
      case 'scenario':
        status = runScenario(parsed.positional, parsed.options, internalVerificationStage);
        break;
      case 'baseline':
        status = baselineProject(parsed.positional, parsed.options);
        break;
      case 'visual-test':
        status = visualTest(parsed.positional, parsed.options, internalVerificationStage);
        break;
      case 'verify':
        status = verifyProject(
          parsed.positional[0], parsed.options, internalVerification.expectedPlanDigest, internalVerification.invocationIdentity,
        );
        break;
      case 'oracle-verify':
        status = oracleVerify(parsed.positional[0], parsed.options);
        break;
      case 'templates':
        status = await templatesCommand(parsed.positional, parsed.options);
        break;
      case 'export-init':
        status = exportInit(parsed.positional[0]);
        break;
      case 'export':
        status = exportProject(parsed.positional, parsed.options, internalVerificationStage);
        break;
      case 'unit':
        status = runUnitTests(parsed.positional[0], parsed.options, internalVerificationStage, internalVerification.unitBinding);
        break;
      case 'scene':
        status = parsed.positional[0] === 'set'
          ? sceneSet(parsed.positional, parsed.options, internalVerificationStage)
          : parsed.positional[0] === 'restore'
            ? sceneRestore(parsed.positional, parsed.options, internalVerificationStage)
            : sceneDoctor(parsed.positional, parsed.options, internalVerificationStage);
        break;
      case 'editor':
        status = await editorCommand(parsed.positional, parsed.options);
        break;
      default:
        throw new Error(`Unknown command: ${parsed.command}`);
    }
    process.exitCode = status;
  } catch (error) {
    if (error.resultClassification) {
      publishInternalStageOutcome(error.resultClassification, error.resultSource ?? 'preflight', error.message);
    }
    if (rawArguments[0] === 'verify') {
      const envelope = error.resultReport?.resultEnvelope ?? buildResultEnvelope({
        report: error.resultReport,
        strategy: verificationStrategyFromArgs(rawArguments),
        event: {
          classification: error.resultClassification ?? 'configuration',
          source: error.resultSource ?? 'preflight',
          summary: error.message,
        },
      });
      console.error(renderResultEnvelopeText(envelope));
    }
    console.error(color.red(`Flight Deck: ${error.message}`));
    process.exitCode = Number(error.exitCode ?? 1);
  }
}

if (privateLifecycleRegistry()) {
  await main();
} else if (cursorCompatEnabled()) {
  // Cursor fork: prepare unit/verify bindings in-process, skip nested Job supervisors.
  process.exitCode = await runCursorCompatInvocation(process.argv.slice(2));
} else {
  process.exitCode = await superviseCliInvocation(process.argv.slice(2));
}
