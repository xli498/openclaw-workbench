import { constants } from 'node:fs';
import { open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquireWorkspaceWriteLock, openStableParent, replaceWithinStableParent, unlinkStableFile, writeStableFile } from './change-transaction.mjs';

export class RecoveryError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'RecoveryError'; this.code = code; this.details = details; }
}

const STATES = new Set(['prepared', 'committing', 'committed', 'rolled_back', 'rollback_partial', 'finalize_failed', 'recovery_apply_failed']);

function inside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target.startsWith(`${base}${path.sep}`);
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..');
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

async function assertSafeExistingPath(root, candidate, label) {
  const resolved = path.resolve(candidate);
  if (!inside(root, resolved)) throw new RecoveryError('MANIFEST_PATH_INVALID', label);
  const real = await realpath(resolved).catch(() => null);
  if (real && !inside(root, real)) throw new RecoveryError('RECOVERY_PATH_ESCAPE', label);
  if (!real) {
    const parent = await realpath(path.dirname(resolved)).catch(() => null);
    if (parent && !inside(root, parent)) throw new RecoveryError('RECOVERY_PATH_ESCAPE', label);
  }
  return real;
}

async function readSafeFile(root, candidate, label) {
  if (!await assertSafeExistingPath(root, candidate, label)) return null;
  let stable;
  let handle;
  try {
    stable = await openStableParent(root, candidate);
    handle = await open(stable.stablePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new RecoveryError('RECOVERY_PATH_INVALID', label);
    return await handle.readFile();
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError('RECOVERY_PATH_INVALID', label);
  } finally { await handle?.close().catch(() => {}); await stable?.directory.close().catch(() => {}); }
}

async function atomicWriteManifest(root, filePath, manifest) {
  let stable;
  const tempName = `${path.basename(filePath)}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    stable = await openStableParent(root, filePath);
    const temp = path.join(stable.stableParent, tempName);
    await writeFile(temp, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    try { await rename(temp, stable.stablePath); }
    catch (error) { await unlink(temp).catch(() => {}); throw error; }
  } finally { await stable?.directory.close().catch(() => {}); }
}

async function withRecoveryLock(root, fn) {
  let releaseLock;
  try {
    releaseLock = await acquireWorkspaceWriteLock(path.resolve(root));
    return await fn();
  } catch (error) {
    if (error.code === 'BUSY') throw new RecoveryError('BUSY', 'workspace write lock is held');
    throw error;
  } finally {
    await releaseLock?.();
  }
}

export function validateTransactionManifest({ root, manifest }) {
  if (!manifest || !manifest.transactionId || !STATES.has(manifest.state) || !Array.isArray(manifest.files)) {
    throw new RecoveryError('MANIFEST_INVALID', 'invalid transaction manifest');
  }
  for (const file of manifest.files) {
    if (!safeRelativePath(file.relativePath) || !file.target || path.resolve(file.target) !== path.resolve(root, file.relativePath) || !inside(root, file.target) || (file.snapshot && !inside(root, file.snapshot))) {
      throw new RecoveryError('MANIFEST_PATH_INVALID', file.relativePath ?? 'unknown');
    }
    if (file.temp && !inside(root, file.temp)) throw new RecoveryError('MANIFEST_PATH_INVALID', file.relativePath);
  }
  return true;
}

export async function scanPendingTransactions({ root, directory = '.openclaw-workbench/transactions', tolerateInvalid = false } = {}) {
  if (!root || path.isAbsolute(directory) || directory.split('/').includes('..')) throw new RecoveryError('PATH_INVALID', 'invalid transaction directory');
  const transactionDir = path.resolve(root, directory);
  let stable;
  try { stable = await openStableParent(root, path.join(transactionDir, '.scan-anchor')); }
  catch (error) {
    if (error.code === 'TARGET_PARENT_UNAVAILABLE' && /ENOENT/.test(error.message)) return Object.freeze([]);
    throw new RecoveryError('SCAN_FAILED', error.message);
  }
  const entries = await readdir(stable.stableParent, { withFileTypes: true }).catch((error) => { throw new RecoveryError('SCAN_FAILED', error.message); });
  const pending = [];
  try {
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(transactionDir, entry.name);
      let handle;
      let manifest;
      try {
        handle = await open(path.join(stable.stableParent, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        if (!(await handle.stat()).isFile()) throw new Error('manifest is not a regular file');
        manifest = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
      } catch (error) {
        if (!tolerateInvalid) throw new RecoveryError('MANIFEST_INVALID', entry.name, { error: error.message });
        pending.push(Object.freeze({ transactionId: entry.name, state: 'unknown', manifestPath: filePath, invalid: Object.freeze({ code: 'MANIFEST_INVALID', message: error.message }) }));
        continue;
      } finally { await handle?.close().catch(() => {}); }
      try { validateTransactionManifest({ root, manifest }); }
      catch (error) {
        if (!tolerateInvalid) throw error;
        pending.push(Object.freeze({ transactionId: manifest?.transactionId ?? entry.name, state: manifest?.state ?? 'unknown', manifestPath: filePath, invalid: Object.freeze({ code: error.code ?? 'MANIFEST_INVALID', message: error.message }) }));
        continue;
      }
      if (manifest.state === 'prepared' || manifest.state === 'committing' || manifest.state === 'rollback_partial' || manifest.state === 'finalize_failed' || manifest.state === 'recovery_apply_failed') pending.push(Object.freeze({ ...manifest, manifestPath: filePath }));
    }
  } finally { await stable.directory.close().catch(() => {}); }
  return Object.freeze(pending);
}

export async function inspectPendingTransaction({ root, manifest }) {
  validateTransactionManifest({ root, manifest });
  const files = [];
  for (const file of manifest.files) {
    const target = await assertSafeExistingPath(root, file.target, file.relativePath);
    if (file.snapshot) await assertSafeExistingPath(root, file.snapshot, file.relativePath);
    if (file.temp) await assertSafeExistingPath(root, file.temp, file.relativePath);
    const snapshot = file.snapshot ? await readSafeFile(root, file.snapshot, file.relativePath).catch(() => null) : null;
    const current = await readSafeFile(root, file.target, file.relativePath).catch(() => null);
    const temp = file.temp ? await readSafeFile(root, file.temp, file.relativePath).catch(() => null) : null;
    files.push(Object.freeze({
      relativePath: file.relativePath,
      targetExists: Boolean(target),
      currentHash: current ? hash(current) : null,
      beforeHash: file.beforeHash ?? null,
      afterHash: file.afterHash ?? null,
      snapshotAvailable: Boolean(snapshot),
      tempAvailable: Boolean(temp),
      tempHash: temp ? hash(temp) : null,
      currentMatchesBefore: Boolean(current && file.beforeHash && hash(current) === file.beforeHash),
      currentMatchesAfter: Boolean(current && file.afterHash && hash(current) === file.afterHash),
      tempMatchesAfter: Boolean(temp && file.afterHash && hash(temp) === file.afterHash),
    }));
  }
  return Object.freeze({ transactionId: manifest.transactionId, state: manifest.state, files: Object.freeze(files) });
}

export function decideRecovery(report) {
  if (!report || !Array.isArray(report.files) || report.files.length === 0) throw new RecoveryError('REPORT_INVALID', 'invalid recovery report');
  const states = report.files.map((file) => {
    if (!file.snapshotAvailable) return 'blocked';
    if (file.currentMatchesAfter) return 'already_committed';
    if (file.currentMatchesBefore && file.tempAvailable && file.tempMatchesAfter) return 'can_resume';
    if (file.currentMatchesBefore) return 'can_resume_or_discard';
    return 'conflict';
  });
  if (states.includes('conflict')) return Object.freeze({ decision: 'blocked', reason: 'CONCURRENT_MODIFICATION', states: Object.freeze(states) });
  if (states.every((state) => state === 'already_committed')) return Object.freeze({ decision: 'mark_committed', states: Object.freeze(states) });
  if (states.includes('blocked')) return Object.freeze({ decision: 'blocked', reason: 'RECOVERY_MATERIAL_MISSING', states: Object.freeze(states) });
  return Object.freeze({ decision: 'requires_approval', states: Object.freeze(states) });
}

export async function finalizeAlreadyCommitted({ root, manifest, manifestPath, audit } = {}) {
  validateTransactionManifest({ root, manifest });
  if (!manifestPath || !inside(root, manifestPath)) throw new RecoveryError('MANIFEST_PATH_INVALID', 'manifestPath');
  return withRecoveryLock(root, async () => {
    const report = await inspectPendingTransaction({ root, manifest });
    const decision = decideRecovery(report);
    if (decision.decision !== 'mark_committed') throw new RecoveryError('FINALIZE_NOT_APPLICABLE', decision.decision, decision);
    const next = { ...manifest, state: 'committed' };
    await atomicWriteManifest(root, manifestPath, next);
    if (audit) await audit.append({ type: 'transaction.mark_committed', actor: 'system', transactionId: manifest.transactionId, files: manifest.files.map((file) => file.relativePath), state: 'committed' });
    return Object.freeze({ transactionId: manifest.transactionId, state: 'committed' });
  });
}

export async function executeRecovery({ root, manifest, manifestPath, mode, approved = false, audit, renameFile = rename, updateManifest } = {}) {
  validateTransactionManifest({ root, manifest });
  if (!approved) throw new RecoveryError('APPROVAL_REQUIRED', 'recovery requires explicit approval');
  if (mode !== 'rollback' && mode !== 'resume') throw new RecoveryError('MODE_INVALID', mode ?? 'missing mode');
  return withRecoveryLock(root, async () => {
    const report = await inspectPendingTransaction({ root, manifest });
    const decision = decideRecovery(report);
    if (decision.decision === 'blocked') throw new RecoveryError('RECOVERY_BLOCKED', decision.reason, decision);
    if (mode === 'resume' && !report.files.every((file) => file.currentMatchesAfter || (file.currentMatchesBefore && file.tempAvailable && file.tempMatchesAfter))) {
      throw new RecoveryError('RESUME_NOT_APPLICABLE', decision.decision);
    }
    if (mode === 'rollback' && !report.files.every((file) => file.currentMatchesBefore || file.currentMatchesAfter)) throw new RecoveryError('ROLLBACK_CONFLICT', 'current files are not in a known transaction state');
    const applied = [];
    try {
      for (const file of manifest.files) {
        await assertSafeExistingPath(root, file.target, file.relativePath);
        if (file.snapshot) await assertSafeExistingPath(root, file.snapshot, file.relativePath);
        if (file.temp) await assertSafeExistingPath(root, file.temp, file.relativePath);
        if (mode === 'resume' && file.temp && !report.files.find((item) => item.relativePath === file.relativePath).currentMatchesAfter) {
          const content = await readSafeFile(root, file.temp, file.relativePath).catch((error) => { throw new RecoveryError('TEMP_UNAVAILABLE', file.relativePath, { error: error.message }); });
          if (hash(content) !== file.afterHash) throw new RecoveryError('TEMP_HASH_MISMATCH', file.relativePath);
          try {
            await replaceWithinStableParent({ root, source: file.temp, target: file.target, renameFile, expectedSourceHash: file.afterHash, expectedTargetHash: file.beforeHash, expectedAfterHash: file.afterHash });
            applied.push(file);
          } catch (error) {
            if (error.details?.replaced) applied.push(file);
            throw error;
          }
        } else if (mode === 'rollback' && file.snapshot && !report.files.find((item) => item.relativePath === file.relativePath).currentMatchesBefore) {
          const content = await readSafeFile(root, file.snapshot, file.relativePath).catch((error) => { throw new RecoveryError('SNAPSHOT_UNAVAILABLE', file.relativePath, { error: error.message }); });
          if (!content) throw new RecoveryError('SNAPSHOT_UNAVAILABLE', file.relativePath);
          if (hash(content) !== file.beforeHash) throw new RecoveryError('SNAPSHOT_HASH_MISMATCH', file.relativePath);
          const temp = `${file.target}.ocw-recovery.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          await writeStableFile(root, temp, content, 'recovery staging write');
          try {
            await replaceWithinStableParent({ root, source: temp, target: file.target, renameFile, expectedSourceHash: file.beforeHash, expectedTargetHash: file.afterHash, expectedAfterHash: file.beforeHash });
            applied.push(file);
          } catch (error) {
            if (error.details?.replaced) applied.push(file);
            await unlinkStableFile(root, temp).catch(() => {});
            throw error;
          }
        }
      }
    } catch (error) {
      const rollbackErrors = [];
      const appliedPaths = applied.map((file) => file.relativePath);
      for (const file of [...applied].reverse()) {
        try {
          // resume 的补偿回到 before；rollback 的补偿必须回到原来的 after，不能再次写入快照。
          const compensationSource = mode === 'resume' ? file.snapshot : file.temp;
          const expectedCompensationHash = mode === 'resume' ? file.beforeHash : file.afterHash;
          if (!compensationSource) throw new RecoveryError('COMPENSATION_MATERIAL_MISSING', file.relativePath);
          const content = await readSafeFile(root, compensationSource, file.relativePath);
          if (hash(content) !== expectedCompensationHash) throw new RecoveryError('COMPENSATION_HASH_MISMATCH', file.relativePath);
          const temp = `${file.target}.ocw-recovery-rollback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          await writeStableFile(root, temp, content, 'recovery rollback staging write');
          try {
            await replaceWithinStableParent({ root, source: temp, target: file.target, renameFile, expectedSourceHash: expectedCompensationHash, expectedTargetHash: mode === 'resume' ? file.afterHash : file.beforeHash, expectedAfterHash: expectedCompensationHash });
          } catch (error) {
            await unlinkStableFile(root, temp).catch(() => {});
            throw error;
          }
        } catch (rollbackError) { rollbackErrors.push({ path: file.relativePath, error: rollbackError.message }); }
      }
      const failureCode = rollbackErrors.length ? 'ROLLBACK_PARTIAL' : 'RECOVERY_APPLY_FAILED';
      const failureState = rollbackErrors.length ? 'rollback_partial' : 'recovery_apply_failed';
      let recoveryManifestWritten = false;
      if (manifestPath && inside(root, manifestPath)) {
        try {
          await atomicWriteManifest(root, manifestPath, { ...manifest, state: failureState, recoveryError: { code: failureCode, message: error.message, applied: appliedPaths, rollbackErrors } });
          recoveryManifestWritten = true;
        } catch { /* 状态落盘失败不掩盖恢复主错误 */ }
      }
      if (audit) await audit.append({ type: 'transaction.recovery_apply_failed', actor: 'system', transactionId: manifest.transactionId, files: manifest.files.map((file) => file.relativePath), code: failureCode, applied: appliedPaths, rollbackErrors, recoveryManifestWritten }).catch(() => {});
      throw new RecoveryError(failureCode, error.message, { state: failureState, applied: appliedPaths, rollbackErrors, recoveryManifestWritten });
    }
    const finalState = mode === 'rollback' ? 'rolled_back' : 'committed';
    // 具备清单路径时，成功恢复必须同步落盘终态；否则下次扫描会把已完成事务再次当作 pending。
    const finalize = updateManifest ?? (manifestPath ? async (next) => atomicWriteManifest(root, manifestPath, next) : null);
    if (finalize) {
      try { await finalize({ ...manifest, state: finalState }); }
      catch (error) {
        let recoveryManifestWritten = false;
        if (manifestPath && inside(root, manifestPath)) {
          try {
            await atomicWriteManifest(root, manifestPath, { ...manifest, state: 'finalize_failed', finalizeError: { state: finalState, message: error.message } });
            recoveryManifestWritten = true;
          } catch { /* 保留 FINALIZE_FAILED；下一次启动仍可依靠文件 hash 重新判断 */ }
        }
        if (audit) await audit.append({ type: 'transaction.finalize_failed', actor: 'system', transactionId: manifest.transactionId, files: manifest.files.map((file) => file.relativePath), state: finalState, recoveryManifestWritten, error: error.message }).catch(() => {});
        throw new RecoveryError('FINALIZE_FAILED', error.message, { state: finalState, recoveryManifestWritten });
      }
    }
    if (audit) await audit.append({ type: `transaction.${mode}`, actor: 'user-approved', transactionId: manifest.transactionId, files: manifest.files.map((file) => file.relativePath), state: finalState });
    return Object.freeze({ transactionId: manifest.transactionId, mode, state: finalState });
  });
}

export const recoverableStates = Object.freeze([...STATES]);
