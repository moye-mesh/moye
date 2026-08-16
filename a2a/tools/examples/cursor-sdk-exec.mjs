#!/usr/bin/env node
/** @deprecated Use ../room-runtime-exec.js --runtime cursor */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const exec = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'room-runtime-exec.js');
const child = spawn(process.execPath, [exec, '--runtime', 'cursor', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (c) => process.exit(c == null ? 1 : c));
