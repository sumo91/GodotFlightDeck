import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVerificationPlan, assertVerificationPlanDigest, verificationPlanSummary } from '../cli/verification-plan.mjs';
import { createVerificationJournal, appendVerificationJournalRecord, closeVerificationJournal, readVerificationJournal } from '../cli/evidence-journal.mjs';

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

test('an incomplete Unit report remains a recorded inconclusive outcome, not a journal write error', () => {
  const project = mkdtempSync(join(tmpdir(), 'gdeck-incomplete-journal-'));
  let writer;
  try {
    mkdirSync(join(project, '.gdeck'), { recursive: true });
    mkdirSync(join(project, 'tests'));
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
    writeFileSync(join(project, 'tests/example_test.gd'), 'extends Node\n');
    writeFileSync(join(project, '.gdeck/config.json'), JSON.stringify({ verificationProfiles: { fast: { unit: 'auto' } } }));
    const plan = resolveVerificationPlan({ project, outputPath: join(project, '.gdeck/reports/verify.json'),
      invocationIdentity: 'b'.repeat(64), verificationProfile: 'fast' });
    writer = createVerificationJournal(plan);
    const stage = plan.stages.find(item => item.kind === 'unit');
    appendVerificationJournalRecord(writer, 'preflight_completed', {}, 1);
    appendVerificationJournalRecord(writer, 'stage_started', { ordinal: 1, total: 1, stageId: stage.id }, 2);
    appendVerificationJournalRecord(writer, 'stage_terminal', { ordinal: 1, stageId: stage.id, state: 'failed', report: null,
      outcome: { classification: 'report_incomplete', source: 'preflight' } }, 3);
    const read = readVerificationJournal(plan.evidenceBinding.journalPath);
    assert.equal(read.integrity, 'valid');
    assert.equal(read.records.at(-1).payload.outcome.classification, 'report_incomplete');
  } finally {
    if (writer) closeVerificationJournal(writer);
    rmSync(project, { recursive: true, force: true });
  }
});
