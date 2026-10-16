import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { BridgeClient, BridgeError, COMMANDS } from '../src/bridge-client.mjs';
import { createMcpServer, parseArgs } from '../src/server.mjs';

async function memory(t, options = {}) {
  const calls = [];
  const state = { commands: [...COMMANDS], failure: undefined, healthFailure: undefined, ...options };
  const bridge = {
    async health() {
      if (state.healthFailure) throw state.healthFailure;
      return { ok: true, capabilities: { commands: state.commands } };
    },
    async call(command, args) {
      calls.push({ command, args });
      if (state.failure) throw state.failure;
      return { command, args };
    },
  };
  const server = await createMcpServer({ bridge });
  assert.ok(server instanceof McpServer);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, server, calls, state };
}
const payload = (result) => JSON.parse(result.content[0].text);
const code = (result) => { assert.equal(result.isError, true); return payload(result).error.code; };

test('real SDK initialize and tools/list expose all 17 documented tools with schemas and annotations', async (t) => {
  const { client } = await memory(t);
  assert.equal(client.getServerVersion().name, 'cocos-creator-mcp');
  const { tools } = await client.listTools();
  assert.equal(tools.length, 17);
  for (const tool of tools) {
    assert.ok(tool.description.length > 30);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
    assert.equal(typeof tool.annotations.destructiveHint, 'boolean');
    assert.equal(tool.annotations.openWorldHint, false);
  }
  assert.equal(tools.find(({ name }) => name === 'scene_query').annotations.readOnlyHint, true);
  assert.equal(tools.find(({ name }) => name === 'asset_edit').annotations.destructiveHint, true);
  assert.equal(tools.find(({ name }) => name === 'property_set').annotations.readOnlyHint, false);
});

test('all command mappings execute through real SDK tools/call, preserving operation arguments', async (t) => {
  const f = await memory(t);
  const validator = new AjvJsonSchemaValidator();
  const validators = new Map((await f.client.listTools()).tools.map((tool) => [tool.name, validator.getValidator(tool.inputSchema)]));
  const cases = [
    ['editor_info', {}, 'editor.info'], ['scene_query', {}, 'scene.query'],
    ['scene_open', { asset: 'db://assets/test.scene' }, 'scene.open'],
    ['scene_save', {}, 'scene.save'], ['scene_create', { url: 'db://assets/new.scene', name: 'New' }, 'scene.create'],
    ['scene_history', { action: 'undo' }, 'scene.undo'], ['scene_history', { action: 'redo' }, 'scene.redo'],
    ['node_query', { uuid: 'node' }, 'node.query'],
    ['node_edit', { action: 'create', parent: 'root', name: 'Label', components: ['cc.Label'], position: { x: 1, y: 2, z: 0 } }, 'node.create'],
    ['node_edit', { action: 'remove', uuid: 'node' }, 'node.remove'],
    ['node_edit', { action: 'reparent', uuid: 'node', parent: 'root', keepWorldTransform: true }, 'node.reparent'],
    ['node_edit', { action: 'duplicate', uuid: 'node', name: 'Copy' }, 'node.duplicate'],
    ['component_edit', { action: 'catalog', component: 'cc.' }, 'component.catalog'],
    ['component_edit', { action: 'list', uuid: 'node' }, 'component.list'],
    ['component_edit', { action: 'add', uuid: 'node', component: 'cc.Label' }, 'component.add'],
    ['component_edit', { action: 'remove', uuid: 'node', componentUuid: 'component' }, 'component.remove'],
    ['property_set', { uuid: 'node', path: 'string', value: { text: 'test', nested: [true, null, 3] }, componentUuid: 'component' }, 'property.set'],
    ['asset_query', { action: 'search', pattern: 'db://assets/**', type: 'cc.SceneAsset', limit: 10, offset: 0 }, 'asset.query'],
    ['asset_edit', { action: 'create', url: 'db://assets/new.txt', content: '' }, 'asset.create'],
    ['asset_edit', { action: 'save', asset: 'asset', content: 'hello' }, 'asset.save'],
    ['asset_edit', { action: 'import', source: path.join(os.tmpdir(), 'file.png'), overwrite: false }, 'asset.import'],
    ['asset_edit', { action: 'move', asset: 'asset', url: 'db://assets/moved.txt' }, 'asset.move'],
    ['asset_edit', { action: 'copy', asset: 'asset', url: 'db://assets/copied.txt' }, 'asset.copy'],
    ['asset_edit', { action: 'delete', asset: 'asset' }, 'asset.delete'],
    ['asset_edit', { action: 'meta', asset: 'asset', userData: { type: 'sprite-frame' } }, 'asset.meta'],
    ['prefab_manage', { action: 'create', uuid: 'node', url: 'db://assets/new.prefab' }, 'prefab.create'],
    ['prefab_manage', { action: 'instantiate', asset: 'prefab', parent: 'root', name: 'Instance' }, 'prefab.instantiate'],
    ['ui_build', { parent: 'root', tree: [{ name: 'Panel', properties: { active: true }, components: [{ type: 'cc.UITransform', properties: { width: 200 } }], children: [{ name: 'Child' }] }] }, 'ui.build'],
    ['editor_preview', { action: 'info' }, 'preview.info'], ['editor_preview', { action: 'open' }, 'preview.open'],
    ['editor_preview', { action: 'refresh' }, 'preview.refresh'], ['editor_logs', { level: 'warn', limit: 20, since: 1234 }, 'editor.logs'],
    ['project_build', { action: 'config' }, 'build.config'], ['project_build', { action: 'start', options: { platform: 'web-mobile' } }, 'build.start'],
    ['project_build', { action: 'status', taskId: 'task' }, 'build.status'], ['project_build', { action: 'cancel', taskId: 'task' }, 'build.cancel'],
  ];
  for (const [name, args, command] of cases) {
    const validated = validators.get(name)(args);
    assert.equal(validated.valid, true, `${name} advertised schema: ${validated.errorMessage}`);
    const expected = { ...args };
    if (!['asset_query'].includes(name)) delete expected.action;
    const result = await f.client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
    assert.deepEqual(payload(result), { command, args: expected });
    assert.deepEqual(f.calls.at(-1), { command, args: expected });
  }
  assert.equal(f.calls.length, COMMANDS.length);
  assert.deepEqual(new Set(f.calls.map(({ command }) => command)), new Set(COMMANDS));
});

