import { ResultClassificationError } from './result-envelope.mjs';
import { chmodSync, existsSync, fstatSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const LIFECYCLE_TEMPORARY_PREFIXES = [
  'gdeck-fixture-run-', 'gdeck-verification-snapshot-', 'gdeck-release-project-', 'gdeck-native-smoke-', 'gdeck-class-info-',
];

export function privateLifecycleRegistry() {
  if (process.env.GDECK_LIFECYCLE_FD !== '4') return null;
  try {
    const metadata = fstatSync(4);
    // Windows has no POSIX permission bits (Node chmod cannot restrict ACLs);
    // the fd identity itself is the trust boundary there.
    const privateMode = process.platform === 'win32' || (metadata.mode & 0o077) === 0;
    return metadata.isFile() && privateMode ? 4 : null;
  } catch {
    return null;
  }
}

export function lifecycleRegistryEvent(event, path) {
  const registryDescriptor = privateLifecycleRegistry();
  if (registryDescriptor === null) return;
  const absolute = resolve(path);
  const temporaryResource = resolve(dirname(absolute)) === resolve(tmpdir())
    && LIFECYCLE_TEMPORARY_PREFIXES.some((prefix) => basename(absolute).startsWith(prefix));
  const exportStagingResource = basename(dirname(absolute)) === 'export-staging'
    && basename(dirname(dirname(absolute))) === '.gdeck';
  const captureStagingResource = basename(dirname(absolute)) === 'captures'
    && basename(dirname(dirname(absolute))) === '.gdeck' && /^\.gdeck-ab-[A-Za-z0-9]{6}$/.test(basename(absolute));
  if (!temporaryResource && !exportStagingResource && !captureStagingResource) {
    throw new ResultClassificationError('configuration', `Lifecycle resource path is outside an allowed invocation staging namespace: ${absolute}`);
  }
  try {
    writeSync(registryDescriptor, Buffer.from(`${JSON.stringify({ event, path: absolute, owner: process.pid })}\n`));
  } catch (error) {
    throw new ResultClassificationError('cleanup_timeout', `Cannot update the private lifecycle registry: ${error.message}`, 'process_result');
  }
}

export function createLifecycleTemporaryDirectory(prefix) {
  if (!LIFECYCLE_TEMPORARY_PREFIXES.includes(prefix)) throw new Error(`Unsupported lifecycle temporary prefix: ${prefix}`);
  const path = mkdtempSync(join(tmpdir(), prefix));
  try {
    lifecycleRegistryEvent('resource_add', path);
    return path;
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

export function removeLifecycleTemporaryDirectory(path) {
  if (!path) return;
  try { makeVerificationTreeWritable(path); } catch { /* removal below remains authoritative */ }
  try { rmSync(path, { recursive: true, force: true }); }
  catch (error) { throw new ResultClassificationError('cleanup_timeout', `Cannot remove lifecycle temporary directory ${path}: ${error.message}`, 'process_result'); }
  if (existsSync(path)) throw new ResultClassificationError('cleanup_timeout', `Lifecycle temporary directory remained after cleanup: ${path}`, 'process_result');
  lifecycleRegistryEvent('resource_remove', path);
}

export function makeVerificationTreeWritable(root) {
  if (!existsSync(root)) return;
  const visit = (path) => {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) return;
    if (!metadata.isDirectory()) {
      chmodSync(path, metadata.mode & 0o111 ? 0o700 : 0o600);
      return;
    }
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(root);
}
