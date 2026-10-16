#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
export const USAGE = 'Usage: node scripts/soak.mjs --project <absolute disposable fixture> --report <new absolute JSON file> [--duration-seconds 28800] [--interval-ms 1000] [--cycles <count>] [--control-file <absolute JSON file>]';

export function createContinuityMonitor({ onGap, now = Date.now, schedule = setInterval, cancel = clearInterval }) {
  let previous = now(), stopped = false;
  const stop = () => { if (!stopped) { stopped = true; cancel(timer); } };
  const check = () => {
    if (stopped) return;
    const current = now(), gap = current - previous;
    previous = current;
    if (gap > 60000 || gap < 0) { stop(); onGap(gap); }
  };
  const timer = schedule(check, 5000);
  timer.unref?.();
  return { stop, check };
}

export function parseOptions(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const values = {};
  const flags = new Set(['--project', '--report', '--duration-seconds', '--interval-ms', '--cycles', '--control-file']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!flags.has(flag) || Object.hasOwn(values, flag) || value === undefined || value.startsWith('--')) throw new Error(USAGE);
    values[flag] = value;
  }
  for (const flag of ['--project', '--report']) if (!values[flag] || !path.isAbsolute(values[flag])) throw new Error(`${flag} must be an absolute path.`);
  const number = (flag, fallback, min, max) => {
    const raw = values[flag] ?? String(fallback);
    if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw new Error(`${flag} must be an integer from ${min} to ${max}.`);
    return Number(raw);
  };
  if (values['--control-file'] && !path.isAbsolute(values['--control-file'])) throw new Error('--control-file must be absolute.');
  return { project: path.resolve(values['--project']), report: path.resolve(values['--report']),
    ...(values['--control-file'] && { controlFile: path.resolve(values['--control-file']) }),
    durationSeconds: number('--duration-seconds', 28800, 1, 604800), intervalMs: number('--interval-ms', 1000, 0, 60000),
    cycles: values['--cycles'] === undefined ? undefined : number('--cycles', 1, 1, 1000000) };
}

