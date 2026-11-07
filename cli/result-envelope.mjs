import { capturePairSummary } from './capture-ab.mjs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { unitReportDisposition } from './unit-progress.mjs';

const MAX_COVERAGE_ITEMS = 24;
const MAX_DECISIVE_STAGES = 6;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_ARTIFACTS = 12;
const MAX_NEXT_STEPS = 6;
const MAX_SUMMARY_CHARACTERS = 500;
const MAX_PATH_CHARACTERS = 1024;
const MAX_RENDER_BYTES = 12 * 1024;
const MAX_RENDER_LINES = 120;

const QUALIFIED_FAILURES = new Set([
  'unit_assertion',
  'scenario_expectation',
  'visual_mismatch',
  'performance_budget',
  'export_integrity',
]);

const CANCELLED_FAILURES = new Set(['confirmation_denied', 'confirmation_timeout', 'cancelled']);

const LANE_BY_KIND = Object.freeze({
  doctor: 'environment',
  check: 'functional',
  unit: 'functional',
  scenario: 'functional',
  visual: 'visual',
  benchmark: 'performance',
  export: 'release',
});

const LANE_ORDER = ['environment', 'functional', 'visual', 'performance', 'release'];

export class ResultClassificationError extends Error {
  constructor(classification, message, source = 'preflight') {
    super(message);
    this.name = 'ResultClassificationError';
    this.resultClassification = classification;
    this.resultSource = source;
    if (classification === 'process_spawn') this.exitCode = 127;
    else if (classification === 'timeout') this.exitCode = 124;
    else if (classification === 'cleanup_timeout') this.exitCode = 125;
    else if (classification === 'report_io') this.exitCode = 126;
  }
}

function boundedText(value, maximum = MAX_SUMMARY_CHARACTERS) {
  if (value === undefined || value === null) return '';
  const normalized = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').replace(/[\r\n]+/g, ' ').trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

function completePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > MAX_PATH_CHARACTERS || /[\u0000-\u001F\u007F]/.test(value)) return '';
  return value;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function boundedScalar(value) {
  if (finite(value) || typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'string') return boundedText(value, 240);
  return undefined;
}

function compactObject(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

function boundedEvidenceValue(value, depth = 0) {
  if (depth > 2) return undefined;
  if (typeof value === 'string') return boundedText(value, 240);
  if (finite(value) || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => boundedEvidenceValue(item, depth + 1)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 8).map(([key, item]) => [boundedText(key, 80), boundedEvidenceValue(item, depth + 1)]).filter(([key, item]) => key && item !== undefined));
  }
  return undefined;
}

function laneFor(kind) {
  return LANE_BY_KIND[kind] ?? 'functional';
}

function fact(classification, source, summary, values = {}) {
  return {
    classification,
    source,
    summary: boundedText(summary || classification),
    ...(values.expected ? { expected: boundedEvidenceValue(values.expected) } : {}),
    ...(values.actual ? { actual: boundedEvidenceValue(values.actual) } : {}),
  };
}

const UNIT_ASSERTIONS = new Set(['fail', 'equal', 'not_equal', 'approx', 'true', 'false', 'greater', 'greater_equal', 'less_equal', 'has_key']);

