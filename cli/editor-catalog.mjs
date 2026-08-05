/**
 * Editor Bridge capability catalog for Agent navigation (P0/P1).
 * Layers: core-read, core-write, supplementary-write, destructive.
 */

export const EDITOR_ACTION_CATALOG = Object.freeze({
  describe: {
    layer: 'meta',
    risk: 'none',
    summary: 'Describe an editor action contract and safety layer',
    requiresLiveEditor: false,
    requiresAllowWrites: false,
    requiresApply: false,
    requiresSupplementary: false,
  },
  status: {
    layer: 'core-read',
    risk: 'none',
    summary: 'Probe Editor Bridge identity and project binding',
    requiresLiveEditor: true,
    requiresAllowWrites: false,
    requiresApply: false,
    requiresSupplementary: false,
  },
  sessions: {
    layer: 'core-read',
    risk: 'none',
    summary: 'List local Editor session metadata for this project',
    requiresLiveEditor: false,
    requiresAllowWrites: false,
    requiresApply: false,
    requiresSupplementary: false,
  },
  tree: {
    layer: 'core-read',
    risk: 'none',
    summary: 'Read the edited scene node tree',
    requiresLiveEditor: true,
    requiresAllowWrites: false,
    requiresApply: false,
    requiresSupplementary: false,
  },
  inspect: {
    layer: 'core-read',
    risk: 'none',
    summary: 'Inspect a node and its properties',
    requiresLiveEditor: true,
    requiresAllowWrites: false,
    requiresApply: false,
    requiresSupplementary: false,
  },
  logs: {
    layer: 'core-read',
    risk: 'none',
    summary: 'Read bounded editor/runtime log lines',
    requiresLiveEditor: true,
    requiresAllowWrites: false,
    requiresApply: false,
    requiresSupplementary: false,
  },
  'resource-inspect': {
    layer: 'core-read',
    risk: 'none',
    summary: 'Inspect a resource under configured resourceRoots',
    requiresLiveEditor: true,
    requiresAllowWrites: false,
    requiresApply: false,
    requiresSupplementary: false,
  },
  set: {
    layer: 'core-write',
    risk: 'project-write',
    summary: 'Set a node property (UndoRedo)',
    requiresLiveEditor: true,
    requiresAllowWrites: true,
    requiresApply: false,
    requiresSupplementary: false,
  },
  create: {
    layer: 'core-write',
    risk: 'project-write',
    summary: 'Create a whitelisted UI/2D/container node',
    requiresLiveEditor: true,
    requiresAllowWrites: true,
    requiresApply: false,
    requiresSupplementary: false,
  },
  save: {
    layer: 'core-write',
    risk: 'project-write',
    summary: 'Save the currently edited scene',
    requiresLiveEditor: true,
    requiresAllowWrites: true,
    requiresApply: false,
    requiresSupplementary: false,
  },
  undo: {
    layer: 'core-write',
    risk: 'project-write',
    summary: 'Undo the last Editor Bridge action',
    requiresLiveEditor: true,
    requiresAllowWrites: true,
    requiresApply: false,
    requiresSupplementary: false,
  },
  redo: {
    layer: 'core-write',
    risk: 'project-write',
    summary: 'Redo the last undone Editor Bridge action',
    requiresLiveEditor: true,
    requiresAllowWrites: true,
    requiresApply: false,
    requiresSupplementary: false,
  },
  reorder: {
    layer: 'supplementary-write',
    risk: 'project-write',
    summary: 'Reorder a child node under its parent',
    requiresLiveEditor: true,
    requiresAllowWrites: true,
    requiresApply: false,
    requiresSupplementary: true,
  },
  'resource-create': {
    layer: 'supplementary-write',
    risk: 'project-write',
    summary: 'Create a whitelisted resource under resourceRoots',
    requiresLiveEditor: true,
    requiresAllowWrites: true,
    requiresApply: false,
    requiresSupplementary: true,
  },
  'resource-set': {
    layer: 'supplementary-write',
    risk: 'project-write',
    summary: 'Set a resource property under resourceRoots',
    requiresLiveEditor: true,
    requiresAllowWrites: true,
    requiresApply: false,
    requiresSupplementary: true,
  },
  'resource-assign': {
    layer: 'supplementary-write',
    risk: 'project-write',
    summary: 'Assign a resource reference onto a node property',
    requiresLiveEditor: true,
    requiresAllowWrites: true,
    requiresApply: false,
    requiresSupplementary: true,
  },
  delete: {
    layer: 'destructive',
    risk: 'destructive',
    summary: 'Delete a non-root scene node (requires --apply)',
    requiresLiveEditor: true,
    requiresAllowWrites: true,
    requiresApply: true,
    requiresSupplementary: false,
  },
  'resource-delete': {
    layer: 'destructive',
    risk: 'destructive',
    summary: 'Delete a resource file under resourceRoots (requires --apply)',
    requiresLiveEditor: true,
    requiresAllowWrites: true,
    requiresApply: true,
    requiresSupplementary: true,
  },
  'cleanup-sessions': {
    layer: 'destructive',
    risk: 'destructive',
    summary: 'Remove stale Editor session metadata (requires --apply)',
    requiresLiveEditor: false,
    requiresAllowWrites: false,
    requiresApply: true,
    requiresSupplementary: false,
  },
  batch: {
    layer: 'destructive',
    risk: 'destructive',
    summary: 'Preview or apply a bounded batch of editor operations (default preview; --apply commits)',
    requiresLiveEditor: true,
    requiresAllowWrites: true,
    requiresApply: true,
    requiresSupplementary: false,
  },
});

