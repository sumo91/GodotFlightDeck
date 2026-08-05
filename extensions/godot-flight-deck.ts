import { chmod, lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PI_FIELDS, getPiFamily, parseCliArguments } from "../registry/commands.mjs";
import {
  createUnitExecutionBinding,
  createUnitProgressStream,
  normalizeVerbosity,
  projectUnitProgress,
  unitReportDisposition,
} from "../cli/unit-progress.mjs";
import { renderVerificationProgress, startVerificationProgressObserver } from "../cli/progress-observer.mjs";
import {
  ApprovalLeaseStore,
  approvalLeaseScope,
  buildCliArgs,
  buildResultEnvelope,
  confirmationLifecycle,
  enrichResultEnvelope,
  extensionExecutionTimeoutMilliseconds,
  extensionSupervisedExecutionTimeoutMilliseconds,
  failureFirstSummary,
  findGodotProject,
  journalInterruptionProjection,
  projectDoctorProcessResult,
  operationConfirmation,
  operationDescription,
  readPiSafetyConfig,
  renderResultEnvelopeText,
  resolveActiveProject,
  structuredFailureSummary,
  validationReportSummary,
  verificationReportMatchesEvidenceBinding,
  verificationReportReadEvent,
  verificationReportReceipt,
} from "./runtime.mjs";
const CLI_FILE = fileURLToPath(new URL("../cli/gdeck.mjs", import.meta.url));
const PROCESS_RUNNER_FILE = fileURLToPath(new URL("../cli/process-runner.mjs", import.meta.url));
const PLAN_HELPER_FILE = fileURLToPath(new URL("../cli/verification-plan-helper.mjs", import.meta.url));
const TOOL_TIMEOUT_SECONDS = 300;
const approvalLeases = new ApprovalLeaseStore();

function fieldSchema(fieldName: string) {
  const definition: any = (PI_FIELDS as any)[fieldName];
  if (!definition) throw new Error(`Unknown Flight Deck schema field: ${fieldName}`);
  const { kind, optional, values, ...constraints } = definition;
  let schema: any;
  if (kind === "string") schema = Type.String(constraints);
  else if (kind === "number") schema = Type.Number(constraints);
  else if (kind === "integer") schema = Type.Integer(constraints);
  else if (kind === "boolean") schema = Type.Boolean(constraints);
  else if (kind === "enum") schema = StringEnum(values as any);
  else if (kind === "any") schema = Type.Any(constraints);
  else if (kind === "operations") schema = Type.Array(Type.Record(Type.String(), Type.Any()), constraints);
  else throw new Error(`Unsupported Flight Deck schema kind: ${kind}`);
  return optional ? Type.Optional(schema) : schema;
}

function familySchema(familyName: ToolFamily) {
  const family: any = getPiFamily(familyName);
  if (!family) throw new Error(`Unknown Flight Deck tool family: ${familyName}`);
  const properties: Record<string, any> = {
    action: StringEnum(Object.keys(family.actions) as any),
  };
  for (const entry of family.fields) {
    const publicName = typeof entry === "string" ? entry : entry.name;
    const fieldName = typeof entry === "string" ? entry : entry.field;
    properties[publicName] = fieldSchema(fieldName);
  }
  return Type.Object(properties, { additionalProperties: false });
}

const ProjectParams = familySchema("project");
const ValidateParams = familySchema("validate");
const ReleaseParams = familySchema("release");
const EditorParams = familySchema("editor");
const SceneParams = familySchema("scene");
const RunParams = familySchema("run");

type ToolFamily = "project" | "validate" | "release" | "editor" | "scene" | "run";
type ToolParams = Record<string, any>;

interface InvocationDetails {
  family: ToolFamily;
  action: string;
  project: string;
  exitCode: number;
  report?: unknown;
  reportPath?: string;
  manifest?: unknown;
  manifestPath?: string;
  fullLogPath?: string;
  truncated: boolean;
  resultEnvelope?: unknown;
  journal?: unknown;
  progress?: unknown;
}

function renderInterruptionProjection(value: any) {
  if (!value) return "";
  const current = value.currentStage
    ? `; current stage ${value.currentStage.ordinal} (${value.currentStage.stageId})`
    : "";
  return `Incremental evidence (non-authoritative): integrity ${value.integrity}; seal ${value.seal}; completed stages ${value.completedStageCount}${current}`;
}

function verificationStrategy(params: ToolParams) {
  return params.profile
    ? { mode: "profile", profile: String(params.profile) }
    : { mode: "legacy", profile: null };
}

function envelopeFailure(strategy: any, classification: string, source: string, message: string, report: any = null) {
  const resultEnvelope = buildResultEnvelope({ report, strategy, event: { classification, source, summary: message } });
  const error: any = new Error(`${renderResultEnvelopeText(resultEnvelope)}\n\n${message}`);
  error.resultEnvelope = resultEnvelope;
  error.resultClassification = classification;
  return error;
}

function invocationFailure(message: string, resultEnvelope: any, details: InvocationDetails | undefined = undefined) {
  const error: any = new Error(message);
  error.resultEnvelope = resultEnvelope;
  if (details) error.details = details;
  return error;
}

function outputPrefix(resultEnvelope: any, failureSummary: string) {
  const envelope = resultEnvelope ? `${renderResultEnvelopeText(resultEnvelope)}\n\n` : "";
  const failure = failureSummary ? `Failure summary (bounded; selected from full output before truncation):\n${failureSummary}\n\n` : "";
  return `${envelope}${failure}`;
}

