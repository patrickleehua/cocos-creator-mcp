'use strict';

const test = require('node:test');
const assert = require('assert').strict;
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const createRequire = require('module').createRequire;

// Resolve through the extension's CommonJS package even when the root is ESM.
const extensionRequire = createRequire(path.resolve(__dirname, '../extensions/cocos-creator-mcp/package.json'));
const startBridge = extensionRequire('./bridge.js').startBridge;
const BODY_LIMIT = 2 * 1024 * 1024;

function deferred() {
    let resolve;
    const promise = new Promise(function (done) { resolve = done; });
    return { promise: promise, resolve: resolve };
}

async function until(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for test condition.');
        await new Promise(function (resolve) { setTimeout(resolve, 5); });
    }
}

async function fixture(t, options) {
    options = options || {};
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-http-bridge-'));
    const editor = {
        App: { version: '3.7.3' },
        Project: { path: directory, uuid: 'test-project-uuid', name: 'Test Project' },
    };
    const bridge = await startBridge({
        editor: editor,
        dispatch: options.dispatch || (async function (command, args) { return { command: command, args: args }; }),
        commands: options.commands || ['read', 'write'],
        port: options.port,
    });
    t.after(async function () {
        await bridge.stop();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return {
        bridge: bridge, editor: editor, directory: directory,
        session: JSON.parse(fs.readFileSync(bridge.sessionPath, 'utf8')),
    };
}

function beginRequest(f, options) {
    options = options || {};
    const headers = Object.assign({ Authorization: 'Bearer ' + f.session.token }, options.headers);
    let content = options.raw;
    if (options.data !== undefined) content = JSON.stringify(options.data);
    if (content !== undefined && !options.chunked) {
        if (headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/json';
        if (headers['Content-Length'] === undefined) headers['Content-Length'] = Buffer.byteLength(content);
    }
    if (options.chunked) headers['Content-Type'] = 'application/json';
    Object.keys(headers).forEach(function (key) {
        if (headers[key] === null) delete headers[key];
    });
    let req;
    const response = new Promise(function (resolve, reject) {
        req = http.request({
            host: '127.0.0.1', port: f.bridge.port, path: options.path || '/health',
            method: options.method || (content !== undefined || options.chunked ? 'POST' : 'GET'),
            headers: headers, agent: false,
        }, function (res) {
            const chunks = [];
            res.on('data', function (chunk) { chunks.push(chunk); });
            res.on('error', reject);
            res.on('end', function () {
                const text = Buffer.concat(chunks).toString('utf8');
                try {
                    assert.match(res.headers['content-type'], /^application\/json/);
                    assert.equal(Number(res.headers['content-length']), Buffer.byteLength(text));
                    assert.equal(res.headers['access-control-allow-origin'], undefined);
                    resolve({ status: res.statusCode, headers: res.headers, text: text, body: JSON.parse(text) });
                } catch (error) { reject(error); }
            });
        });
        req.on('error', reject);
        req.setTimeout(options.timeout || 15000, function () { req.destroy(new Error('Test request timed out.')); });
    });
    // Some tests intentionally disconnect a request before they await its result.
    response.catch(function () {});
    if (!options.open) req.end(content);
    else if (content !== undefined) req.write(content);
    return { req: req, response: response };
}

function request(f, options) { return beginRequest(f, options).response; }

function rpcBody(f, id, args, command) {
    return { id: id || crypto.randomBytes(16).toString('hex'), sessionId: f.bridge.sessionId,
        command: command || 'write', args: args === undefined ? {} : args };
}

function rpc(f, id, args, command) {
    return request(f, { path: '/rpc', data: rpcBody(f, id, args, command) });
}

function expectError(response, status, code) {
    assert.equal(response.status, status);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, code);
    assert.equal(typeof response.body.error.message, 'string');
}

test('publishes discovery atomically and exposes authenticated health with a stable identity', async function (t) {
    const f = await fixture(t);
    assert.ok(f.bridge.port > 0);
    assert.equal(f.bridge.sessionPath, path.join(f.directory, 'temp', 'cocos-creator-mcp', 'session.json'));
    assert.deepEqual(Object.keys(f.session).sort(), [
        'editorVersion', 'host', 'pid', 'port', 'project', 'protocolVersion', 'sessionId', 'token',
    ]);
    assert.equal(f.session.host, '127.0.0.1');
    assert.equal(f.session.port, f.bridge.port);
    assert.equal(f.session.sessionId, f.bridge.sessionId);
    assert.equal(f.session.protocolVersion, 1);
    assert.equal(f.session.pid, process.pid);
    assert.match(f.session.token, /^[a-f0-9]{64}$/);
    assert.deepEqual(fs.readdirSync(path.dirname(f.bridge.sessionPath)), ['session.json']);
    const health = await request(f);
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, {
        ok: true, protocolVersion: 1, sessionId: f.bridge.sessionId, editorVersion: '3.7.3',
        project: f.session.project, capabilities: { commands: ['read', 'write'] },
    });
    assert.equal(health.headers['cache-control'], 'no-store');
    assert.equal(health.body.token, undefined);
    f.editor.Project.path = path.join(f.directory, 'another-project');
    f.editor.Project.uuid = 'changed';
    f.editor.App.version = 'changed';
    assert.deepEqual((await request(f)).body, health.body);
    await f.bridge.stop();
    assert.equal(fs.existsSync(f.bridge.sessionPath), false);
    await assert.rejects(request(f), /ECONNREFUSED|ECONNRESET/);
});

test('requires the session Bearer token on health, RPC and unknown routes', async function (t) {
    let calls = 0;
    const f = await fixture(t, { dispatch: async function () { calls++; } });
    for (const authorization of [null, '', 'Basic secret', 'Bearer wrong', 'Bearer ' + f.session.token + '0']) {
        expectError(await request(f, { headers: { Authorization: authorization } }), 401, 'UNAUTHORIZED');
        expectError(await request(f, { path: '/rpc', data: rpcBody(f),
            headers: { Authorization: authorization } }), 401, 'UNAUTHORIZED');
    }
    expectError(await request(f, { path: '/absent', headers: { Authorization: null } }), 401, 'UNAUTHORIZED');
    assert.equal((await request(f, { headers: { Authorization: 'bearer ' + f.session.token } })).status, 200);
    assert.equal(calls, 0);
});

test('validates Host and rejects all browser Origins without CORS headers', async function (t) {
    let calls = 0;
    const f = await fixture(t, { dispatch: async function () { calls++; } });
    for (const host of ['example.org:' + f.bridge.port, '127.0.0.1.evil:' + f.bridge.port,
        'localhost:1', '127.0.0.1', '0.0.0.0:' + f.bridge.port]) {
        expectError(await request(f, { headers: { Host: host } }), 403, 'INVALID_HOST');
    }
    for (const origin of ['https://example.org', 'http://localhost:' + f.bridge.port, 'null', '']) {
        expectError(await request(f, { path: '/rpc', data: rpcBody(f), headers: { Origin: origin } }),
            403, 'ORIGIN_NOT_ALLOWED');
    }
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        assert.equal((await request(f, { headers: { Host: host + ':' + f.bridge.port } })).status, 200);
    }
    assert.equal(calls, 0);
});

