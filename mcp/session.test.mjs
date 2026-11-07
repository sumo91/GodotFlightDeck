import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
test('MCP watch completes a clean observation window without an outer timeout', { skip: process.platform === 'win32' }, async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'gdeck-watch-session-')));
  const client = new Client({ name: 'watch-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], stderr: 'pipe' });
  transport.stderr?.resume();
  try {
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
    const engine = join(project, 'engine.mjs');
    writeFileSync(engine, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
    mkdirSync(join(project, '.gdeck'));
    writeFileSync(join(project, '.gdeck/config.json'), JSON.stringify({ godotPath: engine }));
    await client.connect(transport);
    const result = await client.callTool({ name: 'gdeck_run', arguments: { action: 'watch', project, timeout: 2 } });
    assert.equal(result.structuredContent.process.exitCode, 0);
    assert.equal(result.structuredContent.process.timedOut, false);
    assert.notEqual(result.isError, true);
  } finally { await client.close(); rmSync(project, { recursive: true, force: true }); }
});

test('invalid calls stay bounded before any project/process lookup', async () => {
  const client = new Client({ name: 'invalid-call-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], stderr: 'pipe' });
  transport.stderr?.resume();
  try {
    await client.connect(transport);
    for (const request of [
      { name: 'gdeck_validate', arguments: { action: 'x'.repeat(20000) } },
      { name: 'x'.repeat(20000), arguments: {} },
    ]) {
      const result = await client.callTool(request);
      assert.equal(result.isError, true);
      assert.ok(Buffer.byteLength(result.content[0].text) <= 8192);
    }
  } finally { await client.close(); }
});

for (const mode of ['cancel', 'disconnect', 'timeout']) {
  test(`MCP ${mode} cleans an active CLI process and its stubborn descendants`, { skip: process.platform === 'win32', timeout: 15000 }, async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'gdeck-session-test-')));
    const pidPath = join(project, 'pids.json');
    const fakeGodot = join(project, 'godot-fixture');
    writeFileSync(fakeGodot, `#!${process.execPath}\nconst {spawn}=require('node:child_process');\nif(process.argv.includes('--version')) {console.log('4.7.2.stable');process.exit(0);}\nconst child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)},JSON.stringify([process.pid,child.pid]));\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`, { mode: 0o700 });
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
    mkdirSync(join(project, '.gdeck'));
    writeFileSync(join(project, '.gdeck', 'config.json'), JSON.stringify({ godotPath: fakeGodot }));
    const client = new Client({ name: 'session-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], env: { ...process.env }, stderr: 'pipe' });
    transport.stderr?.resume();
    const controller = new AbortController();
    let pids = [];
    try {
      await client.connect(transport);
      const detection = await client.callTool({ name: 'gdeck_project', arguments: { action: 'detect', project } });
      assert.equal(detection.structuredContent.service.schemaVersion, 2);
      let callOutcome;
      const pending = client.callTool({ name: 'gdeck_validate', arguments: { action: 'check', project, timeout: mode === 'timeout' ? 3 : 10 } }, undefined, { signal: controller.signal })
        .catch(error => ({ error })).then(result => { callOutcome = result; return result; });
      // Await an explicit readiness file; startup can be slower while Godot is
      // running elsewhere. A completed call without readiness is a real failure.
      for (let i = 0; i < 600 && !existsSync(pidPath) && !callOutcome; i++) await delay(10);
      assert.equal(existsSync(pidPath), true, `CLI reached the child fixture: ${JSON.stringify(callOutcome?.structuredContent?.process ?? callOutcome?.error?.message ?? 'startup deadline')}`);
      pids = JSON.parse(readFileSync(pidPath, 'utf8'));
      if (mode === 'cancel') controller.abort();
      if (mode === 'disconnect') await client.close();
      const result = await pending;
      if (mode === 'timeout') {
        assert.equal(result.structuredContent.process.timedOut, true);
        assert.equal(result.structuredContent.process.exitCode, 124);
        const page = await client.callTool({ name: 'gdeck_log', arguments: { logId: result.structuredContent.logs.id, stream: 'stdout', limit: 32 } });
        assert.equal(page.structuredContent.encoding, 'base64');
        assert.equal(Buffer.from(page.structuredContent.data, 'base64').length, page.structuredContent.nextOffset);
      }
      for (let i = 0; i < 400 && pids.some(alive); i++) await delay(10);
      assert.equal(pids.some(alive), false, 'owned process tree was reaped');
    } finally {
      controller.abort();
      await client.close();
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(project, { recursive: true, force: true });
    }
  });
}
