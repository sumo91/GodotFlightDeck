import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  canonicalEvidenceJson as canonicalVerificationPlanJson,
  INVOCATION_IDENTITY_PATTERN,
  processBirthIdentity,
} from './evidence-contract.mjs';
import { pathContainsSymlink, pathIsInside } from './safety.mjs';

function fsyncBestEffort(descriptor) {
  try {
    fsyncSync(descriptor);
  } catch (error) {
    const unsupported = new Set(['EINVAL', 'ENOTSUP', 'EISDIR']);
    if (process.platform === 'win32') unsupported.add('EPERM').add('EACCES');
    if (!unsupported.has(error?.code)) throw error;
  }
}

const RECORD_PATTERN = /^(\d{6})-([a-f0-9]{64})\.json$/;
const MAX_RECORDS = 256;
const MAX_RECORD_BYTES = 384 * 1024;
const MAX_OPERATIONAL_RECORD_BYTES = 8 * 1024;
const MAX_JOURNAL_BYTES = 512 * 1024;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const STAGE_ID_PATTERN = /^stage-\d{3}$/;
const TERMINAL_STATES = new Set(['passed', 'failed', 'skipped', 'blocked', 'cancelled', 'inconclusive']);
const CLASSIFICATIONS = new Set([
  'unit_assertion', 'visual_regression', 'performance_budget', 'scenario_assertion', 'export_integrity',
  'configuration', 'precondition', 'fixture_isolation', 'plan_drift', 'report_io', 'report_missing',
  'report_corrupt', 'process_spawn', 'timeout', 'cleanup_timeout', 'cancelled', 'unknown',
]);
const SOURCES = new Set(['structured_report', 'preflight', 'process_result']);
const AGGREGATE_VERDICTS = new Set(['PASSED', 'FAILED', 'INCONCLUSIVE', 'CANCELLED']);

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function pathIdentity(path) {
  const metadata = lstatSync(path);
  return { dev: metadata.dev, ino: metadata.ino, mode: metadata.mode, size: metadata.size };
}

function sameIdentity(path, identity, kind) {
  try {
    const metadata = lstatSync(path);
    return metadata.dev === identity.dev && metadata.ino === identity.ino
      && (kind === 'directory' ? metadata.isDirectory() : metadata.isFile()) && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function assertIdentity(path, identity, kind, label) {
  if (!sameIdentity(path, identity, kind)) throw new Error(`${label} identity changed`);
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
}

function exclusiveFile(path, bytes, mode = 0o600) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(path, flags, mode);
  try {
    writeAll(descriptor, bytes);
    fsyncBestEffort(descriptor);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size !== bytes.length) throw new Error('exclusive file publication was incomplete');
    return { dev: metadata.dev, ino: metadata.ino, mode: metadata.mode, size: metadata.size };
  } finally {
    closeSync(descriptor);
  }
}

function safeUnlink(path, identity, label) {
  const parent = dirname(path);
  const quarantine = join(parent, `.${basename(path)}.unlink-${randomBytes(16).toString('hex')}`);
  assertIdentity(path, identity, 'file', label);
  renameSync(path, quarantine);
  if (!sameIdentity(quarantine, identity, 'file')) {
    if (!existsSync(path)) renameSync(quarantine, path);
    throw new Error(`${label} identity changed during release`);
  }
  unlinkSync(quarantine);
  if (existsSync(path)) throw new Error(`${label} replacement appeared during release`);
}

function recordCore(invocationIdentity, sequence, previousHash, type, elapsedMs, payload) {
  return { schemaVersion: 1, invocationIdentity, sequence, previousHash, type, elapsedMs, payload };
}

function recordBytes(core) {
  const recordHash = createHash('sha256').update(canonicalVerificationPlanJson(core)).digest('hex');
  const record = { ...core, recordHash };
  return { record, bytes: Buffer.from(`${canonicalVerificationPlanJson(record)}\n`) };
}

function safeBoundPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validEvidenceBinding(binding) {
  return exactKeys(binding, [
    'schemaVersion', 'invocationIdentity', 'project', 'strategy', 'outputPath', 'timeoutMs', 'resolver',
    'inputsDigest', 'namespacePath', 'lockPath', 'ownerPath', 'journalPath', 'stageReportRoot',
    'retentionCandidates', 'planDigest',
  ])
    && binding.schemaVersion === 1
    && INVOCATION_IDENTITY_PATTERN.test(binding.invocationIdentity ?? '')
    && safeBoundPath(binding.project)
    && exactKeys(binding.strategy, ['mode', 'profile'])
    && ['legacy', 'profile'].includes(binding.strategy.mode)
    && (binding.strategy.profile === null || (typeof binding.strategy.profile === 'string'
      && binding.strategy.profile.length <= 100 && !/[\u0000-\u001f\u007f]/.test(binding.strategy.profile)))
    && safeBoundPath(binding.outputPath)
    && Number.isInteger(binding.timeoutMs) && binding.timeoutMs > 0
    && exactKeys(binding.resolver, ['verificationPlanSchemaVersion', 'contract'])
    && binding.resolver.verificationPlanSchemaVersion === 1
    && binding.resolver.contract === 'gdeck-verification-plan/1'
    && /^[a-f0-9]{64}$/.test(binding.inputsDigest ?? '')
    && /^[a-f0-9]{64}$/.test(binding.planDigest ?? '')
    && ['namespacePath', 'lockPath', 'ownerPath', 'journalPath', 'stageReportRoot'].every((key) => safeBoundPath(binding[key]))
    && Array.isArray(binding.retentionCandidates);
}

function validReportReference(value) {
  return value === null || (exactKeys(value, ['path', 'sha256', 'size'])
    && safeBoundPath(value.path) && /^[a-f0-9]{64}$/.test(value.sha256 ?? '')
    && Number.isInteger(value.size) && value.size >= 0 && value.size <= 64 * 1024 * 1024);
}

function validOutcome(value) {
  return value === undefined || (exactKeys(value, ['classification', 'source'])
    && CLASSIFICATIONS.has(value.classification) && SOURCES.has(value.source));
}

function validPayload(type, payload) {
  if (type === 'header') return exactKeys(payload, ['evidenceBinding']) && validEvidenceBinding(payload.evidenceBinding);
  if (type === 'preflight_completed') return exactKeys(payload, []);
  if (type === 'stage_started') {
    return exactKeys(payload, ['ordinal', 'total', 'stageId'])
      && Number.isInteger(payload.ordinal) && payload.ordinal >= 1
      && Number.isInteger(payload.total) && payload.total >= payload.ordinal
      && STAGE_ID_PATTERN.test(payload.stageId ?? '');
  }
  if (type === 'stage_terminal') {
    const keys = Object.keys(payload ?? {});
    const expected = payload?.outcome === undefined
      ? ['ordinal', 'stageId', 'state', 'report']
      : ['ordinal', 'stageId', 'state', 'report', 'outcome'];
    return keys.length === expected.length && exactKeys(payload, expected)
      && Number.isInteger(payload.ordinal) && payload.ordinal >= 1
      && STAGE_ID_PATTERN.test(payload.stageId ?? '')
      && TERMINAL_STATES.has(payload.state)
      && validReportReference(payload.report)
      && validOutcome(payload.outcome);
  }
  if (type === 'report_binding') {
    return exactKeys(payload, ['outputPath', 'sha256', 'size'])
      && safeBoundPath(payload.outputPath) && /^[a-f0-9]{64}$/.test(payload.sha256 ?? '')
      && Number.isInteger(payload.size) && payload.size >= 0 && payload.size <= MAX_REPORT_BYTES;
  }
  return false;
}

