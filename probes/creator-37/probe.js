'use strict';

function shape(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', length: value.length, first: value.length ? shape(value[0]) : null };
  if (typeof value === 'object') return { type: 'object', keys: Object.keys(value).slice(0, 32) };
  return { type: typeof value, value };
}

async function collectProbe(editor, options) {
  const timeoutMs = options && options.timeoutMs || 5000;
  const checks = [];
  async function check(moduleName, message, args, summarize) {
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => editor.Message.request(moduleName, message, ...args)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Read-only probe timed out')), timeoutMs);
        }),
      ]);
      if (value === undefined) throw new Error('Query returned undefined; support was not verified');
      checks.push({ module: moduleName, message, state: 'responded', result: summarize ? summarize(value) : shape(value) });
      return { ok: true, value };
    } catch (error) {
      checks.push({ module: moduleName, message, state: 'failed', error: String(error && error.message || error) });
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  const report = {
    editorVersion: editor.App.version,
    runtime: { node: process.versions.node, electron: process.versions.electron || null, fetch: typeof globalThis.fetch },
    project: { name: editor.Project.name, uuid: editor.Project.uuid, path: editor.Project.path },
    checks,
    unverified: ['all writes', 'undo/redo and snapshot semantics', 'prefab serialization', 'MCP transport'],
  };
  const ready = await check('scene', 'query-is-ready', []);
  await check('asset-db', 'query-ready', []);
  await check('asset-db', 'query-asset-info', ['db://assets']);
  if (ready.ok && ready.value === true) {
    await check('scene', 'query-dirty', []);
    await check('scene', 'query-node-tree', []);
    const selection = editor.Selection.getSelected('node');
    if (selection.length) await check('scene', 'query-node', [selection[0]]);
    await check('scene', 'execute-scene-script', [{
      name: 'cocos-37-compat-probe', method: 'getSceneSummary', args: [],
    }], value => value);
  } else {
    report.sceneQueriesSkipped = 'Scene was not confirmed ready';
  }
  return report;
}

module.exports = { collectProbe };
