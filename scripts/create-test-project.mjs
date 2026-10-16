#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { installExtension } from './install-extension.mjs';
import { openAsar } from '../tools/inspect-creator.cjs';

const projectPath = path.resolve(process.argv[2] || '.work/creator-3.7.3-test');
const editorPath = path.resolve(process.argv[3] || 'C:/ProgramData/cocos/editors/Creator/3.7.3');
const archive = openAsar(path.join(editorPath, 'resources/app.asar'));
let version;
try { version = JSON.parse(archive.read('package.json')).version; } finally { archive.close(); }
if (!/^3\.7\.\d+$/.test(version)) throw new Error('Expected a Creator 3.7.x installation');
await fs.mkdir(projectPath, { recursive: false });
await fs.mkdir(path.join(projectPath, 'assets'), { recursive: true });
const uuid = randomUUID();
await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({
  name: 'Cocos MCP Compatibility Lab', type: '2d', uuid, creator: { version },
}, null, 2));
await fs.writeFile(path.join(projectPath, '.cocos-mcp-test-project.json'), JSON.stringify({uuid, purpose:'cocos-creator-mcp integration tests'}, null, 2));
await fs.writeFile(path.join(projectPath, 'tsconfig.json'), JSON.stringify({ extends: './temp/tsconfig.cocos.json', compilerOptions: { strict: true } }, null, 2));
await fs.copyFile(path.join(editorPath, 'resources/resources/3d/engine/editor/assets/default_file_content/scene-2d'), path.join(projectPath, 'assets/Main.scene'));
await installExtension(projectPath);
console.log(projectPath);
