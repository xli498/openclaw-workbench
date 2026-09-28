import { createWorkspace } from './workspace.mjs';
import { redactText } from './redaction.mjs';

const STATUS_VALUES = new Set(['ready', 'unavailable', 'degraded', 'error', 'unknown']);
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SAFE_REVISION = /^(?:sha256:[A-Za-z0-9._:-]{1,128}|[a-f0-9]{40})$/i;
const SENSITIVE_LABEL = /(?:env|keychain):[A-Za-z_][A-Za-z0-9_]*/i;
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|private|var)\/)/;
const URL_VALUE = /[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const READY_STATES = new Set(['ready', 'healthy', 'connected', 'ok']);
const UNAVAILABLE_STATES = new Set(['unavailable', 'disabled', 'not_configured']);
const DEGRADED_STATES = new Set(['error', 'failed', 'degraded']);

function statusOf(value, fallback = 'unavailable') {
  if (!STATUS_VALUES.has(value?.status)) return fallback;
  return value.status === 'error' ? 'degraded' : value.status;
}

function codeOf(value, fallback = 'DIAGNOSTIC_UNAVAILABLE') {
  return typeof value?.code === 'string' && SAFE_CODE.test(value.code) ? value.code : fallback;
}

function unavailable(code = 'NOT_CONFIGURED') {
  return Object.freeze({ status: 'unavailable', code: SAFE_CODE.test(code) ? code : 'NOT_CONFIGURED' });
}

function safeLabel(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const raw = value.trim();
  if (SENSITIVE_LABEL.test(raw) || ABSOLUTE_PATH.test(raw) || URL_VALUE.test(raw) || /[\0\r\n]/.test(raw)) return fallback;
  const label = redactText(raw, 128);
  return label.length ? label : fallback;
}

function safeAuditValue(field, value) {
  if (typeof value !== 'string' || value.length > 256 || URL_VALUE.test(value) || ABSOLUTE_PATH.test(value) || SENSITIVE_LABEL.test(value) || /[\0\r\n]/.test(value)) return null;
  if (field === 'actionHash' && !/^[a-f0-9]{16,128}$/i.test(value)) return null;
  return redactText(value, 256);
}

function normalizeHealthStatus(value) {
  if (typeof value !== 'string') return 'unknown';
  const status = value.trim().toLowerCase();
  if (READY_STATES.has(status)) return 'ready';
  if (UNAVAILABLE_STATES.has(status)) return 'unavailable';
  if (DEGRADED_STATES.has(status)) return 'degraded';
  return 'unknown';
}

function normalizeOpenClaw(value) {
  if (statusOf(value) === 'ready' && typeof value?.version === 'string' && /^\d+(?:\.\d+){1,3}$/.test(value.version)) {
    return Object.freeze({ status: 'ready', version: value.version });
  }
  return unavailable(statusOf(value) === 'unavailable' ? codeOf(value) : 'DIAGNOSTIC_UNAVAILABLE');
}

function normalizeMcp(value) {
  const rawStatus = value?.status;
  if (rawStatus && rawStatus !== 'ready') return Object.freeze({ status: rawStatus === 'error' ? 'degraded' : statusOf(value), ...(value?.code ? { code: codeOf(value) } : {}) });
  const servers = Array.isArray(value?.servers) ? value.servers : [];
  const safeServers = servers.slice(0, 256).map((server, index) => Object.freeze({
    name: safeLabel(server?.name ?? server?.id, `server-${index + 1}`),
    status: normalizeHealthStatus(server?.status ?? server?.state),
  }));
  const status = safeServers.every((server) => server.status === 'ready') ? 'ready' : 'degraded';
  return Object.freeze({
    status,
    ...(value?.code && status !== 'ready' ? { code: codeOf(value) } : {}),
    ...(status === 'ready' ? { serverCount: Number.isSafeInteger(value?.serverCount) ? Math.max(0, value.serverCount) : safeServers.length, servers: safeServers } : {}),
  });
}

function normalizeMcpServers(value) {
  if (value && !Array.isArray(value) && value.status && value.status !== 'ready') return Object.freeze({ status: value.status === 'error' ? 'degraded' : statusOf(value), ...(value.code ? { code: codeOf(value) } : {}) });
  const servers = Array.isArray(value) ? value : Array.isArray(value?.servers) ? value.servers : [];
  const normalized = servers.slice(0, 256).map((server, index) => ({
    id: safeLabel(server?.id, `server-${index + 1}`),
    name: safeLabel(server?.name ?? server?.id, `server-${index + 1}`),
    enabled: server?.enabled === true,
    status: normalizeHealthStatus(server?.health?.status ?? server?.status),
  }));
  return Object.freeze({
    status: normalized.every((server) => server.status === 'ready') ? 'ready' : 'degraded',
    serverCount: servers.length,
    servers: Object.freeze(normalized.map((server) => Object.freeze(server))),
  });
}

function normalizeModels(value) {
  const profiles = Array.isArray(value) ? value : Array.isArray(value?.profiles) ? value.profiles : [];
  const profileDegraded = profiles.some((profile) => normalizeHealthStatus(profile?.health?.status ?? profile?.status) !== 'ready');
  const status = Array.isArray(value)
    ? (profileDegraded ? 'degraded' : 'ready')
    : (profileDegraded || statusOf(value, 'ready') === 'degraded' ? 'degraded' : statusOf(value, 'ready'));
  return Object.freeze({
    status,
    ...(value?.code && status !== 'ready' ? { code: codeOf(value) } : {}),
    profiles: Object.freeze(profiles.slice(0, 128).map((profile, index) => Object.freeze({
      id: safeLabel(profile?.id, `model-${index + 1}`),
      enabled: profile?.enabled === true,
      status: normalizeHealthStatus(profile?.health?.status ?? profile?.status),
    }))),
  });
}

function normalizeAudit(value) {
  if (value && !Array.isArray(value) && value.status && value.status !== 'ready') return unavailable(value.code);
  const events = Array.isArray(value) ? value : Array.isArray(value?.events) ? value.events : [];
  const fields = ['id', 'timestamp', 'type', 'actor', 'sessionId', 'actionId', 'actionHash', 'transactionId', 'serverId', 'profileId', 'operation', 'status', 'code', 'state'];
  return Object.freeze({
    status: 'ready',
    events: Object.freeze(events.slice(-100).map((event) => Object.freeze(Object.fromEntries(fields.flatMap((field) => { const safe = safeAuditValue(field, event?.[field]); return safe === null ? [] : [[field, safe]]; }))))),
  });
}

function safeGeneratedAt(value) {
  if (typeof value !== 'string' || value.length > 128) return new Date(0).toISOString();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString();
}

export function normalizeDiagnostics(value) {
  const input = value && typeof value === 'object' ? value : {};
  const openclaw = Object.prototype.hasOwnProperty.call(input, 'openclaw') ? normalizeOpenClaw(input.openclaw) : unavailable('DIAGNOSTIC_UNAVAILABLE');
  const mcp = Object.prototype.hasOwnProperty.call(input, 'mcp') ? normalizeMcp(input.mcp) : unavailable('DIAGNOSTIC_UNAVAILABLE');
  const models = Object.prototype.hasOwnProperty.call(input, 'models') ? normalizeModels(input.models) : unavailable('NOT_CONFIGURED');
  const workspaceRaw = input.workspace;
  const workspace = workspaceRaw?.status === 'ready'
    ? Object.freeze({ status: 'ready', workspaceRevision: typeof workspaceRaw.workspaceRevision === 'string' && SAFE_REVISION.test(workspaceRaw.workspaceRevision) ? workspaceRaw.workspaceRevision : null, ...(typeof workspaceRaw.gitRevision === 'string' && /^[a-f0-9]{40}$/i.test(workspaceRaw.gitRevision) ? { gitRevision: workspaceRaw.gitRevision } : {}) })
    : unavailable(workspaceRaw?.code);
  const audit = Object.prototype.hasOwnProperty.call(input, 'audit')
    ? (input.audit?.status === 'unavailable' ? unavailable(input.audit.code) : normalizeAudit(input.audit))
    : unavailable('NOT_CONFIGURED');
  const components = [openclaw, mcp, models, workspace, audit];
  return Object.freeze({
    status: components.every((component) => component.status === 'ready') ? 'ready' : 'degraded',
    generatedAt: safeGeneratedAt(input.generatedAt),
    openclaw,
    mcp,
    models,
    workspace,
    audit,
  });
}

async function safeCall(callback, fallback) {
  if (typeof callback !== 'function') return fallback;
  try { return await callback(); }
  catch { return unavailable('DIAGNOSTIC_UNAVAILABLE'); }
}

export async function collectDiagnostics({ root, openclaw, mcp, mcpServers, models, workspace, audit, now = () => new Date() } = {}) {
  const workspaceProbe = workspace ?? (root ? async () => {
    const current = await createWorkspace(root);
    return { status: 'ready', workspaceRevision: await current.workspaceRevision(), gitRevision: await current.gitRevision() };
  } : undefined);
  const [openclawRaw, mcpRaw, modelRaw, workspaceRaw, auditRaw, mcpServersRaw] = await Promise.all([
    safeCall(openclaw, unavailable()),
    safeCall(mcp, unavailable()),
    safeCall(models, unavailable('NOT_CONFIGURED')),
    safeCall(workspaceProbe, unavailable('NOT_CONFIGURED')),
    safeCall(audit ? () => audit.list() : undefined, unavailable('NOT_CONFIGURED')),
    typeof mcpServers === 'function' ? safeCall(mcpServers, unavailable()) : Promise.resolve(undefined),
  ]);
  const mcpResult = typeof mcpServers === 'function'
    ? (mcpServersRaw?.status && mcpServersRaw.status !== 'ready' ? Object.freeze({ status: mcpServersRaw.status === 'error' ? 'degraded' : 'unavailable', code: codeOf(mcpServersRaw) }) : normalizeMcpServers(mcpServersRaw))
    : normalizeMcp(mcpRaw);
  const workspaceResult = workspaceRaw?.status === 'ready'
    ? Object.freeze({ status: 'ready', workspaceRevision: typeof workspaceRaw.workspaceRevision === 'string' && SAFE_REVISION.test(workspaceRaw.workspaceRevision) ? workspaceRaw.workspaceRevision : null, ...(typeof workspaceRaw.gitRevision === 'string' && /^[a-f0-9]{40}$/i.test(workspaceRaw.gitRevision) ? { gitRevision: workspaceRaw.gitRevision } : {}) })
    : unavailable(workspaceRaw?.code);
  const auditResult = auditRaw?.status === 'unavailable' ? unavailable(auditRaw.code) : normalizeAudit(auditRaw);
  const components = [normalizeOpenClaw(openclawRaw), mcpResult, normalizeModels(modelRaw), workspaceResult, auditResult];
  const status = components.every((component) => component.status === 'ready') ? 'ready' : 'degraded';
  let generatedAt;
  try { generatedAt = new Date(now()).toISOString(); } catch { generatedAt = new Date(0).toISOString(); }
  return Object.freeze({ status, generatedAt, openclaw: components[0], mcp: components[1], models: components[2], workspace: components[3], audit: components[4] });
}

export { normalizeAudit, normalizeMcp, normalizeModels };
