#!/usr/bin/env node
/**
 * GodotFlightDeck MCP server — exposes the gdeck_* tool families (project,
 * validate, release, editor, scene, run) to ZCode and other MCP clients.
 *
 * Tools mirror the Pi extension's names and actions (registry/commands.mjs
 * PI_FAMILIES) and delegate to `cli/gdeck.mjs` via a bounded child process.
 * Mutating actions are NOT auto-confirmed here: the CLI enforces its own
 * guards (--apply for destructive editor actions), and agents must obtain
 * explicit user approval before calling mutating tools.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import Ajv from "ajv";
import { executeSupervised } from "./supervisor.mjs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { formatResult, readLog, boundedText } from "./result.mjs";
export { formatResult } from "./result.mjs";
import { fileURLToPath } from "node:url";
import {
  getCliCommand,
  getPiAction,
  getPiFamily,
  PI_FIELDS,
  parseCliArguments,
} from "../registry/commands.mjs";
import { findGodotProject } from "../extensions/runtime.mjs";
import { generateInvocationIdentity } from "../cli/evidence-contract.mjs";
import { resolveVerificationPlan, verificationPlanSummary } from "../cli/verification-plan.mjs";

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_FILE = join(TOOL_ROOT, "cli", "gdeck.mjs");
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 900;
export const MAX_SCENARIO_TIMEOUT_SECONDS = 7800;
export const SERVICE_INFO = Object.freeze({
  name: "godot-flight-deck", version: JSON.parse(readFileSync(join(TOOL_ROOT, "package.json"), "utf8")).version,
  schemaVersion: 2,
  buildId: createHash("sha256").update(Buffer.concat([
    "mcp/server.mjs", "mcp/result.mjs", "mcp/supervisor.mjs", "cli/gdeck.mjs", "registry/commands.mjs",
    "godot/addons/flight_deck/scenario_runner.gd",
    "godot/addons/flight_deck/runtime_probe.gd", "cli/process-runner.mjs", "cli/verification-plan.mjs",
    "cli/performance-budgets.mjs", "cli/plan-diagnostics.mjs", "cli/diagnostics.mjs", "cli/runtime-clock.mjs",
    "cli/result-envelope.mjs", "cli/evidence-journal.mjs", "cli/capture-ab.mjs",
    "godot/addons/flight_deck/capture_ab.gd", "godot/addons/flight_deck/visual_diff.gd",
  ].map(path => readFileSync(join(TOOL_ROOT, path))))).digest("hex"),
  startedAt: new Date().toISOString(), processId: process.pid,
});

const MUTATION_WARNING =
  "Mutating actions (init, sync-addon, baseline, export-init, export, editor writes, scene set, batch) require explicit user approval before invocation. Destructive editor actions additionally need apply=true or commit=true.";

const FAMILY_DESCRIPTIONS = {
  project: "Detect, initialize, or diagnose the active trusted Godot project using structured Flight Deck operations.",
  validate: "Run GDScript checks, unit tests, scenarios, visual regression, benchmarks, baselines, or unified verification (check/unit/scenario/baseline/visual/benchmark/verify/oracle).",
  release: "Inspect/install templates, initialize exports, or produce internal desktop builds. Public publishing is intentionally unavailable.",
  editor: "Query or safely modify the running Godot Editor through the authenticated local Bridge. Batch defaults to dry-run and writes require confirmation.",
  scene: "Inspect or edit .tscn scene files headlessly: doctor checks integrity, set edits a node property (dry-run by default, apply commits), restore rolls back a snapshot.",
  run: "Launch the Godot project headlessly: query injects white-listed read-only runtime queries with deterministic seed/frames; watch streams stdout/stderr live (timeout ends the observation window).",
};

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

// Batch preflight files written during the current tool call (cleaned in finally).
const activeBatchFiles = [];

function fieldToOption(name) {
  return FIELD_OPTION_NAMES[name] ?? name;
}

/**
 * Build the gdeck CLI argv for a (family, action, params, project) invocation.
 */
