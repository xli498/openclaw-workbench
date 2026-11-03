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
// Absolute-path redaction for every outward-facing copy of a session (public
// view, persisted snapshot, restored record). The old pattern only matched a
// fixed POSIX prefix list (/Users/, /home/, /tmp/, /private/, /var/), so a
// path under any other root (/workspace/, /opt/, /srv/, /etc/, /usr/, ...)
// passed through untouched. The new pattern matches any token-start absolute
// path: a Windows drive path, a backslash UNC path, or a POSIX path. A bare
// "//" after a scheme or "=" is left alone so URLs such as http://... are not
// mangled; a path must start at the string start or after a delimiter, so a
// relative segment such as "a/b" is not treated as absolute.
// Delimiter/terminator notes (redline fixes for the s1 review):
// - DELIM adds the previously missing `<`, `>`, `|`, `&`, `)` (and backtick),
//   so `>/tmp/x`, `</tmp/x`, `|/tmp/x`, `&/tmp/x` no longer pass through.
// - TERM terminates a token at `<>|&),;}]` and backtick as well, so a closing
//   `)` is no longer swallowed into the placeholder.
// - A token may continue across a space-separated segment when that segment
//   itself contains a separator (`/opt/private dir/file`), the only
//   space-in-path shape recognisable without knowing the path in advance.
//   Longer space runs whose middle segments carry no separator
//   (e.g. `/tmp/x my dir/file`) remain a documented residual: the tail after
//   the first separator-less segment is relative-looking and cannot be told
//   apart from prose.
// - Forward-slash UNC (`//server/share/...`) is matched separately with a
//   delimiter set that excludes `:`, so `http://...` (where `//` follows a
//   scheme colon) is never treated as UNC, while a genuine UNC token at a
//   token boundary is redacted instead of being exempted wholesale.
const PATH_TERM = '\\s\'"<>|&),;\\]}`';
const PATH_DELIM = '\\s=:"\'([{;,<>&|)}\\]`';
const PATH_DELIM_NO_COLON = '\\s="\'([{;,<>&|)}\\]`';
const PATH_TOKEN = `[^${PATH_TERM}]*`;
const PATH_CONT = `(?:[ \\t]+[^${PATH_TERM}]*[\\\\/][^${PATH_TERM}]*)*`;
const ABSOLUTE_PATH_PATTERN = new RegExp(`(^|[${PATH_DELIM}])(?:[A-Za-z]:[\\\\/]|\\\\\\\\|\\/(?!\\/))${PATH_TOKEN}${PATH_CONT}`, 'g');
const UNC_PATH_PATTERN = new RegExp(`(^|[${PATH_DELIM_NO_COLON}])\\/\\/[^${PATH_TERM}\\/]+\\/(?:${PATH_TOKEN}${PATH_CONT})`, 'g');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

  function stripAbsolutePaths(value) {
    return value.replace(UNC_PATH_PATTERN, '$1[path redacted]').replace(ABSOLUTE_PATH_PATTERN, '$1[path redacted]');
  }

  function truncateText(value, maxLength) {
    return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  // Order matters: secret redaction first, then path replacement, then the
  // length cap. Replacing paths first would leave "[path redacted]" right
  // after a sensitive key (for example "key=/abs/path"), and the secret
  // rule would then cut the placeholder at its space, producing the mangled
  // "key=[redacted] redacted]".
  function redactOutput(value, maxLength) {
    if (typeof value !== 'string') return redactText(value, maxLength);
    return truncateText(stripAbsolutePaths(redactText(value, Number.MAX_SAFE_INTEGER)), maxLength);
  }

  function restoreChunks(value, outputLimit, redact = redactOutput) {
    if (!Array.isArray(value)) return { chunks: [], outputBytes: 0 };
    const chunks = [];
    let outputBytes = 0;
    for (const chunk of value.slice(0, 512)) {
      const text = redact(String(chunk?.text ?? ''), Math.max(outputLimit + 3, 16 * 1024));
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

function publicRecord(record, redact = redactOutput) {
  return Object.freeze({
    id: record.id,
    status: record.status,
    argv: Object.freeze(record.argv.map((value) => redact(value, 1_024))),
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
  // Workspace-root variants for path redaction. The generic pattern above
  // cannot redact a root that contains a space (it stops at the space), so
  // the root itself — plus any path nested under it — is replaced first, as
  // one placeholder, before the generic pattern runs. The in-memory record
  // argv is deliberately NOT rewritten here: the live command still needs
  // the real arguments; only outward-facing copies (public view, persisted
  // snapshot, restored record) go through this function.
  // Workspace-root replacement, boundary-checked and alias-tolerant. The old
  // code replaced the root text with no start/end boundary, so a sibling
  // such as `<root>2/file` lost only its root prefix and leaked the `2/file`
  // tail, and a root occurring mid-token leaked its prefix. The root is now
  // rebuilt from its segments joined by a one-or-two-separator class, so
  // mixed (`C:/work\proj`) and doubled (`C:\\work\\proj`) separator spellings
  // of the same root match, and drive/UNC roots additionally match
  // case-insensitively and under the `\\?\` long-path prefix. The match must
  // start at the string start or after a delimiter and must end at the string
  // end, a separator, or a terminator. Separator classes are composed from
  // String.fromCharCode(92) so no backslash-literal escaping level can drift.
  // The in-memory record argv is deliberately NOT rewritten here: the live
  // command still needs the real arguments; only outward-facing copies go
  // through this function.
  // Order (Q4 Must): root replacement FIRST, then the generic strip, then
  // secret redaction. The old secret-first order destroyed a space-containing
  // root that appeared as a secret value (`key=<spaced-root>/file` was cut
  // at the space by the secret rule, so the root could no longer match and
  // the tail leaked). Secret redaction now runs with `[path redacted]`
  // placeholders held aside, so it cannot mangle a placeholder that follows
  // a key (`key=[path redacted]` stays intact instead of becoming
  // `key=[redacted] redacted]`).
  const BS = String.fromCharCode(92);
  const SEP = `[${BS}${BS}/]`;
  const SEP12 = `(?:[${BS}${BS}/]{1,2})`;
  const LONG_PREFIX = `${BS}${BS}${BS}${BS}${BS}?${BS}${BS}`;
  const rootPattern = (() => {
    const segments = rootPath.split(/[\\/]+/).filter(Boolean);
    if (!segments.length) return null;
    const joined = segments.map(escapeRegExp).join(SEP12);
    const isDrive = /^[A-Za-z]:/.test(segments[0]);
    const isUnc = rootPath.startsWith(`${BS}${BS}`);
    let head;
    if (isDrive) head = `(?:${LONG_PREFIX})?${joined}`;
    else if (isUnc) head = `(?:${LONG_PREFIX}UNC${SEP12}|${BS}${BS}${BS}${BS})${joined}`;
    else head = `${SEP12}${joined}`;
    // No separate start-delimiter group: the head itself begins with a
    // separator (or a drive/UNC prefix), which already anchors the first
    // segment; only the end boundary needs the lookahead, so a root embedded
    // mid-token still has the root itself hidden while a sibling name such
    // as `<root>2/...` is never partially replaced.
    const source = `${head}(?:${SEP}${PATH_TOKEN}${PATH_CONT})?(?=$|[${PATH_TERM}]|${SEP})`;
    // Sibling pass: the same root followed by name-extension characters
    // (`<root>2/...`, `<root>-backup/...`). The boundary lookahead above
    // rightly refuses these, but without a sibling pass a space-containing
    // sibling root would then leak its tail through the generic strip (which
    // stops at the space). The extension class excludes separators and list
    // punctuation, so an exact root or a list-adjacent root never fires here.
    const siblingSource = `${head}[A-Za-z0-9_.\-]+(?:${SEP}${PATH_TOKEN}${PATH_CONT})?`;
    return { source, siblingSource, flags: (isDrive || isUnc) ? 'gi' : 'g' };
  })();
  function redactSecretsPreservingPlaceholders(value) {
    return value.split('[path redacted]').map((part) => redactText(part, Number.MAX_SAFE_INTEGER)).join('[path redacted]');
  }
  function redactStoredPath(value, maxLength) {
    if (typeof value !== 'string') return redactOutput(value, maxLength);
    let output = value;
    if (rootPattern) output = output.replace(new RegExp(rootPattern.siblingSource, rootPattern.flags), '[path redacted]').replace(new RegExp(rootPattern.source, rootPattern.flags), '[path redacted]');
    output = stripAbsolutePaths(output);
    output = redactSecretsPreservingPlaceholders(output);
    return truncateText(output, maxLength);
  }
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
    // realpath may return a canonical casing or a short-name alias that is not
    // textually equivalent to the requested path on Windows. Compare the two
    // canonical paths instead; this still rejects junction/symlink escapes.
    if (!isSameOrInsidePath(resolvedRoot, resolvedDirectory)) fail('SESSION_STORE_ESCAPE', 'session store escapes workspace');
    return directory;
  }

  function persistedValue(record) {
    return {
      version: 1,
      id: record.id,
      status: record.status,
      argv: record.argv.map((value) => redactStoredPath(value, 1_024)),
      cwd: record.cwd,
      capabilities: { ...record.capabilities },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      outputBytes: record.outputBytes,
      chunks: record.chunks.map((chunk) => ({ sequence: chunk.sequence, stream: chunk.stream, text: redactStoredPath(chunk.text, record.maxOutputBytes) })),
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
    const text = redactStoredPath(typeof value === 'string' ? value : value?.text, Math.max(outputLimit + 3, 16 * 1024));
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
        // Bounded provider establishment: the wait for the async provider
        // handle is bounded by the session timeoutMs, so a provider that
        // never resolves cannot hang create()/close() forever. The
        // session-timeout timer can also fire first; either way a handle
        // that arrives after the session left 'running' is cancelled and
        // must never update capability bits (late-handle guard below).
        let providerTimer = null;
        const providerPromise = Promise.resolve().then(() => sessionProvider({ root: rootPath, argv: [...record.argv], cwd: record.cwd, timeoutMs: record.timeoutMs, maxOutputBytes: record.maxOutputBytes, signal: controller.signal, onOutput, onExit }));
        const providerTimeout = new Promise((_, reject) => { providerTimer = setTimeout(() => reject(new TerminalSessionError('PROVIDER_TIMEOUT', 'terminal session provider timed out')), record.timeoutMs); });
        try {
          runtime.handle = await Promise.race([providerPromise, providerTimeout]);
        } catch (error) {
          if (providerTimer) clearTimeout(providerTimer);
          // A late handle must still be cleaned up, never adopted.
          void providerPromise.then((late) => { try { if (late && typeof late.cancel === 'function') void Promise.resolve(late.cancel()).catch(() => {}); } catch {} }).catch(() => {});
          throw error;
        }
        if (providerTimer) clearTimeout(providerTimer);
        if (!runtime.handle || typeof runtime.handle !== 'object') fail('PROVIDER_INVALID', 'terminal session provider returned an invalid handle');
        if (record.status !== 'running' || runtimes.get(record.id) !== runtime) {
          const late = runtime.handle;
          runtime.handle = null;
          if (late && typeof late.cancel === 'function') void Promise.resolve(late.cancel()).catch(() => {});
          return;
        }
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
        const restoredOutput = restoreChunks(value.chunks, maxOutputBytes, redactStoredPath);
        const record = { id, status: value.status, argv: value.argv.map((item) => redactStoredPath(String(item), 1_024)), cwd: safeCwd(value.cwd), timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes, capabilities: { pty: value.capabilities?.pty === true, input: value.capabilities?.input === true, incrementalOutput: value.capabilities?.incrementalOutput === true }, createdAt: value.createdAt, updatedAt: value.updatedAt, outputBytes: restoredOutput.outputBytes, chunks: restoredOutput.chunks, ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}), ...(value.error ? { error: safeError(value.error) } : {}) };
        digests.set(id, snapshot.digest);
        records.set(id, record);
        if (record.status === 'running') { record.status = 'manual_review'; record.capabilities = { pty: false, input: false, incrementalOutput: false }; record.error = { code: 'SESSION_INTERRUPTED' }; record.updatedAt = new Date(clock()).toISOString(); await persist(record); }
        // A snapshot that is ALREADY manual_review gets the same zeroed
        // capabilities: a stale snapshot must never restore live-looking
        // capability bits. Its existing review reason (record.error) is
        // preserved, not overwritten with SESSION_INTERRUPTED.
        else if (record.status === 'manual_review' && (record.capabilities.pty || record.capabilities.input || record.capabilities.incrementalOutput)) { record.capabilities = { pty: false, input: false, incrementalOutput: false }; record.updatedAt = new Date(clock()).toISOString(); await persist(record); }
      } catch { /* malformed records are ignored and never executed */ }
    }
    return Object.freeze({ sessions: records.size });
  }

  async function create({ id, argv, cwd = '.', timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes: requestedOutputBytes = maxOutputBytes, approved = false } = {}) {
    if (approved !== true) fail('APPROVAL_REQUIRED', 'terminal session requires explicit approval');
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
      return publicRecord(record, redactStoredPath);
    } finally {
      reservations.delete(safeId);
      resolveCreation();
      creating.delete(creation);
    }
  }

  function get(id) {
    if (!records.has(id)) fail('SESSION_NOT_FOUND', 'terminal session not found');
    return publicRecord(records.get(id), redactStoredPath);
  }

  function list() { return Object.freeze([...records.values()].map((record) => publicRecord(record, redactStoredPath))); }

  async function read(id, { after = 0, limit = 100 } = {}) {
    if (!records.has(id)) fail('SESSION_NOT_FOUND', 'terminal session not found');
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('OUTPUT_CURSOR_INVALID', 'output cursor is invalid');
    const record = records.get(id);
    const earliest = record.chunks[0]?.sequence ?? record.chunks.length + 1;
    const cursorExpired = after > 0 && after < earliest - 1;
    return Object.freeze({ session: publicRecord(record, redactStoredPath), chunks: Object.freeze(record.chunks.filter((chunk) => chunk.sequence > after).slice(0, limit).map((chunk) => Object.freeze({ ...chunk }))), next: record.chunks.at(-1)?.sequence ?? after, earliest, cursorExpired });
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

  // Resize passthrough: only providers whose handle exposes resize() (the
  // POSIX PTY provider) support it. The non-pty default runner and the
  // Windows ConPTY provider (resize not wired in this slice) report
  // PTY_UNAVAILABLE / PTY_RESIZE_UNSUPPORTED honestly instead of faking
  // a size change. Size validation mirrors the POSIX provider limits.
  async function resize(id, cols, rows) {
    if (!records.has(id)) fail('SESSION_NOT_FOUND', 'terminal session not found');
    if (!Number.isSafeInteger(cols) || cols < 1 || cols > 500 || !Number.isSafeInteger(rows) || rows < 1 || rows > 200) fail('SIZE_INVALID', 'terminal session size is invalid');
    const record = records.get(id);
    if (record.status === 'manual_review') fail('SESSION_MANUAL_REVIEW', 'terminal session requires manual review');
    if (record.status !== 'running') fail('SESSION_NOT_RUNNING', 'terminal session is not running');
    const runtime = runtimes.get(id);
    if (!runtime?.handle || typeof runtime.handle.resize !== 'function') fail('PTY_UNAVAILABLE', 'terminal session resize is unavailable for this session');
    const size = await runtime.handle.resize(cols, rows);
    return Object.freeze({ id, cols: size.cols, rows: size.rows });
  }

  async function cancel(id) {
    if (!records.has(id)) fail('SESSION_NOT_FOUND', 'terminal session not found');
    const record = records.get(id);
    if (record.status !== 'running') return publicRecord(record, redactStoredPath);
    const runtime = runtimes.get(id);
    try {
      if (runtime?.timeout) clearTimeout(runtime.timeout);
      if (typeof runtime?.handle?.cancel === 'function') await runtime.handle.cancel(); else runtime?.controller.abort();
    }
    catch {}
    finish(record, 'cancelled', { code: 'SESSION_CANCELLED' });
    runtimes.delete(id);
    return publicRecord(record, redactStoredPath);
  }

  async function close() {
    closing = true;
    await Promise.all([...creating]);
    await Promise.all([...records.values()].filter((record) => record.status === 'running').map((record) => cancel(record.id).catch(() => {})));
    await Promise.all([...records.values()].map((record) => persist(record).catch(() => {})));
  }

  return Object.freeze({ restore, create, get, list, read, write, cancel, close, resize });
}

export { DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, MAX_INPUT_BYTES };
