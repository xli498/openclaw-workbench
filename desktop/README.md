# Windows desktop scaffold

This directory contains the Tauri 2 Windows desktop shell for OpenClaw Workbench. The Node runtime remains a separate child process. The desktop bundle owns its resource layout and never stores API keys or runtime bearer tokens in the bundle.

## Prerequisites

- Windows 10/11
- Node.js `>=22.19.0` (development fallback only; release installers carry their own Node runtime)
- Rust toolchain with Cargo
- Tauri Windows prerequisites (WebView2, Microsoft C++ Build Tools with the MSVC `link.exe`, and a Windows 10/11 SDK)

## Setup and development

From the repository root:

```powershell
cd desktop
cargo check
cargo test
cargo tauri dev
```

`cargo tauri dev` is a development run. If bundle resources are not materialized, a debug build first looks for `desktop/node-runtime/node.exe` and then may use a supported Node.js on `PATH`. The source-checkout fallback is compiled out of release builds.

Before building, run the Tauri environment preflight from `desktop`:

```powershell
npx --yes @tauri-apps/cli@2.12.1 info
```

This uses an ephemeral `npx` download and does not install a global Tauri CLI or modify the repository. The preflight should report WebView2, Rust/Cargo, Visual Studio Build Tools with MSVC, and a Windows SDK. If the output reports `link.exe` not found, install the Microsoft C++ Build Tools workload with a Windows 10/11 SDK, reopen the terminal, and run the preflight again. Do not change the Rust linker configuration to hide this missing Windows toolchain.

## Windows build

```powershell
cd desktop
npx --yes @tauri-apps/cli@2.12.1 build --ci
```

Before a Windows release build, prepare the exact Node.js `v22.19.0` win-x64 archive in `desktop/node-runtime/`. CI downloads this archive automatically; the binary is intentionally ignored by Git and is never committed. The release bundle maps that directory to `runtime/node` and starts `runtime/node/node.exe` from the Tauri resource directory.

Installers are emitted below `desktop/target/release/bundle/`.

## Installer lifecycle contract

Every release must publish both Windows installer formats: an MSI and an NSIS
`.exe`. The Tauri `version` is kept equal to the repository version so Windows
Installer can detect an upgrade instead of creating a second product. A clean
install must start the bundled runtime, and an upgrade must preserve the chosen
workspace while replacing the application and runtime files.

Uninstall removes the application, bundled runtime, shortcuts, and registered
runtime process. It must not delete a user's workspace or API keys: model
secrets are held by Windows Credential Manager and workspace state belongs to
the selected project. A failed or interrupted uninstall must not be treated as
proof that cleanup succeeded.

The Windows CI job verifies the MSI and NSIS files exist and that the package
metadata is internally consistent. This is a contract check, not a GUI
installation test. Real clean-install, upgrade, and uninstall verification
must still be run on an isolated Windows machine with a disposable workspace;
the release checklist is:

1. Install the MSI and confirm the app opens, the bundled `runtime/node/node.exe`
   starts, and no API key appears in the install directory or logs.
2. Install a newer version over the same installation and confirm the workspace
   selection, Credential Manager entry, and runtime health survive the upgrade.
3. Uninstall from Windows Settings or the NSIS uninstaller, confirm the app and
   runtime files are gone, then confirm the workspace and Credential Manager
   entry remain until the user explicitly removes them.

Do not run these GUI lifecycle checks against a developer's real workspace or
real credentials. Record the Windows version, installer type, package version,
exit code, and cleanup observations with the release artifact.

`cargo tauri build` remains equivalent when the Tauri CLI is already installed. Both commands require the MSVC `link.exe`; `cargo check` and `cargo test` can fail before compiling the application when Visual Studio Build Tools or the Windows SDK is absent.

The installer includes the runtime resources under the Tauri resource directory:

- `runtime/bin/workbench.mjs`
- `runtime/runtime/` (Node runtime modules and Windows helper scripts)
- `runtime/package.json`
- `runtime/node/node.exe` and the accompanying Node.js runtime files

The release desktop process resolves the entry point and Node executable from `AppHandle.path().resource_dir()`. If packaged resources are missing, startup fails instead of falling back to a source checkout or a system Node.js installation. This keeps the installer self-contained and makes the runtime version deterministic.

## Safe runtime launcher contract

`src/runtime_launcher.rs` implements the host-side launch contract. A caller must provide:

1. An absolute path to `node.exe`.
2. An absolute path to the existing `bin/workbench.mjs` entry point (from the bundle resource directory in release builds).
3. An absolute working directory inside the chosen Workbench checkout.
4. Explicit argv values such as `--root`, `--host`, and `--port`.

The launcher starts Node with argv and `shell: false` semantics, validates paths, and manages the child lifecycle. Tauri commands generate one-time bearer tokens in memory, pass them to the child only through environment variables, and proxy authenticated requests without exposing tokens to the frontend. Shutdown first uses the authenticated endpoint, then falls back to a bounded process-tree stop.
