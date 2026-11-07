#!/usr/bin/env node
import { fstatSync, lstatSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { executeProcess } from './process-lifecycle.mjs';

function readPrivateSpecification() {
  const mode = process.argv[2];
  if (mode === '--spec-stdin') return readFileSync(0, 'utf8');
  if (mode !== '--spec-file') throw new Error('process specification must use private stdin or file transport');
  const path = process.argv[3] ?? '';
  const directory = dirname(path);
  let privatePathValidated = false;
  try {
    const directoryMetadata = lstatSync(directory);
    const fileMetadata = lstatSync(path);
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : fileMetadata.uid;
    // Windows has no POSIX permission bits; mode checks are meaningless there
    // (Node chmod cannot restrict ACLs), so they are skipped on win32. All other
    // integrity checks (symlinks, tmpdir ancestry, naming, uid) still apply.
    const privateModeOk = process.platform === 'win32'
      || ((directoryMetadata.mode & 0o077) === 0 && (fileMetadata.mode & 0o077) === 0);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()
      || fileMetadata.isSymbolicLink() || !fileMetadata.isFile()
      || !privateModeOk
      || fileMetadata.uid !== expectedUid || dirname(realpathSync(directory)) !== realpathSync(tmpdir())
      || !basename(directory).startsWith('gdeck-process-spec-') || basename(path) !== 'spec.json') {
      throw new Error('process specification path is not a private temporary file');
    }
    privatePathValidated = true;
    return readFileSync(path, 'utf8');
  } finally {
    if (privatePathValidated) {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* caller also performs bounded cleanup */ }
    }
  }
}

let specification;
try { specification = JSON.parse(readPrivateSpecification()); }
catch (error) { console.error(`Flight Deck: invalid process specification: ${error.message}`); process.exit(2); }
const result = await executeProcess(specification, { handleSignals: true });
const { stdoutBuffer, stderrBuffer, stdout, stderr, ...metadata } = result;
for (const [fd, bytes] of [[1, stdoutBuffer], [2, stderrBuffer], [3, Buffer.from(`${JSON.stringify(metadata)}\n`)]]) {
  try { if (bytes?.length) writeSync(fd, bytes); } catch { /* caller may have closed its pipe */ }
}
process.exit(result.status);
