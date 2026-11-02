# Flight Deck MCP server

The STDIO server exposes the six `gdeck_*` tool families and delegates execution
to the Flight Deck CLI. Configure the client to run Node.js 20+ with the absolute
path to `mcp/server.mjs`; pass the Godot project's absolute path in each tool call.

Install the locked dependencies from the repository root:

```sh
npm ci --ignore-scripts --prefix mcp
```

Restart the client's MCP connection after changing the server or its tool schemas.
The CLI is loaded by a fresh child process for each call.

## Regression tests

```sh
npm test --prefix mcp
GODOT_BIN=/absolute/path/to/godot npm run test:godot --prefix mcp
```

On macOS, the standard Godot executable path is
`/Applications/Godot.app/Contents/MacOS/Godot`.

The contract suite validates generated arguments with the real CLI parser and
checks schema validation, typed values, profile mappings and explicit mutation
flags. The smoke test uses a fresh MCP client/server and a temporary headless
Godot Editor with isolated user-data paths. It exercises named verification,
unit execution, typed property writes, batch preview/commit, undo, and deletion
refusal without `apply`, then removes its fixture and stops its processes.
The smoke test is skipped when `GODOT_BIN` is unset.

## Write semantics

Property `value` accepts native JSON numbers, booleans, strings, arrays, objects
and null. Batch operations use `commit: false` for preview and `commit: true`
for an approved commit. Destructive editor actions require explicit
`apply: true`; existing CLI and authenticated Bridge checks remain active.
Input validation does not substitute for user authorization.
