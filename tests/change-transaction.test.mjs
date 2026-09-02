import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseUnifiedPatch } from '../runtime/patch-engine.mjs';
import { acquireWorkspaceWriteLock, applyPatchTransaction, applyHunks, TransactionError } from '../runtime/change-transaction.mjs';
import { decideRecovery, executeRecovery, finalizeAlreadyCommitted, inspectPendingTransaction, scanPendingTransactions, validateTransactionManifest } from '../runtime/recovery.mjs';
import { mkdir } from 'node:fs/promises';
import { scanStartupRecovery } from '../runtime/startup-recovery.mjs';
import { startWorkbench } from '../runtime/index.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-tx-'));
  await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
  await writeFile(path.join(root, 'b.txt'), 'alpha\nbeta\n');
  return root;
}

const transactionManifestPath = (root, transactionId) => path.join(root, '.openclaw-workbench', 'transactions', `${transactionId}.json`);
const testManifestWriter = async () => {};

test('stale write lock 仅在进程已退出且超过阈值时接管', async () => {
  const root = await fixture();
  const lockDir = path.join(root, '.openclaw-workbench'); await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, 'write.lock'), JSON.stringify({ pid: 99999, createdAt: 100, token: 'stale-token-123456' }));
  const release = await acquireWorkspaceWriteLock(root, { now: 1000, staleAfterMs: 500, isProcessAlive: async () => false });
  await release();
});

test('stale lock 接管后重新创建新锁并可释放', async () => {
  const root = await fixture();
  const lockDir = path.join(root, '.openclaw-workbench'); await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, 'write.lock'), JSON.stringify({ pid: 99999, createdAt: 100, token: 'stale-token-123456' }));
  const release = await acquireWorkspaceWriteLock(root, { now: 1000, staleAfterMs: 500, isProcessAlive: async () => false });
  const metadata = JSON.parse(await readFile(path.join(lockDir, 'write.lock'), 'utf8'));
  assert.equal(metadata.pid, process.pid);
  assert.notEqual(metadata.token, 'stale-token-123456');
  await release();
});

test('旧持有者释放时不得删除接管后的新锁', async () => {
  const root = await fixture();
  const lockDir = path.join(root, '.openclaw-workbench'); await mkdir(lockDir, { recursive: true });
  const first = await acquireWorkspaceWriteLock(root);
  const oldRelease = first;
  const lockPath = path.join(lockDir, 'write.lock');
  const old = JSON.parse(await readFile(lockPath, 'utf8'));
  await (await import('node:fs/promises')).rename(lockPath, `${lockPath}.stale-test`);
  const second = await acquireWorkspaceWriteLock(root);
  await oldRelease();
  const current = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.notEqual(current.token, old.token);
  await second();
});

test('活动或损坏 write lock 不得自动接管', async () => {
  const root = await fixture();
  const lockDir = path.join(root, '.openclaw-workbench'); await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, 'write.lock'), 'bad');
  await assert.rejects(() => acquireWorkspaceWriteLock(root), (e) => e.code === 'BUSY');
});

test('事务被跨进程文件锁阻断', async () => {
  const root = await fixture();
  const lockDir = path.join(root, '.openclaw-workbench');
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, 'write.lock'), 'held');
  const parsed = parseUnifiedPatch(`--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n`);
  await assert.rejects(() => applyPatchTransaction({ root, parsedPatch: parsed, declaredPaths: ['a.txt'], currentRevision: 'r1' }), (e) => e.code === 'BUSY');
});

test('事务生命周期写入审计事件', async () => {
  const root = await fixture();
  const audit = { events: [], async append(event) { this.events.push(event); return event; } };
  const parsed = parseUnifiedPatch(`--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n`);
  await applyPatchTransaction({ root, parsedPatch: parsed, declaredPaths: ['a.txt'], currentRevision: 'r1', audit });
  assert.deepEqual(audit.events.map((event) => event.type), ['transaction.prepared', 'transaction.committing', 'transaction.committed']);
});

test('审计失败不掩盖已提交事务，保留 committed 清单', async () => {
  const root = await fixture();
  const parsed = parseUnifiedPatch(`--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n`);
  const audit = { async append(event) { if (event.type === 'transaction.committed') throw new Error('audit unavailable'); } };
  await assert.rejects(() => applyPatchTransaction({ root, parsedPatch: parsed, declaredPaths: ['a.txt'], currentRevision: 'r1', audit }), /audit unavailable/);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\n');
  const dir = path.join(root, '.openclaw-workbench', 'transactions');
  const files = await (await import('node:fs/promises')).readdir(dir);
  const manifest = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'));
  assert.equal(manifest.state, 'committed');
});

test('多文件 Patch 先全部预检，再一次提交', async () => {
  const root = await fixture();
  const parsed = parseUnifiedPatch(`--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n--- a/b.txt\n+++ b/b.txt\n@@ -1,2 +1,2 @@\n-alpha\n+ALPHA\n beta\n`);
  const result = await applyPatchTransaction({ root, parsedPatch: parsed, declaredPaths: ['a.txt', 'b.txt'], expectedRevision: 'r1', currentRevision: 'r1' });
  assert.equal(result.files.length, 2);
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(manifest.state, 'committed');
  assert.equal(manifest.files.length, 2);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\n');
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'ALPHA\nbeta\n');
});

