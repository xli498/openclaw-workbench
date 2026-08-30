import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync, chmodSync, rmdirSync, unlinkSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';

function inside(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.includes(`${sep}..${sep}`));
}

export function assertSafeSnapshotPath({ root, storePath, ErrorType, code, message }) {
  const declaredRoot = resolve(root);
  const realRoot = realpathSync(declaredRoot);
  if (declaredRoot !== realRoot) throw new ErrorType(code, message);
  const target = resolve(storePath);
  if (!inside(realRoot, target)) throw new ErrorType(code, message);
  let current = realRoot;
  for (const segment of relative(realRoot, dirname(target)).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new ErrorType(code, message);
  }
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ErrorType(code, message);
  }
}

export function snapshotDigest(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function readSnapshot({ root, storePath, ErrorType, code, message }) {
  assertSafeSnapshotPath({ root, storePath, ErrorType, code, message });
  try {
    const content = readFileSync(storePath, 'utf8');
    return Object.freeze({ content, digest: snapshotDigest(content) });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ content: null, digest: null });
    throw error;
  }
}

export function writeSnapshotAtomically({ root, storePath, payload, expectedDigest, ErrorType, code, message, busyCode, busyMessage, conflictCode, conflictMessage, temporaryName }) {
  assertSafeSnapshotPath({ root, storePath, ErrorType, code, message });
  mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
  assertSafeSnapshotPath({ root, storePath, ErrorType, code, message });
  const lockPath = `${storePath}.lock`;
  try { mkdirSync(lockPath, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new ErrorType(busyCode, busyMessage); throw error; }
  const temporary = `${storePath}.${temporaryName}.tmp`;
  try {
    const current = readSnapshot({ root, storePath, ErrorType, code, message });
    if (current.digest !== expectedDigest) throw new ErrorType(conflictCode, conflictMessage);
    writeFileSync(temporary, payload, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, storePath);
    chmodSync(storePath, 0o600);
    return snapshotDigest(payload);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmdirSync(lockPath);
  }
}
