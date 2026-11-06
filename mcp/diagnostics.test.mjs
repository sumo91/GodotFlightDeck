import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticHints, assertionCompletion } from '../cli/diagnostics.mjs';
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