test('任一文件预检失败时，不修改任何文件', async () => {
  const root = await fixture();
  const parsed = parseUnifiedPatch(`--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n--- a/b.txt\n+++ b/b.txt\n@@ -1,2 +1,2 @@\n-wrong\n+ALPHA\n beta\n`);
  await assert.rejects(() => applyPatchTransaction({ root, parsedPatch: parsed, declaredPaths: ['a.txt', 'b.txt'] }), (e) => e.code === 'CONTENT_MISMATCH');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'alpha\nbeta\n');
});

test('工作区 revision 变化时拒绝事务', async () => {
  const root = await fixture();
  const parsed = parseUnifiedPatch(`--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n`);
  await assert.rejects(() => applyPatchTransaction({ root, parsedPatch: parsed, declaredPaths: ['a.txt'], expectedRevision: 'r1', currentRevision: 'r2' }), (e) => e instanceof TransactionError && e.code === 'REVISION_MISMATCH');
});

test('扫描未完成事务并忽略已完成事务', async () => {
  const root = await fixture();
  const dir = path.join(root, '.openclaw-workbench', 'transactions');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'pending.json'), JSON.stringify({ transactionId: 'tx-1', state: 'committing', files: [] }));
  await writeFile(path.join(dir, 'done.json'), JSON.stringify({ transactionId: 'tx-2', state: 'committed', files: [] }));
  const pending = await scanPendingTransactions({ root });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].transactionId, 'tx-1');
  assert.equal(pending[0].manifestPath, path.join(dir, 'pending.json'));
});

test('拒绝非法或损坏事务清单', async () => {
  const root = await fixture();
  const dir = path.join(root, '.openclaw-workbench', 'transactions');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'bad.json'), '{broken');
  await assert.rejects(() => scanPendingTransactions({ root }), (e) => e.code === 'MANIFEST_INVALID');
});

test('恢复扫描拒绝 transactions 目录符号链接', async () => {
  const root = await fixture();
  const stateRoot = path.join(root, '.openclaw-workbench');
  const outside = await mkdtemp(path.join(tmpdir(), 'ocw-transactions-outside-'));
  await mkdir(stateRoot, { recursive: true });
  await symlink(outside, path.join(stateRoot, 'transactions'));
  await assert.rejects(() => scanPendingTransactions({ root }), (error) => error.code === 'SCAN_FAILED');
});

test('恢复清单拒绝工作区外路径', async () => {
  const root = await fixture();
  assert.throws(() => validateTransactionManifest({ root, manifest: { transactionId: 'x', state: 'committing', files: [{ relativePath: 'a.txt', target: '/tmp/escape', snapshot: path.join(root, 'snap') }] } }), (e) => e.code === 'MANIFEST_PATH_INVALID');
});

test('事务存储目录是符号链接时拒绝写入', async () => {
  const root = await fixture();
  const parsed = parseUnifiedPatch(`--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n`);
  const workbench = path.join(root, '.openclaw-workbench');
  const outside = await mkdtemp(path.join(tmpdir(), 'ocw-storage-outside-'));
  await mkdir(workbench, { recursive: true });
  await symlink(outside, path.join(workbench, 'transactions'));
  await assert.rejects(() => applyPatchTransaction({ root, parsedPatch: parsed, declaredPaths: ['a.txt'] }), (e) => e.code === 'STORAGE_PATH_CHANGED');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal((await (await import('node:fs/promises')).readdir(outside)).length, 0);
});

test('快照存储目录是符号链接时拒绝写入', async () => {
  const root = await fixture();
  const parsed = parseUnifiedPatch(`--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n`);
  const workbench = path.join(root, '.openclaw-workbench');
  const outside = await mkdtemp(path.join(tmpdir(), 'ocw-snapshot-outside-'));
  await mkdir(workbench, { recursive: true });
  await symlink(outside, path.join(workbench, 'snapshots'));
  await assert.rejects(() => applyPatchTransaction({ root, parsedPatch: parsed, declaredPaths: ['a.txt'] }), (e) => e.code === 'STORAGE_PATH_CHANGED');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal((await (await import('node:fs/promises')).readdir(outside)).length, 0);
});

test('恢复清单拒绝 relativePath 与实际 target 不一致', async () => {
  const root = await fixture();
  assert.throws(() => validateTransactionManifest({ root, manifest: { transactionId: 'x', state: 'committing', files: [{ relativePath: 'a.txt', target: path.join(root, 'b.txt') }] } }), (e) => e.code === 'MANIFEST_PATH_INVALID');
});

test('检查恢复材料时拒绝符号链接逃逸', async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'ocw-outside-'));
  const link = path.join(root, 'escape');
  await symlink(outside, link);
  const manifest = { transactionId: 'tx-escape', state: 'committing', files: [{ relativePath: 'escape/a.txt', target: path.join(link, 'a.txt'), snapshot: path.join(root, 'snap'), beforeHash: 'bad', afterHash: 'bad' }] };
  await assert.rejects(() => inspectPendingTransaction({ root, manifest }), (e) => e.code === 'RECOVERY_PATH_ESCAPE');
});

test('检查未完成事务时报告当前文件与快照状态', async () => {
  const root = await fixture();
  const dir = path.join(root, '.openclaw-workbench', 'transactions');
  await mkdir(dir, { recursive: true });
  const snapshot = path.join(root, '.openclaw-workbench', 'snapshots', 'a.snap');
  await mkdir(path.dirname(snapshot), { recursive: true });
  await writeFile(snapshot, 'one\\ntwo\\n');
  const manifest = { transactionId: 'tx-inspect', state: 'committing', files: [{ relativePath: 'a.txt', target: path.join(root, 'a.txt'), snapshot, beforeHash: 'bad', afterHash: 'also-bad' }] };
  const report = await inspectPendingTransaction({ root, manifest });
  assert.equal(report.files[0].targetExists, true);
  assert.equal(report.files[0].snapshotAvailable, true);
  assert.equal(report.files[0].currentMatchesBefore, false);
  assert.equal(report.files[0].currentMatchesAfter, false);
});

