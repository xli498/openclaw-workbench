import { spawn } from 'node:child_process';
import path from 'node:path';

// Second LSP slice: document sync, diagnostics intake, an approval-gated
// edit-proposal path, and a multi-server registry live in companion modules.
// This client stays read-only on disk: it never writes a file itself.
// The first slice's guarantees still hold, with one correction: the
// request path sends only methods that are BOTH caller-allowlisted AND
// not on the non-overridable forbidden list below (Q30-2). A custom
// allowedMethods value can add further read methods, but it can never
// re-enable a forbidden write/execute method, so the old absolute claim
// that "any allowlisted method may be sent" no longer stands -- the
// allowlist is intersected with the forbidden list at construction.
// Server-initiated requests are never auto-executed; commands and
// arguments are refused when they contain shell or credential material;
// environment values are never logged, never stored in snapshots, and
// never included in error text. The spawned server inherits only an
// explicit base environment (PATH/HOME/LANG/LC_ALL/TMPDIR) plus the
// caller-validated env entries, never the whole parent environment
// (Q30-4).
//
// Edit proposals produced here are NOT applied by this client. A proposal
// is data for the repository's existing Patch proposal + independent
// approval flow. Any code path that takes a proposal from
// collectWorkspaceEditProposal / editProposalHandler and writes it
// straight to disk is a bug: it bypasses the approval gate.
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_DOCUMENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTICS_PER_URI = 256;
const DEFAULT_MAX_DIAGNOSTIC_MESSAGE_CHARS = 4096;
const SHELL_PATTERN = /[;&|<>`$()\r\n]/;
const SECRET_PATTERN = /(?:bearer|token|password|secret|api[_ -]?key)\s*[:=]|:\/\/[^/\s:]+:[^@\s]+@/i;
const SECRET_FLAG_PATTERN = /(?:^|\s)(?:--?|\/)(?:token|password|secret|api[-_ ]?key)(?:\s|=|$)/i;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const URL_USERINFO_PATTERN = /:\/\/[^/\s:]+:[^@\s]+@/g;
const BEARER_TOKEN_PATTERN = /bearer\s+[A-Za-z0-9._\-~+/=]+/gi;
// Credential-assignment values must cover quoted values in full:
// with a bare [^\s,;]+ value, secret="a b" redacted only `"a` and
// left ` b"` behind. The quoted alternatives come first so a quoted
// value (including spaces) is consumed whole; unquoted values keep
// the old terminators.
const CREDENTIAL_ASSIGN_PATTERN = /([A-Za-z0-9_.\-]*(?:password|passwd|secret|token|api[ _-]?key)[A-Za-z0-9_.\-]*\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi;

export const LSP_READ_ONLY_METHODS = Object.freeze([
  'initialize',
  'shutdown',
  'textDocument/hover',
  'textDocument/definition',
  'textDocument/references',
  'textDocument/documentSymbol',
  'textDocument/completion',
  'workspace/symbol',
]);

// Q30-2: non-overridable forbidden methods. A caller-supplied
// allowedMethods array is intersected with this list at construction:
// any entry here makes construction fail, so no caller can smuggle a
// write or execute method past the read-only gate by passing a custom
// allowlist. Entries are methods that mutate state, execute commands,
// or carry edits/commands back from the server: the client never sends
// them as requests, whatever the caller allowlists.
export const LSP_FORBIDDEN_METHODS = Object.freeze([
  'workspace/applyEdit',
  'workspace/executeCommand',
  'workspace/didChangeConfiguration',
  'workspace/didChangeWatchedFiles',
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didClose',
  'textDocument/didSave',
  'textDocument/willSaveWaitUntil',
  'textDocument/rename',
  'textDocument/prepareRename',
  'textDocument/formatting',
  'textDocument/rangeFormatting',
  'textDocument/onTypeFormatting',
  'textDocument/codeAction',
]);

// Q30-4: the only parent-environment keys a spawned server inherits.
// Everything else the server sees must come from the caller-validated
// env argument, never from a blanket process.env spread.
const LSP_BASE_ENV_KEYS = Object.freeze(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']);

export class LspClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LspClientError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message) { throw new LspClientError(code, message); }

function safeCommand(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\0\r\n]/.test(value)) fail('LSP_COMMAND_INVALID', 'LSP server command is invalid');
  if (SHELL_PATTERN.test(value) || SECRET_PATTERN.test(value) || SECRET_FLAG_PATTERN.test(value)) fail('LSP_COMMAND_INVALID', 'LSP server command contains unsafe shell or credential material');
  return value;
}

function safeArgs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) fail('LSP_ARGS_INVALID', 'LSP args must be an array of at most 64 strings');
  return value.map((item) => {
    if (typeof item !== 'string' || !item || item.length > 512 || /[\0\r\n]/.test(item)) fail('LSP_ARGS_INVALID', 'LSP arg is invalid');
    if (SHELL_PATTERN.test(item) || SECRET_PATTERN.test(item) || SECRET_FLAG_PATTERN.test(item)) fail('LSP_ARGS_INVALID', 'LSP arg contains unsafe shell or credential material');
    return item;
  });
}

