import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { openWindowsPathLock, runWindowsFileOperationSync } from './windows-path-lock.mjs';

const DEFAULT_STALE_LOCK_MS = 5 * 60_000;
const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

function inside(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.includes(`${sep}..${sep}`));
}

function openAnchoredDirectory(pathname, ErrorType, code, message) {
  let fd;
  try {
    if (process.platform === 'win32') {
      const info = lstatSync(pathname);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('not a directory');
      const fd = openSync(pathname, fsConstants.O_RDONLY);
      const opened = fstatSync(fd);
      if (!opened.isDirectory()) throw new Error('not a directory');
      return Object.freeze({ fd, path: realpathSync(pathname), stat: opened });
    }
    fd = openSync(pathname, DIR_FLAGS);
    const procPath = `/proc/self/fd/${fd}`;
    // /proc/self/fd is required: all follow-up names are resolved from this inode,
    // not from a parent pathname that an attacker can replace after validation.
    const resolved = realpathSync(procPath);
    if (!lstatSync(resolved).isDirectory()) throw new Error('not a directory');
    return Object.freeze({ fd, path: procPath, stat: fstatSync(fd) });
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw new ErrorType(code, message);
  }
}

function closeDirectory(directory) { if (directory?.fd !== undefined && directory.fd !== null) closeSync(directory.fd); }

function entry(parent, name) { return resolve(parent.path, name); }
function sameIdentity(left, right) { return left && right && left.dev === right.dev && left.ino === right.ino; }
function entryStillOwned(parent, name, directory) {
  try { return sameIdentity(lstatSync(entry(parent, name)), directory.stat); } catch { return false; }
}

function readRegularFileNoFollow(pathname) {
  let fd;
  try {
    fd = openSync(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    return Object.freeze({ content: readFileSync(fd, 'utf8'), stat });
  } finally { if (fd !== undefined) closeSync(fd); }
}

// `pathname` must be derived from an already-open parent directory FD.  Keep
// opening and reading on that FD path: checking the name first and then using
// readFileSync(name) would reintroduce a final-component symlink race.
function readAnchoredRegularFile(parent, name) {
  return readRegularFileNoFollow(entry(parent, name));
}

function openExistingAnchoredParent(root, pathname, ErrorType, code, message) {
  const realRoot = realpathSync(resolve(root));
  const targetParent = resolve(dirname(pathname));
  if (!inside(realRoot, targetParent)) throw new ErrorType(code, message);
  let current = openAnchoredDirectory(realRoot, ErrorType, code, message);
  try {
    for (const segment of relative(realRoot, targetParent).split(sep).filter(Boolean)) {
      let next;
      try { next = openAnchoredDirectory(entry(current, segment), ErrorType, code, message); }
      catch (error) {
        if (error?.code === 'ENOENT' || !lstatSync(entry(current, segment), { throwIfNoEntry: false })) return null;
        throw error;
      }
      closeDirectory(current); current = next;
    }
    return current;
  } catch (error) { closeDirectory(current); throw error; }
}

function readLockOwner(lock) {
  const file = readRegularFileNoFollow(entry(lock, 'owner.json'));
  if (!file) return null;
  const owner = JSON.parse(file.content);
  if (!owner || typeof owner.token !== 'string' || !/^[0-9a-f-]{36}$/.test(owner.token) || !Number.isSafeInteger(owner.startedAt)) return null;
  return Object.freeze({ ...owner, stat: file.stat });
}

function removeOwnedLock(parent, lockName, lock, token, { __testHooks } = {}) {
  let owner;
  try { owner = readLockOwner(lock); } catch { return null; }
  if (!owner || owner.token !== token || !entryStillOwned(parent, lockName, lock)) return null;
  __testHooks?.beforeLockCleanup?.({ parentPath: parent.path, lockName, lockPath: lock.path });
  // Node has no unlinkat/CAS. Recheck both the directory entry and owner inode
  // immediately before deleting, so a detected successor is never removed.
  let current;
  try { current = readLockOwner(lock); } catch { return null; }
  if (!current || current.token !== token || !sameIdentity(current.stat, owner.stat) || !entryStillOwned(parent, lockName, lock)) return null;
  try { unlinkSync(entry(lock, 'owner.json')); } catch (error) { if (error.code !== 'ENOENT') return error; }
  if (!entryStillOwned(parent, lockName, lock)) return null;
  try { rmdirSync(entry(parent, lockName)); return null; }
  catch (error) { return error.code === 'ENOENT' ? null : error; }
}

function recoverStaleLock(parent, lockName, { staleLockMs, now, ErrorType, code, message, __testHooks }) {
  // Node exposes no renameat2(RENAME_NOREPLACE/CAS) primitive.  An inode check
  // before rename is therefore insufficient: an attacker can replace lockName
  // in the final interval and have its successor quarantined.  Do not perform
  // automatic stale recovery until a kernel-level compare-and-rename protocol
  // is available.  A stale lock is intentionally reported busy for manual
  // recovery rather than risking concurrent writers.
  let lock;
  try { lock = openAnchoredDirectory(entry(parent, lockName), ErrorType, code, message); } catch { return false; }
  try {
    const owner = readLockOwner(lock);
    if (!owner || now - owner.startedAt < staleLockMs || !entryStillOwned(parent, lockName, lock)) return false;
    // This hook is deliberately after the stale candidate's directory/owner
    // identities were captured, i.e. the exact former rename race window.
    __testHooks?.afterStaleLockVerified?.({ parentPath: parent.path, lockName, lockPath: lock.path });
    // A second observation can detect a successor, but cannot make rename CAS.
    // Either way, leave lockName untouched and require manual recovery.
    return false;
  } catch { return false; } finally { closeDirectory(lock); }
}

export function assertSafeSnapshotPath({ root, storePath, ErrorType, code, message }) {
  const declaredRoot = resolve(root);
  const realRoot = realpathSync(declaredRoot);
  if (declaredRoot !== realRoot) throw new ErrorType(code, message);
  const target = resolve(storePath);
  if (!inside(realRoot, target)) throw new ErrorType(code, message);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() || (stat && !stat.isFile())) throw new ErrorType(code, message);
}

