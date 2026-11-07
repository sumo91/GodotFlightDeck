import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, openSync, closeSync, readSync, fstatSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildResultEnvelope, renderResultEnvelopeText } from '../cli/result-envelope.mjs';
import { validationReportSummary, verificationReportMatchesEvidenceBinding, verificationReportReceipt } from '../extensions/runtime.mjs';
import { unitReportDisposition } from '../cli/unit-progress.mjs';
import { diagnosticHints, assertionCompletion, boundedProcessTimings, boundedClockReport,
  readUnitDiagnostics, firstReportDiagnostics, renderDiagnosticText } from '../cli/diagnostics.mjs';

export const TEXT_LIMIT_BYTES = 8192;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const logs = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function boundedText(value, limit = TEXT_LIMIT_BYTES) {
  const bytes = Buffer.from(String(value));
  if (bytes.length <= limit) return String(value);
  const suffix = '\n[Presentation truncated; inspect structuredContent and cited artifacts.]';
  return bytes.subarray(0, limit - Buffer.byteLength(suffix) - 3).toString('utf8') + suffix;
}

function saveLogs(result) {
  const id = randomUUID();
  const directory = mkdtempSync(join(tmpdir(), 'gdeck-mcp-output-'));
  const streams = {};
  for (const name of ['stdout', 'stderr']) {
    const bytes = result[`${name}Buffer`] ?? Buffer.from(result[name] ?? '');
    const path = join(directory, `${name}.log`);
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
    streams[name] = { path, bytes: bytes.length, sha256: hash(bytes) };
  }
  // Bound session bookkeeping; old artifacts remain available at their cited paths.
  if (logs.size >= 128) logs.delete(logs.keys().next().value);
  logs.set(id, streams);
  return { id, streams, complete: !result.stdoutTruncated && !result.stderrTruncated
    && !/Flight Deck: (?:stdout|stderr) output truncated;/.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`),
  retrieval: 'gdeck_log (this session); cited files remain available after disconnect' };
}

export function readLog({ logId, stream = 'stdout', offset = 0, limit = 8192 }) {
  if (!['stdout', 'stderr'].includes(stream) || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 32768) throw new Error('Invalid log stream, byte offset or limit (1..32768)');
  const entry = logs.get(logId)?.[stream];
  if (!entry) throw new Error('Unknown log ID in this server session; use the cited file path for older logs');
  const fd = openSync(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== entry.bytes) throw new Error('Captured log changed after publication');
    if (offset > stat.size) throw new Error('Log byte offset exceeds file size');
    const buffer = Buffer.alloc(Math.min(limit, stat.size - offset));
    const count = readSync(fd, buffer, 0, buffer.length, offset);
    const bytes = buffer.subarray(0, count);
    return { schemaVersion: 1, logId, stream, offset, nextOffset: offset + count, totalBytes: entry.bytes,
      eof: offset + count === entry.bytes, encoding: 'base64', data: bytes.toString('base64'), sha256: entry.sha256 };
  } finally { closeSync(fd); }
}

function readReport(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_REPORT_BYTES) throw new Error('Report size/type invalid');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) throw new Error('Report changed during read');
      offset += read;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Report changed during read');
    return { report: JSON.parse(bytes.toString('utf8')), bytes };
  } finally { closeSync(fd); }
}

function processClassification(result) {
  if (result.cleanupTimedOut || result.status === 125) return 'cleanup_timeout';
  if (result.cancelled) return 'cancelled';
  if (result.timedOut || result.status === 124) return 'timeout';
  if (result.status === 127) return 'process_spawn';
  if (result.status === 126) return 'report_io';
  return result.status === 0 ? 'none' : 'unknown';
}

// The caller supplies an unpredictable, initially absent report path via argv.
// Never discover a report path or decide a Verdict by searching process logs.
export function formatResult(action, project, result, { family = 'validate', reportPath = '', verbosity = 'compact', service } = {}) {
  const capturedLogs = saveLogs(result);
  let classification = processClassification(result);
  let report;
  let envelope;
  let summary;
  let reportState = reportPath ? 'missing' : 'not_requested';
  if (reportPath) {
    try {
      const loaded = readReport(reportPath);
      report = loaded.report;
      reportState = 'accepted';
      if (action === 'verify') {
        if (!verificationReportMatchesEvidenceBinding(report, {
          digest: report.verificationPlanDigest, evidenceBinding: report.evidenceBinding,
        }, reportPath, { reportBytes: loaded.bytes, receipt: verificationReportReceipt(result.stdout) })) {
          throw new Error('Verification report execution binding is invalid');
        }
        // Preserve the CLI's authoritative envelope, including coverage and artifacts.
        envelope = report.resultEnvelope;
      } else if (action === 'unit') {
        if (unitReportDisposition(report).state !== 'terminal'
          || report.unit_binding?.output_path !== reportPath
          || report.unit_binding?.project !== project) throw new Error('Unit report is incomplete or unbound');
      } else if (action === 'scenario') {
        if (!['passed', 'failed'].includes(report.scenario?.status) || !Array.isArray(report.scenario?.assertions)) throw new Error('Scenario report invalid');
      }
      if (['unit', 'scenario'].includes(action)) {
        summary = validationReportSummary(action, report, reportPath);
        envelope = buildResultEnvelope({ report: { coverage: [{ kind: action, target: action, disposition: 'run',
          execution: result.status === 0 && summary.status === 'passed' ? 'passed' : 'failed', reason: 'Explicit MCP action' }], stages: [{ kind: action, target: action, disposition: 'run',
          status: result.status === 0 && summary.status === 'passed' ? 'passed' : 'failed', exitCode: result.status, report, reportPath }] }, reportPath });
      }
    } catch (error) {
      report = undefined;
      envelope = undefined;
      summary = undefined;
      reportState = error.code === 'ENOENT' ? 'missing' : 'invalid';
      if (classification === 'none') classification = reportState === 'missing' ? 'report_missing' : 'report_corrupt';
    }
  }
  if (['cleanup_timeout', 'cancelled', 'timeout', 'process_spawn', 'report_io'].includes(classification)) {
    envelope = buildResultEnvelope({ report: reportState === 'accepted' && action === 'verify' ? report : null, reportPath,
      event: { classification, source: classification === 'cancelled' ? 'cancellation' : 'process_result', summary: `MCP process lifecycle: ${classification}` } });
  } else if (!envelope && reportPath) {
    envelope = buildResultEnvelope({ reportPath, event: { classification: classification === 'none' ? 'unknown' : classification,
      source: 'process_result', summary: `No accepted ${action} report; exit ${result.status}; report ${reportState}` } });
  } else if (envelope?.verdict === 'PASSED' && result.status !== 0) {
    envelope = buildResultEnvelope({ reportPath, event: { classification: 'unknown', source: 'process_result', summary: 'Process exited nonzero after passing structured assertions' } });
  }
  const isError = result.status !== 0 || (envelope && envelope.verdict !== 'PASSED');
  const diagnostics = { ...diagnosticHints(result), assertions: assertionCompletion(action, report) };
  const engine = action === 'unit' ? readUnitDiagnostics(reportPath) : firstReportDiagnostics(report);
  if (engine) diagnostics.engine = engine;
  const stages = Array.isArray(report?.stages) ? report.stages : [];
  const orderedStages = [...stages.filter(stage => stage.status === 'failed'), ...stages.filter(stage => stage.status !== 'failed')];
  const clocks = boundedClockReport(report?.clocks);
  const structuredContent = {
    schemaVersion: 1, action: { family, name: action, project, status: isError ? (result.cancelled ? 'cancelled' : 'unsuccessful') : 'completed' },
    process: { exitCode: result.status, timedOut: Boolean(result.timedOut), cancelled: Boolean(result.cancelled),
      cleanupTimedOut: Boolean(result.cleanupTimedOut), classification, evidenceAuthority: 'operational_only',
      timings: boundedProcessTimings(result.timings) },
    diagnostics,
    ...(clocks ? { clocks } : {}),
    ...(action === 'verify' && report ? { verification: {
      plan: report.verificationPlan, timings: report.timings,
      preflight: report.preflightFailure ? { phase: report.preflightFailure.phase, classification: report.preflightFailure.classification,
        process: report.preflightFailure.processEvidence, diagnostics: report.preflightFailure.diagnostics, planDrift: report.preflightFailure.planDrift } : undefined,
      stages: orderedStages.slice(0, 6).map(stage => ({ kind: stage.kind, target: stage.target,
        exitCode: stage.exitCode, status: stage.status, process: stage.processEvidence,
        diagnostics: stage.diagnostics, planDrift: stage.planDrift, clocks: boundedClockReport(stage.report?.clocks) })),
      omittedStages: Math.max(0, stages.length - 6),
    } } : {}),
    ...(envelope ? { resultEnvelope: envelope } : {}),
    ...(summary ? { summary } : {}), report: { path: reportPath || null, state: reportState }, logs: capturedLogs,
    ...(service ? { service } : {}), presentation: { verbosity, textLimitBytes: TEXT_LIMIT_BYTES, rawOutputWithheld: true },
  };
  // Small JSON-producing read/write actions retain their usable payload. Large
  // trees/queries remain in the exact captured stream instead of bloating MCP.
  if (!reportPath && Buffer.byteLength(result.stdout ?? '') <= 4096) {
    try { structuredContent.data = JSON.parse(result.stdout.trim()); } catch { /* not a JSON action */ }
  }
  const text = [renderDiagnosticText(engine) || renderDiagnosticText(diagnostics),
    envelope ? (action === 'verify' ? renderResultEnvelopeText(envelope)
    : `gdeck ${action}\nVerdict: ${envelope.verdict}\nClassification: ${envelope.failureClassification.code}`)
    : `gdeck ${action}: ${structuredContent.action.status}; exit ${result.status}`,
    summary ? JSON.stringify(summary) : '',
    diagnostics.resources.length ? `Resource hints: ${diagnostics.resources.map(item => item.type).join(', ')} (diagnostic only)` : '',
    clocks ? `Clock: ${clocks.mode}; simulation=${clocks.simulation_seconds}s; probe wall=${clocks.wall_seconds}s. Project sampling windows and game speed remain project-defined.` : '',
    report?.verificationPlan ? `Plan: ${report.verificationPlan.planDigest}; inputs: ${report.verificationPlan.inputsDigest}; full timings/scope: cited verification report.` : '',
    `Raw output withheld. Log ID: ${capturedLogs.id}; stdout: ${capturedLogs.streams.stdout.path}; stderr: ${capturedLogs.streams.stderr.path}`,
    !capturedLogs.complete ? 'Upstream capture was truncated; these files contain all retained bytes, not all emitted bytes.' : '',
    verbosity === 'diagnostic' ? `Process: ${JSON.stringify(structuredContent.process)}` : '',
  ].filter(Boolean).join('\n');
  return { content: [{ type: 'text', text: boundedText(text) }], structuredContent, isError: Boolean(isError) };
}
