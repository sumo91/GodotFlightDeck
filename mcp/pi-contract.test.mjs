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

import { PI_FAMILIES } from '../registry/commands.mjs';
import { buildCliArgs as mcpArgs, cleanupBatchFiles } from './server.mjs';

test('every declared action shares CLI operand semantics across Pi and MCP', () => {
  const values = { name: 'example', profile: 'default', path: 'Node', parent: '.', property: 'visible', value: false,
    className: 'Node2D', nodeName: 'Example', resourceClass: 'Theme', resource: 'res://resources/theme.tres', index: 0,
    target: 'all', scene: 'res://main.tscn', operations: [{action:'set',path:'.',property:'visible',value:false}], commit: false };
  try {
    for (const [family, spec] of Object.entries(PI_FAMILIES)) {
      for (const [action, def] of Object.entries(spec.actions)) {
        if (!def.cliCommand) continue;
        const params = { action, ...Object.fromEntries(def.parameters.filter(key => key in values).map(key => [key, values[key]])) };
        const left = parseCliArguments(buildCliArgs(family, params, project, { batchPath: '/tmp/batch.json', writeAuthorized: true }));
        const right = parseCliArguments(mcpArgs(family, action, { ...params, ...(left.options.json ? {json:true}:{}), ...(left.options.apply ? {apply:true}:{}) }, project));
        if (action === 'batch') right.positional[1] = '/tmp/batch.json';
        assert.deepEqual(left, right, `${family}:${action}`);
      }
    }
  } finally { cleanupBatchFiles(); }
});

import * as nodeModule from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('actual Pi tool callback gates execution on host confirmation', { skip: !nodeModule.registerHooks || !nodeModule.stripTypeScriptTypes }, async () => {
  const stubs = {
    '@earendil-works/pi-coding-agent': 'export const DEFAULT_MAX_BYTES=8192, DEFAULT_MAX_LINES=100; export const formatSize=String; export const truncateTail=text=>({content:text,truncated:false});',
    '@earendil-works/pi-ai': 'export const StringEnum=values=>({enum:values});',
    'typebox': 'export const Type=new Proxy({}, {get:(_,key)=>(...args)=>({kind:key,args})});',
  };
  const hooks = nodeModule.registerHooks({
    resolve(specifier, context, next) {
      return specifier in stubs ? {url:`data:text/javascript,${encodeURIComponent(stubs[specifier])}`,shortCircuit:true} : next(specifier,context);
    },
    load(url, context, next) {
      if (url.endsWith('/extensions/godot-flight-deck.ts')) return {format:'module',source:nodeModule.stripTypeScriptTypes(readFileSync(new URL(url),'utf8')),shortCircuit:true};
      return next(url,context);
    },
  });
  const root=mkdtempSync(join(tmpdir(),'gdeck-pi-host-'));
  const realNow=Date.now;
  try {
    writeFileSync(join(root,'project.godot'),'config_version=5\n');
    const {default:register}=await import('../extensions/godot-flight-deck.ts');
    for (const mode of ['approve','deny','timeout','no-ui']) {
      const tools=new Map(), calls=[];
      register({registerTool:tool=>tools.set(tool.name,tool),registerCommand(){},on(){},
        async exec(command,args){calls.push(JSON.parse(readFileSync(args[2],'utf8')));return {code:0,stdout:'done',stderr:''};}});
      const ctx={cwd:root,isProjectTrusted:()=>true,hasUI:mode!=='no-ui',ui:{confirm:async()=>{
        if(mode==='timeout') { const now=realNow(); Date.now=()=>now+200000; }
        return mode==='approve';
      }}};
      const result=await tools.get('gdeck_editor').execute('test',{action:'batch',commit:true,operations:[{action:'set',path:'.',property:'visible',value:false}]},undefined,undefined,ctx).catch(error=>({error}));
      Date.now=realNow;
      assert.equal(calls.length,mode==='approve'?1:0,mode);
      if(calls.length) assert.equal(parseCliArguments(calls[0].args.slice(1)).options.apply,true);
      else assert.match(result.error?.message ?? '', /denied|timed out|no Pi system confirmation/,mode);
    }
  } finally {Date.now=realNow;hooks.deregister();rmSync(root,{recursive:true,force:true});}
});
