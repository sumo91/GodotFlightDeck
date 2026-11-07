#!/usr/bin/env node
import { CLI_COMMANDS, parseCliArguments, publicCommandDescription } from '../registry/commands.mjs';
import { fsyncBestEffort, syncDirectoryBestEffort, writeFileAtomic, writeFileAtomicNoReplace } from './atomic-files.mjs';
import { capturePairSummary, publishCapturePairs } from './capture-ab.mjs';
import { classInfoCommand } from './class-info.mjs';
import { renderDiagnosticText, writeUnitDiagnostics } from './diagnostics.mjs';
import { assessDoctorCapabilities, capabilityRelevanceForPlan } from './doctor-capabilities.mjs';
import { AGENT_DECISION_TREE, EDITOR_ACTION_CATALOG, HELP_DOMAINS, describeEditorAction, listEditorActionsByLayer, resolveEditorBridgePolicy, validateBatchOperations } from './editor-catalog.mjs';
import { generateInvocationIdentity, requireInvocationIdentity } from './evidence-contract.mjs';
import { buildEvidenceIndex } from './evidence-index.mjs';
import { projectVerificationJournalSeal } from './evidence-journal.mjs';
import { publishInternalStageOutcome, runProcess, setInternalStageOutcomeSink, timeoutMilliseconds } from './execution.mjs';
import { createLifecycleTemporaryDirectory, lifecycleRegistryEvent, makeVerificationTreeWritable, privateLifecycleRegistry, removeLifecycleTemporaryDirectory } from './lifecycle-resources.mjs';
import { renderVerificationProgress, startVerificationProgressObserver } from './progress-observer.mjs';
import { configPath, defaultConfig, findGodot, isProjectDirectory, loadConfig, projectAndProfile, resolveProject } from './project-config.mjs';
import { releaseManifestPath, writeReleaseManifest } from './release-manifest.mjs';
import { ResultClassificationError, buildResultEnvelope, renderResultEnvelopeText } from './result-envelope.mjs';
import { withRuntimeClockMetadata } from './runtime-clock.mjs';
import { pathContainsSymlink, pathIsInside } from './safety.mjs';
import { formatScenarioLintWarnings, lintScenarioDefinition } from './scenario-lint.mjs';
import { ADDON_SOURCE, CLI_FILE, DEFAULT_TIMEOUT_SECONDS, ERROR_PATTERN, PROCESS_CLEANUP_TIMEOUT_MS, PROCESS_RUNNER, PROCESS_WATCHDOG_GRACE_MS, TOOL_ROOT, TOOL_VERSION, color, timestamp } from './tool-context.mjs';
import { unitBindingForExecution, unitRuntimeArguments, verificationUnitOwnerNonce } from './unit-binding.mjs';
import { createUnitProgressStream, normalizeVerbosity, projectUnitProgress, projectUnitSlowestCases, unitExecutionBindingMatches, unitReportDisposition } from './unit-progress.mjs';
import { assertVerificationPlanDigest, resolveVerificationPlan, verificationPlanExecutionBudgetMilliseconds } from './verification-plan.mjs';
import { assertCurrentVerificationPlanForEffect, assertVerificationSnapshotInputs, prepareProjectImportsForSealing, sealableProjectFingerprint, setVerificationTreeReadOnly, verificationImportableAssetCount } from './verification-snapshot.mjs';
import { verificationExecutionPath, verificationExecutionProject } from './verification-stage.mjs';
import { verifyProject } from './verification.mjs';
import { watchOutput } from './watch-output.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants as fsConstants, cpSync, createReadStream, createWriteStream, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function printHelp(domainCandidate = undefined) {
  const domainName = domainCandidate && HELP_DOMAINS[domainCandidate] ? domainCandidate : undefined;
  if (domainCandidate && !domainName) {
    throw new Error(`Unknown help domain: ${domainCandidate}. Allowed: ${Object.keys(HELP_DOMAINS).join(', ')}`);
  }
  if (domainName) {
    const domain = HELP_DOMAINS[domainName];
    console.log(`Godot Flight Deck ${TOOL_VERSION} — domain: ${domainName}

${domain.summary}

When:
  ${domain.when}

Suggested next commands:
${domain.next.map((line) => `  ${line}`).join('\n')}
`);
    if (domainName === 'editor') {
      const layers = listEditorActionsByLayer();
      console.log('Editor layers:');
      for (const [layer, actions] of Object.entries(layers)) {
        if (!actions.length) continue;
        console.log(`  ${layer}: ${actions.join(', ')}`);
      }
      console.log('\nPolicy: allowWrites gates writes; supplementaryEnabled gates reorder/resource-*; destructive needs --apply.');
      console.log('Describe one action: gdeck editor describe <action> [--json]');
    }
    return;
  }
  const commands = Object.entries(CLI_COMMANDS).filter(([name]) => !['help', 'version', 'describe'].includes(name));
  const usages = commands.map(([, definition]) => `  ${definition.usage}`).join('\n');
  const summaries = commands.map(([name, definition]) => `  ${name.padEnd(12)} ${definition.summary}`).join('\n');
  console.log(`Godot Flight Deck ${TOOL_VERSION}

Usage:
${usages}
  gdeck help [verify|editor|scenario|project]
  gdeck describe <command> --json
  gdeck editor describe [action]

Commands:
${summaries}
  describe     Describe the strict contract for a command
  help         Show full help or a domain guide for Agents

Domains:
${Object.entries(HELP_DOMAINS).map(([name, item]) => `  ${name.padEnd(10)} ${item.summary}`).join('\n')}

Agent decision tree:
${AGENT_DECISION_TREE.map((item) => `  - ${item.id}: prefer ${item.prefer}`).join('\n')}

Environment:
  GODOT_BIN  Absolute path to the preferred Godot executable
  GDECK_CURSOR_COMPAT  Default on in this fork (set 0 to restore nested supervisors)

Options are command-specific and unknown options fail before execution.
Only gdeck run accepts arbitrary game arguments after --.
All Godot and verify stages have a finite wall-clock timeout (default 300 seconds).
`);
}

function describeCommand(name, json = false) {
  const description = publicCommandDescription(name);
  if (!description) throw new Error(`Unknown command to describe: ${name}`);
  const output = { ...description, toolVersion: TOOL_VERSION };
  if (json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`${name}: ${description.summary}`);
    console.log(`Usage: ${description.usage}`);
    const options = Object.keys(description.options);
    console.log(`Options: ${options.length ? options.map((key) => `--${key}`).join(', ') : '(none)'}`);
    if (description.actions) console.log(`Actions: ${Object.keys(description.actions).join(', ')}`);
  }
}

function cursorCompatEnabled() {
  // Agent-shell compat: avoid nested Job Object supervisors under agent shells.
  // Cursor uses GDECK_CURSOR_COMPAT=1 (default on in this fork); Codex uses
  // GDECK_CODEX_DIRECT=1 (explicit opt-in, highest priority). Set
  // GDECK_CURSOR_COMPAT=0 to restore upstream process-runner supervision.
  if (process.env.GDECK_CODEX_DIRECT === '1') return true;
  const raw = process.env.GDECK_CURSOR_COMPAT;
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  return true;
}

function processStatusOr(result, fallback = 1) {
  return [124, 125, 127].includes(result?.status) ? result.status : fallback;
}

function fileFingerprint(path) {
  if (!existsSync(path)) return { kind: 'missing' };
  const metadata = statSync(path);
  if (!metadata.isFile()) return { kind: 'other' };
  return {
    kind: 'file',
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    mode: metadata.mode & 0o777,
  };
}

function sameFingerprint(left, right) {
  return left?.kind === right?.kind && left?.sha256 === right?.sha256 && left?.mode === right?.mode;
}

function addonTreeFingerprint(root) {
  if (!existsSync(root)) return null;
  const hash = createHash('sha256');
  const visit = (directory, relativeDirectory = '') => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`Flight Deck addon transaction refuses symbolic links: ${absolute}`);
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}\0${relativePath}\0${metadata.mode & 0o777}\0`);
      if (entry.isDirectory()) visit(absolute, relativePath);
      else if (entry.isFile()) hash.update(readFileSync(absolute));
      else throw new Error(`Flight Deck addon transaction found unsupported entry: ${absolute}`);
    }
  };
  visit(root);
  return hash.digest('hex');
}

function syncTreeDurably(root) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`Flight Deck staged addon contains a symbolic link: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const descriptor = openSync(absolute, 'r');
        try { fsyncBestEffort(descriptor); } finally { closeSync(descriptor); }
      } else throw new Error(`Flight Deck staged addon contains an unsupported entry: ${absolute}`);
    }
    syncDirectoryBestEffort(directory);
  };
  visit(root);
}

function fileSnapshot(path) {
  if (!existsSync(path)) return { exists: false };
  const metadata = statSync(path);
  if (!metadata.isFile()) throw new Error(`Flight Deck managed path is not a file: ${path}`);
  return { exists: true, content: readFileSync(path), mode: metadata.mode & 0o777 };
}

function restoreFileSnapshot(path, snapshot) {
  rmSync(path, { recursive: true, force: true });
  if (snapshot.exists) writeFileAtomic(path, snapshot.content, { mode: snapshot.mode });
}

function addAutoload(project) {
  const path = join(project, 'project.godot');
  let source = readFileSync(path, 'utf8');
  const declaration = 'FlightDeckProbe="*res://addons/flight_deck/runtime_probe.gd"';
  if (/^FlightDeckProbe=.*$/m.test(source)) {
    source = source.replace(/^FlightDeckProbe=.*$/m, declaration);
  } else if (/^\[autoload\]\s*$/m.test(source)) {
    source = source.replace(/^\[autoload\]\s*$/m, `[autoload]\n\n${declaration}`);
  } else {
    source = `${source.trimEnd()}\n\n[autoload]\n\n${declaration}\n`;
  }
  writeFileAtomic(path, source);
}

function enableEditorPlugin(project) {
  const path = join(project, 'project.godot');
  let source = readFileSync(path, 'utf8');
  const plugin = 'res://addons/flight_deck/plugin.cfg';
  const enabledPattern = /^enabled=PackedStringArray\((.*)\)$/m;
  const match = source.match(enabledPattern);
  if (match) {
    if (!match[1].includes(plugin)) {
      const items = match[1].trim();
      const replacement = `enabled=PackedStringArray(${items ? `${items}, ` : ''}"${plugin}")`;
      source = source.replace(enabledPattern, replacement);
    }
  } else if (/^\[editor_plugins\]\s*$/m.test(source)) {
    source = source.replace(/^\[editor_plugins\]\s*$/m, `[editor_plugins]\n\nenabled=PackedStringArray("${plugin}")`);
  } else {
    source = `${source.trimEnd()}\n\n[editor_plugins]\n\nenabled=PackedStringArray("${plugin}")\n`;
  }
  writeFileAtomic(path, source);
}

