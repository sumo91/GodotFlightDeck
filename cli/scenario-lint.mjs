/**
 * Lightweight static scenario lint for Agent ergonomics.
 * Warnings only — never fails a run by itself.
 */

export function lintScenarioDefinition(definition, options = {}) {
  const warnings = [];
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    return [{ code: 'scenario_shape', message: 'Scenario root must be a JSON object' }];
  }
  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      warnings.push({ code: 'step_shape', stepIndex: index, message: `Step ${index} must be an object` });
      continue;
    }
    if (!step.wait_event || index === 0) continue;
    const previous = steps[index - 1];
    if (!previous || typeof previous !== 'object' || !previous.command) continue;
    const since = step.since ?? step.Since;
    const includeHistory = step.includeHistory === true || step.include_history === true;
    if (!since && !includeHistory) {
      warnings.push({
        code: 'command_wait_window',
        stepIndex: index,
        message: `Step ${index}: wait_event immediately after command without since:"command" or includeHistory; early events may be missed`,
      });
    }
  }
  if (options.traceEvents === true || definition.traceEvents === true) {
    warnings.push({
      code: 'trace_events_enabled',
      message: 'traceEvents is enabled; failure reports will include event-window diagnostics',
    });
  }
  return warnings;
}

export function formatScenarioLintWarnings(warnings) {
  return warnings.map((item) => `Scenario lint: ${item.message}`);
}
