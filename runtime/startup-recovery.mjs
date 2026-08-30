import path from 'node:path';
import { RecoveryError, finalizeAlreadyCommitted, inspectPendingTransaction, scanPendingTransactions, decideRecovery } from './recovery.mjs';
import { scanCommandLedger } from './command-ledger.mjs';

export async function scanStartupRecovery({ root, audit, onError, onScanError } = {}) {
  if (!root) throw new Error('root is required');
  let manifests;
  try { manifests = await scanPendingTransactions({ root, tolerateInvalid: true }); }
  catch (error) {
    const failure = Object.freeze({ transactionId: null, state: 'unknown', decision: 'error', finalized: false, error: Object.freeze({ code: error.code ?? 'SCAN_FAILED', message: error.message }) });
    let alertError;
    if (onScanError) {
      try { await onScanError(failure); }
      catch (callbackError) { alertError = Object.freeze({ code: callbackError.code ?? 'STARTUP_ALERT_FAILED', message: callbackError.message }); }
    }
    throw new RecoveryError('SCAN_FAILED', error.message, { cause: failure, ...(alertError ? { alertError } : {}) });
  }
  const results = [];
  for (const command of await scanCommandLedger({ root })) results.push(Object.freeze({ ...command, kind: 'command', finalized: false }));
  for (const manifest of manifests) {
    try {
      if (manifest.invalid) throw Object.assign(new Error(manifest.invalid.message), { code: manifest.invalid.code });
      const report = await inspectPendingTransaction({ root, manifest });
      const decision = decideRecovery(report);
      let finalized = false;
      if ((decision.decision === 'mark_committed' || manifest.state === 'finalize_failed') && manifest.manifestPath) {
        await finalizeAlreadyCommitted({ root, manifest, manifestPath: path.resolve(manifest.manifestPath), audit });
        finalized = true;
      }
      results.push(Object.freeze({ transactionId: manifest.transactionId, state: manifest.state, decision: decision.decision, finalized, report }));
    } catch (error) {
      const failure = { transactionId: manifest.transactionId, state: manifest.state, decision: 'error', finalized: false, error: Object.freeze({ code: error.code ?? 'STARTUP_RECOVERY_FAILED', message: error.message }) };
      if (onError) {
        try { await onError(Object.freeze({ ...failure })); }
        catch (callbackError) {
          failure.alertError = Object.freeze({ code: callbackError.code ?? 'STARTUP_ALERT_FAILED', message: callbackError.message });
        }
      }
      results.push(Object.freeze(failure));
    }
  }
  return Object.freeze(results);
}
