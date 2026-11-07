import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readVerificationJournal, projectVerificationJournalSeal } from '../cli/evidence-journal.mjs';
import { verificationReportReceipt } from '../extensions/runtime.mjs';

// A reference checkout can run the same assertions before a pure module move.
const cli = process.env.GDECK_REFERENCE_CLI ?? fileURLToPath(new URL('../cli/gdeck.mjs', import.meta.url));
const cases = [
  ['passed', 'PASSED', 'none'], ['assertion', 'FAILED', 'unit_assertion'],
  ['missing', 'INCONCLUSIVE', 'report_missing'], ['corrupt', 'INCONCLUSIVE', 'report_corrupt'],
  ['incomplete', 'INCONCLUSIVE', 'report_incomplete'], ['drift', 'INCONCLUSIVE', 'plan_drift'],
  ['timeout', 'INCONCLUSIVE', 'timeout'], ['import', 'INCONCLUSIVE', 'precondition'],
  ['publication', null, null],
];
for (const [mode, verdict, classification] of cases) {
  test(`Verify preserves ${mode} evidence and cleans its snapshot`, { skip: process.platform === 'win32' }, () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'gdeck-verify-regression-')));
    try {
      mkdirSync(join(project, '.gdeck'));
      mkdirSync(join(project, 'tests'));
      writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
      writeFileSync(join(project, 'tests/example_test.gd'), 'extends RefCounted\n');
      const marker = join(project, '.gdeck/snapshot-path');
      const engine = join(project, 'engine.mjs');
      writeFileSync(engine, `#!${process.execPath}
import {writeFileSync} from 'node:fs';
const args=process.argv, mode=${JSON.stringify(mode)};
const value=prefix=>args.find(x=>x.startsWith(prefix))?.slice(prefix.length);
writeFileSync(${JSON.stringify(marker)},args[args.indexOf('--path')+1]);
if(args.includes('--import')) {
  if(mode==='import') {console.error('ERROR: import fixture failure');process.exit(1);}
  process.exit(0);
}

if(mode==='timeout') {writeFileSync(value('--report='),JSON.stringify({schema_version:2,complete:false,unit_binding:JSON.parse(Buffer.from(value('--gdeck-unit-binding='),'base64url'))}));setInterval(()=>{},1000);}
else if(mode!=='missing') {
  const failed=mode==='assertion';
  const report={schema_version:2,complete:mode!=='incomplete',unit_binding:JSON.parse(Buffer.from(value('--gdeck-unit-binding='),'base64url')),
    status:failed?'failed':'passed',summary:{total:1,passed:failed?0:1,failed:failed?1:0,assertions:1,duration_ms:1},cases:[{name:'fixture',passed:!failed,failure_kind:failed?'assertion':null}]};
  writeFileSync(value('--report='),mode==='corrupt'?'{bad':JSON.stringify(report));
  if(mode==='drift') writeFileSync(${JSON.stringify(join(project, 'tests/example_test.gd'))},'extends Node\\n');
}
`, { mode: 0o700 });
      writeFileSync(join(project, '.gdeck/config.json'), JSON.stringify({ godotPath: engine, verify: { doctor: false, check: false, unit: true } }));
      const output = join(project, '.gdeck/reports/result.json');
      const result = spawnSync(process.execPath, [cli, 'verify', project, '--output', output, '--timeout', '3'], {
        env: { ...process.env, GODOT_BIN: engine, GDECK_TEST_FAIL_AGGREGATE_PUBLICATION: mode === 'publication' ? '1' : '0' },
        encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
      });
      assert.equal(result.error, undefined, 'external watchdog must not rescue Verify');
      assert.equal(existsSync(dirname(readFileSync(marker, 'utf8'))), false, 'owned snapshot is removed');
      if (mode === 'publication') {
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(output), false);
        assert.equal(existsSync(output.replace(/\.json$/, '.md')), false, 'partial Markdown is removed');
        return;
      }
      const bytes = readFileSync(output);
      const report = JSON.parse(bytes);
      assert.equal(report.resultEnvelope.verdict, verdict, result.stdout + result.stderr);
      assert.equal(report.resultEnvelope.failureClassification?.code ?? null, classification);
      assert.equal(result.status === 0, verdict === 'PASSED');
      const receipt = verificationReportReceipt(result.stdout);
      assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(receipt.size, bytes.length);
      assert.equal(receipt.invocationIdentity, report.evidenceBinding.invocationIdentity);
      const journal = readVerificationJournal(report.journal.path);
      assert.equal(journal.integrity, 'valid');
      assert.equal(projectVerificationJournalSeal(report.journal.path).seal, 'sealed');
      for (const record of journal.records) {
        const reference = record.payload?.report;
        if (!reference) continue;
        const stageBytes = readFileSync(reference.path);
        assert.equal(reference.sha256, createHash('sha256').update(stageBytes).digest('hex'));
        assert.equal(reference.size, stageBytes.length);
      }
      if (process.env.GDECK_PARITY_OUTPUT) {
        const semantics = { code: result.status, verdict, classification, coverage: report.coverage,
          stages: report.stages.map(s => ({ kind: s.kind, status: s.status, exitCode: s.exitCode, outcome: s.outcome?.classification })) };
        mkdirSync(process.env.GDECK_PARITY_OUTPUT, { recursive: true });
        writeFileSync(join(process.env.GDECK_PARITY_OUTPUT, `${mode}.json`), JSON.stringify(semantics, null, 2));
      }
    } finally { rmSync(project, { recursive: true, force: true }); }
  });
}