export function snapshotDigest(content) { return createHash('sha256').update(content).digest('hex'); }

export function readSnapshot({ root, storePath, ErrorType, code, message, __testHooks, __windowsAnchored = false } = {}) {
  assertSafeSnapshotPath({ root, storePath, ErrorType, code, message });
  if (process.platform === 'win32' && !__windowsAnchored && __testHooks) {
    const target = resolve(storePath); const parentPath = dirname(target); const realRoot = realpathSync(resolve(root));
    let expectedParent;
    try { expectedParent = realpathSync(parentPath); } catch { return Object.freeze({ content: null, digest: null }); }
    let lock;
    try {
      lock = openWindowsPathLock({ root: realRoot, parent: parentPath, target, expectedParent });
      return readSnapshot({ root, storePath, ErrorType, code, message, __testHooks, __windowsAnchored: true });
    } catch (error) { throw error instanceof ErrorType ? error : new ErrorType(code, message); }
    finally { lock?.close(); }
  }
  const parent = openExistingAnchoredParent(root, storePath, ErrorType, code, message);
  if (!parent) return Object.freeze({ content: null, digest: null });
  try {
    __testHooks?.onParentOpened?.({ parentPath: parent.path, storePath });
    if (process.platform === 'win32') {
      if (!lstatSync(storePath, { throwIfNoEntry: false })) return Object.freeze({ content: null, digest: null });
      const encoded = runWindowsFileOperationSync({ operation: 'read', root: realpathSync(resolve(root)), parent: dirname(resolve(storePath)), target: resolve(storePath), expectedParent: realpathSync(dirname(resolve(storePath))) });
      const content = Buffer.from(encoded, 'base64').toString('utf8');
      return Object.freeze({ content, digest: snapshotDigest(content) });
    }
    const file = readAnchoredRegularFile(parent, basename(storePath));
    if (!file) return Object.freeze({ content: null, digest: null });
    return Object.freeze({ content: file.content, digest: snapshotDigest(file.content) });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ content: null, digest: null });
    if (error instanceof ErrorType) throw error;
    throw new ErrorType(code, message);
  } finally { closeDirectory(parent); }
}

