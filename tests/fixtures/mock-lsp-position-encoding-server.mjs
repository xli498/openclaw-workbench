// Minimal mock LSP server that negotiates UTF-8 positions. It speaks the
// Content-Length frame protocol, answers initialize (with
// positionEncoding 'utf-8')/hover/shutdown, and records didChange
// notifications verbatim so tests can assert the client forwarded the
// negotiated units untouched while applying UTF-16 units locally.
// It never writes any file.
let buffer = Buffer.alloc(0);
let lastContentChanges = null;
let didChangeCount = 0;

function send(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
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
      send({ jsonrpc: '2.0', id: frame.id, result: { capabilities: { positionEncoding: 'utf-8', hoverProvider: true } } });
    } else if (frame.method === 'textDocument/didChange') {
      didChangeCount++;
      lastContentChanges = frame.params.contentChanges;
    } else if (frame.method === 'textDocument/hover') {
      send({ jsonrpc: '2.0', id: frame.id, result: { contents: { kind: 'plaintext', value: JSON.stringify({ didChangeCount, lastContentChanges }) } } });
    } else if (frame.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: frame.id, result: null });
    } else if (frame.method === 'exit') {
      process.exit(0);
    } else if (frame.id !== undefined) {
      send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