test('tools and action enums follow actual capabilities, including a changed session', async (t) => {
  const f = await memory(t, { commands: ['editor.info', 'component.list', 'build.status', 'editor.eval'] });
  let { tools } = await f.client.listTools();
  assert.deepEqual(tools.map(({ name }) => name), ['editor_info', 'component_edit', 'project_build']);
  assert.deepEqual(tools.find(({ name }) => name === 'component_edit').inputSchema.properties.action.enum, ['list']);
  assert.equal(tools.find(({ name }) => name === 'component_edit').annotations.readOnlyHint, true);
  assert.equal(code(await f.client.callTool({ name: 'component_edit', arguments: { action: 'add', uuid: 'node', component: 'cc.Label' } })), 'UNSUPPORTED_COMMAND');
  f.state.commands = ['scene.query', 'node.create', 'node.remove'];
  ({ tools } = await f.client.listTools());
  assert.deepEqual(tools.map(({ name }) => name), ['scene_query', 'node_edit']);
  assert.deepEqual(tools.find(({ name }) => name === 'node_edit').inputSchema.properties.action.enum, ['create', 'remove']);
  assert.equal(code(await f.client.callTool({ name: 'editor_info' })), 'UNSUPPORTED_COMMAND');
  const result = await f.client.callTool({ name: 'node_edit', arguments: { action: 'create', name: 'new' } });
  assert.notEqual(result.isError, true);
  assert.equal(f.calls.length, 1);
});

test('empty capabilities do not advertise tools or permit execution', async (t) => {
  const f = await memory(t, { commands: [] });
  assert.deepEqual((await f.client.listTools()).tools, []);
  assert.equal(code(await f.client.callTool({ name: 'scene_save' })), 'UNSUPPORTED_COMMAND');
  f.state.commands = ['editor.info'];
  assert.deepEqual((await f.client.listTools()).tools.map(({ name }) => name), ['editor_info']);
  assert.equal(code(await f.client.callTool({ name: 'not_a_tool' })), 'UNKNOWN_TOOL');
  assert.equal(f.calls.length, 0);
});

