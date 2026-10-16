'use strict';

const path = require('path');
module.paths.push(path.join(Editor.App.path, 'node_modules'));
exports.load = function () {};
exports.unload = function () {};
exports.methods = {
  summary() {
    const cc = require('cc');
    const scene = cc.director.getScene();
    if (!scene) return { ready: false };
    return { ready: true, uuid: scene.uuid, name: scene.name, children: scene.children.map(node => ({ uuid: node.uuid, name: node.name })) };
  },
};
