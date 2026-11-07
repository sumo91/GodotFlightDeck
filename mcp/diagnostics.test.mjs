import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticHints, assertionCompletion, writeUnitDiagnostics, readUnitDiagnostics, renderDiagnosticText } from '../cli/diagnostics.mjs';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRuntimeClockMetadata } from '../cli/runtime-clock.mjs';

test('clock metadata follows actual engine arguments, not user arguments or assumed scenario names', () => {
  assert.equal(withRuntimeClockMetadata(['--fixed-fps', '60', '--', '--gdeck-report=a']).at(-1), '--gdeck-fixed-fps=60');
  assert.equal(withRuntimeClockMetadata(['--path', '/project', '--', '--fixed-fps', '120']).at(-1), '--gdeck-fixed-fps=0');
  assert.equal(withRuntimeClockMetadata(['--fixed-fps', 'bad', '--']).at(-1), '--gdeck-fixed-fps=-1');
});

test('diagnostics expose fixed descriptions and captured line references, never arbitrary payloads', () => {
  const result = diagnosticHints({ stdout: 'ordinary ERROR secret-token\n', stderr:
    'startup\nERROR: secret=password\nLeaked instance: AudioStreamPlaybackWAV:123 token=secret\nLeaked instance: AudioStreamWAV:456\n' });
  assert.deepEqual(result.firstIssue, { category: 'engine_error',
    summary: 'Godot reported an error; inspect the cited captured line.', stream: 'stderr', line: 2 });
  assert.deepEqual(result.resources.map(r => [r.type, r.line]), [['AudioStreamPlaybackWAV', 3], ['AudioStreamWAV', 4]]);
  assert.equal(result.evidenceAuthority, 'diagnostic_only');
  assert.doesNotMatch(JSON.stringify(result), /secret|password|123|456/);
  assert.equal(diagnosticHints({ stdout: 'all assertions PASSED or FAILED' }).firstIssue, null);
});

test('assertion completion is separate from process exit and missing/incomplete reports', () => {
  assert.deepEqual(assertionCompletion('unit', { schema_version: 2, complete: false, summary: { failed: 0 } }), { state: 'incomplete' });
  assert.equal(assertionCompletion('scenario', { scenario: { status: 'failed', steps_completed: 2, steps_total: 3, assertions: [] } }).allStepsCompleted, false);
  assert.equal(assertionCompletion('scenario', { scenario: { status: 'passed', steps_completed: 3, steps_total: 3, assertions: [{ passed: true }] } }).passed, true);
  assert.deepEqual(assertionCompletion('scenario', null), { state: 'unavailable' });
  assert.equal(assertionCompletion('scenario', { scenario: { status: 'passed', steps_completed: 'private payload', steps_total: 1 } }).stepsCompleted, null);
});

test('engine source locations belong to the adjacent first error and omit arbitrary messages', () => {
  const result = diagnosticHints({ stderr: 'SCRIPT ERROR: Parse Error: secret=value\n          at: GDScript::reload (res://scripts/主界面.gd:42)\nERROR: Failed to load script\n' });
  assert.deepEqual(result.firstIssue.source, { path: 'res://scripts/主界面.gd', line: 42 });
  assert.equal(result.firstIssue.errorKind, 'parse');
  assert.match(renderDiagnosticText(result), /res:\/\/scripts\/主界面.gd:42/);
  assert.doesNotMatch(JSON.stringify(result), /secret=value/);
  for (const location of ['res://../private.gd:1', 'res://.gdeck/token.gd:1', '/private/secret.gd:1', 'res://a.gd:0']) {
    assert.equal(diagnosticHints({ stderr: `SCRIPT ERROR: failed\n at: (${location})\n` }).firstIssue.source, undefined);
  }
  assert.equal(diagnosticHints({ stderr: 'ERROR: first\nSCRIPT ERROR: second\n at: (res://second.gd:3)\n' }).firstIssue.source, undefined);
  assert.equal(diagnosticHints({ stderr: 'ERROR: first', stdout: ' at: (res://different-stream.gd:3)\n' }).firstIssue.source, undefined);
});

test('quiet Unit diagnostics survive missing reports, keep private logs, and reject unrelated sidecars', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gdeck-unit-diagnostics-'));
  const report = join(directory, 'missing-report.json');
  try {
    const stderr = 'SCRIPT ERROR: Compile Error: private payload\n at: (res://tests/example_test.gd:9)\n';
    writeUnitDiagnostics(report, { stdout: '', stderr, outputTruncated: true });
    const saved = readUnitDiagnostics(report);
    assert.equal(saved.firstIssue.source.line, 9);
    assert.equal(saved.logs.complete, false);
    assert.equal(readFileSync(saved.logs.streams.stderr.path, 'utf8'), stderr);
    assert.doesNotMatch(JSON.stringify(saved), /private payload/);
    if (process.platform !== 'win32') assert.equal(statSync(saved.logs.streams.stderr.path).mode & 0o777, 0o600);
    assert.throws(() => writeUnitDiagnostics(report, { stderr }), /EEXIST/);
    const path = `${report}.diagnostics.json`;
    const malformed = JSON.parse(readFileSync(path, 'utf8'));
    malformed.logs.streams.stderr.path = '/private/other.log';
    writeFileSync(path, JSON.stringify(malformed));
    assert.equal(readUnitDiagnostics(report), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
