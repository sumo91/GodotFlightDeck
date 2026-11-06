import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { executeSupervised } from './supervisor.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('capture preserves non-UTF8 bytes for exact log retrieval', async () => {
  const result = await executeSupervised(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,128,65]))'], { cwd: tmpdir(), timeoutSeconds: 2 });
  assert.deepEqual(result.stdoutBuffer, Buffer.from([0, 255, 128, 65]));
  assert.equal(result.stdoutBytes, 4);
});

test('async supervision keeps timers responsive and preserves child exit/output', async () => {
  let responsive = false;
  const timer = setTimeout(() => { responsive = true; }, 10);
  const result = await executeSupervised(process.execPath, ['-e', "setTimeout(()=>{process.stdout.write('done');process.exit(7)},100)"], { cwd: tmpdir(), timeoutSeconds: 2 });
  clearTimeout(timer);
  assert.equal(responsive, true);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'done');
  assert.equal(result.cleanupTimedOut, false);
  assert.equal(result.timings.clock, 'monotonic');
  assert.ok(result.timings.executionMs >= 100);
  assert.ok(result.timings.launchMs >= 0);
  assert.ok(result.timings.cleanupMs >= 0);
  assert.ok(Math.abs(result.timings.totalMs - result.timings.launchMs - result.timings.executionMs - result.timings.cleanupMs) < 0.01);
});

for (const mode of ['timeout', 'abort', 'completed']) {
  test(`${mode} cleans up its child and descendant process group without Godot`, { timeout: 10000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gdeck-mcp-supervisor-test-'));
    const pidFile = join(directory, 'pids.json');
    const controller = new AbortController();
    let pids = [];
    try {
      const source = `
        const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));
        ${mode === 'completed' ? 'setTimeout(()=>process.exit(0),100)' : "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"};`;
      const resultPromise = executeSupervised(process.execPath, ['-e', source], {
        cwd: directory, timeoutSeconds: mode === 'timeout' ? .8 : 5, signal: controller.signal,
      });
      for (let i = 0; i < 150 && !existsSync(pidFile); i++) await delay(10);
      assert.equal(existsSync(pidFile), true, 'fixture child started');
      pids = JSON.parse(readFileSync(pidFile, 'utf8'));
      if (mode === 'abort') controller.abort();
      const result = await resultPromise;
      assert.equal(result.status, mode === 'timeout' ? 124 : mode === 'abort' ? 143 : 0);
      assert.equal(result.timedOut, mode === 'timeout');
      assert.equal(result.cancelled, mode === 'abort');
      assert.equal(result.cleanupTimedOut, false);
      assert.equal(pids.some(alive), false, 'both owned processes are gone when supervision resolves');
    } finally {
      controller.abort();
      for (const pid of pids) { if (alive(pid)) process.kill(pid, 'SIGKILL'); }
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('already aborted calls never start a process', async () => {
  const controller = new AbortController();controller.abort();
  const result = await executeSupervised('/does/not/exist', [], { cwd: tmpdir(), timeoutSeconds: 1, signal: controller.signal });
  assert.equal(result.status, 130);
  assert.equal(result.cancelled, true);
});
