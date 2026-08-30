import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_LIMIT = 500;

export class EventBusError extends Error {
  constructor(code, message) { super(message); this.name = 'EventBusError'; this.code = code; }
}

export function createEventBus({ limit = DEFAULT_LIMIT, clock = () => new Date(), root, storePath = root ? join(root, '.openclaw-workbench', 'events.json') : undefined } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new EventBusError('INVALID_LIMIT', 'limit must be an integer between 1 and 10000');
  const events = [];
  let sequence = 0;
  function persist() {
    if (!storePath) return;
    mkdirSync(dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, sequence, events }), { mode: 0o600 });
    renameSync(temporary, storePath);
  }
  function restore() {
    if (!storePath) return false;
    try {
      const snapshot = JSON.parse(readFileSync(storePath, 'utf8'));
      if (snapshot?.version !== 1 || !Number.isInteger(snapshot.sequence) || snapshot.sequence < 0 || !Array.isArray(snapshot.events)) throw new Error('unsupported event snapshot');
      const ids = new Set();
      if (snapshot.events.length > limit) throw new Error('invalid event snapshot');
      for (const [index, event] of snapshot.events.entries()) {
        if (!event || typeof event.id !== 'string' || !event.id || ids.has(event.id) || !Number.isInteger(event.sequence) || event.sequence < 1 || event.sequence > snapshot.sequence || (index && event.sequence <= snapshot.events[index - 1].sequence) || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object') throw new Error('invalid event snapshot');
        ids.add(event.id);
      }
      events.push(...snapshot.events.map((event) => Object.freeze({ ...event, data: Object.freeze({ ...event.data }), recovered: true })));
      sequence = snapshot.sequence;
      return events.length > 0;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new EventBusError('EVENT_STORE_INVALID', 'event snapshot is invalid; refusing recovery');
    }
  }
  const recovered = restore();
  function publish({ type, sessionId, actionId, requestId, data = {} } = {}) {
    if (typeof type !== 'string' || !type || type.length > 128) throw new EventBusError('INVALID_EVENT_TYPE', 'event type is required and must be at most 128 characters');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new EventBusError('INVALID_EVENT_DATA', 'event data must be an object');
    const event = Object.freeze({ id: randomUUID(), sequence: ++sequence, type, ...(sessionId ? { sessionId } : {}), ...(actionId ? { actionId } : {}), ...(requestId ? { requestId } : {}), data: Object.freeze({ ...data }), createdAt: clock().toISOString() });
    events.push(event);
    if (events.length > limit) events.splice(0, events.length - limit);
    persist();
    return event;
  }
  function list({ after = 0, limit: requestedLimit = 100 } = {}) {
    if (!Number.isInteger(after) || after < 0) throw new EventBusError('INVALID_CURSOR', 'after must be a non-negative integer');
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > limit) throw new EventBusError('INVALID_EVENT_LIMIT', `limit must be an integer between 1 and ${limit}`);
    const items = events.filter((event) => event.sequence > after).slice(0, requestedLimit);
    return Object.freeze({ events: Object.freeze([...items]), nextAfter: items.length ? items.at(-1).sequence : after, latestSequence: sequence, recovered });
  }
  return Object.freeze({ publish, list, snapshotPath: storePath, recovered });
}