test('rejects duplicate security headers and returns JSON for malformed HTTP', async function (t) {
    const f = await fixture(t);
    async function raw(text) {
        return new Promise(function (resolve, reject) {
            const socket = net.connect(f.bridge.port, '127.0.0.1', function () { socket.end(text); });
            let response = '';
            socket.setEncoding('utf8');
            socket.on('data', function (chunk) { response += chunk; });
            socket.on('error', reject);
            socket.on('end', function () {
                try { resolve(JSON.parse(response.split('\r\n\r\n')[1])); } catch (error) { reject(error); }
            });
        });
    }
    const host = 'Host: 127.0.0.1:' + f.bridge.port + '\r\n';
    const auth = 'Authorization: Bearer ' + f.session.token + '\r\n';
    assert.equal((await raw('GET /health HTTP/1.1\r\n' + host + host + auth + '\r\n')).error.code, 'INVALID_HOST');
    assert.equal((await raw('GET /health HTTP/1.1\r\n' + host + auth + auth + '\r\n')).error.code, 'UNAUTHORIZED');
    assert.equal((await raw('NOT HTTP\r\n\r\n')).error.code, 'INVALID_HTTP');
});

test('normalizes undefined results and preserves Editor error codes and JSON details', async function (t) {
    const f = await fixture(t, {
        dispatch: async function (command, args) {
            if (args.mode === 'error') {
                const error = new Error('Editor refused the change.');
                error.code = 'EDITOR_BUSY';
                error.details = { scene: 'scene-1', retry: true };
                throw error;
            }
            if (args.mode === 'number-code') throw { code: 1007, message: 'numeric', details: ['details'] };
            if (args.mode === 'string-error') throw 'plain failure';
            if (args.mode === 'circular') { const result = {}; result.self = result; return result; }
            if (args.mode === 'circular-error') {
                const error = new Error('circular details');
                error.code = 'EDITOR_ERROR';
                error.details = error;
                throw error;
            }
            if (args.mode === 'bigint') return BigInt(1);
            if (args.mode === 'function') return function () {};
            if (args.mode === 'symbol') return Symbol('result');
        },
    });
    assert.deepEqual((await rpc(f, 'empty-result')).body, { id: 'empty-result', ok: true, result: null });
    const error = await rpc(f, 'error-result', { mode: 'error' });
    expectError(error, 200, 'EDITOR_BUSY');
    assert.deepEqual(error.body.error, {
        code: 'EDITOR_BUSY', message: 'Editor refused the change.', details: { scene: 'scene-1', retry: true },
    });
    assert.deepEqual((await rpc(f, 'numeric', { mode: 'number-code' })).body.error,
        { code: 1007, message: 'numeric', details: ['details'] });
    expectError(await rpc(f, 'plain', { mode: 'string-error' }), 200, 'DISPATCH_ERROR');
    expectError(await rpc(f, 'circular', { mode: 'circular' }), 200, 'SERIALIZATION_ERROR');
    expectError(await rpc(f, 'bigint', { mode: 'bigint' }), 200, 'SERIALIZATION_ERROR');
    expectError(await rpc(f, 'function', { mode: 'function' }), 200, 'SERIALIZATION_ERROR');
    expectError(await rpc(f, 'symbol', { mode: 'symbol' }), 200, 'SERIALIZATION_ERROR');
    expectError(await rpc(f, 'circular-error', { mode: 'circular-error' }), 200, 'EDITOR_ERROR');
    assert.equal((await rpc(f, 'after-errors')).body.ok, true);
});

