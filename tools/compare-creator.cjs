#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openAsar } = require('./inspect-creator.cjs');

const modules = ['scene', 'asset-db', 'builder', 'preview', 'project'];
const coreMessages = {
  scene: ['query-is-ready', 'query-dirty', 'query-node', 'query-node-tree', 'query-component',
    'create-node', 'remove-node', 'set-parent', 'create-component', 'remove-component',
    'set-property', 'execute-scene-script', 'open-scene', 'save-scene', 'snapshot',
    'snapshot-abort', 'undo', 'redo', 'begin-recording', 'end-recording', 'cancel-recording', 'create-prefab'],
  'asset-db': ['query-ready', 'query-assets', 'query-asset-info', 'query-asset-meta',
    'query-uuid', 'query-url', 'create-asset', 'import-asset', 'save-asset',
    'query-asset-dependencies', 'query-asset-users'],
  builder: ['build', 'query-tasks-info', 'excute-build-stage', 'execute-build-stage'],
  preview: ['open', 'refresh'],
  project: ['query-project-data', 'query-project-configs', 'set-config'],
};

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function archiveHash(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function inspect(filename) {
  filename = path.resolve(filename);
  const archive = openAsar(filename);
  try {
    const root = JSON.parse(archive.read('package.json'));
    const result = {
      path: filename, size: fs.statSync(filename).size, sha256: await archiveHash(filename),
      version: root.version, memberCount: archive.entries.length, repack: null,
      moduleMessages: {}, sourceMembers: [],
    };
    const repackPath = path.join(path.dirname(filename), 'repack.json');
    if (fs.existsSync(repackPath)) {
      const bytes = fs.readFileSync(repackPath);
      result.repack = { path: repackPath, sha256: sha256(bytes), metadata: JSON.parse(bytes) };
    }
    for (const moduleName of modules) {
      const relative = `builtin/${moduleName}/package.json`;
      const bytes = archive.read(relative);
      const manifest = JSON.parse(bytes);
      result.sourceMembers.push({ path: relative, sha256: sha256(bytes) });
      result.moduleMessages[moduleName] = manifest.contributions.messages || {};
    }
    for (const relative of ['builtin/scene/@types/message.d.ts', 'builtin/scene/@types/public.d.ts',
      'builtin/asset-db/@types/message.d.ts', 'node_modules/@editor/creator/@types/editor.d.ts']) {
      const bytes = archive.read(relative);
      result.sourceMembers.push({ path: relative, sha256: sha256(bytes) });
    }
    return result;
  } finally {
    archive.close();
  }
}

async function main() {
  const [, , beforePath, afterPath, outputPath] = process.argv;
  if (!beforePath || !afterPath || !outputPath) {
    throw new Error('Usage: node tools/compare-creator.cjs <3.7 app.asar> <comparison app.asar> <new-report.json>');
  }
  const before = await inspect(beforePath);
  const after = await inspect(afterPath);
  const changes = modules.map(moduleName => {
    const a = before.moduleMessages[moduleName];
    const b = after.moduleMessages[moduleName];
    return {
      module: moduleName, beforeCount: Object.keys(a).length, afterCount: Object.keys(b).length,
      added: Object.keys(b).filter(key => !(key in a)),
      removed: Object.keys(a).filter(key => !(key in b)),
      core: coreMessages[moduleName].map(message => ({
        message, before: a[message] || null, after: b[message] || null,
      })),
    };
  });
  const report = {
    schemaVersion: 1,
    evidenceType: 'offline ASAR manifest and declaration inspection; no editor code executed',
    limits: [
      'Registration establishes declared availability, not runtime correctness or parameter compatibility.',
      'Comparison is between these exact installed builds; it does not establish the first release of an API.',
      'Encrypted .ccc implementations are not decompiled.',
      'A repack marker means this installation may differ from a stock Cocos release.',
    ],
    before, after, changes,
  };
  const destination = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ report: destination, before: before.version, after: after.version,
    modules: changes.map(({ module, beforeCount, afterCount }) => ({ module, beforeCount, afterCount })) }));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
