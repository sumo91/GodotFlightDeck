import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path';
import { getPiAction, getPiFamily } from '../registry/commands.mjs';
import {
  assessDoctorCapabilities,
  DOCTOR_CAPABILITY_IDS,
  DOCTOR_CAPABILITY_NAMES,
  DOCTOR_CHECK_IDS,
} from '../cli/doctor-capabilities.mjs';
import { verificationPlanExecutionBudgetMilliseconds } from '../cli/verification-plan.mjs';
import { canonicalEvidenceJson } from '../cli/evidence-contract.mjs';
import { projectVerificationJournalSeal } from '../cli/evidence-journal.mjs';
import {
  normalizeVerbosity, projectUnitSlowestCases, unitExecutionBindingMatches, unitReportDisposition,
} from '../cli/unit-progress.mjs';
import {
  buildResultEnvelope,
  enrichResultEnvelope,
  renderResultEnvelopeText,
} from '../cli/result-envelope.mjs';

export { buildResultEnvelope, enrichResultEnvelope, renderResultEnvelopeText };

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const CLASS_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const PROPERTY_PATTERN = /^[A-Za-z0-9_/]+$/;
const DEFAULT_CONFIRMATION_TIMEOUT_SECONDS = 90;
const MIN_CONFIRMATION_TIMEOUT_SECONDS = 5;
const MAX_CONFIRMATION_TIMEOUT_SECONDS = 120;
const MAX_APPROVAL_LEASE_SECONDS = 300;
const FAILURE_SUMMARY_MAX_BYTES = 8 * 1024;
const FAILURE_SUMMARY_MAX_LINES = 24;
const DOCTOR_CHECK_STATUSES = new Set(['ok', 'warn', 'error']);
const DOCTOR_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const DOCTOR_CHECK_NAMES = {
  'godot-executable': 'Godot executable',
  'godot-version': 'Godot version',
  'flight-deck-config': 'Flight Deck config',
  'project-file': 'Project file',
  'runtime-probe': 'Runtime probe',
  'runtime-autoload': 'Runtime autoload',
  'editor-bridge-addon': 'Editor bridge addon',
  'editor-plugin-enabled': 'Editor plugin enabled',
  'editor-auth-token': 'Editor auth token',
  'editor-write-policy': 'Editor write policy',
  'editor-bridge-session': 'Editor bridge session',
  'editor-bridge-availability': 'Editor bridge availability',
  'export-templates': 'Export templates',
  'git-repository': 'Git repository',
  'project-root': 'Project',
};

function exactObjectKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} has an invalid field set`);
}

function exactUniqueIds(items, expectedIds, label) {
  if (!Array.isArray(items) || items.length !== expectedIds.length) throw new Error(`${label} has an invalid item count`);
  const ids = items.map((item) => item?.id);
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error(`${label} IDs must be unique strings`);
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...expectedIds].sort())) throw new Error(`${label} IDs do not match schema 1`);
}

function exactTokenList(value, allowed, label) {
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== 'string' || !allowed.has(item))) {
    throw new Error(`${label} is invalid`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
  return value;
}

function sameStringList(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function doctorReportSummary(report, expectedProject) {
  exactObjectKeys(report, ['toolVersion', 'project', 'capabilitySchemaVersion', 'probes', 'checks', 'capabilities'], 'Doctor report');
  if (report.capabilitySchemaVersion !== 1) throw new Error('Unsupported Doctor capability schema');
  if (typeof report.toolVersion !== 'string' || report.toolVersion.length > 64 || !DOCTOR_VERSION_PATTERN.test(report.toolVersion)) {
    throw new Error('Doctor toolVersion is invalid');
  }
  if (typeof report.project !== 'string' || typeof expectedProject !== 'string'
    || realpathSync(report.project) !== realpathSync(expectedProject)) throw new Error('Doctor project binding mismatch');
  exactObjectKeys(report.probes, ['godotVersion', 'editorBridge'], 'Doctor probes');
  if (typeof report.probes.godotVersion !== 'boolean' || typeof report.probes.editorBridge !== 'boolean') {
    throw new Error('Doctor probes must be boolean');
  }
  exactUniqueIds(report.checks, DOCTOR_CHECK_IDS, 'Doctor checks');
  const checkStatuses = [];
  for (const check of report.checks) {
    exactObjectKeys(check, ['id', 'name', 'status', 'detail'], `Doctor check ${check?.id ?? '(unknown)'}`);
    if (!DOCTOR_CHECK_STATUSES.has(check.status) || typeof check.name !== 'string' || Buffer.byteLength(check.name) > 512
      || typeof check.detail !== 'string' || Buffer.byteLength(check.detail) > 8 * 1024) {
      throw new Error(`Doctor check ${check.id} is malformed`);
    }
    checkStatuses.push({ id: check.id, status: check.status });
  }
  exactUniqueIds(report.capabilities, DOCTOR_CAPABILITY_IDS, 'Doctor capabilities');
  const checkIdSet = new Set(DOCTOR_CHECK_IDS);
  const conditionSet = new Set([
    ...DOCTOR_CHECK_IDS.map((id) => id.replaceAll('-', '_')),
    ...DOCTOR_CAPABILITY_IDS,
    'editor_writes_disabled',
  ]);
  for (const capability of report.capabilities) {
    exactObjectKeys(
      capability,
      ['id', 'name', 'status', 'supportingChecks', 'decisiveProbeRan', 'summary', 'usableSubset', 'missingConditions'],
      `Doctor capability ${capability?.id ?? '(unknown)'}`,
    );
    if (typeof capability.name !== 'string' || Buffer.byteLength(capability.name) > 512
      || typeof capability.summary !== 'string' || Buffer.byteLength(capability.summary) > 8 * 1024
      || typeof capability.decisiveProbeRan !== 'boolean') throw new Error(`Doctor capability ${capability.id} is malformed`);
    exactTokenList(capability.supportingChecks, checkIdSet, `${capability.id}.supportingChecks`);
    exactTokenList(capability.usableSubset, conditionSet, `${capability.id}.usableSubset`);
    exactTokenList(capability.missingConditions, conditionSet, `${capability.id}.missingConditions`);
  }
  const expectedCapabilities = assessDoctorCapabilities(checkStatuses, { probes: report.probes });
  for (const expected of expectedCapabilities) {
    const actual = report.capabilities.find((capability) => capability.id === expected.id);
    if (!actual || actual.status !== expected.status || actual.decisiveProbeRan !== expected.decisiveProbeRan
      || !sameStringList(actual.supportingChecks, expected.supportingChecks)
      || !sameStringList(actual.usableSubset, expected.usableSubset)
      || !sameStringList(actual.missingConditions, expected.missingConditions)) {
      throw new Error(`Doctor capability ${expected.id} contradicts its supporting checks or probes`);
    }
  }
  realpathSync(expectedProject);
  return {
    project: 'active-trusted-project',
    projectBound: true,
    toolVersion: report.toolVersion,
    capabilitySchemaVersion: 1,
    probes: { ...report.probes },
    checks: checkStatuses.map((check) => ({
      ...check,
      name: DOCTOR_CHECK_NAMES[check.id],
      detailCode: `${check.id.replaceAll('-', '_')}_${check.status}`,
    })),
    capabilities: expectedCapabilities.map((capability) => ({
      id: capability.id,
      name: DOCTOR_CAPABILITY_NAMES[capability.id],
      status: capability.status,
      supportingChecks: capability.supportingChecks,
      decisiveProbeRan: capability.decisiveProbeRan,
      summaryCode: `${capability.id}_${capability.status}`,
      usableSubset: capability.usableSubset,
      missingConditions: capability.missingConditions,
    })),
    checkListTruncated: false,
    capabilityListTruncated: false,
  };
}

export function hasUsableDoctorAssessment(report) {
  return Boolean(report && report.capabilitySchemaVersion === 1
    && Array.isArray(report.checks) && report.checks.length === DOCTOR_CHECK_IDS.length
    && Array.isArray(report.capabilities) && report.capabilities.length === DOCTOR_CAPABILITY_IDS.length);
}

export function renderDoctorAssessment(report) {
  if (!hasUsableDoctorAssessment(report)) throw new Error('Doctor assessment is incomplete');
  const lines = ['Doctor capability assessment (sanitized):'];
  for (const capability of report.capabilities) {
    const probe = capability.decisiveProbeRan ? 'decisive probe observed' : 'decisive probe not observed';
    const missing = capability.missingConditions.length ? `; missing ${capability.missingConditions.join(', ')}` : '';
    lines.push(`- ${capability.id}: ${capability.status}; ${probe}${missing}`);
  }
  return `${lines.join('\n')}\n`;
}

export function doctorExitDisposition(exitCode, usableAssessment) {
  if (!Number.isInteger(exitCode)) throw new Error('Doctor exit code must be an integer');
  if (exitCode === 0 && usableAssessment) return 'completed';
  if (exitCode === 1 && usableAssessment) return 'diagnostic';
  return 'failure';
}

export function projectDoctorProcessResult(result, expectedProject, options = {}) {
  if (options.aborted === true) return { disposition: 'cancelled', text: 'Flight Deck project:doctor was cancelled.' };
  if (result?.killed === true) return { disposition: 'killed', text: 'Flight Deck project:doctor was killed by the bounded outer timeout.' };
  const exitCode = Number(result?.code);
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  if (!Number.isInteger(exitCode)) return { disposition: 'invalid', text: 'Doctor process result is malformed.' };
  if (Buffer.byteLength(stdout) > 256 * 1024) {
    return { disposition: 'invalid', text: 'Doctor structured capability assessment exceeds 262144 bytes.' };
  }
  try {
    const report = doctorReportSummary(JSON.parse(stdout.trim()), expectedProject);
    if (!hasUsableDoctorAssessment(report)) throw new Error('assessment is incomplete');
    return {
      disposition: doctorExitDisposition(exitCode, true),
      report,
      text: renderDoctorAssessment(report),
    };
  } catch {
    return { disposition: 'invalid', text: 'Doctor structured capability assessment is invalid.' };
  }
}

export function verificationReportReceipt(stdout) {
  const matches = String(stdout ?? '').match(/^GDECK_VERIFY_REPORT_RECEIPT ([A-Za-z0-9_-]{1,4096})$/gm) ?? [];
  if (matches.length !== 1) return null;
  try {
    const encoded = matches[0].slice('GDECK_VERIFY_REPORT_RECEIPT '.length);
    const receipt = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const keys = Object.keys(receipt ?? {}).sort().join('\0');
    if (keys !== ['invocationIdentity', 'reportPath', 'schemaVersion', 'sha256', 'size'].sort().join('\0')
      || receipt.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(receipt.invocationIdentity ?? '')
      || typeof receipt.reportPath !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '')
      || !Number.isInteger(receipt.size) || receipt.size < 1 || receipt.size > 8 * 1024 * 1024) return null;
    return receipt;
  } catch {
    return null;
  }
}

export function verificationReportMatchesEvidenceBinding(report, plan, reportPath, options = {}) {
  const expected = plan?.evidenceBinding;
  if (!expected || !report || typeof report !== 'object') return false;
  try {
    const bindingMatches = report.schemaVersion === 2
      && report.resultEnvelope?.schemaVersion === 1
      && report.verificationPlanDigest === plan.digest
      && report.evidenceBinding?.invocationIdentity === expected.invocationIdentity
      && report.journal?.path === expected.journalPath
      && report.journal?.invocationIdentity === expected.invocationIdentity
      && resolve(reportPath) === resolve(expected.outputPath)
      && canonicalEvidenceJson(report.evidenceBinding) === canonicalEvidenceJson(expected);
    if (!bindingMatches) return false;
    const seal = projectVerificationJournalSeal(expected.journalPath);
    if (seal.seal === 'sealed') return true;
    const receipt = options.receipt;
    const bytes = Buffer.isBuffer(options.reportBytes) ? options.reportBytes : null;
    let parsedBytes;
    try { parsedBytes = JSON.parse(bytes?.toString('utf8') ?? ''); } catch { parsedBytes = null; }
    return report.journal?.writeStatus === 'failed' && bytes
      && canonicalEvidenceJson(parsedBytes) === canonicalEvidenceJson(report)
      && receipt?.schemaVersion === 1
      && receipt.invocationIdentity === expected.invocationIdentity
      && resolve(receipt.reportPath) === resolve(expected.outputPath)
      && receipt.size === bytes.length
      && receipt.sha256 === createHash('sha256').update(bytes).digest('hex');
  } catch {
    return false;
  }
}

export function journalInterruptionProjection(plan, project) {
  const binding = plan?.evidenceBinding;
  try {
    const journalRelation = binding ? relative(resolve(project), resolve(binding.journalPath)) : '..';
    if (!binding || resolve(binding.project) !== resolve(project)
      || !journalRelation || journalRelation === '..' || journalRelation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || isAbsolute(journalRelation)) return null;
    const projection = projectVerificationJournalSeal(binding.journalPath);
    return {
      invocationIdentity: binding.invocationIdentity,
      integrity: projection.integrity,
      seal: projection.seal,
      preflightObserved: projection.preflightObserved === true,
      lastSequence: Number.isInteger(projection.lastSequence) ? projection.lastSequence : null,
      completedStageCount: Number.isInteger(projection.completedStageCount) ? projection.completedStageCount : 0,
      currentStage: projection.currentStage ?? null,
    };
  } catch {
    return {
      invocationIdentity: binding?.invocationIdentity ?? null,
      integrity: 'unverifiable', seal: 'unverifiable', preflightObserved: false,
      lastSequence: null, completedStageCount: 0, currentStage: null,
    };
  }
}

export function findGodotProject(startPath) {
  const start = resolve(String(startPath || '.').replace(/^@/, ''));
  let current = start;
  while (true) {
    if (existsSync(resolve(current, 'project.godot'))) return realpathSync(current);
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
  // Monorepo layout: a godot/ subdirectory of the starting path (e.g. a Web
  // repo root that hosts the Godot client under godot/).
  const nested = resolve(start, 'godot');
  if (existsSync(resolve(nested, 'project.godot'))) return realpathSync(nested);
  return null;
}

export function resolveActiveProject(cwd, requestedPath) {
  const active = findGodotProject(cwd);
  if (!active) throw new Error(`No Godot project found from Pi working directory: ${cwd}`);
  if (!requestedPath) return active;
  const requested = findGodotProject(resolve(cwd, String(requestedPath).replace(/^@/, '')));
  if (!requested) throw new Error(`Not inside a Godot project: ${requestedPath}`);
  if (requested !== active) {
    throw new Error('The extension can only operate on the trusted Godot project containing Pi current working directory.');
  }
  return active;
}

function assertOnly(params, allowed) {
  const accepted = new Set(['action', 'project', ...allowed]);
  const unexpected = Object.keys(params).filter((key) => params[key] !== undefined && !accepted.has(key));
  if (unexpected.length) {
    const allowedList = allowed.length ? allowed.join(', ') : '(none)';
    throw new Error(`Unsupported parameter(s) for ${params.action}: ${unexpected.join(', ')}. Allowed: ${allowedList}`);
  }
}

function requireText(value, label, pattern, maxLength = 160) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || (pattern && !pattern.test(value))) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function optionalInteger(value, label, minimum, maximum) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${label}`);
  return value;
}

