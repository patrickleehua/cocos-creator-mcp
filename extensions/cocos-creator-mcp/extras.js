'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const coordinators = new WeakMap();
const JOB_LIMIT = 64;
const JOB_TTL_MS = 30 * 60 * 1000;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code, message, details) {
    const error = new Error(message);
    error.code = code;
    if (details !== undefined) error.details = details;
    throw error;
}

function json(value, code) {
    try {
        return JSON.parse(JSON.stringify(value, function (key, item) {
            if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
                throw new TypeError('Non-JSON value');
            }
            return item;
        }));
    } catch (error) {
        fail(code || 'INVALID_NATIVE_RESULT', 'Expected a JSON-serializable value.');
    }
}

function errorInfo(error) {
    const info = {
        code: error && error.code !== undefined ? error.code : 'EDITOR_ERROR',
        message: error && typeof error.message === 'string' ? error.message : String(error),
    };
    try {
        if (error && error.details !== undefined) info.details = json(error.details);
        return json(info);
    } catch (ignored) {
        return { code: 'EDITOR_ERROR', message: info.message };
    }
}

function canonical(value) {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

function createExtras(editor) {
    if (!editor || !editor.Message || typeof editor.Message.request !== 'function') {
        throw new TypeError('Editor.Message.request is required.');
    }
    let disposed = false;
    const handlers = {};
    const manifests = {};
    for (const name of ['preview', 'builder']) {
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(editor.App.path, 'builtin', name, 'package.json'), 'utf8'));
            manifests[name] = manifest.contributions.messages;
        } catch (ignored) {
            manifests[name] = null;
        }
    }
    const has = (name, message) => record(manifests[name]) && own(manifests[name], message) &&
        record(manifests[name][message]) && Array.isArray(manifests[name][message].methods) &&
        manifests[name][message].methods.length > 0;
    const call = (name, message, ...args) => Promise.resolve().then(function () {
        alive();
        return editor.Message.request(name, message, ...args);
    });
    function alive() {
        if (disposed) fail('EXTRAS_DISPOSED', 'Extra command handlers have been disposed.');
    }
    function register(name, available, handler) {
        if (!available) return;
        handlers[name] = async function (args) {
            alive();
            if (args === undefined) args = {};
            if (!record(args)) fail('INVALID_ARGUMENT', 'Command args must be an object.');
            return handler(args);
        };
    }

    register('preview.info', has('preview', 'query-preview-url'), async function () {
        const url = await call('preview', 'query-preview-url');
        let parsed;
        try { parsed = new URL(url); } catch (ignored) {}
        if (typeof url !== 'string' || !parsed || !/^https?:$/.test(parsed.protocol)) {
            fail('INVALID_NATIVE_RESULT', 'Native preview did not return an HTTP preview URL.', { result: url === undefined ? null : url });
        }
        // A URL alone does not establish that a browser preview has been started.
        return { url: url, source: 'preview/query-preview-url' };
    });
    register('preview.refresh', has('preview', 'reload-terminal'), async function () {
        const result = await call('preview', 'reload-terminal');
        if (result === false) fail('EDITOR_REJECTED', 'Native preview rejected the reload request.');
        return { requested: true, source: 'preview/reload-terminal', result: result === undefined ? null : json(result) };
    });
    register('preview.open', has('preview','preview-scene-in-browser') && has('preview','query-preview-url'), async function () {
        if (await call('scene','query-is-ready') !== true) fail('SCENE_NOT_READY','Open a saved scene before previewing');
        if (await call('scene','query-dirty')) fail('UNSAVED_CHANGES','Save the scene before previewing');
        const tree=await call('scene','query-node-tree');
        const scene=Array.isArray(tree)?tree[0]:tree;
        if (!scene || !scene.uuid || (scene.type && scene.type!=='cc.Scene')) fail('SCENE_NOT_READY','No scene asset is open');
        const info=await handlers['preview.info']({});
        const result=await call('preview','preview-scene-in-browser',scene.uuid);
        if (result===false) fail('EDITOR_REJECTED','Native browser preview was rejected');
        const url=new URL(info.url); url.hostname='localhost'; url.searchParams.set('scene',scene.uuid);
        return {requested:true,url:url.href,sceneUuid:scene.uuid,source:'preview/preview-scene-in-browser'};
    });

    const profileAvailable = editor.Profile && typeof editor.Profile.getProject === 'function';
    register('build.config', has('builder', 'query-platform-config') || profileAvailable, async function (args) {
        if (args.options !== undefined && !record(args.options)) fail('INVALID_ARGUMENT', 'options must be an object.');
        const platform = args.platform === undefined ? args.options && args.options.platform : args.platform;
        if (platform !== undefined) {
            if (typeof platform !== 'string' || !platform.trim()) fail('INVALID_ARGUMENT', 'platform must be a nonempty string.');
            if (!has('builder', 'query-platform-config')) fail('UNSUPPORTED_COMMAND', 'Native platform configuration message is unavailable.');
            const native = await call('builder', 'query-platform-config', platform);
            if (native === undefined || native === null || native === false) fail('CONFIG_NOT_FOUND', 'Native platform configuration was not found.');
            const config = record(native.config) ? native.config[platform] : native;
            if (config === undefined) fail('CONFIG_NOT_FOUND','This build platform is not registered.');
            return { source: 'builder/query-platform-config', platform: platform, config: json(config) };
        }
        if (!profileAvailable) fail('INVALID_ARGUMENT', 'Supply options.platform to query native platform configuration.');
        const config = await editor.Profile.getProject('builder');
        if (config === undefined || config === null) fail('CONFIG_NOT_FOUND', 'Native builder project profile was not found.');
        return { source: 'Editor.Profile.getProject(builder)', config: json(config) };
    });

    // Keep the command-build lock across createExtras/dispose cycles for the
    // same Editor object. Native command-build owns a single global resolver.
    let coordinator = coordinators.get(editor);
    if (!coordinator) {
        coordinator = { active: null, jobs: new Map(), last: null };
        coordinators.set(editor, coordinator);
    }
    const jobs = coordinator.jobs;
    function pruneJobs(reserve) {
        const now = Date.now();
        jobs.forEach(function (job, id) {
            if (job.finishedAt !== null && now - job.finishedAt >= JOB_TTL_MS) jobs.delete(id);
        });
        while (jobs.size > JOB_LIMIT - (reserve ? 1 : 0)) {
            let removed = false;
            for (const pair of jobs) {
                if (pair[1].finishedAt !== null) {
                    jobs.delete(pair[0]);
                    removed = true;
                    break;
                }
            }
            if (!removed) break;
        }
    }
    function snapshot(job) {
        return json({
            taskId: job.taskId, state: job.state, options: job.options,
            startedAt: job.startedAt, finishedAt: job.finishedAt,
            code: job.code, nativeResult: job.nativeResult, error: job.error,
            nativeTaskId: job.nativeTaskId, cancelRequested: job.cancelRequested,
        });
    }
    async function nativeQueue() {
        const info = await call('builder', 'query-tasks-info');
        if (!record(info) || !record(info.queue)) fail('INVALID_NATIVE_RESULT', 'Native builder did not return a task queue.');
        return json(info);
    }
    function findJob(args) {
        pruneJobs(false);
        if (args.taskId !== undefined && (typeof args.taskId !== 'string' || !args.taskId.trim())) {
            fail('INVALID_ARGUMENT', 'taskId must be a nonempty string.');
        }
        const id = args.taskId || (coordinator.active && coordinator.active.taskId) || coordinator.last;
        const job = id ? jobs.get(id) : null;
        if (args.taskId && !job) fail('BUILD_NOT_FOUND', 'Build job is unknown or has expired.', { taskId: args.taskId });
        return job || null;
    }
    function marked(task, marker) {
        if (!record(task)) return false;
        return task.id === marker || [task.options, task.rawOptions].some(options =>
            record(options) && (options.id === marker || options.taskId === marker));
    }
    function identify(job, info) {
        const candidates = Object.keys(info.queue).filter(function (id) {
            const task = info.queue[id];
            if (job.baseline.has(id) || (record(task) && job.baseline.has(task.id))) return false;
            return id === job.taskId || marked(task, job.taskId);
        });
        if (candidates.length === 1) {
            job.nativeTaskId = candidates[0];
            return candidates[0];
        }
        return null;
    }
    function complete(job, result, error) {
        job.finishedAt = Date.now();
        job.state = 'failed';
        if (error) {
            job.error = errorInfo(error);
        } else {
            try { job.nativeResult = result === undefined ? null : json(result); } catch (ignored) {}
            job.code = typeof result === 'number' && isFinite(result) ? result : null;
            if (result === 36) {
                job.state = 'succeeded';
            } else {
                job.error = {
                    code: result === 32 ? 'INVALID_BUILD_OPTIONS' : result === 34 ? 'BUILD_FAILED' : 'UNEXPECTED_BUILD_RESULT',
                    message: result === 32 ? 'Native builder rejected the build options (32).' :
                        result === 34 ? 'Native builder reported build failure (34).' : 'Native builder returned an unrecognized completion result.',
                };
            }
        }
        if (coordinator.active === job) coordinator.active = null;
    }

    const queueAvailable = has('builder', 'query-tasks-info');
    register('build.start', queueAvailable && has('builder', 'command-build'), async function (args) {
        if (!record(args.options)) fail('INVALID_ARGUMENT', 'Supply a build options object.');
        const options = json(args.options, 'INVALID_ARGUMENT');
        if (typeof options.platform !== 'string' || !options.platform.trim()) fail('INVALID_ARGUMENT', 'options.platform is required.');
        if (own(options, 'id') || own(options, 'taskId')) fail('INVALID_ARGUMENT', 'Native id and taskId are reserved for build ownership tracking.');
        let fingerprint;
        try { fingerprint = canonical(options); } catch (error) { fail('INVALID_ARGUMENT', 'Build options are nested too deeply.'); }
        const active = coordinator.active;
        if (active) {
            if (active.fingerprint !== fingerprint) fail('BUILD_BUSY', 'An extra-command build is still pending.', { taskId: active.taskId });
            await active.startPromise;
            return Object.assign(snapshot(active), { deduplicated: true });
        }
        pruneJobs(true);
        const job = {
            taskId: 'mcp-build-' + crypto.randomBytes(16).toString('hex'),
            fingerprint: fingerprint, options: options, state: 'preparing',
            startedAt: Date.now(), finishedAt: null, code: null, nativeResult: null, error: null,
            baseline: new Set(), nativeTaskId: null, cancelRequested: false, cancelPromise: null, startPromise: null,
        };
        coordinator.active = job; // Acquire before the first asynchronous read.
        coordinator.last = job.taskId;
        jobs.set(job.taskId, job);
        job.startPromise = (async function () {
            try {
                const before = await nativeQueue();
                alive();
                const activeNativeTasks=Object.keys(before.queue).filter(id => {
                    const task=before.queue[id];
                    return record(task) && ['waiting','processing','running','preparing','queued'].indexOf(task.state)!==-1;
                });
                if (before.free===false || activeNativeTasks.length) fail('NATIVE_BUILD_BUSY',
                    'Wait for existing native build tasks before starting an MCP build.', {nativeTaskIds:activeNativeTasks});
                Object.keys(before.queue).forEach(function (id) {
                    job.baseline.add(id);
                    const task = before.queue[id];
                    if (record(task) && typeof task.id === 'string') job.baseline.add(task.id);
                });
                // The shipped IBuildTaskOption declares `id` as a manually
                // configured task ID. If native code drops it, cancel fails closed.
                const nativeOptions = json(options, 'INVALID_ARGUMENT');
                nativeOptions.id = job.taskId;
                job.state = 'running';
                const pending = call('builder', 'command-build', nativeOptions);
                // Never await the build in a handler: the transport serializes
                // handlers, and health/status/cancel must remain available.
                pending.then(result => complete(job, result, null), error => complete(job, null, error));
            } catch (error) {
                complete(job, null, error);
                throw error;
            }
        })();
        await job.startPromise;
        return Object.assign(snapshot(job), { deduplicated: false });
    });

    register('build.status', queueAvailable, async function (args) {
        const job = findJob(args);
        const native = await nativeQueue();
        const id = job ? identify(job, native) : null;
        return {
            isBuilding: coordinator.active !== null,
            task: job ? snapshot(job) : null,
            native: native,
            nativeTask: id ? native.queue[id] : null,
        };
    });

    register('build.cancel', queueAvailable && has('builder', 'break-task'), async function (args) {
        if (typeof args.taskId !== 'string' || !args.taskId.trim()) fail('INVALID_ARGUMENT', 'taskId is required for cancellation.');
        const job = findJob(args);
        if (job.finishedAt !== null) return snapshot(job);
        if (job.cancelPromise) return job.cancelPromise;
        job.cancelPromise = (async function () {
            await job.startPromise;
            const native = await nativeQueue();
            if (job.finishedAt !== null) return snapshot(job);
            alive();
            const id = identify(job, native);
            if (!id) fail('NATIVE_TASK_NOT_IDENTIFIED', 'Cannot safely associate a new native task with this build; nothing was cancelled.', {
                taskId: job.taskId,
                newNativeTaskIds: Object.keys(native.queue).filter(id => !job.baseline.has(id)),
            });
            const result = await call('builder', 'break-task', id);
            if (result === false) fail('EDITOR_REJECTED', 'Native builder rejected the cancellation request.');
            job.cancelRequested = true;
            if (job.finishedAt === null) job.state = 'cancelling';
            // This acknowledges the native break request, not build completion.
            return snapshot(job);
        })();
        try {
            return await job.cancelPromise;
        } catch (error) {
            job.cancelPromise = null;
            throw error;
        }
    });

    register('editor.logs', editor.Logger && typeof editor.Logger.query === 'function', async function (args) {
        const native = await editor.Logger.query();
        if (native === undefined || native === null) fail('INVALID_NATIVE_RESULT', 'Native logger returned no snapshot.');
        const recognized = Array.isArray(native) && native.every(entry => record(entry) &&
            (entry.process === 'browser' || entry.process === 'renderer') &&
            ['log', 'info', 'warn', 'error'].indexOf(entry.type) !== -1 &&
            typeof entry.message === 'string' && typeof entry.time === 'number' &&
            Number.isFinite(entry.time) && entry.time >= 0);
        if (recognized) {
            const level = args.level === undefined ? 'all' : args.level;
            if (['all', 'info', 'warn', 'error'].indexOf(level) === -1) {
                fail('INVALID_ARGUMENT', 'level must be all, info, warn or error.');
            }
            if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1)) {
                fail('INVALID_ARGUMENT', 'limit must be a positive integer; results are capped at 1000.');
            }
            const limit = args.limit === undefined ? 100 : Math.min(args.limit, 1000);
            let since = 0;
            if (args.since !== undefined) {
                if (typeof args.since === 'string' && /^\d+(?:\.\d+)?$/.test(args.since.trim())) {
                    since = Number(args.since.trim());
                } else if (typeof args.since === 'number') {
                    since = args.since;
                } else {
                    fail('INVALID_ARGUMENT', 'since must be a nonnegative millisecond timestamp or numeric string.');
                }
                if (!Number.isFinite(since) || since < 0) {
                    fail('INVALID_ARGUMENT', 'since must be a nonnegative millisecond timestamp or numeric string.');
                }
            }
            const matched = native.filter(entry => entry.time >= since &&
                (level === 'all' || (entry.type === 'log' ? 'info' : entry.type) === level));
            // Logger.query can combine browser and renderer batches. Return the
            // most recent matching records in chronological order, without
            // sorting or annotating the Editor-owned array in place.
            matched.sort((left, right) => left.time - right.time);
            const entries = matched.slice(-limit).map(function (entry) {
                const normalized = json(entry);
                normalized.timestamp = entry.time;
                normalized.level = entry.type === 'log' ? 'info' : entry.type;
                if (!own(normalized, 'source')) normalized.source = 'Editor.Logger.query';
                return normalized;
            });
            return {
                scope: 'native Editor.Logger.query entries; normalized timestamp/level, no console interception',
                source: 'Editor.Logger.query', entries: entries, total: matched.length,
                limit: limit, truncated: matched.length > limit,
            };
        }
        // Preserve unfamiliar native formats rather than silently dropping
        // records or claiming that filters were applied to unknown fields.
        if (args.level !== undefined || args.limit !== undefined || args.since !== undefined) {
            fail('UNSUPPORTED_FILTER', 'This native logger format cannot be filtered; omit level, limit and since to read the original snapshot.');
        }
        return {
            scope: 'native Editor.Logger.query snapshot; unfiltered native format, no console interception',
            native: json(native),
        };
    });

    return {
        handlers: handlers,
        dispose: function () {
            // A dispatched build outlives disposal. Do not cancel it implicitly
            // or release the command-build lock before its promise settles.
            disposed = true;
        },
        isBuilding: function () { return coordinator.active !== null; },
    };
}

module.exports = { createExtras: createExtras };