function safeEnv(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('LSP_ENV_INVALID', 'LSP env must be an object');
  const entries = Object.entries(value);
  if (entries.length > 128) fail('LSP_ENV_INVALID', 'LSP env has too many entries');
  const env = {};
  for (const [key, val] of entries) {
    // Q30-4: env values get the same shell/credential-material checks as
    // commands and args. A value smuggling `$(...)`, a shell separator,
    // or a credential assignment (token=/password=, a URL userinfo) is
    // refused before spawn instead of being handed to the server.
    if (!ENV_PATTERN.test(key) || typeof val !== 'string' || val.length > 4096 || /[\0\r\n]/.test(val)
      || SHELL_PATTERN.test(val) || SECRET_PATTERN.test(val) || SECRET_FLAG_PATTERN.test(val)) fail('LSP_ENV_INVALID', 'LSP env entry is invalid');
    env[key] = val;
  }
  return env;
}

// Re-exported under public names so the server registry (and any other
// module) validates commands, args, and env with exactly the same rules
// as this client instead of re-implementing them.
export function validateLspCommand(value) { return safeCommand(value); }
export function validateLspArgs(value) { return safeArgs(value); }
export function validateLspEnv(value) { return safeEnv(value); }

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

// Resolve a file:// URI (empty host or localhost only) against the
// workspace root. decodeURIComponent runs before path.resolve so an
// encoded ".." cannot smuggle a path out, and the resolved path must
// equal the root or live under it. Anything else is out of root.
function resolveLspUri(uri, rootPath) {
  if (typeof uri !== 'string' || !uri || uri.includes('\0')) fail('LSP_URI_OUT_OF_ROOT', 'LSP URI is outside the workspace root');
  const match = uri.match(/^file:\/\/([^/]*)(\/.*)$/);
  if (!match) fail('LSP_URI_OUT_OF_ROOT', 'LSP URI is outside the workspace root');
  const host = match[1];
  if (host !== '' && host !== 'localhost') fail('LSP_URI_OUT_OF_ROOT', 'LSP URI is outside the workspace root');
  const rawPath = match[2];
  if (/[?#]/.test(rawPath)) fail('LSP_URI_OUT_OF_ROOT', 'LSP URI is outside the workspace root');
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { fail('LSP_URI_OUT_OF_ROOT', 'LSP URI is outside the workspace root'); }
  if (decoded.includes('\0')) fail('LSP_URI_OUT_OF_ROOT', 'LSP URI is outside the workspace root');
  const resolved = path.resolve(decoded);
  if (resolved !== rootPath && !resolved.startsWith(rootPath + path.sep)) fail('LSP_URI_OUT_OF_ROOT', 'LSP URI is outside the workspace root');
  return resolved;
}

function isPosition(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Number.isSafeInteger(value.line) && value.line >= 0
    && Number.isSafeInteger(value.character) && value.character >= 0;
}

function comparePositions(a, b) {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}

function copyPosition(value) {
  return Object.freeze({ line: value.line, character: value.character });
}

function copyRange(range) {
  return Object.freeze({ start: copyPosition(range.start), end: copyPosition(range.end) });
}

// LSP positions count UTF-16 code units, which is exactly how JavaScript
// strings are indexed, so offsets below are plain string indices. A
// surrogate pair (e.g. an emoji) occupies two character columns.
function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r') {
      if (text[i + 1] === '\n') i++;
      starts.push(i + 1);
    } else if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineContentLength(text, starts, line) {
  const start = starts[line];
  const next = line + 1 < starts.length ? starts[line + 1] : text.length;
  let end = next;
  if (text[end - 1] === '\n') end--;
  if (text[end - 1] === '\r') end--;
  return end - start;
}

function positionToOffset(text, starts, position) {
  if (position.line >= starts.length) fail('LSP_DOCUMENT_INVALID', 'LSP document change position is out of range');
  if (position.character > lineContentLength(text, starts, position.line)) fail('LSP_DOCUMENT_INVALID', 'LSP document change position is out of range');
  return starts[position.line] + position.character;
}

// Position-encoding alignment (LSP 3.17 `general.positionEncodings`).
// The server negotiates one encoding in its initialize capabilities;
// positions in didChange notifications it receives are counted in that
// encoding, while JavaScript strings are indexed in UTF-16 units. The
// two helpers below convert a character offset within ONE line between
// the negotiated encoding and UTF-16. A position that lands inside a
// multi-unit code point (mid-surrogate-pair, mid-UTF-8-sequence) has no
// valid alignment and throws LSP_POSITION_INVALID; callers must not
// update local state or forward the change when this throws. Positions
// are line-scoped: the caller supplies the line's text, not the whole
// document, because line breaks are encoding-neutral.
export const LSP_POSITION_ENCODINGS = Object.freeze(['utf-8', 'utf-32', 'utf-16']);

function encodingUnitLength(codePoint, encoding) {
  if (encoding === 'utf-32') return 1;
  if (encoding === 'utf-16') return codePoint.length;
  return Buffer.byteLength(codePoint, 'utf8');
}

export function convertLspPositionToUtf16(lineText, character, encoding = 'utf-16') {
  if (typeof lineText !== 'string' || !Number.isSafeInteger(character) || character < 0) fail('LSP_POSITION_INVALID', 'LSP position is invalid');
  if (!LSP_POSITION_ENCODINGS.includes(encoding)) fail('LSP_POSITION_INVALID', 'LSP position encoding is not supported');
  if (encoding === 'utf-16') {
    if (character > lineText.length) fail('LSP_POSITION_INVALID', 'LSP position is out of range');
    return character;
  }
  let encoded = 0;
  let utf16 = 0;
  for (const codePoint of lineText) {
    if (encoded === character) return utf16;
    const step = encodingUnitLength(codePoint, encoding);
    if (encoded + step > character) fail('LSP_POSITION_INVALID', 'LSP position lands inside a code point');
    encoded += step;
    utf16 += codePoint.length;
  }
  if (encoded === character) return utf16;
  fail('LSP_POSITION_INVALID', 'LSP position is out of range');
}

export function convertLspPositionFromUtf16(lineText, utf16Character, encoding = 'utf-16') {
  if (typeof lineText !== 'string' || !Number.isSafeInteger(utf16Character) || utf16Character < 0) fail('LSP_POSITION_INVALID', 'LSP position is invalid');
  if (!LSP_POSITION_ENCODINGS.includes(encoding)) fail('LSP_POSITION_INVALID', 'LSP position encoding is not supported');
  if (encoding === 'utf-16') {
    if (utf16Character > lineText.length) fail('LSP_POSITION_INVALID', 'LSP position is out of range');
    return utf16Character;
  }
  let encoded = 0;
  let utf16 = 0;
  for (const codePoint of lineText) {
    if (utf16 === utf16Character) return encoded;
    if (utf16 + codePoint.length > utf16Character) fail('LSP_POSITION_INVALID', 'LSP position lands inside a code point');
    encoded += encodingUnitLength(codePoint, encoding);
    utf16 += codePoint.length;
  }
  if (utf16 === utf16Character) return encoded;
  fail('LSP_POSITION_INVALID', 'LSP position is out of range');
}

// Apply incremental {range, text} changes in order, each against the
// document produced by the previous one. Throws LSP_DOCUMENT_INVALID on
// any malformed range or out-of-range position; the caller must not
// update local state when this throws.
function applyIncrementalChanges(text, changes) {
  let current = text;
  for (const change of changes) {
    if (!change || typeof change !== 'object' || Array.isArray(change) || typeof change.text !== 'string'
      || !isPosition(change.range?.start) || !isPosition(change.range?.end)
      || comparePositions(change.range.start, change.range.end) > 0) {
      fail('LSP_DOCUMENT_INVALID', 'LSP incremental document change is invalid');
    }
    const starts = computeLineStarts(current);
    const start = positionToOffset(current, starts, change.range.start);
    const end = positionToOffset(current, starts, change.range.end);
    if (start > end) fail('LSP_DOCUMENT_INVALID', 'LSP incremental document change range is invalid');
    current = current.slice(0, start) + change.text + current.slice(end);
  }
  return current;
}

function redactDiagnosticMessage(message) {
  return message
    .replace(URL_USERINFO_PATTERN, '://[redacted]@')
    .replace(BEARER_TOKEN_PATTERN, '[redacted]')
    .replace(CREDENTIAL_ASSIGN_PATTERN, '$1[redacted]');
}

// Keep only the allowlisted diagnostic fields; drop everything else the
// server sent. Returns a frozen record, or null when the entry has no
// usable string message. code/source are bounded and redacted like
// messages: previously they were stored verbatim at any length, so a
// server could smuggle credential or path material through them past
// the message filter.
function sanitizeDiagnostic(diagnostic, maxMessageChars) {
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic) || typeof diagnostic.message !== 'string') return null;
  const record = { message: redactDiagnosticMessage(diagnostic.message).slice(0, maxMessageChars) };
  if (diagnostic.range && typeof diagnostic.range === 'object'
    && isPosition(diagnostic.range.start) && isPosition(diagnostic.range.end)
    && comparePositions(diagnostic.range.start, diagnostic.range.end) <= 0) {
    record.range = copyRange(diagnostic.range);
  }
  if (Number.isSafeInteger(diagnostic.severity)) record.severity = diagnostic.severity;
  if (Number.isSafeInteger(diagnostic.code)) record.code = diagnostic.code;
  else if (typeof diagnostic.code === 'string') record.code = redactDiagnosticMessage(diagnostic.code).slice(0, 128);
  if (typeof diagnostic.source === 'string') record.source = redactDiagnosticMessage(diagnostic.source).slice(0, 128);
  return Object.freeze(record);
}

