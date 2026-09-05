# Gateway WebSocket Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Workbench 增加一个仅连接回环 Gateway 的可测试 WebSocket 传输层，提供握手、请求关联、超时、取消和消息大小门禁。

**Architecture:** 新增独立 `gateway-adapter` 模块，不猜测或执行 OpenClaw 私有业务方法；调用方显式提供 JSON 帧，传输层只负责安全连接生命周期。默认只允许 `localhost`、`127.0.0.1` 和 `::1`，默认不自动连接、不启动进程、不记录 token；所有网络行为通过显式 `connect()`/`request()` 触发并支持依赖注入测试。

**Tech Stack:** Node.js 22+, ESM, WHATWG WebSocket-compatible API, `node:test`。

---

### Task 1: 安全 URL 与帧传输契约

**Files:**
- Create: `runtime/gateway-adapter.mjs`
- Create: `tests/gateway-adapter.test.mjs`

- [ ] **Step 1: Write failing tests** for loopback-only URL validation, token-free error text, connect timeout, request correlation, cancellation, and max frame size.
- [ ] **Step 2: Run targeted tests** with `node --test tests/gateway-adapter.test.mjs`; expect missing module/export failures.
- [ ] **Step 3: Implement minimal adapter** exporting `GatewayAdapterError` and `createGatewayAdapter`; use injected `WebSocketImpl`, fixed `ws`/`wss` URL parsing, JSON frame IDs, bounded timers, `AbortSignal`, and no automatic reconnect.
- [ ] **Step 4: Run targeted tests** until all gateway tests pass.

### Task 2: Public boundary and lifecycle integration

**Files:**
- Modify: `runtime/index.mjs`
- Modify: `runtime/session.mjs`
- Create: `tests/gateway-session.test.mjs`

- [ ] **Step 1: Add a failing session test** proving an explicitly supplied Gateway request function can service one Ask turn and that cancellation leaves no assistant message.
- [ ] **Step 2: Implement optional `gatewayRequestFn` injection** in `createChatSessionManager`; preserve existing `runAgentFn` default and never connect unless the caller supplies the function.
- [ ] **Step 3: Export the adapter and run session regressions**; existing CLI and HTTP behavior must remain unchanged.

### Task 3: Documentation, CI, review, and delivery

**Files:**
- Modify: `README.md`
- Modify: `docs/06-chat-session-api.md`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Document supported states** (`disconnected`, `connecting`, `ready`, `timed_out`, `cancelled`, `failed`) and explicitly state that Gateway protocol methods, process startup, MCP tools, secrets, WebSocket control-plane, and public Bridge remain out of scope.
- [ ] **Step 2: Add Node syntax checks and targeted gateway/session tests to CI.**
- [ ] **Step 3: Run `node --check`, targeted tests, full `npm test`, `npm pack --dry-run`, and `git diff --check`; request independent review before commit/push.
- [ ] **Step 4: Push a dedicated branch, wait for GitHub checks, and merge only when green.**

## Self-Review

- No OpenClaw private protocol is invented; the adapter is a transport boundary only.
- No default network call, process spawn, token persistence, or public listener is introduced.
- Every behavior has a failing-test-first task and a concrete verification command.
