import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readSnapshot, writeSnapshotAtomically } from './snapshot-store.mjs';

const DEFAULT_LIMIT = 500;
const MAX_EVENT_DATA_BYTES = 64 * 1024;

export class EventBusError extends Error {
  constructor(code, message) { super(message); this.name = 'EventBusError'; this.code = code; }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function normalizeEventData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new EventBusError('INVALID_EVENT_DATA', 'event data must be an object');
  let encoded;
  try { encoded = JSON.stringify(data); }
  catch { throw new EventBusError('INVALID_EVENT_DATA', 'event data must be JSON serializable'); }
  if (!encoded || Buffer.byteLength(encoded) > MAX_EVENT_DATA_BYTES) throw new EventBusError('EVENT_DATA_LIMIT', `event data must not exceed ${MAX_EVENT_DATA_BYTES} bytes`);
  const normalized = JSON.parse(encoded);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) throw new EventBusError('INVALID_EVENT_DATA', 'event data must be a JSON object');
  return deepFreeze(normalized);
}

export function createEventBus({ limit = DEFAULT_LIMIT, clock = () => new Date(), root, storePath = root ? join(root, '.openclaw-workbench', 'events.json') : undefined } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new EventBusError('INVALID_LIMIT', 'limit must be an integer between 1 and 10000');
  const events = [];
  const subscribers = new Set();
  let sequence = 0;
  let persistedDigest = null;
  function persist() {
    if (!storePath) return;
    persistedDigest = writeSnapshotAtomically({ root, storePath, payload: JSON.stringify({ version: 1, sequence, events }), expectedDigest: persistedDigest, ErrorType: EventBusError, code: 'EVENT_STORE_INVALID', message: 'event snapshot is invalid; refusing recovery', busyCode: 'EVENT_STORE_BUSY', busyMessage: 'event snapshot write is already in progress', conflictCode: 'EVENT_STORE_CONFLICT', conflictMessage: 'event snapshot changed outside this manager; refusing overwrite', temporaryName: randomUUID() });
  }
  function restore() {
    if (!storePath) return false;
    try {
      const stored = readSnapshot({ root, storePath, ErrorType: EventBusError, code: 'EVENT_STORE_INVALID', message: 'event snapshot is invalid; refusing recovery' });
      if (stored.content === null) return false;
      persistedDigest = stored.digest;
      const snapshot = JSON.parse(stored.content);
      if (snapshot?.version !== 1 || !Number.isInteger(snapshot.sequence) || snapshot.sequence < 0 || !Array.isArray(snapshot.events)) throw new Error('unsupported event snapshot');
      const ids = new Set();
      if (snapshot.events.length > limit) throw new Error('invalid event snapshot');
      for (const [index, event] of snapshot.events.entries()) {
        if (!event || typeof event.id !== 'string' || !event.id || ids.has(event.id) || !Number.isInteger(event.sequence) || event.sequence < 1 || event.sequence > snapshot.sequence || (index && event.sequence <= snapshot.events[index - 1].sequence) || typeof event.type !== 'string') throw new Error('invalid event snapshot');
        normalizeEventData(event.data);
        ids.add(event.id);
      }
      events.push(...snapshot.events.map((event) => Object.freeze({ ...event, data: normalizeEventData(event.data), recovered: true })));
      sequence = snapshot.sequence;
      return events.length > 0;
    } catch (error) {
      throw new EventBusError('EVENT_STORE_INVALID', 'event snapshot is invalid; refusing recovery');
    }
  }
  const recovered = restore();
  function publish({ type, sessionId, actionId, requestId, data = {} } = {}) {
    if (typeof type !== 'string' || !type || type.length > 128) throw new EventBusError('INVALID_EVENT_TYPE', 'event type is required and must be at most 128 characters');
    const normalizedData = normalizeEventData(data);
    const previousEvents = [...events];
    const previousSequence = sequence;
    const event = Object.freeze({ id: randomUUID(), sequence: ++sequence, type, ...(sessionId ? { sessionId } : {}), ...(actionId ? { actionId } : {}), ...(requestId ? { requestId } : {}), data: normalizedData, createdAt: clock().toISOString() });
    events.push(event);
    if (events.length > limit) events.splice(0, events.length - limit);
    try { persist(); } catch (error) { events.splice(0, events.length, ...previousEvents); sequence = previousSequence; throw error; }
    for (const subscriber of subscribers) {
      try { subscriber(event); } catch { /* 订阅者故障不得影响事件发布 */ }
    }
    return event;
  }
  function subscribe(listener, { after = 0 } = {}) {
    if (typeof listener !== 'function') throw new EventBusError('INVALID_SUBSCRIBER', 'subscriber must be a function');
    if (!Number.isSafeInteger(after) || after < 0) throw new EventBusError('INVALID_CURSOR', 'after must be a non-negative integer');
    const filtered = (event) => { if (event.sequence > after) listener(event); };
    subscribers.add(filtered);
    return () => subscribers.delete(filtered);
  }
  function list({ after = 0, limit: requestedLimit = 100 } = {}) {
    if (!Number.isInteger(after) || after < 0) throw new EventBusError('INVALID_CURSOR', 'after must be a non-negative integer');
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > limit) throw new EventBusError('INVALID_EVENT_LIMIT', `limit must be an integer between 1 and ${limit}`);
    const items = events.filter((event) => event.sequence > after).slice(0, requestedLimit);
    const earliestSequence = events.length ? events[0].sequence : sequence + 1;
    const cursorExpired = after > 0 && after < earliestSequence - 1;
    return Object.freeze({ events: Object.freeze([...items]), nextAfter: items.length ? items.at(-1).sequence : after, latestSequence: sequence, earliestSequence, cursorExpired, recovered });
  }
  function subscribeFrom(listener, { after = 0, limit: requestedLimit = Math.min(100, limit) } = {}) {
    const page = list({ after, limit: requestedLimit });
    const unsubscribe = subscribe(listener, { after: page.latestSequence });
    return Object.freeze({ page, unsubscribe });
  }
  return Object.freeze({ publish, list, subscribe, subscribeFrom, snapshotPath: storePath, recovered, retentionLimit: limit });
}
