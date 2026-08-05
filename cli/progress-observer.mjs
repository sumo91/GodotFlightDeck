import { existsSync, lstatSync, watch } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { readVerificationJournal } from './evidence-journal.mjs';
import { normalizeVerbosity } from './unit-progress.mjs';

const CADENCE = Object.freeze({
  compact: { pollMs: 500, heartbeatMs: 5_000, maxEvents: 128 },
  normal: { pollMs: 500, heartbeatMs: 1_000, maxEvents: 256 },
  diagnostic: { pollMs: 250, heartbeatMs: 500, maxEvents: 512 },
});

function directoryIdentity(path) {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
}

function stageKindMap(plan) {
  return new Map((Array.isArray(plan?.stages) ? plan.stages : [])
    .filter((stage) => stage?.includeInLegacyReport === true && typeof stage?.id === 'string')
    .map((stage) => [stage.id, stage.kind]));
}

function validOrdinal(value) {
  return Number.isInteger(value) && value >= 1 && value <= 10_000;
}

export function renderVerificationProgress(progress) {
  return `Verify progress ${progress.stage.ordinal}/${progress.stage.total}: ${progress.stage.kind} ${progress.stage.state}; elapsed ${progress.elapsedMs} ms`;
}

export function startVerificationProgressObserver({ plan, verbosity: requestedVerbosity, render, observeJournalProbe = undefined }) {
  const verbosity = normalizeVerbosity(requestedVerbosity, 'compact');
  const cadence = CADENCE[verbosity];
  const journalPath = plan?.evidenceBinding?.journalPath;
  const kinds = stageKindMap(plan);
  const stageTotal = (Array.isArray(plan?.stages) ? plan.stages : []).filter((stage) => stage?.includeInLegacyReport === true).length;
  const maximumEvents = Math.min(1_024, Math.max(cadence.maxEvents, stageTotal * 2 + 2));
  let observedDirectoryIdentity = null;
  let lastRecordSequence = -1;
  let emittedEvents = 0;
  let truncated = false;
  let rendererFailed = false;
  let current = null;
  let lastHeartbeatAt = Number.NEGATIVE_INFINITY;
  let polling = false;
  let benchmarkSuspended = false;
  let journalWatcher = null;

  const closeJournalWatcher = () => {
    try { journalWatcher?.close(); } catch { /* observation is best-effort */ }
    journalWatcher = null;
  };

  const emit = (progress, terminal = false) => {
    const reserve = terminal ? maximumEvents : maximumEvents - 1;
    if (emittedEvents >= reserve) {
      truncated = true;
      return;
    }
    emittedEvents += 1;
    lastHeartbeatAt = performance.now();
    try { render(progress); }
    catch { rendererFailed = true; }
  };

  const processJournal = (now) => {
    try { observeJournalProbe?.(); } catch { /* test/diagnostic hook cannot affect execution */ }
    if (typeof journalPath !== 'string' || !existsSync(journalPath)) return;
    let identity;
    try { identity = directoryIdentity(journalPath); }
    catch { return; }
    if (!identity || identity === observedDirectoryIdentity) return;
    const observed = readVerificationJournal(journalPath);
    if (observed.integrity !== 'valid') return;
    observedDirectoryIdentity = identity;
    for (const record of observed.records) {
      if (record.sequence <= lastRecordSequence) continue;
      lastRecordSequence = record.sequence;
      if (record.type === 'stage_started') {
        const ordinal = record.payload?.ordinal;
        const total = record.payload?.total;
        const kind = kinds.get(record.payload?.stageId);
        if (!validOrdinal(ordinal) || !validOrdinal(total) || ordinal > total || typeof kind !== 'string') continue;
        current = {
          stageId: record.payload.stageId,
          ordinal,
          total,
          kind,
          baseElapsedMs: record.elapsedMs,
          observedAt: now,
        };
        emit({
          schemaVersion: 1,
          elapsedMs: record.elapsedMs,
          stage: { ordinal, total, kind, state: 'running' },
          truncated: false,
        });
        if (kind === 'benchmark' && !benchmarkSuspended) {
          benchmarkSuspended = true;
          try {
            journalWatcher = watch(journalPath, { persistent: false }, () => {
              if (!benchmarkSuspended) return;
              processJournal(performance.now());
              if (!current || current.kind !== 'benchmark') {
                benchmarkSuspended = false;
                closeJournalWatcher();
              }
            });
            journalWatcher.on('error', () => closeJournalWatcher());
          } catch { closeJournalWatcher(); }
        }
      } else if (record.type === 'stage_terminal') {
        const ordinal = record.payload?.ordinal;
        const kind = kinds.get(record.payload?.stageId);
        const state = ['passed', 'failed', 'skipped', 'blocked'].includes(record.payload?.state) ? record.payload.state : 'failed';
        const total = current?.stageId === record.payload?.stageId ? current.total : stageTotal;
        if (!validOrdinal(ordinal) || !validOrdinal(total) || ordinal > total || typeof kind !== 'string') continue;
        emit({
          schemaVersion: 1,
          elapsedMs: record.elapsedMs,
          stage: { ordinal, total, kind, state },
          truncated: false,
        }, true);
        if (current?.stageId === record.payload.stageId) current = null;
      }
    }
  };

  const heartbeat = (now) => {
    if (!current || current.kind === 'benchmark' || now - lastHeartbeatAt < cadence.heartbeatMs) return;
    emit({
      schemaVersion: 1,
      elapsedMs: Math.max(current.baseElapsedMs, Math.floor(current.baseElapsedMs + now - current.observedAt)),
      stage: { ordinal: current.ordinal, total: current.total, kind: current.kind, state: 'running' },
      truncated: false,
    });
  };

  const poll = () => {
    if (polling) return;
    polling = true;
    try {
      const now = performance.now();
      if (!benchmarkSuspended) processJournal(now);
      heartbeat(now);
    } finally { polling = false; }
  };

  poll();
  const timer = setInterval(poll, cadence.pollMs);
  timer.unref?.();
  return Object.freeze({
    stop() {
      clearInterval(timer);
      benchmarkSuspended = false;
      closeJournalWatcher();
      poll();
      return {
        streaming: 'supported',
        emittedEvents,
        truncated,
        rendererFailed,
      };
    },
  });
}
