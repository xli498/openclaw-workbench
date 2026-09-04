import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import { validatePatchTargets } from './patch-engine.mjs';
import { openWindowsPathLock, runWindowsFileOperation } from './windows-path-lock.mjs';

export class TransactionError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'TransactionError'; this.code = code; this.details = details; }
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
let active = false;

function safeRelative(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\')) throw new TransactionError('PATH_INVALID', relativePath);
  const base = path.resolve(root);
  const target = path.resolve(base, relativePath);
  if (!target.startsWith(`${base}${path.sep}`)) throw new TransactionError('PATH_ESCAPE', relativePath);
  return target;
}

function applyHunks(original, hunks) {
  const lines = original.split('\n');
  let offset = 0;
  for (const hunk of hunks) {
    let index = hunk.oldStart - 1 + offset;
    const replacement = [];
    for (const line of hunk.body) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === ' ') {
        if (lines[index] !== text) throw new TransactionError('CONTEXT_MISMATCH', 'patch context does not match file');
        replacement.push(text); index += 1;
      } else if (marker === '-') {
        if (lines[index] !== text) throw new TransactionError('CONTENT_MISMATCH', 'patch removal does not match file');
        index += 1;
      } else if (marker === '+') replacement.push(text);
    }
    const consumed = hunk.body.filter((l) => l[0] !== '+').length;
    lines.splice(hunk.oldStart - 1 + offset, consumed, ...replacement);
    offset += replacement.length - consumed;
  }
  return lines.join('\n');
}

async function writeManifest(root, filePath, manifest) {
  const tempName = `${path.basename(filePath)}.tmp-${randomUUID()}`;
  const tempPath = path.join(path.dirname(filePath), tempName);
  const content = JSON.stringify(manifest);
  await writeStableFile(root, tempPath, content, 'manifest staging write');
  try { await replaceWithinStableParent({ root, source: tempPath, target: filePath, expectedSourceHash: digest(content), expectedAfterHash: digest(content) }); }
  catch (error) { await unlinkStableFile(root, tempPath).catch(() => {}); throw error; }
}

async function assertWorkspaceDirectory(root, directory, label) {
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new TransactionError('PATH_ESCAPE', label);
  const real = await realpath(resolved).catch((error) => { throw new TransactionError('STORAGE_UNAVAILABLE', `${label}: ${error.message}`); });
  if (real !== resolved) throw new TransactionError('STORAGE_PATH_CHANGED', label);
  return real;
}

export async function writeStableFile(root, filePath, content, label) {
  let stable;
  try {
    if (process.platform === 'win32') {
      const candidatePath = path.resolve(filePath);
      const parentPath = path.dirname(candidatePath);
      const rootReal = await realpath(root);
      const parentReal = await realpath(parentPath);
      await runWindowsFileOperation({ operation: 'write', root: rootReal, parent: parentPath, target: candidatePath, expectedParent: parentReal, contentBase64: Buffer.from(content).toString('base64'), replaceIfExists: false, expectTargetMissing: true });
      return;
    }
    stable = await openStableParent(root, filePath);
    await writeFile(stable.stablePath, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error instanceof TransactionError) throw error;
    throw new TransactionError('STORAGE_WRITE_FAILED', `${label}: ${error.message}`);
  } finally { await stable?.directory.close().catch(() => {}); }
}

export async function unlinkStableFile(root, filePath) {
  let stable;
  try {
    if (process.platform === 'win32') {
      const candidatePath = path.resolve(filePath);
      const parentPath = path.dirname(candidatePath);
      const rootReal = await realpath(root);
      const parentReal = await realpath(parentPath);
      await runWindowsFileOperation({ operation: 'delete', root: rootReal, parent: parentPath, target: candidatePath, expectedParent: parentReal });
      return;
    }
    stable = await openStableParent(root, filePath);
    await unlink(stable.stablePath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  } finally { await stable?.directory.close().catch(() => {}); }
}

async function restoreFileAtomically(root, target, content) {
  const temp = `${target}.ocw-rollback-${randomUUID()}.tmp`;
  try {
    await writeStableFile(root, temp, content, 'rollback staging write');
    await replaceWithinStableParent({ root, source: temp, target, expectedSourceHash: digest(content), expectedAfterHash: digest(content) });
  } catch (error) {
    await unlinkStableFile(root, temp).catch(() => {});
    throw error;
  }
}

async function readStableRegular(filePath, label) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new TransactionError('TARGET_CHANGED', `${label} is not a regular file`);
    return await handle.readFile();
  } catch (error) {
    if (error instanceof TransactionError) throw error;
    throw new TransactionError('TARGET_CHANGED', `${label} changed: ${error.message}`);
  } finally { await handle?.close().catch(() => {}); }
}

