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
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getCliCommand,
  getPiAction,
  getPiFamily,
  CLI_OPTIONS,
  PI_FIELDS,
} from "../registry/commands.mjs";
import { findGodotProject } from "../extensions/runtime.mjs";

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_FILE = join(TOOL_ROOT, "cli", "gdeck.mjs");
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 900;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

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
const BATCH_FIELDS = new Set(["batchName", "operations", "commit"]);

// Batch preflight files written during the current tool call (cleaned in finally).
const activeBatchFiles = [];

function fieldToOption(name) {
  return FIELD_OPTION_NAMES[name] ?? name;
}

function isOptionField(fieldName) {
  return Boolean(CLI_OPTIONS[fieldToOption(fieldName)]);
}

/**
 * Build the gdeck CLI argv for a (family, action, params, project) invocation.
 */
function buildCliArgs(family, actionName, params, project) {
  const actionDef = getPiAction(family, actionName);
  if (!actionDef) throw new Error(`Unknown Flight Deck action: ${family}:${actionName}`);
  const cliCommand = getCliCommand(actionDef.cliCommand);
  if (!cliCommand) throw new Error(`Unknown Flight Deck command: ${actionDef.cliCommand}`);

  const args = [actionDef.cliCommand];
  if (cliCommand.actions) args.push(actionName); // nested action commands (editor/scene/templates)

  const positional = [];
  const options = [];
  let batchFile = null;
  let batchCommit = false;

  for (const fieldName of actionDef.parameters) {
    const value = params[fieldName];
    if (value === undefined || value === null) continue;
    if (BATCH_FIELDS.has(fieldName)) {
      if (fieldName === "operations") {
        batchFile = join(tmpdir(), `gdeck-mcp-batch-${process.pid}-${Date.now()}.json`);
        writeFileSync(batchFile, `${JSON.stringify({ name: params.batchName ?? "mcp-batch", operations: value }, null, 2)}\n`, { encoding: "utf8" });
        activeBatchFiles.push(batchFile);
      } else if (fieldName === "commit") {
        batchCommit = value === true;
      }
      continue;
    }
    if (isOptionField(fieldName)) {
      const optionName = fieldToOption(fieldName);
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
  return [...args, ...positional, ...options];
}

/**
 * Convert a PI field definition to a JSON Schema property.
 */
function fieldToJsonSchema(fieldName) {
  const definition = PI_FIELDS[fieldName];
  if (!definition) return { type: "string" };
  const schema = {};
  if (definition.kind === "integer" || definition.kind === "number") schema.type = "number";
  else if (definition.kind === "boolean") schema.type = "boolean";
  else if (definition.kind === "enum") {
    schema.type = "string";
    schema.enum = [...definition.values];
  } else if (definition.kind === "operations") {
    schema.type = "array";
    schema.items = { type: "object" };
  } else {
    schema.type = "string";
  }
  for (const key of ["description", "minimum", "maximum", "minLength", "maxLength", "pattern"]) {
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
  return { type: "object", properties, additionalProperties: false };
}

function executeCli(args, timeoutSeconds) {
  const result = spawnSync(process.execPath, [CLI_FILE, ...args], {
    cwd: TOOL_ROOT,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: timeoutSeconds * 1000,
    killSignal: "SIGTERM",
    windowsHide: true,
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  const status = timedOut ? 124 : Number.isInteger(result.status) ? result.status : 127;
  return { status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), timedOut };
}

function formatResult(actionName, project, result) {
  const lines = [];
  if (result.stdout.trim()) lines.push(result.stdout.trimEnd());
  if (result.stderr.trim()) lines.push(result.stderr.trimEnd());
  if (result.timedOut) lines.push(`gdeck ${actionName}: timed out after the configured window (exit 124)`);
  else if (result.status !== 0) lines.push(`gdeck ${actionName}: exit code ${result.status}`);
  const text = lines.join("\n");
  return {
    content: [{ type: "text", text: text || `gdeck ${actionName}: completed (no output)` }],
    isError: result.status !== 0,
  };
}

function cleanupBatchFiles() {
  while (activeBatchFiles.length > 0) {
    const file = activeBatchFiles.pop();
    try { rmSync(file, { force: true }); } catch { /* bounded cleanup */ }
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

async function handleFamilyCall(familyName, params) {
  const family = getPiFamily(familyName);
  const actionName = params.action;
  const actionDef = getPiAction(familyName, actionName);
  if (!family || !actionDef) {
    return {
      content: [{ type: "text", text: `Unknown Flight Deck action: ${familyName}:${actionName}` }],
      isError: true,
    };
  }

  try {
    if (familyName === "project" && actionName === "detect") {
      const project = resolveProject(params.project);
      return { content: [{ type: "text", text: `Godot project detected: ${project}` }] };
    }
    const project = resolveProject(params.project);
    const args = buildCliArgs(familyName, actionName, params, project);
    const timeoutSeconds = Math.min(
      Math.max(Number(params.timeout ?? DEFAULT_TIMEOUT_SECONDS), 1),
      MAX_TIMEOUT_SECONDS,
    );
    return formatResult(actionName, project, executeCli(args, timeoutSeconds));
  } catch (error) {
    return {
      content: [{ type: "text", text: `gdeck ${actionName}: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  } finally {
    cleanupBatchFiles();
  }
}

const server = new Server(
  { name: "godot-flight-deck", version: "1.6.5" },
  { capabilities: { tools: {} } },
);

const FAMILY_NAMES = ["project", "validate", "release", "editor", "scene", "run"];

const toolDefs = FAMILY_NAMES.map((familyName) => {
  const family = getPiFamily(familyName);
  return {
    name: family.toolName,
    title: `Godot Flight Deck ${familyName}`,
    description: `${FAMILY_DESCRIPTIONS[familyName] ?? `Structured Flight Deck operations for ${familyName}.`} ${MUTATION_WARNING}`,
    inputSchema: familyInputSchema(family),
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const familyName = FAMILY_NAMES.find((key) => getPiFamily(key).toolName === name);
  if (!familyName) {
    return { content: [{ type: "text", text: `Unknown Flight Deck tool: ${name}` }], isError: true };
  }
  return handleFamilyCall(familyName, args ?? {});
});

const transport = new StdioServerTransport();
await server.connect(transport);
