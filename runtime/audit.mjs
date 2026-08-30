import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
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

function inside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

async function safeAuditPath(root, filePath) {
  if (!root || !filePath || path.isAbsolute(filePath) || filePath.includes('\\') || filePath.split('/').includes('..')) throw new Error('audit_invalid_path');
  const realRoot = await realpath(root);
  const resolved = path.resolve(realRoot, filePath);
  if (!inside(realRoot, resolved)) throw new Error('audit_invalid_path');
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(resolved));
  if (!inside(realRoot, parent) || path.dirname(resolved) !== parent) throw new Error('audit_path_escape');
  const existing = await realpath(resolved).catch(() => null);
  if (existing && existing !== resolved) throw new Error('audit_path_escape');
  return resolved;
}

async function readAuditRecords(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('audit_invalid_file');
    return (await handle.readFile('utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } finally { await handle?.close().catch(() => {}); }
}

export async function createFileAuditLog({ root, filePath, clock = () => new Date() } = {}) {
  const safePath = await safeAuditPath(root, filePath);
  const lockPath = `${safePath}.lock`;
  async function withLock(operation) {
    let acquired = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { await mkdir(lockPath); acquired = true; break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    if (!acquired) throw new Error('audit_lock_timeout');
    try { return await operation(); }
    finally { await rm(lockPath, { recursive: true, force: true }); }
  }
  let previousHash = 'GENESIS';
  try {
    const records = await readAuditRecords(safePath);
    if (!verifyAuditChain(records)) throw new Error('audit_chain_invalid');
    if (records.length) previousHash = records.at(-1).recordHash;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return Object.freeze({
    async append(event) {
      if (!event || !event.type || !event.actor) throw new Error('audit_event_requires_type_and_actor');
      return withLock(async () => {
        let currentPreviousHash = 'GENESIS';
        try {
          const records = await readAuditRecords(safePath);
          if (!verifyAuditChain(records)) throw new Error('audit_chain_invalid');
          if (records.length) currentPreviousHash = records.at(-1).recordHash;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const timestamp = clock().toISOString();
        const record = { id: `${timestamp}-${Date.now()}`, timestamp, ...event, previousHash: currentPreviousHash };
        const recordHash = createHash('sha256').update(JSON.stringify(record)).digest('hex');
        const persisted = Object.freeze({ ...record, recordHash });
        const handle = await open(safePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(`${JSON.stringify(persisted)}\n`); await handle.sync(); }
        finally { await handle.close(); }
        previousHash = recordHash;
        return persisted;
      });
    },
    async list() {
      try { return (await readAuditRecords(safePath)).map((record) => Object.freeze(record)); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
  });
}
