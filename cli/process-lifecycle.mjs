import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeSync,
} from 'node:fs';
import { chmod as chmodAsync, lstat as lstatAsync, readdir as readdirAsync, realpath as realpathAsync, rm as rmAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const DEFAULT_CLEANUP_TIMEOUT_MS = 750;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TERM_GRACE_MS = 250;
const POLL_MS = 20;
const isWindows = process.platform === 'win32';

function finiteInteger(value, fallback, minimum, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function monotonicNowNs() {
  return process.hrtime.bigint();
}

function deadlineFrom(specification, timeoutMs) {
  const local = monotonicNowNs() + BigInt(timeoutMs) * 1_000_000n;
  if (!/^\d+$/.test(String(specification.deadlineNs ?? ''))) return local;
  const supplied = BigInt(specification.deadlineNs);
  return supplied < local ? supplied : local;
}

class TailBuffer {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.retainedBytes = 0;
    this.total = 0;
    this.truncated = false;
  }

  append(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.total += bytes.length;
    if (bytes.length >= this.limit) {
      this.chunks = [bytes.subarray(bytes.length - this.limit)];
      this.retainedBytes = this.limit;
    } else {
      this.chunks.push(bytes);
      this.retainedBytes += bytes.length;
      while (this.retainedBytes > this.limit) {
        const overflow = this.retainedBytes - this.limit;
        const first = this.chunks[0];
        if (first.length <= overflow) {
          this.chunks.shift();
          this.retainedBytes -= first.length;
        } else {
          this.chunks[0] = first.subarray(overflow);
          this.retainedBytes -= overflow;
        }
      }
    }
    if (this.total > this.limit) this.truncated = true;
  }

  rendered(streamName) {
    const retained = Buffer.concat(this.chunks, this.retainedBytes);
    if (!this.truncated) return retained;
    const marker = Buffer.from(`Flight Deck: ${streamName} output truncated; retained ${this.retainedBytes} of ${this.total} bytes\n`);
    return Buffer.concat([marker, retained]);
  }
}

export function executeProcess(specification, { signal, onOutput, handleSignals = false } = {}) {
  if (signal?.aborted) return Promise.resolve({ status: 130, stdout: '', stderr: '', cancelled: true });
  return new Promise((resolveResult) => {
    const timeoutMs = finiteInteger(specification.timeoutMs, 1, 1, 24 * 60 * 60 * 1000);
    const cleanupTimeoutMs = finiteInteger(specification.cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS, 500, 10_000);
    const maximumOutputBytes = finiteInteger(specification.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 16 * 1024, 64 * 1024 * 1024);
    const perStreamBytes = Math.max(8 * 1024, Math.floor(maximumOutputBytes / 2));
    const phase = String(specification.phase ?? 'process').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'process';
    const nonce = /^[a-f0-9]{64}$/.test(String(specification.nonce ?? '')) ? specification.nonce : randomBytes(32).toString('hex');
    const processOwnerToken = /^[a-f0-9]{64}$/.test(String(process.env.GDECK_PROCESS_OWNER_TOKEN ?? ''))
      ? process.env.GDECK_PROCESS_OWNER_TOKEN : randomBytes(32).toString('hex');
    const executionDeadlineNs = deadlineFrom(specification, timeoutMs);
    const stdout = new TailBuffer(perStreamBytes);
    const stderr = new TailBuffer(perStreamBytes);
    const initialParentPid = process.ppid;
    const lifecycleProjectRoots = (Array.isArray(specification.lifecycleProjectRoots) ? specification.lifecycleProjectRoots : [])
      .flatMap((path) => {
        try {
          const root = realpathSync(String(path));
          return lstatSync(root).isDirectory() ? [root] : [];
        } catch { return []; }
      });

    const LIFECYCLE_DESCRIPTOR = 4;

    function inheritedLifecycleDescriptorIsSafe() {
      if (process.env.GDECK_LIFECYCLE_FD !== String(LIFECYCLE_DESCRIPTOR)) return false;
      try {
        const metadata = fstatSync(LIFECYCLE_DESCRIPTOR);
        return metadata.isFile() && (metadata.mode & 0o077) === 0;
      } catch {
        return false;
      }
    }

    let registryDirectory = '';
    let registryPath = '';
    let registryDescriptor = LIFECYCLE_DESCRIPTOR;
    let ownsRegistry = false;
    if (!inheritedLifecycleDescriptorIsSafe()) {
      registryDirectory = mkdtempSync(join(tmpdir(), 'gdeck-process-tree-'));
      chmodSync(registryDirectory, 0o700);
      registryPath = join(registryDirectory, 'groups.ndjson');
      registryDescriptor = openSync(registryPath, 'wx+', 0o600);
      ownsRegistry = true;
    }

    function appendRegistryEvent(value) {
      try { writeSync(registryDescriptor, Buffer.from(`${JSON.stringify(value)}\n`)); }
      catch { /* root cleanup reports a missing or unreadable registry */ }
    }

    function registryEvent(event, pid) {
      if (!Number.isInteger(pid) || pid <= 0) return;
      appendRegistryEvent({ event, pid, owner: process.pid });
    }

    if (ownsRegistry && Array.isArray(specification.lifecycleResources)) {
      for (const path of specification.lifecycleResources) {
        if (typeof path === 'string') appendRegistryEvent({ event: 'resource_add', path, owner: process.pid });
      }
    }

    function registeredLifecycle() {
      const groups = new Set();
      const resources = new Set();
      let content = '';
      try { content = readFileSync(registryPath, 'utf8'); } catch { return { groups, resources }; }
      for (const line of content.split('\n')) {
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (Number.isInteger(event?.pid) && event.pid > 0) {
            if (event.event === 'add') groups.add(event.pid);
            else if (event.event === 'remove') groups.delete(event.pid);
          }
          if (typeof event?.path === 'string') {
            if (event.event === 'resource_add') resources.add(event.path);
            else if (event.event === 'resource_remove') resources.delete(event.path);
          }
        } catch { /* an incomplete final append is ignored */ }
      }
      return { groups, resources };
    }

    function groupExists(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        if (isWindows) process.kill(pid, 0);
        else process.kill(-pid, 0);
        return true;
      } catch (error) {
        return error?.code !== 'ESRCH';
      }
    }

    function signalGroup(pid, signal) {
      if (!Number.isInteger(pid) || pid <= 0) return;
      try {
        if (isWindows) {
          if (signal === 'SIGKILL' || signal === 'SIGTERM') spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', timeout: 2_000 });
          else process.kill(pid, signal);
        } else {
          process.kill(-pid, signal);
        }
      } catch {
        try { process.kill(pid, signal); } catch { /* already gone */ }
      }
    }

    function discoverDescendantProcessGroups(rootPids) {
      if (isWindows || rootPids.length === 0) return;
      const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 100, maxBuffer: 2 * 1024 * 1024,
      });
      if (result.status !== 0) return;
      const processes = [];
      for (const line of String(result.stdout ?? '').split('\n')) {
        const [pidText, parentText, groupText] = line.trim().split(/\s+/);
        const pid = Number(pidText);
        const parent = Number(parentText);
        const group = Number(groupText);
        if (Number.isInteger(pid) && pid > 0 && Number.isInteger(parent) && parent >= 0 && Number.isInteger(group) && group > 0) {
          processes.push({ pid, parent, group });
        }
      }
      const descendants = new Set(rootPids);
      let changed = true;
      while (changed) {
        changed = false;
        for (const processEntry of processes) {
          if (descendants.has(processEntry.parent) && !descendants.has(processEntry.pid)) {
            descendants.add(processEntry.pid);
            discoveredDescendantGroups.add(processEntry.group);
            changed = true;
          }
        }
      }
    }

    function discoverTaggedProcessGroups() {
      if (isWindows) return;
      const environment = { ...process.env };
      delete environment.GDECK_PROCESS_OWNER_TOKEN;
      const result = spawnSync('/bin/ps', ['eww', '-axo', 'pid=,ppid=,pgid=,command='], {
        encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'ignore'], timeout: 150, maxBuffer: 64 * 1024 * 1024,
      });
      if (result.status !== 0) return;
      const entries = String(result.stdout ?? '').split('\n').flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s/);
        return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), line }] : [];
      });
      const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
      const ancestorPids = new Set([process.pid]);
      const ancestorGroups = new Set();
      const supervisorEntry = byPid.get(process.pid);
      if (supervisorEntry?.group > 0) ancestorGroups.add(supervisorEntry.group);
      let ancestorPid = process.ppid;
      while (Number.isInteger(ancestorPid) && ancestorPid > 0 && !ancestorPids.has(ancestorPid)) {
        ancestorPids.add(ancestorPid);
        const ancestor = byPid.get(ancestorPid);
        if (!ancestor) break;
        ancestorGroups.add(ancestor.group);
        ancestorPid = ancestor.parent;
      }
      for (const entry of entries) {
        if (!entry.line.includes(`GDECK_PROCESS_OWNER_TOKEN=${processOwnerToken}`)) continue;
        if (entry.pid > 0 && entry.group > 0 && !ancestorPids.has(entry.pid) && !ancestorGroups.has(entry.group)) {
          discoveredDescendantGroups.add(entry.group);
        }
      }
    }

    function activeOwnedGroups(discover = false) {
      const groups = ownsRegistry ? registeredLifecycle().groups : new Set();
      if (child?.pid) groups.add(child.pid);
      if (discover) {
        discoverDescendantProcessGroups([...groups]);
        discoverTaggedProcessGroups();
      }
      for (const group of discoveredDescendantGroups) groups.add(group);
      return [...groups].filter(groupExists);
    }

    function signalOwnedGroups(signal) {
      const groups = activeOwnedGroups(true).sort((left, right) => right - left);
      for (const pid of groups) signalGroup(pid, signal);
    }

    const childEnvironment = {
      ...(specification.env ?? process.env),
      GDECK_EXECUTION_DEADLINE_NS: String(executionDeadlineNs),
      GDECK_PROCESS_OWNER_TOKEN: processOwnerToken,
    };
    delete childEnvironment.GDECK_PROCESS_REGISTRY_PATH;
    delete childEnvironment.GDECK_PROCESS_REGISTRY_NONCE;
    delete childEnvironment.GDECK_LIFECYCLE_FD;
    const childStdio = ['ignore', 'pipe', 'pipe'];
    if (specification.propagateLifecycleRegistry === true) {
      childEnvironment.GDECK_LIFECYCLE_FD = String(LIFECYCLE_DESCRIPTOR);
      childStdio.push('ignore', registryDescriptor);
    }

    let child;
    const timingStartedNs = monotonicNowNs();
    let timingSpawnedNs = 0n;
    let timingCleanupNs = 0n;
    let executionTimer;
    let orphanTimer;
    let cleanupPoll;
    let escalationTimer;
    let cleanupDeadlineTimer;
    let cleanupDeadlineNs = 0n;
    let finalizing = false;
    let finalized = false;
    let timedOut = false;
    let cancelled = false;
    let cleanupTimedOut = false;
    let targetExitCode = null;
    let targetSignal = null;
    let requestedStatus = 1;
    let finishReason = 'unknown';
    const discoveredDescendantGroups = new Set();

    function clearLifecycleTimers() {
      for (const timer of [executionTimer, orphanTimer, cleanupPoll, escalationTimer, cleanupDeadlineTimer]) {
        if (timer) clearTimeout(timer);
        if (timer && timer === orphanTimer) clearInterval(timer);
      }
    }

    function metadata(status) {
      const ended = monotonicNowNs();
      const cleanupStarted = timingCleanupNs || ended;
      const launched = timingSpawnedNs || cleanupStarted;
      const milliseconds = (end, start) => Number(end - start) / 1_000_000;
      const metadata = {
        schemaVersion: 1,
        nonce,
        phase,
        status,
        reason: finishReason,
        timedOut,
        cancelled,
        cleanupTimedOut,
        targetExitCode,
        targetSignal,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutBytes: stdout.total,
        stderrBytes: stderr.total,
        timings: { clock: 'monotonic', scope: 'supervised_child',
          launchMs: milliseconds(launched, timingStartedNs), executionMs: milliseconds(cleanupStarted, launched),
          cleanupMs: milliseconds(ended, cleanupStarted), totalMs: milliseconds(ended, timingStartedNs) },
      };
      return metadata;
    }

    const LIFECYCLE_RESOURCE_PREFIXES = [
      'gdeck-fixture-run-', 'gdeck-verification-snapshot-', 'gdeck-release-project-', 'gdeck-native-smoke-', 'gdeck-class-info-', 'gdeck-pi-batch-',
    ];

    async function lifecycleResourceIsSafe(path) {
      try {
        await lstatAsync(path);
        const parent = await realpathAsync(dirname(path));
        const temporary = parent === await realpathAsync(tmpdir())
          && LIFECYCLE_RESOURCE_PREFIXES.some((prefix) => basename(path).startsWith(prefix));
        const exportStaging = lifecycleProjectRoots.some((root) => parent === join(root, '.gdeck', 'export-staging'));
        const captureStaging = /^\.gdeck-ab-[A-Za-z0-9]{6}$/.test(basename(path))
          && lifecycleProjectRoots.some((root) => parent === join(root, '.gdeck', 'captures'));
        return temporary || exportStaging || captureStaging;
      } catch (error) {
        return error?.code === 'ENOENT';
      }
    }

    async function makeTreeWritable(path) {
      let metadata;
      try { metadata = await lstatAsync(path); }
      catch (error) { if (error?.code === 'ENOENT') return; throw error; }
      if (metadata.isSymbolicLink()) return;
      if (metadata.isDirectory()) {
        await chmodAsync(path, 0o700);
        for (const entry of await readdirAsync(path)) await makeTreeWritable(join(path, entry));
      } else {
        await chmodAsync(path, 0o600);
      }
    }

    async function removeRegisteredResources() {
      if (!ownsRegistry) return true;
      let removed = true;
      const resources = [...registeredLifecycle().resources].sort((left, right) => right.length - left.length);
      for (const path of resources) {
        if (!await lifecycleResourceIsSafe(path)) {
          removed = false;
          continue;
        }
        try {
          await makeTreeWritable(path);
          await rmAsync(path, { recursive: true, force: true });
        } catch {
          removed = false;
        }
      }
      return removed;
    }

    async function removeRegistryBestEffort() {
      if (!ownsRegistry) return true;
      try {
        closeSync(registryDescriptor);
        await rmAsync(registryDirectory, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    }

    async function finalize(status) {
      if (finalized) return;
      finalized = true;
      if (!timingCleanupNs) timingCleanupNs = monotonicNowNs();
      clearLifecycleTimers();
      try { child?.stdout?.destroy(); } catch { /* already closed */ }
      try { child?.stderr?.destroy(); } catch { /* already closed */ }
      if (child?.pid) registryEvent('remove', child.pid);
      let finalStatus = status;
      if (cleanupDeadlineNs === 0n) cleanupDeadlineNs = monotonicNowNs() + BigInt(cleanupTimeoutMs) * 1_000_000n;
      const remainingCleanupMs = Math.max(1, Number((cleanupDeadlineNs - monotonicNowNs() + 999_999n) / 1_000_000n));
      let cleanupTimer;
      const cleanup = Promise.all([removeRegisteredResources(), removeRegistryBestEffort()])
        .then(([resourcesRemoved, registryRemoved]) => ({ completed: true, resourcesRemoved, registryRemoved }));
      const cleanupResult = await Promise.race([
        cleanup,
        new Promise((resolveCleanup) => {
          cleanupTimer = setTimeout(() => resolveCleanup({ completed: false, resourcesRemoved: false, registryRemoved: false }), remainingCleanupMs);
        }),
      ]);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (!cleanupResult.completed) {
        cleanupTimedOut = true;
        finishReason = 'cleanup_timeout';
        finalStatus = 125;
      } else if (!cleanupResult.resourcesRemoved || !cleanupResult.registryRemoved) {
        cleanupTimedOut = true;
        finishReason = 'registry_cleanup_failure';
        finalStatus = 125;
      } else if (monotonicNowNs() > cleanupDeadlineNs) {
        cleanupTimedOut = true;
        finishReason = 'cleanup_timeout';
        finalStatus = 125;
      }
      if (timedOut) stderr.append(`Flight Deck: ${phase} timed out after ${(timeoutMs / 1000).toFixed(3)}s\n`);
      if (cleanupTimedOut) stderr.append(`Flight Deck: ${phase} cleanup exceeded ${cleanupTimeoutMs}ms\n`);
      for (const [name, handler] of signalHandlers) process.off(name, handler);
      signal?.removeEventListener('abort', abort);
      const stdoutBuffer = stdout.rendered('stdout');
      const stderrBuffer = stderr.rendered('stderr');
      resolveResult({ ...metadata(finalStatus), stdoutBuffer, stderrBuffer,
        stdout: stdoutBuffer.toString('utf8'), stderr: stderrBuffer.toString('utf8') });

    }

    function pollForCleanup() {
      if (activeOwnedGroups().length === 0) {
        finalize(requestedStatus);
        return;
      }
      cleanupPoll = setTimeout(pollForCleanup, POLL_MS);
    }

    function beginCleanup(status, reason) {
      if (finalizing || finalized) return;
      finalizing = true;
      timingCleanupNs = monotonicNowNs();
      requestedStatus = status;
      finishReason = reason;
      cleanupDeadlineNs = monotonicNowNs() + BigInt(cleanupTimeoutMs) * 1_000_000n;
      if (executionTimer) clearTimeout(executionTimer);
      signalOwnedGroups('SIGTERM');
      escalationTimer = setTimeout(() => signalOwnedGroups('SIGKILL'), Math.min(TERM_GRACE_MS, Math.max(50, cleanupTimeoutMs - 100)));
      cleanupDeadlineTimer = setTimeout(() => {
        const remaining = activeOwnedGroups();
        if (remaining.length > 0) {
          cleanupTimedOut = true;
          signalOwnedGroups('SIGKILL');
          finalize(125);
        } else {
          finalize(requestedStatus);
        }
      }, cleanupTimeoutMs);
      pollForCleanup();
    }

    function scheduleExecutionDeadline() {
      const remainingMs = Number((executionDeadlineNs - monotonicNowNs()) / 1_000_000n);
      if (remainingMs <= 0) {
        timedOut = true;
        beginCleanup(124, `${phase}_timeout`);
        return;
      }
      executionTimer = setTimeout(() => {
        timedOut = true;
        beginCleanup(124, `${phase}_timeout`);
      }, remainingMs);
    }

    const signalHandlers = new Map();
    if (handleSignals) {
      for (const [name, status] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
        const handler = () => { cancelled = true; beginCleanup(status, 'cancelled'); };
        signalHandlers.set(name, handler);
        process.on(name, handler);
      }
    }
    const abort = () => { cancelled = true; beginCleanup(143, 'cancelled'); };
    signal?.addEventListener('abort', abort, { once: true });

    try {
      child = spawn(specification.executable, specification.args ?? [], {
        cwd: specification.cwd || undefined,
        env: childEnvironment,
        detached: !isWindows,
        stdio: childStdio,
        windowsHide: true,
        shell: specification.shell === true,
      });
    } catch (error) {
      stderr.append(`Flight Deck: could not start process: ${error.message}\n`);
      finishReason = 'process_spawn';
      finalize(127);
    }

    if (child) {
      child.stdout.on('data', (chunk) => { stdout.append(chunk); onOutput?.('stdout', chunk); });
      child.stderr.on('data', (chunk) => { stderr.append(chunk); onOutput?.('stderr', chunk); });
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});

      child.on('spawn', () => {
        timingSpawnedNs = monotonicNowNs();
        registryEvent('add', child.pid);
        scheduleExecutionDeadline();
      });

      child.on('error', (error) => {
        stderr.append(`Flight Deck: could not start process: ${error.message}\n`);
        finishReason = 'process_spawn';
        finalize(127);
      });

      child.on('exit', (code, signal) => {
        targetExitCode = code;
        targetSignal = signal;
        const status = timedOut ? 124 : code !== null ? code : signal ? 128 : 1;
        beginCleanup(status, timedOut ? `${phase}_timeout` : 'completed');
      });
    }

    orphanTimer = setInterval(() => {
      if (!finalizing && (process.ppid === 1 || process.ppid !== initialParentPid)) {
        cancelled = true;
        beginCleanup(128, 'parent_lost');
      }
    }, 100);

    if (signal?.aborted) abort();
  });
}