function ensureBridgeToken(project) {
  const path = join(project, '.gdeck', 'editor-token');
  if (!existsSync(path)) writeFileAtomic(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  return path;
}

function ensureGitignore(project) {
  const path = join(project, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = [];
  if (!existing.includes('.gdeck/reports/')) lines.push('.gdeck/reports/');
  if (!existing.includes('.gdeck/captures/')) lines.push('.gdeck/captures/');
  if (!existing.includes('.gdeck/editor-token')) lines.push('.gdeck/editor-token');
  if (!existing.includes('.gdeck/editor-session.json')) lines.push('.gdeck/editor-session.json');
  if (!existing.includes('.gdeck/editor-session-*.json')) lines.push('.gdeck/editor-session-*.json');
  if (!existing.includes('.gdeck-init.lock')) lines.push('.gdeck-init.lock');
  if (!existing.includes('.gdeck-init-transaction.json')) lines.push('.gdeck-init-transaction.json');
  if (!existing.includes('.gdeck-init-key-*')) lines.push('.gdeck-init-key-*');
  if (lines.length > 0) {
    writeFileAtomic(path, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}\n# Godot Flight Deck generated output\n${lines.join('\n')}\n`);
  }
}

function acquireInitLock(project) {
  const path = join(project, '.gdeck-init.lock');
  if (pathContainsSymlink(project, path)) throw new Error(`Flight Deck init lock path contains a symbolic link: ${path}`);
  const token = `${process.pid}-${randomBytes(12).toString('hex')}`;
  const create = () => {
    const descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`);
    fsyncBestEffort(descriptor);
    closeSync(descriptor);
    syncDirectoryBestEffort(project);
  };
  try {
    create();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let owner = null;
    try { owner = JSON.parse(readFileSync(path, 'utf8')); } catch {}
    const ownerDetail = Number.isInteger(owner?.pid) && owner.pid > 0 ? ` (recorded pid ${owner.pid})` : '';
    throw new Error(`Flight Deck init lock already exists${ownerDetail}. Init fails closed; after verifying no init process is active, remove ${path} and run init again.`);
  }
  return () => {
    try {
      const owner = JSON.parse(readFileSync(path, 'utf8'));
      if (owner.token === token) rmSync(path, { force: true });
    } catch {}
  };
}

function initJournalPath(project) { return join(project, '.gdeck-init-transaction.json'); }
function initJournalKeyPath(project, transaction) { return join(project, `.gdeck-init-key-${transaction}`); }

function maybeFailInitStep(step) {
  if (process.env.GDECK_TEST_INIT_FAIL_STEP === step) throw new Error(`Injected init failure after ${step}`);
  if (process.env.GDECK_TEST_INIT_CRASH_STEP === step) process.exit(86);
}

function journalSignature(journal, secret) {
  const unsigned = { ...journal };
  delete unsigned.signature;
  return createHmac('sha256', secret).update(JSON.stringify(unsigned)).digest('hex');
}

function writeInitJournal(project, journal, secret) {
  const signed = { ...journal, signature: journalSignature(journal, secret) };
  writeFileAtomic(initJournalPath(project), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
}

function recoverInterruptedInit(project) {
  const journalPath = initJournalPath(project);
  if (pathContainsSymlink(project, journalPath)) throw new Error(`Flight Deck init journal path contains a symbolic link: ${journalPath}`);
  if (!existsSync(journalPath)) return;
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  if (journal.schemaVersion !== 1 || typeof journal.transaction !== 'string' || !/^[0-9]+-[0-9a-f]{10}$/.test(journal.transaction)) {
    throw new Error(`Invalid Flight Deck init recovery journal: ${journalPath}`);
  }
  const keyPath = initJournalKeyPath(project, journal.transaction);
  if (pathContainsSymlink(project, keyPath) || !existsSync(keyPath)) throw new Error(`Flight Deck init recovery key is missing or unsafe: ${keyPath}`);
  const secret = readFileSync(keyPath, 'utf8').trim();
  const expectedSignature = journalSignature(journal, secret);
  const suppliedSignature = String(journal.signature ?? '');
  if (!/^[0-9a-f]{64}$/.test(suppliedSignature)
      || !timingSafeEqual(Buffer.from(expectedSignature, 'hex'), Buffer.from(suppliedSignature, 'hex'))) {
    throw new Error(`Flight Deck init recovery journal failed its integrity check: ${journalPath}`);
  }
  const validPhases = new Set(['preparing', 'addon_backed_up', 'addon_installed', 'committed']);
  const validHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (!validPhases.has(journal.phase) || typeof journal.hadAddon !== 'boolean' || !validHash(journal.stagedFingerprint)
      || (journal.hadAddon && !validHash(journal.backupFingerprint)) || (!journal.hadAddon && journal.backupFingerprint !== null)) {
    throw new Error(`Invalid Flight Deck init recovery journal: ${journalPath}`);
  }
  const addonsDirectory = join(project, 'addons');
  const addonTarget = join(addonsDirectory, 'flight_deck');
  const stagedAddon = join(addonsDirectory, `.flight_deck-stage-${journal.transaction}`);
  const backupAddon = join(addonsDirectory, `.flight_deck-backup-${journal.transaction}`);
  if (typeof journal.targetVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(journal.targetVersion)) {
    throw new Error(`Invalid target version in Flight Deck init recovery journal: ${journalPath}`);
  }
  for (const path of [addonsDirectory, addonTarget, stagedAddon, backupAddon]) {
    if (pathContainsSymlink(project, path)) throw new Error(`Flight Deck init recovery refuses a symbolic link: ${path}`);
  }
  const requireFingerprint = (path, expected, label) => {
    if (!existsSync(path)) return false;
    const actual = addonTreeFingerprint(path);
    if (actual !== expected) throw new Error(`Interrupted init found a modified ${label}; preserved for manual recovery: ${path}`);
    return true;
  };
  const stageExists = requireFingerprint(stagedAddon, journal.stagedFingerprint, 'staged addon');
  if (!journal.hadAddon && existsSync(backupAddon)) throw new Error(`Interrupted init journal contradicts the preserved addon backup: ${backupAddon}`);
  const backupExists = journal.hadAddon ? requireFingerprint(backupAddon, journal.backupFingerprint, 'addon backup') : false;
  if (journal.phase === 'committed') {
    requireFingerprint(addonTarget, journal.stagedFingerprint, 'committed installed addon');
    if (stageExists) rmSync(stagedAddon, { recursive: true, force: true });
    if (backupExists) rmSync(backupAddon, { recursive: true, force: true });
    rmSync(journalPath, { force: true });
    rmSync(keyPath, { force: true });
    syncDirectoryBestEffort(addonsDirectory);
    syncDirectoryBestEffort(project);
    return;
  }
  if (backupExists) {
    if (existsSync(addonTarget)) {
      requireFingerprint(addonTarget, journal.stagedFingerprint, 'installed transaction addon');
      rmSync(addonTarget, { recursive: true, force: true });
    }
    renameSync(backupAddon, addonTarget);
  } else if (journal.hadAddon) {
    if (!existsSync(addonTarget) || addonTreeFingerprint(addonTarget) !== journal.backupFingerprint || journal.phase !== 'preparing') {
      throw new Error(`Interrupted init backup is missing; refusing automatic recovery: ${backupAddon}`);
    }
  } else if (existsSync(addonTarget)) {
    requireFingerprint(addonTarget, journal.stagedFingerprint, 'installed transaction addon');
    rmSync(addonTarget, { recursive: true, force: true });
  }
  if (stageExists) rmSync(stagedAddon, { recursive: true, force: true });
  rmSync(journalPath, { force: true });
  rmSync(keyPath, { force: true });
  syncDirectoryBestEffort(addonsDirectory);
  syncDirectoryBestEffort(project);
}

function initProject(projectCandidate) {
  const project = resolveProject(projectCandidate);
  const releaseLock = acquireInitLock(project);
  try {
    recoverInterruptedInit(project);
  const addonsDirectory = join(project, 'addons');
  const addonTarget = join(addonsDirectory, 'flight_deck');
  const transaction = `${process.pid}-${randomBytes(5).toString('hex')}`;
  const journalSecret = randomBytes(32).toString('hex');
  const journalKeyPath = initJournalKeyPath(project, transaction);
  const stagedAddon = join(addonsDirectory, `.flight_deck-stage-${transaction}`);
  const backupAddon = join(addonsDirectory, `.flight_deck-backup-${transaction}`);
  const gdeckDirectory = join(project, '.gdeck');
  if (pathContainsSymlink(project, gdeckDirectory)) throw new Error(`Flight Deck init refuses a managed path containing a symbolic link: ${gdeckDirectory}`);
  const managedFiles = [
    configPath(project), join(project, 'project.godot'), join(project, '.gitignore'),
    join(project, '.gdeck', 'editor-token'),
  ];
  const assertManagedPathsSafe = () => {
    for (const path of [addonsDirectory, addonTarget, join(project, '.gdeck'), ...managedFiles]) {
      if (pathContainsSymlink(project, path)) throw new Error(`Flight Deck init refuses a managed path containing a symbolic link: ${path}`);
    }
  };
  assertManagedPathsSafe();
  const snapshots = new Map(managedFiles.map((path) => [path, fileSnapshot(path)]));
  const expectedFingerprints = new Map(managedFiles.map((path) => [path, fileFingerprint(path)]));
  const directoryState = new Map([
    [addonsDirectory, existsSync(addonsDirectory)],
    [join(project, '.gdeck'), existsSync(join(project, '.gdeck'))],
    [join(project, '.gdeck', 'captures'), existsSync(join(project, '.gdeck', 'captures'))],
    [join(project, '.gdeck', 'reports'), existsSync(join(project, '.gdeck', 'reports'))],
  ]);
  let addonBackedUp = false;
  let addonInstalled = false;
  const writtenFingerprints = new Map();
  const assertWritePrecondition = (path) => {
    if (!sameFingerprint(fileFingerprint(path), expectedFingerprints.get(path))) {
      throw new Error(`Flight Deck init detected a concurrent change before writing: ${path}`);
    }
  };
  const recordWrite = (path) => {
    const fingerprint = fileFingerprint(path);
    writtenFingerprints.set(path, fingerprint);
    expectedFingerprints.set(path, fingerprint);
  };
  const journal = {
    schemaVersion: 1, transaction, targetVersion: TOOL_VERSION, hadAddon: existsSync(addonTarget), phase: 'preparing',
    stagedFingerprint: null, backupFingerprint: null,
  };
  try {
    mkdirSync(addonsDirectory, { recursive: true });
    cpSync(ADDON_SOURCE, stagedAddon, { recursive: true, force: false, errorOnExist: true });
    for (const required of ['plugin.cfg', 'plugin.gd', 'runtime_probe.gd', 'scenario_runner.gd', 'unit_runner.gd']) {
      if (!existsSync(join(stagedAddon, required))) throw new Error(`Staged Flight Deck addon is incomplete: ${required}`);
    }
    const stagedPlugin = readFileSync(join(stagedAddon, 'plugin.cfg'), 'utf8');
    if (!stagedPlugin.includes(`version="${TOOL_VERSION}"`)) throw new Error(`Staged Flight Deck addon version does not match ${TOOL_VERSION}`);
    syncTreeDurably(stagedAddon);
    journal.stagedFingerprint = addonTreeFingerprint(stagedAddon);
    journal.backupFingerprint = journal.hadAddon ? addonTreeFingerprint(addonTarget) : null;
    assertManagedPathsSafe();
    writeFileAtomic(journalKeyPath, `${journalSecret}\n`, { mode: 0o600 });
    writeInitJournal(project, journal, journalSecret);
    if (existsSync(addonTarget)) {
      renameSync(addonTarget, backupAddon);
      addonBackedUp = true;
      syncDirectoryBestEffort(addonsDirectory);
    }
    journal.phase = 'addon_backed_up';
    writeInitJournal(project, journal, journalSecret);
    maybeFailInitStep('addon_backed_up');
    renameSync(stagedAddon, addonTarget);
    addonInstalled = true;
    syncDirectoryBestEffort(addonsDirectory);
    journal.phase = 'addon_installed';
    writeInitJournal(project, journal, journalSecret);

    assertManagedPathsSafe();
    mkdirSync(join(project, '.gdeck', 'captures'), { recursive: true });
    mkdirSync(join(project, '.gdeck', 'reports'), { recursive: true });
    const path = configPath(project);
    assertWritePrecondition(path);
    if (!existsSync(path)) {
      writeFileAtomic(path, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
      recordWrite(path);
    } else {
      const existingConfig = JSON.parse(readFileSync(path, 'utf8'));
      existingConfig.flightDeckVersion = TOOL_VERSION;
      existingConfig.editorBridge = { ...defaultConfig().editorBridge, ...(existingConfig.editorBridge ?? {}) };
      existingConfig.pi = { ...defaultConfig().pi, ...(existingConfig.pi ?? {}) };
      writeFileAtomic(path, `${JSON.stringify(existingConfig, null, 2)}\n`);
      recordWrite(path);
    }
    assertWritePrecondition(join(project, 'project.godot'));
    addAutoload(project);
    recordWrite(join(project, 'project.godot'));
    assertWritePrecondition(join(project, 'project.godot'));
    enableEditorPlugin(project);
    recordWrite(join(project, 'project.godot'));
    if (process.env.GDECK_TEST_INIT_CREATE_TOKEN === '1') writeFileSync(join(project, '.gdeck', 'editor-token'), 'concurrent-token\n', { mode: 0o600 });
    assertWritePrecondition(join(project, '.gdeck', 'editor-token'));
    ensureBridgeToken(project);
    recordWrite(join(project, '.gdeck', 'editor-token'));
    assertWritePrecondition(join(project, '.gitignore'));
    ensureGitignore(project);
    recordWrite(join(project, '.gitignore'));
    maybeFailInitStep('gitignore');
    journal.phase = 'committed';
    writeInitJournal(project, journal, journalSecret);
    maybeFailInitStep('committed');
    rmSync(backupAddon, { recursive: true, force: true });
    addonBackedUp = false;
    rmSync(initJournalPath(project), { force: true });
    rmSync(journalKeyPath, { force: true });
    console.log(color.green('Flight Deck installed'));
    console.log(`  Project: ${project}`);
    console.log(`  Addon:   ${addonTarget}`);
    console.log(`  Config:  ${path}`);
    console.log('  Editor:  restart required if this project was already open');
  } catch (error) {
    const rollbackErrors = [];
    try {
      if (addonInstalled) {
        const installedFingerprint = addonTreeFingerprint(addonTarget);
        if (installedFingerprint !== journal.stagedFingerprint) throw new Error('installed addon changed after this transaction wrote it');
        rmSync(addonTarget, { recursive: true, force: true });
      }
    } catch (rollbackError) { rollbackErrors.push(`cannot remove partial addon: ${rollbackError.message}`); }
    if (addonBackedUp && existsSync(backupAddon)) {
      try {
        renameSync(backupAddon, addonTarget);
        addonBackedUp = false;
      } catch (rollbackError) {
        rollbackErrors.push(`cannot restore addon backup at ${backupAddon}: ${rollbackError.message}`);
      }
    }
    for (const [path, snapshot] of snapshots) {
      const written = writtenFingerprints.get(path);
      if (!written) continue;
      try {
        if (!sameFingerprint(fileFingerprint(path), written)) {
          rollbackErrors.push(`refused to overwrite a concurrently changed file: ${path}`);
          continue;
        }
        restoreFileSnapshot(path, snapshot);
      } catch (rollbackError) { rollbackErrors.push(`cannot restore ${path}: ${rollbackError.message}`); }
    }
    for (const [path, existed] of [...directoryState.entries()].reverse()) {
      if (!existed && existsSync(path)) {
        try { if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true }); }
        catch (rollbackError) { rollbackErrors.push(`cannot clean ${path}: ${rollbackError.message}`); }
      }
    }
    if (rollbackErrors.length) {
      throw new Error(`Flight Deck init failed and rollback is incomplete: ${error.message}. ${rollbackErrors.join('; ')}`);
    }
    rmSync(initJournalPath(project), { force: true });
    rmSync(journalKeyPath, { force: true });
    throw new Error(`Flight Deck init rolled back without keeping partial changes: ${error.message}`);
  } finally {
    rmSync(stagedAddon, { recursive: true, force: true });
    if (!addonBackedUp) rmSync(backupAddon, { recursive: true, force: true });
  }
  } finally {
    releaseLock();
  }
}

async function godotVersion(godot, options = {}) {
  const result = await runProcess(godot, ['--version'], {
    quiet: true, timeoutMs: timeoutMilliseconds(options), maxOutputBytes: 16 * 1024, phase: 'godot_version',
  });
  if ([124, 125, 127].includes(result.status)) {
    const message = result.status === 124 ? 'Godot version check timed out'
      : result.status === 125 ? 'Godot version check cleanup exceeded its deadline'
        : 'Godot version process could not be started';
    const error = new Error(message);
    error.exitCode = result.status;
    throw error;
  }
  if (result.status !== 0) throw new Error(`Godot version check failed with exit code ${result.status}`);
  const output = result.stdout.trim();
  if (!output) throw new Error('Godot version check returned empty output');
  if (Buffer.byteLength(output) > 256 || output.includes('\n') || !/^\d+\.\d+(?:\.\d+)?(?:\.[A-Za-z0-9]+)*$/.test(output)) {
    throw new Error('Godot version check returned malformed output');
  }
  return output;
}

function templateDirectories() {
  // Always include the platform install root (Windows uses %APPDATA%\Godot\export_templates).
  // Keep legacy macOS/Linux paths for side-by-side installs and Flatpak.
  const roots = [
    exportTemplateRoot(),
    join(homedir(), 'Library', 'Application Support', 'Godot', 'export_templates'),
    join(homedir(), '.local', 'share', 'godot', 'export_templates'),
    join(homedir(), '.var', 'app', 'org.godotengine.Godot', 'data', 'godot', 'export_templates'),
  ];
  const seenRoots = new Set();
  const versions = [];
  for (const root of roots) {
    if (!root || seenRoots.has(root) || !existsSync(root)) continue;
    seenRoots.add(root);
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      if (statSync(full).isDirectory()) versions.push(full);
    }
  }
  return versions;
}

function exportTemplateRoot() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Godot', 'export_templates');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Godot', 'export_templates');
  }
  return join(homedir(), '.local', 'share', 'godot', 'export_templates');
}

function templateVersionFromGodot(versionString) {
  // Godot 4.x reports both "4.3.stable.official" and "4.7.1.stable.official…".
  // Template folders use "<version>.<channel>", e.g. 4.7.1.stable.
  const match = String(versionString).trim().match(
    /^(\d+\.\d+(?:\.\d+)?)\.(stable|beta\d*|rc\d*|dev\d*)(?:\.|$)/,
  );
  if (!match) throw new Error(`Cannot derive export template version from Godot: ${versionString}`);
  return `${match[1]}.${match[2]}`;
}

function releaseTagFromTemplateVersion(templateVersion) {
  // 4.7.1.stable → 4.7.1-stable; 4.3.stable → 4.3-stable
  const match = String(templateVersion).trim().match(
    /^(\d+\.\d+(?:\.\d+)?)\.(stable|beta\d*|rc\d*|dev\d*)$/,
  );
  if (!match) throw new Error(`Cannot derive release tag from template version: ${templateVersion}`);
  return `${match[1]}-${match[2]}`;
}

async function officialTemplateAsset(templateVersion) {
  const tag = releaseTagFromTemplateVersion(templateVersion);
  const response = await fetch(`https://api.github.com/repos/godotengine/godot/releases/tags/${tag}`, {
    headers: { 'User-Agent': `godot-flight-deck/${TOOL_VERSION}`, Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`Cannot query Godot release ${tag}: HTTP ${response.status}`);
  const release = await response.json();
  const expectedName = `Godot_v${tag.replace('-', '-')}_export_templates.tpz`;
  const asset = release.assets?.find((candidate) => candidate.name === expectedName)
    ?? release.assets?.find((candidate) => candidate.name.includes('export_templates.tpz') && !candidate.name.includes('mono'));
  if (!asset) throw new Error(`Official export template asset not found for ${tag}`);
  return {
    tag,
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    sha256: String(asset.digest ?? '').replace(/^sha256:/, ''),
  };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': `godot-flight-deck/${TOOL_VERSION}` } });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  mkdirSync(dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function templatesCommand(positional, options) {
  const action = positional[0] ?? 'status';
  const projectCandidate = positional[1];
  const project = projectCandidate ? resolveProject(projectCandidate) : (isProjectDirectory(process.cwd()) ? resolveProject() : null);
  const config = project ? loadConfig(project) : defaultConfig();
  const godot = findGodot(config, options.godot);
  const versionString = await godotVersion(godot, options);
  const templateVersion = templateVersionFromGodot(versionString);
  const destination = join(exportTemplateRoot(), templateVersion);
  const installed = existsSync(destination) && readdirSync(destination).length > 0;
  if (action === 'status') {
    console.log(`Godot:     ${versionString}`);
    console.log(`Templates: ${destination}`);
    console.log(`Status:    ${installed ? color.green('installed') : color.yellow('missing')}`);
    return installed ? 0 : 1;
  }
  if (action !== 'install') throw new Error(`Unknown templates action: ${action}`);
  if (installed && !options.force) {
    console.log(color.green(`Export templates already installed: ${destination}`));
    return 0;
  }
  const asset = await officialTemplateAsset(templateVersion);
  const cacheDirectory = join(homedir(), '.cache', 'godot-flight-deck', 'templates');
  const archive = join(cacheDirectory, asset.name);
  console.log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
  if (!existsSync(archive) || statSync(archive).size !== asset.size || options.force) {
    await downloadFile(asset.url, archive);
  } else {
    console.log(color.muted(`Using cached archive: ${archive}`));
  }
  if (asset.sha256) {
    console.log('Verifying SHA-256…');
    const digest = await sha256File(archive);
    if (digest !== asset.sha256) {
      rmSync(archive, { force: true });
      throw new Error(`Template checksum mismatch: expected ${asset.sha256}, received ${digest}`);
    }
  }
  const extraction = join(tmpdir(), `gdeck-templates-${process.pid}-${Date.now()}`);
  mkdirSync(extraction, { recursive: true });
  const unzip = await runProcess('unzip', ['-q', '-o', archive, '-d', extraction], { quiet: true, timeoutMs: timeoutMilliseconds(options) });
  if (unzip.status !== 0) {
    rmSync(extraction, { recursive: true, force: true });
    throw new Error(`Cannot extract export templates: ${unzip.output}`);
  }
  const source = existsSync(join(extraction, 'templates')) ? join(extraction, 'templates') : extraction;
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
  rmSync(extraction, { recursive: true, force: true });
  console.log(color.green(`Export templates installed: ${destination}`));
  return 0;
}

function defaultExports(project) {
  const projectSettings = readFileSync(join(project, 'project.godot'), 'utf8');
  const nameMatch = projectSettings.match(/^config\/name="([^"]+)"/m);
  const projectName = nameMatch?.[1] ?? 'GodotGame';
  const fileName = projectName.replace(/[^a-zA-Z0-9_-]+/g, '') || 'GodotGame';
  const bundleName = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') || 'godot.game';
  return {
    bundleIdentifier: `com.flightdeck.${bundleName}`,
    targets: {
      macos: { preset: 'macOS', path: `build/macos/${fileName}.zip` },
      windows: { preset: 'Windows Desktop', path: `build/windows/${fileName}.exe` },
      linux: { preset: 'Linux', path: `build/linux/${fileName}.x86_64` },
    },
  };
}

function exportPresetText(exportsConfig) {
  const targets = [
    ['macOS', 'macOS', exportsConfig.targets.macos.path, `application/bundle_identifier="${exportsConfig.bundleIdentifier}"\nbinary_format/architecture="universal"\ncodesign/codesign=1\nnotarization/notarization=0`],
    ['Windows Desktop', 'Windows Desktop', exportsConfig.targets.windows.path, 'binary_format/architecture="x86_64"\ncodesign/enable=false'],
    ['Linux', 'Linux', exportsConfig.targets.linux.path, 'binary_format/architecture="x86_64"'],
  ];
  return `${targets.map(([name, platform, output, options], index) => `[preset.${index}]\n\nname="${name}"\nplatform="${platform}"\nrunnable=${index === 0 ? 'true' : 'false'}\nadvanced_options=false\ndedicated_server=false\ncustom_features=""\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=".gdeck/**,qa/**,tests/**,docs/**,README.md,addons/flight_deck/**"\nexport_path="${output}"\nencryption_include_filters=""\nencryption_exclude_filters=""\nencrypt_pck=false\nencrypt_directory=false\n\n[preset.${index}.options]\n\ncustom_template/debug=""\ncustom_template/release=""\n${options}\n`).join('\n')}\n`;
}

function exportInit(projectCandidate) {
  const project = resolveProject(projectCandidate);
  const path = configPath(project);
  const config = loadConfig(project);
  config.flightDeckVersion = TOOL_VERSION;
  config.exports = config.exports ?? defaultExports(project);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  const presetsPath = join(project, 'export_presets.cfg');
  if (!existsSync(presetsPath)) {
    writeFileSync(presetsPath, exportPresetText(config.exports));
    console.log(color.green(`Created ${presetsPath}`));
  } else {
    console.log(color.yellow(`Preserved existing ${presetsPath}`));
  }
  console.log(`Bundle ID: ${config.exports.bundleIdentifier}`);
  return 0;
}

function sanitizedProjectSettings(source) {
  let result = source.replace(/^FlightDeckProbe=.*(?:\r?\n)?/m, '');
  result = result.replace(/"res:\/\/addons\/flight_deck\/plugin\.cfg"\s*,?\s*/g, '');
  result = result.replace(/PackedStringArray\(\s*,/g, 'PackedStringArray(').replace(/,\s*\)/g, ')');
  return result;
}

function exportSourceExclusions(project, exportsConfig) {
  return [
    { path: join(project, 'build', 'release-manifest.json'), subtree: false },
    ...Object.values(exportsConfig?.targets ?? {})
      .filter((definition) => definition && typeof definition === 'object' && typeof definition.path === 'string')
      .map((definition) => ({ path: dirname(resolve(project, definition.path)), subtree: true })),
  ].filter((item) => pathIsInside(project, item.path));
}

async function stageReleaseProject(project, sourceExclusions = [], importRuntime = null) {
  const stagingRoot = createLifecycleTemporaryDirectory('gdeck-release-project-');
  const ignored = new Set(['.git', '.godot', '.gdeck', 'tests', 'qa', 'docs']);
  try {
    cpSync(project, stagingRoot, {
      recursive: true,
      force: true,
      filter: (source) => {
        const relation = relative(project, source);
        if (!relation) return true;
        const parts = relation.split(sep);
        if (ignored.has(parts[0]) || source.endsWith('.import')) return false;
        if (sourceExclusions.some((item) => source === item.path || (item.subtree && pathIsInside(item.path, source)))) return false;
        return !(parts[0] === 'addons' && parts[1] === 'flight_deck');
      },
    });
    makeVerificationTreeWritable(stagingRoot);
    const settingsPath = join(stagingRoot, 'project.godot');
    writeFileSync(settingsPath, sanitizedProjectSettings(readFileSync(settingsPath, 'utf8')));
    rmSync(join(stagingRoot, 'addons', 'flight_deck'), { recursive: true, force: true });
    mkdirSync(join(stagingRoot, '.godot'), { recursive: true });
    const sourceFingerprint = sealableProjectFingerprint(stagingRoot);
    const importableAssets = verificationImportableAssetCount(stagingRoot);
    if (importableAssets > 0) {
      await prepareProjectImportsForSealing(stagingRoot, importRuntime);
      if (sealableProjectFingerprint(stagingRoot) !== sourceFingerprint) {
        throw new ResultClassificationError('plan_drift', 'Release source changed while Godot imports were being prepared; export was not started.');
      }
    }
    setVerificationTreeReadOnly(stagingRoot);
    return stagingRoot;
  } catch (error) {
    removeLifecycleTemporaryDirectory(stagingRoot);
    throw error;
  }
}

function macosNativeSmokeOptions(exportsConfig) {
  const definition = exportsConfig.nativeSmoke?.macos;
  if (definition === undefined) return { enabled: false, timeoutMs: 10_000 };
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('exports.nativeSmoke.macos must be an object');
  }
  if (definition.enabled !== undefined && typeof definition.enabled !== 'boolean') {
    throw new Error('exports.nativeSmoke.macos.enabled must be boolean');
  }
  const timeoutSeconds = Number(definition.timeoutSeconds ?? 10);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 30) {
    throw new Error('exports.nativeSmoke.macos.timeoutSeconds must be between 1 and 30');
  }
  return { enabled: definition.enabled === true, timeoutMs: Math.round(timeoutSeconds * 1000) };
}

function validateZipEntryNames(names) {
  for (const name of names) {
    const normalized = String(name);
    const parts = normalized.split('/');
    if (!normalized || normalized.includes('\\') || normalized.includes('\0') || normalized.startsWith('/')
      || /^[A-Za-z]:\//.test(normalized) || parts.includes('..')) {
      throw new Error(`Unsafe macOS archive entry: ${name}`);
    }
  }
}

async function nativeMacosSmoke(output, executableEntry, options) {
  const sandbox = createLifecycleTemporaryDirectory('gdeck-native-smoke-');
  const extraction = join(sandbox, 'archive');
  const isolatedHome = join(sandbox, 'home');
  const isolatedTemp = join(sandbox, 'tmp');
  const isolatedData = join(sandbox, 'data');
  const isolatedConfig = join(sandbox, 'config');
  try {
    for (const directory of [extraction, isolatedHome, isolatedTemp, isolatedData, isolatedConfig]) mkdirSync(directory, { recursive: true });
    const metadata = await runProcess('unzip', ['-Z', '-l', output], { quiet: true, timeoutMs: 30_000 });
    if (metadata.status !== 0) return { passed: false, nativeRun: false, reason: 'cannot inspect macOS archive metadata' };
    if (metadata.stdout.split(/\r?\n/).some((line) => /^l[rwx-]{9}\s/.test(line))) {
      return { passed: false, nativeRun: false, reason: 'macOS archive contains symbolic links' };
    }
    const unzip = await runProcess('unzip', ['-q', output, '-d', extraction], { quiet: true, timeoutMs: 30_000 });
    if (unzip.status !== 0) return { passed: false, nativeRun: false, reason: 'cannot extract macOS archive for native smoke' };
    const executable = resolve(extraction, executableEntry);
    if (!pathIsInside(extraction, executable) || pathContainsSymlink(extraction, executable) || !existsSync(executable) || !statSync(executable).isFile()) {
      return { passed: false, nativeRun: false, reason: 'macOS app executable is unsafe or missing after extraction' };
    }
    const result = await runProcess(executable, ['--headless', '--quit-after', '2'], {
      cwd: dirname(executable),
      quiet: true,
      timeoutMs: options.timeoutMs,
      phase: 'native_smoke',
      inheritEnv: false,
      env: {
        HOME: isolatedHome,
        TMPDIR: isolatedTemp,
        XDG_DATA_HOME: isolatedData,
        XDG_CONFIG_HOME: isolatedConfig,
        APPDATA: isolatedData,
        LOCALAPPDATA: isolatedData,
        PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        LC_ALL: process.env.LC_ALL ?? '',
      },
    });
    const passed = result.status === 0 && !ERROR_PATTERN.test(result.output);
    return {
      passed,
      check: 'macOS .app executable launched with isolated user directories',
      nativeRun: passed,
      exitCode: result.status,
      timedOut: result.timedOut,
      reason: passed ? undefined : result.timedOut ? 'native macOS smoke timed out' : 'native macOS smoke failed',
    };
  } finally {
    removeLifecycleTemporaryDirectory(sandbox);
  }
}

async function smokeExport(target, output, nativeSmokeOptions = { enabled: false }) {
  const status = statSync(output);
  if (!status.isFile() || status.size <= 0) return { passed: false, reason: 'primary artifact is empty' };
  if (target === 'macos') {
    const listing = await runProcess('unzip', ['-Z1', output], { quiet: true, timeoutMs: 30_000 });
    const names = listing.stdout.split(/\r?\n/).filter(Boolean);
    if (listing.status !== 0) return { passed: false, reason: 'cannot inspect macOS archive', nativeRun: false };
    try { validateZipEntryNames(names); } catch (error) { return { passed: false, reason: error.message, nativeRun: false }; }
    const executableEntry = names.find((name) => /\.app\/Contents\/MacOS\/[^/]+$/.test(name));
    if (!executableEntry) return { passed: false, reason: 'archive does not contain a macOS .app executable', nativeRun: false };
    if (nativeSmokeOptions.enabled) {
      if (process.platform !== 'darwin') {
        return { passed: false, reason: 'native macOS smoke was requested on a non-macOS host', nativeRun: false };
      }
      return await nativeMacosSmoke(output, executableEntry, nativeSmokeOptions);
    }
    return {
      passed: true,
      check: 'archive contains a macOS .app executable',
      nativeRun: false,
      note: 'Structure smoke only; enable exports.nativeSmoke.macos for an isolated native launch on macOS.',
    };
  }
  const companion = output.replace(/\.(?:exe|x86_64)$/i, '.pck');
  const passed = existsSync(companion) && statSync(companion).size > 0;
  return {
    passed,
    check: target === 'windows' ? 'Windows .exe and .pck structure' : 'Linux executable and .pck structure',
    nativeRun: false,
    note: 'Structure smoke only; no Windows/Linux native execution was claimed.',
  };
}

