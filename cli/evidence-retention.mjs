import { createHash } from 'node:crypto';
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, unlinkSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { canonicalEvidenceJson, INVOCATION_IDENTITY_PATTERN, processBirthIdentity } from './evidence-contract.mjs';
import { projectVerificationJournalSeal, readVerificationJournal } from './evidence-journal.mjs';
import { pathContainsSymlink, pathIsInside } from './safety.mjs';

function fsyncBestEffort(descriptor) {
  try { fsyncSync(descriptor); } catch (error) {
    const unsupported = new Set(['EINVAL', 'ENOTSUP', 'EISDIR']);
    if (process.platform === 'win32') unsupported.add('EPERM').add('EACCES');
    if (!unsupported.has(error?.code)) throw error;
  }
}

export const RETENTION_MAX_NAMESPACES = 64;
export const RETENTION_MAX_BYTES = 512 * 1024 * 1024;
export const RETENTION_INVOCATION_RESERVE_BYTES = 224 * 1024 * 1024;
const SEALED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const INCOMPLETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_INVENTORY_FILES = 512;
const MAX_INVENTORY_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RETENTION_MANIFEST_BYTES = 384 * 1024;
const MAX_RETENTION_SCAN_ENTRIES = 32 * 1024;
const MAX_RETENTION_SCAN_BYTES = 768 * 1024 * 1024;
const MAX_RETENTION_ROOT_ENTRIES = 256;
const OUTPUT_TOKEN_PATTERN = /^[a-f0-9]{24}$/;

function fileIdentity(path, relativePath, budget = undefined) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error('Retention inventory contains a symbolic link');
  if (budget) {
    budget.entries += 1;
    if (budget.entries > MAX_RETENTION_SCAN_ENTRIES) throw new Error('Retention scan entry limit exceeded');
  }
  if (metadata.isDirectory()) {
    return { path: relativePath, type: 'directory', dev: metadata.dev, ino: metadata.ino, size: 0, sha256: null };
  }
  if (!metadata.isFile() || metadata.size > MAX_INVENTORY_FILE_BYTES) throw new Error('Retention inventory contains an unsafe file');
  if (budget) {
    budget.bytes += metadata.size;
    if (budget.bytes > MAX_RETENTION_SCAN_BYTES) throw new Error('Retention scan byte limit exceeded');
  }
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes;
  let descriptorMetadata;
  try {
    descriptorMetadata = fstatSync(descriptor);
    if (descriptorMetadata.dev !== metadata.dev || descriptorMetadata.ino !== metadata.ino || !descriptorMetadata.isFile()) {
      throw new Error('Retention inventory file identity changed before reading');
    }
    bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor);
    if (afterRead.dev !== metadata.dev || afterRead.ino !== metadata.ino || afterRead.size !== metadata.size) {
      throw new Error('Retention inventory changed while reading');
    }
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path);
  if (metadata.dev !== after.dev || metadata.ino !== after.ino || metadata.size !== after.size || after.isSymbolicLink()) {
    throw new Error('Retention inventory changed while scanning');
  }
  return {
    path: relativePath,
    type: 'file',
    dev: metadata.dev,
    ino: metadata.ino,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function directoryInventory(root, budget = undefined) {
  const entries = [];
  const visit = (directory, relativeDirectory = '.') => {
    const descriptor = openSync(
      directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = fstatSync(descriptor);
      entries.push(fileIdentity(directory, relativeDirectory, budget));
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (entries.length >= MAX_INVENTORY_FILES) throw new Error('Retention inventory file limit exceeded');
        const path = join(directory, entry.name);
        const relation = relative(root, path).replaceAll('\\', '/');
        if (entry.isDirectory()) visit(path, relation);
        else entries.push(fileIdentity(path, relation, budget));
      }
      const descriptorAfter = fstatSync(descriptor);
      const pathAfter = lstatSync(directory);
      if (before.dev !== descriptorAfter.dev || before.ino !== descriptorAfter.ino
        || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.isSymbolicLink()) {
        throw new Error('Retention inventory directory changed while scanning');
      }
    } finally {
      closeSync(descriptor);
    }
  };
  visit(root);
  return entries;
}

function inventoryBytes(entries) {
  return entries.reduce((total, entry) => total + entry.size, 0);
}

