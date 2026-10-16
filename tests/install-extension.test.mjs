import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const run = promisify(execFile);
const installer = new URL('../scripts/install-extension.mjs', import.meta.url);
const shippedPackage = new URL('../extensions/cocos-creator-mcp/package.json', import.meta.url);

async function fixture(t, version = '3.7.3') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'creator install ')));
  t.after(async () => {
    t.mock.restoreAll();
    // root is the exact disposable directory created above, never a project supplied by a user.
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const scripts = path.join(root, 'distribution', 'scripts');
  const source = path.join(root, 'distribution', 'extensions', 'cocos-creator-mcp');
  const project = path.join(root, 'My Game');
  const extensions = path.join(project, 'extensions');
  const destination = path.join(extensions, 'cocos-creator-mcp');
  await fs.mkdir(scripts, { recursive: true });
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(path.join(project, 'assets'), { recursive: true });
  const info = { name: 'My Game', uuid: randomUUID(), creator: { version } };
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify(info));
  await fs.copyFile(shippedPackage, path.join(source, 'package.json'));
  for (const name of ['main.js', 'bridge.js', 'adapter.js', 'scene.js']) {
    await fs.writeFile(path.join(source, name), `// distribution v1: ${name}\n`);
  }
  await fs.mkdir(path.join(source, 'resources'));
  await fs.writeFile(path.join(source, 'resources', 'empty.txt'), '');
  const script = path.join(scripts, 'install-extension.mjs');
  await fs.copyFile(installer, script);
  const { installExtension } = await import(pathToFileURL(script));
  return { root, source, project, extensions, destination, info, script, installExtension };
}

async function snapshot(root) {
  const entries = new Map();
  async function visit(current) {
    for (const name of (await fs.readdir(current)).sort()) {
      const target = path.join(current, name);
      const stat = await fs.lstat(target);
      const relative = path.relative(root, target);
      if (stat.isSymbolicLink()) entries.set(relative, ['link', await fs.readlink(target)]);
      else if (stat.isDirectory()) { entries.set(relative, 'directory'); await visit(target); }
      else entries.set(relative, await fs.readFile(target));
    }
  }
  await visit(root);
  return entries;
}

async function assertNoTemporaryDirectories(f) {
  assert.deepEqual((await fs.readdir(f.extensions)).sort(), ['cocos-creator-mcp']);
}

const code = expected => error => error.code === expected;
const injected = () => Object.assign(new Error('simulated filesystem failure'), { code: 'EIO' });
const directoryLink = (target, link) => fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

test('first install reproduces the distribution and preserves other project files and extensions', async (t) => {
  const f = await fixture(t);
  const beforePackage = await fs.readFile(path.join(f.project, 'package.json'));
  await fs.mkdir(path.join(f.extensions, 'other-extension'), { recursive: true });
  await fs.writeFile(path.join(f.extensions, 'other-extension', 'user.txt'), 'leave me alone');
  await fs.writeFile(path.join(f.project, 'assets', 'scene.scene'), 'scene bytes');
  assert.equal(await f.installExtension(f.project), f.destination);
  assert.deepEqual(await snapshot(f.destination), await snapshot(f.source));
  assert.deepEqual(await fs.readFile(path.join(f.project, 'package.json')), beforePackage);
  assert.equal(await fs.readFile(path.join(f.project, 'assets', 'scene.scene'), 'utf8'), 'scene bytes');
  assert.equal(await fs.readFile(path.join(f.extensions, 'other-extension', 'user.txt'), 'utf8'), 'leave me alone');
  assert.deepEqual((await fs.readdir(f.extensions)).sort(), ['cocos-creator-mcp', 'other-extension']);
});

test('explicit update replaces managed edits, preserves extra files, and is repeatable', async (t) => {
  const f = await fixture(t);
  // An older/manual copy has no installer receipt and is still an authorized update.
  await fs.mkdir(f.extensions);
  await fs.cp(f.source, f.destination, { recursive: true });
  await fs.writeFile(path.join(f.destination, 'main.js'), '// locally edited own bridge');
  await fs.writeFile(path.join(f.destination, 'notes.txt'), 'user notes');
  await fs.mkdir(path.join(f.destination, 'local', 'empty'), { recursive: true });
  await fs.writeFile(path.join(f.destination, 'local', 'settings.json'), '{"port":7000}');
  await fs.writeFile(path.join(f.source, 'main.js'), '// distribution v2');
  await fs.writeFile(path.join(f.source, 'resources', 'new.txt'), 'new resource');
  assert.equal(await f.installExtension(f.project, { update: true }), f.destination);
  const result = await snapshot(f.destination);
  for (const [name, value] of await snapshot(f.source)) assert.deepEqual(result.get(name), value);
  assert.equal(await fs.readFile(path.join(f.destination, 'notes.txt'), 'utf8'), 'user notes');
  assert.equal(await fs.readFile(path.join(f.destination, 'local', 'settings.json'), 'utf8'), '{"port":7000}');
  assert((await fs.stat(path.join(f.destination, 'local', 'empty'))).isDirectory());
  await f.installExtension(f.project, { update: true });
  assert.deepEqual(await snapshot(f.destination), result);
  await assertNoTemporaryDirectories(f);
});

