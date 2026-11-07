import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('watch fails on errors across chunks and at EOF, and succeeds for clean observations', { skip: process.platform === 'win32' }, () => {
  const project = mkdtempSync(join(tmpdir(), 'gdeck-watch-'));
  try {
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
    const engine = join(project, 'engine.mjs');
    writeFileSync(engine, `#!${process.execPath}
const mode=process.env.GDECK_WATCH_TEST;
if(mode==='split') {process.stderr.write('SCRIPT ER');setTimeout(()=>process.stderr.write('ROR: broken'),30);}
else if(mode==='error') console.error('SCRIPT ERROR: broken');
else if(mode==='long') {process.stdout.write('x'.repeat(100000)+'SCRIPT ER');setTimeout(()=>process.stdout.write('ROR: broken'),30);}
else if(mode==='window-error') {console.error('SCRIPT ERROR: broken');setInterval(()=>{},1000);}
else if(mode==='window') setInterval(()=>{},1000);
else console.log('normal output');
`, { mode: 0o700 });
    for (const mode of ['error', 'split', 'long', 'window-error', 'clean', 'window']) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../cli/gdeck.mjs', import.meta.url)), 'run', project, '--watch', '--godot', engine, '--timeout', '2'],
        { env: { ...process.env, GDECK_CURSOR_COMPAT: '1', GDECK_WATCH_TEST: mode }, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
      assert.equal(result.status, ['clean', 'window'].includes(mode) ? 0 : 1, mode + result.stderr);
    }
  } finally { rmSync(project, { recursive: true, force: true }); }
});
