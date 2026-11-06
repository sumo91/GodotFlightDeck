import { extname } from 'node:path';

export function sourceCategory(path) {
  const normalized = path.replaceAll('\\', '/');
  if (/^(qa|tests)(\/|$)/.test(normalized)) return 'test_fixtures';
  if (/^(docs)(\/|$)/.test(normalized) || /\.(md|txt)$/i.test(normalized)) return 'documentation';
  if (['.gd', '.cs', '.gdshader', '.gdextension'].includes(extname(normalized))) return 'project_code';
  if (['.godot', '.cfg', '.json'].includes(extname(normalized))) return 'configuration';
  if (['.tscn', '.tres', '.res', '.scn', '.png', '.jpg', '.svg', '.wav', '.ogg', '.glb'].includes(extname(normalized))) return 'resources';
  return 'other_inputs';
}

const inputCategory = kind => ({ config: 'configuration', project: 'configuration',
  'unit-test': 'test_fixtures', scenario: 'test_fixtures', 'fixture-adapter': 'test_fixtures',
  'uid-sidecars': 'uid_sidecars' })[kind] ?? 'other_inputs';

export function planDriftDiagnostics(original, current, context = {}) {
  const categories = new Set();
  for (const category of new Set([...(original.inputs ?? []), ...(current.inputs ?? [])]
    .filter(i => i.kind === 'project-tree').flatMap(i => (i.categories ?? []).map(c => c.category)))) {
    const categoryValue = plan => (plan.inputs.find(i => i.kind === 'project-tree')?.categories ?? []).find(c => c.category === category);
    if (JSON.stringify(categoryValue(original)) !== JSON.stringify(categoryValue(current))) categories.add(category);
  }
  const key = input => `${input.kind}:${input.path ?? ''}`;
  const before = new Map(original.inputs.filter(i => i.kind !== 'project-tree').map(i => [key(i), i]));
  const after = new Map(current.inputs.filter(i => i.kind !== 'project-tree').map(i => [key(i), i]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))) categories.add(inputCategory((before.get(id) ?? after.get(id)).kind));
  }
  if (categories.size === 0) categories.add('plan_configuration_or_effects');
  return { evidenceAuthority: 'diagnostic_only', phase: context.phase ?? 'plan_comparison', stageId: context.stageId ?? null,
    originalPlanDigest: original.digest, currentPlanDigest: current.digest,
    originalInputsDigest: original.evidenceBinding.inputsDigest, currentInputsDigest: current.evidenceBinding.inputsDigest,
    changedCategories: [...categories].sort(), priorEvidenceScope: 'original_inputs_only',
    currentStageEvidenceAccepted: false };
}

export function verificationPlanSummary(plan) {
  const tree = plan.inputs.find(input => input.kind === 'project-tree');
  const exclusions = plan.sourceExclusions.filter(item => !plan.sourceExclusions.some(parent => parent !== item
    && parent.subtree && item.path.startsWith(`${parent.path}/`)));
  return { evidenceAuthority: 'operational_only', planDigest: plan.digest, inputsDigest: plan.evidenceBinding.inputsDigest,
    configDigest: plan.inputs.find(input => input.kind === 'config')?.sha256,
    sourceTreeDigest: tree?.sha256, fileCount: tree?.fileCount ?? 0,
    categories: tree?.categories ?? [],
    scope: 'project_tree_and_selected_configuration',
    excluded: exclusions.slice(0, 24), exclusionsTruncated: exclusions.length > 24,
    configException: '.gdeck/config.json participates through semantic configuration',
    generatedSidecars: '*.import excluded; *.uid bound separately',
    evidenceScope: 'original_inputs_only', editingPolicy: 'changes_to_bound_inputs_invalidate_this_run_no_global_lock' };
}
