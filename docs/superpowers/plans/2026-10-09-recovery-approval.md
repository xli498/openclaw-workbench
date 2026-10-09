# Recovery Approval Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the read-only recovery report into a safe, human-approved `resume` / `rollback` workflow in the HTTP control plane and desktop operations panel.

**Architecture:** A recovery proposal is held in memory and binds one transaction, operation mode, manifest byte hash, freshly inspected report, and action hash. Approval uses the separate approval token, rechecks the manifest and report under the existing recovery lock, and then calls the existing `executeRecovery`; after Runtime restart, no proposal is executable and the transaction returns to manual review. The UI displays every relative path and its exact effect before approval; it never stores or displays credentials.

**Tech Stack:** Node.js ESM, `node:test`, existing transaction recovery primitives, static HTML/CSS/JavaScript Tauri frontend.

---

### Task 1: Lock manifest identity and prove the missing HTTP behavior

**Files:**
- Modify: `tests/change-transaction.test.mjs`
- Modify: `tests/http-server.test.mjs`
- Test targets: `runtime/recovery.mjs`, `runtime/http-server.mjs`

- [ ] Add a scanner test that writes exact JSON bytes to `.openclaw-workbench/transactions/tx-hash.json`, calls `scanPendingTransactions`, and asserts `manifestHash === sha256(fileBytes)` while `JSON.stringify(manifest)` does not contain helper fields `manifestHash` or `manifestPath`.
- [ ] Add an `executeRecovery` test that passes an incorrect `expectedManifestHash`, expects `MANIFEST_CONFLICT`, and verifies the target file remains byte-for-byte unchanged.
- [ ] Add an HTTP test using a real pending transaction fixture: `POST /v1/recovery/tx-resume/proposals` with `{"mode":"resume"}` returns `201` and a file impact; approval without `x-approval-token` returns `403`; approval with the wrong action hash returns `409`; valid `POST /v1/recovery/proposals/:proposalId/approve` returns `200`, applies the real temp file, and commits the manifest.
- [ ] Add a rollback HTTP test that starts with the target at `afterHash`, approves `rollback`, and verifies the real snapshot is restored and the manifest becomes `rolled_back`.
- [ ] Add stale-state tests that edit the target after proposal and mutate the manifest during the approval audit write; each approval must return `409` and must not overwrite the changed target.
- [ ] Run `node --test tests/change-transaction.test.mjs tests/http-server.test.mjs`; confirm the new cases fail because manifest hashing and recovery routes do not yet exist.

### Task 2: Implement safe transaction-bound recovery proposals

**Files:**
- Modify: `runtime/recovery.mjs`
- Modify: `runtime/http-server.mjs`
- Test: `tests/change-transaction.test.mjs`, `tests/http-server.test.mjs`

- [ ] While scanning, hash the exact manifest bytes with SHA-256. Expose `manifestPath` and `manifestHash` as non-enumerable helper properties so final-state writes cannot accidentally persist scanner metadata.
- [ ] Extend `executeRecovery` with optional `expectedManifestHash`. When both it and `manifestPath` are supplied, read the canonical manifest safely after acquiring the existing workspace write lock and reject a missing or different byte hash with `RecoveryError('MANIFEST_CONFLICT', ...)` before inspecting or changing any target.
- [ ] Add an in-memory map with a maximum of 32 pending recovery proposals and a transaction claim set. `POST /v1/recovery/:transactionId/proposals` accepts `{ "mode": "resume" | "rollback" }`, looks up the transaction from `scanPendingTransactions` (never joins user input to a path), inspects it again, requires `decision === 'requires_approval'`, and creates an `awaiting_approval` high-risk action.
- [ ] Bind the action preview to `{ transactionId, state, mode, files }`; each file contains only `relativePath`, current state (`before` / `after`), and effect (`apply_after` / `keep_after` / `restore_before` / `keep_before`). Store the raw manifest hash and report digest privately with the proposal.
- [ ] Add `POST /v1/recovery/proposals/:proposalId/approve`. Require `x-approval-token`, compare the submitted `actionHash`, claim the transaction, rescan and re-inspect the pending manifest, compare both stored fingerprints, and then call `executeRecovery({ root, manifest, manifestPath, expectedManifestHash, mode, approved: true, audit: effectiveAudit })`.
- [ ] Write `transaction.recovery.proposed` and `transaction.recovery.approved` audit records before execution and `transaction.recovery.verified` after success. Record only relative paths, mode, IDs, hashes, result state, and approved actor; never record file contents or credentials. Consume the proposal after success or execution failure.
- [ ] Add the proposal summary to its transaction in `GET /v1/recovery`; proposals remain non-executable after process restart because the map is not persisted.
- [ ] Map approval failures to `403`, missing records to `404`, stale/conflicting/busy states to `409`, and proposal limit to `429`; return sanitized error codes and messages only.
- [ ] Run the focused tests and verify resume, rollback, stale report, stale manifest, wrong hash, missing approval, and no-replay-after-restart behavior.

### Task 3: Let the desktop operator inspect impact and approve

**Files:**
- Modify: `desktop/frontend/app.js`
- Modify: `desktop/frontend/index.html`
- Modify: `desktop/frontend/styles.css`
- Modify: `tests/desktop-operations-panel.test.mjs`

- [ ] Add a failing static contract requiring the proposal and approval routes, separate approval flag, displayed relative file effects, and explicit confirmation text.
- [ ] Render each transaction with its current decision and per-file current state. Offer `申请继续完成` only when resume is applicable, and `申请回滚` only when rollback is applicable.
- [ ] After proposal creation, display mode, transaction ID, affected paths, and each exact effect; require the operator to press `批准并执行恢复` before sending the approval request.
- [ ] Call approval through `modelRequest('POST', path, { actionHash }, true)` so the existing Rust Runtime request layer supplies the separate approval token. Do not place any token in DOM text, localStorage, or console output.
- [ ] On success or conflict, clear the proposal card and refresh operations so the user sees the authoritative final state; on failure, keep the report visible and show a safe error code.
- [ ] Run `node --test tests/desktop-operations-panel.test.mjs` and `node --check desktop/frontend/app.js`.

### Task 4: Document, verify, and preserve the result

**Files:**
- Modify: `docs/06-chat-session-api.md`
- Modify: `docs/04-review-log.md`
- Create: `C:\Users\HP\Documents\Codex\shared\results\<current timestamp>_openclaw_recovery_approval.json`
- Append: `C:\Users\HP\Documents\Codex\shared\results\index.jsonl`

- [ ] Document `POST /v1/recovery/:transactionId/proposals`, `POST /v1/recovery/proposals/:proposalId/approve`, separate-token approval, hash-bound staleness checks, and the no-replay-after-restart rule.
- [ ] Run focused tests, the full `npm test`, `git diff --check`, package/static checks, and the repository’s existing recovery/security tests; record exact counts and exit codes.
- [ ] Review the full diff for path/secret leakage and confirm only tracked feature files and plan/docs are changed; leave untracked `output/` and `Ƭ` untouched.
- [ ] Request code review on the final diff, fix all Critical/Important findings, then commit the verified scoped changes on `codex/mcp-streamable-bridge`.
- [ ] Push only after fresh verification and successful remote connectivity; if the proxy or GitHub blocks the push, retain the local commit and record the exact blocker without changing global proxy settings.
