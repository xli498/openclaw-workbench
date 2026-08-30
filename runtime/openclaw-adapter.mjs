import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 600_000;

export class AdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.details = details;
  }
}

export function buildAgentArgv({ message, sessionKey, agent, model, thinking, timeoutSeconds, local = false }) {
  if (!message) throw new AdapterError('INVALID_INPUT', 'message is required');
  if (!sessionKey && !agent) throw new AdapterError('INVALID_INPUT', 'sessionKey or agent is required');
  const argv = ['agent', '--json', '--message', message];
  if (sessionKey) argv.push('--session-key', sessionKey);
  if (agent) argv.push('--agent', agent);
  if (model) argv.push('--model', model);
  if (thinking) argv.push('--thinking', thinking);
  if (timeoutSeconds !== undefined) argv.push('--timeout', String(timeoutSeconds));
  if (local) argv.push('--local');
  return argv;
}

export function parseAgentJson(stdout) {
  try {
    const value = JSON.parse(stdout);
    if (!value || typeof value !== 'object') throw new Error('not_object');
    return value;
  } catch (error) {
    throw new AdapterError('INVALID_RESPONSE', 'OpenClaw returned invalid JSON', { cause: error.message });
  }
}

export function runAgent(options, { command = 'openclaw', timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = 1_048_576, signal } = {}) {
  const argv = buildAgentArgv(options);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AdapterError('ABORTED', 'Agent run aborted'));
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let outputTruncated = false;
    const appendOutput = (target, chunk) => {
      if (outputTruncated) return target;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        outputTruncated = true;
        terminate();
        return target;
      }
      return target + chunk.toString();
    };
    let settled = false;
    const terminate = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {}
    };
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); } };
    const timer = setTimeout(() => {
      terminate();
      finish(reject, new AdapterError('TIMEOUT', `OpenClaw agent exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    const abort = () => {
      terminate();
      finish(reject, new AdapterError('ABORTED', 'Agent run aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { stdout = appendOutput(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendOutput(stderr, chunk); });
    child.on('error', (error) => {
      finish(reject, new AdapterError('SPAWN_FAILED', error.message));
    });
    child.on('close', (code, signalName) => {
      if (settled) return;
      if (outputTruncated) return finish(reject, new AdapterError('OUTPUT_LIMIT', `OpenClaw output exceeded ${maxOutputBytes} bytes`, { code, signal: signalName }));
      if (code !== 0) return finish(reject, new AdapterError('PROCESS_FAILED', `OpenClaw exited with code ${code}`, { code, signal: signalName, stderr }));
      try { finish(resolve, parseAgentJson(stdout)); }
      catch (error) { finish(reject, error); }
    });
  });
}
