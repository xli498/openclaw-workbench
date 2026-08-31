# Review Loop

## Round 1 — 2026-08-30

**Result:** FAIL

### Findings
- P1: `GET /v1/status` reran startup recovery and could mutate durable state.
- P1: command proposals defaulted to `working-tree`, so approval did not bind actual workspace content.
- P1: patch targets did not reuse sensitive-path policy.
- P1: command execution resolved allowlisted names through inherited `PATH`.
- P1: patch/recovery commit paths still have filesystem TOCTOU windows.
- P2: audit lock ownership/stale-lock handling is weak.
- P2: snapshot stores reject routine concurrent writes instead of serializing them.
- P2: `safeCwd` remains check-then-use.

### Minimal fixes applied
- Cache startup recovery state once per server instance; status reads cached data.
- Compute and bind a content-based workspace revision for patch and command proposals.
- Reject sensitive patch targets (`.git`, `.env*`, credentials, private keys).
- Resolve executables only from trusted system directories and reduce the command allowlist to exact safe forms.
- Add regression tests for revision requirements, sensitive patch paths, command-path rejection, and PATH hijacking.

### Verification
- `npm test`: 143/143 passed.
- `git diff --check`: passed.

## Round 2 — 2026-08-30

**Result:** FAIL

### Independent review findings
- HTTP approval bodies could inject `currentRevision` because workflow functions preferred caller input over the server revision callback.
- Deleted tracked files were not represented correctly in the workspace digest.
- Request handling could begin before startup recovery finished.

### Minimal fixes applied
- Approval paths now whitelist server-owned inputs and always prefer `getCurrentRevision()` when supplied.
- Workspace digest treats missing tracked files as a stable `deleted` marker.
- All authenticated routes except `/health` await startup recovery.
- Added HTTP revision-injection and workspace modify/add/delete regression tests.

### Verification
- `npm test`: 145/145 passed.
- `git diff --check`: passed.

## Round 3 — 2026-08-30

**Result:** WARN

### Resolved from Round 1
- Status endpoint side effects / repeated scan: resolved.
- Command and patch approval revision drift: resolved for Git workspaces through server-owned content digest binding; HTTP override regression-tested.
- Sensitive patch targets: resolved.
- PATH hijacking and broad read-command allowlist: resolved by trusted executable resolution and exact-form allowlist.

### Remaining shortcomings
- Patch commit and recovery still use path-based `rename()` after validation; a hostile concurrent writer can race parent-directory replacement.
- `safeCwd` remains path-based between `realpath()` and `spawn()`.
- Audit and snapshot locking need owner tokens, stale-lock recovery, and in-process queuing.
- Non-Git workspaces still return the conservative `working-tree` sentinel and therefore do not receive content-based approval binding.
- Product surface remains a local runtime foundation, not a desktop IDE/Bridge/MCP distribution comparable to ShunCode.

### Delivery decision
- The four highest-impact, low-risk defects are fixed and regression-tested.
- The remaining TOCTOU and lock architecture issues require a separate design change rather than a rushed local patch.

## Round 4 — 2026-08-30

**Result:** WARN

### Additional fix
- Patch commit, rollback, recovery resume, and recovery rollback replacements now anchor the target parent directory through a Linux `/proc/self/fd/<fd>` directory handle.
- Replacement sources and targets are re-hashed immediately before rename; committed content is re-opened with `O_NOFOLLOW` and verified immediately after rename.
- Compensating rollback uses the same stable-parent replacement path.

### Verification
- `npm test`: 145/145 passed.
- `git diff --check`: passed.

### Honest residual boundary
- Node.js does not expose `openat`/`renameat2` compare-and-swap primitives. The remaining race between the last target hash check and `rename()` is narrowed but cannot be mathematically eliminated against a hostile non-cooperating local process.
- Recovery manifest scanning/reading and audit/snapshot lock architecture remain future hardening items.
- Final state remains `WARN`, not `PASS`.

## Round 5 — 2026-08-30

**Result:** WARN

### Additional fix
- File audit locks now contain an owner token, PID, and creation timestamp.
- Release removes a lock only when ownership is proven.
- Expired locks owned by a dead process are atomically quarantined and reclaimed.
- Added stale-lock recovery coverage.

### Verification
- `npm test`: 146/146 passed.
- `git diff --check`: passed.

### Remaining
- Snapshot stores are intentionally fail-closed on lock contention and still need a broader async persistence redesign if queued writes are required.
- `safeCwd` remains a Node path-based check/use boundary.

## Round 6 — 2026-08-30

**Result:** WARN

