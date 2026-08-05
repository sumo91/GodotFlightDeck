const option = (takesValue, valueName, description, extra = {}) => ({ takesValue, valueName, description, ...extra });

export const CLI_OPTIONS = Object.freeze({
  frames: option(true, 'N', 'Frame count'),
  warmup: option(true, 'N', 'Benchmark warmup frames'),
  profile: option(true, 'NAME', 'Profile override'),
  output: option(true, 'FILE', 'Output file'),
  report: option(true, 'FILE', 'Report file'),
  godot: option(true, 'PATH', 'Godot executable override'),
  seed: option(true, 'N', 'Deterministic random seed'),
  tolerance: option(true, 'N', 'Visual changed-pixel ratio limit'),
  threshold: option(true, 'N', 'Visual per-pixel difference threshold'),
  filter: option(true, 'TEXT', 'Unit test name filter', { allowOptionLikeValue: true }),
  file: option(true, 'PATH', 'Check a single .gd script instead of the whole project'),
  query: option(true, 'JSON', 'White-listed read-only runtime query list (property/tree/signals/group)'),
  'query-file': option(true, 'PATH', 'File containing the runtime query JSON list'),
  watch: option(false, '', 'Stream the game stdout/stderr live with error markers'),
  'main-scene': option(true, 'PATH', 'Scene to run when watching (res:// path)'),
  depth: option(true, 'N', 'Editor tree depth'),
  limit: option(true, 'N', 'Editor result limit'),
  timeout: option(true, 'SECONDS', 'Wall-clock timeout'),
  verbosity: option(true, 'LEVEL', 'Presentation detail level', { values: ['compact', 'normal', 'diagnostic'] }),
  json: option(false, '', 'Emit JSON'),
  debug: option(false, '', 'Create a debug export'),
  force: option(false, '', 'Replace a cached download'),
  'dry-run': option(false, '', 'Validate without committing'),
  apply: option(false, '', 'Commit a destructive editor action (delete/batch/cleanup-sessions)'),
  publish: option(false, '', 'Reserved publishing request (currently rejected)'),
  'trace-events': option(false, '', 'Emit scenario event-window diagnostics on wait timeouts'),
  domain: option(true, 'NAME', 'Help domain', { values: ['verify', 'editor', 'scenario', 'project'] }),
});

const positional = (name, required = false, description = '') => ({ name, required, description });
const command = (summary, usage, options = [], positionals = [], extra = {}) => ({
  summary, usage, options, positionals, minimumPositionals: positionals.filter((item) => item.required).length,
  maximumPositionals: positionals.length, ...extra,
});
const nestedAction = (usage, options, minimumPositionals, maximumPositionals) => ({ usage, options, minimumPositionals, maximumPositionals });

const editorActions = {
  describe: nestedAction('gdeck editor describe [action]', ['json'], 1, 2),
  status: nestedAction('gdeck editor status [project]', ['json'], 1, 2),
  sessions: nestedAction('gdeck editor sessions [project] [--json]', ['json'], 1, 2),
  'cleanup-sessions': nestedAction('gdeck editor cleanup-sessions [project] [--apply] [--json]', ['apply', 'json'], 1, 2),
  tree: nestedAction('gdeck editor tree [project] [--depth N] [--limit N]', ['depth', 'limit', 'json'], 1, 2),
  inspect: nestedAction('gdeck editor inspect [node-path] [project]', ['json'], 1, 3),
  logs: nestedAction('gdeck editor logs [project] [--limit N]', ['limit', 'json'], 1, 2),
  set: nestedAction('gdeck editor set <node-path> <property> <json-value> [project]', ['json'], 4, 5),
  create: nestedAction('gdeck editor create <parent-path> <class> <name> [project]', ['json'], 4, 5),
  delete: nestedAction('gdeck editor delete <node-path> [project] --apply', ['apply', 'json'], 2, 3),
  reorder: nestedAction('gdeck editor reorder <node-path> <index> [project]', ['json'], 3, 4),
  'resource-inspect': nestedAction('gdeck editor resource-inspect <res://path.tres> [project]', ['json'], 2, 3),
  'resource-create': nestedAction('gdeck editor resource-create <class> <res://path.tres> [project]', ['json'], 3, 4),
  'resource-set': nestedAction('gdeck editor resource-set <res://path.tres> <property> <json-value> [project]', ['json'], 4, 5),
  'resource-delete': nestedAction('gdeck editor resource-delete <res://path.tres> [project] --apply', ['apply', 'json'], 2, 3),
  'resource-assign': nestedAction('gdeck editor resource-assign <node-path> <property> <res://path.tres> [project]', ['json'], 4, 5),
  batch: nestedAction('gdeck editor batch <batch.json> [project] [--dry-run|--apply]', ['dry-run', 'apply', 'json'], 2, 3),
  undo: nestedAction('gdeck editor undo [project]', ['json'], 1, 2),
  redo: nestedAction('gdeck editor redo [project]', ['json'], 1, 2),
  save: nestedAction('gdeck editor save [project]', ['json'], 1, 2),
};

