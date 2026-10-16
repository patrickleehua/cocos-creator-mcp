import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BridgeClient, BridgeError } from '../src/bridge-client.mjs';

async function fixture(t, { timeout = 1500 } = {}) {
  const project = await mkdtemp(path.join(os.tmpdir(), 'creator-bridge-'));
  const sessionFile = path.join(project, 'temp', 'cocos-creator-mcp', 'session.json');
  await mkdir(path.dirname(sessionFile), { recursive: true });
  const requests = [];
  let session;
  const state = { health: undefined, rpc: undefined };
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ url: request.url, method: request.method, headers: request.headers, body });
    const health = { ok: true, protocolVersion: 1, sessionId: session.sessionId,
      editorVersion: session.editorVersion, project: session.project,
      capabilities: { commands: ['editor.info', 'scene.save', 'scene.query'] } };
    const handler = request.url === '/health' ? state.health : state.rpc;
    if (handler) return handler({ request, response, body, health, session });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/health' ? health : { id: body.id, ok: true, result: { command: body.command, args: body.args } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  session = { protocolVersion: 1, host: '127.0.0.1', port: server.address().port,
    token: 'secret-for-tests', sessionId: 'session-one', editorVersion: '3.7.3',
    project: { path: project, uuid: 'project-uuid', name: 'Test project' }, pid: process.pid };
  const save = async (changes = {}) => { session = { ...session, ...changes }; await writeFile(sessionFile, JSON.stringify(session)); };
  await save();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(project, { recursive: true, force: true });
  });
  return { project, sessionFile, requests, state, save, server,
    get session() { return session; }, client: new BridgeClient({ project, timeout }) };
}

const errorCode = (code) => (error) => error instanceof BridgeError && error.code === code;

test('oversized RPC payloads are rejected locally before dispatch', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client.call('scene.save', { content: 'x'.repeat(2 * 1024 * 1024) }), error => {
    assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(error.details.outcome, 'not_applied');
    return true;
  });
  assert.equal(f.requests.filter(request => request.url === '/rpc').length, 0);
});

test('an authoritative preflight timeout keeps its not-applied outcome', async (t) => {
  const f = await fixture(t);
  f.state.rpc = ({ response, body }) => response.end(JSON.stringify({ id: body.id, ok: false,
    error: { code: 'COMMAND_TIMEOUT', message: 'Preflight query timed out.', details: { outcome: 'not_applied', retryable: false } } }));
  await assert.rejects(f.client.call('scene.save'), error => error.code === 'COMMAND_TIMEOUT' && error.details.outcome === 'not_applied');
});

test('BridgeClient authenticates health and RPC and validates response correlation', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.call('scene.save'), { command: 'scene.save', args: {} });
  assert.equal(f.client.sessionFile, f.sessionFile);
  assert.deepEqual(f.requests.map(({ url, method }) => [method, url]), [['GET', '/health'], ['POST', '/rpc']]);
  for (const request of f.requests) assert.equal(request.headers.authorization, 'Bearer secret-for-tests');
  const { body } = f.requests[1];
  assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.deepEqual(Object.keys(body).sort(), ['args', 'command', 'deadline', 'id', 'sessionId']);
  assert(Number.isSafeInteger(body.deadline));
  assert(body.deadline <= Date.now() + f.client.timeout);
  assert.equal(body.sessionId, 'session-one');
});

test('reads fresh discovery and reconnects after endpoint/token/session replacement', async (t) => {
  const f = await fixture(t);
  await f.client.call('editor.info');
  const alternate = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer replacement-token');
    if (request.url === '/health') return response.end(JSON.stringify({ ok: true, protocolVersion: 1,
      sessionId: 'session-two', editorVersion: '3.7.3', project: f.session.project, capabilities: { commands: ['scene.save'] } }));
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.sessionId, 'session-two');
    response.end(JSON.stringify({ id: body.id, ok: true, result: 'new-session' }));
  });
  await new Promise((resolve) => alternate.listen(0, '127.0.0.1', resolve));
  t.after(async () => { alternate.closeAllConnections(); await new Promise((resolve) => alternate.close(resolve)); });
  await f.save({ sessionId: 'session-two', token: 'replacement-token', port: alternate.address().port });
  assert.equal(await f.client.call('scene.save'), 'new-session');
  assert.equal(f.requests.length, 2, 'The previous endpoint is not reused.');
});

