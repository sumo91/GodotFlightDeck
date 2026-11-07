import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../cli/gdeck.mjs', import.meta.url));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ZkAAAAASUVORK5CYII=';

test('Capture publishes only this invocation and preserves an existing output on every failure', { skip: process.platform === 'win32' }, () => {
  const project = mkdtempSync(join(tmpdir(), 'gdeck-capture-test-'));
  try {
    const engine = join(project, 'engine.mjs');
    writeFileSync(engine, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const arg = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const mode = process.env.GDECK_CAPTURE_TEST_MODE;
const image = arg('--gdeck-capture');
const report = arg('--gdeck-report');
if (mode === 'timeout') { setInterval(() => {}, 1000); }
else if (mode !== 'no-artifacts') {
  writeFileSync(image, Buffer.from(mode === 'bad-png' ? 'bad image' : '${png}', mode === 'bad-png' ? 'utf8' : 'base64'));
  if (mode !== 'no-report') writeFileSync(report, mode === 'bad-json' ? '{' : JSON.stringify({capture: mode === 'wrong-report' ? 'old.png' : image, capture_error: mode === 'capture-error' ? 1 : 0}));
  if (mode === 'error-log') console.error('ERROR: failed after capture');
  if (mode === 'exit-failure') process.exitCode = 1;
}
`, { mode: 0o700 });
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
    mkdirSync(join(project, '.gdeck'));
    writeFileSync(join(project, '.gdeck', 'config.json'), JSON.stringify({ godotPath: engine, profiles: { default: { frames: 1, userArgs: [] } } }));
    const output = join(project, 'existing.png');
    const old = Buffer.from('existing user image');
    const invoke = mode => spawnSync(process.execPath, [cli, 'capture', project, '--output', output, '--timeout', mode === 'timeout' ? '0.2' : '5'], {
      encoding: 'utf8', env: { ...process.env, GODOT_BIN: engine, GDECK_CURSOR_COMPAT: '1', GDECK_CAPTURE_TEST_MODE: mode }, timeout: 10000,
    });
    for (const mode of ['no-artifacts', 'no-report', 'exit-failure', 'error-log', 'wrong-report', 'bad-json', 'bad-png', 'capture-error', 'timeout']) {
      writeFileSync(output, old);
      const result = invoke(mode);
      assert.notEqual(result.status, 0, mode);
      assert.deepEqual(readFileSync(output), old, mode);
      assert.doesNotMatch(result.stdout, /Capture complete|Image:/, mode);
      assert.deepEqual(readdirSync(join(project, '.gdeck', 'reports')), [], mode);
      assert.equal(readdirSync(project).some(name => name.startsWith('.gdeck-capture-')), false, mode);
    }
    const result = invoke('success');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(output), Buffer.from(png, 'base64'));
    const reports = readdirSync(join(project, '.gdeck', 'reports'));
    assert.equal(reports.length, 1);
    assert.equal(JSON.parse(readFileSync(join(project, '.gdeck', 'reports', reports[0]), 'utf8')).capture, output);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
