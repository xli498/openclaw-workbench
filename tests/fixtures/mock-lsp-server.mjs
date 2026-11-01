import { appendFileSync } from 'node:fs';

const recordPath = process.argv[2];
let buffer = Buffer.alloc(0);
let serverRequestSent = false;

function send(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
}

function record(value) {
  if (recordPath) appendFileSync(recordPath, `${JSON.stringify(value)}\n`);
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
    record(frame);
    if (frame.method === 'initialize') {
      send({ jsonrpc: '2.0', id: frame.id, result: { capabilities: { hoverProvider: true } } });
    } else if (frame.method === 'textDocument/hover') {
      if (!serverRequestSent) {
        serverRequestSent = true;
        send({ jsonrpc: '2.0', id: 999, method: 'window/showMessageRequest', params: { type: 1, message: 'should not be executed' } });
      }
      send({ jsonrpc: '2.0', id: frame.id, result: { contents: { kind: 'markdown', value: 'mock hover' } } });
    } else if (frame.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: frame.id, result: null });
    } else if (frame.method === 'exit') {
      process.exit(0);
    } else if (frame.id !== undefined) {
      send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