test('恢复决策遇到并发修改时阻断', () => {
  const result = decideRecovery({ files: [{ snapshotAvailable: true, currentMatchesBefore: false, currentMatchesAfter: false }] });
  assert.equal(result.decision, 'blocked');
  assert.equal(result.reason, 'CONCURRENT_MODIFICATION');
});

test('恢复决策对已提交事务只建议标记完成', () => {
  const result = decideRecovery({ files: [{ snapshotAvailable: true, currentMatchesBefore: false, currentMatchesAfter: true }, { snapshotAvailable: true, currentMatchesBefore: false, currentMatchesAfter: true }] });
  assert.equal(result.decision, 'mark_committed');
});

test('恢复决策不会绕过审批自动继续', () => {
  const result = decideRecovery({ files: [{ snapshotAvailable: true, currentMatchesBefore: true, currentMatchesAfter: false }] });
  assert.equal(result.decision, 'requires_approval');
});

test('启动扫描隔离损坏 JSON，并继续处理其他事务', async () => {
  const root = await fixture(); const dir = path.join(root, '.openclaw-workbench', 'transactions'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'broken.json'), '{broken');
  const result = await scanStartupRecovery({ root });
  assert.equal(result[0].decision, 'error'); assert.equal(result[0].error.code, 'MANIFEST_INVALID');
});

test('启动扫描失败通过独立回调上报并保留 SCAN_FAILED', async () => {
  const root = await fixture(); const workbench = path.join(root, '.openclaw-workbench'); await mkdir(workbench, { recursive: true });
  await writeFile(path.join(workbench, 'transactions'), '{}');
  const failures = [];
  await assert.rejects(() => scanStartupRecovery({ root, onScanError: (failure) => failures.push(failure) }), (error) => error.code === 'SCAN_FAILED');
  assert.equal(failures[0].error.code, 'SCAN_FAILED');
});

test('启动告警回调失败不阻断扫描结果', async () => {
  const root = await fixture(); const dir = path.join(root, '.openclaw-workbench', 'transactions'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'broken.json'), '{broken');
  const result = await scanStartupRecovery({ root, onError: async () => { throw new Error('alert offline'); } });
  assert.equal(result[0].decision, 'error'); assert.equal(result[0].alertError.code, 'STARTUP_ALERT_FAILED');
});

test('启动扫描隔离单项失败并继续处理其他事务', async () => {
  const root = await fixture(); const dir = path.join(root, '.openclaw-workbench', 'transactions'); await mkdir(dir, { recursive: true });
  const target = path.join(root, 'a.txt'); const content = await readFile(target); const digest = createHash('sha256').update(content).digest('hex');
  const snapshot = path.join(root, 'a.snapshot'); await writeFile(snapshot, content);
  const valid = { transactionId: 'tx-valid', state: 'committing', files: [{ relativePath: 'a.txt', target, snapshot, beforeHash: digest, afterHash: digest }] };
  const invalid = { transactionId: 'tx-invalid', state: 'committing', files: [{ relativePath: 'a.txt', target: path.join(root, '..', 'escape'), snapshot }] };
  await writeFile(transactionManifestPath(root, valid.transactionId), JSON.stringify(valid)); await writeFile(path.join(dir, 'b-invalid.json'), JSON.stringify(invalid));
  const failures = []; const result = await scanStartupRecovery({ root, onError: (failure) => failures.push(failure) });
  assert.equal(result.length, 2); assert.equal(result.find((item) => item.transactionId === 'tx-valid').finalized, true); assert.equal(result.find((item) => item.transactionId === 'tx-invalid').decision, 'error'); assert.equal(failures.length, 1);
});

test('整轮扫描告警回调失败仍保留原始 SCAN_FAILED', async () => {
  const root = await fixture(); const workbench = path.join(root, '.openclaw-workbench'); await mkdir(workbench, { recursive: true });
  await writeFile(path.join(workbench, 'transactions'), '{}');
  const result = await startWorkbench({ root, onStartupScanError: async () => { throw new Error('alert offline'); } });
  assert.equal(result.fatalError.code, 'SCAN_FAILED'); assert.equal(result.fatalError.alertError.code, 'STARTUP_ALERT_FAILED');
});

test('正式启动入口将整轮扫描失败转换为可交付 fatalError', async () => {
  const root = await fixture(); const workbench = path.join(root, '.openclaw-workbench'); await mkdir(workbench, { recursive: true });
  await writeFile(path.join(workbench, 'transactions'), '{}');
  const result = await startWorkbench({ root });
  assert.equal(result.summary.errors, 1); assert.equal(result.fatalError.code, 'SCAN_FAILED');
});

test('正式启动入口返回恢复摘要且不自动执行审批动作', async () => {
  const root = await fixture();
  const result = await startWorkbench({ root });
  assert.deepEqual(result.summary, { scanned: 0, finalized: 0, errors: 0, approvalsRequired: 0, blocked: 0 });
});

