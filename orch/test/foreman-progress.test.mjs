// Foreman stage C: tier-1 signals, tier-2 checks and verdicts, and IGM admission events.
// The rule under test throughout: a signal asks for a check; only a written verdict cancels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TEST_ROOT, makeCase, waitFor, orch } from './helpers.mjs';
import { makeRepo } from './wf-helpers.mjs';
import { Store } from '../src/foreman/store.mjs';
import { Progress, longestRepeat, repeatedFailures, worktreeFingerprint } from '../src/foreman/progress.mjs';
import { IgmClient } from '../src/foreman/igm.mjs';
import { Dispatcher } from '../src/foreman/dispatcher.mjs';
import { makeCall } from '../src/foreman/engine.mjs';
import { addProject, enqueue, answerCheck, requestCheckNow } from '../src/foreman/api.mjs';
import { readSettings, saveSettings } from '../src/foreman/settings.mjs';

const SETTINGS = { actor: 'foreman' };
const baseItem = (over = {}) => ({
  project: 'alpha', title: 'a long task', goal_ref: 'g1', handoff: 'TASK: x', allowlist: ['out.txt'], size: 'XS',
  acceptance: [{ kind: 'command', argv: ['node', '--version'] }], route: { cli: 'fake', model: 'm' }, ...over,
});