test('health identity and capability failures never dispatch writes', async (t) => {
  const cases = [
    ['SESSION_MISMATCH', (health) => ({ ...health, sessionId: 'different' })],
    ['SESSION_MISMATCH', (health) => ({ ...health, editorVersion: '3.8.0' })],
    ['PROJECT_MISMATCH', (health) => ({ ...health, project: { ...health.project, uuid: 'other-project' } })],
    ['PROJECT_MISMATCH', (health) => ({ ...health, project: { ...health.project, name: 'Other project' } })],
    ['PROJECT_MISMATCH', (health) => ({ ...health, project: { ...health.project, path: path.dirname(health.project.path) } })],
    ['INVALID_HEALTH', (health) => ({ ...health, ok: false })],
    ['INVALID_HEALTH', (health) => ({ ...health, protocolVersion: 2 })],
    ['INVALID_HEALTH', (health) => ({ ...health, capabilities: {} })],
    ['INVALID_HEALTH', (health) => ({ ...health, capabilities: { commands: ['scene.save', 42] } })],
    ['UNSUPPORTED_COMMAND', (health) => ({ ...health, capabilities: { commands: ['editor.info'] } })],
  ];
  for (const [code, change] of cases) await t.test(code, async (subtest) => {
    const f = await fixture(subtest);
    f.state.health = ({ response, health }) => response.end(JSON.stringify(change(health)));
    await assert.rejects(f.client.call('scene.save'), errorCode(code));
    assert.equal(f.requests.length, 1);
  });
});

test('session rotation during health is refused, then the next invocation reconnects', async (t) => {
  const f = await fixture(t);
  f.state.health = async ({ response, health }) => {
    await f.save({ sessionId: 'session-two', token: 'new-token' });
    response.end(JSON.stringify(health));
  };
  await assert.rejects(f.client.call('scene.save'), errorCode('SESSION_CHANGED'));
  assert.equal(f.requests.length, 1);
  f.state.health = undefined;
  await f.client.call('scene.save');
  assert.equal(f.requests.at(-1).body.sessionId, 'session-two');
  assert.equal(f.requests.at(-1).headers.authorization, 'Bearer new-token');
});

test('unknown command is rejected even when it appears in capabilities', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client.call('editor.eval', {}), errorCode('UNKNOWN_COMMAND'));
  assert.equal(f.requests.length, 0);
});

test('discovery validation rejects unsafe endpoints and malformed identity before networking', async (t) => {
  const patches = [{ host: 'example.org' }, { host: 'localhost' }, { host: '127.0.0.2' },
    { port: 0 }, { port: 65536 }, { port: 123.5 }, { token: '' }, { token: 'bad\r\ntoken' },
    { protocolVersion: 2 }, { sessionId: '' }, { editorVersion: '' }, { pid: 0 },
    { project: { path: 'relative', uuid: 'uuid', name: 'name' } }];
  const f = await fixture(t);
  const original = f.session;
  for (const patch of patches) {
    await f.save({ ...original, ...patch });
    await assert.rejects(f.client.call('scene.save'), errorCode('INVALID_DISCOVERY'));
  }
  await writeFile(f.sessionFile, '{');
  await assert.rejects(f.client.call('scene.save'), errorCode('INVALID_DISCOVERY'));
  await rm(f.sessionFile);
  await assert.rejects(f.client.call('scene.save'), errorCode('DISCOVERY_NOT_FOUND'));
  assert.equal(f.requests.length, 0);
});

test('discovery pointing at another project is rejected before health', async (t) => {
  const f = await fixture(t);
  await f.save({ project: { ...f.session.project, path: path.dirname(f.project) } });
  await assert.rejects(f.client.call('scene.save'), errorCode('PROJECT_MISMATCH'));
  assert.equal(f.requests.length, 0);
});

test('HTTP authentication errors, invalid JSON, and health disconnects have stable codes', async (t) => {
  const cases = [
    ['AUTH_FAILED', ({ response }) => { response.writeHead(401); response.end('{}'); }],
    ['AUTH_FAILED', ({ response }) => { response.writeHead(401); response.end('Unauthorized'); }],
    ['AUTH_FAILED', ({ response }) => { response.writeHead(403); response.end('{}'); }],
    ['BRIDGE_HTTP_ERROR', ({ response }) => { response.writeHead(503); response.end('{}'); }],
    ['INVALID_RESPONSE', ({ response }) => response.end('bad-json')],
    ['BRIDGE_UNAVAILABLE', ({ response }) => response.destroy()],
  ];
  for (const [code, handler] of cases) await t.test(code, async (subtest) => {
    const f = await fixture(subtest);
    f.state.health = handler;
    await assert.rejects(f.client.call('scene.save'), errorCode(code));
    assert.equal(f.requests.length, 1);
  });
});

test('RPC errors preserve adapter error code/message/details', async (t) => {
  const f = await fixture(t);
  f.state.rpc = ({ response, body }) => response.end(JSON.stringify({ id: body.id, ok: false,
    error: { code: 'UNSAVED_CHANGES', message: 'Save the scene first.', details: { scene: 'scene-uuid' } } }));
  await assert.rejects(f.client.call('scene.save'), (error) => {
    assert.equal(error.code, 'UNSAVED_CHANGES');
    assert.equal(error.message, 'Save the scene first.');
    assert.deepEqual(error.details, { scene: 'scene-uuid' });
    return true;
  });
});

