import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class ChangeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ChangeError';
    this.code = code;
    this.details = details;
  }
}

const digest = (value) => createHash('sha256').update(value).digest('hex');

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function safeExistingTarget(root, relativePath) {
  const rootReal = await realpath(root).catch((e) => { throw new ChangeError('ROOT_UNAVAILABLE', e.message); });
  if (!relativePath || path.isAbsolute(relativePath)) throw new ChangeError('INVALID_INPUT', 'relativePath must be relative');
  const target = path.resolve(rootReal, relativePath);
  if (target !== rootReal && !target.startsWith(`${rootReal}${path.sep}`)) throw new ChangeError('PATH_ESCAPE', 'target escapes workspace');
  const targetReal = await realpath(target).catch((e) => { throw new ChangeError('READ_FAILED', e.message); });
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) throw new ChangeError('SYMLINK_ESCAPE', 'target symlink escapes workspace');
  return { rootReal, target, targetReal };
}

export async function applyTextChange({ root, relativePath, expectedHash, nextContent, snapshotDir }) {
  if (!root || !relativePath || path.isAbsolute(relativePath)) throw new ChangeError('INVALID_INPUT', 'root and relativePath are required');
  const { rootReal, targetReal } = await safeExistingTarget(root, relativePath);
  const before = await readFile(targetReal).catch((e) => { throw new ChangeError('READ_FAILED', e.message); });
  const beforeHash = digest(before);
  if (beforeHash !== expectedHash) throw new ChangeError('HASH_MISMATCH', 'file changed since preview', { expectedHash, actualHash: beforeHash });
  const snapshotRoot = path.resolve(rootReal, snapshotDir ?? path.join(rootReal, '.openclaw-workbench', 'snapshots'));
  if (!inside(rootReal, snapshotRoot)) throw new ChangeError('PATH_ESCAPE', 'snapshot directory escapes workspace');
  const snapshotParent = await realpath(path.dirname(snapshotRoot)).catch(() => null);
  if (snapshotParent && !inside(rootReal, snapshotParent)) throw new ChangeError('SYMLINK_ESCAPE', 'snapshot directory symlink escapes workspace');
  await mkdir(snapshotRoot, { recursive: true });
  const snapshotRootReal = await realpath(snapshotRoot).catch((e) => { throw new ChangeError('WRITE_FAILED', e.message); });
  if (!inside(rootReal, snapshotRootReal)) throw new ChangeError('SYMLINK_ESCAPE', 'snapshot directory symlink escapes workspace');
  const snapshot = path.join(snapshotRootReal, `${Date.now()}-${randomUUID()}-${path.basename(relativePath)}`);
  await copyFile(targetReal, snapshot);
  const temp = `${targetReal}.ocw-${randomUUID()}.tmp`;
  try {
    await writeFile(temp, nextContent, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, targetReal);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw new ChangeError('WRITE_FAILED', error.message, { path: relativePath });
  }
  const after = await readFile(targetReal);
  return Object.freeze({ relativePath, beforeHash, afterHash: digest(after), snapshot });
}

export async function rollbackTextChange({ root, relativePath, snapshot }) {
  const { rootReal, targetReal } = await safeExistingTarget(root, relativePath);
  const snapshotPath = path.resolve(snapshot);
  if (!inside(rootReal, snapshotPath)) throw new ChangeError('PATH_ESCAPE', 'snapshot escapes workspace');
  const snapshotReal = await realpath(snapshotPath).catch((e) => { throw new ChangeError('SNAPSHOT_UNAVAILABLE', e.message); });
  if (!inside(rootReal, snapshotReal)) throw new ChangeError('SYMLINK_ESCAPE', 'snapshot symlink escapes workspace');
  const snapshotInfo = await stat(snapshotReal).catch((e) => { throw new ChangeError('SNAPSHOT_UNAVAILABLE', e.message); });
  if (!snapshotInfo.isFile()) throw new ChangeError('SNAPSHOT_INVALID', 'snapshot is not a file');
  const content = await readFile(snapshotReal);
  const temp = `${targetReal}.ocw-${randomUUID()}.rollback`;
  await writeFile(temp, content, { flag: 'wx' });
  await rename(temp, targetReal);
  return Object.freeze({ relativePath, restoredHash: digest(content) });
}