function optionalNumber(value, label, minimum, maximum) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Invalid ${label}`);
  return value;
}

function nodePath(value, label = 'node path') {
  const path = requireText(value, label, null, 512);
  if (path.startsWith('/') || path.includes('..') || path.includes('\0')) throw new Error(`Invalid ${label}`);
  return path;
}

function resourcePath(value) {
  const path = requireText(value, 'resource path', null, 512);
  if (!path.startsWith('res://') || path.includes('..') || path.includes('\0')) throw new Error('Invalid resource path');
  return path;
}

function jsonString(value, maximumBytes = 128 * 1024) {
  const seen = new WeakSet();
  const visit = (item, depth) => {
    if (depth > 24) throw new Error('JSON value is too deeply nested');
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
      throw new Error('Editor value must be JSON-compatible');
    }
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Editor value contains a non-finite number');
    if (item && typeof item === 'object') {
      if (seen.has(item)) throw new Error('Editor value contains a cycle');
      seen.add(item);
      for (const child of Array.isArray(item) ? item : Object.values(item)) visit(child, depth + 1);
      seen.delete(item);
    }
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > maximumBytes) throw new Error('Editor value is too large');
  return serialized;
}

function addTimeout(args, timeout) {
  const seconds = optionalNumber(timeout, 'timeout', 1, 900);
  if (seconds !== undefined) args.push('--timeout', String(seconds));
}

function positionalArgs(prefix, values) {
  const firstOptionLike = values.findIndex((value) => String(value).startsWith('-'));
  if (firstOptionLike < 0) return [...prefix, ...values];
  return [...prefix, ...values.slice(0, firstOptionLike), '--', ...values.slice(firstOptionLike)];
}

function readProjectConfig(project, purpose) {
  const configPath = resolve(project, '.gdeck', 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config root must be an object');
    return config;
  } catch (error) {
    throw new Error(`Cannot inspect ${purpose}: ${error.message}`);
  }
}

export function readPiSafetyConfig(project) {
  const config = readProjectConfig(project, 'Pi safety configuration');
  const pi = config.pi ?? {};
  if (!pi || typeof pi !== 'object' || Array.isArray(pi)) throw new Error('Pi safety configuration must be an object');
  const confirmationTimeoutSeconds = pi.confirmationTimeoutSeconds ?? DEFAULT_CONFIRMATION_TIMEOUT_SECONDS;
  const approvalLeaseSeconds = pi.approvalLeaseSeconds ?? 120;
  if (!Number.isInteger(confirmationTimeoutSeconds)
    || confirmationTimeoutSeconds < MIN_CONFIRMATION_TIMEOUT_SECONDS
    || confirmationTimeoutSeconds > MAX_CONFIRMATION_TIMEOUT_SECONDS) {
    throw new Error(`Pi safety configuration confirmationTimeoutSeconds must be an integer from ${MIN_CONFIRMATION_TIMEOUT_SECONDS} to ${MAX_CONFIRMATION_TIMEOUT_SECONDS}`);
  }
  if (!Number.isInteger(approvalLeaseSeconds) || approvalLeaseSeconds < 0 || approvalLeaseSeconds > MAX_APPROVAL_LEASE_SECONDS) {
    throw new Error(`Pi safety configuration approvalLeaseSeconds must be an integer from 0 to ${MAX_APPROVAL_LEASE_SECONDS}`);
  }
  return { confirmationTimeoutSeconds, approvalLeaseSeconds };
}

function canonicalLeaseValue(value) {
  if (Array.isArray(value)) return value.map(canonicalLeaseValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalLeaseValue(value[key])]));
  }
  return value;
}

export function approvalLeaseScope(family, action, params = {}) {
  const effect = Object.fromEntries(Object.entries(params)
    .filter(([key, value]) => !['action', 'project', 'timeout'].includes(key) && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)));
  if (family === 'release' && action === 'export' && effect.target === undefined) effect.target = 'all';
  if (family === 'release' && action === 'export') effect.debug = effect.debug === true;
  return JSON.stringify(canonicalLeaseValue(effect));
}

function approvalLeaseKey(project, family, action, scope) {
  return JSON.stringify([project, family, action, scope]);
}

const EXTENSION_PROCESS_CLEANUP_MS = 750;
const EXTENSION_WATCHDOG_GRACE_MS = 750;
export function extensionSupervisedExecutionTimeoutMilliseconds(family, action, timeoutSeconds, verificationPlan = null) {
  const seconds = Number(timeoutSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid extension execution timeout');
  if (family === 'validate' && action === 'verify') {
    if (!verificationPlan || !Array.isArray(verificationPlan.stages)) throw new Error('Verify execution timeout requires the resolved Verification Plan');
    return verificationPlanExecutionBudgetMilliseconds(verificationPlan);
  }
  if (family === 'validate' && action === 'visual') return Math.ceil((2 * seconds + 5) * 1000);
  if (family === 'release' && action === 'export') return Math.ceil((5 * seconds + 60) * 1000);
  const graceSeconds = family === 'project' && action === 'init' ? 0 : 4;
  return Math.ceil((seconds + graceSeconds) * 1000);
}

export function extensionExecutionTimeoutMilliseconds(family, action, timeoutSeconds, verificationPlan = null) {
  const execution = extensionSupervisedExecutionTimeoutMilliseconds(family, action, timeoutSeconds, verificationPlan);
  return execution + EXTENSION_PROCESS_CLEANUP_MS + EXTENSION_WATCHDOG_GRACE_MS;
}

export async function confirmationLifecycle({
  hasUI,
  leaseEligible,
  leaseAvailable,
  timeoutMilliseconds,
  approvalLeaseSeconds,
  confirm,
  now = () => Date.now(),
}) {
  if (!hasUI) return { outcome: 'unavailable', leaseUsed: false, grantLeaseSeconds: 0, confirmCalls: 0 };
  if (leaseEligible && leaseAvailable) return { outcome: 'approved', leaseUsed: true, grantLeaseSeconds: 0, confirmCalls: 0 };
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0 || typeof confirm !== 'function') {
    throw new Error('Invalid confirmation lifecycle configuration');
  }
  const deadline = now() + timeoutMilliseconds;
  const approved = await confirm({ deadline, timeoutMilliseconds });
  if (approved) {
    return {
      outcome: 'approved', leaseUsed: false,
      grantLeaseSeconds: leaseEligible ? approvalLeaseSeconds : 0,
      confirmCalls: 1,
    };
  }
  return {
    outcome: now() >= deadline - 100 ? 'timeout' : 'denied',
    leaseUsed: false,
    grantLeaseSeconds: 0,
    confirmCalls: 1,
  };
}

export class ApprovalLeaseStore {
  #leases = new Map();

  has(project, family, action, scope, now = Date.now()) {
    const key = approvalLeaseKey(project, family, action, scope);
    const expiresAt = this.#leases.get(key);
    if (typeof expiresAt !== 'number' || expiresAt <= now) {
      this.#leases.delete(key);
      return false;
    }
    return true;
  }

  grant(project, family, action, scope, expiresAt) {
    if (typeof scope !== 'string' || !Number.isFinite(expiresAt)) throw new Error('Invalid approval lease');
    this.#leases.set(approvalLeaseKey(project, family, action, scope), expiresAt);
  }

  revoke(project, family, action, scope) {
    this.#leases.delete(approvalLeaseKey(project, family, action, scope));
  }

  clear() { this.#leases.clear(); }
}

export function operationConfirmation(family, action, params = {}) {
  const definition = getPiAction(family, action);
  if (!definition) throw new Error(`Confirmation policy is unavailable for ${family}:${action}`);
  const policy = definition.confirmation;
  let required;
  if (policy === 'never') required = false;
  else if (policy === 'always' || policy === 'delete') required = true;
  else if (policy === 'verify-plan') {
    if (!params.verificationPlan || typeof params.verificationPlan !== 'object' || !Array.isArray(params.verificationPlan.effects)) {
      throw new Error('Verification Plan confirmation policy is missing or malformed');
    }
    required = params.verificationPlan.effects.length > 0;
  }
  else if (policy === 'batch-commit') required = params.commit === true;
  else throw new Error(`Unknown confirmation policy for ${family}:${action}`);
  return {
    required,
    risk: definition.risk,
    leaseEligible: required && definition.leaseEligible === true,
  };
}

export function operationNeedsConfirmation(family, action, params = {}) {
  return operationConfirmation(family, action, params).required;
}

export function operationDescription(family, action, params = {}) {
  if (family === 'project' && action === 'init') return 'install or update the Flight Deck addon and project configuration';
  if (family === 'validate' && action === 'baseline') return `replace the committed visual baseline for ${params.profile ?? 'default'}`;
  if (family === 'validate' && action === 'verify' && Array.isArray(params.verificationPlan?.effects) && params.verificationPlan.effects.length > 0) {
    const targets = Array.isArray(params.verificationPlan.targets) ? params.verificationPlan.targets.map((target) => boundedLine(target, 120)).join(', ') : '(unknown)';
    const paths = params.verificationPlan.effects.map((effect) => boundedLine(effect?.path, 500)).filter(Boolean).join(', ');
    const profile = params.profile ? ` Verification Profile ${boundedLine(params.profile, 120)}` : ' legacy verification';
    return `run${profile} including configured exports with a single aggregate confirmation: ${targets}; replace ${paths}`;
  }
  if (family === 'release' && action === 'templates-install') return 'install Godot export templates into the user profile';
  if (family === 'release' && action === 'export-init') return 'create or update export configuration';
  if (family === 'release' && action === 'export') return `replace internal build artifacts for ${params.target ?? 'all'}`;
  if (family === 'editor' && action === 'sessions') return 'list every known Editor Bridge session for this project';
  if (family === 'editor' && action === 'cleanup-sessions') return 'remove only session metadata whose process is conclusively dead';
  if (family === 'editor') return `${action} through the authenticated Editor Bridge`;
  return `${family}:${action}`;
}

function boundedLine(value, maximum = 1_000) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

export function failureFirstSummary(output) {
  const lines = String(output ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const pattern = /\b(error|failed?|failure|timed out|timeout|denied|missing|invalid|assert(?:ion)?)\b/i;
  const candidates = lines.filter((line) => pattern.test(line));
  const source = candidates.length ? candidates : lines.slice(-8);
  const lineLimit = source.length > FAILURE_SUMMARY_MAX_LINES ? FAILURE_SUMMARY_MAX_LINES - 1 : FAILURE_SUMMARY_MAX_LINES;
  const result = [];
  let bytes = 0;
  for (const line of source) {
    if (result.length >= lineLimit) break;
    const bounded = boundedLine(line);
    const lineBytes = Buffer.byteLength(bounded) + (result.length ? 1 : 0);
    if (bytes + lineBytes > FAILURE_SUMMARY_MAX_BYTES) break;
    result.push(bounded);
    bytes += lineBytes;
  }
  const omitted = source.length - result.length;
  if (omitted > 0) {
    const marker = `FAILED SUMMARY TRUNCATED: ${omitted} additional failure line(s); use the report or full log path for complete details.`;
    while (result.length > 0 && bytes + Buffer.byteLength(marker) + 1 > FAILURE_SUMMARY_MAX_BYTES) {
      const removed = result.pop();
      bytes -= Buffer.byteLength(removed) + (result.length ? 1 : 0);
    }
    if (Buffer.byteLength(marker) <= FAILURE_SUMMARY_MAX_BYTES) result.push(marker);
  }
  return result.join('\n');
}

function summaryEvidenceScalar(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean' || value === null) return String(value);
  if (value && typeof value === 'object' && value.type === 'String' && Number.isFinite(value.length)) return `String(length=${value.length})`;
  return 'redacted';
}

function opaqueUnitIdentifier(value) {
  const source = typeof value === 'string' && value ? value : 'unknown-unit-case';
  return `case-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
}

