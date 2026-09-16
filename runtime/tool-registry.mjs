import { createWorkspace, WorkspaceError, isInternalWorkspacePath, isSensitiveWorkspacePath } from './workspace.mjs';
import { createCodeToolProposal } from './code-tools.mjs';
import { redactText, redactValue, boundedJson } from './redaction.mjs';

const READ_TOOLS = Object.freeze([
  'workspace.list_directory',
  'workspace.find_files',
  'workspace.search_files',
  'workspace.read_files',
  'workspace.diagnostics',
  'workspace.progress',
]);
const WRITE_TOOLS = Object.freeze(['workspace.patch', 'workspace.command']);
const ALL_TOOLS = Object.freeze([...READ_TOOLS, ...WRITE_TOOLS]);
const MAX_PATH_LENGTH = 1_024;
const MAX_PATTERN_LENGTH = 256;
const MAX_QUERY_LENGTH = 256;
const MAX_FILES_PER_READ = 32;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_SEARCH_FILE_BYTES = 128 * 1024;
const MAX_SEARCH_SCAN_FILES = 512;
const MAX_SEARCH_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_RESULTS = 100;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 512;
const MAX_DEPTH = 16;

// Keep the pre-loop workspace names usable while the model-facing catalog uses
// the canonical names. The resolver is shared by the compatibility facade and
// the live registry so an allowlisted alias cannot fail at dispatch time.
export const LEGACY_TO_CANONICAL = Object.freeze({
  'workspace.list_files': 'workspace.list_directory',
  'workspace.read_file': 'workspace.read_files',
  'workspace.search': 'workspace.search_files',
});

export function canonicalToolName(name) {
  return LEGACY_TO_CANONICAL[name] ?? name;
}

function normalizeAliasInput(name, input) {
  if (name === 'workspace.read_file') return plainObject(input) ? { paths: [input.path] } : input;
  return input;
}

function legacyResult(name, input, result) {
  if (name === 'workspace.read_file') {
    return { path: result.files[0].path, content: result.files[0].content };
  }
  if (name === 'workspace.list_files') {
    const scope = typeof input.path === 'string' ? input.path.replaceAll('\\', '/').replace(/\/$/, '') : '';
    const files = scope && scope !== '.' && !result.entries.some((entry) => entry.path === scope)
      ? [{ path: scope, type: 'directory' }, ...result.entries]
      : result.entries;
    return { files };
  }
  return result;
}

export class ToolRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ToolRegistryError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) { throw new ToolRegistryError(code, message, details); }

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizePath(value, { allowDot = true } = {}) {
  if (value === undefined && allowDot) return '.';
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(value)) fail('TOOL_INPUT_INVALID', 'path is invalid');
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  if (!normalized && allowDot) return '.';
  if (normalized === '.' && allowDot) return '.';
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some((part) => part === '..')) fail('TOOL_INPUT_INVALID', 'path is invalid');
  if (process.platform === 'win32' && normalized.includes(':')) fail('TOOL_INPUT_INVALID', 'path contains a forbidden Windows stream or device prefix');
  if (isInternalWorkspacePath(normalized) || isSensitiveWorkspacePath(normalized)) fail('TOOL_INPUT_INVALID', 'path is not available to workspace tools');
  return normalized.replace(/\/$/, '') || (allowDot ? '.' : fail('TOOL_INPUT_INVALID', 'path is invalid'));
}

function normalizePattern(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATTERN_LENGTH || /[\0\r\n]/.test(value)) fail('TOOL_INPUT_INVALID', 'pattern is invalid');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some((part) => part === '..') || (process.platform === 'win32' && normalized.includes(':'))) fail('TOOL_INPUT_INVALID', 'pattern is invalid');
  return normalized;
}

function globRegex(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') { source += '.*'; index += 1; }
      else source += '.*';
    } else if (char === '?') source += '.';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 'i');
}

function normalizeLimit(value, fallback, maximum, name) {
  const limit = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) fail('TOOL_INPUT_INVALID', `${name} is out of range`);
  return limit;
}

function normalizeDepth(value, fallback) {
  const depth = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > MAX_DEPTH) fail('TOOL_INPUT_INVALID', 'maxDepth is out of range');
  return depth;
}

