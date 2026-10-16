'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspect } = require('node:util');
const { after, test } = require('node:test');
const { createAdapter } = require('../extensions/cocos-creator-mcp/adapter.js');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-native-contract-'));
let fixtureNumber = 0;
after(() => {
  // Only remove the absolute temporary directory created by this test file.
  assert.equal(path.resolve(path.dirname(fixtureRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixtureRoot).startsWith('creator-native-contract-'));
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

// The fixture models the Editor boundary, not adapter helpers. Creator 3.7's
// builtin/scene/@types/public.d.ts defines INode properties as IProperty dumps,
// __comps__ as component dumps, and component.value as a map of properties.
// Vec3 values contain raw coordinates; component UUIDs and editable fields are
// wrapped independently. Query replies are detached, as they are across IPC.
const copy = value => structuredClone(value);
const prop = (type, value, metadata = {}) => ({ type, value, readonly: false, visible: true, ...metadata });
function component(type, uuid) {
  const fields = {
    uuid: prop('String', uuid, { readonly: true }),
    enabled: prop('Boolean', true),
  };
  if (type === 'cc.Label') Object.assign(fields, { string: prop('String', 'Hello'), fontSize: prop('Number', 40, { min: 0 }) });
  if (type === 'cc.UIOpacity') fields.opacity = prop('Number', 255, { min: 0, max: 255, step: 1 });
  if (type === 'cc.Sprite') fields.spriteFrame = prop('cc.SpriteFrame', { uuid: 'sprite-frame' });
  if (type === 'cc.MeshRenderer') fields.materials = prop('cc.Material', [prop('cc.Material', { uuid: 'material-one' })], { isArray: true });
  if (type === 'contract.Settings') fields.config = prop('Object', { theme: 'original', rules: [{ label: 'safe' }] });
  return { type, cid: type, value: fields, readonly: false, visible: true };
}
function node(uuid, name, parent = null, components = []) {
  return { uuid, parent, dump: {
    uuid: prop('String', uuid, { readonly: true }), name: prop('String', name), active: prop('Boolean', true),
    position: prop('cc.Vec3', { x: 12, y: 34, z: 56 }), rotation: prop('cc.Vec3', { x: 0, y: 0, z: 90 }),
    scale: prop('cc.Vec3', { x: 1, y: 1, z: 1 }), layer: prop('Number', 1),
    __comps__: components,
  } };
}
function editorFixture({ nativeComponents = [] } = {}) {
  const projectPath = path.join(fixtureRoot, String(++fixtureNumber));
  const assetsPath = path.join(projectPath, 'assets');
  const appPath=path.join(projectPath,'editor');
  const nativeMessages={
    scene:['query-is-ready','query-dirty','query-node-tree','query-node','query-classes','set-property','snapshot','create-node','remove-node','set-parent','duplicate-node','create-component','remove-component','open-scene','save-scene','undo','redo','create-prefab'],
    'asset-db':['query-ready','query-assets','query-asset-info','query-asset-meta','query-uuid','query-url','query-path','create-asset','save-asset','import-asset','move-asset','copy-asset','delete-asset','save-asset-meta','reimport-asset'],
  };
  for(const [name,messages] of Object.entries(nativeMessages)){
    const directory=path.join(appPath,'builtin',name);fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({contributions:{messages:Object.fromEntries(messages.map(message=>[message,{methods:[message]}]))}}));
  }
  fs.mkdirSync(assetsPath, { recursive: true });
  const label = node('label-node', 'Label', 'panel-node', [component('cc.Label', 'label-component'), component('cc.UIOpacity', 'opacity-component')]);
  const state = {
    ready: true, assetReady: true, dirty: false, forest: false, nextNode: 0, nextComponent: 0, nextAsset: 0,
    nodes: new Map([['scene-root', node('scene-root', 'Scene')], ['panel-node', node('panel-node', 'Panel', 'scene-root')], ['label-node', label]]),
    assets: new Map([
      ['scene-asset', { uuid: 'scene-asset', url: 'db://assets/Main.scene', type: 'cc.SceneAsset', invalid: false }],
      ['prefab-asset', { uuid: 'prefab-asset', url: 'db://assets/Panel.prefab', type: 'cc.Prefab', invalid: false }],
      ['text-asset', { uuid: 'text-asset', url: 'db://assets/content.txt', type: 'cc.TextAsset', invalid: false }],
      ['sprite-frame', { uuid: 'sprite-frame', url: 'db://assets/icon.png/spriteFrame', type: 'cc.SpriteFrame', invalid: false }],
    ]),
    contents: new Map([['text-asset', 'original']]), overrides: new Map(), calls: [],
    assetMetadata: new Map(), pendingAssetImports: new Map(),
  };
  function asset(selector) { return state.assets.get(selector) || [...state.assets.values()].find(info => info.url === selector); }
  function nativeAsset(selector) {
    assert.ok(typeof selector === 'string' && selector.startsWith('db://assets/'), 'Creator 3.7.3 asset mutations require a db:// URL as the native source selector.');
    const info = asset(selector);
    assert.ok(info, 'Native asset source URL must resolve to an existing asset.');
    return info;
  }
  function fileForUrl(url) {
    const file = path.resolve(assetsPath, url.slice('db://assets/'.length).replace(/\/spriteFrame$/, ''));
    assert.ok(file.startsWith(assetsPath + path.sep), 'The simulated native Editor must never write outside its temporary assets directory.');
    return file;
  }
  function persist(info, content) {
    info.file = fileForUrl(info.url);
    fs.mkdirSync(path.dirname(info.file), { recursive: true });
    fs.writeFileSync(info.file, content, 'utf8');
  }
  for (const info of state.assets.values()) persist(info, state.contents.get(info.uuid) ?? '');
  function hierarchy() {
    const branch = current => ({ uuid: current.uuid, name: current.dump.name.value,
      children: [...state.nodes.values()].filter(child => child.parent === current.uuid).map(branch) });
    const roots = [...state.nodes.values()].filter(current => current.parent === null).map(branch);
    return state.forest ? roots : roots[0];
  }
  function insertNode(name, parent, components = []) {
    const uuid = 'created-node-' + ++state.nextNode;
    const current = node(uuid, name, parent || 'scene-root', components.map(type => component(type, 'created-component-' + ++state.nextComponent)));
    state.nodes.set(uuid, current);
    return uuid;
  }
  function addAsset(url, content) {
    const uuid = 'created-asset-' + ++state.nextAsset;
    const info = { uuid, url, type: url.endsWith('.scene') ? 'cc.SceneAsset' : url.endsWith('.prefab') ? 'cc.Prefab' : 'cc.TextAsset', invalid: false };
    state.assets.set(uuid, info);
    state.contents.set(uuid, content);
    persist(info, content);
    return { uuid };
  }
  function native(moduleName, message, args) {
    const [first, second, third] = args;
    switch (moduleName + ':' + message) {
      case 'scene:query-is-ready': return state.ready;
      case 'scene:query-dirty': return state.dirty;
      case 'scene:query-node-tree': return hierarchy();
      case 'scene:query-node': return state.nodes.get(first)?.dump || null;
      case 'scene:snapshot': return undefined; // Native void responses are valid.
      case 'scene:set-property': {
        const current = state.nodes.get(first.uuid);
        assert.ok(current, 'Native set-property must target a node UUID.');
        const parts=first.path.split('.');
        const key=parts.pop();
        let owner=current.dump;
        for(const part of parts){
          if(owner && typeof owner.type==='string' && Object.hasOwn(owner,'value'))owner=owner.value;
          owner=owner?.[part];
        }
        if(owner && typeof owner.type==='string' && Object.hasOwn(owner,'value'))owner=owner.value;
        assert.ok(owner?.[key] && Object.hasOwn(owner[key],'value') && typeof owner[key].type==='string','Native paths address IProperty dumps, not raw vector coordinates.');
        owner[key]=copy(first.dump);
        state.dirty = true;
        return undefined;
      }
      case 'scene:create-node': {
        // Verified in Creator 3.7.3: create-node can ignore components. The
        // A native/template default may already provide some components; the
        // requested final state must be satisfied without duplicate instances.
        const uuid = insertNode(first.name || 'Prefab instance', first.parent, nativeComponents);
        if (first.position) state.nodes.get(uuid).dump.position.value = copy(first.position);
        state.dirty = true;
        return [uuid];
      }
      case 'scene:create-component': {
        const current = state.nodes.get(first.uuid);
        assert.ok(current);
        current.dump.__comps__.push(component(first.component, 'created-component-' + ++state.nextComponent));
        state.dirty = true;
        return undefined;
      }
      case 'scene:remove-component': {
        // Verified in Creator 3.7.3: uuid identifies the COMPONENT INSTANCE.
        // A node UUID plus component/cid is ineffective. Native failure can be
        // logged with a void response, so unchanged state must fail readback.
        for (const current of state.nodes.values()) {
          const index = current.dump.__comps__.findIndex(comp => comp.value.uuid.value === first.uuid);
          if (index !== -1) {
            current.dump.__comps__.splice(index, 1);
            state.dirty = true;
            break;
          }
        }
        return undefined;
      }
      case 'scene:remove-node': {
        function remove(uuid) {
          for (const child of [...state.nodes.values()].filter(current => current.parent === uuid)) remove(child.uuid);
          state.nodes.delete(uuid);
        }
        remove(first.uuid); state.dirty = true; return undefined;
      }
      case 'scene:set-parent': state.nodes.get(first.uuids).parent = first.parent; state.dirty = true; return undefined;
      case 'scene:duplicate-node': {
        const original = state.nodes.get(first);
        const uuid = insertNode(original.dump.name.value + ' copy', original.parent);
        state.nodes.get(uuid).dump = copy(original.dump);
        state.nodes.get(uuid).dump.uuid.value = uuid;
        state.dirty = true;
        return [uuid];
      }
      case 'scene:open-scene': {
        const target = asset(first);
        assert.ok(target);
        const root = [...state.nodes.values()].find(current => current.parent === null);
        const oldUuid = root.uuid;
        state.nodes.delete(oldUuid);
        root.uuid = target.uuid; root.dump.uuid.value = target.uuid;
        root.dump.name.value = path.basename(target.url, '.scene');
        for (const child of state.nodes.values()) if (child.parent === oldUuid) child.parent = target.uuid;
        state.nodes.set(root.uuid, root);
        state.ready = true; state.dirty = false;
        return undefined;
      }
      case 'scene:save-scene': state.dirty = false; return undefined;
      case 'scene:undo': case 'scene:redo': return undefined;
      case 'scene:create-prefab': return addAsset(second, 'native prefab');
      case 'asset-db:query-ready': return state.assetReady;
      case 'asset-db:query-asset-info': {
        const info = asset(first);
        const pending = info && state.pendingAssetImports.get(info.uuid);
        if (pending) {
          // Model importer observations independently of wall-clock timing:
          // A parent may remain imported:false after a write is acknowledged.
          // Its subasset is initially absent, pending, invalid, then usable.
          const observation = pending.observations++;
          info.imported = observation > 0;
          if (observation > 0) {
            const subasset = { uuid: pending.uuid, url: info.url + '/' + pending.name,
              type: pending.type, imported: observation >= 2, invalid: observation === 2 };
            info.subAssets = { ...info.subAssets, [pending.name]: subasset };
            if (observation >= 3) {
              state.assets.set(subasset.uuid, subasset);
              state.pendingAssetImports.delete(info.uuid);
            }
          }
        }
        return info || null;
      }
      case 'asset-db:query-assets': return [...state.assets.values()];
      case 'asset-db:query-uuid': return asset(first)?.uuid || null;
      case 'asset-db:query-url': return asset(first)?.url || null;
      case 'asset-db:query-path': return asset(first)?.file || null;
      case 'asset-db:query-asset-meta': {
        const info = asset(first);
        return info ? state.assetMetadata.get(info.uuid) || { uuid: info.uuid, importer: info.importer || 'text', ver: '1.0.0', userData: {} } : null;
      }
      case 'asset-db:save-asset-meta': {
        const info = nativeAsset(first);
        const oldAssetInfo = copy(info);
        state.assetMetadata.set(info.uuid, JSON.parse(second));
        fs.writeFileSync(info.file + '.meta', second, 'utf8');
        return oldAssetInfo; // Native acknowledgement can describe the old asset.
      }
      case 'asset-db:reimport-asset': {
        const info = state.assets.get(first);
        assert.ok(info && info.uuid === first, 'Native reimport-asset identifies its asset by UUID.');
        const requested = state.assetMetadata.get(info.uuid)?.userData?.type;
        if (info.importer === 'image' && ['sprite-frame', 'texture'].includes(requested)) {
          const name = requested === 'sprite-frame' ? 'spriteFrame' : 'texture';
          info.imported = false;
          state.pendingAssetImports.set(info.uuid, { observations: 0, name,
            uuid: info.uuid + '@' + name, type: requested === 'sprite-frame' ? 'cc.SpriteFrame' : 'cc.Texture2D' });
        }
        return null; // Verified native reimport acknowledgement is not boolean.
      }
      case 'asset-db:create-asset': return addAsset(first, second);
      case 'asset-db:save-asset': {
        const info = nativeAsset(first);
        state.contents.set(info.uuid, second); persist(info, second); return { uuid: info.uuid };
      }
      case 'asset-db:delete-asset': {
        const info = nativeAsset(first);
        fs.unlinkSync(info.file); state.assets.delete(info.uuid); state.contents.delete(info.uuid); return undefined;
      }
      case 'asset-db:move-asset': {
        const info = nativeAsset(first);
        const destination = fileForUrl(second);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(info.file, destination);
        info.url = second; info.file = destination;
        return null; // Sampled Creator 3.7.3 move result; success still requires readback.
      }
      case 'asset-db:copy-asset': return addAsset(second, fs.readFileSync(nativeAsset(first).file));
      case 'asset-db:import-asset': return addAsset(second, fs.readFileSync(first));
      default: assert.fail('Unexpected native Editor request: ' + moduleName + ':' + message + ' ' + JSON.stringify(third));
    }
  }
  const editor = {
    App: { version: '3.7.3', path: appPath },
    Project: { uuid: 'contract-project', name: 'Adapter contract', path: projectPath },
    Message: {
      async request(moduleName, message, ...args) {
        state.calls.push({ module: moduleName, message, args: copy(args) });
        const override = state.overrides.get(moduleName + ':' + message);
        const result = override ? await override(args, () => native(moduleName, message, args)) : native(moduleName, message, args);
        return copy(result);
      },
      addBroadcastListener() {}, removeBroadcastListener() {},
    },
  };
  const adapter = createAdapter(editor);
  return { state, adapter, editor, dispatch: (command, args) => adapter.dispatch(command, args),
    writes: () => state.calls.filter(call => !call.message.startsWith('query-')),
    nativeCalls: message => state.calls.filter(call => call.message === message),
    node: uuid => state.nodes.get(uuid), asset,
  };
}

function imageMetadataFixture() {
  const f = editorFixture();
  const file = path.join(path.dirname(f.asset('text-asset').file), 'imported.png');
  const info = { uuid: 'image-asset', url: 'db://assets/imported.png', file,
    type: 'cc.ImageAsset', importer: 'image', imported: true, invalid: false,
    subAssets: { texture: { uuid: 'image-asset@texture', type: 'cc.Texture2D', imported: true, invalid: false } } };
  const meta = { uuid: info.uuid, importer: 'image', ver: '1.0.27', imported: true,
    files: ['.json', '.png'],
    subMetas: { texture: { uuid: 'image-asset@texture', importer: 'texture', ver: '1.0.22', userData: { retained: true } } },
    userData: { type: 'texture', hasAlpha: true, retained: { setting: 'keep' } } };
  fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5z8AAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(file + '.meta', JSON.stringify(meta), 'utf8');
  f.state.assets.set(info.uuid, info);
  f.state.assetMetadata.set(info.uuid, meta);
  return f;
}
const rejectsCode = (code, inspect) => error => {
  assert.equal(error.code, code, error.stack);
  inspect?.(error);
  return true;
};
async function rejectsWithoutWriting(fixture, command, args, expectedCode) {
  await assert.rejects(fixture.dispatch(command, args), rejectsCode(expectedCode));
  assert.deepEqual(fixture.writes(), [], 'Rejected input/readiness must never reach a native mutation.');
}

test('queries preserve Creator 3.7 typed dump, hierarchy, Euler rotation, and component instance identity', async t => {
  for (const forest of [false, true]) await t.test(forest ? 'root array' : 'root object', async () => {
    const f = editorFixture(); f.state.forest = forest;
    const result = await f.dispatch('node.query', { path: 'Scene/Panel/Label' });
    assert.equal(result.uuid, 'label-node');
    assert.equal(result.parentUuid, 'panel-node');
    assert.deepEqual(result.position, { x: 12, y: 34, z: 56 });
    assert.deepEqual(result.rotation, { x: 0, y: 0, z: 90 });
    assert.equal(result.active, true);
    assert.deepEqual(result.components.map(comp => [comp.type, comp.uuid]), [['cc.Label', 'label-component'], ['cc.UIOpacity', 'opacity-component']]);
    assert.equal(result.dump.__comps__[0].value.string.type, 'String');
    result.dump.name.value = 'client-side change';
    assert.equal((await f.dispatch('node.query', { uuid: 'label-node' })).name, 'Label');
    assert.deepEqual(f.writes(), []);
  });
});

test('node query without a selector returns the hierarchy; conflicting selectors cannot silently pick a node', async () => {
  const f = editorFixture();
  const result = await f.dispatch('node.query', {});
  const roots = Array.isArray(result.tree) ? result.tree : [result.tree];
  const root = roots.find(current => current.uuid === 'scene-root');
  assert.ok(root);
  assert.equal(root.children[0].uuid, 'panel-node');
  await assert.rejects(f.dispatch('node.query', { uuid: 'label-node', name: 'Panel' }), rejectsCode('INVALID_ARGUMENT'));
  assert.deepEqual(f.writes(), []);
});

test('property writes accept 0, false and empty strings and verify actual native readback', async t => {
  const cases = [
    [{ path: 'active', value: false }, () => false],
    [{ path: 'name', value: '' }, () => ''],
    [{ path: 'layer', value: 0 }, () => 0],
    [{ path: 'position.x', value: 0 }, () => ({ x: 0, y: 34, z: 56 })],
    [{ componentUuid: 'label-component', path: 'string', value: '' }, () => ''],
    [{ componentUuid: 'opacity-component', path: 'opacity', value: 0 }, () => 0],
  ];
  for (const [args, expected] of cases) await t.test(args.path, async () => {
    const f = editorFixture();
    const result = await f.dispatch('property.set', { uuid: 'label-node', ...args });
    assert.equal(result.verified, true);
    assert.deepEqual(result.value, expected());
    const writes = f.nativeCalls('set-property');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].args[0].uuid, 'label-node', 'Component instance IDs must not be substituted for owning node IDs.');
    assert.equal(writes[0].args[0].record, true);
    assert.ok(writes[0].args[0].dump.type, 'Native set-property requires a typed IProperty dump.');
    const after = await f.dispatch('node.query', { uuid: 'label-node' });
    if (args.path === 'active' || args.path === 'name' || args.path === 'layer') assert.equal(after.dump[args.path].value, args.value);
    if (args.path === 'position.x') assert.deepEqual(after.position, expected());
    if (args.componentUuid) assert.equal(after.components.find(comp => comp.uuid === args.componentUuid).properties[args.path], args.value);
  });
});