test('an existing own extension requires explicit update and remains byte-for-byte intact', async (t) => {
  const f = await fixture(t);
  await f.installExtension(f.project);
  const before = await snapshot(f.destination);
  await assert.rejects(f.installExtension(f.project), code('EXTENSION_EXISTS'));
  assert.deepEqual(await snapshot(f.destination), before);
  await assertNoTemporaryDirectories(f);
});

test('a name-only manifest, different entry point, missing bridge, and unrelated directory are refused', async (t) => {
  for (const kind of ['name-only', 'other-entry', 'missing-bridge', 'no-manifest', 'empty', 'file']) {
    await t.test(kind, async (subtest) => {
      const f = await fixture(subtest);
      await fs.mkdir(f.extensions);
      if (kind === 'file') await fs.writeFile(f.destination, 'user file');
      else {
        await fs.mkdir(f.destination);
        if (kind !== 'empty') await fs.writeFile(path.join(f.destination, 'user.txt'), 'precious');
        if (kind === 'name-only') await fs.writeFile(path.join(f.destination, 'package.json'), '{"name":"cocos-creator-mcp"}');
        if (kind === 'other-entry' || kind === 'missing-bridge') {
          await fs.cp(f.source, f.destination, { recursive: true });
          if (kind === 'missing-bridge') await fs.unlink(path.join(f.destination, 'bridge.js'));
          else {
            const info = JSON.parse(await fs.readFile(path.join(f.destination, 'package.json'), 'utf8'));
            info.main = './my-extension.js';
            await fs.writeFile(path.join(f.destination, 'package.json'), JSON.stringify(info));
          }
        }
      }
      const before = await snapshot(f.extensions);
      await assert.rejects(f.installExtension(f.project, { update: true }));
      assert.deepEqual(await snapshot(f.extensions), before);
    });
  }
});

test('missing, malformed, and non-3.7 project versions and incomplete identities cannot install', async (t) => {
  const cases = [
    ['missing creator', info => { delete info.creator; }],
    ['missing version', info => { info.creator = {}; }],
    ['3.8', info => { info.creator.version = '3.8.0'; }],
    ['3.6', info => { info.creator.version = '3.6.3'; }],
    ['partial', info => { info.creator.version = '3.7.'; }],
    ['beta', info => { info.creator.version = '3.7.4-beta.1'; }],
    ['trailing text', info => { info.creator.version = '3.7.3 anything'; }],
    ['number', info => { info.creator.version = 3.7; }],
    ['missing UUID', info => { delete info.uuid; }],
    ['invalid UUID', info => { info.uuid = 'not-a-project-uuid'; }],
    ['missing name', info => { delete info.name; }],
    ['blank name', info => { info.name = ' '; }],
  ];
  for (const [label, change] of cases) await t.test(label, async (subtest) => {
    const f = await fixture(subtest);
    change(f.info);
    await fs.writeFile(path.join(f.project, 'package.json'), JSON.stringify(f.info));
    const before = await snapshot(f.project);
    await assert.rejects(f.installExtension(f.project, { update: true }), code('INVALID_PROJECT'));
    assert.deepEqual(await snapshot(f.project), before);
  });
  for (const version of ['3.7.0', '3.7.4']) await t.test(version, async (subtest) => {
    const f = await fixture(subtest, version);
    await f.installExtension(f.project);
    assert.deepEqual(await snapshot(f.destination), await snapshot(f.source));
  });
});

test('ordinary npm folders and projects without an assets directory are refused before writing', async (t) => {
  const f = await fixture(t);
  await fs.rmdir(path.join(f.project, 'assets'));
  const before = await snapshot(f.project);
  await assert.rejects(f.installExtension(f.project));
  assert.deepEqual(await snapshot(f.project), before);
});