function exactCandidate(candidate) {
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && candidate.schemaVersion === 1
    && ['stale_lock', 'namespace'].includes(candidate.kind)
    && typeof candidate.path === 'string'
    && typeof candidate.quarantinePath === 'string'
    && INVOCATION_IDENTITY_PATTERN.test(candidate.cleanupInvocationIdentity ?? '')
    && typeof candidate.alreadyQuarantined === 'boolean'
    && typeof candidate.reason === 'string'
    && (candidate.invocationIdentity === null || INVOCATION_IDENTITY_PATTERN.test(candidate.invocationIdentity ?? ''))
    && Array.isArray(candidate.entries) && candidate.entries.length > 0 && candidate.entries.length <= MAX_INVENTORY_FILES
    && candidate.entries.every((entry) => entry && typeof entry.path === 'string'
      && ['file', 'directory'].includes(entry.type) && Number.isInteger(entry.dev) && Number.isInteger(entry.ino)
      && Number.isInteger(entry.size) && entry.size >= 0
      && (entry.sha256 === null || /^[a-f0-9]{64}$/.test(entry.sha256)));
}

function retentionQuarantinePath(path, cleanupInvocationIdentity, candidateIdentity, identity) {
  const token = createHash('sha256').update(canonicalEvidenceJson({
    path, cleanupInvocationIdentity, candidateIdentity, identity,
  })).digest('hex').slice(0, 24);
  return join(dirname(path), `.gdeck-retention-${cleanupInvocationIdentity}-${candidateIdentity}-${token}`);
}

function candidateForFile(path, reason, cleanupInvocationIdentity) {
  const entries = [fileIdentity(path, basename(path))];
  return {
    schemaVersion: 1,
    kind: 'stale_lock',
    path,
    quarantinePath: retentionQuarantinePath(path, cleanupInvocationIdentity, 'lock', entries[0]),
    cleanupInvocationIdentity,
    alreadyQuarantined: false,
    invocationIdentity: null,
    reason,
    entries,
  };
}

function candidateForNamespace(path, invocationIdentity, reason, cleanupInvocationIdentity, entries = undefined) {
  const resolvedEntries = entries ?? directoryInventory(path);
  return {
    schemaVersion: 1,
    kind: 'namespace',
    path,
    quarantinePath: retentionQuarantinePath(path, cleanupInvocationIdentity, invocationIdentity, resolvedEntries[0]),
    cleanupInvocationIdentity,
    alreadyQuarantined: false,
    invocationIdentity,
    reason,
    entries: resolvedEntries,
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function ownerIsLive(owner) {
  if (!processIsAlive(owner?.pid)) return false;
  if (owner.processBirthIdentity === null) return true;
  const observed = processBirthIdentity(owner.pid);
  return observed === null || observed === owner.processBirthIdentity;
}

function lockOwner(path) {
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 2 || before.size > 8 * 1024) return null;
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size
      || pathAfter.mtimeMs !== before.mtimeMs || pathAfter.ctimeMs !== before.ctimeMs
      || pathAfter.isSymbolicLink()) return null;
    const value = JSON.parse(bytes.toString('utf8'));
    if (value?.schemaVersion !== 1 || !INVOCATION_IDENTITY_PATTERN.test(value.invocationIdentity ?? '')
      || !/^[a-f0-9]{64}$/.test(value.ownerNonce ?? '') || !Number.isInteger(value.pid)
      || !(value.processBirthIdentity === null || /^[a-f0-9]{64}$/.test(value.processBirthIdentity ?? ''))
      || !Number.isInteger(value.expiresAtMs) || value.expiresAtMs < 1) return null;
    return value;
  } catch { return null; }
  finally { if (Number.isInteger(descriptor)) closeSync(descriptor); }
}

function namespaceObservation(path, invocationIdentity, outputPath, cleanupInvocationIdentity, budget) {
  let entries;
  try { entries = directoryInventory(path, budget); }
  catch { return { path, invocationIdentity, entries: null, bytes: 0, eligible: null }; }
  const bytes = inventoryBytes(entries);
  const ownerPath = join(path, 'owner.json');
  const owner = existsSync(ownerPath) ? lockOwner(ownerPath) : null;
  const ageMs = Math.max(0, Date.now() - lstatSync(path).mtimeMs);
  const journalPath = join(path, 'journal');
  const seal = existsSync(journalPath) ? projectVerificationJournalSeal(journalPath) : { seal: 'unverifiable' };
  const observed = existsSync(journalPath) ? readVerificationJournal(journalPath) : null;
  const boundOutput = observed?.integrity === 'valid' ? observed.evidenceBinding.outputPath : null;
  let reason = null;
  if (seal.seal === 'sealed' && resolve(boundOutput) === resolve(outputPath)) reason = 'superseded_sealed';
  else if (seal.seal === 'sealed' && ageMs >= SEALED_MAX_AGE_MS) reason = 'expired_sealed';
  else if (seal.seal === 'incomplete' && ageMs >= INCOMPLETE_MAX_AGE_MS && owner && !ownerIsLive(owner)) reason = 'expired_incomplete';
  return {
    path, invocationIdentity, entries, bytes,
    eligible: reason ? candidateForNamespace(path, invocationIdentity, reason, cleanupInvocationIdentity, entries) : null,
  };
}