test('property acknowledgement without a changed dump fails verification instead of reporting success', async () => {
  const f = editorFixture();
  f.state.overrides.set('scene:set-property', () => undefined);
  await assert.rejects(f.dispatch('property.set', { uuid: 'label-node', path: 'active', value: false }), rejectsCode('VERIFICATION_FAILED', error => {
    assert.equal(error.details.expected, false);
    assert.equal(error.details.actual, true);
  }));
  assert.equal(f.nativeCalls('set-property').length, 1, 'A failed write must not be retried.');
  assert.equal(f.node('label-node').dump.active.value, true);
});

test('asset references resolve to valid assets of the declared property type before a native write', async t => {
  const cases = [
    ['db://assets/missing.png/spriteFrame', 'ASSET_NOT_FOUND'],
    ['missing-asset-uuid', 'ASSET_NOT_FOUND'],
    ['db://assets/content.txt', 'INVALID_ASSET_TYPE'],
  ];
  for (const [value, expected] of cases) await t.test(value, async () => {
    const f = editorFixture();
    f.node('label-node').dump.__comps__.push(component('cc.Sprite', 'sprite-component'));
    await rejectsWithoutWriting(f, 'property.set', { uuid: 'label-node', componentUuid: 'sprite-component', path: 'spriteFrame', value }, expected);
  });
  await t.test('valid SpriteFrame URL', async () => {
    const f = editorFixture();
    const sprite = component('cc.Sprite', 'sprite-component'); sprite.value.spriteFrame.value.uuid = '';
    f.node('label-node').dump.__comps__.push(sprite);
    const result = await f.dispatch('property.set', { uuid: 'label-node', componentUuid: 'sprite-component', path: 'spriteFrame', value: 'db://assets/icon.png/spriteFrame' });
    assert.equal(result.verified, true);
    assert.deepEqual(result.value, { uuid: 'sprite-frame' });
    const after = await f.dispatch('node.query', { uuid: 'label-node' });
    assert.deepEqual(after.components.find(comp => comp.uuid === 'sprite-component').properties.spriteFrame, { uuid: 'sprite-frame' });
  });
});