function beginDirectoryReplacement(stagedDirectory, destinationDirectory, backupRoot = dirname(destinationDirectory)) {
  const backup = join(backupRoot, `${basename(destinationDirectory)}.backup-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dirname(destinationDirectory), { recursive: true });
  let hadDestination = false;
  try {
    if (existsSync(destinationDirectory)) {
      renameSync(destinationDirectory, backup);
      hadDestination = true;
    }
    renameSync(stagedDirectory, destinationDirectory);
    return { destinationDirectory, backup, hadDestination };
  } catch (error) {
    if (existsSync(destinationDirectory)) rmSync(destinationDirectory, { recursive: true, force: true });
    if (hadDestination && existsSync(backup)) renameSync(backup, destinationDirectory);
    throw error;
  }
}

function commitDirectoryReplacement(transaction) {
  rmSync(transaction.backup, { recursive: true, force: true });
}

function rollbackDirectoryReplacement(transaction) {
  if (existsSync(transaction.destinationDirectory)) rmSync(transaction.destinationDirectory, { recursive: true, force: true });
  if (transaction.hadDestination && existsSync(transaction.backup)) renameSync(transaction.backup, transaction.destinationDirectory);
}

function replaceDirectoryAtomically(stagedDirectory, destinationDirectory) {
  const transaction = beginDirectoryReplacement(stagedDirectory, destinationDirectory);
  commitDirectoryReplacement(transaction);
}

function fileRollbackSnapshot(path) {
  return existsSync(path) ? { path, existed: true, bytes: readFileSync(path), mode: statSync(path).mode & 0o777 } : { path, existed: false };
}

function restoreFileRollbackSnapshot(snapshot) {
  if (!snapshot.existed) {
    rmSync(snapshot.path, { force: true });
    return;
  }
  mkdirSync(dirname(snapshot.path), { recursive: true });
  const temporary = `${snapshot.path}.rollback-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, snapshot.bytes, { mode: snapshot.mode });
  rmSync(snapshot.path, { force: true });
  renameSync(temporary, snapshot.path);
}

async function exportProject(positional, options, internalStage = null) {
  const targetName = internalStage?.stage.target ?? positional[0] ?? 'all';
  const project = internalStage?.plan.project ?? resolveProject(positional[1] ?? process.cwd());
  const sourceProject = verificationExecutionProject(internalStage) ?? project;
  const config = internalStage
    ? { godotPath: internalStage.stage.runtime.godotPath, exports: internalStage.stage.runtime.exportsConfig }
    : loadConfig(project);
  const exportsConfig = config.exports;
  if (!exportsConfig) throw new Error('Export configuration missing. Run gdeck export-init first.');
  if (!existsSync(join(sourceProject, 'export_presets.cfg'))) throw new Error('export_presets.cfg missing. Run gdeck export-init first.');
  if (options.publish) {
    throw new Error('--publish is unavailable until Flight Deck implements and verifies target-specific signing and notarization.');
  }
  const godot = findGodot(config, options.godot);
  const requested = targetName === 'all' ? ['macos', 'windows', 'linux'] : [targetName];
  const nativeSmokeByTarget = new Map();
  if (requested.includes('macos')) nativeSmokeByTarget.set('macos', macosNativeSmokeOptions(exportsConfig));
  const occupiedOutputs = new Set();
  const plans = requested.map((target) => {
    const definition = exportsConfig.targets?.[target];
    if (!definition) throw new Error(`Unknown export target: ${target}`);
    const finalOutput = resolve(project, options.output && requested.length === 1 ? options.output : definition.path);
    if (!pathIsInside(project, finalOutput)) throw new Error(`Export output must stay inside the project: ${finalOutput}`);
    if (pathContainsSymlink(project, finalOutput)) throw new Error(`Export output path must not contain symbolic links: ${finalOutput}`);
    const finalDirectory = dirname(finalOutput);
    if (finalDirectory === project) {
      throw new Error(`Export output must use a dedicated subdirectory, not the project root: ${finalOutput}`);
    }
    const outputs = target === 'macos'
      ? [finalOutput]
      : [finalOutput, finalOutput.replace(/\.(?:exe|x86_64)$/i, '.pck')];
    for (const output of outputs) {
      if (occupiedOutputs.has(output)) throw new Error(`Export targets resolve to the same artifact path: ${output}`);
      occupiedOutputs.add(output);
    }
    return { target, definition, finalOutput, finalDirectory };
  });
  const directories = [...new Set(plans.map((plan) => plan.finalDirectory))];
  for (let left = 0; left < directories.length; left += 1) {
    for (let right = left + 1; right < directories.length; right += 1) {
      if (pathIsInside(directories[left], directories[right]) || pathIsInside(directories[right], directories[left])) {
        throw new Error(`Export directories must not be nested: ${directories[left]} and ${directories[right]}`);
      }
    }
  }

  const manifestPath = releaseManifestPath(project);
  const groups = new Map();
  const exportStagingRoot = join(project, '.gdeck', 'export-staging');
  if (pathContainsSymlink(project, exportStagingRoot)) throw new Error(`Export staging path must not contain symbolic links: ${exportStagingRoot}`);
  const sourceStage = await stageReleaseProject(sourceProject, exportSourceExclusions(sourceProject, exportsConfig), {
    godot,
    timeoutMs: timeoutMilliseconds(options),
  });
  const artifacts = [];
  const replacements = [];
  const manifestRollback = internalStage ? fileRollbackSnapshot(manifestPath) : null;
  let manifestWritten = false;
  let failed = false;
  let timedOut = false;
  let lifecycleStatus = 0;
  try {
    for (const finalDirectory of directories) {
      const stagedDirectory = join(exportStagingRoot, `${basename(finalDirectory)}-${process.pid}-${Date.now()}-${groups.size}`);
      lifecycleRegistryEvent('resource_add', stagedDirectory);
      rmSync(stagedDirectory, { recursive: true, force: true });
      if (existsSync(finalDirectory)) {
        if (!statSync(finalDirectory).isDirectory()) throw new Error(`Export destination is not a directory: ${finalDirectory}`);
        cpSync(finalDirectory, stagedDirectory, { recursive: true });
      } else {
        mkdirSync(stagedDirectory, { recursive: true });
      }
      groups.set(finalDirectory, { stagedDirectory, changed: false });
    }

    for (const plan of plans) {
      const group = groups.get(plan.finalDirectory);
      const stagedOutput = join(group.stagedDirectory, basename(plan.finalOutput));
      rmSync(stagedOutput, { force: true });
      if (plan.target !== 'macos') rmSync(stagedOutput.replace(/\.(?:exe|x86_64)$/i, '.pck'), { force: true });
      console.log(`Exporting ${plan.target} → ${plan.finalOutput}`);
      const mode = options.debug ? '--export-debug' : '--export-release';
      const result = await runProcess(godot, ['--headless', '--path', sourceStage, mode, plan.definition.preset, stagedOutput], {
        cwd: sourceStage,
        timeoutMs: timeoutMilliseconds(options),
        phase: 'export',
      });
      timedOut ||= result.timedOut;
      if ([124, 125, 127].includes(result.status)) lifecycleStatus = result.status;
      const smoke = result.status === 0 && !ERROR_PATTERN.test(result.output) && existsSync(stagedOutput)
        ? await smokeExport(plan.target, stagedOutput, nativeSmokeByTarget.get(plan.target))
        : { passed: false, reason: result.timedOut ? 'export timed out' : 'Godot export failed' };
      if (!smoke.passed) {
        console.log(color.red(`Export failed: ${plan.target}`));
        failed = true;
        if ([124, 125, 127].includes(smoke.exitCode)) lifecycleStatus = smoke.exitCode;
        if (lifecycleStatus !== 0) break;
        continue;
      }
      const stagedFiles = plan.target === 'macos'
        ? [stagedOutput]
        : [stagedOutput, stagedOutput.replace(/\.(?:exe|x86_64)$/i, '.pck')];
      const files = stagedFiles.map((file) => ({
        path: relative(group.stagedDirectory, file),
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
        size: statSync(file).size,
      }));
      group.changed = true;
      artifacts.push({
        target: plan.target,
        path: relative(project, plan.finalOutput),
        sha256: files[0].sha256,
        size: files[0].size,
        files,
        smoke,
      });
    }

    if (internalStage) assertCurrentVerificationPlanForEffect(internalStage.plan, 'before export commit; final artifacts were not replaced');
    for (const [finalDirectory, group] of groups) {
      if (!group.changed) continue;
      if (internalStage) replacements.push(beginDirectoryReplacement(group.stagedDirectory, finalDirectory, exportStagingRoot));
      else replaceDirectoryAtomically(group.stagedDirectory, finalDirectory);
    }
    for (const artifact of artifacts) console.log(color.green(`Export complete: ${artifact.target}`));
    await writeReleaseManifest(project, {
      debug: options.debug,
      publishRequested: options.publish,
      artifacts,
    });
    manifestWritten = true;
    if (internalStage) {
      assertCurrentVerificationPlanForEffect(internalStage.plan, 'while export effects were committing; the export transaction was rolled back');
      for (const replacement of replacements) {
        try { commitDirectoryReplacement(replacement); } catch {}
      }
    }
  } catch (error) {
    if (internalStage) {
      const rollbackErrors = [];
      for (const replacement of [...replacements].reverse()) {
        try { rollbackDirectoryReplacement(replacement); } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
      }
      if (manifestWritten) {
        try { restoreFileRollbackSnapshot(manifestRollback); } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
      }
      if (rollbackErrors.length > 0) throw new Error(`${error.message}; export rollback failed: ${rollbackErrors.join('; ')}`);
    }
    throw error;
  } finally {
    const cleanupErrors = [];
    try { removeLifecycleTemporaryDirectory(sourceStage); } catch (error) { cleanupErrors.push(error.message); }
    for (const group of groups.values()) {
      try {
        rmSync(group.stagedDirectory, { recursive: true, force: true });
        if (existsSync(group.stagedDirectory)) throw new Error('path still exists');
        lifecycleRegistryEvent('resource_remove', group.stagedDirectory);
      } catch (error) { cleanupErrors.push(`Cannot remove export staging directory ${group.stagedDirectory}: ${error.message}`); }
    }
    try {
      if (existsSync(exportStagingRoot) && readdirSync(exportStagingRoot).length === 0) rmSync(exportStagingRoot, { recursive: true });
    } catch (error) { cleanupErrors.push(`Cannot remove export staging root ${exportStagingRoot}: ${error.message}`); }
    if (cleanupErrors.length > 0) throw new ResultClassificationError('cleanup_timeout', cleanupErrors.join('; '), 'process_result');
  }
  return lifecycleStatus || (timedOut ? 124 : failed || artifacts.length !== requested.length ? 1 : 0);
}

async function gitRoot(project, options = {}) {
  const result = await runProcess('git', ['-C', project, 'rev-parse', '--show-toplevel'], {
    quiet: true, timeoutMs: timeoutMilliseconds(options), phase: 'git_root',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function sameExistingPath(left, right) {
  try { return realpathSync(resolve(left)) === realpathSync(resolve(right)); }
  catch { return resolve(left) === resolve(right); }
}

function editorSessionPaths(project) {
  const directory = join(project, '.gdeck');
  if (pathContainsSymlink(project, directory)) throw new Error('Editor session directory contains a symbolic link');
  if (!existsSync(directory)) return [];
  const paths = readdirSync(directory)
    .filter((name) => /^editor-session(?:-[0-9a-f]{32})?\.json$/.test(name))
    .sort()
    .map((name) => join(directory, name));
  if (paths.length > 128) throw new Error('Editor session inventory exceeds the safe limit of 128 files');
  return paths;
}

function inspectEditorSessionMetadata(project, path) {
  const base = { path, file: basename(path), fingerprint: { kind: 'unsafe' } };
  if (pathContainsSymlink(project, path)) {
    return { ...base, state: 'unsafe-preserved', detail: `${basename(path)} contains a symbolic link` };
  }
  const fingerprint = fileFingerprint(path);
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size > 16 * 1024) throw new Error('session metadata is not a bounded file');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof data.project !== 'string' || data.project.length === 0) throw new Error('session project is missing');
    const sessionProject = resolve(data.project);
    const host = String(data.host ?? '').toLowerCase();
    const port = Number(data.port);
    if (!sameExistingPath(sessionProject, project)) throw new Error(`session belongs to another project: ${data.project ?? '(unknown)'}`);
    if (data.schema_version !== 1) throw new Error(`unsupported session schema: ${data.schema_version}`);
    if (typeof data.bridge_version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(data.bridge_version)) throw new Error('invalid session bridge version');
    if (host !== '127.0.0.1') throw new Error(`session host must be exactly 127.0.0.1, received ${host}`);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`invalid session port: ${data.port}`);
    if (typeof data.instance_id !== 'string' || !/^[0-9a-f]{32}$/.test(data.instance_id)) throw new Error('invalid session instance id');
    if (!basename(path).includes(data.instance_id)) throw new Error('session filename does not match its instance id');
    if (!Number.isInteger(data.pid) || data.pid <= 0) throw new Error('invalid session process id');
    if (typeof data.started_unix !== 'number' || !Number.isFinite(data.started_unix) || data.started_unix <= 0 || data.started_unix > Date.now() / 1000 + 300) throw new Error('invalid session start time');
    let state = 'metadata-live';
    try {
      process.kill(data.pid, 0);
    } catch (probeError) {
      if (probeError?.code === 'ESRCH') state = 'stale-dead';
      else if (probeError?.code !== 'EPERM') throw new Error(`cannot determine session process state: ${probeError?.code ?? probeError?.message}`);
    }
    return {
      ...base,
      fingerprint,
      state,
      detail: state === 'stale-dead'
        ? `session process is not running: ${data.pid}`
        : `instance ${data.instance_id.slice(0, 12)} on ${host}:${port}, version ${data.bridge_version}`,
      data: { ...data, host, port },
    };
  } catch (error) {
    return { ...base, fingerprint, state: 'invalid-preserved', detail: `${basename(path)} is invalid and was preserved: ${error.message}` };
  }
}

function editorSessionInventory(project) {
  return editorSessionPaths(project).map((path) => inspectEditorSessionMetadata(project, path));
}

function publicEditorSession(item) {
  return {
    file: item.file,
    state: item.state,
    detail: item.detail,
    instanceId: item.data?.instance_id,
    pid: item.data?.pid,
    host: item.data?.host,
    port: item.data?.port,
    bridgeVersion: item.data?.bridge_version,
    startedUnix: item.data?.started_unix,
  };
}

async function inspectEditorSessions(project) {
  const inventory = editorSessionInventory(project);
  const tokenPath = join(project, '.gdeck', 'editor-token');
  const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
  await Promise.all(inventory.filter((item) => item.state === 'metadata-live').map(async (item) => {
    if (!token) {
      item.state = 'live-unreachable';
      item.detail += '; Editor token is missing';
      return;
    }
    try {
      const response = await requestEditorBridge({
        host: item.data.host,
        port: item.data.port,
        token,
        expectedInstanceId: item.data.instance_id,
        action: 'status',
        params: {},
      });
      const problem = bridgeHandshakeProblem(response, project, true, item.data);
      if (problem) {
        item.state = 'live-unreachable';
        item.detail += `; ${problem}`;
      } else {
        item.state = 'authenticated-live';
        item.detail += '; authenticated and reachable';
      }
    } catch (error) {
      item.state = 'live-unreachable';
      item.detail += `; ${error.message}`;
    }
  }));
  return { project, sessions: inventory.map(publicEditorSession) };
}

function cleanupEditorSessions(project) {
  const inventory = editorSessionInventory(project);
  const removed = [];
  for (const item of inventory) {
    if (item.state !== 'stale-dead') continue;
    if (pathContainsSymlink(project, item.path)) continue;
    const refreshed = inspectEditorSessionMetadata(project, item.path);
    if (refreshed.state !== 'stale-dead' || !sameFingerprint(refreshed.fingerprint, item.fingerprint)) continue;
    rmSync(item.path, { force: true });
    syncDirectoryBestEffort(dirname(item.path));
    removed.push(publicEditorSession(refreshed));
  }
  return {
    project,
    removed,
    preserved: inventory.filter((item) => !removed.some((candidate) => candidate.file === item.file)).map(publicEditorSession),
  };
}

function readEditorSession(project) {
  const directory = join(project, '.gdeck');
  let results;
  try { results = editorSessionInventory(project); }
  catch (error) { return { path: directory, status: 'invalid', detail: error.message }; }
  if (results.length === 0) return { path: directory, status: 'missing', detail: 'No Editor session metadata; the Editor may be closed or require a restart' };
  const valid = results.filter((result) => result.state === 'metadata-live');
  if (valid.length === 1) {
    const ignoredCount = results.length - 1;
    return {
      path: valid[0].path,
      status: 'valid',
      data: valid[0].data,
      detail: `${valid[0].detail}${ignoredCount ? `; ${ignoredCount} non-live session file(s) preserved` : ''}`,
    };
  }
  if (valid.length > 1) return { path: directory, status: 'ambiguous', detail: `${valid.length} live Editor sessions found; close all but one before Bridge operations` };
  return { path: directory, status: 'invalid', detail: results.map((result) => result.detail).join('; ') };
}

function editorEndpoint(project, bridgeConfig) {
  const session = readEditorSession(project);
  if (session.status === 'valid') return { host: session.data.host, port: session.data.port, session };
  return {
    host: String(bridgeConfig.host ?? '127.0.0.1').toLowerCase(),
    port: Number(bridgeConfig.port ?? 47835),
    session,
  };
}

function regularFileWithoutSymlink(path, maximumBytes = Infinity) {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= maximumBytes;
  } catch {
    return false;
  }
}

function managedRuntimeProbeInstalled(sourceProject) {
  try {
    const installed = join(sourceProject, 'addons', 'flight_deck', 'runtime_probe.gd');
    const expected = join(ADDON_SOURCE, 'runtime_probe.gd');
    if (!regularFileWithoutSymlink(installed, 4 * 1024 * 1024) || !regularFileWithoutSymlink(expected, 4 * 1024 * 1024)) return false;
    return timingSafeEqual(
      createHash('sha256').update(readFileSync(installed)).digest(),
      createHash('sha256').update(readFileSync(expected)).digest(),
    );
  } catch {
    return false;
  }
}

function exactRuntimeAutoloadInstalled(projectFile) {
  const declarations = [];
  let active = false;
  for (const line of String(projectFile).split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = trimmed.match(/^\[([^\]]+)\]$/);
    if (header) {
      active = header[1] === 'autoload';
      continue;
    }
    if (active && /^FlightDeckProbe\s*=/.test(trimmed)) declarations.push(trimmed);
  }
  return declarations.length === 1 && declarations[0] === 'FlightDeckProbe="*res://addons/flight_deck/runtime_probe.gd"';
}