test('project, assets, extensions, destination, and nested directory links never redirect installation', async (t) => {
  for (const location of ['project', 'ancestor', 'assets', 'extensions', 'destination', 'nested', 'source']) {
    await t.test(location, async (subtest) => {
      const f = await fixture(subtest);
      const outside = path.join(f.root, 'outside');
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside must stay unchanged');
      let project = f.project;
      if (location === 'project') {
        project = path.join(f.root, 'project-link');
        await directoryLink(f.project, project);
      } else if (location === 'ancestor') {
        const alias = path.join(f.root, 'ancestor-link');
        await directoryLink(path.dirname(f.project), alias);
        project = path.join(alias, path.basename(f.project));
      } else if (location === 'assets') {
        await fs.rmdir(path.join(f.project, 'assets'));
        await directoryLink(outside, path.join(f.project, 'assets'));
      } else if (location === 'extensions') await directoryLink(outside, f.extensions);
      else if (location === 'destination') {
        await fs.mkdir(f.extensions);
        await directoryLink(outside, f.destination);
      } else if (location === 'nested') {
        await f.installExtension(f.project);
        await directoryLink(outside, path.join(f.destination, 'linked'));
      } else await directoryLink(outside, path.join(f.source, 'linked'));
      const beforeProject = await snapshot(f.project);
      const beforeOutside = await snapshot(outside);
      await assert.rejects(f.installExtension(project, { update: true }), code('UNSAFE_INSTALL'));
      assert.deepEqual(await snapshot(f.project), beforeProject);
      assert.deepEqual(await snapshot(outside), beforeOutside);
    });
  }
});

test('linked project metadata and managed files cannot be followed', async (t) => {
  for (const location of ['project-package', 'extension-package', 'managed-file']) await t.test(location, async (subtest) => {
    const f = await fixture(subtest);
    await f.installExtension(f.project);
    const target = location === 'project-package' ? path.join(f.project, 'package.json') :
      path.join(f.destination, location === 'extension-package' ? 'package.json' : 'main.js');
    const outside = path.join(f.root, 'outside-file');
    await fs.copyFile(target, outside);
    await fs.unlink(target);
    try { await fs.symlink(outside, target, 'file'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        await fs.copyFile(outside, target);
        subtest.skip('Windows file symlinks require Developer Mode or privilege; directory junction tests still run');
        return;
      }
      throw error;
    }
    const before = await fs.readFile(outside);
    await assert.rejects(f.installExtension(f.project, { update: true }), code('UNSAFE_INSTALL'));
    assert.deepEqual(await fs.readFile(outside), before);
    assert((await fs.lstat(target)).isSymbolicLink());
  });
});

test('a new managed file cannot replace a user directory and its contents', async (t) => {
  const f = await fixture(t);
  await f.installExtension(f.project);
  await fs.mkdir(path.join(f.destination, 'new.js'));
  await fs.writeFile(path.join(f.destination, 'new.js', 'notes.txt'), 'user file');
  await fs.writeFile(path.join(f.source, 'new.js'), '// added by a new release');
  const before = await snapshot(f.destination);
  await assert.rejects(f.installExtension(f.project, { update: true }), code('INSTALL_CONFLICT'));
  assert.deepEqual(await snapshot(f.destination), before);
  await assertNoTemporaryDirectories(f);
});

test('copy failure leaves the active extension intact and removes partial staging', async (t) => {
  for (const updating of [false, true]) await t.test(updating ? 'update' : 'new install', async (subtest) => {
    const f = await fixture(subtest);
    if (updating) await f.installExtension(f.project);
    const before = updating ? await snapshot(f.destination) : null;
    const cp = fs.cp;
    subtest.mock.method(fs, 'cp', async (from, to, options) => {
      if (from === f.source) {
        await fs.writeFile(path.join(to, 'main.js'), '// incomplete new version');
        throw injected();
      }
      return cp(from, to, options);
    });
    await assert.rejects(f.installExtension(f.project, { update: updating }), code('EIO'));
    if (updating) {
      assert.deepEqual(await snapshot(f.destination), before);
      await assertNoTemporaryDirectories(f);
    } else {
      await assert.rejects(fs.lstat(f.destination), code('ENOENT'));
      assert.deepEqual(await fs.readdir(f.extensions), []);
    }
  });
});