### Independent review findings fixed
- Recovery rollback now binds the expected current target hash before replacing it, preventing silent overwrite when the target changes after inspection.
- Recovery reads, manifest writes, and transaction manifest scanning now use stable parent directory handles; manifest files are opened with `O_NOFOLLOW` and verified as regular files.
- Audit lock creation cleans up its own newly-created directory if owner metadata cannot be written.

### Verification
- `npm test`: 147/147 passed.
- `git diff --check`: passed.

### Residual boundary
- Pure Node still lacks strict fd-relative compare-and-swap rename primitives; the final hash-check-to-rename window is reduced, not eliminated.
- Snapshot persistence queueing and terminal cwd FD execution remain separate architectural work.
- Final state remains `WARN`.

## Round 7 — 2026-08-30

**Result:** WARN

### Additional fix
- Non-Git workspaces now receive a deterministic content-based `sha256:` revision instead of the constant `working-tree` sentinel.
- The fallback revision recursively binds regular files, directory structure, and safe in-workspace symlinks while excluding sensitive paths and `.openclaw-workbench` runtime state.
- Symlinks that resolve outside the workspace fail closed.
- The fallback rejects aliases into sensitive/internal state and enforces bounded entry/byte budgets to avoid unbounded revision scans.
- Independent review found and closed equivalent Git-worktree gaps: tracked aliases into sensitive state now fail closed, Git entries share the same hard budgets, and regular files are opened with `O_NOFOLLOW`, streamed only after size preflight, and checked for identity/size/mtime stability.

### Residual boundary
- The recursive Node.js fallback is still path-based and cannot provide an atomic whole-tree snapshot against a hostile concurrent writer.
- Snapshot store locking and terminal cwd FD execution remain separate architectural work.

### Independent final review
- Result: `WARN`, with no blocking `FAIL`.
- Confirmed closed: Git aliases into sensitive/internal state, asymmetric Git entry/byte budgets, read-before-budget allocation, final-component symlink following, and unstable-file error classification.
- Verification: `153/153` tests passed and `git diff --check` passed.
- Remaining non-blocking limits: millisecond `mtime` checks are best-effort rather than hostile-writer proof; extreme Git path lists may hit the bounded `execFile` buffer and fail as `GIT_UNAVAILABLE`; whole-tree revision scanning is not atomic.

## Round 8 — 2026-08-30

**Result:** COMPLETE (Round 8 scope)

### Terminal cwd hardening
- Terminal execution now opens the requested workspace directory with `O_DIRECTORY | O_NOFOLLOW`, verifies the opened descriptor still resolves inside the workspace, and spawns through `/proc/self/fd/<fd>`.
- The directory descriptor remains open through `spawn()`, preventing a validated visible path from being replaced with an attacker-controlled directory during the validation-to-spawn window.
- If Linux procfs cannot provide the descriptor path, execution fails closed instead of falling back to the original pathname.
- This mechanism is Linux/procfs-specific and is not claimed to be portable.

### Snapshot persistence hardening
- `snapshot-store` now creates a per-operation `0600` temp name and a lock-directory owner record containing a UUID token and start timestamp.
- Cleanup removes only a temp name created for this operation and only a lock whose on-disk owner token still matches; this prevents ABA cleanup from removing a replacement lock.
- Stale recovery is conservative: only a parseable, expired owner record is quarantined by rename before cleanup; malformed/active locks remain busy. Cleanup failures do not replace the primary write/conflict error.
- Removed post-rename pathname `chmod`; the created temp inode already has `0600` permissions.

### Approval claim and session error handling
- Proposal approvals persist an `awaiting_approval → executing` claim before an awaited workflow. Claims bind action hash, UUID token, and start time; only the matching token may persist a terminal action. Restarted non-terminal claims recover as `manual_review` and are never replayed.
- HTTP maps concurrent approval conflicts to `409`, and a concurrency test proves only one approval proceeds.
- Chat and plan persistence cleanup now preserves the primary agent/review error and attaches persistence failure metadata instead of allowing a `finally` write to mask it.

### Verification
- Added proposal-claim/restart and concurrent-HTTP-approve tests, plus retained terminal stable-cwd coverage.
- Focused suites: `27/27` passed.
- Full suite: `157/157` passed (`npm test`).
- `git diff --check` passed.

### Remaining WARN
- Node pathname validation cannot eliminate all hostile-writer TOCTOU between checks and filesystem operations; these paths fail closed where detectable, but descriptor-relative filesystem primitives would be required to close the residual fully.
- Stable terminal CWD deliberately requires Linux `/proc/self/fd`; unsupported procfs fails closed.
- Lock stale recovery uses elapsed time plus authenticated-on-disk ownership metadata, not PID liveness; a long paused writer beyond the stale threshold can be conservatively displaced and will fail its ownership-protected cleanup rather than removing the successor lock.