test('rejects malformed JSON, invalid envelopes, invalid sessions and unlisted commands before dispatch', async function (t) {
    let calls = 0;
    const f = await fixture(t, { dispatch: async function () { calls++; } });
    expectError(await request(f, { path: '/rpc', raw: '{oops' }), 400, 'INVALID_JSON');
    expectError(await request(f, { path: '/rpc', raw: '' }), 400, 'INVALID_JSON');
    const base = rpcBody(f, 'valid-id');
    for (const body of [null, [], 1, 'text', {},
        Object.assign({}, base, { id: '' }), Object.assign({}, base, { id: ' ' }),
        Object.assign({}, base, { id: 123 }), Object.assign({}, base, { id: 'x'.repeat(129) }),
        Object.assign({}, base, { args: [] }), Object.assign({}, base, { args: null }),
        Object.assign({}, base, { args: undefined }), Object.assign({}, base, { command: 1 }),
        Object.assign({}, base, { command: '' })]) {
        expectError(await request(f, { path: '/rpc', data: body }), 400, 'INVALID_REQUEST');
    }
    for (const sessionId of [undefined, null, '', 'stale-session']) {
        expectError(await request(f, { path: '/rpc', data: Object.assign({}, base, { sessionId: sessionId }) }),
            409, 'SESSION_MISMATCH');
    }
    for (const command of ['unknown', 'constructor', '__proto__', 'toString']) {
        expectError(await rpc(f, 'bad-' + command, {}, command), 403, 'COMMAND_NOT_ALLOWED');
    }
    const invalidUtf8 = Buffer.concat([Buffer.from('{"value":"'), Buffer.from([255]), Buffer.from('"}')]);
    expectError(await request(f, { path: '/rpc', raw: invalidUtf8 }), 400, 'INVALID_JSON');
    assert.equal(calls, 0);
});

