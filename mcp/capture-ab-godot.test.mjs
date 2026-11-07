import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('rendered A/B restores the scene, detects drift, and preserves artifacts through Verify', { skip: !process.env.GODOT_BIN, timeout: 90000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gdeck-ab-godot-')));
  const project = join(root, 'project');
  mkdirSync(join(project, 'qa/scenarios'), { recursive: true });
  const client = new Client({ name: 'ab-regression', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
    env: { ...process.env, HOME: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root }, stderr: 'pipe' });
  transport.stderr?.resume();
  const call = async (name, args, expectedError = false) => {
    const response = await client.callTool({ name, arguments: { project, timeout: 15, ...args } }, undefined, { timeout: 25000 });
    assert.equal(Boolean(response.isError), expectedError, JSON.stringify(response.content));
    return response.structuredContent;
  };
  const scenario = (name, steps) => writeFileSync(join(project, `qa/scenarios/${name}.json`), JSON.stringify({
    name, profile: 'ab', capture: false, timeoutFrames: 60,
    steps: [{ wait_state: 'ready', where: { ok: true } }, ...steps], assertions: [],
  }));
  const pair = value => ({ capture_ab: { name: 'panel', changes: [{ path: 'Panel', property: 'visible', value }] } });
  try {
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n[application]\nconfig/name="AB Regression"\nrun/main_scene="res://main.tscn"\n[display]\nwindow/size/viewport_width=320\nwindow/size/viewport_height=240\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
    writeFileSync(join(project, 'main.tscn'), '[gd_scene format=3]\n[node name="Main" type="Node2D"]\n[node name="Panel" type="ColorRect" parent="."]\noffset_left=40.0\noffset_top=30.0\noffset_right=180.0\noffset_bottom=120.0\ncolor=Color(1,0,0,1)\n[node name="Camera" type="Camera2D" parent="."]\nposition=Vector2(160,120)\nenabled=false\n');
    writeFileSync(join(project, 'qa/adapter.gd'), `extends Node
var probe: Node
var draws := 0
func gdeck_setup(p: Node) -> void:
\tprobe = p
\tprobe.command_requested.connect(_command)
\t_setup.call_deferred()
func _setup() -> void:
\tprobe.state("ready", {"ok": true})
func _command(command_name: String, _payload: Dictionary) -> void:
\tif command_name == "check_restored":
\t\tvar panel = get_tree().current_scene.get_node("Panel")
\t\tprobe.event("restored", {"ok": panel.visible and not get_tree().paused and panel.process_mode == Node.PROCESS_MODE_INHERIT})
\tif command_name == "camera_on":
\t\tget_tree().current_scene.get_node("Camera").enabled = true
\tif command_name == "arm_drift":
\t\tRenderingServer.frame_pre_draw.connect(_draw_drift)
func _draw_drift() -> void:
\tdraws += 1
\tif draws == 5:
\t\tget_tree().current_scene.get_node("Panel").color = Color.BLUE
`);
    await client.connect(transport);
    await call('gdeck_project', { action: 'init' });
    const path = join(project, '.gdeck/config.json');
    const config = JSON.parse(readFileSync(path));
    config.profiles.ab = { fixtureAdapter: 'res://qa/adapter.gd' };
    config.verificationProfiles = { ab: { scenarios: ['success'] }, drift: { scenarios: ['drift'] } };
    writeFileSync(path, JSON.stringify(config));
    await call('gdeck_validate', { action: 'check' });
    scenario('success', [pair(false), { command: 'check_restored' }, { wait_event: 'restored', where: { ok: true }, since: 'command', timeout_frames: 3 }]);
    scenario('noop', [pair(true)]);
    scenario('camera', [{ command: 'camera_on' }, { capture_ab: { changes: [{ path: 'Camera', property: 'zoom', value: [1.25, 1.25] }] } }]);
    scenario('drift', [{ command: 'arm_drift' }, pair(false)]);
    scenario('invalid', [{ capture_ab: { changes: [{ path: 'Panel', property: 'script', value: null }] } }]);
    scenario('later-failure', [pair(false), { wait_state: 'missing', timeout_frames: 1 }]);
    const success = await call('gdeck_validate', { action: 'scenario', name: 'success' });
    const report = JSON.parse(readFileSync(success.report.path));
    const captured = report.capture_ab[0];
    assert.equal(captured.published, true);
    assert.equal(captured.restored, true);
    assert.deepEqual(captured.changes, [{ path: 'Panel', property: 'visible', before: true, after: false }]);
    assert.equal(captured.changed_pixels, 140 * 90);
    assert.deepEqual(readFileSync(captured.artifacts.a), readFileSync(captured.artifacts.restored));
    assert.notDeepEqual(readFileSync(captured.artifacts.a), readFileSync(captured.artifacts.b));
    assert.equal(success.resultEnvelope.artifacts.filter(item => item.kind.startsWith('capture_ab_')).length, 6);
    const noop = await call('gdeck_validate', { action: 'scenario', name: 'noop' });
    assert.equal(noop.summary.capturePairs[0].changed_ratio, 0);
    const camera = await call('gdeck_validate', { action: 'scenario', name: 'camera' });
    assert.ok(camera.summary.capturePairs[0].changed_ratio > 0);
    const verified = await call('gdeck_validate', { action: 'verify', profile: 'ab' });
    assert.equal(verified.resultEnvelope.verdict, 'PASSED');
    assert.equal(verified.resultEnvelope.artifacts.filter(item => item.kind.startsWith('capture_ab_')).length, 6);
    // Verify above has no importable assets: it still needs the global class cache.
    mkdirSync(join(project, 'qa/baselines'));
    writeFileSync(join(project, 'qa/baselines/ab.png'), readFileSync(captured.artifacts.a));
    await call('gdeck_validate', { action: 'visual', profile: 'ab' });
    const before = readdirSync(join(project, '.gdeck/captures')).sort();
    for (const name of ['drift', 'invalid', 'later-failure']) {
      const result = await call('gdeck_validate', { action: 'scenario', name }, true);
      assert.equal(result.resultEnvelope.verdict, name === 'later-failure' ? 'FAILED' : 'INCONCLUSIVE');
      assert.equal(result.summary.capturePairs[0].published, false);
      assert.equal(result.resultEnvelope.artifacts.some(item => item.kind.startsWith('capture_ab_')), false);
      assert.deepEqual(readdirSync(join(project, '.gdeck/captures')).sort(), before);
      if (name === 'drift') {
        const failed = JSON.parse(readFileSync(result.report.path));
        assert.equal(failed.capture_ab[0].reason, 'restore_image_changed');
        assert.equal(failed.capture_ab[0].restored, true);
      }
    }
    const drift = await call('gdeck_validate', { action: 'verify', profile: 'drift' }, true);
    assert.equal(drift.resultEnvelope.verdict, 'INCONCLUSIVE');
    assert.equal(drift.resultEnvelope.failureClassification.code, 'precondition');
    writeFileSync(join(project, 'qa/scenarios/timeout.json'), JSON.stringify({ profile: 'ab', capture: false,
      timeoutFrames: 100000000, steps: [{ wait_frames: 100000000 }, pair(false)] }));
    const timeout = await call('gdeck_validate', { action: 'scenario', name: 'timeout', timeout: 1 }, true);
    assert.equal(timeout.resultEnvelope.verdict, 'INCONCLUSIVE');
    assert.equal(timeout.resultEnvelope.failureClassification.code, 'timeout');
    assert.deepEqual(readdirSync(join(project, '.gdeck/captures')).sort(), before);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
