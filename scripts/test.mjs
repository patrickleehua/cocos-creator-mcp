#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function main() {
  const directory = path.join(root, 'tests');
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.test\.(?:cjs|mjs|js)$/.test(entry.name))
    .map(entry => path.join(directory, entry.name))
    .sort();
  if (files.length === 0) throw new Error('No tests/*.test.{cjs,mjs,js} files found.');

  // npm consumes its own `--`; also accept one for direct launcher invocations.
  const flags = process.argv.slice(2);
  if (flags[0] === '--') flags.shift();
  // Enumerate files ourselves: Node 20 on Windows does not expand these globs.
  // Flags precede filenames so values such as --test-name-pattern are parsed.
  const child = spawn(process.execPath, ['--test', ...flags, ...files], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });

  let requestedSignal;
  let spawnFailed = false;
  const listeners = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const listener = () => {
      requestedSignal = requestedSignal || signal;
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(signal);
      } catch (error) {
        if (error.code !== 'ESRCH') process.stderr.write(`Cannot forward ${signal}: ${error.message}\n`);
      }
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }

  await new Promise(resolve => {
    child.once('error', error => {
      spawnFailed = true;
      process.stderr.write(`Cannot start Node test runner: ${error.message}\n`);
    });
    child.once('close', (code, signal) => {
      for (const [name, listener] of listeners) process.removeListener(name, listener);
      const interrupted = signal || requestedSignal;
      if (interrupted) {
        process.exitCode = 128 + (constants.signals[interrupted] || 1);
        // POSIX callers can observe the original terminating signal. Windows
        // cannot reproduce all POSIX signals, so retain the numeric exit status.
        if (process.platform !== 'win32') {
          try { process.kill(process.pid, interrupted); } catch (ignored) {}
        }
      } else {
        process.exitCode = spawnFailed || code === null ? 1 : code;
      }
      resolve();
    });
  });
}

main().catch(error => {
  process.stderr.write(`Test launcher failed: ${error.message}\n`);
  process.exitCode = 1;
});
