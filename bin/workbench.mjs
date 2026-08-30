#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { startWorkbench } from '../runtime/index.mjs';

function usage() {
  return 'Usage: openclaw-workbench [--root <workspace>] [--json]';
}

export function parseArgs(argv) {
  const options = { root: process.cwd(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw new Error('--root requires a path');
      options.root = value;
    } else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') return { help: true };
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

export async function runCli(argv, { stdout = process.stdout, cwd = process.cwd() } = {}) {
  const options = parseArgs(argv);
  if (options.help) { stdout.write(`${usage()}\n`); return { exitCode: 0 }; }
  const result = await startWorkbench({ root: path.resolve(cwd, options.root) });
  if (options.json) stdout.write(`${JSON.stringify(result)}\n`);
  else stdout.write(`Startup recovery: scanned=${result.summary.scanned} finalized=${result.summary.finalized} errors=${result.summary.errors} approvalsRequired=${result.summary.approvalsRequired} manualReview=${result.summary.manualReview ?? 0} blocked=${result.summary.blocked}${result.fatalError ? ` fatal=${result.fatalError.code}` : ''}\n`);
  return { exitCode: result.summary.errors ? 2 : 0, result };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { const { exitCode } = await runCli(process.argv.slice(2)); process.exitCode = exitCode; }
  catch (error) { process.stderr.write(`${error.message}\n${usage()}\n`); process.exitCode = 1; }
}
