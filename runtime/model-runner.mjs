import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { SecretResolverError } from './secret-resolver.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_MESSAGES = 128;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_TOOL_CALLS = 64;
const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;
const SENSITIVE_QUERY = /(?:token|secret|password|passwd|auth|bearer|api[_-]?key|apikey|accesskey|clientsecret|key)/i;

export class ModelRunnerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ModelRunnerError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) { throw new ModelRunnerError(code, message, details); }

function redactResolvedSecret(value, secret) {
  if (typeof value !== 'string' || typeof secret !== 'string' || !secret) return value;
  return value.split(secret).join('[redacted]');
}

function redactResolvedValue(value, secret, depth = 0) {
  if (depth > 8) return '[redacted]';
  if (typeof value === 'string') return redactResolvedSecret(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactResolvedValue(item, secret, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactResolvedSecret(key, secret), redactResolvedValue(item, secret, depth + 1)]));
  return value;
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

function endpointFor(profile) {
  if (!profile || typeof profile !== 'object' || typeof profile.endpoint !== 'string' || typeof profile.model !== 'string') fail('MODEL_PROFILE_INVALID', 'model profile is invalid');
  if (!['openai-compatible', 'openai-responses'].includes(profile.protocol)) fail('MODEL_PROTOCOL_UNSUPPORTED', 'model protocol is not supported by this runner');
  let parsed;
  try { parsed = new URL(profile.endpoint); } catch { fail('MODEL_ENDPOINT_BLOCKED', 'model endpoint is not allowed'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || blockedHost(parsed.hostname) || [...parsed.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key))) fail('MODEL_ENDPOINT_BLOCKED', 'model endpoint is not allowed');
  const suffix = profile.protocol === 'openai-responses' ? '/responses' : '/chat/completions';
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}${suffix}`;
  parsed.search = '';
  return parsed.toString();
}

function raceAbort(promise, signal, onAbort) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => { if (settled) return; settled = true; cleanup(); reject(onAbort()); };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then((value) => { if (settled) return; settled = true; cleanup(); resolve(value); }, (error) => { if (settled) return; settled = true; cleanup(); reject(error); });
    if (signal?.aborted) abort();
  });
}

async function readBoundedText(response, maxBytes, signal, onAbort) {
  if (!response?.body?.getReader) fail('MODEL_RESPONSE_INVALID', 'model provider returned an invalid response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await raceAbort(reader.read(), signal, onAbort);
      if (done) break;
      const chunk = typeof value === 'string' ? value : value instanceof Uint8Array ? value : null;
      if (chunk === null) fail('MODEL_RESPONSE_INVALID', 'model provider returned an invalid response stream');
      const chunkBytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
      total += chunkBytes;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        fail('MODEL_RESPONSE_LIMIT', 'model response exceeded the configured limit');
      }
      chunks.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    if (signal?.aborted) void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock?.(); }
}

function safeJson(value, code = 'MODEL_INPUT_INVALID') {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail(code, 'model input is not JSON serializable'); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_MESSAGE_BYTES) fail(code, 'model input exceeds the configured limit');
  return encoded;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES || messages.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.role !== 'string' || !item.role || !['system', 'user', 'assistant', 'tool', 'developer'].includes(item.role))) fail('MODEL_INPUT_INVALID', 'messages are invalid');
  const encoded = safeJson(messages);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_MESSAGE_BYTES) fail('MODEL_INPUT_INVALID', 'messages exceed the configured limit');
  return messages.map((message) => ({ ...message }));
}

function normalizeTools(tools) {
  if (tools === undefined) return [];
  if (!Array.isArray(tools) || tools.length > MAX_TOOL_CALLS) fail('MODEL_INPUT_INVALID', 'tools are invalid');
  const encoded = safeJson(tools);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_MESSAGE_BYTES) fail('MODEL_INPUT_INVALID', 'tools exceed the configured limit');
  return tools.map((tool) => ({ ...tool }));
}

function parseArguments(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_TOOL_ARGUMENT_BYTES) fail('MODEL_TOOL_CALL_INVALID', 'model returned invalid tool arguments');
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail('MODEL_TOOL_CALL_INVALID', 'model returned invalid tool arguments'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('MODEL_TOOL_CALL_INVALID', 'model returned invalid tool arguments');
  return parsed;
}

function normalizeChatToolCalls(toolCalls) {
  if (toolCalls === undefined) return [];
  if (!Array.isArray(toolCalls) || toolCalls.length > MAX_TOOL_CALLS) fail('MODEL_TOOL_CALL_INVALID', 'model returned invalid tool calls');
  return toolCalls.map((call) => {
    const fn = call?.function;
    if (!call || typeof call.id !== 'string' || !call.id || typeof fn?.name !== 'string' || !fn.name || typeof fn.arguments !== 'string') fail('MODEL_TOOL_CALL_INVALID', 'model returned invalid tool call');
    return { id: call.id, name: fn.name, arguments: parseArguments(fn.arguments) };
  });
}

function normalizeResponsesOutput(output) {
  if (!Array.isArray(output) || output.length > MAX_TOOL_CALLS + 16) fail('MODEL_RESPONSE_INVALID', 'model provider returned an invalid response');
  let text = '';
  const toolCalls = [];
  for (const item of output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
    } else if (item?.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name) fail('MODEL_TOOL_CALL_INVALID', 'model returned invalid tool call');
      toolCalls.push({ id: item.call_id, name: item.name, arguments: parseArguments(item.arguments) });
    }
  }
  return { text, toolCalls };
}

function parseJsonResponse(profile, parsed) {
  if (profile.protocol === 'openai-compatible') {
    const choice = parsed?.choices?.[0];
    if (!choice || !choice.message || typeof choice.message !== 'object') fail('MODEL_RESPONSE_INVALID', 'model provider returned an invalid response');
    const content = choice.message.content;
    if (content !== null && content !== undefined && typeof content !== 'string') fail('MODEL_RESPONSE_INVALID', 'model provider returned an invalid response');
    return { text: content ?? '', toolCalls: normalizeChatToolCalls(choice.message.tool_calls), usage: parsed.usage, finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null };
  }
  const output = normalizeResponsesOutput(parsed?.output);
  return { ...output, usage: parsed?.usage, finishReason: typeof parsed?.status === 'string' ? parsed.status : null };
}

function parseSseResponse(profile, text) {
  const result = { text: '', toolCalls: [], usage: undefined, finishReason: null };
  const toolArgs = new Map();
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    let payload;
    try { payload = JSON.parse(data); } catch { fail('MODEL_RESPONSE_INVALID', 'model provider returned invalid event data'); }
    if (profile.protocol === 'openai-compatible') {
      const choice = payload?.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === 'string') result.text += delta.content;
      if (Array.isArray(delta?.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = Number.isSafeInteger(call?.index) ? call.index : result.toolCalls.length;
          const existing = result.toolCalls[index] ?? { id: call?.id ?? `stream-call-${index}`, name: call?.function?.name ?? '', arguments: {} };
          if (call?.id) existing.id = call.id;
          if (call?.function?.name) existing.name = call.function.name;
          if (typeof call?.function?.arguments === 'string') toolArgs.set(index, `${toolArgs.get(index) ?? ''}${call.function.arguments}`);
          result.toolCalls[index] = existing;
        }
      }
      if (typeof choice?.finish_reason === 'string') result.finishReason = choice.finish_reason;
      if (payload?.usage) result.usage = payload.usage;
    } else {
      if (payload?.type === 'response.output_text.delta' && typeof payload.delta === 'string') result.text += payload.delta;
      if (payload?.type === 'response.function_call_arguments.delta' && typeof payload.delta === 'string') {
        const id = typeof payload.item_id === 'string' ? payload.item_id : `stream-call-${result.toolCalls.length}`;
        const existing = result.toolCalls.find((call) => call.id === id) ?? { id, name: '', arguments: {} };
        toolArgs.set(id, `${toolArgs.get(id) ?? ''}${payload.delta}`);
        if (!result.toolCalls.includes(existing)) result.toolCalls.push(existing);
      }
      if (payload?.type === 'response.output_item.added' && payload.item?.type === 'function_call') {
        result.toolCalls.push({ id: payload.item.call_id ?? payload.item.id ?? `stream-call-${result.toolCalls.length}`, name: payload.item.name ?? '', arguments: {} });
      }
      if (payload?.type === 'response.completed') {
        result.finishReason = typeof payload.response?.status === 'string' ? payload.response.status : 'completed';
        result.usage = payload.response?.usage;
      }
    }
  }
  for (const call of result.toolCalls) {
    const raw = profile.protocol === 'openai-compatible' ? toolArgs.get(result.toolCalls.indexOf(call)) : toolArgs.get(call.id);
    if (!call.name || typeof raw !== 'string') fail('MODEL_TOOL_CALL_INVALID', 'model returned invalid tool call');
    call.arguments = parseArguments(raw);
  }
  return result;
}

function abortError(timedOut, signal) {
  return new ModelRunnerError(timedOut ? 'MODEL_TIMEOUT' : signal?.aborted ? 'MODEL_ABORTED' : 'MODEL_REQUEST_FAILED', timedOut ? 'model request timed out' : signal?.aborted ? 'model request was cancelled' : 'model request failed');
}

export function createModelRunner({ profileResolver, secretResolver, fetchImpl = globalThis.fetch, lookupImpl = fetchImpl === globalThis.fetch ? lookup : async () => [], requestTimeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
  if (!secretResolver || typeof secretResolver.resolve !== 'function') throw new ModelRunnerError('MODEL_SECRET_RESOLVER_INVALID', 'secret resolver is unavailable');
  if (typeof fetchImpl !== 'function') throw new ModelRunnerError('MODEL_FETCH_INVALID', 'fetch implementation is unavailable');
  if (typeof lookupImpl !== 'function') throw new ModelRunnerError('MODEL_LOOKUP_INVALID', 'endpoint lookup implementation is unavailable');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new ModelRunnerError('MODEL_CONFIG_INVALID', 'model runner limits are invalid');
  const resolveProfile = async (input) => {
    if (input?.profile) return input.profile;
    const resolver = typeof profileResolver === 'function' ? profileResolver : profileResolver?.get?.bind(profileResolver);
    if (!resolver || typeof input?.profileId !== 'string') fail('MODEL_PROFILE_INVALID', 'model profile is required');
    const resolved = await resolver(input.profileId);
    if (!resolved) fail('MODEL_PROFILE_NOT_FOUND', 'model profile was not found');
    return resolved;
  };
  return async function runModel({ profile, profileId, model, messages = [], tools, signal } = {}) {
    const selected = await resolveProfile({ profile, profileId });
    if (selected.enabled !== true) fail('MODEL_DISABLED', 'model profile is disabled');
    if (model !== undefined && model !== selected.model) fail('MODEL_PROFILE_MISMATCH', 'requested model does not match the selected profile');
    const target = endpointFor(selected);
    const normalizedMessages = normalizeMessages(messages);
    const normalizedTools = normalizeTools(tools);
    const body = selected.protocol === 'openai-compatible'
      ? { model: selected.model, messages: normalizedMessages, tools: normalizedTools, stream: true }
      : { model: selected.model, input: normalizedMessages, tools: normalizedTools, stream: true };
    const encodedBody = safeJson(body);
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', relayAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
    const onAbort = () => abortError(timedOut, signal);
    try {
      if (signal?.aborted) throw onAbort();
      let secret;
      try { secret = await raceAbort(secretResolver.resolve(selected.secretRef, { signal: controller.signal }), controller.signal, onAbort); }
      catch (error) {
        if (error instanceof ModelRunnerError) throw error;
        if (error instanceof SecretResolverError) throw new ModelRunnerError(error.code, 'model secret could not be resolved');
        throw new ModelRunnerError('MODEL_SECRET_RESOLVE_FAILED', 'model secret could not be resolved');
      }
      if (timedOut || signal?.aborted) throw onAbort();
      const endpointUrl = new URL(target);
      const resolved = await raceAbort(lookupImpl(endpointUrl.hostname, { all: true, verbatim: true }), controller.signal, onAbort);
      const addresses = Array.isArray(resolved) ? resolved : [resolved];
      if (addresses.some((entry) => blockedHost(entry?.address ?? entry))) fail('MODEL_ENDPOINT_BLOCKED', 'model endpoint is not allowed');
      const response = await raceAbort(fetchImpl(target, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: encodedBody, redirect: 'error', signal: controller.signal }), controller.signal, onAbort);
      if (!response?.ok) throw new ModelRunnerError('MODEL_HTTP_STATUS', 'model provider returned an HTTP error', { status: Number.isSafeInteger(response?.status) ? response.status : undefined });
      const text = await readBoundedText(response, maxResponseBytes, controller.signal, onAbort);
      let result;
      const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
      if (contentType.includes('text/event-stream')) result = parseSseResponse(selected, text);
      else { let parsed; try { parsed = JSON.parse(text); } catch { fail('MODEL_RESPONSE_INVALID', 'model provider returned invalid JSON'); } result = parseJsonResponse(selected, parsed); }
      if (timedOut || signal?.aborted) throw onAbort();
      return Object.freeze({ text: redactResolvedSecret(typeof result.text === 'string' ? result.text : '', secret), toolCalls: Object.freeze((result.toolCalls ?? []).map((call) => Object.freeze({ ...call, id: redactResolvedSecret(call.id, secret), name: redactResolvedSecret(call.name, secret), arguments: redactResolvedValue(call.arguments, secret) }))), ...(result.usage && typeof result.usage === 'object' ? { usage: Object.freeze(redactResolvedValue(result.usage, secret)) } : {}), finishReason: redactResolvedSecret(result.finishReason ?? null, secret), model: selected.model, protocol: selected.protocol });
    } catch (error) {
      if (error instanceof ModelRunnerError) throw error;
      if (timedOut || signal?.aborted) throw onAbort();
      throw new ModelRunnerError('MODEL_REQUEST_FAILED', 'model request failed');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relayAbort);
      if (!controller.signal.aborted) controller.abort();
    }
  };
}
