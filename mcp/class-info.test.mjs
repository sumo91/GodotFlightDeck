import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryClassInfo, renderClassInfo } from '../cli/class-info.mjs';
import { parseCliArguments, publicCommandDescription } from '../registry/commands.mjs';

test('class-info is discoverable and rejects unsupported command options', () => {
  const parsed = parseCliArguments(['class-info', 'Control', '/some project', '--filter', 'anchor', '--json']);
  assert.deepEqual(parsed.positional, ['Control', '/some project']);
  assert.equal(parsed.options.filter, 'anchor');
  assert.equal(publicCommandDescription('class-info').options.json.takesValue, false);
  assert.throws(() => parseCliArguments(['class-info']), /positional/);
  assert.throws(() => parseCliArguments(['class-info', 'Control', '--apply']), /Unsupported/);
});

const metadata = {
  schemaVersion: 1, className: 'Control', complete: true, status: 'ok', issues: [], apiType: 'core',
  engine: { executable: '/actual/godot', version: { string: '4.7.2-test' } }, inheritance: ['CanvasItem', 'Node', 'Object'],
  methods: [{ name: 'set_anchors_preset', declaredIn: 'Control', flags: 1,
    args: [{ name: 'preset', class_name: 'Control.LayoutPreset', typeName: 'int' }, { name: 'keep_offsets', typeName: 'bool' }],
    default_args: [{ typeName: 'bool', text: 'false' }], return: { typeName: 'void' } }],
  properties: [{ name: 'name', declaredIn: 'Node', typeName: 'StringName' }],
  signals: [{ name: 'gui_input', declaredIn: 'Control', args: [{ name: 'event', class_name: 'InputEvent' }], flags: 1 }],
};

test('text includes inheritance, types, default values, signals and declaration owners', () => {
  const text = renderClassInfo({ ...metadata, scope: 'builtin_engine_classes' });
  assert.match(text, /Control < CanvasItem < Node < Object/);
  assert.match(text, /set_anchors_preset\(preset: Control.LayoutPreset, keep_offsets: bool = false\) -> void \[Control\]/);
  assert.match(text, /property name: StringName \[Node\]/);
  assert.match(text, /signal gui_input\(event: InputEvent\) \[Control\]/);
});

test('selected engine, incomplete reports and process failures preserve truthful results and cleanup',
  { skip: process.platform === 'win32', timeout: 30000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gdeck-class-info-test-'));
    const project = join(root, 'project');
    const invocation = join(root, 'invocation.json');
    const oldBin = process.env.GODOT_BIN;
    mkdirSync(join(project, '.gdeck'), { recursive: true });
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
    const fake = (name, body = '') => {
      const path = join(root, name);
      writeFileSync(path, `#!${process.execPath}\nconst fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({engine: ${JSON.stringify(name)}, cwd: process.cwd(), args: process.argv.slice(2)}));
const report = ${JSON.stringify(metadata)};
${body}
fs.writeFileSync(process.argv.at(-1), JSON.stringify(report));\n`, { mode: 0o700 });
      return path;
    };
    const assertCleaned = () => assert.equal(existsSync(JSON.parse(readFileSync(invocation)).cwd), false);
    try {
      delete process.env.GODOT_BIN;
      const configEngine = fake('configured');
      writeFileSync(join(project, '.gdeck/config.json'), JSON.stringify({ godotPath: configEngine }));
      let result = await queryClassInfo('Control', project, { filter: 'ANCHOR' });
      assert.equal(result.exitCode, 0);
      assert.equal(result.report.engine.requestedExecutable, configEngine);
      assert.equal(result.report.engine.executable, '/actual/godot');
      assert.equal(result.report.methods.length, 1);
      assert.equal(result.report.signals.length, 0);
      assert.equal(result.report.selection.total.signals, 1);
      assertCleaned();
      const envEngine = fake('environment');
      process.env.GODOT_BIN = envEngine;
      result = await queryClassInfo('Control', project, {});
      assert.equal(result.report.engine.requestedExecutable, envEngine);
      const override = fake('override');
      result = await queryClassInfo('Control', project, { godot: override, filter: 'no_matching_members' });
      assert.equal(result.exitCode, 0);
      assert.equal(result.report.complete, true);
      assert.equal(result.report.engine.requestedExecutable, override);
      assert.deepEqual(result.report.selection.returned, { methods: 0, properties: 0, signals: 0 });
      assertCleaned();

      for (const [name, body, status, code, exitCode] of [
        ['missing-metadata', 'report.complete=false;report.status="incomplete";report.issues=[{code:"metadata_missing",member:"Control.foo",fields:["args"]}];', 'incomplete', 'metadata_missing', 1],
        ['unknown', 'report.complete=false;report.status="error";report.issues=[{code:"class_not_found"}];', 'error', 'class_not_found', 1],
        ['extension', 'report.complete=false;report.status="error";report.issues=[{code:"class_out_of_scope"}];', 'error', 'class_out_of_scope', 1],
        ['no-report', 'process.exit(0);', 'error', 'query_error', 1],
        ['malformed', 'delete report.engine;', 'error', 'query_error', 1],
        ['empty-metadata', 'report.methods=[];', 'error', 'query_error', 1],
        ['engine-error', 'console.error("SCRIPT ERROR: injected error");', 'error', 'engine_execution', 1],
        ['nonzero', 'process.exit(9);', 'error', 'engine_execution', 9],
        ['timeout', 'setInterval(()=>{},1000);', 'error', 'timeout', 124],
      ]) {
        result = await queryClassInfo('Control', project, { godot: fake(name, body), timeout: name === 'timeout' ? 0.2 : 3 });
        assert.equal(result.exitCode, exitCode, name);
        assert.equal(result.report.status, status, name);
        assert.equal(result.report.complete, false, name);
        assert.equal(result.report.issues[0].code, code, name);
        assertCleaned();
      }
      const broken = join(root, 'unlaunchable');
      writeFileSync(broken, '#!/missing/interpreter\n', { mode: 0o700 });
      result = await queryClassInfo('Control', project, { godot: broken });
      assert.equal(result.exitCode, 127);
      assert.equal(result.report.issues[0].code, 'process_spawn');
      assert.equal((await queryClassInfo('res://custom.gd', project)).report.complete, false);
      assert.equal(existsSync(join(project, '.godot')), false);
    } finally {
      if (oldBin === undefined) delete process.env.GODOT_BIN; else process.env.GODOT_BIN = oldBin;
      rmSync(root, { recursive: true, force: true });
    }
  });
