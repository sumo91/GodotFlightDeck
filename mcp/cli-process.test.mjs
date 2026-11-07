import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
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
