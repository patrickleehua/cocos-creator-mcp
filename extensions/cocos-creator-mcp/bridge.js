'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BODY_LIMIT = 2 * 1024 * 1024;
const BODY_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 60000;
const MAX_REQUESTS = 256;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const SOCKET_DRAIN_MS = 1000;
const REJECT_DRAIN_MS = 1000;

function noop() {}

function failure(code, message, status) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function errorBody(id, error, fallbackCode) {
    let code = fallbackCode || 'INTERNAL_ERROR';
    let message = 'Unexpected bridge error.';
    let details;
    try {
        if (error && (typeof error.code === 'string' ||
            (typeof error.code === 'number' && isFinite(error.code)))) {
            code = error.code;
        }
        message = error && typeof error.message === 'string' ? error.message : String(error);
        if (error && error.details !== undefined) {
            // Editor errors occasionally contain non-JSON values. Never let their
            // diagnostics prevent an error response (or poison the dispatch queue).
            try {
                details = JSON.parse(JSON.stringify(error.details, function (key, value) {
                    return typeof value === 'bigint' ? String(value) : value;
                }));
            } catch (ignored) {
                details = { message: 'Error details are not JSON serializable.' };
            }
        }
    } catch (ignored) {}
    const result = { id: id, ok: false, error: { code: code, message: message } };
    if (details !== undefined) result.error.details = details;
    return result;
}

function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ':' + canonical(value[key]);
    }).join(',') + '}';
}

