#!/usr/bin/env node
'use strict';

// Read-only ASAR inspection. Does not load or execute any editor modules.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function openAsar(filename) {
  const fd = fs.openSync(filename, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, 16, 0) !== 16) throw new Error('Truncated ASAR');
    const headerSize = prefix.readUInt32LE(12);
    const dataOffset = 8 + prefix.readUInt32LE(4);
    if (headerSize > 64 * 1024 * 1024 || 16 + headerSize > dataOffset) throw new Error('Invalid ASAR header');
    const header = Buffer.alloc(headerSize);
    if (fs.readSync(fd, header, 0, headerSize, 16) !== headerSize) throw new Error('Truncated ASAR header');
    const tree = JSON.parse(header.toString('utf8'));
    const entries = [];
    function walk(node, parent) {
      for (const [name, item] of Object.entries(node.files || {})) {
        const relative = parent ? `${parent}/${name}` : name;
        if (item.files) walk(item, relative);
        else entries.push({ path: relative, ...item });
      }
    }
    walk(tree, '');
    const byPath = new Map(entries.map(entry => [entry.path, entry]));
    function read(relative) {
      const entry = byPath.get(relative);
      if (!entry || entry.link) throw new Error(`Missing file or unsupported ASAR link: ${relative}`);
      if (entry.unpacked) return fs.readFileSync(`${filename}.unpacked/${relative}`);
      const buffer = Buffer.alloc(entry.size);
      if (fs.readSync(fd, buffer, 0, buffer.length, dataOffset + Number(entry.offset)) !== buffer.length) {
        throw new Error(`Truncated ASAR member: ${relative}`);
      }
      return buffer;
    }
    return { entries, read, close: () => fs.closeSync(fd) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

if (require.main === module) {
  const [, , archivePath, mode = 'list', argument, outputDirectory] = process.argv;
  if (!archivePath) {
    console.error('Usage: node tools/inspect-creator.cjs <app.asar> list [regex] | read <member> | extract <regex> <new-output-dir>');
    process.exitCode = 1;
  } else {
    const archive = openAsar(path.resolve(archivePath));
    try {
      if (mode === 'read') process.stdout.write(archive.read(argument));
      else if (mode === 'list') {
        const pattern = new RegExp(argument || '.');
        console.log(JSON.stringify(archive.entries.filter(entry => pattern.test(entry.path)), null, 2));
      } else if (mode === 'extract') {
        if (!argument || !outputDirectory) throw new Error('Extraction requires a regex and a new output directory');
        const destination = path.resolve(outputDirectory);
        if (fs.existsSync(destination)) throw new Error(`Output already exists: ${destination}`);
        const pattern = new RegExp(argument);
        const selected = archive.entries.filter(entry => pattern.test(entry.path) && !entry.link);
        fs.mkdirSync(destination, { recursive: true });
        const manifest = [];
        for (const entry of selected) {
          const target = path.resolve(destination, entry.path);
          if (!target.startsWith(destination + path.sep)) throw new Error(`Unsafe path: ${entry.path}`);
          const bytes = archive.read(entry.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, bytes, { flag: 'wx' });
          manifest.push({ path: entry.path, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
        }
        fs.writeFileSync(path.join(destination, 'extraction-manifest.json'), JSON.stringify({
          source: path.resolve(archivePath), archiveSize: fs.statSync(archivePath).size,
          headerMemberCount: archive.entries.length, selector: argument, members: manifest,
        }, null, 2));
        console.log(JSON.stringify({ destination, files: selected.length }));
      } else throw new Error(`Unknown mode: ${mode}`);
    } finally {
      archive.close();
    }
  }
}

module.exports = { openAsar };
