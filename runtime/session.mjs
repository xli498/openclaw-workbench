import { randomUUID } from 'node:crypto';
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
  return Object.freeze({ id: session.id, workspaceId: session.workspaceId, mode: session.mode, actor: session.actor, status: session.status, createdAt: session.createdAt, messageCount: session.messages.length });
}

export function createChatSessionManager({ root, runAgentFn = runAgent, clock = () => new Date() } = {}) {
  if (!root) throw new SessionError('ROOT_REQUIRED', 'root is required');
  const sessions = new Map();

  function createSession({ mode = 'Ask', actor = 'user', workspaceId = root } = {}) {
    assertMode(mode);
    if (typeof actor !== 'string' || !actor || actor.length > 256) throw new SessionError('INVALID_ACTOR', 'actor is required and must be at most 256 characters');
    const session = { id: randomUUID(), workspaceId, mode, actor, status: 'active', createdAt: clock().toISOString(), messages: [], running: false };
    sessions.set(session.id, session);
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
    try {
      const response = await runAgentFn({ message, sessionKey: session.id, mode: session.mode, model, thinking, timeoutSeconds, local, signal });
      const assistantMessage = Object.freeze({ role: 'assistant', content: response, createdAt: clock().toISOString() });
      session.messages.push(assistantMessage);
      return Object.freeze({ session: publicSession(session), message: assistantMessage });
    } catch (error) {
      session.messages.pop();
      throw error;
    } finally { session.running = false; }
  }

  async function planReview({ sessionId, question, models, thinking, timeoutSeconds } = {}) {
    const session = getSession(sessionId);
    if (session.status !== 'active') throw new SessionError('SESSION_NOT_ACTIVE', 'session is not active');
    if (session.mode !== 'Plan') throw new SessionError('MODE_INSUFFICIENT', 'plan review requires a Plan session');
    if (session.running) throw new SessionError('SESSION_BUSY', 'session already has a running turn');
    session.running = true;
    try { return await runPlanReview({ question, models, sessionKey: session.id, thinking, timeoutSeconds }); }
    catch (error) { if (error instanceof PlanError) throw error; throw error; }
    finally { session.running = false; }
  }

  function listMessages(sessionId) {
    const session = getSession(sessionId);
    return Object.freeze(session.messages.map((message) => Object.freeze({ ...message })));
  }

  function closeSession(sessionId) {
    const session = getSession(sessionId);
    if (session.running) throw new SessionError('SESSION_BUSY', 'cannot close a running session');
    session.status = 'closed';
    return publicSession(session);
  }

  return Object.freeze({ createSession, getSession: (id) => publicSession(getSession(id)), sendMessage, planReview, listMessages, closeSession });
}