test('invalid inputs and unknown actions return structured stable errors without invoking RPC', async (t) => {
  const f = await memory(t);
  const cases = [
    ['scene_open', {}], ['scene_open', { asset: '  ' }], ['scene_open', { asset: 'asset', discardChanges: true }],
    ['scene_save', { unknown: true }], ['scene_history', { action: 'eval' }],
    ['node_query', { uuid: 'one', path: 'two' }], ['node_edit', { action: 'remove' }],
    ['node_edit', { action: 'reparent', uuid: 'node' }], ['node_edit', { action: 'create', position: { x: 1, y: 2 } }],
    ['component_edit', { action: 'add', uuid: 'node' }], ['component_edit', { action: 'remove', uuid: 'node' }],
    ['property_set', { uuid: 'node', path: 'active' }], ['asset_query', { action: 'meta' }],
    ['asset_query', { action: 'search', limit: -1 }], ['asset_query', { action: 'search', offset: 0.5 }],
    ['asset_edit', { action: 'save', asset: 'asset' }], ['asset_edit', { action: 'move', asset: 'asset' }],
    ['asset_edit', { action: 'meta', asset: 'asset' }], ['asset_edit', { action: 'meta', userData: {} }],
    ['asset_edit', { action: 'meta', asset: 'asset', userData: [] }],
    ['asset_edit', { action: 'import' }], ['prefab_manage', { action: 'create', uuid: 'node' }],
    ['prefab_manage', { action: 'instantiate' }], ['ui_build', { tree: [] }],
    ['ui_build', { tree: [{ name: 'test', components: [{ type: '' }] }] }],
    ['ui_build', { tree: [{ name: 'test', children: [{ components: [] }] }] }],
    ['editor_logs', { level: 'debug' }], ['project_build', { action: 'cancel' }],
  ];
  for (const [name, args] of cases) {
    const result = await f.client.callTool({ name, arguments: args });
    assert.equal(code(result), 'INVALID_ARGUMENT', `${name}: ${JSON.stringify(args)}`);
    assert.deepEqual(result.structuredContent, payload(result));
  }
  assert.equal(code(await f.client.callTool({ name: '__proto__' })), 'UNKNOWN_TOOL');
  assert.equal(f.calls.length, 0);
  const result = await f.client.callTool({ name: 'property_set', arguments: { uuid: 'node', path: 'target', value: null } });
  assert.notEqual(result.isError, true, 'null is a valid property value.');
});

test('bridge and unexpected errors always map to isError=true with stable codes', async (t) => {
  const f = await memory(t);
  const details = { outcome: 'unknown', retryable: false };
  f.state.failure = new BridgeError('TIMEOUT', 'Write timed out; outcome unknown.', details);
  let result = await f.client.callTool({ name: 'scene_save' });
  assert.deepEqual(payload(result), { error: { code: 'TIMEOUT', message: 'Write timed out; outcome unknown.', details } });
  assert.equal(result.isError, true);
  f.state.failure = new Error('private implementation detail');
  result = await f.client.callTool({ name: 'scene_save' });
  assert.equal(code(result), 'INTERNAL_ERROR');
  assert.doesNotMatch(result.content[0].text, /private implementation/u);
  f.state.healthFailure = new BridgeError('SESSION_MISMATCH', 'Stale session.');
  assert.equal(code(await f.client.callTool({ name: 'scene_save' })), 'SESSION_MISMATCH');
  assert.equal(f.calls.length, 2, 'Unconfirmed health never invokes RPC.');
});

