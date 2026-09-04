# MCP Registry Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Workbench 增加一个持久化、审批门禁、默认禁用的 MCP Server 注册表，只登记安全元数据和工具授权，不启动任意 Server 或执行工具。

**Architecture:** `runtime/mcp-registry.mjs` 负责 schema 校验、脱敏元数据、原子快照和注册/禁用/工具授权状态；HTTP 控制面负责 Bearer + 独立 approval token、actionHash、单次提案和审计。健康检查仅调用显式注入的只读探针，默认返回未配置，不读取或保存环境变量值。

**Tech Stack:** Node.js 22+, ESM, `node:fs/promises`, existing snapshot/audit/action helpers, `node:test`.

---

### Task 1: 固化注册表边界和 schema 红灯

**Files:**
- Create: `runtime/mcp-registry.mjs`
- Create: `tests/mcp-registry.test.mjs`

- [x] **Step 1: 写失败测试**

覆盖：合法 stdio/http 元数据、默认 `enabled:false`、工具 allowlist、环境变量只接受名称、命令 shell 元字符/换行/凭据值/超限/重复工具被拒绝、快照重启恢复和快照符号链接拒绝。

- [x] **Step 2: 运行红灯**

Run: `node --test tests/mcp-registry.test.mjs`

Expected: 因 `runtime/mcp-registry.mjs` 不存在而失败。

- [x] **Step 3: 实现最小 registry**

导出 `McpRegistryError`、`createMcpRegistry`。注册记录只包含 `id/name/transport/command/args/envKeys/tools/permissions/enabled/health`；禁止保存 env 值、token、URL 用户密码和任意原始错误。使用 `writeSnapshotAtomically`，快照写入 `.openclaw-workbench/mcp-registry.json`，检测外部修改和 symlink/reparse escape。

- [x] **Step 4: 运行定向测试到绿**

Run: `node --test tests/mcp-registry.test.mjs`

Expected: PASS，输出无失败。

### Task 2: HTTP 注册提案、审批、列表和健康状态

**Files:**
- Modify: `runtime/http-server.mjs`
- Modify: `runtime/index.mjs`
- Create: `tests/mcp-http.test.mjs`

- [x] **Step 1: 写失败测试**

验证 `GET /v1/mcp/servers` 只返回脱敏注册记录；`POST /v1/mcp/servers` 返回 `awaiting_approval` 且不改变 registry；缺少/错用 approval token、actionHash 篡改、重复审批均拒绝；正确审批后注册仍保持 `enabled:false`；`GET /v1/mcp/servers/:id/health` 默认返回 `NOT_CONFIGURED`，注入探针时只传安全元数据。

- [x] **Step 2: 运行红灯**

Run: `node --test tests/mcp-http.test.mjs`

Expected: 路由返回 404 或导入缺少导出。

- [x] **Step 3: 实现 API**

在 `createWorkbenchServer` 内初始化 registry 和进程内 pending proposals。提案 action 类型为 `mcp.register`，preview 不包含 env 值或原始命令敏感字段；审批只允许一次且独立于 Bearer token。健康探针接口 `inspectMcpServerFn` 默认返回 `{status:'unavailable', code:'NOT_CONFIGURED'}`，不得自动 spawn。

- [x] **Step 4: 运行 HTTP 定向测试到绿**

Run: `node --test tests/mcp-http.test.mjs`

Expected: PASS。

### Task 3: 红队复攻和文档门禁

**Files:**
- Modify: `tests/security-red-team.test.mjs`
- Modify: `README.md`
- Modify: `docs/02-threat-model.md`
- Modify: `docs/04-review-log.md`
- Modify: `.github/workflows/ci.yml`

- [x] **Step 1: 添加红队攻击**

覆盖命令注入、绝对路径/路径穿越、env 值注入、工具名越权、控制 token 冒充 approval、actionHash 重放、注册快照 symlink、健康检查自动启动等攻击；每条断言稳定错误码和文件未改变。

- [x] **Step 2: 运行攻击并修复**

Run: `node --test tests/security-red-team.test.mjs --test-reporter=spec`

先确认攻击确实触达产品，再按 TDD 写回归测试和最小修复；修复后重跑同一脚本，所有攻击必须失败而合法注册/读取仍成功。

- [x] **Step 3: 更新边界文档和 CI**

明确注册表不是 MCP 执行器，默认禁用、无 secret 持久化、无自动启动；CI 加入 MCP 定向测试、红队测试、`node --check`、`npm test`、`npm pack --dry-run`、`git diff --check`。

- [ ] **Step 4: 审核和提交前验证**

运行完整测试并记录摘要；请求独立审核，修复 Critical/Important 后再提交、推送 PR、等待 GitHub checks，通过后合并。

---

## Self-Review

- Spec coverage: schema、持久化、审批、健康探针、红队和文档分别由 Task 1-3 覆盖。
- Placeholder scan: 无 TBD/TODO 或未定义接口；每个任务均有文件、命令和预期。
- Boundary check: 不实现 transport、工具调用、自动启动或公网 Bridge，避免伪装产品能力。