function validateEditRange(range) {
  if (!range || typeof range !== 'object' || Array.isArray(range)
    || !isPosition(range.start) || !isPosition(range.end)
    || comparePositions(range.start, range.end) > 0) {
    fail('LSP_EDIT_INVALID', 'LSP workspace edit range is invalid');
  }
  return copyRange(range);
}

function validateTextEdit(edit) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit) || typeof edit.newText !== 'string') {
    fail('LSP_EDIT_INVALID', 'LSP workspace edit is invalid');
  }
  return Object.freeze({ range: validateEditRange(edit.range), newText: edit.newText });
}

// Pure function: no fs, no child_process, no network. It turns either a
// workspace/applyEdit request frame (params.edit, optional params.label)
// or a bare WorkspaceEdit ({changes} or {documentChanges}) into a frozen
// {label?, files: [{uri, version|null, edits: [{range, newText}]}],
//  fileOperations?: [{kind, uri|oldUri|newUri, options?}]}
// proposal. Text edits and file operations (create/rename/delete) are
// BOTH proposal data only, in the order the server sent them: landing
// any of them on disk must go through the repository's Patch proposal +
// independent approval flow. Writing a proposal straight to disk
// bypasses that gate and is a bug. Note on positions: text-edit ranges
// are carried exactly as the server sent them, i.e. in the server's
// negotiated position encoding; convert them with
// convertLspPositionToUtf16/FromUtf16 before landing, never silently
// reinterpret them as UTF-16.
export function collectWorkspaceEditProposal(input, { root } = {}) {
  if (typeof root !== 'string' || !root) fail('LSP_ROOT_INVALID', 'LSP workspace root is required');
  const rootPath = path.resolve(root);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('LSP_EDIT_INVALID', 'LSP workspace edit is invalid');
  const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params) ? input.params : null;
  let edit;
  let label;
  if (params && params.edit !== undefined) {
    edit = params.edit;
    label = params.label;
  } else if (input.edit !== undefined) {
    edit = input.edit;
    label = input.label;
  } else {
    edit = input;
    label = input.label;
  }
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) fail('LSP_EDIT_INVALID', 'LSP workspace edit is invalid');
  if (label !== undefined && typeof label !== 'string') fail('LSP_EDIT_INVALID', 'LSP workspace edit label is invalid');
  const hasChanges = edit.changes !== undefined;
  const hasDocumentChanges = edit.documentChanges !== undefined;
  if (hasChanges === hasDocumentChanges) fail('LSP_EDIT_INVALID', 'LSP workspace edit must carry exactly one of changes or documentChanges');
  const byUri = new Map();
  const fileOperations = [];
  const addFile = (uri, version, edits) => {
    resolveLspUri(uri, rootPath);
    if (!Array.isArray(edits) || edits.length === 0) fail('LSP_EDIT_INVALID', 'LSP workspace edit file has no edits');
    const normalized = edits.map(validateTextEdit);
    const existing = byUri.get(uri);
    if (existing) {
      // A version is a constraint on the document state the edits were
      // written against. Keeping only the first non-null version
      // silently dropped later constraints, so edits written against
      // a different version would merge as if they agreed. Equal
      // versions merge; a null side adopts the other's version; two
      // different non-null versions conflict and are rejected.
      if (version !== null) {
        if (existing.version === null) existing.version = version;
        else if (existing.version !== version) fail('LSP_EDIT_INVALID', 'LSP workspace edit document versions conflict for the same URI');
      }
      existing.edits.push(...normalized);
    } else {
      byUri.set(uri, { uri, version, edits: [...normalized] });
    }
  };
  if (hasChanges) {
    if (!edit.changes || typeof edit.changes !== 'object' || Array.isArray(edit.changes)) fail('LSP_EDIT_INVALID', 'LSP workspace edit changes are invalid');
    const entries = Object.entries(edit.changes);
    if (entries.length === 0) fail('LSP_EDIT_INVALID', 'LSP workspace edit is empty');
    for (const [uri, edits] of entries) addFile(uri, null, edits);
  } else {
    if (!Array.isArray(edit.documentChanges) || edit.documentChanges.length === 0) fail('LSP_EDIT_INVALID', 'LSP workspace edit documentChanges are invalid');
    for (const item of edit.documentChanges) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('LSP_EDIT_INVALID', 'LSP workspace edit documentChange is invalid');
      // File operations are proposalized, never applied here. Every URI
      // is resolved against the workspace root exactly like text edits.
      const fileOp = normalizeFileOperation(item, rootPath);
      if (fileOp) { fileOperations.push(fileOp); continue; }
      const doc = item.textDocument;
      if (!doc || typeof doc !== 'object' || typeof doc.uri !== 'string') {
        fail('LSP_EDIT_INVALID', 'LSP workspace edit documentChange is invalid');
      }
      let version = null;
      if (doc.version !== undefined && doc.version !== null) {
        if (!Number.isSafeInteger(doc.version) || doc.version < 0) fail('LSP_EDIT_INVALID', 'LSP workspace edit document version is invalid');
        version = doc.version;
      }
      addFile(doc.uri, version, item.edits);
    }
  }
  if (byUri.size === 0 && fileOperations.length === 0) fail('LSP_EDIT_INVALID', 'LSP workspace edit is empty');
  const files = Object.freeze([...byUri.values()].map((file) => Object.freeze({
    uri: file.uri,
    version: file.version,
    edits: Object.freeze(file.edits),
  })));
  const proposal = label === undefined ? { files } : { label, files };
  if (fileOperations.length > 0) proposal.fileOperations = Object.freeze(fileOperations);
  return Object.freeze(proposal);
}

