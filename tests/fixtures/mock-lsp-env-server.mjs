import { appendFileSync } from 'node:fs';

// Minimal LSP server that records only booleans about its environment:
// whether the parent's marker variable leaked in, whether the caller's
// env entry arrived, and whether the explicit base keys arrived. It
// never writes an env value to disk.
const recordPath = process.argv[2];
let buffer = Buffer.alloc(0);

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
      if (recordPath) {
        appendFileSync(recordPath, `${JSON.stringify({
          parentMarkerPresent: process.env.OCW_P2_S4_PARENT_MARKER !== undefined,
          callerValuePresent: process.env.LSP_TEST_VALUE === 'lsp-caller-value',
          pathPresent: process.env.PATH !== undefined,
        })}\n`);
      }
      send({ jsonrpc: '2.0', id: frame.id, result: { capabilities: {} } });
    } else if (frame.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: frame.id, result: null });
    } else if (frame.method === 'exit') {
      process.exit(0);
    } else if (frame.id !== undefined) {
      send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