export async function doctor(projectCandidate, options, internalStage = null) {
  const project = internalStage?.plan.project ?? resolveProject(projectCandidate);
  const sourceProject = verificationExecutionProject(internalStage) ?? project;
  const checks = [];
  const projectConfigPath = configPath(project);
  const configExists = existsSync(projectConfigPath);
  let config = defaultConfig();
  let configError = '';
  if (internalStage?.stage.runtime.config) {
    config = internalStage.stage.runtime.config;
  } else if (configExists) {
    try {
      if (!regularFileWithoutSymlink(projectConfigPath, 1024 * 1024)) throw new Error('configuration must be a regular non-symbolic-link file of at most 1048576 bytes');
      config = loadConfig(project);
    } catch (error) {
      configError = error.message;
    }
  }
  let godot = '';
  let godotVersionProbeRan = false;
  let lifecycleStatus = 0;
  try {
    godot = findGodot(config, options.godot);
    checks.push({ id: 'godot-executable', name: 'Godot executable', status: 'ok', detail: godot });
  } catch (error) {
    if ([124, 125, 127].includes(error.exitCode)) lifecycleStatus = error.exitCode;
    checks.push({ id: 'godot-executable', name: 'Godot executable', status: 'error', detail: error.message });
  }
  if (godot) {
    try {
      godotVersionProbeRan = true;
      checks.push({ id: 'godot-version', name: 'Godot version', status: 'ok', detail: await godotVersion(godot, options) });
    } catch (error) {
      if ([124, 125, 127].includes(error.exitCode)) lifecycleStatus = error.exitCode;
      checks.push({ id: 'godot-version', name: 'Godot version', status: 'error', detail: error.message });
    }
  } else {
    checks.push({ id: 'godot-version', name: 'Godot version', status: 'warn', detail: 'Not probed because the Godot executable is unavailable' });
  }
  checks.push({
    id: 'flight-deck-config',
    name: 'Flight Deck config',
    status: configError ? 'error' : configExists ? 'ok' : 'warn',
    detail: configError || (configExists ? projectConfigPath : 'Run gdeck init'),
  });
  const projectFilePath = join(sourceProject, 'project.godot');
  let projectFile = '';
  let projectFileError = '';
  try {
    if (!regularFileWithoutSymlink(projectFilePath, 4 * 1024 * 1024)) throw new Error('project.godot must be a regular non-symbolic-link file of at most 4194304 bytes');
    projectFile = readFileSync(projectFilePath, 'utf8');
    if (!/^config_version\s*=\s*\d+\s*$/m.test(projectFile)) throw new Error('project.godot is missing a valid config_version declaration');
  } catch (error) {
    projectFileError = error.message;
  }
  checks.push({
    id: 'project-file',
    name: 'Project file',
    status: projectFileError ? 'error' : 'ok',
    detail: projectFileError || projectFilePath,
  });
  const runtimeProbeInstalled = managedRuntimeProbeInstalled(sourceProject);
  checks.push({
    id: 'runtime-probe',
    name: 'Runtime probe',
    status: runtimeProbeInstalled ? 'ok' : 'error',
    detail: runtimeProbeInstalled ? 'managed runtime probe matches this Flight Deck build' : 'Run gdeck init to install the managed runtime probe',
  });
  const runtimeAutoloadInstalled = !projectFileError && exactRuntimeAutoloadInstalled(projectFile);
  checks.push({
    id: 'runtime-autoload',
    name: 'Runtime autoload',
    status: runtimeAutoloadInstalled ? 'ok' : 'error',
    detail: runtimeAutoloadInstalled ? 'FlightDeckProbe uses the managed runtime path in [autoload]' : projectFileError || 'Run gdeck init to install the exact active FlightDeckProbe autoload',
  });
  const bridgeToken = join(project, '.gdeck', 'editor-token');
  const bridgeConfig = config.editorBridge ?? {};
  const editorIntegrationRequired = internalStage === null;
  const bridgeScriptInstalled = regularFileWithoutSymlink(join(sourceProject, 'addons', 'flight_deck', 'editor_bridge.gd'), 4 * 1024 * 1024);
  const editorPluginEnabled = !projectFileError && projectFile.includes('res://addons/flight_deck/plugin.cfg');
  const tokenInstalled = regularFileWithoutSymlink(bridgeToken, 64 * 1024);
  const endpoint = editorIntegrationRequired ? editorEndpoint(project, bridgeConfig) : {
    host: String(bridgeConfig.host ?? '127.0.0.1').toLowerCase(),
    port: Number(bridgeConfig.port ?? 47835),
    session: { status: 'not_selected', detail: 'Optional Editor integration was not selected by this verification stage' },
  };
  const bridgeHost = endpoint.host;
  const bridgePort = endpoint.port;
  checks.push({
    id: 'editor-bridge-addon',
    name: 'Editor bridge addon',
    status: bridgeScriptInstalled ? 'ok' : editorIntegrationRequired ? 'error' : 'warn',
    detail: bridgeScriptInstalled ? 'installed' : 'Run gdeck init',
  });
  checks.push({
    id: 'editor-plugin-enabled',
    name: 'Editor plugin enabled',
    status: editorPluginEnabled ? 'ok' : editorIntegrationRequired ? 'error' : 'warn',
    detail: editorPluginEnabled ? 'res://addons/flight_deck/plugin.cfg' : 'Run gdeck init, or enable Godot Flight Deck under Project Settings > Plugins',
  });
  checks.push({
    id: 'editor-auth-token',
    name: 'Editor auth token',
    status: tokenInstalled ? 'ok' : editorIntegrationRequired ? 'error' : 'warn',
    detail: tokenInstalled ? bridgeToken : 'Run gdeck init',
  });
  const editorWritesAllowed = bridgeConfig.allowWrites === true;
  const editorSupplementary = bridgeConfig.supplementaryEnabled === true;
  checks.push({
    id: 'editor-write-policy',
    name: 'Editor write policy',
    status: editorWritesAllowed ? 'ok' : 'warn',
    detail: `allowWrites=${editorWritesAllowed ? 'true' : 'false'}; supplementaryEnabled=${editorSupplementary ? 'true' : 'false'}; destructive requires --apply`,
  });
  checks.push({
    id: 'editor-bridge-session',
    name: 'Editor bridge session',
    status: endpoint.session.status === 'valid' && endpoint.session.data.bridge_version === TOOL_VERSION ? 'ok' : 'warn',
    detail: endpoint.session.status === 'valid' && endpoint.session.data.bridge_version !== TOOL_VERSION
      ? `${endpoint.session.detail}; installed CLI is ${TOOL_VERSION}`
      : endpoint.session.detail,
  });
  let editorBridgeProbeRan = false;
  let bridgeAvailability = {
    id: 'editor-bridge-availability',
    name: 'Editor bridge availability',
    status: 'warn',
    detail: 'Bridge not probed because installation prerequisites are incomplete',
  };
  if (!editorIntegrationRequired) {
    bridgeAvailability = {
      id: 'editor-bridge-availability',
      name: 'Editor bridge availability',
      status: 'warn',
      detail: 'Optional Editor integration was not selected; no Bridge connection was attempted',
    };
  } else if (configError) {
    bridgeAvailability = {
      id: 'editor-bridge-availability',
      name: 'Editor bridge availability',
      status: 'warn',
      detail: 'Bridge not probed because Flight Deck configuration is invalid',
    };
  } else if (bridgeHost !== '127.0.0.1') {
    bridgeAvailability = {
      id: 'editor-bridge-availability',
      name: 'Editor bridge availability',
      status: 'error',
      detail: `Bridge host must be exactly 127.0.0.1, received ${bridgeHost}`,
    };
  } else if (!Number.isInteger(bridgePort) || bridgePort < 1024 || bridgePort > 65535) {
    bridgeAvailability = {
      id: 'editor-bridge-availability',
      name: 'Editor bridge availability',
      status: 'error',
      detail: `Invalid Editor Bridge port: ${bridgePort}`,
    };
  } else if (bridgeScriptInstalled && editorPluginEnabled && tokenInstalled) {
    try {
      editorBridgeProbeRan = true;
      const response = await requestEditorBridge({
        host: bridgeHost,
        port: bridgePort,
        token: readFileSync(bridgeToken, 'utf8').trim(),
        action: 'status',
        params: {},
      });
      const connectedProjectValue = String(response.result?.project ?? '');
      const connectedProject = response.ok && connectedProjectValue ? resolve(connectedProjectValue) : '';
      const bridgeVersion = String(response.version ?? response.result?.flight_deck_version ?? 'unknown');
      const expectedSession = endpoint.session.status === 'valid' ? endpoint.session.data : null;
      const expectedInstanceId = expectedSession ? String(expectedSession.instance_id) : '';
      const instanceMatches = expectedSession
        && String(response.result?.instance_id ?? '') === expectedInstanceId
        && Number(response.result?.pid) === Number(expectedSession.pid)
        && Number(response.result?.started_unix) === Number(expectedSession.started_unix);
      bridgeAvailability = response.ok && sameExistingPath(connectedProject, project) && bridgeVersion === TOOL_VERSION && instanceMatches
        ? { id: 'editor-bridge-availability', name: 'Editor bridge availability', status: 'ok', detail: `connected at ${bridgeHost}:${bridgePort}, version ${bridgeVersion}, instance ${expectedInstanceId.slice(0, 12)}` }
        : response.ok && sameExistingPath(connectedProject, project) && bridgeVersion === TOOL_VERSION
          ? { id: 'editor-bridge-availability', name: 'Editor bridge availability', status: 'warn', detail: 'Bridge responded, but its instance does not match valid live session metadata. Restart the Editor before writing.' }
          : response.ok && sameExistingPath(connectedProject, project)
            ? { id: 'editor-bridge-availability', name: 'Editor bridge availability', status: 'warn', detail: `Bridge version mismatch: CLI ${TOOL_VERSION}, Editor ${bridgeVersion}. Restart the Editor before any write operation.` }
            : response.ok
              ? { id: 'editor-bridge-availability', name: 'Editor bridge availability', status: 'warn', detail: `Bridge belongs to another project: ${response.result?.project ?? '(unknown)'}. Open this project in Godot Editor or use its session endpoint.` }
              : { id: 'editor-bridge-availability', name: 'Editor bridge availability', status: 'warn', detail: `Bridge rejected authentication (${response.error ?? 'unknown'}, version ${bridgeVersion}). The port may belong to another project, or the running Editor may have an old token.` };
    } catch (error) {
      bridgeAvailability = {
        id: 'editor-bridge-availability',
        name: 'Editor bridge availability',
        status: 'warn',
        detail: `Bridge unavailable at ${bridgeHost}:${bridgePort}: ${error.message}. If gdeck init ran while the Editor was open, restart it; otherwise enable Godot Flight Deck under Project Settings > Plugins.`,
      };
    }
  }
  checks.push(bridgeAvailability);
  let templates = [];
  let templateError = '';
  try { templates = templateDirectories(); }
  catch (error) { templateError = error.message; }
  checks.push({
    id: 'export-templates',
    name: 'Export templates',
    status: templateError ? 'error' : templates.length > 0 ? 'ok' : 'warn',
    detail: templateError || (templates.length > 0 ? templates.join(', ') : 'No templates installed'),
  });
  const root = await gitRoot(project, options);
  checks.push({
    id: 'git-repository',
    name: 'Git repository',
    status: root ? 'ok' : 'warn',
    detail: root || 'Not initialized',
  });
  checks.push({ id: 'project-root', name: 'Project', status: 'ok', detail: project });
  checks.push({
    id: 'cursor-compat-mode',
    name: 'Agent-shell compat mode',
    status: 'ok',
    detail: cursorCompatEnabled()
      ? 'enabled (in-process CLI; nested Job supervisors skipped; GDECK_CURSOR_COMPAT or GDECK_CODEX_DIRECT)'
      : 'disabled (nested process-runner supervision active; set GDECK_CURSOR_COMPAT=1 or GDECK_CODEX_DIRECT=1)',
  });
  const addonPluginPath = join(sourceProject, 'addons', 'flight_deck', 'plugin.cfg');
  let installedAddonVersion = '';
  if (existsSync(addonPluginPath)) {
    try {
      installedAddonVersion = String(readFileSync(addonPluginPath, 'utf8').match(/^version="([^"]+)"/m)?.[1] ?? '');
    } catch { installedAddonVersion = ''; }
  }
  const addonFingerprintMatch = managedRuntimeProbeInstalled(sourceProject);
  const addonVersionMatch = Boolean(installedAddonVersion) && installedAddonVersion === TOOL_VERSION && addonFingerprintMatch;
  checks.push({
    id: 'addon-version-match',
    name: 'Addon version match',
    status: !existsSync(join(sourceProject, 'addons', 'flight_deck'))
      ? 'warn'
      : addonVersionMatch ? 'ok' : 'error',
    detail: !existsSync(join(sourceProject, 'addons', 'flight_deck'))
      ? 'Addon not installed; run gdeck init or gdeck sync-addon'
      : addonVersionMatch
        ? `${installedAddonVersion} matches CLI ${TOOL_VERSION}`
        : `Project addon ${installedAddonVersion || 'unknown'} does not match CLI ${TOOL_VERSION}${addonFingerprintMatch ? '' : ' (fingerprint drift)'}; run gdeck sync-addon`,
  });

  const relevance = internalStage ? capabilityRelevanceForPlan(internalStage.plan) : null;
  const capabilities = assessDoctorCapabilities(checks, {
    probes: { godotVersion: godotVersionProbeRan, editorBridge: editorBridgeProbeRan },
  }).map((capability) => relevance ? { ...capability, relevance: relevance[capability.id] } : capability);

  if (options.json) {
    console.log(JSON.stringify({
      toolVersion: TOOL_VERSION,
      project,
      capabilitySchemaVersion: 1,
      probes: { godotVersion: godotVersionProbeRan, editorBridge: editorBridgeProbeRan },
      checks,
      capabilities,
    }, null, 2));
  } else {
    console.log(`Godot Flight Deck ${TOOL_VERSION}\n`);
    for (const check of checks) {
      const marker = check.status === 'ok' ? color.green('✓') : check.status === 'warn' ? color.yellow('!') : color.red('✗');
      console.log(`${marker} ${check.name.padEnd(20)} ${check.detail}`);
    }
    console.log('\nCapabilities');
    for (const capability of capabilities) {
      const marker = capability.status === 'available' ? color.green('✓')
        : capability.status === 'degraded' ? color.yellow('!')
          : capability.status === 'unavailable' ? color.red('✗') : color.muted('?');
      const relevanceLabel = capability.relevance ? ` / ${capability.relevance}` : '';
      console.log(`${marker} ${capability.name.padEnd(26)} ${capability.status}${relevanceLabel}: ${capability.summary}`);
    }
  }
  return lifecycleStatus || (checks.some((check) => check.status === 'error') ? 1 : 0);
}

async function checkScriptFile(project, godot, file, options) {
  const target = resolve(project, file);
  if (!pathIsInside(project, target)) throw new Error(`check --file must be inside the project: ${file}`);
  if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`check --file does not exist: ${file}`);
  if (!target.toLowerCase().endsWith('.gd')) throw new Error(`check --file must be a .gd script: ${file}`);
  const runner = join(TOOL_ROOT, 'godot', 'check_script_runner.gd');
  if (!existsSync(runner)) throw new Error(`check script runner missing: ${runner}`);
  console.log(color.muted(`Checking ${target}`));
  const result = await runProcess(godot, ['--headless', '--path', project, '-s', runner, '--', target], {
    cwd: project, timeoutMs: timeoutMilliseconds(options), phase: 'check-file',
  });
  const failed = result.status !== 0 || ERROR_PATTERN.test(result.output);
  if (failed) {
    console.log(color.red('Flight Deck check failed'));
    const lines = result.output.split(/\r?\n/);
    const digest = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (ERROR_PATTERN.test(lines[index])) {
        digest.push(lines[index].trim());
        if (lines[index + 1]?.includes('at: GDScript::reload')) digest.push(lines[index + 1].trim());
      }
    }
    if (digest.length) console.log(digest.join('\n'));
  } else {
    console.log(color.green('Flight Deck check passed'));
  }
  return failed ? 1 : 0;
}

async function checkProject(projectCandidate, options, internalStage = null) {
  const project = internalStage?.plan.project ?? resolveProject(projectCandidate);
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const config = internalStage ? { godotPath: internalStage.stage.runtime.godotPath } : loadConfig(project);
  const godot = findGodot(config, options.godot);
  if (options.file) return await checkScriptFile(executionProject, godot, options.file, options);
  console.log(color.muted(`Checking ${project}`));
  const result = await runProcess(godot, ['--headless', '--path', executionProject, '--editor', '--quit'], {
    cwd: executionProject, timeoutMs: timeoutMilliseconds(options), phase: 'check',
  });
  const failed = result.status !== 0 || ERROR_PATTERN.test(result.output);
  console.log(failed ? color.red('Flight Deck check failed') : color.green('Flight Deck check passed'));
  return failed ? processStatusOr(result) : 0;
}

function resolveRunQuery(options) {
  if (options.query && options['query-file']) throw new Error('Use either --query or --query-file, not both');
  let raw = '';
  if (options.query) raw = String(options.query);
  if (options['query-file']) {
    const file = resolve(options['query-file']);
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`--query-file does not exist: ${file}`);
    raw = readFileSync(file, 'utf8');
  }
  if (!raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--query must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('--query must be a JSON array of query definitions');
  const allowedTypes = new Set(['property', 'tree', 'signals', 'group']);
  const definitions = parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`--query[${index}] must be an object`);
    const type = String(entry.type ?? '');
    if (!allowedTypes.has(type)) throw new Error(`--query[${index}] type must be property/tree/signals/group, got: ${type}`);
    return { ...entry, type, id: String(entry.id ?? `query-${index + 1}`) };
  });
  return definitions;
}

function printQueryResults(reportPath, options) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const queries = report?.queries;
  if (!queries) {
    console.log(color.yellow('No query results in report (query flag was not forwarded to the probe).'));
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(queries, null, 2));
    return;
  }
  console.log(color.green('Query results'));
  console.log(`  seed: ${queries.seed}  frames: ${queries.frames}  count: ${queries.count}`);
  for (const result of queries.results ?? []) {
    const marker = result.ok ? color.green('ok') : color.red('failed');
    console.log(`  [${result.id}] ${result.type} ${marker}`);
    const payload = result.ok ? result.result : { error: result.error };
    console.log(`    ${JSON.stringify(payload)?.slice(0, 600)}`);
  }
}

async function runProject(projectCandidate, options, passthrough) {
  const reserved = passthrough.find((argument) => typeof argument === 'string' && argument.startsWith('--gdeck-'));
  if (reserved) throw new Error(`Game passthrough arguments use the reserved --gdeck- namespace: ${reserved}`);
  const project = resolveProject(projectCandidate);
  const config = loadConfig(project);
  const godot = findGodot(config, options.godot);
  const query = resolveRunQuery(options);
  if (options.watch && query) throw new Error('--watch and --query are mutually exclusive');
  if (options.watch) {
    return runProjectWatched(godot, project, options, passthrough);
  }  if (query) {
    const frames = Number(options.frames ?? 30);
    const seedValue = Number(options.seed ?? 42);
    const report = join(project, '.gdeck', 'reports', `query-${timestamp()}.json`);
    mkdirSync(dirname(report), { recursive: true });
    const userArgs = [
      `--gdeck-query=${JSON.stringify(query)}`,
      `--gdeck-report=${report}`,
      `--gdeck-after-frames=${frames}`,
      `--gdeck-seed=${seedValue}`,
      ...passthrough,
    ];
    console.log(color.muted(`Observing ${project} for ${frames} frames (seed ${seedValue})`));
    const result = await runProcess(godot, withRuntimeClockMetadata(['--path', project, '--', ...userArgs]), {
      cwd: project,
      timeoutMs: timeoutMilliseconds(options),
      phase: 'run-query',
    });
    const failed = result.status !== 0 || ERROR_PATTERN.test(result.output);
    if (failed && !existsSync(report)) {
      console.error(color.red('Query run failed before the report was written'));
      return processStatusOr(result);
    }
    printQueryResults(report, options);
    return failed ? processStatusOr(result) : 0;
  }
  const result = await runProcess(godot, ['--path', project, ...(passthrough.length ? ['--', ...passthrough] : [])], {
    cwd: project,
    timeoutMs: timeoutMilliseconds(options),
    phase: 'run',
  });
  return result.status;
}

async function runProjectWatched(godot, project, options, passthrough) {
  const godotArgs = ['--path', project];
  if (options['main-scene']) {
    if (!options['main-scene'].startsWith('res://')) throw new Error('--main-scene must be a res:// path');
    godotArgs.push('--main-scene', options['main-scene']);
  }
  const output = watchOutput((stream, line) => {
    if (line) console.log(`[gdeck:${stream === 'stdout' ? 'out' : 'err'}] ${line}`);
  });
  const result = await runProcess(godot, [...godotArgs, ...(passthrough.length ? ['--', ...passthrough] : [])], {
    cwd: project, timeoutMs: timeoutMilliseconds(options), phase: 'watch', quiet: true,
    onOutput: (stream, chunk) => output.write(stream, chunk),
  });
  const errors = output.finish();
  // Window completion is expected; cleanup/cancellation failures remain failures.
  if (result.cleanupTimedOut || result.cancelled || result.status === 127) return result.status;
  if (errors) return 1;
  return result.timedOut ? 0 : result.status;
}

// Oracle chain: the Godot-side cross-client verification scripts from the
// repository's `npm run check` chain, plus the reference baseline check.
// Kept in sync with package.json scripts.check; Web-side steps (npm test,
// build) are intentionally outside the Godot-focused oracle command.
const ORACLE_CHAIN_SCRIPTS = [
  'godot:program-check',
  'godot:domain-data:check',
  'godot:parity-regression:verify',
  'godot:full-loop:verify',
  'godot:migration-check',
  'godot:project:verify',
  'godot:application-session:verify',
  'godot:tactical-battle:verify',
  'godot:tactical-movement:verify',
  'godot:tactical-attack:verify',
  'godot:tactical-skill:verify',
  'godot:tactical-ai:verify',
  'godot:tactical-outcome:verify',
  'godot:tactical-settlement:verify',
  'godot:production-save:verify',
  'godot:campaign-entry:verify',
  'godot:campaign-setup:presentation',
  'godot:tactical-presentation:verify',
  'reference:check',
];

