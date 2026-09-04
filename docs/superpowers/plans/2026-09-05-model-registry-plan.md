# Model Registry Connection Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加一个不保存密钥、默认禁用、审批后才登记的模型档案注册表和只读连接测试接口，为首次配置向导提供可验证 Runtime 基础。

**Architecture:** `runtime/model-registry.mjs` 只保存 provider、protocol、model、能力列表、无密钥的 SecretRef 引用和健康摘要，使用现有 anchored snapshot 原子持久化。HTTP 控制面用 Bearer + 独立 approval token + actionHash 创建/批准档案；连接测试只调用显式注入探针，默认返回 `NOT_CONFIGURED`，绝不联网或读取 SecretRef。

**Tech Stack:** Node.js 22+, ESM, existing snapshot/action/audit helpers, `node:test`.

---

### Task 1: 模型档案 schema 和快照

**Files:** `runtime/model-registry.mjs`, `tests/model-registry.test.mjs`

- [x] 写失败测试：合法档案默认禁用、能力 allowlist、SecretRef 只能是引用、endpoint 不得带凭据/敏感 query、重复 ID/未知协议/超限/快照 symlink 拒绝、重启恢复。
- [x] 运行 `node --test tests/model-registry.test.mjs` 确认缺模块红灯。
- [x] 实现 `ModelRegistryError`、`normalizeModelProfile`、`createModelRegistry`、`register`、`updateHealth`、`get`、`list`。
- [x] 运行定向测试到绿。

### Task 2: HTTP 审批注册和连接测试

**Files:** `runtime/http-server.mjs`, `runtime/index.mjs`, `tests/model-http.test.mjs`

- [x] 写失败测试：`GET /v1/models`、`POST /v1/models`、`POST /v1/models/:actionId/approve`、`GET /v1/models/:id/health` 的鉴权、审批、重放、默认禁用和探针隔离。
- [x] 运行红灯。
- [x] 实现模型提案 reservation、独立 approval token、actionHash 和默认非联网探针。
- [x] 运行 HTTP 定向测试到绿。

### Task 3: 红队、文档、CI 和交付

**Files:** `tests/security-red-team.test.mjs`, `README.md`, `docs/00-product-charter.md`, `docs/02-threat-model.md`, `docs/04-review-log.md`, `.github/workflows/ci.yml`

- [x] 添加 SecretRef 值、endpoint 凭据/query、协议注入、token 互换、actionHash 重放和自动联网攻击测试。
- [x] 运行完整测试、`npm pack --dry-run`、`node --check`、`git diff --check`；独立审核后提交、推送、等待 CI、合并。
- [x] 文档明确模型档案不是凭据存储，不会自动联网或修改 OpenClaw 配置。

---

## Boundary

本计划不实现真实 provider SDK、SecretRef 解析、模型调用、Gateway WebSocket 或云端同步；这些能力必须在后续 transport/credential 专项中单独验收。