## Round 9 — 2026-08-30

**Result:** COMPLETE (security closure review)

### P1 fixed: snapshot parent-directory replacement
- `writeSnapshotAtomically` opens and validates the snapshot parent with `O_DIRECTORY | O_NOFOLLOW`, then uses only its Linux `/proc/self/fd/<fd>` anchor for lock creation/opening, owner metadata, current snapshot reads, temporary writes, rename, stale quarantine, and cleanup.
- The lock directory is independently opened with the same no-follow directory-handle rule. Owner-token and ABA protections remain intact: cleanup removes a lock only when its owner record still has this operation's UUID token.
- Procfs anchoring is mandatory for these writes. If it is unavailable, the store fails closed rather than reusing the mutable original parent pathname.
- A direct regression test swaps the visible parent directory for a symlink immediately after the parent FD is opened; output remains in the renamed original inode and nothing is written outside the workspace.

### P2 test closure
- Added controlled-command coverage that replaces the visible cwd with an outside symlink after FD opening; the child runs in the original opened inode.
- Existing direct coverage retains owner-only snapshot permissions, busy-lock refusal, stale-owner behavior, malformed/symlink owner refusal, conflict preservation, and terminal timeout/abort/output-limit handling.
- The focused persistence/terminal suites pass `20/20`; direct snapshot lock coverage passes `2/2`; the full suite is now `161/161`.

### Verification
- `node --test tests/session-persistence.test.mjs tests/terminal.test.mjs`: `20/20` passed.
- `npm test`: `161/161` passed.
- No Python source files are present, so `py_compile` is not applicable.
- `git diff --check`: passed.

### Residual architecture boundaries (P2, accepted)
- Pure Node exposes no portable `openat`/fd-relative rename API. This Linux implementation closes the mutable-parent path by resolving all critical names under verified `/proc/self/fd` directory descriptors; non-procfs environments fail closed.
- Stale recovery remains timestamp-based rather than PID-liveness-based. A paused writer older than the threshold may be quarantined, but its token-bound cleanup cannot remove a successor lock.

### Final review state
- P0: `0`
- P1: `0`
- P2: `2` (documented platform/API boundaries above)
- Exploration: saturated for the identified snapshot-path and terminal-FD threat surfaces.

## Round 10 — 2026-08-30

**Result:** COMPLETE (final safety closure)

### P1 closure
- `readSnapshot()` now opens the parent with `O_DIRECTORY | O_NOFOLLOW`, requires its `/proc/self/fd/<fd>` anchor, then opens the basename with `O_NOFOLLOW`, verifies a regular inode with `fstat`, and reads that same FD. Parent rename/external replacement cannot redirect recovery reads; missing parent remains an empty snapshot, while procfs/symlink/non-regular failures fail closed.
- Snapshot parent creation is now component-by-component from an opened verified root FD. It no longer performs recursive `mkdir()` through a mutable full parent path.
- Lock owner reads are same-FD `O_NOFOLLOW` reads. Stale cleanup rechecks parent entry dev/inode plus owner token/inode before owner unlink and before `rmdir`; detected ABA successors are retained. Node has no `unlinkat`/CAS, so the unavoidable micro-window is fail-safe by non-empty-directory failure rather than deleting a successor.

### P2 closure
- If an approval claim succeeds but revision, command-ledger, policy/hash, or audit prerequisites fail without a terminal action, HTTP persists `manual_review` with a bounded error summary and matching claim token, and removes the live in-memory proposal. It cannot remain permanently executable.
- Existing session `finally` persistence handling preserves the primary error code/message/cause and attaches `details.persistenceError`.
- Terminal retains procfs fail-closed behavior and its synchronous spawn, async error, abort, FD-close, and single-settlement coverage from prior rounds.

### New regression coverage
- Production snapshot read: parent rename + external replacement and final-component symlink refusal.
- Safe nested parent creation and stale quarantine cleanup successor replacement.
- Existing focused proposal/http tests verify durable claims and only-token completion; full suite covers the established terminal/session fault cases.

### Verification
- Focused `node --test tests/snapshot-store.test.mjs`: `4/4` passed.
- Focused `node --test tests/proposal-store.test.mjs tests/http-server.test.mjs`: `26/26` passed.
- `npm test`: `163/163` passed.
- No Python source files are present; `py_compile` is not applicable.
- `git diff --check`: passed.

