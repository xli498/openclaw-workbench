import { join } from 'node:path';
import { snapshotDigest, readSnapshot, writeSnapshotAtomically } from './snapshot-store.mjs';

const VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SHELL_PATTERN = /[;&|<>`$()\r\n]/;
const SECRET_PATTERN = /(?:bearer|token|password|secret|api[_ -]?key)\s*[:=]|:\/\/[^/\s:]+:[^@\s]+@/i;
const SECRET_FLAG_PATTERN = /(?:^|\s)(?:--?|\/)(?:token|password|secret|api[-_ ]?key)(?:\s|=|$)/i;

function sensitiveQueryKey(key) {
  const normalized = String(key).toLowerCase().replace(/-/g, '_');
  return /(?:token|secret|password|passwd|auth|bearer|api_key|apikey|accesskey|clientsecret|key)/.test(normalized);
}

export class McpRegistryError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'McpRegistryError'; this.code = code; this.details = details; }
}

function fail(code, message) { throw new McpRegistryError(code, message); }

function stringField(value, field, max, code = 'MCP_INPUT_INVALID') {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) fail(code, `${field} is invalid`);
  return value.trim();
}

function safeCommand(value) {
  const command = stringField(value, 'command', 512, 'MCP_COMMAND_INVALID');
  if (SHELL_PATTERN.test(command) || SECRET_PATTERN.test(command) || SECRET_FLAG_PATTERN.test(command)) fail('MCP_COMMAND_INVALID', 'command contains unsafe shell or credential material');
  return command;
}

function safeArgs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) fail('MCP_ARGS_INVALID', 'args must be an array of at most 64 strings');
  return value.map((item) => {
    const arg = stringField(item, 'arg', 512, 'MCP_ARGS_INVALID');
    if (SHELL_PATTERN.test(arg) || SECRET_PATTERN.test(arg) || SECRET_FLAG_PATTERN.test(arg)) fail('MCP_ARGS_INVALID', 'args contain unsafe shell or credential material');
    return arg;
  });
}

function safeTools(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256 || value.some((item) => typeof item !== 'string' || !TOOL_PATTERN.test(item))) fail('MCP_TOOLS_INVALID', 'tools must be unique valid tool names');
  const tools = [...value];
  if (new Set(tools).size !== tools.length) fail('MCP_TOOLS_INVALID', 'tools must be unique');
  return tools;
}

function safeEnvKeys(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128 || value.some((item) => typeof item !== 'string' || !ENV_PATTERN.test(item))) fail('MCP_ENV_KEY_INVALID', 'envKeys must contain names only, never values');
  const keys = [...value];
  if (new Set(keys).size !== keys.length) fail('MCP_ENV_KEY_INVALID', 'envKeys must be unique');
  return keys;
}

function safePermissions(value) {
  const permissions = value ?? {};
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions) || Object.keys(permissions).some((key) => !['filesystem', 'network'].includes(key)) || ![permissions.filesystem, permissions.network].every((item) => item === undefined || typeof item === 'boolean')) fail('MCP_PERMISSIONS_INVALID', 'permissions must contain boolean filesystem/network flags');
  return { filesystem: permissions.filesystem === true, network: permissions.network === true };
}

function safeEndpoint(value) {
  if (value === undefined) return null;
  const endpoint = stringField(value, 'endpoint', 2048, 'MCP_ENDPOINT_INVALID');
  let parsed;
  try { parsed = new URL(endpoint); } catch { fail('MCP_ENDPOINT_INVALID', 'endpoint must be an http(s) URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || [...parsed.searchParams.keys()].some(sensitiveQueryKey)) fail('MCP_ENDPOINT_INVALID', 'endpoint must be an http(s) URL without credentials or secret query parameters');
  return parsed.toString();
}

function contentForHash(server) {
  const { configHash: _hash, health: _health, ...config } = server;
  return config;
}

function withHash(server) {
  const configHash = snapshotDigest(JSON.stringify(contentForHash(server)));
  return Object.freeze({ ...server, configHash, health: Object.freeze(server.health ?? { status: 'unknown', checkedAt: null }) });
}

function publicServer(server) { return Object.freeze({ ...server, permissions: Object.freeze({ ...server.permissions }), envKeys: Object.freeze([...(server.envKeys ?? [])]), args: Object.freeze([...(server.args ?? [])]), tools: Object.freeze([...(server.tools ?? [])]), health: Object.freeze({ ...server.health }) }); }

export function normalizeMcpServer(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('MCP_INPUT_INVALID', 'server must be an object');
  const id = stringField(input.id, 'id', 64, 'MCP_ID_INVALID');
  if (!ID_PATTERN.test(id)) fail('MCP_ID_INVALID', 'id contains invalid characters');
  const name = stringField(input.name ?? id, 'name', 128, 'MCP_NAME_INVALID');
  const transport = input.transport ?? 'stdio';
  if (!['stdio', 'sse', 'streamable-http'].includes(transport)) fail('MCP_TRANSPORT_INVALID', 'unsupported MCP transport');
  const endpoint = safeEndpoint(input.endpoint);
  if (transport === 'stdio' && !input.command) fail('MCP_COMMAND_INVALID', 'stdio server requires command');
  if (transport !== 'stdio' && !endpoint) fail('MCP_ENDPOINT_INVALID', 'http server requires endpoint');
  if (transport === 'stdio' && endpoint) fail('MCP_ENDPOINT_INVALID', 'stdio server cannot define endpoint');
  const server = {
    id,
    name,
    transport,
    ...(transport === 'stdio' ? { command: safeCommand(input.command), args: safeArgs(input.args) } : { endpoint, args: [] }),
    envKeys: safeEnvKeys(input.envKeys),
    tools: safeTools(input.tools),
    permissions: safePermissions(input.permissions),
    enabled: false,
    health: { status: 'unknown', checkedAt: null },
  };
  return publicServer(withHash(server));
}

function restoreServer(value) {
  const normalized = normalizeMcpServer(value);
  if (typeof value.enabled !== 'boolean' || !value.health || typeof value.health.status !== 'string' || !['unknown', 'ready', 'unavailable', 'error'].includes(value.health.status)) fail('MCP_REGISTRY_INVALID', 'registry snapshot contains invalid server state');
  const restored = withHash({ ...normalized, enabled: value.enabled, health: { status: value.health.status, checkedAt: value.health.checkedAt ?? null } });
  if (value.configHash !== restored.configHash) fail('MCP_REGISTRY_INVALID', 'registry snapshot contains invalid server hash');
  return publicServer(restored);
}

export function createMcpRegistry({ root, storePath = join(root ?? '', '.openclaw-workbench', 'mcp-registry.json') } = {}) {
  if (!root) throw new McpRegistryError('ROOT_REQUIRED', 'root is required');
  const records = new Map();
  let persistedDigest = null;
  try {
    const stored = readSnapshot({ root, storePath, ErrorType: McpRegistryError, code: 'MCP_REGISTRY_INVALID', message: 'MCP registry snapshot is invalid' });
    if (stored.content !== null) {
      const snapshot = JSON.parse(stored.content);
      if (!snapshot || snapshot.version !== VERSION || !Array.isArray(snapshot.servers)) fail('MCP_REGISTRY_INVALID', 'MCP registry snapshot is invalid');
      for (const item of snapshot.servers) {
        const restored = restoreServer(item);
        if (records.has(restored.id)) fail('MCP_REGISTRY_INVALID', 'MCP registry contains duplicate IDs');
        records.set(restored.id, restored);
      }
      persistedDigest = stored.digest;
    }
  } catch (error) {
    if (error instanceof McpRegistryError) throw error;
    throw new McpRegistryError('MCP_REGISTRY_INVALID', 'MCP registry snapshot is invalid');
  }
  function persist() {
    const payload = JSON.stringify({ version: VERSION, servers: [...records.values()] });
    persistedDigest = writeSnapshotAtomically({ root, storePath, payload, expectedDigest: persistedDigest, ErrorType: McpRegistryError, code: 'MCP_REGISTRY_INVALID', message: 'MCP registry snapshot is invalid', busyCode: 'MCP_REGISTRY_BUSY', busyMessage: 'MCP registry is busy', conflictCode: 'MCP_REGISTRY_CONFLICT', conflictMessage: 'MCP registry changed outside this process', temporaryName: 'mcp-registry' });
  }
  function validate(input) { return normalizeMcpServer(input); }
  function register(input) {
    const server = validate(input);
    if (records.has(server.id)) throw new McpRegistryError('MCP_DUPLICATE', 'MCP server ID already exists');
    records.set(server.id, server);
    try { persist(); } catch (error) { records.delete(server.id); throw error; }
    return server;
  }
  function authorizeTools(id, tools, expectedConfigHash) {
    const current = records.get(id);
    if (!current) throw new McpRegistryError('MCP_NOT_FOUND', 'MCP server not found');
    if (current.configHash !== expectedConfigHash) throw new McpRegistryError('MCP_CONFLICT', 'MCP server changed before authorization');
    const next = publicServer(withHash({ ...current, tools: safeTools(tools) }));
    records.set(id, next);
    try { persist(); } catch (error) { records.set(id, current); throw error; }
    return next;
  }
  function updateHealth(id, health) {
    const current = records.get(id);
    if (!current) throw new McpRegistryError('MCP_NOT_FOUND', 'MCP server not found');
    const status = health?.status;
    if (!['unknown', 'ready', 'unavailable', 'error'].includes(status)) throw new McpRegistryError('MCP_HEALTH_INVALID', 'health status is invalid');
    const next = publicServer({ ...current, health: { status, checkedAt: typeof health.checkedAt === 'string' ? health.checkedAt : new Date().toISOString() } });
    records.set(id, next);
    try { persist(); } catch (error) { records.set(id, current); throw error; }
    return next;
  }
  function setEnabled(id, enabled, expectedConfigHash) {
    const current = records.get(id);
    if (!current) throw new McpRegistryError('MCP_NOT_FOUND', 'MCP server not found');
    if (current.configHash !== expectedConfigHash) throw new McpRegistryError('MCP_CONFLICT', 'MCP server changed before enable state update');
    if (typeof enabled !== 'boolean') throw new McpRegistryError('MCP_ENABLED_INVALID', 'enabled must be boolean');
    const next = publicServer(withHash({ ...current, enabled }));
    records.set(id, next);
    try { persist(); } catch (error) { records.set(id, current); throw error; }
    return next;
  }
  return Object.freeze({ validate, register, authorizeTools, updateHealth, setEnabled, get: (id) => records.has(id) ? publicServer(records.get(id)) : null, list: () => Object.freeze([...records.values()].map(publicServer)), snapshotPath: storePath });
}
