# Flight Deck MCP server

The STDIO server exposes the six `gdeck_*` tool families plus `gdeck_log`, and delegates execution
to the Flight Deck CLI. Configure the client to run Node.js 20+ with the absolute
path to `mcp/server.mjs`; pass the Godot project's absolute path in each tool call.

Install the locked dependencies from the repository root:

```sh
npm ci --ignore-scripts --prefix mcp
```

Reconnect the client's MCP connection after changing the server, its loaded
dependencies, or its tool schemas. The CLI is loaded by a fresh child process for
each call, so CLI-only updates with an unchanged MCP contract do not require a reconnect.
Routine development and regression checks can use the CLI directly.

## Results and logs (MCP schema 2)

Every executed action returns `structuredContent` with action status, process
exit/timeout/cancellation/cleanup facts, report location, and captured log
references. Verify forwards the CLI's execution-bound `resultEnvelope` unchanged;
Unit and Scenario project their invocation-owned reports through the same Verdict
classifier. Missing, incomplete or invalid reports cannot produce a passing
Verdict. Actions without a validation report expose operational status, which is
not a product Verdict. Small JSON action payloads are available as `data`.
Structured report reads are limited to 8 MiB. An oversized report is not accepted
as terminal evidence; its path remains available for inspection. Event-history
storage/streaming is a separate follow-up, not silently truncated here.

Text is limited to **8 KiB** in all verbosity modes. Event history and raw output
are withheld, including in `diagnostic`; verbosity never changes evidence or
execution. Full captured stdout/stderr live in separate `0600` files inside a
private temporary directory. `logs.complete: false` discloses upstream capture
loss (the process runner retains at most 64 MiB total); a truncated capture must
not be described as the complete emitted log. Verify may also cite stage logs in
its existing Envelope. Temporary files follow host temp retention; GDeck does
not automatically delete the cited files when the connection closes.

Read a log on demand with:

```json
{"name":"gdeck_log","arguments":{"logId":"<logs.id>","stream":"stdout","offset":0,"limit":8192}}
```

Pages contain base64 bytes in `structuredContent.data`, `nextOffset`, `eof`, and
the SHA256 of the complete captured stream. Concatenate decoded bytes before
UTF-8 decoding or hash verification. Maximum page size is 32 KiB; offsets are
bytes. This endpoint accepts only IDs issued by this session, never arbitrary
paths. It remembers the most recent 128 calls; older logs remain at the cited
file paths. Reading logs never retries execution. Treat raw logs as private.

## Finite long calls and connection identity

The default execution timeout remains 120 seconds. Only an explicit Scenario
call may request up to 7,800 seconds; other actions remain capped at 900 seconds.
The async supervisor preserves the event loop for cancellation, owns process-tree
cleanup, and cancels active/queued calls when the MCP connection closes. There is
no persistent task, resume or automatic retry. SDK clients must choose a request
deadline greater than execution plus cleanup (e.g. timeout + 30 seconds).

`gdeck_project(action="detect")` and executed action results include `service`:
package version, implementation build fingerprint, MCP schema version, PID and
process start time. The MCP initialize version also includes the build prefix.
When verifying an MCP update, reconnect and compare this identity through the
actual client connection; an old server retains its loaded code and startup identity.
If detection has no service identity or validation still returns raw text without
`structuredContent`, the connection has not demonstrated schema 2 support. Reconnect
and check detection again; a passing CLI run alone does not verify the MCP update.
An old MCP connection does not block independent CLI work.

To test this source checkout through a fresh structured MCP session, without
changing the installed server, save a normal MCP request as JSON and run:

```sh
node mcp/call.mjs /absolute/request.json /absolute/response.json
```

The helper persists the exact request and response, with private permissions.
It does not accept CLI passthrough arguments.

## Diagnostics, clocks and frozen inputs

`diagnostics` is explicitly `diagnostic_only`. It exposes fixed error categories,
the first matching retained line (stderr before stdout, not cross-stream time
order), known leaked resource types, and structured assertion completion. It
never copies arbitrary error text or changes the Result Envelope. In particular,
passed assertions followed by exit 1 remain `INCONCLUSIVE / unknown`.

The first result also includes a normalized `res://` source path and line when
Godot supplies an adjacent project location, with fixed parse/compile/runtime
error descriptions. Arbitrary engine messages stay in private logs. Unit retains
its quiet child output beside the exact report as `.engine-stdout.log` and
`.engine-stderr.log`, with a bounded `.diagnostics.json` companion. These hints
remain available when the Unit report is missing or incomplete and never qualify
a Verdict. `diagnostics.engine` and failed Verify stage diagnostics cite these
files; read them via their local paths, not the session-only `gdeck_log` ID.

Verify reports retain failed/error-bearing stage wrapper stdout/stderr under the
invocation's private evidence namespace, with `0600` files, hashes and truncation
disclosure. These stage logs use the CLI's decoded UTF-8 streams; MCP log pages
preserve exact captured bytes. A wrapper may already have withheld nested output;
these references do not claim to reconstruct unavailable engine logs.

`timings` separates snapshot copy, validation, import, sealing and removal.
Supervised processes expose monotonic launch, execution and cleanup durations;
Verify stages also carry up to 16 bound child-process timing records when available.
The compatibility direct-process mode reports combined child duration and
`phaseBreakdownAvailable: false`; it cannot separate launch/run/cleanup.
MCP returns at most six stage diagnostics (failures first); inspect the referenced
aggregate report for the rest. Measurements are facts, not new timeout budgets.

