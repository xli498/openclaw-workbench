# OpenClaw Productization Red-Blue Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 OpenClaw Workbench 从可测试 Runtime 基线推进为具备可恢复配置管理和可证明安全边界的本地产品基础，并用真实红队攻击验证修复没有绕过审批、路径和审计控制。

**Architecture:** 配置管理只通过 Workbench 自己的受控目录工作：导入前计算源文件哈希并创建不可覆盖的备份，写入采用临时文件 + 原子替换，提交前再次校验 base hash，冲突时阻断而不覆盖。所有配置动作绑定会话、配置哈希和审批令牌，事件写入已有审计链；OpenClaw Gateway、MCP 工具执行和公网 Bridge 在本计划中只定义接口，不伪装成已完成能力。

**Tech Stack:** Node.js 22+, ESM, `node:fs/promises`, SHA-256, existing HTTP server, `node:test`, PowerShell/Windows CI.

---

## 当前差距分级

- P0（必须先完成）：配置导入/备份/回滚；红队攻击矩阵；审计和冲突门禁；首次启动可诊断状态。
- P1（随后垂直切片）：OpenClaw Agent/Gateway WebSocket Adapter；MCP Server 注册、健康检查和工具级授权；模型配置向导与连接测试。
- P2（产品壳）：桌面/浏览器控制面、安装向导、迁移导出、升级回滚。
- P3（独立风险评审后）：Bridge 公网隧道、设备配对和跨入口连接。

## 第一版 MVP 验收范围

1. 用户可查看当前 OpenClaw 配置状态，导入前自动生成备份。
2. 配置更新必须提供 `baseHash`，目标文件变化时返回冲突，原文件保持不变。
3. 回滚只能选择 Workbench 创建的备份，备份路径不能逃出工作区或被符号链接替换。
4. 导入、冲突、回滚、失败均有结构化审计记录且审计链可验证。
5. HTTP API 只在 loopback、Bearer 鉴权和独立 approval token 下提供这些动作。
6. 所有红队攻击在修复后均失败，合法导入和回滚流程仍成功。

## 红队攻击矩阵

- 鉴权：缺少 Bearer、把控制 token 当 approval token、过期/重复审批。
- 完整性：篡改 `baseHash`、重放 actionHash、并发修改配置、伪造备份元数据。
- 文件系统：`..`、绝对路径、Windows 8.3 别名、junction/reparse point、备份符号链接、临时文件替换竞态。
- 注入：配置 JSON 中的 prompt/tool 字段、事件数据中的 HTML/换行、超大 body、错误回显凭据。
- 运行时：CLI 输出伪造、超时、stderr 泄露、环境变量和 PATH 注入。
- Bridge 预案：公网监听、随机路径重放、设备撤销缺失；在 Bridge 实现前必须保持接口未暴露。

## 蓝队修复规则

每个发现必须先写一个能失败的回归测试，再做最小实现；完成后运行定向测试、完整测试、`git diff --check`、`npm pack --dry-run`，独立审核通过后才提交和推送。未完成的 Gateway/MCP/Bridge 不允许用假响应掩盖。

### Task 1: 红队基线攻击并固化报告

**Files:**
- Create: `tests/security-red-team.test.mjs`
- Create: `docs/security/red-team-baseline-2026-09-04.md`

- [x] **Step 1: 写出真实攻击测试**

```js
test('未带 approval token 不能执行配置写入', async () => {
  const response = await request(address, '/v1/config/import', { method: 'POST', body: JSON.stringify({ baseHash, content: '{}' }) });
  assert.equal(response.status, 403);
});

test('备份符号链接不能把回滚写到工作区外', async () => {
  await assert.rejects(() => rollbackConfig({ root, backupPath: link }), (error) => error.code === 'SYMLINK_ESCAPE');
});
```

- [x] **Step 2: 运行攻击测试并记录每个可利用路径**

Run: `node --test tests/security-red-team.test.mjs`

Expected: 当前缺失的配置端点测试失败，并将失败分类为“未实现能力”或“安全漏洞”，不能把 404 当成修复证据。

- [x] **Step 3: 将攻击输入、实际响应、影响和修复优先级写入报告**

报告必须包含请求路径、状态码、是否改变文件、是否产生审计记录和复现命令；禁止保存 token、密钥或完整配置内容。

### Task 2: 配置存储和备份回滚 API

**Files:**
- Create: `runtime/config-store.mjs`
- Modify: `runtime/index.mjs`
- Modify: `runtime/http-server.mjs`
- Create: `tests/config-store.test.mjs`
- Modify: `tests/http-server.test.mjs`

- [x] **Step 1: 写失败测试覆盖合法导入、baseHash 冲突、备份回滚和路径逃逸**

```js
test('导入配置先备份并返回 beforeHash/afterHash', async () => {
  const result = await importConfig({ root, relativePath: 'openclaw.json', expectedHash: digest(before), content: after });
  assert.equal(result.beforeHash, digest(before));
  assert.equal(result.afterHash, digest(after));
  assert.equal(await readFile(result.backupPath, 'utf8'), before);
});

test('配置变化后拒绝导入且不覆盖当前文件', async () => {
  await assert.rejects(() => importConfig({ root, relativePath: 'openclaw.json', expectedHash: digest(before), content: after }), (error) => error.code === 'CONFIG_CONFLICT');
  assert.equal(await readFile(target, 'utf8'), changed);
});
```

