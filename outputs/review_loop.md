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
