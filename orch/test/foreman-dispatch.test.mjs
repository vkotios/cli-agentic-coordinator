// Foreman stage B: the dispatcher end to end with orch's fake worker in temporary repositories.
// The pilot repositories are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeCase, waitFor, TEST_ROOT } from './helpers.mjs';
import { makeRepo } from './wf-helpers.mjs';
import { Store } from '../src/foreman/store.mjs';
import { Dispatcher } from '../src/foreman/dispatcher.mjs';
import { makeCall } from '../src/foreman/engine.mjs';
import { addProject, enqueue } from '../src/foreman/api.mjs';
import { saveSettings } from '../src/foreman/settings.mjs';

const NODE_OK = ['node', '-e', "process.exit(require('fs').existsSync('out.txt') ? 0 : 1)"];

function item(over = {}) {
  return {
    project: 'alpha',
    title: 'write out.txt',
    goal_ref: 'g1',
    handoff: 'TASK: create out.txt\nFILES YOU MAY EDIT: out.txt',
    allowlist: ['out.txt'],
    acceptance: [{ kind: 'command', argv: NODE_OK }],
    size: 'XS',
    route: { cli: 'fake', model: 'localai/qwen3-coder-30b', flags: ['--write-file', 'out.txt'] },
    ...over,
  };
}

