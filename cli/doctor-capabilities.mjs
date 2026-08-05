export const DOCTOR_CAPABILITY_IDS = [
  'godot_process',
  'project_metadata',
  'runtime_probe_integration',
  'project_import',
  'unit_execution',
  'scenario_execution',
  'visual_comparison',
  'benchmark_execution',
  'editor_bridge_read',
  'editor_bridge_write',
  'desktop_export',
  'native_smoke',
];

export const DOCTOR_CAPABILITY_NAMES = {
  godot_process: 'Godot process',
  project_metadata: 'Project metadata',
  runtime_probe_integration: 'Runtime probe integration',
  project_import: 'Project import',
  unit_execution: 'Unit execution',
  scenario_execution: 'Scenario execution',
  visual_comparison: 'Visual comparison',
  benchmark_execution: 'Benchmark execution',
  editor_bridge_read: 'Editor Bridge read',
  editor_bridge_write: 'Editor Bridge write',
  desktop_export: 'Desktop export',
  native_smoke: 'Native smoke',
};

export const DOCTOR_CHECK_IDS = [
  'godot-executable',
  'godot-version',
  'flight-deck-config',
  'project-file',
  'runtime-probe',
  'runtime-autoload',
  'editor-bridge-addon',
  'editor-plugin-enabled',
  'editor-auth-token',
  'editor-write-policy',
  'editor-bridge-session',
  'editor-bridge-availability',
  'export-templates',
  'git-repository',
  'project-root',
  'cursor-compat-mode',
  'addon-version-match',
];

const CHECK_CONDITIONS = {
  'godot-executable': 'godot_executable',
  'godot-version': 'godot_version',
  'flight-deck-config': 'flight_deck_config',
  'project-file': 'project_file',
  'runtime-probe': 'runtime_probe',
  'runtime-autoload': 'runtime_autoload',
  'editor-bridge-addon': 'editor_bridge_addon',
  'editor-plugin-enabled': 'editor_plugin_enabled',
  'editor-auth-token': 'editor_auth_token',
  'editor-write-policy': 'editor_writes_disabled',
  'editor-bridge-availability': 'editor_bridge_availability',
  'export-templates': 'export_templates',
  'git-repository': 'git_repository',
  'project-root': 'project_root',
};

function checkIndex(checks) {
  if (!Array.isArray(checks)) throw new Error('Doctor capability assessment requires checks');
  const index = new Map();
  for (const check of checks) {
    if (!check || typeof check.id !== 'string' || !['ok', 'warn', 'error'].includes(check.status)) {
      throw new Error('Doctor capability assessment received an invalid check');
    }
    if (index.has(check.id)) throw new Error(`Doctor capability assessment received duplicate check: ${check.id}`);
    index.set(check.id, check);
  }
  return index;
}

function presentCheckIds(index, ids) {
  return ids.filter((id) => index.has(id));
}

function missingConditions(index, ids) {
  return ids
    .filter((id) => index.get(id)?.status !== 'ok')
    .map((id) => CHECK_CONDITIONS[id] ?? id.replaceAll('-', '_'));
}

function assessment(id, status, supportingChecks, decisiveProbeRan, summary, usableSubset = [], missing = []) {
  if (!DOCTOR_CAPABILITY_IDS.includes(id)) throw new Error(`Unknown Doctor capability: ${id}`);
  if (!['available', 'degraded', 'unavailable', 'not_probed'].includes(status)) throw new Error(`Invalid Doctor capability status: ${status}`);
  if (status === 'available' && decisiveProbeRan !== true) throw new Error(`Available capability requires a decisive probe: ${id}`);
  if (status === 'degraded' && (usableSubset.length === 0 || missing.length === 0)) {
    throw new Error(`Degraded capability requires usable and missing subsets: ${id}`);
  }
  return {
    id,
    name: DOCTOR_CAPABILITY_NAMES[id],
    status,
    supportingChecks,
    decisiveProbeRan: decisiveProbeRan === true,
    summary,
    usableSubset,
    missingConditions: missing,
  };
}