export async function openStableParent(root, candidate) {
  const base = await realpath(root).catch((error) => { throw new TransactionError('ROOT_UNAVAILABLE', error.message); });
  const candidatePath = path.resolve(candidate);
  const parentPath = path.dirname(candidatePath);
  if (parentPath !== base && !parentPath.startsWith(`${base}${path.sep}`)) throw new TransactionError('PATH_ESCAPE', candidatePath);
  const parentReal = await realpath(parentPath).catch((error) => { throw new TransactionError('TARGET_PARENT_UNAVAILABLE', error.message); });
  if (parentReal !== parentPath || (parentReal !== base && !parentReal.startsWith(`${base}${path.sep}`))) throw new TransactionError('TARGET_PARENT_CHANGED', candidatePath);
  if (process.platform === 'win32') {
    const info = await lstat(parentPath).catch((error) => { throw new TransactionError('STABLE_DIRECTORY_UNAVAILABLE', error.message); });
    if (info.isSymbolicLink() || !info.isDirectory()) throw new TransactionError('STABLE_DIRECTORY_UNAVAILABLE', 'target parent must be a regular directory');
    let lock;
    try {
      lock = openWindowsPathLock({ root: base, parent: parentPath, target: candidatePath, expectedParent: parentReal });
      return { directory: { close: async () => lock?.close() }, stableParent: parentReal, candidatePath, stablePath: path.join(parentReal, path.basename(candidatePath)) };
    } catch (error) { lock?.close(); throw new TransactionError('STABLE_DIRECTORY_UNAVAILABLE', error.message); }
  }
  const directory = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    .catch((error) => { throw new TransactionError('STABLE_DIRECTORY_UNAVAILABLE', error.message); });
  try {
    const stableParent = `/proc/self/fd/${directory.fd}`;
    const openedParentReal = await realpath(stableParent).catch((error) => { throw new TransactionError('STABLE_DIRECTORY_UNAVAILABLE', error.message); });
    if (openedParentReal !== parentReal) throw new TransactionError('TARGET_PARENT_CHANGED', candidatePath);
    return { directory, stableParent, candidatePath, stablePath: path.join(stableParent, path.basename(candidatePath)) };
  } catch (error) {
    await directory.close().catch(() => {});
    throw error;
  }
}

export async function replaceWithinStableParent({ root, source, target, renameFile = rename, expectedSourceHash, expectedTargetHash, expectedAfterHash } = {}) {
  const sourcePath = path.resolve(source);
  const targetPath = path.resolve(target);
  const parentPath = path.dirname(targetPath);
  if (path.dirname(sourcePath) !== parentPath) throw new TransactionError('PATH_ESCAPE', 'atomic replacement must stay in one workspace directory');
  if (process.platform === 'win32' && renameFile === rename) {
    const rootReal = await realpath(root);
    const parentReal = await realpath(parentPath);
    await runWindowsFileOperation({ operation: 'replace', root: rootReal, parent: parentPath, target: targetPath, source: sourcePath, expectedParent: parentReal, expectedSourceHash, expectedTargetHash });
    if (expectedAfterHash !== undefined && digest(await readStableRegular(targetPath, 'committed target')) !== expectedAfterHash) throw new TransactionError('POST_VERIFY_FAILED', 'committed content hash mismatch', { replaced: true });
    return;
  }
  let stable;
  try {
    stable = await openStableParent(root, targetPath);
    const stableSource = path.join(stable.stableParent, path.basename(sourcePath));
    const stableTarget = stable.stablePath;
    if (expectedSourceHash !== undefined && digest(await readStableRegular(stableSource, 'replacement source')) !== expectedSourceHash) throw new TransactionError('SOURCE_CHANGED', 'replacement source changed before commit');
    if (expectedTargetHash !== undefined && digest(await readStableRegular(stableTarget, 'replacement target')) !== expectedTargetHash) throw new TransactionError('TARGET_CHANGED', 'replacement target changed before commit');
    await renameFile(stableSource, stableTarget);
    if (expectedAfterHash !== undefined && digest(await readStableRegular(stableTarget, 'committed target')) !== expectedAfterHash) throw new TransactionError('POST_VERIFY_FAILED', 'committed content hash mismatch', { replaced: true });
  } finally { await stable?.directory.close().catch(() => {}); }
}