test('启动扫描仅自动收敛已完成事务，不自动恢复冲突事务', async () => {
  const root = await fixture(); const dir = path.join(root, '.openclaw-workbench', 'transactions'); await mkdir(dir, { recursive: true });
  const target = path.join(root, 'a.txt'); const content = await readFile(target); const digest = createHash('sha256').update(content).digest('hex');
  const snapshot = path.join(root, 'a.snapshot'); await writeFile(snapshot, content);
  const manifest = { transactionId: 'tx-startup', state: 'committing', files: [{ relativePath: 'a.txt', target, snapshot, beforeHash: digest, afterHash: digest }] };
  await writeFile(transactionManifestPath(root, manifest.transactionId), JSON.stringify(manifest));
  const result = await scanStartupRecovery({ root });
  assert.equal(result[0].finalized, true); assert.equal(result[0].decision, 'mark_committed');
  assert.equal(JSON.parse(await readFile(transactionManifestPath(root, manifest.transactionId), 'utf8')).state, 'committed');
});

test('启动恢复可再次收敛 finalize_failed 且文件已全部达到 afterHash 的事务', async () => {
  const root = await fixture(); const target = path.join(root, 'a.txt'); const snapshot = path.join(root, 'a.snapshot');
  await writeFile(target, 'one\\n'); await writeFile(snapshot, 'old\\n');
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const manifest = { transactionId: 'tx-finalize-retry', state: 'finalize_failed', files: [{ relativePath: 'a.txt', target, snapshot, beforeHash: digest(Buffer.from('old\\n')), afterHash: digest(Buffer.from('one\\n')) }] };
  const dir = path.join(root, '.openclaw-workbench', 'transactions'); await mkdir(dir, { recursive: true });
  await writeFile(transactionManifestPath(root, manifest.transactionId), JSON.stringify(manifest));
  const results = await scanStartupRecovery({ root });
  assert.equal(results[0].finalized, true); assert.equal(results[0].decision, 'mark_committed'); assert.equal(JSON.parse(await readFile(transactionManifestPath(root, manifest.transactionId), 'utf8')).state, 'committed');
});

test('finalize_failed 文件未完全达到 afterHash 时不会跳过决策强行标记 committed', async () => {
  const root = await fixture(); const target = path.join(root, 'a.txt'); const snapshot = path.join(root, 'a.snapshot');
  await writeFile(target, 'changed\n'); await writeFile(snapshot, 'old\n');
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const manifest = { transactionId: 'tx-finalize-conflict', state: 'finalize_failed', files: [{ relativePath: 'a.txt', target, snapshot, beforeHash: digest(Buffer.from('old\n')), afterHash: digest(Buffer.from('one\n')) }] };
  const dir = path.join(root, '.openclaw-workbench', 'transactions'); await mkdir(dir, { recursive: true });
  const manifestPath = path.join(dir, 'tx.json'); await writeFile(manifestPath, JSON.stringify(manifest));
  const results = await scanStartupRecovery({ root });
  assert.equal(results[0].finalized, false); assert.equal(results[0].decision, 'blocked'); assert.equal(results[0].report.files[0].currentMatchesAfter, false);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'finalize_failed');
});

test('已全部写入 afterHash 时可原子标记 committed', async () => {
  const root = await fixture(); const manifestPath = transactionManifestPath(root, 'tx-already-done');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const target = path.join(root, 'a.txt'); const content = await readFile(target); const digest = createHash('sha256').update(content).digest('hex');
  const snapshot = path.join(root, 'a.snapshot'); await writeFile(snapshot, content);
  const manifest = { transactionId: 'tx-already-done', state: 'committing', files: [{ relativePath: 'a.txt', target, snapshot, beforeHash: digest, afterHash: digest }] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await finalizeAlreadyCommitted({ root, manifest, manifestPath });
  assert.equal(result.state, 'committed');
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'committed');
});

test('恢复操作没有明确审批时拒绝执行', async () => {
  const root = await fixture();
  const manifest = { transactionId: 'tx-approval', state: 'committing', files: [{ relativePath: 'a.txt', target: path.join(root, 'a.txt'), snapshot: path.join(root, 'a.txt') }] };
  await assert.rejects(() => executeRecovery({ root, manifest, mode: 'rollback' }), (e) => e.code === 'APPROVAL_REQUIRED');
});

test('并发 recovery 被文件锁阻断', async () => {
  const root = await fixture();
  const lockDir = path.join(root, '.openclaw-workbench');
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, 'write.lock'), 'held');
  const manifest = { transactionId: 'tx-busy', state: 'committing', files: [{ relativePath: 'a.txt', target: path.join(root, 'a.txt'), snapshot: path.join(root, 'a.txt') }] };
  await assert.rejects(() => executeRecovery({ root, manifest, mode: 'rollback', approved: true }), (e) => e.code === 'BUSY');
});

test('已审批 rollback 使用快照恢复并记录审计', async () => {
  const root = await fixture();
  const snapshot = path.join(root, 'a.snapshot');
  await writeFile(snapshot, 'one\\ntwo\\n');
  const before = 'one\\ntwo\\n';
  const current = await readFile(path.join(root, 'a.txt'));
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const manifest = { transactionId: 'tx-rollback', state: 'committing', files: [{ relativePath: 'a.txt', target: path.join(root, 'a.txt'), snapshot, beforeHash: sha(before), afterHash: sha(current) }] };
  const events = [];
  const result = await executeRecovery({ root, manifest, mode: 'rollback', approved: true, updateManifest: testManifestWriter, audit: { append: async (event) => events.push(event) } });
  assert.equal(result.state, 'rolled_back');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\\ntwo\\n');
  assert.equal(events[0].type, 'transaction.rollback');
});

