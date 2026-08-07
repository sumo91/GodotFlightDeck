---
name: godot-flight-deck
description: Operate Godot Flight Deck for Godot project setup, diagnostics, GDScript and unit tests, scenarios, visual regression, benchmarks, unified verification, internal desktop exports, and authenticated Editor automation. Use when an Agent needs to inspect, test, validate, export, or safely edit a Godot project.
compatibility: Requires Node.js 20+, Godot Flight Deck, a trusted project containing project.godot (Pi extension, MCP server, or CLI), and Godot 4.7 for the primary compatibility target.
---

# Godot Flight Deck

Use the structured `gdeck_*` tools when available: on Pi they come from the extension, in ZCode they arrive as `godot-flight-deck__gdeck_*` from the MCP server. Do not invoke `gdeck` through `bash` when these tools are available, and do not construct raw CLI arguments.

## Platform tool mapping

| Platform | Tool access |
|---|---|
| Pi (Cursor) | `gdeck_*` tools from the Pi extension |
| ZCode / MCP | `godot-flight-deck__gdeck_*` tools from the `godot-flight-deck` MCP server (`mcp/server.mjs`); always pass `project` explicitly |
| Plain shell | `bin\gdeck.cmd` or `node cli/gdeck.mjs` — fallback only |

## Standard workflow

1. Call `gdeck_project` with `action: "detect"` or `action: "doctor"`. Read each Doctor capability independently: `available`, `degraded`, `unavailable`, and `not_probed` are operational assessments, not product Verdicts. Never infer an unprobed Unit/import/Export capability from static prerequisites, and do not let an unavailable optional Editor capability block unrelated headless work.
2. If the project is not initialized, explain that chat approval is preparatory only, then call `gdeck_project` with `action: "init"`; the user must also approve the separate Pi system confirmation dialog.
3. Run the narrowest relevant `gdeck_validate` action first. For long Unit or Verify work, use `verbosity: "normal"` when bounded progress is useful; `compact` is the default and `diagnostic` still withholds raw output. Verbosity changes presentation only, never the Plan, timeout, oracle, confirmation, evidence authority, or Verdict. Use `gdeck_project` with `action: "evidence"` only to inspect bounded current/stale/unverifiable Final Reports and incomplete Journals; it is zero-write and must never be treated as resume, retry, or Verdict authority.
4. Use `gdeck_validate` with `action: "verify"` for the configured pipeline. When the project declares a named Verification Profile appropriate to the task, pass its exact `profile`; do not infer or invent one. Omit `profile` to preserve legacy `verify` behavior. If the selected pipeline includes exports, one aggregate system confirmation covers its exact planned targets because build artifacts will be replaced. A prior incomplete Journal never permits skipping a stage; every invocation starts from its newly resolved Plan.
5. Read the Result Envelope before logs or the compatibility summary. Report the selected Verification Profile, overall `PASSED` / `FAILED` / `INCONCLUSIVE` / `CANCELLED` Verdict, failure classification, decisive evidence, lane results, exact skipped/`not_configured`/`blocked` coverage, and artifact paths. Do not treat compatibility `status: passed` or a passing lane as proof of capabilities that were not configured, were skipped, or remained blocked.

## Test isolation

- Never use automated tests against a real player save.
- Require a deterministic fixture mode such as `--fixture-state` in project profiles. For code-based setup, use the profile `fixtureAdapter` field only with a `res://tests/` or `res://qa/` `.gd` file; adapter runs receive isolated user-data directories and a one-time capability. Never pass reserved `--gdeck-*` arguments through a normal `gdeck run` launch.
- Do not add test-only commands that remain active during a normal game launch.
- Use semantic events and project test commands instead of timing-only interaction where possible. A first-step `wait_event` can match initialization history; later waits require events from their own action window. Timeout reports include bounded exact matches from before that window.
- Do not update a visual baseline merely to make a failed visual test pass. Inspect the diff and obtain user approval before calling `baseline`.

