import { createMcpHttpTransport } from './mcp-http-transport.mjs';
import { createMcpStdioTransport } from './mcp-transport.mjs';

export class McpRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'McpRuntimeError';
    this.code = code;
    this.details = details;
  }
}

function requireApproval(approved) {
  if (approved !== true) throw new McpRuntimeError('MCP_APPROVAL_REQUIRED', 'explicit MCP approval is required');
}

function requireHash(expectedConfigHash, server) {
  if (typeof expectedConfigHash !== 'string' || expectedConfigHash !== server.configHash) throw new McpRuntimeError('MCP_CONFLICT', 'MCP server configuration changed');
}

function validateToolInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new McpRuntimeError('MCP_TOOL_INPUT_INVALID', 'MCP tool input must be an object');
  let encoded;
  try { encoded = JSON.stringify(input); } catch { throw new McpRuntimeError('MCP_TOOL_INPUT_INVALID', 'MCP tool input must be JSON serializable'); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 256 * 1024) throw new McpRuntimeError('MCP_TOOL_INPUT_INVALID', 'MCP tool input is too large');
}

function publicInstance(instance) {
  return Object.freeze({ id: instance.id, transport: instance.transportKind, state: instance.state });
}

export function createMcpServerRuntime({ registry, transportFactory, stdioOptions = {}, httpOptions = {} } = {}) {
  if (!registry || typeof registry.get !== 'function') throw new McpRuntimeError('MCP_REGISTRY_REQUIRED', 'MCP registry is required');
  if (transportFactory !== undefined && typeof transportFactory !== 'function') throw new McpRuntimeError('MCP_FACTORY_INVALID', 'MCP transport factory is invalid');
  const instances = new Map();

  function getServer(id) {
    const server = registry.get(id);
    if (!server) throw new McpRuntimeError('MCP_NOT_FOUND', 'MCP server not found');
    return server;
  }

  function makeTransport(server) {
    if (transportFactory) return transportFactory(server);
    if (server.transport === 'stdio') return createMcpStdioTransport({ ...stdioOptions, command: server.command, args: server.args, env: {} });
    return createMcpHttpTransport({ ...httpOptions, endpoint: server.endpoint, transport: server.transport });
  }

  async function start(id, { expectedConfigHash, approved = false } = {}) {
    requireApproval(approved);
    const server = getServer(id);
    requireHash(expectedConfigHash, server);
    if (server.enabled !== true) throw new McpRuntimeError('MCP_SERVER_DISABLED', 'MCP server is disabled');
    const existing = instances.get(id);
    if (existing) {
      if (existing.configHash !== server.configHash) throw new McpRuntimeError('MCP_CONFLICT', 'MCP server configuration changed');
      return existing.startPromise ?? publicInstance(existing);
    }
    const instance = { id: server.id, transportKind: server.transport, configHash: server.configHash, state: 'starting', client: makeTransport(server), closed: false, closePromise: null, startPromise: null };
    instance.closeOnce = async () => {
      if (!instance.closePromise) instance.closePromise = Promise.resolve().then(() => instance.client.close());
      return instance.closePromise;
    };
    instances.set(id, instance);
    instance.startPromise = Promise.resolve().then(() => instance.client.start()).then(() => {
      if (instance.closed || instances.get(id) !== instance) throw new McpRuntimeError('MCP_RUNTIME_CLOSED', 'MCP runtime was stopped during start');
      instance.state = 'ready';
      return publicInstance(instance);
    }).catch(async (error) => {
      if (instance.closed || instances.get(id) !== instance) await instance.closeOnce();
      if (instances.get(id) === instance) instances.delete(id);
      throw error instanceof McpRuntimeError ? error : new McpRuntimeError('MCP_START_FAILED', 'MCP server could not be started');
    });
    return instance.startPromise;
  }

  async function stop(id) {
    const instance = instances.get(id);
    if (!instance) throw new McpRuntimeError('MCP_NOT_RUNNING', 'MCP server is not running');
    instance.closed = true;
    instances.delete(id);
    await instance.closeOnce();
    return Object.freeze({ id, state: 'stopped' });
  }

  async function callTool(id, tool, input = {}, { expectedConfigHash, approved = false } = {}) {
    const instance = instances.get(id);
    if (!instance || instance.state !== 'ready') throw new McpRuntimeError('MCP_NOT_RUNNING', 'MCP server is not running');
    requireApproval(approved);
    const server = getServer(id);
    requireHash(expectedConfigHash, server);
    if (instance.configHash !== server.configHash) throw new McpRuntimeError('MCP_CONFLICT', 'MCP server configuration changed after start');
    if (server.enabled !== true) throw new McpRuntimeError('MCP_SERVER_DISABLED', 'MCP server is disabled');
    if (typeof tool !== 'string' || !tool || !server.tools.includes(tool)) throw new McpRuntimeError('MCP_TOOL_NOT_AUTHORIZED', 'MCP tool is not authorized');
    validateToolInput(input);
    try {
      return await instance.client.request('tools/call', { name: tool, arguments: input });
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code.startsWith('MCP_') ? error.code : 'MCP_REQUEST_FAILED';
      const message = code === 'MCP_REQUEST_TIMEOUT' ? 'MCP request timed out' : code === 'MCP_REQUEST_ABORTED' ? 'MCP request was cancelled' : 'MCP request failed';
      throw new McpRuntimeError(code, message);
    }
  }

  async function close() {
    const current = [...instances.values()];
    instances.clear();
    for (const instance of current) { instance.closed = true; await instance.closeOnce(); }
  }

  return Object.freeze({ start, stop, callTool, close, status: () => Object.freeze([...instances.values()].map(publicInstance)) });
}