test('checks routes, methods, content type and content encoding with JSON errors', async function (t) {
    const f = await fixture(t);
    expectError(await request(f, { path: '/missing' }), 404, 'NOT_FOUND');
    expectError(await request(f, { path: '/rpc' }), 405, 'METHOD_NOT_ALLOWED');
    expectError(await request(f, { path: '/health', method: 'POST' }), 405, 'METHOD_NOT_ALLOWED');
    expectError(await request(f, { path: '/rpc', data: rpcBody(f), headers: { 'Content-Type': 'text/plain' } }),
        415, 'UNSUPPORTED_MEDIA_TYPE');
    expectError(await request(f, { path: '/rpc', data: rpcBody(f), headers: { 'Content-Type': null } }),
        415, 'UNSUPPORTED_MEDIA_TYPE');
    expectError(await request(f, { path: '/rpc', data: rpcBody(f), headers: { 'Content-Encoding': 'gzip' } }),
        415, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal((await request(f, { path: '/rpc', data: rpcBody(f),
        headers: { 'Content-Type': 'application/json; charset=utf-8' } })).body.ok, true);
});

test('enforces the 2 MiB byte limit for declared and streamed bodies, including multibyte input', async function (t) {
    let calls = 0;
    const f = await fixture(t, { dispatch: async function () { calls++; return true; } });
    const body = rpcBody(f, 'limit', { value: '' });
    const room = BODY_LIMIT - Buffer.byteLength(JSON.stringify(body));
    body.args.value = '界'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3);
    assert.equal(Buffer.byteLength(JSON.stringify(body)), BODY_LIMIT);
    assert.equal((await request(f, { path: '/rpc', data: body })).body.result, true);
    body.id = 'over1';
    body.args.value += 'x';
    expectError(await request(f, { path: '/rpc', data: body }), 413, 'PAYLOAD_TOO_LARGE');
    const streamed = beginRequest(f, { path: '/rpc', open: true, chunked: true });
    streamed.req.write(Buffer.alloc(BODY_LIMIT, 32));
    streamed.req.end(Buffer.from(' '));
    expectError(await streamed.response, 413, 'PAYLOAD_TOO_LARGE');
    assert.equal(calls, 1);
});

test('reads with a finite deadline while health stays responsive', { timeout: 15000 }, async function (t) {
    let calls = 0;
    const f = await fixture(t, { dispatch: async function () { calls++; } });
    const slow = beginRequest(f, { path: '/rpc', open: true, chunked: true });
    slow.req.write('{');
    // Keep sending bytes: the bridge deadline must not be just an idle timeout.
    const trickle = setInterval(function () { slow.req.write(' '); }, 750);
    t.after(function () { clearInterval(trickle); slow.req.destroy(); });
    assert.equal((await request(f)).status, 200);
    expectError(await slow.response, 408, 'REQUEST_TIMEOUT');
    clearInterval(trickle);
    assert.equal(calls, 0);
    assert.equal((await request(f)).status, 200);
});

test('deduplicates pending and queued RPCs, rejects conflicts, and retains serialization after disconnect', async function (t) {
    const gate = deferred();
    t.after(function () { gate.resolve(); });
    let active = 0;
    let maximum = 0;
    const starts = [];
    let validations = 0;
    const f = await fixture(t, {
        commands: function () { validations++; return ['write']; },
        dispatch: async function (command, args) {
            active++;
            maximum = Math.max(maximum, active);
            starts.push(args.index);
            try {
                if (args.index === 1) await gate.promise;
                return { index: args.index };
            } finally { active--; }
        },
    });
    const first = beginRequest(f, { path: '/rpc', data: rpcBody(f, 'first', { index: 1 }) });
    await until(function () { return starts.length === 1; });
    const baseline = validations;
    const retry = rpc(f, 'first', { index: 1 });
    const second = rpc(f, 'second', { index: 2, nested: { a: 1, b: [2, 3] } });
    const secondRetry = rpc(f, 'second', { nested: { b: [2, 3], a: 1 }, index: 2 });
    await until(function () { return validations >= baseline + 3; });
    expectError(await rpc(f, 'first', { index: 9 }), 409, 'REQUEST_ID_CONFLICT');
    expectError(await rpc(f, 'second', { index: 2, nested: { a: 1, b: [3, 2] } }), 409, 'REQUEST_ID_CONFLICT');
    first.req.destroy();
    await assert.rejects(first.response);
    assert.equal((await request(f)).status, 200);
    assert.deepEqual(starts, [1]);
    assert.equal(active, 1);
    gate.resolve();
    const responses = await Promise.all([retry, second, secondRetry]);
    assert.equal(responses.every(function (response) { return response.body.ok; }), true);
    assert.equal(responses[1].text, responses[2].text);
    assert.deepEqual(starts, [1, 2]);
    assert.equal(maximum, 1);
    assert.equal((await rpc(f, 'first', { index: 1 })).text, responses[0].text);
    assert.equal((await rpc(f, 'second', { nested: { a: 1, b: [2, 3] }, index: 2 })).text, responses[1].text);
    assert.deepEqual(starts, [1, 2]);
});