function oracleVerify(projectCandidate, options) {
  const project = resolveProject(projectCandidate);
  let packageFile = join(project, 'package.json');
  let dir = project;
  while (!existsSync(packageFile)) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`oracle-verify requires the repository package.json (searched from ${project})`);
    dir = parent;
    packageFile = join(dir, 'package.json');
  }
  const repoRoot = dirname(packageFile);
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const perScriptTimeoutMs = timeoutMilliseconds(options);
  const started = Date.now();
  const results = [];
  let failed = 0;
  for (const script of ORACLE_CHAIN_SCRIPTS) {
    const scriptStarted = Date.now();
    let status;
    let durationMs;
    try {
      const npmResult = spawnSync(npmCommand, ['run', script, '--silent'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: perScriptTimeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        shell: true,
      });
      const timedOut = npmResult.error?.code === 'ETIMEDOUT';
      status = !timedOut && npmResult.status === 0 ? 'passed' : 'failed';
      durationMs = Date.now() - scriptStarted;
      if (status !== 'passed') failed += 1;
      if (timedOut) console.error(color.red(`  ${script}: timed out after ${perScriptTimeoutMs}ms`));
      else if (npmResult.status !== 0 && !options.quiet) {
        const tail = String(npmResult.stdout ?? '').split(/\r?\n/).filter((line) => line.trim()).slice(-4).join('\n');
        if (tail) console.error(color.muted(`    ${tail.slice(0, 600)}`));
      }
    } catch (error) {
      status = 'failed';
      durationMs = Date.now() - scriptStarted;
      failed += 1;
      if (error.message) console.error(color.red(`  ${script}: ${error.message.slice(0, 300)}`));
    }
    results.push({ script, status, durationMs });
    const marker = status === 'passed' ? color.green('passed') : color.red('failed');
    console.log(`  ${marker.padEnd(7)} ${script.padEnd(38)} ${(durationMs / 1000).toFixed(1)}s`);
  }
  const totalMs = Date.now() - started;
  const report = {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    project,
    chain: 'npm run check (Godot side + reference)',
    totalSeconds: totalMs / 1000,
    passed: results.filter((item) => item.status === 'passed').length,
    failed,
    results,
  };
  const reportPath = join(project, '.gdeck', 'reports', `oracle-${timestamp()}.json`);
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch { /* report write is best-effort */ }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Oracle chain: ${report.passed} passed, ${report.failed} failed, ${(totalMs / 1000).toFixed(1)}s`);
    console.log(`  Report: ${reportPath}`);
  }
  return failed > 0 ? 1 : 0;
}

const SCENE_RESOURCE_TYPES = new Map([
  ['Script', ['.gd']],
  ['Texture2D', ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.svg']],
  ['Theme', ['.tres', '.res']],
  ['VideoStream', ['.ogv', '.webm', '.mp4']],
  ['AudioStream', ['.ogg', '.mp3', '.wav']],
  ['Shader', ['.gdshader']],
  ['FontFile', ['.ttf', '.otf', '.woff', '.woff2']],
  ['PackedScene', ['.tscn', '.scn']],
]);

async function sceneSet(positional, options, internalStage = null) {
  const project = internalStage?.plan.project ?? (positional[5] ? resolveProject(positional[5]) : resolveProject());
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const config = internalStage ? { godotPath: internalStage.stage.runtime.godotPath } : loadConfig(project);
  const godot = findGodot(config, options.godot);
  const sceneArg = positional[1];
  const nodePath = positional[2] ?? '.';
  const property = positional[3];
  const jsonValue = positional[4];
  if (!sceneArg || !property || jsonValue === undefined) {
    throw new Error('scene set requires <scene> <node-path> <property> <json-value>');
  }
  const scenePath = sceneArg.startsWith('res://') ? sceneArg : `res://${sceneArg.replaceAll('\\', '/')}`;
  const sceneFile = resolve(project, scenePath.slice('res://'.length));
  if (!pathIsInside(project, sceneFile) || !existsSync(sceneFile) || !statSync(sceneFile).isFile()) {
    throw new Error(`scene set: scene not found inside project: ${sceneArg}`);
  }
  if (!scenePath.endsWith('.tscn')) throw new Error(`scene set: target must be a .tscn: ${sceneArg}`);
  try {
    JSON.parse(jsonValue);
  } catch (error) {
    throw new Error(`scene set: value must be valid JSON: ${error.message}`);
  }
  const mode = options.apply ? 'apply' : 'dry';
  let snapshot = '';
  if (mode === 'apply') {
    const snapshotsRoot = join(project, '.gdeck', 'snapshots');
    mkdirSync(snapshotsRoot, { recursive: true });
    const sceneRelative = relative(join(project, 'scenes'), sceneFile).replaceAll('\\', '/').replaceAll('/', '__');
    snapshot = join(snapshotsRoot, `${sceneRelative.replace('.tscn', '')}-${timestamp()}.tscn`);
    cpSync(sceneFile, snapshot);
    console.log(color.muted(`Snapshot: ${snapshot}`));
  }
  const runner = join(TOOL_ROOT, 'godot', 'scene_edit_runner.gd');
  const result = await runProcess(godot, ['--headless', '--path', executionProject, '-s', runner, '--', scenePath, nodePath, property, jsonValue, mode], {
    cwd: executionProject, timeoutMs: timeoutMilliseconds(options), phase: 'scene-set',
  });
  const failed = result.status !== 0 || ERROR_PATTERN.test(result.output);
  const preview = result.output.split(/\r?\n/).find((line) => line.startsWith('EDIT_PREVIEW')) ?? '';
  if (preview) {
    console.log(color.muted(preview.replace('EDIT_PREVIEW ', 'Preview: ')));
  }
  if (failed) {
    console.error(color.red(`scene set ${mode} failed`));
    if (snapshot) console.error(color.yellow(`  Restore with: gdeck scene restore ${snapshot} --apply`));
    return 1;
  }
  if (mode === 'apply') {
    console.log(color.green(`Applied ${property}=${jsonValue} to ${scenePath}`));
    console.log(color.muted('  Note: ResourceSaver rewrites the whole scene (canonical Godot style); expected.'));
    const doctorResult = await sceneDoctor(['doctor', project], { ...options, json: false });
    if (doctorResult !== 0) {
      console.error(color.yellow(`  scene doctor found broken scenes after edit; restore with: gdeck scene restore ${snapshot} --apply`));
    }
    return doctorResult;
  }
  console.log(color.yellow('Dry-run: nothing written. Re-run with --apply to commit.'));
  return 0;
}

function sceneRestore(positional, options, internalStage = null) {
  const project = internalStage?.plan.project ?? (positional[2] ? resolveProject(positional[2]) : resolveProject());
  const snapshotArg = positional[1];
  if (!snapshotArg) throw new Error('scene restore requires <snapshot-path>');
  const snapshotCandidates = [
    resolve(project, '.gdeck', 'snapshots', snapshotArg),
    resolve(project, snapshotArg),
  ];
  const snapshot = snapshotCandidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!snapshot || !pathIsInside(project, snapshot)) {
    throw new Error(`scene restore: snapshot not found inside project: ${snapshotArg}`);
  }
  const sceneFile = resolve(project, 'scenes', `${basename(snapshot, '.tscn').replace(/-\d{4}-\d{2}-\d{2}T[\d-]+Z$/, '').replaceAll('__', '/')}.tscn`);
  const scenePath = `res://${relative(project, sceneFile).replaceAll('\\', '/')}`;
  if (!existsSync(sceneFile)) throw new Error(`scene restore: cannot derive scene path from snapshot: ${snapshotArg}`);
  if (!options.apply) {
    console.log(color.muted(`Would restore ${scenePath} from ${snapshot}`));
    console.log(color.yellow('Dry-run: nothing written. Re-run with --apply to commit.'));
    return 0;
  }
  cpSync(snapshot, sceneFile);
  console.log(color.green(`Restored ${scenePath} from snapshot`));
  return 0;
}

async function sceneDoctor(positional, options, internalStage = null) {
  const project = internalStage?.plan.project ?? (positional[1] ? resolveProject(positional[1]) : resolveProject());
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const config = internalStage ? { godotPath: internalStage.stage.runtime.godotPath } : loadConfig(project);
  const godot = findGodot(config, options.godot);
  const sceneRoot = join(project, 'scenes');
  if (!existsSync(sceneRoot) || !statSync(sceneRoot).isDirectory()) {
    throw new Error(`No scenes directory under project: ${sceneRoot}`);
  }
  const findings = [];
  const files = collectSceneFiles(sceneRoot);
  const started = Date.now();
  for (const file of files) {
    scanSceneFile(file, project, findings);
  }
  const staticDurationMs = Date.now() - started;
  const report = await runProcess(godot, ['--headless', '--path', executionProject, '-s', join(TOOL_ROOT, 'godot', 'scene_scan_runner.gd'), '--', 'res://scenes'], {
    cwd: executionProject, timeoutMs: timeoutMilliseconds(options), phase: 'scene-doctor',
  });
  const loadFindings = parseSceneScanOutput(report.output);
  for (const loadFinding of loadFindings) {
    const alreadyReported = findings.some((item) => item.severity === loadFinding.severity && item.file === loadFinding.file);
    if (!alreadyReported) findings.push(loadFinding);
  }
  const broken = findings.filter((item) => item.severity === 'broken');
  const warnings = findings.filter((item) => item.severity === 'warning');
  const result = {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    project,
    scanned: files.length,
    broken: broken.length,
    warnings: warnings.length,
    staticDurationMs,
    loadDurationMs: report.durationMs ?? null,
    findings,
  };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(color.muted(`Scene doctor: ${files.length} scenes under res://scenes`));
    for (const finding of findings) {
      const marker = finding.severity === 'broken' ? color.red('broken') : finding.severity === 'warning' ? color.yellow('warn') : color.green('ok');
      console.log(`  ${marker.padEnd(7)} ${finding.file}${finding.detail ? ` — ${finding.detail}` : ''}`);
    }
    console.log(broken.length || warnings.length
      ? `${broken.length} broken, ${warnings.length} warnings`
      : color.green(`All ${files.length} scenes OK`));
  }
  return broken.length ? 1 : 0;
}

function collectSceneFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith('.tscn')) files.push(full);
    }
  }
  return files.sort();
}

function scanSceneFile(file, project, findings) {
  const relativePath = `res://${relative(project, file).replaceAll('\\', '/')}`;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const subResourceIds = new Set();
  const nodePaths = new Set();
  let extResources = 0;
  let subResources = 0;
  let loadSteps = 0;
  for (const line of lines) {
    const ext = line.match(/^\[ext_resource(?: type="([^"]*)")? path="([^"]+)" id="([^"]+)"\]/);
    if (ext) {
      extResources += 1;
      const [, type, path, id] = ext;
      const target = path.startsWith('res://') ? path.slice('res://'.length) : path;
      const absolute = resolve(project, target);
      if (!path.startsWith('res://') || !existsSync(absolute) || !statSync(absolute).isFile()) {
        findings.push({ severity: 'broken', file: relativePath, detail: `ext_resource ${id} path missing: ${path}` });
      } else if (type && SCENE_RESOURCE_TYPES.has(type)) {
        const allowed = SCENE_RESOURCE_TYPES.get(type);
        const extnameLower = extname(absolute).toLowerCase();
        if (!allowed.includes(extnameLower)) {
          findings.push({ severity: 'warning', file: relativePath, detail: `ext_resource ${id} type ${type} with unexpected extension ${extnameLower}` });
        }
      }
      continue;
    }
    const sub = line.match(/^\[sub_resource type="([^"]*)" id="([^"]*)"\]/);
    if (sub) {
      subResources += 1;
      const [, , id] = sub;
      if (subResourceIds.has(id)) {
        findings.push({ severity: 'broken', file: relativePath, detail: `duplicate sub_resource id ${id}` });
      }
      subResourceIds.add(id);
      continue;
    }
    const node = line.match(/^\[node name="([^"]*)"(?: type="([^"]*)")?(?: parent="([^"]*)")?(?: instance=ExtResource\("([^"]*)"\))?\]/);
    if (node) {
      const [, name, , parent] = node;
      const fullPath = parent && parent !== '.' ? `${parent}/${name}` : name;
      if (parent && parent !== '.' && !nodePaths.has(parent)) {
        findings.push({ severity: 'warning', file: relativePath, detail: `node ${name} references unknown parent: ${parent}` });
      }
      nodePaths.add(fullPath);
      continue;
    }
    const header = line.match(/^\[gd_scene load_steps=(\d+) format=(\d+)\]/);
    if (header) loadSteps = Number(header[1]);
  }
  if (loadSteps > 0 && loadSteps !== extResources + subResources + 1) {
    findings.push({ severity: 'warning', file: relativePath, detail: `load_steps ${loadSteps} != ext ${extResources} + sub ${subResources} + 1` });
  }
}

function parseSceneScanOutput(output) {
  const findings = [];
  for (const line of output.split(/\r?\n/)) {
    const fail = line.match(/^SCENE_FAIL (.+)$/);
    if (fail) {
      findings.push({ severity: 'broken', file: fail[1], detail: 'Godot load() returned null (see load errors above)' });
      continue;
    }
    const sceneError = line.match(/^ERROR: (res:\/\/[^:]+):\d+ - (.*)$/);
    if (sceneError) {
      findings.push({ severity: 'broken', file: sceneError[1], detail: sceneError[2].trim().slice(0, 300) });
      continue;
    }
    const plainError = line.match(/^ERROR: Resource file not found: (res:\/\/[^ ]+)/);
    if (plainError) {
      findings.push({ severity: 'warning', file: plainError[1], detail: 'Resource file not found during load (see load errors above)' });
    }
  }
  return findings;
}

function profileFor(config, name) {
  const profile = config.profiles?.[name];
  if (!profile) {
    const choices = Object.keys(config.profiles ?? {}).join(', ') || '(none)';
    throw new Error(`Unknown capture profile "${name}". Available: ${choices}`);
  }
  return profile;
}

function fixtureAdapterFor(project, profile) {
  const adapter = profile.fixtureAdapter;
  if (adapter === undefined || adapter === null) return '';
  if (typeof adapter !== 'string' || adapter.length === 0) {
    throw new Error('Profile fixtureAdapter must be a non-empty res://tests/ or res://qa/ .gd path');
  }
  const components = adapter.startsWith('res://') ? adapter.slice('res://'.length).split('/') : [];
  if (!['tests', 'qa'].includes(components[0]) || components.length < 2
    || components.some((component) => !component || component === '.' || component === '..' || component.includes('\\'))
    || !components.at(-1).endsWith('.gd')) {
    throw new Error(`Profile fixtureAdapter must be a res://tests/ or res://qa/ .gd path: ${adapter}`);
  }
  const absolute = resolve(project, ...components);
  if (!pathIsInside(project, absolute)) throw new Error(`Profile fixtureAdapter escapes the project: ${adapter}`);
  if (pathContainsSymlink(project, absolute)) throw new Error(`Profile fixtureAdapter path must not contain symbolic links: ${adapter}`);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`Profile fixtureAdapter file is missing: ${adapter}`);
  const allowedRoot = resolve(project, components[0]);
  if (!pathIsInside(realpathSync(allowedRoot), realpathSync(absolute))) throw new Error(`Profile fixtureAdapter escapes its test root: ${adapter}`);
  return adapter;
}

function ensureFixtureAdapterIsProfileDeclared(userArgs) {
  if (userArgs.some((argument) => typeof argument === 'string' && argument.startsWith('--gdeck-fixture-adapter='))) {
    throw new Error('Fixture adapters must be declared with profile.fixtureAdapter, not userArgs');
  }
}

async function runProfileGodot(godot, args, options, fixtureAdapter) {
  args = withRuntimeClockMetadata(args);
  if (!fixtureAdapter) return await runProcess(godot, args, options);
  const isolationRoot = createLifecycleTemporaryDirectory('gdeck-fixture-run-');
  const capability = randomBytes(32).toString('hex');
  const directories = {
    HOME: join(isolationRoot, 'home'),
    USERPROFILE: join(isolationRoot, 'home'),
    XDG_DATA_HOME: join(isolationRoot, 'xdg-data'),
    XDG_CONFIG_HOME: join(isolationRoot, 'xdg-config'),
    XDG_CACHE_HOME: join(isolationRoot, 'xdg-cache'),
    XDG_STATE_HOME: join(isolationRoot, 'xdg-state'),
    APPDATA: join(isolationRoot, 'app-data'),
    LOCALAPPDATA: join(isolationRoot, 'local-app-data'),
  };
  for (const directory of new Set(Object.values(directories))) mkdirSync(directory, { recursive: true });
  try {
    return await runProcess(godot, [...args, `--gdeck-fixture-capability=${capability}`], {
      ...options,
      env: { ...(options.env ?? {}), ...directories, GDECK_FIXTURE_CAPABILITY: capability },
    });
  } finally {
    removeLifecycleTemporaryDirectory(isolationRoot);
  }
}