test('rollback 拒绝 hash 不匹配的快照且不改写目标', async () => {
  const root = await fixture();
  const target = path.join(root, 'a.txt');
  const snapshot = path.join(root, 'a.snapshot');
  const before = Buffer.from('one\ntwo\n');
  const after = Buffer.from('one\nTWO\n');
  await writeFile(target, after);
  await writeFile(snapshot, 'tampered\n');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const manifest = { transactionId: 'tx-rollback-snapshot-hash', state: 'committing', files: [{
    relativePath: 'a.txt', target, snapshot, beforeHash: sha(before), afterHash: sha(after),
  }] };
  await assert.rejects(() => executeRecovery({ root, manifest, mode: 'rollback', approved: true, updateManifest: testManifestWriter }), (error) => error.code === 'RECOVERY_APPLY_FAILED');
  assert.equal(await readFile(target, 'utf8'), 'one\nTWO\n');
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.ocw-recovery-')), []);
});

test('rollback staging 替换失败时清理稳定目录中的临时文件', async () => {
  const root = await fixture();
  const target = path.join(root, 'a.txt');
  const snapshot = path.join(root, 'a.snapshot');
  await writeFile(snapshot, 'zero\none\n');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const manifest = { transactionId: 'tx-rollback-cleanup', state: 'committing', files: [{
    relativePath: 'a.txt', target, snapshot,
    beforeHash: sha(Buffer.from('zero\none\n')),
    afterHash: sha(Buffer.from('one\ntwo\n')),
  }] };
  await assert.rejects(() => executeRecovery({
    root, manifest, mode: 'rollback', approved: true, updateManifest: testManifestWriter,
    renameFile: async () => { throw new Error('injected rollback failure'); },
  }), (error) => error.code === 'RECOVERY_APPLY_FAILED');
  assert.equal(await readFile(target, 'utf8'), 'one\ntwo\n');
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.ocw-recovery-')), []);
});

test('多文件 recovery 中途失败时回滚已应用文件', async () => {
  const root = await fixture();
  const a = path.join(root, 'a.txt');
  const b = path.join(root, 'b.txt');
  const sa = path.join(root, 'a.snapshot');
  const sb = path.join(root, 'b.snapshot');
  await writeFile(sa, 'one\ntwo\n');
  await writeFile(sb, 'alpha\nbeta\n');
  const currentA = await readFile(a); const currentB = await readFile(b);
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const manifest = { transactionId: 'tx-multi-recovery', state: 'committing', files: [
    { relativePath: 'a.txt', target: a, snapshot: sa, beforeHash: sha(currentA), afterHash: sha(Buffer.from('one\\nTWO\\n')), temp: path.join(root, 'a.temp') },
    { relativePath: 'b.txt', target: b, snapshot: sb, beforeHash: sha(currentB), afterHash: sha(Buffer.from('alpha\\nBETA\\n')), temp: path.join(root, 'b.temp') },
  ] };
  await writeFile(manifest.files[0].temp, 'one\\nTWO\\n');
  await writeFile(manifest.files[1].temp, 'alpha\\nBETA\\n');
  let calls = 0;
  const manifestPath = transactionManifestPath(root, manifest.transactionId); await mkdir(path.dirname(manifestPath), { recursive: true }); await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => executeRecovery({ root, manifest, manifestPath, mode: 'resume', approved: true, renameFile: async (...args) => { calls += 1; if (calls === 2) throw new Error('injected failure'); return (await import('node:fs/promises')).rename(...args); } }), (e) => (e.code === 'RECOVERY_APPLY_FAILED' || e.code === 'ROLLBACK_PARTIAL') && e.details.recoveryManifestWritten === true);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'recovery_apply_failed');
  assert.equal(await readFile(a, 'utf8'), 'one\ntwo\n');
});

test('recovery 替换后校验失败仍将已替换文件纳入补偿回滚', async () => {
  const root = await fixture();
  const target = path.join(root, 'a.txt');
  const temp = path.join(root, 'a.temp');
  const snapshot = path.join(root, 'a.snapshot');
  await writeFile(temp, 'one\nTWO\n');
  await writeFile(snapshot, 'one\ntwo\n');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const manifest = { transactionId: 'tx-recovery-post-verify', state: 'committing', files: [{
    relativePath: 'a.txt', target, temp, snapshot,
    beforeHash: sha(Buffer.from('one\ntwo\n')),
    afterHash: sha(Buffer.from('one\nTWO\n')),
  }] };
  const originalRename = (await import('node:fs/promises')).rename;
  let renameCalls = 0;
  await assert.rejects(() => executeRecovery({
    root, manifest, mode: 'resume', approved: true, updateManifest: testManifestWriter,
    renameFile: async (...args) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        await originalRename(...args);
        await writeFile(args[1], 'corrupted\\n');
      } else {
        await writeFile(args[1], 'one\\nTWO\\n');
        await originalRename(...args);
      }
    },
  }), (error) => error.code === 'ROLLBACK_PARTIAL' && renameCalls === 1);
  assert.equal(await readFile(target, 'utf8'), 'corrupted\\n');
});

