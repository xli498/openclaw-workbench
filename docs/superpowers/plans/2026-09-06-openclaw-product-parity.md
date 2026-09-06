# OpenClaw Product Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints. Every runtime change must follow a failing-test-first loop and a red-team replay.

**Goal:** Turn the current auditable Workbench runtime into a usable local OpenClaw product core that can configure a model, run Ask/Plan/Code Chat through a real provider, expose safe workspace tools, and optionally serve the workspace through a protected local Streamable HTTP MCP Bridge.

**Architecture:** Keep the existing approval and persistence boundaries. Add a provider-neutral model runner that resolves SecretRef only in memory, supports bounded OpenAI-compatible Chat Completions and Responses requests, and emits normalized assistant/tool events. Add a tool registry whose read-only tools execute immediately while mutation tools create existing approval proposals. Add a separate Bridge HTTP server that implements MCP initialize/tools/list/tools/call with bearer authentication, per-session protocol state, bounded frames, and loopback-only binding; tunnel providers remain an explicit adapter boundary.

**Tech Stack:** Node.js 22 ESM, built-in `fetch`, `node:http`, `AbortController`, `node:test`, existing workspace/workflow/audit/session/model registry modules.

---

### Task 1: Product gap evidence and public capability matrix

**Files:**
- Modify: `docs/00-product-charter.md`
- Modify: `docs/01-integration-boundary.md`
- Modify: `README.md`
- Test: `tests/product-contract.test.mjs`

- [ ] Write a contract test that asserts the public capability matrix names implemented Chat, model execution, tool approval, and Bridge status separately from unimplemented account, tunnel, LSP, and persistent PTY features.
- [ ] Run the contract test and confirm it fails because the new capability identifiers are absent.
- [ ] Update the documents with a measurable definition of “OpenClaw product core complete”: model registration → live request → normalized Chat turn → read-only tool call → approved mutation proposal → audit; Bridge is a separate milestone.
- [ ] Run the contract test and `git diff --check`.

### Task 2: OpenAI-compatible provider runner

**Files:**
- Create: `runtime/model-runner.mjs`
- Modify: `runtime/index.mjs`
- Test: `tests/model-runner.test.mjs`
- Test: `tests/model-runner-red-team.test.mjs`

- [ ] Write failing tests for Chat Completions and Responses request shapes, SecretRef resolution only into an Authorization header, model/profile mismatch rejection, bounded JSON/SSE parsing, timeout, caller cancellation, malformed provider output, tool-call normalization, and no secret/error/body persistence.
- [ ] Run the focused tests and confirm the expected missing-module failure.
- [ ] Implement `createModelRunner({ profileResolver, secretResolver, fetchImpl, requestTimeoutMs, maxResponseBytes })` with one bounded request per turn, protocol-specific payloads, strict endpoint policy, `redirect: 'error'`, normalized `{ text, toolCalls, usage, finishReason }`, and sanitized `ModelRunnerError` codes.
- [ ] Run focused tests, then run the full suite.
- [ ] Red team: inject secret text in HTTP errors, SSE frames, tool arguments, oversized responses, redirects, private DNS answers, and abort races; verify none reaches returned errors, audit records, or snapshots.
- [ ] Re-run the exact attacks after blue-team fixes and record before/after results.

### Task 3: Model-backed Chat session integration

**Files:**
- Modify: `runtime/session.mjs`
- Modify: `runtime/http-server.mjs`
- Modify: `runtime/control-panel.mjs`
- Test: `tests/model-chat-session.test.mjs`
- Test: `tests/model-chat-red-team.test.mjs`

- [ ] Write failing tests proving a session can select an enabled model profile, send a bounded conversation, stream/accumulate a normalized assistant response, reject disabled or unknown profiles, and preserve cancellation/manual-review semantics.
- [ ] Run focused tests and confirm failure before implementation.
- [ ] Add injectable `modelRunner`, resolve the selected profile from `createModelRegistry`, keep the existing OpenClaw CLI adapter as an explicit fallback only when configured, and never silently switch providers.
- [ ] Add model selection and connection status to the control panel without exposing SecretRef values.
- [ ] Run the focused and full suites.
- [ ] Red team model/profile substitution, stale config hash, disabled profile, provider prompt injection, oversized message, and response-secret attacks; fix and replay.

### Task 4: Unified workspace tool registry and tool loop

**Files:**
- Create: `runtime/tool-registry.mjs`
- Create: `runtime/agent-loop.mjs`
- Modify: `runtime/session.mjs`
- Modify: `runtime/index.mjs`
- Test: `tests/tool-registry.test.mjs`
- Test: `tests/agent-loop.test.mjs`
- Test: `tests/agent-loop-red-team.test.mjs`

