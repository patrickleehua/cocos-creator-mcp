#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeClient, BridgeError, DEFAULT_TIMEOUT, MAX_TIMEOUT } from './bridge-client.mjs';
import { createMcpServer } from './tools.mjs';

export { createMcpServer } from './tools.mjs';
export const USAGE = 'Usage: cocos-creator-mcp --project <absolute project> [--timeout <milliseconds>]';

export function parseArgs(argv) {
  let project;
  let timeout = DEFAULT_TIMEOUT;
  let timeoutSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      if (argv.length !== 1) throw new BridgeError('INVALID_ARGUMENT', '--help must be used alone.');
      return { help: true };
    }
    if (flag !== '--project' && flag !== '--timeout') throw new BridgeError('INVALID_ARGUMENT', `Unknown option: ${flag}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new BridgeError('INVALID_ARGUMENT', `${flag} requires a value.`);
    if (flag === '--project') {
      if (project !== undefined) throw new BridgeError('INVALID_ARGUMENT', '--project must be provided once.');
      project = value;
    } else {
      if (timeoutSeen || !/^\d+$/u.test(value)) throw new BridgeError('INVALID_ARGUMENT', '--timeout must be provided once as a positive integer.');
      timeoutSeen = true;
      timeout = Number(value);
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT) throw new BridgeError('INVALID_ARGUMENT', `--timeout must be between 1 and ${MAX_TIMEOUT}.`);
    }
  }
  if (typeof project !== 'string' || !project.trim() || !path.isAbsolute(project)) throw new BridgeError('INVALID_ARGUMENT', '--project must be an absolute project path.');
  return { project: path.resolve(project), timeout };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stderr.write(`${USAGE}\n`); return; }
  const bridge = new BridgeClient(options);
  const server = await createMcpServer({ bridge });
  const transport = new StdioServerTransport();
  let closing;
  const close = () => {
    closing ??= server.close().finally(() => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.stdin.removeListener('end', onEnd);
    });
    return closing;
  };
  const onSignal = () => { void close().catch(() => { process.exitCode = 1; }); };
  const onEnd = () => { void close().catch(() => { process.exitCode = 1; }); };
  await server.connect(transport);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.stdin.once('end', onEnd);
  return { server, transport, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code = error instanceof BridgeError ? error.code : 'INTERNAL_ERROR';
    const message = error instanceof BridgeError ? error.message : 'The MCP service could not start.';
    process.stderr.write(`${code}: ${message}\n${USAGE}\n`);
    process.exitCode = 1;
  });
}
