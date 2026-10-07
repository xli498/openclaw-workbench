# Tauri First Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or **superpowers:executing-plans**. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the existing Tauri scaffold into a safe first-launch shell that starts and stops the existing Node CLI Runtime for a selected workspace and exposes only in-memory connection details to the frontend.

**Architecture:** Keep the Node Runtime and approval/security logic unchanged. The Rust desktop host owns a single child-process state, creates a one-time bearer token, passes it through an environment variable rather than argv, launches `bin/workbench.mjs` with explicit arguments and no shell, and shuts the child down on command or app exit. The static frontend calls typed Tauri commands and keeps the returned token only in page memory.

**Tech Stack:** Tauri 2, Rust 2021, Node.js CLI, static HTML/CSS/JavaScript, Rust unit tests, Node static contract tests.

---

### Task 1: Correct and test the Runtime launch contract

**Files:**
- Modify: `desktop/src/runtime_launcher.rs`
- Test: `desktop/src/runtime_launcher.rs` unit tests

- [ ] Add a failing unit test proving the launch spec points at `bin/workbench.mjs`, rejects relative paths, rejects token values in argv, and accepts explicit `--root`, `--host`, `--port`, `--token-env`, and `--approval-token-env` arguments.
- [ ] Run `cd desktop; cargo test runtime_launcher` and confirm the new contract assertion fails before implementation.
- [ ] Implement `RuntimeLaunchSpec` validation and `spawn_with_tokens` using `Command` argv, `env`, `current_dir`, and `shell: false` semantics. Do not put either token in argv or error text.
- [ ] Add a `RuntimeChild` wrapper with idempotent graceful termination followed by forced kill only when needed.
- [ ] Run `cargo fmt --check` and the focused Rust tests. If Cargo cannot download dependencies, run the static source contract test and record the limitation without claiming compilation.

### Task 2: Add Tauri runtime lifecycle commands

**Files:**
- Modify: `desktop/src/lib.rs`
- Modify: `desktop/Cargo.toml`
- Modify: `desktop/capabilities/default.json`
- Test: `desktop/src/lib.rs` unit tests

- [ ] Add failing tests for start, duplicate start rejection, status, stop, and idempotent app shutdown behavior.
- [ ] Implement a mutex-protected `RuntimeState` and Tauri commands `start_runtime`, `runtime_status`, and `stop_runtime`. The start command validates an absolute existing workspace, chooses an available loopback port, creates a one-time token, starts the existing CLI entry point, and returns `{ baseUrl, token, workspace, pid }` only to the current frontend invocation.
- [ ] Wire `RunEvent::Exit` and window close handling to stop the child. Never persist the token or include it in logs.
- [ ] Keep command permissions limited to core plus the explicitly used dialog capability; do not enable shell or filesystem-wide plugins.
- [ ] Run focused Rust tests and `cargo fmt --check`.

### Task 3: Build the first-launch screen

**Files:**
- Modify: `desktop/frontend/index.html`
- Create: `tests/desktop-first-launch.test.mjs`

- [ ] Add a failing static contract test asserting the page contains workspace selection, start/stop actions, runtime status, error recovery, and a link target for the authenticated control panel without rendering a token in visible text.
- [ ] Implement a restrained dark workbench shell with a workspace path field, native folder-picker button, start/stop controls, status badge, and an “打开工作台” action. Use `window.__TAURI__.core.invoke` and `window.__TAURI__.dialog.open` only when available; show a clear development fallback when the page is opened outside Tauri.
- [ ] Keep the returned bearer token in a JavaScript variable only long enough to construct the authenticated panel URL; never write it to localStorage, DOM text, or console output.
- [ ] Run the focused Node test and `git diff --check`.

### Task 4: Package the existing Runtime resources and verify the slice

**Files:**
- Modify: `desktop/tauri.conf.json`
- Modify: `desktop/README.md`
- Modify: `.github/workflows/ci.yml`

- [ ] Add the Node CLI/runtime files as explicit bundle resources and document the required Node discovery rule for development and packaged builds.
- [ ] Add a Windows desktop smoke job that runs static contract checks and Rust formatting/tests; keep installer build separate until Cargo dependencies are available.
- [ ] Run `npm test`, the new desktop contract test, `npm pack --dry-run`, `git diff --check`, and the available Rust checks.
- [ ] Commit only the scoped desktop first-launch changes with message `feat: connect tauri runtime first launch`.

## Exit criteria

This slice is complete only when a clean checkout can statically verify the Tauri command surface, the Runtime is launched through the existing CLI with explicit argv and environment-based tokens, stop/exit cleanup is idempotent, and the first-launch screen exposes workspace and service status without persisting secrets. MSI/NSIS installation remains a separate gate until Cargo can build on Windows.