async function boundedOutput(output: string, failureSummary = "", resultEnvelope: any = undefined, withholdOutput = false, upstreamTruncated = false) {
  if (resultEnvelope && upstreamTruncated) resultEnvelope = enrichResultEnvelope(resultEnvelope, { outputTruncated: true });
  let prefix = outputPrefix(resultEnvelope, failureSummary);
  if (withholdOutput && output) {
    const directory = await mkdtemp(join(tmpdir(), "gdeck-pi-log-"));
    const fullLogPath = join(directory, "output.log");
    await writeFile(fullLogPath, output, { encoding: "utf8", mode: 0o600 });
    if (resultEnvelope) resultEnvelope = enrichResultEnvelope(resultEnvelope, { outputTruncated: upstreamTruncated, outputWithheld: true, fullLogPath });
    prefix = outputPrefix(resultEnvelope, failureSummary);
    return {
      text: `${prefix}Verification raw output was withheld from the first result. Full captured output: ${fullLogPath}`,
      fullLogPath,
      truncated: upstreamTruncated,
      resultEnvelope,
    };
  }
  let outputMaxBytes = Math.max(1_024, DEFAULT_MAX_BYTES - Buffer.byteLength(prefix) - 512);
  let outputMaxLines = Math.max(100, DEFAULT_MAX_LINES - prefix.split("\n").length);
  let truncation = truncateTail(output, { maxLines: outputMaxLines, maxBytes: outputMaxBytes });
  let fullLogPath: string | undefined;
  if (truncation.truncated) {
    const directory = await mkdtemp(join(tmpdir(), "gdeck-pi-log-"));
    fullLogPath = join(directory, "output.log");
    await writeFile(fullLogPath, output, { encoding: "utf8", mode: 0o600 });
    if (resultEnvelope) resultEnvelope = enrichResultEnvelope(resultEnvelope, { outputTruncated: true, fullLogPath });
    prefix = outputPrefix(resultEnvelope, failureSummary);
    outputMaxBytes = Math.max(1_024, DEFAULT_MAX_BYTES - Buffer.byteLength(prefix) - 512);
    outputMaxLines = Math.max(100, DEFAULT_MAX_LINES - prefix.split("\n").length);
    truncation = truncateTail(output, { maxLines: outputMaxLines, maxBytes: outputMaxBytes });
  }
  let text = prefix + (truncation.content || "Flight Deck command completed without output.");
  if (truncation.truncated) {
    text += `\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines`;
    text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    text += ` Full output: ${fullLogPath}]`;
  }
  return { text, fullLogPath, truncated: upstreamTruncated || truncation.truncated, resultEnvelope };
}

function preflightReportForPlan(verificationPlan: any) {
  return verificationPlan ? {
    verificationProfile: verificationPlan.verificationProfile,
    coverage: verificationPlan.stages.map((stage: any) => ({
      kind: stage.kind,
      target: stage.target,
      disposition: stage.disposition,
      execution: stage.disposition === "run" ? "not_attempted" : "not_applicable",
      reason: stage.reason,
    })),
  } : null;
}

async function requireConfirmation(ctx: ExtensionContext, family: ToolFamily, params: ToolParams, project: string, force = false, verificationPlan: any = null) {
  const confirmation = operationConfirmation(family, params.action, params);
  const preflightReport = preflightReportForPlan(verificationPlan);
  const scope = approvalLeaseScope(family, params.action, params);
  const decision = { scope, leaseUsed: false, grantLeaseSeconds: 0 };
  if (!force && !confirmation.required) return decision;
  const safety = readPiSafetyConfig(project);
  const description = operationDescription(family, params.action, params);
  const editorLifecycleWarning = family === "project" && params.action === "init"
    ? "\n\nThe Editor may already be open even when no current session metadata exists (for example, during an upgrade from 1.3). The on-disk update is transactional, and any running Editor must be restarted before Bridge writes can resume."
    : "";
  const leaseNotice = confirmation.leaseEligible && safety.approvalLeaseSeconds > 0
    ? `\nA successful execution creates an in-memory lease for only this exact project, ${family}:${params.action} action, and effect scope, expiring ${safety.approvalLeaseSeconds} seconds after success.`
    : "\nNo approval lease will be created for this operation.";
  const confirmationTimeoutMilliseconds = safety.confirmationTimeoutSeconds * 1_000;
  const lifecycle = await confirmationLifecycle({
    hasUI: ctx.hasUI,
    leaseEligible: confirmation.leaseEligible,
    leaseAvailable: ctx.hasUI && confirmation.leaseEligible && safety.approvalLeaseSeconds > 0
      && approvalLeases.has(project, family, params.action, scope),
    timeoutMilliseconds: confirmationTimeoutMilliseconds,
    approvalLeaseSeconds: safety.approvalLeaseSeconds,
    confirm: ({ deadline }: { deadline: number }) => ctx.ui.confirm(
      `Pi system confirmation required — ${confirmation.risk} risk`,
      `Project: ${project}\nOperation: ${description}\nRisk tier: ${confirmation.risk}\nPreflight completed; execution has not started.\nDecision deadline: ${new Date(deadline).toISOString()} (${safety.confirmationTimeoutSeconds} seconds).${leaseNotice}${editorLifecycleWarning}\n\nApproval written in chat does not authorize this operation. Confirm it in this Pi dialog.`,
      { timeout: confirmationTimeoutMilliseconds },
    ),
  });
  if (lifecycle.outcome === "approved") {
    decision.leaseUsed = lifecycle.leaseUsed;
    decision.grantLeaseSeconds = lifecycle.grantLeaseSeconds;
    return decision;
  }
  if (lifecycle.outcome === "unavailable") {
    const message = "Flight Deck denied this operation because no Pi system confirmation dialog is available. Chat approval cannot bypass the system confirmation; nothing was changed.";
    if (family === "validate" && params.action === "verify") throw envelopeFailure(verificationStrategy(params), "confirmation_unavailable", "cancellation", message, preflightReport);
    throw new Error(message);
  }
  if (lifecycle.outcome === "timeout") {
    const message = `The Pi system confirmation timed out at its ${safety.confirmationTimeoutSeconds}-second decision deadline. Nothing was changed; invoke the operation again if you want another confirmation dialog.`;
    if (family === "validate" && params.action === "verify") throw envelopeFailure(verificationStrategy(params), "confirmation_timeout", "cancellation", message, preflightReport);
    throw new Error(message);
  }
  const message = "The Pi system confirmation was denied. Nothing was changed. Chat approval does not replace this confirmation; invoke the operation again if you want another dialog.";
  if (family === "validate" && params.action === "verify") throw envelopeFailure(verificationStrategy(params), "confirmation_denied", "cancellation", message, preflightReport);
  throw new Error(message);
}

