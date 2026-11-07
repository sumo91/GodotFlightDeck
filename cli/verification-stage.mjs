import { writeFileAtomicNoReplace } from './atomic-files.mjs';
import { boundedProcessTimings, diagnosticHints, readUnitDiagnostics } from './diagnostics.mjs';
import { DOCTOR_CAPABILITY_IDS, DOCTOR_CAPABILITY_NAMES } from './doctor-capabilities.mjs';
import { runProcess } from './execution.mjs';
import { ResultClassificationError } from './result-envelope.mjs';
import { pathContainsSymlink, pathIsInside } from './safety.mjs';
import { CLI_FILE, PROCESS_CLEANUP_TIMEOUT_MS } from './tool-context.mjs';
import { verificationStagePreparationBudgetMilliseconds } from './verification-plan.mjs';
import { assertVerificationPublicationDirectory, closeVerificationPublicationDirectory, openVerificationPublicationDirectory } from './verification-report.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export function verificationExecutionProject(internalStage) {
  return internalStage?.executionProject ?? internalStage?.plan.project;
}

export function verificationExecutionPath(internalStage, plannedPath) {
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

export async function executeVerificationCommand(planned, plan, executionProject) {
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
  let childProcesses = [];
  try {
    result = await runProcess(process.execPath, [CLI_FILE, ...argumentsList], {
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
      const allowedClassifications = new Set(['process_spawn', 'configuration', 'precondition', 'fixture_isolation', 'plan_drift', 'report_io', 'timeout', 'cleanup_timeout', 'cancelled']);
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
    const timingsPath = `${outcomePath}.timings`;
    if (existsSync(timingsPath)) {
      const metadata = lstatSync(timingsPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16384) throw new Error('Internal process timings are malformed');
      const candidate = JSON.parse(readFileSync(timingsPath, 'utf8'));
      if (candidate.nonce !== outcomeNonce || !Array.isArray(candidate.processes) || candidate.processes.length > 16) throw new Error('Internal process timings are unbound');
      childProcesses = candidate.processes.map(item => ({ phase: /^[a-zA-Z0-9_-]{1,80}$/.test(item.phase) ? item.phase : 'process',
        exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null, timings: boundedProcessTimings(item.timings) }));
    }
  } finally {
    rmSync(outcomePath, { force: true });
    rmSync(`${outcomePath}.timings`, { force: true });
  }
  const diagnostics = diagnosticHints(result);
  const engine = planned.kind === 'unit' ? readUnitDiagnostics(planned.reportPath) : null;
  // Retain failures and error/leak hints without putting raw payloads into reports.
  const logStreams = {};
  if (result.status !== 0 || diagnostics.firstIssue) {
    const directory = openVerificationPublicationDirectory(plan.project, plan.evidenceBinding.stageReportRoot, 'stage diagnostic directory', 0o700);
    try {
      for (const stream of ['stdout', 'stderr']) {
        const path = planned.diagnosticLogPaths[stream];
        const bytes = Buffer.from(result[stream] ?? '');
        assertVerificationPublicationDirectory(directory);
        if (pathContainsSymlink(plan.project, path)) throw new ResultClassificationError('report_io', 'Stage diagnostic path is unsafe');
        writeFileAtomicNoReplace(path, bytes, { mode: 0o600 });
        assertVerificationPublicationDirectory(directory);
        logStreams[stream] = { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
    } finally { closeVerificationPublicationDirectory(directory); }
  }
  return {
    exitCode: result.status,
    diagnostics: { ...diagnostics, ...(engine ? { engine } : {}), logs: { streams: logStreams, complete: !result.outputTruncated, encoding: 'utf8_decoded', retained: Object.keys(logStreams).length > 0 } },
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
      stdoutBytes: Number(result.supervisor?.stdoutBytes ?? Buffer.byteLength(result.stdout ?? '')),
      stderrBytes: Number(result.supervisor?.stderrBytes ?? Buffer.byteLength(result.stderr ?? '')),
      timings: boundedProcessTimings(result.timings),
      childProcesses,
    },
  };
}

