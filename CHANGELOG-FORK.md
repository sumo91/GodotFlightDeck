# Godot Flight Deck — Fork Changelog

Changelog-driven port from upstream notes `1.6.0 → 1.6.3`, plus agent-shell ergonomics.
This fork is **not** a byte-identical upstream release.

## 1.6.9 (2026-11-08 — class APIs and code-quality revisions)

- Add CLI `class-info` for project-selected Godot built-in class APIs, with engine identity, inheritance, declaration owners, typed defaults, member filtering and explicit incomplete/error results. Queries run in an isolated empty project without loading game scripts or extensions.
- Class-info validation: 86 Node tests and all three real-Godot suites passed on macOS / Godot 4.7.2. GreyRanger engine queries and actual API calls passed 9,185 checks; its existing worktree changes were preserved. See [class-info validation](docs/missions/builtin-class-info/verification.md).

- Enforce frame-time budgets consistently; forward confirmed Pi destructive flags; retain watch errors across stream chunks and observation-window completion.
- Share an asynchronous process lifecycle across direct CLI and supervised execution, including bounded descendant cleanup. Stop Verify after cancellation and preserve cancellation evidence.
- Share Pi/MCP argv encoding and split verification snapshots, stage execution and report publication into separate modules included in package/service fingerprints.
- Validation: 83 Node tests and both real-Godot suites passed on macOS; isolated GreyRanger fast passed 123 tests / 4,943 assertions, and a short scenario passed. Oracle consumer migration, native Windows/Linux and real Pi UI acceptance remain open. See [validation record](docs/code-quality-validation-2026-11-08.md).

## 1.6.8 (2026-11-07 — same-process A/B capture)

- Add opt-in Scenario `capture_ab` steps through the existing CLI, MCP and Pi paths. Temporarily change supported visual node/camera properties in an isolated fixture process, capture A/B/restored A, restore property and processing state, and generate side-by-side images and heatmaps using the existing pixel comparator.
- Require unchanged scene/camera/semantic state and pixel-identical restoration; support a fixture-provided game-state digest. Uncontrolled comparisons remain `INCONCLUSIVE`, and image differences alone do not qualify a visual failure.
- Publish complete invocation-owned capture bundles only after the scenario succeeds and file hashes/dimensions match. Preserve earlier bundles and register pending directories for timeout/disconnect cleanup. Include bounded A/B summaries and artifacts in MCP, Pi and Verify.
- Prepare the global script class cache for scenario/visual/benchmark verification snapshots even when the project has no importable assets; this fixes scenario-only Verify hanging on an unloaded runtime probe.
- Exclude the local MCP dependency cache from release archives; install runtime dependencies from the committed lockfile.
- Validation on macOS / Godot 4.7.2: 54 Node tests and both real-Godot integration suites passed. An isolated GreyRanger snapshot completed all 10 scenario steps after real mouse input moved four party units; unchanged A/B had 0% pixel difference, hiding the player locator changed 0.8865%, and restored A matched exactly. Injected state drift returned `INCONCLUSIVE` without publication. Verify preserved the A/B artifacts, and `fast` passed 123 tests / 4,943 assertions. The original game worktree was unchanged; cross-platform execution, performance budgets and exports were not revalidated.

## 1.6.7 (2026-11-07 — diagnostics and scenario improvements)

- Add normalized project source locations to bounded engine diagnostics. Preserve quiet Unit engine logs separately, including when terminal reports are unavailable; MCP and Pi surface the hint without promoting logs to Verdict evidence.
- Add opt-in `fail_where` to event waits, preserving existing windows and incremental cursors. Add `FlightDeckProbe.state()` and `wait_state` for latest project-declared snapshots; failure conditions take precedence and release held inputs.
- Stage Capture output beside its destination. Publish only a matching successful report and PNG; failed or timed-out attempts preserve existing images.
- Accept `report_incomplete` in the verification journal, avoiding a secondary `report_io` classification for interrupted Unit evidence. Include the journal and Result Envelope implementation in MCP service build identities.
- Preserve the local MCP argument contract, response limits, private logs, cancellation/disconnect cleanup, finite long calls, runtime clocks and event-window regression coverage. The CLI, MCP and addon versions are aligned at 1.6.7; deployment uses the local package.
- Validation on macOS / Godot 4.7.2: 52 Node tests and the real-Godot MCP smoke passed. An isolated GreyRanger `45768db` snapshot passed `fast` (123 tests / 4,943 assertions); real mouse input moved all four party units. Blocked-input event/state controls failed on the next frame, source diagnostics identified an injected error at line 3, and a Capture timeout preserved the prior PNG hash. The original game worktree was unchanged. Cross-platform execution, long soaks, performance budgets and exports were not revalidated.

## 1.6.6 (2026-11-06 — GreyRanger feedback revisions)

- Match MCP arguments to the CLI contract: init timeouts stay in the MCP supervisor, template actions use their CLI names, and runtime profiles remain positional.
- Preserve JSON property types and negative values; supply root-node defaults when optional editor paths are omitted.
- Preserve batch names in private temporary files; expose explicit `apply` for destructive operations and keep preview as the batch default.
- Validate input schemas and required operands before execution; forward supported JSON output flags and activate watch mode from its action.
- Insert coordinator-generated verify/unit report options before `--`, preserving argument boundaries during the second CLI parse.
- Add contract tests and an isolated real-Godot MCP smoke test covering verification, unit execution, property writes, batch preview/commit, undo and explicit deletion. See `mcp/README.md`.