function createReportPath(project: string, action: string) {
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  return join(project, ".gdeck", "reports", `pi-${action}-${suffix}.json`);
}

async function resolveVerificationPlanFresh(pi: ExtensionAPI, options: any, signal?: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), "gdeck-plan-spec-"));
  try {
    await chmod(directory, 0o700);
    const specPath = join(directory, "spec.json");
    await writeFile(specPath, `${JSON.stringify(options)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const result: any = await pi.exec(process.execPath, [PLAN_HELPER_FILE, "--spec-file", specPath], {
      cwd: options.project,
      signal,
      timeout: 60_000,
    });
    if (result.code !== 0) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim().slice(0, 2_000);
      throw new Error(`Flight Deck could not resolve a fresh Verification Plan${detail ? `: ${detail}` : ""}`);
    }
    const output = String(result.stdout ?? "");
    if (Buffer.byteLength(output) > 8 * 1024 * 1024) throw new Error("Fresh Verification Plan result exceeds 8388608 bytes");
    const parsed = JSON.parse(output);
    if (!parsed?.plan || typeof parsed.plan.digest !== "string" || !Array.isArray(parsed.plan.stages)) {
      throw new Error("Fresh Verification Plan helper returned an invalid result");
    }
    if (!parsed?.confirmation || parsed.confirmation.authorizationDigest !== parsed.plan.authorizationDigest) {
      throw new Error("Fresh Verification Plan confirmation does not match its authorization digest");
    }
    return parsed;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readJsonFileLimited(path: string, maximumBytes = 8 * 1024 * 1024) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) throw new Error(`Structured result is missing or exceeds ${maximumBytes} bytes: ${path}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.isSymbolicLink()) {
      throw new Error(`Structured result changed while it was being read: ${path}`);
    }
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } finally {
    await handle.close();
  }
}

function verificationUnitProgressTargets(plan: any, verbosity: string) {
  const visibleStages = (Array.isArray(plan?.stages) ? plan.stages : []).filter((stage: any) => stage?.includeInLegacyReport === true);
  return visibleStages.flatMap((stage: any, index: number) => {
    if (stage?.kind !== "unit" || stage?.disposition !== "run" || typeof stage?.reportPath !== "string") return [];
    const parsed = parseCliArguments(stage.commandArgs);
    const runtimeArguments = ["--tests=res://tests", ...(parsed.options.filter ? [`--filter=${parsed.options.filter}`] : [])];
    return [{
      report: stage.reportPath,
      binding: createUnitExecutionBinding({
        invocationIdentity: plan.invocationIdentity,
        ownerNonce: createHash("sha256").update(`${plan.invocationIdentity}\0${stage.id}\0unit-owner`).digest("hex"),
        project: plan.project,
        outputPath: stage.reportPath,
        timeoutMs: stage.timeoutMs,
        runtimeArguments,
      }),
      verbosity,
      stageOrdinal: index + 1,
      stageTotal: visibleStages.length,
    }];
  });
}

