// Foreman stage A: work-item schema, SQLite store, one-Foreman lock, and the enqueue paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { TEST_ROOT, orch } from './helpers.mjs';
import { validateItem } from '../src/foreman/schema.mjs';
import { Store } from '../src/foreman/store.mjs';
import { acquireForemanLock, foremanHolder } from '../src/foreman/lock.mjs';
import { addProject, enqueue, parkItem, requeueItem } from '../src/foreman/api.mjs';
import { callTool } from '../src/mcp.mjs';

function tempDir(name) {
  const dir = path.join(TEST_ROOT, `fm-${name}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir], { windowsHide: true });
  return dir;
}

const good = (over = {}) => ({
  project: 'alpha',
  title: 'Add a parser test',
  goal_ref: 'g1',
  handoff: 'TASK: add a test\nFILES YOU MAY EDIT: test/parser.test.mjs',
  allowlist: ['test/parser.test.mjs'],
  acceptance: [{ kind: 'command', argv: ['node', '--test', 'test/parser.test.mjs'] }],
  ...over,
});

function fresh(name) {
  const root = tempDir(name);
  const store = Store.open(root);
  const repo = gitRepo(path.join(root, 'repo'));
  addProject(store, { id: 'alpha', repo }, 'test');
  addProject(store, { id: 'beta', repo }, 'test');
  return { root, store, repo, done: () => { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('schema: a valid item gets its defaults', () => {
  const r = validateItem(good());
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual([r.item.size, r.item.priority, r.item.latency, r.item.domain, r.item.review, r.item.context_budget], ['S', 'P2', 'whenever', 'code', 'full', 32000]);
});

test('schema: an item with no acceptance check is refused, and every problem is listed at once', () => {
  const r = validateItem({ project: 'Bad Project', title: '', handoff: '', allowlist: [], acceptance: [], size: 'XL', surprise: 1 });
  assert.equal(r.ok, false);
  const text = r.errors.join('\n');
  for (const needle of ['acceptance', 'project', 'title', 'handoff', 'allowlist', 'size', 'surprise: unknown field']) assert.match(text, new RegExp(needle), needle);
  assert.equal(validateItem(good({ acceptance: undefined })).ok, false);
});

test('schema: paths must stay inside the repository and commands must be argv arrays', () => {
  for (const allowlist of [['/etc/passwd'], ['C:\\Windows\\x'], ['../outside.txt'], ['a/../../b']]) {
    assert.equal(validateItem(good({ allowlist })).ok, false, JSON.stringify(allowlist));
  }
  for (const argv of ['npm test', [], [''], ['ok', 3]]) {
    assert.equal(validateItem(good({ acceptance: [{ kind: 'command', argv }] })).ok, false, JSON.stringify(argv));
  }
  assert.equal(validateItem(good({ acceptance: [{ kind: 'rubric', text: 'reads clearly' }] })).ok, true);
  assert.equal(validateItem(good({ acceptance: [{ kind: 'rubric' }] })).ok, false);
});

test('store: migrations are versioned, reopening keeps data, and a newer database is refused', () => {
  const { root, store, done } = fresh('migrate');
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 1);
    const item = enqueue(store, good(), 'test');
    store.close();
    const again = Store.open(root);
    assert.equal(again.getItem(item.id).title, 'Add a parser test');
    again.close();
    const raw = new DatabaseSync(path.join(root, 'foreman', 'foreman.db'));
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    assert.throws(() => Store.open(root), /newer than this orch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('store: enqueue needs a registered project, numbers items per project and proposes the goal', () => {
  const { store, done } = fresh('enqueue');
  try {
    assert.throws(() => enqueue(store, good({ project: 'gamma' }), 'test'), /not registered/);
    const a = enqueue(store, good(), 'test');
    const b = enqueue(store, good({ title: 'second' }), 'test');
    const c = enqueue(store, good({ project: 'beta', title: 'other project' }), 'test');
    assert.deepEqual([a.id, b.id, c.id], ['alpha-0001', 'alpha-0002', 'beta-0001']);
    assert.equal(store.listGoals('alpha')[0].status, 'proposed');
    assert.equal(a.spec.handoff.startsWith('TASK:'), true);
    assert.equal(store.events({ item: a.id })[0].actor, 'test');
  } finally {
    done();
  }
});

test('store: only ready items with an approved goal are picked, by priority then project rotation', () => {
  const { store, done } = fresh('pick');
  try {
    const low = enqueue(store, good({ title: 'low', priority: 'P3' }), 'test');
    const a = enqueue(store, good({ title: 'a1', priority: 'P1' }), 'test');
    const a2 = enqueue(store, good({ title: 'a2', priority: 'P1' }), 'test');
    const b = enqueue(store, good({ project: 'beta', title: 'b1', priority: 'P1', goal_ref: 'g2' }), 'test');
    assert.equal(store.pickNext(), null, 'no goal is approved yet');
    store.setGoalStatus('alpha', 'g1', 'approved', 'test');
    assert.equal(store.pickNext().id, a.id, 'P1 beats P3; g2 is still proposed');
    store.setGoalStatus('beta', 'g2', 'approved', 'test');
    store.kvSet('last_project', 'alpha');
    assert.equal(store.pickNext().id, b.id, 'rotation moves to the next project inside the class');
    store.kvSet('last_project', 'beta');
    assert.equal(store.pickNext().id, a.id);
    store.updateItem(a.id, { paused: true }, 'test');
    assert.equal(store.pickNext().id, a2.id, 'a paused item is skipped');
    store.setProjectPaused('alpha', true, 'test');
    assert.equal(store.pickNext().id, b.id, 'a paused project is skipped');
    assert.equal(low.priority, 'P3');
  } finally {
    done();
  }
});

test('store: dependencies block until done; unknown and cross-project dependencies are refused', () => {
  const { store, done } = fresh('deps');
  try {
    store.setGoalStatus('alpha', store.ensureGoal('alpha', 'g1', 'test').id, 'approved', 'test');
    const first = enqueue(store, good({ title: 'contract' }), 'test');
    const second = enqueue(store, good({ title: 'impl', depends_on: [first.id] }), 'test');
    assert.equal(second.state, 'blocked');
    assert.throws(() => enqueue(store, good({ depends_on: ['alpha-0999'] }), 'test'), /no such item/);
    const other = enqueue(store, good({ project: 'beta' }), 'test');
    assert.throws(() => enqueue(store, good({ depends_on: [other.id] }), 'test'), /another project/);
    assert.equal(store.pickNext().id, first.id);
    store.transition(first.id, 'running', { actor: 'test' });
    store.transition(first.id, 'verifying', { actor: 'test' });
    store.transition(first.id, 'done', { actor: 'test' });
    assert.equal(store.getItem(second.id).state, 'ready');
    assert.equal(store.pickNext().id, second.id);
  } finally {
    done();
  }
});

test('store: the transition table is the only authority, parking needs a tag, and every move is audited', () => {
  const { store, done } = fresh('transitions');
  try {
    const item = enqueue(store, good(), 'test');
    assert.throws(() => store.transition(item.id, 'done', { actor: 'test' }), /cannot go from ready to done/);
    assert.throws(() => store.transition(item.id, 'parked', { actor: 'test', reason: 'x' }), /needs a tag/);
    assert.throws(() => store.transition(item.id, 'running', { actor: undefined }), /actor/);
    store.transition(item.id, 'running', { actor: 'foreman', patch: { run_id: 'r1', wp: 'alpha-0001' } });
    assert.throws(() => store.updateItem(item.id, { priority: 'P0' }, 'test'), /edit it after it stops/);
    store.transition(item.id, 'parked', { actor: 'foreman', parkTag: 'timeout', reason: 'no progress' });
    assert.equal(store.getItem(item.id).park_tag, 'timeout');
    assert.throws(() => parkItem(store, item.id, '', 'test'), /needs a reason/);
    const back = requeueItem(store, item.id, 'me');
    assert.equal(back.state, 'ready');
    assert.equal(back.park_tag, null);
    const kinds = store.events({ item: item.id }).map((e) => `${e.kind}:${e.actor}`);
    assert.deepEqual(kinds, ['item-enqueued:test', 'item-running:foreman', 'item-parked:foreman', 'item-ready:me']);
  } finally {
    done();
  }
});

test('store: a failed transaction leaves no half-written state', () => {
  const { store, done } = fresh('atomic');
  try {
    assert.throws(() => store.tx(() => {
      store.event('x', { actor: 'a' });
      throw new Error('boom');
    }), /boom/);
    assert.equal(store.events().length, 2, 'only the two project-added events remain');
  } finally {
    done();
  }
});

test('lock: one Foreman per state root, with the holder named, released at once on close', async () => {
  const root = tempDir('lock');
  try {
    const first = await acquireForemanLock(root);
    await assert.rejects(() => acquireForemanLock(root), (/** @type {any} */ e) => e.code === 'foreman-locked' && e.message.includes(`pid ${process.pid}`));
    const holder = await foremanHolder(root);
    assert.equal(holder.pid, process.pid);
    await first.release();
    assert.equal(await foremanHolder(root), null);
    const second = await acquireForemanLock(root);
    await second.release();
    const other = tempDir('lock2');
    const parallel = await acquireForemanLock(other);
    await parallel.release();
    fs.rmSync(other, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cli and mcp: register a project, enqueue by file and by tool, and see a refusal with every problem', async () => {
  const root = tempDir('cli');
  const env = { ...process.env, ORCH_STATE_ROOT: path.join(root, 'state') };
  try {
    const repo = gitRepo(path.join(root, 'repo'));
    const project = await orch(['foreman', 'project', 'add', '--id', 'alpha', '--repo', repo, '--json'], env);
    assert.equal(project.code, 0, project.stdout + project.stderr);
    const relative = await orch(['foreman', 'project', 'add', '--id', 'rel', '--repo', 'repo'], env);
    assert.notEqual(relative.code, 0, 'a relative repo path is refused');
    const file = path.join(root, 'item.json');
    fs.writeFileSync(file, JSON.stringify(good()));
    const added = await orch(['enqueue', '--file', file, '--json', '--by', 'claude'], env);
    assert.equal(added.code, 0, added.stdout + added.stderr);
    assert.equal(JSON.parse(added.stdout).id, 'alpha-0001');
    const bad = await orch(['enqueue', '--item', JSON.stringify(good({ acceptance: [] })), '--json'], env);
    assert.equal(bad.code, 2);
    assert.match(JSON.parse(bad.stdout).errors.join('\n'), /acceptance/);
    const listed = JSON.parse((await orch(['foreman', 'items', '--json'], env)).stdout);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].state, 'ready');

    const fromTool = await callTool('enqueue', { item: JSON.stringify(good({ title: 'via mcp' })), by: 'claude-mcp' }, { stateRoot: path.join(root, 'state') });
    assert.notEqual(fromTool.isError, true, JSON.stringify(fromTool));
    const status = await callTool('foreman_status', {}, { stateRoot: path.join(root, 'state') });
    assert.match(JSON.stringify(status), /ready/);
    const store = Store.open(path.join(root, 'state'));
    assert.equal(store.getItem('alpha-0002').title, 'via mcp');
    assert.equal(store.events({ item: 'alpha-0002' })[0].actor, 'claude-mcp');
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
