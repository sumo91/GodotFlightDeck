import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isAbsolute, resolve } from 'node:path';

const IDENTITY_PATTERN = /^[a-f0-9]{64}$/;
const CASE_TOKEN_PATTERN = /^case-[0-9]{4,10}$/;
const VERBOSITIES = new Set(['compact', 'normal', 'diagnostic']);
const MAX_SAFE_COUNTER = 10_000_000;
const DEFAULT_LIMITS = Object.freeze({
  compact: { maxEvents: 48, minimumIntervalMs: 5_000 },
  normal: { maxEvents: 120, minimumIntervalMs: 1_000 },
  diagnostic: { maxEvents: 240, minimumIntervalMs: 250 },
});

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function boundedInteger(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_SAFE_COUNTER;
}

function validTerminalShape(report, aggregateProjection = false) {
  if (!['passed', 'failed'].includes(report?.status)
    || !report.summary || typeof report.summary !== 'object' || Array.isArray(report.summary)
    || !boundedInteger(report.summary.total)
    || !boundedInteger(report.summary.passed)
    || !boundedInteger(report.summary.failed)
    || !boundedInteger(report.summary.assertions)
    || !finiteNonNegative(report.summary.duration_ms)
    || !Array.isArray(report.cases)
    || report.cases.length > MAX_SAFE_COUNTER
    || report.summary.passed + report.summary.failed !== report.summary.total
    || report.status !== (report.summary.failed === 0 ? 'passed' : 'failed')) return false;
  if (aggregateProjection) return report.cases.every((item) => typeof item?.passed === 'boolean');
  if (report.cases.length !== report.summary.total || report.cases.some((item) => typeof item?.passed !== 'boolean')) return false;
  const passedCases = report.cases.filter((item) => item.passed === true).length;
  return passedCases === report.summary.passed && report.cases.length - passedCases === report.summary.failed;
}

export function normalizeVerbosity(value, fallback = 'compact') {
  const resolved = value ?? fallback;
  if (!VERBOSITIES.has(resolved)) throw new Error(`Unknown verbosity: ${resolved}. Allowed: compact, normal, diagnostic`);
  return resolved;
}

export function createUnitExecutionBinding(values) {
  const invocationIdentity = values?.invocationIdentity;
  const ownerNonce = values?.ownerNonce;
  const project = resolve(values?.project ?? '');
  const outputPath = resolve(values?.outputPath ?? '');
  const timeoutMs = values?.timeoutMs;
  const runtimeArguments = values?.runtimeArguments;
  if (!IDENTITY_PATTERN.test(invocationIdentity ?? '') || !IDENTITY_PATTERN.test(ownerNonce ?? '')) {
    throw new Error('Unit invocation identity and owner nonce must be 64 lowercase hexadecimal characters');
  }
  if (!isAbsolute(project) || !isAbsolute(outputPath) || !Number.isInteger(timeoutMs) || timeoutMs < 1
    || !Array.isArray(runtimeArguments) || runtimeArguments.length > 64
    || runtimeArguments.some((item) => typeof item !== 'string' || Buffer.byteLength(item) > 2_048)) {
    throw new Error('Unit execution binding is malformed');
  }
  return Object.freeze({
    schema_version: 1,
    invocation_identity: invocationIdentity,
    owner_nonce: ownerNonce,
    project,
    output_path: outputPath,
    timeout_ms: timeoutMs,
    runtime_arguments_sha256: createHash('sha256').update(JSON.stringify(runtimeArguments)).digest('hex'),
  });
}

function validBinding(value) {
  return exactKeys(value, [
    'schema_version', 'invocation_identity', 'owner_nonce', 'project', 'output_path', 'timeout_ms', 'runtime_arguments_sha256',
  ])
    && value.schema_version === 1
    && IDENTITY_PATTERN.test(value.invocation_identity ?? '')
    && IDENTITY_PATTERN.test(value.owner_nonce ?? '')
    && typeof value.project === 'string' && isAbsolute(value.project)
    && typeof value.output_path === 'string' && isAbsolute(value.output_path)
    && Number.isInteger(value.timeout_ms) && value.timeout_ms > 0
    && IDENTITY_PATTERN.test(value.runtime_arguments_sha256 ?? '');
}

export function unitExecutionBindingMatches(actual, expected) {
  return validBinding(actual) && validBinding(expected)
    && actual.schema_version === expected.schema_version
    && actual.invocation_identity === expected.invocation_identity
    && actual.owner_nonce === expected.owner_nonce
    && resolve(actual.project) === resolve(expected.project)
    && resolve(actual.output_path) === resolve(expected.output_path)
    && actual.timeout_ms === expected.timeout_ms
    && actual.runtime_arguments_sha256 === expected.runtime_arguments_sha256;
}

