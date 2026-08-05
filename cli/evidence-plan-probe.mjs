#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolveVerificationPlan } from './verification-plan.mjs';

const MAX_SPEC_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;

try {
  if (process.argv.length !== 3 || process.argv[2] !== '--spec-stdin') throw new Error('expected --spec-stdin');
  const bytes = readFileSync(0);
  if (bytes.length <= 0 || bytes.length > MAX_SPEC_BYTES) throw new Error('probe spec is empty or oversized');
  const spec = JSON.parse(bytes.toString('utf8'));
  const allowed = new Set(['project', 'binding', 'maxFiles', 'maxBytes']);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)
    || Object.keys(spec).some((key) => !allowed.has(key))) throw new Error('probe spec is invalid');
  const binding = spec.binding;
  if (!binding || binding.schemaVersion !== 1 || !Number.isInteger(spec.maxFiles) || spec.maxFiles < 1
    || !Number.isInteger(spec.maxBytes) || spec.maxBytes < 1) throw new Error('probe binding or limits are invalid');
  const observation = {};
  const plan = resolveVerificationPlan({
    project: spec.project,
    outputPath: binding.outputPath,
    timeoutSeconds: binding.timeoutMs / 1000,
    verificationProfile: binding.strategy?.mode === 'profile' ? binding.strategy.profile : undefined,
    invocationIdentity: binding.invocationIdentity,
    retentionCandidateManifest: binding.retentionCandidates,
    retentionEffectsMayBeFulfilled: true,
    observationLimits: { maxFiles: spec.maxFiles, maxBytes: spec.maxBytes },
    observationSink: observation,
  });
  const result = `${JSON.stringify({
    digest: plan.digest, inputsDigest: plan.evidenceBinding.inputsDigest,
    filesObserved: observation.files, bytesObserved: observation.bytes,
  })}\n`;
  if (Buffer.byteLength(result) > MAX_RESULT_BYTES) throw new Error('probe result is oversized');
  process.stdout.write(result);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Flight Deck evidence Plan probe: ${message}\n`);
  process.exitCode = /observation (?:file|byte) limit exceeded/i.test(message) ? 2 : 1;
}