export async function acquireWorkspaceWriteLock(root, { staleAfterMs = 10 * 60 * 1000, now = Date.now(), isProcessAlive = defaultProcessAlive } = {}) {
  const lockPath = path.join(root, '.openclaw-workbench', 'write.lock');
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try { handle = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let stale = false;
    try {
      const metadata = JSON.parse(await readFile(lockPath, 'utf8'));
      stale = Number.isInteger(metadata.pid)
        && Number.isFinite(metadata.createdAt)
        && typeof metadata.token === 'string' && metadata.token.length >= 16
        && now >= metadata.createdAt
        && now - metadata.createdAt >= staleAfterMs
        && !(await isProcessAlive(metadata.pid));
    } catch { /* malformed locks are never auto-claimed */ }
    if (!stale) throw new TransactionError('BUSY', 'another transaction is active');
    // 将旧锁原子移走，避免“读到旧锁后直接 unlink”误删竞争者新建的锁。
    const quarantine = `${lockPath}.stale-${randomUUID()}`;
    try { await rename(lockPath, quarantine); }
    catch (takeoverError) { if (takeoverError.code === 'ENOENT' || takeoverError.code === 'EEXIST') throw new TransactionError('BUSY', 'another transaction is active'); throw takeoverError; }
    await unlink(quarantine).catch(() => {});
    try { handle = await open(lockPath, 'wx'); }
    catch (retryError) { if (retryError.code === 'EEXIST') throw new TransactionError('BUSY', 'another transaction is active'); throw retryError; }
  }
  const token = randomUUID();
  const metadata = JSON.stringify({ pid: process.pid, createdAt: now, token });
  try { await handle.writeFile(metadata, 'utf8'); }
  catch (error) { await handle.close().catch(() => {}); await unlink(lockPath).catch(() => {}); throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close().catch(() => {});
    try {
      const current = JSON.parse(await readFile(lockPath, 'utf8'));
      if (current.token === token) await unlink(lockPath);
    } catch { /* 锁已被接管、替换或损坏时不得删除未知所有者的锁 */ }
  };
}

