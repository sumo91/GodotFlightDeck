import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVerificationPlan, assertVerificationPlanDigest, verificationPlanSummary } from '../cli/verification-plan.mjs';

test('drift diagnostics follow the frozen dependency/config scope and exclude generated reports', () => {
  const project = mkdtempSync(join(tmpdir(), 'gdeck-plan-diagnostics-'));
  try {
    for (const dir of ['.gdeck/reports', 'qa/scenarios', 'scripts', 'docs']) mkdirSync(join(project, dir), { recursive: true });
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n[application]\nconfig/name="diagnostics"\n');
    writeFileSync(join(project, 'scripts/dependency.gd'), 'extends Node\n');
    writeFileSync(join(project, 'qa/fixture.gd'), 'extends Node\n');
    const config = { profiles: { smoke: { seed: 1, fixtureAdapter: 'res://qa/fixture.gd' } },
      verificationProfiles: { smoke: { scenarios: ['smoke'] } } };
    const saveConfig = () => writeFileSync(join(project, '.gdeck/config.json'), JSON.stringify(config));
    saveConfig();
    writeFileSync(join(project, 'qa/scenarios/smoke.json'), JSON.stringify({ profile: 'smoke', steps: [], assertions: [] }));
    const options = { project, outputPath: join(project, '.gdeck/reports/test.json'), invocationIdentity: 'a'.repeat(64), verificationProfile: 'smoke' };
    const original = resolveVerificationPlan(options);
    const summary = verificationPlanSummary(original);
    assert.equal(summary.planDigest, original.digest);
    assert.equal(summary.inputsDigest, original.evidenceBinding.inputsDigest);
    assert.ok(summary.categories.some(c => c.category === 'project_code'));
    assert.ok(summary.excluded.some(e => e.path === '.gdeck'));
    writeFileSync(join(project, '.gdeck/reports/generated.json'), '{"noise":true}');
    assertVerificationPlanDigest(resolveVerificationPlan(options), original.digest, original, { phase: 'before_stage', stageId: 'test' });
    for (const [file, text, expected] of [
      ['scripts/dependency.gd', 'extends Node\nvar changed = true\n', 'project_code'],
      ['qa/fixture.gd', 'extends Node\nvar fixture_changed = true\n', 'test_fixtures'],
      ['docs/notes.md', 'frozen project document\n', 'documentation'],
    ]) {
      const previous = resolveVerificationPlan(options);
      writeFileSync(join(project, file), text);
      assert.throws(() => assertVerificationPlanDigest(resolveVerificationPlan(options), previous.digest, previous,
        { phase: 'after_stage', stageId: 'test' }), error => {
        assert.equal(error.resultClassification, 'plan_drift');
        assert.equal(error.planDrift.phase, 'after_stage');
        assert.ok(error.planDrift.changedCategories.includes(expected));
        assert.equal(error.planDrift.originalInputsDigest, previous.evidenceBinding.inputsDigest);
        assert.equal(error.planDrift.priorEvidenceScope, 'original_inputs_only');
        return true;
      });
    }
    const previous = resolveVerificationPlan(options);
    config.profiles.smoke.seed = 2;
    saveConfig();
    assert.throws(() => assertVerificationPlanDigest(resolveVerificationPlan(options), previous.digest, previous), error => {
      assert.ok(error.planDrift.changedCategories.includes('configuration'));
      return true;
    });
  } finally { rmSync(project, { recursive: true, force: true }); }
});
