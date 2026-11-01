import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createLspClient, collectWorkspaceEditProposal, convertLspPositionToUtf16, convertLspPositionFromUtf16 } from '../runtime/lsp-client.mjs';
import { createLspServerRegistry } from '../runtime/lsp-server-registry.mjs';

// NOTE ON THE EDIT PATH (read before touching it): an edit proposal is
// data, never an instruction to write. Nothing in this file, in
// lsp-client.mjs, or in the mock server writes a proposal to disk: the
// only file the tests create is their own fixture, written directly by
// the test with writeFile and asserted byte-identical afterwards.
// Landing a proposal on disk must go through the repository's existing
// Patch proposal + independent approval flow. Writing a proposal
// straight to disk would bypass that approval gate and is a bug.
const FIXTURE = new URL('./fixtures/mock-lsp-doc-server.mjs', import.meta.url).pathname;

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function hoverReport(client, uri) {
  const result = await client.request('textDocument/hover', {
    textDocument: { uri },
    position: { line: 0, character: 0 },
  });
  return JSON.parse(result.contents.value);
}

test('doc sync: open/change (full + incremental UTF-16)/close with version tracking and rollback rejection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-doc-'));
  const uri = `file://${root}/a.txt`;
  const client = createLspClient({ command: process.execPath, args: [FIXTURE], root });
  try {
    await client.start();
    client.didOpen(uri, 'plaintext', 'a\u{1F600}b');
    assert.equal(client.getOpenDocument(uri).version, 0);
    assert.equal(client.getOpenDocument(uri).text, 'a\u{1F600}b');
    // The emoji is one glyph but two UTF-16 code units: characters 1..3
    // cover exactly the emoji, so replacing them yields 'aXb'.
    client.didChange(uri, [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, text: 'X' }]);
    assert.equal(client.getOpenDocument(uri).version, 1);
    assert.equal(client.getOpenDocument(uri).text, 'aXb');
    client.didChange(uri, 'hello\nworld');
    assert.equal(client.getOpenDocument(uri).version, 2);
    assert.equal(client.getOpenDocument(uri).text, 'hello\nworld');
    client.didChange(uri, [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, text: 'there' }]);
    assert.equal(client.getOpenDocument(uri).version, 3);
    assert.equal(client.getOpenDocument(uri).text, 'hello\nthere');
    // Version must strictly increase: equal and lower versions rejected.
    assert.throws(() => client.didChange(uri, 'x', 3), { code: 'LSP_DOCUMENT_VERSION_INVALID' });
    assert.throws(() => client.didChange(uri, 'x', 2), { code: 'LSP_DOCUMENT_VERSION_INVALID' });
    assert.equal(client.getOpenDocument(uri).text, 'hello\nthere');
    client.didChange(uri, 'v10', 10);
    assert.equal(client.getOpenDocument(uri).version, 10);
    assert.throws(() => client.didOpen(uri, 'plaintext', 'again'), { code: 'LSP_DOCUMENT_ALREADY_OPEN' });
    assert.equal(client.listOpenDocuments().length, 1);
    const report = await hoverReport(client, uri);
    assert.equal(report.counts.didOpen, 1);
    assert.ok(report.counts.didChange >= 4);
    client.didClose(uri);
    assert.equal(client.getOpenDocument(uri), null);
    assert.deepEqual(client.listOpenDocuments(), []);
    assert.throws(() => client.didClose(uri), { code: 'LSP_DOCUMENT_NOT_OPEN' });
    // Reopening after close starts a fresh version track.
    client.didOpen(uri, 'plaintext', 'fresh', 3);
    assert.equal(client.getOpenDocument(uri).version, 3);
    client.didChange(uri, 'fresh2');
    assert.equal(client.getOpenDocument(uri).version, 4);
    assert.deepEqual(await client.shutdown(), { status: 'closed' });
  } finally {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('doc sync: out-of-root URIs rejected, localhost form accepted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-uri-'));
  const client = createLspClient({ command: process.execPath, args: [FIXTURE], root });
  try {
    await client.start();
    assert.throws(() => client.didOpen('file:///etc/passwd', 'plaintext', 'x'), { code: 'LSP_URI_OUT_OF_ROOT' });
    assert.throws(() => client.didOpen(`file://${root}/../evil.txt`, 'plaintext', 'x'), { code: 'LSP_URI_OUT_OF_ROOT' });
    assert.throws(() => client.didOpen(`file://evil.example.com${root}/x.txt`, 'plaintext', 'x'), { code: 'LSP_URI_OUT_OF_ROOT' });
    assert.throws(() => client.didOpen('https://example.com/x.txt', 'plaintext', 'x'), { code: 'LSP_URI_OUT_OF_ROOT' });
    assert.throws(() => client.didOpen('file:///etc%2Fpasswd', 'plaintext', 'x'), { code: 'LSP_URI_OUT_OF_ROOT' });
    assert.throws(() => client.getDiagnostics('file:///etc/passwd'), { code: 'LSP_URI_OUT_OF_ROOT' });
    assert.equal(client.listOpenDocuments().length, 0);
    const okUri = `file://localhost${root}/ok.txt`;
    client.didOpen(okUri, 'plaintext', 'ok');
    assert.equal(client.getOpenDocument(okUri).text, 'ok');
    assert.deepEqual(await client.shutdown(), { status: 'closed' });
  } finally {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('doc sync: content limit rejects without sending or recording', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-limit-'));
  const uri = `file://${root}/big.txt`;
  const client = createLspClient({ command: process.execPath, args: [FIXTURE], root, maxDocumentBytes: 10 });
  try {
    await client.start();
    assert.throws(() => client.didOpen(uri, 'plaintext', 'this text is far too long'), { code: 'LSP_DOCUMENT_LIMIT' });
    assert.equal(client.getOpenDocument(uri), null);
    client.didOpen(uri, 'plaintext', 'tiny');
    assert.equal(client.getOpenDocument(uri).text, 'tiny');
    assert.throws(() => client.didChange(uri, 'this replacement is far too long'), { code: 'LSP_DOCUMENT_LIMIT' });
    assert.equal(client.getOpenDocument(uri).text, 'tiny');
    assert.equal(client.getOpenDocument(uri).version, 0);
    const report = await hoverReport(client, uri);
    assert.equal(report.counts.didOpen, 1);
    assert.equal(report.counts.didChange, 0);
    assert.deepEqual(await client.shutdown(), { status: 'closed' });
  } finally {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('doc sync: failed send never updates local state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-nosend-'));
  const uri = `file://${root}/x.txt`;
  const client = createLspClient({ command: process.execPath, args: [FIXTURE], root });
  try {
    // Never started: the send fails, and no document is recorded.
    assert.throws(() => client.didOpen(uri, 'plaintext', 'x'), { code: 'LSP_NOT_STARTED' });
    assert.equal(client.getOpenDocument(uri), null);
    assert.deepEqual(client.listOpenDocuments(), []);
  } finally {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnostics: collected per URI, whitelisted, redacted, capped, truncated; out-of-root discarded', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-diag-'));
  const uri = `file://${root}/d.txt`;
  const client = createLspClient({
    command: process.execPath, args: [FIXTURE], root,
    maxDiagnosticsPerUri: 2, maxDiagnosticMessageChars: 20,
  });
  try {
    await client.start();
    client.didOpen(uri, 'plaintext', 'hello');
    await waitFor(() => client.getDiagnostics(uri).length === 2, 'diagnostics to arrive');
    const stored = client.getDiagnostics(uri);
    assert.equal(stored.length, 2, 'per-URI cap keeps only the first 2 of 3');
    assert.ok(stored[0].message.includes('[redacted]'));
    assert.ok(!stored[0].message.includes('should-be-redacted'));
    assert.ok(!stored[0].message.includes('abcdef123456'));
    assert.ok(!stored[0].message.includes('user:pass'));
    assert.ok(!('extraField' in stored[0]), 'non-whitelisted fields are dropped');
    assert.deepEqual(Object.keys(stored[0]).sort(), ['code', 'message', 'range', 'severity', 'source']);
    assert.equal(stored[1].message.length, 20, 'over-long message truncated to the char cap');
    assert.deepEqual(client.getDiagnostics(`file://${root}/unknown.txt`), []);
    const all = client.getAllDiagnostics();
    assert.ok(!(Object.keys(all).includes('file:///etc/passwd')), 'out-of-root diagnostic discarded');
    assert.ok(Object.keys(all).includes(uri));
    assert.deepEqual(await client.shutdown(), { status: 'closed' });
  } finally {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('applyEdit with handler yields only a frozen proposal and leaves the target file untouched', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-edit-'));
  const targetPath = path.join(root, 'target.txt');
  await writeFile(targetPath, 'ORIGINAL', 'utf8');
  const targetUri = `file://${targetPath}`;
  let seenProposal = null;
  const client = createLspClient({
    command: process.execPath, args: [FIXTURE, targetUri], root,
    editProposalHandler: (proposal) => {
      seenProposal = proposal;
      return { applied: true, note: 'proposal-only' };
    },
  });
  try {
    await client.start();
    await hoverReport(client, targetUri); // first hover triggers the mock applyEdit request
    await waitFor(async () => {
      const report = await hoverReport(client, targetUri);
      return report.lastApplyEditResponse !== null;
    }, 'applyEdit response to be recorded');
    const report = await hoverReport(client, targetUri);
    assert.deepEqual(report.lastApplyEditResponse, { result: { applied: true, note: 'proposal-only' } });
    assert.ok(seenProposal, 'handler received a proposal');
    assert.ok(Object.isFrozen(seenProposal));
    assert.equal(seenProposal.label, 'mock-edit');
    assert.equal(seenProposal.files.length, 1);
    assert.equal(seenProposal.files[0].uri, targetUri);
    assert.equal(seenProposal.files[0].version, null);
    assert.deepEqual(seenProposal.files[0].edits, [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'INSERTED' },
    ]);
    assert.equal(await readFile(targetPath, 'utf8'), 'ORIGINAL', 'proposal alone must not modify the file');
    assert.deepEqual(await client.shutdown(), { status: 'closed' });
  } finally {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('applyEdit with handler returning undefined answers {applied:false}; without handler answers -32601', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-edit2-'));
  const targetUri = `file://${root}/target.txt`;
  const withUndefined = createLspClient({
    command: process.execPath, args: [FIXTURE, targetUri], root,
    editProposalHandler: () => undefined,
  });
  const withoutHandler = createLspClient({
    command: process.execPath, args: [FIXTURE, targetUri], root,
  });
  try {
    await withUndefined.start();
    await hoverReport(withUndefined, targetUri);
    await waitFor(async () => (await hoverReport(withUndefined, targetUri)).lastApplyEditResponse !== null, 'undefined-handler response');
    assert.deepEqual((await hoverReport(withUndefined, targetUri)).lastApplyEditResponse, { result: { applied: false } });
    await withUndefined.shutdown();

    await withoutHandler.start();
    await hoverReport(withoutHandler, targetUri);
    await waitFor(async () => (await hoverReport(withoutHandler, targetUri)).lastApplyEditResponse !== null, 'no-handler response');
    assert.equal((await hoverReport(withoutHandler, targetUri)).lastApplyEditResponse.error.code, -32601);
    await withoutHandler.shutdown();
  } finally {
    await withUndefined.close().catch(() => {});
    await withoutHandler.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('collectWorkspaceEditProposal: normalization and rejection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-proposal-'));
  try {
    const uri = `file://${root}/a.txt`;
    const other = `file://${root}/b.txt`;
    // applyEdit frame form, with label.
    const fromFrame = collectWorkspaceEditProposal({
      jsonrpc: '2.0', id: 7, method: 'workspace/applyEdit',
      params: { label: 'fix', edit: { changes: { [uri]: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, newText: 'new' }] } } },
    }, { root });
    assert.equal(fromFrame.label, 'fix');
    assert.deepEqual(fromFrame.files, [{ uri, version: null, edits: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, newText: 'new' }] }]);
    assert.ok(Object.isFrozen(fromFrame) && Object.isFrozen(fromFrame.files));
    // Bare documentChanges form, with version.
    const fromDocChanges = collectWorkspaceEditProposal({
      documentChanges: [{ textDocument: { uri: other, version: 4 }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '' }] }],
    }, { root });
    assert.equal(fromDocChanges.files[0].version, 4);
    assert.equal(fromDocChanges.files[0].edits[0].newText, '');
    assert.ok(!('label' in fromDocChanges));
    // Empty edits rejected.
    assert.throws(() => collectWorkspaceEditProposal({}, { root }), { code: 'LSP_EDIT_INVALID' });
    assert.throws(() => collectWorkspaceEditProposal({ changes: {} }, { root }), { code: 'LSP_EDIT_INVALID' });
    assert.throws(() => collectWorkspaceEditProposal({ documentChanges: [] }, { root }), { code: 'LSP_EDIT_INVALID' });
    assert.throws(() => collectWorkspaceEditProposal({ changes: { [uri]: [] } }, { root }), { code: 'LSP_EDIT_INVALID' });
    // Both shapes at once rejected.
    assert.throws(() => collectWorkspaceEditProposal({
      changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' }] },
      documentChanges: [{ textDocument: { uri, version: 1 }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' }] }],
    }, { root }), { code: 'LSP_EDIT_INVALID' });
    // create/rename/delete documentChanges are proposalized (data only),
    // never applied: the landing path still needs Patch approval.
    const onlyOps = collectWorkspaceEditProposal({
      documentChanges: [
        { kind: 'create', uri, options: { overwrite: false } },
        { kind: 'rename', oldUri: uri, newUri: other },
        { kind: 'delete', uri: other, options: { recursive: true } },
      ],
    }, { root });
    assert.deepEqual(onlyOps.files, []);
    assert.deepEqual(onlyOps.fileOperations, [
      { kind: 'create', uri, options: { overwrite: false } },
      { kind: 'rename', oldUri: uri, newUri: other },
      { kind: 'delete', uri: other, options: { recursive: true } },
    ]);
    assert.ok(Object.isFrozen(onlyOps) && Object.isFrozen(onlyOps.fileOperations));
    // Unknown kinds stay rejected, never silently dropped or reinterpreted.
    assert.throws(() => collectWorkspaceEditProposal({ documentChanges: [{ kind: 'move', uri }] }, { root }), { code: 'LSP_EDIT_UNSUPPORTED' });
    // File-operation URIs obey the same workspace-root boundary as edits.
    assert.throws(() => collectWorkspaceEditProposal({ documentChanges: [{ kind: 'create', uri: 'file:///etc/passwd' }] }, { root }), { code: 'LSP_URI_OUT_OF_ROOT' });
    assert.throws(() => collectWorkspaceEditProposal({ documentChanges: [{ kind: 'rename', oldUri: uri, newUri: 'file:///etc/passwd' }] }, { root }), { code: 'LSP_URI_OUT_OF_ROOT' });
    // Non-boolean options and unknown option keys rejected.
    assert.throws(() => collectWorkspaceEditProposal({ documentChanges: [{ kind: 'create', uri, options: { overwrite: 'yes' } }] }, { root }), { code: 'LSP_EDIT_INVALID' });
    assert.throws(() => collectWorkspaceEditProposal({ documentChanges: [{ kind: 'delete', uri, options: { force: true } }] }, { root }), { code: 'LSP_EDIT_INVALID' });
    // Mixed text edits + file operations keep server order in one proposal.
    const mixed = collectWorkspaceEditProposal({
      label: 'mixed',
      documentChanges: [
        { textDocument: { uri, version: 2 }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' }] },
        { kind: 'rename', oldUri: uri, newUri: other },
      ],
    }, { root });
    assert.equal(mixed.label, 'mixed');
    assert.equal(mixed.files.length, 1);
    assert.deepEqual(mixed.fileOperations, [{ kind: 'rename', oldUri: uri, newUri: other }]);
    // Out-of-root, bad range, non-string newText rejected.
    assert.throws(() => collectWorkspaceEditProposal({ changes: { 'file:///etc/passwd': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' }] } }, { root }), { code: 'LSP_URI_OUT_OF_ROOT' });
    assert.throws(() => collectWorkspaceEditProposal({ changes: { [uri]: [{ range: { start: { line: 1, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' }] } }, { root }), { code: 'LSP_EDIT_INVALID' });
    assert.throws(() => collectWorkspaceEditProposal({ changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 42 }] } }, { root }), { code: 'LSP_EDIT_INVALID' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server registry: config-only registration, lookup, and rejection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-registry-'));
  try {
    const registry = createLspServerRegistry({ root });
    assert.equal(registry.getWorkspaceRoot(), root);
    const entry = registry.register({ id: 'pyright', languageIds: ['python'], command: process.execPath, args: ['--stdio'] });
    assert.equal(entry.root, root, 'server root defaults to the workspace root');
    assert.equal(entry.command, process.execPath);
    assert.ok(Object.isFrozen(entry));
    registry.register({ id: 'ts', languageIds: ['typescript', 'javascript'], command: process.execPath, root: 'sub' });
    assert.equal(registry.get('ts').root, path.join(root, 'sub'), 'relative server root resolves against the workspace root');
    assert.equal(registry.get('missing'), null);
    assert.equal(registry.list().length, 2);
    assert.deepEqual(registry.getForLanguage('python').map((item) => item.id), ['pyright']);
    assert.deepEqual(registry.getForLanguage('rust'), []);
    assert.deepEqual(await readdir(root), [], 'registry spawns nothing and writes nothing');
    assert.throws(() => registry.register({ id: 'pyright', languageIds: ['python'], command: process.execPath }), { code: 'LSP_SERVER_DUPLICATE' });
    assert.throws(() => registry.register({ id: 'bad;id', languageIds: ['x'], command: process.execPath }), { code: 'LSP_SERVER_INVALID' });
    assert.throws(() => registry.register({ id: '', languageIds: ['x'], command: process.execPath }), { code: 'LSP_SERVER_INVALID' });
    assert.throws(() => registry.register({ id: 'a'.repeat(65), languageIds: ['x'], command: process.execPath }), { code: 'LSP_SERVER_INVALID' });
    assert.throws(() => registry.register({ id: 'shell', languageIds: ['x'], command: 'node; rm -rf /' }), { code: 'LSP_COMMAND_INVALID' });
    assert.throws(() => registry.register({ id: 'tok', languageIds: ['x'], command: process.execPath, args: ['--token=<redacted>'] }), { code: 'LSP_ARGS_INVALID' });
    assert.throws(() => registry.register({ id: 'env', languageIds: ['x'], command: process.execPath, env: { 'bad-key': 'v' } }), { code: 'LSP_ENV_INVALID' });
    assert.throws(() => registry.register({ id: 'esc', languageIds: ['x'], command: process.execPath, root: '/etc' }), { code: 'LSP_SERVER_ROOT_OUT_OF_ROOT' });
    assert.throws(() => registry.register({ id: 'esc2', languageIds: ['x'], command: process.execPath, root: '../outside' }), { code: 'LSP_SERVER_ROOT_OUT_OF_ROOT' });
    assert.throws(() => registry.register({ id: 'nolang', languageIds: [], command: process.execPath }), { code: 'LSP_SERVER_INVALID' });
    // Initial servers list validated the same way.
    assert.throws(() => createLspServerRegistry({
      root,
      servers: [
        { id: 'dup', languageIds: ['x'], command: process.execPath },
        { id: 'dup', languageIds: ['x'], command: process.execPath },
      ],
    }), { code: 'LSP_SERVER_DUPLICATE' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('position encoding: pure UTF-8/UTF-32/UTF-16 conversion aligns on code-point boundaries', () => {
  // Line: 'a' + emoji (UTF-16: 2 units, UTF-8: 4 bytes, UTF-32: 1 unit) + 'b'.
  const line = 'a\u{1F600}b';
  assert.equal(convertLspPositionToUtf16(line, 5, 'utf-8'), 3);
  assert.equal(convertLspPositionToUtf16(line, 2, 'utf-32'), 3);
  assert.equal(convertLspPositionToUtf16(line, 3, 'utf-16'), 3);
  assert.equal(convertLspPositionFromUtf16(line, 3, 'utf-8'), 5);
  assert.equal(convertLspPositionFromUtf16(line, 3, 'utf-32'), 2);
  // BMP non-ASCII: 'e-acute' is 1 UTF-16 unit, 2 UTF-8 bytes, 1 UTF-32 unit.
  assert.equal(convertLspPositionToUtf16('éx', 2, 'utf-8'), 1);
  assert.equal(convertLspPositionFromUtf16('éx', 1, 'utf-8'), 2);
  // Mid-code-point positions have no alignment and are rejected.
  assert.throws(() => convertLspPositionToUtf16(line, 2, 'utf-8'), { code: 'LSP_POSITION_INVALID' });
  assert.throws(() => convertLspPositionToUtf16(line, 3, 'utf-8'), { code: 'LSP_POSITION_INVALID' });
  assert.throws(() => convertLspPositionFromUtf16(line, 2, 'utf-8'), { code: 'LSP_POSITION_INVALID' });
  assert.throws(() => convertLspPositionToUtf16(line, 99, 'utf-8'), { code: 'LSP_POSITION_INVALID' });
  assert.throws(() => convertLspPositionToUtf16(line, 0, 'utf-7'), { code: 'LSP_POSITION_INVALID' });
  // ASCII is identical in all three encodings.
  assert.equal(convertLspPositionToUtf16('hello', 3, 'utf-8'), 3);
  assert.equal(convertLspPositionToUtf16('hello', 3, 'utf-32'), 3);
});

test('position encoding: UTF-8 server negotiation converts didChange locally, forwards negotiated units', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-enc-'));
  const uri = `file://${root}/a.txt`;
  const fixture = new URL('./fixtures/mock-lsp-position-encoding-server.mjs', import.meta.url).pathname;
  const client = createLspClient({ command: process.execPath, args: [fixture], root });
  try {
    await client.start();
    assert.equal(client.getPositionEncoding(), 'utf-8');
    client.didOpen(uri, 'plaintext', 'a\u{1F600}b');
    // Mid-emoji UTF-8 offset (byte 2 of the 4-byte sequence) is rejected
    // before any send or local update.
    assert.throws(() => client.didChange(uri, [{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } }, text: 'Y' }]), { code: 'LSP_POSITION_INVALID' });
    assert.equal(client.getOpenDocument(uri).text, 'a\u{1F600}b');
    // UTF-8 units: 'a' = 1 byte, emoji = 4 bytes, so 'b' starts at byte 5.
    client.didChange(uri, [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 5 } }, text: 'X' }]);
    assert.equal(client.getOpenDocument(uri).text, 'aXb');
    const report = JSON.parse((await client.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 0 } })).contents.value);
    assert.equal(report.didChangeCount, 1);
    // The server was told UTF-8 units, not the UTF-16 units used locally.
    assert.deepEqual(report.lastContentChanges, [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 5 } }, text: 'X' }]);
    assert.deepEqual(await client.shutdown(), { status: 'closed' });
  } finally {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
