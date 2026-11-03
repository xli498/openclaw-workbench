// Minimal mock LSP server for the P2-s5 diagnostics tests. It speaks the
// Content-Length frame protocol, answers initialize/shutdown, and on
// didOpen publishes a fixed diagnostic set designed so each redaction
// rule can be proven separately (never via truncation alone):
// - entry 0: a Bearer token and NOTHING that looks like URL userinfo,
//   longer than the 20-char truncation the old test used;
// - entry 1: URL userinfo and NO Bearer token, likewise long;
// - entry 2: a quoted credential value containing spaces;
// - entry 3: over-long code/source carrying credential material.
// It also publishes one out-of-root diagnostic that the client must
// discard and must not forward to onNotification. It never writes a file.
let buffer = Buffer.alloc(0);

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
          message: `Bearer ${'A'.repeat(60)} reported at ${'x'.repeat(60)}`,
          code: 'BEARER-CASE',
          source: 'diag2',
        },
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
          severity: 1,
          message: `see http://diaguser:diagpass123@example.com/docs for details ${'y'.repeat(60)}`,
          code: 'URI-CASE',
          source: 'diag2',
        },
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
          severity: 2,
          message: `config secret="alpha beta gamma" end ${'z'.repeat(60)}`,
          code: 'QUOTED-CASE',
          source: 'diag2',
        },
        {
          range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
          severity: 2,
          message: 'plain diagnostic four',
          code: `${'C'.repeat(200)} token=should-not-leak-code`,
          source: `${'S'.repeat(200)} Bearer should-not-leak-source`,
        },
      ],
    },
  });
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri: 'file:///etc/passwd',
      diagnostics: [{ message: 'out-of-root Bearer should-not-leak-oor', source: 'diag2' }],
    },
  });
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
    if (frame.method === 'initialize') {
      send({ jsonrpc: '2.0', id: frame.id, result: { capabilities: {} } });
    } else if (frame.method === 'textDocument/didOpen') {
      publishDiagnosticsFor(frame.params.textDocument.uri);
    } else if (frame.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: frame.id, result: null });
    } else if (frame.method === 'exit') {
      process.exit(0);
    } else if (frame.id !== undefined) {
      send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