function world(t, name) {
  const root = path.join(TEST_ROOT, `fm-${name}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(root, { recursive: true });
  const repo = path.join(root, 'repo');
  makeRepo(repo, { 'README.md': 'r\n' });
  const store = Store.open(root);
  addProject(store, { id: 'alpha', repo }, 'test');
  store.ensureGoal('alpha', 'g1', 'test');
  store.setGoalStatus('alpha', 'g1', 'approved', 'test');
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, repo, store };
}

/** A running item with a run row, a worktree directory and a scripted orch (`call`). */
function running(w, { log = [], size = 'XS' } = {}) {
  const it = enqueue(w.store, baseItem({ size }), 'test');
  const run = w.store.startRun(it.id, { cli: 'fake', model: 'm' }, 'foreman');
  w.store.updateRun(run.id, { run_id: 'run-1', state: 'running', worktree: w.repo });
  const calls = [];
  let logLines = log;
  const call = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'log') return { ok: true, exitCode: 0, out: null, text: logLines.join('\n'), error: null };
    if (argv[0] === 'cancel') return { ok: true, exitCode: 0, out: { cancel_state: 'cancelled' }, text: '', error: null };
    return { ok: true, exitCode: 0, out: null, text: '', error: null };
  };
  return { it, calls, call, setLog: (l) => { logLines = l; }, run: () => w.store.currentRun(it.id) };
}

const view = (status = 'running') => ({ derived_status: status });

test('signals: repeated steps, repeated failing tests, and a worktree fingerprint', () => {
  const steps = ['read file a', 'edit x', 'edit x', 'edit x', 'run tests'];
  assert.equal(longestRepeat(steps).count, 3);
  assert.equal(longestRepeat(['2026-11-23T10:00:00Z tool call 1', '2026-11-23T10:00:05Z tool call 2', '2026-11-23T10:00:09Z tool call 3']).count, 3, 'timestamps and numbers are normalised away');
  const lines = ['✖ parser handles empty (1.2ms)', 'noise', '✖ parser handles empty (1.3ms)', '✖ other test', '✖ parser handles empty (1ms)', '✖ parser handles empty (4ms)'];
  assert.deepEqual(repeatedFailures(lines, 4), [{ name: 'parser handles empty', runs: 4 }]);
  const root = path.join(TEST_ROOT, `fm-fp-${crypto.randomBytes(3).toString('hex')}`);
  makeRepo(root, { 'a.txt': '1\n' });
  try {
    const before = worktreeFingerprint(root);
    assert.equal(worktreeFingerprint(root).hash, before.hash, 'unchanged stays equal');
    fs.writeFileSync(path.join(root, 'b.txt'), 'new');
    assert.notEqual(worktreeFingerprint(root).hash, before.hash, 'an untracked file changes it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tier 1 only asks for a check: a repeating run gets a packet and a pending check, never a cancel', async (t) => {
  const w = world(t, 'tier1');
  const r = running(w, { log: ['step A', 'step A', 'step A', 'step A'] });
  const progress = new Progress({ store: w.store, stateRoot: w.root, call: r.call });
  await progress.observe(w.store.getItem(r.it.id), r.run(), view(), SETTINGS);
  const checks = w.store.listChecks({ item: r.it.id });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'pending');
  assert.equal(checks[0].tier, 2);
  assert.ok(checks[0].signals.some((s) => s.kind === 'repetition'));
  const packet = JSON.parse(fs.readFileSync(checks[0].packet_path, 'utf8'));
  assert.equal(packet.item.id, r.it.id);
  assert.deepEqual(packet.verdicts, ['progressing', 'looping', 'off-track', 'blocked', 'unsure']);
  assert.equal(packet.log_tail.length, 4);
  assert.ok(packet.acceptance.length === 1 && packet.allowlist[0] === 'out.txt');
  assert.equal(r.calls.some((c) => c[0] === 'cancel'), false, 'a signal never cancels');
  assert.equal(w.store.getItem(r.it.id).state, 'running');
  // While a check is pending no second one is requested.
  await progress.observe(w.store.getItem(r.it.id), r.run(), view(), SETTINGS);
  assert.equal(w.store.listChecks({ item: r.it.id }).length, 1);
});

test('tier 2: a quiet run raises no signal and no check; budget milestones fire once each', async (t) => {
  const w = world(t, 'budget');
  const r = running(w, { log: ['reading', 'editing', 'testing'] });
  let now = Date.parse(r.run().started_at);
  const progress = new Progress({ store: w.store, stateRoot: w.root, call: r.call, now: () => now, thresholds: { budgetMinutes: { XS: 10 }, noProgressMinutes: 999 } });
  const observe = () => progress.observe(w.store.getItem(r.it.id), r.run(), view(), SETTINGS);
  now += 2 * 60000;
  await observe();
  assert.equal(w.store.listChecks().length, 0, 'nothing to report at 20% of the budget');
  now += 4 * 60000; // 6 min: past 50%
  await observe();
  assert.equal(w.store.listChecks().length, 1);
  answerCheck(w.store, 1, { verdict: 'progressing', reason: 'tests are advancing' }, 'claude');
  now += 11 * 60000; // 17 min: past 100% and past the gap
  await observe();
  const checks = w.store.listChecks();
  assert.equal(checks.length, 2, 'the 100% milestone');
  assert.equal(checks[1].signals.some((s) => s.kind === 'over-budget'), true);
  assert.equal(r.calls.some((c) => c[0] === 'cancel'), false, 'over budget is a signal, never a cancel');
});

test('verdicts: looping, off-track and blocked cancel with the verdict as the reason; progressing and unsure do not', async (t) => {
  for (const [verdict, tag, expectTag] of [['looping', null, 'capability-wall'], ['off-track', 'scope-violation', 'scope-violation'], ['off-track', null, 'spec-ambiguous'], ['blocked', null, 'needs-input']]) {
    const w = world(t, `verdict-${verdict}`);
    const r = running(w, { log: ['x', 'x', 'x', 'x'] });
    const progress = new Progress({ store: w.store, stateRoot: w.root, call: r.call });
    await progress.observe(w.store.getItem(r.it.id), r.run(), view(), SETTINGS);
    answerCheck(w.store, 1, { verdict, reason: `because ${verdict}`, tag }, 'claude');
    await progress.observe(w.store.getItem(r.it.id), r.run(), view(), SETTINGS);
    assert.deepEqual(r.calls.filter((c) => c[0] === 'cancel'), [['cancel', 'run-1']]);
    const parked = JSON.parse(w.store.kvGet(`park:${r.it.id}`));
    assert.equal(parked.tag, expectTag, `${verdict}/${tag}`);
    assert.match(parked.reason, new RegExp(`verdict ${verdict}: because ${verdict}`));
    const ev = w.store.events({ item: r.it.id }).find((e) => e.kind === 'cancel-requested');
    assert.equal(ev.data.reason, parked.reason, 'the cancel records the verdict');
    await progress.observe(w.store.getItem(r.it.id), r.run(), view(), SETTINGS);
    assert.equal(r.calls.filter((c) => c[0] === 'cancel').length, 1, 'a verdict is applied exactly once');
  }
  const w = world(t, 'verdict-soft');
  const r = running(w, { log: ['x', 'x', 'x', 'x'] });
  const progress = new Progress({ store: w.store, stateRoot: w.root, call: r.call });
  await progress.observe(w.store.getItem(r.it.id), r.run(), view(), SETTINGS);
  answerCheck(w.store, 1, { verdict: 'unsure', reason: 'cannot tell' }, 'claude');
  await progress.observe(w.store.getItem(r.it.id), r.run(), view(), SETTINGS);
  assert.equal(r.calls.some((c) => c[0] === 'cancel'), false);
  assert.throws(() => answerCheck(w.store, 1, { verdict: 'progressing', reason: 'again' }, 'claude'), /already answered/);
  assert.throws(() => answerCheck(w.store, 1, { verdict: 'maybe', reason: 'x' }, 'claude'), /verdict must be one of/);
  assert.throws(() => answerCheck(w.store, 99, { verdict: 'looping', reason: 'x' }, 'claude'), /no such check/);
});

test('tier 2 budget: after the allowed number of checks the next alarm parks instead of buying another', async (t) => {
  const w = world(t, 'cap');
  const r = running(w, { log: ['x', 'x', 'x', 'x'] });
  let now = Date.parse(r.run().started_at);
  const progress = new Progress({ store: w.store, stateRoot: w.root, call: r.call, now: () => now, thresholds: { tier2Max: 2, tier2MinGapMinutes: 1 } });
  for (let i = 1; i <= 2; i++) {
    now += 2 * 60000;
    await progress.observe(w.store.getItem(r.it.id), r.run(), view(), SETTINGS);
    answerCheck(w.store, i, { verdict: 'progressing', reason: 'ok' }, 'claude');
    await progress.observe(w.store.getItem(r.it.id), r.run(), view(), SETTINGS);
  }
  assert.equal(w.store.listChecks().length, 2);
  now += 2 * 60000;
  await progress.observe(w.store.getItem(r.it.id), r.run(), view(), SETTINGS);
  assert.equal(w.store.listChecks().length, 2, 'no third check');
  assert.equal(JSON.parse(w.store.kvGet(`park:${r.it.id}`)).tag, 'timeout');
  assert.deepEqual(r.calls.filter((c) => c[0] === 'cancel'), [['cancel', 'run-1']]);
});

test('an executor can answer a packet at once, and a person can ask for a check now', async (t) => {
  const w = world(t, 'executor');
  const r = running(w, { log: ['x', 'x', 'x', 'x'] });
  const seen = [];
  const progress = new Progress({ store: w.store, stateRoot: w.root, call: r.call, executor: async (packet, ctx) => { seen.push([packet.item.id, ctx.checkId]); return { verdict: 'progressing', reason: 'executor says fine', executor: 'fake' }; } });
  await progress.observe(w.store.getItem(r.it.id), r.run(), view(), SETTINGS);
  assert.deepEqual(seen, [[r.it.id, 1]]);
  assert.equal(w.store.getCheck(1).status, 'done');
  assert.equal(w.store.getCheck(1).executor, 'fake');

  const quiet = world(t, 'check-now');
  const q = running(quiet, { log: ['fine'] });
  const p2 = new Progress({ store: quiet.store, stateRoot: quiet.root, call: q.call });
  await p2.observe(quiet.store.getItem(q.it.id), q.run(), view(), SETTINGS);
  assert.equal(quiet.store.listChecks().length, 0);
  requestCheckNow(quiet.store, q.it.id, 'owner-gui');
  await p2.observe(quiet.store.getItem(q.it.id), q.run(), view(), SETTINGS);
  assert.equal(quiet.store.listChecks().length, 1);
  assert.match(JSON.stringify(quiet.store.getCheck(1)), /requested by owner-gui|packet/);
  assert.throws(() => requestCheckNow(quiet.store, 'alpha-9999', 'x'), /no such item/);
});

function igmServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, auth: req.headers.authorization });
      const body = handler(req.url);
      res.writeHead(body ? 200 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body || {}));
    }).listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` }));
  });
}

