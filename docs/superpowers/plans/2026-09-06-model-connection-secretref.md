# Model Connection And SecretRef Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Add a controlled SecretRef resolver and an explicitly approved, non-persistent OpenAI-compatible model health probe without exposing resolved secrets.

**Architecture:** Keep model registry snapshots metadata-only. A new resolver validates `env:` and abstract `keychain:` references and returns secrets only to the in-memory probe. A new probe performs one bounded HTTP request with injected `fetch`, timeout, abort, response-size, and error sanitization controls. The HTTP control plane keeps GET health non-networked and adds an approval-gated POST health check bound to the current model config hash.

**Tech Stack:** Node.js 22 ESM, built-in `fetch`, `AbortController`, `node:test`, existing model registry/audit/error mapping.

---

### Task 1: SecretRef resolver boundary

**Files:**
- Create: `runtime/secret-resolver.mjs`
- Test: `tests/secret-resolver.test.mjs`
- Modify: `runtime/index.mjs`

- [x] Write tests for valid `env:` resolution, abstract `keychain:` provider resolution, missing references, malformed references, control characters, oversized values, and error messages/details that never include secret values.
- [x] Run `node --test tests/secret-resolver.test.mjs` and confirm it fails because the resolver module does not exist.
- [x] Implement `SecretResolverError`, `parseSecretRef`, and `createSecretResolver({ env, keychainProvider })`; validate reference syntax, bound value length, reject empty/control-character values, and never copy resolved values into metadata.
- [x] Export the resolver from `runtime/index.mjs`.
- [x] Run the focused test and the existing model registry tests.

### Task 2: Bounded model health probe

**Files:**
- Create: `runtime/model-probe.mjs`
- Test: `tests/model-probe.test.mjs`
- Modify: `runtime/index.mjs`

- [x] Write failing tests for an OpenAI-compatible `/models` request, Authorization header construction from a resolver, timeout and caller cancellation, non-2xx/invalid/oversized response handling, unsupported protocols, and proof that secret text is absent from thrown errors.
- [x] Run `node --test tests/model-probe.test.mjs` and confirm the expected missing-module failure.
- [x] Implement `createModelHealthProbe({ secretResolver, fetchImpl, requestTimeoutMs, maxResponseBytes })` with one request per call, no retries, no persistence, bounded body reads, sanitized structured errors, endpoint policy, and protocol-specific headers.
- [x] Export the probe from `runtime/index.mjs`.
- [x] Run focused probe tests and all existing tests.

### Task 3: Approval-gated HTTP integration

**Files:**
- Modify: `runtime/http-server.mjs`
- Test: `tests/http-server.test.mjs`

- [x] Write failing HTTP tests proving GET health remains non-networked, POST health requires the separate approval token and current `configHash`, live probe results update only the health summary, and responses/audit entries contain no secret.
- [x] Run the focused HTTP tests and confirm failure before implementation.
- [x] Add injectable `modelHealthProbe` and `secretResolver` options; keep the existing read-only GET route, and add `POST /v1/models/:id/health` with approval-token and hash checks.
- [x] Map resolver/probe errors to bounded public codes, audit only profile ID/status/code, and never include headers, body, or resolved values.
- [x] Run focused HTTP tests and the full suite.

### Task 4: Red-team review and release verification

**Files:**
- Modify: `docs/04-review-log.md`, `README.md` only if the public API is finalized.
- Create: `C:\Users\HP\Documents\Codex\shared\results\YYYYMMDD_HHmmss_openclaw_workbench_model_connection.json`
- Modify: `C:\Users\HP\Documents\Codex\shared\results\index.jsonl`

- [x] Re-run attacks for secret leakage in errors, JSON responses, audit, snapshots, action previews, malformed refs, oversized responses, timeout races, endpoint policy, and stale config hashes.
- [x] Run `npm test`, `npm pack --dry-run`, `node --check` on changed modules, and `git diff --check`.
- [ ] Perform an independent review of the diff, fix all Critical/Important findings, commit the verified slice, push a PR, wait for Node 22/24/Windows CI, and merge only after all required checks are green.
- [ ] Save the durable result and append its path to the shared results index without storing credentials.