function startPiUnitProgressObserver(targets: any[], onUpdate: ((result: any) => void) | undefined) {
  if (!onUpdate || targets.length === 0) {
    return { stop: async () => ({ streaming: onUpdate ? "not_applicable" : "unavailable", emittedEvents: 0, truncated: false, rendererFailed: false }) };
  }
  const states = targets.map((target) => ({
    ...target,
    stream: createUnitProgressStream({ verbosity: target.verbosity }),
    emittedEvents: 0,
    finished: false,
  }));
  let rendererFailed = false;
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      for (const state of states) {
        if (state.finished) continue;
        try {
          if (!existsSync(state.report)) continue;
          const structured = await readJsonFileLimited(state.report, 256 * 1024);
          const report = structured.value;
          const disposition = unitReportDisposition(report, report?.schema_version === 2 ? state.binding : undefined);
          if (disposition.state === "terminal" || disposition.state === "corrupt") {
            state.finished = true;
            continue;
          }
          const sequence = report?.progress?.sequence;
          if (!Number.isInteger(sequence)) continue;
          const projected = projectUnitProgress(report, state.binding, {
            verbosity: state.verbosity,
            stageOrdinal: state.stageOrdinal,
            stageTotal: state.stageTotal,
          });
          if (!projected) continue;
          const accepted = state.stream.observe(projected, sequence);
          if (!accepted) continue;
          state.emittedEvents += 1;
          const current = accepted.unit.current
            ? `; current #${accepted.unit.current.ordinal}${accepted.unit.current.token ? ` ${accepted.unit.current.token}` : ""}` : "";
          try {
            const total = accepted.unit.total === null ? "?" : accepted.unit.total;
            onUpdate({
              content: [{ type: "text", text: `Unit progress ${accepted.stage.ordinal}/${accepted.stage.total}: ${accepted.unit.completed}/${total} cases; elapsed ${accepted.elapsedMs} ms${current}` }],
              details: {
                phase: "unit_progress",
                elapsedMs: accepted.elapsedMs,
                stage: accepted.stage,
                unit: accepted.unit,
                truncated: accepted.truncated,
              },
            });
          } catch { rendererFailed = true; }
        } catch { /* progress is best-effort and cannot affect the supervised process */ }
      }
    } finally { polling = false; }
  };
  void poll();
  const timer = setInterval(() => { void poll(); }, 250);
  (timer as any).unref?.();
  return {
    async stop() {
      clearInterval(timer);
      await poll();
      let truncated = false;
      let emittedEvents = 0;
      for (const state of states) {
        if (state.emittedEvents > 0) state.stream.finish();
        const snapshot = state.stream.snapshot();
        truncated ||= snapshot.progressTruncated;
        emittedEvents += snapshot.emittedEvents;
      }
      return { streaming: "supported", emittedEvents, truncated, rendererFailed };
    },
  };
}

function manifestSummary(manifest: any) {
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts.slice(0, 20).map((artifact: any) => ({
    target: artifact?.target,
    path: artifact?.path,
    sha256: artifact?.sha256,
    size: artifact?.size,
    smoke: artifact?.smoke,
  })) : [];
  return {
    schemaVersion: manifest?.schemaVersion,
    flightDeckVersion: manifest?.flightDeckVersion,
    createdAt: manifest?.createdAt,
    gitSha: manifest?.gitSha,
    debug: manifest?.debug,
    publishRequested: manifest?.publishRequested,
    publishReady: manifest?.publishReady,
    artifacts,
    artifactListTruncated: Array.isArray(manifest?.artifacts) && manifest.artifacts.length > artifacts.length,
  };
}