export const CLI_COMMANDS = Object.freeze({
  help: command('Show command help or a capability domain guide', 'gdeck help [domain] [--domain NAME]', ['domain'], [positional('domain')]),
  version: command('Print the Flight Deck version', 'gdeck version'),
  describe: command('Describe a command contract', 'gdeck describe <command> [--json]', ['json'], [positional('command', true)]),
  init: command('Install or update the runtime probe and project configuration', 'gdeck init [project]', [], [positional('project')]),
  'sync-addon': command('Refresh the Flight Deck addon from this CLI build (same transactional path as init)', 'gdeck sync-addon [project]', [], [positional('project')]),
  doctor: command('Assess independent Godot, project, headless, Editor and export capabilities', 'gdeck doctor [project] [--json]', ['json', 'godot', 'timeout'], [positional('project')]),
  'evidence-index': command('Inspect bounded verification evidence freshness without executing or writing', 'gdeck evidence-index [project] [--json] [--timeout SECONDS] [--limit N]', ['json', 'timeout', 'limit'], [positional('project')]),
  check: command('Import the project and validate all GDScript', 'gdeck check [project] [--file PATH] [--timeout SECONDS]', ['godot', 'timeout', 'file'], [positional('project')]),
  run: command('Launch the configured project', 'gdeck run [project] [--query JSON|--query-file PATH] [--watch] [--main-scene PATH] [--frames N] [--seed N] [--json] [--timeout SECONDS] [-- <game arguments>]', ['godot', 'timeout', 'query', 'query-file', 'watch', 'main-scene', 'frames', 'seed', 'json'], [positional('project')], { passthrough: true }),
  capture: command('Capture the game viewport', 'gdeck capture [profile] [project] [--frames N] [--output FILE]', ['frames', 'output', 'godot', 'seed', 'timeout'], [positional('profile'), positional('project')]),
  benchmark: command('Measure a stable runtime performance window', 'gdeck benchmark [profile] [project] [--frames N] [--warmup N]', ['frames', 'warmup', 'output', 'godot', 'seed', 'timeout'], [positional('profile'), positional('project')]),
  scenario: command('Run scripted input, waits and semantic assertions', 'gdeck scenario <name|file> [project] [--profile NAME] [--frames N] [--output FILE] [--trace-events]', ['profile', 'frames', 'output', 'report', 'godot', 'seed', 'timeout', 'trace-events'], [positional('name-or-file', true), positional('project')]),
  baseline: command('Create or update a visual regression baseline', 'gdeck baseline [profile] [project] [--frames N]', ['frames', 'godot', 'seed', 'threshold', 'tolerance', 'timeout'], [positional('profile'), positional('project')]),
  'visual-test': command('Compare a capture against a visual baseline', 'gdeck visual-test [profile] [project] [--tolerance N] [--threshold N]', ['frames', 'report', 'godot', 'seed', 'threshold', 'tolerance', 'timeout'], [positional('profile'), positional('project')]),
  verify: command('Run the configured verification pipeline', 'gdeck verify [project] [--profile NAME] [--output REPORT.json] [--verbosity LEVEL] [--json]', ['profile', 'output', 'timeout', 'verbosity', 'json'], [positional('project')]),
  templates: command('Inspect or install official export templates', 'gdeck templates <status|install> [project]', ['godot', 'force', 'timeout'], [], {
    defaultAction: 'status', actions: {
      status: nestedAction('gdeck templates status [project]', ['godot', 'timeout'], 1, 2),
      install: nestedAction('gdeck templates install [project] [--force]', ['godot', 'force', 'timeout'], 1, 2),
    },
  }),
  'export-init': command('Create desktop export presets and configuration', 'gdeck export-init [project]', [], [positional('project')]),
  export: command('Build configured internal desktop artifacts', 'gdeck export <macos|windows|linux|all> [project] [--debug] [--publish] [--timeout SECONDS]', ['debug', 'publish', 'godot', 'output', 'timeout'], [positional('target', true), positional('project')]),
  unit: command('Discover and run headless GDScript unit tests', 'gdeck unit [project] [--filter TEXT] [--verbosity LEVEL]', ['filter', 'output', 'godot', 'timeout', 'verbosity'], [positional('project')]),
  scene: command('Inspect or edit scene integrity', 'gdeck scene doctor [project] [--json] | gdeck scene set <scene> <node> <property> <json> [--apply] | gdeck scene restore <snapshot> [--apply]', ['json', 'godot', 'timeout', 'apply'], [positional('project')], { defaultAction: 'doctor', actions: {
    doctor: nestedAction('gdeck scene doctor [project] [--json]', ['json', 'godot', 'timeout'], 1, 2),
    set: nestedAction('gdeck scene set <scene> <node-path> <property> <json-value> [project] [--apply]', ['apply', 'json', 'godot', 'timeout'], 5, 6),
    restore: nestedAction('gdeck scene restore <snapshot> [project] [--apply]', ['apply', 'godot', 'timeout'], 2, 3),
  } }),
  editor: command('Query or safely edit the running Godot Editor', 'gdeck editor <action> [args] [project]', [...new Set(Object.values(editorActions).flatMap((item) => item.options))], [], { defaultAction: 'status', actions: editorActions }),
});