test('component add/remove succeeds only with an observed component-instance change', async () => {
  const f = editorFixture();
  const before = await f.dispatch('component.list', { uuid: 'label-node' });
  const added = await f.dispatch('component.add', { uuid: 'label-node', component: 'cc.Sprite' });
  assert.equal(added.added.length, 1);
  assert.equal(added.added[0].type, 'cc.Sprite');
  assert.ok(!before.components.some(comp => comp.uuid === added.added[0].uuid));
  const removed = await f.dispatch('component.remove', { uuid: 'label-node', componentUuid: added.added[0].uuid });
  assert.equal(removed.removed.uuid, added.added[0].uuid);
  assert.ok(!removed.components.some(comp => comp.uuid === added.added[0].uuid));
  assert.deepEqual(removed.components.map(comp => comp.uuid), before.components.map(comp => comp.uuid));
});

test('node creation satisfies requested components even when native create-node ignores them', async t => {
  for (const nativeComponents of [[], ['cc.Label', 'cc.UIOpacity']]) await t.test(nativeComponents.length ? 'components already supplied natively' : 'Creator 3.7.3 ignores components', async () => {
    const f = editorFixture({ nativeComponents });
    const requested = ['cc.Label', 'cc.UIOpacity'];
    const result = await f.dispatch('node.create', { name: 'Requested node', parent: 'panel-node',
      components: requested, position: { x: 0, y: -12, z: 3 } });
    assert.equal(result.uuids.length, 1);
    const current = await f.dispatch('node.query', { uuid: result.uuids[0] });
    assert.equal(current.name, 'Requested node');
    assert.equal(current.parentUuid, 'panel-node');
    assert.deepEqual(current.position, { x: 0, y: -12, z: 3 });
    for (const type of requested) {
      assert.equal(current.components.filter(comp => comp.type === type).length, 1, 'Requested component must exist exactly once: ' + type);
      assert.equal(result.nodes[0].components.filter(comp => comp.type === type).length, 1, 'Success response must describe the actual requested component: ' + type);
    }
  });
});

test('node creation cannot succeed with requested components absent after native acknowledgement', async () => {
  const f = editorFixture();
  f.state.overrides.set('scene:create-component', () => undefined);
  await assert.rejects(f.dispatch('node.create', { name: 'Incomplete', components: ['cc.Label'] }), rejectsCode('VERIFICATION_FAILED'));
});

test('node creation surfaces a native failure while satisfying requested components', async () => {
  const f = editorFixture();
  f.state.overrides.set('scene:create-component', () => { const error = new Error('Component creation refused'); error.code = 'EDITOR_BUSY'; throw error; });
  await assert.rejects(f.dispatch('node.create', { name: 'Incomplete', components: ['cc.Label'] }), rejectsCode('EDITOR_BUSY'));
});

test('invalid node creation vectors never reach native creation', async t => {
  const positions = [null, false, '0,0,0', [0, 0, 0], { x: 0, y: 0 },
    { x: '0', y: 0, z: 0 }, { x: 0, y: false, z: 0 }, { x: 0, y: 0, z: null },
    { x: NaN, y: 0, z: 0 }, { x: 0, y: Infinity, z: 0 }];
  for (const position of positions) await t.test(inspect(position), () => rejectsWithoutWriting(editorFixture(), 'node.create', { name: 'Invalid position', position }, 'INVALID_ARGUMENT'));
});

test('a component class selector is rejected when multiple instances have that class', async () => {
  const f = editorFixture();
  f.node('label-node').dump.__comps__.push(component('cc.Label', 'another-label-component'));
  const before = copy(f.node('label-node').dump.__comps__);
  await rejectsWithoutWriting(f, 'component.remove', { uuid: 'label-node', component: 'cc.Label' }, 'AMBIGUOUS_COMPONENT');
  assert.deepEqual(f.node('label-node').dump.__comps__, before);
});

test('an exact component UUID removes only that instance among duplicate classes', async t => {
  for (const componentUuid of ['label-component', 'another-label-component']) await t.test(componentUuid, async () => {
    const f = editorFixture();
    const second = component('cc.Label', 'another-label-component');
    second.value.string.value = 'Keep this distinct instance';
    second.value.enabled.value = false;
    f.node('label-node').dump.__comps__.push(second);
    const before = copy(f.node('label-node').dump.__comps__);
    const expected = before.filter(comp => comp.value.uuid.value !== componentUuid);
    const result = await f.dispatch('component.remove', { uuid: 'label-node', componentUuid });
    assert.equal(result.removed.uuid, componentUuid);
    assert.deepEqual(f.node('label-node').dump.__comps__, expected, 'All surviving component properties and instance identities must be preserved.');
    const readback = await f.dispatch('component.list', { uuid: 'label-node' });
    assert.ok(!readback.components.some(comp => comp.uuid === componentUuid));
    assert.equal(readback.components.filter(comp => comp.type === 'cc.Label').length, 1);
    assert.deepEqual(result.components, readback.components);
    assert.ok(f.node('label-node'), 'Removing a component must retain its owning node.');
  });
});

test('a unique class selector resolves to the component instance and preserves other components', async () => {
  const f = editorFixture();
  const labelBefore = copy(f.node('label-node').dump.__comps__[0]);
  const result = await f.dispatch('component.remove', { uuid: 'label-node', component: 'cc.UIOpacity' });
  assert.equal(result.removed.uuid, 'opacity-component');
  assert.deepEqual(f.node('label-node').dump.__comps__, [labelBefore]);
  const readback = await f.dispatch('component.list', { uuid: 'label-node' });
  assert.deepEqual(readback.components.map(comp => comp.uuid), ['label-component']);
});

test('an exact component UUID on another node cannot bypass owning-node validation', async () => {
  const f = editorFixture();
  f.node('panel-node').dump.__comps__.push(component('cc.Label', 'foreign-label-component'));
  const labelBefore = copy(f.node('label-node').dump.__comps__);
  const panelBefore = copy(f.node('panel-node').dump.__comps__);
  await rejectsWithoutWriting(f, 'component.remove', { uuid: 'label-node', componentUuid: 'foreign-label-component' }, 'COMPONENT_NOT_FOUND');
  assert.deepEqual(f.node('label-node').dump.__comps__, labelBefore);
  assert.deepEqual(f.node('panel-node').dump.__comps__, panelBefore);
});