function validateFileOperationOptions(options, allowedKeys) {
  if (options === undefined) return undefined;
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('LSP_EDIT_INVALID', 'LSP file operation options are invalid');
  for (const [key, value] of Object.entries(options)) {
    if (!allowedKeys.includes(key) || typeof value !== 'boolean') fail('LSP_EDIT_INVALID', 'LSP file operation options are invalid');
  }
  return Object.freeze({ ...options });
}

// Returns a frozen file-operation record, or null when the item is a
// TextDocumentEdit. Unknown kinds stay rejected: silently dropping or
// reinterpreting an unknown operation would misrepresent the proposal.
function normalizeFileOperation(item, rootPath) {
  const kind = item.kind ?? (typeof item.oldUri === 'string' && typeof item.newUri === 'string' ? 'rename' : undefined);
  if (kind === undefined) return null;
  if (kind === 'create') {
    if (typeof item.uri !== 'string') fail('LSP_EDIT_INVALID', 'LSP create file operation uri is invalid');
    resolveLspUri(item.uri, rootPath);
    const options = validateFileOperationOptions(item.options, ['overwrite', 'ignoreIfExists']);
    return Object.freeze(options === undefined ? { kind, uri: item.uri } : { kind, uri: item.uri, options });
  }
  if (kind === 'rename') {
    if (typeof item.oldUri !== 'string' || typeof item.newUri !== 'string') fail('LSP_EDIT_INVALID', 'LSP rename file operation uris are invalid');
    resolveLspUri(item.oldUri, rootPath);
    resolveLspUri(item.newUri, rootPath);
    const options = validateFileOperationOptions(item.options, ['overwrite', 'ignoreIfExists']);
    return Object.freeze(options === undefined ? { kind, oldUri: item.oldUri, newUri: item.newUri } : { kind, oldUri: item.oldUri, newUri: item.newUri, options });
  }
  if (kind === 'delete') {
    if (typeof item.uri !== 'string') fail('LSP_EDIT_INVALID', 'LSP delete file operation uri is invalid');
    resolveLspUri(item.uri, rootPath);
    const options = validateFileOperationOptions(item.options, ['recursive', 'ignoreIfNotExists']);
    return Object.freeze(options === undefined ? { kind, uri: item.uri } : { kind, uri: item.uri, options });
  }
  fail('LSP_EDIT_UNSUPPORTED', 'LSP workspace edit documentChange kind is not supported');
}

