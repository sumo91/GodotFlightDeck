import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { executeProcess } from '../cli/process-lifecycle.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
test('direct lifecycle preserves exit status, bounds output and reports spawn failure', async () => {
  const result = await executeProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(200000),()=>process.exit(7))"], timeoutMs: 3000, maxOutputBytes: 16384 });
  assert.equal(result.status, 7);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(result.stdoutBuffer.length < 17000);
  assert.equal(result.stdoutBytes, 200000);
  const missing = await executeProcess({ executable: '/gdeck-fixture-does-not-exist', args: [], timeoutMs: 3000 });
  assert.equal(missing.status, 127);
  assert.equal(missing.reason, 'process_spawn');
});
for (const mode of ['default', 'direct', 'supervised', 'cancel']) {
  test(`CLI ${mode} reaps a stubborn engine and descendant`, { skip: process.platform === 'win32', timeout: 15000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gdeck-cli-process-'));
    let pids = [], child, watchdog;
    try {
      const engine = join(root, 'engine.mjs'), pidFile = join(root, 'pids.json');
      writeFileSync(join(root, 'project.godot'), 'config_version=5\n');
      writeFileSync(engine, `#!${process.execPath}
import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
process.on('SIGTERM',()=>{});c.stdout.once('data',()=>writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,c.pid])));setInterval(()=>{},1000);`, { mode: 0o700 });
      const env = { ...process.env }; delete env.GDECK_CODEX_DIRECT; delete env.GDECK_CURSOR_COMPAT;
      if (mode === 'direct') env.GDECK_CODEX_DIRECT = '1';
      if (mode === 'supervised') env.GDECK_CURSOR_COMPAT = '0';
      child = spawn(process.execPath, [fileURLToPath(new URL('../cli/gdeck.mjs', import.meta.url)), 'run', root, '--godot', engine, '--timeout', mode === 'cancel' ? '15' : '5'], { env, detached: true, stdio: ['ignore','pipe','pipe'] });
      child.stdout.resume();child.stderr.resume();
      let rescued = false;
      watchdog = setTimeout(() => { rescued = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 12000);
      const completion = new Promise(resolve => child.once('close', (code, signal) => resolve({code,signal})));
      for (let i=0;i<400&&!existsSync(pidFile);i++) await delay(10);
      assert.ok(existsSync(pidFile), 'fixture ready before execution timeout');
      pids = JSON.parse(readFileSync(pidFile, 'utf8'));
      if (mode === 'cancel') child.kill('SIGTERM');
      const result = await completion;
      assert.equal(rescued, false, 'external watchdog must not rescue the CLI');
      assert.equal(result.code, mode === 'cancel' ? 143 : 124);
      assert.equal(pids.some(alive), false, 'owned process tree is gone');
    } finally {
      clearTimeout(watchdog);
      if (child) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      for (const pid of pids) { if(alive(pid)) process.kill(pid,'SIGKILL'); }
      rmSync(root,{recursive:true,force:true});
    }
  });
}

for (const phase of ['stage', 'import']) {
test(`cancelling Verify during ${phase} prevents later stages and removes its snapshot`, { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'gdeck-verify-cancel-'));
  let child, watchdog, pids = [];
  try {
    const ready = join(root, '.gdeck/ready'), later = join(root, '.gdeck/later');
    mkdirSync(join(root, '.gdeck')); mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'project.godot'), 'config_version=5\n');
    writeFileSync(join(root, 'tests/fixture_test.gd'), 'extends RefCounted\n');
    const engine = join(root, 'engine.mjs');
    writeFileSync(engine, `#!${process.execPath}
import {writeFileSync} from 'node:fs';
if(process.argv.includes('--import') && ${JSON.stringify(phase)}!=='import') process.exit(0);
if(process.argv.some(x=>x.startsWith('--report='))) {writeFileSync(${JSON.stringify(later)},'unexpected later stage');process.exit(0);}
writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,snapshot:process.argv[process.argv.indexOf('--path')+1]}));
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
`, {mode:0o700});
    writeFileSync(join(root, '.gdeck/config.json'), JSON.stringify({godotPath:engine,verify:{doctor:false,check:true,unit:true}}));
    const report = join(root, '.gdeck/reports/result.json');
    const moduleUrl = new URL('../cli/verification.mjs', import.meta.url).href;
    const entry = `import {verifyProject} from ${JSON.stringify(moduleUrl)};process.exitCode=await verifyProject(${JSON.stringify(root)},{output:${JSON.stringify(report)},timeout:10},'','a'.repeat(64));`;
    child = spawn(process.execPath, ['--input-type=module','-e',entry], {detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,GODOT_BIN:engine}});
    let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
    let rescued=false;
    watchdog=setTimeout(()=>{rescued=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},12000);
    const completion=new Promise(resolve=>child.once('close',resolve));
    for(let i=0;i<600&&!existsSync(ready);i++) await delay(10);
    assert.ok(existsSync(ready),logs);
    const fixture=JSON.parse(readFileSync(ready,'utf8'));pids=[fixture.pid];
    child.kill('SIGTERM');await completion;
    assert.equal(rescued,false);
    assert.equal(JSON.parse(readFileSync(report)).resultEnvelope.verdict,'CANCELLED',logs);
    assert.equal(existsSync(later),false,'no later stage may start after cancellation');
    assert.equal(existsSync(fixture.snapshot),false);
    assert.equal(pids.some(alive),false);
  } finally {
    clearTimeout(watchdog);
    if(child) {try{process.kill(-child.pid,'SIGKILL');}catch{}}
    for(const pid of pids) if(alive(pid)) process.kill(pid,'SIGKILL');
    rmSync(root,{recursive:true,force:true});
  }
});
}
