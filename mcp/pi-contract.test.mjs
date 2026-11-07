import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCliArgs, confirmationLifecycle } from '../extensions/runtime.mjs';
import { parseCliArguments } from '../registry/commands.mjs';
const project = '/tmp/gdeck pi test';
const parse = (params, writeAuthorized = false) => parseCliArguments(buildCliArgs('editor', params, project, { batchPath: '/tmp/batch.json', writeAuthorized }));

test('Pi confirmed writes carry apply; preflight and preview never commit', () => {
  const operations = [{ action: 'set', path: '.', property: 'visible', value: false }];
  for (const params of [{ action: 'batch', commit: true, operations }, { action: 'delete', path: 'Temporary' }, { action: 'resource-delete', resource: 'res://resources/temp.tres' }, { action: 'cleanup-sessions' }]) {
    assert.equal(parse(params).options.apply, undefined);
    assert.equal(parse(params, true).options.apply, true, params.action);
  }
  for (const commit of [undefined, false]) assert.equal(parse({ action: 'batch', commit, operations }, true).options['dry-run'], true);
});

test('Pi confirmation denial, timeout and no UI cannot authorize execution', async () => {
  for (const mode of ['approve', 'deny', 'timeout', 'no-ui']) {
    let launched = 0;
    let clock = 0;
    const decision = await confirmationLifecycle({ hasUI: mode !== 'no-ui', leaseEligible: false, leaseAvailable: false, timeoutMilliseconds: 100, approvalLeaseSeconds: 0, now: () => clock,
      confirm: async () => { if (mode === 'timeout') clock = 200; return mode === 'approve'; } });
    if (decision.outcome === 'approved') { assert.equal(parse({ action: 'delete', path: 'Temporary' }, true).options.apply, true); launched++; }
    assert.equal(launched, mode === 'approve' ? 1 : 0);
  }
});