async function executeFamilyImpl(
  pi: ExtensionAPI,
  family: ToolFamily,
  params: ToolParams,
  signal: AbortSignal | undefined,
  onUpdate: ((result: any) => void) | undefined,
  ctx: ExtensionContext,
) {
  if (!ctx.isProjectTrusted()) throw new Error("Godot Flight Deck requires the current Pi project to be trusted.");
  const project = resolveActiveProject(ctx.cwd, params.project);
  if (family === "project" && params.action === "detect") {
    buildCliArgs(family, params, project);
    return {
      content: [{ type: "text" as const, text: `Godot project detected: ${project}` }],
      details: { family, action: params.action, project, exitCode: 0, truncated: false } satisfies InvocationDetails,
    };
  }

  const isVerify = family === "validate" && params.action === "verify";
  const isUnit = family === "validate" && params.action === "unit";
  const isDoctor = family === "project" && params.action === "doctor";
  const invocationIdentity = isVerify || isUnit ? randomBytes(32).toString("hex") : undefined;
  let reportPath: string | undefined = isVerify || isUnit ? createReportPath(project, params.action) : undefined;
  const unitBinding = isUnit ? createUnitExecutionBinding({
    invocationIdentity,
    ownerNonce: randomBytes(32).toString("hex"),
    project,
    outputPath: reportPath,
    timeoutMs: Number(params.timeout ?? TOOL_TIMEOUT_SECONDS) * 1000,
    runtimeArguments: ["--tests=res://tests", ...(params.filter ? [`--filter=${params.filter}`] : [])],
  }) : undefined;
  buildCliArgs(family, params, project, {
    reportPath: reportPath ?? join(project, ".gdeck", "reports", "pi-verify-preflight.json"),
    batchPath: join(tmpdir(), "gdeck-pi-batch-preflight.json"),
    unitBinding,
  });
  const verifyPlanOptions = isVerify ? {
    project,
    outputPath: reportPath,
    timeoutSeconds: Number(params.timeout ?? TOOL_TIMEOUT_SECONDS),
    verificationProfile: params.profile,
    invocationIdentity,
  } : undefined;
  const resolvedVerification = verifyPlanOptions ? await resolveVerificationPlanFresh(pi, verifyPlanOptions, signal) : undefined;
  const verifyPlan = resolvedVerification?.plan;
  const confirmationPlan = resolvedVerification?.confirmation;
  const confirmationParams = confirmationPlan
    ? {
      ...params,
      verificationPlan: { targets: confirmationPlan.targets, effects: confirmationPlan.effects },
      approvalPlanDigest: confirmationPlan.authorizationDigest,
    }
    : params;
  const leaseDecision = await requireConfirmation(ctx, family, confirmationParams, project, false, verifyPlan);
  const temporaryDirectories: string[] = [];
  let leaseExecutionSucceeded = false;
  let batchPath: string | undefined;
  try {
    if (verifyPlanOptions && verifyPlan) {
      const currentPlan = (await resolveVerificationPlanFresh(pi, {
        ...verifyPlanOptions,
        retentionCandidateManifest: verifyPlan.evidenceBinding?.retentionCandidates ?? [],
      }, signal)).plan;
      if (currentPlan.digest !== verifyPlan.digest) {
        const error: any = new Error("Flight Deck Verification Plan changed after confirmation preflight. Nothing was started; invoke verify again to review the current plan.");
        error.resultClassification = "plan_drift";
        error.resultReport = preflightReportForPlan(verifyPlan);
        throw error;
      }
    }
    if (family === "validate" && params.action === "scenario") {
      reportPath = createReportPath(project, params.action);
    }
    if (family === "editor" && params.action === "batch") {
      const directory = await mkdtemp(join(tmpdir(), "gdeck-pi-batch-"));
      temporaryDirectories.push(directory);
      batchPath = join(directory, "batch.json");
      await writeFile(batchPath, `${JSON.stringify({ name: params.name, operations: params.operations }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    const args = buildCliArgs(family, params, project, {
      reportPath,
      batchPath,
      expectedPlanDigest: verifyPlan?.digest,
      invocationIdentity,
      unitBinding,
    });
    const timeoutSeconds = Number(params.timeout ?? (family === "editor" ? 30 : TOOL_TIMEOUT_SECONDS));
    let initialRendererFailed = false;
    if (onUpdate) {
      try {
        onUpdate({
          content: [{ type: "text", text: `Running Flight Deck ${family}:${params.action}…` }],
          details: { family, action: params.action, project },
        });
      } catch { initialRendererFailed = true; }
    }
    const verbosity = normalizeVerbosity(params.verbosity, "compact");
    const progressTargets = isUnit && unitBinding ? [{
      report: reportPath,
      binding: unitBinding,
      verbosity,
      stageOrdinal: 1,
      stageTotal: 1,
    }] : isVerify ? verificationUnitProgressTargets(verifyPlan, verbosity) : [];
    const progressObserver = startPiUnitProgressObserver(progressTargets, onUpdate);
    const stageProgressObserver = isVerify && onUpdate ? startVerificationProgressObserver({
      plan: verifyPlan,
      verbosity,
      render: (progress: any) => onUpdate({
        content: [{ type: "text", text: renderVerificationProgress(progress) }],
        details: { phase: "verification_stage_progress", ...progress },
      }),
    }) : null;
    const supervisedTimeout = extensionSupervisedExecutionTimeoutMilliseconds(family, params.action, timeoutSeconds, verifyPlan);
    const outerTimeout = extensionExecutionTimeoutMilliseconds(family, params.action, timeoutSeconds, verifyPlan);
    const executionOptions: { cwd: string; signal?: AbortSignal; timeout?: number } = { cwd: project, signal, timeout: outerTimeout };
    const processSpecification = JSON.stringify({
      executable: process.execPath,
      args: [CLI_FILE, ...args],
      cwd: project,
      env: process.env,
      timeoutMs: supervisedTimeout,
      cleanupTimeoutMs: 750,
      maxOutputBytes: 32 * 1024 * 1024,
      phase: isVerify ? "pi_verify" : `pi_${family}_${params.action}`,
      nonce: randomBytes(32).toString("hex"),
      propagateLifecycleRegistry: true,
      lifecycleResources: [...temporaryDirectories],
      lifecycleProjectRoots: [project],
    });
    const specificationDirectory = await mkdtemp(join(tmpdir(), "gdeck-process-spec-"));
    temporaryDirectories.push(specificationDirectory);
    await chmod(specificationDirectory, 0o700);
    const specificationPath = join(specificationDirectory, "spec.json");
    await writeFile(specificationPath, processSpecification, { encoding: "utf8", flag: "wx", mode: 0o600 });
    let result: any;
    let progressSummary: any = { streaming: onUpdate ? "not_applicable" : "unavailable", emittedEvents: 0, truncated: false, rendererFailed: initialRendererFailed };
    try {
      result = await pi.exec(process.execPath, [PROCESS_RUNNER_FILE, "--spec-file", specificationPath], executionOptions);
    } catch (error) {
      if (isVerify) {
        const spawnCodes = new Set(["ENOENT", "EACCES", "ENOTDIR", "EPERM"]);
        const cancelled = signal?.aborted || (error as any)?.name === "AbortError";
        const classification = cancelled ? "cancelled" : spawnCodes.has((error as any)?.code) ? "process_spawn" : "unknown";
        const source = cancelled ? "cancellation" : "process_result";
        const message = error instanceof Error ? error.message : String(error);
        const failure: any = envelopeFailure(
          verificationStrategy(params), classification, source, message, preflightReportForPlan(verifyPlan),
        );
        const interruption = journalInterruptionProjection(verifyPlan, project);
        if (interruption) {
          failure.details = { family, action: params.action, project, journal: interruption };
          failure.message = `${failure.message}\n\n${renderInterruptionProjection(interruption)}`;
        }
        throw failure;
      }
      throw error;
    } finally {
      const observedProgress = await progressObserver.stop();
      const observedStages = stageProgressObserver?.stop() ?? {
        streaming: onUpdate ? "not_applicable" : "unavailable", emittedEvents: 0, truncated: false, rendererFailed: false,
      };
      progressSummary = {
        streaming: onUpdate ? "supported" : "unavailable",
        emittedEvents: observedProgress.emittedEvents + observedStages.emittedEvents,
        truncated: observedProgress.truncated || observedStages.truncated,
        rendererFailed: initialRendererFailed || observedProgress.rendererFailed || observedStages.rendererFailed,
      };
    }
    const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n--- stderr ---\n" : "");
    const upstreamOutputTruncated = /Flight Deck: (?:stdout|stderr) output truncated; retained \d+ of \d+ bytes/.test(output);
    const details: InvocationDetails = {
      family,
      action: params.action,
      project,
      exitCode: result.code,
      reportPath,
      truncated: false,
      progress: progressSummary,
    };
    let doctorPresentation = "";
    let doctorDisposition: string | null = null;
    if (isDoctor) {
      const projected = projectDoctorProcessResult(result, project, { aborted: signal?.aborted === true });
      doctorDisposition = projected.disposition;
      if (projected.report) details.report = projected.report;
      doctorPresentation = projected.text;
      if (projected.disposition === "cancelled" || projected.disposition === "killed"
        || (projected.disposition === "invalid" && ![124, 125, 127].includes(result.code))) {
        throw invocationFailure(projected.text, undefined, details);
      }
    }
    let reportReadError = "";
    let reportReadClassification = "report_missing";
    let rawReport: any;
    let resultEnvelope: any;
    if (reportPath && existsSync(reportPath)) {
      try {
        const structured = await readJsonFileLimited(reportPath);
        rawReport = structured.value;
        if (isUnit) {
          const disposition = unitReportDisposition(rawReport, rawReport?.schema_version === 2 ? unitBinding : undefined);
          if (disposition.state !== "terminal") {
            const error: any = new Error(disposition.state === "incomplete"
              ? "Unit report is incomplete operational evidence and cannot be rendered as a terminal result"
              : "Unit report schema or execution binding is invalid");
            error.resultClassification = disposition.state === "incomplete" ? "report_incomplete" : "report_corrupt";
            throw error;
          }
        }
        if (verifyPlan && !verificationReportMatchesEvidenceBinding(rawReport, verifyPlan, reportPath, {
          reportBytes: structured.bytes,
          receipt: verificationReportReceipt(result.stdout),
        })) {
          const error: any = new Error(`Verification report evidence binding mismatch for the active invocation`);
          error.resultClassification = "plan_drift";
          throw error;
        }
        details.report = validationReportSummary(params.action, rawReport, reportPath);
        if (isVerify) resultEnvelope = (details.report as any)?.resultEnvelope;
      } catch (error) {
        reportReadClassification = (error as any)?.resultClassification ?? "report_corrupt";
        reportReadError = `ERROR Cannot read ${params.action} report ${reportPath}: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else if (reportPath) {
      reportReadClassification = "report_missing";
      reportReadError = `ERROR Expected ${params.action} report was not produced: ${reportPath}`;
    }
    const interruption = isVerify && (signal?.aborted || result.killed || result.code !== 0 || Boolean(reportReadError))
      ? journalInterruptionProjection(verifyPlan, project)
      : null;
    if (interruption) details.journal = interruption;
    if (isVerify) {
      if (signal?.aborted) {
        resultEnvelope = buildResultEnvelope({
          report: rawReport ?? preflightReportForPlan(verifyPlan),
          reportPath: rawReport ? reportPath : undefined,
          markdownPath: rawReport ? reportPath?.replace(/\.json$/, ".md") : undefined,
          strategy: verificationStrategy(params),
          event: { classification: "cancelled", source: "cancellation", summary: "Verification was cancelled" },
        });
      } else if (result.killed) {
        resultEnvelope = buildResultEnvelope({
          report: rawReport ?? preflightReportForPlan(verifyPlan),
          reportPath: rawReport ? reportPath : undefined,
          markdownPath: rawReport ? reportPath?.replace(/\.json$/, ".md") : undefined,
          strategy: verificationStrategy(params),
          event: { classification: "timeout", source: "process_result", summary: "Verification was killed by the bounded outer timeout" },
        });
      } else if ([124, 125, 126, 127].includes(result.code)) {
        const classification = result.code === 124 ? "timeout" : result.code === 125 ? "cleanup_timeout" : result.code === 126 ? "report_io" : "process_spawn";
        resultEnvelope = buildResultEnvelope({
          report: rawReport ?? preflightReportForPlan(verifyPlan),
          reportPath: rawReport ? reportPath : undefined,
          markdownPath: rawReport ? reportPath?.replace(/\.json$/, ".md") : undefined,
          strategy: verificationStrategy(params),
          event: {
            classification,
            source: result.code === 126 ? "preflight" : "process_result",
            summary: result.code === 124 ? "Verification exceeded its bounded execution deadline"
              : result.code === 125 ? "Verification cleanup exceeded its bounded deadline"
                : result.code === 126 ? "Verification report publication failed"
                  : "Configured verification process could not be started",
          },
        });
      } else if (reportReadError) {
        const event = verificationReportReadEvent(reportReadClassification, result.code, reportReadError);
        resultEnvelope = buildResultEnvelope({
          report: rawReport ?? preflightReportForPlan(verifyPlan),
          reportPath,
          markdownPath: reportPath?.replace(/\.json$/, ".md"),
          strategy: verificationStrategy(params),
          event,
        });
      } else if (!resultEnvelope && result.code !== 0) {
        resultEnvelope = buildResultEnvelope({
          report: preflightReportForPlan(verifyPlan),
          reportPath,
          markdownPath: reportPath?.replace(/\.json$/, ".md"),
          strategy: verificationStrategy(params),
          event: {
            classification: result.code === 124 ? "timeout" : "unknown",
            source: "process_result",
            summary: result.code === 124 ? "Verification exceeded its bounded execution timeout" : `Verification exited ${result.code} without qualifying structured evidence`,
          },
        });
      }
    }
    const failedExecution = signal?.aborted || result.killed || result.code !== 0 || Boolean(reportReadError);
    const failureSummary = failedExecution && !isDoctor
      ? failureFirstSummary([structuredFailureSummary(params.action, rawReport, reportPath), reportReadError, isVerify ? "" : output].filter(Boolean).join("\n"))
      : "";
    const presentationOutput = isDoctor ? doctorPresentation : output;
    const bounded = await boundedOutput(presentationOutput, failureSummary, resultEnvelope, isVerify, isDoctor ? false : upstreamOutputTruncated);
    const interruptionText = renderInterruptionProjection(interruption);
    if (interruptionText) bounded.text = `${bounded.text}\n\n${interruptionText}`;
    resultEnvelope = bounded.resultEnvelope;
    details.fullLogPath = bounded.fullLogPath;
    details.truncated = bounded.truncated;
    if (resultEnvelope) {
      details.resultEnvelope = resultEnvelope;
      if (details.report && typeof details.report === "object") (details.report as any).resultEnvelope = resultEnvelope;
    }
    if (signal?.aborted) throw invocationFailure(`Flight Deck ${family}:${params.action} was cancelled.\n${bounded.text}`, resultEnvelope);
    if (result.killed) throw invocationFailure(`Flight Deck ${family}:${params.action} was killed by the outer timeout.\n${bounded.text}`, resultEnvelope);
    if (result.code !== 0 && doctorDisposition !== "diagnostic") {
      const label = result.code === 124 ? "timed out"
        : result.code === 125 ? "cleanup timed out"
          : result.code === 127 ? "could not start its configured process" : `failed with exit code ${result.code}`;
      throw invocationFailure(`Flight Deck ${family}:${params.action} ${label}.\n${bounded.text}`, resultEnvelope, details);
    }
    if (reportReadError) throw invocationFailure(`Flight Deck ${family}:${params.action} failed to read its structured report.\n${bounded.text}`, resultEnvelope);

    if (family === "release" && params.action === "export") {
      const manifestPath = join(project, "build", "release-manifest.json");
      if (existsSync(manifestPath)) {
        details.manifestPath = manifestPath;
        details.manifest = manifestSummary((await readJsonFileLimited(manifestPath)).value);
      }
    }
    if (leaseDecision.grantLeaseSeconds > 0) {
      approvalLeases.grant(
        project, family, params.action, leaseDecision.scope,
        Date.now() + leaseDecision.grantLeaseSeconds * 1_000,
      );
    }
    leaseExecutionSucceeded = true;
    const responseText = doctorDisposition === "diagnostic"
      ? `Flight Deck Doctor completed with diagnostic findings (exit code 1); structured capability assessment is preserved.\n\n${bounded.text}`
      : bounded.text;
    return { content: [{ type: "text" as const, text: responseText }], details };
  } finally {
    if (!leaseExecutionSucceeded && leaseDecision.leaseUsed) {
      approvalLeases.revoke(project, family, params.action, leaseDecision.scope);
    }
    for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true });
  }
}