test('missing or foreign nodes and components cannot be mutated', async t => {
  const cases = [
    ['node.remove', { uuid: 'absent' }, 'NODE_NOT_FOUND'],
    ['component.remove', { uuid: 'label-node', componentUuid: 'foreign-component' }, 'COMPONENT_NOT_FOUND'],
    ['property.set', { uuid: 'label-node', componentUuid: 'foreign-component', path: 'string', value: '' }, 'COMPONENT_NOT_FOUND'],
    ['node.create', { name: 'New', parent: 'absent' }, 'NODE_NOT_FOUND'],
    ['node.reparent', { uuid: 'label-node', parent: 'absent' }, 'NODE_NOT_FOUND'],
  ];
  for (const [command, args, expected] of cases) await t.test(command, () => rejectsWithoutWriting(editorFixture(), command, args, expected));
});

test('scene roots and ancestor/descendant cycles are protected before native mutations', async t => {
  for (const [command, args] of [
    ['node.remove', { uuid: 'scene-root' }], ['node.reparent', { uuid: 'scene-root', parent: 'panel-node' }],
    ['node.reparent', { uuid: 'panel-node', parent: 'panel-node' }], ['node.reparent', { uuid: 'panel-node', parent: 'label-node' }],
  ]) await t.test(JSON.stringify(args), () => rejectsWithoutWriting(editorFixture(), command, args, 'INVALID_ARGUMENT'));
});

test('unready scenes block every scene/node/component mutation at the native boundary', async t => {
  const cases = [
    ['scene.save', {}], ['scene.undo', {}], ['scene.redo', {}], ['node.create', { name: 'New' }],
    ['node.remove', { uuid: 'label-node' }], ['node.reparent', { uuid: 'label-node', parent: 'scene-root' }],
    ['node.duplicate', { uuid: 'label-node' }], ['component.add', { uuid: 'label-node', component: 'cc.Sprite' }],
    ['component.remove', { uuid: 'label-node', component: 'cc.Label' }], ['property.set', { uuid: 'label-node', path: 'active', value: false }],
    ['prefab.create', { uuid: 'label-node', url: 'db://assets/New.prefab' }], ['prefab.instantiate', { asset: 'prefab-asset' }],
    ['ui.build', { tree: [{ name: 'New' }] }],
  ];
  for (const [command, args] of cases) await t.test(command, async () => {
    const f = editorFixture(); f.state.ready = false;
    await rejectsWithoutWriting(f, command, args, 'SCENE_NOT_READY');
  });
});

test('unready asset databases block writes and asset-driven scene operations', async t => {
  const cases = [
    ['asset.create', { url: 'db://assets/new.txt', content: 'text' }], ['asset.save', { asset: 'text-asset', content: '' }],
    ['asset.delete', { asset: 'text-asset' }], ['asset.move', { asset: 'text-asset', url: 'db://assets/moved.txt' }],
    ['asset.copy', { asset: 'text-asset', url: 'db://assets/copied.txt' }], ['asset.import', { source: __filename, url: 'db://assets/imported.txt' }],
    ['asset.meta', { asset: 'text-asset', userData: { retained: true } }],
    ['scene.open', { asset: 'scene-asset' }], ['scene.create', { url: 'db://assets/New.scene' }],
    ['prefab.create', { uuid: 'label-node', url: 'db://assets/New.prefab' }], ['prefab.instantiate', { asset: 'prefab-asset' }],
  ];
  for (const [command, args] of cases) await t.test(command, async () => {
    const f = editorFixture(); f.state.assetReady = false;
    await rejectsWithoutWriting(f, command, args, 'ASSET_DB_NOT_READY');
  });
});

test('wrong or missing assets and unsaved scenes cannot trigger scene opening or prefab instantiation', async t => {
  const cases = [
    ['scene.open', { asset: 'missing' }, null, 'ASSET_NOT_FOUND'],
    ['scene.open', { asset: 'text-asset' }, null, 'INVALID_ASSET_TYPE'],
    ['scene.open', { asset: 'text-asset' }, f => { f.asset('text-asset').url = 'db://assets/not-a-scene.scene'; }, 'INVALID_ASSET_TYPE'],
    ['prefab.instantiate', { asset: 'text-asset' }, null, 'INVALID_ASSET_TYPE'],
    ['prefab.instantiate', { asset: 'text-asset' }, f => { f.asset('text-asset').url = 'db://assets/not-a-prefab.prefab'; }, 'INVALID_ASSET_TYPE'],
    ['scene.open', { asset: 'scene-asset' }, f => { f.state.dirty = true; }, 'UNSAVED_CHANGES'],
  ];
  for (const [command, args, prepare, expected] of cases) await t.test(command + ' ' + args.asset + ' ' + expected, async () => {
    const f = editorFixture(); prepare?.(f);
    await rejectsWithoutWriting(f, command, args, expected);
  });
});

test('prefab instantiation accepts the advertised URL selector and reads back the requested instance', async () => {
  const f = editorFixture();
  const result = await f.dispatch('prefab.instantiate', { url: 'db://assets/Panel.prefab', parent: 'panel-node', name: 'URL instance' });
  assert.equal(result.assetUuid, 'prefab-asset');
  assert.equal(result.uuids.length, 1);
  const current = await f.dispatch('node.query', { uuid: result.uuids[0] });
  assert.equal(current.name, 'URL instance');
  assert.equal(current.parentUuid, 'panel-node');
});

test('scene opening reads back the requested ready scene identity', async () => {
  const f = editorFixture();
  const result = await f.dispatch('scene.open', { asset: 'scene-asset' });
  assert.equal(result.asset.uuid, 'scene-asset');
  assert.equal(result.scene.ready, true);
  const roots = Array.isArray(result.scene.tree) ? result.scene.tree : [result.scene.tree];
  assert.ok(roots.some(current => current.uuid === 'scene-asset'));
});

test('failed imports are rejected before any existing invalid asset is saved or instantiated', async t => {
  for (const [command, args, uuid] of [
    ['asset.save', { asset: 'text-asset', content: '' }, 'text-asset'],
    ['scene.open', { asset: 'scene-asset' }, 'scene-asset'],
    ['prefab.instantiate', { asset: 'prefab-asset' }, 'prefab-asset'],
  ]) await t.test(command, async () => {
    const f = editorFixture(); f.asset(uuid).invalid = true;
    await rejectsWithoutWriting(f, command, args, 'IMPORT_FAILED');
  });
});

test('asset writes reject traversal and non-project URLs before invoking asset-db writes', async t => {
  for (const url of ['db://internal/default.txt', 'file:///tmp/out.txt', 'db://assets/../outside.txt',
    'db://assets/./file.txt', 'db://assets//file.txt', 'db://assets/folder\\file.txt', 'db://assets/file\0.txt']) {
    await t.test(JSON.stringify(url), () => rejectsWithoutWriting(editorFixture(), 'asset.create', { url, content: 'content' }, 'INVALID_ASSET_URL'));
  }
});

test('empty text assets can be created and saved without losing their contents', async t => {
  await t.test('create empty', async () => {
    const f = editorFixture();
    const result = await f.dispatch('asset.create', { url: 'db://assets/empty.txt', content: '' });
    assert.equal(result.url, 'db://assets/empty.txt');
    assert.equal(f.state.contents.get(result.uuid), '');
    assert.equal(fs.readFileSync(f.asset(result.uuid).file, 'utf8'), '');
  });
  await t.test('save empty', async () => {
    const f = editorFixture();
    const result = await f.dispatch('asset.save', { asset: 'text-asset', content: '' });
    assert.equal(result.uuid, 'text-asset');
    assert.equal(f.state.contents.get('text-asset'), '');
    assert.equal(fs.readFileSync(f.asset('text-asset').file, 'utf8'), '');
  });
});

test('text asset creation and save preserve exact UTF-8 file contents including opaque JSON text', async t => {
  const content = '\u7b2c\u4e00\u884c\r\n{"__proto__":{"polluted":true},"value":false}\n\u{1f30d}\n';
  await t.test('create', async () => {
    const f = editorFixture();
    const result = await f.dispatch('asset.create', { url: 'db://assets/utf8.txt', content });
    assert.equal(result.url, 'db://assets/utf8.txt');
    assert.deepEqual(fs.readFileSync(f.asset(result.uuid).file), Buffer.from(content, 'utf8'));
    assert.equal(Object.prototype.polluted, undefined, 'Opaque text content must remain data.');
  });
  await t.test('save', async () => {
    const f = editorFixture();
    const result = await f.dispatch('asset.save', { asset: 'text-asset', content });
    assert.equal(result.uuid, 'text-asset');
    assert.deepEqual(fs.readFileSync(f.asset(result.uuid).file), Buffer.from(content, 'utf8'));
    assert.equal(Object.prototype.polluted, undefined);
  });
});

test('asset copy/move/delete convert external UUID selectors to native db:// source URLs', async () => {
  const f = editorFixture();
  const copied = await f.dispatch('asset.copy', { asset: 'text-asset', url: 'db://assets/copied.txt' });
  assert.equal(f.nativeCalls('copy-asset').at(-1).args[0], 'db://assets/content.txt');
  assert.equal(copied.url, 'db://assets/copied.txt');
  const moved = await f.dispatch('asset.move', { asset: copied.uuid, url: 'db://assets/moved.txt' });
  assert.equal(f.nativeCalls('move-asset').at(-1).args[0], 'db://assets/copied.txt');
  assert.equal(moved.uuid, copied.uuid);
  assert.equal(moved.url, 'db://assets/moved.txt');
  const deleted = await f.dispatch('asset.delete', { asset: moved.uuid });
  assert.equal(f.nativeCalls('delete-asset').at(-1).args[0], 'db://assets/moved.txt');
  assert.equal(deleted.deleted, moved.uuid);
  assert.equal(f.asset(moved.uuid), undefined);
  assert.equal(f.asset('text-asset').url, 'db://assets/content.txt');
});

