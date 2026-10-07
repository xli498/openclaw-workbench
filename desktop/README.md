# Windows desktop scaffold

This directory contains the Tauri 2 Windows desktop shell for OpenClaw Workbench. The Node runtime remains a separate child process. The desktop bundle owns its resource layout and never stores API keys or runtime bearer tokens in the bundle.

## Prerequisites

- Windows 10/11
- Node.js `>=22.19.0`
- Rust toolchain with Cargo
- Tauri Windows prerequisites (WebView2 and Microsoft C++ Build Tools)

## Setup and development

From the repository root:

```powershell
cd desktop
cargo check
cargo test
cargo tauri dev
```

`cargo tauri dev` is a development run. If bundle resources are not materialized, a debug build may use the checkout's `bin/` and `runtime/` directories. This fallback is compiled out of release builds.

If the Tauri CLI is not installed, install it without changing the repository:

```powershell
cargo install tauri-cli --version '^2'
```

## Windows build

```powershell
cd desktop
cargo tauri build
```

Installers are emitted below `desktop/target/release/bundle/`.

The installer includes the runtime resources under the Tauri resource directory:

- `runtime/bin/workbench.mjs`
- `runtime/runtime/` (Node runtime modules and Windows helper scripts)
- `runtime/package.json`

The release desktop process resolves the entry point from `AppHandle.path().resource_dir()`. If packaged resources are missing, startup fails instead of falling back to a source checkout. The current installer still requires a supported system Node.js (`>=22.19.0`) on `PATH`; Node.js is not bundled yet.

## Safe runtime launcher contract

`src/runtime_launcher.rs` implements the host-side launch contract. A caller must provide:

1. An absolute path to `node.exe`.
2. An absolute path to the existing `bin/workbench.mjs` entry point (from the bundle resource directory in release builds).
3. An absolute working directory inside the chosen Workbench checkout.
4. Explicit argv values such as `--root`, `--host`, and `--port`.

The launcher starts Node with argv and `shell: false` semantics, validates paths, and manages the child lifecycle. Tauri commands generate one-time bearer tokens in memory, pass them to the child only through environment variables, and proxy authenticated requests without exposing tokens to the frontend. Shutdown first uses the authenticated endpoint, then falls back to a bounded process-tree stop.
