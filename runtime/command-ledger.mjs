import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

function ledgerDirectory(root) {
  return path.resolve(root, '.openclaw-workbench', 'commands');
}

function safeName(value) { return `${value}.json`; }

export async function claimCommandAction({ root, action } = {}) {
  if (!root || !action?.actionHash) throw new Error('command action hash is required');
  const directory = ledgerDirectory(root);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, safeName(action.actionHash));
  const record = { actionId: action.id, actionHash: action.actionHash, sessionId: action.sessionId, status: 'claimed', claimedAt: new Date().toISOString() };
  try {
    const handle = await open(filePath, 'wx');
    try { await handle.writeFile(`${JSON.stringify(record)}\n`); }
    finally { await handle.close(); }
    return Object.freeze({ claimed: true, record: Object.freeze(record) });
  } catch (error) {
    if (error.code === 'EEXIST') return Object.freeze({ claimed: false, record: Object.freeze(JSON.parse(await readFile(filePath, 'utf8'))) });
    throw error;
  }
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
      results.push(Object.freeze({ ...record, ledgerPath: filePath, decision: 'manual_review' }));
    } catch (error) {
      results.push(Object.freeze({ actionHash: entry.name.slice(0, -5), decision: 'error', error: Object.freeze({ code: 'COMMAND_LEDGER_INVALID', message: error.message }), ledgerPath: filePath }));
    }
  }
  return Object.freeze(results);
}

export { ledgerDirectory };
