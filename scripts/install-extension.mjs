#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionName = 'cocos-creator-mcp';
const source = path.resolve(fileURLToPath(new URL('../extensions/cocos-creator-mcp/', import.meta.url)));

function fail(message, code = 'UNSAFE_INSTALL') {
  return Object.assign(new Error(message), { code });
}

function samePath(a, b) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function optionalStat(target) {
  try { return await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function directory(target, expected) {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(await fs.realpath(target), target)) {
    throw fail(`Expected a real directory without symlinks or junctions: ${target}`);
  }
  if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) {
    throw fail(`Directory changed during installation: ${target}`, 'INSTALL_CHANGED');
  }
  return stat;
}

async function readJson(target) {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024 || !samePath(await fs.realpath(target), target)) {
    throw fail(`Expected a regular JSON file without links: ${target}`);
  }
  return JSON.parse(await fs.readFile(target, 'utf8'));
}

async function readProject(projectPath) {
  await directory(projectPath);
  const info = await readJson(path.join(projectPath, 'package.json'));
  if (!info || typeof info.name !== 'string' || !info.name.trim() ||
      typeof info.uuid !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(info.uuid)) {
    throw fail('Expected a Creator project package.json with a name and project UUID', 'INVALID_PROJECT');
  }
  if (typeof info.creator?.version !== 'string' || !/^3\.7\.(0|[1-9]\d*)$/.test(info.creator.version)) {
    throw fail(`Expected a Creator 3.7.x project; found ${String(info.creator?.version)}`, 'INVALID_PROJECT');
  }
  await directory(path.join(projectPath, 'assets'));
  return JSON.stringify(info);
}

// Bound copying and catch changes while staging. Never traverse links,
// including junctions, or copy special files from a user-controlled destination.
async function tree(root) {
  await directory(root);
  const entries = new Map();
  let totalBytes = 0;
  async function visit(current, depth) {
    if (depth > 32) throw fail(`Extension directory is too deeply nested: ${root}`);
    for (const name of (await fs.readdir(current)).sort()) {
      const target = path.join(current, name);
      if (!inside(root, target)) throw fail(`Extension path escapes its directory: ${target}`);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || !samePath(await fs.realpath(target), target)) {
        throw fail(`Extension contains a link or special file: ${target}`);
      }
      if (entries.size >= 20000 || (totalBytes += stat.isFile() ? stat.size : 0) > 512 * 1024 * 1024) {
        throw fail(`Extension exceeds the installer limit (20,000 entries / 512 MiB): ${root}`);
      }
      const relative = path.relative(root, target);
      if (stat.isDirectory()) {
        entries.set(relative, 'directory');
        await visit(target, depth + 1);
      } else {
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of createReadStream(target)) {
          if ((bytes += chunk.length) > stat.size) throw fail(`Extension file changed while reading: ${target}`, 'INSTALL_CHANGED');
          hash.update(chunk);
        }
        if (bytes !== stat.size) throw fail(`Extension file changed while reading: ${target}`, 'INSTALL_CHANGED');
        entries.set(relative, hash.digest('hex'));
      }
    }
  }
  await visit(root, 0);
  return entries;
}

function sameTree(a, b) {
  return a.size === b.size && [...a].every(([name, value]) => b.get(name) === value);
}

async function ownExtension(target, entries) {
  const info = await readJson(path.join(target, 'package.json'));
  // Recognize older/manual installs too. --update authorizes replacing their
  // managed files, even when edited, but a matching package name alone is unsafe.
  const messages = info?.contributions?.messages;
  if (info?.name !== extensionName || info.package_version !== 2 || info.main !== './main.js' ||
      info.contributions?.scene?.script !== './scene.js' ||
      !['start-bridge', 'stop-bridge', 'bridge-status'].every((name, index) =>
        Array.isArray(messages?.[name]?.methods) &&
        messages[name].methods.includes(['startBridge', 'stopBridge', 'bridgeStatus'][index])) ||
      !['main.js', 'bridge.js', 'adapter.js', 'scene.js'].every(name => entries.has(name) && entries.get(name) !== 'directory')) {
    throw fail(`Destination is not a recognized ${extensionName} extension: ${target}`, 'FOREIGN_EXTENSION');
  }
}