test('correlated non-2xx RPC errors retain session rejection codes', async (t) => {
  const f = await fixture(t);
  f.state.rpc = ({ response, body }) => {
    response.writeHead(409);
    response.end(JSON.stringify({ id: body.id, ok: false, error: { code: 'SESSION_MISMATCH', message: 'The editor restarted.' } }));
  };
  await assert.rejects(f.client.call('scene.save'), errorCode('SESSION_MISMATCH'));
  assert.equal(f.requests.filter(({ url }) => url === '/rpc').length, 1);
});

test('adapter timeouts and lost RPC connections never imply a write was not applied', async (t) => {
  const f = await fixture(t);
  f.state.rpc = ({ response, body }) => response.end(JSON.stringify({ id: body.id, ok: false,
    error: { code: 'COMMAND_TIMEOUT', message: 'Editor deadline exceeded.', details: { queue: 'scene' } } }));
  await assert.rejects(f.client.call('scene.save'), (error) => error.code === 'COMMAND_TIMEOUT'
    && error.details.outcome === 'unknown' && error.details.queue === 'scene' && /outcome unknown/iu.test(error.message));
  f.state.rpc = ({ response }) => response.destroy();
  await assert.rejects(f.client.call('scene.save'), (error) => error.code === 'BRIDGE_UNAVAILABLE' && error.details.outcome === 'unknown');
  assert.equal(f.requests.filter(({ url }) => url === '/rpc').length, 2);
});

test('mismatched and malformed RPC envelopes are never accepted as successful', async (t) => {
  const replies = [() => ({ id: 'wrong', ok: true, result: {} }),
    ({ id }) => ({ id, ok: true }), ({ id }) => ({ id, ok: false }),
    ({ id }) => ({ id, ok: false, error: { code: 3, message: 'bad' } }),
    ({ id }) => ({ id, ok: 'true', result: {} })];
  const f = await fixture(t);
  for (const reply of replies) {
    f.state.rpc = ({ body, response }) => response.end(JSON.stringify(reply(body)));
    await assert.rejects(f.client.call('scene.save'), (error) => error.code === 'INVALID_RESPONSE' && error.details.outcome === 'unknown');
  }
  assert.equal(f.requests.filter(({ url }) => url === '/rpc').length, replies.length);
});

test('write timeout is outcome unknown and the command is never retried', async (t) => {
  // Allow real discovery/health I/O to finish on a busy Windows host. The RPC
  // response itself stays open until the client's actual deadline aborts it.
  const f = await fixture(t, { timeout: 2000 });
  f.state.rpc = () => {};
  await assert.rejects(f.client.call('scene.save'), (error) => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.details.stage, 'rpc');
    assert.equal(error.details.outcome, 'unknown');
    assert.equal(error.details.retryable, false);
    assert.match(error.message, /outcome unknown/u);
    return true;
  });
  assert.equal(f.requests.filter(({ url }) => url === '/rpc').length, 1);
  f.state.rpc = undefined;
  assert.equal((await f.client.call('editor.info')).command, 'editor.info');
});

test('timeout includes a stalled response body, and health timeout prevents dispatch', async (t) => {
  const f = await fixture(t, { timeout: 2000 });
  f.state.health = ({ response }) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); };
  await assert.rejects(f.client.call('scene.save'), (error) => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.details.stage, 'health');
    assert.equal(error.details.outcome, 'not_applied');
    return true;
  });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/health');
  assert.equal(f.requests.filter(({ url }) => url === '/rpc').length, 0);
});

test('cancellation before dispatch is safe and cancellation after dispatch has unknown outcome', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.client.call('scene.save', {}, { signal: controller.signal }), (error) => error.code === 'CANCELLED' && error.details.outcome === 'not_applied');
  assert.equal(f.requests.length, 0);
  const active = new AbortController();
  f.state.rpc = () => active.abort();
  await assert.rejects(f.client.call('scene.save', {}, { signal: active.signal }), (error) => error.code === 'CANCELLED' && error.details.outcome === 'unknown');
  assert.equal(f.requests.length, 2);
});

test('redirects are not followed and cannot leak the session token', async (t) => {
  const f = await fixture(t);
  let leaked = false;
  const target = createServer((_request, response) => { leaked = true; response.end('{}'); });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(async () => { target.closeAllConnections(); await new Promise((resolve) => target.close(resolve)); });
  f.state.health = ({ response }) => { response.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/health` }); response.end(); };
  await assert.rejects(f.client.call('scene.save'), errorCode('BRIDGE_UNAVAILABLE'));
  assert.equal(leaked, false);
});

test('constructor and direct RPC reject invalid input locally', async () => {
  for (const options of [{}, { project: 'relative' }, { project: os.tmpdir(), timeout: 0 },
    { project: os.tmpdir(), timeout: 0.5 }, { project: os.tmpdir(), timeout: 2 ** 31 }]) {
    assert.throws(() => new BridgeClient(options), errorCode('INVALID_ARGUMENT'));
  }
  const client = new BridgeClient({ project: os.tmpdir() });
  await assert.rejects(client.call('scene.save', []), errorCode('INVALID_ARGUMENT'));
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(client.call('scene.save', cycle), errorCode('INVALID_ARGUMENT'));
});