async function captureProject(positional, options, internalStage = null) {
  const runtime = internalStage?.stage.runtime;
  const selected = internalStage ? { project: internalStage.plan.project, profile: internalStage.stage.target } : projectAndProfile(positional);
  const { project, profile: profileName } = selected;
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const config = runtime ? { godotPath: runtime.godotPath } : loadConfig(project);
  const profile = runtime ? null : profileFor(config, profileName);
  const godot = findGodot(config, options.godot);
  const frames = Number(runtime?.frames ?? options.frames ?? profile?.frames ?? 30);
  const seedValue = Number(runtime?.seed ?? options.seed ?? profile?.seed ?? 42);
  const output = resolve(options.output ?? join(project, '.gdeck', 'captures', `${profileName}-${timestamp()}.png`));
  const report = join(project, '.gdeck', 'reports', `${profileName}-${timestamp()}-${randomBytes(6).toString('hex')}.json`);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(dirname(report), { recursive: true });
  const profileUserArgs = runtime?.profileUserArgs ?? profile.userArgs ?? [];
  ensureFixtureAdapterIsProfileDeclared(profileUserArgs);
  const fixtureAdapter = runtime?.fixtureAdapter ?? fixtureAdapterFor(project, profile);
  const staging = mkdtempSync(join(dirname(output), '.gdeck-capture-'));
  const stagedImage = join(staging, 'capture.png');
  const stagedReport = join(staging, 'report.json');
  let publishedReport = false;
  let publishedImage = false;
  try {
    const userArgs = [
      ...profileUserArgs,
      ...(fixtureAdapter ? [`--gdeck-fixture-adapter=${fixtureAdapter}`] : []),
      `--gdeck-capture=${stagedImage}`,
      `--gdeck-report=${stagedReport}`,
      `--gdeck-after-frames=${frames}`,
      `--gdeck-seed=${seedValue}`,
    ];
    const result = await runProfileGodot(godot, ['--path', executionProject, '--fixed-fps', '60', '--', ...userArgs], {
      cwd: executionProject, timeoutMs: timeoutMilliseconds(options), phase: 'capture',
    }, fixtureAdapter);
    const failed = result.status !== 0 || ERROR_PATTERN.test(result.output) || !existsSync(stagedImage) || !existsSync(stagedReport);
    if (failed) {
      console.error(color.red('Capture failed'));
      return processStatusOr(result);
    }
    const data = JSON.parse(readFileSync(stagedReport, 'utf8'));
    const image = readFileSync(stagedImage);
    if (data.capture !== stagedImage || data.capture_error !== 0
      || image.length < 24 || !image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      throw new Error('Capture did not produce a matching successful report and PNG');
    }
    data.capture = output;
    writeFileAtomicNoReplace(report, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    publishedReport = true;
    renameSync(stagedImage, output);
    publishedImage = true;
    console.log(color.green('Capture complete'));
    console.log(`  Image:  ${output}`);
    console.log(`  Report: ${report}`);
    return 0;
  } finally {
    if (publishedReport && !publishedImage) rmSync(report, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

function scenarioFile(project, candidate) {
  const fileName = candidate.endsWith('.json') ? candidate : `${candidate}.json`;
  const projectScenario = join(project, 'qa', 'scenarios', fileName);
  if (existsSync(projectScenario)) return projectScenario;
  const direct = resolve(candidate);
  if (existsSync(direct)) return direct;
  throw new Error(`Scenario not found: ${candidate}`);
}

async function runScenario(positional, options, internalStage = null) {
  if (positional.length === 0) throw new Error('Scenario name or JSON file is required.');
  const runtime = internalStage?.stage.runtime;
  const project = internalStage?.plan.project ?? resolveProject(positional[1] ?? process.cwd());
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  let config;
  let path;
  let frames;
  let seedValue;
  let scenarioName;
  let scenarioStem;
  let capturesOutput;
  let profileUserArgs;
  let scenarioUserArgs;
  let fixtureAdapter;
  if (runtime) {
    config = { godotPath: runtime.godotPath };
    path = verificationExecutionPath(internalStage, runtime.scenarioPath);
    frames = runtime.frames;
    seedValue = runtime.seed;
    scenarioName = runtime.scenarioName;
    scenarioStem = runtime.scenarioStem;
    capturesOutput = runtime.capture || Boolean(options.output);
    profileUserArgs = runtime.profileUserArgs;
    scenarioUserArgs = runtime.targetUserArgs;
    fixtureAdapter = runtime.fixtureAdapter;
  } else {
    const scenarioCandidate = positional[0];
    config = loadConfig(project);
    path = scenarioFile(project, scenarioCandidate);
    const definition = JSON.parse(readFileSync(path, 'utf8'));
    const profileName = options.profile ?? definition.profile ?? 'default';
    const profile = profileFor(config, profileName);
    frames = Number(options.frames ?? definition.timeoutFrames ?? 3600);
    seedValue = Number(options.seed ?? definition.seed ?? profile.seed ?? 42);
    scenarioName = definition.name ?? path.split('/').at(-1).replace(/\.json$/, '');
    scenarioStem = path.split('/').at(-1).replace(/\.json$/, '').replace(/[^A-Za-z0-9_-]+/g, '_') || 'scenario';
    capturesOutput = definition.capture !== false || Boolean(options.output);
    profileUserArgs = profile.userArgs ?? [];
    scenarioUserArgs = definition.userArgs ?? [];
    fixtureAdapter = fixtureAdapterFor(project, profile);
  }
  if (typeof scenarioName !== 'string' || scenarioName.length === 0) throw new Error('Scenario name must be a non-empty string');
  ensureFixtureAdapterIsProfileDeclared([...profileUserArgs, ...scenarioUserArgs]);
  const abSteps = (JSON.parse(readFileSync(path, 'utf8')).steps ?? []).flatMap((step, index) => step?.capture_ab !== undefined ? [index] : []);
  if (abSteps.length > 4) throw new Error('A scenario may capture at most four A/B pairs');
  if (abSteps.length && !fixtureAdapter) throw new Error('A/B capture requires a profile.fixtureAdapter with isolated user data');
  const godot = findGodot(config, options.godot);
  const runTimestamp = timestamp();
  const output = resolve(options.output ?? join(project, '.gdeck', 'captures', `scenario-${scenarioStem}-${runTimestamp}.png`));
  const report = resolve(options.report ?? join(project, '.gdeck', 'reports', `scenario-${scenarioStem}-${runTimestamp}.json`));
  if (capturesOutput) mkdirSync(dirname(output), { recursive: true });
  mkdirSync(dirname(report), { recursive: true });
  const traceEvents = options['trace-events'] === true || process.env.GDECK_TRACE_EVENTS === '1';
  if (!runtime) {
    try {
      const definition = JSON.parse(readFileSync(path, 'utf8'));
      const lintWarnings = lintScenarioDefinition(definition, { traceEvents });
      for (const line of formatScenarioLintWarnings(lintWarnings.filter((item) => item.code !== 'trace_events_enabled'))) {
        console.error(color.yellow(line));
      }
    } catch { /* lint is best-effort */ }
  }
  const abParent = join(project, '.gdeck', 'captures');
  if (abSteps.length && pathContainsSymlink(project, abParent)) throw new Error('A/B capture directory must not contain symbolic links');
  if (abSteps.length) mkdirSync(abParent, { recursive: true });
  const abStaging = abSteps.length ? mkdtempSync(join(abParent, '.gdeck-ab-')) : '';
  const abDestination = abStaging ? join(abParent, `scenario-${scenarioStem}-${runTimestamp}-${basename(abStaging).slice(10)}-ab`) : '';
  let abPublished = false;
  try {
  if (abStaging) lifecycleRegistryEvent('resource_add', abStaging);
  const userArgs = [
    ...profileUserArgs,
    ...scenarioUserArgs,
    ...(fixtureAdapter ? [`--gdeck-fixture-adapter=${fixtureAdapter}`] : []),
    ...(abStaging ? [`--gdeck-capture-ab-root=${abStaging}`] : []),
    `--gdeck-scenario=${path}`,
    `--gdeck-report=${report}`,
    `--gdeck-after-frames=${frames}`,
    `--gdeck-seed=${seedValue}`,
  ];
  if (capturesOutput) userArgs.push(`--gdeck-capture=${output}`);
  const result = await runProfileGodot(godot, ['--path', executionProject, '--fixed-fps', '60', '--', ...userArgs], {
    cwd: executionProject,
    timeoutMs: timeoutMilliseconds(options),
    phase: 'scenario',
    env: traceEvents ? { GDECK_TRACE_EVENTS: '1' } : undefined,
  }, fixtureAdapter);
  if (!existsSync(report)) {
    console.error(color.red('Scenario failed without producing a report'));
    return processStatusOr(result);
  }
  const data = JSON.parse(readFileSync(report, 'utf8'));
  const scenarioResult = data.scenario ?? {};
  let passed = result.status === 0 && !ERROR_PATTERN.test(result.output) && scenarioResult.status === 'passed';
  if (abStaging) {
    if (passed) {
      try {
        publishCapturePairs(data, abStaging, abDestination, abSteps);
        abPublished = true;
      } catch (error) {
        passed = false;
        scenarioResult.status = 'failed';
        scenarioResult.failure_kind = 'precondition';
        scenarioResult.failure = 'A/B artifact publication failed';
        scenarioResult.failure_details = { kind: 'capture_ab_inconclusive', reason: 'publication_failed' };
        for (const pair of data.capture_ab ?? []) { pair.published = false; delete pair.artifacts; }
        console.error(error.message);
      }
    }
    try { writeFileAtomic(report, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 }); }
    catch (error) {
      if (abPublished) rmSync(abDestination, { recursive: true, force: true });
      throw error;
    }
    for (const pair of capturePairSummary(data.capture_ab)) {
      console.log(`  A/B step ${pair.step}: ${pair.published ? 'published' : 'not published'}${pair.artifacts ? `; ${pair.artifacts.side_by_side}` : ''}`);
    }
  }
  console.log(passed ? color.green('Scenario passed') : color.red('Scenario failed'));
  console.log(`  Name:       ${scenarioResult.name ?? scenarioName}`);
  console.log(`  Steps:      ${scenarioResult.steps_completed ?? 0}/${scenarioResult.steps_total ?? 0}`);
  console.log(`  Assertions: ${(scenarioResult.assertions ?? []).filter((item) => item.passed).length}/${(scenarioResult.assertions ?? []).length}`);
  if (scenarioResult.failure) console.log(`  Failure:    ${scenarioResult.failure}`);
  if (!passed && scenarioResult.failure_details?.kind === 'wait_event_timeout') {
    const details = scenarioResult.failure_details;
    console.log(`  Event window: [${details.event_window_start ?? '?'}, ${details.event_window_end ?? '?'}); matches=${details.matches_in_window ?? 0}; prior=${details.prior_matches ?? 0}`);
    if ((traceEvents || scenarioResult.trace_events) && details.trace?.recent_events) {
      for (const event of details.trace.recent_events.slice(-6)) {
        console.log(`  Event #${event.index} frame=${event.frame}: ${event.name}`);
      }
    }
  }
  if (capturesOutput) console.log(`  Image:      ${output}`);
  console.log(`  Report:     ${report}`);
  return passed ? 0 : processStatusOr(result);
  } finally {
    if (abStaging) {
      rmSync(abStaging, { recursive: true, force: true });
      lifecycleRegistryEvent('resource_remove', abStaging);
    }
  }
}

async function baselineProject(positional, options) {
  const { project, profile } = projectAndProfile(positional);
  const output = join(project, 'qa', 'baselines', `${profile}.png`);
  const metadataPath = join(project, 'qa', 'baselines', `${profile}.json`);
  const config = loadConfig(project);
  const profileConfig = profileFor(config, profile);
  const frames = Number(options.frames ?? profileConfig.frames ?? 30);
  const seedValue = Number(options.seed ?? profileConfig.seed ?? 42);
  mkdirSync(dirname(output), { recursive: true });
  const status = await captureProject(positional, { ...options, frames, seed: seedValue, output });
  if (status === 0) {
    const metadata = {
      schemaVersion: 1,
      flightDeckVersion: TOOL_VERSION,
      profile,
      frames,
      seed: seedValue,
      pixelThreshold: Number(options.threshold ?? 0.05),
      tolerance: Number(options.tolerance ?? 0.001),
    };
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    console.log(color.green(`Baseline updated: ${output}`));
    console.log(`  Metadata: ${metadataPath}`);
  }
  return status;
}

async function visualTest(positional, options, internalStage = null) {
  const runtime = internalStage?.stage.runtime;
  const selected = internalStage ? { project: internalStage.plan.project, profile: internalStage.stage.target } : projectAndProfile(positional);
  const { project, profile } = selected;
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const baseline = runtime ? verificationExecutionPath(internalStage, runtime.baselinePath) : join(project, 'qa', 'baselines', `${profile}.png`);
  if (!existsSync(baseline)) {
    console.error(color.red(`Visual baseline missing: ${baseline}`));
    console.error(`Run: gdeck baseline ${profile} ${project}`);
    return 1;
  }
  const metadataPath = join(project, 'qa', 'baselines', `${profile}.json`);
  const metadata = runtime ? {} : existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, 'utf8')) : {};
  const runTimestamp = timestamp();
  const actual = join(project, '.gdeck', 'captures', `visual-${profile}-${runTimestamp}.png`);
  const diff = join(project, '.gdeck', 'reports', `visual-${profile}-${runTimestamp}-diff.png`);
  const report = resolve(options.report ?? join(project, '.gdeck', 'reports', `visual-${profile}-${runTimestamp}.json`));
  const captureOptions = {
    ...options,
    frames: runtime?.frames ?? options.frames ?? metadata.frames,
    seed: runtime?.seed ?? options.seed ?? metadata.seed,
    output: actual,
  };
  const captureStatus = await captureProject(positional, captureOptions, internalStage);
  if (captureStatus !== 0) return captureStatus;
  const config = runtime ? { godotPath: runtime.godotPath } : loadConfig(project);
  const godot = findGodot(config, options.godot);
  const threshold = Number(runtime?.threshold ?? options.threshold ?? metadata.pixelThreshold ?? 0.05);
  const tolerance = Number(runtime?.tolerance ?? options.tolerance ?? metadata.tolerance ?? 0.001);
  const diffScript = 'res://addons/flight_deck/visual_diff.gd';
  const args = [
    '--headless', '--path', executionProject, '--script', diffScript, '--',
    `--baseline=${baseline}`,
    `--actual=${actual}`,
    `--diff=${diff}`,
    `--report=${report}`,
    `--threshold=${threshold}`,
    `--tolerance=${tolerance}`,
  ];
  const result = await runProcess(godot, args, {
    cwd: executionProject, timeoutMs: timeoutMilliseconds(options), phase: 'visual_diff',
  });
  if (!existsSync(report)) {
    console.error(color.red('Visual comparison failed without producing a report'));
    return processStatusOr(result);
  }
  const data = JSON.parse(readFileSync(report, 'utf8'));
  const passed = result.status === 0 && data.passed === true;
  console.log(passed ? color.green('Visual test passed') : color.red('Visual test failed'));
  console.log(`  Profile:       ${profile}`);
  console.log(`  Changed:       ${(Number(data.changed_ratio) * 100).toFixed(4)}%`);
  console.log(`  Mean error:    ${(Number(data.mean_absolute_error) * 100).toFixed(4)}%`);
  console.log(`  Pixel limit:   ${(threshold * 100).toFixed(2)}%`);
  console.log(`  Ratio limit:   ${(tolerance * 100).toFixed(4)}%`);
  console.log(`  Baseline:      ${baseline}`);
  console.log(`  Actual:        ${actual}`);
  console.log(`  Diff heatmap:  ${diff}`);
  console.log(`  Report:        ${report}`);
  return passed ? 0 : processStatusOr(result);
}

async function benchmarkProject(positional, options, internalStage = null) {
  const runtime = internalStage?.stage.runtime;
  const selected = internalStage ? { project: internalStage.plan.project, profile: internalStage.stage.target } : projectAndProfile(positional);
  const { project, profile: profileName } = selected;
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const config = runtime ? { godotPath: runtime.godotPath } : loadConfig(project);
  const profile = runtime ? null : profileFor(config, profileName);
  const godot = findGodot(config, options.godot);
  const frames = Number(runtime?.frames ?? options.frames ?? profile?.benchmarkFrames ?? 600);
  const warmupFrames = Number(runtime?.warmupFrames ?? options.warmup ?? profile?.benchmarkWarmupFrames ?? 60);
  if (!Number.isInteger(frames) || frames < 1) throw new Error('Benchmark frames must be a positive integer');
  if (!Number.isInteger(warmupFrames) || warmupFrames < 0) throw new Error('Benchmark warmup frames must be a non-negative integer');
  const seedValue = Number(runtime?.seed ?? options.seed ?? profile?.seed ?? 42);
  const report = resolve(options.output ?? join(project, '.gdeck', 'reports', `${profileName}-benchmark-${timestamp()}.json`));
  mkdirSync(dirname(report), { recursive: true });
  const profileUserArgs = runtime?.profileUserArgs ?? profile.userArgs ?? [];
  ensureFixtureAdapterIsProfileDeclared(profileUserArgs);
  const fixtureAdapter = runtime?.fixtureAdapter ?? fixtureAdapterFor(project, profile);
  const userArgs = [
    ...profileUserArgs,
    ...(fixtureAdapter ? [`--gdeck-fixture-adapter=${fixtureAdapter}`] : []),
    '--gdeck-benchmark',
    `--gdeck-report=${report}`,
    `--gdeck-warmup-frames=${warmupFrames}`,
    `--gdeck-after-frames=${warmupFrames + frames}`,
    `--gdeck-seed=${seedValue}`,
  ];
  const result = await runProfileGodot(godot, ['--path', executionProject, '--', ...userArgs], {
    cwd: executionProject, timeoutMs: timeoutMilliseconds(options), phase: 'benchmark',
  }, fixtureAdapter);
  const failed = result.status !== 0 || ERROR_PATTERN.test(result.output) || !existsSync(report);
  if (failed) {
    console.error(color.red('Benchmark failed'));
    return processStatusOr(result);
  }
  const data = JSON.parse(readFileSync(report, 'utf8'));
  console.log(color.green('Benchmark complete'));
  console.log(`  Warmup frames:   ${data.benchmark_window?.warmup_frames ?? warmupFrames}`);
  console.log(`  Measured frames: ${data.benchmark_window?.stable_frames ?? data.frames}`);
  console.log(`  Stable avg FPS:  ${Number(data.performance.average_fps).toFixed(1)}`);
  if (Number.isFinite(Number(data.performance.average_frame_ms))) {
    console.log(`  Avg frame:       ${Number(data.performance.average_frame_ms).toFixed(2)} ms`);
  }
  if (Number.isFinite(Number(data.performance.worst_frame_ms))) {
    console.log(`  Worst frame:     ${Number(data.performance.worst_frame_ms).toFixed(2)} ms`);
  }
  console.log(`  Worst process*:  ${Number(data.performance.worst_process_ms).toFixed(2)} ms (*TIME_PROCESS monitor, not per-frame)`);
  if (data.performance_timing) {
    console.log(`  Timing samples:  ${(data.performance_timing.samples ?? []).length}/${data.performance_timing.sample_count ?? 0}`);
    console.log(`  Slowest retained: ${(data.performance_timing.slowest_frames ?? []).length}`);
  }
  console.log(`  Nodes:           ${data.performance.nodes}`);
  console.log(`  Active 2D:       ${data.performance.active_2d_objects}`);
  console.log(`  Godot static MB: ${(Number(data.performance.static_memory_bytes) / (1024 * 1024)).toFixed(1)} (snapshot, not RSS/peak)`);
  console.log(`  Report:          ${report}`);
  return 0;
}

function reserveDirectUnitReport(report, binding) {
  mkdirSync(dirname(report), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(report, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    const bytes = Buffer.from(JSON.stringify({
      schema_version: 2,
      complete: false,
      unit_binding: binding,
      progress: { sequence: 0, elapsed_ms: 0, completed_cases: 0, total_cases: 0, current_case: null },
    }));
    writeSync(descriptor, bytes);
    fsyncBestEffort(descriptor);
    try { fchmodSync(descriptor, 0o600); } catch (error) {
      if (!(process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'ENOSYS' || error?.code === 'EINVAL'))) throw error;
    }
  } catch (error) {
    throw new ResultClassificationError('report_io', `Cannot reserve invocation-owned Unit report path ${report}: ${error.message}`);
  } finally {
    if (Number.isInteger(descriptor)) closeSync(descriptor);
  }
}

function readUnitReportStable(report, maximumBytes = 64 * 1024 * 1024) {
  let descriptor;
  try {
    descriptor = openSync(report, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) throw new Error('Unit report is empty, unsafe, or oversized');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(report);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.isSymbolicLink()) {
      throw new Error('Unit report changed while it was being read');
    }
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    if (Number.isInteger(descriptor)) closeSync(descriptor);
  }
}

async function runUnitTests(projectCandidate, options, internalStage = null, directUnitBinding = null) {
  const project = internalStage?.plan.project ?? resolveProject(projectCandidate);
  const executionProject = verificationExecutionProject(internalStage) ?? project;
  const testsDirectory = join(executionProject, 'tests');
  if (!existsSync(testsDirectory)) {
    console.error(color.red(`Tests directory missing: ${testsDirectory}`));
    return 1;
  }
  const config = internalStage ? { godotPath: internalStage.stage.runtime.godotPath } : loadConfig(project);
  const godot = findGodot(config, options.godot);
  const report = resolve(options.output ?? join(project, '.gdeck', 'reports', `unit-${timestamp()}.json`));
  const timeoutMs = timeoutMilliseconds(options);
  const expectedBinding = internalStage
    ? unitBindingForExecution({
      project,
      report,
      timeoutMs,
      options,
      invocationIdentity: internalStage.plan.invocationIdentity,
      ownerNonce: verificationUnitOwnerNonce(internalStage.plan, internalStage.stage),
    })
    : directUnitBinding;
  if (!expectedBinding) throw new ResultClassificationError('configuration', 'Direct Unit requires a GDeck-owned execution binding');
  const reconstructedBinding = unitBindingForExecution({
    project,
    report,
    timeoutMs,
    options,
    invocationIdentity: expectedBinding.invocation_identity,
    ownerNonce: expectedBinding.owner_nonce,
  });
  if (!unitExecutionBindingMatches(expectedBinding, reconstructedBinding)) {
    throw new ResultClassificationError('configuration', 'Direct Unit execution binding does not match its exact project, output, timeout, or runtime arguments');
  }
  if (internalStage) {
    if (existsSync(report)) throw new ResultClassificationError('report_io', `Invocation-owned Unit report path is unexpectedly occupied: ${report}`);
    mkdirSync(dirname(report), { recursive: true });
  } else reserveDirectUnitReport(report, expectedBinding);
  const runtimeArguments = unitRuntimeArguments(options);
  const args = [
    '--headless', '--path', executionProject,
    '--script', 'res://addons/flight_deck/unit_runner.gd', '--',
    ...runtimeArguments,
    `--report=${report}`,
    `--gdeck-unit-binding=${Buffer.from(JSON.stringify(expectedBinding)).toString('base64url')}`,
  ];
  const result = await runProcess(godot, args, {
    cwd: executionProject, timeoutMs, phase: 'unit', quiet: true,
  });
  if (result.status !== 0 || ERROR_PATTERN.test(result.output)) {
    const diagnostics = writeUnitDiagnostics(report, result);
    const hint = renderDiagnosticText(diagnostics);
    if (hint) console.error(hint);
    console.error(`Engine logs: ${diagnostics.logs.streams.stdout.path}; ${diagnostics.logs.streams.stderr.path}`);
  }
  if (!existsSync(report)) {
    console.error(color.red('Unit tests failed without producing a report'));
    return processStatusOr(result);
  }
  let data;
  try { data = readUnitReportStable(report); }
  catch (error) {
    console.error(color.red(`Unit tests produced an unreadable report: ${error.message}`));
    return processStatusOr(result);
  }
  const disposition = unitReportDisposition(data, data.schema_version === 2 ? expectedBinding : undefined);
  if (disposition.state !== 'terminal') {
    console.error(color.red(disposition.state === 'incomplete'
      ? 'Unit execution ended with operational-only incomplete evidence'
      : 'Unit execution produced corrupt or mismatched evidence'));
    console.log(`  Report:     ${report}`);
    return processStatusOr(result);
  }
  const passed = result.status === 0 && !ERROR_PATTERN.test(result.output) && data.status === 'passed' && Number(data.summary?.total ?? 0) > 0;
  console.log(passed ? color.green('Unit tests passed') : color.red('Unit tests failed'));
  console.log(`  Cases:      ${data.summary?.passed ?? 0}/${data.summary?.total ?? 0}`);
  console.log(`  Assertions: ${data.summary?.assertions ?? 0}`);
  console.log(`  Duration:   ${data.summary?.duration_ms ?? 0} ms`);
  if (normalizeVerbosity(options.verbosity, 'compact') !== 'compact') {
    for (const item of projectUnitSlowestCases(data, data.schema_version === 2 ? expectedBinding : undefined, { limit: 5 })) {
      console.log(`  Slow case:  #${item.ordinal} ${item.identifier} ${item.durationMs} ms`);
    }
  }
  console.log(`  Report:     ${report}`);
  return passed ? 0 : processStatusOr(result);
}

function requestEditorBridge({ host, port, token, expectedInstanceId = '', action, params }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = connect({ host, port });
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      rejectRequest(new Error(`Editor bridge timed out at ${host}:${port}`));
    }, 3000);
    const finish = (callback, value) => {
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: Date.now(), token, client_version: TOOL_VERSION, expected_instance_id: expectedInstanceId, action, params })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(resolveRequest, JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        finish(rejectRequest, new Error(`Invalid editor bridge response: ${error.message}`));
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      rejectRequest(new Error(`Cannot connect to editor bridge at ${host}:${port}: ${error.message}`));
    });
  });
}

const EDITOR_READ_ACTIONS = new Set(
  Object.entries(EDITOR_ACTION_CATALOG)
    .filter(([, meta]) => meta.layer === 'core-read' || meta.layer === 'meta')
    .map(([name]) => name),
);

function bridgeHandshakeProblem(response, project, requireCompatibleVersion, expectedSession = null) {
  if (!response.ok) return `Editor bridge handshake failed: ${response.error ?? 'unknown error'}`;
  const bridgeProject = String(response.result?.project ?? '');
  if (!bridgeProject || !sameExistingPath(bridgeProject, project)) return `Editor bridge belongs to another project: ${bridgeProject || '(unknown)'}`;
  const bridgeVersion = String(response.version ?? response.result?.flight_deck_version ?? 'unknown');
  if (expectedSession) {
    const identityMatches = String(response.result?.instance_id ?? '') === String(expectedSession.instance_id)
      && Number(response.result?.pid) === Number(expectedSession.pid)
      && Number(response.result?.started_unix) === Number(expectedSession.started_unix);
    if (!identityMatches) return 'Editor bridge identity does not match the active project session. Restart the Editor before writing.';
  }
  if (requireCompatibleVersion && bridgeVersion !== TOOL_VERSION) return `Editor bridge version mismatch: CLI ${TOOL_VERSION}, Editor ${bridgeVersion}. Restart the Editor before writing.`;
  return '';
}

