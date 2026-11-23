// Control-plane GUI server: sign-in, CSRF, Host and Origin checks, the LAN-needs-a-password rule,
// the audit trail, and the actions behind each screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { TEST_ROOT, makeCase, orch, idFrom, waitFor } from './helpers.mjs';
import { makeRepo } from './wf-helpers.mjs';
import { Store } from '../src/foreman/store.mjs';
import { startGui } from '../src/gui/server.mjs';
import { setPassword, hasPassword } from '../src/gui/auth.mjs';
import { addProject } from '../src/foreman/api.mjs';

const PASSWORD = 'a sufficiently long test password';

function stateDir(name) {
  const root = path.join(TEST_ROOT, `fm-gui-${name}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

async function withGui(t, name, /** @type {{password?: boolean, setup?: (root: string) => Promise<void>}} */ { password = true, setup } = {}) {
  const root = stateDir(name);
  const saved = process.env.ORCH_STATE_ROOT;
  process.env.ORCH_STATE_ROOT = root;
  if (password) await setPassword(root, PASSWORD);
  const repo = path.join(root, 'repo');
  makeRepo(repo, { 'README.md': 'r\n' });
  const store = Store.open(root);
  addProject(store, { id: 'alpha', repo }, 'test');
  store.close();
  if (setup) await setup(root);
  const gui = await startGui({ stateRoot: root, host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await gui.close();
    if (saved === undefined) delete process.env.ORCH_STATE_ROOT; else process.env.ORCH_STATE_ROOT = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${gui.port}`;
  return { root, gui, base, repo };
}

/** A tiny browser: keeps the cookie, sends the CSRF header on mutations. */
function browser(base) {
  let cookie = '';
  let csrf = '';
  const request = async (method, url, body, extra = {}) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {}), ...extra };
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set[0].split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers, set };
  };
  return {
    request,
    get: (u) => request('GET', u),
    post: (u, b = {}, h) => request('POST', u, b, h),
    async login(password = PASSWORD) {
      const r = await request('POST', '/api/auth/login', { password });
      if (r.status === 200) csrf = r.json.csrf_token;
      return r;
    },
    cookie: () => cookie,
  };
}

const goodItem = (over = {}) => ({
  project: 'alpha', title: 'a task', goal_ref: 'g1', handoff: 'TASK: x', allowlist: ['out.txt'], size: 'XS',
  acceptance: [{ kind: 'command', argv: ['node', '--version'] }], ...over,
});

test('gui: a LAN address is never served without a password, loopback may be', async (t) => {
  const root = stateDir('lan');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(() => startGui({ stateRoot: root, host: '0.0.0.0', port: 0 }), (/** @type {any} */ e) => e.code === 'gui-no-password');
  assert.equal(hasPassword(root), false);
  const open = await startGui({ stateRoot: root, host: '127.0.0.1', port: 0 });
  const r = await fetch(`http://127.0.0.1:${open.port}/api/overview`);
  assert.equal(r.status, 200, 'loopback with no password is open to this machine');
  await open.close();
  assert.throws(() => { throw new Error('x'); });
  await assert.rejects(() => setPassword(root, 'short'), /at least 12/);
});