function validateCandidateIdentity(
  candidate, evidenceRoot, allowFulfilled, currentInvocationIdentity = '', currentOwnerPath = '', budget = undefined,
) {
  if (!exactCandidate(candidate) || !pathIsInside(evidenceRoot, candidate.path)) throw new Error('Retention candidate manifest is invalid');
  const path = resolve(candidate.path);
  const components = relative(evidenceRoot, path).replaceAll('\\', '/').split('/');
  const pathShapeValid = candidate.kind === 'stale_lock'
    ? components.length === 1 && components[0] === 'verify-owner.lock'
    : components.length === 2 && OUTPUT_TOKEN_PATTERN.test(components[0])
      && INVOCATION_IDENTITY_PATTERN.test(components[1]) && components[1] === candidate.invocationIdentity;
  if (!pathShapeValid) throw new Error('Retention candidate path shape is invalid');
  const quarantinePath = resolve(candidate.quarantinePath);
  const candidateIdentity = candidate.kind === 'stale_lock' ? 'lock' : candidate.invocationIdentity;
  const expectedQuarantine = retentionQuarantinePath(
    path, candidate.cleanupInvocationIdentity, candidateIdentity, candidate.entries[0],
  );
  if (dirname(quarantinePath) !== dirname(path) || quarantinePath !== expectedQuarantine
    || quarantinePath === path || pathContainsSymlink(evidenceRoot, quarantinePath)) {
    throw new Error('Retention candidate quarantine path is invalid');
  }
  if (candidate.alreadyQuarantined) {
    if (existsSync(path)) throw new Error('Retention target replacement appeared after interrupted quarantine');
    if (!existsSync(quarantinePath)) {
      if (allowFulfilled) return;
      throw new Error('Interrupted retention quarantine disappeared before cleanup');
    }
    const actual = candidate.kind === 'namespace'
      ? directoryInventory(quarantinePath, budget)
      : [fileIdentity(quarantinePath, basename(path), budget)];
    if (canonicalEvidenceJson(actual) !== canonicalEvidenceJson(candidate.entries)) {
      throw new Error('Interrupted retention quarantine identity changed');
    }
    return;
  }
  if (existsSync(quarantinePath)) throw new Error('Retention candidate has an unexpected quarantine');
  if (!existsSync(path)) {
    if (allowFulfilled) return;
    throw new Error('Retention candidate disappeared before cleanup');
  }
  if (allowFulfilled && candidate.kind === 'stale_lock') {
    const currentLock = lockOwner(path);
    const currentOwner = currentOwnerPath && existsSync(currentOwnerPath) ? lockOwner(currentOwnerPath) : null;
    if (currentLock?.invocationIdentity === currentInvocationIdentity
      && currentOwner?.invocationIdentity === currentInvocationIdentity
      && currentLock.ownerNonce === currentOwner.ownerNonce && currentLock.pid === currentOwner.pid) return;
  }
  if (pathContainsSymlink(evidenceRoot, path)) throw new Error('Retention candidate contains a symbolic link');
  const actual = candidate.kind === 'namespace'
    ? directoryInventory(path, budget)
    : [fileIdentity(path, basename(path), budget)];
  if (canonicalEvidenceJson(actual) !== canonicalEvidenceJson(candidate.entries)) {
    throw new Error('Retention candidate identity changed');
  }
}

function recoveredQuarantineCandidate(quarantinePath, evidenceRoot, budget) {
  const match = basename(quarantinePath).match(/^\.gdeck-retention-([a-f0-9]{64})-(lock|[a-f0-9]{64})-([a-f0-9]{24})$/);
  if (!match) return null;
  const cleanupInvocationIdentity = match[1];
  const candidateIdentity = match[2];
  const kind = candidateIdentity === 'lock' ? 'stale_lock' : 'namespace';
  const path = kind === 'stale_lock'
    ? join(evidenceRoot, 'verify-owner.lock')
    : join(dirname(quarantinePath), candidateIdentity);
  if (existsSync(path)) throw new Error('Interrupted retention quarantine conflicts with a replacement target');
  const entries = kind === 'namespace'
    ? directoryInventory(quarantinePath, budget)
    : [fileIdentity(quarantinePath, basename(path), budget)];
  const expected = retentionQuarantinePath(path, cleanupInvocationIdentity, candidateIdentity, entries[0]);
  if (resolve(expected) !== resolve(quarantinePath)) throw new Error('Interrupted retention quarantine token is invalid');
  return {
    schemaVersion: 1,
    kind,
    path,
    quarantinePath,
    cleanupInvocationIdentity,
    alreadyQuarantined: true,
    invocationIdentity: kind === 'namespace' ? candidateIdentity : null,
    reason: 'interrupted_quarantine',
    entries,
  };
}

