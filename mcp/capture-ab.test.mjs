import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { publishCapturePairs, capturePairSummary } from '../cli/capture-ab.mjs';
import { buildResultEnvelope } from '../cli/result-envelope.mjs';

function fixture(root) {
  const staging = join(root, 'staging');
  mkdirSync(join(staging, 'pair-1'), { recursive: true });
  const pair = { step: 1, status: 'completed', restored: true, published: false, width: 1, height: 1,
    control: { same_process: true, restored_image_identical: true }, files: {} };
  for (const key of ['a', 'b', 'restored', 'side_by_side', 'diff']) {
    // Only the publisher's header/hash contract is under test; rendered PNGs are covered in Godot.
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.writeUInt32BE(key === 'side_by_side' ? 2 : 1, 16);
    png.writeUInt32BE(1, 20);
    writeFileSync(join(staging, 'pair-1', `${key}.png`), png);
    pair.files[key] = { sha256: createHash('sha256').update(png).digest('hex') };
  }
  return { staging, destination: join(root, 'published'), report: { capture_ab: [pair] } };
}

test('A/B publication rejects incomplete, changed or unrelated files and never replaces an existing bundle', () => {
  for (const fault of ['missing', 'changed', 'hash-mismatch', 'wrong-step', 'unrestored', 'occupied', 'extra']) {
    const root = mkdtempSync(join(tmpdir(), 'gdeck-ab-publish-'));
    try {
      const { staging, destination, report } = fixture(root);
      if (fault === 'missing') rmSync(join(staging, 'pair-1/b.png'));
      if (fault === 'changed') writeFileSync(join(staging, 'pair-1/b.png'), 'changed');
      if (fault === 'hash-mismatch') report.capture_ab[0].files.b.sha256 = '0'.repeat(64);
      if (fault === 'wrong-step') report.capture_ab[0].step = 2;
      if (fault === 'unrestored') report.capture_ab[0].control.restored_image_identical = false;
      if (fault === 'extra') writeFileSync(join(staging, 'extra.txt'), 'unexpected');
      if (fault === 'occupied') { mkdirSync(destination); writeFileSync(join(destination, 'keep'), 'old'); }
      assert.throws(() => publishCapturePairs(report, staging, destination, [1]), undefined, fault);
      assert.equal(existsSync(destination), fault === 'occupied');
      if (fault === 'occupied') assert.equal(readFileSync(join(destination, 'keep'), 'utf8'), 'old');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('A/B results expose published artifacts, withhold project payloads, and classify drift as inconclusive', () => {
  const root = mkdtempSync(join(tmpdir(), 'gdeck-ab-result-'));
  try {
    const { staging, destination, report } = fixture(root);
    report.capture_ab[0].changes = [{ private: 'not-for-first-response' }];
    assert.equal(capturePairSummary(report.capture_ab)[0].artifacts, undefined);
    publishCapturePairs(report, staging, destination, [1]);
    assert.equal(existsSync(staging), false);
    const summary = capturePairSummary(report.capture_ab);
    assert.equal(summary[0].published, true);
    assert.doesNotMatch(JSON.stringify(summary), /not-for-first-response/);
    assert.equal(JSON.parse(readFileSync(summary[0].artifacts.report)).published, true);
    const passed = buildResultEnvelope({ report: { stages: [{ kind: 'scenario', status: 'passed', report }] } });
    assert.equal(passed.artifacts.filter(item => item.kind.startsWith('capture_ab_')).length, 6);
    report.scenario = { status: 'failed', failure_kind: 'precondition', failure_details: { kind: 'capture_ab_inconclusive', reason: 'state_changed', step_index: 1 } };
    const failed = buildResultEnvelope({ report: { stages: [{ kind: 'scenario', status: 'failed', report }] } });
    assert.equal(failed.verdict, 'INCONCLUSIVE');
    assert.equal(failed.failureClassification.code, 'precondition');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