function flatten(nodes, output = []) {
  for (const node of nodes) {
    output.push({ path: String(node.path).replaceAll('\\', '/'), type: node.type, ...(Number.isSafeInteger(node.size) ? { size: node.size } : {}) });
    if (Array.isArray(node.children)) flatten(node.children, output);
  }
  return output;
}

function bounded(value) {
  const safe = redactValue(value, { maxStringLength: MAX_TOOL_RESULT_BYTES });
  try { boundedJson(safe, MAX_TOOL_RESULT_BYTES, 'TOOL_RESULT_LIMIT'); }
  catch (error) { throw new ToolRegistryError('TOOL_RESULT_LIMIT', 'tool result exceeded the configured limit'); }
  return Object.freeze(safe);
}

function publicProposal(proposal) {
  return {
    ...proposal,
    status: proposal?.action?.status,
    action: proposal?.action,
    ...(proposal?.command ? { command: proposal.command } : {}),
    ...(proposal?.parsedPatch ? { parsedPatch: proposal.parsedPatch } : {}),
    ...(proposal?.workspaceRevision ? { workspaceRevision: proposal.workspaceRevision } : {}),
    ...(proposal?.policy ? { policy: proposal.policy } : {}),
    ...(proposal?.commandPolicy ? { commandPolicy: proposal.commandPolicy } : {}),
  };
}

function callArguments(first, second) {
  if (typeof first === 'string') return { name: first, input: second ?? {}, mode: 'Ask', sessionId: undefined };
  if (!plainObject(first)) fail('TOOL_INPUT_INVALID', 'tool call must be an object');
  return { mode: first.mode ?? 'Ask', name: first.name, input: first.input ?? {}, sessionId: first.sessionId, signal: first.signal };
}

