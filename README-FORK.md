# Godot Flight Deck — Fork Notes

Path: `D:\03_Godot\04_Tools\GodotFlightDeck`

Version: **1.6.8** (changelog-driven fork of upstream notes `1.6.0 → 1.6.3`, plus agent-shell ergonomics / P0–P1 Editor Bridge layering / Codex integration).

The upstream bundle at `D:\03_Godot\GodotFlightDeck-1.6.0-Windows` is left untouched.

## Why this fork exists

Upstream CLI always wraps every invocation in `process-runner` (nested Node supervisor). Inside Cursor’s agent shell that already uses a Windows Job Object, the nested supervisor hits:

```text
AssignProcessToJobObject: (50) 不支持该请求
```

and hangs — even for `gdeck version`.

## Fork changes (agent-shell compatible)

1. **Default `GDECK_CURSOR_COMPAT=1`** (set `=0` to restore upstream supervisor behavior).
2. Skip the outer `superviseCliInvocation` and run `main()` in-process.
3. Direct mode uses the shared asynchronous process lifecycle in-process, with bounded TERM/KILL cleanup, instead of nesting another Node supervisor.
4. Launcher: `bin\gdeck.cmd` / `bin\gdeck.mjs` sets `GODOT_BIN` default to Godot 4.7.1.
5. **Windows export-template detection**: `templateDirectories()` includes `%APPDATA%\Godot\export_templates`.
6. **Cold import** temporarily disables only the Flight Deck Editor plugin, then atomically restores `project.godot`.
7. **Scenario ergonomics**: `--trace-events`, `wait_event.since: "command"`, `includeHistory`, static lint warnings.
8. **Verify Failure Digest** for short Agent-readable failure summaries.
9. **Doctor checks**: `cursor-compat-mode`, `addon-version-match`.
10. **`gdeck sync-addon`** refreshes project addon from this CLI (reuses init transaction).
11. **P0 Agent navigation**: `gdeck help [verify|editor|scenario|project]`, `gdeck editor describe [action]`.
12. **P1 Editor Bridge layering**: core-read / core-write / supplementary-write / destructive; `editorBridge.supplementaryEnabled`; destructive actions require `--apply`; `editor batch` previews by default.

Direct and supervised modes share process cleanup. POSIX regressions include stubborn descendants, cancellation and inherited output pipes. Windows Agent Shell Job Object compatibility and native process-tree cleanup require Windows validation; macOS results do not certify them.

### Skipped upstream item

- **1.6.2 Pi `/reload` ESM cache** — not applicable; Cursor uses the CLI, not Pi Extension tools.

### Benchmark note (1.6.3)

`average_frame_ms` / `worst_frame_ms` use adjacent `_process` wall-clock intervals.
`worst_process_ms` remains as a compatibility field from Godot `TIME_PROCESS` (not real per-frame data).
Prefer budget `worstFrameMsLte` for new performance gates.

## Quick use (from any Godot project)

```powershell
$gdeck = "D:\03_Godot\04_Tools\GodotFlightDeck\bin\gdeck.cmd"
& $gdeck version
& $gdeck doctor .
& $gdeck check .
```

## Agent navigation (P0)

```powershell
& $gdeck help
& $gdeck help editor
& $gdeck help verify
& $gdeck editor describe
& $gdeck editor describe delete --json
```

## Editor Bridge policy (P1)

In `.gdeck/config.json`:

```json
"editorBridge": {
  "host": "127.0.0.1",
  "port": 47835,
  "allowWrites": false,
  "supplementaryEnabled": false,
  "resourceRoots": ["res://resources/"]
}
```

- **core-read** (default): status, sessions, tree, inspect, logs, resource-inspect  
- **core-write** (needs `allowWrites`): set, create, save, undo, redo  
- **supplementary-write** (needs `allowWrites` + `supplementaryEnabled`): reorder, resource-create/set/assign  
- **destructive** (needs `--apply`, and writes where applicable): delete, resource-delete, cleanup-sessions, batch `--apply`  
- `gdeck editor batch <file>` **previews by default**; commit only with `--apply`

## Project init / addon sync (mutates project — ask human first)

```powershell
& $gdeck init .
# or, when only refreshing the addon after a fork upgrade:
& $gdeck sync-addon .
```

## Discoverability for Cursor agents

Personal skill: `C:\Users\HYMOD\.cursor\skills\godot-flight-deck-cursor\SKILL.md`

See also `CHANGELOG-FORK.md`.