export function unitReportDisposition(report, expectedBinding = undefined) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { state: 'corrupt', schemaVersion: null, reason: 'report_shape' };
  }
  if (report.schema_version === 1) {
    if (Object.hasOwn(report, 'complete') || !validTerminalShape(report)) {
      return { state: 'corrupt', schemaVersion: 1, reason: 'legacy_schema' };
    }
    return { state: 'terminal', schemaVersion: 1, reason: null };
  }
  if (report.schema_version !== 2) return { state: 'corrupt', schemaVersion: null, reason: 'schema_version' };
  const acceptedAggregateProjection = expectedBinding === undefined
    && report.complete === true && report.unit_binding_accepted === true
    && report.aggregate_projection?.reason === 'privacy_bounded_stage_projection';
  if (acceptedAggregateProjection) {
    return validTerminalShape(report, true)
      ? { state: 'terminal', schemaVersion: 2, reason: null }
      : { state: 'corrupt', schemaVersion: 2, reason: 'terminal_shape' };
  }
  if (typeof report.complete !== 'boolean' || !validBinding(report.unit_binding)
    || (expectedBinding !== undefined && !unitExecutionBindingMatches(report.unit_binding, expectedBinding))) {
    return { state: 'corrupt', schemaVersion: 2, reason: 'binding_or_complete' };
  }
  if (!report.complete) return { state: 'incomplete', schemaVersion: 2, reason: null };
  if (!validTerminalShape(report)) return { state: 'corrupt', schemaVersion: 2, reason: 'terminal_shape' };
  return { state: 'terminal', schemaVersion: 2, reason: null };
}

function validProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const totalKnown = value.total_cases !== null;
  if (!boundedInteger(value.sequence) || value.sequence < 1 || !finiteNonNegative(value.elapsed_ms)
    || !boundedInteger(value.completed_cases) || (totalKnown && !boundedInteger(value.total_cases))
    || (totalKnown && value.completed_cases > value.total_cases)) return false;
  if (value.current_case === null || value.current_case === undefined) return true;
  return exactKeys(value.current_case, ['ordinal', 'token'])
    && Number.isInteger(value.current_case.ordinal) && value.current_case.ordinal >= 1
    && (!totalKnown || value.current_case.ordinal <= Math.max(1, value.total_cases))
    && CASE_TOKEN_PATTERN.test(value.current_case.token ?? '');
}

export function projectUnitProgress(report, expectedBinding, options = {}) {
  if (unitReportDisposition(report, expectedBinding).state !== 'incomplete' || !validProgress(report.progress)) return null;
  const verbosity = normalizeVerbosity(options.verbosity, 'compact');
  const stageOrdinal = Number.isInteger(options.stageOrdinal) && options.stageOrdinal >= 1 ? options.stageOrdinal : 1;
  const stageTotal = Number.isInteger(options.stageTotal) && options.stageTotal >= stageOrdinal ? options.stageTotal : 1;
  const current = report.progress.current_case;
  return {
    schemaVersion: 1,
    invocationIdentity: expectedBinding.invocation_identity,
    elapsedMs: Math.floor(report.progress.elapsed_ms),
    stage: { ordinal: stageOrdinal, total: stageTotal, state: 'running' },
    unit: {
      completed: report.progress.completed_cases,
      total: report.progress.total_cases,
      ...(current ? { current: { ordinal: current.ordinal, ...(verbosity === 'compact' ? {} : { token: current.token }) } } : {}),
    },
    truncated: report.progress.truncated === true,
  };
}

export function createUnitProgressLimiter(options = {}) {
  const verbosity = normalizeVerbosity(options.verbosity, 'compact');
  const defaults = DEFAULT_LIMITS[verbosity];
  const maxEvents = Number.isInteger(options.maxEvents) && options.maxEvents >= 1 ? options.maxEvents : defaults.maxEvents;
  const minimumIntervalMs = Number.isInteger(options.minimumIntervalMs) && options.minimumIntervalMs >= 0
    ? options.minimumIntervalMs : defaults.minimumIntervalMs;
  let emittedEvents = 0;
  let lastEmittedAt = Number.NEGATIVE_INFINITY;
  let highestSequence = -1;
  let pending = null;
  let dropped = false;
  let finished = false;
  const offerPending = (event, now) => {
    if (!event || !Number.isInteger(event.sequence) || event.sequence < highestSequence || !finiteNonNegative(event.elapsedMs)) {
      dropped = true;
      return null;
    }
    if (event.sequence > highestSequence) {
      if (pending) dropped = true;
      highestSequence = event.sequence;
      pending = event;
    } else if (!pending) return null;
    const reserve = Math.max(0, maxEvents - 1);
    if (emittedEvents >= reserve || now - lastEmittedAt < minimumIntervalMs) {
      dropped = true;
      return null;
    }
    const accepted = pending;
    pending = null;
    emittedEvents += 1;
    lastEmittedAt = now;
    return { ...accepted };
  };
  return Object.freeze({
    offer(event, now = Date.now()) {
      if (finished) return null;
      return offerPending(event, now);
    },
    finish(event, now = Date.now()) {
      if (finished) return null;
      finished = true;
      if (!event || !Number.isInteger(event.sequence) || !finiteNonNegative(event.elapsedMs) || emittedEvents >= maxEvents) {
        dropped = true;
        return null;
      }
      if (pending) dropped = true;
      pending = null;
      highestSequence = Math.max(highestSequence, event.sequence);
      emittedEvents += 1;
      lastEmittedAt = now;
      return { ...event, progressTruncated: dropped };
    },
    snapshot() { return { verbosity, emittedEvents, progressTruncated: dropped }; },
  });
}