function safeTypedAssertionValue(value) {
  if (value === null || typeof value === 'boolean' || finite(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const size = finite(value.size) ? value.size : finite(value.length) ? value.length : undefined;
    return { type: boundedText(value.type ?? 'Variant', 40), ...(finite(size) ? { size } : {}) };
  }
  if (typeof value === 'string') return { type: 'String', size: value.length };
  if (Array.isArray(value)) return { type: 'Array', size: value.length };
  return { type: typeof value };
}

function opaqueUnitIdentifier(value) {
  const source = typeof value === 'string' && value ? value : 'unknown-unit-case';
  return /^case-[a-f0-9]{12}$/.test(source)
    ? source
    : `case-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
}

function firstFailedUnitCase(report) {
  return (Array.isArray(report?.cases) ? report.cases : []).find((item) => item?.passed !== true);
}

function structuredStageFact(stage) {
  if (stage?.evidenceAccepted === false) return null;
  const report = stage?.report;
  if (!report || typeof report !== 'object') return null;
  if (stage.kind === 'unit' && unitReportDisposition(report).state !== 'terminal') return null;
  if (stage.kind === 'unit' && report.status === 'failed') {
    const failed = firstFailedUnitCase(report);
    if (!failed) return null;
    const failureKind = boundedText(failed.failure_kind, 80);
    const classification = ['test_load', 'test_contract'].includes(failureKind)
      ? 'precondition'
      : failureKind === 'assertion' ? 'unit_assertion' : 'unknown';
    const detail = Array.isArray(failed.failure_details) ? failed.failure_details[0] : null;
    const caseName = opaqueUnitIdentifier(failed.name ?? failed.file);
    const assertion = UNIT_ASSERTIONS.has(detail?.assertion) ? detail.assertion : 'assertion';
    return fact(classification, 'structured_report', classification === 'unit_assertion'
      ? `Unit case ${caseName} failed a typed ${assertion}`
      : classification === 'precondition' ? `Unit case ${caseName} could not be loaded under its declared test contract`
        : `Unit case ${caseName} failed without typed assertion evidence`, {
      expected: detail?.expected !== undefined ? compactObject([
        ['value', safeTypedAssertionValue(detail.expected)],
        ['epsilon', finite(detail?.epsilon) ? detail.epsilon : undefined],
      ]) : undefined,
      actual: compactObject([
        ['case', caseName],
        ['value', detail?.actual !== undefined ? safeTypedAssertionValue(detail.actual) : undefined],
      ]),
    });
  }
  if (stage.kind === 'scenario') {
    const scenario = report.scenario ?? report;
    if (scenario?.status !== 'failed') return null;
    const failedAssertion = (Array.isArray(scenario.assertions) ? scenario.assertions : []).find((item) => item?.passed !== true);
    if (scenario.failure_kind === 'precondition' && scenario.failure_details?.kind === 'capture_ab_inconclusive') {
      return fact('precondition', 'structured_report', 'A/B capture could not establish and publish a controlled comparison', {
        actual: compactObject([['stepIndex', scenario.failure_details.step_index], ['reason', boundedText(scenario.failure_details.reason, 80)]]),
      });
    }
    if (scenario.failure_kind === 'precondition' || failedAssertion?.failure_kind === 'precondition') {
      return fact('precondition', 'structured_report', 'Scenario definition or declared prerequisite is invalid', {
        actual: compactObject([['assertionIndex', finite(failedAssertion?.index) ? failedAssertion.index : undefined]]),
      });
    }
    if (failedAssertion && (scenario.failure_kind === 'expectation' || failedAssertion.failure_kind === 'expectation'
      || finite(failedAssertion.expected_count_gte) || finite(failedAssertion.expected_count_lte))) {
      const expected = compactObject([
        ['countGte', finite(failedAssertion.expected_count_gte) ? failedAssertion.expected_count_gte : undefined],
        ['countLte', finite(failedAssertion.expected_count_lte) ? failedAssertion.expected_count_lte : undefined],
      ]);
      const actual = compactObject([
        ['count', finite(failedAssertion.count) ? failedAssertion.count : undefined],
        ['event', boundedText(failedAssertion.event, 160) || undefined],
        ['assertionIndex', finite(failedAssertion.index) ? failedAssertion.index : undefined],
      ]);
      return fact('scenario_expectation', 'structured_report', `Scenario assertion ${failedAssertion.index ?? 'unknown'} did not satisfy its declared event count`, {
        expected: Object.keys(expected).length ? expected : undefined,
        actual: Object.keys(actual).length ? actual : undefined,
      });
    }
    const details = scenario?.failure_details;
    if (scenario.failure_kind === 'expectation' && ['wait_event_failed', 'wait_state_failed', 'wait_state_timeout'].includes(details?.kind)) {
      return fact('scenario_expectation', 'structured_report', details.kind === 'wait_state_timeout'
        ? 'Scenario state expectation exceeded its declared frame window'
        : 'Scenario matched its explicitly declared failure condition', {
        actual: compactObject([
          ['stepIndex', finite(details.step_index) ? details.step_index : undefined],
          ['event', boundedText(details.event, 160) || undefined],
          ['state', boundedText(details.state, 160) || undefined],
          ['stateAvailable', typeof details.available === 'boolean' ? details.available : undefined],
        ]),
      });
    }
    if (details?.kind === 'wait_event_timeout') {
      return fact('scenario_expectation', 'structured_report', 'Scenario event expectation exceeded its declared frame window', {
        expected: compactObject([
          ['event', boundedText(details.event, 160) || undefined],
          ['countGte', finite(details.required_count) ? details.required_count : undefined],
        ]),
        actual: compactObject([
          ['count', finite(details.matches_in_window) ? details.matches_in_window : undefined],
          ['stepIndex', finite(details.step_index) ? details.step_index : undefined],
        ]),
      });
    }
    return fact(scenario.failure_kind === 'expectation' ? 'scenario_expectation' : 'unknown', 'structured_report',
      scenario.failure_kind === 'expectation' ? 'Scenario did not satisfy a typed expectation' : 'Scenario failed without typed expectation evidence');
  }
  if (stage.kind === 'visual' && report.passed === false) {
    const reason = boundedText(report.reason, 160);
    if (['baseline_load_failed', 'actual_load_failed', 'diff_write_failed'].includes(reason) || (finite(report.diff_error) && report.diff_error !== 0)) {
      return fact('report_io', 'structured_report', 'Visual evidence could not be read or written', {
        actual: compactObject([['errorCode', finite(report.diff_error) ? report.diff_error : undefined]]),
      });
    }
    if (finite(report.changed_ratio) || (Array.isArray(report.baseline_size) && Array.isArray(report.actual_size))) {
      return fact('visual_mismatch', 'structured_report', 'Visual evidence exceeded the declared tolerance', {
        expected: compactObject([
          ['changedRatioLte', finite(report.tolerance) ? report.tolerance : undefined],
          ['dimensions', Array.isArray(report.baseline_size) ? report.baseline_size.slice(0, 2).map(boundedScalar) : undefined],
        ]),
        actual: compactObject([
          ['changedRatio', finite(report.changed_ratio) ? report.changed_ratio : undefined],
          ['dimensions', Array.isArray(report.actual_size) ? report.actual_size.slice(0, 2).map(boundedScalar) : undefined],
        ]),
      });
    }
    return fact('unknown', 'structured_report', 'Visual structured report did not qualify the failure');
  }
  if (stage.kind === 'benchmark') {
    const failedBudget = (Array.isArray(stage.budgets) ? stage.budgets : []).find((item) => item?.passed !== true);
    if (failedBudget) {
      return fact('performance_budget', 'structured_report', `Performance budget ${failedBudget.metric ?? failedBudget.budget ?? 'unknown'} failed`, {
        expected: compactObject([
          ['operator', boundedText(failedBudget.operator, 8) || undefined],
          ['limit', finite(failedBudget.limit) ? failedBudget.limit : undefined],
        ]),
        actual: compactObject([
          ['metric', boundedText(failedBudget.metric ?? failedBudget.budget, 120) || undefined],
          ['value', finite(failedBudget.actual) ? failedBudget.actual : undefined],
        ]),
      });
    }
  }
  return null;
}

function stageFact(stage) {
  const structured = structuredStageFact(stage);
  if (structured) return structured;
  const outcome = stage?.outcome;
  if (outcome && typeof outcome === 'object' && typeof outcome.classification === 'string') {
    return fact(outcome.classification, outcome.source ?? 'preflight', outcome.summary, {
      expected: outcome.expected,
      actual: outcome.actual,
    });
  }
  if (stage?.status === 'failed' && stage?.exitCode === 124) {
    return fact('timeout', 'process_result', 'Stage exceeded its bounded execution timeout');
  }
  if (stage?.status === 'failed') {
    return fact('unknown', 'process_result', `Stage exited without qualifying structured evidence (exit ${stage.exitCode ?? 'unknown'})`);
  }
  return null;
}

function coverageSummary(report) {
  const all = Array.isArray(report?.coverage) ? report.coverage : [];
  const selected = all.slice(0, MAX_COVERAGE_ITEMS);
  const counts = { run: 0, skipped: 0, notConfigured: 0, blocked: 0 };
  const byLane = new Map();
  for (const item of all) {
    const disposition = item?.disposition;
    if (disposition === 'run') counts.run += 1;
    else if (disposition === 'skipped') counts.skipped += 1;
    else if (disposition === 'not_configured') counts.notConfigured += 1;
    else if (disposition === 'blocked') counts.blocked += 1;
    const lane = laneFor(item?.kind);
    const laneCounts = byLane.get(lane) ?? { lane, run: 0, skipped: 0, notConfigured: 0, blocked: 0 };
    if (disposition === 'run') laneCounts.run += 1;
    else if (disposition === 'skipped') laneCounts.skipped += 1;
    else if (disposition === 'not_configured') laneCounts.notConfigured += 1;
    else if (disposition === 'blocked') laneCounts.blocked += 1;
    byLane.set(lane, laneCounts);
  }
  return {
    counts,
    lanes: LANE_ORDER.filter((lane) => byLane.has(lane)).map((lane) => byLane.get(lane)),
    items: selected.map((item) => ({
      lane: laneFor(item?.kind),
      kind: boundedText(item?.kind, 80),
      target: boundedText(item?.target, 160),
      disposition: boundedText(item?.disposition, 40),
      execution: boundedText(item?.execution, 40),
      reason: boundedText(item?.reason?.code, 120),
    })),
    omitted: all.length - selected.length,
  };
}

function laneResults(stages) {
  const byLane = new Map();
  for (const stage of stages) {
    const lane = laneFor(stage?.kind);
    const state = byLane.get(lane) ?? { lane, passed: 0, failed: 0, inconclusive: 0 };
    const classification = stageFact(stage)?.classification;
    if (QUALIFIED_FAILURES.has(classification)) state.failed += 1;
    else if (classification) state.inconclusive += 1;
    else if (stage?.status === 'passed') state.passed += 1;
    byLane.set(lane, state);
  }
  return LANE_ORDER.filter((lane) => byLane.has(lane)).map((lane) => {
    const state = byLane.get(lane);
    const status = state.failed > 0 ? 'failed' : state.inconclusive > 0 ? 'inconclusive' : state.passed > 0 ? 'passed' : 'not_selected';
    return { ...state, status };
  });
}

function addArtifact(output, seen, kind, value) {
  const path = completePath(value);
  if (!path) return false;
  if (seen.has(`${kind}\0${path}`)) return true;
  seen.add(`${kind}\0${path}`);
  output.push({ kind, path });
  return true;
}

function collectArtifacts(stages, reportPath, markdownPath, reportArtifacts = []) {
  const all = [];
  const seen = new Set();
  let rejected = 0;
  const record = (kind, value) => {
    if (value !== undefined && value !== null && value !== '' && !addArtifact(all, seen, kind, value)) rejected += 1;
  };
  record('verification_report', reportPath);
  record('verification_markdown', markdownPath);
  for (const artifact of Array.isArray(reportArtifacts) ? reportArtifacts : []) {
    record(boundedText(artifact?.kind ?? 'verification_artifact', 80), artifact?.path);
  }
  for (const stage of stages) {
    record(stage?.outcome?.classification === 'report_missing' ? 'expected_stage_report' : 'stage_report', stage?.reportPath);
    const detail = stage?.report;
    record('capture', detail?.capture);
    for (const pair of capturePairSummary(detail?.capture_ab)) {
      if (pair.published) for (const [key, path] of Object.entries(pair.artifacts)) record(`capture_ab_${key}`, path);
    }
    record('visual_actual', detail?.actual);
    record('visual_diff', detail?.diff);
    for (const artifact of Array.isArray(stage?.artifacts) ? stage.artifacts : []) {
      record(boundedText(artifact?.kind ?? 'release_artifact', 80), artifact?.path);
    }
  }
  return { items: all.slice(0, MAX_ARTIFACTS), omitted: rejected + Math.max(0, all.length - MAX_ARTIFACTS) };
}

function boundedReplayContext(replay) {
  const fixtureAdapter = typeof replay?.fixtureAdapter === 'string' && replay.fixtureAdapter.length <= 1024
    && !/[\u0000-\u001F\u007F]/.test(replay.fixtureAdapter) ? replay.fixtureAdapter : null;
  return {
    verificationProfile: boundedText(replay?.verificationProfile, 100) || null,
    runtimeProfile: boundedText(replay?.runtimeProfile, 100) || null,
    seed: finite(replay?.seed) ? replay.seed : null,
    fixtureAdapter,
    timeoutMs: finite(replay?.timeoutMs) ? replay.timeoutMs : null,
  };
}

function decisiveEntries(stages, facts) {
  const all = [];
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    const item = facts[index];
    if (!item) continue;
    all.push({
      lane: laneFor(stage?.kind),
      kind: boundedText(stage?.kind, 80),
      target: boundedText(stage?.target, 160),
      verdict: QUALIFIED_FAILURES.has(item.classification) ? 'FAILED' : 'INCONCLUSIVE',
      classification: item.classification,
      source: item.source,
      ...(stage?.replay ? { replay: boundedReplayContext(stage.replay) } : {}),
    });
  }
  return { items: all.slice(0, MAX_DECISIVE_STAGES), omitted: Math.max(0, all.length - MAX_DECISIVE_STAGES), all };
}

function evidenceEntries(stages, facts) {
  const all = [];
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    const item = facts[index];
    if (!item) continue;
    const base = {
      lane: laneFor(stage?.kind),
      kind: boundedText(stage?.kind, 80),
      target: boundedText(stage?.target, 160),
    };
    all.push({
      ...base,
      classification: item.classification,
      summary: item.summary,
      ...(item.expected ? { expected: item.expected } : {}),
      ...(item.actual ? { actual: item.actual } : {}),
      ...(completePath(stage?.reportPath) ? { reportPath: stage.reportPath } : {}),
    });
    const related = Array.isArray(stage?.relatedOutcomes) ? stage.relatedOutcomes : [];
    for (const outcome of related) {
      if (!outcome || typeof outcome.classification !== 'string') continue;
      all.push({ ...base, classification: outcome.classification, summary: boundedText(outcome.summary || outcome.classification) });
    }
    if (stage?.exitCode === 124 && item.classification !== 'timeout' && !related.some((outcome) => outcome?.classification === 'timeout')) {
      all.push({ ...base, classification: 'timeout', summary: 'Stage exceeded its bounded execution timeout' });
    }
  }
  return { items: all.slice(0, MAX_EVIDENCE_ITEMS), omitted: Math.max(0, all.length - MAX_EVIDENCE_ITEMS) };
}

function nextStepsFor(verdict, classification, artifacts, decisive, source = null) {
  const steps = [];
  const report = classification === 'report_missing'
    ? artifacts.find((item) => ['expected_stage_report', 'expected_verification_report'].includes(item.kind))
    : artifacts.find((item) => item.kind === 'verification_report');
  if (report) steps.push({ action: classification === 'report_missing' ? 'check_expected_report_path' : 'inspect_report', path: report.path });
  const first = decisive.find((item) => item.classification === classification && (!source || item.source === source)) ?? decisive[0];
  if (classification === 'plan_drift') steps.push({ action: 'refresh_verification_plan' });
  else if (['configuration', 'precondition', 'fixture_isolation', 'confirmation_unavailable'].includes(classification)) {
    steps.push({ action: 'resolve_precondition', ...(first ? { kind: first.kind, target: first.target } : {}) });
  } else if (verdict !== 'PASSED' && first) {
    steps.push({ action: 'rerun_same_target', kind: first.kind, target: first.target, ...(first.replay ? { replay: first.replay } : {}) });
  }
  const evidenceArtifact = artifacts.find((item) => ![
    'verification_report', 'verification_markdown', 'stage_report',
    'expected_verification_report', 'expected_verification_markdown', 'expected_stage_report',
  ].includes(item.kind));
  if (evidenceArtifact) steps.push({ action: 'inspect_artifact', path: evidenceArtifact.path });
  return steps.slice(0, MAX_NEXT_STEPS);
}

function eventEnvelope(strategy, event, report = null, reportPath = '', markdownPath = '') {
  const classification = boundedText(event?.classification || 'unknown', 80);
  const source = boundedText(event?.source || (CANCELLED_FAILURES.has(classification) ? 'cancellation' : 'preflight'), 80);
  const verdict = CANCELLED_FAILURES.has(classification) ? 'CANCELLED' : 'INCONCLUSIVE';
  const summary = boundedText(event?.summary || classification);
  const coverage = coverageSummary(report);
  const stages = Array.isArray(report?.stages) ? report.stages : [];
  const artifacts = collectArtifacts(stages, reportPath, markdownPath, report?.artifacts);
  if (classification === 'report_missing') {
    artifacts.items = artifacts.items.map((item) => ({
      ...item,
      kind: item.kind === 'verification_report' ? 'expected_verification_report'
        : item.kind === 'verification_markdown' ? 'expected_verification_markdown' : item.kind,
    }));
  }
  const truncation = { ...emptyTruncation(), coverageItems: coverage.omitted, artifacts: artifacts.omitted };
  truncation.occurred = coverage.omitted > 0 || artifacts.omitted > 0;
  return {
    schemaVersion: 1,
    strategy: normalizeStrategy(strategy, report),
    verdict,
    coverage: { counts: coverage.counts, lanes: coverage.lanes, items: coverage.items },
    laneResults: laneResults(stages),
    decisiveStages: [],
    failureClassification: { code: classification, source },
    evidence: [{ lane: 'environment', kind: 'verification', target: 'preflight', classification, summary }],
    artifacts: artifacts.items,
    nextSteps: nextStepsFor(verdict, classification, artifacts.items, [], source),
    truncation,
  };
}

function normalizeStrategy(strategy, report = null) {
  if (strategy?.mode === 'profile') return { mode: 'profile', profile: boundedText(strategy.profile, 100) || null };
  if (report?.verificationProfile) return { mode: 'profile', profile: boundedText(report.verificationProfile, 100) };
  return { mode: 'legacy', profile: null };
}

function emptyTruncation() {
  return {
    occurred: false,
    coverageItems: 0,
    decisiveStages: 0,
    evidenceItems: 0,
    artifacts: 0,
    output: false,
    outputWithheld: false,
    fullLogPath: null,
  };
}

export function buildResultEnvelope({ report = null, reportPath = '', markdownPath = '', strategy = null, event = null } = {}) {
  if (event) return eventEnvelope(strategy, event, report, reportPath, markdownPath);
  const stages = Array.isArray(report?.stages) ? report.stages : [];
  const facts = stages.map(stageFact);
  const qualified = facts.find((item) => item && QUALIFIED_FAILURES.has(item.classification));
  const sourcePriority = { structured_report: 0, preflight: 1, process_result: 2, cancellation: 3 };
  const inconclusive = facts.map((item, index) => ({ item, index })).filter(({ item }) => item)
    .sort((left, right) => (sourcePriority[left.item.source] ?? 99) - (sourcePriority[right.item.source] ?? 99) || left.index - right.index)[0]?.item;
  const attemptedPasses = stages.filter((stage) => stage?.status === 'passed').length;
  let verdict;
  let primary;
  if (qualified) {
    verdict = 'FAILED';
    primary = qualified;
  } else if (inconclusive) {
    verdict = 'INCONCLUSIVE';
    primary = inconclusive;
  } else if (attemptedPasses > 0) {
    verdict = 'PASSED';
    primary = { classification: 'none', source: null };
  } else if (report?.status === 'failed') {
    verdict = 'INCONCLUSIVE';
    primary = { classification: 'unknown', source: 'structured_report' };
  } else {
    verdict = 'INCONCLUSIVE';
    primary = { classification: 'insufficient_coverage', source: 'preflight' };
  }
  const coverage = coverageSummary(report);
  const decisive = decisiveEntries(stages, facts);
  const evidence = evidenceEntries(stages, facts);
  if (verdict === 'INCONCLUSIVE' && primary.classification === 'insufficient_coverage') {
    evidence.items.push({
      lane: 'environment', kind: 'verification', target: 'coverage', classification: 'insufficient_coverage',
      summary: 'No selected verification criterion produced passing evidence',
    });
  } else if (verdict === 'INCONCLUSIVE' && primary.classification === 'unknown' && evidence.items.length === 0) {
    evidence.items.push({
      lane: 'environment', kind: 'verification', target: 'report', classification: 'unknown',
      summary: 'Structured verification status failed without qualifying stage evidence',
    });
  }
  const artifacts = collectArtifacts(stages, reportPath, markdownPath, report?.artifacts);
  const truncation = {
    ...emptyTruncation(),
    coverageItems: coverage.omitted,
    decisiveStages: decisive.omitted,
    evidenceItems: evidence.omitted,
    artifacts: artifacts.omitted,
  };
  truncation.occurred = Object.values(truncation).some((value) => typeof value === 'number' && value > 0);
  return {
    schemaVersion: 1,
    strategy: normalizeStrategy(strategy, report),
    verdict,
    coverage: { counts: coverage.counts, lanes: coverage.lanes, items: coverage.items },
    laneResults: laneResults(stages),
    decisiveStages: decisive.items,
    failureClassification: { code: primary.classification, source: primary.source },
    evidence: evidence.items,
    artifacts: artifacts.items,
    nextSteps: nextStepsFor(verdict, primary.classification, artifacts.items, decisive.all, primary.source),
    truncation,
  };
}

export function enrichResultEnvelope(envelope, { outputTruncated = false, outputWithheld = false, fullLogPath = '' } = {}) {
  const copy = structuredClone(envelope);
  copy.truncation = { ...emptyTruncation(), ...(copy.truncation ?? {}) };
  copy.truncation.output = outputTruncated === true;
  copy.truncation.outputWithheld = outputWithheld === true;
  const path = completePath(fullLogPath);
  copy.truncation.fullLogPath = path || null;
  if (path && !copy.artifacts.some((item) => item.kind === 'full_log' && item.path === path)) {
    if (copy.artifacts.length < MAX_ARTIFACTS) copy.artifacts.push({ kind: 'full_log', path });
    else copy.truncation.artifacts += 1;
  }
  copy.truncation.occurred = copy.truncation.output || copy.truncation.outputWithheld || Boolean(copy.truncation.aggregateReport)
    || ['coverageItems', 'decisiveStages', 'evidenceItems', 'artifacts'].some((key) => Number(copy.truncation[key] ?? 0) > 0);
  return copy;
}

function compactJson(value) {
  return boundedText(JSON.stringify(value), 800);
}

function boundedRenderedLines(lines) {
  const output = [];
  let bytes = 0;
  let omitted = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + (output.length ? 1 : 0);
    if (output.length >= MAX_RENDER_LINES - 1 || bytes + lineBytes > MAX_RENDER_BYTES - 120) {
      omitted += 1;
      continue;
    }
    output.push(line);
    bytes += lineBytes;
  }
  if (omitted > 0) output.push(`Rendered envelope truncated: ${omitted} line(s); inspect the cited verification report for the complete bounded envelope.`);
  return output.join('\n');
}

export function renderResultEnvelopeText(envelope) {
  const lines = [
    `RESULT ENVELOPE v${envelope.schemaVersion}`,
    `Strategy: ${envelope.strategy.mode === 'profile' ? `profile ${envelope.strategy.profile}` : 'legacy verify'}`,
    `Verdict: ${envelope.verdict}`,
    `Classification: ${envelope.failureClassification.code}${envelope.failureClassification.source ? ` (${envelope.failureClassification.source})` : ''}`,
    `Coverage plan: selected_run=${envelope.coverage.counts.run} skipped=${envelope.coverage.counts.skipped} not_configured=${envelope.coverage.counts.notConfigured} blocked=${envelope.coverage.counts.blocked}`,
  ];
  for (const lane of envelope.laneResults) lines.push(`Lane ${lane.lane}: ${lane.status}`);
  lines.push(`Output truncated: ${envelope.truncation.output ? 'yes' : 'no'}; withheld: ${envelope.truncation.outputWithheld ? 'yes' : 'no'}`);
  if (envelope.truncation.fullLogPath) lines.push(`Full log: ${envelope.truncation.fullLogPath}`);
  const omitted = envelope.truncation;
  if (omitted.coverageItems || omitted.decisiveStages || omitted.evidenceItems || omitted.artifacts) {
    lines.push(`Envelope truncated: coverage=${omitted.coverageItems} stages=${omitted.decisiveStages} evidence=${omitted.evidenceItems} artifacts=${omitted.artifacts}`);
  }
  if (omitted.aggregateReport) lines.push(`Aggregate report projection: ${compactJson(omitted.aggregateReport)}`);
  for (const stage of envelope.decisiveStages) lines.push(`Decisive ${stage.lane}/${stage.kind}:${stage.target}: ${stage.classification} → ${stage.verdict}`);
  for (const item of envelope.evidence) {
    let line = `Evidence ${item.kind}:${item.target}: ${item.summary}`;
    if (item.expected) line += `; expected=${compactJson(item.expected)}`;
    if (item.actual) line += `; actual=${compactJson(item.actual)}`;
    lines.push(line);
  }
  for (const artifact of envelope.artifacts) lines.push(`Artifact ${artifact.kind}: ${artifact.path}`);
  for (const step of envelope.nextSteps) lines.push(`Next ${step.action}${step.kind ? ` ${step.kind}:${step.target}` : ''}${step.replay ? ` context=${compactJson(step.replay)}` : ''}${step.path ? ` ${step.path}` : ''}`);
  for (const item of envelope.coverage.items) lines.push(`Coverage ${item.lane}/${item.kind}:${item.target}: ${item.disposition} (${item.execution}; ${item.reason})`);
  return boundedRenderedLines(lines);
}

function markdownCell(value) {
  return boundedText(value, 1000).replaceAll('\\', '\\\\').replaceAll('|', '\\|');
}

function markdownText(value) {
  return boundedText(value, 1000).replaceAll('\\', '\\\\').replace(/([*_[\]<>])/g, '\\$1');
}

function markdownCode(value) {
  const text = String(value);
  const runs = text.match(/`+/g) ?? [];
  const delimiter = '`'.repeat(1 + runs.reduce((maximum, run) => Math.max(maximum, run.length), 0));
  return `${delimiter}${text}${delimiter}`;
}