test('caches dispatch errors and snapshots completed results', async function (t) {
    let calls = 0;
    const value = { before: true };
    const f = await fixture(t, { dispatch: async function (command, args) {
        calls++;
        if (args.fail) throw Object.assign(new Error('cached failure'), { code: 'EDITOR_FAILURE' });
        return value;
    } });
    const successful = await rpc(f, 'snapshot');
    value.before = false;
    assert.equal((await rpc(f, 'snapshot')).text, successful.text);
    const failed = await rpc(f, 'failed', { fail: true });
    assert.equal((await rpc(f, 'failed', { fail: true })).text, failed.text);
    assert.equal(calls, 2);
    expectError(await rpc(f, 'snapshot', {}, 'read'), 409, 'REQUEST_ID_CONFLICT');
});

test('expires completed request ids and bounds the completed cache', async function (t) {
    const calls = new Map();
    const f = await fixture(t, { dispatch: async function (command, args) {
        calls.set(args.key, (calls.get(args.key) || 0) + 1);
        return calls.get(args.key);
    } });
    let now = Date.now();
    t.mock.method(Date, 'now', function () { return now; });
    await rpc(f, 'expires', { key: 'expires' });
    assert.equal((await rpc(f, 'expires', { key: 'expires' })).body.result, 1);
    now += 10 * 60 * 1000;
    assert.equal((await rpc(f, 'expires', { key: 'expires' })).body.result, 2);
    await rpc(f, 'oldest', { key: 'oldest' });
    for (let i = 0; i < 256; i++) await rpc(f, 'bounded-' + i, { key: i });
    assert.equal((await rpc(f, 'oldest', { key: 'oldest' })).body.result, 2);
});

test('bounds pending work without evicting requests that are still queued', { timeout: 10000 }, async function (t) {
    const gate = deferred();
    t.after(function () { gate.resolve(); });
    let checks = 0;
    let calls = 0;
    const f = await fixture(t, {
        commands: function () { checks++; return ['write']; },
        dispatch: async function () { calls++; await gate.promise; return calls; },
    });
    const pending = [rpc(f, 'running')];
    await until(function () { return calls === 1; });
    const baseline = checks;
    // Pace socket creation so the test fills the RPC queue rather than the OS
    // TCP accept backlog (notably on Windows under other parallel test runs).
    for (let i = 0; i < 255; i++) {
        pending.push(rpc(f, 'pending-' + i));
        if (i % 16 === 15 || i === 254) {
            await until(function () { return checks >= baseline + i + 1; });
        }
    }
    expectError(await rpc(f, 'overflow'), 503, 'QUEUE_FULL');
    const duplicate = rpc(f, 'running');
    expectError(await rpc(f, 'pending-254', { changed: true }), 409, 'REQUEST_ID_CONFLICT');
    assert.equal(calls, 1);
    gate.resolve();
    const results = await Promise.all(pending.concat([duplicate]));
    assert.equal(results.every(function (result) { return result.body.ok; }), true);
    assert.equal(results[0].text, results[results.length - 1].text);
    assert.equal(calls, 256);
});

test('reports dynamic capabilities and rechecks permissions before queued dispatch', async function (t) {
    let commands = ['write'];
    let calls = 0;
    const gate = deferred();
    t.after(function () { gate.resolve(); });
    let checks = 0;
    const f = await fixture(t, {
        commands: function () { checks++; return commands; },
        dispatch: async function () { calls++; await gate.promise; return null; },
    });
    const first = rpc(f, 'first');
    await until(function () { return calls === 1; });
    const baseline = checks;
    const queued = rpc(f, 'queued');
    await until(function () { return checks > baseline; });
    commands = ['read', 'read'];
    assert.deepEqual((await request(f)).body.capabilities.commands, ['read']);
    expectError(await rpc(f, 'new-write'), 403, 'COMMAND_NOT_ALLOWED');
    gate.resolve();
    assert.equal((await first).body.ok, true);
    expectError(await queued, 200, 'COMMAND_NOT_ALLOWED');
    assert.equal(calls, 1);
});

