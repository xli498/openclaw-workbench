#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { startWorkbench, createWorkbenchServer } from '../runtime/index.mjs';

function usage() {
  return 'Usage: openclaw-workbench [--root <workspace>] [--host <loopback>] [--port <port>] [--token-env <name>] [--approval-token-env <name>] [--openclaw-command-env <name>] [--json]';
}

export function parseArgs(argv) {
  const options = { root: process.cwd(), host: '127.0.0.1', port: 0, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root' || argument === '--host' || argument === '--port' || argument === '--token-env' || argument === '--approval-token-env' || argument === '--openclaw-command-env' || argument === '--token' || argument === '--approval-token') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw new Error(argument === '--root' ? '--root requires a path' : `${argument} requires a value`);
      if (argument === '--root') options.root = value;
      else if (argument === '--host') options.host = value;
      else if (argument === '--token' || argument === '--approval-token') throw new Error('令牌禁止通过命令行传入，请使用 --token-env / --approval-token-env');
      else if (argument === '--token-env') options.tokenEnv = value;
      else if (argument === '--approval-token-env') options.approvalTokenEnv = value;
      else if (argument === '--openclaw-command-env') options.openclawCommandEnv = value;
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

export async function runCli(argv, { stdout = process.stdout, cwd = process.cwd(), env = process.env, createServer = createWorkbenchServer, startup = startWorkbench } = {}) {
  const options = parseArgs(argv);
  if (options.help) { stdout.write(`${usage()}\n`); return { exitCode: 0 }; }
  const root = path.resolve(cwd, options.root);
  const token = env[options.tokenEnv ?? 'OPENCLAW_WORKBENCH_TOKEN'];
  const approvalToken = env[options.approvalTokenEnv ?? 'OPENCLAW_WORKBENCH_APPROVAL_TOKEN'];
  if (!token) {
    const result = await startup({ root });
    if (options.json) stdout.write(`${JSON.stringify(result)}\n`);
    else stdout.write(`Startup recovery: scanned=${result.summary.scanned} finalized=${result.summary.finalized} errors=${result.summary.errors} approvalsRequired=${result.summary.approvalsRequired} manualReview=${result.summary.manualReview ?? 0} blocked=${result.summary.blocked}${result.fatalError ? ` fatal=${result.fatalError.code}` : ''}\n`);
    return { exitCode: result.summary.errors ? 2 : 0, result };
  }
  if (!approvalToken) throw new Error('审批令牌缺失，请设置 OPENCLAW_WORKBENCH_APPROVAL_TOKEN 或 --approval-token-env');
  const command = env[options.openclawCommandEnv ?? 'OPENCLAW_WORKBENCH_COMMAND']?.trim() || 'openclaw';
  const app = createServer({ root, host: options.host, port: options.port, token, approvalToken, adapter: { command } });
  const result = await app.startup;
  if (result.fatalError) return { exitCode: 2, result };
  const address = await app.listen();
  const output = { ...result, service: { host: address.address, port: address.port } };
  if (options.json) stdout.write(`${JSON.stringify(output)}\n`);
  else stdout.write(`Workbench listening on http://${address.address}:${address.port} (startup recovery: scanned=${result.summary.scanned} finalized=${result.summary.finalized} errors=${result.summary.errors})\n`);
  return { exitCode: result.summary.errors ? 2 : 0, result: output, app };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
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
