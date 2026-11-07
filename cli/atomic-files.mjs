import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function syncDirectoryBestEffort(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    fsyncBestEffort(descriptor);
  } catch (error) {
    const unsupported = new Set(['EINVAL', 'ENOTSUP', 'EISDIR']);
    if (process.platform === 'win32') unsupported.add('EPERM').add('EACCES');
    if (!unsupported.has(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function fsyncBestEffort(descriptor) {
  try {
    fsyncSync(descriptor);
  } catch (error) {
    const unsupported = new Set(['EINVAL', 'ENOTSUP', 'EISDIR']);
    if (process.platform === 'win32') unsupported.add('EPERM').add('EACCES');
    if (!unsupported.has(error?.code)) throw error;
  }
}

export function writeFileAtomic(path, content, options = {}) {
  const temporary = `${path}.gdeck-${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const existingMode = existsSync(path) && statSync(path).isFile() ? statSync(path).mode & 0o777 : undefined;
  const mode = options.mode ?? existingMode ?? (0o666 & ~process.umask());
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    try { fchmodSync(descriptor, mode); } catch (error) {
      if (!(process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'ENOSYS' || error?.code === 'EINVAL'))) throw error;
    }
    writeFileSync(descriptor, content);
    fsyncBestEffort(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    syncDirectoryBestEffort(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function writeFileAtomicNoReplace(path, content, options = {}) {
  const temporary = `${path}.gdeck-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
  const mode = options.mode ?? (0o666 & ~process.umask());
  let descriptor;
  let temporaryIdentity;
  let published = false;
  try {
    descriptor = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), mode);
    try { fchmodSync(descriptor, mode); } catch (error) {
      if (!(process.platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'ENOSYS' || error?.code === 'EINVAL'))) throw error;
    }
    writeFileSync(descriptor, content);
    fsyncBestEffort(descriptor);
    const metadata = fstatSync(descriptor);
    temporaryIdentity = { dev: metadata.dev, ino: metadata.ino };
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
    published = true;
    const visible = lstatSync(path);
    if (!visible.isFile() || visible.isSymbolicLink() || visible.dev !== temporaryIdentity.dev || visible.ino !== temporaryIdentity.ino) {
      throw new Error(`Atomic no-replace publication identity mismatch: ${path}`);
    }
    unlinkSync(temporary);
    temporaryIdentity = undefined;
    syncDirectoryBestEffort(dirname(path));
    return { dev: visible.dev, ino: visible.ino };
  } catch (error) {
    if (published && existsSync(path)) {
      const visible = lstatSync(path);
      if (visible.isFile() && !visible.isSymbolicLink()
        && visible.dev === temporaryIdentity?.dev && visible.ino === temporaryIdentity?.ino) unlinkSync(path);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryIdentity && existsSync(temporary)) {
      const visible = lstatSync(temporary);
      if (visible.isFile() && !visible.isSymbolicLink()
        && visible.dev === temporaryIdentity.dev && visible.ino === temporaryIdentity.ino) unlinkSync(temporary);
    }
  }
}
