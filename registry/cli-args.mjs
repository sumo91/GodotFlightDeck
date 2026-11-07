import { getPiAction, getCliCommand, parseCliArguments } from './commands.mjs';

// Fields that are boolean flags on the CLI.
const FLAG_FIELDS = new Set(["json", "watch", "apply", "debug", "force", "dry-run"]);
// Fields whose CLI option name differs from the Pi field name.
const FIELD_OPTION_NAMES = { warmupFrames: "warmup" };
// Editor batch handling.
const BATCH_FIELDS = new Set(["name", "operations", "commit"]);

const REQUIRED_FIELDS = {
  "validate:scenario": ["name"],
  "release:export": ["target"],
  "editor:set": ["property", "value"],
  "editor:create": ["className", "nodeName"],
  "editor:delete": ["path"],
  "editor:reorder": ["path", "index"],
  "editor:resource-inspect": ["resource"],
  "editor:resource-create": ["resourceClass", "resource"],
  "editor:resource-set": ["resource", "property", "value"],
  "editor:resource-delete": ["resource"],
  "editor:resource-assign": ["path", "property", "resource"],
  "editor:batch": ["operations"],
  "scene:set": ["scene", "path", "property", "value"],
  "scene:restore": ["path"],
};

function fieldToOption(name) {
  return FIELD_OPTION_NAMES[name] ?? name;
}

/**
 * Build the gdeck CLI argv for a (family, action, params, project) invocation.
 */
export function buildCliArgs(family, actionName, params, project, internal = {}) {
  const actionDef = getPiAction(family, actionName);
  if (!actionDef) throw new Error(`Unknown Flight Deck action: ${family}:${actionName}`);
  if (!actionDef.cliCommand) return [];
  const cliCommand = getCliCommand(actionDef.cliCommand);
  if (!cliCommand) throw new Error(`Unknown Flight Deck command: ${actionDef.cliCommand}`);

  for (const field of REQUIRED_FIELDS[`${family}:${actionName}`] ?? []) {
    if (!Object.hasOwn(params, field) || params[field] === undefined || (field !== "value" && (params[field] === null || params[field] === ""))) {
      throw new Error(`Missing required parameter for ${family}:${actionName}: ${field}`);
    }
  }
  params = { ...params };
  if (family === "editor" && ["inspect", "set"].includes(actionName)) params.path ??= ".";
  if (family === "editor" && actionName === "create") params.parent ??= ".";
  if (family === "run" && actionName === "watch") params.watch = true;

  const args = [actionDef.cliCommand];
  const cliAction = actionDef.cliCommand === "templates" ? actionName.replace(/^templates-/, "") : actionName;
  if (cliCommand.actions) args.push(cliAction);
  const allowedOptions = new Set(cliCommand.actions?.[cliAction]?.options ?? cliCommand.options);

  const positional = [];
  const options = [];
  let batchFile = null;
  let batchCommit = false;

  const fields = new Set(actionDef.parameters);
  if (allowedOptions.has("json")) fields.add("json");
  if (family === "editor" && actionName !== "batch" && allowedOptions.has("apply")) fields.add("apply");
  for (const fieldName of fields) {
    const value = params[fieldName];
    if (value === undefined || (value === null && fieldName !== "value")) continue;
    if (family === "editor" && actionName === "batch" && BATCH_FIELDS.has(fieldName)) {
      if (fieldName === "operations") {
        if (!internal.batchPath) throw new Error('Internal batch path is missing');
        batchFile = internal.batchPath;
      } else if (fieldName === "commit") {
        batchCommit = value === true;
      }
      continue;
    }
    const optionName = fieldToOption(fieldName);
    // An init timeout bounds the MCP child process; init has no --timeout option.
    if (fieldName === "timeout" && !allowedOptions.has(optionName)) continue;
    if (allowedOptions.has(optionName)) {
      if (FLAG_FIELDS.has(optionName)) {
        if (value === true) options.push(`--${optionName}`);
      } else {
        options.push(`--${optionName}`, String(value));
      }
    } else {
      positional.push(fieldName === "value" ? JSON.stringify(value) : String(value));
    }
  }

  if (batchFile) {
    positional.push(batchFile);
    options.push(batchCommit ? "--apply" : "--dry-run");
  }
  if (project) positional.push(project);
  // Protect negative JSON numbers and option-like node names. For `run`, --
  // starts game arguments instead, so its absolute project path stays before it.
  const result = cliCommand.passthrough
    ? [...args, ...positional, ...options]
    : [...args, ...options, "--", ...positional];
  // Catch contract drift before starting a process or touching the project.
  parseCliArguments(result);
  return result;
}

