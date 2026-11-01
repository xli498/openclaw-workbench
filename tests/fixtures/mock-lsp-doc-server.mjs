// Minimal mock LSP server for the document-sync tests. It speaks the
// Content-Length frame protocol, answers initialize/hover/shutdown, and
// keeps everything in memory. It never writes any file: there is no
// record path, and no fs import at all.
//
// Behaviour the tests rely on:
// - didOpen: stores the document and immediately publishes diagnostics
//   for that URI (including a credential-bearing message, so the client
//   side redaction can be checked) plus one out-of-root diagnostic that
//   the client must discard.
// - didChange: records the last contentChanges; didClose: drops the doc.
// - hover: on the first hover, if an applyEdit target URI was passed as
//   argv[2], the mock first sends a workspace/applyEdit server request
//   for that URI and only then answers the hover. The client's answer
//   to that request is recorded in memory and reported by the next
//   hover, so tests can assert the response code/result without the
//   mock ever touching disk.
const applyEditTargetUri = process.argv[2] || null;
let buffer = Buffer.alloc(0);
const docs = new Map();
const counts = { didOpen: 0, didChange: 0, didClose: 0 };
let lastContentChanges = null;
let applyEditSent = false;
let lastApplyEditResponse = null;

function send(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
}

function publishDiagnosticsFor(uri) {
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          message: 'token=should-be-redacted and Bearer abcdef123456 and see http://user:pass@example.com/x',
          code: 'X1',
          source: 'mock',
          extraField: 'must-be-dropped',
        },
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
          severity: 2,
          message: 'x'.repeat(50),
          source: 'mock',
        },
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
          severity: 2,
          message: 'third-diagnostic',
          source: 'mock',
        },
      ],
    },
  });
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri: 'file:///etc/passwd',
      diagnostics: [{ message: 'out-of-root diagnostic', source: 'mock' }],
    },
  });
}

function hoverReport() {
  return {
    counts: { ...counts },
    docs: [...docs.keys()],
    lastContentChanges,
    lastApplyEditResponse,
  };
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + length);
    let frame;
    try { frame = JSON.parse(body); } catch { continue; }
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      if (frame.id === 900) lastApplyEditResponse = frame.error ? { error: frame.error } : { result: frame.result };
      continue;
    }
    if (frame.method === 'initialize') {
      send({ jsonrpc: '2.0', id: frame.id, result: { capabilities: { hoverProvider: true } } });
    } else if (frame.method === 'textDocument/didOpen') {
      counts.didOpen++;
      docs.set(frame.params.textDocument.uri, frame.params.textDocument.text);
      publishDiagnosticsFor(frame.params.textDocument.uri);
    } else if (frame.method === 'textDocument/didChange') {
      counts.didChange++;
      lastContentChanges = frame.params.contentChanges;
      const uri = frame.params.textDocument.uri;
      if (Array.isArray(lastContentChanges) && lastContentChanges.length === 1 && lastContentChanges[0].range === undefined) {
        docs.set(uri, lastContentChanges[0].text);
      }
    } else if (frame.method === 'textDocument/didClose') {
      counts.didClose++;
      docs.delete(frame.params.textDocument.uri);
    } else if (frame.method === 'textDocument/hover') {
      if (applyEditTargetUri && !applyEditSent) {
        applyEditSent = true;
        send({
          jsonrpc: '2.0',
          id: 900,
          method: 'workspace/applyEdit',
          params: {
            label: 'mock-edit',
            edit: {
              changes: {
                [applyEditTargetUri]: [
                  { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'INSERTED' },
                ],
              },
            },
          },
        });
      }
      send({ jsonrpc: '2.0', id: frame.id, result: { contents: { kind: 'plaintext', value: JSON.stringify(hoverReport()) } } });
    } else if (frame.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: frame.id, result: null });
    } else if (frame.method === 'exit') {
      process.exit(0);
    } else if (frame.id !== undefined) {
      send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
