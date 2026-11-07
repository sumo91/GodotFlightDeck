import { parseCliArguments } from '../registry/commands.mjs';
import { writeFileAtomicNoReplace } from './atomic-files.mjs';
import { assertionCompletion, firstReportDiagnostics, renderDiagnosticText } from './diagnostics.mjs';
import { requireInvocationIdentity } from './evidence-contract.mjs';
import { appendVerificationJournalRecord, closeVerificationJournal, createVerificationJournal } from './evidence-journal.mjs';
import { applyEvidenceRetention } from './evidence-retention.mjs';
import { performanceBudgetResults } from './performance-budgets.mjs';
import { resolveProject } from './project-config.mjs';
import { releaseGitSha, releaseManifestPath, writeReleaseManifest } from './release-manifest.mjs';
import { ResultClassificationError, buildResultEnvelope, renderResultEnvelopeText } from './result-envelope.mjs';
import { pathContainsSymlink, pathIsInside } from './safety.mjs';
import { DEFAULT_TIMEOUT_SECONDS, TOOL_VERSION, color, timestamp } from './tool-context.mjs';
import { unitBindingForExecution, verificationUnitOwnerNonce } from './unit-binding.mjs';
import { unitReportDisposition } from './unit-progress.mjs';
import { assertVerificationPlanDigest, resolveVerificationPlan, verificationPlanSummary } from './verification-plan.mjs';
import { boundedOutputTail, boundedStageReport, closeVerificationPublicationDirectories, invalidateVerificationPublicationArtifacts, openVerificationPublicationDirectories, preflightReportForVerificationPlan, printVerificationFailureDigest, publishVerificationPreflightFailure, publishVerificationReport, reportIoFailure } from './verification-report.mjs';
import { assertCurrentVerificationPlanForEffect, createVerificationSnapshot, removeVerificationSnapshot } from './verification-snapshot.mjs';
import { executeVerificationCommand } from './verification-stage.mjs';
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export async function verifyProject(projectCandidate, options, expectedPlanDigest = '', invocationIdentity = '') {
  const project = resolveProject(projectCandidate);
  const started = Date.now();
  const output = resolve(options.output ?? join(project, '.gdeck', 'reports', `verify-${timestamp()}.json`));
  const planOptions = {
    project,
    outputPath: output,
    timeoutSeconds: options.timeout ?? DEFAULT_TIMEOUT_SECONDS,
    verificationProfile: options.profile,
    invocationIdentity: requireInvocationIdentity(invocationIdentity),
  };
  const plan = resolveVerificationPlan(planOptions);
  console.log(`Verification plan ${plan.digest}; inputs ${plan.evidenceBinding.inputsDigest}`);
  console.log(`Frozen scope: project tree and selected configuration; ${plan.inputs.find(input => input.kind === 'project-tree')?.fileCount ?? 0} files. Changes to bound inputs invalidate this run; no global editing lock.`);
  console.log(`Excluded paths: ${verificationPlanSummary(plan).excluded.map(item => item.path).join(', ')}; .gdeck/config.json remains bound semantically; .import excluded, .uid bound separately.`);
  let executionSnapshot;
  let publicationDirectories;
  let verificationJournal;
  let journalFailure = false;
  let finalReportVerdict = '';
  const journalStarted = process.hrtime.bigint();
  const journalElapsedMs = () => Number((process.hrtime.bigint() - journalStarted) / 1_000_000n);
  assertVerificationPlanDigest(plan, expectedPlanDigest);
  try {
    applyEvidenceRetention(plan);
    planOptions.retentionCandidateManifest = plan.evidenceBinding.retentionCandidates;
    planOptions.retentionEffectsMayBeFulfilled = true;
    verificationJournal = createVerificationJournal(plan);
    invalidateVerificationPublicationArtifacts(plan);
    publicationDirectories = openVerificationPublicationDirectories(plan);
    executionSnapshot = plan.stages.some((stage) => stage.disposition === 'run' && stage.includeInLegacyReport)
      ? await createVerificationSnapshot(plan)
      : null;
    appendVerificationJournalRecord(verificationJournal, 'preflight_completed', {}, journalElapsedMs());
  } catch (error) {
    if (!verificationJournal || error?.code === 'evidence_owner_conflict') throw error;
    try {
      error.resultReport = publishVerificationPreflightFailure(
        plan, started, error, publicationDirectories, verificationJournal, journalElapsedMs,
      );
    } catch (publicationError) {
      publicationError.resultReport = preflightReportForVerificationPlan(plan);
      throw publicationError;
    } finally {
      closeVerificationPublicationDirectories(publicationDirectories);
      publicationDirectories = undefined;
      if (verificationJournal) {
        try { closeVerificationJournal(verificationJournal); }
        catch (error) { throw reportIoFailure('Cannot close verification Journal ownership', error); }
        verificationJournal = undefined;
      }
    }
    throw error;
  }
  try {
  const stages = [];
  const verifiedExportRecords = [];
  const pendingExportStages = [];
  let exportExecutionAttempted = false;
  let planDrifted = false;
  const journalStages = plan.stages.filter((stage) => stage.includeInLegacyReport);
  const journalOrdinal = new Map(journalStages.map((stage, index) => [stage.id, index + 1]));

  function commitJournal(type, payload) {
    try {
      appendVerificationJournalRecord(verificationJournal, type, payload, journalElapsedMs());
      return true;
    } catch {
      journalFailure = true;
      return false;
    }
  }

  function journalReportReference(stage) {
    if (stage.journalReportReference) return stage.journalReportReference;
    const reportPath = stage.journalReportPath ?? stage.reportPath;
    if (!reportPath || stage.evidenceAccepted === false || !existsSync(reportPath)) return null;
    const bytes = readFileSync(reportPath);
    return {
      path: reportPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  }

  function commitStageTerminal(planned, stage, state = stage.status) {
    const outcome = stage.outcome && typeof stage.outcome.classification === 'string' && typeof stage.outcome.source === 'string'
      ? { classification: stage.outcome.classification, source: stage.outcome.source }
      : undefined;
    return commitJournal('stage_terminal', {
      ordinal: journalOrdinal.get(planned.id),
      stageId: planned.id,
      state,
      report: journalReportReference(stage),
      ...(outcome ? { outcome } : {}),
    });
  }

  function legacyStage(planned, values) {
    const stage = {
      planStageId: planned.id,
      kind: planned.kind,
      target: planned.target,
      status: values.status,
      exitCode: values.exitCode,
      durationMs: values.durationMs ?? 0,
      reportPath: values.reportPath ?? null,
      report: values.report ?? null,
      outputTail: values.outputTail ?? '',
      replay: {
        verificationProfile: plan.verificationProfile,
        runtimeProfile: planned.runtime?.profile ?? null,
        seed: planned.runtime?.seed ?? null,
        fixtureAdapter: planned.runtime?.fixtureAdapter ?? null,
        timeoutMs: planned.timeoutMs,
      },
      ...(values.outcome ? { outcome: values.outcome } : {}),
      ...(values.processEvidence ? { processEvidence: values.processEvidence } : {}),
      ...(values.diagnostics ? { diagnostics: values.diagnostics } : {}),
      ...(values.planDrift ? { planDrift: values.planDrift } : {}),
      ...(values.evidenceAccepted === false ? { evidenceAccepted: false } : {}),
      ...(values.relatedOutcomes?.length ? { relatedOutcomes: values.relatedOutcomes } : {}),
      ...(values.artifacts ? { artifacts: values.artifacts } : {}),
    };
    stages.push(stage);
    return stage;
  }

  function ensurePlanIsCurrent(planned) {
    try {
      const current = resolveVerificationPlan(planOptions);
      assertVerificationPlanDigest(current, plan.digest, plan, { phase: 'before_stage', stageId: planned.id });
      return true;
    } catch (error) {
      console.log(`\n${color.muted(`── ${planned.kind}: ${planned.target}`)}`);
      console.error(color.red(error.message));
      legacyStage(planned, {
        status: 'failed', exitCode: 1, outputTail: error.message,
        outcome: { classification: 'plan_drift', source: 'preflight', summary: error.message },
        planDrift: error.planDrift,
      });
      planDrifted = true;
      return false;
    }
  }

  async function executePlannedStage(planned) {
    console.log(`\n${color.muted(`── ${planned.kind}: ${planned.target}`)}`);
    if (planned.reportPath && existsSync(planned.reportPath)) {
      throw new ResultClassificationError('report_io', `Invocation-owned stage report path is unexpectedly occupied: ${planned.reportPath}`);
    }
    const command = await executeVerificationCommand(planned, plan, executionSnapshot?.project ?? project);
    let detail = null;
    let reportError = '';
    let reportClassification = 'report_corrupt';
    let operationalIncompleteUnit = false;
    let journalReport;
    if (planned.reportPath) {
      if (!existsSync(planned.reportPath)) reportError = `Expected stage report was not produced: ${planned.reportPath}`;
      else if (pathContainsSymlink(project, planned.reportPath)) reportError = `Exact stage report path contains a symbolic link: ${planned.reportPath}`;
      else {
        let descriptor;
        try {
          descriptor = openSync(planned.reportPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
          const before = fstatSync(descriptor);
          const reportStageCount = Math.max(1, plan.stages.filter((stage) => Boolean(stage.reportPath)).length);
          const maximumStageReportBytes = Math.min(64 * 1024 * 1024, Math.floor((128 * 1024 * 1024) / reportStageCount));
          if (!before.isFile() || before.size > maximumStageReportBytes) {
            throw new Error(`Exact stage report is not a file or exceeds its invocation-bound ${maximumStageReportBytes} byte budget: ${planned.reportPath}`);
          }
          fchmodSync(descriptor, 0o600);
          const bytes = readFileSync(descriptor);
          const after = fstatSync(descriptor);
          const pathAfter = lstatSync(planned.reportPath);
          if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.isSymbolicLink()) {
            throw new Error(`Exact stage report changed while it was being bound: ${planned.reportPath}`);
          }
          const rawReport = JSON.parse(bytes.toString('utf8'));
          if (planned.kind === 'unit') {
            const parsedUnitCommand = parseCliArguments(planned.commandArgs);
            const expectedUnitBinding = unitBindingForExecution({
              project: plan.project,
              report: planned.reportPath,
              timeoutMs: planned.timeoutMs,
              options: parsedUnitCommand.options,
              invocationIdentity: plan.invocationIdentity,
              ownerNonce: verificationUnitOwnerNonce(plan, planned),
            });
            const disposition = unitReportDisposition(rawReport, rawReport.schema_version === 2 ? expectedUnitBinding : undefined);
            if (disposition.state !== 'terminal') {
              operationalIncompleteUnit = disposition.state === 'incomplete';
              reportClassification = disposition.state === 'incomplete' ? 'report_incomplete' : 'report_corrupt';
              throw new Error(disposition.state === 'incomplete'
                ? 'Unit report is incomplete operational evidence and cannot qualify a stage result'
                : 'Unit report schema, owner, invocation, output, timeout, or runtime binding is invalid');
            }
          }
          detail = boundedStageReport(planned.kind, rawReport);
          journalReport = {
            path: planned.reportPath,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
          };
        } catch (error) { reportError = `Cannot read exact stage report: ${error.message}`; }
        finally { if (Number.isInteger(descriptor)) closeSync(descriptor); }
      }
    }
    const stage = legacyStage(planned, {
      status: command.exitCode === 0 && !reportError ? 'passed' : 'failed',
      exitCode: command.exitCode,
      durationMs: command.durationMs,
      reportPath: planned.reportPath,
      report: detail,
      outputTail: [command.outputTail, reportError].filter(Boolean).join('\n'),
      processEvidence: command.processEvidence,
      diagnostics: { ...command.diagnostics, assertions: assertionCompletion(planned.kind, detail) },
      outcome: reportError ? ((operationalIncompleteUnit || command.processEvidence.cancelled) && command.outcome ? command.outcome : {
        classification: existsSync(planned.reportPath) ? reportClassification : 'report_missing',
        source: 'preflight',
        summary: reportError,
      }) : command.outcome,
      relatedOutcomes: reportError && command.outcome && !operationalIncompleteUnit && !command.processEvidence.cancelled
        ? [command.outcome]
        : operationalIncompleteUnit ? [{ classification: 'report_incomplete', source: 'preflight', summary: reportError }] : undefined,
    });
    if (journalReport) Object.defineProperty(stage, 'journalReportReference', { value: journalReport, enumerable: false });
    if (planned.kind === 'benchmark') {
      if (stage.report?.performance) {
        stage.budgets = performanceBudgetResults(stage.report.performance, planned.runtime?.budgets ?? {});
        if (stage.budgets.some((budget) => !budget.passed)) stage.status = 'failed';
      } else if (Object.keys(planned.runtime?.budgets ?? {}).length > 0) {
        stage.status = 'failed';
        stage.budgets = [];
      }
    }
    return stage;
  }

  for (const planned of plan.stages) {
    if (!planned.includeInLegacyReport) continue;
    if (planned.disposition === 'skipped') {
      console.log(`\n${color.muted(`── ${planned.kind}: ${planned.target}`)}`);
      console.log(color.yellow(`Stage skipped: ${planned.reason.message}`));
      const stage = legacyStage(planned, { status: 'skipped', exitCode: 0, outputTail: planned.reason.message });
      if (!commitStageTerminal(planned, stage, 'skipped')) break;
      continue;
    }
    if (planned.disposition === 'blocked') {
      console.log(`\n${color.muted(`── ${planned.kind}: ${planned.target}`)}`);
      console.error(color.red(planned.reason.message));
      const blockedClassification = planned.reason.code === 'profile-missing' ? 'configuration' : 'precondition';
      legacyStage(planned, {
        status: 'failed', exitCode: 1, outputTail: planned.reason.message,
        outcome: { classification: blockedClassification, source: 'preflight', summary: planned.reason.message },
      });
      if (planned.kind === 'export') {
        if (plan.confirmationEffects.length > 0) exportExecutionAttempted = true;
        pendingExportStages.push({ planned, stage: stages.at(-1) });
      } else if (!commitStageTerminal(planned, stages.at(-1), 'blocked')) break;
      continue;
    }
    if (planned.disposition !== 'run') continue;
    if (!ensurePlanIsCurrent(planned)) break;
    if (planned.reportPath && existsSync(planned.reportPath)) {
      journalFailure = true;
      legacyStage(planned, {
        status: 'failed', exitCode: 126,
        outputTail: 'Invocation-owned stage report path is unexpectedly occupied.',
        outcome: {
          classification: 'report_io', source: 'preflight',
          summary: 'Invocation-owned stage report path is unexpectedly occupied.',
        },
      });
      break;
    }
    if (!commitJournal('stage_started', {
      ordinal: journalOrdinal.get(planned.id), total: journalStages.length, stageId: planned.id,
    })) break;
    let stage;
    try { stage = await executePlannedStage(planned); }
    catch (error) {
      stage = legacyStage(planned, {
        status: 'failed', exitCode: Number(error.exitCode ?? 126), outputTail: error.message,
        outcome: {
          classification: error.resultClassification ?? 'report_io',
          source: error.resultSource ?? 'preflight',
          summary: error.message,
        },
      });
      journalFailure = true;
      commitStageTerminal(planned, stage, 'failed');
      break;
    }
    if (stage.processEvidence?.cancelled || stage.outcome?.classification === 'cancelled') {
      commitStageTerminal(planned, stage);
      break;
    }
    try {
      const current = resolveVerificationPlan(planOptions);
      assertVerificationPlanDigest(current, plan.digest, plan, { phase: 'after_stage', stageId: planned.id });
    } catch (error) {
      stage.status = 'failed';
      stage.outputTail = [stage.outputTail, `Verification Plan input changed while the stage was running; its result was rejected: ${error.message}`].filter(Boolean).join('\n');
      stage.outcome = { classification: 'plan_drift', source: 'preflight', summary: error.message };
      stage.evidenceAccepted = false;
      stage.planDrift = error.planDrift;
      planDrifted = true;
      if (planned.kind === 'export') exportExecutionAttempted = true;
      commitStageTerminal(planned, stage, 'failed');
      break;
    }
    if (planned.kind !== 'export') {
      if (!commitStageTerminal(planned, stage)) break;
      continue;
    }
    exportExecutionAttempted = true;
    if (stage.status === 'passed') {
    const manifestPath = releaseManifestPath(project);
    try {
      if (!existsSync(manifestPath)) throw new Error('export did not produce a release manifest');
      if (pathContainsSymlink(project, manifestPath)) throw new Error('export release manifest contains a symbolic link');
      const before = lstatSync(manifestPath);
      const manifestBytes = readFileSync(manifestPath);
      const after = lstatSync(manifestPath);
      if (!before.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
        throw new Error('export release manifest changed while it was being bound');
      }
      const stageManifest = JSON.parse(manifestBytes.toString('utf8'));
      if (!Array.isArray(stageManifest.artifacts) || stageManifest.artifacts.length !== 1) {
        throw new Error('export manifest must contain exactly one artifact');
      }
      const artifact = stageManifest.artifacts[0];
      if (artifact.target !== planned.target) throw new Error(`export manifest target mismatch: expected ${planned.target}`);
      try { writeFileAtomicNoReplace(planned.journalReportPath, manifestBytes, { mode: 0o600 }); }
      catch (error) { throw new ResultClassificationError('report_io', `Cannot bind private export stage evidence: ${error.message}`); }
      Object.defineProperty(stage, 'journalReportReference', {
        value: {
          path: planned.journalReportPath,
          sha256: createHash('sha256').update(manifestBytes).digest('hex'),
          size: manifestBytes.length,
        },
        enumerable: false,
      });
      verifiedExportRecords.push({ artifact, stage, errors: [], integrityEvidence: [] });
    } catch (error) {
      stage.status = 'failed';
      stage.outputTail = [stage.outputTail, `Cannot aggregate export manifest: ${error.message}`].filter(Boolean).join('\n');
      stage.outcome = {
        classification: error.resultClassification ?? 'export_integrity',
        source: error.resultSource ?? 'preflight',
        summary: error.message,
      };
      if (error.resultClassification === 'report_io') journalFailure = true;
    }
    }
    pendingExportStages.push({ planned, stage });
    if (journalFailure) break;
  }

  const outputOwners = new Map();
  for (const record of verifiedExportRecords) {
    const artifact = record.artifact;
    const primary = resolve(project, artifact.path ?? '');
    const artifactDirectory = dirname(primary);
    if (!artifact.path || !pathIsInside(project, primary) || pathContainsSymlink(project, primary)) {
      record.errors.push(`unsafe artifact path: ${artifact.path ?? ''}`);
      continue;
    }
    if (!Array.isArray(artifact.files) || artifact.files.length === 0) {
      record.errors.push('artifact file list is empty');
      continue;
    }
    for (let index = 0; index < artifact.files.length; index += 1) {
      const file = artifact.files[index];
      const absolute = resolve(artifactDirectory, file.path ?? '');
      if (!file.path || !pathIsInside(artifactDirectory, absolute) || pathContainsSymlink(project, absolute)) {
        record.errors.push(`unsafe artifact file path: ${file.path ?? ''}`);
        continue;
      }
      if (index === 0 && absolute !== primary) record.errors.push('primary artifact path does not match its file list');
      const previous = outputOwners.get(absolute);
      if (previous) {
        record.errors.push(`artifact path collides with ${previous.artifact.target}: ${absolute}`);
        previous.errors.push(`artifact path collides with ${artifact.target}: ${absolute}`);
      } else {
        outputOwners.set(absolute, record);
      }
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        record.errors.push(`artifact file is missing: ${absolute}`);
        record.integrityEvidence.push({
          summary: `Artifact file is missing: ${absolute}`,
          expected: { path: absolute, sha256: file.sha256, size: file.size },
          actual: { state: 'missing' },
        });
        continue;
      }
      const bytes = readFileSync(absolute);
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== file.sha256 || bytes.length !== file.size) {
        record.errors.push(`artifact file changed after export: ${absolute}`);
        record.integrityEvidence.push({
          summary: `Artifact file changed after export: ${absolute}`,
          expected: { sha256: file.sha256, size: file.size },
          actual: { sha256: actualHash, size: bytes.length },
        });
      }
    }
  }
  for (const record of verifiedExportRecords) {
    if (record.errors.length === 0) {
      const artifactDirectory = dirname(resolve(project, record.artifact.path));
      record.stage.artifacts = [
        { kind: 'release_manifest', path: releaseManifestPath(project) },
        ...record.artifact.files.map((file) => ({ kind: 'release_artifact', path: resolve(artifactDirectory, file.path) })),
      ];
      continue;
    }
    record.stage.status = 'failed';
    const evidence = record.integrityEvidence[0];
    record.stage.outcome = {
      classification: 'export_integrity', source: 'preflight', summary: evidence?.summary ?? record.errors[0],
      ...(evidence?.expected ? { expected: evidence.expected } : {}),
      ...(evidence?.actual ? { actual: evidence.actual } : {}),
    };
    record.stage.outputTail = [record.stage.outputTail, ...record.errors.map((error) => `Cannot aggregate export manifest: ${error}`)].filter(Boolean).join('\n');
  }
  if (exportExecutionAttempted && !planDrifted) {
    try {
      assertCurrentVerificationPlanForEffect(plan, 'before aggregate manifest publication; the aggregate manifest was not replaced');
    } catch (error) {
      planDrifted = true;
      const lastExportStage = [...stages].reverse().find((stage) => stage.kind === 'export');
      if (lastExportStage) {
        lastExportStage.status = 'failed';
        lastExportStage.exitCode = 1;
        lastExportStage.outcome = { classification: 'plan_drift', source: 'preflight', summary: error.message };
        lastExportStage.evidenceAccepted = false;
        lastExportStage.outputTail = [lastExportStage.outputTail, error.message].filter(Boolean).join('\n');
      }
    }
  }
  if (exportExecutionAttempted && !planDrifted) {
    const gitSha = await releaseGitSha(project);
    for (const record of verifiedExportRecords) {
      if (record.errors.length > 0) continue;
      const artifactDirectory = dirname(resolve(project, record.artifact.path));
      for (const file of record.artifact.files) {
        const absolute = resolve(artifactDirectory, file.path);
        if (!existsSync(absolute) || !statSync(absolute).isFile()) {
          record.errors.push(`artifact file disappeared during manifest preparation: ${absolute}`);
          record.integrityEvidence.push({
            summary: `Artifact file disappeared during manifest preparation: ${absolute}`,
            expected: { path: absolute, sha256: file.sha256, size: file.size },
            actual: { state: 'missing' },
          });
          continue;
        }
        const bytes = readFileSync(absolute);
        const actualHash = createHash('sha256').update(bytes).digest('hex');
        if (actualHash !== file.sha256 || bytes.length !== file.size) {
          record.errors.push(`artifact file changed during manifest preparation: ${absolute}`);
          record.integrityEvidence.push({
            summary: `Artifact file changed during manifest preparation: ${absolute}`,
            expected: { sha256: file.sha256, size: file.size },
            actual: { sha256: actualHash, size: bytes.length },
          });
        }
      }
      if (record.errors.length > 0) {
        record.stage.status = 'failed';
        record.stage.exitCode = 1;
        const evidence = record.integrityEvidence[0];
        record.stage.outcome = {
          classification: 'export_integrity', source: 'preflight', summary: evidence?.summary ?? record.errors[0],
          ...(evidence?.expected ? { expected: evidence.expected } : {}),
          ...(evidence?.actual ? { actual: evidence.actual } : {}),
        };
        record.stage.outputTail = [record.stage.outputTail, ...record.errors.map((error) => `Cannot publish aggregate export manifest: ${error}`)].filter(Boolean).join('\n');
      }
    }
    const verifiedExportArtifacts = verifiedExportRecords
      .filter((record) => record.errors.length === 0)
      .map((record) => record.artifact);
    await writeReleaseManifest(project, { debug: false, publishRequested: false, artifacts: verifiedExportArtifacts, gitSha });
  }

  for (const pending of pendingExportStages) {
    if (!commitStageTerminal(pending.planned, pending.stage)) break;
  }

  const completedSnapshot = executionSnapshot;
  executionSnapshot = null;
  const cleanupStarted = process.hrtime.bigint();
  removeVerificationSnapshot(completedSnapshot);
  const snapshotCleanupMs = Number(process.hrtime.bigint() - cleanupStarted) / 1_000_000;

  for (const stage of stages) stage.outputTail = boundedOutputTail(stage.outputTail);
  const failed = stages.filter((stage) => stage.status === 'failed').length;
  const skipped = stages.filter((stage) => stage.status === 'skipped').length;
  const passed = stages.filter((stage) => stage.status === 'passed').length;
  const markdown = plan.markdownPath;
  const report = {
    schemaVersion: 2,
    flightDeckVersion: TOOL_VERSION,
    project,
    verificationProfile: plan.verificationProfile,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    status: failed === 0 && !planDrifted ? 'passed' : 'failed',
    summary: { total: stages.length, passed, skipped, failed },
    stages,
    verificationPlanDigest: plan.digest,
    verificationPlan: verificationPlanSummary(plan),
    timings: { preparation: completedSnapshot?.timings ?? null, snapshotCleanupMs },
    evidenceBinding: plan.evidenceBinding,
    journal: { path: plan.evidenceBinding.journalPath, invocationIdentity: plan.invocationIdentity },
    coverage: plan.stages.map((stage) => ({
      kind: stage.kind,
      target: stage.target,
      disposition: stage.disposition,
      execution: stage.disposition === 'run'
        ? stages.some((result) => result.planStageId === stage.id) ? 'attempted' : 'not_attempted'
        : 'not_applicable',
      reason: stage.reason,
    })),
  };
  report.resultEnvelope = buildResultEnvelope({ report, reportPath: output, markdownPath: markdown });
  finalReportVerdict = report.resultEnvelope.verdict;
  ({ journalFailure, verdict: finalReportVerdict } = publishVerificationReport(
    plan, report, publicationDirectories, verificationJournal, journalElapsedMs, journalFailure,
  ));
  console.log(`\n${renderResultEnvelopeText(report.resultEnvelope)}`);
  const hint = renderDiagnosticText(firstReportDiagnostics(report));
  if (hint) console.error(hint);
  console.log(`\n${report.status === 'passed' ? color.green('Verification passed') : color.red('Verification failed')}`);
  console.log(`  Stages:   ${report.summary.passed} passed, ${report.summary.skipped} skipped, ${report.summary.failed} failed`);
  console.log(`  JSON:     ${output}`);
  console.log(`  Markdown: ${markdown}`);
  if (report.status !== 'passed') printVerificationFailureDigest(report, output, markdown, options);
  if (journalFailure && report.resultEnvelope.verdict !== 'FAILED') return 126;
  return report.status === 'passed' ? 0 : 1;
  } finally {
    removeVerificationSnapshot(executionSnapshot);
    closeVerificationPublicationDirectories(publicationDirectories);
    if (verificationJournal) {
      try { closeVerificationJournal(verificationJournal); }
      catch (error) {
        if (!journalFailure && finalReportVerdict !== 'FAILED') {
          throw reportIoFailure('Cannot close verification Journal ownership', error);
        }
        if (!journalFailure) {
          console.error(color.yellow('Verification Journal ownership cleanup failed after qualified product evidence; aggregate FAILED remains authoritative.'));
        }
      }
    }
  }
}
