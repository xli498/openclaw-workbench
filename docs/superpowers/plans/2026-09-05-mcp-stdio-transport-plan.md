# MCP Stdio Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为已审批的 MCP 注册骨架增加一个显式启动、可取消、有限帧的 stdio JSON-RPC transport 边界，不自动调用工具或读取 SecretRef。

**Architecture:** 新增独立 `mcp-transport` 模块，调用方显式传入已校验的 command/args/cwd 和可选环境对象。模块通过依赖注入的 child-process 工厂启动 `shell:false` 子进程，按换行 JSON 帧关联请求响应，并在关闭、超时、取消或超限时拒绝 pending 请求。注册表、审批 API 和工具 allowlist 不被绕过。

**Tech Stack:** Node.js 22+, ESM, `node:child_process`, `node:test`。

---

### Task 1: Stdio transport lifecycle and request boundary

**Files:**
- Create: `runtime/mcp-transport.mjs`
- Create: `tests/mcp-transport.test.mjs`

- [ ] **Step 1: Write failing tests** for shell-free startup, JSON-RPC correlation, timeout, abort, close cleanup, and frame limits using a fake child process.
- [ ] **Step 2: Run `node --test tests/mcp-transport.test.mjs` and confirm the module/export failure.**
- [ ] **Step 3: Implement `McpTransportError` and `createMcpStdioTransport` with explicit `start()`, `request()`, and `close()` lifecycle; never auto-start or restart.
- [ ] **Step 4: Run the targeted tests and confirm all transport cases pass.**

### Task 2: Public export and boundary documentation

**Files:**
- Modify: `runtime/index.mjs`
- Modify: `README.md`
- Modify: `docs/01-integration-boundary.md`
- Modify: `docs/06-chat-session-api.md`

- [ ] **Step 1: Add a failing public-import test for the transport export.**
- [ ] **Step 2: Export the transport and document that it requires an already approved command, does not resolve secrets, and does not perform MCP tool orchestration.**
- [ ] **Step 3: Run targeted tests, full `npm test`, `npm pack --dry-run`, `git diff --check`, and syntax checks.**

### Task 3: Review and delivery

- [ ] **Step 1: Request independent review focused on process-spawn safety, frame parsing, cancellation, and lifecycle cleanup.**
- [ ] **Step 2: Fix Critical/Important findings, rerun all verification, commit, push, and merge only after CI is green.**

## Boundary checks

- No shell command strings, automatic process startup, retries, SecretRef reads, MCP tool allowlist changes, or public listener are added.
- The transport sends only caller-supplied JSON-RPC frames and returns correlated responses; protocol semantics remain with the caller.