test('recovery 替换期间可见父目录被替换时仍写入原目录 inode', async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'ocw-recovery-outside-'));
  const visibleDir = path.join(root, 'nested');
  const stableDir = path.join(root, 'nested-original');
  const target = path.join(visibleDir, 'a.txt');
  const temp = path.join(visibleDir, 'a.temp');
  const snapshot = path.join(visibleDir, 'a.snapshot');
  await mkdir(visibleDir);
  await writeFile(target, 'one\\ntwo\\n');
  await writeFile(temp, 'one\\nTWO\\n');
  await writeFile(snapshot, 'one\\ntwo\\n');
  await writeFile(path.join(outside, 'a.txt'), 'outside\\n');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const manifest = { transactionId: 'tx-recovery-parent-drift', state: 'committing', files: [{
    relativePath: 'nested/a.txt', target, temp, snapshot,
    beforeHash: sha(Buffer.from('one\\ntwo\\n')),
    afterHash: sha(Buffer.from('one\\nTWO\\n')),
  }] };
  const fsRename = (await import('node:fs/promises')).rename;
  let swapped = false;
  const result = await executeRecovery({
    root, manifest, mode: 'resume', approved: true, updateManifest: testManifestWriter,
    renameFile: async (...args) => {
      if (!swapped) {
        swapped = true;
        await fsRename(visibleDir, stableDir);
        await symlink(outside, visibleDir);
      }
      return fsRename(...args);
    },
  });
  assert.equal(result.state, 'committed');
  assert.equal(await readFile(path.join(stableDir, 'a.txt'), 'utf8'), 'one\\nTWO\\n');
  assert.equal(await readFile(path.join(visibleDir, 'a.txt'), 'utf8'), 'outside\\n');
});

test('rollback 已应用文件后失败时补偿回到 afterHash', async () => {
  const root = await fixture();
  const target = path.join(root, 'a.txt');
  const snapshot = path.join(root, 'a.snapshot');
  const temp = path.join(root, 'a.temp');
  const before = Buffer.from('one\ntwo\n');
  const after = Buffer.from('one\nTWO\n');
  await writeFile(target, after);
  await writeFile(snapshot, before);
  await writeFile(temp, after);
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const manifest = { transactionId: 'tx-rollback-compensation', state: 'committing', files: [{
    relativePath: 'a.txt', target, snapshot, temp, beforeHash: sha(before), afterHash: sha(after),
  }] };
  let calls = 0;
  await assert.rejects(() => executeRecovery({
    root, manifest, mode: 'rollback', approved: true, updateManifest: testManifestWriter,
    renameFile: async (...args) => {
      calls += 1;
      const result = await (await import('node:fs/promises')).rename(...args);
      if (calls === 1) throw Object.assign(new Error('injected rollback failure after replacement'), { details: { replaced: true } });
      return result;
    },
  }), (error) => error.code === 'RECOVERY_APPLY_FAILED');
  assert.equal(calls, 2);
  assert.equal(await readFile(target, 'utf8'), 'one\nTWO\n');
});

test('多文件混合状态要求审批且可区分恢复路径', async () => {
  const root = await fixture();
  const a = path.join(root, 'a.txt'); const b = path.join(root, 'b.txt');
  const sa = path.join(root, 'a.snapshot'); const sb = path.join(root, 'b.snapshot');
  const ta = path.join(root, 'a.temp'); const tb = path.join(root, 'b.temp');
  await writeFile(sa, 'one\ntwo\n'); await writeFile(sb, 'alpha\nbeta\n');
  await writeFile(ta, 'one\nTWO\n'); await writeFile(tb, 'alpha\nBETA\n');
  await writeFile(a, 'one\nTWO\n');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const report = await inspectPendingTransaction({ root, manifest: { transactionId: 'tx-mixed', state: 'committing', files: [
    { relativePath: 'a.txt', target: a, temp: ta, snapshot: sa, beforeHash: sha(Buffer.from('one\ntwo\n')), afterHash: sha(Buffer.from('one\nTWO\n')) },
    { relativePath: 'b.txt', target: b, temp: tb, snapshot: sb, beforeHash: sha(Buffer.from('alpha\nbeta\n')), afterHash: sha(Buffer.from('alpha\nBETA\n')) },
  ] } });
  const decision = decideRecovery(report);
  assert.equal(decision.decision, 'requires_approval');
  assert.deepEqual(decision.states, ['already_committed', 'can_resume']);
  await assert.rejects(() => executeRecovery({ root, manifest: { transactionId: 'tx-mixed', state: 'committing', files: [
    { relativePath: 'a.txt', target: a, temp: ta, snapshot: sa, beforeHash: sha(Buffer.from('one\ntwo\n')), afterHash: sha(Buffer.from('one\nTWO\n')) },
    { relativePath: 'b.txt', target: b, temp: tb, snapshot: sb, beforeHash: sha(Buffer.from('alpha\nbeta\n')), afterHash: sha(Buffer.from('alpha\nBETA\n')) },
  ] }, mode: 'resume' }), (error) => error.code === 'APPROVAL_REQUIRED');
});

test('缺少快照时恢复阻断且不读取临时材料', async () => {
  const root = await fixture();
  const target = path.join(root, 'a.txt'); const temp = path.join(root, 'a.temp');
  await writeFile(temp, 'one\nTWO\n');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const manifest = { transactionId: 'tx-no-snapshot', state: 'committing', files: [{ relativePath: 'a.txt', target, temp, beforeHash: sha(Buffer.from('one\ntwo\n')), afterHash: sha(Buffer.from('one\nTWO\n')) }] };
  const report = await inspectPendingTransaction({ root, manifest });
  assert.equal(report.files[0].snapshotAvailable, false);
  assert.equal(decideRecovery(report).reason, 'RECOVERY_MATERIAL_MISSING');
  await assert.rejects(() => executeRecovery({ root, manifest, mode: 'resume', approved: true }), (error) => error.code === 'RECOVERY_BLOCKED');
  assert.equal(await readFile(target, 'utf8'), 'one\ntwo\n');
});