// Create missing parents only through opened directory FDs. No mkdir call ever
// traverses the mutable complete parent pathname.
function openOrCreateAnchoredParent({ root, storePath, ErrorType, code, message }) {
  const declaredRoot = resolve(root); const realRoot = realpathSync(declaredRoot); const target = resolve(storePath);
  if (declaredRoot !== realRoot || !inside(realRoot, target)) throw new ErrorType(code, message);
  let current = openAnchoredDirectory(realRoot, ErrorType, code, message);
  try {
    for (const segment of relative(realRoot, dirname(target)).split(sep).filter(Boolean)) {
      try { mkdirSync(entry(current, segment), { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const next = openAnchoredDirectory(entry(current, segment), ErrorType, code, message);
      closeDirectory(current); current = next;
    }
    return current;
  } catch (error) { closeDirectory(current); throw error instanceof ErrorType ? error : new ErrorType(code, message); }
}

export function writeSnapshotAtomically({ root, storePath, payload, expectedDigest, ErrorType, code, message, busyCode, busyMessage, conflictCode, conflictMessage, temporaryName, staleLockMs = DEFAULT_STALE_LOCK_MS, now = Date.now(), __testHooks, __windowsAnchored = false } = {}) {
  assertSafeSnapshotPath({ root, storePath, ErrorType, code, message });
  if (process.platform === 'win32' && !__windowsAnchored && __testHooks) {
    const target = resolve(storePath); const parentPath = dirname(target); const realRoot = realpathSync(resolve(root));
    try { mkdirSync(parentPath, { recursive: true }); } catch { throw new ErrorType(code, message); }
    let expectedParent;
    try { expectedParent = realpathSync(parentPath); } catch { throw new ErrorType(code, message); }
    let lock;
    try {
      lock = openWindowsPathLock({ root: realRoot, parent: parentPath, target, expectedParent });
      return writeSnapshotAtomically({ root, storePath, payload, expectedDigest, ErrorType, code, message, busyCode, busyMessage, conflictCode, conflictMessage, temporaryName, staleLockMs, now, __testHooks, __windowsAnchored: true });
    } catch (error) { throw error instanceof ErrorType ? error : new ErrorType(code, message); }
    finally { lock?.close(); }
  }
  if (process.platform === 'win32' && !__windowsAnchored) {
    try { mkdirSync(dirname(resolve(storePath)), { recursive: true }); } catch { throw new ErrorType(code, message); }
  }
  const parent = openOrCreateAnchoredParent({ root, storePath, ErrorType, code, message });
  const targetName = basename(storePath);
  const lockName = `${targetName}.lock`;
  const token = randomUUID();
  let lock;
  let temporary;
  let primaryError;
  try {
    __testHooks?.onParentOpened?.({ parentPath: parent.path, storePath });
    try { mkdirSync(resolve(parent.path, lockName), { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST' || !recoverStaleLock(parent, lockName, { staleLockMs, now, ErrorType, code, message, __testHooks })) throw new ErrorType(busyCode, busyMessage);
      try { mkdirSync(resolve(parent.path, lockName), { mode: 0o700 }); } catch { throw new ErrorType(busyCode, busyMessage); }
    }
    lock = openAnchoredDirectory(resolve(parent.path, lockName), ErrorType, code, message);
    writeFileSync(resolve(lock.path, 'owner.json'), JSON.stringify({ token, startedAt: now }), { mode: 0o600, flag: 'wx' });
    const suffix = typeof temporaryName === 'string' && temporaryName ? temporaryName : 'snapshot';
    temporary = `${targetName}.${suffix}.${token}.tmp`;
    __testHooks?.beforeCurrentDigestOpen?.({ parentPath: parent.path, targetName, storePath });
    let current;
    try {
      const file = readAnchoredRegularFile(parent, targetName);
      current = { digest: file ? snapshotDigest(file.content) : null };
    }
    catch (error) { if (error?.code === 'ENOENT') current = { digest: null }; else throw new ErrorType(code, message); }
    if (current.digest !== expectedDigest) throw new ErrorType(conflictCode, conflictMessage);
    if (process.platform === 'win32') {
      runWindowsFileOperationSync({
        operation: 'write', root: realpathSync(resolve(root)), parent: dirname(resolve(storePath)), target: resolve(storePath), expectedParent: realpathSync(dirname(resolve(storePath))),
        expectedTargetHash: expectedDigest ?? undefined, contentBase64: Buffer.from(payload).toString('base64'), replaceIfExists: current.digest !== null, expectTargetMissing: current.digest === null,
      });
    } else {
      writeFileSync(resolve(parent.path, temporary), payload, { mode: 0o600, flag: 'wx' });
      renameSync(resolve(parent.path, temporary), resolve(parent.path, targetName));
      temporary = null;
    }
    return snapshotDigest(payload);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (temporary) { try { unlinkSync(entry(parent, temporary)); } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(error); } }
    if (lock) { const cleanupError = removeOwnedLock(parent, lockName, lock, token, { __testHooks }); if (cleanupError) cleanupErrors.push(cleanupError); closeDirectory(lock); }
    closeDirectory(parent);
    if (!primaryError && cleanupErrors.length) throw cleanupErrors[0];
  }
}
