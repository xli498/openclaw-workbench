import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { runControlledCommand, validateCommandLimits, openStableCwd } from './terminal.mjs';
import { classifyCommand } from './policy.mjs';
import { readSnapshot, snapshotDigest, writeSnapshotAtomically } from './snapshot-store.mjs';
import { redactText } from './redaction.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_SESSION_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const TERMINAL_STATES = new Set(['running', 'exited', 'cancelled', 'timed_out', 'failed', 'manual_review']);
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|private|var)\/)[^\s\r\n]*/g;

export class TerminalSessionError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'TerminalSessionError'; this.code = code; this.details = details; }
}

function fail(code, message, details) { throw new TerminalSessionError(code, message, details); }

function safeSessionId(value) {
  if (value === undefined) return randomUUID();
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) fail('SESSION_ID_INVALID', 'session id is invalid');
  return value;
}

function safeCwd(value = '.') {
  if (typeof value !== 'string' || !value || value.length > 1_024 || /[\0\r\n]/.test(value)) fail('CWD_INVALID', 'session cwd is invalid');
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '') || '.';
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) fail('PATH_ESCAPE', 'session cwd escapes workspace');
  return normalized;
}

function safeTimeout(value) {
  return value === undefined ? DEFAULT_TIMEOUT_MS : value;
}

function safeError(error, fallback = 'SESSION_FAILED') {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : fallback;
  return Object.freeze({ code });
}

  function redactOutput(value, maxLength) {
    return redactText(typeof value === 'string' ? value.replace(ABSOLUTE_PATH_PATTERN, '[path redacted]') : value, maxLength);
  }

  function restoreChunks(value, outputLimit) {
    if (!Array.isArray(value)) return { chunks: [], outputBytes: 0 };
    const chunks = [];
    let outputBytes = 0;
    for (const chunk of value.slice(0, 512)) {
      const text = redactOutput(String(chunk?.text ?? ''), Math.max(outputLimit + 3, 16 * 1024));
      if (!text) continue;
      const bytes = Buffer.byteLength(text, 'utf8');
      const remaining = outputLimit - outputBytes;
      if (remaining <= 0) break;
      const bounded = bytes > remaining ? Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8') : text;
      if (!bounded) break;
      chunks.push({ sequence: chunks.length + 1, stream: chunk?.stream === 'stderr' ? 'stderr' : 'stdout', text: bounded });
      outputBytes += Buffer.byteLength(bounded, 'utf8');
      if (bytes > remaining) break;
    }
    return { chunks, outputBytes };
  }

