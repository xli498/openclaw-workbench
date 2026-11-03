// Secret-change action hashes (Q24-2).
//
// Rule, stated explicitly so a client can reproduce it without guessing:
// a secret-change request must carry `actionHash` equal to the digest the
// server computes for that exact operation, target, and current version:
//
//   secretActionHash({ operation, name, version })
//     = actionHash({ type: `secret.${operation}`, sessionId: 'secret',
//                    workspaceRevision: version, target: name,
//                    preview: null, risk: 'high' })
//
// `actionHash` is the repository's existing approval digest from
// action.mjs (SHA-256 over JSON.stringify of the input, in the field order
// above, which mirrors createAction's immutable fields). No new digest
// algorithm is invented here, and the secret value is never an input to
// the hash: the hash binds the operation, the target name, and the
// existence version, not the value being stored.
//
// `version` is the secret's existence state at check time, observed
// inside the server's secret lock:
//   'absent'  - the backend currently reports no such secret
//   'present' - the backend currently reports such a secret
// A client predicts it from GET /v1/secrets/<name> (`configured`); if
// the state changed between that read and the server's locked check,
// the hash no longer matches and the change is rejected instead of
// silently applying to a different version. Operations are 'create'
// (overwrite is false), 'overwrite' (overwrite is true), and 'delete'.
// A hash for the wrong operation, target, or version is rejected with
// SECRET_ACTION_HASH_MISMATCH (HTTP 409), exactly like the model-action
// hash mismatches elsewhere in this server.

import { actionHash } from './action.mjs';

export const SECRET_VERSION_ABSENT = 'absent';
export const SECRET_VERSION_PRESENT = 'present';

export function secretActionHash({ operation, name, version }) {
  if (!['create', 'overwrite', 'delete'].includes(operation)) throw new Error('secret operation is required');
  if (typeof name !== 'string' || !name) throw new Error('secret name is required');
  if (![SECRET_VERSION_ABSENT, SECRET_VERSION_PRESENT].includes(version)) throw new Error('secret version is required');
  return actionHash({ type: `secret.${operation}`, sessionId: 'secret', workspaceRevision: version, target: name, preview: null, risk: 'high' });
}

export function secretVersionOf(exists) {
  return exists ? SECRET_VERSION_PRESENT : SECRET_VERSION_ABSENT;
}
