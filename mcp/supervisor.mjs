import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROCESS_RUNNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'process-runner.mjs');
const CLEANUP_TIMEOUT_MS = 3000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// Reuse Flight Deck's existing monotonic deadline, process-tree ownership and
// isolated-resource cleanup. The MCP event loop stays available for cancellation.
export function executeSupervised(executable, args, { cwd, timeoutSeconds, signal, lifecycleProjectRoots = [] }) {
  if (signal?.aborted) return Promise.resolve({ status: 130, stdout: '', stderr: 'MCP call cancelled before execution', cancelled: true });
  const nonce = randomBytes(32).toString('hex');
  const phase = 'mcp';
  const specification = {
    executable, args, cwd, env: { ...process.env }, phase, nonce,
    timeoutMs: Math.round(timeoutSeconds * 1000), cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES, propagateLifecycleRegistry: true, lifecycleProjectRoots,
  };
  return new Promise(resolve => {
    const child = spawn(process.execPath, [PROCESS_RUNNER, '--spec-stdin'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
    const output = [[], [], []];
    for (const [index, stream] of [child.stdout, child.stderr, child.stdio[3]].entries()) {
      stream.on('data', chunk => output[index].push(chunk));
    }
    const cancel = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdin.on('error', () => {}); // EPIPE after cancellation carries no new authority.
    child.once('error', error => {
      signal?.removeEventListener('abort', cancel);
      resolve({ status: 127, stdout: '', stderr: `MCP supervisor could not start: ${error.message}`, timedOut: false });
    });
    child.once('close', () => {
      signal?.removeEventListener('abort', cancel);
      const [stdoutBuffer, stderrBuffer, metadataBuffer] = output.map(chunks => Buffer.concat(chunks));
      const [stdout, stderr, metadata] = [stdoutBuffer, stderrBuffer, metadataBuffer].map(bytes => bytes.toString('utf8'));
      let result;
      try {
        const candidate = JSON.parse(metadata.trim());
        if (candidate.schemaVersion === 1 && candidate.nonce === nonce && candidate.phase === phase && Number.isInteger(candidate.status)) result = candidate;
      } catch { /* Absence of authenticated lifecycle metadata is inconclusive. */ }
      resolve(result ? { ...result, stdout, stderr, stdoutBuffer, stderrBuffer } : {
        status: 125, stdout, stderr: `${stderr}\nMCP supervisor exited without lifecycle metadata`, cleanupTimedOut: true,
      });
    });
    child.stdin.end(JSON.stringify(specification));
    if (signal?.aborted) cancel();
  });
}