export function renderResultEnvelopeMarkdown(envelope) {
  const lines = [
    '## Result Envelope',
    '',
    `- Verdict: **${envelope.verdict}**`,
    `- Strategy: ${markdownCode(envelope.strategy.mode === 'profile' ? `profile:${envelope.strategy.profile}` : 'legacy verify')}`,
    `- Failure classification: ${markdownCode(envelope.failureClassification.code)} (${markdownText(envelope.failureClassification.source ?? 'none')})`,
    `- Planned coverage: \`selected_run=${envelope.coverage.counts.run}\`, \`skipped=${envelope.coverage.counts.skipped}\`, \`not_configured=${envelope.coverage.counts.notConfigured}\`, \`blocked=${envelope.coverage.counts.blocked}\``,
  ];
  if (envelope.coverage.items.length) {
    lines.push('', '| Coverage lane | Kind | Target | Disposition | Execution | Reason |', '|---|---|---|---:|---:|---|');
    for (const item of envelope.coverage.items) lines.push(`| ${markdownCell(item.lane)} | ${markdownCell(item.kind)} | ${markdownCell(item.target)} | ${markdownCell(item.disposition)} | ${markdownCell(item.execution)} | ${markdownCell(item.reason)} |`);
  }
  if (envelope.decisiveStages.length) {
    lines.push('', '| Lane | Stage | Target | Verdict | Classification |', '|---|---|---|---:|---|');
    for (const stage of envelope.decisiveStages) lines.push(`| ${markdownCell(stage.lane)} | ${markdownCell(stage.kind)} | ${markdownCell(stage.target)} | ${markdownCell(stage.verdict)} | ${markdownCell(stage.classification)} |`);
  }
  if (envelope.evidence.length) {
    lines.push('', '### Decisive evidence', '');
    for (const item of envelope.evidence) lines.push(`- **${markdownText(`${item.kind}:${item.target}`)}** — ${markdownText(item.summary)}${item.expected ? `; expected ${markdownCode(compactJson(item.expected))}` : ''}${item.actual ? `; actual ${markdownCode(compactJson(item.actual))}` : ''}`);
  }
  if (envelope.artifacts.length) {
    lines.push('', '### Artifacts', '');
    for (const artifact of envelope.artifacts) lines.push(`- ${markdownText(artifact.kind)}: ${markdownCode(artifact.path)}`);
  }
  if (envelope.nextSteps.length) {
    lines.push('', '### Deterministic next steps', '');
    for (const step of envelope.nextSteps) lines.push(`- ${markdownCode(step.action)}${step.kind ? ` for ${markdownCode(`${step.kind}:${step.target}`)}` : ''}${step.replay ? ` with ${markdownCode(compactJson(step.replay))}` : ''}${step.path ? `: ${markdownCode(step.path)}` : ''}`);
  }
  if (envelope.truncation.occurred) {
    lines.push('', `Truncation disclosed: coverage=${envelope.truncation.coverageItems}, stages=${envelope.truncation.decisiveStages}, evidence=${envelope.truncation.evidenceItems}, artifacts=${envelope.truncation.artifacts}, output=${envelope.truncation.output}.${envelope.truncation.aggregateReport ? ` Aggregate report projection: ${markdownCode(compactJson(envelope.truncation.aggregateReport))}.` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