export function createToolRegistry({ root, audit, onProposal, progressProvider } = {}) {
  if (!root) throw new ToolRegistryError('ROOT_REQUIRED', 'root is required');
  const workspacePromise = createWorkspace(root, { maxRevisionBytes: 16 * 1024 * 1024, maxRevisionEntries: 20_000 });
  const progress = new Map();

  function names({ mode = 'Ask' } = {}) {
    if (mode === 'Code') return ALL_TOOLS;
    if (mode === 'Ask' || mode === 'Plan') return READ_TOOLS;
    return Object.freeze([]);
  }

  const definitionsByName = Object.freeze({
    'workspace.list_directory': { type: 'function', function: { name: 'workspace.list_directory', description: 'List bounded non-sensitive workspace entries', parameters: { type: 'object', properties: { path: { type: 'string' }, maxEntries: { type: 'integer', minimum: 1, maximum: MAX_LIST_ENTRIES }, maxDepth: { type: 'integer', minimum: 0, maximum: MAX_DEPTH } }, additionalProperties: false } } },
    'workspace.find_files': { type: 'function', function: { name: 'workspace.find_files', description: 'Find non-sensitive files by a bounded glob pattern', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: MAX_RESULTS } }, required: ['pattern'], additionalProperties: false } } },
    'workspace.search_files': { type: 'function', function: { name: 'workspace.search_files', description: 'Search bounded text in non-sensitive workspace files', parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' }, pattern: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: MAX_RESULTS } }, required: ['query'], additionalProperties: false } } },
    'workspace.read_files': { type: 'function', function: { name: 'workspace.read_files', description: 'Read a bounded set of non-sensitive workspace files', parameters: { type: 'object', properties: { paths: { type: 'array', minItems: 1, maxItems: MAX_FILES_PER_READ, items: { type: 'string' } } }, required: ['paths'], additionalProperties: false } } },
    'workspace.diagnostics': { type: 'function', function: { name: 'workspace.diagnostics', description: 'Return bounded local workspace diagnostics', parameters: { type: 'object', additionalProperties: false } } },
    'workspace.progress': { type: 'function', function: { name: 'workspace.progress', description: 'Read safe progress state for this session', parameters: { type: 'object', properties: { sessionId: { type: 'string' } }, additionalProperties: false } } },
    'workspace.patch': { type: 'function', function: { name: 'workspace.patch', description: 'Create an approval-required patch proposal; never applies it', parameters: { type: 'object', properties: { patch: { type: 'string', maxLength: 128000 }, declaredPaths: { type: 'array', maxItems: 128, items: { type: 'string' } } }, required: ['patch', 'declaredPaths'], additionalProperties: false } } },
    'workspace.command': { type: 'function', function: { name: 'workspace.command', description: 'Create an approval-required command proposal; never executes it', parameters: { type: 'object', properties: { argv: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string' } }, cwd: { type: 'string' }, timeoutMs: { type: 'integer' }, maxOutputBytes: { type: 'integer' } }, required: ['argv'], additionalProperties: false } } },
  });

  function definitions({ mode = 'Ask' } = {}) {
    return Object.freeze(names({ mode }).filter((name) => definitionsByName[name]).map((name) => definitionsByName[name]));
  }

  async function call(first, second) {
    const { mode, name, input: rawInput, sessionId, signal } = callArguments(first, second);
    const canonicalName = canonicalToolName(name);
    const input = normalizeAliasInput(name, rawInput);
    if (!ALL_TOOLS.includes(canonicalName)) fail('TOOL_NOT_ALLOWED', 'tool is not allowlisted');
    if (!names({ mode }).includes(canonicalName)) fail('TOOL_MODE_DENIED', 'tool is not available in this mode');
    if (!plainObject(input)) fail('TOOL_INPUT_INVALID', 'tool input must be an object');
    if (signal?.aborted) fail('TOOL_ABORTED', 'tool call was cancelled');
    const workspace = await workspacePromise;
    try {
      let result;
      if (canonicalName === 'workspace.list_directory') {
        const scope = normalizePath(input.path);
        const tree = await workspace.tree({ maxEntries: normalizeLimit(input.maxEntries, MAX_LIST_ENTRIES, MAX_LIST_ENTRIES, 'maxEntries'), maxDepth: normalizeDepth(input.maxDepth, 8) });
        const entries = flatten(tree).filter((entry) => scope === '.' || entry.path === scope || entry.path.startsWith(`${scope}/`));
        result = { entries: entries.filter((entry) => scope === '.' || entry.path !== scope).slice(0, MAX_LIST_ENTRIES) };
      } else if (canonicalName === 'workspace.find_files') {
        const pattern = normalizePattern(input.pattern);
        const scope = normalizePath(input.path);
        const matcher = globRegex(pattern);
        const tree = await workspace.tree({ maxEntries: 10_000, maxDepth: MAX_DEPTH });
        const files = flatten(tree).filter((entry) => entry.type === 'file' && (scope === '.' || entry.path === scope || entry.path.startsWith(`${scope}/`)) && matcher.test(entry.path)).slice(0, normalizeLimit(input.maxResults, MAX_RESULTS, MAX_RESULTS, 'maxResults')).map((entry) => entry.path);
        result = { files };
      } else if (canonicalName === 'workspace.search_files') {
        if (typeof input.query !== 'string' || !input.query || input.query.length > MAX_QUERY_LENGTH || /[\0\r\n]/.test(input.query)) fail('TOOL_INPUT_INVALID', 'query is invalid');
        const scope = normalizePath(input.path);
        const matcher = input.pattern === undefined ? null : globRegex(normalizePattern(input.pattern));
        const maxResults = normalizeLimit(input.maxResults, MAX_RESULTS, MAX_RESULTS, 'maxResults');
        const tree = await workspace.tree({ maxEntries: 10_000, maxDepth: MAX_DEPTH });
        const matches = [];
        let scannedFiles = 0;
        let scannedBytes = 0;
        for (const entry of flatten(tree)) {
          if (signal?.aborted) fail('TOOL_ABORTED', 'tool call was cancelled');
          if (entry.type !== 'file' || matches.length >= maxResults || scannedFiles >= MAX_SEARCH_SCAN_FILES || scannedBytes >= MAX_SEARCH_SCAN_BYTES || (scope !== '.' && entry.path !== scope && !entry.path.startsWith(`${scope}/`)) || (matcher && !matcher.test(entry.path))) continue;
          scannedFiles += 1;
          if (Number.isSafeInteger(entry.size)) {
            if (entry.size > MAX_SEARCH_FILE_BYTES || scannedBytes + entry.size > MAX_SEARCH_SCAN_BYTES) continue;
            scannedBytes += entry.size;
          }
          try {
            const content = await workspace.read(entry.path, { maxBytes: MAX_SEARCH_FILE_BYTES });
            if (!Number.isSafeInteger(entry.size)) scannedBytes += Buffer.byteLength(content, 'utf8');
            const index = content.indexOf(input.query);
            if (index >= 0) matches.push({ path: entry.path, snippets: [redactText(content.slice(Math.max(0, index - 80), index + input.query.length + 80))] });
          } catch (error) { if (error?.code === 'TOOL_ABORTED') throw error; }
        }
        result = { matches, ...(scannedFiles >= MAX_SEARCH_SCAN_FILES || scannedBytes >= MAX_SEARCH_SCAN_BYTES ? { truncated: true } : {}) };
      } else if (canonicalName === 'workspace.read_files') {
        if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > MAX_FILES_PER_READ) fail('TOOL_INPUT_INVALID', 'paths is invalid');
        const paths = input.paths.map((value) => normalizePath(value, { allowDot: false }));
        const files = [];
        let totalBytes = 0;
        for (const relativePath of paths) {
          if (signal?.aborted) fail('TOOL_ABORTED', 'tool call was cancelled');
          const content = await workspace.read(relativePath, { maxBytes: MAX_FILE_BYTES });
          totalBytes += Buffer.byteLength(content, 'utf8');
          if (totalBytes > MAX_TOOL_RESULT_BYTES) throw new WorkspaceError('READ_LIMIT', 'combined file results exceed the configured limit');
          files.push({ path: relativePath, content: redactText(content, MAX_FILE_BYTES) });
        }
        result = { files };
      } else if (canonicalName === 'workspace.diagnostics') {
        const [workspaceRevision, gitRevision] = await Promise.all([workspace.workspaceRevision(), workspace.gitRevision()]);
        result = { workspaceRevision, gitRevision, status: 'ready', capabilities: { read: true, patch: 'approval_required', command: 'approval_required' } };
      } else if (canonicalName === 'workspace.progress') {
        const key = typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : sessionId;
        const provided = typeof progressProvider === 'function' ? await progressProvider({ sessionId: key }) : progress.get(key) ?? { status: 'idle' };
        result = { sessionId: typeof key === 'string' ? key : null, status: typeof provided?.status === 'string' ? redactText(provided.status, 64) : 'idle', ...(typeof provided?.message === 'string' ? { message: redactText(provided.message, 512) } : {}) };
      } else {
        if (typeof sessionId !== 'string' || !sessionId) fail('SESSION_REQUIRED', 'sessionId is required for mutation proposals');
        const proposal = await createCodeToolProposal({ mode, tool: canonicalName === 'workspace.patch' ? 'patch' : 'command', input: { ...input, sessionId }, root, audit });
        if (typeof onProposal === 'function') await onProposal(proposal);
        result = { approvalRequired: true, proposal: publicProposal(proposal) };
      }
      return bounded(legacyResult(name, rawInput, result));
    } catch (error) {
      if (error instanceof ToolRegistryError) throw error;
      if (error instanceof WorkspaceError) {
        const inputCodes = new Set(['INVALID_PATH', 'PATH_ESCAPE', 'SENSITIVE_PATH', 'INTERNAL_PATH', 'SYMLINK_ESCAPE', 'NOT_A_FILE', 'READ_RACE']);
        const outputCodes = new Set(['READ_LIMIT', 'TREE_LIMIT', 'REVISION_LIMIT']);
        if (inputCodes.has(error.code)) throw new ToolRegistryError('TOOL_INPUT_INVALID', 'tool path is not available');
        if (outputCodes.has(error.code)) throw new ToolRegistryError('TOOL_RESULT_LIMIT', 'tool result exceeded the configured limit');
        throw new ToolRegistryError('TOOL_EXECUTION_FAILED', 'tool execution failed');
      }
      throw error;
    }
  }

  return Object.freeze({ names, definitions, call, setProgress(sessionId, state) { if (typeof sessionId === 'string' && sessionId) progress.set(sessionId, redactValue(state)); } });
}

export { READ_TOOLS, WRITE_TOOLS, ALL_TOOLS };
