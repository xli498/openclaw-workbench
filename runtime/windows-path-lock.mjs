import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const WINDOWS = process.platform === 'win32';
const SCRIPT = fileURLToPath(new URL('./windows-path-lock.ps1', import.meta.url));
const FILE_OPS_SCRIPT = fileURLToPath(new URL('./windows-file-ops.ps1', import.meta.url));

function powershellPath() {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function payloadPaths() {
  const directory = path.join(os.tmpdir(), `ocw-path-lock-${process.pid}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return { directory, ready: path.join(directory, 'ready'), release: path.join(directory, 'release') };
}

function killProcess(child) {
  try {
    if (child?.pid) spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true });
  } catch {}
}

function waitForExit(child, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(child.pid, 0); } catch { return true; }
  }
  return false;
}

export function isBrokerReadyContent(value) {
  return value === 'OK' || value.startsWith('ERROR:');
}

function waitForReady(paths, child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(paths.ready)) {
      let result;
      try { result = readFileSync(paths.ready, 'utf8'); } catch {}
      if (result !== undefined && isBrokerReadyContent(result)) {
        if (result !== 'OK') throw new Error(result);
        return;
      }
    }
    try { process.kill(child.pid, 0); } catch { throw new Error('windows path lock broker exited'); }
  }
  throw new Error('windows path lock broker timeout');
}

function startBroker({ root, parent, target, expectedParent }) {
  const paths = payloadPaths();
  const payload = Buffer.from(JSON.stringify({ root, parent, target, expectedParent, ready: paths.ready, release: paths.release }), 'utf8').toString('base64');
  const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Payload', payload], { shell: false, stdio: 'ignore', windowsHide: true });
  try {
    waitForReady(paths, child);
  } catch (error) {
    killProcess(child);
    rmSync(paths.directory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  return Object.freeze({
    close() {
      if (closed) return;
      closed = true;
      try { writeFileSync(paths.release, 'release'); } catch {}
      const deadline = Date.now() + 2_000;
      if (!waitForExit(child, deadline - Date.now())) {
        killProcess(child);
        waitForExit(child, 2_000);
      }
      rmSync(paths.directory, { recursive: true, force: true });
    },
  });
}

export function openWindowsPathLock({ root, parent, target, expectedParent } = {}) {
  if (!WINDOWS) return null;
  return startBroker({ root, parent, target, expectedParent });
}

export async function openWindowsPathLockAsync(options = {}) {
  if (!WINDOWS) return null;
  return openWindowsPathLock(options);
}

function fileOpsPayload(options) {
  return Buffer.from(JSON.stringify(options), 'utf8').toString('base64');
}

function fileOpsArgs(options) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FILE_OPS_SCRIPT, '-Payload', fileOpsPayload(options)];
}

export function runWindowsFileOperationSync(options = {}) {
  if (!WINDOWS) throw new Error('windows file operations are only available on Windows');
  const result = spawnSync(powershellPath(), fileOpsArgs(options), { shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || 'windows file operation failed').trim());
  return String(result.stdout ?? '');
}

export async function runWindowsFileOperation(options = {}) {
  if (!WINDOWS) throw new Error('windows file operations are only available on Windows');
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), fileOpsArgs(options), { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || 'windows file operation failed')));
  });
}
