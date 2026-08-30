import { link, mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function ledgerDirectory(root) {
  return path.resolve(root, '.openclaw-workbench', 'commands');
}

function safeName(value) { return /^[a-f0-9]{64}$/.test(value) ? `${value}.json` : null; }

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
  const directory = ledgerDirectory(root);
  await mkdir(directory, { recursive: true });
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
    catch (error) { await rm(temporaryPath, { force: true }); if (error.code !== 'EEXIST') throw error; return Object.freeze({ claimed: false, record: Object.freeze(JSON.parse(await readFile(filePath, 'utf8'))) }); }
    return Object.freeze({ claimed: true, record: Object.freeze(record) });
  } catch (error) {
    if (error.code === 'EEXIST') return Object.freeze({ claimed: false, record: Object.freeze(JSON.parse(await readFile(filePath, 'utf8'))) });
    throw error;
  }
}

export async function updateCommandAction({ root, actionHash, status, result, error } = {}) {
  const fileName = safeName(actionHash);
  if (!root || !fileName || !['executing', 'verified', 'failed', 'timed_out', 'cancelled'].includes(status)) throw new Error('invalid command ledger update');
  const filePath = path.join(ledgerDirectory(root), fileName);
  const current = JSON.parse(await readFile(filePath, 'utf8'));
  const updated = { ...current, status, ...(result ? { result } : {}), ...(error ? { error } : {}), updatedAt: new Date().toISOString() };
  await atomicWrite(filePath, updated, { replace: true });
  return Object.freeze(updated);
}

export async function scanCommandLedger({ root } = {}) {
  if (!root) throw new Error('root is required');
  const directory = ledgerDirectory(root);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const record = JSON.parse(await readFile(filePath, 'utf8'));
      results.push(Object.freeze({ ...record, ledgerPath: filePath, decision: record.status === 'verified' || record.status === 'failed' || record.status === 'timed_out' || record.status === 'cancelled' ? 'recorded' : 'manual_review' }));
    } catch (error) {
      results.push(Object.freeze({ actionHash: entry.name.slice(0, -5), decision: 'error', error: Object.freeze({ code: 'COMMAND_LEDGER_INVALID', message: error.message }), ledgerPath: filePath }));
    }
  }
  return Object.freeze(results);
}

export { ledgerDirectory };
