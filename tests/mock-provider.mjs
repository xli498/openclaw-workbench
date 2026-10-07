const SECRET = 'mock-secret-value';
const PATCH = '--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n WORKBENCH_FIXTURE\n+APPROVED_CHANGE\n';

function responseBody(value) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function sseResponse(payload) {
  const event = `data: ${JSON.stringify(payload)}\n\n`;
  const done = 'data: [DONE]\n\n';
  return new Response(responseBody(`${event}${done}`), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function lastUserMessage(messages = []) {
  return [...messages].reverse().find((message) => message?.role === 'user')?.content ?? '';
}

function toolResult(messages = []) {
  return [...messages].reverse().find((message) => message?.role === 'tool')?.content ?? '';
}

function chatPayload(body, behavior = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages.at(-1);
  const toolNames = new Set((Array.isArray(body?.tools) ? body.tools : []).map((tool) => tool?.function?.name));
  const user = lastUserMessage(messages);

  if (typeof behavior.responseText === 'string') return { content: behavior.responseText };
  if (last?.role === 'tool') {
    const result = toolResult(messages);
    if (result.includes('approvalRequired')) return { content: '已生成修改提案，等待人工审批。' };
    if (result.includes('WORKBENCH_FIXTURE')) return { content: 'README.md 包含 WORKBENCH_FIXTURE，读取和搜索均为只读操作。' };
    return { content: '本地工作区检查完成。' };
  }

  if (user.includes('修改') && toolNames.has('workspace.patch')) {
    return { toolCall: { id: 'mock-patch-1', name: 'workspace.patch', arguments: { patch: PATCH, declaredPaths: ['README.md'] } } };
  }
  if ((user.includes('读取') || user.includes('搜索')) && toolNames.has('workspace.read_files')) {
    return { toolCall: { id: 'mock-read-1', name: 'workspace.read_files', arguments: { paths: ['README.md'] } } };
  }
  return { content: 'Plan: inspect the workspace, identify the smallest change, and verify it after approval.' };
}

function completion(body, behavior) {
  const result = chatPayload(body, behavior);
  if (result.toolCall) {
    return sseResponse({
      choices: [{ delta: { tool_calls: [{ index: 0, id: result.toolCall.id, type: 'function', function: { name: result.toolCall.name, arguments: JSON.stringify(result.toolCall.arguments) } }] }, finish_reason: 'tool_calls' }],
      model: body.model,
    });
  }
  return sseResponse({ choices: [{ delta: { content: result.content }, finish_reason: 'stop' }], model: body.model });
}

/**
 * Deterministic OpenAI-compatible provider seam used by product acceptance tests.
 * It records requests, validates the expected bearer header, and returns real
 * chat-completions SSE payloads to the production model runner.
 */
export async function createMockOpenAIProvider({ secret = SECRET, delayMs = 0, errorStatus, responseText } = {}) {
  const requests = [];
  let closed = false;
  const fetch = async (url, options = {}) => {
    if (closed) throw new Error('mock provider is closed');
    const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : {};
    requests.push({ url: String(url), method: options.method, headers, body });
    if (headers.authorization !== `Bearer ${secret}`) return new Response(responseBody('unauthorized'), { status: 401 });
    if (Number.isSafeInteger(errorStatus)) return new Response(responseBody(JSON.stringify({ error: { message: 'mock provider error' } })), { status: errorStatus, headers: { 'content-type': 'application/json' } });
    if (delayMs > 0) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('mock provider request aborted'), { name: 'AbortError' })); };
      options.signal?.addEventListener('abort', abort, { once: true });
    });
    return completion(body, { responseText });
  };
  return Object.freeze({
    fetch,
    requests,
    createAgentRunner() {
      return async ({ message, model }) => ({ text: 'Plan: inspect the workspace, propose the smallest safe change, and verify it after approval.', model, protocol: 'openai-compatible', ...(message ? {} : {}) });
    },
    async close() { closed = true; },
  });
}

export { PATCH };
