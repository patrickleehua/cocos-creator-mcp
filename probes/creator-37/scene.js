'use strict';

const path = require('path');
module.paths.push(path.join(Editor.App.path, 'node_modules'));

exports.load = function () {};
exports.unload = function () {};
exports.methods = {
  getSceneSummary() {
    const cc = require('cc');
    const scene = cc.director.getScene();
    if (!scene) return { hasScene: false };
    const stack = [scene];
    let count = 0;
    while (stack.length && count < 10000) {
      const node = stack.pop();
      count++;
      for (const child of node.children) stack.push(child);
    }
    // Return plain values only; never pass a live engine Node over IPC.
    return {
      hasScene: true, uuid: scene.uuid, name: scene.name,
      countedNodes: count, truncated: stack.length > 0,
      rootChildren: scene.children.slice(0, 20).map(node => ({ uuid: node.uuid, name: node.name })),
      nodeApis: {
        getChildByUuid: typeof scene.getChildByUuid,
        addComponent: typeof scene.addComponent,
        removeComponent: typeof scene.removeComponent,
      },
      resourcesLoad: typeof cc.resources?.load,
      assetManagerResourcesLoad: typeof cc.assetManager?.resources?.load,
    };
  },
};