export const HELP_DOMAINS = Object.freeze({
  verify: {
    summary: 'Headless validation and evidence',
    next: [
      'gdeck doctor <project>',
      'gdeck check <project>',
      'gdeck unit <project>',
      'gdeck verify <project> --profile <name>',
      'gdeck evidence-index <project>',
    ],
    when: 'After code/scene changes, or before claiming a fix works. Does not require Godot Editor UI.',
  },
  editor: {
    summary: 'Live Godot Editor Bridge (project must be open in Editor)',
    next: [
      'gdeck editor describe',
      'gdeck editor status <project>',
      'gdeck editor tree <project> --depth 4',
      'gdeck editor inspect <node-path> <project>',
      'gdeck editor set ... (needs allowWrites)',
      'gdeck editor delete ... --apply (destructive)',
      'gdeck editor batch <file> [project]          # default preview',
      'gdeck editor batch <file> [project] --apply  # commit after approval',
    ],
    when: 'When you need the currently opened scene tree/properties. Prefer file edits + verify for gameplay logic.',
  },
  scenario: {
    summary: 'Scripted runtime scenarios via FlightDeckProbe',
    next: [
      'gdeck scenario <name> <project> [--trace-events]',
      'gdeck verify <project> --profile core-loop',
    ],
    when: 'For playable loops (menu→arena, shop, combat). Use wait_event / since:"command" / includeHistory.',
  },
  project: {
    summary: 'Install, sync, and project health',
    next: [
      'gdeck init <project>',
      'gdeck sync-addon <project>',
      'gdeck doctor <project>',
      'gdeck templates status <project>',
    ],
    when: 'First setup, fork upgrade, or doctor reports addon mismatch.',
  },
});

export const AGENT_DECISION_TREE = Object.freeze([
  {
    id: 'gameplay-logic',
    prefer: 'Edit .gd/.tscn files in the workspace, then gdeck check / unit / verify',
    avoid: 'Editor Bridge writes for large gameplay refactors',
  },
  {
    id: 'inspect-open-scene',
    prefer: 'gdeck editor status → tree → inspect (Editor must be open, versions aligned)',
    avoid: 'Guessing node paths without tree/inspect',
  },
  {
    id: 'small-ui-tweak',
    prefer: 'Bridge set/create after human allowWrites; then editor save; then verify smoke',
    avoid: 'delete/resource-delete/batch commit without --apply and explicit approval',
  },
  {
    id: 'regression',
    prefer: 'gdeck verify --profile headless-smoke or an existing verificationProfiles name',
    avoid: 'Inventing profile names or updating visual baselines to force green',
  },
]);

export function listEditorActionsByLayer() {
  const layers = {
    'core-read': [],
    'core-write': [],
    'supplementary-write': [],
    destructive: [],
    meta: [],
  };
  for (const [name, meta] of Object.entries(EDITOR_ACTION_CATALOG)) {
    (layers[meta.layer] ?? (layers[meta.layer] = [])).push(name);
  }
  return layers;
}

export function describeEditorAction(actionName) {
  if (!actionName) {
    return {
      schemaVersion: 1,
      kind: 'editor-catalog',
      layers: listEditorActionsByLayer(),
      actions: EDITOR_ACTION_CATALOG,
      decisionTree: AGENT_DECISION_TREE,
    };
  }
  const meta = EDITOR_ACTION_CATALOG[actionName];
  if (!meta) return null;
  return { schemaVersion: 1, kind: 'editor-action', action: actionName, ...meta };
}

export function resolveEditorBridgePolicy(bridgeConfig = {}) {
  return {
    allowWrites: bridgeConfig.allowWrites === true,
    // Supplementary writes default off; enable explicitly in .gdeck/config.json
    supplementaryEnabled: bridgeConfig.supplementaryEnabled === true,
  };
}

/** Map batch operation.action → catalog action name (same string today). */
export function validateBatchOperations(operations, policy) {
  if (!Array.isArray(operations)) {
    return { ok: false, error: 'Batch operations must be an array' };
  }
  const allowedBatchActions = new Set(['set', 'resource-set', 'resource-assign']);
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      return { ok: false, error: `batch[${index}]: operation must be an object` };
    }
    const opAction = String(operation.action ?? '');
    if (!allowedBatchActions.has(opAction)) {
      return { ok: false, error: `batch[${index}]: unsupported action '${opAction}'. Allowed: ${[...allowedBatchActions].join(', ')}` };
    }
    const meta = EDITOR_ACTION_CATALOG[opAction];
    if (!meta) {
      return { ok: false, error: `batch[${index}]: unknown action '${opAction}'` };
    }
    if (meta.requiresAllowWrites && !policy.allowWrites) {
      return { ok: false, error: `batch[${index}]: action '${opAction}' requires editorBridge.allowWrites=true` };
    }
    if (meta.requiresSupplementary && !policy.supplementaryEnabled) {
      return {
        ok: false,
        error: `batch[${index}]: action '${opAction}' requires editorBridge.supplementaryEnabled=true`,
      };
    }
  }
  return { ok: true };
}