export function createUnitProgressStream(options = {}) {
  const verbosity = normalizeVerbosity(options.verbosity, 'compact');
  const defaults = DEFAULT_LIMITS[verbosity];
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : null;
  // Cadence covers the full timeout window so late cases still emit updates.
  const cadence = timeoutMs
    ? Math.max(250, Math.min(defaults.minimumIntervalMs, Math.floor(timeoutMs / Math.max(1, defaults.maxEvents))))
    : defaults.minimumIntervalMs;
  const limiter = createUnitProgressLimiter({
    verbosity,
    maxEvents: defaults.maxEvents,
    minimumIntervalMs: cadence,
  });
  let latest = null;
  let latestReportSequence = -1;
  let latestObservedAt = 0;
  let presentationSequence = 0;
  let pending = null;
  let lastRenderedAt = Number.NEGATIVE_INFINITY;
  let lastRenderedElapsed = -1;
  let regressionRejected = false;
  let displayedUpdates = 0;
  return Object.freeze({
    observe(projected, reportSequence, now = performance.now()) {
      if (!projected || !Number.isInteger(reportSequence) || reportSequence < latestReportSequence) return null;
      if (reportSequence > latestReportSequence) {
        const regressed = latest && (
          projected.elapsedMs < Math.max(latest.elapsedMs, lastRenderedElapsed >= 0 ? lastRenderedElapsed : 0)
          || projected.unit.completed < latest.unit.completed
          || (latest.unit.total !== null && projected.unit.total !== latest.unit.total)
          || (latest.unit.total === null && projected.unit.total !== null && projected.unit.total < projected.unit.completed)
          || projected.stage.ordinal !== latest.stage.ordinal
          || projected.stage.total !== latest.stage.total
        );
        if (regressed) {
          regressionRejected = true;
          return null;
        }
        latest = projected;
        latestReportSequence = reportSequence;
        latestObservedAt = now;
        presentationSequence += 1;
        pending = { ...projected, sequence: presentationSequence, elapsedMs: projected.elapsedMs };
      } else if (!pending && latest && now - lastRenderedAt >= cadence) {
        presentationSequence += 1;
        pending = {
          ...latest,
          sequence: presentationSequence,
          elapsedMs: Math.max(latest.elapsedMs, Math.floor(latest.elapsedMs + now - latestObservedAt)),
        };
      }
      if (!pending) return null;
      const accepted = limiter.offer(pending, now);
      if (accepted) {
        pending = null;
        lastRenderedAt = now;
        lastRenderedElapsed = accepted.elapsedMs;
        displayedUpdates += 1;
      }
      return accepted;
    },
    finish(now = performance.now()) {
      const wallElapsed = latest
        ? Math.floor(Math.max(latest.elapsedMs, latest.elapsedMs + now - latestObservedAt))
        : 0;
      const elapsedMs = Math.max(
        latest?.elapsedMs ?? 0,
        lastRenderedElapsed >= 0 ? lastRenderedElapsed : 0,
        wallElapsed,
      );
      const terminal = limiter.finish({ sequence: presentationSequence + 1, elapsedMs, terminal: true }, now);
      if (terminal) displayedUpdates += 1;
      return terminal;
    },
    snapshot() {
      const snapshot = limiter.snapshot();
      return {
        ...snapshot,
        displayedUpdates,
        progressTruncated: snapshot.progressTruncated || regressionRejected,
        regressionRejected,
      };
    },
  });
}

export function projectUnitSlowestCases(report, expectedBinding = undefined, options = {}) {
  if (unitReportDisposition(report, expectedBinding).state !== 'terminal') return [];
  const limit = Number.isInteger(options.limit) ? Math.min(8, Math.max(0, options.limit)) : 5;
  return report.cases.map((item, index) => ({ item, index }))
    .filter(({ item }) => finiteNonNegative(item?.duration_ms))
    .sort((left, right) => right.item.duration_ms - left.item.duration_ms || left.index - right.index)
    .slice(0, limit)
    .map(({ item, index }) => {
      const source = typeof item?.name === 'string' ? item.name : typeof item?.file === 'string' ? item.file : `ordinal:${index + 1}`;
      return {
        ordinal: index + 1,
        identifier: `case-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`,
        durationMs: Math.round(item.duration_ms * 1000) / 1000,
      };
    });
}