- Incrementally scan scenario wait-event windows while preserving complete event history and existing action-window semantics.
- Return bounded MCP schema 2 results, execution-bound Verdict envelopes, private logs with byte paging, and service build identities.
- Supervise MCP execution asynchronously with cancellation/disconnect cleanup and explicit scenario timeouts up to 7,800 seconds.
- Report diagnostic-only exit clues, process/snapshot timings, simulation and wall-clock measurements, and frozen-plan drift details without changing Verdict or performance budgets.
- Align package, MCP lockfile, addon, Editor Bridge, runtime probe and Unit report versions at 1.6.6. See `docs/greyranger-feedback-revision-plan.md` for validation and remaining coverage limits.

## 1.6.5 (Codex + ZCode integration)

- [x] `GDECK_CODEX_DIRECT=1` now selects the same in-process direct mode as `GDECK_CURSOR_COMPAT=1` — the Codex fork (1.6.0) is unified into this single fork and retired
- [x] Port `codex/gdeck.ps1` wrapper (direct mode + default `GODOT_BIN` Godot 4.7.1)
- [x] Doctor `cursor-compat-mode` check renamed to "Agent-shell compat mode" (identifier kept); detail covers both env vars
- [x] Windows ACL mode-bit skip and patch-level Godot version parsing were already present from earlier ports (verified against the Codex fork)
- [x] Codex agent skill `godot-flight-deck-codex` retargeted to the unified tool
- [x] New `mcp/` MCP server exposing the six `gdeck_*` tool families to ZCode (reuses `registry/commands.mjs` PI_FAMILIES; project resolution via `findGodotProject`)
- [x] ZCode wiring: `~/.zcode/cli/config.json` MCP server entry + `~/.zcode/skills/godot-flight-deck` junction; skill gained a platform tool-mapping section

## 1.6.4 (rebrand)

- [x] Rebrand to platform-neutral `GodotFlightDeck` (folder, package `godot-flight-deck`, launchers `bin/gdeck.cmd` / `bin/gdeck.mjs`)
- [x] Docs renamed: `README-CURSOR.md` → `README-FORK.md`, `CHANGELOG-CURSOR.md` → `CHANGELOG-FORK.md`
- [x] `GDECK_CURSOR_COMPAT` env and `cursor-compat-mode` doctor check keep their identifiers (semantics unchanged)

## Gap matrix (Phase 0)

| Item | Baseline `1.6.0-cursor.1` | Target |
|------|---------------------------|--------|
| 1.6.0 Evidence / Doctor / progress | present | keep |
| 1.6.1 Evidence reliability | partial (`path: null` flood, scan fail semantics) | port |
| 1.6.1 Unit progress cadence / elapsed | partial | port |
| 1.6.1 Cold-import plugin isolation | missing | port |
| 1.6.2 Pi `/reload` ESM cache | N/A on Cursor | skip |
| 1.6.3 Real frame timing | missing (`TIME_PROCESS` as per-frame) | port |
| Cursor Job Object compat | present | keep / guard |
| Scenario event ergonomics | missing | add |
| Verify failure digest | missing | add |
| Doctor addon / cursor checks | missing | add |

## 1.6.3-cursor.1

### From upstream 1.6.1 (ported)

- [x] Evidence Index: timeout, sealed/bound priority, result limit, classification counts, less `path: null` flood
- [x] Evidence scan status: `complete` / `incomplete` / `unverifiable`; incomplete no longer exits as failure
- [x] Unit progress: cadence covers timeout, higher compact budget, terminal elapsed fix, displayed-update count
- [x] Cold snapshot import: temporarily disable only Flight Deck Editor plugin; atomic `project.godot` restore; drift → `plan_drift`; no auto-retry

### From upstream 1.6.3 (ported)

- [x] Real wall-clock frame timing via adjacent `_process` ticks
- [x] `average_frame_ms`, `worst_frame_ms`; `average_fps` from average frame time
- [x] Slow frames sorted by real `frame_ms`
- [x] Budget `worstFrameMsLte`; keep `worst_process_ms` compatibility field
- [x] Avoid treating repeated `TIME_PROCESS` monitor readings as distinct spikes

### Cursor-local

- [x] Scenario `traceEvents` / `--trace-events`, `wait_event.since: "command"`, `includeHistory`
- [x] Scenario lint warnings for risky command→wait patterns
- [x] Verification Failure Digest (short Agent-readable summary)
- [x] Doctor checks: `cursor-compat-mode`, `addon-version-match`
- [x] `gdeck sync-addon` to refresh project addon from this fork
- [x] Document Pi 1.6.2 as intentionally skipped
- [x] **P0** Agent navigation: `gdeck help [domain]`, `gdeck editor describe [action]`, decision tree in help/skill
- [x] **P1** Editor Bridge layers: core-read / core-write / supplementary-write / destructive; `supplementaryEnabled`; destructive `--apply`; batch defaults to preview
- [x] **P1 hardening**: Bridge enforces `supplementaryEnabled` + `confirm_apply`; CLI validates batch operations; `loadConfig` deep-merges `editorBridge` (`1.6.3-cursor.2`)

### Skipped

- Upstream 1.6.2 Pi reload compatibility module (Cursor uses CLI only)