export function resolveEvidenceRetention(planIdentity, options = {}) {
  const project = resolve(planIdentity.project);
  const evidenceRoot = resolve(planIdentity.evidenceRoot);
  const frozen = options.retentionCandidateManifest;
  if (frozen !== undefined) {
    if (!Array.isArray(frozen) || frozen.length > RETENTION_MAX_NAMESPACES + 1) throw new Error('Frozen retention candidate manifest is invalid');
    if (Buffer.byteLength(canonicalEvidenceJson(frozen)) > MAX_RETENTION_MANIFEST_BYTES) {
      throw new Error('Frozen retention candidate manifest exceeds 393216 bytes');
    }
    const validationBudget = { entries: 0, bytes: 0 };
    for (const candidate of frozen) validateCandidateIdentity(
      candidate, evidenceRoot, options.retentionEffectsMayBeFulfilled === true, planIdentity.invocationIdentity,
      join(planIdentity.currentNamespace, 'owner.json'), validationBudget,
    );
    return frozen.map((candidate) => structuredClone(candidate));
  }
  if (!existsSync(evidenceRoot)) return [];
  if (pathContainsSymlink(project, evidenceRoot)) throw new Error('Verification evidence retention root is unsafe');
  const candidates = [];
  const scanBudget = { entries: 0, bytes: 0 };
  const lockPath = join(evidenceRoot, 'verify-owner.lock');
  if (existsSync(lockPath)) {
    const owner = lockOwner(lockPath);
    if (!owner) throw new Error('Verification evidence owner lock is malformed or unsafe');
    if (!ownerIsLive(owner)) {
      candidates.push(candidateForFile(lockPath, 'stale_owner_lock', planIdentity.invocationIdentity));
    }
  }
  let namespaceCount = 0;
  let totalBytes = 0;
  const eligible = [];
  const rootEntries = readdirSync(evidenceRoot, { withFileTypes: true });
  if (rootEntries.length > MAX_RETENTION_ROOT_ENTRIES) throw new Error('Verification evidence retention root entry limit exceeded');
  for (const outputEntry of rootEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (outputEntry.name === 'verify-owner.lock' && outputEntry.isFile()) continue;
    if (outputEntry.isFile() && outputEntry.name.startsWith('.gdeck-retention-')) {
      const recovered = recoveredQuarantineCandidate(join(evidenceRoot, outputEntry.name), evidenceRoot, scanBudget);
      if (!recovered || recovered.kind !== 'stale_lock') throw new Error('Verification evidence retention root contains an invalid quarantine');
      candidates.push(recovered);
      continue;
    }
    if (!outputEntry.isDirectory() || !OUTPUT_TOKEN_PATTERN.test(outputEntry.name) || outputEntry.isSymbolicLink()) {
      throw new Error('Verification evidence retention root contains an unrecognized entry');
    }
    const outputRoot = join(evidenceRoot, outputEntry.name);
    const invocationEntries = readdirSync(outputRoot, { withFileTypes: true });
    if (invocationEntries.length > RETENTION_MAX_NAMESPACES + 1) throw new Error('Verification evidence output namespace limit exceeded');
    for (const invocationEntry of invocationEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (invocationEntry.isDirectory() && invocationEntry.name.startsWith('.gdeck-retention-')) {
        const recovered = recoveredQuarantineCandidate(join(outputRoot, invocationEntry.name), evidenceRoot, scanBudget);
        if (!recovered || recovered.kind !== 'namespace') throw new Error('Verification evidence output namespace contains an invalid quarantine');
        namespaceCount += 1;
        totalBytes += inventoryBytes(recovered.entries);
        candidates.push(recovered);
        continue;
      }
      if (!invocationEntry.isDirectory() || !INVOCATION_IDENTITY_PATTERN.test(invocationEntry.name) || invocationEntry.isSymbolicLink()) {
        throw new Error('Verification evidence output namespace contains an unrecognized entry');
      }
      const namespace = join(outputRoot, invocationEntry.name);
      if (resolve(namespace) === resolve(planIdentity.currentNamespace)) continue;
      namespaceCount += 1;
      const observation = namespaceObservation(
        namespace, invocationEntry.name, planIdentity.outputPath, planIdentity.invocationIdentity, scanBudget,
      );
      if (!observation.entries) throw new Error('Verification evidence namespace cannot be safely inventoried');
      totalBytes += observation.bytes;
      if (observation.eligible) eligible.push(observation.eligible);
    }
  }
  eligible.sort((left, right) => left.path.localeCompare(right.path));
  candidates.push(...eligible);
  const removedNamespaces = candidates.filter((candidate) => candidate.kind === 'namespace').length;
  const removedBytes = candidates.filter((candidate) => candidate.kind === 'namespace')
    .reduce((total, candidate) => total + inventoryBytes(candidate.entries), 0);
  if (Buffer.byteLength(canonicalEvidenceJson(candidates)) > MAX_RETENTION_MANIFEST_BYTES) {
    throw new Error('Verification evidence retention candidates cannot be safely bounded');
  }
  if (namespaceCount - removedNamespaces + 1 > RETENTION_MAX_NAMESPACES
    || totalBytes - removedBytes + RETENTION_INVOCATION_RESERVE_BYTES > RETENTION_MAX_BYTES) {
    throw new Error('Verification evidence retention quota cannot be safely reclaimed');
  }
  return candidates;
}

