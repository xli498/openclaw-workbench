import { constants } from 'node:fs';
import { link, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function ledgerDirectory(root) {
  return path.resolve(root, '.openclaw-workbench', 'commands');
}

function inside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target.startsWith(`${base}${path.sep}`);
}

function safeName(value) { return /^[a-f0-9]{64}$/.test(value) ? `${value}.json` : null; }

async function safeLedgerDirectory(root) {
  const resolvedRoot = await realpath(root);
  const directory = ledgerDirectory(resolvedRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resolvedDirectory = await realpath(directory);
  if (!inside(resolvedRoot, resolvedDirectory) || resolvedDirectory !== directory) throw new Error('command ledger directory escapes root');
  return { root: resolvedRoot, directory: resolvedDirectory };
}

async function existingLedgerDirectory(root) {
  const resolvedRoot = await realpath(root);
  const expected = ledgerDirectory(resolvedRoot);
  const directory = await realpath(expected).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!directory) return null;
  if (!inside(resolvedRoot, directory) || directory !== expected) throw new Error('command ledger directory escapes root');
  return directory;
}

async function readLedgerRecord(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('command ledger record must be a regular file');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle?.close().catch(() => {}); }
}

function assertRecordMatchesAction(record, action) {
  if (!record || record.actionId !== action.id || record.actionHash !== action.actionHash || record.sessionId !== action.sessionId || JSON.stringify(record.command) !== JSON.stringify(action.preview)) {
    throw new Error('command ledger record does not match action');
  }
  if (!['claimed', 'executing', 'verified', 'failed', 'timed_out', 'cancelled'].includes(record.status)) throw new Error('command ledger record has invalid status');
  return record;
}

async function atomicWrite(filePath, value, { replace = false } = {}) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  try { if (replace) await rename(temporaryPath, filePath); else { await link(temporaryPath, filePath); await unlink(temporaryPath); } }
  catch (error) { await rm(temporaryPath, { force: true }); throw error; }
}

export async function claimCommandAction({ root, action } = {}) {
  if (!root || !action?.actionHash) throw new Error('command action hash is required');
  const { directory } = await safeLedgerDirectory(root);
  const fileName = safeName(action.actionHash);
  if (!fileName) throw new Error('invalid command action hash');
  const filePath = path.join(directory, fileName);
  const record = { actionId: action.id, actionHash: action.actionHash, sessionId: action.sessionId, status: 'claimed', claimedAt: new Date().toISOString(), command: action.preview };
  try {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx');
    try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temporaryPath, filePath); await unlink(temporaryPath); }
    catch (error) { await rm(temporaryPath, { force: true }); if (error.code !== 'EEXIST') throw error; return Object.freeze({ claimed: false, record: Object.freeze(assertRecordMatchesAction(await readLedgerRecord(filePath), action)) }); }
    return Object.freeze({ claimed: true, record: Object.freeze(record) });
  } catch (error) {
    if (error.code === 'EEXIST') return Object.freeze({ claimed: false, record: Object.freeze(assertRecordMatchesAction(await readLedgerRecord(filePath), action)) });
    throw error;
  }
}

export async function updateCommandAction({ root, actionHash, status, result, error } = {}) {
  const fileName = safeName(actionHash);
  if (!root || !fileName || !['executing', 'verified', 'failed', 'timed_out', 'cancelled'].includes(status)) throw new Error('invalid command ledger update');
  const { directory } = await safeLedgerDirectory(root);
  const filePath = path.join(directory, fileName);
  const current = await readLedgerRecord(filePath);
  const updated = { ...current, status, ...(result ? { result } : {}), ...(error ? { error } : {}), updatedAt: new Date().toISOString() };
  await atomicWrite(filePath, updated, { replace: true });
  return Object.freeze(updated);
}

export async function scanCommandLedger({ root } = {}) {
  if (!root) throw new Error('root is required');
  const directory = await existingLedgerDirectory(root);
  if (!directory) return Object.freeze([]);
  const entries = await readdir(directory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const record = await readLedgerRecord(filePath);
      if (!safeName(record.actionHash) || !record.actionId || !record.sessionId || !['claimed', 'executing', 'verified', 'failed', 'timed_out', 'cancelled'].includes(record.status)) throw new Error('invalid command ledger record');
      results.push(Object.freeze({ ...record, ledgerPath: filePath, decision: record.status === 'verified' || record.status === 'failed' || record.status === 'timed_out' || record.status === 'cancelled' ? 'recorded' : 'manual_review' }));
    } catch (error) {
      results.push(Object.freeze({ actionHash: entry.name.slice(0, -5), decision: 'error', error: Object.freeze({ code: 'COMMAND_LEDGER_INVALID', message: error.message }), ledgerPath: filePath }));
    }
  }
  return Object.freeze(results);
}

export { ledgerDirectory };
