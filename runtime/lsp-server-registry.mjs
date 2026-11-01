import path from 'node:path';
import { LspClientError, validateLspCommand, validateLspArgs, validateLspEnv } from './lsp-client.mjs';

// Multi-language-server registry: configuration only. It never spawns a
// process, never writes a file, and never touches the network. It only
// records which validated command serves which languages under which
// workspace root, so a caller can pick a server entry and hand it to
// createLspClient. Command/args/env validation is reused from lsp-client
// (validateLspCommand / validateLspArgs / validateLspEnv), so shell
// metacharacters and credential material are refused here exactly as
// they are refused by the client.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(code, message) { throw new LspClientError(code, message); }

export function createLspServerRegistry({ root, servers } = {}) {
  if (typeof root !== 'string' || !root) fail('LSP_ROOT_INVALID', 'LSP workspace root is required');
  const workspaceRoot = path.resolve(root);
  const byId = new Map();

  function register(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('LSP_SERVER_INVALID', 'LSP server entry must be an object');
    const { id, languageIds, command, args, env, root: serverRoot } = entry;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) fail('LSP_SERVER_INVALID', 'LSP server id is invalid');
    if (byId.has(id)) fail('LSP_SERVER_DUPLICATE', 'LSP server id is already registered');
    if (!Array.isArray(languageIds) || languageIds.length === 0
      || languageIds.some((language) => typeof language !== 'string' || !language || language.length > 128)) {
      fail('LSP_SERVER_INVALID', 'LSP server languageIds must be a non-empty array of strings');
    }
    const safeCommand = validateLspCommand(command);
    const safeArguments = validateLspArgs(args);
    const safeEnvironment = validateLspEnv(env);
    // A relative explicit root resolves against the workspace root, not
    // the process cwd, so it cannot escape through the caller's cwd.
    let resolvedRoot = workspaceRoot;
    if (serverRoot !== undefined) {
      if (typeof serverRoot !== 'string' || !serverRoot) fail('LSP_SERVER_INVALID', 'LSP server root is invalid');
      resolvedRoot = path.resolve(workspaceRoot, serverRoot);
      if (resolvedRoot !== workspaceRoot && !resolvedRoot.startsWith(workspaceRoot + path.sep)) {
        fail('LSP_SERVER_ROOT_OUT_OF_ROOT', 'LSP server root is outside the workspace root');
      }
    }
    const stored = Object.freeze({
      id,
      languageIds: Object.freeze([...languageIds]),
      command: safeCommand,
      args: Object.freeze([...safeArguments]),
      env: Object.freeze({ ...safeEnvironment }),
      root: resolvedRoot,
    });
    byId.set(id, stored);
    return stored;
  }

  if (servers !== undefined) {
    if (!Array.isArray(servers)) fail('LSP_SERVER_INVALID', 'LSP servers must be an array');
    for (const entry of servers) register(entry);
  }

  return Object.freeze({
    register,
    get: (id) => byId.get(id) ?? null,
    list: () => Object.freeze([...byId.values()]),
    getForLanguage: (language) => Object.freeze([...byId.values()].filter((entry) => entry.languageIds.includes(language))),
    getWorkspaceRoot: () => workspaceRoot,
  });
}
