import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { formatResult } from './server.mjs';
import { readLog, boundedText } from './result.mjs';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const captured = [];
after(() => { for (const path of captured) rmSync(path, { recursive: true, force: true }); });
function present(action, result, options) {
  const output = formatResult(action, '/tmp/project', { stdout: '', stderr: '', ...result }, options);
  captured.push(dirname(output.structuredContent.logs.streams.stdout.path));
  return output;
}
function scenarioReport(passed = true) {
  const directory = mkdtempSync(join(tmpdir(), 'gdeck-result-test-'));
  captured.push(directory);
  const path = join(directory, 'report.json');
  writeFileSync(path, JSON.stringify({ scenario: { status: passed ? 'passed' : 'failed', name: 'fixture', steps_completed: 1, steps_total: 1,
    failure_kind: passed ? 'none' : 'expectation', assertions: [{ passed, index: 0, event: 'done', count: passed ? 1 : 0, expected_count_gte: 1 }] } }));
  return path;
}

test('large event output has a structured result and <= 8 KiB default text', () => {
  const result = present('scenario', { status: 0, stdout: 'GDECK_EVENT noise {}\n'.repeat(50000) });
  assert.ok(Buffer.byteLength(result.content[0].text) <= 8192, 'event history must not enter the first response');
  assert.ok(result.structuredContent, 'result is machine-readable');
});

test('logs can be reassembled exactly across UTF-8 boundaries with hashes and private permissions', () => {
  const stdout = '事件🙂\n'.repeat(10000);
  const result = present('scenario', { status: 0, stdout });
  const log = result.structuredContent.logs;
  let offset = 0;
  const chunks = [];
  while (true) {
    const page = readLog({ logId: log.id, offset, limit: 997 });
    chunks.push(Buffer.from(page.data, 'base64'));
    offset = page.nextOffset;
    if (page.eof) break;
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.toString('utf8'), stdout);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), log.streams.stdout.sha256);
  if (process.platform !== 'win32') assert.equal(statSync(log.streams.stdout.path).mode & 0o777, 0o600);
  assert.throws(() => readLog({ logId: '/etc/passwd' }), /Unknown/);
  for (const offset of [-1, 1.5, Infinity]) assert.throws(() => readLog({ logId: log.id, offset }), /Invalid/);
  assert.throws(() => readLog({ logId: log.id, limit: 32769 }), /Invalid/);
  assert.ok(Buffer.byteLength(boundedText('🙂'.repeat(10000))) <= 8192);
});

test('upstream output loss is disclosed rather than called a complete log', () => {
  assert.equal(present('check', { status: 0, stdoutTruncated: true }).structuredContent.logs.complete, false);
});

test('log pages preserve bytes that are not valid UTF-8', () => {
  const bytes = Buffer.from([0, 255, 128, 65]);
  const result = present('check', { status: 0, stdout: bytes.toString('utf8'), stdoutBuffer: bytes });
  const page = readLog({ logId: result.structuredContent.logs.id });
  assert.deepEqual(Buffer.from(page.data, 'base64'), bytes);
});

for (const [name, processResult, passed, verdict, classification] of [
  ['assertion failure', { status: 1 }, false, 'FAILED', 'scenario_expectation'],
  ['passed assertions then exit 1', { status: 1 }, true, 'INCONCLUSIVE', 'unknown'],
  ['timeout', { status: 124, timedOut: true }, true, 'INCONCLUSIVE', 'timeout'],
  ['spawn failure', { status: 127 }, true, 'INCONCLUSIVE', 'process_spawn'],
  ['cleanup timeout', { status: 125, cleanupTimedOut: true }, true, 'INCONCLUSIVE', 'cleanup_timeout'],
  ['cancelled', { status: 143, cancelled: true }, true, 'CANCELLED', 'cancelled'],
]) {
  test(`${name} keeps diagnostics separate from Verdict authority`, () => {
    const result = present('scenario', { ...processResult, stdout: 'ERROR assertion FAILED password=secret' }, { reportPath: scenarioReport(passed) });
    assert.equal(result.structuredContent.resultEnvelope.verdict, verdict);
    assert.equal(result.structuredContent.resultEnvelope.failureClassification.code, classification);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.diagnostics.evidenceAuthority, 'diagnostic_only');
    assert.equal(result.structuredContent.diagnostics.assertions.state, 'terminal');
    assert.equal(result.structuredContent.diagnostics.assertions.passed, passed);
    assert.doesNotMatch(JSON.stringify(result), /password=secret/);
  });
}

test('audio exit hints locate retained lines without promoting them to failure evidence', () => {
  const result = present('scenario', { status: 1, stderr: 'ERROR: resources still in use\nLeaked instance: AudioStreamWAV:1\nLeaked instance: AudioStreamPlaybackWAV:2 secret=value\n' }, { reportPath: scenarioReport(true) });
  assert.equal(result.structuredContent.resultEnvelope.verdict, 'INCONCLUSIVE');
  assert.equal(result.structuredContent.resultEnvelope.failureClassification.code, 'unknown');
  assert.deepEqual(result.structuredContent.diagnostics.resources.map(r => [r.type, r.line]), [['AudioStreamWAV', 2], ['AudioStreamPlaybackWAV', 3]]);
  assert.doesNotMatch(JSON.stringify(result), /secret=value/);
});

test('verbosity and log volume do not alter accepted evidence or Verdict', () => {
  const reportPath = scenarioReport();
  let expected;
  for (const verbosity of ['compact', 'normal', 'diagnostic']) {
    for (const count of [1, 50000]) {
      const result = present('scenario', { status: 0, stdout: 'ERROR ordinary log\n'.repeat(count) }, { reportPath, verbosity });
      assert.equal(result.structuredContent.resultEnvelope.verdict, 'PASSED');
      expected ??= result.structuredContent.resultEnvelope;
      assert.deepEqual(result.structuredContent.resultEnvelope, expected);
      assert.ok(Buffer.byteLength(result.content[0].text) <= 8192);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16000);
    }
  }
});

test('missing reports and incomplete Unit reports cannot pass even on exit zero', () => {
  const path = scenarioReport();
  writeFileSync(path, JSON.stringify({ schema_version: 2, complete: false, status: 'passed' }));
  for (const reportPath of [path, `${path}.missing`]) {
    const result = present('unit', { status: 0 }, { reportPath });
    assert.equal(result.structuredContent.resultEnvelope.verdict, 'INCONCLUSIVE');
    assert.equal(result.isError, true);
  }
});
