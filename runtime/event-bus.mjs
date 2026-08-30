import { randomUUID } from 'node:crypto';

const DEFAULT_LIMIT = 500;

export class EventBusError extends Error {
  constructor(code, message) { super(message); this.name = 'EventBusError'; this.code = code; }
}

export function createEventBus({ limit = DEFAULT_LIMIT, clock = () => new Date() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new EventBusError('INVALID_LIMIT', 'limit must be an integer between 1 and 10000');
  const events = [];
  let sequence = 0;
  function publish({ type, sessionId, actionId, requestId, data = {} } = {}) {
    if (typeof type !== 'string' || !type || type.length > 128) throw new EventBusError('INVALID_EVENT_TYPE', 'event type is required and must be at most 128 characters');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new EventBusError('INVALID_EVENT_DATA', 'event data must be an object');
    const event = Object.freeze({ id: randomUUID(), sequence: ++sequence, type, ...(sessionId ? { sessionId } : {}), ...(actionId ? { actionId } : {}), ...(requestId ? { requestId } : {}), data: Object.freeze({ ...data }), createdAt: clock().toISOString() });
    events.push(event);
    if (events.length > limit) events.splice(0, events.length - limit);
    return event;
  }
  function list({ after = 0, limit: requestedLimit = 100 } = {}) {
    if (!Number.isInteger(after) || after < 0) throw new EventBusError('INVALID_CURSOR', 'after must be a non-negative integer');
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > limit) throw new EventBusError('INVALID_EVENT_LIMIT', `limit must be an integer between 1 and ${limit}`);
    const items = events.filter((event) => event.sequence > after).slice(0, requestedLimit);
    return Object.freeze({ events: Object.freeze([...items]), nextAfter: items.length ? items.at(-1).sequence : after, latestSequence: sequence });
  }
  return Object.freeze({ publish, list });
}
