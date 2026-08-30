import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function createAuditLog({ clock = () => new Date() } = {}) {
  const events = [];
  return Object.freeze({
    append(event) {
      if (!event || !event.type || !event.actor) throw new Error('audit_event_requires_type_and_actor');
      const timestamp = clock().toISOString();
      const record = Object.freeze({
        id: `${timestamp}-${events.length + 1}`,
        timestamp,
        ...event,
      });
      events.push(record);
      return record;
    },
    list() { return events.slice(); },
  });
}

export function verifyAuditChain(records) {
  let previousHash = 'GENESIS';
  for (const record of records ?? []) {
    if (record.previousHash !== previousHash || !record.recordHash) return false;
    const { recordHash, ...body } = record;
    const expected = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (expected !== recordHash) return false;
    previousHash = recordHash;
  }
  return true;
}

export async function createFileAuditLog({ filePath, clock = () => new Date() } = {}) {
  if (!filePath || path.isAbsolute(filePath) === false && filePath.includes('..')) throw new Error('audit_invalid_path');
  await mkdir(path.dirname(filePath), { recursive: true });
  let previousHash = 'GENESIS';
  try {
    const content = await readFile(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length) previousHash = JSON.parse(lines.at(-1)).recordHash;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return Object.freeze({
    async append(event) {
      if (!event || !event.type || !event.actor) throw new Error('audit_event_requires_type_and_actor');
      const timestamp = clock().toISOString();
      const record = { id: `${timestamp}-${Date.now()}`, timestamp, ...event, previousHash };
      const recordHash = createHash('sha256').update(JSON.stringify(record)).digest('hex');
      const persisted = Object.freeze({ ...record, recordHash });
      await appendFile(filePath, `${JSON.stringify(persisted)}\n`, { encoding: 'utf8', flag: 'a' });
      previousHash = recordHash;
      return persisted;
    },
    async list() {
      try { return (await readFile(filePath, 'utf8')).split('\n').filter(Boolean).map((line) => Object.freeze(JSON.parse(line))); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
  });
}