test('igm: the event cursor and boot id are kept, only orch clients count, an abort asks for an immediate check', async (t) => {
  const w = world(t, 'igm');
  const KEY = 'secret-control-key-123';
  let boot = 'boot-a';
  const events = [
    { seq: 1, action: 'batch_paused', client: null, actor: 'browser-1' },
    { seq: 2, action: 'queue_timeout', client: 'orch/run-1', priority: 'batch' },
    { seq: 3, action: 'aborted_by_operator', client: 'orch/run-1', reason: 'wrong model', actor: 'browser-1' },
    { seq: 4, action: 'aborted_by_operator', client: 'me', reason: 'mine', actor: 'browser-1' },
  ];
  const srv = await igmServer((url) => {
    const after = Number(new URL(url, 'http://x').searchParams.get('after'));
    return { boot_id: boot, next: events.at(-1).seq, oldest: 1, events: events.filter((e) => e.seq > after) };
  });
  t.after(() => srv.server.close());
  const client = new IgmClient({ baseUrl: srv.url, env: { IGM_CONTROL_KEY: KEY } });
  const breaker = await client.eventsFor('run-1', w.store, 'foreman', 'alpha-0001');
  assert.equal(breaker.action, 'aborted_by_operator');
  assert.equal(breaker.reason, 'wrong model');
  assert.equal(srv.requests[0].auth, `Bearer ${KEY}`);
  const recorded = w.store.events().filter((e) => e.kind === 'igm-event');
  assert.deepEqual(recorded.map((e) => e.data.action), ['queue_timeout', 'aborted_by_operator'], 'the other client and the gateway-wide event are not recorded');
  assert.equal(w.store.kvGet('igm_cursor'), '4');
  assert.equal(await client.eventsFor('run-1', w.store, 'foreman', 'alpha-0001'), null, 'events are consumed once');
  // The key is never written to the store.
  const dump = JSON.stringify(w.store.db.prepare('SELECT * FROM kv').all()) + JSON.stringify(w.store.events());
  assert.equal(dump.includes(KEY), false);

  // A restart of the gateway resets its sequence: the new log is read from the start.
  boot = 'boot-b';
  events.length = 0;
  events.push({ seq: 1, action: 'dropped_by_operator', client: 'orch/run-2', reason: 'stale', actor: 'browser-2' });
  client.lastPoll = 0;
  const after = await client.eventsFor('run-2', w.store, 'foreman', 'alpha-0001');
  assert.equal(after.action, 'dropped_by_operator');
  assert.equal(w.store.kvGet('igm_boot'), 'boot-b');
});