const field = (kind, options = {}) => ({ kind, optional: true, ...options });
export const PI_FIELDS = Object.freeze({
  project: field('string', { description: 'Path inside the active trusted Godot project; defaults to Pi cwd' }),
  timeout: field('number', { minimum: 1, maximum: 900, description: 'Wall-clock timeout in seconds' }),
  profile: field('string', { minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' }),
  name: field('string', { minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$', description: 'Project-local scenario name' }),
  filter: field('string', { minLength: 1, maxLength: 120 }),
  frames: field('integer', { minimum: 1, maximum: 100000 }),
  seed: field('integer', { minimum: 0, maximum: 2147483647, description: 'Deterministic random seed' }),
  warmupFrames: field('integer', { minimum: 0, maximum: 100000, description: 'Benchmark warmup frames excluded from stable metrics' }),
  tolerance: field('number', { minimum: 0, maximum: 1 }),
  threshold: field('number', { minimum: 0, maximum: 1 }),
  verbosity: field('enum', { values: ['compact', 'normal', 'diagnostic'], description: 'Presentation detail; never changes execution or evidence authority' }),
  target: field('enum', { values: ['macos', 'windows', 'linux', 'all'] }),
  debug: field('boolean'),
  path: field('string', { maxLength: 512, description: 'Scene-relative node path' }),
  parent: field('string', { maxLength: 512 }),
  property: field('string', { maxLength: 160 }),
  value: field('any', { description: 'JSON-compatible property value' }),
  className: field('string', { maxLength: 100 }),
  nodeName: field('string', { maxLength: 100 }),
  index: field('integer', { minimum: 0, maximum: 100000 }),
  resource: field('string', { maxLength: 512, description: 'Resource path under an allowed res:// root' }),
  resourceClass: field('string', { maxLength: 100 }),
  depth: field('integer', { minimum: 1, maximum: 64 }),
  limit: field('integer', { minimum: 1, maximum: 5000 }),
  batchName: field('string', { maxLength: 80, description: 'Batch transaction name' }),
  operations: field('operations', { minItems: 1, maxItems: 100 }),
  commit: field('boolean', { description: 'Commit a validated batch; false performs dry-run only' }),
  file: field('string', { description: 'Check a single .gd script instead of the whole project' }),
  json: field('boolean', { description: 'Emit structured JSON output where supported' }),
  apply: field('boolean', { description: 'Commit a write operation after dry-run preview' }),
  scene: field('string', { description: 'Scene res:// path to edit' }),
  query: field('string', { description: 'White-listed read-only runtime query list (inline JSON array)' }),
  'query-file': field('string', { description: 'File containing the runtime query JSON list' }),
  watch: field('boolean', { description: 'Stream the game stdout/stderr live with error markers' }),
  'main-scene': field('string', { description: 'Scene to run when watching (res:// path)' }),
});

const action = (cliCommand, parameters, confirmation, risk, leaseEligible = false) => ({
  cliCommand, parameters, confirmation, risk, leaseEligible,
});
export const PI_FAMILIES = Object.freeze({
  project: {
    toolName: 'gdeck_project', fields: ['project', 'timeout'], actions: {
      detect: action(null, [], 'never', 'none'), init: action('init', ['timeout'], 'always', 'project-write', true),
      doctor: action('doctor', ['timeout'], 'never', 'none'), evidence: action('evidence-index', [], 'never', 'none'),
    },
  },
  validate: {
    toolName: 'gdeck_validate', fields: ['project', 'timeout', 'profile', 'name', 'filter', 'frames', 'warmupFrames', 'tolerance', 'threshold', 'verbosity', 'file', 'json'], actions: {
      check: action('check', ['file', 'timeout'], 'never', 'none'), unit: action('unit', ['filter', 'timeout', 'verbosity'], 'never', 'none'),
      scenario: action('scenario', ['name', 'profile', 'frames', 'timeout'], 'never', 'none'),
      baseline: action('baseline', ['profile', 'frames', 'timeout'], 'always', 'destructive'),
      visual: action('visual-test', ['profile', 'tolerance', 'threshold', 'timeout'], 'never', 'none'),
      benchmark: action('benchmark', ['profile', 'frames', 'warmupFrames', 'timeout'], 'never', 'none'),
      verify: action('verify', ['profile', 'timeout', 'verbosity', 'json'], 'verify-plan', 'generated-write', true),
    },
  },
  release: {
    toolName: 'gdeck_release', fields: ['project', 'timeout', 'target', 'debug'], actions: {
      'templates-status': action('templates', ['timeout'], 'never', 'none'),
      'templates-install': action('templates', ['timeout'], 'always', 'host-write'),
      'export-init': action('export-init', [], 'always', 'project-write', true), export: action('export', ['target', 'debug', 'timeout'], 'always', 'generated-write', true),
    },
  },
  editor: {
    toolName: 'gdeck_editor',
    fields: ['project', 'path', 'parent', 'property', 'value', 'className', 'nodeName', 'index', 'resource', 'resourceClass', 'depth', 'limit', { name: 'name', field: 'batchName' }, 'operations', 'commit'],
    actions: {
      status: action('editor', [], 'never', 'none'),
      sessions: action('editor', [], 'never', 'none'),
      'cleanup-sessions': action('editor', [], 'always', 'destructive'),
      tree: action('editor', ['depth', 'limit'], 'never', 'none'), inspect: action('editor', ['path'], 'never', 'none'), logs: action('editor', ['limit'], 'never', 'none'),
      set: action('editor', ['path', 'property', 'value'], 'always', 'project-write', true), create: action('editor', ['parent', 'className', 'nodeName'], 'always', 'project-write', true),
      delete: action('editor', ['path'], 'delete', 'destructive'), reorder: action('editor', ['path', 'index'], 'always', 'project-write', true),
      'resource-inspect': action('editor', ['resource'], 'never', 'none'), 'resource-create': action('editor', ['resourceClass', 'resource'], 'always', 'project-write', true),
      'resource-set': action('editor', ['resource', 'property', 'value'], 'always', 'project-write', true), 'resource-delete': action('editor', ['resource'], 'delete', 'destructive'),
      'resource-assign': action('editor', ['path', 'property', 'resource'], 'always', 'project-write', true), batch: action('editor', ['name', 'operations', 'commit'], 'batch-commit', 'destructive'),
      undo: action('editor', [], 'always', 'project-write', true), redo: action('editor', [], 'always', 'project-write', true), save: action('editor', [], 'always', 'project-write', true),
    },
  },
  scene: {
    toolName: 'gdeck_scene', fields: ['project', 'timeout', 'json', 'apply', 'scene', 'path', 'property', 'value'], actions: {
      doctor: action('scene', ['timeout', 'json'], 'never', 'none'),
      set: action('scene', ['scene', 'path', 'property', 'value', 'apply', 'timeout'], 'always', 'project-write', true),
      restore: action('scene', ['path', 'apply', 'timeout'], 'always', 'project-write', true),
    },
  },
  run: {
    toolName: 'gdeck_run', fields: ['project', 'timeout', 'frames', 'seed', 'json', 'query', 'query-file', 'watch', 'main-scene'], actions: {
      query: action('run', ['query', 'query-file', 'frames', 'seed', 'json', 'timeout'], 'never', 'generated-write'),
      watch: action('run', ['watch', 'main-scene', 'timeout'], 'never', 'none'),
    },
  },
});

export function getCliCommand(name) { return CLI_COMMANDS[name] ?? null; }
export function getPiFamily(name) { return PI_FAMILIES[name] ?? null; }
export function getPiAction(family, actionName) { return PI_FAMILIES[family]?.actions?.[actionName] ?? null; }

function actionDefinition(command, positionalValues) {
  if (!command.actions) return null;
  return command.actions[positionalValues[0]] ?? null;
}

export function allowedCliOptions(commandName, positionalValues = []) {
  const definition = getCliCommand(commandName);
  if (!definition) return [];
  return actionDefinition(definition, positionalValues)?.options ?? definition.options;
}

export function parseCliArguments(argv) {
  const aliases = { '--help': 'help', '-h': 'help', '--version': 'version', '-v': 'version' };
  let commandName = aliases[argv[0]] ?? argv[0] ?? 'help';
  if (!getCliCommand(commandName)) throw new Error(`Unknown command: ${commandName}`);
  const parsed = { command: commandName, positional: [], passthrough: [], options: {} };
  let endOfOptions = false;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (endOfOptions) {
      if (getCliCommand(commandName).passthrough) parsed.passthrough.push(value);
      else parsed.positional.push(value);
      continue;
    }
    if (value === '--') {
      endOfOptions = true;
      continue;
    }
    if (value === '--help' || value === '-h') {
      commandName = 'help';
      parsed.command = 'help';
      continue;
    }
    if (value.startsWith('-')) {
      if (!value.startsWith('--')) throw new Error(`Unknown option for ${commandName}: ${value}`);
      const equals = value.indexOf('=');
      const key = value.slice(2, equals >= 0 ? equals : undefined);
      const definition = CLI_OPTIONS[key];
      if (!definition) throw new Error(`Unknown option for ${commandName}: ${value}`);
      if (definition.takesValue) {
        if (equals >= 0) {
          const inlineValue = value.slice(equals + 1);
          if (!inlineValue) throw new Error(`Option --${key} requires ${definition.valueName || 'a value'}`);
          parsed.options[key] = inlineValue;
        } else {
          const next = argv[index + 1];
          if (next === undefined || (!definition.allowOptionLikeValue && next.startsWith('--') && CLI_OPTIONS[next.slice(2)])) {
            throw new Error(`Option --${key} requires ${definition.valueName || 'a value'}`);
          }
          parsed.options[key] = next;
          index += 1;
        }
      } else {
        if (equals >= 0) throw new Error(`Option --${key} does not accept a value`);
        parsed.options[key] = true;
      }
      continue;
    }
    parsed.positional.push(value);
  }
  if (parsed.command === 'help') return parsed;
  const commandDefinition = getCliCommand(commandName);
  if (commandDefinition.actions && parsed.positional.length === 0 && commandDefinition.defaultAction) parsed.positional.push(commandDefinition.defaultAction);
  if (commandDefinition.actions) {
    const actionName = parsed.positional[0];
    if (!actionName || !Object.hasOwn(commandDefinition.actions, actionName)) {
      throw new Error(`Unsupported ${commandName} action: ${actionName ?? '(missing)'}. Allowed: ${Object.keys(commandDefinition.actions).join(', ')}`);
    }
  }
  for (const [key, value] of Object.entries(parsed.options)) {
    const values = CLI_OPTIONS[key]?.values;
    if (values && !values.includes(value)) {
      const label = key === 'verbosity' ? 'verbosity' : `value for --${key}`;
      throw new Error(`Unknown ${label}: ${value}. Allowed: ${values.join(', ')}`);
    }
  }
  const allowed = allowedCliOptions(commandName, parsed.positional);
  const unsupported = Object.keys(parsed.options).filter((key) => !allowed.includes(key));
  if (unsupported.length) {
    throw new Error(`Unsupported option(s) for ${commandName}${commandDefinition.actions ? `:${parsed.positional[0]}` : ''}: ${unsupported.map((key) => `--${key}`).join(', ')}. Allowed: ${allowed.length ? allowed.map((key) => `--${key}`).join(', ') : '(none)'}`);
  }
  const nested = actionDefinition(commandDefinition, parsed.positional);
  const minimum = nested?.minimumPositionals ?? commandDefinition.minimumPositionals;
  const maximum = nested?.maximumPositionals ?? commandDefinition.maximumPositionals;
  if (parsed.positional.length < minimum || parsed.positional.length > maximum) {
    throw new Error(`Invalid positional arguments for ${commandName}${nested ? `:${parsed.positional[0]}` : ''}. Usage: ${nested?.usage ?? commandDefinition.usage}`);
  }
  return parsed;
}

export function publicCommandDescription(name) {
  const definition = getCliCommand(name);
  if (!definition) return null;
  const options = Object.fromEntries(definition.options.map((key) => [key, { flags: [`--${key}`], ...CLI_OPTIONS[key] }]));
  return {
    schemaVersion: 1,
    command: name,
    summary: definition.summary,
    usage: definition.usage,
    passthrough: definition.passthrough === true,
    defaultAction: definition.defaultAction,
    positionals: definition.positionals,
    positionalCardinality: { minimum: definition.minimumPositionals, maximum: definition.maximumPositionals },
    options,
    actions: definition.actions ? Object.fromEntries(Object.entries(definition.actions).map(([actionName, item]) => [actionName, {
      usage: item.usage, options: item.options, positionalCardinality: { minimum: item.minimumPositionals, maximum: item.maximumPositionals },
    }])) : undefined,
    piBindings: Object.entries(PI_FAMILIES).flatMap(([familyName, family]) => Object.entries(family.actions)
      .filter(([, binding]) => binding.cliCommand === name)
      .map(([actionName, binding]) => ({
        family: familyName, tool: family.toolName, action: actionName, confirmation: binding.confirmation,
        risk: binding.risk, leaseEligible: binding.leaseEligible,
      }))),
  };
}

export function assertRegistryIntegrity() {
  for (const [commandName, definition] of Object.entries(CLI_COMMANDS)) {
    for (const key of definition.options) if (!CLI_OPTIONS[key]) throw new Error(`Unknown CLI option ${key} on ${commandName}`);
    if (definition.minimumPositionals > definition.maximumPositionals) throw new Error(`Invalid positional contract on ${commandName}`);
    if (definition.defaultAction && !definition.actions?.[definition.defaultAction]) throw new Error(`Invalid default action on ${commandName}`);
    for (const [actionName, item] of Object.entries(definition.actions ?? {})) {
      if (!actionName) throw new Error(`Empty action on ${commandName}`);
      if (item.minimumPositionals > item.maximumPositionals) throw new Error(`Invalid positional contract on ${commandName}:${actionName}`);
      for (const key of item.options) if (!CLI_OPTIONS[key]) throw new Error(`Unknown CLI option ${key} on ${commandName}:${actionName}`);
    }
  }
  for (const [familyName, family] of Object.entries(PI_FAMILIES)) {
    const publicFields = family.fields.map((entry) => typeof entry === 'string' ? entry : entry.name);
    for (const entry of family.fields) {
      const key = typeof entry === 'string' ? entry : entry.field;
      if (!PI_FIELDS[key]) throw new Error(`Unknown Pi field ${key} on ${familyName}`);
    }
    for (const [actionName, binding] of Object.entries(family.actions)) {
      for (const key of binding.parameters) if (!publicFields.includes(key)) throw new Error(`Pi action ${familyName}:${actionName} uses undeclared field ${key}`);
      if (binding.cliCommand && !CLI_COMMANDS[binding.cliCommand]) throw new Error(`Pi action ${familyName}:${actionName} targets unknown command ${binding.cliCommand}`);
      if (!['never', 'always', 'verify-plan', 'batch-commit', 'delete'].includes(binding.confirmation)) throw new Error(`Missing or unknown confirmation policy on ${familyName}:${actionName}`);
      if (!['none', 'generated-write', 'project-write', 'destructive', 'host-write'].includes(binding.risk)) throw new Error(`Missing or unknown risk tier on ${familyName}:${actionName}`);
      if (typeof binding.leaseEligible !== 'boolean') throw new Error(`Missing lease policy on ${familyName}:${actionName}`);
      if (binding.leaseEligible && !['generated-write', 'project-write'].includes(binding.risk)) throw new Error(`Only generated or project writes may use approval leases: ${familyName}:${actionName}`);
      if (['none', 'destructive', 'host-write'].includes(binding.risk) && binding.leaseEligible) throw new Error(`Non-mutating, destructive, and host writes cannot use approval leases: ${familyName}:${actionName}`);
    }
  }
  return true;
}

assertRegistryIntegrity();
