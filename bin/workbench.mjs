#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { startWorkbench, createWorkbenchServer } from '../runtime/index.mjs';

function usage() {
  return 'Usage: openclaw-workbench [--root <workspace>] [--host <loopback>] [--port <port>] --token <token> [--approval-token <token>] [--json]';
}

export function parseArgs(argv) {
  const options = { root: process.cwd(), host: '127.0.0.1', port: 0, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root' || argument === '--host' || argument === '--port' || argument === '--token' || argument === '--approval-token') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw new Error(argument === '--root' ? '--root requires a path' : `${argument} requires a value`);
      if (argument === '--root') options.root = value;
      else if (argument === '--host') options.host = value;
      else if (argument === '--token') options.token = value;
      else if (argument === '--approval-token') options.approvalToken = value;
      else {
        if (!/^(?:0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > 65535) throw new Error('--port must be an integer from 0 to 65535');
        options.port = Number(value);
      }
    } else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') return { help: true };
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

export async function runCli(argv, { stdout = process.stdout, cwd = process.cwd(), createServer = createWorkbenchServer, startup = startWorkbench } = {}) {
  const options = parseArgs(argv);
  if (options.help) { stdout.write(`${usage()}\n`); return { exitCode: 0 }; }
  const root = path.resolve(cwd, options.root);
  if (!options.token) {
    const result = await startup({ root });
    if (options.json) stdout.write(`${JSON.stringify(result)}\n`);
    else stdout.write(`Startup recovery: scanned=${result.summary.scanned} finalized=${result.summary.finalized} errors=${result.summary.errors} approvalsRequired=${result.summary.approvalsRequired} manualReview=${result.summary.manualReview ?? 0} blocked=${result.summary.blocked}${result.fatalError ? ` fatal=${result.fatalError.code}` : ''}\n`);
    return { exitCode: result.summary.errors ? 2 : 0, result };
  }
  const app = createServer({ root, host: options.host, port: options.port, token: options.token, approvalToken: options.approvalToken });
  const result = await app.startup;
  if (result.fatalError) return { exitCode: 2, result };
  const address = await app.listen();
  const output = { ...result, service: { host: address.address, port: address.port } };
  if (options.json) stdout.write(`${JSON.stringify(output)}\n`);
  else stdout.write(`Workbench listening on http://${address.address}:${address.port} (startup recovery: scanned=${result.summary.scanned} finalized=${result.summary.finalized} errors=${result.summary.errors})\n`);
  return { exitCode: result.summary.errors ? 2 : 0, result: output, app };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { exitCode, app } = await runCli(process.argv.slice(2));
    process.exitCode = exitCode;
    if (app) {
      let closing = false;
      const close = async () => { if (closing) return; closing = true; await app.close(); };
      process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
      process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
    }
  }
  catch (error) { process.stderr.write(`${error.message}\n${usage()}\n`); process.exitCode = 1; }
}