Runtime reports include `clocks`: reserved metadata derived from the actual launcher arguments selects
`fixed_step_throughput` or `real_time`, and simulation seconds sum `_process(delta)`.
Without this metadata the mode is `unknown`. Godot consumes engine options such
as `--fixed-fps` before exposing `OS.get_cmdline_args()`, so the probe cannot infer
their absence as real-time mode (see the [Godot OS contract](https://docs.godotengine.org/en/stable/classes/class_os.html#class-os-method-get-cmdline-args)).
Fixed FPS is a simulation step, not a wall-clock rendering cap. Probe warmup and
sampling wall time refer to the probe's frame window; project fixture sampling
windows and game 1×/2×/4× speeds remain project-defined. Synchronous fixture setup
and command dispatch are measured separately. Async continuations and total tool
overhead are not measured; scenario tick time includes command dispatch, so these
figures must not be added as disjoint costs. Existing raw frame samples and
outliers are retained under the same sampling rules.

Verify freezes the exact resolved plan before execution. Clients requesting MCP
progress receive a bounded initial plan/scope notification; the source helper
records it. Final results also expose plan, input, configuration and source-tree
digests. Drift diagnostics name the detection phase, stage and changed categories
(code, fixtures, configuration, resources, documents or other inputs), while
preserving `plan_drift` and rejecting current-stage evidence. Earlier results
remain evidence for the original inputs only. Generated exclusions are declared;
`.gdeck/config.json` is still semantically bound and UID sidecars are bound
separately. There is no global edit lock. A project's rule to run `fast` after a
documentation change is its own development rule, not a GDeck scheduling policy.

## Regression tests

```sh
npm test --prefix mcp
GODOT_BIN=/absolute/path/to/godot npm run test:godot --prefix mcp
```

On macOS, the standard Godot executable path is
`/Applications/Godot.app/Contents/MacOS/Godot`.

The contract suite validates generated arguments with the real CLI parser and
checks schema validation, typed values, profile mappings and explicit mutation
flags, response-size bounds, paged-log hashes, and failure classification.
Lifecycle fixtures exercise normal exit, timeout, cancellation and client
disconnect with descendants that refuse SIGTERM; POSIX results do not certify
Windows process cleanup. The smoke test uses a fresh MCP client/server and a temporary headless
Godot Editor with isolated user-data paths. It exercises named verification,
unit execution, typed property writes, batch preview/commit, undo, and deletion
refusal without `apply`, then removes its fixture and stops its processes.
The smoke test is skipped when `GODOT_BIN` is unset.

The smoke also checks a real failed Unit stage, private diagnostics, and both
Godot regression suites. Its isolated home is outside the frozen source tree so
engine log writes do not masquerade as source edits.

`godot/tests/semantic_event_window_test.gd` is a project-hosted regression suite:
copy it into an initialized project's `tests/` directory, install this checkout's
`scenario_runner.gd`, then use structured Unit with a matching filter. It counts
actual events scanned by the runtime probe and exercises history, action/command
windows, same-frame matches and timeout diagnostics. Restore temporary project
changes after collecting evidence. Incremental waits retain the full append-only
event history and final assertions; this release does not bound event storage.

`godot/tests/runtime_clock_test.gd` compares equal simulation steps under different
wall-clock delays. Install the matching `runtime_probe.gd` and prepare a fresh
project's import/class cache with structured `check` before direct Unit execution.

`godot/tests/scenario_state_test.gd` covers latest-state waits, explicit failure
conditions, request identity, legacy event windows, incremental scanning and
input release. The real-Godot smoke suite installs it alongside the existing
clock and event-window suites, and checks source diagnostics for both terminal
test-load failures and an incomplete Unit runner failure.

Scenario steps also accept `capture_ab: { name, changes: [{ path, property, value }] }`.
Use the existing `gdeck_validate` scenario action with an isolated fixture profile;
no new tool or arbitrary output path is needed. The runtime captures A, B and a
restored A in one process, checks state/camera invariants and exact restoration,
and creates the side-by-side image and difference heatmap. Only successful runs
publish a complete, hash-checked bundle. `capturePairs` includes bounded metrics
and artifact paths; private comparison reports retain the declared changes and
control evidence. Verify preserves these artifacts and classifies uncontrolled
comparisons as `INCONCLUSIVE / precondition`. See the root README for supported
properties and the optional `gdeck_capture_state()` fixture guard.

`capture-ab.test.mjs` exercises publication and result projection.
`capture-ab-godot.test.mjs` covers rendered differences, no-op pairs, camera zoom,
restoration, render drift, rejected properties, later scenario failure, timeout
cleanup, and Verify. The shared pixel comparator is checked by
`godot/tests/capture_ab_test.gd`; baseline comparison keeps its existing metrics.

## Write semantics

Property `value` accepts native JSON numbers, booleans, strings, arrays, objects
and null. Batch operations use `commit: false` for preview and `commit: true`
for an approved commit. Destructive editor actions require explicit
`apply: true`; existing CLI and authenticated Bridge checks remain active.
Input validation does not substitute for user authorization.
