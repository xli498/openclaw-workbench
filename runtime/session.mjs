import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runAgent } from './openclaw-adapter.mjs';
import { runPlanReview, PlanError } from './plan.mjs';

export const CHAT_MODES = Object.freeze(['Ask', 'Plan', 'Code']);
const MAX_MESSAGE_LENGTH = 32 * 1024;

export class SessionError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'SessionError'; this.code = code; this.details = details; }
}

function assertMode(mode) {
  if (!CHAT_MODES.includes(mode)) throw new SessionError('INVALID_MODE', `mode must be one of ${CHAT_MODES.join(', ')}`);
}

function publicSession(session) {
  return Object.freeze({ id: session.id, workspaceId: session.workspaceId, mode: session.mode, actor: session.actor, status: session.status, createdAt: session.createdAt, messageCount: session.messages.length, ...(session.recoveryReason ? { recoveryReason: session.recoveryReason } : {}) });
}

function snapshotSession(session) {
  return { id: session.id, workspaceId: session.workspaceId, mode: session.mode, actor: session.actor, status: session.status, createdAt: session.createdAt, messages: session.messages, running: session.running };
}

export function createChatSessionManager({ root, runAgentFn = runAgent, clock = () => new Date(), storePath = join(root ?? '', '.openclaw-workbench', 'sessions.json') } = {}) {
  if (!root) throw new SessionError('ROOT_REQUIRED', 'root is required');
  const sessions = new Map();
  function persist() {
    const payload = JSON.stringify({ version: 1, sessions: [...sessions.values()].map(snapshotSession) });
    mkdirSync(dirname(storePath), { recursive: true });
    const temp = `${storePath}.${randomUUID()}.tmp`;
    writeFileSync(temp, payload, { mode: 0o600 });
    renameSync(temp, storePath);
  }
  function restore() {
    try {
      const payload = JSON.parse(readFileSync(storePath, 'utf8'));
      if (payload?.version !== 1 || !Array.isArray(payload.sessions)) throw new Error('unsupported snapshot');
      const ids = new Set();
      for (const raw of payload.sessions) {
        if (!raw || typeof raw.id !== 'string' || !raw.id || ids.has(raw.id) || !CHAT_MODES.includes(raw.mode) || (raw.status !== undefined && !['active', 'closed', 'manual_review'].includes(raw.status)) || !Array.isArray(raw.messages) || raw.messages.some((message) => !message || !['user', 'assistant'].includes(message.role) || (typeof message.content !== 'string' && (!message.content || typeof message.content !== 'object' || Array.isArray(message.content))))) throw new Error('invalid session snapshot');
        ids.add(raw.id);
        const interrupted = raw.running === true;
        const session = { id: raw.id, workspaceId: raw.workspaceId || root, mode: raw.mode, actor: raw.actor || 'user', status: interrupted ? 'manual_review' : raw.status === 'closed' ? 'closed' : 'active', createdAt: raw.createdAt || clock().toISOString(), messages: raw.messages.map((message) => Object.freeze({ ...message })), running: false, ...(interrupted ? { recoveryReason: 'interrupted_turn' } : {}) };
        sessions.set(session.id, session);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new SessionError('SESSION_STORE_INVALID', 'session snapshot is invalid; refusing recovery');
    }
  }
  restore();

  function createSession({ mode = 'Ask', actor = 'user', workspaceId = root } = {}) {
    assertMode(mode);
    if (typeof actor !== 'string' || !actor || actor.length > 256) throw new SessionError('INVALID_ACTOR', 'actor is required and must be at most 256 characters');
    const session = { id: randomUUID(), workspaceId, mode, actor, status: 'active', createdAt: clock().toISOString(), messages: [], running: false };
    sessions.set(session.id, session);
    persist();
    return publicSession(session);
  }

  function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new SessionError('SESSION_NOT_FOUND', 'session not found');
    return session;
  }

  async function sendMessage({ sessionId, message, model, thinking, timeoutSeconds, local = true, signal } = {}) {
    const session = getSession(sessionId);
    if (session.status !== 'active') throw new SessionError('SESSION_NOT_ACTIVE', 'session is not active');
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_LENGTH) throw new SessionError('INVALID_MESSAGE', `message must be non-empty and at most ${MAX_MESSAGE_LENGTH} characters`);
    if (session.running) throw new SessionError('SESSION_BUSY', 'session already has a running turn');
    session.running = true;
    const userMessage = Object.freeze({ role: 'user', content: message, createdAt: clock().toISOString() });
    session.messages.push(userMessage);
    persist();
    try {
      const response = await runAgentFn({ message, sessionKey: session.id, mode: session.mode, model, thinking, timeoutSeconds, local, signal });
      const assistantMessage = Object.freeze({ role: 'assistant', content: response, createdAt: clock().toISOString() });
      session.messages.push(assistantMessage);
      persist();
      return Object.freeze({ session: publicSession(session), message: assistantMessage });
    } catch (error) {
      session.messages.pop();
      persist();
      throw error;
    } finally { session.running = false; persist(); }
  }

  async function planReview({ sessionId, question, models, thinking, timeoutSeconds } = {}) {
    const session = getSession(sessionId);
    if (session.status !== 'active') throw new SessionError('SESSION_NOT_ACTIVE', 'session is not active');
    if (session.mode !== 'Plan') throw new SessionError('MODE_INSUFFICIENT', 'plan review requires a Plan session');
    if (session.running) throw new SessionError('SESSION_BUSY', 'session already has a running turn');
    session.running = true;
    persist();
    try { return await runPlanReview({ question, models, sessionKey: session.id, thinking, timeoutSeconds }); }
    catch (error) { if (error instanceof PlanError) throw error; throw error; }
    finally { session.running = false; persist(); }
  }

  function listMessages(sessionId) {
    const session = getSession(sessionId);
    return Object.freeze(session.messages.map((message) => Object.freeze({ ...message })));
  }

  function closeSession(sessionId) {
    const session = getSession(sessionId);
    if (session.running) throw new SessionError('SESSION_BUSY', 'cannot close a running session');
    session.status = 'closed';
    persist();
    return publicSession(session);
  }

  function reviewSession(sessionId, { decision, reviewer = 'user' } = {}) {
    const session = getSession(sessionId);
    if (session.status !== 'manual_review') throw new SessionError('REVIEW_NOT_REQUIRED', 'session is not awaiting manual review');
    if (!['resume', 'close'].includes(decision)) throw new SessionError('INVALID_REVIEW_DECISION', 'decision must be resume or close');
    if (typeof reviewer !== 'string' || !reviewer || reviewer.length > 256) throw new SessionError('INVALID_REVIEWER', 'reviewer is required and must be at most 256 characters');
    session.status = decision === 'resume' ? 'active' : 'closed';
    session.recoveryReason = undefined;
    session.review = Object.freeze({ decision, reviewer, reviewedAt: clock().toISOString(), replayed: false });
    persist();
    return publicSession(session);
  }

  return Object.freeze({ createSession, getSession: (id) => publicSession(getSession(id)), sendMessage, planReview, listMessages, closeSession, reviewSession, snapshotPath: storePath });
}