function prerequisiteAssessment(index, id, checkIds, prerequisites, requiredChecks = []) {
  const unavailable = prerequisites.filter((item) => item.status === 'unavailable');
  const degraded = prerequisites.filter((item) => item.status === 'degraded');
  const missingChecks = missingConditions(index, requiredChecks);
  if (unavailable.length > 0 || degraded.length > 0 || missingChecks.length > 0) {
    return assessment(
      id,
      'unavailable',
      presentCheckIds(index, checkIds),
      false,
      'Required capability prerequisites are unavailable',
      [],
      [...unavailable, ...degraded].map((item) => item.id).concat(missingChecks),
    );
  }
  if (prerequisites.some((item) => item.status !== 'available')) {
    return assessment(id, 'not_probed', presentCheckIds(index, checkIds), false, 'Runtime capability was not decisively probed');
  }
  return assessment(id, 'not_probed', presentCheckIds(index, checkIds), false, 'Runtime capability was not decisively probed');
}

export function assessDoctorCapabilities(checks, options = {}) {
  const index = checkIndex(checks);
  const probes = options.probes ?? {};
  const godotChecks = ['godot-executable', 'godot-version'];
  const godotMissing = missingConditions(index, godotChecks);
  const godotProcess = godotMissing.length === 0 && probes.godotVersion === true
    ? assessment('godot_process', 'available', presentCheckIds(index, godotChecks), true, 'Godot version process probe completed')
    : godotMissing.length > 0
      ? assessment('godot_process', 'unavailable', presentCheckIds(index, godotChecks), probes.godotVersion === true, 'Godot process prerequisites or version probe failed', [], godotMissing)
      : assessment('godot_process', 'not_probed', presentCheckIds(index, godotChecks), false, 'Godot version process probe was not run');

  const metadataChecks = ['flight-deck-config', 'project-file', 'git-repository', 'project-root'];
  const projectMissing = missingConditions(index, ['project-root', 'project-file']);
  const configMissing = missingConditions(index, ['flight-deck-config']);
  let projectMetadata;
  if (projectMissing.length > 0) {
    projectMetadata = assessment('project_metadata', 'unavailable', presentCheckIds(index, metadataChecks), true, 'Project root is unavailable', [], projectMissing);
  } else if (configMissing.length > 0) {
    projectMetadata = assessment(
      'project_metadata', 'degraded', presentCheckIds(index, metadataChecks), true,
      'Project files are usable but Flight Deck configuration is incomplete', ['project_root', 'project_file'], configMissing,
    );
  } else {
    projectMetadata = assessment('project_metadata', 'available', presentCheckIds(index, metadataChecks), true, 'Project metadata checks completed');
  }

  const runtimeChecks = ['runtime-probe', 'runtime-autoload'];
  const runtimeMissing = missingConditions(index, runtimeChecks);
  const runtimeIntegration = runtimeMissing.length === 0
    ? assessment('runtime_probe_integration', 'available', presentCheckIds(index, runtimeChecks), true, 'Runtime probe installation checks completed')
    : assessment('runtime_probe_integration', 'unavailable', presentCheckIds(index, runtimeChecks), true, 'Runtime probe integration is incomplete', [], runtimeMissing);

  const importChecks = [...godotChecks, 'project-file', 'project-root'];
  const executionChecks = [...godotChecks, ...runtimeChecks];
  const projectImport = prerequisiteAssessment(
    index, 'project_import', importChecks, [godotProcess], ['project-file', 'project-root'],
  );
  const unitExecution = prerequisiteAssessment(index, 'unit_execution', executionChecks, [godotProcess, runtimeIntegration]);
  const scenarioExecution = prerequisiteAssessment(index, 'scenario_execution', executionChecks, [godotProcess, runtimeIntegration]);
  const visualComparison = prerequisiteAssessment(index, 'visual_comparison', executionChecks, [godotProcess, runtimeIntegration]);
  const benchmarkExecution = prerequisiteAssessment(index, 'benchmark_execution', executionChecks, [godotProcess, runtimeIntegration]);

  const editorChecks = ['editor-bridge-addon', 'editor-plugin-enabled', 'editor-auth-token', 'editor-write-policy', 'editor-bridge-session', 'editor-bridge-availability'];
  const editorPrerequisiteChecks = ['editor-bridge-addon', 'editor-plugin-enabled', 'editor-auth-token'];
  const editorMissing = missingConditions(index, editorPrerequisiteChecks);
  let editorRead;
  if (editorMissing.length > 0) {
    editorRead = assessment(
      'editor_bridge_read', 'unavailable', presentCheckIds(index, editorChecks), false,
      'Editor Bridge prerequisites are unavailable', [], editorMissing,
    );
  } else if (index.get('editor-bridge-availability')?.status === 'error') {
    editorRead = assessment(
      'editor_bridge_read', 'unavailable', presentCheckIds(index, editorChecks), false,
      'Editor Bridge configuration prevents a runtime probe', [], ['editor_bridge_availability'],
    );
  } else if (probes.editorBridge !== true) {
    editorRead = assessment('editor_bridge_read', 'not_probed', presentCheckIds(index, editorChecks), false, 'Editor Bridge runtime probe was not selected');
  } else if (index.get('editor-bridge-availability')?.status === 'ok') {
    editorRead = assessment('editor_bridge_read', 'available', presentCheckIds(index, editorChecks), true, 'Authenticated Editor Bridge probe completed');
  } else {
    editorRead = assessment(
      'editor_bridge_read', 'unavailable', presentCheckIds(index, editorChecks), true,
      'Authenticated Editor Bridge probe did not establish a trusted session', [], ['editor_bridge_availability'],
    );
  }

  let editorWrite;
  if (editorRead.status === 'unavailable') {
    editorWrite = assessment('editor_bridge_write', 'unavailable', presentCheckIds(index, editorChecks), false, 'Editor Bridge read prerequisite is unavailable', [], ['editor_bridge_read']);
  } else if (index.get('editor-write-policy')?.status !== 'ok') {
    editorWrite = assessment('editor_bridge_write', 'unavailable', presentCheckIds(index, editorChecks), true, 'Editor writes are disabled by project configuration', [], ['editor_writes_disabled']);
  } else {
    editorWrite = assessment('editor_bridge_write', 'not_probed', presentCheckIds(index, editorChecks), false, 'Doctor does not perform a consequential Editor write probe');
  }

  const templateChecks = ['export-templates'];
  const templateMissing = missingConditions(index, templateChecks);
  const exportChecks = [...importChecks, ...templateChecks];
  const desktopExport = templateMissing.length > 0
    ? assessment('desktop_export', 'unavailable', presentCheckIds(index, exportChecks), true, 'Export templates are unavailable', [], templateMissing)
    : prerequisiteAssessment(index, 'desktop_export', exportChecks, [godotProcess, projectImport]);
  const nativeSmoke = templateMissing.length > 0
    ? assessment('native_smoke', 'unavailable', presentCheckIds(index, exportChecks), true, 'Export templates are unavailable', [], templateMissing)
    : prerequisiteAssessment(index, 'native_smoke', exportChecks, [godotProcess, projectImport, desktopExport]);

  return [
    godotProcess,
    projectMetadata,
    runtimeIntegration,
    projectImport,
    unitExecution,
    scenarioExecution,
    visualComparison,
    benchmarkExecution,
    editorRead,
    editorWrite,
    desktopExport,
    nativeSmoke,
  ];
}

