import { fsyncBestEffort, writeFileAtomicNoReplace } from './atomic-files.mjs';
import { capturePairSummary } from './capture-ab.mjs';
import { boundedClockReport, diagnosticHints, firstReportDiagnostics, renderDiagnosticText } from './diagnostics.mjs';
import { appendVerificationJournalRecord } from './evidence-journal.mjs';
import { ResultClassificationError, buildResultEnvelope, renderResultEnvelopeMarkdown } from './result-envelope.mjs';
import { pathContainsSymlink, pathIsInside } from './safety.mjs';
import { TOOL_VERSION } from './tool-context.mjs';
import { verificationPlanSummary } from './verification-plan.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

export function printVerificationFailureDigest(report, output, markdown, options = {}) {
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

export function boundedStageReport(kind, report) {
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
      capture_ab: capturePairSummary(report.capture_ab),
      performance,
      performance_timing: performanceTiming,
      clocks: boundedClockReport(report.clocks),
      benchmark_window: benchmarkWindow,
      scenario: scenario && typeof scenario === 'object' ? {
        name: boundedProjectIdentifier(scenario.name, 'scenario', 200),
        status: boundedReportEnum(scenario.status, ['passed', 'failed', 'skipped', 'blocked'], 'unknown'),
        steps_completed: boundedReportNumber(scenario.steps_completed),
        steps_total: boundedReportNumber(scenario.steps_total),
        failure_kind: boundedReportEnum(scenario.failure_kind, ['expectation', 'precondition', 'error', 'none'], 'unknown'),
        failure_details: details && typeof details === 'object' ? {
          kind: boundedReportEnum(details.kind, ['expectation', 'precondition', 'timeout', 'error', 'capture_ab_inconclusive'], 'unknown'),
          ...(details.kind === 'capture_ab_inconclusive' ? { reason: boundedReportEnum(details.reason, ['invalid_definition', 'isolated_rendered_profile_required', 'invalid_viewport', 'node_missing', 'capture_failed', 'state_changed', 'change_rejected', 'restore_image_changed', 'restore_failed', 'write_failed', 'pair_limit', 'publication_failed'], 'unknown') } : {}),
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
        assertions_evaluated: assertions.length,
      } : null,
    };
  }
  if (kind === 'benchmark') return { ...common, performance, performance_timing: performanceTiming, benchmark_window: benchmarkWindow, clocks: boundedClockReport(report.clocks) };
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

export function boundedOutputTail(output, maximumLines = 24, maximumLineCharacters = 1000) {
  return String(output ?? '').trim().split('\n').slice(-maximumLines)
    .map((line) => boundedReportText(line, maximumLineCharacters) ?? '').join('\n');
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

export function preflightReportForVerificationPlan(plan) {
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

export function reportIoFailure(summary, error = undefined) {
  if (error?.resultClassification === 'report_io') return error;
  const suffix = typeof error?.code === 'string' ? ` (${error.code})` : '';
  return new ResultClassificationError('report_io', `${summary}${suffix}`);
}

export function removeVerificationPublicationFile(plan, path, label, expectedIdentity = undefined) {
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

export function invalidateVerificationPublicationArtifacts(plan) {
  removeVerificationPublicationFile(plan, plan.outputPath, 'verification JSON report');
  removeVerificationPublicationFile(plan, plan.markdownPath, 'verification Markdown report');
  removeVerificationPublicationFile(plan, plan.diagnosticLogPath, 'verification preflight log');
}

export function openVerificationPublicationDirectory(project, directory, label, mode = undefined) {
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

export function assertVerificationPublicationDirectory(identity) {
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

export function closeVerificationPublicationDirectory(identity) {
  if (!identity) return;
  try { closeSync(identity.descriptor); } catch { /* publication result already determined */ }
}

export function openVerificationPublicationDirectories(plan) {
  const report = openVerificationPublicationDirectory(plan.project, dirname(plan.outputPath), 'verification report directory');
  try {
    const diagnostic = openVerificationPublicationDirectory(plan.project, dirname(plan.diagnosticLogPath), 'verification diagnostic directory', 0o700);
    return { report, diagnostic };
  } catch (error) {
    closeVerificationPublicationDirectory(report);
    throw error;
  }
}

export function closeVerificationPublicationDirectories(directories) {
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

export function publishVerificationPreflightFailure(
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
    verificationPlan: verificationPlanSummary(plan),
    timings: error.resultTimings ?? null,
    evidenceBinding: plan.evidenceBinding,
    coverage: preflightReportForVerificationPlan(plan).coverage,
    preflightFailure: {
      phase: error.resultPhase ?? 'verification_preflight',
      classification,
      source,
      summary: error.message,
      ...(error.resultProcessEvidence ? { processEvidence: error.resultProcessEvidence } : {}),
      diagnostics: { ...diagnosticHints({ stdout: diagnosticOutput }), assertions: { state: 'not_started' },
        logPath: diagnosticOutput ? plan.diagnosticLogPath : null },
      ...(error.planDrift ? { planDrift: error.planDrift } : {}),
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
  const hint = renderDiagnosticText(firstReportDiagnostics(report));
  if (hint) console.error(hint);
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

export function publishVerificationReport(plan, report, publicationDirectories, verificationJournal, journalElapsedMs, journalFailure) {
  const { project, outputPath: output, markdownPath: markdown } = plan;
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
  return { journalFailure, verdict: report.resultEnvelope.verdict };
}
