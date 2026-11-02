import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCliArgs, cleanupBatchFiles, fieldToJsonSchema, toolDefs, validateToolArguments } from './server.mjs';
import { parseCliArguments } from '../registry/commands.mjs';

const project = '/tmp/flight deck test project';
const parse = (family, action, params = {}) => parseCliArguments(buildCliArgs(family, action, params, project));
afterEach(cleanupBatchFiles);

test('init timeout belongs to the MCP supervisor, not init argv', () => {
  const parsed = parse('project', 'init', { timeout: 30 });
  assert.deepEqual(parsed.positional, [project]);
  assert.equal(parsed.options.timeout, undefined);
});

for (const action of ['templates-status', 'templates-install']) {
  test(`${action} maps to a supported templates subcommand`, () => {
    const parsed = parse('release', action, { timeout: 30 });
    assert.deepEqual(parsed.positional, [action.slice('templates-'.length), project]);
  });
}

for (const action of ['baseline', 'visual', 'benchmark']) {
  test(`${action} passes runtime profile positionally`, () => {
    assert.deepEqual(parse('validate', action, { profile: 'default' }).positional, ['default', project]);
  });
}

test('verify and scenario keep profile as a named option', () => {
  assert.equal(parse('validate', 'verify', { profile: 'fast' }).options.profile, 'fast');
  assert.deepEqual(parse('validate', 'scenario', { name: 'movement', profile: 'default' }).positional, ['movement', project]);
});

test('editor value schema supports JSON numbers, booleans, arrays, objects and null', () => {
  assert.notEqual(fieldToJsonSchema('value').type, 'string');
  for (const value of [3, -3, false, [10, 20], { x: 10, y: 20 }, null, 'false']) {
    const parsed = parse('editor', 'set', { path: '.', property: 'example', value });
    assert.deepEqual(JSON.parse(parsed.positional[3]), value);
    assert.equal(parsed.positional[4], project);
  }
});

test('omitted optional paths do not shift the project into the node position', () => {
  assert.deepEqual(parse('editor', 'inspect').positional, ['inspect', '.', project]);
  assert.deepEqual(parse('editor', 'create', { className: 'Node2D', nodeName: 'Example' }).positional,
    ['create', '.', 'Node2D', 'Example', project]);
});

test('batch preserves its public name and defaults to preview', () => {
  const operations = [{ action: 'set', path: '.', property: 'visible', value: false }];
  const parsed = parse('editor', 'batch', { name: 'Preview changes', operations });
  const batch = JSON.parse(readFileSync(parsed.positional[1], 'utf8'));
  assert.deepEqual(batch, { name: 'Preview changes', operations });
  assert.equal(parsed.options['dry-run'], true);
  assert.equal(parsed.options.apply, undefined);
});

test('batch commit is explicit', () => {
  const parsed = parse('editor', 'batch', { operations: [{ action: 'set', path: '.', property: 'visible', value: true }], commit: true });
  assert.equal(parsed.options.apply, true);
  assert.equal(parsed.options['dry-run'], undefined);
});

test('destructive editor operations expose and preserve explicit apply', () => {
  const schema = toolDefs.find(t => t.name === 'gdeck_editor').inputSchema;
  assert.equal(schema.properties.apply?.type, 'boolean');
  for (const [action, params] of [
    ['delete', { path: 'Temporary' }],
    ['resource-delete', { resource: 'res://resources/temporary.tres' }],
    ['cleanup-sessions', {}],
  ]) {
    assert.equal(parse('editor', action, params).options.apply, undefined);
    assert.equal(parse('editor', action, { ...params, apply: true }).options.apply, true);
  }
});

test('watch action activates watch without a redundant flag', () => {
  assert.equal(parse('run', 'watch', { timeout: 5 }).options.watch, true);
});

test('JSON output is forwarded only where the CLI supports it', () => {
  assert.equal(parse('validate', 'unit', { json: true }).options.json, undefined);
  assert.equal(parse('scene', 'set', { scene: 'res://main.tscn', path: '.', property: 'visible', value: false, json: true }).options.json, true);
});

test('invalid types, missing actions and unknown parameters fail before execution', () => {
  for (const params of [{}, { action: 'check', frames: 1.5 }, { action: 'check', timeout: 0 }, { action: 'check', surprise: true }]) {
    assert.throws(() => validateToolArguments('validate', params), /Invalid/);
  }
  assert.throws(() => validateToolArguments('editor', { action: 'batch', operations: [] }), /Invalid/);
  assert.throws(() => validateToolArguments('editor', { action: 'delete', apply: 'true' }), /Invalid/);
  for (const value of [3, false, [1, 2], { x: 1, y: 2 }, null, 'false']) {
    assert.doesNotThrow(() => validateToolArguments('editor', { action: 'set', property: 'example', value }));
  }
});

test('missing required operands cannot shift later values into another argument', () => {
  assert.throws(() => parse('editor', 'set', { value: 1 }), /Missing required.*property/);
  assert.throws(() => parse('editor', 'set', { property: 'visible' }), /Missing required.*value/);
  assert.throws(() => parse('editor', 'delete'), /Missing required.*path/);
  assert.throws(() => parse('editor', 'batch', { name: 'Incomplete' }), /Missing required.*operations/);
});