function validateTransition(records, record) {
  if (record.sequence === 0) {
    if (record.type !== 'header') throw new Error('Journal sequence zero must be the header');
    return;
  }
  if (record.type === 'header') throw new Error('Journal contains a duplicate header');
  if (records.some((item) => item.type === 'report_binding')) throw new Error('Journal contains a record after report binding');
  if (record.type === 'preflight_completed'
    && records.some((item) => item.type === 'preflight_completed' || item.type.startsWith('stage_'))) {
    throw new Error('Journal preflight completion is duplicated or out of order');
  }
  if (record.type.startsWith('stage_') && !records.some((item) => item.type === 'preflight_completed')) {
    throw new Error('Journal stage observation precedes preflight completion');
  }
  const open = [];
  let lastStartedOrdinal = 0;
  let lastTerminalOrdinal = 0;
  for (const item of records) {
    if (item.type === 'stage_started') {
      if (item.payload.ordinal <= lastStartedOrdinal || item.payload.ordinal <= lastTerminalOrdinal) {
        throw new Error('Journal stage start is out of order');
      }
      lastStartedOrdinal = item.payload.ordinal;
      open.push(item.payload);
    }
    if (item.type === 'stage_terminal') {
      if (item.payload.ordinal <= lastTerminalOrdinal) throw new Error('Journal stage terminal is out of order');
      lastTerminalOrdinal = item.payload.ordinal;
      const standalone = ['skipped', 'blocked'].includes(item.payload.state);
      if (standalone) {
        if (open[0] && open[0].ordinal <= item.payload.ordinal) throw new Error('Journal standalone terminal conflicts with a started stage');
        continue;
      }
      const started = open.shift();
      if (!started || started.ordinal !== item.payload.ordinal || started.stageId !== item.payload.stageId) {
        throw new Error('Journal stage terminal does not match its start');
      }
    }
  }
  if (record.type === 'stage_started'
    && (record.payload.ordinal <= lastStartedOrdinal || record.payload.ordinal <= lastTerminalOrdinal)) {
    throw new Error('Journal stage start is out of order');
  }
  if (record.type === 'stage_terminal') {
    const standalone = ['skipped', 'blocked'].includes(record.payload.state);
    if (record.payload.ordinal <= lastTerminalOrdinal) throw new Error('Journal stage terminal is out of order');
    if (standalone) {
      if (open[0] && open[0].ordinal <= record.payload.ordinal) {
        throw new Error('Journal standalone terminal conflicts with a started stage');
      }
    } else {
      const started = open[0];
      if (!started || started.ordinal !== record.payload.ordinal || started.stageId !== record.payload.stageId) {
        throw new Error('Journal stage terminal does not match its start');
      }
    }
  }
  if (record.type === 'report_binding') {
    if (open.length > 0) throw new Error('Journal cannot bind a report with an open stage');
    const boundOutput = records[0]?.payload?.evidenceBinding?.outputPath;
    if (typeof boundOutput !== 'string' || resolve(record.payload.outputPath) !== resolve(boundOutput)) {
      throw new Error('Journal report binding output does not match its Evidence Binding');
    }
  }
}

function writerAssertion(writer) {
  if (!writer || writer.closed) throw new Error('Verification Journal writer is closed');
  assertIdentity(dirname(writer.lockPath), writer.rootIdentity, 'directory', 'Verification evidence root');
  assertIdentity(writer.lockPath, writer.lockIdentity, 'file', 'Verification owner lock');
  assertIdentity(writer.namespacePath, writer.namespaceIdentity, 'directory', 'Verification evidence namespace');
  assertIdentity(writer.ownerPath, writer.ownerIdentity, 'file', 'Verification evidence owner');
  assertIdentity(writer.journalPath, writer.journalIdentity, 'directory', 'Verification Journal directory');
  assertIdentity(writer.stageReportRoot, writer.stageReportIdentity, 'directory', 'Verification stage report directory');
  const rootMetadata = fstatSync(writer.rootDescriptor);
  const namespaceMetadata = fstatSync(writer.namespaceDescriptor);
  const journalMetadata = fstatSync(writer.journalDescriptor);
  const stageReportMetadata = fstatSync(writer.stageReportDescriptor);
  if (rootMetadata.dev !== writer.rootIdentity.dev || rootMetadata.ino !== writer.rootIdentity.ino
    || namespaceMetadata.dev !== writer.namespaceIdentity.dev || namespaceMetadata.ino !== writer.namespaceIdentity.ino
    || journalMetadata.dev !== writer.journalIdentity.dev || journalMetadata.ino !== writer.journalIdentity.ino
    || stageReportMetadata.dev !== writer.stageReportIdentity.dev || stageReportMetadata.ino !== writer.stageReportIdentity.ino) {
    throw new Error('Verification Journal directory descriptor identity changed');
  }
  if (realpathSync(writer.journalPath) !== writer.journalRealPath) throw new Error('Verification Journal path changed');
}

