import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importConfig, readConfig, rollbackConfig } from '../runtime/config-store.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-config-'));
  await writeFile(path.join(root, 'openclaw.json'), '{"mode":"old"}\n');
  return root;
}

test('导入配置先备份并返回 beforeHash/afterHash', async () => {
  const root = await fixture();
  try {
    const before = '{"mode":"old"}\n';
    const after = '{"mode":"new"}\n';
    const result = await importConfig({ root, relativePath: 'openclaw.json', expectedHash: digest(before), content: after });
    assert.equal(result.beforeHash, digest(before));
    assert.equal(result.afterHash, digest(after));
    assert.equal(result.backupId.endsWith('.json'), true);
    assert.equal(await readFile(result.backupPath, 'utf8'), before);
    assert.equal((await readConfig({ root, relativePath: 'openclaw.json' })).hash, digest(after));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('首次导入缺失配置接受 null 哈希且不生成伪备份', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-config-first-'));
  try {
    const content = '{"mode":"first"}\n';
    const result = await importConfig({ root, relativePath: 'openclaw.json', content });
    assert.equal(result.beforeHash, null);
    assert.equal('backupId' in result, false);
    assert.equal((await readConfig({ root })).hash, digest(content));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('配置变化后拒绝导入且不覆盖当前文件', async () => {
  const root = await fixture();
  try {
    const changed = '{"mode":"changed"}\n';
    await writeFile(path.join(root, 'openclaw.json'), changed);
    await assert.rejects(
      () => importConfig({ root, relativePath: 'openclaw.json', expectedHash: digest('{"mode":"old"}\n'), content: '{"mode":"new"}\n' }),
      (error) => error.code === 'CONFIG_CONFLICT',
    );
    assert.equal(await readFile(path.join(root, 'openclaw.json'), 'utf8'), changed);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('回滚只接受 Workbench 备份并以当前哈希作为覆盖门禁', async () => {
  const root = await fixture();
  try {
    const before = '{"mode":"old"}\n';
    const after = '{"mode":"new"}\n';
    const imported = await importConfig({ root, relativePath: 'openclaw.json', expectedHash: digest(before), content: after });
    const rolledBack = await rollbackConfig({ root, relativePath: 'openclaw.json', backupId: imported.backupId, expectedHash: digest(after) });
    assert.equal(rolledBack.beforeHash, digest(after));
    assert.equal(rolledBack.afterHash, digest(before));
    assert.equal(await readFile(path.join(root, 'openclaw.json'), 'utf8'), before);
    await assert.rejects(() => rollbackConfig({ root, relativePath: 'openclaw.json', backupId: imported.backupPath, expectedHash: digest(before) }), (error) => error.code === 'BACKUP_PATH_INVALID');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('拒绝配置绝对路径、非 JSON 路径和备份符号链接逃逸', async (t) => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'ocw-config-outside-'));
  try {
    await assert.rejects(() => readConfig({ root, relativePath: '../openclaw.json' }), (error) => error.code === 'CONFIG_PATH_INVALID');
    await assert.rejects(() => readConfig({ root, relativePath: '.OpenClaw-Workbench/config.json' }), (error) => error.code === 'CONFIG_PATH_INVALID');
    await assert.rejects(() => readConfig({ root, relativePath: 'notes.txt' }), (error) => error.code === 'CONFIG_PATH_INVALID');
    const imported = await importConfig({ root, relativePath: 'openclaw.json', expectedHash: digest('{"mode":"old"}\n'), content: '{"mode":"new"}\n' });
    const link = path.join(root, '.openclaw-workbench', 'config-backups', 'escape.json');
    try { await symlink(path.join(outside, 'secret.json'), link); } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows symlink creation requires Developer Mode'); return; }
      throw error;
    }
    await writeFile(path.join(outside, 'secret.json'), '{"secret":true}\n');
    await assert.rejects(() => rollbackConfig({ root, relativePath: 'openclaw.json', backupId: 'escape.json', expectedHash: imported.afterHash }), (error) => ['BACKUP_UNAVAILABLE', 'SYMLINK_ESCAPE', 'BACKUP_PATH_INVALID'].includes(error.code));
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('备份 ID 必须绑定创建它的配置目标，不能跨文件回滚', async () => {
  const root = await fixture();
  try {
    const before = '{"mode":"old"}\n';
    const imported = await importConfig({ root, relativePath: 'openclaw.json', expectedHash: digest(before), content: '{"mode":"new"}\n' });
    const other = path.join(root, 'other.json');
    await writeFile(other, '{"other":true}\n');
    await assert.rejects(
      () => rollbackConfig({ root, relativePath: 'other.json', backupId: imported.backupId, expectedHash: digest('{"other":true}\n') }),
      (error) => error.code === 'BACKUP_TARGET_MISMATCH',
    );
    assert.equal(await readFile(other, 'utf8'), '{"other":true}\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