test('提交第二个文件失败时恢复已提交文件并保留 rolled_back 清单', async () => {
  const root = await fixture();
  const parsed = parseUnifiedPatch(`--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n--- a/b.txt\n+++ b/b.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA\n`);
  let calls = 0;
  await assert.rejects(() => applyPatchTransaction({ root, parsedPatch: parsed, declaredPaths: ['a.txt', 'b.txt'], renameFile: async (...args) => {
    calls += 1;
    if (calls === 2) throw new Error('injected commit failure');
    return (await import('node:fs/promises')).rename(...args);
  } }), (error) => error.code === 'COMMIT_FAILED');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'alpha\nbeta\n');
  const entries = await (await import('node:fs/promises')).readdir(path.join(root, '.openclaw-workbench', 'transactions'));
  const manifest = JSON.parse(await readFile(path.join(root, '.openclaw-workbench', 'transactions', entries[0]), 'utf8'));
  assert.equal(manifest.state, 'rolled_back');
});

test('提交后校验失败时补偿回滚全部已提交文件', async () => {
  const root = await fixture();
  const parsed = parseUnifiedPatch(`--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n--- a/b.txt\n+++ b/b.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA\n`);
  const originalRename = (await import('node:fs/promises')).rename;
  await assert.rejects(() => applyPatchTransaction({ root, parsedPatch: parsed, declaredPaths: ['a.txt', 'b.txt'], getCurrentRevision: async () => 'r1', expectedRevision: 'r1', audit: { async append() {} },
    renameFile: async (...args) => { await originalRename(...args); if (args[1].endsWith(`${path.sep}a.txt`)) await writeFile(args[1], 'corrupted\n'); },
  }), (error) => error.code === 'POST_VERIFY_FAILED');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'alpha\nbeta\n');
});

test('恢复应用失败且回滚再次失败时保留 ROLLBACK_PARTIAL 现场', async () => {
  const root = await fixture();
  const a = path.join(root, 'a.txt'); const b = path.join(root, 'b.txt');
  const sa = path.join(root, 'a.snapshot'); const sb = path.join(root, 'b.snapshot');
  const ta = path.join(root, 'a.temp'); const tb = path.join(root, 'b.temp');
  await writeFile(sa, 'one\ntwo\n'); await writeFile(sb, 'alpha\nbeta\n');
  await writeFile(ta, 'one\nTWO\n'); await writeFile(tb, 'alpha\nBETA\n');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const manifest = { transactionId: 'tx-rollback-partial', state: 'committing', files: [
    { relativePath: 'a.txt', target: a, temp: ta, snapshot: sa, beforeHash: sha(Buffer.from('one\ntwo\n')), afterHash: sha(Buffer.from('one\nTWO\n')) },
    { relativePath: 'b.txt', target: b, temp: tb, snapshot: sb, beforeHash: sha(Buffer.from('alpha\nbeta\n')), afterHash: sha(Buffer.from('alpha\nBETA\n')) },
  ] };
  const manifestPath = transactionManifestPath(root, manifest.transactionId); await mkdir(path.dirname(manifestPath), { recursive: true }); await writeFile(manifestPath, JSON.stringify(manifest));
  let calls = 0;
  await assert.rejects(() => executeRecovery({ root, manifest, manifestPath, mode: 'resume', approved: true, renameFile: async (...args) => {
    calls += 1;
    if (calls === 2 || calls === 3) throw new Error(`injected rename failure ${calls}`);
    return (await import('node:fs/promises')).rename(...args);
  } }), (error) => error.code === 'ROLLBACK_PARTIAL' && error.details.rollbackErrors.length === 1);
  const failed = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(failed.state, 'rollback_partial');
  assert.equal(failed.recoveryError.code, 'ROLLBACK_PARTIAL');
});

test('resume 完成后可更新事务清单并记录最终状态', async () => {
  const root = await fixture();
  const temp = path.join(root, 'a.temp');
  const target = path.join(root, 'a.txt');
  const snapshot = path.join(root, 'a.snapshot');
  await writeFile(temp, 'one\\nTWO\\n'); await writeFile(snapshot, 'one\\ntwo\\n');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const before = await readFile(target);
  const after = await readFile(temp);
  const manifest = { transactionId: 'tx-finalize', state: 'committing', files: [{ relativePath: 'a.txt', target, temp, snapshot, beforeHash: sha(before), afterHash: sha(after) }] };
  let updated;
  const result = await executeRecovery({ root, manifest, mode: 'resume', approved: true, updateManifest: async (next) => { updated = next; } });
  assert.equal(result.state, 'committed');
  assert.equal(updated.state, 'committed');
  assert.equal(await readFile(target, 'utf8'), 'one\\nTWO\\n');
});

test('有 manifestPath 时恢复成功自动持久化终态', async () => {
  const root = await fixture();
  const target = path.join(root, 'a.txt');
  const snapshot = path.join(root, 'a.snapshot');
  const temp = path.join(root, 'a.temp');
  const manifestPath = transactionManifestPath(root, 'tx-auto-finalize');
  const before = Buffer.from('one\ntwo\n');
  const after = Buffer.from('one\nTWO\n');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  await writeFile(target, before); await writeFile(snapshot, before); await writeFile(temp, after);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const manifest = { transactionId: 'tx-auto-finalize', state: 'committing', files: [{ relativePath: 'a.txt', target, snapshot, temp, beforeHash: sha(before), afterHash: sha(after) }] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await executeRecovery({ root, manifest, manifestPath, mode: 'resume', approved: true });
  assert.equal(result.state, 'committed');
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'committed');
  assert.deepEqual(await scanPendingTransactions({ root }), []);
});

