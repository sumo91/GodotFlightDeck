import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, timeoutMilliseconds } from './execution.mjs';
import { createLifecycleTemporaryDirectory, removeLifecycleTemporaryDirectory } from './lifecycle-resources.mjs';
import { findGodot, loadConfig, resolveProject } from './project-config.mjs';
import { ERROR_PATTERN, TOOL_ROOT } from './tool-context.mjs';

const memberKinds = ['methods', 'properties', 'signals'];

export async function queryClassInfo(className, projectCandidate, options = {}) {
  const report = { schemaVersion: 1, command: 'class-info', scope: 'builtin_engine_classes', metadataSource: 'ClassDB', className,
    status: 'error', complete: false, issues: [] };
  let directory;
  let exitCode = 1;
  try {
    report.project = resolveProject(projectCandidate);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(className ?? '')) throw new Error('Expected an engine class name, for example Control');
    const timeoutMs = timeoutMilliseconds(options);
    const executable = findGodot(loadConfig(report.project), options.godot);
    report.engine = { requestedExecutable: executable };
    directory = createLifecycleTemporaryDirectory('gdeck-class-info-');
    writeFileSync(join(directory, 'project.godot'), 'config_version=5\n');
    const output = join(directory, 'class-info.json');
    const processResult = await runProcess(executable, ['--headless', '--path', directory,
      '--script', join(TOOL_ROOT, 'godot', 'class_info.gd'), '--', className, output], {
      cwd: directory, quiet: true, timeoutMs, phase: 'class-info',
      env: { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
        XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory },
    });
    if (processResult.status !== 0 || processResult.outputTruncated || ERROR_PATTERN.test(processResult.output)) {
      exitCode = processResult.status || 1;
      report.issues.push({ code: processResult.cancelled ? 'cancelled' : ({ 124: 'timeout', 125: 'cleanup_timeout', 127: 'process_spawn' })[exitCode] ?? 'engine_execution',
        message: `Engine query did not complete cleanly (exit ${processResult.status}${processResult.outputTruncated ? ', output truncated' : ''}).` });
    } else {
      const data = JSON.parse(readFileSync(output, 'utf8'));
      if (data.schemaVersion !== 1 || data.className !== className || !data.engine?.executable || !data.engine?.version?.string
        || !['ok', 'incomplete', 'error'].includes(data.status) || typeof data.complete !== 'boolean'
        || !Array.isArray(data.issues) || !Array.isArray(data.inheritance) || memberKinds.some(kind => !Array.isArray(data[kind]))
        || data.complete !== (data.status === 'ok')
        || (data.status === 'ok' && (data.issues.length || !data.methods.length))) {
        throw new Error('Engine returned an invalid or incomplete class-info report');
      }
      Object.assign(report, data, { engine: { ...data.engine, requestedExecutable: executable } });
      const filter = String(options.filter ?? '').toLowerCase();
      const total = Object.fromEntries(memberKinds.map(kind => [kind, report[kind].length]));
      for (const kind of memberKinds) report[kind] = report[kind].filter(item => item.name.toLowerCase().includes(filter));
      report.selection = { filter: String(options.filter ?? ''), total, returned: Object.fromEntries(memberKinds.map(kind => [kind, report[kind].length])) };
      exitCode = report.status === 'ok' && report.complete ? 0 : 1;
    }
  } catch (error) {
    report.status = 'error';
    report.complete = false;
    report.issues.push({ code: 'query_error', message: error.message });
  } finally {
    if (directory) {
      try { removeLifecycleTemporaryDirectory(directory); }
      catch (error) {
        report.status = 'error'; report.complete = false; exitCode = 125;
        report.issues.push({ code: 'cleanup_timeout', message: error.message });
      }
    }
  }
  return { report, exitCode };
}

function typeLabel(info) { return info?.class_name || info?.typeName || '?'; }

export function renderClassInfo(report) {
  const lines = [`${report.className}: ${report.status} (${report.scope})`];
  if (report.engine) lines.push(`Engine: ${report.engine.version?.string ?? '(version unavailable)'} — ${report.engine.executable ?? report.engine.requestedExecutable}`);
  if (report.inheritance) lines.push(`Inheritance: ${[report.className, ...report.inheritance].join(' < ')}`);
  if (report.selection) lines.push(`Member filter: ${JSON.stringify(report.selection.filter)}; returned ${Object.values(report.selection.returned).reduce((a, b) => a + b, 0)} of ${Object.values(report.selection.total).reduce((a, b) => a + b, 0)}`);
  for (const kind of memberKinds) {
    for (const item of report[kind] ?? []) {
      if (kind === 'properties') lines.push(`property ${item.name}: ${typeLabel(item)} [${item.declaredIn}]`);
      else {
        const defaults = item.default_args ?? [];
        const args = item.args?.map((arg, index) => {
          const value = defaults[index - item.args.length + defaults.length];
          return `${arg.name}: ${typeLabel(arg)}${value ? ` = ${value.text}` : ''}`;
        }).join(', ') ?? '?';
        const flags = item.flags ?? 0;
        lines.push(`${kind === 'signals' ? 'signal' : `${flags & 32 ? 'static ' : ''}method`} ${item.name}(${args}${flags & 16 ? `${args ? ', ' : ''}...` : ''})${kind === 'methods' ? ` -> ${typeLabel(item.return)}` : ''} [${item.declaredIn}]`);
      }
    }
  }
  for (const issue of report.issues) lines.push(`${issue.code}: ${issue.message ?? `${issue.member}: missing ${issue.fields?.join(', ')}`}`);
  return lines.join('\n');
}

export async function classInfoCommand(className, project, options) {
  const { report, exitCode } = await queryClassInfo(className, project, options);
  console.log(options.json ? JSON.stringify(report, null, 2) : renderClassInfo(report));
  return exitCode;
}