test('igm: an unreachable gateway or a missing key never breaks a tick and is reported once', async (t) => {
  const w = world(t, 'igm-down');
  const noKey = new IgmClient({ baseUrl: 'http://127.0.0.1:1', env: {} });
  assert.equal(await noKey.eventsFor('run-1', w.store, 'foreman', 'alpha-0001'), null);
  noKey.lastPoll = 0;
  assert.equal(await noKey.eventsFor('run-1', w.store, 'foreman', 'alpha-0001'), null);
  assert.equal(w.store.events().filter((e) => e.kind === 'igm-unavailable').length, 1);
  const down = new IgmClient({ baseUrl: 'http://127.0.0.1:1', env: { IGM_CONTROL_KEY: 'k' }, timeoutMs: 500 });
  assert.equal(await down.eventsFor('run-1', w.store, 'foreman', 'alpha-0001'), null);
});

test('progress and igm together: an operator abort triggers an immediate check', async (t) => {
  const w = world(t, 'igm-trigger');
  const r = running(w, { log: ['working'] });
  const srv = await igmServer(() => ({ boot_id: 'b', next: 1, events: [{ seq: 1, action: 'aborted_by_operator', client: 'orch/run-1', reason: 'wrong model', actor: 'browser-9' }] }));
  t.after(() => srv.server.close());
  const igm = new IgmClient({ baseUrl: srv.url, env: { IGM_CONTROL_KEY: 'k' } });
  const progress = new Progress({ store: w.store, stateRoot: w.root, call: r.call, igm });
  await progress.observe(w.store.getItem(r.it.id), r.run(), view(), SETTINGS);
  const check = w.store.getCheck(1);
  assert.ok(check, 'a check was requested at once');
  assert.match(w.store.events({ item: r.it.id }).find((e) => e.kind === 'check-requested').data.reasons.join(), /operator aborted/);
  assert.equal(r.calls.some((c) => c[0] === 'cancel'), false, 'an abort never cancels the run by itself');
});

// ---- end to end with orch's fake worker ------------------------------------------------------