function withPinnedDirectory(directory, operation) {
  const descriptor = openSync(
    directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor);
    operation();
    fsyncBestEffort(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(directory);
    if (before.dev !== after.dev || before.ino !== after.ino
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.isSymbolicLink()) {
      throw new Error('Retention parent directory identity changed during cleanup');
    }
  } finally {
    closeSync(descriptor);
  }
}

export function applyEvidenceRetention(plan) {
  const candidates = plan?.evidenceBinding?.retentionCandidates;
  const evidenceRoot = dirname(plan.evidenceBinding.lockPath);
  if (!Array.isArray(candidates)) throw new Error('Verification Plan retention manifest is missing');
  const validationBudget = { entries: 0, bytes: 0 };
  for (const candidate of candidates) {
    validateCandidateIdentity(candidate, evidenceRoot, false, plan.invocationIdentity, plan.evidenceBinding.ownerPath, validationBudget);
    withPinnedDirectory(dirname(candidate.path), () => {
      const target = resolve(candidate.path);
      const quarantine = resolve(candidate.quarantinePath);
      if (candidate.alreadyQuarantined) {
        if (!existsSync(quarantine) || existsSync(target)) throw new Error('Interrupted retention quarantine state changed before cleanup');
      } else {
        if (existsSync(quarantine)) throw new Error('Retention quarantine path is unexpectedly occupied');
        renameSync(target, quarantine);
      }
      const expectedRoot = candidate.kind === 'stale_lock'
        ? candidate.entries[0]
        : candidate.entries.find((entry) => entry.path === '.');
      const quarantined = lstatSync(quarantine);
      const quarantineMatches = quarantined.dev === expectedRoot.dev && quarantined.ino === expectedRoot.ino
        && !quarantined.isSymbolicLink()
        && (candidate.kind === 'stale_lock' ? quarantined.isFile() : quarantined.isDirectory());
      if (!quarantineMatches) {
        if (!candidate.alreadyQuarantined && !existsSync(target)) renameSync(quarantine, target);
        throw new Error('Retention target changed during quarantine');
      }
      if (candidate.kind === 'stale_lock') {
        unlinkSync(quarantine);
        if (existsSync(target)) throw new Error('Retention lock replacement appeared during cleanup');
        return;
      }
      const root = quarantine;
      const files = candidate.entries.filter((entry) => entry.type === 'file').sort((left, right) => right.path.length - left.path.length);
      const directories = candidate.entries.filter((entry) => entry.type === 'directory').sort((left, right) => right.path.length - left.path.length);
      for (const entry of files) {
        const path = resolve(root, entry.path);
        if (!pathIsInside(root, path)) throw new Error('Retention file escapes its namespace');
        const metadata = lstatSync(path);
        if (metadata.dev !== entry.dev || metadata.ino !== entry.ino || !metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error('Retention file identity changed before deletion');
        }
        unlinkSync(path);
      }
      for (const entry of directories) {
        const path = entry.path === '.' ? root : resolve(root, entry.path);
        const metadata = lstatSync(path);
        if (metadata.dev !== entry.dev || metadata.ino !== entry.ino || !metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new Error('Retention directory identity changed before deletion');
        }
        rmdirSync(path);
      }
      if (existsSync(target)) throw new Error('Retention namespace replacement appeared during cleanup');
    });
  }
}
