'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { AsyncLocalStorage } = require('async_hooks');
const { createExtras } = require('./extras');

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isProperty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'value') && typeof value.type === 'string';
}
function unwrap(value) {
  if (!value || typeof value !== 'object') return value;
  if (isProperty(value)) return unwrap(value.value);
  if (Array.isArray(value)) return value.map(unwrap);
  const result = {};
  for (const key of Object.keys(value)) result[key] = unwrap(value[key]);
  return result;
}
function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_ARGUMENT', name + ' must be a nonempty string');
  return value;
}
function safeSegments(value) {
  text(value, 'path');
  const parts = value.replace(/\[(\d+)\]/g, '.$1').split('.');
  if (parts.some(p => !p || ['__proto__', 'constructor', 'prototype'].includes(p))) {
    fail('INVALID_ARGUMENT', 'Invalid property path');
  }
  return parts;
}
function validateJson(value, depth) {
  if ((depth || 0) > 40) fail('INVALID_ARGUMENT', 'JSON nesting exceeds 40 levels');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') fail('INVALID_ARGUMENT', 'Expected a JSON value');
  for (const key of Object.keys(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('INVALID_ARGUMENT', 'Unsafe JSON property name');
    validateJson(value[key], (depth || 0) + 1);
  }
}
function validateShape(before, next) {
  if (before === null) return;
  if (typeof before === 'number') {
    if (typeof next !== 'number' || !Number.isFinite(next)) fail('INVALID_ARGUMENT', 'Expected a finite number');
  } else if (typeof before === 'boolean' || typeof before === 'string') {
    if (typeof next !== typeof before) fail('INVALID_ARGUMENT', 'Expected a ' + typeof before);
  } else if (Array.isArray(before)) {
    if (!Array.isArray(next)) fail('INVALID_ARGUMENT', 'Expected an array');
  } else if (before && typeof before === 'object') {
    if (!next || typeof next !== 'object' || Array.isArray(next)) fail('INVALID_ARGUMENT', 'Expected an object');
    for (const key of Object.keys(next)) {
      if (!Object.prototype.hasOwnProperty.call(before, key)) fail('INVALID_ARGUMENT', 'Unknown value field: ' + key);
      validateShape(before[key], next[key]);
    }
  }
}
function childrenOf(tree) { return Array.isArray(tree) ? tree : tree ? [tree] : []; }
function flatten(tree) {
  const result = [];
  const visit = (node, parent) => {
    result.push({ node, parent });
    for (const child of node.children || []) visit(child, node);
  };
  for (const root of childrenOf(tree)) visit(root, null);
  return result;
}
function componentInfo(dump) {
  return (dump.__comps__ || []).map((comp, index) => ({
    uuid: unwrap(comp.value && comp.value.uuid),
    type: comp.cid || comp.type,
    index,
    properties: unwrap(comp.value),
  }));
}

function createAdapter(editor) {
  const operations = new AsyncLocalStorage();
  const call = (moduleName, message, ...args) => {
    const operation = operations.getStore();
    if (operation && !message.startsWith('query-') && message !== 'check-and-complete-options') {
      operation.mutationRequested = true;
    }
    return editor.Message.request(moduleName, message, ...args);
  };
  const log = [];
  const handlers = {};
  const listeners = [];
  const extras = createExtras(editor, { request: call });
  let electron;
  try { electron = require('electron'); } catch (_) {}
  function singleSceneWindow() {
    if (!electron || !electron.BrowserWindow) return;
    const windows = electron.BrowserWindow.getAllWindows().filter(w => /\/windows\/main\.html(?:#|$)/.test(w.webContents.getURL()));
    if (windows.length > 1) fail('MULTIPLE_SCENE_WINDOWS', 'Creator 3.7 broadcasts scene messages across main windows; close extra project windows before editing');
  }
  const manifests = {};
  for (const moduleName of ['scene', 'asset-db', 'builder', 'preview']) {
    try {
      manifests[moduleName] = JSON.parse(fs.readFileSync(path.join(editor.App.path, 'builtin', moduleName, 'package.json'), 'utf8')).contributions.messages;
    } catch (_) { manifests[moduleName] = null; }
  }
  const has = (moduleName, message) => {
    const manifest=manifests[moduleName];
    const entry=manifest && Object.prototype.hasOwnProperty.call(manifest,message) && manifest[message];
    return !!entry && typeof entry==='object' && Array.isArray(entry.methods) && entry.methods.length>0 &&
      entry.methods.every(method=>typeof method==='string' && method.trim());
  };
  function register(name, needs, handler) {
    if (needs.every(([moduleName, message]) => has(moduleName, message))) handlers[name] = handler;
  }
  function record(level, message, details) {
    log.push({ timestamp: Date.now(), level, message, details });
    if (log.length > 1000) log.shift();
  }
  async function ready() {
    singleSceneWindow();
    const deadline = Date.now() + 5000;
    do {
      if (await call('scene', 'query-is-ready') === true) { singleSceneWindow(); return; }
      // Prefab/import/compiler work can briefly reload the scene worker.
      // Wait only on this read-only precondition; never replay a mutation.
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    fail('SCENE_NOT_READY', 'Open a scene and wait for the scene editor to be ready');
  }
  async function tree() { await ready(); return call('scene', 'query-node-tree'); }
  async function creationParent(parent) {
    if (parent !== undefined) {
      const selected = await resolveNode({ uuid: text(parent, 'parent') });
      return selected.node.uuid;
    }
    const roots = childrenOf(await tree());
    if (roots.length !== 1 || typeof roots[0].uuid !== 'string' || !roots[0].uuid) {
      fail('SCENE_IDENTITY_UNAVAILABLE', 'Creation requires one current scene root or an explicit parent');
    }
    // Native 3.7 create-node's implicit parent can produce a detached UUID
    // during repeated create/remove operations. Never inherit that UI state.
    return roots[0].uuid;
  }
  async function resolveNode(args) {
    if (['uuid', 'path', 'name'].filter(key => args[key] !== undefined).length !== 1) fail('INVALID_ARGUMENT', 'Supply exactly one node selector');
    const entries = flatten(await tree());
    let hits;
    if (args.uuid) hits = entries.filter(x => x.node.uuid === args.uuid);
    else if (args.path) {
      const wanted = args.path.replace(/^\/+|\/+$/g, '').split('/');
      const walk = (nodes, index) => nodes.filter(x => x.name === wanted[index]).flatMap(x => index === wanted.length - 1 ? [x] : walk(x.children || [], index + 1));
      const roots = entries.filter(x => !x.parent).map(x => x.node);
      let found = walk(roots, 0);
      if (!found.length) found = walk(roots.flatMap(x => x.children || []), 0);
      hits = entries.filter(x => found.includes(x.node) || found.some(y => y.uuid === x.node.uuid));
    } else if (args.name) hits = entries.filter(x => x.node.name === args.name);
    else fail('INVALID_ARGUMENT', 'Supply exactly one node uuid, path, or name');
    if (!hits.length) fail('NODE_NOT_FOUND', 'Node was not found in the current scene', args);
    if (hits.length !== 1) fail('AMBIGUOUS_NODE', 'Node selector matches multiple nodes; use UUID', { uuids: hits.map(x => x.node.uuid) });
    return hits[0];
  }
  async function nodeDump(uuid) {
    text(uuid, 'uuid');
    const dump = await call('scene', 'query-node', uuid);
    if (!dump || typeof dump !== 'object') fail('NODE_NOT_FOUND', 'No node dump for ' + uuid);
    return dump;
  }
  async function nodeQuery(args) {
    if (!args.uuid && !args.path && !args.name) return { tree: await tree() };
    const target = await resolveNode(args);
    const dump = await nodeDump(target.node.uuid);
    return {
      uuid: target.node.uuid, name: unwrap(dump.name), parentUuid: target.parent && target.parent.uuid,
      active: unwrap(dump.active), position: unwrap(dump.position), rotation: unwrap(dump.rotation),
      scale: unwrap(dump.scale), components: componentInfo(dump), dump,
    };
  }
  async function assetInfo(asset, { allowPending = false } = {}) {
    const info = await call('asset-db', 'query-asset-info', text(asset, 'asset'));
    if (!info) fail('ASSET_NOT_FOUND', 'Asset was not found: ' + asset);
    if (info.invalid || (info.imported === false && !allowPending)) fail('IMPORT_FAILED', 'Asset is not successfully imported: ' + asset);
    return info;
  }
  function assetUrl(url) {
    text(url, 'url');
    if (!url.startsWith('db://assets/') || url.includes('\\') || url.includes('\0')) {
      fail('INVALID_ASSET_URL', 'Writes require a URL under db://assets/');
    }
    if (url.slice('db://assets/'.length).split('/').some(s => !s || s === '.' || s === '..')) {
      fail('INVALID_ASSET_URL', 'Asset URL contains an empty or traversal segment');
    }
    return url;
  }
  async function assetReady() {
    if (await call('asset-db', 'query-ready') !== true) fail('ASSET_DB_NOT_READY', 'Asset database is not ready');
  }
  async function waitFor(check, message) {
    const until = Date.now() + 5000;
    do {
      const result = await check();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < until);
    fail('VERIFICATION_FAILED', message);
  }
  async function snapshot() { await call('scene', 'snapshot'); }

  register('editor.info', [], async () => ({
    editorVersion: editor.App.version, adapter: 'creator37', protocolVersion: 1,
    runtime: { node: process.versions.node, electron: process.versions.electron },
    project: { name: editor.Project.name, path: editor.Project.path, uuid: editor.Project.uuid },
    capabilities: { commands: Object.keys(handlers), groupedUndo: false },
  }));
  register('scene.query', [['scene', 'query-node-tree']], async () => {
    singleSceneWindow();
    const isReady = await call('scene', 'query-is-ready');
    if (!isReady) return { ready: false, dirty: null, tree: null };
    const result = await call('scene', 'query-node-tree');
    return { ready: true, dirty: await call('scene', 'query-dirty'), tree: result };
  });
  register('node.query', [['scene', 'query-node']], nodeQuery);
  register('scene.open', [['scene', 'open-scene']], async args => {
    singleSceneWindow();
    await assetReady();
    const asset = await assetInfo(args.asset);
    if (asset.type !== 'cc.SceneAsset') fail('INVALID_ASSET_TYPE', 'Expected a successfully imported scene asset');
    const isReady = await call('scene', 'query-is-ready');
    if (isReady && await call('scene', 'query-dirty')) {
      fail('UNSAVED_CHANGES', 'Save the current scene before opening another scene');
    }
    const result = await call('scene', 'open-scene', asset.uuid);
    if (result === false) fail('EDITOR_REJECTED', 'Editor rejected opening the scene');
    const current = await waitFor(async () => {
      const scene = await handlers['scene.query']({});
      const roots = childrenOf(scene.tree);
      if (scene.ready !== true || typeof scene.dirty !== 'boolean' ||
          roots.length !== 1 || roots[0].uuid !== asset.uuid) return false;
      return scene;
    }, 'The requested scene did not become active');
    return { asset, scene: current };
  });
  register('scene.save', [['scene', 'save-scene'], ['scene', 'query-node-tree'], ['asset-db', 'query-ready'], ['asset-db', 'query-asset-info']], async () => {
    await ready();
    await assetReady();
    const roots = childrenOf(await call('scene', 'query-node-tree'));
    if (roots.length !== 1 || !roots[0].uuid) fail('SCENE_IDENTITY_UNAVAILABLE', 'Saving requires one current scene asset');
    const asset = await assetInfo(roots[0].uuid);
    if (asset.type !== 'cc.SceneAsset') fail('INVALID_ASSET_TYPE', 'Saving requires an existing imported scene asset');
    assetUrl(asset.url);
    const dirty = await call('scene', 'query-dirty');
    if (typeof dirty !== 'boolean') fail('INVALID_NATIVE_RESULT', 'Editor did not confirm the scene dirty state');
    if (!dirty) {
      const current = await handlers['scene.query']({});
      const currentRoots = childrenOf(current.tree);
      if (!current.ready || current.dirty !== false || currentRoots.length !== 1 || currentRoots[0].uuid !== asset.uuid) {
        fail('SCENE_CHANGED', 'Scene changed while confirming its saved state');
      }
      return { saved: true, unchanged: true, scene: current };
    }
    const result = await call('scene', 'save-scene');
    if (result === false) fail('EDITOR_REJECTED', 'Editor could not save the scene');
    await waitFor(async () => !await call('scene', 'query-dirty'), 'Scene remained dirty after save');
    return { saved: true, scene: await handlers['scene.query']({}) };
  });
  register('scene.create', [['asset-db', 'create-asset']], async args => {
    await assetReady();
    const url = assetUrl(args.url);
    if (!url.endsWith('.scene')) fail('INVALID_ASSET_URL', 'Scene URL must end in .scene');
    const template = path.join(path.dirname(editor.App.path), 'resources', '3d', 'engine', 'editor', 'assets', 'default_file_content', 'scene-2d');
    if (!fs.existsSync(template)) fail('TEMPLATE_NOT_FOUND', 'The installed editor scene template was not found');
    let content = fs.readFileSync(template, 'utf8');
    if (args.name !== undefined) {
      const data = JSON.parse(content);
      for (const item of data) if (item.__type__ === 'cc.SceneAsset' || item.__type__ === 'cc.Scene') item._name = text(args.name, 'name');
      content = JSON.stringify(data, null, 2);
    }
    const result = await call('asset-db', 'create-asset', url, content, { overwrite: false, rename: false });
    if (!result) fail('EDITOR_REJECTED', 'Scene asset creation failed');
    return { asset: await assetInfo(url), template: 'installed-editor/scene-2d' };
  });
  for (const action of ['undo', 'redo']) register('scene.' + action, [['scene', action]], async () => {
    await ready();
    if (await call('scene', action) === false) fail('EDITOR_REJECTED', 'Editor rejected ' + action);
    return handlers['scene.query']({});
  });
  register('node.create', [['scene', 'create-node']], async args => {
    await ready();
    const components = args.components || [];
    if (!Array.isArray(components) || components.some(c => typeof c !== 'string' || !c.trim()) || new Set(components).size !== components.length) fail('INVALID_ARGUMENT', 'components must contain unique nonempty class IDs');
    if (args.position !== undefined) {
      validateShape({ x:0, y:0, z:0 }, args.position);
      if (['x','y','z'].some(key => !Object.prototype.hasOwnProperty.call(args.position, key))) fail('INVALID_ARGUMENT', 'position requires x, y, and z');
    }
    const options = { name: args.name === undefined ? 'Node' : text(args.name, 'name'), snapshot: true };
    options.parent = await creationParent(args.parent);
    if (args.position) options.position = args.position;
    const result = await call('scene', 'create-node', options);
    const uuids = typeof result === 'string' ? [result] : result;
    if (!Array.isArray(uuids) || !uuids.length || !uuids.every(v => typeof v === 'string')) fail('EDITOR_REJECTED', 'Editor did not return newly created node UUIDs', { result });
    const nodes = [];
    for (const uuid of uuids) {
      try {
        // 3.7.3 accepts the components field but does not populate it for plain nodes.
        // Use the native component operation and verify each requested class explicitly.
        for (const component of components) {
          if (!componentInfo(await nodeDump(uuid)).some(c => c.type === component)) await handlers['component.add']({ uuid, component });
        }
        if (args.position && !isDeepStrictEqual(unwrap((await nodeDump(uuid)).position), args.position)) await propertySet({uuid,path:'position',value:args.position});
        nodes.push(await nodeQuery({ uuid }));
      } catch (error) { error.details = { cause:error.details, partial:true, createdUuids:uuids }; throw error; }
    }
    return { uuids, nodes };
  });
  register('node.remove', [['scene', 'remove-node']], async args => {
    const target = await resolveNode({ uuid: text(args.uuid, 'uuid') });
    if (!target.parent) fail('INVALID_ARGUMENT', 'Cannot remove the scene root');
    await call('scene', 'remove-node', { uuid: args.uuid });
    await snapshot();
    if (flatten(await tree()).some(x => x.node.uuid === args.uuid)) fail('VERIFICATION_FAILED', 'Node still exists after removal');
    return { removed: args.uuid };
  });
  register('node.reparent', [['scene', 'set-parent']], async args => {
    const target = await resolveNode({ uuid: text(args.uuid, 'uuid') });
    const parent = await resolveNode({ uuid: text(args.parent, 'parent') });
    if (!target.parent) fail('INVALID_ARGUMENT', 'Cannot reparent the scene root');
    if (flatten(target.node).some(x => x.node.uuid === parent.node.uuid)) fail('INVALID_ARGUMENT', 'Cannot parent a node to itself or its descendant');
    await call('scene', 'set-parent', { parent: args.parent, uuids: args.uuid, keepWorldTransform: args.keepWorldTransform !== false });
    await snapshot();
    const after = await nodeQuery({ uuid: args.uuid });
    if (after.parentUuid !== args.parent) fail('VERIFICATION_FAILED', 'Node parent did not change');
    return after;
  });
  register('node.duplicate', [['scene', 'duplicate-node']], async args => {
    await resolveNode({ uuid: text(args.uuid, 'uuid') });
    const result = await call('scene', 'duplicate-node', args.uuid);
    await snapshot();
    const uuids = typeof result === 'string' ? [result] : result;
    if (!Array.isArray(uuids) || !uuids.length) fail('EDITOR_REJECTED', 'Editor did not return duplicated nodes');
    const nodes = [];
    for (const uuid of uuids) {
      if (args.name !== undefined) await propertySet({uuid,path:'name',value:text(args.name,'name')});
      nodes.push(await nodeQuery({uuid}));
    }
    return { uuids, nodes };
  });
  register('component.list', [['scene', 'query-node']], async args => {
    await resolveNode({uuid:text(args.uuid,'uuid')});
    return { uuid:args.uuid, components:componentInfo(await nodeDump(args.uuid)) };
  });
  register('component.catalog', [['scene','query-classes']], async args => {
    await ready();
    const classes=await call('scene','query-classes');
    if (!Array.isArray(classes)) fail('EDITOR_ERROR','Editor did not return a component class catalog');
    return {classes:args.component ? classes.filter(item=>JSON.stringify(item).includes(args.component)) : classes};
  });
  register('component.add', [['scene', 'create-component']], async args => {
    await resolveNode({ uuid: text(args.uuid, 'uuid') });
    const before = componentInfo(await nodeDump(args.uuid));
    const result = await call('scene', 'create-component', { uuid: args.uuid, component: text(args.component, 'component') });
    if (result === false) fail('EDITOR_REJECTED', 'Editor rejected component creation');
    await snapshot();
    const after = componentInfo(await nodeDump(args.uuid));
    const added = after.filter(x => !before.some(y => x.uuid === y.uuid));
    if (!added.length) fail('VERIFICATION_FAILED', 'No new component instance was created', { before, after });
    return { uuid: args.uuid, added, components: after };
  });
  register('component.remove', [['scene', 'remove-component']], async args => {
    await resolveNode({ uuid: text(args.uuid, 'uuid') });
    const before = componentInfo(await nodeDump(args.uuid));
    const matches = before.filter(x => args.componentUuid ? x.uuid === args.componentUuid : x.type === args.component);
    if (!matches.length) fail('COMPONENT_NOT_FOUND', 'Component was not found on this node');
    if (matches.length !== 1) fail('AMBIGUOUS_COMPONENT', 'Use a component instance UUID when multiple components have the same class');
    await call('scene', 'remove-component', { uuid: matches[0].uuid });
    await snapshot();
    const after = componentInfo(await nodeDump(args.uuid));
    if (after.some(x => x.uuid === matches[0].uuid)) fail('VERIFICATION_FAILED', 'Component still exists after removal');
    return { removed: matches[0], components: after };
  });

  function descriptor(dump, inputPath) {
    const parts = safeSegments(inputPath);
    let current = dump;
    let candidate;
    for (let index = 0; index < parts.length; index++) {
      if (isProperty(current)) {
        candidate = { dump: current, path: parts.slice(0, index).join('.'), rest: parts.slice(index) };
        current = current.value;
      }
      if (Array.isArray(current) && !/^\d+$/.test(parts[index])) fail('PROPERTY_NOT_FOUND', 'Only existing array entries can be addressed');
      if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, parts[index])) {
        fail('PROPERTY_NOT_FOUND', 'Property is absent from the live dump: ' + inputPath);
      }
      current = current[parts[index]];
    }
    if (isProperty(current)) {
      return { dump: current, path: parts.join('.'), rest: [] };
    }
    if (candidate) return candidate;
    fail('PROPERTY_NOT_FOUND', 'Path does not address an editable dump property');
  }
  async function encodeValue(before, value) {
    if (isProperty(before)) return encodeProperty(before, value);
    if (Array.isArray(before)) {
      if (!Array.isArray(value)) fail('INVALID_ARGUMENT', 'Expected an array');
      return clone(value);
    }
    if (before && typeof before === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT', 'Expected an object');
      const result = clone(before);
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(before,key)) fail('INVALID_ARGUMENT', 'Unknown value field: ' + key);
        result[key] = await encodeValue(before[key], value[key]);
      }
      return result;
    }
    validateShape(before, value);
    return clone(value);
  }
  async function encodeProperty(source, value) {
    if (source.readonly) fail('READ_ONLY_PROPERTY', 'This property is read-only');
    const result = clone(source);
    if (source.isArray) {
      if (!Array.isArray(value)) fail('INVALID_ARGUMENT', 'Expected an array');
      result.value = [];
      for (let index = 0; index < value.length; index++) {
        const template = source.elementTypeData !== undefined ? source.elementTypeData : source.value[index] !== undefined ? source.value[index] : source.value[0];
        if (template === undefined) fail('UNSUPPORTED_PROPERTY_SHAPE', 'Native array has no element type template');
        result.value.push(await encodeValue(template, value[index]));
      }
      return result;
    }
    const raw = source.value;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, 'uuid')) {
      if (value === null) value = {uuid:''};
      else if (typeof value === 'string') value = {uuid:value};
      if (!value || typeof value !== 'object' || typeof value.uuid !== 'string') fail('INVALID_ARGUMENT', 'Reference values require a UUID, URL, or null');
      if (value.uuid) {
        if (source.type === 'cc.Node') await resolveNode({uuid:value.uuid});
        else if (source.type === 'cc.Component' || (source.extends || []).includes('cc.Component')) {
          const exists = flatten(await tree()).some(({node}) => (node.components || []).some(component => component.value === value.uuid));
          if (!exists) fail('COMPONENT_NOT_FOUND', 'Referenced component does not exist in the current scene');
        } else if ((source.extends || []).includes('cc.Asset') || ['cc.Asset','cc.SpriteFrame','cc.Texture2D','cc.TextureCube','cc.Material','cc.Prefab','cc.Font','cc.BitmapFont','cc.TTFFont','cc.AudioClip','cc.AnimationClip','cc.Mesh','cc.JsonAsset','cc.TextAsset','cc.ImageAsset'].includes(source.type)) {
          let info = await assetInfo(value.uuid);
          if (source.type !== 'cc.Asset' && info.type !== source.type && !(info.extends || []).includes(source.type)) {
            const matches = Object.values(info.subAssets || {}).filter(asset => asset.type === source.type || (asset.extends || []).includes(source.type));
            if (matches.length !== 1) fail('INVALID_ASSET_TYPE', 'Expected a unique ' + source.type + ' asset or subasset');
            info = await assetInfo(matches[0].uuid);
          }
          value = {uuid:info.uuid};
        }
      }
    }
    result.value = await encodeValue(raw, value);
    if (typeof result.value === 'number' && ((typeof source.min === 'number' && result.value < source.min) || (typeof source.max === 'number' && result.value > source.max))) fail('INVALID_ARGUMENT', 'Value is outside the live property bounds');
    if (source.type === 'cc.Color' && Object.values(result.value).some(channel => !Number.isInteger(channel) || channel < 0 || channel > 255)) fail('INVALID_ARGUMENT', 'Color channels must be integers from 0 to 255');
    return result;
  }
  async function propertySet(args) {
    validateJson(args.value);
    await resolveNode({ uuid: text(args.uuid, 'uuid') });
    const before = await nodeDump(args.uuid);
    let propertyPath = text(args.path, 'path');
    if (args.componentUuid) {
      const comp = componentInfo(before).find(x => x.uuid === args.componentUuid);
      if (!comp) fail('COMPONENT_NOT_FOUND', 'Component instance does not belong to this node');
      propertyPath = '__comps__.' + comp.index + '.' + propertyPath;
    }
    const target = descriptor(before, propertyPath);
    let requested = unwrap(target.dump);
    if (target.rest.length) {
      let object = requested;
      for (const key of target.rest.slice(0, -1)) object = object[key];
      object[target.rest[target.rest.length - 1]] = args.value;
    } else requested = args.value;
    const next = await encodeProperty(target.dump, requested);
    const expected = unwrap(next);
    const result = await call('scene', 'set-property', { uuid: args.uuid, path: target.path, dump: next, record: true });
    if (result === false) fail('EDITOR_REJECTED', 'Editor rejected property modification');
    await snapshot();
    const after = await nodeDump(args.uuid);
    const actual = unwrap(descriptor(after, target.path).dump.value);
    if (!isDeepStrictEqual(actual, expected)) fail('VERIFICATION_FAILED', 'Property readback differs from requested value', { path: target.path, expected, actual });
    return { uuid: args.uuid, componentUuid: args.componentUuid, path: target.path, value: actual, verified: true };
  }
  register('property.set', [['scene', 'set-property']], propertySet);

  register('asset.query', [['asset-db', 'query-assets']], async args => {
    await assetReady();
    const action = args.action || 'search';
    if (action === 'search') {
      if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) fail('INVALID_ARGUMENT', 'offset must be a nonnegative integer');
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) fail('INVALID_ARGUMENT', 'limit must be a positive integer');
      let list = await call('asset-db', 'query-assets', { pattern: args.pattern || 'db://assets/**', ccType: args.type && args.type.startsWith('cc.') ? args.type : undefined, type: args.type && !args.type.startsWith('cc.') ? args.type : undefined });
      if (!Array.isArray(list)) fail('EDITOR_REJECTED', 'Asset query did not return an array');
      if (args.type) list = list.filter(info=>info.type===args.type || info.importer===args.type || (info.extends||[]).includes(args.type));
      const offset = args.offset || 0;
      const limit = Math.max(1, Math.min(args.limit || 50, 500));
      return { total: list.length, offset, limit, assets: list.slice(offset, offset + limit) };
    }
    const messages = { info: 'query-asset-info', meta: 'query-asset-meta', uuid: 'query-uuid', url: 'query-url', path: 'query-path' };
    if (!messages[action]) fail('INVALID_ARGUMENT', 'Unknown asset query action');
    const result = await call('asset-db', messages[action], text(args.asset, 'asset'));
    if (result === null || result === undefined) fail('ASSET_NOT_FOUND', 'Asset query did not find ' + args.asset);
    return result;
  });
  register('asset.meta', [['asset-db','save-asset-meta'],['asset-db','reimport-asset']], async args => {
    await assetReady();
    if (!args.userData || typeof args.userData !== 'object' || Array.isArray(args.userData)) fail('INVALID_ARGUMENT','userData must be an object');
    const asset = await assetInfo(args.asset);
    assetUrl(asset.url);
    const meta = await call('asset-db','query-asset-meta',asset.uuid);
    if (!meta || meta.uuid !== asset.uuid) fail('VERIFICATION_FAILED','Native metadata identity differs from the selected asset');
    meta.userData = Object.assign({},meta.userData,args.userData);
    const result = await call('asset-db','save-asset-meta',asset.url,JSON.stringify(meta));
    if (result === false) fail('EDITOR_REJECTED','Editor rejected importer metadata changes');
    if (await call('asset-db','reimport-asset',asset.uuid) === false) fail('IMPORT_FAILED','Importer metadata was saved but reimport was rejected',{partial:true,uuid:asset.uuid});
    const after = await call('asset-db','query-asset-meta',asset.uuid);
    if (!after || after.uuid !== asset.uuid || Object.keys(args.userData).some(key => !isDeepStrictEqual(after.userData && after.userData[key],args.userData[key]))) fail('VERIFICATION_FAILED','Importer metadata readback differs from requested fields');
    const imported = await waitFor(async () => {
      // A successful write may leave its importer pending (imported:false).
      // Post-write verification may wait; preconditions and invalid stay strict.
      const info=await assetInfo(asset.uuid, {allowPending:true});
      if (info.imported === false) return false;
      // Image type changes create asynchronous subassets after save-asset-meta.
      if (asset.importer === 'image' && ['sprite-frame','texture'].includes(args.userData.type)) {
        const type=args.userData.type==='sprite-frame'?'cc.SpriteFrame':'cc.Texture2D';
        if (!Object.values(info.subAssets || {}).some(item=>item.type===type && item.imported && !item.invalid)) return false;
      }
      return info;
    },'Asset did not finish importing the requested metadata').catch(error => {
      error.details = Object.assign({},error.details,{partial:true,uuid:asset.uuid,meta:after});
      throw error;
    });
    return {asset:imported,meta:after,verified:true};
  });
  for (const action of ['create', 'save', 'import', 'move', 'copy', 'delete']) {
    register('asset.' + action, [['asset-db', action + '-asset']], async args => {
      await assetReady();
      let result;
      let expectedContent;
      let expectedFileHash;
      let expectedUrl;
      let movedSource;
      async function digest(file) {
        const hash=crypto.createHash('sha256');
        for await(const chunk of fs.createReadStream(file)) hash.update(chunk);
        return hash.digest('hex');
      }
      if (action === 'create') {
        const url = assetUrl(args.url);
        if (args.content !== undefined && typeof args.content !== 'string') fail('INVALID_ARGUMENT', 'content must be a string');
        result = await call('asset-db', 'create-asset', url, args.content === undefined ? null : args.content, { overwrite: !!args.overwrite, rename: false });
        expectedContent=args.content; expectedUrl=url;
      } else if (action === 'import') {
        const source = path.resolve(text(args.source, 'source'));
        if (!fs.existsSync(source) || !fs.statSync(source).isFile()) fail('INVALID_ARGUMENT', 'Import source must be an existing file');
        expectedFileHash=await digest(source);
        expectedUrl=assetUrl(args.url || 'db://assets/' + path.basename(source));
        result = await call('asset-db', 'import-asset', source, expectedUrl, { overwrite: !!args.overwrite, rename: false });
      } else {
        const info = await assetInfo(args.asset);
        assetUrl(info.url);
        if (action === 'save') {
          if (typeof args.content !== 'string') fail('INVALID_ARGUMENT', 'content must be a string');
          result = await call('asset-db', 'save-asset', info.url, args.content);
          expectedContent=args.content; expectedUrl=info.url;
        } else if (action === 'delete') {
          result = await call('asset-db', 'delete-asset', info.url);
          if (result === false) fail('EDITOR_REJECTED', 'Editor rejected asset deletion');
          if (await call('asset-db', 'query-asset-info', info.uuid)) fail('VERIFICATION_FAILED', 'Asset still exists after deletion');
          return { deleted: info.uuid, url: info.url };
        } else {
          if (info.file && !info.isDirectory) expectedFileHash=await digest(info.file);
          expectedUrl=assetUrl(args.url);
          if (action === 'move') movedSource=info;
          result = await call('asset-db', action + '-asset', info.url, expectedUrl, { overwrite: !!args.overwrite, rename: false });
        }
      }
      if (result === false || (result == null && action !== 'move')) fail('EDITOR_REJECTED', 'Editor rejected asset ' + action);
      // 3.7.3 move-asset resolves null even on success; prove its result by URL,
      // stable UUID, source disappearance and actual bytes rather than acknowledgement shape.
      let verifiedUuid = result && result.uuid || movedSource && movedSource.uuid;
      const verified = await waitFor(async () => {
        const info = await assetInfo(result && result.uuid || expectedUrl || args.asset, {allowPending:true});
        if (expectedUrl && info.url !== expectedUrl) fail('VERIFICATION_FAILED', 'Asset operation returned a different destination URL');
        if (movedSource && info.uuid !== movedSource.uuid) fail('VERIFICATION_FAILED','Asset move did not preserve identity and remove the old URL');
        verifiedUuid = info.uuid;
        return info.imported === false ? false : info;
      },'Asset did not finish importing after ' + action).catch(error => {
        error.details = Object.assign({},error.details,{partial:true,url:expectedUrl,uuid:verifiedUuid});
        throw error;
      });
      if (movedSource && (verified.uuid !== movedSource.uuid || (movedSource.url !== verified.url && await call('asset-db','query-asset-info',movedSource.url)))) fail('VERIFICATION_FAILED','Asset move did not preserve identity and remove the old URL');
      try {
        if (expectedContent !== undefined && (!verified.file || !fs.readFileSync(verified.file).equals(Buffer.from(expectedContent,'utf8')))) fail('VERIFICATION_FAILED', 'Asset file content differs from the requested UTF-8 bytes');
        if (expectedFileHash && (!verified.file || await digest(verified.file) !== expectedFileHash)) fail('VERIFICATION_FAILED', 'Asset file differs from the source bytes');
      } catch(error) {
        if(error.code==='VERIFICATION_FAILED') throw error;
        fail('VERIFICATION_FAILED','Asset output file could not be read',{cause:error.message});
      }
      return verified;
    });
  }

  register('prefab.create', [['scene', 'create-prefab']], async args => {
    await assetReady();
    const before=await resolveNode({ uuid: text(args.uuid, 'uuid') });
    if (!before.parent) fail('INVALID_ARGUMENT','Cannot turn the scene root into a prefab');
    const url = assetUrl(args.url);
    if (!url.endsWith('.prefab')) fail('INVALID_ASSET_URL', 'Prefab URL must end in .prefab');
    if (await call('asset-db', 'query-asset-info', url)) fail('ASSET_EXISTS', 'A prefab already exists at the destination');
    const result = await call('scene', 'create-prefab', args.uuid, url);
    if (result === false) fail('EDITOR_REJECTED', 'Native prefab creation failed');
    await snapshot();
    const info = await waitFor(() => call('asset-db', 'query-asset-info', url), 'Native prefab creation did not produce an asset');
    const entries=flatten(await tree());
    let after=entries.find(entry=>entry.node.uuid===args.uuid);
    if (!after) {
      const candidates=entries.filter(entry=>entry.parent && entry.parent.uuid===before.parent.uuid && entry.node.prefab && entry.node.prefab.assetUuid===info.uuid);
      if (candidates.length!==1) fail('VERIFICATION_FAILED','Prefab asset was created but its replacement scene node was not uniquely identified',{partial:true,asset:info});
      after=candidates[0];
    }
    // Native Creator 3.7.3 replaces and renames the source node while linking it.
    // Return every changed identity so callers can keep addressing the same data.
    const identityRemap={nodes:{},components:{}};
    function map(oldNode,newNode) {
      identityRemap.nodes[oldNode.uuid]=newNode.uuid;
      const oldComponents=oldNode.components||[],newComponents=newNode.components||[];
      oldComponents.forEach((component,index)=>{
        if(newComponents[index] && newComponents[index].type===component.type) identityRemap.components[component.value]=newComponents[index].value;
      });
      if((oldNode.children||[]).length!==(newNode.children||[]).length) fail('VERIFICATION_FAILED','Prefab conversion changed the source subtree structure',{partial:true,asset:info,identityRemap});
      (oldNode.children||[]).forEach((child,index)=>map(child,newNode.children[index]));
    }
    map(before.node,after.node);
    return { asset:info, source:await nodeQuery({uuid:after.node.uuid}), identityRemap };
  });
  register('prefab.instantiate', [['scene', 'create-node']], async args => {
    await assetReady();
    await ready();
    const asset = await assetInfo(args.asset || args.url);
    if (asset.type !== 'cc.Prefab') fail('INVALID_ASSET_TYPE', 'Expected a successfully imported prefab asset');
    const parent = await creationParent(args.parent);
    const result = await call('scene', 'create-node', { assetUuid: asset.uuid, type: 'cc.Prefab', parent, name: args.name, snapshot: true });
    const uuids = typeof result === 'string' ? [result] : result;
    if (!Array.isArray(uuids) || !uuids.length) fail('EDITOR_REJECTED', 'Prefab instantiation returned no node UUIDs');
    const nodes = [];
    for (const uuid of uuids) {
      try {
        // The resource-instantiation branch in 3.7.3 also ignores options.name.
        if (args.name !== undefined) await propertySet({uuid,path:'name',value:text(args.name,'name')});
        nodes.push(await nodeQuery({uuid}));
      } catch(error) { error.details={cause:error.details,partial:true,createdUuids:uuids}; throw error; }
    }
    return { assetUuid: asset.uuid, uuids, nodes };
  });

  register('ui.build', [['scene', 'create-node'], ['scene', 'set-property']], async args => {
    if (!Array.isArray(args.tree) || !args.tree.length) fail('INVALID_ARGUMENT', 'tree must be a nonempty array');
    let count = 0;
    function validate(nodes, depth) {
      if (depth > 20) fail('INVALID_ARGUMENT', 'UI tree depth exceeds 20');
      for (const node of nodes) {
        if (++count > 500) fail('INVALID_ARGUMENT', 'UI tree exceeds 500 nodes');
        text(node.name, 'tree node name');
        if (node.properties !== undefined && (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties))) fail('INVALID_ARGUMENT', 'Node properties must be an object');
        if (node.properties) for (const key of Object.keys(node.properties)) safeSegments(key);
        if (node.components !== undefined && !Array.isArray(node.components)) fail('INVALID_ARGUMENT', 'Node components must be an array');
        if (node.components) for (const comp of node.components) {
          text(comp.type, 'component type');
          if (comp.properties !== undefined && (!comp.properties || typeof comp.properties !== 'object' || Array.isArray(comp.properties))) fail('INVALID_ARGUMENT', 'Component properties must be an object');
          if (comp.properties) for (const key of Object.keys(comp.properties)) safeSegments(key);
        }
        if (node.children !== undefined && !Array.isArray(node.children)) fail('INVALID_ARGUMENT', 'Node children must be an array');
        if (node.children) validate(node.children, depth + 1);
      }
    }
    validate(args.tree, 0);
    const created = [];
    async function build(nodes, parent) {
      for (const node of nodes) {
        let result;
        try { result = await handlers['node.create']({ name: node.name, parent, components: (node.components || []).map(c => c.type) }); }
        catch(error) {
          if (error.details && error.details.createdUuids) for (const uuid of error.details.createdUuids) created.push({uuid,name:node.name});
          throw error;
        }
        const uuid = result.uuids[0];
        created.push({ uuid, name: node.name });
        for (const key of Object.keys(node.properties || {})) await propertySet({ uuid, path: key, value: node.properties[key] });
        for (const spec of node.components || []) {
          const matches = componentInfo(await nodeDump(uuid)).filter(c => c.type === spec.type);
          if (matches.length !== 1) fail('AMBIGUOUS_COMPONENT', 'UI builder requires unique component types');
          for (const key of Object.keys(spec.properties || {})) await propertySet({ uuid, componentUuid: matches[0].uuid, path: key, value: spec.properties[key] });
        }
        if (node.children) await build(node.children, uuid);
      }
    }
    try { await build(args.tree, args.parent); }
    catch (error) { error.details = { cause: error.details, partial: true, created }; throw error; }
    return { created, atomic: false, scene: await handlers['scene.query']({}) };
  });
  register('editor.logs', [], async args => ({
    scope: 'bridge operations since extension load',
    entries: log.filter(x => (!args.level || args.level === 'all' || x.level === args.level) && (!args.since || x.timestamp >= args.since)).slice(-Math.min(args.limit || 100, 1000)),
  }));

  Object.assign(handlers, extras.handlers);
  const readOnlyCommands = new Set(['editor.info','editor.logs','scene.query','node.query','component.list','component.catalog','asset.query','preview.info','build.config','build.status']);
  const dispatch = (command, args) => operations.run({ mutationRequested: false }, async () => {
    if (!Object.prototype.hasOwnProperty.call(handlers, command)) fail('UNSUPPORTED_COMMAND', 'Command is not supported by this editor: ' + command);
    args = args || {};
    validateJson(args);
    try {
      if (extras.isBuilding() && !readOnlyCommands.has(command) && !['build.start','build.cancel'].includes(command)) fail('BUILD_BUSY','Wait for the active build before editing the project');
      if (command === 'build.start') {
        singleSceneWindow();
        await assetReady();
        if (await call('scene','query-is-ready') === true && await call('scene','query-dirty')) fail('UNSAVED_CHANGES','Save the scene before starting a build');
      }
      if (command === 'preview.open') singleSceneWindow();
      const result = await handlers[command](args);
      if (command !== 'editor.logs') record('info', command + ' completed');
      return result;
    } catch (error) {
      if (!error.code) error.code = 'EDITOR_ERROR';
      if (!readOnlyCommands.has(command)) {
        const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
          ? error.details : error.details === undefined ? {} : { nativeDetails: error.details };
        error.details = Object.assign({}, details, {
          outcome: operations.getStore().mutationRequested ? 'unknown' : 'not_applied', retryable: false,
        });
      }
      record('error', command + ': ' + error.message, { code: error.code });
      throw error;
    }
  });
  return {
    commands: () => Object.keys(handlers), dispatch,
    dispose: () => { extras.dispose(); for (const [event, listener] of listeners) editor.Message.removeBroadcastListener(event, listener); },
  };
}

module.exports = { createAdapter, unwrap, safeSegments, flatten, componentInfo };
