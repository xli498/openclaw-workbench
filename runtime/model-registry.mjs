import { join } from 'node:path';
import { snapshotDigest, readSnapshot, writeSnapshotAtomically } from './snapshot-store.mjs';

const VERSION = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
const REF = /^(?:env:[A-Za-z_][A-Za-z0-9_]{0,127}|keychain:[A-Za-z0-9._:-]{1,127})$/;
const PROTOCOLS = new Set(['openai-compatible', 'openai-responses', 'anthropic']);
const CAPABILITIES = new Set(['text', 'vision', 'tool_calling', 'reasoning', 'streaming']);
const SECRET_QUERY = /(?:token|secret|password|passwd|auth|bearer|api[_-]?key|apikey|accesskey|clientsecret|key)/;

export class ModelRegistryError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ModelRegistryError'; this.code = code; this.details = details; }
}

function fail(code, message) { throw new ModelRegistryError(code, message); }
function text(value, field, max, code) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) fail(code, `${field} is invalid`); return value.trim(); }
function endpoint(value) {
  const raw = text(value, 'endpoint', 2048, 'MODEL_ENDPOINT_INVALID');
  let parsed; try { parsed = new URL(raw); } catch { fail('MODEL_ENDPOINT_INVALID', 'endpoint must be an http(s) URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || [...parsed.searchParams.keys()].some((key) => SECRET_QUERY.test(String(key).toLowerCase().replace(/-/g, '_')))) fail('MODEL_ENDPOINT_INVALID', 'endpoint must not contain credentials or secret query parameters');
  return parsed.toString();
}
function capabilities(value) {
  if (!Array.isArray(value) || value.length > 16 || value.some((item) => typeof item !== 'string' || !CAPABILITIES.has(item)) || new Set(value).size !== value.length) fail('MODEL_CAPABILITIES_INVALID', 'capabilities are invalid');
  return [...value];
}
function profileHash(profile) { const { configHash: _hash, health: _health, ...config } = profile; return snapshotDigest(JSON.stringify(config)); }
function publicProfile(profile) { return Object.freeze({ ...profile, capabilities: Object.freeze([...(profile.capabilities ?? [])]), health: Object.freeze({ ...profile.health }) }); }

export function normalizeModelProfile(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('MODEL_INPUT_INVALID', 'model profile must be an object');
  const id = text(input.id, 'id', 64, 'MODEL_ID_INVALID');
  if (!ID.test(id)) fail('MODEL_ID_INVALID', 'id contains invalid characters');
  const provider = text(input.provider, 'provider', 128, 'MODEL_PROVIDER_INVALID');
  if (!NAME.test(provider)) fail('MODEL_PROVIDER_INVALID', 'provider contains invalid characters');
  const protocol = input.protocol;
  if (!PROTOCOLS.has(protocol)) fail('MODEL_PROTOCOL_INVALID', 'unsupported model protocol');
  const model = text(input.model, 'model', 256, 'MODEL_NAME_INVALID');
  const secretRef = text(input.secretRef, 'secretRef', 256, 'MODEL_SECRET_REF_INVALID');
  if (!REF.test(secretRef)) fail('MODEL_SECRET_REF_INVALID', 'secretRef must reference env or keychain, not contain a secret value');
  const profile = { id, provider, protocol, model, endpoint: endpoint(input.endpoint), capabilities: capabilities(input.capabilities ?? []), secretRef, enabled: false, health: { status: 'unknown', checkedAt: null } };
  return publicProfile({ ...profile, configHash: profileHash(profile) });
}

function restore(value) {
  const normalized = normalizeModelProfile(value);
  if (value.enabled !== false || value.configHash !== normalized.configHash || !value.health || !['unknown', 'ready', 'unavailable', 'error'].includes(value.health.status)) fail('MODEL_REGISTRY_INVALID', 'model registry snapshot is invalid');
  return publicProfile({ ...normalized, health: { status: value.health.status, checkedAt: value.health.checkedAt ?? null } });
}

export function createModelRegistry({ root, storePath = join(root ?? '', '.openclaw-workbench', 'model-registry.json') } = {}) {
  if (!root) throw new ModelRegistryError('ROOT_REQUIRED', 'root is required');
  const records = new Map(); let persistedDigest = null;
  try {
    const stored = readSnapshot({ root, storePath, ErrorType: ModelRegistryError, code: 'MODEL_REGISTRY_INVALID', message: 'model registry snapshot is invalid' });
    if (stored.content !== null) {
      const snapshot = JSON.parse(stored.content);
      if (!snapshot || snapshot.version !== VERSION || !Array.isArray(snapshot.models)) fail('MODEL_REGISTRY_INVALID', 'model registry snapshot is invalid');
      for (const item of snapshot.models) { const profile = restore(item); if (records.has(profile.id)) fail('MODEL_REGISTRY_INVALID', 'model registry contains duplicate IDs'); records.set(profile.id, profile); }
      persistedDigest = stored.digest;
    }
  } catch (error) { if (error instanceof ModelRegistryError) throw error; throw new ModelRegistryError('MODEL_REGISTRY_INVALID', 'model registry snapshot is invalid'); }
  function persist() { persistedDigest = writeSnapshotAtomically({ root, storePath, payload: JSON.stringify({ version: VERSION, models: [...records.values()] }), expectedDigest: persistedDigest, ErrorType: ModelRegistryError, code: 'MODEL_REGISTRY_INVALID', message: 'model registry snapshot is invalid', busyCode: 'MODEL_REGISTRY_BUSY', busyMessage: 'model registry is busy', conflictCode: 'MODEL_REGISTRY_CONFLICT', conflictMessage: 'model registry changed outside this process', temporaryName: 'model-registry' }); }
  function register(input) { const profile = normalizeModelProfile(input); if (records.has(profile.id)) throw new ModelRegistryError('MODEL_DUPLICATE', 'model profile ID already exists'); records.set(profile.id, profile); try { persist(); } catch (error) { records.delete(profile.id); throw error; } return profile; }
  function updateHealth(id, health) { const current = records.get(id); if (!current) throw new ModelRegistryError('MODEL_NOT_FOUND', 'model profile not found'); if (!['unknown', 'ready', 'unavailable', 'error'].includes(health?.status)) throw new ModelRegistryError('MODEL_HEALTH_INVALID', 'health status is invalid'); const next = publicProfile({ ...current, health: { status: health.status, checkedAt: typeof health.checkedAt === 'string' ? health.checkedAt : new Date().toISOString() } }); records.set(id, next); try { persist(); } catch (error) { records.set(id, current); throw error; } return next; }
  return Object.freeze({ validate: normalizeModelProfile, register, updateHealth, get: (id) => records.has(id) ? publicProfile(records.get(id)) : null, list: () => Object.freeze([...records.values()].map(publicProfile)), snapshotPath: storePath });
}
