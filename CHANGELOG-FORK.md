# Godot Flight Deck — Fork Changelog

Changelog-driven port from upstream notes `1.6.0 → 1.6.3`, plus agent-shell ergonomics.
This fork is **not** a byte-identical upstream release.

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