const UNIT_FAILURE_KINDS = new Set(['assertion', 'test_load', 'test_contract', 'precondition', 'error', 'none']);
const UNIT_ASSERTION_KINDS = new Set(['fail', 'equal', 'not_equal', 'approx', 'true', 'false', 'greater', 'greater_equal', 'less_equal', 'has_key']);

function unitFailureLines(report, prefix = '') {
  if (unitReportDisposition(report).state !== 'terminal') return [];
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  const lines = [];
  for (const item of cases) {
    if (item?.passed === true) continue;
    const name = opaqueUnitIdentifier(item?.name ?? item?.file);
    const details = Array.isArray(item?.failure_details) ? item.failure_details : [];
    if (item?.failure_kind !== 'assertion' || details.length === 0) {
      lines.push(`FAILED CASE ${prefix}${name}: no typed assertion evidence; inspect the exact report`);
      continue;
    }
    for (const detail of details.slice(0, 3)) {
      const assertion = UNIT_ASSERTION_KINDS.has(detail?.assertion) ? detail.assertion : 'assertion';
      lines.push(`FAILED CASE ${prefix}${name}: ${assertion} expected ${summaryEvidenceScalar(detail?.expected)} actual ${summaryEvidenceScalar(detail?.actual)}`);
    }
  }
  return lines;
}