for (const mode of ['passed', 'tampered', 'rollback']) {
  test(`Verify export ${mode} binds artifacts or restores the prior build`, { skip: process.platform === 'win32' }, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gdeck-export-regression-')));
    const project = join(root, 'project');
    try {
      mkdirSync(join(project, '.gdeck'), { recursive: true });
      mkdirSync(join(project, 'build/windows'), { recursive: true });
      const output = join(project, 'build/windows/game.exe');
      const manifest = join(project, 'build/release-manifest.json');
      writeFileSync(output, 'prior executable');
      writeFileSync(manifest, 'prior manifest');
      writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
      writeFileSync(join(project, 'export_presets.cfg'), '[preset.0]\nname="Windows Desktop"\nplatform="Windows Desktop"\n');
      const engine = join(root, 'engine.mjs');
      writeFileSync(engine, `#!${process.execPath}
import {writeFileSync} from 'node:fs';
const output=process.argv.at(-1);
writeFileSync(output,'new executable');writeFileSync(output.replace(/\\.exe$/,'.pck'),'new package');
`, { mode: 0o700 });
      // This deterministic seam runs after artifact hashes are collected and
      // directories are replaced, before manifest publication and drift checks.
      const git = join(root, 'git');
      writeFileSync(git, `#!${process.execPath}
import {writeFileSync} from 'node:fs';
if(${JSON.stringify(mode)}==='tampered') writeFileSync(${JSON.stringify(output)},'changed executable');
if(${JSON.stringify(mode)}==='rollback') writeFileSync(${JSON.stringify(join(project, 'project.godot'))},'config_version=5\\n; changed input\\n');
console.log('fixture-sha');
`, { mode: 0o700 });
      writeFileSync(join(project, '.gdeck/config.json'), JSON.stringify({ godotPath: engine,
        verify: { doctor: false, check: false, unit: false, exports: ['windows'] },
        exports: { targets: { windows: { preset: 'Windows Desktop', path: 'build/windows/game.exe' } } } }));
      const reportPath = join(project, '.gdeck/reports/result.json');
      const result = spawnSync(process.execPath, [cli, 'verify', project, '--output', reportPath, '--timeout', '5'], {
        env: { ...process.env, GODOT_BIN: engine, PATH: `${root}:${process.env.PATH}` }, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
      });
      assert.equal(result.error, undefined);
      const report = JSON.parse(readFileSync(reportPath));
      assert.equal(projectVerificationJournalSeal(report.journal.path).seal, 'sealed');
      assert.equal(report.resultEnvelope.failureClassification.code, { passed: 'none', tampered: 'export_integrity', rollback: 'plan_drift' }[mode], result.stdout + result.stderr);
      assert.equal(result.status === 0, mode === 'passed');
      assert.equal(existsSync(join(project, '.gdeck/export-staging')), false);
      if (mode === 'rollback') {
        assert.equal(readFileSync(output, 'utf8'), 'prior executable');
        assert.equal(readFileSync(manifest, 'utf8'), 'prior manifest');
      } else {
        const release = JSON.parse(readFileSync(manifest));
        assert.equal(release.publishReady, false);
        assert.equal(release.artifacts.length, mode === 'passed' ? 1 : 0);
        if (mode === 'passed') assert.equal(release.artifacts[0].sha256, createHash('sha256').update(readFileSync(output)).digest('hex'));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
