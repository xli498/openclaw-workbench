import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SERVICE_PATTERN = /^[A-Za-z0-9._:-]{1,127}$/;
const NAME_PATTERN = /^[A-Za-z0-9._:-]{1,127}$/;
const MAX_SECRET_LENGTH = 8192;

export class SecretStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecretStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SecretStoreError(code, message);
}

function validateService(service) {
  if (typeof service !== 'string' || !SERVICE_PATTERN.test(service)) fail('SECRET_STORE_SERVICE_INVALID', 'secret store service is invalid');
  return service;
}

function validateName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) fail('SECRET_STORE_INPUT_INVALID', 'store input is invalid');
  return name;
}

function validateSecret(secret) {
  if (typeof secret !== 'string' || !secret || Buffer.byteLength(secret, 'utf8') > MAX_SECRET_LENGTH || /[\0\r\n]/.test(secret)) fail('SECRET_STORE_INPUT_INVALID', 'store input is invalid');
  return secret;
}

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OcwCredentialNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount;
    public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("Advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
'@
  $target = 'OpenClawWorkbench:' + [string]$request.service + ':' + [string]$request.name
  $kind = [UInt32]1
  if ($request.op -eq 'set') {
    $blob = [System.Text.Encoding]::Unicode.GetBytes([string]$request.value)
    $pin = [Runtime.InteropServices.Marshal]::AllocHGlobal($blob.Length)
    try {
      [Runtime.InteropServices.Marshal]::Copy($blob, 0, $pin, $blob.Length)
      $credential = New-Object OcwCredentialNative+CREDENTIAL
      $credential.Type = $kind; $credential.TargetName = $target; $credential.UserName = 'OpenClawWorkbench'
      $credential.CredentialBlobSize = [UInt32]$blob.Length; $credential.CredentialBlob = $pin; $credential.Persist = [UInt32]2
      if (-not [OcwCredentialNative]::CredWrite([ref]$credential, 0)) { throw 'credential operation failed' }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($pin) }
    [Console]::Out.Write('{"ok":true}')
  } elseif ($request.op -eq 'get' -or $request.op -eq 'has') {
    $pointer = [IntPtr]::Zero
    if (-not [OcwCredentialNative]::CredRead($target, $kind, 0, [ref]$pointer)) {
      $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($nativeError -eq 1168) { [Console]::Out.Write('{"ok":true,"found":false}'); exit 0 }
      throw 'credential operation failed'
    }
    try {
      $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][OcwCredentialNative+CREDENTIAL])
      if ($request.op -eq 'has') { [Console]::Out.Write('{"ok":true,"found":true}') }
      else {
        $bytes = New-Object byte[] $credential.CredentialBlobSize
        [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $credential.CredentialBlobSize)
        $value = [System.Text.Encoding]::Unicode.GetString($bytes)
        [Console]::Out.Write((@{ok=$true;found=$true;value=$value} | ConvertTo-Json -Compress))
      }
    } finally { [OcwCredentialNative]::CredFree($pointer) }
  } elseif ($request.op -eq 'delete') {
    $deleted = [OcwCredentialNative]::CredDelete($target, $kind, 0)
    if (-not $deleted -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'credential operation failed' }
    [Console]::Out.Write((@{ok=$true;deleted=$deleted} | ConvertTo-Json -Compress))
  } else { throw 'credential operation failed' }
} catch {
  [Console]::Error.WriteLine('credential operation failed')
  exit 1
}
`;

function parseBackendResult(stdout) {
  try {
    const result = JSON.parse(stdout);
    if (!result || result.ok !== true) fail('SECRET_STORE_BACKEND_FAILED', 'secret store operation failed');
    return result;
  } catch (error) {
    if (error instanceof SecretStoreError) throw error;
    fail('SECRET_STORE_BACKEND_FAILED', 'secret store operation failed');
  }
}

export function createPowerShellCredentialBackend({ platform = process.platform, systemRoot = process.env.SystemRoot ?? 'C:\\Windows', execFileImpl, runPowerShell } = {}) {
  if (platform !== 'win32') fail('SECRET_STORE_UNAVAILABLE', 'Windows Credential Manager is unavailable');
  if (execFileImpl !== undefined && typeof execFileImpl !== 'function') fail('SECRET_STORE_BACKEND_INVALID', 'secret store backend is invalid');
  if (runPowerShell !== undefined && typeof runPowerShell !== 'function') fail('SECRET_STORE_BACKEND_INVALID', 'secret store backend is invalid');
  const executable = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  async function invoke(op, service, name, value) {
    const input = JSON.stringify({ op, service, name, ...(value === undefined ? {} : { value }) });
    try {
      const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT];
      const result = runPowerShell
        ? await runPowerShell(executable, args, { input, inputEncoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 })
        : await (execFileImpl ?? execFileAsync)(executable, args, { input, encoding: 'utf8', inputEncoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
      return parseBackendResult(result.stdout);
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      fail('SECRET_STORE_BACKEND_FAILED', 'secret store operation failed');
    }
  }
  return Object.freeze({
    async set(service, name, value) { await invoke('set', service, name, value); },
    async get(service, name) { const result = await invoke('get', service, name); return result.found ? result.value : null; },
    async has(service, name) { return (await invoke('has', service, name)).found === true; },
    async delete(service, name) { return (await invoke('delete', service, name)).deleted === true; },
  });
}

export function createMemorySecretBackend() {
  const entries = new Map();
  function key(service, name) { return `${service}\0${name}`; }
  return Object.freeze({
    async set(service, name, value) { entries.set(key(service, name), value); },
    async get(service, name) { return entries.get(key(service, name)) ?? null; },
    async has(service, name) { return entries.has(key(service, name)); },
    async delete(service, name) { return entries.delete(key(service, name)); },
  });
}

export function createNoopSecretBackend() {
  return Object.freeze({
    async set() {},
    async get() { return null; },
    async has() { return false; },
    async delete() { return false; },
  });
}

export function createWindowsCredentialStore({ service, backend, platform = process.platform } = {}) {
  validateService(service);
  const selectedBackend = backend ?? (platform === 'win32' ? createPowerShellCredentialBackend({ platform }) : createMemorySecretBackend());
  for (const method of ['set', 'get', 'delete', 'has']) {
    if (typeof selectedBackend?.[method] !== 'function') fail('SECRET_STORE_BACKEND_INVALID', 'secret store backend is invalid');
  }
  return Object.freeze({
    async set(name, value) {
      validateName(name); validateSecret(value);
      try { await selectedBackend.set(service, name, value); }
      catch (error) { if (error instanceof SecretStoreError) throw error; fail('SECRET_STORE_BACKEND_FAILED', 'secret store operation failed'); }
    },
    async get(name) {
      validateName(name);
      let value;
      try { value = await selectedBackend.get(service, name); }
      catch (error) { if (error instanceof SecretStoreError) throw error; fail('SECRET_STORE_BACKEND_FAILED', 'secret store operation failed'); }
      if (value === null || value === undefined) return null;
      return validateSecret(value);
    },
    async has(name) {
      validateName(name);
      try { return Boolean(await selectedBackend.has(service, name)); }
      catch (error) { if (error instanceof SecretStoreError) throw error; fail('SECRET_STORE_BACKEND_FAILED', 'secret store operation failed'); }
    },
    async delete(name) {
      validateName(name);
      try { return Boolean(await selectedBackend.delete(service, name)); }
      catch (error) { if (error instanceof SecretStoreError) throw error; fail('SECRET_STORE_BACKEND_FAILED', 'secret store operation failed'); }
    },
  });
}