test('stop is idempotent, drains accepted dispatches and rejects unfinished uploads and new connections', async function (t) {
    const firstGate = deferred();
    const secondGate = deferred();
    t.after(function () { firstGate.resolve(); secondGate.resolve(); });
    const starts = [];
    let checks = 0;
    const f = await fixture(t, {
        commands: function () { checks++; return ['write']; },
        dispatch: async function (command, args) {
            starts.push(args.index);
            await (args.index === 1 ? firstGate.promise : secondGate.promise);
            return args.index;
        },
    });
    const first = rpc(f, 'first', { index: 1 });
    await until(function () { return starts.length === 1; });
    const baseline = checks;
    const second = rpc(f, 'second', { index: 2 });
    await until(function () { return checks > baseline; });
    const upload = beginRequest(f, { path: '/rpc', open: true, chunked: true });
    upload.req.write('{');
    await request(f);
    const idle = net.connect(f.bridge.port, '127.0.0.1');
    idle.on('error', function () {});
    idle.resume();
    await new Promise(function (resolve) { idle.once('connect', resolve); });
    let stopped = false;
    const stopping = f.bridge.stop();
    stopping.then(function () { stopped = true; });
    assert.strictEqual(f.bridge.stop(), stopping);
    assert.equal(fs.existsSync(f.bridge.sessionPath), false);
    expectError(await upload.response, 503, 'BRIDGE_STOPPING');
    await assert.rejects(request(f), /ECONNREFUSED|ECONNRESET/);
    assert.equal(stopped, false);
    assert.deepEqual(starts, [1]);
    firstGate.resolve();
    assert.equal((await first).body.result, 1);
    await until(function () { return starts.length === 2; });
    assert.equal(stopped, false);
    secondGate.resolve();
    assert.equal((await second).body.result, 2);
    await stopping;
    await until(function () { return idle.destroyed; });
    assert.equal(stopped, true);
});

test('replaces stale discovery but an older bridge cannot delete a newer owner', async function (t) {
    const f = await fixture(t);
    const second = await startBridge({ editor: f.editor, dispatch: async function () {}, commands: [] });
    t.after(async function () { await second.stop(); });
    const newer = fs.readFileSync(second.sessionPath, 'utf8');
    assert.notEqual(second.sessionId, f.bridge.sessionId);
    assert.notEqual(JSON.parse(newer).token, f.session.token);
    await f.bridge.stop();
    assert.equal(fs.readFileSync(second.sessionPath, 'utf8'), newer);
    await second.stop();
    assert.equal(fs.existsSync(second.sessionPath), false);
});

test('does not delete malformed or differently owned discovery on stop', async function (t) {
    for (const replacement of ['{incomplete', JSON.stringify({ sessionId: 'another-owner' })]) {
        const f = await fixture(t);
        fs.writeFileSync(f.bridge.sessionPath, replacement);
        await f.bridge.stop();
        assert.equal(fs.readFileSync(f.bridge.sessionPath, 'utf8'), replacement);
    }
    const f = await fixture(t);
    fs.writeFileSync(f.bridge.sessionPath, JSON.stringify(Object.assign({}, f.session, { token: 'other-token' })));
    await f.bridge.stop();
    assert.equal(JSON.parse(fs.readFileSync(f.bridge.sessionPath, 'utf8')).token, 'other-token');
});

test('fails startup cleanly for invalid options, occupied ports and discovery write errors', async function (t) {
    await assert.rejects(startBridge({}), /required/);
    const f = await fixture(t);
    for (const port of [-1, 65536, 1.5, '0']) {
        await assert.rejects(startBridge({ editor: f.editor, dispatch: async function () {}, commands: [], port: port }),
            /port/);
    }
    await assert.rejects(startBridge({ editor: f.editor, dispatch: async function () {}, commands: [null] }), /commands/);
    const before = fs.readFileSync(f.bridge.sessionPath, 'utf8');
    await assert.rejects(startBridge({ editor: f.editor, dispatch: async function () {}, commands: [], port: f.bridge.port }),
        { code: 'EADDRINUSE' });
    assert.equal(fs.readFileSync(f.bridge.sessionPath, 'utf8'), before);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-bridge-write-error-'));
    t.after(function () { fs.rmSync(project, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(project, 'temp'), 'not a directory');
    await assert.rejects(startBridge({ editor: { App: { version: '3.7.3' }, Project: { path: project } },
        dispatch: async function () {}, commands: [] }));
});
