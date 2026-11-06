// These hints locate evidence. They never qualify a Verdict or copy log payloads.
const RESOURCE_TYPES = ['AudioStreamWAV', 'AudioStreamPlaybackWAV', 'AudioStreamOggVorbis',
  'AudioStreamPlaybackOggVorbis', 'AudioStreamMP3', 'AudioStreamPlaybackMP3', 'Node', 'Resource'];
const ISSUES = [
  ['script_error', /\bSCRIPT ERROR:/, 'Godot reported a script error.'],
  ['resource_leak', /Leaked instance:|resources still in use|ObjectDB instances leaked/, 'Godot reported resources or instances remaining at exit.'],
  ['engine_error', /(?:^|\s)ERROR:/, 'Godot reported an error; inspect the cited captured line.'],
];

export function diagnosticHints(streams) {
  let firstIssue = null;
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
      if (issue && !firstIssue) firstIssue = { category: issue[0], summary: issue[2], stream, line };
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
  if (value.scope === 'direct_child') return { clock: 'monotonic', scope: 'direct_child', phaseBreakdownAvailable: false,
    ...(Number.isFinite(value.totalMs) && value.totalMs >= 0 ? { totalMs: value.totalMs } : {}) };
  return { clock: 'monotonic', scope: 'supervised_child',
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