### Final review state
- P0: `0`
- P1: `0`
- P2: `0` for the scoped actionable defects. Residual platform boundary: Node lacks fd-relative unlink/CAS primitives; this implementation detects substitutions and fails safe, but cannot make filesystem mutation mathematically atomic against a hostile kernel-level racing process.
- Exploration: saturated for the requested snapshot, claim-terminalization, session-persistence, and terminal lifecycle surfaces.


## Round 11 — 2026-08-30

**Result:** COMPLETE (Round 11 final review)

### P1 closure
- `writeSnapshotAtomically()` now obtains the current digest through the already-verified parent FD and an `O_NOFOLLOW` regular-file FD; it no longer uses pathname `readFileSync(currentPath)`. A production-write hook regression swaps the final digest entry to an external symlink immediately before this open and proves the operation fails closed without changing the external file.
- Automatic stale-lock quarantine is disabled. Pure Node lacks an atomic compare-and-rename primitive, so a pre-rename inode check cannot prevent quarantining a successor lock. Expired locks now remain busy for manual recovery. Regression coverage replaces the lock immediately after stale candidate verification and proves the successor stays at the live lock name and the writer remains busy.

### P2 closure
- `markManualReview()` now persists `proposal.action.status: manual_review`, retaining claim/action-hash/token and bounded prerequisite error context. Restart restoration also terminalizes every non-terminal proposal into this non-executing state; recovery summaries no longer count it as executing. Tests cover revision/ledger-audit precondition failure and restart readback.
- Controlled terminal execution has a minimal private test-only spawn seam. A synchronous spawn throw maps to `SPAWN_FAILED`, closes the stable CWD FD, and settles once; existing async error, abort, timeout, and output-limit coverage remains intact.

### Verification
- `npm test`: **166/166 passed**.
- Python sources: none found; `py_compile` not applicable.
- `git diff --check`: passed.

### Final review state
- P0: **0**
- P1: **0**
- P2: **0**
- Exploration: saturated for all requested snapshot digest/open, stale-lock ABA, proposal manual-review, and terminal spawn lifecycle branches.
- Deliberate residual boundary: stale locks require manual recovery because Node does not expose a safe source-identity compare-and-rename operation; this is a fail-closed availability tradeoff, not an unresolved concurrency-write risk.

## Round 12 — 2026-08-31

**Result:** COMPLETE (scoped P1 repair)

### Fixes
- Snapshot reads now open every parent component from a verified root directory FD with `O_DIRECTORY | O_NOFOLLOW`; nested ancestor symlink replacement cannot redirect recovery reads.
- `createCommandProposal()` is async and awaits audit append before returning. Audit failure is propagated, so HTTP cannot return `201` before the proposal audit is durable/accepted.
- Terminal success, synchronous spawn throw, async error, abort, timeout, and output-limit paths share an awaited single-settlement close path. Close errors are recorded as bounded diagnostics and do not replace the primary process result.

### Verification
- Focused snapshot/command/terminal suites: **41/41 passed**.
- Full suite: **169/169 passed** (`npm test`).
- `git diff --check`: passed.
- Python sources: none found; `py_compile` not applicable.

### Final review state
- P0: **0**
- P1: **0** for the requested scoped findings.
- P2: **0** for the requested actionable items; residual platform boundary remains Node's lack of portable fd-relative CAS/unlink primitives, handled fail-closed.
- No commit or push performed. Independent read-only review remains advisable before release.

## Round 13 — 2026-08-31

**Result:** COMPLETE (terminal synchronous-spawn diagnostic repair)

### P1 closure
- The synchronous `spawn()` throw branch now keeps a single diagnostics object through awaited stable-CWD closure and rejects with the original `SPAWN_FAILED` error.
- If closing the stable CWD FD also fails, `details.closeError` is retained without replacing the synchronous spawn failure code or message.
- Regression coverage wraps the existing test-only CWD-open seam, performs the real FD close, then injects an `ECLOSE` failure. It verifies the primary spawn failure, preserved close diagnostic, one close-error callback, and a closed handle.

### Verification
- `node --test tests/terminal.test.mjs`: **11/11 passed**.
- Focused snapshot/command/terminal/http suites: **44/44 passed**.
- `npm test`: **168/168 passed**. This is the observed current-suite count; it differs from the historical Round 12 record of `169/169`.
- Python sources: none found; `py_compile` not applicable.
- `git diff --check`: passed.

### Final review state
- P0: **0** in this scoped review.
- P1: **0** in this scoped review; synchronous spawn failure retains close diagnostics.
- P2: **0** for the identified test-gap defect; the injected close failure verifies the real diagnostic path.
- Residual platform boundary: Node lacks portable fd-relative CAS/unlink primitives; the scoped terminal lifecycle repair does not alter that boundary.
- No commit or push performed. A fresh independent read-only review is still recommended before release.