export function buildCliArgs(family, actionName, params, project) {
  const actionDef = getPiAction(family, actionName);
  if (!actionDef) throw new Error(`Unknown Flight Deck action: ${family}:${actionName}`);
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
        const batchDirectory = mkdtempSync(join(tmpdir(), "gdeck-mcp-batch-"));
        activeBatchFiles.push(batchDirectory);
        batchFile = join(batchDirectory, "batch.json");
        writeFileSync(batchFile, `${JSON.stringify({ name: params.name ?? "mcp-batch", operations: value }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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

/**
 * Convert a PI field definition to a JSON Schema property.
 */
export function fieldToJsonSchema(fieldName) {
  const definition = PI_FIELDS[fieldName];
  if (!definition) return { type: "string" };
  const schema = {};
  if (definition.kind === "integer" || definition.kind === "number") schema.type = definition.kind;
  else if (definition.kind === "boolean") schema.type = "boolean";
  else if (definition.kind === "enum") {
    schema.type = "string";
    schema.enum = [...definition.values];
  } else if (definition.kind === "operations") {
    schema.type = "array";
    schema.items = { type: "object" };
  } else if (definition.kind !== "any") {
    schema.type = "string";
  }
  for (const key of ["description", "minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems"]) {
    if (definition[key] !== undefined) schema[key] = definition[key];
  }
  return schema;
}

function familyInputSchema(family) {
  const properties = {
    action: { type: "string", enum: Object.keys(family.actions), description: "Operation to perform" },
  };
  for (const entry of family.fields) {
    const publicName = typeof entry === "string" ? entry : entry.name;
    const fieldName = typeof entry === "string" ? entry : entry.field;
    properties[publicName] = fieldToJsonSchema(fieldName);
  }
  if (family.toolName === "gdeck_editor") {
    properties.apply = fieldToJsonSchema("apply");
    properties.json = fieldToJsonSchema("json");
  }
  const schema = { type: "object", properties, required: ["action"], additionalProperties: false };
  if (family.toolName === "gdeck_validate") {
    properties.timeout.maximum = MAX_SCENARIO_TIMEOUT_SECONDS;
    properties.timeout.description = "Wall-clock seconds; default 120. Explicit scenario calls allow up to 7800; other actions allow up to 900.";
    schema.allOf = [{
      if: { properties: { action: { const: "scenario" } } },
      else: { properties: { timeout: { maximum: MAX_TIMEOUT_SECONDS } } },
    }];
  }
  return schema;
}

export function executionTimeoutSeconds(params) {
  return Number(params.timeout ?? DEFAULT_TIMEOUT_SECONDS);
}

function executeCli(args, timeoutSeconds, signal, project) {
  return executeSupervised(process.execPath, [CLI_FILE, ...args], {
    cwd: TOOL_ROOT, timeoutSeconds, signal, lifecycleProjectRoots: [project],
  });
}

export function withReportArgument(args, action, reportPath) {
  if (!reportPath) return args;
  const flag = action === "scenario" ? "--report" : "--output";
  const separator = args.indexOf("--");
  const insertion = separator < 0 ? args.length : separator;
  const result = [...args.slice(0, insertion), flag, reportPath, ...args.slice(insertion)];
  parseCliArguments(result);
  return result;
}

export function cleanupBatchFiles() {
  while (activeBatchFiles.length > 0) {
    const file = activeBatchFiles.pop();
    try { rmSync(file, { recursive: true, force: true }); } catch { /* bounded cleanup */ }
  }
}

/**
 * Resolve the Godot project for a tool call. Unlike the Pi extension (which
 * pins one trusted project per session), the MCP server trusts the project
 * path the agent passes — ZCode's permission system gates the tool call.
 */
function resolveProject(requestedPath) {
  const project = findGodotProject(requestedPath ?? process.cwd());
  if (!project) throw new Error(`No Godot project found from: ${requestedPath ?? process.cwd()}`);
  return project;
}

async function handleFamilyCall(familyName, params, signal, onPlan) {
  const family = getPiFamily(familyName);
  const actionName = params.action;
  const actionDef = getPiAction(familyName, actionName);
  if (!family || !actionDef) {
    return {
      content: [{ type: "text", text: `Unknown Flight Deck action for ${familyName}` }],
      structuredContent: { schemaVersion: 1, action: { family: familyName, status: "rejected" }, service: SERVICE_INFO },
      isError: true,
    };
  }

  try {
    validateToolArguments(familyName, params);
    if (familyName === "project" && actionName === "detect") {
      const project = resolveProject(params.project);
      return { content: [{ type: "text", text: `Godot project detected: ${project}\nService ${SERVICE_INFO.version}; schema ${SERVICE_INFO.schemaVersion}; build ${SERVICE_INFO.buildId}; started ${SERVICE_INFO.startedAt}` }],
        structuredContent: { schemaVersion: 1, project, service: SERVICE_INFO } };
    }
    const project = resolveProject(params.project);
    let args = buildCliArgs(familyName, actionName, params, project);
    let reportPath = "";
    if (familyName === "validate" && ["verify", "unit", "scenario"].includes(actionName)) {
      const directory = join(project, ".gdeck", "reports");
      mkdirSync(directory, { recursive: true });
      reportPath = join(directory, `${actionName}-mcp-${randomUUID()}.json`);
      args = withReportArgument(args, actionName, reportPath);
    }
    const timeoutSeconds = executionTimeoutSeconds(params);
    if (familyName === "validate" && actionName === "verify") {
      const invocationIdentity = generateInvocationIdentity();
      const plan = resolveVerificationPlan({ project, outputPath: reportPath, timeoutSeconds,
        verificationProfile: params.profile, invocationIdentity });
      const insertion = args.indexOf("--");
      const index = insertion < 0 ? args.length : insertion;
      args.splice(index, 0, `--gdeck-internal-verify-plan-digest=${plan.digest}`, `--gdeck-internal-invocation-identity=${invocationIdentity}`);
      await onPlan?.(verificationPlanSummary(plan));
    }
    return formatResult(actionName, project, await executeCli(args, timeoutSeconds, signal, project),
      { family: familyName, reportPath, verbosity: params.verbosity, service: SERVICE_INFO });
  } catch (error) {
    return {
      content: [{ type: "text", text: boundedText(`gdeck ${actionName}: ${error instanceof Error ? error.message : String(error)}`) }],
      structuredContent: { schemaVersion: 1, action: { family: familyName, name: actionName, status: "rejected" }, service: SERVICE_INFO },
      isError: true,
    };
  } finally {
    cleanupBatchFiles();
  }
}

const server = new Server(
  { name: SERVICE_INFO.name, version: `${SERVICE_INFO.version}+${SERVICE_INFO.buildId.slice(0, 12)}` },
  { capabilities: { tools: {} } },
);

const FAMILY_NAMES = ["project", "validate", "release", "editor", "scene", "run"];

export const toolDefs = FAMILY_NAMES.map((familyName) => {
  const family = getPiFamily(familyName);
  return {
    name: family.toolName,
    title: `Godot Flight Deck ${familyName}`,
    description: `${FAMILY_DESCRIPTIONS[familyName] ?? `Structured Flight Deck operations for ${familyName}.`} ${MUTATION_WARNING}`,
    inputSchema: familyInputSchema(family),
  };
});

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map(toolDefs.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
const logTool = {
  name: "gdeck_log", description: "Read captured output from this MCP session by log ID and byte offset. Base64 pages preserve exact bytes; SHA256 covers the complete captured stream. Never executes or retries a command.",
  inputSchema: { type: "object", additionalProperties: false, required: ["logId"], properties: {
    logId: { type: "string", maxLength: 36 }, stream: { type: "string", enum: ["stdout", "stderr"] },
    offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 32768 },
  } },
};
const validateLog = ajv.compile(logTool.inputSchema);
export function validateToolArguments(familyName, params) {
  const validate = validators.get(getPiFamily(familyName)?.toolName);
  if (!validate || !validate(params)) {
    throw new Error(`Invalid ${familyName} arguments: ${validate ? ajv.errorsText(validate.errors) : "unknown tool family"}`);
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...toolDefs, logTool] }));

// Preserve the previous single-call mutation/batch lifetime while execution is async.
let callQueue = Promise.resolve();
const activeCalls = new Set();
server.onclose = () => { for (const controller of activeCalls) controller.abort(); };
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  if (name === "gdeck_log") {
    try {
      if (!validateLog(args ?? {})) throw new Error(`Invalid log arguments: ${ajv.errorsText(validateLog.errors)}`);
      const page = readLog(args);
      return { content: [{ type: "text", text: `Captured ${page.stream}: bytes ${page.offset}..${page.nextOffset} of ${page.totalBytes}; eof=${page.eof}. Exact bytes are in structuredContent.data (base64).` }], structuredContent: page };
    } catch (error) { return { content: [{ type: "text", text: boundedText(error.message) }], isError: true }; }
  }
  const familyName = FAMILY_NAMES.find((key) => getPiFamily(key).toolName === name);
  if (!familyName) {
    return { content: [{ type: "text", text: "Unknown Flight Deck tool" }], isError: true };
  }
  const controller = new AbortController();
  activeCalls.add(controller);
  const abort = () => controller.abort();
  extra.signal.addEventListener("abort", abort, { once: true });
  if (extra.signal.aborted) abort();
  const progressToken = request.params._meta?.progressToken;
  const onPlan = progressToken === undefined ? undefined : async plan => {
    try {
      await extra.sendNotification({ method: "notifications/progress", params: {
        progressToken, progress: 0, total: 1, message: boundedText(`Verification plan frozen: ${JSON.stringify(plan)}`, 6144),
      } });
    } catch { /* Presentation delivery never changes execution or evidence. */ }
  };
  const pending = callQueue.then(() => handleFamilyCall(familyName, args ?? {}, controller.signal, onPlan)).finally(() => {
    activeCalls.delete(controller);
    extra.signal.removeEventListener("abort", abort);
  });
  callQueue = pending.catch(() => {});
  return pending;
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.once("end", () => server.close());
}