function printEditorResult(action, result) {
  if (action === 'batch') {
    const label = result.dry_run ? 'Batch preflight passed' : 'Batch committed';
    console.log(color.green(`${label}: ${result.name}`));
    console.log(`  Operations: ${result.count}`);
    console.log(`  Dry run:    ${result.dry_run ? 'yes' : 'no'}`);
    if (result.undo_registered) console.log('  Undo:       registered');
    for (const operation of result.operations ?? []) {
      console.log(`  - ${operation.action} ${operation.target}:${operation.property}`);
    }
    return;
  }
  if (action === 'status') {
    console.log(color.green('Godot editor connected'));
    console.log(`  Godot:    ${result.godot_version}`);
    console.log(`  Project:  ${result.project}`);
    console.log(`  Scene:    ${result.edited_scene || '(none)'}`);
    console.log(`  Running:  ${result.is_playing ? 'yes' : 'no'}`);
    console.log(`  Selected: ${(result.selected_nodes ?? []).length}`);
    console.log(`  Writes:   ${result.allow_writes ? 'enabled' : 'disabled'}`);
    console.log(`  Undo:     ${result.can_undo ? 'available' : 'empty'}`);
    return;
  }
  if (action === 'tree') {
    console.log(`Edited scene: ${result.scene || '(none)'}`);
    for (const node of result.nodes ?? []) {
      console.log(`${'  '.repeat(node.depth)}${node.name}  ${color.muted(`[${node.class}] ${node.path}`)}`);
    }
    if (result.truncated) console.log(color.yellow(`… truncated at ${result.limit} nodes`));
    return;
  }
  if (action === 'inspect') {
    console.log(`${result.name} [${result.class}]`);
    console.log(`Path: ${result.path}`);
    if (result.script) console.log(`Script: ${result.script}`);
    for (const property of result.properties ?? []) {
      console.log(`  ${property.name}: ${JSON.stringify(property.value)} ${color.muted(`[${property.type}]`)}`);
    }
    return;
  }
  if (action === 'resource-inspect') {
    console.log(`${result.path} [${result.class}]`);
    for (const property of result.properties ?? []) {
      console.log(`  ${property.name}: ${JSON.stringify(property.value)} ${color.muted(`[${property.type}${property.class ? `:${property.class}` : ''}]`)}`);
    }
    return;
  }
  if (action === 'resource-create') {
    console.log(color.green(`Created ${result.path} [${result.class}]`));
    console.log('  Undo: registered');
    return;
  }
  if (action === 'resource-set') {
    console.log(color.green(`Updated ${result.path}:${result.property}`));
    console.log(`  Old: ${JSON.stringify(result.old_value)}`);
    console.log(`  New: ${JSON.stringify(result.value)}`);
    console.log('  Undo: registered');
    return;
  }
  if (action === 'resource-delete') {
    console.log(color.green(`Deleted ${result.path} [${result.class}]`));
    console.log('  Undo: registered');
    return;
  }
  if (action === 'resource-assign') {
    console.log(color.green(`Assigned ${result.resource} to ${result.path}:${result.property}`));
    console.log('  Undo: registered');
    return;
  }
  if (action === 'create') {
    console.log(color.green(`Created ${result.path} [${result.class}]`));
    console.log('  Undo: registered');
    return;
  }
  if (action === 'delete') {
    console.log(color.green(`Deleted ${result.path}`));
    console.log('  Undo: registered');
    return;
  }
  if (action === 'reorder') {
    console.log(color.green(`Moved ${result.path}: ${result.old_index} → ${result.index}`));
    console.log('  Undo: registered');
    return;
  }
  if (action === 'set') {
    console.log(color.green(`Updated ${result.path}:${result.property}`));
    console.log(`  Type: ${result.type}`);
    console.log(`  Old:  ${JSON.stringify(result.old_value)}`);
    console.log(`  New:  ${JSON.stringify(result.value)}`);
    console.log('  Undo: registered');
    return;
  }
  if (action === 'undo' || action === 'redo') {
    console.log(color.green(action === 'undo' ? `Undid ${result.action ?? 'last action'}` : 'Redid last action'));
    return;
  }
  if (action === 'save') {
    console.log(color.green(`Saved ${result.scene}`));
    return;
  }
  if (action === 'logs') {
    const modified = result.modified_unix ? new Date(result.modified_unix * 1000).toISOString() : 'unknown';
    console.log(`Runtime log: ${result.path || '(unavailable)'} (modified ${modified})`);
    for (const line of result.lines ?? []) console.log(line);
    if ((result.bridge_events ?? []).length > 0) {
      console.log('\nEditor bridge events:');
      for (const line of result.bridge_events) console.log(line);
    }
  }
}

async function editorCommand(positional, options) {
  const action = positional[0] ?? 'status';
  const supported = new Set(Object.keys(CLI_COMMANDS.editor.actions));
  if (!supported.has(action)) {
    console.error(color.red(`Unsupported editor action: ${action}`));
    return 1;
  }
  if (action === 'describe') {
    const targetAction = positional[1];
    const description = describeEditorAction(targetAction);
    if (targetAction && !description) {
      console.error(color.red(`Unknown editor action: ${targetAction}`));
      console.error(`Allowed: ${Object.keys(EDITOR_ACTION_CATALOG).join(', ')}`);
      return 1;
    }
    if (options.json) console.log(JSON.stringify(description, null, 2));
    else if (targetAction) {
      console.log(`editor ${targetAction}`);
      console.log(`  Layer:    ${description.layer}`);
      console.log(`  Risk:     ${description.risk}`);
      console.log(`  Summary:  ${description.summary}`);
      console.log(`  Live Editor: ${description.requiresLiveEditor ? 'required' : 'not required'}`);
      console.log(`  allowWrites: ${description.requiresAllowWrites ? 'required' : 'not required'}`);
      console.log(`  supplementaryEnabled: ${description.requiresSupplementary ? 'required' : 'not required'}`);
      console.log(`  --apply:  ${description.requiresApply ? 'required to mutate' : 'not required'}`);
    } else {
      const layers = listEditorActionsByLayer();
      console.log(`Editor Bridge catalog (${TOOL_VERSION})`);
      for (const [layer, actions] of Object.entries(layers)) {
        if (!actions.length) continue;
        console.log(`  ${layer}: ${actions.join(', ')}`);
      }
      console.log('\nDecision tree:');
      for (const item of AGENT_DECISION_TREE) {
        console.log(`  - ${item.id}: ${item.prefer}`);
      }
      console.log('\nTip: gdeck editor describe <action> --json');
    }
    return 0;
  }
  let target = '';
  let property = '';
  let value;
  let parent = '';
  let className = '';
  let nodeName = '';
  let index = -1;
  let resourcePath = '';
  let resourceClass = '';
  let batch;
  let projectCandidate;
  if (action === 'batch') {
    const batchPath = positional[1];
    if (!batchPath) {
      console.error(color.red('Usage: gdeck editor batch <batch.json> [project] [--dry-run|--apply]'));
      return 1;
    }
    const resolvedBatch = resolve(batchPath);
    if (!existsSync(resolvedBatch)) {
      console.error(color.red(`Batch file not found: ${resolvedBatch}`));
      return 1;
    }
    try { batch = JSON.parse(readFileSync(resolvedBatch, 'utf8')); } catch (error) {
      console.error(color.red(`Invalid batch JSON: ${error.message}`));
      return 1;
    }
    if (!batch || !Array.isArray(batch.operations)) {
      console.error(color.red('Batch JSON must contain an operations array'));
      return 1;
    }
    projectCandidate = positional[2];
  } else if (action === 'inspect') {
    target = positional[1] ?? '.';
    projectCandidate = positional[2];
  } else if (action === 'set') {
    target = positional[1] ?? '.';
    property = positional[2] ?? '';
    const rawValue = positional[3];
    if (!property || rawValue === undefined) {
      console.error(color.red('Usage: gdeck editor set <node-path> <property> <json-value> [project]'));
      return 1;
    }
    try { value = JSON.parse(rawValue); } catch { value = rawValue; }
    projectCandidate = positional[4];
  } else if (action === 'resource-inspect' || action === 'resource-delete') {
    resourcePath = positional[1] ?? '';
    if (!resourcePath) {
      console.error(color.red(`Usage: gdeck editor ${action} <res://path.tres> [project]${action === 'resource-delete' ? ' --apply' : ''}`));
      return 1;
    }
    projectCandidate = positional[2];
  } else if (action === 'resource-create') {
    resourceClass = positional[1] ?? '';
    resourcePath = positional[2] ?? '';
    if (!resourceClass || !resourcePath) {
      console.error(color.red('Usage: gdeck editor resource-create <class> <res://path.tres> [project]'));
      return 1;
    }
    projectCandidate = positional[3];
  } else if (action === 'resource-set') {
    resourcePath = positional[1] ?? '';
    property = positional[2] ?? '';
    const rawValue = positional[3];
    if (!resourcePath || !property || rawValue === undefined) {
      console.error(color.red('Usage: gdeck editor resource-set <res://path.tres> <property> <json-value> [project]'));
      return 1;
    }
    try { value = JSON.parse(rawValue); } catch { value = rawValue; }
    projectCandidate = positional[4];
  } else if (action === 'resource-assign') {
    target = positional[1] ?? '.';
    property = positional[2] ?? '';
    resourcePath = positional[3] ?? '';
    if (!property || !resourcePath) {
      console.error(color.red('Usage: gdeck editor resource-assign <node-path> <property> <res://path.tres> [project]'));
      return 1;
    }
    projectCandidate = positional[4];
  } else if (action === 'create') {
    parent = positional[1] ?? '.';
    className = positional[2] ?? '';
    nodeName = positional[3] ?? '';
    if (!className || !nodeName) {
      console.error(color.red('Usage: gdeck editor create <parent-path> <class> <name> [project]'));
      return 1;
    }
    projectCandidate = positional[4];
  } else if (action === 'delete') {
    target = positional[1] ?? '';
    if (!target) {
      console.error(color.red('Usage: gdeck editor delete <node-path> [project] --apply'));
      return 1;
    }
    projectCandidate = positional[2];
  } else if (action === 'reorder') {
    target = positional[1] ?? '';
    index = Number(positional[2] ?? -1);
    if (!target || !Number.isInteger(index) || index < 0) {
      console.error(color.red('Usage: gdeck editor reorder <node-path> <index> [project]'));
      return 1;
    }
    projectCandidate = positional[3];
  } else {
    projectCandidate = positional[1];
  }
  const project = resolveProject(projectCandidate);
  const actionMeta = EDITOR_ACTION_CATALOG[action];
  // batch defaults to preview without --apply; other destructive actions hard-require --apply
  if (action !== 'batch' && actionMeta?.requiresApply && options.apply !== true) {
    console.error(color.red(`Editor action '${action}' is destructive. Re-run with --apply after explicit human approval.`));
    return 1;
  }
  if (action === 'batch' && options.apply === true && options['dry-run'] === true) {
    console.error(color.red('Conflicting flags: use either --dry-run (preview) or --apply (commit), not both.'));
    return 1;
  }
  // Batch defaults to preview unless --apply is present.
  const batchDryRun = action === 'batch' ? options.apply !== true : Boolean(options['dry-run']);
  if (action === 'batch' && batchDryRun) {
    if (!options.json) console.log(color.muted('Batch preview mode (no mutations). Pass --apply to commit after approval.'));
  }
  if (action === 'sessions') {
    const inventory = await inspectEditorSessions(project);
    if (options.json) console.log(JSON.stringify(inventory, null, 2));
    else {
      console.log(`Editor sessions for ${project}`);
      if (inventory.sessions.length === 0) console.log('  No session metadata found.');
      for (const session of inventory.sessions) console.log(`  ${session.state.padEnd(20)} ${session.file}: ${session.detail}`);
    }
    return 0;
  }
  if (action === 'cleanup-sessions') {
    const cleanup = cleanupEditorSessions(project);
    if (options.json) console.log(JSON.stringify(cleanup, null, 2));
    else {
      console.log(`Editor session cleanup for ${project}`);
      console.log(`  Removed:   ${cleanup.removed.length}`);
      console.log(`  Preserved: ${cleanup.preserved.length}`);
      for (const session of cleanup.removed) console.log(`  removed ${session.file}: ${session.detail}`);
    }
    return 0;
  }
  const config = loadConfig(project);
  const bridge = config.editorBridge ?? defaultConfig().editorBridge;
  const policy = resolveEditorBridgePolicy(bridge);
  if (action === 'batch') {
    // Preview and commit both enforce operation-level layer policy (no supplementary bypass).
    const batchGate = validateBatchOperations(batch?.operations ?? [], {
      // Preview may run with allowWrites=false; only enforce allowWrites when committing.
      allowWrites: batchDryRun ? true : policy.allowWrites,
      supplementaryEnabled: policy.supplementaryEnabled,
    });
    if (!batchGate.ok) {
      console.error(color.red(batchGate.error));
      return 1;
    }
    if (!batchDryRun && !policy.allowWrites) {
      console.error(color.red('Editor writes are disabled. Set editorBridge.allowWrites=true in .gdeck/config.json after human approval.'));
      return 1;
    }
  }
  if (actionMeta?.requiresAllowWrites && !policy.allowWrites && !(action === 'batch' && batchDryRun)) {
    console.error(color.red('Editor writes are disabled. Set editorBridge.allowWrites=true in .gdeck/config.json after human approval.'));
    return 1;
  }
  if (actionMeta?.requiresSupplementary && !policy.supplementaryEnabled) {
    console.error(color.red(`Editor action '${action}' requires editorBridge.supplementaryEnabled=true in .gdeck/config.json.`));
    return 1;
  }
  const endpoint = editorEndpoint(project, bridge);
  const bridgeHost = endpoint.host;
  if (bridgeHost !== '127.0.0.1') {
    console.error(color.red(`Editor bridge host must be exactly 127.0.0.1: ${bridgeHost}`));
    return 1;
  }
  const tokenPath = join(project, '.gdeck', 'editor-token');
  const requiresWriteIdentity = !EDITOR_READ_ACTIONS.has(action) && !(action === 'batch' && batchDryRun);
  if (requiresWriteIdentity && endpoint.session.status !== 'valid') {
    console.error(color.red(`Editor writes require valid live session metadata: ${endpoint.session.detail}. Restart the Editor before writing.`));
    return 1;
  }
  const expectedInstanceId = endpoint.session.status === 'valid' ? String(endpoint.session.data.instance_id) : '';
  if (!existsSync(tokenPath)) {
    console.error(color.red('Editor bridge token missing. Run gdeck init first.'));
    return 1;
  }
  const params = {
    path: target,
    property,
    value,
    parent,
    class: className,
    name: batch?.name ?? nodeName,
    index,
    resource: resourcePath,
    resource_class: resourceClass,
    operations: batch?.operations,
    dry_run: batchDryRun,
    // Bridge defense-in-depth: destructive/batch commit must carry confirm_apply.
    confirm_apply: options.apply === true,
    depth: Number(options.depth ?? 8),
    limit: Number(options.limit ?? 500),
  };
  try {
    const token = readFileSync(tokenPath, 'utf8').trim();
    if (action !== 'status') {
      const handshake = await requestEditorBridge({ host: bridgeHost, port: endpoint.port, token, expectedInstanceId, action: 'status', params: {} });
      const problem = bridgeHandshakeProblem(handshake, project, requiresWriteIdentity, requiresWriteIdentity ? endpoint.session.data : null);
      if (problem) {
        console.error(color.red(problem));
        return 1;
      }
      const bridgeVersion = String(handshake.version ?? handshake.result?.flight_deck_version ?? 'unknown');
      if (bridgeVersion !== TOOL_VERSION) console.error(color.yellow(`Editor bridge version mismatch: CLI ${TOOL_VERSION}, Editor ${bridgeVersion}; read-only action allowed.`));
    }
    const response = await requestEditorBridge({
      host: bridgeHost,
      port: endpoint.port,
      token,
      expectedInstanceId,
      action,
      params,
    });
    if (!response.ok) {
      console.error(color.red(`Editor bridge error: ${response.error ?? 'unknown error'}`));
      return 1;
    }
    if (action === 'status') {
      const problem = bridgeHandshakeProblem(response, project, false);
      if (problem) {
        console.error(color.red(problem));
        return 1;
      }
      const bridgeVersion = String(response.version ?? response.result?.flight_deck_version ?? 'unknown');
      if (bridgeVersion !== TOOL_VERSION) console.error(color.yellow(`Editor bridge version mismatch: CLI ${TOOL_VERSION}, Editor ${bridgeVersion}; read-only status allowed.`));
    }
    if (options.json) console.log(JSON.stringify(response.result, null, 2));
    else printEditorResult(action, response.result);
    return 0;
  } catch (error) {
    console.error(color.red(error.message));
    console.error(color.muted('Open the project in Godot Editor and ensure the Flight Deck plugin is enabled.'));
    return 1;
  }
}

