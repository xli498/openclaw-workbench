# Windows desktop scaffold

This directory is a minimal Tauri 2 shell for OpenClaw Workbench. It is intentionally isolated from the existing Node runtime: no runtime files, package scripts, secrets, or UI integration are changed here.

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

## Safe runtime launcher contract

`src/runtime_launcher.rs` documents the host-side contract for a future integration. A caller must provide:

1. An absolute path to `node.exe`.
2. An absolute path to the existing `runtime/index.mjs` entry point.
3. An absolute working directory inside the chosen Workbench checkout.
4. Explicit argv values such as `--root`, `--host`, and `--port`.

The contract starts Node with `Command` argv and `shell: false` semantics (no shell string), validates paths before spawning, and returns a child handle for lifecycle management. It does not read, create, persist, or pass secrets. It is not exposed through the window or a Tauri command yet; authentication and approval integration must be designed separately before enabling it.

