import { createUnitExecutionBinding } from './unit-progress.mjs';
import { createHash } from 'node:crypto';

export function unitRuntimeArguments(options) {
  return ['--tests=res://tests', ...(options.filter ? [`--filter=${options.filter}`] : [])];
}

export function verificationUnitOwnerNonce(plan, stage) {
  return createHash('sha256').update(`${plan.invocationIdentity}\0${stage.id}\0unit-owner`).digest('hex');
}

export function unitBindingForExecution({ project, report, timeoutMs, options, invocationIdentity, ownerNonce }) {
  return createUnitExecutionBinding({
    invocationIdentity,
    ownerNonce,
    project,
    outputPath: report,
    timeoutMs,
    runtimeArguments: unitRuntimeArguments(options),
  });
}