test('gui sign-in: password, cookie flags, CSRF, Host, Origin and the rate limit', async (t) => {
  const { base, root } = await withGui(t, 'auth');
  const b = browser(base);
  assert.equal((await b.get('/api/overview')).status, 401, 'no session, no data');
  assert.equal((await b.post('/api/auth/login', { password: 'wrong wrong wrong' })).status, 401);
  const ok = await b.login();
  assert.equal(ok.status, 200);
  const cookie = ok.set[0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(fs.readFileSync(path.join(root, 'gui', 'auth.json'), 'utf8').includes(PASSWORD), false, 'only a hash is stored');
  assert.equal((await b.get('/api/overview')).status, 200);

  const noCsrf = await fetch(base + '/api/foreman/pause', { method: 'POST', headers: { cookie: b.cookie(), 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403, 'a mutation without the CSRF token is refused');
  const wrongOrigin = await b.post('/api/foreman/pause', {}, { origin: 'http://evil.example' });
  assert.equal(wrongOrigin.status, 403);
  const wrongType = await fetch(base + '/api/foreman/pause', { method: 'POST', headers: { cookie: b.cookie(), 'content-type': 'text/plain', 'x-csrf-token': (await b.get('/api/auth/session')).json.csrf_token }, body: '{}' });
  assert.equal(wrongType.status, 415);
  // fetch cannot set Host, so use a raw request: an unknown Host is refused (DNS rebinding).
  const rebound = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/overview', { headers: { cookie: b.cookie(), host: 'evil.example' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(rebound, 403, 'an unknown Host is refused (DNS rebinding)');

  assert.equal((await b.post('/api/auth/logout')).status, 200);
  assert.equal((await b.get('/api/overview')).status, 401, 'the session is gone');

  const attacker = browser(base);
  let last;
  for (let i = 0; i < 6; i++) last = await attacker.post('/api/auth/login', { password: `nope nope nope ${i}` });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.equal((await attacker.post('/api/auth/login', { password: PASSWORD })).status, 429, 'even the right password waits');
});

test('gui static pages: security headers, a fixed file list and no traversal', async (t) => {
  const { base } = await withGui(t, 'static');
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /orch control plane/);
  for (const p of ['/app.js', '/style.css', '/favicon.svg']) assert.equal((await fetch(base + p)).status, 200, p);
  for (const p of ['/../package.json', '/..%2fpackage.json', '/package.json', '/gui/app.js', '/%2e%2e/src/config.mjs']) assert.equal((await fetch(base + p)).status, 404, p);
});

test('gui actions: add an item, approve a goal, park with a reason, and every action is audited with the session', async (t) => {
  const { base, root } = await withGui(t, 'actions');
  const b = browser(base);
  const session = (await b.login()).json.session_id;

  const refused = await b.post('/api/items', goodItem({ acceptance: [] }));
  assert.equal(refused.status, 422);
  assert.match(refused.json.details.join(), /acceptance/);
  const created = await b.post('/api/items', goodItem());
  assert.equal(created.status, 200, created.text);
  assert.equal(created.json.id, 'alpha-0001');
  assert.equal(created.json.spec, undefined, 'the list view does not carry the whole spec');
  assert.equal((await b.get('/api/items')).json.items.length, 1);
  const detail = (await b.get('/api/items/alpha-0001')).json;
  assert.equal(detail.item.spec.handoff, 'TASK: x');
  assert.equal(detail.events[0].kind, 'item-enqueued');

  const overview = (await b.get('/api/overview')).json;
  assert.equal(overview.counts.ready, 1);
  assert.equal(overview.goals[0].status, 'proposed');
  assert.equal((await b.post('/api/goals/alpha/g1/approve')).json.status, 'approved');

  assert.equal((await b.post('/api/items/alpha-0001/park', {})).status, 400, 'parking needs a reason');
  const parked = await b.post('/api/items/alpha-0001/park', { reason: 'wrong approach' });
  assert.equal(parked.json.state, 'parked');
  assert.equal(parked.json.park_tag, 'operator');
  assert.equal((await b.post('/api/items/alpha-0001/requeue')).json.state, 'ready');
  assert.equal((await b.post('/api/items/alpha-0001/edit', { priority: 'P0' })).json.priority, 'P0');
  assert.equal((await b.post('/api/items/alpha-0001/edit', { priority: 'P9' })).status, 409);
  assert.equal((await b.post('/api/projects/alpha/pause')).json.paused, true);
  assert.equal((await b.post('/api/foreman/pause')).json.paused, true);
  assert.equal((await b.get('/api/overview')).json.foreman.paused, true);

  const store = Store.open(root);
  const gui = store.events().filter((e) => e.kind === 'gui-action');
  store.close();
  assert.ok(gui.length >= 6);
  for (const e of gui) assert.equal(e.actor, `gui:${session}`, 'every GUI action names the browser session');
  assert.ok(gui.some((e) => e.data.action === 'park' && e.data.reason === 'wrong approach'));
  const audit = (await b.get('/api/audit')).json.actions;
  assert.ok(audit.length >= 6 && audit.every((e) => e.kind === 'gui-action'));
});

test('gui verdicts, claims and cleanup preview go through orch', async (t) => {
  const { base, root } = await withGui(t, 'orchcalls');
  const b = browser(base);
  await b.login();

  assert.equal((await b.post('/api/checks/99/verdict', { verdict: 'looping', reason: 'x' })).status, 409);
  assert.equal((await b.post('/api/claims', { wp: 'WP-GUI', by: 'owner' })).status, 200);
  const held = (await b.get('/api/claims')).json.claims;
  assert.ok(held.some((c) => c.wp === 'WP-GUI' && c.by === 'owner'), JSON.stringify(held));
  assert.equal((await b.post('/api/claims', { wp: 'WP-GUI', by: 'owner' })).status, 409, 'a second claim is refused');
  assert.equal((await b.post('/api/claims', { wp: '../bad', by: 'owner' })).status, 400);
  assert.equal((await b.post('/api/claims', { wp: 'WP-X', by: 'root' })).status, 400);
  assert.equal((await b.post('/api/claims/WP-GUI/release', { by: 'codex' })).status, 409, 'release by a non-holder is refused');
  assert.equal((await b.post('/api/claims/WP-GUI/release', { by: 'owner', force: true })).status, 400, 'a forced release needs a reason');
  assert.equal((await b.post('/api/claims/WP-GUI/release', { by: 'owner' })).status, 200);
  assert.equal((await b.post('/api/claims/WP-NONE/finish', { by: 'owner' })).status, 400, 'finish needs confirmation');

  const preview = await b.post('/api/cleanup/preview', { wp: 'WP-GUI' });
  assert.ok([200, 409, 502].includes(preview.status), preview.text);
  assert.equal((await b.post('/api/cleanup/apply', { wp: 'WP-GUI', by: 'owner' })).status, 400, 'apply needs the explicit confirmation');
  void root;
});

test('gui runs: list, status, log, and a cancel that needs a reason and a confirmation', { timeout: 120000 }, async (t) => {
  const c = makeCase('fm-gui-runs');
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'src/a.js': '1\n' });
  t.after(() => c.cleanup());
  const saved = {};
  for (const key of ['ORCH_STATE_ROOT', 'ORCH_LANE_ID', 'ORCH_ALLOW_FAKE', 'ORCH_FAKE_WORKER']) { saved[key] = process.env[key]; process.env[key] = c.env[key]; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  await setPassword(c.stateRoot, PASSWORD);
  const gui = await startGui({ stateRoot: c.stateRoot, host: '127.0.0.1', port: 0 });
  t.after(() => gui.close());
  const started = await orch(['run', '--cli', 'fake', '--dir', repo, '--handoff', c.handoffPath, '--no-window', '--no-monitor', '--flag', '--hold', '--flag', '60', '--flag', '--echo', '--flag', 'hello from the worker'], c.env);
  assert.equal(started.code, 0, started.stdout + started.stderr);
  const id = idFrom(started.stdout);
  const b = browser(`http://127.0.0.1:${gui.port}`);
  await b.login();
  const list = (await b.get('/api/runs')).json.runs;
  assert.ok(list.some((r) => r.id === id));
  const one = (await b.get(`/api/runs/${id}`)).json.run;
  assert.ok(['running', 'queued', 'running_quiet'].includes(one.derived_status || one.status), one.derived_status);
  await waitFor(async () => (await b.get(`/api/runs/${id}/log?stream=stdout&tail=50`)).json.lines.join('\n').includes('hello from the worker'), { what: 'the worker output in the log', timeoutMs: 30000 });
  assert.equal((await b.get('/api/runs/not-a-run')).status, 404);

  assert.equal((await b.post(`/api/runs/${id}/cancel`, { confirm: true })).status, 400, 'a reason is required');
  assert.equal((await b.post(`/api/runs/${id}/cancel`, { reason: 'wrong model' })).status, 400, 'a confirmation is required');
  const cancelled = await b.post(`/api/runs/${id}/cancel`, { reason: 'wrong model for this task', confirm: true });
  assert.equal(cancelled.status, 200, cancelled.text);
  const after = await waitFor(async () => { const r = (await b.get(`/api/runs/${id}`)).json.run; return r.derived_status === 'cancelled' ? r : null; }, { timeoutMs: 30000, what: 'the run to be cancelled' });
  assert.equal(after.derived_status, 'cancelled');
  const store = Store.open(c.stateRoot);
  const e = store.events().find((x) => x.kind === 'gui-action' && x.data.action === 'cancel');
  store.close();
  assert.equal(e.data.reason, 'wrong model for this task');
});
