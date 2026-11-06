#!/usr/bin/env node
// Fresh structured MCP session for checking a source checkout before installation.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [requestPath, responsePath] = process.argv.slice(2);
if (!requestPath || !responsePath) throw new Error('Usage: node mcp/call.mjs request.json response.json');
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
const client = new Client({ name: 'gdeck-source-validation', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], env: { ...process.env }, stderr: 'pipe' });
transport.stderr?.pipe(process.stderr);
try {
  await client.connect(transport);
  const started = performance.now();
  const progress = [];
  const result = await client.callTool(request, undefined, { timeout: ((request.arguments?.timeout ?? 120) + 30) * 1000,
    onprogress: update => { if (progress.length < 32) progress.push(update); console.log(String(update.message ?? '').slice(0, 6144)); } });
  writeFileSync(responsePath, JSON.stringify({ request, elapsedSeconds: (performance.now() - started) / 1000, progress, result }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ responsePath, isError: Boolean(result.isError), textBytes: Buffer.byteLength(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')) }));
  for (const item of result.content) if (item.type === 'text') console.log(item.text.slice(-12000));
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
