import { openSync, closeSync, fstatSync, readSync, writeFileSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';

// These hints locate evidence. They never qualify a Verdict or copy log payloads.
const RESOURCE_TYPES = ['AudioStreamWAV', 'AudioStreamPlaybackWAV', 'AudioStreamOggVorbis',
  'AudioStreamPlaybackOggVorbis', 'AudioStreamMP3', 'AudioStreamPlaybackMP3', 'Node', 'Resource'];
const ISSUES = [
  ['script_error', /\bSCRIPT ERROR:/, 'Godot reported a script error.'],
  ['resource_leak', /Leaked instance:|resources still in use|ObjectDB instances leaked/, 'Godot reported resources or instances remaining at exit.'],
  ['engine_error', /(?:^|\s)ERROR:/, 'Godot reported an error; inspect the cited captured line.'],
];
const SCRIPT_ERRORS = { parse: 'Godot reported a GDScript parse error.', compile: 'Godot reported a GDScript compile error.' };

function sourceLocation(path, line) {
  if (typeof path !== 'string' || path.length > 512 || !/^res:\/\/[\p{L}\p{N}_ .\/-]+\.(gd|tscn|tres)$/u.test(path)
    || path.slice(6).split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))
    || !Number.isSafeInteger(line) || line < 1) return undefined;
  return { path, line };
}

function safeIssue(issue) {
  const definition = ISSUES.find(([category]) => category === issue?.category);
  if (!definition || !['stdout', 'stderr'].includes(issue.stream) || !Number.isSafeInteger(issue.line) || issue.line < 1) return null;
  const errorKind = issue.category === 'script_error' && Object.hasOwn(SCRIPT_ERRORS, issue.errorKind) ? issue.errorKind : undefined;
  const source = sourceLocation(issue.source?.path, issue.source?.line);
  return { category: definition[0], summary: errorKind ? SCRIPT_ERRORS[errorKind] : definition[2], stream: issue.stream, line: issue.line,
    ...(errorKind ? { errorKind } : {}), ...(source ? { source } : {}) };
}