test('恢复拒绝非事务目录的 manifestPath，且不覆盖工作区文件', async () => {
  const root = await fixture();
  const target = path.join(root, 'a.txt'); const snapshot = path.join(root, 'a.snapshot'); const temp = path.join(root, 'a.temp');
  const before = Buffer.from('one\ntwo\n'); const after = Buffer.from('one\nTWO\n');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  await writeFile(snapshot, before); await writeFile(temp, after);
  const manifest = { transactionId: 'tx-path-bound', state: 'committing', files: [{ relativePath: 'a.txt', target, snapshot, temp, beforeHash: sha(before), afterHash: sha(after) }] };
  const protectedFile = path.join(root, 'README.md'); await writeFile(protectedFile, 'keep me\n');
  await assert.rejects(() => executeRecovery({ root, manifest, manifestPath: protectedFile, mode: 'resume', approved: true }), (error) => error.code === 'MANIFEST_PATH_INVALID');
  assert.equal(await readFile(protectedFile, 'utf8'), 'keep me\n');
  assert.equal(await readFile(target, 'utf8'), 'one\ntwo\n');
});

test('恢复没有持久化写入器时在改写前拒绝执行', async () => {
  const root = await fixture();
  const target = path.join(root, 'a.txt'); const snapshot = path.join(root, 'a.snapshot'); const temp = path.join(root, 'a.temp');
  const before = Buffer.from('one\ntwo\n'); const after = Buffer.from('one\nTWO\n');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  await writeFile(snapshot, before); await writeFile(temp, after);
  const manifest = { transactionId: 'tx-persistence-required', state: 'committing', files: [{ relativePath: 'a.txt', target, snapshot, temp, beforeHash: sha(before), afterHash: sha(after) }] };
  await assert.rejects(() => executeRecovery({ root, manifest, mode: 'resume', approved: true }), (error) => error.code === 'MANIFEST_PERSISTENCE_REQUIRED');
  assert.equal(await readFile(target, 'utf8'), 'one\ntwo\n');
});

test('恢复完成后审计失败不伪装为恢复失败', async () => {
  const root = await fixture();
  const target = path.join(root, 'a.txt');
  const snapshot = path.join(root, 'a.snapshot');
  const temp = path.join(root, 'a.temp');
  const manifestPath = transactionManifestPath(root, 'tx-audit-fail');
  const before = Buffer.from('one\ntwo\n');
  const after = Buffer.from('one\nTWO\n');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  await writeFile(target, before); await writeFile(snapshot, before); await writeFile(temp, after);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const manifest = { transactionId: 'tx-audit-fail', state: 'committing', files: [{ relativePath: 'a.txt', target, snapshot, temp, beforeHash: sha(before), afterHash: sha(after) }] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await executeRecovery({ root, manifest, manifestPath, mode: 'resume', approved: true, audit: { append: async () => { throw new Error('audit unavailable'); } } });
  assert.equal(result.state, 'committed');
  assert.equal(result.auditWritten, false);
  assert.match(result.auditError, /audit unavailable/);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'committed');
  assert.equal(await readFile(target, 'utf8'), 'one\nTWO\n');
});

test('恢复最终状态清单更新失败时返回 FINALIZE_FAILED', async () => {
  const root = await fixture();
  const temp = path.join(root, 'a.temp'); const target = path.join(root, 'a.txt'); const snapshot = path.join(root, 'a.snapshot');
  await writeFile(temp, 'one\\nTWO\\n'); await writeFile(snapshot, 'one\\ntwo\\n');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const manifest = { transactionId: 'tx-finalize-fail', state: 'committing', files: [{ relativePath: 'a.txt', target, temp, snapshot, beforeHash: sha(await readFile(target)), afterHash: sha(await readFile(temp)) }] };
  const manifestPath = transactionManifestPath(root, 'tx-finalize-fail'); await mkdir(path.dirname(manifestPath), { recursive: true }); await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => executeRecovery({ root, manifest, manifestPath, mode: 'resume', approved: true, updateManifest: async () => { throw new Error('manifest unavailable'); } }), (e) => e.code === 'FINALIZE_FAILED' && e.details.recoveryManifestWritten === true);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'finalize_failed');
  assert.equal(await readFile(target, 'utf8'), 'one\\nTWO\\n');
});

test('hunk 应用支持上下文、删除和新增', () => {
  const result = applyHunks('a\nb\nc\n', [{ oldStart: 2, body: [' b', '-c', '+C', '+d'] }]);
  assert.equal(result, 'a\nb\nC\nd\n');
});

test('补丁事务拒绝符号链接目标，防止读取工作区外内容', async () => {
  const root = await fixture();
  const target = path.join(root, 'a.txt');
  const outside = path.join(tmpdir(), `ocw-outside-${Date.now()}.txt`);
  await writeFile(outside, 'outside\n');
  await (await import('node:fs/promises')).unlink(target);
  await symlink(outside, target);
  const patch = parseUnifiedPatch('--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-outside\n+two\n');
  await assert.rejects(() => applyPatchTransaction({ root, parsedPatch: patch, declaredPaths: ['a.txt'] }), (error) => error.code === 'SYMLINK_TARGET' || error.code === 'TARGET_UNAVAILABLE');
  await (await import('node:fs/promises')).unlink(outside);
});