test('a copy that silently omits content is rejected before replacing the old extension', async (t) => {
  const f = await fixture(t);
  await f.installExtension(f.project);
  const before = await snapshot(f.destination);
  await fs.writeFile(path.join(f.source, 'main.js'), '// new version');
  const cp = fs.cp;
  t.mock.method(fs, 'cp', async (from, to, options) => {
    await cp(from, to, options);
    if (from === f.source) await fs.unlink(path.join(to, 'adapter.js'));
  });
  await assert.rejects(f.installExtension(f.project, { update: true }), code('INSTALL_CHANGED'));
  assert.deepEqual(await snapshot(f.destination), before);
  await assertNoTemporaryDirectories(f);
});

test('activation failure restores the entire old extension including extra user files', async (t) => {
  const f = await fixture(t);
  await f.installExtension(f.project);
  await fs.writeFile(path.join(f.destination, 'user.txt'), 'user data');
  const before = await snapshot(f.destination);
  await fs.writeFile(path.join(f.source, 'main.js'), '// new version');
  const rename = fs.rename;
  let failed = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === f.destination && !failed) { failed = true; throw injected(); }
    return rename(from, to);
  });
  await assert.rejects(f.installExtension(f.project, { update: true }), code('EIO'));
  assert(failed);
  assert.deepEqual(await snapshot(f.destination), before);
  await assertNoTemporaryDirectories(f);
  t.mock.restoreAll();
  await f.installExtension(f.project, { update: true });
  assert.equal(await fs.readFile(path.join(f.destination, 'main.js'), 'utf8'), '// new version');
});

test('failure to move the old directory never removes it', async (t) => {
  const f = await fixture(t);
  await f.installExtension(f.project);
  const before = await snapshot(f.destination);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from === f.destination) throw injected();
    return rename(from, to);
  });
  await assert.rejects(f.installExtension(f.project, { update: true }), code('EIO'));
  assert.deepEqual(await snapshot(f.destination), before);
  await assertNoTemporaryDirectories(f);
});

test('if rollback also fails the original remains recoverable at the reported path', async (t) => {
  const f = await fixture(t);
  await f.installExtension(f.project);
  const before = await snapshot(f.destination);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === f.destination) throw injected();
    return rename(from, to);
  });
  let failure;
  await assert.rejects(f.installExtension(f.project, { update: true }), error => {
    failure = error;
    return error.code === 'INSTALL_ROLLBACK_FAILED' && error instanceof AggregateError;
  });
  assert(path.relative(f.extensions, failure.recoveryPath).startsWith('.cocos-creator-mcp-'));
  assert.deepEqual(await snapshot(failure.recoveryPath), before);
  await assert.rejects(fs.lstat(f.destination), code('ENOENT'));
  assert.match(failure.message, /previous extension retained/);
  await assert.rejects(f.installExtension(f.project, { update: true }), code('INSTALL_BUSY'));
});

test('a failed first activation leaves no destination or temporary directories', async (t) => {
  const f = await fixture(t);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === f.destination) throw injected();
    return rename(from, to);
  });
  await assert.rejects(f.installExtension(f.project), code('EIO'));
  await assert.rejects(fs.lstat(f.destination), code('ENOENT'));
  assert.deepEqual(await fs.readdir(f.extensions), []);
});

test('rollback refuses a concurrently created destination and keeps both copies intact', async (t) => {
  const f = await fixture(t);
  await f.installExtension(f.project);
  const before = await snapshot(f.destination);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === f.destination) {
      await fs.mkdir(f.destination);
      await fs.writeFile(path.join(f.destination, 'user.txt'), 'concurrent foreign directory');
      throw injected();
    }
    return rename(from, to);
  });
  let failure;
  await assert.rejects(f.installExtension(f.project, { update: true }), error => {
    failure = error;
    return error.code === 'INSTALL_ROLLBACK_FAILED';
  });
  assert.deepEqual(await snapshot(failure.recoveryPath), before);
  assert.equal(await fs.readFile(path.join(f.destination, 'user.txt'), 'utf8'), 'concurrent foreign directory');
  assert.deepEqual(await fs.readdir(f.destination), ['user.txt']);
});