- [ ] Write failing tests for bounded `list_directory`, `find_files`, `search_files`, `read_files`, `diagnostics`, `patch`, `command`, and `progress` tool schemas; Ask/Plan allow only read/diagnostic/progress tools; Code can create approval proposals but cannot bypass approval.
- [ ] Implement schemas and handlers on top of `createWorkspace`, `createCodeToolProposal`, existing command policy, and event bus. Tool input/output must be JSON-bounded, path-safe, and secret-redacted.
- [ ] Implement a bounded model/tool loop with a maximum of 8 tool calls per batch, maximum rounds, cumulative output budget, cancellation, and no tool execution from untrusted assistant text unless represented as a validated structured tool call.
- [ ] Normalize tool results back into the model runner and persist only safe message/tool metadata.
- [ ] Run full tests plus real red-team attacks for path traversal, sensitive files, shell injection, tool-name substitution, oversized arguments, recursive loops, prompt-injected tool results, and approval-token misuse; fix and replay.

### Task 5: Streamable HTTP MCP Bridge server

**Files:**
- Create: `runtime/mcp-bridge-server.mjs`
- Modify: `runtime/index.mjs`
- Modify: `runtime/http-server.mjs`
- Modify: `README.md`
- Modify: `docs/01-integration-boundary.md`
- Test: `tests/mcp-bridge-server.test.mjs`
- Test: `tests/mcp-bridge-red-team.test.mjs`

- [ ] Write failing tests for loopback-only bind, bearer authentication, MCP initialize/session negotiation, `tools/list`, `tools/call`, JSON and bounded SSE responses, `Mcp-Session-Id`, GET stream, DELETE close, invalid protocol versions, request replay, and graceful shutdown.
- [ ] Implement a standalone local Bridge server with explicit `start/stop/address`, per-session state, a stable tool catalog, and handlers wired to the unified tool registry. Read-only tools execute; patch/command tools return approval-required proposals and never mutate directly.
- [ ] Add a short-lived path token option plus header bearer authentication, no credentials in URLs/logs, strict CORS off by default, frame/body/time budgets, idle session expiry, and no non-loopback bind.
- [ ] Run real HTTP red-team attacks for missing/wrong bearer, path token leakage, protocol downgrade, session fixation, oversized JSON/SSE, cross-session replay, path escape, shell injection, and approval bypass; blue-team then replay the identical attack script.
- [ ] Add a local-only smoke command and document that Cloudflare/ngrok tunnels are not bundled until a provider adapter is independently verified.

### Task 6: Durable terminal and diagnostics contracts

**Files:**
- Create: `runtime/terminal-session.mjs`
- Create: `runtime/diagnostics.mjs`
- Modify: `runtime/http-server.mjs`
- Modify: `runtime/index.mjs`
- Test: `tests/terminal-session.test.mjs`
- Test: `tests/diagnostics.test.mjs`

- [ ] Write failing tests for a bounded persistent command session, incremental output reads, input, cancellation, timeout, restart/manual-review semantics, Windows and POSIX command boundaries, and cleanup.
- [ ] Implement a provider-neutral session interface; use the existing controlled command runner as the non-PTY fallback and report capability `pty:false` rather than pretending interactive support.
- [ ] Implement diagnostics aggregation for OpenClaw CLI, workspace revision, model health, MCP status, and recent redacted audit events with explicit unavailable states.
- [ ] Red team output flooding, process-tree escape, inherited secret environment, stale session replay, and diagnostics secret leakage; fix and replay.

### Task 7: Release gates and product handoff

**Files:**
- Modify: `.github/workflows/*`
- Modify: `docs/04-review-log.md`
- Modify: `docs/05-next-implementation.md`
- Create: `docs/security/red-team-product-parity-YYYY-MM-DD.md`
- Create: `C:/Users/HP/Documents/Codex/shared/results/YYYYMMDD_HHmmss_openclaw_product_parity.json`

- [ ] Run the complete local suite, syntax checks, package dry-run, and the exact red-team replay scripts.
- [ ] Run Node 22, Node 24, and Windows CI; block merge on any failure or skipped required check.
- [ ] Review the diff independently, update docs with actual evidence, commit only scoped files, push a PR, merge only after all required checks are green.
- [ ] Save a durable result and append `index.jsonl`, including remaining non-goals and exact remote commit.

## Completion audit

The product-core goal is complete only when Tasks 1–4 are merged and a clean workspace can register an enabled model, complete an Ask turn, complete a Plan turn, create and explicitly approve a Code proposal, verify the change, and expose redacted audit evidence. The Bridge milestone additionally requires Task 5’s real HTTP client interoperability tests. Tasks 6–7 are required before claiming production readiness.
