#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveVerificationPlan,
  verificationPlanConfirmation,
} from './verification-plan.mjs';

const MAX_SPEC_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

function fail(message) {
  process.stderr.write(`Flight Deck verification Plan helper: ${message}\n`);
  process.exitCode = 1;
}

function projectedPlan(plan) {
  return {
    verificationProfile: plan.verificationProfile,
    stages: plan.stages,
    digest: plan.digest,
    authorizationDigest: plan.authorizationDigest,
    timeoutMs: plan.timeoutMs,
    preparation: plan.preparation,
    evidenceBinding: plan.evidenceBinding,
    inputs: (Array.isArray(plan.inputs) ? plan.inputs : []).filter((input) => input?.kind === 'project-tree'),
    invocationIdentity: plan.invocationIdentity,
  };
}

try {
  if (process.argv.length !== 4 || process.argv[2] !== '--spec-file') throw new Error('expected exactly --spec-file <path>');
  const specPath = resolve(process.argv[3]);
  const metadata = lstatSync(specPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_SPEC_BYTES) {
    throw new Error('spec must be a bounded regular file and not a symbolic link');
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('spec must be an object');
  const allowed = new Set([
    'project', 'outputPath', 'timeoutSeconds', 'verificationProfile', 'invocationIdentity',
    'retentionCandidateManifest', 'retentionEffectsMayBeFulfilled',
  ]);
  const unknown = Object.keys(spec).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`spec contains unknown field(s): ${unknown.join(', ')}`);
  const plan = resolveVerificationPlan(spec);
  const result = JSON.stringify({
    plan: projectedPlan(plan),
    confirmation: verificationPlanConfirmation(plan),
  });
  if (Buffer.byteLength(result) > MAX_RESULT_BYTES) throw new Error(`result exceeds ${MAX_RESULT_BYTES} bytes`);
  process.stdout.write(`${result}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
