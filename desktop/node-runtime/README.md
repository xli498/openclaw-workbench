# Bundled Node.js v22.19.0 runtime staging directory

The Windows release bundle expects Node.js `v22.19.0` for `win-x64` in this
directory. CI downloads the official archive and extracts it here immediately
before the desktop tests and Tauri build. Keep the executable and runtime DLLs
out of Git; the repository intentionally contains this placeholder only.

For local release builds, prepare this directory from the matching official
Node.js archive before running `npx --yes @tauri-apps/cli@2.12.1 build --ci`.
