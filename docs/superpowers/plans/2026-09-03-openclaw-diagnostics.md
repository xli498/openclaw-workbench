# OpenClaw Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a read-only, redacted OpenClaw compatibility diagnosis that lets a Workbench user see whether the configured CLI is runnable before creating a chat session.

**Architecture:** Add a small adapter-owned diagnostic function that invokes only `openclaw --version` and `openclaw --help` with a fixed argv, timeout, no shell and bounded output. The HTTP control plane exposes its normalized result through a new authenticated read-only endpoint; no OpenClaw configuration, Gateway, MCP registry, model or token is read or changed.

**Tech Stack:** Node.js 22+, ESM, `node:child_process`, existing HTTP server, `node:test`.

---

### Task 1: Adapter Diagnostic Contract

**Files:**
- Modify: `runtime/openclaw-adapter.mjs`
- Modify: `tests/openclaw-adapter.test.mjs`

- [x] **Step 1: Write the failing tests**

```js
import { inspectOpenClaw } from '../runtime/openclaw-adapter.mjs';

test('诊断返回可运行 CLI 的版本且不使用 shell', async () => {
  const result = await inspectOpenClaw({ command: process.execPath, spawnImpl: fakeSpawnVersion('2026.6.6') });
  assert.deepEqual(result, { status: 'ready', version: '2026.6.6', command: process.execPath });
});

test('诊断将找不到 CLI 映射为可展示的 unavailable 状态', async () => {
  const result = await inspectOpenClaw({ command: 'missing-openclaw', spawnImpl: fakeSpawnError('ENOENT') });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'CLI_NOT_FOUND');
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern='诊断返回可运行|诊断将找不到'`

Expected: FAIL because `inspectOpenClaw` is not exported.

- [x] **Step 3: Implement the bounded read-only probe**

```js
export async function inspectOpenClaw({ command = 'openclaw', timeoutMs = 5_000, maxOutputBytes = 16 * 1024, spawnImpl = spawn } = {}) {
  try {
    const stdout = await runFixedCommand({ command, argv: ['--version'], timeoutMs, maxOutputBytes, spawnImpl });
    const version = stdout.trim().match(/\d+(?:\.\d+){1,3}/)?.[0] ?? null;
    return Object.freeze({ status: 'ready', command, version });
  } catch (error) {
    const code = error.code === 'ENOENT' || error.code === 'SPAWN_FAILED' ? 'CLI_NOT_FOUND' : 'CLI_UNAVAILABLE';
    return Object.freeze({ status: 'unavailable', command, code });
  }
}
```

`runFixedCommand` must always use `shell: false`, `stdio: ['ignore', 'pipe', 'pipe']`, a timeout, an output cap, and return only normalized version data. It must never include stderr, command environment, absolute working directory, tokens, or model configuration in the public result.

- [x] **Step 4: Run adapter tests**

Run: `npm test -- --test-name-pattern='OpenClaw CLI|受限 Agent runner|诊断'`

Expected: PASS with zero matching test failures.

- [ ] **Step 5: Commit**

```bash
git add runtime/openclaw-adapter.mjs tests/openclaw-adapter.test.mjs
git commit -m "feat: add read-only OpenClaw diagnostics"
```

### Task 2: Authenticated Control-Plane Endpoint

**Files:**
- Modify: `runtime/http-server.mjs`
- Modify: `tests/http-server.test.mjs`

- [x] **Step 1: Write the failing HTTP test**

```js
test('控制面暴露已鉴权的 OpenClaw 诊断且不泄露 stderr', async () => {
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', inspectOpenClawFn: async () => ({ status: 'unavailable', code: 'CLI_NOT_FOUND', command: 'openclaw' }) });
  const address = await app.listen();
  const result = await request(address, '/v1/openclaw/diagnostics');
  assert.deepEqual(result.body, { status: 'unavailable', code: 'CLI_NOT_FOUND', command: 'openclaw' });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern='OpenClaw 诊断且不泄露'`

Expected: FAIL with HTTP 404.

- [x] **Step 3: Add the endpoint and dependency injection seam**

```js
export function createWorkbenchServer({ root, inspectOpenClawFn = inspectOpenClaw, ...options } = {}) {
  // existing initialization
  if (request.method === 'GET' && url.pathname === '/v1/openclaw/diagnostics') {
    return json(response, 200, await inspectOpenClawFn());
  }
}
```

Place this branch after authentication and before mutable endpoints. Do not cache a positive result forever: every request performs a new bounded probe so an installation, upgrade, or PATH repair is visible immediately.

- [x] **Step 4: Run the endpoint and authentication regressions**

Run: `npm test -- --test-name-pattern='OpenClaw 诊断|控制面拒绝无 token|本地控制面提供健康'`

Expected: PASS with zero matching test failures.

- [ ] **Step 5: Commit**

```bash
git add runtime/http-server.mjs tests/http-server.test.mjs
git commit -m "feat: expose OpenClaw compatibility diagnostics"
```

### Task 3: Public API, Documentation, and Windows CI Verification

**Files:**
- Modify: `runtime/index.mjs`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`

- [x] **Step 1: Add the public export and failing package-entry assertion**

```js
export { inspectOpenClaw } from './openclaw-adapter.mjs';

test('package exports the read-only OpenClaw diagnostic', async () => {
  const packageApi = await import('openclaw-workbench');
  assert.equal(typeof packageApi.inspectOpenClaw, 'function');
});
```

- [x] **Step 2: Run the assertion to verify it fails before export**

Run: `npm test -- --test-name-pattern='package exports the read-only'`

Expected: FAIL because the public entrypoint does not export the diagnostic.

- [x] **Step 3: Document the exact user-visible states**

Add a README section containing only these supported outcomes:

```text
GET /v1/openclaw/diagnostics
ready: the CLI produced a parseable version.
unavailable / CLI_NOT_FOUND: the configured command is not runnable from Workbench.
unavailable / CLI_UNAVAILABLE: the CLI did not complete the bounded read-only probe.
```

State explicitly that this endpoint does not authenticate to OpenClaw, read configuration, start Gateway, call a model, modify a workspace, or expose stderr.

- [x] **Step 4: Add Windows CI coverage**

Append `OpenClaw 诊断` to the existing Windows compatibility test-name pattern in `.github/workflows/ci.yml`; retain the complete Linux suite unchanged.

- [x] **Step 5: Run final verification**

Run: `node --check runtime/openclaw-adapter.mjs && node --check runtime/http-server.mjs && npm test -- --test-name-pattern='CLI|Windows|OpenClaw 诊断|终端执行需要|审批后执行命令|控制面提供健康' && npm pack --dry-run && git diff --check`

Expected: exit code 0 and zero matching test failures.

- [ ] **Step 6: Commit**

```bash
git add runtime/index.mjs README.md .github/workflows/ci.yml tests/cli.test.mjs
git commit -m "docs: document OpenClaw diagnostic compatibility gate"
```

## Self-Review

- Scope coverage: the plan covers a diagnostic contract, secured endpoint, package API, documentation, Windows CI, and no configuration mutation.
- Out of scope by design: Gateway WebSocket, device pairing, MCP probe, configuration import, UI, secret storage, and Bridge each require separate plans after this probe can report a reliable local CLI state.
- Placeholder scan: no task depends on undocumented OpenClaw internals; the only invoked command is fixed `--version`.
- Type consistency: `inspectOpenClaw` is the adapter export, `inspectOpenClawFn` is the HTTP dependency injection seam, and its normalized response is the endpoint payload.
