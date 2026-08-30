import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validatePatchTargets } from './patch-engine.mjs';

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

async function writeManifest(filePath, manifest) {
  const temp = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(temp, JSON.stringify(manifest), { flag: 'wx' });
  await rename(temp, filePath);
}

async function restoreFileAtomically(target, content) {
  const temp = `${target}.ocw-rollback-${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
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
      const before = await readFile(target);
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
    const transactionId = `${Date.now()}-${randomUUID()}`;
    const manifestPath = path.join(stateRoot, `${transactionId}.json`);
    for (const item of snapshots) item.snapshot = path.join(snapshotRoot, `${transactionId}-${item.relativePath.replaceAll('/', '__')}`);
    for (const item of staged) item.temp = `${item.target}.ocw-${transactionId}.tmp`;
    const manifestFiles = () => staged.map((x, index) => ({ relativePath: x.relativePath, target: x.target, temp: x.temp, snapshot: snapshots[index]?.snapshot, afterHash: x.afterHash, beforeHash: snapshots[index]?.beforeHash }));
    await writeManifest(manifestPath, { transactionId, state: 'prepared', files: manifestFiles() });
    if (audit) await audit.append({ type: 'transaction.prepared', actor: 'system', transactionId, files: manifestFiles().map((file) => file.relativePath) });
    for (const item of snapshots) await writeFile(item.snapshot, item.before, { flag: 'wx' });
    for (const item of staged) await writeFile(item.temp, item.next, { flag: 'wx' });
    const revisionBeforeCommit = getCurrentRevision ? await getCurrentRevision() : currentRevision;
    if (expectedRevision !== undefined && revisionBeforeCommit !== expectedRevision) throw new TransactionError('REVISION_MISMATCH', 'workspace changed during preflight');
    await writeManifest(manifestPath, { transactionId, state: 'committing', files: manifestFiles() });
    if (audit) await audit.append({ type: 'transaction.committing', actor: 'system', transactionId, files: manifestFiles().map((file) => file.relativePath) });
    const committed = [];
    try {
      for (const item of staged) { await renameFile(item.temp, item.target); committed.push(item); }
      for (const item of staged) {
        const committedContent = await readFile(item.target);
        if (digest(committedContent) !== item.afterHash) throw new TransactionError('POST_VERIFY_FAILED', 'committed content hash mismatch', { path: item.relativePath });
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const item of committed) {
        const snap = snapshots.find((s) => s.target === item.target);
        try { await restoreFileAtomically(item.target, snap.before); } catch (rollbackError) { rollbackErrors.push({ path: item.relativePath, error: rollbackError.message }); }
      }
      const rollbackState = rollbackErrors.length ? 'rollback_partial' : 'rolled_back';
      await writeManifest(manifestPath, { transactionId, state: rollbackState, files: manifestFiles(), rollbackErrors });
      throw new TransactionError(rollbackErrors.length ? 'ROLLBACK_PARTIAL' : error.code === 'POST_VERIFY_FAILED' ? 'POST_VERIFY_FAILED' : 'COMMIT_FAILED', error.message, { rolledBack: committed.map((x) => x.relativePath), rollbackErrors });
    }
    await writeManifest(manifestPath, { transactionId, state: 'committed', files: manifestFiles() });
    if (audit) await audit.append({ type: 'transaction.committed', actor: 'system', transactionId, files: manifestFiles().map((file) => file.relativePath) });
    return Object.freeze({ transactionId, manifestPath, files: Object.freeze(staged.map((x) => ({ relativePath: x.relativePath, afterHash: x.afterHash }))), snapshots: Object.freeze(snapshots.map((x) => ({ relativePath: x.relativePath, snapshot: x.snapshot }))) });
  } finally {
    for (const item of staged) if (item.temp) await unlink(item.temp).catch(() => {});
    await releaseLock?.();
    active = false;
  }
}

export { applyHunks };