function scenarioFailureLines(report, prefix = '') {
  const scenario = report?.scenario ?? report;
  const lines = [];
  if (scenario?.failure) {
    const kind = scenario?.failure_kind === 'expectation' ? 'expectation' : scenario?.failure_kind === 'precondition' ? 'precondition' : 'untyped failure';
    lines.push(`FAILED SCENARIO ${prefix}${boundedLine(scenario?.name ?? 'unknown', 200)}: ${kind}; inspect the exact report`);
  }
  for (const assertion of Array.isArray(scenario?.assertions) ? scenario.assertions : []) {
    if (assertion?.passed === true) continue;
    const event = boundedLine(assertion?.event ?? 'unknown event', 160);
    const count = Number.isFinite(assertion?.count) ? assertion.count : '?';
    const minimum = Number.isFinite(assertion?.expected_count_gte) ? assertion.expected_count_gte : '?';
    const maximum = Number.isFinite(assertion?.expected_count_lte) ? assertion.expected_count_lte : '?';
    lines.push(`FAILED ASSERTION ${prefix}${assertion?.index ?? '?'} event ${event}: count ${count}, expected ${minimum}..${maximum}`);
  }
  return lines;
}

export function structuredFailureSummary(action, report, reportPath = '') {
  if (!report || typeof report !== 'object') {
    return reportPath ? `FAILED structured report unavailable: ${boundedLine(reportPath, 500)}` : '';
  }
  if (action === 'unit' && unitReportDisposition(report).state !== 'terminal') return '';
  const lines = [];
  if (action === 'verify') {
    const failedStages = (Array.isArray(report.stages) ? report.stages : []).filter((stage) => stage?.status === 'failed');
    lines.push(`FAILED VERIFY: ${report?.summary?.failed ?? failedStages.length} failed stage(s); report ${boundedLine(reportPath || '(unknown)', 500)}`);
    for (const stage of failedStages) {
      const label = `${boundedLine(stage?.kind ?? 'stage', 80)}:${boundedLine(stage?.target ?? 'unknown', 160)}`;
      lines.push(`FAILED STAGE ${label} exit ${stage?.exitCode ?? '?'}`);
      if (stage?.kind === 'unit') lines.push(...unitFailureLines(stage.report, `${label} `));
      else if (stage?.kind === 'scenario') lines.push(...scenarioFailureLines(stage.report, `${label} `));
      for (const budget of Array.isArray(stage?.budgets) ? stage.budgets : []) {
        if (budget?.passed === true) continue;
        lines.push(`FAILED BUDGET ${label} ${boundedLine(budget?.metric ?? budget?.budget ?? 'unknown', 120)}: ${budget?.actual ?? '?'} ${budget?.operator ?? ''} ${budget?.limit ?? '?'}`);
      }
      if (stage?.outputTail) lines.push(`FAILED STAGE ${label}: diagnostic output omitted from the first result; inspect the cited full log or exact report`);
    }
  } else if (action === 'unit') {
    lines.push(`FAILED UNIT: ${report?.summary?.failed ?? '?'} failed case(s); report ${boundedLine(reportPath || '(unknown)', 500)}`);
    lines.push(...unitFailureLines(report));
  } else if (action === 'scenario') {
    lines.push(`FAILED SCENARIO REPORT: ${boundedLine(reportPath || '(unknown)', 500)}`);
    lines.push(...scenarioFailureLines(report));
  }
  if (lines.length === 0 && report?.status === 'failed') lines.push(`FAILED ${action}: structured report status is failed`);
  return failureFirstSummary(lines.join('\n'));
}

