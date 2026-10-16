import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseOptions, validateFixture, createContinuityMonitor } from '../scripts/soak.mjs';

test('an eight-hour host sleep cannot qualify as uninterrupted soak time', () => {
  let now = 100000, tick, clears = 0;
  const controller = new AbortController(), gaps = [];
  const monitor = createContinuityMonitor({ now: () => now, schedule(callback) { tick = callback; return {}; },
    cancel() { clears++; }, onGap(gap) { gaps.push(gap); controller.abort(); } });
  now += 5000; tick(); assert.equal(controller.signal.aborted, false);
  now += 8 * 60 * 60 * 1000; tick();
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(gaps, [8 * 60 * 60 * 1000]);
  tick(); monitor.stop(); assert.equal(clears, 1);
});

test('a backward clock change interrupts validation even when checked during final cleanup', () => {
  let now = 100000, interrupted = false;
  const monitor = createContinuityMonitor({ now: () => now, schedule() { return {}; }, cancel() {}, onGap() { interrupted = true; } });
  now -= 10000;
  monitor.check();
  assert.equal(interrupted, true);
  monitor.stop();
});

test('native soak defaults to eight hours and requires explicit absolute fixture/report paths', () => {
  const project = path.resolve('fixture'), report = path.resolve('report.json');
  const options = parseOptions(['--project', project, '--report', report]);
  assert.equal(options.durationSeconds, 8 * 60 * 60);
  assert.equal(options.cycles, undefined);
  for (const args of [[], ['--project', '.'], ['--project', project, '--report', report, '--duration-seconds', '0'],
    ['--project', project, '--report', report, '--cycles', '1.5'], ['--project', project, '--report', report, '--interval-ms', '-1'],
    ['--project', project, '--project', project, '--report', report]]) assert.throws(() => parseOptions(args));
  assert.deepEqual(parseOptions(['--help']), { help: true });
});

test('native soak refuses unmarked or mismatched projects and reports inside the fixture', async t => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'creator-soak-guard-')));
  const project = path.join(parent, 'fixture'), report = path.join(parent, 'reports/result.json');
  await fs.mkdir(project);
  t.after(async () => {
    assert.equal(path.dirname(parent), await fs.realpath(os.tmpdir()));
    assert(path.basename(parent).startsWith('creator-soak-guard-'));
    await fs.rm(parent, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ uuid: 'fixture-one', creator: { version: '3.7.2' } }));
  await assert.rejects(validateFixture(project, report));
  const marker = path.join(project, '.cocos-mcp-test-project.json');
  await fs.writeFile(marker, JSON.stringify({ uuid: 'someone-else', purpose: 'cocos-creator-mcp integration tests' }));
  await assert.rejects(validateFixture(project, report), /identity/u);
  await fs.writeFile(marker, JSON.stringify({ uuid: 'fixture-one', purpose: 'cocos-creator-mcp integration tests' }));
  await assert.rejects(validateFixture(project, path.join(project, 'assets/report.json')), /outside/u);
  assert.equal((await validateFixture(project, report)).creator.version, '3.7.2');
  await fs.writeFile(marker, JSON.stringify({ uuid: 'fixture-one', purpose: 'personal project' }));
  await assert.rejects(validateFixture(project, report), /disposable/u);
});
