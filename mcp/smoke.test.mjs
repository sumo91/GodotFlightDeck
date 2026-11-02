import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  const isolatedHome = join(project, 'user-data');
  mkdirSync(isolatedHome);
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
    return text(result);
  };
  const edit = async args => {
    const output = await call('gdeck_editor', { json: true, ...args });
    const parsed = JSON.parse(output.slice(output.indexOf('{')));
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
    assert.match(verification, /Verdict: PASSED/);
    assert.match(verification, /unit.*skipped/);
    mkdirSync(join(project, 'tests'));
    writeFileSync(join(project, 'tests', 'scene_test.gd'), 'extends FlightDeckTest\n\nfunc test_scene_contract() -> void:\n\tvar scene = load("res://main.tscn").instantiate()\n\tassert_true(scene is Node2D)\n\tassert_equal(str(scene.name), "TestRoot")\n\tscene.free()\n');
    const unit = await call('gdeck_validate', { action: 'unit', timeout: 30 });
    assert.match(unit, /Unit tests passed/);
    assert.match(unit, /Assertions: 2/);
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
    assert.match(denied, /--apply/);
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
  }
});