test('cleanup failure reports the committed install and retains the backup for recovery', async (t) => {
  const f = await fixture(t);
  await f.installExtension(f.project);
  const oldMain = await fs.readFile(path.join(f.destination, 'main.js'));
  await fs.writeFile(path.join(f.source, 'main.js'), '// complete new version');
  const rm = fs.rm;
  t.mock.method(fs, 'rm', async (target, options) => {
    if (path.dirname(target) === f.extensions) throw injected();
    return rm(target, options);
  });
  let failure;
  await assert.rejects(f.installExtension(f.project, { update: true }), error => {
    failure = error;
    return error.code === 'INSTALL_CLEANUP_FAILED' && error.installed === true;
  });
  assert.deepEqual(await snapshot(f.destination), await snapshot(f.source));
  assert([...await snapshot(failure.recoveryPath)].some(([, value]) => Buffer.isBuffer(value) && value.equals(oldMain)));
  assert.match(failure.message, /installed.*cleanup failed/);
  await assert.rejects(f.installExtension(f.project, { update: true }), code('INSTALL_BUSY'));
});

test('replacing the extensions parent with a junction during staging never redirects writes or cleanup', async (t) => {
  const f = await fixture(t);
  await f.installExtension(f.project);
  const before = await snapshot(f.destination);
  const outside = path.join(f.root, 'outside');
  const displaced = path.join(f.project, 'original-extensions');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'user.txt'), 'outside data');
  const outsideBefore = await snapshot(outside);
  const cp = fs.cp;
  t.mock.method(fs, 'cp', async (from, to, options) => {
    await cp(from, to, options);
    if (from === f.source) {
      await fs.rename(f.extensions, displaced);
      await directoryLink(outside, f.extensions);
    }
  });
  await assert.rejects(f.installExtension(f.project, { update: true }), code('UNSAFE_INSTALL'));
  assert.deepEqual(await snapshot(outside), outsideBefore);
  assert.deepEqual(await snapshot(path.join(displaced, 'cocos-creator-mcp')), before);
  assert((await fs.lstat(f.extensions)).isSymbolicLink());
});

test('project changes and concurrent user edits during staging cannot be overwritten', async (t) => {
  for (const mutation of ['project', 'destination', 'new-destination']) await t.test(mutation, async (subtest) => {
    const f = await fixture(subtest);
    if (mutation !== 'new-destination') await f.installExtension(f.project);
    const cp = fs.cp;
    subtest.mock.method(fs, 'cp', async (from, to, options) => {
      await cp(from, to, options);
      if (from === f.source) {
        if (mutation === 'project') await fs.writeFile(path.join(f.project, 'package.json'), JSON.stringify({ ...f.info, uuid: randomUUID() }));
        else {
          await fs.mkdir(f.destination, { recursive: true });
          await fs.writeFile(path.join(f.destination, 'main.js'), '// concurrent user edit');
        }
      }
    });
    await assert.rejects(f.installExtension(f.project, { update: true }), code('INSTALL_CHANGED'));
    if (mutation !== 'project') assert.equal(await fs.readFile(path.join(f.destination, 'main.js'), 'utf8'), '// concurrent user edit');
    await assertNoTemporaryDirectories(f);
  });
});

test('concurrent installers do not replace each other or leak partial installations', async (t) => {
  const f = await fixture(t);
  const cp = fs.cp;
  let release;
  let signal;
  const entered = new Promise(resolve => { signal = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  t.mock.method(fs, 'cp', async (from, to, options) => {
    if (from === f.source) { signal(); await resume; }
    return cp(from, to, options);
  });
  const first = f.installExtension(f.project);
  try {
    await entered;
    await assert.rejects(f.installExtension(f.project, { update: true }), code('INSTALL_BUSY'));
  } finally { release(); }
  await first;
  assert.deepEqual(await snapshot(f.destination), await snapshot(f.source));
  await assertNoTemporaryDirectories(f);
});

test('CLI keeps project-path and --update API, rejects unknown flags, and reports failures', async (t) => {
  const f = await fixture(t);
  const first = await run(process.execPath, [f.script, f.project], { windowsHide: true });
  assert.match(first.stdout, /Installed:/);
  assert.equal(first.stderr, '');
  await assert.rejects(run(process.execPath, [f.script, f.project]), error => error.code === 1 && /--update/.test(error.stderr));
  await fs.writeFile(path.join(f.source, 'main.js'), '// CLI update');
  const updated = await run(process.execPath, [f.script, f.project, '--update'], { windowsHide: true });
  assert.match(updated.stdout, /Installed:/);
  assert.equal(await fs.readFile(path.join(f.destination, 'main.js'), 'utf8'), '// CLI update');
  for (const args of [[], ['--update'], [f.project, '--force'], [f.project, '--update', '--update']]) {
    await assert.rejects(run(process.execPath, [f.script, ...args]), error => error.code === 1 && /Usage:/.test(error.stderr));
  }
  await assertNoTemporaryDirectories(f);
});
