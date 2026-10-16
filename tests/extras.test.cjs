'use strict';

const test = require('node:test');
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const createRequire = require('module').createRequire;

const extensionRequire = createRequire(path.resolve(__dirname, '../extensions/cocos-creator-mcp/package.json'));
const createExtras = extensionRequire('./extras.js').createExtras;
const PREVIEW = ['open', 'query-preview-url', 'reload-terminal', 'preview-scene-in-browser'];
const SCENE_UUID = '12c34a56-789b-4cde-8f01-23456789abcd';
const BUILDER = ['command-build', 'query-tasks-info', 'query-task', 'break-task', 'query-platform-config',
    'check-and-complete-options', 'add-task'];

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function (yes, no) { resolve = yes; reject = no; });
    return { promise: promise, resolve: resolve, reject: reject };
}

async function until(predicate) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(function (resolve) { setImmediate(resolve); });
    }
    assert.fail('Test condition did not become true.');
}

function fixture(t, options) {
    options = options || {};
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-extras-'));
    for (const name of ['preview', 'builder']) {
        if (options[name] === null) continue;
        const messages = {};
        for (const message of options[name] || (name === 'preview' ? PREVIEW : BUILDER)) {
            messages[message] = { methods: [message] };
        }
        const target = path.join(directory, 'builtin', name);
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ contributions: { messages: messages } }));
    }
    const calls = [];
    const scene = Object.assign({
        ready: true, dirty: false,
        tree: { uuid: SCENE_UUID, name: 'Saved Scene', type: 'cc.Scene', children: [] },
    }, options.scene);
    const editor = {
        App: { path: directory, version: '3.7.3' },
        Message: { request: function (moduleName, message, ...args) {
            calls.push({ module: moduleName, message: message, args: args });
            if (moduleName === 'scene') {
                assert.deepEqual(args, []);
                if (message === 'query-is-ready') return scene.ready;
                if (message === 'query-dirty') return scene.dirty;
                if (message === 'query-node-tree') return scene.tree;
                assert.fail('Unexpected scene operation: ' + message);
            }
            if (options.request) return options.request(moduleName, message, ...args);
            if (message === 'query-tasks-info') return { queue: {}, free: true };
            throw new Error('Unexpected native call: ' + moduleName + '/' + message);
        } },
    };
    if (options.logger) editor.Logger = options.logger;
    if (options.profile) editor.Profile = options.profile;
    const extras = createExtras(editor);
    t.after(function () {
        extras.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { editor: editor, extras: extras, handlers: extras.handlers, calls: calls, scene: scene, directory: directory };
}

function buildFixture(t, options) {
    options = options || {};
    const build = deferred();
    t.after(function () { build.resolve(34); });
    const queue = { queue: {}, free: true };
    const f = fixture(t, Object.assign({}, options, { request: function (moduleName, message, ...args) {
        if (options.request) {
            const handled = options.request(moduleName, message, ...args);
            if (handled !== undefined) return handled;
        }
        if (message === 'query-tasks-info') return queue;
        if (message === 'command-build') return build.promise;
        if (message === 'break-task') return undefined;
        throw new Error('Unexpected native call: ' + message);
    } }));
    return Object.assign(f, { build: build, queue: queue });
}

const start = (f, options) => f.handlers['build.start']({ options: options || { platform: 'web-desktop' } });
const status = (f, taskId) => f.handlers['build.status'](taskId ? { taskId: taskId } : {});
const cancel = (f, taskId) => f.handlers['build.cancel']({ taskId: taskId });
const messages = (f, name) => f.calls.filter(call => call.message === name);
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('exposes preview.open only with the real browser-preview message and URL query, not the configuration-panel open', function (t) {
    const all = fixture(t);
    assert.deepEqual(Object.keys(all.handlers).sort(), [
        'build.cancel', 'build.config', 'build.start', 'build.status', 'preview.info', 'preview.open', 'preview.refresh',
    ]);
    assert.equal(typeof all.handlers['preview.open'], 'function');
    assert.equal(all.handlers['editor.logs'], undefined);
    const limited = fixture(t, { preview: ['open', 'query-preview-url'], builder: ['add-task', 'command-build'] });
    assert.deepEqual(Object.keys(limited.handlers), ['preview.info']);
    const browser = fixture(t, { preview: ['query-preview-url', 'preview-scene-in-browser'], builder: [] });
    assert.deepEqual(Object.keys(browser.handlers).sort(), ['preview.info', 'preview.open']);
    const noUrl = fixture(t, { preview: ['open', 'preview-scene-in-browser'], builder: [] });
    assert.deepEqual(Object.keys(noUrl.handlers), []);
    const missing = fixture(t, { preview: null, builder: null });
    assert.deepEqual(Object.keys(missing.handlers), []);
    fs.writeFileSync(path.join(all.directory, 'builtin', 'preview', 'package.json'), '{invalid');
    fs.writeFileSync(path.join(all.directory, 'builtin', 'builder', 'package.json'),
        JSON.stringify({ contributions: { messages: { 'command-build': { methods: [] } } } }));
    const malformed = createExtras(all.editor);
    assert.deepEqual(Object.keys(malformed.handlers), []);
    malformed.dispose();
    fs.writeFileSync(path.join(browser.directory, 'builtin', 'preview', 'package.json'), JSON.stringify({
        contributions: { messages: {
            'query-preview-url': { methods: ['queryPreviewUrl'] },
            'preview-scene-in-browser': { methods: [] },
            open: { methods: ['open'] },
        } },
    }));
    const noBrowserMethod = createExtras(browser.editor);
    assert.deepEqual(Object.keys(noBrowserMethod.handlers), ['preview.info']);
    noBrowserMethod.dispose();
    for (const methods of [[null], [' '], [123], ['open', null]]) {
        fs.writeFileSync(path.join(browser.directory, 'builtin', 'preview', 'package.json'), JSON.stringify({
            contributions: { messages: { 'query-preview-url': { methods: methods } } },
        }));
        const invalidMethods = createExtras(browser.editor);
        assert.deepEqual(Object.keys(invalidMethods.handlers), []);
        invalidMethods.dispose();
    }
});

test('preview.info reads the actual native URL and refresh sends reload-terminal, without claiming browser startup', async function (t) {
    const f = fixture(t, { request: function (moduleName, message) {
        assert.equal(moduleName, 'preview');
        if (message === 'query-preview-url') return 'http://127.0.0.1:7456/';
        if (message === 'reload-terminal') return undefined;
        assert.fail('Must not open the preview configuration panel.');
    } });
    assert.deepEqual(await f.handlers['preview.info']({}), {
        url: 'http://127.0.0.1:7456/', source: 'preview/query-preview-url',
    });
    assert.deepEqual(await f.handlers['preview.refresh']({}), {
        requested: true, source: 'preview/reload-terminal', result: null,
    });
    assert.deepEqual(f.calls.map(call => call.message), ['query-preview-url', 'reload-terminal']);
    assert.equal(f.calls.every(call => call.args.length === 0), true);
});

test('preview forwards native failures and refuses invalid URLs or rejected reloads', async function (t) {
    let value;
    const failure = Object.assign(new Error('preview unavailable'), { code: 'PREVIEW_UNAVAILABLE' });
    const f = fixture(t, { request: function () { if (value === failure) throw failure; return value; } });
    for (value of [undefined, null, false, '', 'javascript:alert(1)', 'file:///tmp/preview']) {
        await rejectsCode(f.handlers['preview.info']({}), 'INVALID_NATIVE_RESULT');
    }
    value = false;
    await rejectsCode(f.handlers['preview.refresh']({}), 'EDITOR_REJECTED');
    value = failure;
    await assert.rejects(f.handlers['preview.info']({}), error => error === failure);
    await assert.rejects(f.handlers['preview.refresh']({}), error => error === failure);
});

test('preview.open sends the saved scene asset UUID to native browser preview before reporting requested', async function (t) {
    const launch = deferred();
    t.after(() => launch.resolve());
    const f = fixture(t, {
        scene: { tree: {
            uuid: SCENE_UUID, name: 'Saved Scene', type: 'cc.Scene',
            children: [{ uuid: 'runtime-child-node-uuid', name: 'Canvas' }],
        } },
        request: function (moduleName, message, ...args) {
            assert.equal(moduleName, 'preview');
            if (message === 'query-preview-url') { assert.deepEqual(args, []); return 'http://127.0.0.1:7456/'; }
            assert.equal(message, 'preview-scene-in-browser');
            assert.deepEqual(args, [SCENE_UUID]);
            return launch.promise;
        },
    });
    let settled = false;
    const pending = f.handlers['preview.open']({ sceneUuid: 'caller-supplied-wrong-uuid' });
    pending.then(() => { settled = true; }, () => { settled = true; });
    await until(() => messages(f, 'preview-scene-in-browser').length === 1);
    assert.equal(settled, false);
    assert.deepEqual(f.calls, [
        { module: 'scene', message: 'query-is-ready', args: [] },
        { module: 'scene', message: 'query-dirty', args: [] },
        { module: 'scene', message: 'query-node-tree', args: [] },
        { module: 'preview', message: 'query-preview-url', args: [] },
        { module: 'preview', message: 'preview-scene-in-browser', args: [SCENE_UUID] },
    ]);
    launch.resolve(undefined);
    const result = await pending;
    assert.deepEqual(result, {
        requested: true, url: 'http://localhost:7456/?scene=' + SCENE_UUID,
        sceneUuid: SCENE_UUID, source: 'preview/preview-scene-in-browser',
    });
    assert.equal(messages(f, 'open').length, 0);
});

test('preview.open refuses a scene that is not strictly ready without querying or starting preview', async function (t) {
    for (const ready of [false, undefined, null, 'true', 1]) {
        const f = fixture(t, { scene: { ready: ready } });
        await rejectsCode(f.handlers['preview.open']({}), 'SCENE_NOT_READY');
        assert.deepEqual(f.calls, [{ module: 'scene', message: 'query-is-ready', args: [] }]);
    }
});

test('preview.open refuses unsaved changes without reading a preview URL or invoking browser preview', async function (t) {
    const f = fixture(t, { scene: { dirty: true } });
    await rejectsCode(f.handlers['preview.open']({}), 'UNSAVED_CHANGES');
    assert.deepEqual(f.calls, [
        { module: 'scene', message: 'query-is-ready', args: [] },
        { module: 'scene', message: 'query-dirty', args: [] },
    ]);
    assert.equal(f.calls.some(call => call.module === 'preview'), false);
});

test('preview.open requires a saved scene root UUID and cannot preview a child node or another root type', async function (t) {
    for (const tree of [null, [], {}, { uuid: '', type: 'cc.Scene' },
        { type: 'cc.Scene', children: [{ uuid: SCENE_UUID }] },
        { uuid: SCENE_UUID, type: 'cc.Node' }, [{ uuid: SCENE_UUID, type: 'cc.Node' }]]) {
        const f = fixture(t, { scene: { tree: tree } });
        await rejectsCode(f.handlers['preview.open']({}), 'SCENE_NOT_READY');
        assert.deepEqual(f.calls.map(call => call.message), ['query-is-ready', 'query-dirty', 'query-node-tree']);
        assert.equal(f.calls.some(call => call.module === 'preview'), false);
    }
});

test('preview.open uses the scene root for the URL and native UUID, preserving the queried port and other URL fields', async function (t) {
    const root = { uuid: SCENE_UUID, type: 'cc.Scene', children: [{ uuid: 'child-not-a-scene-asset' }] };
    const before = JSON.stringify(root);
    for (const tree of [root, [root, { uuid: 'another-root-uuid', type: 'cc.Scene' }]]) {
        const f = fixture(t, {
            scene: { tree: tree },
            request: function (moduleName, message, ...args) {
                assert.equal(moduleName, 'preview');
                if (message === 'query-preview-url') {
                    return 'http://192.168.1.42:8222/game/index.html?scene=old-main-scene&debug=true&scene=other-scene#preview';
                }
                assert.equal(message, 'preview-scene-in-browser');
                assert.deepEqual(args, [SCENE_UUID]);
                return true;
            },
        });
        const result = await f.handlers['preview.open']({});
        assert.equal(result.requested, true);
        assert.equal(result.sceneUuid, SCENE_UUID);
        const url = new URL(result.url);
        assert.equal(url.protocol, 'http:');
        assert.equal(url.hostname, 'localhost');
        assert.equal(url.port, '8222');
        assert.equal(url.pathname, '/game/index.html');
        assert.equal(url.hash, '#preview');
        assert.equal(url.searchParams.get('debug'), 'true');
        assert.deepEqual(url.searchParams.getAll('scene'), [SCENE_UUID]);
        assert.deepEqual(messages(f, 'preview-scene-in-browser').map(call => call.args), [[SCENE_UUID]]);
        assert.equal(messages(f, 'open').length, 0);
    }
    assert.equal(JSON.stringify(root), before);
});

test('preview.open propagates a native rejection or false reply instead of reporting requested', async function (t) {
    const failure = Object.assign(new Error('Native browser preview failed'), { code: 'PREVIEW_START_FAILED' });
    let rejected;
    const f = fixture(t, { request: function (moduleName, message, ...args) {
        assert.equal(moduleName, 'preview');
        if (message === 'query-preview-url') return 'http://127.0.0.1:7456/';
        assert.equal(message, 'preview-scene-in-browser');
        assert.deepEqual(args, [SCENE_UUID]);
        if (rejected) return Promise.reject(failure);
        return false;
    } });
    await rejectsCode(f.handlers['preview.open']({}), 'EDITOR_REJECTED');
    rejected = true;
    await assert.rejects(f.handlers['preview.open']({}), error => error === failure);
    assert.deepEqual(messages(f, 'preview-scene-in-browser').map(call => call.args), [[SCENE_UUID], [SCENE_UUID]]);
    assert.equal(messages(f, 'open').length, 0);
});

test('preview.open cannot report requested or launch a browser if the native URL query fails', async function (t) {
    const failure = Object.assign(new Error('Preview server is unavailable'), { code: 'PREVIEW_UNAVAILABLE' });
    let value;
    const f = fixture(t, { request: function (moduleName, message) {
        assert.equal(moduleName, 'preview');
        assert.equal(message, 'query-preview-url');
        if (value === failure) throw failure;
        return value;
    } });
    for (value of [undefined, null, false, '', 'javascript:alert(1)', 'file:///tmp/preview']) {
        await rejectsCode(f.handlers['preview.open']({}), 'INVALID_NATIVE_RESULT');
    }
    value = failure;
    await assert.rejects(f.handlers['preview.open']({}), error => error === failure);
    assert.equal(messages(f, 'preview-scene-in-browser').length, 0);
    assert.equal(messages(f, 'open').length, 0);
});

test('preview.open cannot claim a native preview request when disposed during its read-only preflight', async function (t) {
    const url = deferred();
    t.after(() => url.resolve('http://127.0.0.1:7456/'));
    const f = fixture(t, { request: function (moduleName, message) {
        assert.equal(moduleName, 'preview');
        assert.equal(message, 'query-preview-url');
        return url.promise;
    } });
    const pending = f.handlers['preview.open']({});
    await until(() => messages(f, 'query-preview-url').length === 1);
    f.extras.dispose();
    url.resolve('http://127.0.0.1:7456/');
    await rejectsCode(pending, 'EXTRAS_DISPOSED');
    assert.equal(messages(f, 'preview-scene-in-browser').length, 0);
    assert.equal(messages(f, 'open').length, 0);
});

test('build.config returns native platform configuration or the native project profile', async function (t) {
    const config = { platform: 'web-desktop', options: { debug: true } };
    let queried = 0;
    const f = fixture(t, {
        request: function (moduleName, message, platform) {
            assert.equal(moduleName, 'builder');
            assert.equal(message, 'query-platform-config');
            assert.equal(platform, 'web-desktop');
            return config;
        },
        profile: { getProject: async function (name) { assert.equal(name, 'builder'); queried++; return { tasks: ['native-task'] }; } },
    });
    const result = await f.handlers['build.config']({ options: { platform: 'web-desktop' } });
    assert.deepEqual(result, { source: 'builder/query-platform-config', platform: 'web-desktop', config: config });
    result.config.options.debug = false;
    assert.equal(config.options.debug, true);
    assert.deepEqual(await f.handlers['build.config']({}), {
        source: 'Editor.Profile.getProject(builder)', config: { tasks: ['native-task'] },
    });
    assert.equal(queried, 1);
    await rejectsCode(f.handlers['build.config']({ platform: '' }), 'INVALID_ARGUMENT');
    await rejectsCode(f.handlers['build.config']({ options: [] }), 'INVALID_ARGUMENT');
    const onlyProfile = fixture(t, { builder: null, preview: null, profile: { getProject: async () => ({ native: true }) } });
    assert.equal((await onlyProfile.handlers['build.config']({})).config.native, true);
    await rejectsCode(onlyProfile.handlers['build.config']({ platform: 'web-desktop' }), 'UNSUPPORTED_COMMAND');
    const missing = fixture(t, { request: () => undefined });
    await rejectsCode(missing.handlers['build.config']({}), 'INVALID_ARGUMENT');
    await rejectsCode(missing.handlers['build.config']({ platform: 'web-desktop' }), 'CONFIG_NOT_FOUND');
});

test('unrecognized logs preserve the scoped native snapshot and reject filters without replacing console', async function (t) {
    const originalConsole = { log: console.log, warn: console.warn, error: console.error };
    const native = { records: [{ type: 'warn', text: 'real native record' }] };
    let reads = 0;
    const f = fixture(t, { logger: { query: async function () { reads++; return native; } } });
    const result = await f.handlers['editor.logs']({});
    assert.match(result.scope, /native Editor.Logger.query snapshot/);
    assert.match(result.scope, /unfiltered/);
    assert.deepEqual(result.native, native);
    result.native.records[0].text = 'changed by caller';
    assert.equal(native.records[0].text, 'real native record');
    for (const args of [{ level: 'warn' }, { limit: 10 }, { since: 123 }]) {
        await rejectsCode(f.handlers['editor.logs'](args), 'UNSUPPORTED_FILTER');
    }
    assert.equal(reads, 4);
    f.extras.dispose();
    assert.equal(console.log, originalConsole.log);
    assert.equal(console.warn, originalConsole.warn);
    assert.equal(console.error, originalConsole.error);
    await rejectsCode(f.handlers['editor.logs']({}), 'EXTRAS_DISPOSED');
    const absent = fixture(t, { logger: { query: () => undefined } });
    await rejectsCode(absent.handlers['editor.logs']({}), 'INVALID_NATIVE_RESULT');
});

test('native log arrays normalize timestamp and level while preserving process, stack, source and native fields', async function (t) {
    const native = [
        { process: 'renderer', type: 'warn', message: 'renderer warning', stack: ['scene.ts:12'], time: 1700000000003,
            source: { file: 'scene.ts', line: 12 } },
        { process: 'browser', type: 'log', message: 'browser log', stack: '', time: 1700000000001 },
        { process: 'browser', type: 'info', message: 'browser info', stack: 'browser.js:8', time: 1700000000002 },
        { process: 'renderer', type: 'error', message: 'renderer error', stack: null, time: 1700000000004 },
    ];
    const original = JSON.stringify(native);
    const originalConsole = [console.log, console.info, console.warn, console.error];
    let reads = 0;
    const f = fixture(t, { logger: { query: function () { reads++; return native; } } });
    const result = await f.handlers['editor.logs']({});
    assert.equal(reads, 1);
    assert.match(result.scope, /native Editor.Logger.query entries/);
    assert.equal(result.source, 'Editor.Logger.query');
    assert.equal(result.total, 4);
    assert.equal(result.limit, 100);
    assert.equal(result.truncated, false);
    assert.equal(result.native, undefined); // Do not bypass the response limit with a second raw array.
    assert.deepEqual(result.entries, [native[1], native[2], native[0], native[3]].map(function (entry) {
        return Object.assign({}, entry, {
            timestamp: entry.time, level: entry.type === 'log' ? 'info' : entry.type,
            source: entry.source === undefined ? 'Editor.Logger.query' : entry.source,
        });
    }));
    result.entries[2].stack.push('caller-added stack frame');
    result.entries[2].source.line = 999;
    assert.equal(JSON.stringify(native), original);
    assert.deepEqual([console.log, console.info, console.warn, console.error], originalConsole);
    f.extras.dispose();
    await rejectsCode(f.handlers['editor.logs']({}), 'EXTRAS_DISPOSED');
    assert.equal(reads, 1);
});

test('native logs filter normalized levels and inclusive millisecond timestamps, including numeric strings', async function (t) {
    const native = [
        { process: 'browser', type: 'log', message: 'a', stack: '', time: 1700000000000 },
        { process: 'renderer', type: 'info', message: 'b', stack: '', time: 1700000000001 },
        { process: 'browser', type: 'warn', message: 'c', stack: '', time: 1700000000002 },
        { process: 'renderer', type: 'error', message: 'd', stack: '', time: 1700000000003 },
    ];
    const f = fixture(t, { logger: { query: () => native } });
    for (const pair of [['all', ['a', 'b', 'c', 'd']], ['info', ['a', 'b']], ['warn', ['c']], ['error', ['d']]]) {
        const result = await f.handlers['editor.logs']({ level: pair[0] });
        assert.deepEqual(result.entries.map(entry => entry.message), pair[1]);
    }
    for (const since of [1700000000001, '1700000000001', ' 1700000000001 ']) {
        const result = await f.handlers['editor.logs']({ level: 'info', since: since });
        assert.deepEqual(result.entries.map(entry => entry.message), ['b']);
        assert.equal(result.entries[0].timestamp, 1700000000001);
    }
    assert.equal((await f.handlers['editor.logs']({ since: 0 })).entries.length, 4);
    const empty = await f.handlers['editor.logs']({ since: 1700000000004 });
    assert.deepEqual(empty.entries, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.truncated, false);
});

test('native log responses default to the latest 100 entries and clamp explicit limits to 1000', async function (t) {
    const native = Array.from({ length: 1105 }, (_, index) => ({
        process: index % 2 ? 'renderer' : 'browser', type: index % 2 ? 'warn' : 'info',
        message: 'entry-' + index, stack: '', time: index,
    })).reverse();
    const original = JSON.stringify(native);
    const f = fixture(t, { logger: { query: () => native } });
    const defaults = await f.handlers['editor.logs']({});
    assert.equal(defaults.entries.length, 100);
    assert.equal(defaults.entries[0].timestamp, 1005);
    assert.equal(defaults.entries[99].timestamp, 1104);
    assert.equal(defaults.total, 1105);
    assert.equal(defaults.truncated, true);
    const bounded = await f.handlers['editor.logs']({ limit: 100000 });
    assert.equal(bounded.limit, 1000);
    assert.equal(bounded.entries.length, 1000);
    assert.equal(bounded.entries[0].timestamp, 105);
    assert.equal(bounded.entries[999].timestamp, 1104);
    assert.equal(bounded.native, undefined);
    const combined = await f.handlers['editor.logs']({ level: 'warn', since: 1090, limit: 2 });
    assert.deepEqual(combined.entries.map(entry => entry.timestamp), [1101, 1103]);
    assert.equal(combined.total, 7);
    assert.equal(combined.truncated, true);
    assert.equal(JSON.stringify(native), original);
});

test('native log sorting preserves equal-time order and accepts empty native arrays', async function (t) {
    let native = [
        { process: 'renderer', type: 'warn', message: 'first at time 1', time: 1, source: 'renderer.ts' },
        { process: 'browser', type: 'log', message: 'second at time 1', time: 1, source: null },
    ];
    const f = fixture(t, { logger: { query: () => native } });
    const result = await f.handlers['editor.logs']({});
    assert.deepEqual(result.entries.map(entry => entry.message), ['first at time 1', 'second at time 1']);
    assert.deepEqual(result.entries.map(entry => entry.source), ['renderer.ts', null]);
    native = [];
    const empty = await f.handlers['editor.logs']({ level: 'error', since: 0, limit: 1 });
    assert.deepEqual(empty.entries, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.truncated, false);
});

test('recognized native log filters reject invalid levels, limits and timestamps instead of coercing them', async function (t) {
    const f = fixture(t, { logger: { query: () => [
        { process: 'browser', type: 'info', message: 'native record', stack: '', time: 100 },
    ] } });
    for (const level of [null, '', 'log', 'debug', 'WARN', 1, true]) {
        await rejectsCode(f.handlers['editor.logs']({ level: level }), 'INVALID_ARGUMENT');
    }
    for (const limit of [null, 0, -1, 1.5, '5', true, NaN, Infinity]) {
        await rejectsCode(f.handlers['editor.logs']({ limit: limit }), 'INVALID_ARGUMENT');
    }
    for (const since of [null, -1, NaN, Infinity, '', ' ', 'cursor-1', '0x10', '-1', {}, [], true]) {
        await rejectsCode(f.handlers['editor.logs']({ since: since }), 'INVALID_ARGUMENT');
    }
});

test('mixed or unfamiliar native arrays preserve every record and refuse to claim filtered results', async function (t) {
    const known = { process: 'browser', type: 'info', message: 'known', stack: '', time: 10 };
    for (const native of [
        [known, null], [known, { message: 'unknown format' }],
        [Object.assign({}, known, { type: 'debug' })],
        [Object.assign({}, known, { process: 'unknown-process' })],
        [Object.assign({}, known, { time: '10' })],
        [Object.assign({}, known, { message: { text: 'structured message' } })],
    ]) {
        const f = fixture(t, { logger: { query: () => native } });
        const snapshot = await f.handlers['editor.logs']({});
        assert.match(snapshot.scope, /unfiltered native format/);
        assert.deepEqual(snapshot.native, native);
        assert.equal(snapshot.entries, undefined);
        await rejectsCode(f.handlers['editor.logs']({ level: 'all' }), 'UNSUPPORTED_FILTER');
        await rejectsCode(f.handlers['editor.logs']({ limit: 1000 }), 'UNSUPPORTED_FILTER');
        await rejectsCode(f.handlers['editor.logs']({ since: 0 }), 'UNSUPPORTED_FILTER');
    }
});

test('native log format is checked on every query and native read failures are preserved', async function (t) {
    let native = [{ process: 'browser', type: 'info', message: 'record', stack: '', time: 1 }];
    const failure = Object.assign(new Error('native logger failed'), { code: 'LOGGER_UNAVAILABLE', details: { process: 'browser' } });
    let throws = false;
    const f = fixture(t, { logger: { query: async function () { if (throws) throw failure; return native; } } });
    assert.equal((await f.handlers['editor.logs']({ level: 'info' })).entries.length, 1);
    native = { records: ['changed native format'] };
    await rejectsCode(f.handlers['editor.logs']({ level: 'info' }), 'UNSUPPORTED_FILTER');
    assert.deepEqual((await f.handlers['editor.logs']({})).native, native);
    native = [];
    assert.deepEqual((await f.handlers['editor.logs']({ limit: 1 })).entries, []);
    throws = true;
    await assert.rejects(f.handlers['editor.logs']({}), error => error === failure);
});

test('build.start returns a local job immediately while the native completion promise is still pending', async function (t) {
    const f = buildFixture(t);
    const options = { platform: 'web-desktop', debug: true, packages: { project: { enabled: true } } };
    const job = await start(f, options);
    assert.match(job.taskId, /^mcp-build-[a-f0-9]{32}$/);
    assert.equal(job.state, 'running');
    assert.equal(job.code, null);
    assert.equal(f.extras.isBuilding(), true);
    assert.equal(messages(f, 'command-build').length, 1);
    const passed = messages(f, 'command-build')[0].args[0];
    assert.deepEqual(passed, Object.assign({}, options, { id: job.taskId }));
    assert.equal(options.id, undefined);
    options.packages.project.enabled = false;
    passed.debug = false; // Native mutation must not alter the job's original options.
    f.queue.queue['native-42'] = { id: 'native-42', state: 'processing', options: passed };
    const pending = await status(f, job.taskId);
    assert.equal(pending.task.state, 'running');
    assert.equal(pending.task.nativeTaskId, 'native-42');
    assert.equal(pending.task.options.packages.project.enabled, true);
    assert.equal(pending.nativeTask.state, 'processing');
    assert.deepEqual(pending.native, f.queue);
    assert.equal(pending.task.code, null);
    assert.equal(messages(f, 'add-task').length, 0);
    assert.equal(messages(f, 'check-and-complete-options').length, 0);
    f.build.resolve(36);
    await until(() => !f.extras.isBuilding());
    const completed = await status(f, job.taskId);
    assert.equal(completed.task.state, 'succeeded');
    assert.equal(completed.task.code, 36);
    assert.equal(typeof completed.task.finishedAt, 'number');
});

test('build.start rejects preexisting native work before it can replace the command-build resolver', async function(t){
    for(const condition of [{free:false,queue:{}},...['waiting','processing','queued','running','preparing'].map(state=>({free:true,queue:{user:{id:'user',state}}}))]){
        await t.test(JSON.stringify(condition),async function(t){
            const f=buildFixture(t);Object.assign(f.queue,condition);
            await rejectsCode(start(f),'NATIVE_BUILD_BUSY');
            assert.equal(messages(f,'command-build').length,0);
            assert.equal(messages(f,'break-task').length,0);
            assert.equal(f.extras.isBuilding(),false);
            f.queue.free=true;f.queue.queue={user:{id:'user',state:'success'}};
            const job=await start(f);assert.equal(job.state,'running');
            f.build.resolve(36);await until(()=>!f.extras.isBuilding());
        });
    }
});

test('concurrent identical starts share preflight and the same job; different starts cannot overlap', async function (t) {
    const preflight = deferred();
    const f = buildFixture(t, { request: (moduleName, message) => message === 'query-tasks-info' ? preflight.promise : undefined });
    const first = start(f, { platform: 'web-desktop', packages: { a: 1, b: 2 } });
    const retry = start(f, { packages: { b: 2, a: 1 }, platform: 'web-desktop' });
    assert.equal(f.extras.isBuilding(), true);
    await rejectsCode(start(f, { platform: 'web-mobile' }), 'BUILD_BUSY');
    await until(() => messages(f, 'query-tasks-info').length === 1);
    assert.equal(messages(f, 'command-build').length, 0);
    preflight.resolve({ queue: {}, free: true });
    const jobs = await Promise.all([first, retry]);
    assert.equal(jobs[0].taskId, jobs[1].taskId);
    assert.equal(jobs[0].deduplicated, false);
    assert.equal(jobs[1].deduplicated, true);
    assert.equal(messages(f, 'command-build').length, 1);
    assert.equal((await start(f, { platform: 'web-desktop', packages: { a: 1, b: 2 } })).taskId, jobs[0].taskId);
    await rejectsCode(start(f, { platform: 'web-desktop', debug: true }), 'BUILD_BUSY');
    f.build.resolve(36);
    await until(() => !f.extras.isBuilding());
});

test('only numeric native completion code 36 means success; false, task-looking values and error codes do not', async function (t) {
    for (const result of [36, 34, 32, false, undefined, null, 0, 1, '36', { id: 'not-a-build-result' }]) {
        const f = buildFixture(t);
        const job = await start(f);
        f.build.resolve(result);
        await until(() => !f.extras.isBuilding());
        const task = (await status(f, job.taskId)).task;
        assert.equal(task.state, result === 36 ? 'succeeded' : 'failed');
        assert.equal(task.code, typeof result === 'number' ? result : null);
        assert.deepEqual(task.nativeResult, result === undefined ? null : result);
        if (result === 36) assert.equal(task.error, null);
        else assert.equal(task.error.code, result === 32 ? 'INVALID_BUILD_OPTIONS' : result === 34 ? 'BUILD_FAILED' : 'UNEXPECTED_BUILD_RESULT');
    }
});

test('native rejection and synchronous throws produce failed jobs with original diagnostics and release the guard', async function (t) {
    const f = buildFixture(t);
    const job = await start(f);
    f.build.reject(Object.assign(new Error('worker crashed'), { code: 'WORKER_CRASH', details: { stage: 'build' } }));
    await until(() => !f.extras.isBuilding());
    const failed = (await status(f, job.taskId)).task;
    assert.deepEqual(failed.error, { code: 'WORKER_CRASH', message: 'worker crashed', details: { stage: 'build' } });
    assert.equal(failed.code, null);
    const sync = fixture(t, { request: function (moduleName, message) {
        if (message === 'query-tasks-info') return { queue: {}, free: true };
        throw Object.assign(new Error('synchronous failure'), { code: 'SYNC_FAILURE' });
    } });
    const started = await start(sync);
    await until(() => !sync.extras.isBuilding());
    assert.equal((await status(sync, started.taskId)).task.error.code, 'SYNC_FAILURE');
    const restarted = await start(sync);
    assert.notEqual(restarted.taskId, started.taskId);
    await until(() => !sync.extras.isBuilding());
});

test('invalid options and failed native preflight cannot dispatch builds or leave a busy lock', async function (t) {
    const f = buildFixture(t);
    for (const options of [null, [], {}, { platform: '' }, { platform: 'web-desktop', id: 'user-task' },
        { platform: 'web-desktop', taskId: 'user-task' }, { platform: 'web-desktop', fn: function () {} }]) {
        await rejectsCode(f.handlers['build.start']({ options: options }), 'INVALID_ARGUMENT');
        assert.equal(f.extras.isBuilding(), false);
    }
    assert.equal(f.calls.length, 0);
    let broken = true;
    const nativeError = Object.assign(new Error('queue unavailable'), { code: 'QUEUE_UNAVAILABLE' });
    const preflight = buildFixture(t, { request: function (moduleName, message) {
        if (message === 'query-tasks-info' && broken) throw nativeError;
    } });
    await assert.rejects(start(preflight), error => error === nativeError);
    assert.equal(preflight.extras.isBuilding(), false);
    assert.equal(messages(preflight, 'command-build').length, 0);
    broken = false;
    const good = await start(preflight);
    assert.equal(good.state, 'running');
    preflight.build.resolve(36);
    await until(() => !preflight.extras.isBuilding());
    const malformed = fixture(t, { request: () => ({ queue: [] }) });
    await rejectsCode(start(malformed), 'INVALID_NATIVE_RESULT');
    assert.equal(malformed.extras.isBuilding(), false);
    assert.equal(messages(malformed, 'command-build').length, 0);
});

test('cancel refuses preexisting and unrelated new tasks and requires explicit local task identity', async function (t) {
    const f = buildFixture(t);
    f.queue.queue['user-task'] = { id: 'user-task', state: 'success', options: { platform: 'web-desktop' } };
    const job = await start(f);
    f.queue.queue['user-task'].options.id = job.taskId; // Even a marker cannot override the baseline exclusion.
    f.queue.queue['another-new-task'] = { id: 'another-new-task', options: { platform: 'web-desktop' } };
    await rejectsCode(f.handlers['build.cancel']({}), 'INVALID_ARGUMENT');
    await rejectsCode(cancel(f, 'user-task'), 'BUILD_NOT_FOUND');
    await rejectsCode(cancel(f, job.taskId), 'NATIVE_TASK_NOT_IDENTIFIED');
    assert.equal(messages(f, 'break-task').length, 0);
    assert.equal(f.extras.isBuilding(), true);
    assert.equal((await status(f, job.taskId)).task.cancelRequested, false);
    f.queue.queue['native-own'] = { id: 'native-own', rawOptions: { id: job.taskId } };
    f.queue.queue['native-ambiguous'] = { id: 'native-ambiguous', options: { id: job.taskId } };
    await rejectsCode(cancel(f, job.taskId), 'NATIVE_TASK_NOT_IDENTIFIED');
    assert.equal(messages(f, 'break-task').length, 0);
    delete f.queue.queue['native-ambiguous'];
    const accepted = await cancel(f, job.taskId);
    assert.equal(accepted.nativeTaskId, 'native-own');
    assert.deepEqual(messages(f, 'break-task').map(call => call.args), [['native-own']]);
    assert.equal(accepted.state, 'cancelling');
    assert.equal(accepted.cancelRequested, true);
    assert.equal(accepted.code, null);
    assert.equal(f.extras.isBuilding(), true);
});

test('duplicate cancellation shares one native break and never treats acknowledgment as completion', async function (t) {
    const breaking = deferred();
    const f = buildFixture(t, { request: (moduleName, message) => message === 'break-task' ? breaking.promise : undefined });
    const job = await start(f);
    f.queue.queue['own-native-id'] = { id: 'own-native-id', options: { id: job.taskId } };
    const first = cancel(f, job.taskId);
    const duplicate = cancel(f, job.taskId);
    await until(() => messages(f, 'break-task').length > 0);
    assert.equal(messages(f, 'break-task').length, 1);
    breaking.resolve(undefined);
    const replies = await Promise.all([first, duplicate]);
    assert.deepEqual(replies[0], replies[1]);
    assert.equal(replies[0].state, 'cancelling');
    assert.equal(f.extras.isBuilding(), true);
    await rejectsCode(start(f, { platform: 'web-mobile' }), 'BUILD_BUSY');
    await cancel(f, job.taskId);
    assert.equal(messages(f, 'break-task').length, 1);
    f.build.resolve(34);
    await until(() => !f.extras.isBuilding());
    const done = await cancel(f, job.taskId);
    assert.equal(done.state, 'failed');
    assert.equal(done.code, 34);
    assert.equal(done.cancelRequested, true);
    assert.equal(messages(f, 'break-task').length, 1);
});

test('failed cancellation can be retried without lying about cancelRequested or releasing a live build', async function (t) {
    let attempt = 0;
    const failure = Object.assign(new Error('break unavailable'), { code: 'BREAK_UNAVAILABLE' });
    const f = buildFixture(t, { request: function (moduleName, message) {
        if (message === 'break-task') {
            attempt++;
            if (attempt === 1) return false;
            if (attempt === 2) throw failure;
            return true;
        }
    } });
    const job = await start(f);
    f.queue.queue[job.taskId] = { id: job.taskId, state: 'processing' };
    await rejectsCode(cancel(f, job.taskId), 'EDITOR_REJECTED');
    await assert.rejects(cancel(f, job.taskId), error => error === failure);
    assert.equal((await status(f, job.taskId)).task.cancelRequested, false);
    assert.equal(f.extras.isBuilding(), true);
    assert.equal((await cancel(f, job.taskId)).cancelRequested, true);
    assert.equal(attempt, 3);
});

test('a completion racing with cancellation is preserved and cannot break a subsequent or user build', async function (t) {
    const lateQueue = deferred();
    let reads = 0;
    const f = buildFixture(t, { request: function (moduleName, message) {
        if (message === 'query-tasks-info' && ++reads > 1) return lateQueue.promise;
    } });
    const job = await start(f);
    const cancelling = cancel(f, job.taskId);
    await until(() => reads === 2);
    f.build.resolve(36);
    await until(() => !f.extras.isBuilding());
    lateQueue.resolve({ queue: { 'native-old': { id: 'native-old', options: { id: job.taskId } } }, free: true });
    const result = await cancelling;
    assert.equal(result.state, 'succeeded');
    assert.equal(result.code, 36);
    assert.equal(result.cancelRequested, false);
    assert.equal(messages(f, 'break-task').length, 0);
});

test('disposal blocks new handlers but preserves pending build ownership until actual completion', async function (t) {
    const f = buildFixture(t);
    const job = await start(f);
    f.extras.dispose();
    f.extras.dispose();
    assert.equal(f.extras.isBuilding(), true);
    await rejectsCode(status(f, job.taskId), 'EXTRAS_DISPOSED');
    await rejectsCode(cancel(f, job.taskId), 'EXTRAS_DISPOSED');
    const other = createExtras(f.editor);
    t.after(() => other.dispose());
    assert.equal(other.isBuilding(), true);
    await rejectsCode(other.handlers['build.start']({ options: { platform: 'web-mobile' } }), 'BUILD_BUSY');
    const duplicate = await other.handlers['build.start']({ options: { platform: 'web-desktop' } });
    assert.equal(duplicate.taskId, job.taskId);
    assert.equal(messages(f, 'command-build').length, 1);
    assert.equal(messages(f, 'break-task').length, 0);
    f.build.resolve(36);
    await until(() => !other.isBuilding());
    assert.equal(f.extras.isBuilding(), false);
    assert.equal((await other.handlers['build.status']({ taskId: job.taskId })).task.state, 'succeeded');
});

test('disposal during preflight prevents deferred native build dispatch and clears its reservation', async function (t) {
    const preflight = deferred();
    const f = buildFixture(t, { request: (moduleName, message) => message === 'query-tasks-info' ? preflight.promise : undefined });
    const pending = start(f);
    await until(() => messages(f, 'query-tasks-info').length === 1);
    f.extras.dispose();
    preflight.resolve({ queue: {}, free: true });
    await rejectsCode(pending, 'EXTRAS_DISPOSED');
    assert.equal(messages(f, 'command-build').length, 0);
    assert.equal(f.extras.isBuilding(), false);
});

test('status reads the native queue while idle and does not fabricate jobs; bad status identities fail', async function (t) {
    const f = buildFixture(t);
    f.queue.queue['user-owned'] = { id: 'user-owned', state: 'processing' };
    const result = await status(f);
    assert.deepEqual(result, { task: null, isBuilding: false, native: f.queue, nativeTask: null });
    await rejectsCode(status(f, 'user-owned'), 'BUILD_NOT_FOUND');
    await rejectsCode(f.handlers['build.status']({ taskId: 123 }), 'INVALID_ARGUMENT');
    await rejectsCode(f.handlers['build.status']([]), 'INVALID_ARGUMENT');
    assert.equal(messages(f, 'command-build').length, 0);
    assert.equal(messages(f, 'break-task').length, 0);
});

test('completed jobs are bounded and expire without keeping timers or native work alive', async function (t) {
    const f = fixture(t, { request: function (moduleName, message) {
        if (message === 'query-tasks-info') return { queue: {}, free: true };
        if (message === 'command-build') return 36;
        assert.fail('Unexpected native message.');
    } });
    const oldest = await start(f);
    await until(() => !f.extras.isBuilding());
    for (let i = 0; i < 64; i++) {
        await start(f);
        await until(() => !f.extras.isBuilding());
    }
    await rejectsCode(status(f, oldest.taskId), 'BUILD_NOT_FOUND');
    const latest = (await status(f)).task;
    assert.equal(latest.state, 'succeeded');
    const advanced = Date.now() + 60 * 60 * 1000;
    t.mock.method(Date, 'now', () => advanced);
    await rejectsCode(status(f, latest.taskId), 'BUILD_NOT_FOUND');
    assert.equal((await status(f)).task, null);
    assert.equal(f.extras.isBuilding(), false);
});
