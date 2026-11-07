import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVerificationPlan } from '../cli/verification-plan.mjs';

for (const verificationProfile of [undefined, 'performance']) {
  test(`frame budgets survive ${verificationProfile ?? 'legacy'} planning`, () => {
    const project = mkdtempSync(join(tmpdir(), 'gdeck-budget-'));
    try {
      mkdirSync(join(project, '.gdeck'));
      writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
      const budgets = { worstFrameMsLte: 20, averageFrameMsLte: 16.7 };
      const selection = { doctor: false, check: false, unit: false, benchmarks: [{ profile: 'default', budgets }] };
      writeFileSync(join(project, '.gdeck/config.json'), JSON.stringify({ profiles: { default: {} }, verify: selection, verificationProfiles: { performance: selection } }));
      const plan = resolveVerificationPlan({ project, outputPath: join(project, '.gdeck/reports/test.json'), invocationIdentity: 'a'.repeat(64), verificationProfile });
      assert.deepEqual(plan.stages.find(s => s.kind === 'benchmark').runtime.budgets, budgets);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });
}

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performanceBudgetResults } from '../cli/performance-budgets.mjs';

test('budget comparisons preserve inclusive limits, missing metrics and MiB conversion', () => {
  for (const [value, passed] of [[19, true], [20, true], [21, false], [undefined, false]]) {
    assert.equal(performanceBudgetResults({ worst_frame_ms: value }, { worstFrameMsLte: 20 })[0].passed, passed);
  }
  assert.deepEqual(performanceBudgetResults({ average_frame_ms: 16, worst_frame_ms: 30, average_fps: 60, static_memory_bytes: 2 * 1024 * 1024 },
    { averageFrameMsLte: 16.7, worstFrameMsLte: 20, averageFpsGte: 60, staticMemoryMbLte: 2 }).map(x => x.passed), [true, false, true, true]);
});

test('Verify enforces frame budgets through the report and Verdict', { skip: process.platform === 'win32' }, () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'gdeck-budget-verify-')));
  try {
    mkdirSync(join(project, '.gdeck'));
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
    const engine = join(project, 'engine.mjs');
    writeFileSync(engine, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
const report=process.argv.find(x=>x.startsWith('--gdeck-report='))?.split('=').slice(1).join('=');
if(report) writeFileSync(report,JSON.stringify({schema_version:3,performance:{average_frame_ms:16,worst_frame_ms:30,average_fps:62.5}}));\n`, { mode: 0o700 });
    for (const [limit, verdict] of [[20, 'FAILED'], [30, 'PASSED']]) {
      const selection = { doctor: false, check: false, unit: false, benchmarks: [{ profile: 'default', budgets: { worstFrameMsLte: limit, averageFrameMsLte: 16.7 } }] };
      writeFileSync(join(project, '.gdeck/config.json'), JSON.stringify({ godotPath: engine, profiles: { default: {} }, verify: selection }));
      const output = join(project, `.gdeck/reports/verify-${limit}.json`);
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../cli/gdeck.mjs', import.meta.url)), 'verify', project, '--output', output, '--timeout', '5'],
        { env: { ...process.env, GODOT_BIN: engine }, encoding: 'utf8', timeout: 20000 });
      assert.equal(result.status, verdict === 'PASSED' ? 0 : 1, result.stdout + result.stderr);
      assert.ok(existsSync(output), result.stdout + result.stderr);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(report.resultEnvelope.verdict, verdict);
      const stage = report.stages.find(s => s.kind === 'benchmark');
      assert.equal(stage.budgets.find(b => b.budget === 'worstFrameMsLte').actual, 30);
      if (verdict === 'FAILED') assert.match(JSON.stringify(report.resultEnvelope), /performance_budget/);
    }
  } finally { rmSync(project, { recursive: true, force: true }); }
});
