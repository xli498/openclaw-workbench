import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedPatch, PatchError, validatePatchTargets } from '../runtime/patch-engine.mjs';

const patch = `--- a/src/a.txt
+++ b/src/a.txt
@@ -1,2 +1,2 @@
 old
-old line
+new line
`;

test('解析 unified patch 并生成稳定 hash 与文件清单', () => {
  const result = parseUnifiedPatch(patch);
  assert.deepEqual(result.paths, ['src/a.txt']);
  assert.equal(result.files[0].hunks[0].body.length, 3);
  assert.equal(result.files[0].hunks[0].oldCount, 2);
  assert.equal(result.files[0].hunks[0].newCount, 2);
  assert.match(result.patchHash, /^[a-f0-9]{64}$/);
});

test('拒绝路径穿越、重复文件和没有 hunk 的 patch', () => {
  assert.throws(() => parseUnifiedPatch('--- a/../secret\n+++ b/../secret\n@@ -1 +1 @@\n-x\n+y\n'), (e) => e.code === 'PATCH_PATH_INVALID');
  assert.throws(() => parseUnifiedPatch(`${patch}\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-x\n+y\n`), (e) => e.code === 'PATCH_DUPLICATE_PATH');
  assert.throws(() => parseUnifiedPatch('--- a/a.txt\n+++ b/a.txt\n'), (e) => e.code === 'PATCH_NO_HUNKS');
});

test('拒绝修改工作区敏感文件', () => {
  for (const target of ['.env', 'nested/.env.local', '.git/config', 'credentials.json', 'keys/id_rsa', 'server.pem']) {
    assert.throws(() => parseUnifiedPatch(`--- a/${target}\n+++ b/${target}\n@@ -1 +1 @@\n-old\n+new\n`), (e) => e.code === 'PATCH_SENSITIVE_PATH', target);
  }
});

test('拒绝 hunk 行数与 header 不一致', () => {
  assert.throws(() => parseUnifiedPatch('--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,1 @@\n-old\n+new\n'), (e) => e.code === 'HUNK_COUNT_MISMATCH');
});

test('解析 CRLF、空文件新增和无末尾换行标记', () => {
  const crlf = '--- a/a.txt\r\n+++ b/a.txt\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n';
  assert.equal(parseUnifiedPatch(crlf).files[0].hunks[0].body[0], '-old');
  const newFile = parseUnifiedPatch('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n');
  assert.equal(newFile.files[0].oldPath, null); assert.equal(newFile.files[0].newPath, 'new.txt');
  const noNewline = parseUnifiedPatch('--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
  assert.deepEqual(noNewline.files[0].hunks[0].body, ['-old', '+new']);
});

test('拒绝非法 hunk 行并校验声明目标', () => {
  assert.throws(() => parseUnifiedPatch('--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n?bad\n'), (e) => e.code === 'HUNK_LINE_INVALID');
  const parsed = parseUnifiedPatch(patch);
  assert.equal(validatePatchTargets(parsed, ['src/a.txt']), true);
  assert.throws(() => validatePatchTargets(parsed, ['other.txt']), (e) => e instanceof PatchError && e.code === 'PATCH_TARGET_UNDECLARED');
});
