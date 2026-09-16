import { redactText, redactValue, boundedJson } from './redaction.mjs';
import { ALL_TOOLS, canonicalToolName, LEGACY_TO_CANONICAL, READ_TOOLS, WRITE_TOOLS } from './tool-registry.mjs';

const DEFAULT_MAX_ROUNDS = 8;
const DEFAULT_MAX_CALLS_PER_BATCH = 8;
const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 512 * 1024;
const MAX_CALL_ID_LENGTH = 256;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const LEGACY_TOOL_ALIASES = Object.freeze(Object.keys(LEGACY_TO_CANONICAL));

export class AgentLoopError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentLoopError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) { throw new AgentLoopError(code, message, details); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function checkAbort(signal) {
  if (signal?.aborted) fail('AGENT_LOOP_ABORTED', 'agent turn was cancelled');
}

function safeError(error) {
  const allowed = /^[A-Z0-9_.-]{1,96}$/.test(String(error?.code ?? '')) ? String(error.code) : 'TOOL_EXECUTION_FAILED';
  const message = redactText(typeof error?.message === 'string' ? error.message : 'tool execution failed', 256);
  return { code: allowed, message: message || 'tool execution failed' };
}

function safeMessages(messages) {
  if (!Array.isArray(messages)) fail('AGENT_INPUT_INVALID', 'messages must be an array');
  return messages.map((message) => {
    if (!plainObject(message) || typeof message.role !== 'string') fail('AGENT_INPUT_INVALID', 'messages are invalid');
    const copy = { ...message };
    if (message.role === 'assistant' && message.content && typeof message.content === 'object' && !Array.isArray(message.content)) {
      copy.content = typeof message.content.text === 'string' ? redactText(message.content.text) : '';
    } else if (typeof message.content === 'string') copy.content = redactText(message.content);
    return copy;
  });
}

function allowedNames(registry, mode) {
  const canonicalNames = mode === 'Code' ? [...ALL_TOOLS] : mode === 'Ask' || mode === 'Plan' ? [...READ_TOOLS] : [];
  const staticNames = [...canonicalNames, ...LEGACY_TOOL_ALIASES];
  let declared;
  try { declared = typeof registry?.definitions === 'function' ? registry.definitions({ mode }) : null; }
  catch { declared = null; }
  if (!Array.isArray(declared) || declared.length === 0) return new Set(staticNames);
  const names = declared.map((item) => item?.function?.name ?? item?.name).filter((name) => typeof name === 'string');
  const allowed = new Set(names.map(canonicalToolName).filter((name) => canonicalNames.includes(name)));
  for (const [alias, canonical] of Object.entries(LEGACY_TO_CANONICAL)) if (allowed.has(canonical)) allowed.add(alias);
  return allowed;
}

function normalizeResponse(response, allowed) {
  if (!plainObject(response)) fail('MODEL_RESPONSE_INVALID', 'model response is invalid');
  const text = typeof response.text === 'string' ? redactText(response.text, 128 * 1024) : '';
  if (response.toolCalls === undefined || response.toolCalls === null) return { ...response, text, toolCalls: [] };
  if (!Array.isArray(response.toolCalls)) fail('TOOL_CALL_INVALID', 'model tool calls are invalid');
  const toolCalls = response.toolCalls.map((call) => {
    if (!plainObject(call) || typeof call.id !== 'string' || !call.id || call.id.length > MAX_CALL_ID_LENGTH || typeof call.name !== 'string' || !call.name || call.name.length > MAX_TOOL_NAME_LENGTH || !plainObject(call.arguments)) fail('TOOL_CALL_INVALID', 'model tool call is invalid');
    if (!allowed.has(call.name)) fail('TOOL_NOT_ALLOWED', 'model requested a tool outside the allowlist');
    let encoded;
    try { encoded = JSON.stringify(call.arguments); } catch { fail('TOOL_CALL_INVALID', 'model tool arguments are invalid'); }
    if (Buffer.byteLength(encoded, 'utf8') > MAX_ARGUMENT_BYTES) fail('TOOL_ARGUMENT_LIMIT', 'model tool arguments exceed the configured limit');
    return { id: redactText(call.id, MAX_CALL_ID_LENGTH), name: call.name, arguments: redactValue(call.arguments, { maxStringLength: 8 * 1024 }) };
  });
  return { ...response, text, toolCalls };
}

function toolMessage(result, maxBytes) {
  const safe = redactValue(result);
  let encoded;
  try { encoded = boundedJson(safe, maxBytes, 'TOOL_OUTPUT_LIMIT'); }
  catch { fail('TOOL_OUTPUT_LIMIT', 'cumulative tool output exceeded the configured limit'); }
  return { safe, encoded, bytes: Buffer.byteLength(encoded, 'utf8') };
}

async function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  checkAbort(signal);
  let abortHandler;
  const aborted = new Promise((_, reject) => {
    abortHandler = () => reject(new AgentLoopError('AGENT_LOOP_ABORTED', 'agent turn was cancelled'));
    signal.addEventListener('abort', abortHandler, { once: true });
  });
  try { return await Promise.race([Promise.resolve(promise), aborted]); }
  finally { signal.removeEventListener('abort', abortHandler); }
}