async function sources() {
  const files = ['src/server.mjs', 'src/tools.mjs', 'src/bridge-client.mjs', 'package.json', 'package-lock.json', 'scripts/soak.mjs',
    ...['main.js', 'bridge.js', 'adapter.js', 'extras.js', 'scene.js', 'package.json'].map(name => 'extensions/cocos-creator-mcp/' + name)];
  return Promise.all(files.map(async file => ({ file, sha256: createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex') })));
}

export async function validateFixture(project, report) {
  const [identity, marker] = await Promise.all(['package.json', '.cocos-mcp-test-project.json'].map(name => fs.readFile(path.join(project, name), 'utf8').then(JSON.parse)));
  assert.equal(marker.purpose, 'cocos-creator-mcp integration tests', 'Use a generated disposable fixture');
  assert.equal(marker.uuid, identity.uuid, 'Disposable fixture identity must match');
  assert.match(identity.creator?.version ?? '', /^3\.7\.\d+$/u);
  const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  assert.equal(normalized(await fs.realpath(project)), normalized(project), 'Use the real fixture directory');
  const relative = path.relative(project, report);
  assert(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'Keep the report outside the fixture');
  await fs.mkdir(path.dirname(report), { recursive: true });
  return identity;
}

async function sampleEditor(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0);
  if (process.platform !== 'win32') return { unavailable: 'Windows process counters only' };
  const script = `$ErrorActionPreference='Stop';$taskAll=Get-CimInstance Win32_Process;$taskIds=[System.Collections.Generic.HashSet[int]]::new();[void]$taskIds.Add(${pid});do{$taskAdded=$false;foreach($taskP in $taskAll){if($taskIds.Contains([int]$taskP.ParentProcessId) -and $taskIds.Add([int]$taskP.ProcessId)){$taskAdded=$true}}}while($taskAdded);$taskMain=Get-Process -Id ${pid};$taskProcesses=@(Get-Process -Id @($taskIds) -ErrorAction SilentlyContinue);[ordered]@{mainPid=${pid};processes=$taskProcesses.Count;mainPrivateBytes=$taskMain.PrivateMemorySize64;mainHandles=$taskMain.HandleCount;privateBytes=($taskProcesses|Measure-Object PrivateMemorySize64 -Sum).Sum;handles=($taskProcesses|Measure-Object HandleCount -Sum).Sum}|ConvertTo-Json -Compress`;
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 64000 });
  return JSON.parse(result.stdout);
}

export async function runSoak(options) {
  const identity = await validateFixture(options.project, options.report);
  const reservation = await fs.open(options.report, 'wx');
  await reservation.close();
  const report = { schemaVersion: 1, kind: 'native-editor-soak', runId: randomUUID(), startedAt: new Date().toISOString(),
    version: identity.creator.version, projectUuid: identity.uuid, platform: `${process.platform} ${process.arch}`, node: process.version,
    requested: { durationSeconds: options.durationSeconds, intervalMs: options.intervalMs, cycles: options.cycles ?? null, resourceControl: Boolean(options.controlFile) },
    sources: await sources(), cycles: 0, toolCalls: 0, connections: 0, closedClients: 0, resourcePauseMs: 0, samples: [], success: false, status: 'running' };
  const namespace = 'db://assets/McpSoak_' + report.runId.replaceAll('-', '');
  report.namespace = namespace;
  const durationMs = options.durationSeconds * 1000;
  const started = Date.now();
  const monotonicStarted = performance.now();
  let client, transport, stderr = '', lastSample = 0, lastProgress = 0, interrupted = false;
  const active = new AbortController();
  const onSignal = () => { interrupted = true; report.success = false; report.status = 'interrupted'; active.abort(); };
  const continuity = createContinuityMonitor({ onGap(gap) {
    report.interruption = { code: 'SOAK_CLOCK_GAP', wallGapMs: gap, message: 'Host sleep, clock change, or a long event-loop stall interrupted continuous validation.' };
    onSignal();
  } });
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const checkpoint = async () => {
    report.elapsedMs = Math.round(performance.now() - monotonicStarted);
    const temporary = options.report + '.' + report.runId + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temporary, options.report);
  };
  const invoke = async (name, args = {}) => {
    report.toolCalls++;
    const reply = await client.callTool({ name, arguments: args }, undefined, { signal: active.signal, timeout: 90000 });
    const value = reply.structuredContent ?? JSON.parse(reply.content.find(item => item.type === 'text').text);
    if (reply.isError) throw Object.assign(new Error(`${name}: ${value.error?.message ?? 'Tool failed'}`), { code: value.error?.code, details: value.error?.details });
    return value.result;
  };
  const close = async () => {
    if (!client) return;
    const previous = client, pid = transport.pid;
    client = undefined;
    await previous.close();
    if (pid) {
      let alive = true;
      for (let index = 0; index < 50; index++) {
        try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { alive = false; break; } throw error; }
        await pause(100);
      }
      assert.equal(alive, false, 'Closed MCP client must not leave its stdio server behind');
    }
    report.closedClients++;
  };
  const connect = async () => {
    transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/server.mjs'), '--project', options.project, '--timeout', '45000'], stderr: 'pipe' });
    transport.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    client = new Client({ name: 'creator-production-soak', version: '0.1.0' });
    await client.connect(transport);
    report.connections++;
    const info = await invoke('editor_info');
    assert.equal(info.project.uuid, identity.uuid);
    assert.equal(info.editorVersion, identity.creator.version);
    assert.equal((await client.listTools()).tools.length, 17);
  };
  const sample = async () => {
    const discovery = JSON.parse(await fs.readFile(path.join(options.project, 'temp/cocos-creator-mcp/session.json'), 'utf8'));
    assert.equal(discovery.project.uuid, identity.uuid);
    const entry = { elapsedMs: Date.now() - started, ...(await sampleEditor(discovery.pid)) };
    report.samples.push(entry);
    if (report.samples.length > 2000) report.samples.splice(1, 1);
    if (entry.privateBytes !== undefined) assert(entry.privateBytes < 8 * 1024 ** 3, 'Editor process tree exceeds 8 GiB private memory budget');
    if (entry.handles !== undefined) assert(entry.handles < 30000, 'Editor process tree exceeds 30,000 handles budget');
    lastSample = Date.now();
  };
  try {
    await connect();
    await sample();
    const current = await invoke('scene_query');
    if (current.ready && current.dirty) await invoke('scene_save');
    await invoke('asset_edit', { action: 'create', url: namespace });
    const main = await invoke('scene_create', { url: namespace + '/Main.scene' });
    const other = await invoke('scene_create', { url: namespace + '/Other.scene' });
    await invoke('scene_open', { asset: main.asset.uuid });
    const file = await invoke('asset_edit', { action: 'create', url: namespace + '/probe.txt', content: 'initial' });
    const created = await invoke('node_edit', { action: 'create', name: 'McpSoakProbe', components: ['cc.UITransform', 'cc.Label'] });
    let uuid = created.uuids[0];
    const flatten = value => (Array.isArray(value) ? value : value ? [value] : []).flatMap(node => [node, ...flatten(node.children)]);
    while (!interrupted && performance.now() - monotonicStarted < durationMs + report.resourcePauseMs && (options.cycles === undefined || report.cycles < options.cycles)) {
      if (options.controlFile) {
        let control;
        try { const raw = await fs.readFile(options.controlFile, 'utf8'); assert(raw.length < 16384); control = JSON.parse(raw); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (control?.abort === true) throw new Error('Resource supervisor stopped this run: ' + String(control.reason ?? 'resource budget exceeded'));
        if (control?.pauseUntil > Date.now()) {
          assert(Number.isSafeInteger(control.pauseUntil) && control.pauseUntil <= Date.now() + 300000, 'Resource pause must expire within five minutes');
          const waitMs = Math.min(5000, control.pauseUntil - Date.now());
          const waitStarted = performance.now();
          await pause(waitMs, undefined, { signal: active.signal });
          report.resourcePauseMs += performance.now() - waitStarted;
          if (Date.now() - lastSample >= 60000) await sample();
          if (Date.now() - lastProgress >= 60000) { await checkpoint(); lastProgress = Date.now(); }
          continue;
        }
      }
      const iteration = report.cycles + 1;
      const node = await invoke('node_query', { uuid });
      const label = node.components.find(component => component.type === 'cc.Label');
      assert(label);
      const text = `生产回归 ${iteration} / ${report.runId}`;
      await invoke('property_set', { uuid, componentUuid: label.uuid, path: 'string', value: text });
      const position = { x: iteration % 100, y: iteration % 37 === 0 ? 0 : -(iteration % 37), z: 0 };
      await invoke('property_set', { uuid, path: 'position', value: position });
      const [after, scene, assets] = await Promise.all([
        invoke('node_query', { uuid }), invoke('scene_query'), invoke('asset_query', { action: 'search', pattern: namespace + '/**', limit: 50 }),
      ]);
      assert.deepEqual(after.position, position);
      assert.equal(after.components.find(component => component.type === 'cc.Label').properties.string, text);
      assert.equal(scene.tree.uuid, main.asset.uuid);
      assert(assets.assets.some(asset => asset.uuid === file.uuid));
      const transient = await invoke('node_edit', { action: 'create', name: 'Transient_' + iteration });
      await invoke('node_edit', { action: 'remove', uuid: transient.uuids[0] });
      assert(!flatten((await invoke('scene_query')).tree).some(value => value.uuid === transient.uuids[0]));
      const saved = await invoke('asset_edit', { action: 'save', asset: file.uuid, content: text });
      assert.equal(await fs.readFile(saved.file, 'utf8'), text);
      await invoke('scene_save');
      if (iteration % 10 === 0) {
        await invoke('scene_open', { asset: other.asset.uuid });
        await invoke('scene_open', { asset: main.asset.uuid });
        const reopened = await invoke('node_query', { name: 'McpSoakProbe' });
        assert.deepEqual(reopened.position, position);
        assert.equal(reopened.components.find(component => component.type === 'cc.Label').properties.string, text);
        uuid = reopened.uuid;
        await close();
        await connect();
      }
      report.cycles++;
      if (Date.now() - lastSample >= 60000) await sample();
      if (Date.now() - lastProgress >= 60000) {
        await checkpoint();
        console.log(JSON.stringify({ version: report.version, cycles: report.cycles, toolCalls: report.toolCalls, elapsedMs: report.elapsedMs, status: 'running' }));
        lastProgress = Date.now();
      }
      if (options.intervalMs) await pause(options.intervalMs, undefined, { signal: active.signal });
    }
    assert(!interrupted, 'Soak interrupted');
    if (options.cycles !== undefined) assert.equal(report.cycles, options.cycles, 'Duration elapsed before the requested cycle count');
    assert(report.cycles > 0, 'No complete cycle');
    await sample();
    assert.deepEqual(await sources(), report.sources, 'Runtime source changed during validation');
    report.success = true;
    report.status = 'passed';
  } catch (error) {
    report.status = interrupted ? 'interrupted' : 'failed';
    report.error = { code: error.code ?? 'ASSERTION_FAILED', message: error.message, ...(error.details === undefined ? {} : { details: error.details }), stderr };
  } finally {
    try { await close(); } catch (error) { report.success = false; report.status = 'failed'; report.cleanupError = error.message; }
    continuity.check();
    continuity.stop();
    report.finishedAt = new Date().toISOString();
    report.durationMet = performance.now() - monotonicStarted >= durationMs + report.resourcePauseMs;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await checkpoint();
  }
  console.log(JSON.stringify({ version: report.version, cycles: report.cycles, toolCalls: report.toolCalls, elapsedMs: report.elapsedMs, success: report.success, status: report.status }));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log(USAGE);
    else if (!(await runSoak(options)).success) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