async function defaultProcessAlive(pid) {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function applyPatchTransaction({ root, parsedPatch, declaredPaths, expectedRevision, currentRevision, getCurrentRevision, snapshotDir, transactionDir, audit, renameFile = rename }) {
  if (active) throw new TransactionError('BUSY', 'another transaction is active');
  active = true;
  let base;
  let releaseLock;
  const snapshots = [];
  const staged = [];
  try {
    base = await realpath(root).catch((e) => { throw new TransactionError('ROOT_UNAVAILABLE', e.message); });
    releaseLock = await acquireWorkspaceWriteLock(base);
    validatePatchTargets(parsedPatch, declaredPaths);
    const revisionNow = getCurrentRevision ? await getCurrentRevision() : currentRevision;
    if (expectedRevision !== undefined && revisionNow !== expectedRevision) throw new TransactionError('REVISION_MISMATCH', 'workspace changed before apply');
    for (const file of parsedPatch.files) {
      if (!file.oldPath || !file.newPath || file.oldPath !== file.newPath) throw new TransactionError('FILE_CREATE_DELETE_UNSUPPORTED', 'only in-place file updates are supported');
      const target = safeRelative(base, file.newPath);
      const targetReal = await realpath(target).catch((e) => { throw new TransactionError('TARGET_UNAVAILABLE', e.message); });
      if (targetReal !== target) throw new TransactionError('SYMLINK_TARGET', file.newPath);
      let handle;
      let before;
      try {
        handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile()) throw new TransactionError('TARGET_UNAVAILABLE', 'patch target must be a regular file');
        before = await handle.readFile();
      } catch (error) {
        if (error instanceof TransactionError) throw error;
        throw new TransactionError('TARGET_UNAVAILABLE', error.message);
      } finally { await handle?.close().catch(() => {}); }
      const targetAfterRead = await realpath(target).catch((e) => { throw new TransactionError('TARGET_UNAVAILABLE', e.message); });
      if (targetAfterRead !== target || targetAfterRead !== targetReal) throw new TransactionError('TARGET_CHANGED', file.newPath);
      const beforeHash = digest(before);
      const next = applyHunks(before.toString('utf8'), file.hunks);
      snapshots.push({ target, relativePath: file.newPath, before, beforeHash });
      staged.push({ target, relativePath: file.newPath, next, afterHash: digest(next) });
    }
    const snapshotRoot = snapshotDir ?? path.join(base, '.openclaw-workbench', 'snapshots');
    const stateRoot = transactionDir ?? path.join(base, '.openclaw-workbench', 'transactions');
    if (!path.resolve(snapshotRoot).startsWith(`${base}${path.sep}`) || !path.resolve(stateRoot).startsWith(`${base}${path.sep}`)) throw new TransactionError('PATH_ESCAPE', 'transaction storage outside workspace');
    await mkdir(snapshotRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await assertWorkspaceDirectory(base, snapshotRoot, 'snapshot storage');
    await assertWorkspaceDirectory(base, stateRoot, 'transaction storage');
    const transactionId = `${Date.now()}-${randomUUID()}`;
    const manifestPath = path.join(stateRoot, `${transactionId}.json`);
    for (const item of snapshots) item.snapshot = path.join(snapshotRoot, `${transactionId}-${item.relativePath.replaceAll('/', '__')}`);
    for (const item of staged) item.temp = `${item.target}.ocw-${transactionId}.tmp`;
    const manifestFiles = () => staged.map((x, index) => ({ relativePath: x.relativePath, target: x.target, temp: x.temp, snapshot: snapshots[index]?.snapshot, afterHash: x.afterHash, beforeHash: snapshots[index]?.beforeHash }));
    await writeManifest(base, manifestPath, { transactionId, state: 'prepared', files: manifestFiles() });
    if (audit) await audit.append({ type: 'transaction.prepared', actor: 'system', transactionId, files: manifestFiles().map((file) => file.relativePath) });
    for (const item of snapshots) await writeStableFile(base, item.snapshot, item.before, 'snapshot write');
    for (const item of staged) await writeStableFile(base, item.temp, item.next, 'staging write');
    const revisionBeforeCommit = getCurrentRevision ? await getCurrentRevision() : currentRevision;
    if (expectedRevision !== undefined && revisionBeforeCommit !== expectedRevision) throw new TransactionError('REVISION_MISMATCH', 'workspace changed during preflight');
    await writeManifest(base, manifestPath, { transactionId, state: 'committing', files: manifestFiles() });
    if (audit) await audit.append({ type: 'transaction.committing', actor: 'system', transactionId, files: manifestFiles().map((file) => file.relativePath) });
    const committed = [];
    try {
      for (const item of staged) {
        const snap = snapshots.find((snapshot) => snapshot.target === item.target);
        try {
          await replaceWithinStableParent({ root: base, source: item.temp, target: item.target, renameFile, expectedSourceHash: item.afterHash, expectedTargetHash: snap.beforeHash, expectedAfterHash: item.afterHash });
          committed.push(item);
        } catch (error) {
          if (error.details?.replaced) committed.push(item);
          throw error;
        }
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const item of committed) {
        const snap = snapshots.find((s) => s.target === item.target);
        try { await restoreFileAtomically(base, item.target, snap.before); } catch (rollbackError) { rollbackErrors.push({ path: item.relativePath, error: rollbackError.message }); }
      }
      const rollbackState = rollbackErrors.length ? 'rollback_partial' : 'rolled_back';
      await writeManifest(base, manifestPath, { transactionId, state: rollbackState, files: manifestFiles(), rollbackErrors });
      throw new TransactionError(rollbackErrors.length ? 'ROLLBACK_PARTIAL' : error.code === 'POST_VERIFY_FAILED' ? 'POST_VERIFY_FAILED' : 'COMMIT_FAILED', error.message, { rolledBack: committed.map((x) => x.relativePath), rollbackErrors });
    }
    await writeManifest(base, manifestPath, { transactionId, state: 'committed', files: manifestFiles() });
    if (audit) await audit.append({ type: 'transaction.committed', actor: 'system', transactionId, files: manifestFiles().map((file) => file.relativePath) });
    return Object.freeze({ transactionId, manifestPath, files: Object.freeze(staged.map((x) => ({ relativePath: x.relativePath, afterHash: x.afterHash }))), snapshots: Object.freeze(snapshots.map((x) => ({ relativePath: x.relativePath, snapshot: x.snapshot }))) });
  } finally {
    for (const item of staged) if (item.temp) await unlinkStableFile(base, item.temp).catch(() => {});
    await releaseLock?.();
    active = false;
  }
}

export { applyHunks };