export async function runAgentLoop({ mode = 'Ask', sessionId, profile, messages = [], registry, modelRunner, signal, maxRounds = DEFAULT_MAX_ROUNDS, maxCallsPerBatch = DEFAULT_MAX_CALLS_PER_BATCH, maxToolOutputBytes = DEFAULT_MAX_TOOL_OUTPUT_BYTES, ...runnerOptions } = {}) {
  if (typeof modelRunner !== 'function') fail('MODEL_RUNNER_REQUIRED', 'model runner is required');
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 64) fail('AGENT_CONFIG_INVALID', 'maxRounds is invalid');
  if (!Number.isSafeInteger(maxCallsPerBatch) || maxCallsPerBatch < 1 || maxCallsPerBatch > 64) fail('AGENT_CONFIG_INVALID', 'maxCallsPerBatch is invalid');
  if (!Number.isSafeInteger(maxToolOutputBytes) || maxToolOutputBytes < 1 || maxToolOutputBytes > 16 * 1024 * 1024) fail('AGENT_CONFIG_INVALID', 'maxToolOutputBytes is invalid');
  const modelMessages = safeMessages(messages);
  const loopSignal = signal ?? new AbortController().signal;
  const allowed = allowedNames(registry, mode);
  const seenCallIds = new Set();
  const toolTrace = [];
  let cumulativeOutputBytes = 0;
  let finalResponse;
  for (let round = 0; round < maxRounds; round += 1) {
    checkAbort(loopSignal);
    let response;
    try {
      response = await awaitWithAbort(modelRunner({ profile, messages: modelMessages, tools: typeof registry?.definitions === 'function' ? registry.definitions({ mode }) : [], mode, sessionId, signal: loopSignal, ...runnerOptions }), loopSignal);
    } catch (error) {
      if (loopSignal.aborted || error?.code === 'ABORTED' || error?.code === 'MODEL_ABORTED') fail('AGENT_LOOP_ABORTED', 'agent turn was cancelled');
      throw error;
    }
    checkAbort(loopSignal);
    const normalized = normalizeResponse(response, allowed);
    finalResponse = normalized;
    const calls = normalized.toolCalls;
    if (calls.length === 0) {
      return Object.freeze({ ...normalized, toolTrace: Object.freeze(toolTrace.map((item) => Object.freeze({ ...item }))) });
    }
    if (!registry || typeof registry.call !== 'function') fail('TOOL_NOT_ALLOWED', 'tool registry is unavailable');
    if (calls.length > maxCallsPerBatch) fail('TOOL_BATCH_LIMIT', 'tool call batch exceeds the configured limit');
    for (const call of calls) {
      if (seenCallIds.has(call.id)) fail('TOOL_CALL_REPLAY', 'duplicate tool call id was rejected');
      seenCallIds.add(call.id);
    }
    modelMessages.push({ role: 'assistant', content: normalized.text ?? '', tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
    for (const call of calls) {
      checkAbort(loopSignal);
      let result;
      let status = 'completed';
      try {
        const pending = registry.call({ mode, name: call.name, input: call.arguments, sessionId, signal: loopSignal });
        result = await awaitWithAbort(pending, loopSignal);
      } catch (error) {
        if (loopSignal.aborted || error?.code === 'TOOL_ABORTED' || error?.code === 'ABORTED') fail('AGENT_LOOP_ABORTED', 'agent turn was cancelled');
        if (error?.code === 'TOOL_NOT_ALLOWED' || error?.code === 'TOOL_MODE_DENIED' || error?.code === 'TOOL_CALL_REPLAY') throw error;
        result = { error: safeError(error) };
        status = 'failed';
      }
      const encoded = toolMessage(result, maxToolOutputBytes - cumulativeOutputBytes);
      cumulativeOutputBytes += encoded.bytes;
      if (cumulativeOutputBytes > maxToolOutputBytes) fail('TOOL_OUTPUT_LIMIT', 'cumulative tool output exceeded the configured limit');
      modelMessages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: encoded.encoded });
      toolTrace.push({ id: call.id, name: call.name, status });
    }
  }
  if (finalResponse?.toolCalls?.length) fail('TOOL_LOOP_LIMIT', 'model tool loop exceeded the configured limit');
  fail('TOOL_LOOP_LIMIT', 'model tool loop exceeded the configured limit');
}
