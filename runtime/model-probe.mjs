import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { SecretResolverError } from './secret-resolver.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const SENSITIVE_QUERY = /(?:token|secret|password|passwd|auth|bearer|api[_-]?key|apikey|accesskey|clientsecret|key)/i;

export class ModelProbeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ModelProbeError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ModelProbeError(code, message, details);
}

function blockedHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host === 'metadata' || host === 'metadata.google.internal' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.nip.io') || host.endsWith('.sslip.io') || host.endsWith('.xip.io')) return true;
  if (isIP(host) === 4) {
    const octets = host.split('.').map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
  }
  if (isIP(host) === 6) {
    const normalized = host.replace(/^::ffff:/i, '');
    if (isIP(normalized) === 4) return blockedHost(normalized);
    return host === '::1' || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host);
  }
  return false;
}

function modelEndpoint(profile) {
  if (!profile || typeof profile !== 'object' || typeof profile.endpoint !== 'string') fail('MODEL_INPUT_INVALID', 'model profile is invalid');
  let url;
  try { url = new URL(profile.endpoint); } catch { fail('MODEL_INPUT_INVALID', 'model profile is invalid'); }
  if (profile.protocol !== 'openai-compatible') fail('MODEL_PROTOCOL_UNSUPPORTED', 'model protocol is not supported by this probe');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || blockedHost(url.hostname) || [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key))) fail('MODEL_ENDPOINT_BLOCKED', 'model endpoint is not allowed for live probing');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
  return url.toString();
}

function abortError(timedOut, callerSignal) {
  return new ModelProbeError(timedOut ? 'MODEL_TIMEOUT' : callerSignal?.aborted ? 'MODEL_ABORTED' : 'MODEL_REQUEST_FAILED', timedOut ? 'model health probe timed out' : callerSignal?.aborted ? 'model health probe was cancelled' : 'model health probe failed');
}

function raceAbort(promise, signal, onAbort) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { signal?.removeEventListener('abort', abort); };
    const abort = () => { if (settled) return; settled = true; cleanup(); reject(onAbort()); };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then((value) => { if (settled) return; settled = true; cleanup(); resolve(value); }, (error) => { if (settled) return; settled = true; cleanup(); reject(error); });
    if (signal?.aborted) abort();
  });
}

async function readBoundedText(response, maxBytes, signal, onAbort) {
  if (!response?.body?.getReader) fail('MODEL_RESPONSE_STREAM_INVALID', 'model response stream is unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await raceAbort(reader.read(), signal, onAbort);
      if (done) break;
      if (!value || !Number.isSafeInteger(value.byteLength)) fail('MODEL_RESPONSE_INVALID', 'model provider returned an invalid response stream');
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {});
        fail('MODEL_RESPONSE_LIMIT', 'model response exceeded the configured limit');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    if (signal?.aborted) void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock?.(); }
}

export function createModelHealthProbe({ secretResolver, fetchImpl = globalThis.fetch, lookupImpl = fetchImpl === globalThis.fetch ? lookup : async () => [], requestTimeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
  if (!secretResolver || typeof secretResolver.resolve !== 'function') throw new ModelProbeError('MODEL_SECRET_RESOLVER_INVALID', 'secret resolver is unavailable');
  if (typeof fetchImpl !== 'function') throw new ModelProbeError('MODEL_FETCH_INVALID', 'fetch implementation is unavailable');
  if (typeof lookupImpl !== 'function') throw new ModelProbeError('MODEL_LOOKUP_INVALID', 'endpoint lookup implementation is unavailable');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new ModelProbeError('MODEL_CONFIG_INVALID', 'model probe limits are invalid');
  return async function probe(profile, { signal } = {}) {
    const target = modelEndpoint(profile);
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', relayAbort, { once: true });
    const onAbort = () => abortError(timedOut, signal);
    try {
      if (signal?.aborted) throw onAbort();
      let secret;
      try { secret = await raceAbort(secretResolver.resolve(profile.secretRef, { signal: controller.signal }), controller.signal, onAbort); }
      catch (error) {
        if (error instanceof ModelProbeError) throw error;
        if (error instanceof SecretResolverError) throw new ModelProbeError(error.code, 'model secret could not be resolved');
        throw new ModelProbeError('MODEL_SECRET_RESOLVE_FAILED', 'model secret could not be resolved');
      }
      if (timedOut || signal?.aborted) throw onAbort();
      const endpointUrl = new URL(target);
      const resolved = await raceAbort(lookupImpl(endpointUrl.hostname, { all: true, verbatim: true }), controller.signal, onAbort);
      const addresses = Array.isArray(resolved) ? resolved : [resolved];
      if (addresses.some((entry) => blockedHost(entry?.address ?? entry))) fail('MODEL_ENDPOINT_BLOCKED', 'model endpoint is not allowed for live probing');
      const response = await raceAbort(fetchImpl(target, { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${secret}` }, redirect: 'error', signal: controller.signal }), controller.signal, onAbort);
      if (!response?.ok) throw new ModelProbeError('MODEL_HTTP_STATUS', 'model provider returned an HTTP error', { status: Number.isSafeInteger(response?.status) ? response.status : undefined });
      const body = await readBoundedText(response, maxResponseBytes, controller.signal, onAbort);
      let parsed;
      try { parsed = JSON.parse(body); } catch { throw new ModelProbeError('MODEL_RESPONSE_INVALID', 'model provider returned invalid JSON'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.data)) throw new ModelProbeError('MODEL_RESPONSE_INVALID', 'model provider returned an invalid models response');
      if (timedOut || signal?.aborted) throw onAbort();
      return Object.freeze({ status: 'ready', code: 'PROBE_OK' });
    } catch (error) {
      if (error instanceof ModelProbeError) throw error;
      if (timedOut || signal?.aborted) throw onAbort();
      throw new ModelProbeError('MODEL_REQUEST_FAILED', 'model health probe failed');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relayAbort);
      if (!controller.signal.aborted) controller.abort();
    }
  };
}