## Editor workflow

1. Use `gdeck_editor` read actions (`status`, `sessions`, `tree`, `inspect`, `resource-inspect`) before proposing a write. Use confirmed `cleanup-sessions` only for metadata GDeck classifies as conclusively dead; live, unreachable, malformed, and unsafe sessions are preserved.
2. The Godot Editor must be running with the Flight Deck plugin enabled.
3. Writes require the local token and `editorBridge.allowWrites: true`; never request or display the token.
4. For `batch`, call it first with `commit: false` for a dry-run. Commit only after the dry-run succeeds and the user approves.
5. Use `undo`, `redo`, and `save` through `gdeck_editor`; do not edit `.tscn` or `.tres` concurrently with a live Editor Bridge transaction.
6. Respect every denied confirmation. Never retry through `bash` to bypass an unavailable UI or safety rejection.

## Internal exports

- Use `gdeck_release` with `templates-status` before installing templates.
- `export-init`, template installation, and exports require explicit confirmation.
- Exports are internal development artifacts only. Their atomic writes to declared project-generated build paths use the lower-friction `generated-write` tier. Generated and ordinary project writes use a short in-memory approval lease by default; it is created only after success and binds the exact project, action, and effect scope. Failed reuse revokes it, and projects may shorten or disable it. It never applies to baselines, deletion/destructive actions, stale Editor-session cleanup, host template installs, or chat text, and it is cleared on session shutdown.
- macOS development output may use ad-hoc signing. Native macOS smoke is opt-in and must run with isolated user directories, a minimal environment, a finite timeout, and whole-process-group cleanup on every exit path; Windows and Linux checks may be structure-only on a macOS host.
- `publishReady: false` means the artifacts are not certified for public distribution.
- Do not request publishing, signing credentials, notarization credentials, arbitrary output paths, environment overrides, or raw passthrough arguments.

## Failure handling

- Treat the Result Envelope as the first-result contract: `FAILED` requires qualified project-standard evidence; infrastructure, configuration, fixture, report, Plan-drift, timeout, process-spawn, and unqualified exit failures remain `INCONCLUSIVE`; confirmation denial/timeout and explicit abort are `CANCELLED`.
- Exit codes 127, 124, and 125 mean process spawn failure, execution timeout, and cleanup timeout respectively; report each distinctly from a test assertion failure. Process-backed operations use nested monotonic deadlines and must not be retried automatically. A bare exit code 1 with no qualifying structured or preflight evidence is `unknown`, even if log text resembles an assertion. Pi system confirmation denial and confirmation timeout are also distinct and must not be retried automatically.
- Read the bounded Result Envelope and then the structured-evidence failure-first summary. Pi withholds raw verify output (which may contain fixture, save, or token data) from the first result and cites a permission-restricted full-log path instead. Failed verify reports are summarized even when the command exits nonzero; use cited report, artifact, and full-log paths only when more detail is needed. Never infer a game-code fix from unstructured logs. If using a `rerun_same_target` next step, preserve its exact Verification Profile, runtime profile, seed, fixture adapter, and timeout context; never retry automatically.
- If project trust, confirmation, Editor authentication, path validation, or fixture isolation fails, stop and explain the prerequisite rather than weakening the guard. Do not require or probe Editor Bridge for a headless Verification Profile that did not select Editor evidence; direct Editor actions remain fail-closed.
- If verify reports Unit as `skipped`, state that no `tests/**/*_test.gd` coverage was executed; direct `gdeck_validate unit` remains strict. Unit schema v2 with `complete: false` is operational progress only: never render its terminal fields or use it to claim `PASSED`/`FAILED`; only a bound `complete: true` report or a legal legacy schema v1 report is terminal evidence.
- Treat `performance_timing.samples` and `slowest_frames` as bounded raw timing facts only. Never discard an outlier, infer subjective performance, invent a percentile policy, relax a project budget, or retry a failed benchmark to obtain a pass.