export function diagnosticHints(streams) {
  let firstIssue = null;
  let sourceWindowClosed = false;
  const resources = new Map();
  // Stream order is explicit, not a claim of cross-stream chronology.
  for (const stream of ['stderr', 'stdout']) {
    const text = String(streams[stream] ?? '');
    let start = 0;
    let line = 1;
    while (start < text.length) {
      const end = text.indexOf('\n', start);
      const value = text.slice(start, end < 0 ? text.length : end).replace(/\u001b\[[0-9;]*m/g, '');
      const issue = ISSUES.find(([, pattern]) => pattern.test(value));
      if (issue && !firstIssue) {
        const errorKind = /SCRIPT ERROR: Parse Error:/.test(value) ? 'parse' : /SCRIPT ERROR: Compile Error:/.test(value) ? 'compile' : undefined;
        firstIssue = { category: issue[0], summary: SCRIPT_ERRORS[errorKind] ?? issue[2], stream, line,
          ...(errorKind ? { errorKind } : {}) };
      }
      // Only attach the adjacent engine location to this error, never a later error's stack.
      if (firstIssue?.stream === stream && line > firstIssue.line && issue) sourceWindowClosed = true;
      if (!sourceWindowClosed && firstIssue?.stream === stream && !firstIssue.source && line > firstIssue.line && line <= firstIssue.line + 3) {
        const location = /^\s*(?:at:|GDScript backtrace \(most recent call first\):|\[\d+\])/.test(value)
          ? value.match(/\((res:\/\/[^\r\n()]+):(\d+)\)\s*$/) : null;
        if (location) {
          const source = sourceLocation(location[1], Number(location[2]));
          if (source) firstIssue.source = source;
        }
      }
      if (/Leaked instance:|resources still in use|ObjectDB instances leaked/.test(value)) {
        for (const type of RESOURCE_TYPES) {
          if (new RegExp(`\\b${type}\\b`).test(value) && !resources.has(type)) resources.set(type, { type, stream, line });
        }
      }
      if (end < 0) break;
      start = end + 1;
      line += 1;
    }
  }
  return { evidenceAuthority: 'diagnostic_only', firstIssue, resources: [...resources.values()],
    order: 'stderr_then_stdout', lineScope: 'captured_stream', rawTextWithheld: true };
}

// A quiet Unit child otherwise loses its engine output at the wrapper boundary.
// Keep it beside the invocation-owned report, independently of terminal evidence.
export function writeUnitDiagnostics(reportPath, result) {
  const diagnostics = { ...diagnosticHints(result), reportPath, schemaVersion: 1,
    logs: { streams: {}, complete: !result.outputTruncated, encoding: 'utf8_decoded' } };
  for (const stream of ['stdout', 'stderr']) {
    const path = `${reportPath}.engine-${stream}.log`;
    const bytes = Buffer.from(result[stream] ?? '');
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    diagnostics.logs.streams[stream] = { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  writeFileSync(`${reportPath}.diagnostics.json`, JSON.stringify(diagnostics), { flag: 'wx', mode: 0o600 });
  return diagnostics;
}

export function readUnitDiagnostics(reportPath) {
  if (!reportPath) return null;
  let descriptor;
  try {
    descriptor = openSync(`${reportPath}.diagnostics.json`, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 8192) return null;
    const bytes = Buffer.alloc(stat.size);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    const after = fstatSync(descriptor);
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return null;
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.schemaVersion !== 1 || value.reportPath !== reportPath) return null;
    const streams = {};
    for (const stream of ['stdout', 'stderr']) {
      const entry = value.logs?.streams?.[stream];
      if (entry?.path !== `${reportPath}.engine-${stream}.log` || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || !/^[a-f0-9]{64}$/.test(entry.sha256)) return null;
      streams[stream] = { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 };
    }
    return { evidenceAuthority: 'diagnostic_only', firstIssue: safeIssue(value.firstIssue),
      logs: { streams, complete: value.logs.complete === true, encoding: 'utf8_decoded' } };
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function firstReportDiagnostics(report) {
  const candidates = [report?.preflightFailure?.diagnostics,
    ...(Array.isArray(report?.stages) ? report.stages.filter(stage => stage.status === 'failed').map(stage => stage.diagnostics?.engine ?? stage.diagnostics) : [])];
  return candidates.find(item => safeIssue(item?.firstIssue)) ?? null;
}

export function renderDiagnosticText(diagnostics) {
  const issue = safeIssue(diagnostics?.firstIssue);
  if (!issue) return '';
  return `Diagnostic only: ${issue.summary}${issue.source ? ` ${issue.source.path}:${issue.source.line}` : ''} (${issue.stream}:${issue.line})`;
}

export function assertionCompletion(kind, report) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (!report || typeof report !== 'object') return { state: 'unavailable' };
  if (kind === 'unit') {
    const terminal = report.schema_version === 1 || (report.schema_version === 2 && report.complete === true);
    return { state: terminal ? 'terminal' : 'incomplete',
      ...(terminal ? { passed: report.summary?.failed === 0, assertions: count(report.summary?.assertions) } : {}) };
  }
  if (kind === 'scenario' && ['passed', 'failed'].includes(report.scenario?.status)) {
    const scenario = report.scenario;
    return { state: 'terminal', passed: scenario.status === 'passed',
      stepsCompleted: count(scenario.steps_completed), stepsTotal: count(scenario.steps_total),
      allStepsCompleted: Number.isInteger(scenario.steps_total) && scenario.steps_completed === scenario.steps_total,
      assertionsEvaluated: count(scenario.assertions_evaluated) ?? (Array.isArray(scenario.assertions) ? scenario.assertions.length : 0) };
  }
  return { state: 'unavailable' };
}

export function boundedProcessTimings(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (value.scope === 'direct_child' && value.phaseBreakdownAvailable !== true) return { clock: 'monotonic', scope: 'direct_child', phaseBreakdownAvailable: false,
    ...(Number.isFinite(value.totalMs) && value.totalMs >= 0 ? { totalMs: value.totalMs } : {}) };
  return { clock: 'monotonic', scope: value.scope === 'direct_child' ? 'direct_child' : 'supervised_child',
    ...(value.scope === 'direct_child' ? { phaseBreakdownAvailable: true } : {}),
    ...Object.fromEntries(['launchMs', 'executionMs', 'cleanupMs', 'totalMs']
      .filter(key => Number.isFinite(value[key]) && value[key] >= 0).map(key => [key, value[key]])) };
}

export function boundedClockReport(value) {
  if (!value || !['fixed_step_throughput', 'real_time', 'unknown'].includes(value.mode)) return undefined;
  const numbers = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] === null
    || (Number.isFinite(object?.[key]) && object[key] >= 0)).map(key => [key, object[key]]));
  return { mode: value.mode, clock: 'monotonic', scope: 'probe_process_ticks',
    modeSource: value.mode === 'unknown' ? 'unspecified' : 'gdeck_launch_metadata',
    ...numbers(value, ['fixed_fps', 'fixed_step_seconds', 'simulation_seconds', 'wall_seconds',
      'warmup_wall_seconds', 'sampling_wall_seconds', 'simulation_to_wall_ratio']),
    simulationSource: 'sum_process_delta', projectGameSpeed: 'project_defined_not_inferred',
    fixture_control: { measurement: 'synchronous_callbacks_only', async_continuations_measured: false,
      ...numbers(value.fixture_control, ['setup_seconds', 'command_dispatch_seconds']) },
    probe_work: { ...numbers(value.probe_work, ['performance_sampling_seconds', 'scenario_tick_seconds']),
      scenario_tick_includes_command_dispatch: true, total_overhead_measured: false } };
}
