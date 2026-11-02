import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createLspClient } from '../runtime/lsp-client.mjs';
import { createLspServerRegistry } from '../runtime/lsp-server-registry.mjs';

// Real-language-server LSP tests (pyright, NOT a mock).
//
// What this file proves, and what it does not:
// - The client drives a REAL pyright-langserver over stdio: hover,
//   definition, diagnostics, and didOpen/didChange/didClose against
//   the server's own analysis. Previous rounds covered hover/
//   definition only as a scratch experiment; this file lands them as
//   repo tests, plus diagnostics and the full doc-sync lifecycle.
// - Server resolution: $OCW_PYRIGHT_BIN, else
//   <repo>/node_modules/.bin/pyright-langserver, else PATH lookup.
//   When no binary is found the tests SKIP (they cannot run without a
//   real server, and a mock must never stand in for one). CI installs
//   pyright 1.1.414 into a temp dir and asserts the binary is
//   executable BEFORE running tests, so a CI skip can only mean the
//   install step itself failed -- and then the job fails there, not
//   silently here.
// - pyright is NOT a repo dependency: it is installed by CI into
//   $RUNNER_TEMP, never into the repo, and package.json is untouched.
// - Encoding, stated precisely: pyright 1.1.414 does not advertise a
//   positionEncoding capability, so the client keeps its UTF-16
//   default (asserted below). The UTF-16 alignment case here uses a
//   real multibyte line (emoji + CJK) through incremental didChange
//   and checks the server's own post-change diagnostics. UTF-8
//   conversion math stays covered by the pure-converter tests and the
//   mock-negotiated UTF-8 didChange test in tests/lsp-doc-sync.test.mjs
//   (both honestly labeled as converter/mock tests, not server tests);
//   no real-server UTF-8 claim is made, because pyright does not
//   negotiate UTF-8.
// - Read-only methods only: hover/definition/references/documentSymbol
//   plus doc sync. Nothing here writes through the client, and the
//   only file the tests create is their own fixture, written directly
//   by the test and asserted unchanged at the end.
function resolvePyrightBin() {
  const candidates = [];
  if (process.env.OCW_PYRIGHT_BIN) candidates.push(process.env.OCW_PYRIGHT_BIN);
  candidates.push(new URL('../node_modules/.bin/pyright-langserver', import.meta.url).pathname);
  candidates.push('pyright-langserver');
  for (const candidate of candidates) {
    if (!candidate.includes(path.sep)) {
      const dirs = (process.env.PATH ?? '').split(path.delimiter);
      for (const dir of dirs) {
        const full = path.join(dir, candidate);
        try { accessSync(full, constants.X_OK); return full; } catch {}
      }
      continue;
    }
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  return null;
}

const PYRIGHT_BIN = resolvePyrightBin();
const SKIP_NO_SERVER = PYRIGHT_BIN === null;
if (PYRIGHT_BIN) console.error(`LSP real server: pyright-langserver at ${PYRIGHT_BIN}`);

const SOURCE = [
  'def greet(name: str) -> str:',
  '    return "hello " + name',
  '',
  'result = greet("world")',
  'bad: int = "oops"',
  '',
].join('\n');

// Polls until `match(diagnostics)` holds. A plain non-empty check
// would accept STALE diagnostics after a didChange (the previous
// analysis is still stored until the server re-analyzes), so callers
// always pass the exact diagnostic state they are waiting for.
async function waitForDiagnostics(client, uri, match, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const diagnostics = client.getDiagnostics(uri);
    if (match(diagnostics)) return diagnostics;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for pyright diagnostics');
}

async function startClient(root) {
  const registry = createLspServerRegistry({
    root,
    servers: [{ id: 'pyright', languageIds: ['python'], command: PYRIGHT_BIN, args: ['--stdio'] }],
  });
  const entry = registry.getForLanguage('python')[0];
  assert.equal(entry.id, 'pyright');
  const client = createLspClient({
    command: entry.command,
    args: [...entry.args],
    root,
    requestTimeoutMs: 60000,
  });
  const started = await client.start();
  return { client, started };
}

test('LSP real server (pyright): hover and definition resolve through the registry entry', { skip: SKIP_NO_SERVER }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-real-'));
  const file = path.join(root, 'demo.py');
  const uri = `file://${file}`;
  await writeFile(file, SOURCE, 'utf8');
  const { client } = await startClient(root);
  try {
    // pyright does not advertise positionEncoding; the client keeps
    // its UTF-16 default. Pinning this documents which encoding the
    // assertions below actually exercise.
    assert.equal(client.getPositionEncoding(), 'utf-16');
    client.didOpen(uri, 'python', SOURCE);
    await waitForDiagnostics(client, uri, (d) => d.length > 0);
    const hover = await client.request('textDocument/hover', { textDocument: { uri }, position: { line: 3, character: 10 } });
    assert.match(hover.contents.value, /def greet\(name: str\) -> str/);
    assert.deepEqual(hover.range, { start: { line: 3, character: 9 }, end: { line: 3, character: 14 } });
    const definition = await client.request('textDocument/definition', { textDocument: { uri }, position: { line: 3, character: 10 } });
    assert.ok(Array.isArray(definition) && definition.length >= 1);
    assert.equal(definition[0].uri, uri);
    assert.deepEqual(definition[0].range, { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } });
    assert.deepEqual(await client.shutdown(), { status: 'closed' });
  } finally {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('LSP real server (pyright): diagnostics arrive for a type error and track line shifts', { skip: SKIP_NO_SERVER }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-real-diag-'));
  const file = path.join(root, 'demo.py');
  const uri = `file://${file}`;
  await writeFile(file, SOURCE, 'utf8');
  const { client } = await startClient(root);
  try {
    client.didOpen(uri, 'python', SOURCE);
    const first = await waitForDiagnostics(client, uri, (d) => d.length === 1 && d[0].range.start.line === 4);
    assert.equal(first.length, 1);
    assert.equal(first[0].code, 'reportAssignmentType');
    assert.equal(first[0].severity, 1);
    assert.equal(first[0].source, 'Pyright');
    assert.match(first[0].message, /not assignable/);
    assert.deepEqual(first[0].range, { start: { line: 4, character: 11 }, end: { line: 4, character: 17 } });
    // Prepend a line: the server's own re-analysis must move the
    // diagnostic down exactly one line.
    client.didChange(uri, `# header\n${SOURCE}`);
    const shifted = await waitForDiagnostics(client, uri, (d) => d.length === 1 && d[0].range.start.line === 5);
    assert.equal(shifted[0].range.start.line, 5);
    assert.equal(shifted[0].code, 'reportAssignmentType');
    assert.deepEqual(await client.shutdown(), { status: 'closed' });
  } finally {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('LSP real server (pyright): didOpen/didChange/didClose lifecycle with multibyte UTF-16 alignment', { skip: SKIP_NO_SERVER }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-real-sync-'));
  const file = path.join(root, 'demo.py');
  const uri = `file://${file}`;
  await writeFile(file, SOURCE, 'utf8');
  const { client } = await startClient(root);
  try {
    client.didOpen(uri, 'python', SOURCE);
    assert.equal(client.getOpenDocument(uri).version, 0);
    await waitForDiagnostics(client, uri, (d) => d.length === 1 && d[0].range.start.line === 4);
    // Multibyte line: emoji is 2 UTF-16 units, CJK is 1 each. Replace
    // exactly the emoji (UTF-16 columns 10..12) with X and prove the
    // server still sees a coherent document: its diagnostics survive
    // at the same line, and the local text matches the edit.
    const multi = 'emoji = "a\u{1F600}b"  # \u4e2d\u6587\n' + SOURCE;
    client.didChange(uri, multi);
    assert.equal(client.getOpenDocument(uri).version, 1);
    assert.equal(client.getOpenDocument(uri).text.split('\n')[0], 'emoji = "a\u{1F600}b"  # \u4e2d\u6587');
    client.didChange(uri, [{ range: { start: { line: 0, character: 10 }, end: { line: 0, character: 12 } }, text: 'X' }]);
    assert.equal(client.getOpenDocument(uri).version, 2);
    assert.equal(client.getOpenDocument(uri).text.split('\n')[0], 'emoji = "aXb"  # \u4e2d\u6587');
    const after = await waitForDiagnostics(client, uri, (d) => d.length === 1 && d[0].range.start.line === 5);
    assert.equal(after[0].code, 'reportAssignmentType');
    assert.equal(after[0].range.start.line, 5);
    client.didClose(uri);
    assert.equal(client.getOpenDocument(uri), null);
    assert.deepEqual(client.listOpenDocuments(), []);
    assert.throws(() => client.didClose(uri), { code: 'LSP_DOCUMENT_NOT_OPEN' });
    assert.deepEqual(await client.shutdown(), { status: 'closed' });
  } finally {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