test('a native nullish move succeeds when destination identity, source removal and file bytes are verified', async t => {
  for (const acknowledgement of [null, undefined]) await t.test(String(acknowledgement), async () => {
    const f = editorFixture();
    const source = copy(f.asset('text-asset'));
    const content = fs.readFileSync(source.file);
    const destination = 'db://assets/nullish-moved.txt';
    f.state.overrides.set('asset-db:move-asset', (_args, proceed) => { proceed(); return acknowledgement; });
    const result = await f.dispatch('asset.move', { asset: source.uuid, url: destination });
    assert.equal(result.uuid, source.uuid);
    assert.equal(result.url, destination);
    assert.equal(f.asset(source.url), undefined);
    assert.equal(fs.existsSync(source.file), false);
    assert.equal(f.asset(destination).uuid, source.uuid);
    assert.deepEqual(fs.readFileSync(f.asset(destination).file), content);
    assert.equal(f.nativeCalls('move-asset').length, 1);
  });
});

test('a native nullish acknowledgement without an actual asset move cannot report success', async t => {
  for (const acknowledgement of [null, undefined]) await t.test(String(acknowledgement), async () => {
    const f = editorFixture();
    const source = copy(f.asset('text-asset'));
    const content = fs.readFileSync(source.file);
    const destination = 'db://assets/never-moved.txt';
    f.state.overrides.set('asset-db:move-asset', () => acknowledgement);
    await assert.rejects(f.dispatch('asset.move', { asset: source.uuid, url: destination }), error => {
      assert.ok(['ASSET_NOT_FOUND', 'VERIFICATION_FAILED'].includes(error.code), error.stack);
      return true;
    });
    assert.equal(f.asset(source.uuid).url, source.url);
    assert.equal(f.asset(destination), undefined);
    assert.deepEqual(fs.readFileSync(source.file), content);
    assert.equal(f.nativeCalls('move-asset').length, 1, 'An unverified move must not be replayed.');
  });
});

test('an explicit false move acknowledgement is rejected even when the native data changed', async () => {
  const f = editorFixture();
  const destination = 'db://assets/false-moved.txt';
  f.state.overrides.set('asset-db:move-asset', (_args, proceed) => { proceed(); return false; });
  await assert.rejects(f.dispatch('asset.move', { asset: 'text-asset', url: destination }), rejectsCode('EDITOR_REJECTED'));
  assert.equal(f.asset(destination).uuid, 'text-asset');
  assert.equal(f.nativeCalls('move-asset').length, 1);
});