function evidenceIndexCommand(projectCandidate, options) {
  const project = resolveProject(projectCandidate);
  const timeoutMs = options.timeout !== undefined ? Math.floor(Number(options.timeout) * 1000) : undefined;
  const limit = options.limit !== undefined ? Math.floor(Number(options.limit)) : undefined;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0)) {
    throw new Error('Evidence Index --timeout must be a non-negative number of seconds');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('Evidence Index --limit must be a positive integer');
  }
  const index = buildEvidenceIndex(project, {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  if (options.json) console.log(JSON.stringify(index, null, 2));
  else {
    console.log(`Evidence scan: ${index.scan.status} (${index.scan.filesObserved} files, ${index.scan.bytesObserved} bytes)`);
    if (index.counts) {
      console.log(`  Counts: sealed/bound=${index.counts.sealed_bound}, valid=${index.counts.valid}, stale=${index.counts.stale}, unverifiable=${index.counts.unverifiable}, invalid=${index.counts.invalid}, incomplete_journals=${index.counts.incomplete_journals}`);
    }
    for (const report of index.finalReports) {
      console.log(`  Final ${report.seal}/${report.freshness}: ${report.path}${report.reportedVerdict ? ` [reported ${report.reportedVerdict}]` : ''}`);
    }
    for (const journal of index.incompleteJournals) {
      console.log(`  Journal ${journal.seal}/${journal.freshness}: ${journal.path}`);
    }
  }
  // incomplete means budget truncated but retained valid finds — not a hard failure
  return index.scan.status === 'unverifiable' ? 1 : 0;
}

function validateInternalVerificationStage(argv) {
  const encoded = process.env.GDECK_INTERNAL_VERIFY_STAGE;
  if (!encoded) return null;
  delete process.env.GDECK_INTERNAL_VERIFY_STAGE;
  if (encoded.length > 8 * 1024) throw new Error('Internal verification stage context is too large');
  let context;
  try { context = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch (error) { throw new Error(`Invalid internal verification stage context: ${error.message}`); }
  if (context?.schemaVersion !== 2 || typeof context.project !== 'string' || typeof context.outputPath !== 'string'
    || typeof context.stageId !== 'string' || typeof context.planDigest !== 'string' || typeof context.executionProject !== 'string'
    || !/^[a-f0-9]{64}$/.test(context.invocationIdentity ?? '')
    || !Array.isArray(context.retentionCandidateManifest) || context.retentionCandidateManifest.length > 65
    || typeof context.outcomePath !== 'string' || !/^[a-f0-9]{64}$/.test(context.outcomeNonce ?? '')) {
    throw new Error('Invalid internal verification stage context');
  }
  const plan = resolveVerificationPlan({
    project: context.project,
    outputPath: context.outputPath,
    timeoutSeconds: context.timeoutSeconds,
    verificationProfile: context.verificationProfile,
    invocationIdentity: context.invocationIdentity,
    retentionCandidateManifest: context.retentionCandidateManifest,
    retentionEffectsMayBeFulfilled: true,
  });
  assertVerificationPlanDigest(plan, context.planDigest);
  const executionProject = resolveProject(context.executionProject);
  if (sameExistingPath(plan.project, executionProject)) throw new Error('Internal verification stage requires an immutable execution snapshot');
  const outcomePath = resolve(context.outcomePath);
  const snapshotRoot = realpathSync(dirname(executionProject));
  if (realpathSync(dirname(outcomePath)) !== snapshotRoot || !basename(outcomePath).startsWith('.gdeck-stage-outcome-')
    || pathContainsSymlink(dirname(outcomePath), outcomePath)) {
    throw new Error('Invalid internal stage outcome path');
  }
  setInternalStageOutcomeSink({ path: outcomePath, nonce: context.outcomeNonce });
  assertVerificationSnapshotInputs(plan, executionProject);
  const stage = plan.stages.find((item) => item.id === context.stageId);
  if (!stage || stage.disposition !== 'run') throw new Error(`Verification stage is no longer runnable: ${context.stageId}`);
  const expected = [...stage.commandArgs, '--timeout', String(stage.timeoutMs / 1000)];
  if (JSON.stringify(argv) !== JSON.stringify(expected)) {
    throw new Error(`Verification stage invocation does not match its Plan: ${context.stageId}`);
  }
  return { plan, stage, executionProject };
}

function extractInternalVerificationExpectation(argv) {
  const digestPrefix = '--gdeck-internal-verify-plan-digest=';
  const identityPrefix = '--gdeck-internal-invocation-identity=';
  const unitBindingPrefix = '--gdeck-internal-unit-binding=';
  const digestValues = argv.filter((argument) => argument.startsWith(digestPrefix));
  const identityValues = argv.filter((argument) => argument.startsWith(identityPrefix));
  const unitBindingValues = argv.filter((argument) => argument.startsWith(unitBindingPrefix));
  if (digestValues.length > 1) throw new Error('Duplicate internal verification plan digest');
  if (identityValues.length > 1) throw new Error('Duplicate internal verification invocation identity');
  if (unitBindingValues.length > 1) throw new Error('Duplicate internal Unit binding');
  const args = argv.filter((argument) => !argument.startsWith(digestPrefix)
    && !argument.startsWith(identityPrefix) && !argument.startsWith(unitBindingPrefix));
  if ((digestValues.length > 0 || identityValues.length > 0) && args[0] !== 'verify') {
    throw new Error('Internal verification bindings are valid only for verify');
  }
  if (unitBindingValues.length > 0 && args[0] !== 'unit') throw new Error('Internal Unit binding is valid only for unit');
  const expectedPlanDigest = digestValues.length === 0 ? '' : digestValues[0].slice(digestPrefix.length);
  if (expectedPlanDigest && !/^[a-f0-9]{64}$/.test(expectedPlanDigest)) throw new Error('Invalid internal verification plan digest');
  const invocationIdentity = identityValues.length === 0 ? '' : requireInvocationIdentity(identityValues[0].slice(identityPrefix.length));
  let unitBinding = null;
  if (unitBindingValues.length > 0) {
    try { unitBinding = JSON.parse(Buffer.from(unitBindingValues[0].slice(unitBindingPrefix.length), 'base64url').toString('utf8')); }
    catch { throw new Error('Invalid internal Unit binding'); }
    if (!unitExecutionBindingMatches(unitBinding, unitBinding)) throw new Error('Invalid internal Unit binding');
  }
  return { args, expectedPlanDigest, invocationIdentity, unitBinding };
}

function verificationStrategyFromArgs(argv) {
  let profile = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') profile = argv[index + 1] ?? '';
    else if (argv[index].startsWith('--profile=')) profile = argv[index].slice('--profile='.length);
  }
  return profile ? { mode: 'profile', profile } : { mode: 'legacy', profile: null };
}

function cliInvocationBudgetMilliseconds(rawArguments) {
  try {
    const internal = extractInternalVerificationExpectation(rawArguments);
    const parsed = parseCliArguments(internal.args);
    const timeoutMs = timeoutMilliseconds(parsed.options);
    if (parsed.command === 'verify') {
      const project = resolveProject(parsed.positional[0]);
      const outputPath = resolve(parsed.options.output ?? join(project, '.gdeck', 'reports', 'supervised-verification.json'));
      const plan = resolveVerificationPlan({
        project,
        outputPath,
        timeoutSeconds: parsed.options.timeout ?? DEFAULT_TIMEOUT_SECONDS,
        verificationProfile: parsed.options.profile,
        invocationIdentity: internal.invocationIdentity,
      });
      return verificationPlanExecutionBudgetMilliseconds(plan);
    }
    if (parsed.command === 'export') {
      const project = resolveProject(parsed.positional[1] ?? process.cwd());
      const config = loadConfig(project);
      const target = parsed.positional[0] ?? 'all';
      const targets = config.exports?.targets ?? defaultExports(project).targets;
      const targetCount = target === 'all' ? Math.max(1, Object.keys(targets).length) : 1;
      const nativeSmoke = macosNativeSmokeOptions(config.exports ?? defaultExports(project));
      const nativeSmokeBudget = nativeSmoke.enabled && (target === 'all' || target === 'macos') ? nativeSmoke.timeoutMs : 0;
      return (targetCount + 1) * timeoutMs + nativeSmokeBudget
        + (targetCount + 2) * PROCESS_CLEANUP_TIMEOUT_MS + 5_000;
    }
    if (parsed.command === 'visual-test') return 2 * timeoutMs + 5_000;
    return timeoutMs + 5_000;
  } catch {
    return 30_000;
  }
}

function cliInvocationLifecycleProjectRoots(rawArguments) {
  try {
    const internal = extractInternalVerificationExpectation(rawArguments);
    const parsed = parseCliArguments(internal.args);
    const candidate = parsed.command === 'verify' || parsed.command === 'unit' ? parsed.positional[0]
      : parsed.command === 'export' ? parsed.positional[1] ?? process.cwd() : null;
    return candidate ? [resolveProject(candidate)] : [];
  } catch { return []; }
}

function unitProgressTargetsForPlan(plan, verbosity) {
  const visibleStages = plan.stages.filter((stage) => stage.includeInLegacyReport);
  return visibleStages.flatMap((stage, index) => {
    if (stage.kind !== 'unit' || stage.disposition !== 'run' || !stage.reportPath) return [];
    const parsed = parseCliArguments(stage.commandArgs);
    return [{
      report: stage.reportPath,
      binding: unitBindingForExecution({
        project: plan.project,
        report: stage.reportPath,
        timeoutMs: stage.timeoutMs,
        options: parsed.options,
        invocationIdentity: plan.invocationIdentity,
        ownerNonce: verificationUnitOwnerNonce(plan, stage),
      }),
      verbosity,
      stageOrdinal: index + 1,
      stageTotal: visibleStages.length,
    }];
  });
}

function startUnitProgressObserver(targets, render = (line) => console.error(line)) {
  const states = targets.map((target) => ({
    ...target,
    stream: createUnitProgressStream({
      verbosity: target.verbosity,
      timeoutMs: target.binding?.timeout_ms ?? target.timeoutMs,
    }),
    observed: false,
    rendererFailed: false,
    finished: false,
    displayedUpdates: 0,
  }));
  const poll = () => {
    for (const state of states) {
      if (state.finished) continue;
      try {
        if (!existsSync(state.report)) continue;
        const report = readUnitReportStable(state.report, 256 * 1024);
        const disposition = unitReportDisposition(report, report?.schema_version === 2 ? state.binding : undefined);
        if (disposition.state === 'terminal' || disposition.state === 'corrupt') {
          state.finished = true;
          continue;
        }
        const projected = projectUnitProgress(report, state.binding, {
          verbosity: state.verbosity,
          stageOrdinal: state.stageOrdinal,
          stageTotal: state.stageTotal,
        });
        const sequence = report?.progress?.sequence;
        if (!projected || !Number.isInteger(sequence)) continue;
        const accepted = state.stream.observe(projected, sequence);
        if (!accepted) continue;
        state.observed = true;
        state.displayedUpdates += 1;
        const current = accepted.unit.current
          ? `; current #${accepted.unit.current.ordinal}${state.verbosity === 'compact' ? '' : (accepted.unit.current.token ? ` ${accepted.unit.current.token}` : '')}` : '';
        const privateReference = state.verbosity === 'diagnostic' ? `; private report ${state.report}` : '';
        try {
          const total = accepted.unit.total === null ? '?' : accepted.unit.total;
          render(`Unit progress ${accepted.stage.ordinal}/${accepted.stage.total}: ${accepted.unit.completed}/${total} cases; elapsed ${accepted.elapsedMs} ms${current}${privateReference}`);
        } catch { state.rendererFailed = true; }
      } catch { /* incomplete progress is best-effort and never affects execution */ }
    }
  };
  poll();
  const timer = setInterval(poll, 250);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      poll();
      const disclosures = [];
      for (const state of states) {
        if (!state.observed) continue;
        const terminal = state.stream.finish();
        const snapshot = state.stream.snapshot();
        const displayed = snapshot.displayedUpdates ?? state.displayedUpdates;
        disclosures.push(`Unit progress updates displayed: ${displayed}.`);
        if (terminal?.progressTruncated || snapshot.progressTruncated) disclosures.push('Unit progress was rate-limited or truncated.');
        if (state.rendererFailed) disclosures.push('Unit progress renderer failed; execution and evidence were unaffected.');
      }
      return [...new Set(disclosures)];
    },
  };
}

function insertInvocationOptions(rawArguments, options) {
  // Preserve the caller's end-of-options marker. Coordinator-generated flags
  // must remain options when the invocation is parsed again by main().
  const separator = rawArguments.indexOf('--');
  const insertion = separator < 0 ? rawArguments.length : separator;
  return [...rawArguments.slice(0, insertion), ...options, ...rawArguments.slice(insertion)];
}

async function prepareCoordinatedInvocation(rawArguments) {
  if (rawArguments.some((argument) => argument.startsWith('--gdeck-internal-invocation-identity=')
    || argument.startsWith('--gdeck-internal-verify-plan-digest=')
    || argument.startsWith('--gdeck-internal-unit-binding='))) {
    const error = new Error('Internal verification bindings cannot be supplied by a direct caller');
    error.exitCode = 1;
    throw error;
  }
  let coordinatedArguments = rawArguments;
  let timeoutMs;
  let coordinatedVerificationPlan;
  let coordinatedUnit;
  if (rawArguments[0] === 'verify') {
    const parsed = parseCliArguments(rawArguments);
    const project = resolveProject(parsed.positional[0]);
    const outputPath = resolve(parsed.options.output ?? join(project, '.gdeck', 'reports', `verify-${timestamp()}.json`));
    const invocationIdentity = generateInvocationIdentity();
    const plan = resolveVerificationPlan({
      project,
      outputPath,
      timeoutSeconds: parsed.options.timeout ?? DEFAULT_TIMEOUT_SECONDS,
      verificationProfile: parsed.options.profile,
      invocationIdentity,
    });
    coordinatedVerificationPlan = plan;
    coordinatedArguments = insertInvocationOptions(rawArguments, [
      ...(parsed.options.output === undefined ? ['--output', outputPath] : []),
      `--gdeck-internal-verify-plan-digest=${plan.digest}`,
      `--gdeck-internal-invocation-identity=${invocationIdentity}`,
    ]);
    timeoutMs = verificationPlanExecutionBudgetMilliseconds(plan);
  } else if (rawArguments[0] === 'unit') {
    const parsed = parseCliArguments(rawArguments);
    const project = resolveProject(parsed.positional[0]);
    const report = resolve(parsed.options.output ?? join(project, '.gdeck', 'reports', `unit-${timestamp()}.json`));
    const invocationIdentity = generateInvocationIdentity();
    const ownerNonce = randomBytes(32).toString('hex');
    const binding = unitBindingForExecution({
      project,
      report,
      timeoutMs: timeoutMilliseconds(parsed.options),
      options: parsed.options,
      invocationIdentity,
      ownerNonce,
    });
    coordinatedUnit = { project, report, binding, verbosity: normalizeVerbosity(parsed.options.verbosity, 'compact') };
    coordinatedArguments = insertInvocationOptions(rawArguments, [
      ...(parsed.options.output === undefined ? ['--output', report] : []),
      `--gdeck-internal-unit-binding=${Buffer.from(JSON.stringify(binding)).toString('base64url')}`,
    ]);
    timeoutMs = cliInvocationBudgetMilliseconds(coordinatedArguments);
  } else {
    timeoutMs = cliInvocationBudgetMilliseconds(coordinatedArguments);
  }
  return { coordinatedArguments, timeoutMs, coordinatedVerificationPlan, coordinatedUnit };
}

async function runCursorCompatInvocation(rawArguments) {
  let prepared;
  try {
    prepared = await prepareCoordinatedInvocation(rawArguments);
  } catch (error) {
    if (rawArguments[0] === 'verify') {
      console.error(renderResultEnvelopeText(buildResultEnvelope({
        strategy: verificationStrategyFromArgs(rawArguments),
        event: {
          classification: error.resultClassification ?? 'configuration',
          source: error.resultSource ?? 'preflight',
          summary: error.message,
        },
      })));
    }
    console.error(color.red(`Flight Deck: ${error.message}`));
    return Number(error.exitCode ?? 1);
  }
  const { coordinatedArguments, coordinatedVerificationPlan, coordinatedUnit } = prepared;
  const progressTargets = coordinatedUnit ? [{
    ...coordinatedUnit,
    stageOrdinal: 1,
    stageTotal: 1,
  }] : coordinatedVerificationPlan
    ? unitProgressTargetsForPlan(coordinatedVerificationPlan, normalizeVerbosity(parseCliArguments(rawArguments).options.verbosity, 'compact'))
    : [];
  const progressObserver = startUnitProgressObserver(progressTargets);
  const stageProgressObserver = coordinatedVerificationPlan ? startVerificationProgressObserver({
    plan: coordinatedVerificationPlan,
    verbosity: normalizeVerbosity(parseCliArguments(rawArguments).options.verbosity, 'compact'),
    render: (progress) => console.error(renderVerificationProgress(progress)),
  }) : null;

  const originalArgv = process.argv.slice();
  process.argv = [originalArgv[0], originalArgv[1], ...coordinatedArguments];
  process.exitCode = 0;
  try {
    await main();
  } finally {
    process.argv = originalArgv;
    for (const disclosure of progressObserver.stop()) console.error(disclosure);
    const stageProgress = stageProgressObserver?.stop();
    if (stageProgress?.truncated) console.error('Verify stage progress was truncated.');
    if (stageProgress?.rendererFailed) console.error('Verify stage progress renderer failed; execution and evidence were unaffected.');
  }
  const finalStatus = Number(process.exitCode ?? 0);
  if (coordinatedVerificationPlan && (finalStatus !== 0 || !existsSync(coordinatedVerificationPlan.outputPath))) {
    const interruption = projectVerificationJournalSeal(coordinatedVerificationPlan.evidenceBinding.journalPath);
    if (interruption.seal !== 'sealed') {
      console.error('Incremental evidence (non-authoritative):');
      console.error(`  Integrity: ${interruption.integrity}; seal: ${interruption.seal}`);
      console.error(`  Preflight observed: ${interruption.preflightObserved === true ? 'yes' : 'no'}; completed stages: ${interruption.completedStageCount ?? 0}`);
      if (interruption.currentStage) {
        console.error(`  Current stage: ${interruption.currentStage.ordinal} (${interruption.currentStage.stageId})`);
      }
    }
  }
  return finalStatus;
}

async function superviseCliInvocation(rawArguments) {
  let prepared;
  try {
    prepared = await prepareCoordinatedInvocation(rawArguments);
  } catch (error) {
    if (rawArguments[0] === 'verify') {
      console.error(renderResultEnvelopeText(buildResultEnvelope({
        strategy: verificationStrategyFromArgs(rawArguments),
        event: {
          classification: error.resultClassification ?? 'configuration',
          source: error.resultSource ?? 'preflight',
          summary: error.message,
        },
      })));
    }
    console.error(color.red(`Flight Deck: ${error.message}`));
    return Number(error.exitCode ?? 1);
  }
  const { coordinatedArguments, timeoutMs, coordinatedVerificationPlan, coordinatedUnit } = prepared;
  const progressTargets = coordinatedUnit ? [{
    ...coordinatedUnit,
    stageOrdinal: 1,
    stageTotal: 1,
  }] : coordinatedVerificationPlan
    ? unitProgressTargetsForPlan(coordinatedVerificationPlan, normalizeVerbosity(parseCliArguments(rawArguments).options.verbosity, 'compact'))
    : [];
  const progressObserver = startUnitProgressObserver(progressTargets);
  const stageProgressObserver = coordinatedVerificationPlan ? startVerificationProgressObserver({
    plan: coordinatedVerificationPlan,
    verbosity: normalizeVerbosity(parseCliArguments(rawArguments).options.verbosity, 'compact'),
    render: (progress) => console.error(renderVerificationProgress(progress)),
  }) : null;
  const specification = JSON.stringify({
    executable: process.execPath,
    args: [CLI_FILE, ...coordinatedArguments],
    cwd: process.cwd(),
    env: { ...process.env },
    timeoutMs,
    cleanupTimeoutMs: PROCESS_CLEANUP_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024 * 1024,
    phase: 'cli_invocation',
    nonce: randomBytes(32).toString('hex'),
    propagateLifecycleRegistry: true,
    lifecycleProjectRoots: cliInvocationLifecycleProjectRoots(coordinatedArguments),
  });
  const supervisor = spawn(process.execPath, [PROCESS_RUNNER, '--spec-stdin'], { stdio: ['pipe', 'inherit', 'inherit'] });
  supervisor.stdin.on('error', () => { /* supervisor startup failure is reported through its exit */ });
  supervisor.stdin.end(specification);
  let watchdogEscalation;
  let watchdogExpired = false;
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    supervisor.kill('SIGTERM');
    watchdogEscalation = setTimeout(() => supervisor.kill('SIGKILL'), PROCESS_CLEANUP_TIMEOUT_MS + PROCESS_WATCHDOG_GRACE_MS);
  }, timeoutMs + PROCESS_CLEANUP_TIMEOUT_MS + PROCESS_WATCHDOG_GRACE_MS);
  const forwardedSignals = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => supervisor.kill(signal);
    forwardedSignals.set(signal, handler);
    process.on(signal, handler);
  }
  const status = await new Promise((resolveStatus) => {
    supervisor.once('error', () => resolveStatus(127));
    supervisor.once('exit', (code, signal) => resolveStatus(code ?? (signal ? 128 : 1)));
  });
  clearTimeout(watchdog);
  if (watchdogEscalation) clearTimeout(watchdogEscalation);
  for (const [signal, handler] of forwardedSignals) process.off(signal, handler);
  for (const disclosure of progressObserver.stop()) console.error(disclosure);
  const stageProgress = stageProgressObserver?.stop();
  if (stageProgress?.truncated) console.error('Verify stage progress was truncated.');
  if (stageProgress?.rendererFailed) console.error('Verify stage progress renderer failed; execution and evidence were unaffected.');
  const finalStatus = watchdogExpired ? 125 : status;
  if (coordinatedVerificationPlan && (finalStatus !== 0 || !existsSync(coordinatedVerificationPlan.outputPath))) {
    const interruption = projectVerificationJournalSeal(coordinatedVerificationPlan.evidenceBinding.journalPath);
    if (interruption.seal !== 'sealed') {
      console.error('Incremental evidence (non-authoritative):');
      console.error(`  Integrity: ${interruption.integrity}; seal: ${interruption.seal}`);
      console.error(`  Preflight observed: ${interruption.preflightObserved === true ? 'yes' : 'no'}; completed stages: ${interruption.completedStageCount ?? 0}`);
      if (interruption.currentStage) {
        console.error(`  Current stage: ${interruption.currentStage.ordinal} (${interruption.currentStage.stageId})`);
      }
    }
  }
  return finalStatus;
}

async function main() {
  const rawArguments = process.argv.slice(2);
  try {
    const internalVerification = extractInternalVerificationExpectation(process.argv.slice(2));
    const internalVerificationStage = validateInternalVerificationStage(internalVerification.args);
    const parsed = parseCliArguments(internalVerification.args);
    let status = 0;
    switch (parsed.command) {
      case 'help':
      case '--help':
      case '-h':
        printHelp(parsed.options.domain ?? parsed.positional[0]);
        break;
      case 'version':
        console.log(TOOL_VERSION);
        break;
      case 'describe':
        describeCommand(parsed.positional[0], parsed.options.json === true);
        break;
      case 'init':
        initProject(parsed.positional[0]);
        break;
      case 'sync-addon':
        // Reuses init's transactional addon install + config version bump.
        initProject(parsed.positional[0]);
        break;
      case 'doctor':
        status = await doctor(parsed.positional[0], parsed.options, internalVerificationStage);
        break;
      case 'evidence-index':
        status = evidenceIndexCommand(parsed.positional[0], parsed.options);
        break;
      case 'check':
        status = await checkProject(parsed.positional[0], parsed.options, internalVerificationStage);
        break;
      case 'class-info':
        status = await classInfoCommand(parsed.positional[0], parsed.positional[1], parsed.options);
        break;
      case 'run':
        status = await runProject(parsed.positional[0], parsed.options, parsed.passthrough);
        break;
      case 'capture':
        status = await captureProject(parsed.positional, parsed.options);
        break;
      case 'benchmark':
        status = await benchmarkProject(parsed.positional, parsed.options, internalVerificationStage);
        break;
      case 'scenario':
        status = await runScenario(parsed.positional, parsed.options, internalVerificationStage);
        break;
      case 'baseline':
        status = await baselineProject(parsed.positional, parsed.options);
        break;
      case 'visual-test':
        status = await visualTest(parsed.positional, parsed.options, internalVerificationStage);
        break;
      case 'verify':
        status = await verifyProject(
          parsed.positional[0], parsed.options, internalVerification.expectedPlanDigest, internalVerification.invocationIdentity,
        );
        break;
      case 'oracle-verify':
        status = oracleVerify(parsed.positional[0], parsed.options);
        break;
      case 'templates':
        status = await templatesCommand(parsed.positional, parsed.options);
        break;
      case 'export-init':
        status = exportInit(parsed.positional[0]);
        break;
      case 'export':
        status = await exportProject(parsed.positional, parsed.options, internalVerificationStage);
        break;
      case 'unit':
        status = await runUnitTests(parsed.positional[0], parsed.options, internalVerificationStage, internalVerification.unitBinding);
        break;
      case 'scene':
        status = parsed.positional[0] === 'set'
          ? await sceneSet(parsed.positional, parsed.options, internalVerificationStage)
          : parsed.positional[0] === 'restore'
            ? sceneRestore(parsed.positional, parsed.options, internalVerificationStage)
            : await sceneDoctor(parsed.positional, parsed.options, internalVerificationStage);
        break;
      case 'editor':
        status = await editorCommand(parsed.positional, parsed.options);
        break;
      default:
        throw new Error(`Unknown command: ${parsed.command}`);
    }
    process.exitCode = status;
  } catch (error) {
    if (error.resultClassification) {
      publishInternalStageOutcome(error.resultClassification, error.resultSource ?? 'preflight', error.message);
    }
    if (rawArguments[0] === 'verify') {
      const envelope = error.resultReport?.resultEnvelope ?? buildResultEnvelope({
        report: error.resultReport,
        strategy: verificationStrategyFromArgs(rawArguments),
        event: {
          classification: error.resultClassification ?? 'configuration',
          source: error.resultSource ?? 'preflight',
          summary: error.message,
        },
      });
      console.error(renderResultEnvelopeText(envelope));
    }
    console.error(color.red(`Flight Deck: ${error.message}`));
    process.exitCode = Number(error.exitCode ?? 1);
  }
}

if (privateLifecycleRegistry()) {
  // An MCP supervisor owns cleanup, but has not prepared Unit/Verify bindings.
  // Only skip coordination when this is already a coordinated child invocation.
  const invocationArgs = process.argv.slice(2);
  const alreadyCoordinated = invocationArgs.some((argument) => argument.startsWith('--gdeck-internal-'))
    || Boolean(process.env.GDECK_INTERNAL_VERIFY_STAGE);
  if (['unit', 'verify'].includes(invocationArgs[0]) && !alreadyCoordinated) {
    process.exitCode = await runCursorCompatInvocation(invocationArgs);
  } else {
    await main();
  }
} else if (cursorCompatEnabled()) {
  // Agent-shell compat (GDECK_CURSOR_COMPAT=1): prepare unit/verify bindings in-process, skip nested Job supervisors.
  process.exitCode = await runCursorCompatInvocation(process.argv.slice(2));
} else {
  process.exitCode = await superviseCliInvocation(process.argv.slice(2));
}
