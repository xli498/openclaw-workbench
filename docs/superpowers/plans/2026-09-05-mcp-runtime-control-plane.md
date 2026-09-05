# MCP Runtime Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** Expose MCP runtime start, stop, status, and allowlisted tool calls through the authenticated HTTP control plane while preserving explicit approval and config-hash safety gates.

**Architecture:** `createWorkbenchServer` owns one `createMcpServerRuntime` bound to its persistent MCP registry. Start, stop, and tool-call requests create in-memory approval proposals; only the existing independent approval endpoint executes them. Runtime status is read-only and returns public instance state. Tool inputs are retained only inside the pending proposal and never returned in the public proposal payload or audit event.

**Tech Stack:** Node.js `node:http`, existing action state machine, `createMcpServerRuntime`, Node test runner, JSON APIs.

---

### Task 1: Define control-plane API contracts with failing tests

**Files:**
- Modify: `tests/mcp-http.test.mjs`
- Modify: `tests/security-red-team.test.mjs`

- [x] **Step 1: Write failing tests**

Add tests that inject a fake MCP transport and assert:

```js
GET /v1/mcp/runtimes -> { runtimes: [] }
POST /v1/mcp/servers/demo/start -> 201 awaiting_approval, runtime remains stopped
POST /v1/mcp/servers/:actionId/approve with approval token -> 200 ready
POST /v1/mcp/servers/demo/call -> 201 awaiting_approval without returning input
POST /v1/mcp/servers/:actionId/approve -> 200 tool result
POST /v1/mcp/servers/demo/stop -> 201 awaiting_approval, approval closes transport
```

The red-team test must prove control token cannot approve runtime actions, stale `configHash` fails at approval, unauthorized tools never reach the transport, and a call proposal response does not contain the tool input.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/mcp-http.test.mjs tests/security-red-team.test.mjs --test-name-pattern='runtime|运行时|MCP.*调用'`

Expected: FAIL because the runtime control routes and proposal execution branches do not exist.

### Task 2: Wire the runtime and approval execution

**Files:**
- Modify: `runtime/http-server.mjs`
- Modify: `tests/mcp-http.test.mjs`

- [x] **Step 1: Add runtime construction and lifecycle cleanup**

Import `createMcpServerRuntime`, accept optional `mcpRuntime` and `mcpTransportFactory` test/integration options, and default to `createMcpServerRuntime({ registry: mcpRegistry, transportFactory: mcpTransportFactory })`. Call `mcpRuntime.close()` from `close()` even when the HTTP server was never listening.

- [x] **Step 2: Add read-only status route**

Implement `GET /v1/mcp/runtimes` returning only `mcpRuntime.status()`.

- [x] **Step 3: Add proposal routes**

Implement:

```text
POST /v1/mcp/servers/:serverId/start
body: { sessionId, configHash }
POST /v1/mcp/servers/:serverId/stop
body: { sessionId, configHash }
POST /v1/mcp/servers/:serverId/call
body: { sessionId, configHash, tool, input }
```

Each route validates session/config hash, server existence, proposal limits, and JSON object input. It creates an `mcp.runtime` action with preview metadata, records a reservation during audit append, and stores an internal proposal with operation `runtime_start`, `runtime_stop`, or `runtime_call`. The public payload includes action, operation, server id, tool name (for calls), and input byte count, never the input object.

- [x] **Step 4: Extend MCP approval dispatch**

In the existing MCP approval handler, dispatch runtime operations to `mcpRuntime.start`, `mcpRuntime.stop`, or `mcpRuntime.callTool` with `approved: true` and the stored `expectedConfigHash`. Return public action plus either runtime status or tool result. Delete the proposal only after successful execution; on failure append a redacted `mcp.failed` audit event and map runtime errors to structured HTTP responses.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `node --test tests/mcp-http.test.mjs tests/security-red-team.test.mjs --test-name-pattern='runtime|运行时|MCP.*调用'`

Expected: all new tests pass with no tool call occurring before approval.

### Task 3: Harden errors, redaction, and documentation

**Files:**
- Modify: `runtime/http-server.mjs`
- Modify: `README.md`
- Modify: `docs/01-integration-boundary.md`
- Modify: `tests/mcp-http.test.mjs`

- [x] **Step 1: Map runtime errors**

Map `MCP_NOT_RUNNING` and `MCP_SERVER_DISABLED` to 409, `MCP_NOT_FOUND` to 404, `MCP_APPROVAL_REQUIRED` and `MCP_TOOL_NOT_AUTHORIZED` to 403, `MCP_TOOL_INPUT_INVALID` to 400, and runtime start/transport failures to 502 without returning command, endpoint, stderr, credentials, or input values.

- [x] **Step 2: Add redaction regression coverage**

Assert public call proposals and audit events expose only server id, operation, tool name, input byte count, action hash, and status; secret-like input values and command configuration are absent.

- [x] **Step 3: Document the routes and limits**

Document that lifecycle and tool calls are proposal-based, require the independent approval token and current config hash, require the server to be enabled, and are bound to one in-memory runtime per HTTP server instance.

- [x] **Step 4: Run the complete verification suite**

Run:

```text
node --test
npm pack --dry-run
node --check runtime/http-server.mjs
git diff --check
```

Expected: zero failures; only the existing Windows symlink privilege skips remain.

### Task 4: Review, commit, and publish

**Files:**
- Review all changes above.

- [x] **Step 1: Request an independent code review**

Review proposal races, runtime close behavior, config-hash TOCTOU, input redaction, and error mapping. Resolve all Critical/Important findings.

- [x] **Step 2: Commit only tracked feature files**

Keep existing user files under `docs/superpowers/plans/2026-09-03-openclaw-diagnostics.md`, `output/`, and the unknown-name file untracked.

- [x] **Step 3: Push, wait for Node 22/24 and Windows CI, then merge**

Use the authenticated GitHub CLI with the local temporary proxy only; verify remote `main` and CI results before reporting completion.