function assetWriteFixture(action) {
  const f = editorFixture();
  const url = action === 'save' ? 'db://assets/content.txt' : 'db://assets/pending-' + action + '.bin';
  const source = path.join(f.editor.Project.path, 'source.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5z8AAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(source, png);
  const args = action === 'create' ? { url, content: 'created content' } : action === 'import' ? { url, source } :
    action === 'save' ? { asset: 'text-asset', content: 'saved content' } : { asset: 'text-asset', url };
  const expectedBytes = action === 'import' ? png : action === 'create' || action === 'save' ? Buffer.from(args.content) :
    fs.readFileSync(f.asset('text-asset').file);
  return { ...f, action, url, args, expectedBytes };
}

test('acknowledged asset create/save/import/move/copy wait for pending import and still verify identity and bytes', async t => {
  for (const action of ['create', 'save', 'import', 'move', 'copy']) await t.test(action, async () => {
    const f = assetWriteFixture(action);
    let acknowledged = false;
    let observations = 0;
    f.state.overrides.set('asset-db:' + action + '-asset', (_args, proceed) => {
      const result = proceed(); acknowledged = true; return result;
    });
    f.state.overrides.set('asset-db:query-asset-info', (_args, proceed) => {
      const info = proceed();
      if (acknowledged && info?.url === f.url) {
        observations++;
        info.imported = observations >= 3;
        info.invalid = false;
      }
      return info;
    });
    const result = await f.dispatch('asset.' + action, f.args);
    assert.equal(result.url, f.url);
    assert.equal(result.imported, true);
    assert.equal(observations, 3, 'Pending readback must precede the confirmed successful import.');
    assert.deepEqual(fs.readFileSync(result.file), f.expectedBytes);
    if (['save', 'move'].includes(action)) assert.equal(result.uuid, 'text-asset');
    if (action === 'move') assert.equal(f.asset('db://assets/content.txt'), undefined);
    if (action === 'copy') assert.equal(f.asset('text-asset').url, 'db://assets/content.txt');
    assert.equal(f.nativeCalls(action + '-asset').length, 1);
    assert.equal(f.writes().length, 1, 'Only read-only queries may repeat.');
  });
});

test('acknowledged asset writes still fail immediately on an invalid pending import', async t => {
  for (const action of ['create', 'save', 'import', 'move', 'copy']) await t.test(action, async () => {
    const f = assetWriteFixture(action);
    let acknowledged = false;
    let observations = 0;
    f.state.overrides.set('asset-db:' + action + '-asset', (_args, proceed) => {
      const result = proceed(); acknowledged = true; return result;
    });
    f.state.overrides.set('asset-db:query-asset-info', (_args, proceed) => {
      const info = proceed();
      if (!acknowledged || info?.url !== f.url) return info;
      observations++;
      return { ...info, imported: false, invalid: true };
    });
    await assert.rejects(f.dispatch('asset.' + action, f.args), rejectsCode('IMPORT_FAILED', error => {
      assert.equal(error.details.partial, true);
      assert.equal(error.details.url, f.url);
      assert.equal(error.details.uuid, f.asset(f.url).uuid);
    }));
    assert.equal(observations, 1, 'An invalid import is terminal, even when imported:false.');
    assert.equal(f.writes().length, 1);
  });
});

test('acknowledged asset import timeout retains destination identity and never replays the import', { timeout: 15000 }, async () => {
  const f = assetWriteFixture('import');
  let observations = 0;
  f.state.overrides.set('asset-db:query-asset-info', (_args, proceed) => {
    const info = proceed();
    if (info?.url !== f.url) return info;
    observations++;
    return { ...info, imported: false, invalid: false };
  });
  await assert.rejects(f.dispatch('asset.import', f.args), rejectsCode('VERIFICATION_FAILED', error => {
    assert.equal(error.details.partial, true);
    assert.equal(error.details.url, f.url);
    assert.equal(error.details.uuid, f.asset(f.url).uuid);
    assert.match(error.message, /did not finish importing/);
  }));
  assert(observations > 1);
  assert.deepEqual(fs.readFileSync(f.asset(f.url).file), f.expectedBytes);
  assert.equal(f.nativeCalls('import-asset').length, 1);
  assert.equal(f.writes().length, 1);
});

test('pending asset imports cannot hide a foreign destination or skip file hash verification', async t => {
  await t.test('foreign URL', async () => {
    const f = assetWriteFixture('import');
    let observations = 0;
    f.state.overrides.set('asset-db:query-asset-info', (_args, proceed) => {
      const info = proceed();
      if (info?.url !== f.url) return info;
      observations++;
      return { ...info, url: 'db://assets/foreign.bin', imported: false };
    });
    await assert.rejects(f.dispatch('asset.import', f.args), rejectsCode('VERIFICATION_FAILED'));
    assert.equal(observations, 1, 'A wrong destination must fail before waiting on its import state.');
    assert.equal(f.writes().length, 1);
  });
  await t.test('corrupt imported bytes', async () => {
    const f = assetWriteFixture('import');
    let observations = 0;
    f.state.overrides.set('asset-db:import-asset', (_args, proceed) => {
      const result = proceed(); fs.writeFileSync(f.asset(result.uuid).file, 'corrupt PNG'); return result;
    });
    f.state.overrides.set('asset-db:query-asset-info', (_args, proceed) => {
      const info = proceed();
      if (info?.url !== f.url) return info;
      observations++;
      return { ...info, imported: observations > 1 };
    });
    await assert.rejects(f.dispatch('asset.import', f.args), rejectsCode('VERIFICATION_FAILED'));
    assert.equal(observations, 2);
    assert.equal(f.writes().length, 1);
  });
});

test('rejected asset acknowledgements cannot enter post-write pending polling', async t => {
  for (const action of ['create', 'save', 'import', 'move', 'copy']) {
    for (const acknowledgement of action === 'move' ? [false] : [false, null, undefined]) {
      await t.test(action + ' ' + String(acknowledgement), async () => {
        const f = assetWriteFixture(action);
        f.state.overrides.set('asset-db:' + action + '-asset', () => acknowledgement);
        await assert.rejects(f.dispatch('asset.' + action, f.args), rejectsCode('EDITOR_REJECTED'));
        const writeIndex = f.state.calls.findIndex(call => call.message === action + '-asset');
        assert(writeIndex >= 0);
        assert.deepEqual(f.state.calls.slice(writeIndex + 1), [], 'Rejected writes must fail before any verification polling.');
        assert.equal(f.writes().length, 1);
      });
    }
  }
});

test('asset.meta preserves native identity and waits for a usable SpriteFrame after nullish reimport', async t => {
  for (const [acknowledgement, selector] of [[null, 'image-asset'], [undefined, 'db://assets/imported.png']]) {
    await t.test(String(acknowledgement) + ' acknowledgement with ' + selector, async () => {
      const f = imageMetadataFixture();
      const original = copy(f.state.assetMetadata.get('image-asset'));
      const imageBytes = fs.readFileSync(f.asset('image-asset').file);
      const observations = [];
      f.state.overrides.set('asset-db:query-asset-info', (_args, proceed) => {
        const info = proceed();
        if (f.nativeCalls('reimport-asset').length) observations.push(copy(info));
        return info;
      });
      f.state.overrides.set('asset-db:reimport-asset', (_args, proceed) => { proceed(); return acknowledgement; });
      const result = await f.dispatch('asset.meta', { asset: selector, userData: { type: 'sprite-frame' } });
      assert.equal(result.verified, true);
      assert.equal(result.asset.uuid, 'image-asset');
      assert.equal(result.asset.importer, original.importer);
      assert.equal(result.meta.uuid, original.uuid);
      assert.equal(result.meta.importer, original.importer);
      assert.deepEqual(result.meta.userData, { ...original.userData, type: 'sprite-frame' });
      const saved = f.nativeCalls('save-asset-meta');
      assert.equal(saved.length, 1);
      assert.equal(saved[0].args[0], 'db://assets/imported.png', 'Native metadata save requires the asset URL.');
      assert.deepEqual(JSON.parse(saved[0].args[1]), { ...original, userData: { ...original.userData, type: 'sprite-frame' } });
      assert.equal(f.nativeCalls('reimport-asset').length, 1);
      assert.equal(f.nativeCalls('reimport-asset')[0].args[0], original.uuid);
      assert.equal(observations[0].imported, false, 'A pending parent import must be polled instead of treated as a failed import.');
      assert.equal(result.asset.imported, true);
      assert(observations.some(info => info.imported && Object.values(info.subAssets || {}).some(item => item.type === 'cc.SpriteFrame' && !item.imported)),
        'A ready parent alone does not prove that the requested subasset is usable.');
      const frames = Object.values(result.asset.subAssets || {}).filter(info => info.type === 'cc.SpriteFrame');
      assert.equal(frames.length, 1);
      assert.equal(frames[0].imported, true, 'A listed but pending subasset is not ready.');
      assert.equal(frames[0].invalid, false, 'An invalid subasset must not be reported as usable.');
      assert.deepEqual(fs.readFileSync(f.asset('image-asset').file), imageBytes, 'Editing importer metadata must preserve the source PNG bytes.');
    });
  }
});

test('asset.meta still rejects an initially pending or invalid asset before writing', async t => {
  for (const flags of [{ imported: false }, { invalid: true }]) await t.test(inspect(flags), async () => {
    const f = imageMetadataFixture();
    Object.assign(f.asset('image-asset'), flags);
    await rejectsWithoutWriting(f, 'asset.meta', { asset: 'image-asset', userData: { type: 'sprite-frame' } }, 'IMPORT_FAILED');
  });
});

test('asset.meta invalid parent imports fail immediately after reimport, including imported:false', async t => {
  for (const imported of [false, true]) await t.test('imported:' + imported, async () => {
    const f = imageMetadataFixture();
    let observations = 0;
    f.state.overrides.set('asset-db:query-asset-info', (_args, proceed) => {
      const info = proceed();
      if (!f.nativeCalls('reimport-asset').length) return info;
      observations++;
      return { ...info, imported, invalid: true };
    });
    await assert.rejects(f.dispatch('asset.meta', { asset: 'image-asset', userData: { type: 'sprite-frame' } }), rejectsCode('IMPORT_FAILED', error => {
      assert.equal(error.details.partial, true);
      assert.equal(error.details.uuid, 'image-asset');
      assert.equal(error.details.meta.userData.type, 'sprite-frame');
    }));
    assert.equal(observations, 1, 'A terminal invalid response must not be treated as pending or retried.');
    assert.equal(f.nativeCalls('save-asset-meta').length, 1);
    assert.equal(f.nativeCalls('reimport-asset').length, 1);
    assert.equal(JSON.parse(fs.readFileSync(f.asset('image-asset').file + '.meta', 'utf8')).userData.type, 'sprite-frame');
  });
});

test('asset.meta bounds pending-parent polling and reports saved metadata without replaying writes', { timeout: 15000 }, async () => {
  const f = imageMetadataFixture();
  const imageBytes = fs.readFileSync(f.asset('image-asset').file);
  let observations = 0;
  f.state.overrides.set('asset-db:query-asset-info', (_args, proceed) => {
    const info = proceed();
    if (!f.nativeCalls('reimport-asset').length) return info;
    observations++;
    // Even a previously usable matching subasset cannot make a pending parent
    // successful. No later read ever confirms this parent finished importing.
    return { ...info, imported: false, invalid: false };
  });
  await assert.rejects(f.dispatch('asset.meta', { asset: 'image-asset', userData: { type: 'sprite-frame' } }), rejectsCode('VERIFICATION_FAILED', error => {
    assert.match(error.message, /did not finish importing/);
    assert.equal(error.details.partial, true);
    assert.equal(error.details.uuid, 'image-asset');
    assert.equal(error.details.meta.uuid, 'image-asset');
    assert.equal(error.details.meta.userData.type, 'sprite-frame');
  }));
  assert(observations > 1, 'Pending imports are checked again using read-only queries.');
  assert.equal(f.nativeCalls('save-asset-meta').length, 1);
  assert.equal(f.nativeCalls('reimport-asset').length, 1);
  assert.equal(f.writes().length, 2, 'Polling must not replay or add native writes.');
  assert.equal(JSON.parse(fs.readFileSync(f.asset('image-asset').file + '.meta', 'utf8')).userData.type, 'sprite-frame');
  assert.deepEqual(fs.readFileSync(f.asset('image-asset').file), imageBytes);
});

test('asset.meta rejects malformed userData and missing assets before any native mutation', async t => {
  for (const args of [{ asset: 'image-asset' }, { asset: 'image-asset', userData: null },
    { asset: 'image-asset', userData: [] }, { asset: 'image-asset', userData: 'sprite-frame' }]) {
    await t.test(inspect(args), () => rejectsWithoutWriting(imageMetadataFixture(), 'asset.meta', args, 'INVALID_ARGUMENT'));
  }
  await t.test('missing asset', () => rejectsWithoutWriting(imageMetadataFixture(), 'asset.meta',
    { asset: 'missing-image', userData: { type: 'sprite-frame' } }, 'ASSET_NOT_FOUND'));
});

test('asset.meta rejects a foreign native metadata UUID before saving or reimporting', async () => {
  const f = imageMetadataFixture();
  f.state.assetMetadata.get('image-asset').uuid = 'foreign-asset';
  await rejectsWithoutWriting(f, 'asset.meta', { asset: 'image-asset', userData: { type: 'sprite-frame' } }, 'VERIFICATION_FAILED');
});

test('asset.meta does not reimport after the native metadata save is explicitly rejected', async () => {
  const f = imageMetadataFixture();
  const original = copy(f.state.assetMetadata.get('image-asset'));
  f.state.overrides.set('asset-db:save-asset-meta', () => false);
  await assert.rejects(f.dispatch('asset.meta', { asset: 'image-asset', userData: { type: 'sprite-frame' } }), rejectsCode('EDITOR_REJECTED'));
  assert.deepEqual(f.state.assetMetadata.get('image-asset'), original);
  assert.equal(f.nativeCalls('save-asset-meta').length, 1);
  assert.equal(f.nativeCalls('reimport-asset').length, 0);
});

test('asset.meta reports partial changes when metadata was saved but reimport returns false', async () => {
  const f = imageMetadataFixture();
  f.state.overrides.set('asset-db:reimport-asset', () => false);
  await assert.rejects(f.dispatch('asset.meta', { asset: 'image-asset', userData: { type: 'sprite-frame' } }), rejectsCode('IMPORT_FAILED', error => {
    assert.equal(error.details.partial, true);
    assert.equal(error.details.uuid, 'image-asset');
  }));
  assert.equal(f.state.assetMetadata.get('image-asset').userData.type, 'sprite-frame');
  assert.equal(f.nativeCalls('save-asset-meta').length, 1);
  assert.equal(f.nativeCalls('reimport-asset').length, 1);
});

test('asset.meta cannot use an old AssetInfo acknowledgement as proof that metadata was saved', async () => {
  const f = imageMetadataFixture();
  f.state.overrides.set('asset-db:save-asset-meta', () => copy(f.asset('image-asset')));
  await assert.rejects(f.dispatch('asset.meta', { asset: 'image-asset', userData: { type: 'sprite-frame' } }), rejectsCode('VERIFICATION_FAILED'));
  assert.equal(f.state.assetMetadata.get('image-asset').userData.type, 'texture');
  assert.equal(f.nativeCalls('save-asset-meta').length, 1);
});

test('asset.meta detects metadata identity changes during reimport', async () => {
  const f = imageMetadataFixture();
  f.state.overrides.set('asset-db:reimport-asset', (_args, proceed) => {
    const result = proceed(); f.state.assetMetadata.get('image-asset').uuid = 'foreign-asset'; return result;
  });
  await assert.rejects(f.dispatch('asset.meta', { asset: 'image-asset', userData: { type: 'sprite-frame' } }), rejectsCode('VERIFICATION_FAILED'));
  assert.equal(f.nativeCalls('save-asset-meta').length, 1);
  assert.equal(f.nativeCalls('reimport-asset').length, 1);
});

test('asset metadata acknowledgement cannot substitute for actual file readback', async t => {
  await t.test('save returns existing metadata without writing the file', async () => {
    const f = editorFixture();
    f.state.overrides.set('asset-db:save-asset', ([selector]) => ({ uuid: f.asset(selector).uuid }));
    await assert.rejects(f.dispatch('asset.save', { asset: 'text-asset', content: 'new content' }), rejectsCode('VERIFICATION_FAILED'));
    assert.equal(fs.readFileSync(f.asset('text-asset').file, 'utf8'), 'original');
    assert.equal(f.nativeCalls('save-asset').length, 1, 'A write whose readback failed must not be replayed.');
  });
  await t.test('create returns valid metadata but incorrect file content', async () => {
    const f = editorFixture();
    f.state.overrides.set('asset-db:create-asset', (_args, proceed) => {
      const result = proceed(); fs.writeFileSync(f.asset(result.uuid).file, 'different bytes', 'utf8'); return result;
    });
    await assert.rejects(f.dispatch('asset.create', { url: 'db://assets/corrupt.txt', content: 'requested bytes' }), rejectsCode('VERIFICATION_FAILED'));
    assert.equal(f.nativeCalls('create-asset').length, 1);
  });
  await t.test('create returns metadata while the output file is missing', async () => {
    const f = editorFixture();
    f.state.overrides.set('asset-db:create-asset', (_args, proceed) => {
      const result = proceed(); fs.unlinkSync(f.asset(result.uuid).file); return result;
    });
    await assert.rejects(f.dispatch('asset.create', { url: 'db://assets/missing-file.txt', content: 'requested bytes' }), rejectsCode('VERIFICATION_FAILED'));
  });
  await t.test('native false remains a failure even if file content changed', async () => {
    const f = editorFixture();
    f.state.overrides.set('asset-db:save-asset', (_args, proceed) => { proceed(); return false; });
    await assert.rejects(f.dispatch('asset.save', { asset: 'text-asset', content: 'partially applied' }), rejectsCode('EDITOR_REJECTED'));
    assert.equal(fs.readFileSync(f.asset('text-asset').file, 'utf8'), 'partially applied');
    assert.equal(f.nativeCalls('save-asset').length, 1);
  });
});

test('unsafe property paths are rejected without native mutation or prototype pollution', async t => {
  const paths = ['__proto__.polluted', 'constructor.prototype.polluted', 'position.__proto__.x', 'position.constructor.prototype.x',
    '__comps__[0].__proto__.polluted', 'position..x', '.active', 'active.', 'position[-1]', 'position[999999999999999999999]', 'position.missing'];
  for (const propertyPath of paths) await t.test(propertyPath, async () => {
    const f = editorFixture();
    await assert.rejects(f.dispatch('property.set', { uuid: 'label-node', path: propertyPath, value: 0 }), error => ['INVALID_ARGUMENT', 'PROPERTY_NOT_FOUND'].includes(error.code));
    assert.deepEqual(f.writes(), []);
    assert.equal(Object.prototype.polluted, undefined);
    assert.deepEqual(f.node('label-node').dump.position.value, { x: 12, y: 34, z: 56 });
  });
});

test('read-only properties and values outside live dump types/bounds are rejected before native writes', async t => {
  const cases = [
    [{ path: 'uuid', value: 'replacement' }, 'READ_ONLY_PROPERTY'],
    [{ path: 'active', value: 0 }, 'INVALID_ARGUMENT'], [{ path: 'name', value: false }, 'INVALID_ARGUMENT'],
    [{ path: 'layer', value: Infinity }, 'INVALID_ARGUMENT'], [{ path: 'position.x', value: 'not a coordinate' }, 'INVALID_ARGUMENT'],
    [{ path: 'position.x', value: Infinity }, 'INVALID_ARGUMENT'], [{ path: 'position.x', value: null }, 'INVALID_ARGUMENT'],
    [{ path: 'position', value: { y: 'not a coordinate' } }, 'INVALID_ARGUMENT'],
    ...[null, false, 0, 'not a vector', [], { x: { value: 1 } }].map(value => [{ path: 'position', value }, 'INVALID_ARGUMENT']),
    ...[false, [], {}].map(value => [{ path: 'position.x', value }, 'INVALID_ARGUMENT']),
    [{ componentUuid: 'opacity-component', path: 'opacity', value: -1 }, 'INVALID_ARGUMENT'],
    [{ componentUuid: 'opacity-component', path: 'opacity', value: 256 }, 'INVALID_ARGUMENT'],
  ];
  for (const [args, expected] of cases) await t.test(inspect(args, { breakLength: Infinity }), () => rejectsWithoutWriting(editorFixture(), 'property.set', { uuid: 'label-node', ...args }, expected));
});

test('prototype-bearing JSON values are rejected recursively before reaching native property writes', async t => {
  const payloads = [
    '{"__proto__":{"polluted":true}}',
    '{"theme":"changed","nested":{"__proto__":{"polluted":true}}}',
    '{"theme":"changed","rules":[{"constructor":{"prototype":{"polluted":true}}}]}',
    '{"theme":"changed","rules":[{"prototype":{"polluted":true}}]}',
  ];
  for (const source of payloads) await t.test(source, async () => {
    const f = editorFixture();
    const settings = component('contract.Settings', 'settings-component');
    f.node('label-node').dump.__comps__.push(settings);
    const original = copy(settings.value.config.value);
    await rejectsWithoutWriting(f, 'property.set', { uuid: 'label-node', componentUuid: 'settings-component', path: 'config', value: JSON.parse(source) }, 'INVALID_ARGUMENT');
    assert.deepEqual(settings.value.config.value, original);
    assert.equal(Object.prototype.polluted, undefined);
  });
  await t.test('ordinary nested JSON remains editable', async () => {
    const f = editorFixture();
    f.node('label-node').dump.__comps__.push(component('contract.Settings', 'settings-component'));
    const value = { theme: 'changed', rules: [{ label: 'still data' }] };
    const result = await f.dispatch('property.set', { uuid: 'label-node', componentUuid: 'settings-component', path: 'config', value });
    assert.equal(result.verified, true);
    assert.deepEqual(result.value, value);
  });
});

test('out-of-range array entries and array internals are not editable properties', async t => {
  for (const propertyPath of ['materials[1]', 'materials[-1]', 'materials.length']) await t.test(propertyPath, async () => {
    const f = editorFixture(); f.node('label-node').dump.__comps__.push(component('cc.MeshRenderer', 'mesh-component'));
    await assert.rejects(f.dispatch('property.set', { uuid: 'label-node', componentUuid: 'mesh-component', path: propertyPath, value: 0 }), error => ['INVALID_ARGUMENT', 'PROPERTY_NOT_FOUND'].includes(error.code));
    assert.deepEqual(f.writes(), []);
  });
});

test('array writes preserve native element dumps and validate nested node references before dispatch', async () => {
  const f = editorFixture();
  const events = prop('cc.ClickEvent', [], {isArray:true,elementTypeData:prop('cc.ClickEvent', {
    target:prop('cc.Node',{uuid:''}),component:prop('String',''),handler:prop('String',''),customEventData:prop('String',''),
  })});
  f.node('label-node').dump.__comps__[0].value.clickEvents=events;
  const value=[{target:{uuid:'panel-node'},component:'contract.Listener',handler:'clicked',customEventData:'payload'}];
  const result=await f.dispatch('property.set',{uuid:'label-node',componentUuid:'label-component',path:'clickEvents',value});
  assert.deepEqual(result.value,value);
  const native=f.node('label-node').dump.__comps__[0].value.clickEvents;
  assert.equal(native.value[0].type,'cc.ClickEvent');
  assert.equal(native.value[0].value.target.type,'cc.Node');
  assert.equal(native.value[0].value.handler.value,'clicked');
  const writes=f.writes().length;
  await assert.rejects(f.dispatch('property.set',{uuid:'label-node',componentUuid:'label-component',path:'clickEvents',value:[{target:{uuid:'missing-node'}}]}),{code:'NODE_NOT_FOUND'});
  assert.equal(f.writes().length,writes);
  await f.dispatch('property.set',{uuid:'label-node',componentUuid:'label-component',path:'clickEvents[0].target',value:null});
  assert.deepEqual(f.node('label-node').dump.__comps__[0].value.clickEvents.value[0].value.target.value,{uuid:''});
});

test('plain object fields called value are retained when querying and editing structured properties', async () => {
  const f=editorFixture();
  f.node('label-node').dump.__comps__[0].value.config=prop('Object',{value:'before',label:'retained'});
  const result=await f.dispatch('property.set',{uuid:'label-node',componentUuid:'label-component',path:'config',value:{value:'after'}});
  assert.deepEqual(result.value,{value:'after',label:'retained'});
  const queried=await f.dispatch('node.query',{uuid:'label-node'});
  assert.deepEqual(queried.components[0].properties.config,{value:'after',label:'retained'});
});

test('native false results never become successful scene/history/property/asset operations', async t => {
  const cases = [
    ['scene.open', { asset: 'scene-asset' }, 'scene:open-scene'], ['scene.save', {}, 'scene:save-scene'],
    ['scene.undo', {}, 'scene:undo'], ['scene.redo', {}, 'scene:redo'],
    ['node.create', { name: 'New' }, 'scene:create-node'],
    ['component.add', { uuid: 'label-node', component: 'cc.Sprite' }, 'scene:create-component'],
    ['property.set', { uuid: 'label-node', path: 'active', value: false }, 'scene:set-property'],
    ['prefab.create', { uuid: 'label-node', url: 'db://assets/New.prefab' }, 'scene:create-prefab'],
    ['asset.create', { url: 'db://assets/New.txt', content: 'text' }, 'asset-db:create-asset'],
  ];
  for (const [command, args, nativeName] of cases) await t.test(command, async () => {
    const f = editorFixture(); f.state.overrides.set(nativeName, () => false);
    await assert.rejects(f.dispatch(command, args), rejectsCode('EDITOR_REJECTED'));
    assert.equal(f.nativeCalls(nativeName.split(':')[1]).length, 1);
  });
});

test('native exceptions retain their error code and are never retried or replaced by fallback success', async t => {
  for (const specific of [true, false]) await t.test(specific ? 'Editor error code' : 'uncoded exception', async () => {
    const f = editorFixture();
    f.state.overrides.set('scene:set-property', () => {
      const error = new Error('Native write failed');
      if (specific) { error.code = 'EDITOR_BUSY'; error.details = { scene: 'scene-root' }; }
      throw error;
    });
    await assert.rejects(f.dispatch('property.set', { uuid: 'label-node', path: 'active', value: false }), rejectsCode(specific ? 'EDITOR_BUSY' : 'EDITOR_ERROR', error => {
      assert.equal(error.message, 'Native write failed');
      if (specific) assert.deepEqual(error.details, { scene: 'scene-root' });
    }));
    assert.equal(f.nativeCalls('set-property').length, 1);
    assert.equal(f.node('label-node').dump.active.value, true);
  });
});

test('node and component writes cannot claim success when native readback does not show the change', async t => {
  const cases = [
    ['node.create', { name: 'New' }, 'scene:create-node', ['never-created'], 'NODE_NOT_FOUND'],
    ['node.remove', { uuid: 'label-node' }, 'scene:remove-node', undefined, 'VERIFICATION_FAILED'],
    ['node.reparent', { uuid: 'label-node', parent: 'scene-root' }, 'scene:set-parent', undefined, 'VERIFICATION_FAILED'],
    ['component.add', { uuid: 'label-node', component: 'cc.Sprite' }, 'scene:create-component', undefined, 'VERIFICATION_FAILED'],
    ['component.remove', { uuid: 'label-node', component: 'cc.Label' }, 'scene:remove-component', undefined, 'VERIFICATION_FAILED'],
  ];
  for (const [command, args, nativeName, result, expected] of cases) await t.test(command, async () => {
    const f = editorFixture(); f.state.overrides.set(nativeName, () => result);
    await assert.rejects(f.dispatch(command, args), rejectsCode(expected));
    assert.equal(f.nativeCalls(nativeName.split(':')[1]).length, 1);
  });
});

test('UI build produces native nodes and verifies their false/zero/empty properties', async () => {
  const f = editorFixture();
  const result = await f.dispatch('ui.build', { parent: 'panel-node', tree: [{ name: 'Container', properties: { active: false }, children: [
    { name: 'Title', components: [{ type: 'cc.Label', properties: { string: '', fontSize: 0 } }] },
  ] }] });
  assert.equal(result.atomic, false);
  assert.equal(result.created.length, 2);
  const parent = await f.dispatch('node.query', { uuid: result.created[0].uuid });
  const child = await f.dispatch('node.query', { uuid: result.created[1].uuid });
  assert.equal(parent.parentUuid, 'panel-node');
  assert.equal(parent.active, false);
  assert.equal(child.parentUuid, parent.uuid);
  assert.equal(child.components.find(comp => comp.type === 'cc.Label').properties.string, '');
  assert.equal(child.components.find(comp => comp.type === 'cc.Label').properties.fontSize, 0);
});

test('UI partial failures report the created nodes, preserve the cause, and stop further writes', async t => {
  await t.test('second node native creation fails', async () => {
    const f = editorFixture();
    let count = 0;
    f.state.overrides.set('scene:create-node', (_args, proceed) => {
      if (++count === 2) { const error = new Error('Editor busy'); error.code = 'EDITOR_BUSY'; error.details = { phase: 'create' }; throw error; }
      return proceed();
    });
    await assert.rejects(f.dispatch('ui.build', { tree: [{ name: 'First' }, { name: 'Second' }, { name: 'Never' }] }), rejectsCode('EDITOR_BUSY', error => {
      assert.equal(error.details.partial, true);
      assert.deepEqual(error.details.created, [{ uuid: 'created-node-1', name: 'First' }]);
      assert.deepEqual(error.details.cause, { phase: 'create' });
    }));
    assert.equal(f.nativeCalls('create-node').length, 2);
    assert.ok(f.node('created-node-1'));
    assert.equal(f.node('created-node-2'), undefined);
  });
  await t.test('first node property rejected', async () => {
    const f = editorFixture(); f.state.overrides.set('scene:set-property', () => false);
    await assert.rejects(f.dispatch('ui.build', { tree: [{ name: 'First', properties: { active: false } }, { name: 'Never' }] }), rejectsCode('EDITOR_REJECTED', error => {
      assert.equal(error.details.partial, true);
      assert.deepEqual(error.details.created, [{ uuid: 'created-node-1', name: 'First' }]);
    }));
    assert.equal(f.nativeCalls('create-node').length, 1);
  });
  await t.test('node exists but its first readback fails', async () => {
    const f = editorFixture();
    f.state.overrides.set('scene:query-node', ([uuid], proceed) => {
      if (uuid === 'created-node-1') { const error = new Error('Scene process disconnected'); error.code = 'SCENE_DISCONNECTED'; throw error; }
      return proceed();
    });
    await assert.rejects(f.dispatch('ui.build', { tree: [{ name: 'Created' }, { name: 'Never' }] }), rejectsCode('SCENE_DISCONNECTED', error => {
      assert.equal(error.details.partial, true);
      assert.deepEqual(error.details.created, [{ uuid: 'created-node-1', name: 'Created' }], 'A created native UUID must be recoverable even when verification fails.');
    }));
    assert.ok(f.node('created-node-1'));
    assert.equal(f.nativeCalls('create-node').length, 1);
  });
});

test('UI structural limits and malicious paths are validated across the complete tree before creating nodes', async t => {
  let deep = { name: 'Leaf' };
  for (let i = 0; i < 22; i++) deep = { name: 'Level ' + i, children: [deep] };
  const unsafe = JSON.parse('{"__proto__.polluted":true}');
  const unsafeValue = JSON.parse('{"theme":"changed","rules":[{"__proto__":{"polluted":true}}]}');
  const cases = [
    ['empty tree', { tree: [] }],
    ['node count over limit', { tree: Array.from({ length: 501 }, (_, i) => ({ name: 'Node ' + i })) }],
    ['depth over limit', { tree: [deep] }],
    ['unsafe node property in later sibling', { tree: [{ name: 'Valid' }, { name: 'Invalid', properties: unsafe }] }],
    ['unsafe component property in later sibling', { tree: [{ name: 'Valid' }, { name: 'Invalid', components: [{ type: 'cc.Label', properties: unsafe }] }] }],
    ['children must be an array', { tree: [{ name: 'Valid' }, { name: 'Invalid', children: 'not an array' }] }],
    ['components must be an array', { tree: [{ name: 'Valid' }, { name: 'Invalid', components: 'not an array' }] }],
    ['property maps must be objects', { tree: [{ name: 'Valid' }, { name: 'Invalid', properties: [] }] }],
    ['nested prototype JSON in later node value', { tree: [{ name: 'Valid' }, { name: 'Invalid', properties: { position: unsafeValue } }] }],
    ['nested prototype JSON in later component value', { tree: [{ name: 'Valid' }, { name: 'Invalid', components: [{ type: 'contract.Settings', properties: { config: unsafeValue } }] }] }],
  ];
  for (const [name, args] of cases) await t.test(name, () => rejectsWithoutWriting(editorFixture(), 'ui.build', args, 'INVALID_ARGUMENT'));
});

test('asset pagination rejects negative/fractional offsets and invalid limits rather than using JS slice coercion', async t => {
  for (const args of [{ action: 'search', offset: -1 }, { action: 'search', offset: 0.5 },
    { action: 'search', limit: 0 }, { action: 'search', limit: -1 }, { action: 'search', limit: 1.5 }]) {
    await t.test(JSON.stringify(args), () => rejectsWithoutWriting(editorFixture(), 'asset.query', args, 'INVALID_ARGUMENT'));
  }
});

test('unknown commands and prototype member names are rejected without calling Editor', async () => {
  const f = editorFixture();
  for (const command of ['scene.execute', 'editor.eval', '__proto__', 'constructor']) {
    await assert.rejects(f.dispatch(command, {}), rejectsCode('UNSUPPORTED_COMMAND'));
  }
  assert.deepEqual(f.state.calls, []);
});

test('missing, unreadable or malformed native message manifests disable the affected command domain',async t=>{
  for(const mode of ['missing','invalid-json','no-messages','empty-methods'])await t.test(mode,async()=>{
    const f=editorFixture();const file=path.join(f.editor.App.path,'builtin/scene/package.json');
    if(mode==='missing')fs.unlinkSync(file);
    else fs.writeFileSync(file,mode==='invalid-json'?'{invalid':JSON.stringify(mode==='no-messages'?{}:{contributions:{messages:{'create-node':{methods:[]}}}}));
    const adapter=createAdapter(f.editor);
    assert(!adapter.commands().includes('node.create'));
    await assert.rejects(adapter.dispatch('node.create',{name:'Never created'}),{code:'UNSUPPORTED_COMMAND'});
    assert.equal(f.nativeCalls('create-node').length,0);
    assert(adapter.commands().includes('editor.info'));
    assert(adapter.commands().includes('asset.query'));
    adapter.dispose();f.adapter.dispose();
  });
});