async function startBridge(options) {
    options = options || {};
    const editor = options.editor;
    const dispatch = options.dispatch;
    const commands = options.commands;
    const requestedPort = options.port === undefined ? 0 : options.port;
    if (!editor || !editor.Project || typeof editor.Project.path !== 'string' ||
        !editor.Project.path.trim() || !editor.App || typeof dispatch !== 'function') {
        throw new TypeError('editor.App, editor.Project.path and dispatch are required.');
    }
    if (typeof requestedPort !== 'number' || !isFinite(requestedPort) ||
        Math.floor(requestedPort) !== requestedPort || requestedPort < 0 || requestedPort > 65535) {
        throw new TypeError('port must be an integer between 0 and 65535.');
    }

    function getCommands() {
        const list = typeof commands === 'function' ? commands() : commands;
        if (!Array.isArray(list) || list.some(function (command) {
            return typeof command !== 'string' || !command.trim();
        })) {
            throw new TypeError('commands must be a string array or a function returning one.');
        }
        return Array.from(new Set(list));
    }
    getCommands();

    // Identity is a snapshot: changing Editor.Project cannot retarget this session.
    const project = {
        path: path.resolve(editor.Project.path),
        uuid: editor.Project.uuid === undefined ? null : editor.Project.uuid,
        name: editor.Project.name === undefined ? null : editor.Project.name,
    };
    const editorVersion = editor.App.version === undefined ? null : editor.App.version;
    const token = crypto.randomBytes(32).toString('hex');
    const sessionId = crypto.randomBytes(16).toString('hex');
    const sessionPath = path.join(project.path, 'temp', 'cocos-creator-mcp', 'session.json');
    const temporaryPath = sessionPath + '.' + sessionId + '.tmp';
    const expectedAuth = Buffer.from('Bearer ' + token);
    const requests = new Map();
    const sockets = new Map();
    const readers = new Set();
    let tail = Promise.resolve();
    let stopping = false;
    let stopPromise;
    let port;
    let cacheTimer;
    let pendingBytes = 0;
    let cachedBytes = 0;

    function verifyProject() {
        if (!editor.Project || typeof editor.Project.path !== 'string' ||
            path.resolve(editor.Project.path) !== project.path ||
            (editor.Project.uuid === undefined ? null : editor.Project.uuid) !== project.uuid ||
            (editor.Project.name === undefined ? null : editor.Project.name) !== project.name ||
            !editor.App || (editor.App.version === undefined ? null : editor.App.version) !== editorVersion) {
            const error = failure('PROJECT_CHANGED', 'Editor identity changed. Restart the project bridge before continuing.', 409);
            error.details = { outcome: 'not_applied', retryable: false };
            throw error;
        }
    }

    function forget(id, entry) {
        requests.delete(id);
        cachedBytes -= entry.responseBytes;
    }

    function trimCache() {
        for (const pair of requests) {
            if (cachedBytes <= MAX_CACHE_BYTES) break;
            if (pair[1].completedAt !== null) forget(pair[0], pair[1]);
        }
    }

    function responseFailure(code, message) {
        const error = failure(code, message, 500);
        // A dispatch may already have changed the project before its result
        // cannot be returned. Never invite a repeated mutation in this case.
        error.details = { outcome: 'unknown', retryable: false };
        return error;
    }

    function send(res, status, value) {
        if (res.finished || res.destroyed || !res.socket || res.socket.destroyed) return;
        const body = typeof value === 'string' ? value : JSON.stringify(value);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            // Also prevents idle keep-alive sockets from delaying Creator unload.
            'Connection': 'close',
        });
        res.end(body);
    }

    function prune() {
        const now = Date.now();
        requests.forEach(function (entry, id) {
            if (entry.completedAt !== null && now - entry.completedAt >= CACHE_TTL_MS) {
                forget(id, entry);
            }
        });
    }

    function makeRoom(bytes) {
        prune();
        if (pendingBytes + bytes > MAX_PENDING_BYTES) {
            throw failure('QUEUE_FULL', 'Pending RPC payloads exceed 16 MiB.', 503);
        }
        if (requests.size < MAX_REQUESTS) return;
        // Never evict queued/running operations: retries must share their promise.
        for (const pair of requests) {
            if (pair[1].completedAt !== null) {
                forget(pair[0], pair[1]);
                return;
            }
        }
        throw failure('QUEUE_FULL', 'Too many pending RPC requests.', 503);
    }

    function enqueue(body, fingerprint, bytes) {
        makeRoom(bytes);
        pendingBytes += bytes;
        const entry = { fingerprint: fingerprint, completedAt: null, promise: null, responseBytes: 0 };
        const operation = tail.then(async function () {
            try {
                if (body.deadline !== undefined && Date.now() >= body.deadline) {
                    const error = failure('REQUEST_EXPIRED', 'RPC expired before native dispatch.', 408);
                    error.details = { outcome: 'not_applied', retryable: false };
                    throw error;
                }
                verifyProject();
                if (getCommands().indexOf(body.command) === -1) {
                    throw failure('COMMAND_NOT_ALLOWED', 'Command is not allowed.', 403);
                }
                // No timeout race here. A disconnected client cannot release this
                // queue while an Editor mutation is still running.
                const result = await dispatch(body.command, body.args);
                try {
                    const response = JSON.stringify({ id: body.id, ok: true, result: result }, function (key, value) {
                        if (typeof value === 'function' || typeof value === 'symbol') {
                            throw new TypeError('Dispatch result contains a non-JSON value.');
                        }
                        return value === undefined ? null : value;
                    });
                    if (Buffer.byteLength(response) > RESPONSE_LIMIT) {
                        throw responseFailure('RESPONSE_TOO_LARGE', 'RPC response exceeds 8 MiB. Narrow the query before calling again.');
                    }
                    return response;
                } catch (error) {
                    if (error.code === 'RESPONSE_TOO_LARGE') throw error;
                    throw responseFailure('SERIALIZATION_ERROR', 'Dispatch result is not JSON serializable.');
                }
            } catch (error) {
                const response = JSON.stringify(errorBody(body.id, error, 'DISPATCH_ERROR'));
                if (Buffer.byteLength(response) > RESPONSE_LIMIT) {
                    return JSON.stringify(errorBody(body.id, responseFailure('RESPONSE_TOO_LARGE', 'RPC error details exceed 8 MiB. Inspect the project before repeating a write.')));
                }
                return response;
            }
        });
        entry.promise = operation.then(function (response) {
            pendingBytes -= bytes;
            entry.completedAt = Date.now();
            entry.responseBytes = Buffer.byteLength(response);
            cachedBytes += entry.responseBytes;
            trimCache();
            return response;
        });
        requests.set(body.id, entry);
        tail = entry.promise.then(noop, noop);
        return entry.promise;
    }

    function readBody(req) {
        return new Promise(function (resolve, reject) {
            let size = 0;
            let chunks = [];
            let done = false;
            const timer = setTimeout(function () {
                finish(failure('REQUEST_TIMEOUT', 'Timed out reading request body.', 408));
            }, BODY_TIMEOUT_MS);

            function finish(error, result) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                readers.delete(cancel);
                req.removeListener('data', onData);
                req.removeListener('end', onEnd);
                req.removeListener('aborted', onAborted);
                req.removeListener('error', onError);
                chunks = [];
                if (error) {
                    req.resume();
                    reject(error);
                } else {
                    resolve(result);
                }
            }
            function cancel() {
                finish(failure('BRIDGE_STOPPING', 'Bridge is stopping.', 503));
            }
            function onData(chunk) {
                size += chunk.length;
                if (size > BODY_LIMIT) {
                    finish(failure('PAYLOAD_TOO_LARGE', 'Request body exceeds 2 MiB.', 413));
                } else {
                    chunks.push(chunk);
                }
            }
            function onEnd() {
                const bytes = Buffer.concat(chunks, size);
                const text = bytes.toString('utf8');
                if (!Buffer.from(text, 'utf8').equals(bytes)) {
                    finish(failure('INVALID_JSON', 'Request body must be UTF-8 JSON.', 400));
                    return;
                }
                try {
                    finish(null, { body: JSON.parse(text), bytes: size });
                } catch (error) {
                    finish(failure('INVALID_JSON', 'Request body must be valid JSON.', 400));
                }
            }
            function onAborted() {
                finish(failure('REQUEST_ABORTED', 'Request body was interrupted.', 400));
            }
            function onError() { onAborted(); }
            readers.add(cancel);
            req.on('data', onData);
            req.on('end', onEnd);
            req.on('aborted', onAborted);
            req.on('error', onError);
        });
    }

    function validateHeaders(req) {
        let hosts = 0;
        let authorizations = 0;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const name = req.rawHeaders[i].toLowerCase();
            if (name === 'host') hosts++;
            if (name === 'authorization') authorizations++;
        }
        const host = String(req.headers.host || '').toLowerCase();
        const allowedHosts = ['127.0.0.1', 'localhost', '[::1]'];
        if (hosts !== 1 || !allowedHosts.some(function (hostname) {
            return host === hostname + ':' + port || (port === 80 && host === hostname);
        })) {
            throw failure('INVALID_HOST', 'Host must address this loopback bridge.', 403);
        }
        // CLI clients omit Origin. Reject even local/empty/null origins so web
        // pages cannot use a leaked token to invoke Editor commands.
        if (req.headers.origin !== undefined) {
            throw failure('ORIGIN_NOT_ALLOWED', 'Requests with Origin are not allowed.', 403);
        }
        const auth = req.headers.authorization;
        const supplied = Buffer.from(typeof auth === 'string' ? auth.replace(/^Bearer /i, 'Bearer ') : '');
        if (authorizations !== 1 || supplied.length !== expectedAuth.length ||
            !crypto.timingSafeEqual(supplied, expectedAuth)) {
            throw failure('UNAUTHORIZED', 'A valid Bearer token is required.', 401);
        }
    }

    function drainRejectedBody(req) {
        if (req.complete || req.aborted || req.destroyed || stopping) return Promise.resolve();
        return new Promise(function (resolve) {
            let done = false;
            const timer = setTimeout(finish, REJECT_DRAIN_MS);
            function finish() {
                if (done) return;
                done = true;
                clearTimeout(timer);
                readers.delete(finish);
                req.removeListener('end', finish);
                req.removeListener('aborted', finish);
                req.removeListener('error', finish);
                resolve();
            }
            readers.add(finish);
            req.once('end', finish);
            req.once('aborted', finish);
            req.once('error', finish);
            // Do not accumulate rejected uploads. A short bounded drain avoids
            // TCP resets hiding JSON errors when a local client is still writing.
            req.resume();
        });
    }

    async function handle(req, res) {
        let id = null;
        try {
            if (stopping) throw failure('BRIDGE_STOPPING', 'Bridge is stopping.', 503);
            validateHeaders(req);
            verifyProject();
            if (req.method === 'GET' && req.url === '/health') {
                send(res, 200, {
                    ok: true, protocolVersion: 1, sessionId: sessionId,
                    editorVersion: editorVersion, project: project,
                    capabilities: { commands: getCommands() },
                });
                return;
            }
            if (req.url !== '/rpc' && req.url !== '/health') {
                throw failure('NOT_FOUND', 'Unknown bridge route.', 404);
            }
            if (req.method !== 'POST' || req.url !== '/rpc') {
                throw failure('METHOD_NOT_ALLOWED', 'Method is not allowed for this route.', 405);
            }
            if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '') ||
                (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
                throw failure('UNSUPPORTED_MEDIA_TYPE', 'Use uncompressed application/json.', 415);
            }
            if (Number(req.headers['content-length']) > BODY_LIMIT) {
                throw failure('PAYLOAD_TOO_LARGE', 'Request body exceeds 2 MiB.', 413);
            }
            const payload = await readBody(req);
            const body = payload.body;
            if (stopping) throw failure('BRIDGE_STOPPING', 'Bridge is stopping.', 503);
            if (body && typeof body.id === 'string') id = body.id;
            if (!body || typeof body !== 'object' || Array.isArray(body) ||
                typeof body.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(body.id) ||
                typeof body.command !== 'string' || !body.command.trim() ||
                !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) {
                throw failure('INVALID_REQUEST', 'RPC requires a valid id, command and object args.', 400);
            }
            if (body.sessionId !== sessionId) {
                throw failure('SESSION_MISMATCH', 'RPC sessionId does not match this Editor session.', 409);
            }
            if (body.deadline !== undefined && (!Number.isSafeInteger(body.deadline) || body.deadline <= 0)) {
                throw failure('INVALID_REQUEST', 'RPC deadline must be a positive Unix time in milliseconds.', 400);
            }
            if (getCommands().indexOf(body.command) === -1) {
                throw failure('COMMAND_NOT_ALLOWED', 'Command is not allowed.', 403);
            }
            let fingerprint;
            try {
                fingerprint = crypto.createHash('sha256').update(canonical({
                    command: body.command, args: body.args,
                })).digest('hex');
            } catch (error) {
                throw failure('INVALID_REQUEST', 'RPC args are nested too deeply.', 400);
            }
            prune();
            const previous = requests.get(body.id);
            if (previous && previous.fingerprint !== fingerprint) {
                throw failure('REQUEST_ID_CONFLICT', 'Request id was already used with different parameters.', 409);
            }
            const response = await (previous ? previous.promise : enqueue(body, fingerprint, payload.bytes));
            send(res, 200, response);
        } catch (error) {
            req.resume();
            if (error.code !== 'REQUEST_TIMEOUT' && error.code !== 'REQUEST_ABORTED') {
                await drainRejectedBody(req);
            }
            if (error && error.code === 'UNAUTHORIZED') res.setHeader('WWW-Authenticate', 'Bearer');
            send(res, error.status || 500, errorBody(id, error));
        }
    }

    const server = http.createServer(function (req, res) {
        const socket = req.socket;
        sockets.set(socket, (sockets.get(socket) || 0) + 1);
        let finished = false;
        function onFinished() {
            if (finished) return;
            finished = true;
            if (sockets.has(socket)) sockets.set(socket, sockets.get(socket) - 1);
        }
        res.once('finish', onFinished);
        res.once('close', onFinished);
        req.on('error', noop);
        res.on('error', noop);
        handle(req, res).catch(function () { socket.destroy(); });
    });
    server.timeout = 0;
    server.headersTimeout = BODY_TIMEOUT_MS;
    server.on('connection', function (socket) {
        sockets.set(socket, 0);
        socket.on('close', function () { sockets.delete(socket); });
    });
    server.on('clientError', function (error, socket) {
        if (socket.destroyed || !socket.writable || socket.writableEnded) return;
        const body = JSON.stringify(errorBody(null, failure('INVALID_HTTP', 'Malformed HTTP request.', 400)));
        socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\n' +
            'Connection: close\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
    });

    function removeOwnDiscovery() {
        let current;
        try {
            current = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT' || error instanceof SyntaxError) return;
            throw error;
        }
        if (current && current.sessionId === sessionId && current.token === token &&
            current.port === port && current.pid === process.pid) {
            fs.unlinkSync(sessionPath);
        }
    }

    function stop() {
        if (stopPromise) return stopPromise;
        stopping = true;
        clearInterval(cacheTimer);
        // Drain every accepted RPC, including queued requests. A pending dispatch
        // deliberately keeps stop pending; socket drain limits never cancel it.
        stopPromise = (async function () {
            const closed = new Promise(function (resolve) { server.close(resolve); });
            let cleanupError;
            try { removeOwnDiscovery(); } catch (error) { cleanupError = error; }
            readers.forEach(function (cancel) { cancel(); });
            sockets.forEach(function (active, socket) { if (!active) socket.destroy(); });
            await tail;
            const timer = setTimeout(function () {
                sockets.forEach(function (active, socket) { socket.destroy(); });
            }, SOCKET_DRAIN_MS);
            await closed;
            clearTimeout(timer);
            requests.clear();
            if (cleanupError) throw cleanupError;
        })();
        return stopPromise;
    }

    try {
        await new Promise(function (resolve, reject) {
            server.once('error', reject);
            server.listen(requestedPort, '127.0.0.1', function () {
                server.removeListener('error', reject);
                resolve();
            });
        });
        port = server.address().port;
        fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
        fs.writeFileSync(temporaryPath, JSON.stringify({
            protocolVersion: 1, host: '127.0.0.1', port: port, token: token,
            sessionId: sessionId, editorVersion: editorVersion, project: project, pid: process.pid,
        }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporaryPath, sessionPath);
        cacheTimer = setInterval(prune, CACHE_TTL_MS);
        cacheTimer.unref();
    } catch (error) {
        try { fs.unlinkSync(temporaryPath); } catch (ignored) {}
        await stop();
        throw error;
    }

    return { port: port, sessionId: sessionId, sessionPath: sessionPath, stop: stop };
}

module.exports = { startBridge: startBridge };