export function verificationReportReadEvent(reportClassification, exitCode, summary) {
  if (reportClassification === 'report_missing' && exitCode === 127) {
    return { classification: 'process_spawn', source: 'process_result', summary: 'Configured verification process could not be started before an aggregate report was produced' };
  }
  if (reportClassification === 'report_missing' && exitCode === 124) {
    return { classification: 'timeout', source: 'process_result', summary: 'Verification timed out before an aggregate report was produced' };
  }
  if (reportClassification === 'report_missing' && exitCode === 125) {
    return { classification: 'cleanup_timeout', source: 'process_result', summary: 'Verification cleanup exceeded its bounded deadline before an aggregate report was produced' };
  }
  if (reportClassification === 'report_missing' && exitCode === 126) {
    return { classification: 'report_io', source: 'preflight', summary: 'Verification report publication failed before an aggregate report was produced' };
  }
  return { classification: reportClassification, source: 'preflight', summary };
}

export function validationReportSummary(action, report, reportPath = '') {
  if (action === 'verify') return verificationSummary(report, { reportPath });
  if (action === 'unit') {
    const disposition = unitReportDisposition(report);
    if (disposition.state !== 'terminal') return {
      status: disposition.state === 'incomplete' ? 'incomplete' : 'corrupt',
      evidenceAuthority: 'operational_only',
      schemaVersion: disposition.schemaVersion,
    };
    const failedCases = (Array.isArray(report?.cases) ? report.cases : []).filter((item) => item?.passed !== true).slice(0, 20).map((item) => ({
      name: opaqueUnitIdentifier(item?.name ?? item?.file),
      failureKind: UNIT_FAILURE_KINDS.has(item?.failure_kind) ? item.failure_kind : 'unknown',
      assertionEvidence: (Array.isArray(item?.failure_details) ? item.failure_details : []).slice(0, 3).map((detail) => ({
        assertion: UNIT_ASSERTION_KINDS.has(detail?.assertion) ? detail.assertion : 'assertion',
        expected: summaryEvidenceScalar(detail?.expected),
        actual: summaryEvidenceScalar(detail?.actual),
      })),
    }));
    const summary = Object.fromEntries(['total', 'passed', 'failed', 'assertions', 'duration_ms']
      .filter((key) => typeof report?.summary?.[key] === 'number' && Number.isFinite(report.summary[key]))
      .map((key) => [key, report.summary[key]]));
    return {
      status: report?.status,
      summary,
      failedCases,
      failedCaseListTruncated: Number(report?.summary?.failed ?? 0) > failedCases.length,
      slowestCases: projectUnitSlowestCases(report, undefined, { limit: 5 }),
    };
  }
  if (action === 'scenario') {
    const scenario = report?.scenario ?? {};
    return {
      status: scenario?.status ?? report?.status,
      scenario: {
        name: boundedLine(scenario?.name, 200), stepsCompleted: scenario?.steps_completed, stepsTotal: scenario?.steps_total,
        failureKind: ['expectation', 'precondition'].includes(scenario?.failure_kind) ? scenario.failure_kind : scenario?.failure ? 'unknown' : undefined,
        diagnosticPayloadOmitted: Boolean(scenario?.failure || scenario?.failure_details),
        failedAssertions: (Array.isArray(scenario?.assertions) ? scenario.assertions : [])
          .filter((item) => item?.passed !== true).slice(0, 20).map((item) => ({
            index: boundedScalar(item?.index), event: boundedLine(item?.event, 160),
            count: boundedScalar(item?.count), expectedCountGte: boundedScalar(item?.expected_count_gte), expectedCountLte: boundedScalar(item?.expected_count_lte),
          })),
      },
    };
  }
  return { status: report?.status };
}

function boundedScalar(value, maximum = 160) {
  if (typeof value === 'string') return boundedLine(value, maximum);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}

