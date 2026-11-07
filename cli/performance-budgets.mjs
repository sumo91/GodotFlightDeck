const definitions = [
  ['averageFpsGte', 'average_fps', 'average_fps', '>=', 1],
  ['worstFrameMsLte', 'worst_frame_ms', 'worst_frame_ms', '<=', 1],
  ['averageFrameMsLte', 'average_frame_ms', 'average_frame_ms', '<=', 1],
  ['worstProcessMsLte', 'worst_process_ms', 'worst_process_ms', '<=', 1],
  ['averageProcessMsLte', 'average_process_ms', 'average_process_ms', '<=', 1],
  ['averagePhysicsMsLte', 'average_physics_ms', 'average_physics_ms', '<=', 1],
  ['nodesLte', 'nodes', 'nodes', '<=', 1],
  ['objectsLte', 'objects', 'objects', '<=', 1],
  ['active2dObjectsLte', 'active_2d_objects', 'active_2d_objects', '<=', 1],
  ['staticMemoryMbLte', 'static_memory_bytes', 'static_memory_mb', '<=', 1024 * 1024],
  ['drawCallsLte', 'draw_calls', 'draw_calls', '<=', 1],
];
const BUDGET_KEYS = new Set(definitions.map(([name]) => name));

export function validateBudgets(value, label, strict = true) {
  const budgets = value ?? {};
  if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)) throw new Error(`${label} must be an object`);
  const result = {};
  for (const [key, limit] of Object.entries(budgets)) {
    if (!BUDGET_KEYS.has(key)) {
      if (strict) throw new Error(`${label} contains unknown budget: ${key}`);
      continue;
    }
    if (typeof limit !== 'number' || !Number.isFinite(limit)) throw new Error(`${label}.${key} must be a finite number`);
    result[key] = limit;
  }
  return result;
}

export function performanceBudgetResults(performance, budgets = {}) {
  const results = [];
  for (const [budgetName, sourceMetric, displayMetric, operator, divisor] of definitions) {
    if (budgets[budgetName] === undefined) continue;
    const actual = Number(performance?.[sourceMetric] ?? Number.NaN) / divisor;
    const limit = Number(budgets[budgetName]);
    const passed = Number.isFinite(actual) && (operator === '>=' ? actual >= limit : actual <= limit);
    results.push({ budget: budgetName, metric: displayMetric, operator, actual, limit, passed });
  }
  return results;
}
