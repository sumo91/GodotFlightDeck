import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../cli/execution.mjs';

const cli = fileURLToPath(new URL('../cli/gdeck.mjs', import.meta.url));

test('real engine reflection agrees with live objects and supports actual API calls',
  { skip: !process.env.GODOT_BIN, timeout: 60000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gdeck-class-info-godot-'));
    const project = join(root, 'project');
    const sandbox = join(root, 'sandbox');
    mkdirSync(project); mkdirSync(sandbox);
    const projectText = 'config_version=5\n[autoload]\nMustNotRun="*res://hostile.gd"\n';
    writeFileSync(join(project, 'project.godot'), projectText);
    writeFileSync(join(project, 'hostile.gd'), 'extends Node\nfunc _init():\n\tassert(false, "class-info loaded a project autoload")\n');
    writeFileSync(join(project, 'custom.gd'), 'class_name CustomProjectClass\nextends Node\n');
    writeFileSync(join(sandbox, 'project.godot'), 'config_version=5\n');
    const env = { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root };
    const invoke = async (name, extra = [], expectedStatus = 0) => {
      const result = await runProcess(process.execPath, [cli, 'class-info', name, project, '--json', ...extra], { quiet: true, timeoutMs: 10000, env });
      assert.equal(result.status, expectedStatus, result.output);
      const data = JSON.parse(result.stdout);
      assert.equal(data.engine.version.major, 4);
      assert.equal(data.className, name);
      return data;
    };
    try {
      const queries = [];
      for (const name of ['Control', 'Resource', 'Node3D', 'Button']) queries.push(await invoke(name));
      const [control, resource, node3d, button] = queries;
      assert.equal(control.methods.find(m => m.name === 'get_children').declaredIn, 'Node');
      assert.equal(control.methods.find(m => m.name === 'get_meta').return.typeName, 'Variant');
      assert.equal(control.methods.find(m => m.name === 'set_meta').return.typeName, 'void');
      assert.equal(resource.signals.find(s => s.name === 'changed').declaredIn, 'Resource');
      assert.equal(button.signals.find(s => s.name === 'pressed').declaredIn, 'BaseButton');
      const lookAt = node3d.methods.find(m => m.name === 'look_at');
      assert.deepEqual(lookAt.default_args.map(v => v.typeName), ['Vector3', 'bool']);
      assert.match(lookAt.default_args[0].text, /^Vector3\(/);
      const editor = await invoke('EditorPlugin', ['--filter', 'add_tool_menu_item']);
      assert.equal(editor.apiType, 'editor');
      assert.equal(editor.methods[0].name, 'add_tool_menu_item');
      for (const name of ['NoSuchBuiltInClass', 'CustomProjectClass', 'Vector2']) {
        const data = await invoke(name, [], 1);
        assert.equal(data.complete, false);
        assert.equal(data.issues[0].code, 'class_not_found');
      }
      assert.equal(existsSync(join(project, '.godot')), false);
      assert.equal(readFileSync(join(project, 'project.godot'), 'utf8'), projectText);

      writeFileSync(join(sandbox, 'queries.json'), JSON.stringify(queries));
      writeFileSync(join(sandbox, 'exercise.gd'), `extends SceneTree
var checks := 0
var failures: Array = []
func expect(value: bool, message: String) -> void:
 checks += 1
 if not value: failures.append(message)
func _initialize() -> void:
 _exercise.call_deferred()
func _exercise() -> void:
 var queries = JSON.parse_string(FileAccess.get_file_as_string("res://queries.json"))
 for query in queries:
  var instance = ClassDB.instantiate(query.className)
  var live_methods := {}
  for entry in instance.get_method_list(): live_methods[entry.name] = entry
  expect(query.methods.size() == live_methods.size(), query.className + " method count")
  for method in query.methods:
   expect(live_methods.has(method.name), query.className + "." + method.name)
   if not live_methods.has(method.name): continue
   var live = live_methods[method.name]
   expect(method.flags == live.flags, method.name + " flags")
   expect(method.args.size() == live.args.size(), method.name + " args")
   expect(method["return"].type == live["return"].type, method.name + " return")
   for i in range(live.args.size()):
    expect(method.args[i].name == live.args[i].name and method.args[i].type == live.args[i].type and method.args[i].class_name == live.args[i].class_name, method.name + " argument type/name")
   expect(method.default_args.size() == live.default_args.size(), method.name + " defaults")
   for i in range(live.default_args.size()):
    expect(method.default_args[i].type == typeof(live.default_args[i]) and method.default_args[i].text == var_to_str(live.default_args[i]), method.name + " default value")
  var live_properties := {}
  for entry in instance.get_property_list():
   live_properties[entry.name] = entry
  # Instances add dynamic script/theme properties; compare the registered API separately.
  var registered_properties := {}
  for entry in ClassDB.class_get_property_list(query.className):
   if not entry.usage & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP): registered_properties[entry.name] = entry
  expect(query.properties.size() == registered_properties.size(), query.className + " property count")
  for property in query.properties:
   expect(live_properties.has(property.name) and live_properties[property.name].type == property.type, property.name + " property type")
  var live_signals := {}
  for entry in instance.get_signal_list(): live_signals[entry.name] = entry
  expect(query.signals.size() == live_signals.size(), query.className + " signal count")
  for signal_info in query.signals:
   expect(live_signals.has(signal_info.name) and live_signals[signal_info.name].args.size() == signal_info.args.size(), signal_info.name + " signal args")
  if not instance is RefCounted: instance.free()
 var control := Control.new()
 root.add_child(control)
 control.set_anchors_preset(Control.PRESET_FULL_RECT)
 expect(control.anchor_right == 1.0 and control.anchor_bottom == 1.0, "anchor defaults work")
 control.mouse_filter = Control.MOUSE_FILTER_IGNORE
 expect(control.mouse_filter == Control.MOUSE_FILTER_IGNORE, "property works")
 control.set_meta(&"sample", 7)
 expect(control.get_meta(&"sample") == 7, "inherited Variant method works")
 var resource := Resource.new()
 var received := []
 resource.changed.connect(func(): received.append(true))
 resource.emit_changed()
 expect(received.size() == 1, "signal works")
 var node := Node3D.new()
 root.add_child(node)
 node.look_at(Vector3(0, 0, -1))
 expect(node.basis.is_equal_approx(Basis.IDENTITY), "Vector3 and bool defaults work")
 control.free()
 node.free()
 print(JSON.stringify({"checks": checks, "failures": failures}))
 quit(0 if failures.is_empty() else 1)
`);
      const proof = await runProcess(process.env.GODOT_BIN, ['--headless', '--path', sandbox, '--script', join(sandbox, 'exercise.gd')], { quiet: true, timeoutMs: 10000, env });
      assert.equal(proof.status, 0, proof.output);
      assert.doesNotMatch(proof.output, /SCRIPT ERROR|ERROR:/);
      const result = JSON.parse(proof.stdout.trim().split('\n').at(-1));
      assert.deepEqual(result.failures, []);
      assert.ok(result.checks > 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