export function verificationSummary(report, options = {}) {
  const allStages = Array.isArray(report?.stages) ? report.stages : [];
  const rank = (status) => status === 'failed' ? 0 : status === 'skipped' ? 1 : status === 'passed' ? 2 : 1;
  const ordered = allStages.map((stage, index) => ({ stage, index })).sort((left, right) => {
    return rank(left.stage?.status) - rank(right.stage?.status) || left.index - right.index;
  });
  const stages = ordered.slice(0, 50).map(({ stage }) => ({
    kind: boundedLine(stage?.kind, 80),
    target: boundedLine(stage?.target, 160),
    status: stage?.status,
    exitCode: boundedScalar(stage?.exitCode),
    durationMs: boundedScalar(stage?.durationMs),
    reportPath: boundedLine(stage?.reportPath, 500) || undefined,
    diagnosticOutputOmitted: Boolean(stage?.outputTail),
    processEvidence: stage?.processEvidence && typeof stage.processEvidence === 'object' ? {
      phase: boundedLine(stage.processEvidence.phase, 80),
      reason: boundedLine(stage.processEvidence.reason, 120) || undefined,
      timedOut: stage.processEvidence.timedOut === true,
      cleanupTimedOut: stage.processEvidence.cleanupTimedOut === true,
      cancelled: stage.processEvidence.cancelled === true,
      outputTruncated: stage.processEvidence.outputTruncated === true,
      stdoutBytes: boundedScalar(stage.processEvidence.stdoutBytes),
      stderrBytes: boundedScalar(stage.processEvidence.stderrBytes),
    } : undefined,
    budgets: Array.isArray(stage?.budgets) ? stage.budgets.slice(0, 10).map((budget) => ({
      metric: boundedLine(budget?.metric, 100),
      actual: boundedScalar(budget?.actual),
      operator: boundedLine(budget?.operator, 8) || undefined,
      limit: boundedScalar(budget?.limit),
      passed: budget?.passed === true,
    })) : undefined,
  }));
  const allCoverage = Array.isArray(report?.coverage) ? report.coverage : [];
  const coverage = allCoverage.slice(0, 100).map((item) => ({
    kind: boundedLine(item?.kind, 80),
    target: boundedLine(item?.target, 160),
    disposition: boundedLine(item?.disposition, 80),
    execution: boundedLine(item?.execution, 80),
    reason: {
      code: boundedLine(item?.reason?.code, 120),
      message: boundedLine(item?.reason?.message, 700),
    },
  }));
  const preflightFailure = report?.preflightFailure;
  const preflightEvent = allStages.length === 0 && preflightFailure && typeof preflightFailure === 'object'
    && typeof preflightFailure.classification === 'string' && ['preflight', 'process_result', 'cancellation'].includes(preflightFailure.source)
    ? {
      classification: boundedLine(preflightFailure.classification, 80),
      source: preflightFailure.source,
      summary: boundedLine(preflightFailure.summary ?? preflightFailure.classification, 500),
    }
    : undefined;
  return {
    schemaVersion: boundedScalar(report?.schemaVersion),
    flightDeckVersion: boundedLine(report?.flightDeckVersion, 80) || undefined,
    project: boundedLine(report?.project, 500) || undefined,
    verificationProfile: boundedLine(report?.verificationProfile, 100) || undefined,
    status: boundedLine(report?.status, 80) || undefined,
    summary: {
      total: boundedScalar(report?.summary?.total),
      passed: boundedScalar(report?.summary?.passed),
      skipped: boundedScalar(report?.summary?.skipped),
      failed: boundedScalar(report?.summary?.failed),
    },
    startedAt: boundedLine(report?.startedAt, 80) || undefined,
    durationMs: boundedScalar(report?.durationMs),
    verificationPlanDigest: boundedLine(report?.verificationPlanDigest, 64) || undefined,
    resultEnvelope: buildResultEnvelope({
      report,
      reportPath: options.reportPath,
      markdownPath: options.reportPath?.endsWith('.json') ? options.reportPath.replace(/\.json$/, '.md') : '',
      ...(preflightEvent ? { event: preflightEvent } : {}),
    }),
    coverage,
    coverageListTruncated: allCoverage.length > coverage.length,
    stages,
    stageListTruncated: allStages.length > stages.length,
  };
}

