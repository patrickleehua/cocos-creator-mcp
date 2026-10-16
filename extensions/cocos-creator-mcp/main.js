'use strict';

const { startBridge } = require('./bridge');
const { createAdapter } = require('./adapter');

let adapter;
let bridge;
let starting;
let lifecycle=Promise.resolve();

function sequence(action) {
  const result=lifecycle.then(action);
  lifecycle=result.catch(function () {});
  return result;
}

async function start() {
  if (bridge) return { running: true, port: bridge.port, sessionId: bridge.sessionId };
  if (starting) return starting;
  starting = (async () => {
    if (!/^3\.7\./.test(Editor.App.version)) throw new Error('This adapter requires Creator 3.7.x');
    adapter = createAdapter(Editor);
    try {
      bridge = await startBridge({ editor: Editor, dispatch: adapter.dispatch, commands: adapter.commands });
      console.log('[cocos-creator-mcp] Bridge ready for ' + Editor.Project.name + ' at port ' + bridge.port);
      return { running: true, port: bridge.port, sessionId: bridge.sessionId };
    } catch (error) {
      adapter.dispose();
      adapter = null;
      throw error;
    }
  })();
  try { return await starting; } finally { starting = null; }
}

async function stop() {
  if (starting) await starting.catch(() => {});
  try {
    if (bridge) await bridge.stop();
  } finally {
    bridge = null;
    if (adapter) adapter.dispose();
    adapter = null;
  }
  return { running: false };
}

exports.load = function () { return sequence(start).catch(error => console.error('[cocos-creator-mcp]', error)); };
exports.unload = function () { return sequence(stop); };
exports.methods = {
  startBridge: function () { return sequence(start); },
  stopBridge: function () { return sequence(stop); },
  bridgeStatus: function () {
    const status = { running: !!bridge, port: bridge ? bridge.port : null, project: Editor.Project.path };
    console.log('[cocos-creator-mcp]', status);
    return status;
  },
};
