import { writeFileAtomic } from './atomic-files.mjs';
import { boundedProcessTimings } from './diagnostics.mjs';
import { privateLifecycleRegistry } from './lifecycle-resources.mjs';
import { executeProcess } from './process-lifecycle.mjs';
import { DEFAULT_TIMEOUT_SECONDS, PROCESS_CLEANUP_TIMEOUT_MS } from './tool-context.mjs';

let internalStageOutcomeSink = null;
const internalProcessTimings = [];
export function setInternalStageOutcomeSink(value) { internalStageOutcomeSink = value; }

export function timeoutMilliseconds(options = {}) {
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

export async function runProcess(executable, args, options = {}) {
  const requestedTimeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000);
  if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) throw new Error('Process timeout must be a positive finite number');
  const deadlineNs = processDeadlineNs(requestedTimeoutMs);
  const phase = String(options.phase ?? 'process').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'process';
  const result = await executeProcess({
    executable, args, cwd: options.cwd,
    env: options.inheritEnv === false ? { ...(options.env ?? {}) } : { ...process.env, ...(options.env ?? {}) },
    timeoutMs: requestedTimeoutMs, deadlineNs: String(deadlineNs),
    cleanupTimeoutMs: options.cleanupTimeoutMs ?? PROCESS_CLEANUP_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? options.maxBuffer ?? 32 * 1024 * 1024,
    phase, propagateLifecycleRegistry: options.propagateLifecycleRegistry === true,
    lifecycleProjectRoots: options.cwd ? [options.cwd] : [],
    shell: options.shell === true,
  }, { handleSignals: true, onOutput: options.onOutput });
  const output = `${result.stdout}${result.stderr}`;
  if (!options.quiet && output) process.stdout.write(output);
  const outputTruncated = result.stdoutTruncated === true || result.stderrTruncated === true;
  const timings = { ...result.timings, scope: 'direct_child', phaseBreakdownAvailable: true };
  recordInternalProcessTiming(phase, result.status, timings);
  const classification = result.cancelled ? 'cancelled' : ({ 127: 'process_spawn', 124: 'timeout', 125: 'cleanup_timeout' })[result.status];
  if (classification) publishInternalStageOutcome(classification, 'process_result', `${phase}: ${classification}`, { phase, reason: result.reason, timedOut: result.timedOut, cleanupTimedOut: result.cleanupTimedOut, outputTruncated });
  return { ...result, output, outputTruncated, timings, supervisor: result };
}

export function publishInternalStageOutcome(classification, source, summary, actual = undefined) {
  if (!internalStageOutcomeSink) return;
  writeFileAtomic(internalStageOutcomeSink.path, `${JSON.stringify({
    nonce: internalStageOutcomeSink.nonce,
    classification,
    source,
    summary,
    ...(actual ? { actual } : {}),
  })}\n`, { mode: 0o600 });
}

function recordInternalProcessTiming(phase, exitCode, timings) {
  if (!internalStageOutcomeSink || !timings) return;
  if (internalProcessTimings.length < 16) internalProcessTimings.push({ phase, exitCode, timings: boundedProcessTimings(timings) });
  writeFileAtomic(`${internalStageOutcomeSink.path}.timings`, JSON.stringify({
    nonce: internalStageOutcomeSink.nonce, processes: internalProcessTimings,
  }), { mode: 0o600 });
}