export async function installExtension(project, { update = false } = {}) {
  if (typeof project !== 'string' || !project.trim() || typeof update !== 'boolean') {
    throw fail('Expected a project path and a boolean update option', 'INVALID_ARGUMENT');
  }
  const projectPath = path.resolve(project);
  const projectStat = await directory(projectPath);
  const projectIdentity = await readProject(projectPath);
  const extensions = path.join(projectPath, 'extensions');
  const destination = path.join(extensions, extensionName);
  if (samePath(source, destination) || inside(source, destination) || inside(destination, source)) {
    throw fail('Extension source and destination must not overlap');
  }
  const sourceEntries = await tree(source);
  await ownExtension(source, sourceEntries);
  try { await fs.mkdir(extensions); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const extensionsStat = await directory(extensions);
  const lock = path.join(extensions, `.${extensionName}-install.lock`);
  try { await fs.mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw fail(`Another installation or an unfinished recovery holds ${lock}`, 'INSTALL_BUSY');
    throw error;
  }
  const lockStat = await directory(lock);
  let transaction;
  let transactionStat;
  let recoveryPath;
  let failure;
  let committed = false;
  try {
    const existing = await optionalStat(destination);
    let oldEntries = new Map();
    if (existing) {
      await directory(destination, existing);
      if (!update) throw fail('An extension already exists at the destination; use --update for this extension', 'EXTENSION_EXISTS');
      oldEntries = await tree(destination);
      await ownExtension(destination, oldEntries);
    }
    // Preserve unrelated files. Refuse file/directory collisions instead of
    // erasing a user's directory when a new release introduces a managed file.
    const expected = new Map(oldEntries);
    for (const [name, value] of sourceEntries) {
      const old = oldEntries.get(name);
      if (old !== undefined && (old === 'directory') !== (value === 'directory')) {
        throw fail(`Existing file/directory conflicts with the extension: ${name}`, 'INSTALL_CONFLICT');
      }
      expected.set(name, value);
    }
    await directory(projectPath, projectStat);
    await directory(extensions, extensionsStat);
    transaction = await fs.mkdtemp(path.join(extensions, `.${extensionName}-install-`));
    transactionStat = await directory(transaction);
    const staged = path.join(transaction, 'staged');
    const backup = path.join(transaction, 'previous');
    await fs.mkdir(staged);
    const stagedStat = await directory(staged);
    async function checkStaging() {
      await directory(projectPath, projectStat);
      await directory(extensions, extensionsStat);
      await directory(transaction, transactionStat);
      await directory(staged, stagedStat);
    }
    const copyOptions = { recursive: true, force: true, dereference: false, verbatimSymlinks: true };
    await checkStaging();
    if (existing) {
      await fs.cp(destination, staged, copyOptions);
      await checkStaging();
      if (!sameTree(oldEntries, await tree(staged))) throw fail('Installed extension changed while copying', 'INSTALL_CHANGED');
    }
    await fs.cp(source, staged, copyOptions);
    await checkStaging();
    if (!sameTree(expected, await tree(staged))) throw fail('Extension changed or copied incompletely while staging', 'INSTALL_CHANGED');

    await checkStaging();
    if (await readProject(projectPath) !== projectIdentity) throw fail('Project identity changed while staging', 'INSTALL_CHANGED');
    if (existing) {
      await directory(destination, existing);
      if (!sameTree(oldEntries, await tree(destination))) throw fail('Installed extension changed while staging', 'INSTALL_CHANGED');
      await fs.rename(destination, backup);
      recoveryPath = backup;
    } else if (await optionalStat(destination)) {
      throw fail('Destination appeared while staging', 'INSTALL_CHANGED');
    }
    try {
      await fs.rename(staged, destination);
      committed = true;
    } catch (error) {
      if (recoveryPath) {
        try {
          await directory(extensions, extensionsStat);
          // Do not replace a concurrently created destination while rolling back.
          if (await optionalStat(destination)) throw fail('Destination appeared during rollback');
          await fs.rename(backup, destination);
          recoveryPath = undefined;
        } catch (rollbackError) {
          throw Object.assign(new AggregateError([error, rollbackError], `Install failed; previous extension retained at ${backup}`, { cause: error }),
            { code: 'INSTALL_ROLLBACK_FAILED', recoveryPath: backup });
        }
      }
      throw error;
    }
    recoveryPath = undefined;
  } catch (error) {
    failure = error;
  } finally {
    // Only remove directories created by this invocation, after checking that
    // their parents still refer to the same project. A failed rollback keeps its
    // backup for recovery; it is never deleted by a generic finally cleanup.
    try {
      await directory(projectPath, projectStat);
      await directory(extensions, extensionsStat);
      if (transaction && !recoveryPath) {
        await directory(transaction, transactionStat);
        await tree(transaction);
        await fs.rm(transaction, { recursive: true });
      }
      if (!recoveryPath) {
        await directory(lock, lockStat);
        await fs.rmdir(lock);
      }
    } catch (cleanupError) {
      if (failure) failure = Object.assign(new AggregateError([failure, cleanupError], `${failure.message}; cleanup failed: ${cleanupError.message}`, { cause: failure }),
        { code: failure.code, recoveryPath: failure.recoveryPath });
      else failure = Object.assign(fail(`Extension installed at ${destination}, but temporary directory cleanup failed: ${cleanupError.message}`, 'INSTALL_CLEANUP_FAILED'),
        { cause: cleanupError, installed: committed, recoveryPath: transaction });
    }
  }
  if (failure) throw failure;
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [project, ...flags] = process.argv.slice(2);
  if (!project || project.startsWith('--') || flags.length > 1 || flags.some(flag => flag !== '--update')) {
    console.error('Usage: node scripts/install-extension.mjs <project-path> [--update]');
    process.exitCode = 1;
  } else {
    installExtension(project, { update: flags.includes('--update') })
      .then(destination => console.log(`Installed: ${destination}\nEnable cocos-creator-mcp in Creator Extension Manager.`))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
