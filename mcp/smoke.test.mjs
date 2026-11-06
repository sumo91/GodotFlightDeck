import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const godot = process.env.GODOT_BIN;
const serverPath = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');

test('MCP calls reach Godot with correct types, preview, commit, undo and explicit delete', { skip: !godot, timeout: 90000 }, async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'gdeck-mcp-smoke-')));
  // Logs written by Godot are generated state, not source inputs. Keep the
  // isolated home outside the frozen project tree so failures cannot drift it.
  const isolatedHome = realpathSync(mkdtempSync(join(tmpdir(), 'gdeck-mcp-smoke-home-')));
  const env = {
    PATH: process.env.PATH, HOME: isolatedHome,
    XDG_DATA_HOME: isolatedHome, XDG_CONFIG_HOME: isolatedHome, XDG_CACHE_HOME: isolatedHome,
    GODOT_BIN: godot, GDECK_CODEX_DIRECT: '1', GDECK_CURSOR_COMPAT: '1',
  };
  const client = new Client({ name: 'gdeck-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'pipe' });
  transport.stderr?.resume();
  let editor;
  const text = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const call = async (name, args, expectError = false) => {
    const result = await client.callTool({ name, arguments: { project, ...args } });
    assert.equal(Boolean(result.isError), expectError, text(result));
    return result;
  };
  const edit = async args => {
    const output = await call('gdeck_editor', { json: true, ...args });
    const parsed = output.structuredContent.data ?? JSON.parse(readFileSync(output.structuredContent.logs.streams.stdout.path, 'utf8'));
    return parsed.result ?? parsed;
  };
  try {
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n[application]\nconfig/name="GDeck MCP Regression"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
    writeFileSync(join(project, 'main.tscn'), '[gd_scene format=3]\n[node name="TestRoot" type="Node2D"]\n');
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.find(t => t.name === 'gdeck_editor').inputSchema.properties.apply.type, 'boolean');
    await call('gdeck_project', { action: 'init', timeout: 30 });
    await call('gdeck_validate', { action: 'check', timeout: 30 });

    const portProbe = createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const port = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
    const configPath = join(project, '.gdeck', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.godotPath = godot;
    config.editorBridge.allowWrites = true;
    config.editorBridge.port = port;
    config.verificationProfiles = { fast: { check: true, unit: 'auto' } };
    writeFileSync(configPath, JSON.stringify(config));
    // Exercise the coordinator too: it injects report options after MCP argv
    // construction, so validating only the first CLI parse misses regressions.
    const verification = await call('gdeck_validate', { action: 'verify', profile: 'fast', timeout: 30 });
    assert.match(text(verification), /Verdict: PASSED/);
    assert.match(text(verification), /unit.*skipped/);
    const verificationReport = JSON.parse(readFileSync(verification.structuredContent.report.path, 'utf8'));
    assert.deepEqual(verification.structuredContent.resultEnvelope, verificationReport.resultEnvelope);
    assert.equal(verification.structuredContent.verification.plan.planDigest, verificationReport.verificationPlanDigest);
    assert.ok(verificationReport.timings.preparation.phases.snapshot_copy >= 0);
    mkdirSync(join(project, 'tests'));
    writeFileSync(join(project, 'tests', 'scene_test.gd'), 'extends FlightDeckTest\n\nfunc test_scene_contract() -> void:\n\tvar scene = load("res://main.tscn").instantiate()\n\tassert_true(scene is Node2D)\n\tassert_equal(str(scene.name), "TestRoot")\n\tscene.free()\n');
    const unit = await call('gdeck_validate', { action: 'unit', timeout: 30 });
    assert.equal(unit.structuredContent.resultEnvelope.verdict, 'PASSED');
    assert.equal(unit.structuredContent.summary.summary.assertions, 2);
    // A real failed Unit stage must retain its private log and terminal assertion
    // facts, independently of the process layer and authoritative Envelope.
    const failingTest = join(project, 'tests', 'failure_test.gd');
    writeFileSync(failingTest, 'extends FlightDeckTest\nfunc test_failure() -> void:\n\tassert_true(false, "intentional fixture assertion")\n');
    const failedVerification = await call('gdeck_validate', { action: 'verify', profile: 'fast', timeout: 30 }, true);
    assert.equal(failedVerification.structuredContent.resultEnvelope.verdict, 'FAILED', text(failedVerification));
    const failedStage = failedVerification.structuredContent.verification.stages.find(stage => stage.kind === 'unit');
    assert.equal(failedStage.diagnostics.assertions.state, 'terminal');
    assert.equal(failedStage.diagnostics.assertions.passed, false);
    const logPath = failedStage.diagnostics.logs.streams.stdout.path;
    assert.equal(failedStage.process.childProcesses.find(item => item.phase === 'unit').timings.scope, 'direct_child');
    assert.equal(failedStage.process.timings.phaseBreakdownAvailable, false);
    assert.ok(readFileSync(logPath).length > 0);
    if (process.platform !== 'win32') assert.equal(statSync(logPath).mode & 0o777, 0o600);
    rmSync(failingTest);
    for (const name of ['runtime_clock_test.gd', 'semantic_event_window_test.gd']) {
      copyFileSync(join(dirname(serverPath), '..', 'godot', 'tests', name), join(project, 'tests', name));
    }
    await call('gdeck_validate', { action: 'unit', timeout: 30 });
    // Deliberately mutate this test-owned source dependency from the immutable
    // test execution. Passing assertions must be rejected for the changed source.
    const dependency = join(project, 'dependency.gd');
    writeFileSync(dependency, 'extends Node\n');
    const driftTest = join(project, 'tests', 'drift_test.gd');
    writeFileSync(driftTest, `extends FlightDeckTest\nfunc test_drift() -> void:\n\tvar file = FileAccess.open(${JSON.stringify(dependency)}, FileAccess.WRITE)\n\tfile.store_string("extends Node\\nvar changed = true\\n")\n\tfile.close()\n\tassert_true(true)\n`);
    const drift = await call('gdeck_validate', { action: 'verify', profile: 'fast', timeout: 30 }, true);
    assert.equal(drift.structuredContent.resultEnvelope.failureClassification.code, 'plan_drift');
    const driftStage = drift.structuredContent.verification.stages.find(stage => stage.planDrift);
    assert.equal(driftStage.planDrift.phase, 'after_stage');
    assert.ok(driftStage.planDrift.changedCategories.includes('project_code'));
    assert.equal(driftStage.planDrift.priorEvidenceScope, 'original_inputs_only');
    rmSync(driftTest);
    mkdirSync(join(project, 'qa', 'scenarios'), { recursive: true });
    writeFileSync(join(project, 'qa', 'clock.gd'), 'extends Node\nfunc gdeck_setup(probe: Node) -> void:\n\tprobe.event("clock_fixture_ready")\n');
    config.profiles.clock = { frames: 60, seed: 42, fixtureAdapter: 'res://qa/clock.gd', userArgs: [] };
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(join(project, 'qa', 'scenarios', 'clock.json'), JSON.stringify({ name: 'clock', profile: 'clock', capture: false,
      timeoutFrames: 60, steps: [{ wait_frames: 12 }], assertions: [{ event: 'clock_fixture_ready', count_gte: 1 }] }));
    const clockResult = await call('gdeck_validate', { action: 'scenario', name: 'clock', timeout: 30 });
    assert.equal(clockResult.structuredContent.clocks.mode, 'fixed_step_throughput');
    assert.equal(clockResult.structuredContent.clocks.fixed_fps, 60);
    const clockReport = JSON.parse(readFileSync(clockResult.structuredContent.report.path, 'utf8'));
    assert.ok(Math.abs(clockReport.clocks.simulation_seconds - clockReport.total_frames / 60) < 0.000001);
    editor = spawn(godot, ['--headless', '--editor', '--path', project, 'res://main.tscn'], { env, detached: process.platform !== 'win32', stdio: 'ignore' });
    const readyDeadline = Date.now() + 15000;
    while (!readdirSync(join(project, '.gdeck')).some(name => /^editor-session-.+\.json$/.test(name))) {
      assert.equal(editor.exitCode, null, 'fixture editor exited before establishing a session');
      assert.ok(Date.now() < readyDeadline, 'fixture editor startup deadline exceeded');
      await delay(100);
    }
    const status = await edit({ action: 'status' });
    assert.equal(status.allow_writes, true);
    assert.equal(status.edited_scene, 'res://main.tscn');
    assert.equal((await edit({ action: 'inspect' })).path, '.');
    await edit({ action: 'create', className: 'Node2D', nodeName: 'Temporary' });
    for (const [property, value] of [['z_index', 3], ['z_index', -3], ['visible', false], ['position', [10, 20]], ['position', { x: 30, y: 40 }], ['editor_description', 'false']]) {
      const result = await edit({ action: 'set', path: 'Temporary', property, value });
      // Bridge 1.6.5 renders Vector2 values as Godot strings in its JSON output.
      if (property === 'position') {
        assert.match(result.value, /^\(-?\d+(?:\.\d+)?, -?\d+(?:\.\d+)?\)$/);
        const actual = result.value.slice(1, -1).split(',').map(Number);
        assert.deepEqual(actual, Array.isArray(value) ? value : [value.x, value.y]);
      } else {
        assert.deepEqual(result.value, value, property);
      }
    }
    const batch = { action: 'batch', name: 'Typed MCP regression', operations: [
      { action: 'set', path: 'Temporary', property: 'visible', value: true },
      { action: 'set', path: 'Temporary', property: 'position', value: [50, 60] },
    ] };
    const preview = await edit({ ...batch, commit: false });
    assert.equal(preview.dry_run, true);
    assert.equal(preview.name, batch.name);
    const propertyValue = async name => (await edit({ action: 'inspect', path: 'Temporary' })).properties.find(p => p.name === name).value;
    assert.equal(await propertyValue('visible'), false);
    await edit({ ...batch, commit: true });
    assert.equal(await propertyValue('visible'), true);
    await edit({ action: 'undo' });
    assert.equal(await propertyValue('visible'), false);
    const denied = await call('gdeck_editor', { action: 'delete', path: 'Temporary' }, true);
    assert.match(readFileSync(denied.structuredContent.logs.streams.stderr.path, 'utf8'), /--apply/);
    await edit({ action: 'inspect', path: 'Temporary' });
    await edit({ action: 'delete', path: 'Temporary', apply: true });
    await edit({ action: 'save' });
    assert.doesNotMatch(readFileSync(join(project, 'main.tscn'), 'utf8'), /Temporary/);
  } finally {
    if (editor && editor.exitCode === null && editor.signalCode === null) {
      const exited = once(editor, 'exit');
      if (process.platform === 'win32') editor.kill('SIGTERM');
      else process.kill(-editor.pid, 'SIGTERM');
      const forced = setTimeout(() => {
        try {
          if (process.platform === 'win32') editor.kill('SIGKILL');
          else process.kill(-editor.pid, 'SIGKILL');
        } catch { /* already stopped */ }
      }, 3000);
      await exited;
      clearTimeout(forced);
    }
    await client.close();
    rmSync(project, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});