export function buildCliArgs(family, params, project, internal = {}) {
  const action = params.action;
  if (typeof action !== 'string') throw new Error('Missing action');
  const familyDefinition = getPiFamily(family);
  if (!familyDefinition) throw new Error(`Unsupported Flight Deck tool family: ${family}`);
  const actionDefinition = getPiAction(family, action);
  if (!actionDefinition) throw new Error(`Unsupported ${family} action: ${action}. Allowed: ${Object.keys(familyDefinition.actions).join(', ')}`);
  assertOnly(params, actionDefinition.parameters);

  if (family === 'project') {
    if (action === 'detect') {
      assertOnly(params, []);
      return [];
    }
    if (action === 'init') {
      assertOnly(params, ['timeout']);
      optionalNumber(params.timeout, 'timeout', 1, 900);
      return ['init', project];
    }
    if (action === 'doctor') {
      assertOnly(params, ['timeout']);
      const args = ['doctor', project, '--json'];
      addTimeout(args, params.timeout);
      return args;
    }
    if (action === 'evidence') {
      assertOnly(params, []);
      return ['evidence-index', project, '--json'];
    }
    throw new Error(`Unsupported project action: ${action}`);
  }

  if (family === 'validate') {
    if (action === 'check') {
      assertOnly(params, ['timeout']);
      const args = ['check', project]; addTimeout(args, params.timeout); return args;
    }
    if (action === 'unit') {
      assertOnly(params, ['filter', 'timeout', 'verbosity']);
      const args = ['unit', project];
      if (params.filter !== undefined) args.push(`--filter=${requireText(params.filter, 'unit filter', null, 120)}`);
      if (internal.reportPath) args.push('--output', internal.reportPath);
      if (params.verbosity !== undefined) args.push('--verbosity', normalizeVerbosity(params.verbosity));
      addTimeout(args, params.timeout);
      if (internal.unitBinding !== undefined) {
        if (!unitExecutionBindingMatches(internal.unitBinding, internal.unitBinding)) throw new Error('Invalid internal Unit binding');
        args.push(`--gdeck-internal-unit-binding=${Buffer.from(JSON.stringify(internal.unitBinding)).toString('base64url')}`);
      }
      return args;
    }
    if (action === 'scenario') {
      assertOnly(params, ['name', 'profile', 'frames', 'timeout']);
      const args = ['scenario', requireText(params.name, 'scenario name', PROFILE_PATTERN, 100), project];
      if (params.profile !== undefined) args.push('--profile', requireText(params.profile, 'profile', PROFILE_PATTERN, 100));
      const frames = optionalInteger(params.frames, 'frames', 1, 100_000);
      if (frames !== undefined) args.push('--frames', String(frames));
      if (internal.reportPath) args.push('--report', internal.reportPath);
      addTimeout(args, params.timeout); return args;
    }
    if (action === 'baseline') {
      assertOnly(params, ['profile', 'frames', 'timeout']);
      const args = ['baseline', requireText(params.profile ?? 'default', 'profile', PROFILE_PATTERN, 100), project];
      const frames = optionalInteger(params.frames, 'frames', 1, 100_000);
      if (frames !== undefined) args.push('--frames', String(frames));
      addTimeout(args, params.timeout); return args;
    }
    if (action === 'visual') {
      assertOnly(params, ['profile', 'tolerance', 'threshold', 'timeout']);
      const args = ['visual-test', requireText(params.profile ?? 'default', 'profile', PROFILE_PATTERN, 100), project];
      const tolerance = optionalNumber(params.tolerance, 'tolerance', 0, 1);
      const threshold = optionalNumber(params.threshold, 'threshold', 0, 1);
      if (tolerance !== undefined) args.push('--tolerance', String(tolerance));
      if (threshold !== undefined) args.push('--threshold', String(threshold));
      addTimeout(args, params.timeout); return args;
    }
    if (action === 'benchmark') {
      assertOnly(params, ['profile', 'frames', 'warmupFrames', 'timeout']);
      const args = ['benchmark', requireText(params.profile ?? 'default', 'profile', PROFILE_PATTERN, 100), project];
      const frames = optionalInteger(params.frames, 'frames', 1, 100_000);
      const warmupFrames = optionalInteger(params.warmupFrames, 'warmup frames', 0, 100_000);
      if (frames !== undefined) args.push('--frames', String(frames));
      if (warmupFrames !== undefined) args.push('--warmup', String(warmupFrames));
      addTimeout(args, params.timeout); return args;
    }
    if (action === 'verify') {
      assertOnly(params, ['profile', 'timeout', 'verbosity']);
      const args = ['verify', project];
      if (params.profile !== undefined) args.push('--profile', requireText(params.profile, 'Verification Profile', PROFILE_PATTERN, 100));
      if (internal.reportPath) args.push('--output', internal.reportPath);
      if (params.verbosity !== undefined) args.push('--verbosity', normalizeVerbosity(params.verbosity));
      addTimeout(args, params.timeout);
      if (internal.expectedPlanDigest !== undefined) {
        if (typeof internal.expectedPlanDigest !== 'string' || !/^[a-f0-9]{64}$/.test(internal.expectedPlanDigest)) {
          throw new Error('Invalid internal verification plan digest');
        }
        args.push(`--gdeck-internal-verify-plan-digest=${internal.expectedPlanDigest}`);
      }
      if (internal.invocationIdentity !== undefined) {
        if (typeof internal.invocationIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(internal.invocationIdentity)) {
          throw new Error('Invalid internal verification invocation identity');
        }
        args.push(`--gdeck-internal-invocation-identity=${internal.invocationIdentity}`);
      }
      return args;
    }
    throw new Error(`Unsupported validation action: ${action}`);
  }

  if (family === 'release') {
    if (action === 'templates-status') {
      assertOnly(params, ['timeout']);
      const args = ['templates', 'status', project]; addTimeout(args, params.timeout); return args;
    }
    if (action === 'templates-install') {
      assertOnly(params, ['timeout']);
      const args = ['templates', 'install', project]; addTimeout(args, params.timeout); return args;
    }
    if (action === 'export-init') {
      assertOnly(params, []);
      return ['export-init', project];
    }
    if (action === 'export') {
      assertOnly(params, ['target', 'debug', 'timeout']);
      const target = params.target ?? 'all';
      if (!['macos', 'windows', 'linux', 'all'].includes(target)) throw new Error('Invalid export target');
      const args = ['export', target, project];
      if (params.debug === true) args.push('--debug');
      addTimeout(args, params.timeout); return args;
    }
    throw new Error(`Unsupported release action: ${action}`);
  }

  if (family === 'editor') {
    const prefix = ['editor', action];
    switch (action) {
      case 'status': assertOnly(params, []); return [...prefix, project];
      case 'sessions': assertOnly(params, []); return [...prefix, project, '--json'];
      case 'cleanup-sessions': assertOnly(params, []); return [...prefix, project, '--json'];
      case 'tree': {
        assertOnly(params, ['depth', 'limit']);
        const args = [...prefix, project];
        const depth = optionalInteger(params.depth, 'depth', 1, 64);
        const limit = optionalInteger(params.limit, 'limit', 1, 5000);
        if (depth !== undefined) args.push('--depth', String(depth));
        if (limit !== undefined) args.push('--limit', String(limit));
        return args;
      }
      case 'inspect': assertOnly(params, ['path']); return positionalArgs(prefix, [nodePath(params.path ?? '.'), project]);
      case 'logs': {
        assertOnly(params, ['limit']);
        const args = [...prefix, project];
        const limit = optionalInteger(params.limit, 'limit', 1, 5000);
        if (limit !== undefined) args.push('--limit', String(limit));
        return args;
      }
      case 'set':
        assertOnly(params, ['path', 'property', 'value']);
        return positionalArgs(prefix, [nodePath(params.path ?? '.'), requireText(params.property, 'property', PROPERTY_PATTERN, 160), jsonString(params.value), project]);
      case 'create':
        assertOnly(params, ['parent', 'className', 'nodeName']);
        return positionalArgs(prefix, [nodePath(params.parent ?? '.'), requireText(params.className, 'node class', CLASS_PATTERN, 100), requireText(params.nodeName, 'node name', CLASS_PATTERN, 100), project]);
      case 'delete': assertOnly(params, ['path']); return positionalArgs(prefix, [nodePath(params.path), project]);
      case 'reorder': {
        assertOnly(params, ['path', 'index']);
        const index = optionalInteger(params.index, 'index', 0, 100_000);
        if (index === undefined) throw new Error('Invalid index');
        return positionalArgs(prefix, [nodePath(params.path), String(index), project]);
      }
      case 'resource-inspect': assertOnly(params, ['resource']); return [...prefix, resourcePath(params.resource), project];
      case 'resource-create':
        assertOnly(params, ['resourceClass', 'resource']);
        return [...prefix, requireText(params.resourceClass, 'resource class', CLASS_PATTERN, 100), resourcePath(params.resource), project];
      case 'resource-set':
        assertOnly(params, ['resource', 'property', 'value']);
        return positionalArgs(prefix, [resourcePath(params.resource), requireText(params.property, 'property', PROPERTY_PATTERN, 160), jsonString(params.value), project]);
      case 'resource-delete': assertOnly(params, ['resource']); return [...prefix, resourcePath(params.resource), project];
      case 'resource-assign':
        assertOnly(params, ['path', 'property', 'resource']);
        return positionalArgs(prefix, [nodePath(params.path ?? '.'), requireText(params.property, 'property', PROPERTY_PATTERN, 160), resourcePath(params.resource), project]);
      case 'batch': {
        assertOnly(params, ['name', 'operations', 'commit']);
        if (!Array.isArray(params.operations) || params.operations.length < 1 || params.operations.length > 100) throw new Error('Batch requires 1 to 100 operations');
        jsonString(params.operations, 512 * 1024);
        if (!internal.batchPath) throw new Error('Internal batch path is missing');
        const args = [...prefix, internal.batchPath, project];
        if (params.commit !== true) args.push('--dry-run');
        return args;
      }
      case 'undo':
      case 'redo':
      case 'save': assertOnly(params, []); return [...prefix, project];
      default: throw new Error(`Unsupported editor action: ${action}`);
    }
  }

  throw new Error(`Unsupported Flight Deck tool family: ${family}`);
}
