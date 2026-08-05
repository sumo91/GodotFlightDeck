import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';

export const EVIDENCE_BINDING_SCHEMA_VERSION = 1;
export const EVIDENCE_RESOLVER_CONTRACT = 'gdeck-verification-plan/1';
export const INVOCATION_IDENTITY_PATTERN = /^[a-f0-9]{64}$/;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalEvidenceJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function generateInvocationIdentity() {
  return randomBytes(32).toString('hex');
}

export function processBirthIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    let fact = '';
    if (platform() === 'linux') {
      const descriptor = openSync(`/proc/${pid}/stat`, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const metadata = fstatSync(descriptor);
        if (!metadata.isFile() || metadata.size > 8 * 1024) return null;
        const stat = readFileSync(descriptor, 'utf8');
        const closeParen = stat.lastIndexOf(')');
        const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
        if (closeParen < 1 || !/^\d+$/.test(fields[19] ?? '')) return null;
        fact = fields[19];
      } finally { closeSync(descriptor); }
    } else if (platform() === 'darwin' || platform().endsWith('bsd')) {
      const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8', timeout: 500, maxBuffer: 8 * 1024,
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      });
      fact = result.status === 0 && !result.signal && !result.error ? String(result.stdout).trim() : '';
      if (!/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-3]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(fact)) return null;
    } else return null;
    return createHash('sha256').update(`${platform()}\0${pid}\0${fact}`).digest('hex');
  } catch { return null; }
}

export function requireInvocationIdentity(value) {
  if (typeof value !== 'string' || !INVOCATION_IDENTITY_PATTERN.test(value)) {
    throw new Error('Verification invocation identity must be exactly 64 lowercase hexadecimal characters');
  }
  return value;
}

export function verificationEvidencePaths(projectCandidate, outputCandidate, invocationCandidate) {
  const project = resolve(projectCandidate);
  const outputPath = resolve(outputCandidate);
  const invocationIdentity = requireInvocationIdentity(invocationCandidate);
  const outputToken = createHash('sha256').update(outputPath).digest('hex').slice(0, 24);
  const root = join(project, '.gdeck', 'reports', 'private', 'evidence');
  const namespace = join(root, outputToken, invocationIdentity);
  return Object.freeze({
    root,
    lockPath: join(root, 'verify-owner.lock'),
    namespace,
    ownerPath: join(namespace, 'owner.json'),
    journalPath: join(namespace, 'journal'),
    stageReportRoot: join(namespace, 'stage-reports'),
    diagnosticLogPath: join(namespace, 'preflight.log'),
  });
}