- [x] **Step 2: 运行测试确认因模块不存在或 API 未实现而失败**

Run: `node --test tests/config-store.test.mjs`

Expected: FAIL with a missing export/module error, not a fixture or assertion typo。

- [x] **Step 3: 实现最小受控配置存储**

`runtime/config-store.mjs` 必须导出 `readConfig`, `importConfig`, `rollbackConfig`, `ConfigError`；只接受相对路径 `openclaw.json` 或 `.json` 配置文件，使用 `createWorkspace` 的 canonical root，备份写入 `.openclaw-workbench/config-backups/<timestamp>-<uuid>.json`，每次写入前重新读取并比对 `expectedHash`，临时文件使用独占创建并以 rename 提交；备份和目标均需拒绝 symlink/reparse escape。

- [x] **Step 4: 运行配置存储定向测试并重构到绿**

Run: `node --test tests/config-store.test.mjs`

Expected: PASS；任何失败先修实现，不放宽测试。

- [x] **Step 5: 暴露已鉴权 HTTP 端点**

增加只读 `GET /v1/config`、审批绑定的 `POST /v1/config/import` 和 `POST /v1/config/rollback`。写操作必须同时验证 Bearer、`x-approval-token`、`actionHash`、`baseHash` 和会话状态；响应只返回相对路径、哈希、备份 ID、状态，不返回配置密钥值。

- [x] **Step 6: 运行 HTTP 回归**

Run: `node --test tests/http-server.test.mjs --test-name-pattern='config|配置|审批'`

Expected: PASS with unauthorized, conflict, replay and success cases covered。

### Task 3: 红队攻击、蓝队修复、回归攻击

**Files:**
- Modify: `tests/security-red-team.test.mjs`
- Modify: `runtime/config-store.mjs`
- Modify: `runtime/http-server.mjs`
- Modify: `docs/02-threat-model.md`

- [x] **Step 1: 对配置 API 执行完整攻击矩阵**

Run: `node --test tests/security-red-team.test.mjs --test-reporter=spec`

必须实际尝试 actionHash 重放、并发 baseHash 冲突、备份符号链接、绝对路径、`..`、超大 JSON、HTML/换行注入和 token 互换。

- [x] **Step 2: 每个可利用发现先新增失败回归测试**

测试名称必须描述攻击和预期拒绝码，例如 `配置备份被替换为 junction 时拒绝回滚`；禁止只断言 500。

- [x] **Step 3: 最小化修复并验证审计链**

修复必须让拒绝响应稳定映射为 `400/403/409`，不回显敏感值，并追加包含 `configId`、`baseHash`、`afterHash` 和结果状态的审计事件；调用 `verifyAuditChain` 验证完整链。

- [x] **Step 4: 重新执行同一攻击脚本**

Run: `node --test tests/security-red-team.test.mjs`

Expected: 每条攻击均被拒绝；随后运行合法导入、读取、回滚测试确认功能仍成功。

### Task 4: 产品文档和持续集成门禁

**Files:**
- Modify: `README.md`
- Modify: `docs/00-product-charter.md`
- Modify: `docs/04-review-log.md`
- Modify: `.github/workflows/ci.yml`
- Create: `docs/security/config-import-runbook.md`

- [x] **Step 1: 文档写明配置动作状态机和恢复语义**

记录 `ready → proposed → awaiting_approval → approved → applying → verified` 以及 `conflict/failed/rollback_available`，明确 Workbench 不会自动覆盖 OpenClaw 原配置。

- [x] **Step 2: CI 加入安全定向测试、Windows 路径测试和打包检查**

Run: `node --check runtime/config-store.mjs; node --check runtime/http-server.mjs; npm test; npm pack --dry-run; git diff --check`

Expected: 所有命令退出码 0；Windows job 必须运行配置路径和红队测试。

- [ ] **Step 3: 完成批次审查、提交和推送**

先记录 `git diff --stat` 和测试摘要，再请求独立代码审核；修复 Critical/Important 问题后提交到独立分支并使用可用代理推送，确认 GitHub checks 全部通过后再合并。

## 后续产品切片

配置切片完成后按同样的红蓝节奏依次实施：OpenClaw Agent/Gateway Adapter、MCP 注册与工具授权、模型配置向导、首次启动安装/迁移、桌面控制面、Bridge 安全实现。每个切片都必须有真实运行验收，不以文档或 mock 响应代替。

## Self-Review

- Spec coverage: 当前产品章程中的配置保护、审批、审计、可恢复和诊断要求分别由 Task 1-4 覆盖；Gateway/MCP/Bridge 明确列为后续切片，不伪装完成。
- Placeholder scan: 全文没有 TBD/TODO 或“适当处理”式空步骤；每个测试、命令和预期均已给出。
- Type consistency: `ConfigError`, `readConfig`, `importConfig`, `rollbackConfig`, `baseHash` 和 `actionHash` 在任务中保持同一命名。
