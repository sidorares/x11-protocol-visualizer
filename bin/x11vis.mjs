#!/usr/bin/env node
// Thin launcher: run the TypeScript CLI through the locally-installed tsx.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../src/cli.ts');
const tsxBin = resolve(here, '../node_modules/.bin/tsx');

const child = spawn(tsxBin, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