export function createVerificationJournal(plan) {
  const binding = plan?.evidenceBinding;
  if (!validEvidenceBinding(binding) || binding.planDigest !== plan.digest || binding.invocationIdentity !== plan.invocationIdentity) {
    throw new Error('Verification Journal requires an exact Plan evidence binding');
  }
  if (!pathIsInside(plan.project, binding.namespacePath) || pathContainsSymlink(plan.project, binding.root ?? binding.namespacePath)) {
    throw new Error('Verification Journal namespace is unsafe');
  }
  const evidenceRoot = dirname(binding.lockPath);
  if (pathContainsSymlink(plan.project, evidenceRoot)) throw new Error('Verification evidence root contains a symbolic link');
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  if (pathContainsSymlink(plan.project, evidenceRoot)) throw new Error('Verification evidence root changed to a symbolic link');
  const ownerNonce = randomBytes(32).toString('hex');
  const ownerProcessBirthIdentity = processBirthIdentity(process.pid);
  const ownerExpiresAtMs = Date.now() + Math.max(60_000,
    plan.stages.reduce((total, stage) => total + Number(stage.timeoutMs ?? 0) + 15_000, 0) + 60_000);
  const lockBytes = Buffer.from(`${canonicalVerificationPlanJson({
    schemaVersion: 1, invocationIdentity: binding.invocationIdentity, ownerNonce, pid: process.pid,
    processBirthIdentity: ownerProcessBirthIdentity, expiresAtMs: ownerExpiresAtMs,
  })}\n`);
  let lockIdentity;
  try { lockIdentity = exclusiveFile(binding.lockPath, lockBytes); }
  catch (error) {
    const conflict = new Error(`Verification owner lock is active or unavailable: ${error.message}`);
    conflict.code = 'evidence_owner_conflict';
    conflict.resultClassification = 'precondition';
    conflict.resultSource = 'preflight';
    throw conflict;
  }
  const writer = {
    closed: false,
    invocationIdentity: binding.invocationIdentity,
    lockPath: binding.lockPath,
    lockIdentity,
    namespacePath: binding.namespacePath,
    ownerPath: binding.ownerPath,
    journalPath: binding.journalPath,
    stageReportRoot: binding.stageReportRoot,
    records: [],
    totalBytes: 0,
  };
  try {
    writer.rootIdentity = pathIdentity(evidenceRoot);
    writer.rootDescriptor = openSync(
      evidenceRoot, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
    fsyncBestEffort(writer.rootDescriptor);
    mkdirSync(dirname(binding.namespacePath), { recursive: true, mode: 0o700 });
    if (pathContainsSymlink(plan.project, dirname(binding.namespacePath))) throw new Error('Verification output evidence root is unsafe');
    mkdirSync(binding.namespacePath, { mode: 0o700 });
    writer.namespaceIdentity = pathIdentity(binding.namespacePath);
    writer.namespaceDescriptor = openSync(
      binding.namespacePath, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const ownerBytes = Buffer.from(`${canonicalVerificationPlanJson({
      schemaVersion: 1, invocationIdentity: binding.invocationIdentity, ownerNonce, pid: process.pid,
      processBirthIdentity: ownerProcessBirthIdentity, expiresAtMs: ownerExpiresAtMs,
    })}\n`);
    writer.ownerIdentity = exclusiveFile(binding.ownerPath, ownerBytes);
    mkdirSync(binding.journalPath, { mode: 0o700 });
    writer.journalIdentity = pathIdentity(binding.journalPath);
    writer.journalRealPath = realpathSync(binding.journalPath);
    writer.journalDescriptor = openSync(
      binding.journalPath, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
    mkdirSync(binding.stageReportRoot, { mode: 0o700 });
    writer.stageReportIdentity = pathIdentity(binding.stageReportRoot);
    writer.stageReportDescriptor = openSync(
      binding.stageReportRoot, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
    appendVerificationJournalRecord(writer, 'header', { evidenceBinding: binding }, 0);
    return writer;
  } catch (error) {
    try { safeUnlink(binding.lockPath, lockIdentity, 'Verification owner lock'); } catch { /* preserve original failure */ }
    for (const descriptor of [writer.stageReportDescriptor, writer.journalDescriptor, writer.namespaceDescriptor, writer.rootDescriptor]) {
      if (Number.isInteger(descriptor)) try { closeSync(descriptor); } catch { /* preserve original failure */ }
    }
    writer.closed = true;
    throw error;
  }
}

export function appendVerificationJournalRecord(writer, type, payload, elapsedMs) {
  writerAssertion(writer);
  if (!Number.isInteger(elapsedMs) || elapsedMs < 0) throw new Error('Verification Journal elapsedMs must be a non-negative integer');
  if (!validPayload(type, payload)) throw new Error(`Verification Journal ${type} payload violates its schema`);
  if (writer.records.length >= MAX_RECORDS) throw new Error('Verification Journal record limit is exhausted');
  const reservedRecords = type === 'stage_started' ? 2 : type === 'stage_terminal' ? 1 : 0;
  if (writer.records.length + 1 + reservedRecords > MAX_RECORDS) {
    throw new Error('Verification Journal cannot reserve terminal record capacity');
  }
  const sequence = writer.records.length;
  const previousHash = sequence === 0 ? null : writer.records.at(-1).recordHash;
  const { record, bytes } = recordBytes(recordCore(writer.invocationIdentity, sequence, previousHash, type, elapsedMs, payload));
  validateTransition(writer.records, record);
  const recordLimit = type === 'header' ? MAX_RECORD_BYTES : MAX_OPERATIONAL_RECORD_BYTES;
  if (bytes.length > recordLimit) throw new Error(`Verification Journal ${type} record exceeds ${recordLimit} bytes`);
  const reservedBytes = (type === 'stage_started' ? 2 : type === 'stage_terminal' ? 1 : 0) * MAX_OPERATIONAL_RECORD_BYTES;
  if (writer.totalBytes + bytes.length + reservedBytes > MAX_JOURNAL_BYTES) {
    throw new Error('Verification Journal exceeds 524288 bytes or cannot reserve terminal capacity');
  }
  if (type === 'stage_terminal' && payload.report && dirname(resolve(payload.report.path)) === resolve(writer.stageReportRoot)) {
    fsyncBestEffort(writer.stageReportDescriptor);
    writerAssertion(writer);
  }
  const name = `${String(sequence).padStart(6, '0')}-${record.recordHash}.json`;
  const finalPath = resolve(writer.journalPath, name);
  const temporaryPath = resolve(writer.journalPath, `.pending-${writer.invocationIdentity}-${randomBytes(8).toString('hex')}`);
  let temporaryIdentity;
  try {
    temporaryIdentity = exclusiveFile(temporaryPath, bytes);
    writerAssertion(writer);
    if (sequence > 0) {
      const previousName = `${String(sequence - 1).padStart(6, '0')}-${previousHash}.json`;
      assertIdentity(resolve(writer.journalPath, previousName), writer.recordIdentities.at(-1), 'file', 'Previous Journal record');
    }
    linkSync(temporaryPath, finalPath);
    fsyncBestEffort(writer.journalDescriptor);
    const finalIdentity = pathIdentity(finalPath);
    if (finalIdentity.dev !== temporaryIdentity.dev || finalIdentity.ino !== temporaryIdentity.ino) {
      throw new Error('Verification Journal record publication identity mismatch');
    }
    safeUnlink(temporaryPath, temporaryIdentity, 'Verification Journal pending record');
    fsyncBestEffort(writer.journalDescriptor);
    writerAssertion(writer);
    writer.records.push(record);
    writer.recordIdentities ??= [];
    writer.recordIdentities.push(finalIdentity);
    writer.totalBytes += bytes.length;
    return record;
  } catch (error) {
    if (temporaryIdentity && sameIdentity(temporaryPath, temporaryIdentity, 'file')) {
      try { safeUnlink(temporaryPath, temporaryIdentity, 'Verification Journal pending record'); } catch { /* preserve failure */ }
    }
    throw error;
  }
}

export function closeVerificationJournal(writer) {
  if (!writer || writer.closed) return;
  let integrityError;
  try { writerAssertion(writer); } catch (error) { integrityError = error; }
  let lockError;
  try {
    assertIdentity(dirname(writer.lockPath), writer.rootIdentity, 'directory', 'Verification evidence root');
    safeUnlink(writer.lockPath, writer.lockIdentity, 'Verification owner lock');
    fsyncBestEffort(writer.rootDescriptor);
  } catch (error) { lockError = error; }
  for (const descriptor of [writer.stageReportDescriptor, writer.journalDescriptor, writer.namespaceDescriptor]) {
    if (Number.isInteger(descriptor)) try { fsyncBestEffort(descriptor); } catch (error) { lockError ??= error; }
  }
  for (const descriptor of [writer.stageReportDescriptor, writer.journalDescriptor, writer.namespaceDescriptor, writer.rootDescriptor]) {
    if (Number.isInteger(descriptor)) try { closeSync(descriptor); } catch (error) { lockError ??= error; }
  }
  writer.closed = true;
  if (lockError) throw lockError;
  if (integrityError) throw integrityError;
}

function invalidJournal(reasonCode = 'journal_invalid') {
  return { integrity: 'unverifiable', reasonCode, records: [] };
}

export function readVerificationJournal(journalCandidate) {
  let journalDescriptor;
  try {
    const journalPath = resolve(journalCandidate);
    const metadata = lstatSync(journalPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return invalidJournal();
    journalDescriptor = openSync(
      journalPath, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const descriptorMetadata = fstatSync(journalDescriptor);
    if (descriptorMetadata.dev !== metadata.dev || descriptorMetadata.ino !== metadata.ino || !descriptorMetadata.isDirectory()) {
      return invalidJournal('journal_unstable');
    }
    const names = readdirSync(journalPath).sort();
    if (names.length === 0 || names.length > MAX_RECORDS || names.some((name) => !RECORD_PATTERN.test(name))) return invalidJournal();
    const records = [];
    let totalBytes = 0;
    let previousHash = null;
    for (let index = 0; index < names.length; index += 1) {
      const match = names[index].match(RECORD_PATTERN);
      if (Number(match[1]) !== index) return invalidJournal('journal_sequence');
      const path = resolve(journalPath, names[index]);
      const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      let bytes;
      let before;
      let after;
      try {
        before = fstatSync(descriptor);
        if (!before.isFile() || before.size <= 0 || before.size > MAX_RECORD_BYTES) return invalidJournal();
        bytes = readFileSync(descriptor);
        after = fstatSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const pathAfter = lstatSync(path);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size
        || pathAfter.mtimeMs !== before.mtimeMs || pathAfter.ctimeMs !== before.ctimeMs || pathAfter.isSymbolicLink()) {
        return invalidJournal('journal_unstable');
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_JOURNAL_BYTES) return invalidJournal('journal_oversized');
      const record = JSON.parse(bytes.toString('utf8'));
      if (!exactKeys(record, ['schemaVersion', 'invocationIdentity', 'sequence', 'previousHash', 'type', 'elapsedMs', 'payload', 'recordHash'])) return invalidJournal();
      if (record.type !== 'header' && bytes.length > MAX_OPERATIONAL_RECORD_BYTES) return invalidJournal('journal_oversized');
      if (record.schemaVersion !== 1 || record.sequence !== index || record.previousHash !== previousHash
        || !INVOCATION_IDENTITY_PATTERN.test(record.invocationIdentity ?? '') || !Number.isInteger(record.elapsedMs) || record.elapsedMs < 0
        || !validPayload(record.type, record.payload)) return invalidJournal();
      const core = recordCore(record.invocationIdentity, record.sequence, record.previousHash, record.type, record.elapsedMs, record.payload);
      const expectedHash = createHash('sha256').update(canonicalVerificationPlanJson(core)).digest('hex');
      if (record.recordHash !== expectedHash || match[2] !== expectedHash
        || bytes.toString('utf8') !== `${canonicalVerificationPlanJson(record)}\n`) return invalidJournal('journal_hash');
      if (index > 0 && record.invocationIdentity !== records[0].invocationIdentity) return invalidJournal('journal_transplant');
      validateTransition(records, record);
      records.push(record);
      previousHash = record.recordHash;
    }
    const binding = records[0]?.payload?.evidenceBinding;
    if (!validEvidenceBinding(binding) || resolve(binding.journalPath) !== journalPath
      || binding.invocationIdentity !== records[0].invocationIdentity) return invalidJournal('journal_binding');
    const namesAfter = readdirSync(journalPath).sort();
    const descriptorAfter = fstatSync(journalDescriptor);
    const pathAfter = lstatSync(journalPath);
    if (JSON.stringify(namesAfter) !== JSON.stringify(names)
      || descriptorAfter.dev !== metadata.dev || descriptorAfter.ino !== metadata.ino
      || descriptorAfter.mtimeMs !== metadata.mtimeMs || descriptorAfter.ctimeMs !== metadata.ctimeMs
      || pathAfter.dev !== metadata.dev || pathAfter.ino !== metadata.ino
      || pathAfter.mtimeMs !== metadata.mtimeMs || pathAfter.ctimeMs !== metadata.ctimeMs || pathAfter.isSymbolicLink()) {
      return invalidJournal('journal_unstable');
    }
    return { integrity: 'valid', reasonCode: null, records, evidenceBinding: binding, totalBytes };
  } catch {
    return invalidJournal();
  } finally {
    if (Number.isInteger(journalDescriptor)) try { closeSync(journalDescriptor); } catch { /* read projection is already bounded */ }
  }
}

export function projectVerificationJournalSeal(journalPath) {
  const observed = readVerificationJournal(journalPath);
  if (observed.integrity !== 'valid') return { integrity: 'unverifiable', seal: 'unverifiable' };
  const completedStageCount = observed.records.filter((record) => record.type === 'stage_terminal').length;
  const openStages = [];
  for (const record of observed.records) {
    if (record.type === 'stage_started') openStages.push(record.payload);
    if (record.type === 'stage_terminal' && !['skipped', 'blocked'].includes(record.payload.state)) openStages.shift();
  }
  const current = openStages.at(-1);
  const currentStage = current ? { ordinal: current.ordinal, stageId: current.stageId } : null;
  const base = {
    integrity: 'valid', completedStageCount, currentStage,
    preflightObserved: observed.records.some((record) => record.type === 'preflight_completed'),
    lastSequence: observed.records.at(-1).sequence,
  };
  const bindingRecord = observed.records.at(-1);
  if (bindingRecord.type !== 'report_binding') return { ...base, seal: 'incomplete' };
  const outputPath = resolve(bindingRecord.payload.outputPath);
  if (outputPath !== resolve(observed.evidenceBinding.outputPath)) {
    return { ...base, integrity: 'unverifiable', seal: 'unverifiable' };
  }
  if (!existsSync(outputPath)) return { ...base, seal: 'incomplete' };
  try {
    if (pathContainsSymlink(observed.evidenceBinding.project, outputPath)) return { ...base, integrity: 'unverifiable', seal: 'unverifiable' };
    const descriptor = openSync(outputPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let before;
    let after;
    let bytes;
    try {
      before = fstatSync(descriptor);
      if (!before.isFile() || before.size !== bindingRecord.payload.size || before.size > MAX_REPORT_BYTES) {
        return { ...base, integrity: 'unverifiable', seal: 'unverifiable' };
      }
      bytes = readFileSync(descriptor);
      after = fstatSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const pathAfter = lstatSync(outputPath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size
      || pathAfter.mtimeMs !== before.mtimeMs || pathAfter.ctimeMs !== before.ctimeMs || pathAfter.isSymbolicLink()
      || createHash('sha256').update(bytes).digest('hex') !== bindingRecord.payload.sha256) {
      return { ...base, integrity: 'unverifiable', seal: 'unverifiable' };
    }
    const report = JSON.parse(bytes.toString('utf8'));
    if (report.schemaVersion !== 2 || report.resultEnvelope?.schemaVersion !== 1
      || !AGGREGATE_VERDICTS.has(report.resultEnvelope?.verdict)
      || report.verificationPlanDigest !== observed.evidenceBinding.planDigest
      || report.journal?.path !== observed.evidenceBinding.journalPath
      || report.journal?.invocationIdentity !== observed.evidenceBinding.invocationIdentity
      || canonicalVerificationPlanJson(report.evidenceBinding) !== canonicalVerificationPlanJson(observed.evidenceBinding)) {
      return { ...base, integrity: 'unverifiable', seal: 'unverifiable' };
    }
    return { ...base, seal: 'sealed' };
  } catch {
    return { ...base, integrity: 'unverifiable', seal: 'unverifiable' };
  }
}