async function httpFixture(t) {
  const project = await mkdtemp(path.join(os.tmpdir(), 'creator-mcp-stdio-'));
  const directory = path.join(project, 'temp', 'cocos-creator-mcp');
  await mkdir(directory, { recursive: true });
  const calls = [];
  const state = { commands: ['editor.info', 'scene.save'], fail: false, sessionId: 'stdio-session' };
  const identity = { path: project, uuid: 'stdio-project', name: 'Stdio project' };
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer stdio-token');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') return response.end(JSON.stringify({ ok: true, protocolVersion: 1,
      sessionId: state.sessionId, editorVersion: '3.7.3', project: identity, capabilities: { commands: state.commands } }));
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    response.end(JSON.stringify(state.fail ? { id: body.id, ok: false, error: { code: 'UNSAVED_CHANGES', message: 'Unsaved scene.' } }
      : { id: body.id, ok: true, result: { editorVersion: '3.7.3', project: identity, command: body.command } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const session = { protocolVersion: 1, host: '127.0.0.1', port: server.address().port, token: 'stdio-token',
    sessionId: state.sessionId, editorVersion: '3.7.3', project: identity, pid: process.pid };
  const save = () => writeFile(path.join(directory, 'session.json'), JSON.stringify({ ...session, sessionId: state.sessionId }));
  await save();
  t.after(async () => {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await rm(project, { recursive: true, force: true });
  });
  return { project, calls, state, save };
}

test('real SDK stdio subprocess initializes, lists, calls, maps remote errors, and reconnects', async (t) => {
  const f = await httpFixture(t);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url)), '--project', f.project, '--timeout', '2000'], stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', (data) => { stderr += data; });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), ['editor_info', 'scene_save']);
  let result = await client.callTool({ name: 'editor_info' });
  assert.equal(payload(result).editorVersion, '3.7.3');
  f.state.fail = true;
  assert.equal(code(await client.callTool({ name: 'scene_save' })), 'UNSAVED_CHANGES');
  f.state.fail = false;
  f.state.sessionId = 'reconnected-stdio-session';
  await f.save();
  result = await client.callTool({ name: 'scene_save' });
  assert.notEqual(result.isError, true);
  assert.equal(f.calls.at(-1).sessionId, 'reconnected-stdio-session');
  assert.equal(stderr, '', 'Healthy startup and normal tool failures do not print diagnostics.');
  await client.close();
});

test('MCP + real BridgeClient returns structured identity failures and never writes', async (t) => {
  const f = await httpFixture(t);
  const server = await createMcpServer({ bridge: new BridgeClient({ project: f.project }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'identity-test', version: '1.0.0' });
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  f.state.sessionId = 'not-in-discovery';
  assert.equal(code(await client.callTool({ name: 'scene_save' })), 'SESSION_MISMATCH');
  assert.equal(f.calls.length, 0);
  await f.save();
  assert.notEqual((await client.callTool({ name: 'scene_save' })).isError, true);
  assert.equal(f.calls.length, 1);
});

test('CLI validates flags and writes help/errors only to stderr', async () => {
  assert.deepEqual(parseArgs(['--project', os.tmpdir(), '--timeout', '123']), { project: path.resolve(os.tmpdir()), timeout: 123 });
  for (const args of [[], ['--project', 'relative'], ['--project'], ['--unknown'], ['--timeout', '0'],
    ['--project', os.tmpdir(), '--timeout', '1.5'], ['--project', os.tmpdir(), '--timeout', '1e3'],
    ['--project', os.tmpdir(), '--timeout', '2147483648'], ['--project', os.tmpdir(), '--project', os.tmpdir()],
    ['--project', os.tmpdir(), '--timeout', '1', '--timeout', '2']]) {
    assert.throws(() => parseArgs(args), (error) => error.code === 'INVALID_ARGUMENT');
  }
  const entry = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  for (const args of [['--help'], ['--project', 'relative']]) {
    const child = spawn(process.execPath, [entry, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(stdout, '');
    assert.match(stderr, /Usage:/u);
    assert.equal(exit, args[0] === '--help' ? 0 : 1);
  }
});

test('raw stdio contains only JSON protocol messages and the CLI exits when stdin ends', { timeout: 15000 }, async (t) => {
  const f = await httpFixture(t);
  const child = spawn(process.execPath,
    [fileURLToPath(new URL('../src/server.mjs', import.meta.url)), '--project', f.project],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const pending = new Map();
  const messages = [];
  const parseErrors = [];
  let buffer = ''; let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        messages.push(message);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      } catch (error) { parseErrors.push(error); }
    }
  });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  async function request(id, method, params) {
    let timer;
    try {
      return await Promise.race([
        new Promise((resolve) => { pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`stdio ${method} timed out: ${stderr}`)), 8000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  const initialized = await request(1, 'initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw-test', version: '1.0.0' } });
  assert.equal(initialized.result.serverInfo.name, 'cocos-creator-mcp');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  assert.equal((await request(2, 'tools/list', {})).result.tools.length, 2);
  assert.notEqual((await request(3, 'tools/call', { name: 'editor_info', arguments: {} })).result.isError, true);
  child.stdin.end();
  assert.equal(await exited, 0);
  assert.equal(stderr, '');
  assert.equal(buffer, '');
  assert.deepEqual(parseErrors, []);
  assert.ok(messages.length >= 3);
  assert.ok(messages.every((message) => message.jsonrpc === '2.0'));
});