async function executeFamily(
  pi: ExtensionAPI,
  family: ToolFamily,
  params: ToolParams,
  signal: AbortSignal | undefined,
  onUpdate: ((result: any) => void) | undefined,
  ctx: ExtensionContext,
) {
  try {
    return await executeFamilyImpl(pi, family, params, signal, onUpdate, ctx);
  } catch (error) {
    if (family !== "validate" || params.action !== "verify" || (error as any)?.resultEnvelope) throw error;
    const classification = (error as any)?.resultClassification ?? (signal?.aborted ? "cancelled" : "configuration");
    const source = (error as any)?.resultSource ?? (signal?.aborted ? "cancellation" : "preflight");
    throw envelopeFailure(
      verificationStrategy(params), classification, source,
      error instanceof Error ? error.message : String(error),
      (error as any)?.resultReport,
    );
  }
}

export default function godotFlightDeckExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "gdeck_project",
    label: "Godot Flight Deck Project",
    description: "Detect, initialize, or diagnose the active trusted Godot project using structured Flight Deck operations.",
    promptSnippet: "Detect, initialize, and diagnose the active trusted Godot project",
    promptGuidelines: ["Use gdeck_project doctor before broader Godot Flight Deck validation or setup changes."],
    parameters: ProjectParams,
    execute: (_id, params, signal, onUpdate, ctx) => executeFamily(pi, "project", params, signal, onUpdate, ctx),
  });

  pi.registerTool({
    name: "gdeck_validate",
    label: "Godot Flight Deck Validate",
    description: `Run GDScript checks, unit tests, scenarios, visual regression, benchmarks, baselines, or unified verification. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved when truncated.`,
    promptSnippet: "Run structured Godot checks, tests, scenarios, visuals, benchmarks, and verification",
    promptGuidelines: [
      "Use gdeck_validate instead of shell commands for Godot Flight Deck checks and tests.",
      "Use gdeck_validate baseline only after inspecting a visual failure and obtaining approval.",
    ],
    parameters: ValidateParams,
    execute: (_id, params, signal, onUpdate, ctx) => executeFamily(pi, "validate", params, signal, onUpdate, ctx),
  });

  pi.registerTool({
    name: "gdeck_release",
    label: "Godot Flight Deck Internal Release",
    description: "Inspect/install templates, initialize exports, or produce internal desktop builds. Public publishing is intentionally unavailable.",
    promptSnippet: "Create guarded internal Godot desktop builds and inspect their manifests",
    promptGuidelines: ["Use gdeck_release only for internal artifacts and never describe publishReady false output as publicly certified."],
    parameters: ReleaseParams,
    execute: (_id, params, signal, onUpdate, ctx) => executeFamily(pi, "release", params, signal, onUpdate, ctx),
  });

  pi.registerTool({
    name: "gdeck_editor",
    label: "Godot Flight Deck Editor",
    description: "Query or safely modify the running Godot Editor through the authenticated local Bridge. Batch defaults to dry-run and writes require confirmation.",
    promptSnippet: "Inspect and safely edit Godot scenes and resources through authenticated Editor Undo/Redo",
    promptGuidelines: [
      "Use gdeck_editor read actions before writes, and run batch with commit false before requesting a committed batch.",
      "Never use shell commands to bypass a denied gdeck_editor confirmation or writes_disabled response.",
    ],
    parameters: EditorParams,
    execute: (_id, params, signal, onUpdate, ctx) => executeFamily(pi, "editor", params, signal, onUpdate, ctx),
  });

  pi.registerTool({
    name: "gdeck_scene",
    label: "Godot Flight Deck Scene",
    description: "Inspect or edit .tscn scene files headlessly: scene doctor checks integrity (broken/warning with details), scene set edits a node property with JSON-typed value (dry-run by default, --apply commits with snapshot), scene restore rolls back a snapshot.",
    promptSnippet: "Inspect and safely edit Godot scenes without opening the editor",
    promptGuidelines: [
      "Use gdeck_scene doctor before editing scenes, and after any manual .tscn change.",
      "scene set defaults to dry-run; commit only with apply after reviewing the preview.",
      "scene set writes real project files; never bypass its confirmation.",
    ],
    parameters: SceneParams,
    execute: (_id, params, signal, onUpdate, ctx) => executeFamily(pi, "scene", params, signal, onUpdate, ctx),
  });

  pi.registerTool({
    name: "gdeck_run",
    label: "Godot Flight Deck Run",
    description: "Launch the Godot project headlessly: query injects white-listed read-only runtime queries (property/tree/signals/group) with deterministic seed/frames and returns results; watch streams the game stdout/stderr live with error markers (timeout ends the observation window).",
    promptSnippet: "Observe a running Godot game headlessly: query node state or watch output",
    promptGuidelines: [
      "Use gdeck_run query to verify runtime state (e.g. a UI node's visible property) without human eyes.",
      "gdeck_run watch ends by timeout; a timeout exit is a successful observation, not a failure.",
      "Query results are deterministic under the same seed and frames.",
    ],
    parameters: RunParams,
    execute: (_id, params, signal, onUpdate, ctx) => executeFamily(pi, "run", params, signal, onUpdate, ctx),
  });

  pi.registerCommand("gdeck-status", {
    description: "Run Flight Deck doctor for the active Godot project",
    handler: async (_args, ctx) => {
      try {
        const result = await executeFamily(pi, "project", { action: "doctor", timeout: 30 }, ctx.signal, undefined, ctx);
        const details = result.details as InvocationDetails;
        if (details.exitCode === 0) ctx.ui.notify(`Flight Deck doctor completed: ${details.project}`, "info");
        else ctx.ui.notify(`Flight Deck doctor completed with diagnostic exit code ${details.exitCode}: ${details.project}`, "warning");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("gdeck-verify", {
    description: "Run the configured Flight Deck verification pipeline",
    handler: async (_args, ctx) => {
      try {
        const result = await executeFamily(pi, "validate", { action: "verify", timeout: TOOL_TIMEOUT_SECONDS }, ctx.signal, undefined, ctx);
        const details = result.details as InvocationDetails;
        const report = details.report as any;
        const verdict = (details.resultEnvelope as any)?.verdict ?? report?.resultEnvelope?.verdict ?? "UNKNOWN";
        ctx.ui.notify(`Flight Deck verify ${verdict}: ${report?.summary?.passed ?? "?"} passed, ${report?.summary?.skipped ?? 0} skipped, ${report?.summary?.failed ?? "?"} failed`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    const project = findGodotProject(ctx.cwd);
    if (!project) return;
    const initialized = existsSync(join(project, ".gdeck", "config.json"));
    ctx.ui.setStatus("gdeck", initialized ? "GDeck ready" : "GDeck not initialized");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    approvalLeases.clear();
    ctx.ui.setStatus("gdeck", undefined);
  });
}