export function capabilityRelevanceForPlan(plan) {
  if (!plan || !Array.isArray(plan.stages)) throw new Error('Capability relevance requires a resolved Verification Plan');
  const stages = plan.stages.filter((stage) => stage?.disposition === 'run');
  const selected = new Set(stages.map((stage) => stage.kind));
  const required = new Set();
  if (stages.length > 0) required.add('project_metadata');
  if (selected.has('doctor')) {
    required.add('godot_process');
    required.add('runtime_probe_integration');
  }
  if (selected.has('check')) {
    required.add('godot_process');
    required.add('project_import');
  }
  if (selected.has('unit')) {
    required.add('godot_process');
    required.add('runtime_probe_integration');
    required.add('unit_execution');
  }
  if (selected.has('scenario')) {
    required.add('godot_process');
    required.add('runtime_probe_integration');
    required.add('scenario_execution');
  }
  if (selected.has('visual')) {
    required.add('godot_process');
    required.add('runtime_probe_integration');
    required.add('visual_comparison');
  }
  if (selected.has('benchmark')) {
    required.add('godot_process');
    required.add('runtime_probe_integration');
    required.add('benchmark_execution');
  }
  if (selected.has('export')) {
    required.add('godot_process');
    required.add('project_import');
    required.add('desktop_export');
  }
  if (plan.preparation?.godotImportRequired === true) {
    required.add('godot_process');
    required.add('project_import');
  }
  const nativeMacosSmoke = stages.some((stage) => stage.kind === 'export' && stage.target === 'macos'
    && stage.runtime?.exportsConfig?.nativeSmoke?.macos?.enabled === true);
  if (nativeMacosSmoke) required.add('native_smoke');
  return Object.fromEntries(DOCTOR_CAPABILITY_IDS.map((id) => [id, required.has(id) ? 'required' : 'irrelevant']));
}