function liveSetup(t, name, flags) {
  const c = makeCase(name);
  const saved = {};
  for (const key of ['ORCH_STATE_ROOT', 'ORCH_LANE_ID', 'ORCH_ALLOW_FAKE', 'ORCH_FAKE_WORKER']) { saved[key] = process.env[key]; process.env[key] = c.env[key]; }
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n' });
  const store = Store.open(c.stateRoot);
  addProject(store, { id: 'alpha', repo }, 'test');
  store.ensureGoal('alpha', 'g1', 'test');
  store.setGoalStatus('alpha', 'g1', 'approved', 'test');
  const it = enqueue(store, baseItem({ route: { cli: 'fake', model: 'localai/qwen3-coder-30b', flags } }), 'test');
  t.after(() => {
    store.close();
    c.cleanup();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  return { c, store, it, call: makeCall(c.stateRoot) };
}

test('end to end: a long run raises a check, a looping verdict cancels it and parks the item with the reason', { timeout: 150000 }, async (t) => {
  const L = liveSetup(t, 'fm-e2e-loop', ['--write-file', 'out.txt', '--hold', '60']);
  const verdicts = [];
  const progress = new Progress({ store: L.store, stateRoot: L.c.stateRoot, call: L.call, thresholds: { budgetMinutes: { XS: 0.03 }, tier2MinGapMinutes: 0 },
    executor: async (packet) => { verdicts.push(packet.reasons); return { verdict: 'looping', reason: 'same step again and again', executor: 'test-executor' }; } });
  const d = new Dispatcher({ store: L.store, stateRoot: L.c.stateRoot, call: L.call, progress });
  const parked = await waitFor(async () => { await d.tick(); const i = L.store.getItem(L.it.id); return i.state === 'parked' ? i : null; }, { timeoutMs: 120000, intervalMs: 500, what: 'the looping run to be parked' });
  assert.equal(parked.park_tag, 'capability-wall');
  assert.match(parked.park_reason, /verdict looping: same step again and again/);
  assert.ok(verdicts.length >= 1 && verdicts[0].some((r) => /budget/.test(r)));
  const status = await L.call(['status', L.store.currentRun(L.it.id).run_id]);
  assert.equal(status.out.runs[0].derived_status, 'cancelled');
  const kinds = L.store.events({ item: L.it.id }).map((e) => e.kind);
  for (const k of ['check-requested', 'cancel-requested', 'item-parked']) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
  assert.equal(kinds.indexOf('check-requested') < kinds.indexOf('cancel-requested'), true, 'no cancel before a verdict was asked for');
});

test('end to end: a pending check is answered from the CLI, a progressing verdict lets the run finish', { timeout: 150000 }, async (t) => {
  const L = liveSetup(t, 'fm-e2e-progress', ['--write-file', 'out.txt', '--hold', '3']);
  const progress = new Progress({ store: L.store, stateRoot: L.c.stateRoot, call: L.call, thresholds: { budgetMinutes: { XS: 0.03 } } });
  const d = new Dispatcher({ store: L.store, stateRoot: L.c.stateRoot, call: L.call, progress });
  await waitFor(async () => { await d.tick(); return L.store.listChecks({ status: 'pending' }).length > 0 || null; }, { timeoutMs: 60000, intervalMs: 400, what: 'a pending check' });
  const pending = L.store.listChecks({ status: 'pending' })[0];
  const answer = await orch(['foreman', 'verdict', String(pending.id), '--verdict', 'progressing', '--reason', 'file is being written', '--by', 'claude-code', '--json'], { ...process.env, ORCH_STATE_ROOT: L.c.stateRoot });
  assert.equal(answer.code, 0, answer.stdout + answer.stderr);
  const done = await waitFor(async () => { await d.tick(); const i = L.store.getItem(L.it.id); return ['needs-review', 'parked'].includes(i.state) ? i : null; }, { timeoutMs: 90000, intervalMs: 500, what: 'the item to finish' });
  assert.equal(done.state, 'needs-review', done.park_reason);
  assert.equal(L.store.getCheck(pending.id).applied, 1);
});

test('settings: the progress thresholds and gateway URL are stored live and the key is not a setting', () => {
  const root = path.join(TEST_ROOT, `fm-settings-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(root, { recursive: true });
  const store = Store.open(root);
  try {
    saveSettings(store, { igmUrl: 'http://gateway.example:9000', progress: { noProgressMinutes: 5 } }, 'test');
    const s = readSettings(store);
    assert.equal(s.igmUrl, 'http://gateway.example:9000');
    assert.equal(s.igmKeyEnv, 'IGM_CONTROL_KEY');
    assert.throws(() => saveSettings(store, { igmKey: 'abc' }, 'test'), /unknown Foreman setting/);
    assert.equal(store.getSetting('foreman').version, 1);
    void execFileSync;
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