export function createLspClient({
  command,
  args,
  root,
  env,
  allowedMethods = LSP_READ_ONLY_METHODS,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  maxDocumentBytes = DEFAULT_MAX_DOCUMENT_BYTES,
  maxDiagnosticsPerUri = DEFAULT_MAX_DIAGNOSTICS_PER_URI,
  maxDiagnosticMessageChars = DEFAULT_MAX_DIAGNOSTIC_MESSAGE_CHARS,
  onNotification,
  onServerRequest,
  editProposalHandler,
} = {}) {
  const serverCommand = safeCommand(command);
  const serverArgs = safeArgs(args);
  if (typeof root !== 'string' || !root) fail('LSP_ROOT_INVALID', 'LSP workspace root is required');
  const rootPath = path.resolve(root);
  const serverEnv = safeEnv(env);
  if (!Array.isArray(allowedMethods) || allowedMethods.length === 0 || allowedMethods.some((m) => typeof m !== 'string')) fail('LSP_METHODS_INVALID', 'LSP allowed methods are invalid');
  // Q30-2: the forbidden list is non-overridable -- a custom allowlist
  // containing a forbidden method fails construction outright, rather
  // than silently dropping the entry and sending the rest.
  for (const method of allowedMethods) {
    if (LSP_FORBIDDEN_METHODS.includes(method)) fail('LSP_METHOD_NOT_ALLOWED', 'LSP method is forbidden even when allowlisted');
  }
  const allowed = new Set(allowedMethods);
  for (const [name, value] of [['requestTimeoutMs', requestTimeoutMs], ['maxFrameBytes', maxFrameBytes], ['maxDocumentBytes', maxDocumentBytes], ['maxDiagnosticsPerUri', maxDiagnosticsPerUri], ['maxDiagnosticMessageChars', maxDiagnosticMessageChars]]) {
    if (!Number.isSafeInteger(value) || value < 1) fail('LSP_CONFIG_INVALID', `${name} must be a positive safe integer`);
  }
  if (onNotification !== undefined && typeof onNotification !== 'function') fail('LSP_CALLBACK_INVALID', 'onNotification must be a function');
  if (onServerRequest !== undefined && typeof onServerRequest !== 'function') fail('LSP_CALLBACK_INVALID', 'onServerRequest must be a function');
  if (editProposalHandler !== undefined && typeof editProposalHandler !== 'function') fail('LSP_CALLBACK_INVALID', 'editProposalHandler must be a function');

  let child = null;
  let state = 'disconnected';
  // Negotiated position encoding; 'utf-16' until a server that reports
  // one of LSP_POSITION_ENCODINGS says otherwise during initialize.
  let positionEncoding = 'utf-16';
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  let initialized = false;
  let closing = false;
  // Open-document table: uri -> {uri, languageId, version, text}. Only
  // updated after a notification frame has been sent successfully, so a
  // send failure can never leave local state ahead of the server.
  const openDocuments = new Map();
  // Diagnostics table: uri -> frozen sanitized diagnostic records.
  // publishDiagnostics replaces (never appends) the entries for its URI.
  const diagnostics = new Map();

  function send(value) {
    if (!child || child.stdin.destroyed) fail('LSP_NOT_STARTED', 'LSP server is not started');
    child.stdin.write(encodeFrame(value));
  }

  // Notifications get the same frame-size check as requests; a frame
  // that fails the check is never written, and callers must not update
  // local state after this throws.
  function sendNotification(value) {
    const frame = encodeFrame(value);
    if (frame.length > maxFrameBytes) fail('LSP_FRAME_LIMIT', 'LSP frame exceeded the configured limit');
    send(value);
  }

  function sendResponse(id, result, error) {
    try { send(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result: result ?? null }); } catch {}
  }

  // Returns the frozen sanitized records, or null when the frame is
  // malformed or out of root. A null return means "discarded": the
  // caller must not forward the raw frame anywhere, or the screening
  // above would be bypassed for onNotification consumers.
  function handlePublishDiagnostics(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params) || typeof params.uri !== 'string' || !Array.isArray(params.diagnostics)) return null;
    try { resolveLspUri(params.uri, rootPath); } catch { return null; } // Out-of-root diagnostics are discarded, never stored.
    const stored = [];
    for (const diagnostic of params.diagnostics) {
      if (stored.length >= maxDiagnosticsPerUri) break;
      const clean = sanitizeDiagnostic(diagnostic, maxDiagnosticMessageChars);
      if (clean) stored.push(clean);
    }
    const frozen = Object.freeze(stored);
    diagnostics.set(params.uri, frozen);
    return frozen;
  }

  function handleFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const entry = pending.get(String(frame.id));
      if (!entry) return;
      pending.delete(String(frame.id));
      clearTimeout(entry.timer);
      if (frame.error) entry.reject(new LspClientError('LSP_REMOTE_ERROR', 'LSP server returned an error response'));
      else entry.resolve(frame.result);
      return;
    }
    if (typeof frame.method === 'string' && frame.id !== undefined) {
      // Server-initiated requests are never auto-executed. workspace/
      // applyEdit is special-cased: only an explicit editProposalHandler
      // may see a normalized proposal, and even then the handler only
      // returns data -- it does not write anything. Without that handler
      // the answer is method-not-found, exactly as for any other
      // unhandled server request, so the server cannot drive the host
      // through this client.
      if (frame.method === 'workspace/applyEdit') {
        if (editProposalHandler) {
          let proposal;
          try {
            proposal = collectWorkspaceEditProposal(frame, { root: rootPath });
          } catch {
            sendResponse(frame.id, null, { code: -32602, message: 'Invalid params' });
            return;
          }
          // The handler only queues proposal data; this client never
          // writes a file, and this package contains no wiring that
          // turns a proposal into a Patch proposal, runs independent
          // approval, and lands it on disk. Approval-before-landing is
          // therefore a caller contract, not a connected chain in this
          // package, and must not be claimed as one. Whatever the
          // handler returns, the receipt to the server is
          // applied:false: forwarding a handler's applied:true would
          // tell the server the edit landed while the target file is
          // still untouched.
          Promise.resolve().then(() => editProposalHandler(proposal))
            .then(() => sendResponse(frame.id, { applied: false }))
            .catch(() => sendResponse(frame.id, null, { code: -32603, message: 'Internal error' }));
        } else {
          sendResponse(frame.id, null, { code: -32601, message: 'Method not found' });
        }
        return;
      }
      if (onServerRequest) {
        Promise.resolve().then(() => onServerRequest(frame)).then((result) => sendResponse(frame.id, result ?? null)).catch(() => sendResponse(frame.id, null, { code: -32603, message: 'Internal error' }));
      } else {
        sendResponse(frame.id, null, { code: -32601, message: 'Method not found' });
      }
      return;
    }
    if (typeof frame.method === 'string') {
      if (frame.method === 'textDocument/publishDiagnostics') {
        // onNotification receives the SANITIZED copy, never the raw
        // frame: forwarding the raw frame would hand unscreened
        // diagnostics (credential material, unbounded code/source,
        // non-allowlisted fields) straight to the callback.
        const sanitized = handlePublishDiagnostics(frame.params);
        if (sanitized !== null) onNotification?.({ ...frame, params: { uri: frame.params.uri, diagnostics: sanitized } });
        return;
      }
      onNotification?.(frame);
    }
  }

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buffer.length > 64 * 1024) failFrame(new LspClientError('LSP_FRAME_LIMIT', 'LSP header exceeded the configured limit'));
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > maxFrameBytes) { failFrame(new LspClientError('LSP_FRAME_LIMIT', 'LSP frame exceeded the configured limit')); return; }
      if (buffer.length < headerEnd + 4 + length) return;
      const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      buffer = buffer.subarray(headerEnd + 4 + length);
      let frame;
      try { frame = JSON.parse(body); } catch { continue; }
      handleFrame(frame);
    }
  }

  function failFrame(error) {
    buffer = Buffer.alloc(0);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    state = 'failed';
  }

  function onExit() {
    if (closing) return;
    state = 'failed';
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new LspClientError('LSP_SERVER_EXITED', 'LSP server exited unexpectedly')); }
    pending.clear();
  }

  async function start() {
    if (state === 'ready') return Object.freeze({ status: 'ready' });
    // Q30-4: no blanket parent-environment inheritance. The child gets
    // only the explicit base keys from the parent plus caller-validated
    // entries, so a stray parent secret (or a poisoned parent variable)
    // can never reach the server implicitly.
    const baseEnv = {};
    for (const key of LSP_BASE_ENV_KEYS) if (process.env[key] !== undefined) baseEnv[key] = process.env[key];
    child = spawn(serverCommand, serverArgs, { cwd: rootPath, shell: false, env: { ...baseEnv, ...serverEnv }, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onExit);
    state = 'starting';
    try {
      const initializeResult = await request('initialize', {
        processId: null,
        rootUri: `file://${rootPath}`,
        capabilities: { general: { positionEncodings: [...LSP_POSITION_ENCODINGS] } },
        workspaceFolders: [{ uri: `file://${rootPath}`, name: path.basename(rootPath) || 'workspace' }],
      });
      const negotiated = initializeResult?.capabilities?.positionEncoding;
      if (typeof negotiated === 'string' && LSP_POSITION_ENCODINGS.includes(negotiated)) positionEncoding = negotiated;
      send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      initialized = true;
      state = 'ready';
      return Object.freeze({ status: 'ready', capabilities: initializeResult?.capabilities ?? null });
    } catch (error) {
      await close().catch(() => {});
      state = 'failed';
      throw error;
    }
  }

  async function request(method, params = {}) {
    if (!allowed.has(method)) fail('LSP_METHOD_NOT_ALLOWED', 'LSP method is not in the read-only allowlist');
    if (method === 'initialize' && state !== 'starting') fail('LSP_STATE_INVALID', 'initialize is only valid during start');
    if (method !== 'initialize' && state !== 'ready' && !(method === 'shutdown' && initialized)) fail('LSP_NOT_STARTED', 'LSP client is not started');
    if (typeof params !== 'object' || params === null || Array.isArray(params)) fail('LSP_PARAMS_INVALID', 'LSP params must be an object');
    const id = nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (Buffer.byteLength(frame, 'utf8') > maxFrameBytes) fail('LSP_FRAME_LIMIT', 'LSP frame exceeded the configured limit');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(String(id)); reject(new LspClientError('LSP_REQUEST_TIMEOUT', 'LSP request timed out')); }, requestTimeoutMs);
      pending.set(String(id), { resolve, reject, timer });
      try { send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); pending.delete(String(id)); reject(error); }
    });
  }

  function didOpen(uri, languageId, text, version = 0) {
    resolveLspUri(uri, rootPath);
    if (typeof languageId !== 'string' || !languageId || languageId.length > 128) fail('LSP_DOCUMENT_INVALID', 'LSP document languageId is invalid');
    if (typeof text !== 'string') fail('LSP_DOCUMENT_INVALID', 'LSP document text must be a string');
    if (openDocuments.has(uri)) fail('LSP_DOCUMENT_ALREADY_OPEN', 'LSP document is already open');
    if (!Number.isSafeInteger(version) || version < 0) fail('LSP_DOCUMENT_VERSION_INVALID', 'LSP document version is invalid');
    if (Buffer.byteLength(text, 'utf8') > maxDocumentBytes) fail('LSP_DOCUMENT_LIMIT', 'LSP document exceeds the configured size limit');
    sendNotification({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId, version, text } } });
    openDocuments.set(uri, { uri, languageId, version, text });
  }

  function didChange(uri, changes, version) {
    resolveLspUri(uri, rootPath);
    const current = openDocuments.get(uri);
    if (!current) fail('LSP_DOCUMENT_NOT_OPEN', 'LSP document is not open');
    let nextText;
    let contentChanges;
    if (typeof changes === 'string') {
      nextText = changes;
      contentChanges = [{ text: changes }];
    } else if (Array.isArray(changes) && changes.length > 0) {
      // Caller ranges are counted in the negotiated encoding. Convert
      // them to UTF-16 for local application only; the notification
      // forwarded to the server keeps the negotiated units untouched.
      // Conversion throws before any send or state update on a
      // mid-code-point position, so local text can never drift ahead
      // of what the server was told.
      let utf16Changes = changes;
      if (positionEncoding !== 'utf-16') {
        let working = current.text;
        utf16Changes = changes.map((change) => {
          const starts = computeLineStarts(working);
          const convert = (position) => {
            if (!isPosition(position) || position.line >= starts.length) fail('LSP_DOCUMENT_INVALID', 'LSP document change position is out of range');
            const lineStart = starts[position.line];
            const lineEnd = position.line + 1 < starts.length ? starts[position.line + 1] : working.length;
            let lineText = working.slice(lineStart, lineEnd);
            if (lineText.endsWith('\r\n')) lineText = lineText.slice(0, -2);
            else if (lineText.endsWith('\n') || lineText.endsWith('\r')) lineText = lineText.slice(0, -1);
            return { line: position.line, character: convertLspPositionToUtf16(lineText, position.character, positionEncoding) };
          };
          const converted = { range: { start: convert(change.range.start), end: convert(change.range.end) }, text: change.text };
          // Advance the working text so multi-change batches convert
          // each range against the document its predecessor produced.
          working = applyIncrementalChanges(working, [converted]);
          return converted;
        });
      }
      nextText = applyIncrementalChanges(current.text, utf16Changes);
      contentChanges = changes.map((change) => ({ range: copyRange(change.range), text: change.text }));
    } else {
      fail('LSP_DOCUMENT_INVALID', 'LSP document changes must be a full string or a non-empty array of incremental changes');
    }
    const nextVersion = version === undefined ? current.version + 1 : version;
    if (!Number.isSafeInteger(nextVersion) || nextVersion <= current.version) fail('LSP_DOCUMENT_VERSION_INVALID', 'LSP document version must strictly increase');
    if (Buffer.byteLength(nextText, 'utf8') > maxDocumentBytes) fail('LSP_DOCUMENT_LIMIT', 'LSP document exceeds the configured size limit');
    sendNotification({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: nextVersion }, contentChanges } });
    openDocuments.set(uri, { uri, languageId: current.languageId, version: nextVersion, text: nextText });
  }

  function didClose(uri) {
    resolveLspUri(uri, rootPath);
    if (!openDocuments.has(uri)) fail('LSP_DOCUMENT_NOT_OPEN', 'LSP document is not open');
    sendNotification({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } });
    openDocuments.delete(uri);
  }

  function getOpenDocument(uri) {
    resolveLspUri(uri, rootPath);
    const doc = openDocuments.get(uri);
    return doc ? Object.freeze({ ...doc }) : null;
  }

  function listOpenDocuments() {
    return Object.freeze([...openDocuments.values()].map((doc) => Object.freeze({ ...doc })));
  }

  function getDiagnostics(uri) {
    resolveLspUri(uri, rootPath);
    const stored = diagnostics.get(uri);
    return stored ? Object.freeze([...stored]) : Object.freeze([]);
  }

  function getAllDiagnostics() {
    const out = {};
    for (const [uri, stored] of diagnostics) out[uri] = Object.freeze([...stored]);
    return Object.freeze(out);
  }

  async function shutdown() {
    if (state !== 'ready' && !initialized) return Object.freeze({ status: 'not-started' });
    try { await request('shutdown', {}); } catch {}
    send({ jsonrpc: '2.0', method: 'exit' });
    await close();
    return Object.freeze({ status: 'closed' });
  }

  async function close() {
    closing = true;
    const current = child;
    child = null;
    state = 'disconnected';
    openDocuments.clear();
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new LspClientError('LSP_CLOSED', 'LSP client was closed')); }
    pending.clear();
    if (current && !current.killed) {
      current.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(() => { try { current.kill('SIGKILL'); } catch {} resolve(); }, 2000);
        current.once('exit', () => { clearTimeout(timer); resolve(); });
      }).catch(() => {});
    }
  }

  return Object.freeze({
    start, request, shutdown, close,
    didOpen, didChange, didClose,
    getOpenDocument, listOpenDocuments,
    getDiagnostics, getAllDiagnostics,
    getState: () => state,
    getPositionEncoding: () => positionEncoding,
    getRoot: () => rootPath,
    getAllowedMethods: () => Object.freeze([...allowed]),
  });
}