function publicRecord(record) {
  return Object.freeze({
    id: record.id,
    status: record.status,
    argv: Object.freeze(record.argv.map((value) => redactOutput(value, 1_024))),
    cwd: record.cwd,
    capabilities: Object.freeze({ ...record.capabilities }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    outputBytes: record.outputBytes,
    ...(Number.isSafeInteger(record.exitCode) ? { exitCode: record.exitCode } : {}),
    ...(record.error ? { error: { code: record.error.code } } : {}),
  });
}

function comparablePath(value) {
  let normalized = path.normalize(value);
  if (process.platform === 'win32') {
    normalized = normalized
      .replace(/^\\\\\?\\UNC\\/i, '\\\\')
      .replace(/^\\\\\?\\/, '')
      .toLowerCase();
  }
  return normalized;
}

function isSameOrInsidePath(root, candidate) {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function createTerminalSessionManager({ root, sessionProvider, runCommand = runControlledCommand, maxSessions = 8, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, maxInputBytes = MAX_INPUT_BYTES, clock = () => Date.now(), sessionDirectory = '.openclaw-workbench/terminal-sessions' } = {}) {
  if (!root) throw new TerminalSessionError('ROOT_REQUIRED', 'workspace root is required');
  if (typeof runCommand !== 'function') throw new TerminalSessionError('RUNNER_INVALID', 'terminal command runner is invalid');
  if (sessionProvider !== undefined && typeof sessionProvider !== 'function') throw new TerminalSessionError('PROVIDER_INVALID', 'terminal session provider is invalid');
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 64) throw new TerminalSessionError('CONFIG_INVALID', 'maxSessions is invalid');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_SESSION_OUTPUT_BYTES) throw new TerminalSessionError('CONFIG_INVALID', 'maxOutputBytes is invalid');
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > MAX_INPUT_BYTES) throw new TerminalSessionError('CONFIG_INVALID', 'maxInputBytes is invalid');
  if (typeof sessionDirectory !== 'string' || path.isAbsolute(sessionDirectory) || sessionDirectory.includes('..') || sessionDirectory.split(/[\\/]/).some((segment) => !segment)) throw new TerminalSessionError('CONFIG_INVALID', 'session directory is invalid');

  const rootPath = path.resolve(root);
  const records = new Map();
  const runtimes = new Map();
  const digests = new Map();
  const reservations = new Set();
  const creating = new Set();
  let closing = false;
  let restored = false;

  function statePath(id) { return path.join(rootPath, sessionDirectory, `${id}.json`); }

  async function ensureDirectory() {
    const directory = path.join(rootPath, sessionDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const resolvedRoot = await realpath(rootPath).catch((error) => { throw new TerminalSessionError('ROOT_UNAVAILABLE', error.message); });
    const resolvedDirectory = await realpath(directory).catch((error) => { throw new TerminalSessionError('SESSION_STORE_UNAVAILABLE', error.message); });
    if (!isSameOrInsidePath(directory, resolvedDirectory) || !isSameOrInsidePath(resolvedRoot, resolvedDirectory)) fail('SESSION_STORE_ESCAPE', 'session store escapes workspace');
    return directory;
  }

  function persistedValue(record) {
    return {
      version: 1,
      id: record.id,
      status: record.status,
      argv: record.argv.map((value) => redactText(value, 1_024)),
      cwd: record.cwd,
      capabilities: { ...record.capabilities },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      outputBytes: record.outputBytes,
      chunks: record.chunks.map((chunk) => ({ sequence: chunk.sequence, stream: chunk.stream, text: redactOutput(chunk.text, record.maxOutputBytes) })),
      ...(Number.isSafeInteger(record.exitCode) ? { exitCode: record.exitCode } : {}),
      ...(record.error ? { error: { code: record.error.code } } : {}),
    };
  }

  async function persist(record) {
    const previous = record.persistTail ?? Promise.resolve();
    const next = previous.then(async () => {
      await ensureDirectory();
      const payload = JSON.stringify(persistedValue(record));
      const current = digests.get(record.id) ?? null;
      const digest = writeSnapshotAtomically({ root: rootPath, storePath: statePath(record.id), payload, expectedDigest: current, ErrorType: TerminalSessionError, code: 'SESSION_STORE_INVALID', message: 'terminal session store is invalid', busyCode: 'SESSION_STORE_BUSY', busyMessage: 'terminal session store is busy', conflictCode: 'SESSION_STORE_CONFLICT', conflictMessage: 'terminal session state changed outside this process', temporaryName: 'terminal-session' });
      digests.set(record.id, digest);
    });
    record.persistTail = next.catch((error) => {
      if (record.status === 'running') {
        record.status = 'manual_review';
        record.capabilities = { pty: false, input: false, incrementalOutput: false };
        record.error = { code: 'SESSION_STORE_FAILURE' };
        record.updatedAt = new Date(clock()).toISOString();
        cancelRuntime(record);
        runtimes.delete(record.id);
      }
      return undefined;
    });
    return next;
  }

  function snapshotRecord(record) {
    return Object.freeze({ ...record, argv: [...record.argv], capabilities: { ...record.capabilities }, chunks: record.chunks.map((chunk) => ({ ...chunk })) });
  }

  function cancelRuntime(record) {
    const runtime = runtimes.get(record.id);
    if (!runtime || runtime.cancelRequested) return;
    runtime.cancelRequested = true;
    if (runtime.timeout) clearTimeout(runtime.timeout);
    if (typeof runtime.handle?.cancel === 'function') void Promise.resolve(runtime.handle.cancel()).catch(() => {});
    else runtime.controller.abort();
  }

  function appendOutput(record, value) {
    if (record.status !== 'running') return;
    const stream = value?.stream === 'stderr' ? 'stderr' : 'stdout';
    const outputLimit = record.maxOutputBytes ?? maxOutputBytes;
    const text = redactOutput(typeof value === 'string' ? value : value?.text, Math.max(outputLimit + 3, 16 * 1024));
    if (!text) return;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (record.outputBytes + bytes > outputLimit) {
      const remaining = Math.max(0, outputLimit - record.outputBytes);
      if (remaining > 0) {
        const truncated = Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8');
        record.chunks.push({ sequence: record.chunks.length ? record.chunks.at(-1).sequence + 1 : 1, stream, text: truncated });
        record.outputBytes += Buffer.byteLength(truncated, 'utf8');
      }
      finish(record, 'failed', { code: 'OUTPUT_LIMIT' });
      cancelRuntime(record);
      return;
    }
    record.chunks.push({ sequence: record.chunks.length ? record.chunks.at(-1).sequence + 1 : 1, stream, text });
    record.outputBytes += bytes;
    record.updatedAt = new Date(clock()).toISOString();
    void persist(record).catch(() => {});
  }

  function finish(record, status, error, result = {}) {
    if (!record || record.status !== 'running') return;
    if (!TERMINAL_STATES.has(status) || status === 'running') status = 'failed';
    record.status = status;
    record.updatedAt = new Date(clock()).toISOString();
    if (Number.isSafeInteger(result.code)) record.exitCode = result.code;
    if (error) record.error = safeError(error);
    void persist(record).catch(() => {});
  }

  async function start(record) {
    const controller = new AbortController();
    const runtime = { controller, handle: null, timeout: null };
    runtimes.set(record.id, runtime);
    const onOutput = (value) => appendOutput(record, value);
    const onExit = (result = {}) => {
      const status = result.status === 'cancelled' ? 'cancelled' : result.status === 'timed_out' ? 'timed_out' : result.status === 'failed' ? 'failed' : 'exited';
      finish(record, status, result.error ?? (status === 'failed' ? result : null), result);
      if (runtime.timeout) clearTimeout(runtime.timeout);
      runtimes.delete(record.id);
    };
    runtime.timeout = setTimeout(() => {
      if (record.status !== 'running') return;
      finish(record, 'timed_out', { code: 'TIMEOUT' });
      cancelRuntime(record);
      runtimes.delete(record.id);
    }, record.timeoutMs);
    try {
      if (sessionProvider) {
        runtime.handle = await sessionProvider({ root: rootPath, argv: [...record.argv], cwd: record.cwd, timeoutMs: record.timeoutMs, maxOutputBytes: record.maxOutputBytes, signal: controller.signal, onOutput, onExit });
        if (!runtime.handle || typeof runtime.handle !== 'object') fail('PROVIDER_INVALID', 'terminal session provider returned an invalid handle');
        record.capabilities = { pty: runtime.handle.capabilities?.pty === true, input: runtime.handle.capabilities?.input === true, incrementalOutput: runtime.handle.capabilities?.incrementalOutput === true };
        if (runtime.cancelRequested && typeof runtime.handle.cancel === 'function') void Promise.resolve(runtime.handle.cancel()).catch(() => {});
      } else {
        runtime.handle = { cancel: () => controller.abort() };
        void Promise.resolve(runCommand({ root: rootPath, argv: [...record.argv], cwd: record.cwd, timeoutMs: record.timeoutMs, maxOutputBytes: record.maxOutputBytes, approved: true, signal: controller.signal }))
          .then((result) => { appendOutput(record, { stream: 'stdout', text: result?.stdout }); appendOutput(record, { stream: 'stderr', text: result?.stderr }); onExit({ status: 'exited', code: result?.code }); })
          .catch((error) => { if (error?.details?.stdout) appendOutput(record, { stream: 'stdout', text: error.details.stdout }); if (error?.details?.stderr) appendOutput(record, { stream: 'stderr', text: error.details.stderr }); onExit({ status: error?.code === 'TIMEOUT' ? 'timed_out' : error?.code === 'ABORTED' ? 'cancelled' : 'failed', error }); });
      }
    } catch (error) { onExit({ status: 'failed', error }); }
  }

  async function restore() {
    if (restored) return Object.freeze({ sessions: records.size });
    restored = true;
    let directory;
    try { directory = await ensureDirectory(); }
    catch (error) { if (error.code === 'ENOENT') return Object.freeze({ sessions: 0 }); throw error; }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!SESSION_ID_PATTERN.test(id)) continue;
      try {
        const snapshot = readSnapshot({ root: rootPath, storePath: statePath(id), ErrorType: TerminalSessionError, code: 'SESSION_STORE_INVALID', message: 'terminal session snapshot is invalid' });
        if (!snapshot.content) continue;
        const value = JSON.parse(snapshot.content);
        if (value?.version !== 1 || value.id !== id || !Array.isArray(value.argv) || !TERMINAL_STATES.has(value.status)) continue;
        const restoredOutput = restoreChunks(value.chunks, maxOutputBytes);
        const record = { id, status: value.status, argv: value.argv.map((item) => redactText(String(item), 1_024)), cwd: safeCwd(value.cwd), timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes, capabilities: { pty: value.capabilities?.pty === true, input: value.capabilities?.input === true, incrementalOutput: value.capabilities?.incrementalOutput === true }, createdAt: value.createdAt, updatedAt: value.updatedAt, outputBytes: restoredOutput.outputBytes, chunks: restoredOutput.chunks, ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}), ...(value.error ? { error: safeError(value.error) } : {}) };
        digests.set(id, snapshot.digest);
        records.set(id, record);
        if (record.status === 'running') { record.status = 'manual_review'; record.capabilities = { pty: false, input: false, incrementalOutput: false }; record.error = { code: 'SESSION_INTERRUPTED' }; record.updatedAt = new Date(clock()).toISOString(); await persist(record); }
      } catch { /* malformed records are ignored and never executed */ }
    }
    return Object.freeze({ sessions: records.size });
  }

  async function create({ id, argv, cwd = '.', timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes: requestedOutputBytes = maxOutputBytes, approved = false } = {}) {
    if (!approved) fail('APPROVAL_REQUIRED', 'terminal session requires explicit approval');
    if (closing) fail('SESSION_CLOSING', 'terminal session manager is closing');
    try { validateCommandLimits({ argv, timeoutMs, maxOutputBytes: requestedOutputBytes }); }
    catch (error) { throw new TerminalSessionError(error.code, error.message, error.details); }
    const commandPolicy = classifyCommand(argv);
    if (commandPolicy.class === 'blocked') fail('COMMAND_POLICY_DENIED', 'command is blocked by policy', { commandPolicy });
    const safeId = safeSessionId(id);
    const activeCount = [...records.values()].filter((record) => record.status === 'running').length;
    if (activeCount + reservations.size >= maxSessions) fail('SESSION_LIMIT', 'terminal session limit reached');
    if (records.has(safeId) || reservations.has(safeId)) fail('SESSION_EXISTS', 'terminal session already exists');
    reservations.add(safeId);
    let resolveCreation;
    const creation = new Promise((resolve) => { resolveCreation = resolve; });
    creating.add(creation);
    try {
      const safeWorkingDirectory = safeCwd(cwd);
      const stable = await openStableCwd(rootPath, safeWorkingDirectory);
      await stable.handle.close().catch(() => {});
      const now = new Date(clock()).toISOString();
        const record = { id: safeId, status: 'running', argv: [...argv], cwd: safeWorkingDirectory, timeoutMs: safeTimeout(timeoutMs), maxOutputBytes: requestedOutputBytes, capabilities: { pty: false, input: false, incrementalOutput: false }, createdAt: now, updatedAt: now, outputBytes: 0, chunks: [] };
      records.set(safeId, record);
      try { await persist(record); await start(record); }
      catch (error) { records.delete(safeId); throw error; }
      return publicRecord(record);
    } finally {
      reservations.delete(safeId);
      resolveCreation();
      creating.delete(creation);
    }
  }

  function get(id) {
    if (!records.has(id)) fail('SESSION_NOT_FOUND', 'terminal session not found');
    return publicRecord(records.get(id));
  }

  function list() { return Object.freeze([...records.values()].map(publicRecord)); }

  async function read(id, { after = 0, limit = 100 } = {}) {
    if (!records.has(id)) fail('SESSION_NOT_FOUND', 'terminal session not found');
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('OUTPUT_CURSOR_INVALID', 'output cursor is invalid');
    const record = records.get(id);
    const earliest = record.chunks[0]?.sequence ?? record.chunks.length + 1;
    const cursorExpired = after > 0 && after < earliest - 1;
    return Object.freeze({ session: publicRecord(record), chunks: Object.freeze(record.chunks.filter((chunk) => chunk.sequence > after).slice(0, limit).map((chunk) => Object.freeze({ ...chunk }))), next: record.chunks.at(-1)?.sequence ?? after, earliest, cursorExpired });
  }

  async function write(id, input) {
    if (!records.has(id)) fail('SESSION_NOT_FOUND', 'terminal session not found');
    if (typeof input !== 'string' || !input || Buffer.byteLength(input, 'utf8') > maxInputBytes) fail('INPUT_INVALID', 'terminal input is invalid');
    const record = records.get(id);
    if (record.status === 'manual_review') fail('SESSION_MANUAL_REVIEW', 'terminal session requires manual review');
    if (record.capabilities.input !== true) fail('PTY_UNAVAILABLE', 'interactive input is unavailable for this session');
    if (record.status !== 'running') fail('SESSION_NOT_RUNNING', 'terminal session is not running');
    const runtime = runtimes.get(id);
    if (!runtime?.handle || typeof runtime.handle.write !== 'function') fail('PTY_UNAVAILABLE', 'interactive input is unavailable for this session');
    await runtime.handle.write(input);
    return Object.freeze({ id, acceptedBytes: Buffer.byteLength(input, 'utf8') });
  }

  async function cancel(id) {
    if (!records.has(id)) fail('SESSION_NOT_FOUND', 'terminal session not found');
    const record = records.get(id);
    if (record.status !== 'running') return publicRecord(record);
    const runtime = runtimes.get(id);
    try {
      if (runtime?.timeout) clearTimeout(runtime.timeout);
      if (typeof runtime?.handle?.cancel === 'function') await runtime.handle.cancel(); else runtime?.controller.abort();
    }
    catch {}
    finish(record, 'cancelled', { code: 'SESSION_CANCELLED' });
    runtimes.delete(id);
    return publicRecord(record);
  }

  async function close() {
    closing = true;
    await Promise.all([...creating]);
    await Promise.all([...records.values()].filter((record) => record.status === 'running').map((record) => cancel(record.id).catch(() => {})));
    await Promise.all([...records.values()].map((record) => persist(record).catch(() => {})));
  }

  return Object.freeze({ restore, create, get, list, read, write, cancel, close });
}

export { DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, MAX_INPUT_BYTES };