/** A case with its own repo, store, and the fake worker wired into this process's environment. */
function setup(t, name, /** @type {{settings?: any}} */ { settings } = {}) {
  const c = makeCase(name);
  const saved = {};
  for (const key of ['ORCH_STATE_ROOT', 'ORCH_LANE_ID', 'ORCH_ALLOW_FAKE', 'ORCH_FAKE_WORKER']) {
    saved[key] = process.env[key];
    process.env[key] = c.env[key];
  }
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n' });
  const store = Store.open(c.stateRoot);
  addProject(store, { id: 'alpha', repo }, 'test');
  store.ensureGoal('alpha', 'g1', 'test');
  store.setGoalStatus('alpha', 'g1', 'approved', 'test');
  if (settings) saveSettings(store, settings, 'test');
  const call = makeCall(c.stateRoot);
  const make = (extra = {}) => new Dispatcher({ store, stateRoot: c.stateRoot, call, ...extra });
  t.after(() => {
    store.close();
    c.cleanup();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  return { c, repo, store, call, make };
}

async function drive(dispatcher, store, id, states, timeoutMs = 90000) {
  return waitFor(async () => {
    await dispatcher.tick();
    const current = store.getItem(id);
    return states.includes(current.state) ? current : null;
  }, { timeoutMs, intervalMs: 300, what: `${id} to reach ${states.join('/')}` });
}

test('dispatcher: a ready item runs to needs-review with its worktree kept and its claim released', { timeout: 150000 }, async (t) => {
  const { store, call, make } = setup(t, 'fm-ok');
  const it = enqueue(store, item(), 'test');
  const d = make();
  const done = await drive(d, store, it.id, ['needs-review', 'parked']);
  assert.equal(done.state, 'needs-review', done.park_reason);
  const run = store.currentRun(it.id);
  assert.equal(run.state, 'finished');
  assert.equal(done.attempt, 1);
  assert.ok(fs.existsSync(path.join(run.worktree, 'out.txt')), 'the worker wrote its file in the worktree');
  assert.ok(fs.existsSync(run.worktree), 'the worktree is retained for review');
  const claims = await call(['claims']);
  assert.equal(claims.ok, true, claims.text);
  const list = Array.isArray(claims.out) ? claims.out : claims.out?.claims;
  assert.ok(Array.isArray(list), `claims output shape: ${claims.text}`);
  assert.equal(list.length, 0, 'the claim was released');
  const kinds = store.events({ item: it.id }).map((e) => e.kind);
  for (const k of ['item-enqueued', 'item-running', 'launched', 'item-verifying', 'acceptance', 'scope', 'item-needs-review']) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
  assert.equal(store.events({ item: it.id }).find((e) => e.kind === 'launched').actor, 'foreman');
});

test('dispatcher: failures park the item with the right tag and a reason', { timeout: 300000 }, async (t) => {
  const { store, make } = setup(t, 'fm-park');
  const failedWorker = enqueue(store, item({ title: 'worker fails', route: { cli: 'fake', model: 'localai/qwen3-coder-30b', flags: ['--exit', '1'] } }), 'test');
  const badCheck = enqueue(store, item({ title: 'check fails', route: { cli: 'fake', model: 'localai/qwen3-coder-30b', flags: ['--write-file', 'out.txt'] }, acceptance: [{ kind: 'command', argv: ['node', '-e', 'process.exit(7)'] }] }), 'test');
  const outside = enqueue(store, item({ title: 'writes outside the allowlist', route: { cli: 'fake', model: 'localai/qwen3-coder-30b', flags: ['--write-file', 'intruder.txt'] }, acceptance: [{ kind: 'command', argv: ['node', '--version'] }] }), 'test');
  const noRoute = enqueue(store, item({ title: 'no route', route: undefined }), 'test');
  const d = make();
  const a = await drive(d, store, failedWorker.id, ['parked', 'needs-review']);
  assert.equal(a.state, 'parked');
  assert.equal(a.park_tag, 'capability-wall');
  assert.match(a.park_reason, /ended failed/);
  const b = await drive(d, store, badCheck.id, ['parked', 'needs-review']);
  assert.equal(b.park_tag, 'check-failed');
  assert.match(b.park_reason, /acceptance check 1 .* exited 7/);
  const c2 = await drive(d, store, outside.id, ['parked', 'needs-review']);
  assert.equal(c2.park_tag, 'scope-violation');
  assert.match(c2.park_reason, /intruder\.txt/);
  const e = await drive(d, store, noRoute.id, ['parked', 'needs-review']);
  assert.equal(e.park_tag, 'needs-input');
  assert.match(e.park_reason, /no route/);
});

test('dispatcher: a default route covers an item with none, and an item without an approved goal never starts', { timeout: 150000 }, async (t) => {
  const { store, make } = setup(t, 'fm-default', { settings: { defaultRoute: { cli: 'fake', model: 'localai/qwen3-coder-30b', flags: ['--write-file', 'out.txt'] } } });
  const ungoaled = enqueue(store, item({ title: 'proposed goal only', goal_ref: 'g-unapproved', route: undefined }), 'test');
  const ok = enqueue(store, item({ title: 'uses the default route', route: undefined }), 'test');
  const d = make();
  const finished = await drive(d, store, ok.id, ['needs-review', 'parked']);
  assert.equal(finished.state, 'needs-review', finished.park_reason);
  assert.equal(store.getItem(ungoaled.id).state, 'ready', 'a proposed goal is not enough to run');
});

test('dispatcher: pause stops launches but still watches a running item; resume starts again', { timeout: 150000 }, async (t) => {
  const { store, make } = setup(t, 'fm-pause');
  const first = enqueue(store, item({ title: 'first', route: { cli: 'fake', model: 'localai/qwen3-coder-30b', flags: ['--write-file', 'out.txt', '--hold', '4'] } }), 'test');
  const second = enqueue(store, item({ title: 'second' }), 'test');
  const d = make();
  await d.tick();
  assert.equal(store.getItem(first.id).state, 'running');
  saveSettings(store, { paused: true }, 'test');
  await drive(d, store, first.id, ['needs-review', 'parked']);
  assert.equal(store.getItem(first.id).state, 'needs-review', 'a running item is still watched while paused');
  await d.tick();
  assert.equal(store.getItem(second.id).state, 'ready', 'nothing new starts while paused');
  saveSettings(store, { paused: false }, 'test');
  const done = await drive(d, store, second.id, ['needs-review', 'parked']);
  assert.equal(done.state, 'needs-review');
});

test('dispatcher: a new Foreman picks up a running item from the store and orch records after a restart', { timeout: 150000 }, async (t) => {
  const { store, make } = setup(t, 'fm-restart');
  const it = enqueue(store, item({ route: { cli: 'fake', model: 'localai/qwen3-coder-30b', flags: ['--write-file', 'out.txt', '--hold', '3'] } }), 'test');
  await make().tick();
  assert.equal(store.getItem(it.id).state, 'running');
  const restarted = make(); // a different instance: nothing is carried over in memory
  const done = await drive(restarted, store, it.id, ['needs-review', 'parked']);
  assert.equal(done.state, 'needs-review', done.park_reason);
});

test('dispatcher: an interrupted launch is parked for inspection, never retried', { timeout: 60000 }, async (t) => {
  const { store, make } = setup(t, 'fm-interrupted');
  const it = enqueue(store, item(), 'test');
  store.startRun(it.id, { cli: 'fake', model: 'm' }, 'foreman'); // the process died right here
  await make().tick();
  const after = store.getItem(it.id);
  assert.equal(after.state, 'parked');
  assert.equal(after.park_tag, 'needs-input');
  assert.match(after.park_reason, /launch interrupted/);
  assert.equal(store.currentRun(it.id).state, 'abandoned');
});

test('dispatcher: a serial lane with no free permit leaves the item ready; concurrency is capped', { timeout: 60000 }, async (t) => {
  const { store, make } = setup(t, 'fm-lane');
  const it = enqueue(store, item(), 'test');
  let free = 0;
  const d = make({ occupancy: async () => ({ serial: true, total: 1, free, used: 1 - free, permits: [] }) });
  await d.tick();
  assert.equal(store.getItem(it.id).state, 'ready', 'no permit: the item waits, it is not an error');
  assert.equal(store.currentRun(it.id), null);
  free = 1;
  const done = await drive(d, store, it.id, ['needs-review', 'parked']);
  assert.equal(done.state, 'needs-review', done.park_reason);

  const a = enqueue(store, item({ title: 'a', route: { cli: 'fake', model: 'localai/qwen3-coder-30b', flags: ['--write-file', 'out.txt', '--hold', '3'] } }), 'test');
  const b = enqueue(store, item({ title: 'b' }), 'test');
  await d.tick();
  await d.tick();
  assert.equal(store.getItem(a.id).state, 'running');
  assert.equal(store.getItem(b.id).state, 'ready', 'maxConcurrent 1: the second waits');
  await drive(d, store, b.id, ['needs-review', 'parked']);
});

test('dispatcher: a scope violation parks the item before any acceptance command runs', { timeout: 120000 }, async (t) => {
  const { c, store, make } = setup(t, 'fm-scope-first');
  const marker = path.join(c.base, 'acceptance-ran.txt');
  const it = enqueue(store, item({
    title: 'writes outside the allowlist',
    route: { cli: 'fake', model: 'localai/qwen3-coder-30b', flags: ['--write-file', 'intruder.txt'] },
    acceptance: [{ kind: 'command', argv: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] }],
  }), 'test');
  const parked = await drive(make(), store, it.id, ['parked', 'needs-review']);
  assert.equal(parked.park_tag, 'scope-violation');
  assert.equal(fs.existsSync(marker), false, 'no acceptance command ran for a worker that left its allowlist');
  assert.equal(store.events({ item: it.id }).some((e) => e.kind === 'acceptance'), false);
});

test('acceptance: the process gets a reduced environment and never resolves programs inside the worktree', { timeout: 60000 }, async (t) => {
  const { runCheck, safeEnv, resolveExecutable } = await import('../src/foreman/acceptance.mjs');
  const root = path.join(TEST_ROOT, `fm-env-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secrets = { IGM_CONTROL_KEY: 'control-secret', IGM_INFERENCE_KEY: 'inference-secret', OPENAI_API_KEY: 'sk-test', ORCH_FAKE_WORKER: 'x' };
  Object.assign(process.env, secrets);
  t.after(() => { for (const k of Object.keys(secrets)) delete process.env[k]; });
  assert.deepEqual(Object.keys(safeEnv()).filter((k) => k in secrets), []);

  const logFile = path.join(root, 'env.log');
  const r = await runCheck({ kind: 'command', argv: ['node', '-e', 'console.log(JSON.stringify(Object.keys(process.env)))'] }, { root, logFile, defaultTimeoutS: 30, maxLogBytes: 100000 });
  assert.equal(r.status, 'pass', JSON.stringify(r));
  const seen = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
  for (const k of Object.keys(secrets)) assert.equal(seen.includes(k), false, `${k} must not reach acceptance code`);

  // A planted program with a bare-name match in the worktree is never used.
  const planted = process.platform === 'win32' ? 'node.cmd' : 'node';
  const body = process.platform === 'win32' ? ['@echo planted>planted.txt', ''].join(String.fromCharCode(13, 10)) : ['#!/bin/sh', 'echo planted > planted.txt', ''].join(String.fromCharCode(10));
  fs.writeFileSync(path.join(root, planted), body, { mode: 0o755 });
  const resolved = resolveExecutable('node', root);
  assert.ok(resolved && !resolved.startsWith(root), `resolved to ${resolved}`);
  const second = await runCheck({ kind: 'command', argv: ['node', '--version'] }, { root, logFile: path.join(root, 'v.log'), defaultTimeoutS: 30, maxLogBytes: 1000 });
  assert.equal(second.status, 'pass');
  assert.equal(fs.existsSync(path.join(root, 'planted.txt')), false, 'the planted program was not run');
  assert.equal(resolveExecutable('definitely-not-a-program-xyz', root), null);
  assert.equal(resolveExecutable('../outside', root), null, 'a path leaving the worktree is refused');
});

test('dispatcher: adapter flags are refused for real adapters', { timeout: 60000 }, async (t) => {
  const { store, make } = setup(t, 'fm-flags');
  const it = enqueue(store, item({ route: { cli: 'codex', model: 'gpt-x', flags: ['--dangerously-bypass-approvals-and-sandbox'] } }), 'test');
  await make().tick();
  const parked = store.getItem(it.id);
  assert.equal(parked.state, 'parked');
  assert.match(parked.park_reason, /only accepted for the test adapter/);
});
