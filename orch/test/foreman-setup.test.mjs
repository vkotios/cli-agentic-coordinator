// Foreman per-project setup command: stored on the project, run once in each fresh worktree before the worker,
// failure parks the item with `setup-failed`, and the ignored files it creates are baselined, not trusted blindly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCase, orch, waitFor, TEST_ROOT } from './helpers.mjs';
import { makeRepo } from './wf-helpers.mjs';
import { Store, SCHEMA_VERSION } from '../src/foreman/store.mjs';
import { Dispatcher } from '../src/foreman/dispatcher.mjs';
import { makeCall } from '../src/foreman/engine.mjs';
import { addProject, setProjectSetup, enqueue, summary } from '../src/foreman/api.mjs';
import { validateSetup, PARK_TAGS } from '../src/foreman/schema.mjs';
import { setupEnv, safeEnv } from '../src/foreman/env.mjs';
import { launchPlan, runCheck, snapshotIgnored, ignoredOutsideAllowlist, resolveExecutable } from '../src/foreman/acceptance.mjs';

const NODE_OK = ['node', '-e', "process.exit(require('fs').existsSync('out.txt') ? 0 : 1)"];
const MAKE_DEP = ['node', '-e', "const fs=require('fs');fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/dep.js','original')"];

function item(over = {}) {
  return {
    project: 'alpha', title: 'write out.txt', goal_ref: 'g1', handoff: 'TASK: create out.txt\nFILES YOU MAY EDIT: out.txt',
    allowlist: ['out.txt'], acceptance: [{ kind: 'command', argv: NODE_OK }], size: 'XS',
    route: { cli: 'fake', model: 'localai/qwen3-coder-30b', flags: ['--write-file', 'out.txt'] },
    ...over,
  };
}
const flags = (...f) => ({ cli: 'fake', model: 'localai/qwen3-coder-30b', flags: f });

/** A case whose repo ignores node_modules/ and .venv/, with the fake worker wired into this process's environment. */
function setupCase(t, name, setupArgv, timeoutS) {
  const c = makeCase(name);
  const saved = {};
  for (const key of ['ORCH_STATE_ROOT', 'ORCH_LANE_ID', 'ORCH_ALLOW_FAKE', 'ORCH_FAKE_WORKER']) { saved[key] = process.env[key]; process.env[key] = c.env[key]; }
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n', '.gitignore': 'node_modules/\n.venv/\n' });
  const store = Store.open(c.stateRoot);
  addProject(store, { id: 'alpha', repo, setup: setupArgv, setupTimeout: timeoutS }, 'test');
  store.ensureGoal('alpha', 'g1', 'test');
  store.setGoalStatus('alpha', 'g1', 'approved', 'test');
  t.after(() => { store.close(); c.cleanup(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const dispatcher = new Dispatcher({ store, stateRoot: c.stateRoot, call: makeCall(c.stateRoot) });
  return { c, repo, store, dispatcher };
}

async function drive(d, store, id, states = ['parked', 'needs-review'], timeoutMs = 90000) {
  return waitFor(async () => { await d.tick(); const cur = store.getItem(id); return states.includes(cur.state) ? cur : null; }, { timeoutMs, intervalMs: 300, what: `${id} to reach ${states.join('/')}` });
}

// ---- pure pieces -------------------------------------------------------------------------------

test('setup: validation accepts an argv list and a bounded timeout, and refuses anything else', () => {
  assert.deepEqual(validateSetup(['npm', 'ci']).setup, { argv: ['npm', 'ci'], timeout_s: 900 });
  assert.deepEqual(validateSetup(['uv', 'sync'], '120').setup, { argv: ['uv', 'sync'], timeout_s: 120 });
  assert.equal(validateSetup(null).setup, null);
  assert.equal(validateSetup([]).ok, true);
  for (const bad of ['npm ci', [1], [''], ['a\0b'], Array(33).fill('x'), { argv: ['x'] }]) assert.equal(validateSetup(bad).ok, false, JSON.stringify(bad));
  for (const bad of [0, -1, 3601, 1.5, 'soon']) assert.equal(validateSetup(['x'], bad).ok, false, String(bad));
  assert.ok(PARK_TAGS.includes('setup-failed'));
});

test('setup: the setup environment adds package-manager settings but never a token or key', () => {
  const env = {
    PATH: '/usr/bin', HOME: '/home/x', NPM_CONFIG_REGISTRY: 'https://registry.example/', PIP_INDEX_URL: 'https://pypi.example/simple', UV_CACHE_DIR: '/c', HTTPS_PROXY: 'http://proxy:3128',
    NODE_EXTRA_CA_CERTS: '/ca.pem', NPM_TOKEN: 'secret', NPM_CONFIG__AUTHTOKEN: 'secret', PIP_PASSWORD: 'secret', ANTHROPIC_API_KEY: 'secret', GITHUB_TOKEN: 'secret', IGM_CONTROL_KEY: 'secret', NODE_OPTIONS: '--require x',
  };
  const out = setupEnv(env);
  for (const k of ['PATH', 'HOME', 'NPM_CONFIG_REGISTRY', 'PIP_INDEX_URL', 'UV_CACHE_DIR', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']) assert.ok(k in out, k);
  for (const k of ['NPM_TOKEN', 'NPM_CONFIG__AUTHTOKEN', 'PIP_PASSWORD', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'IGM_CONTROL_KEY', 'NODE_OPTIONS']) assert.ok(!(k in out), `${k} must not pass`);
  assert.ok(!('NPM_CONFIG_REGISTRY' in safeEnv(env)), 'the acceptance environment is unchanged');
});

test('setup: npm runs through node on Windows (a .cmd cannot be spawned without a shell); other batch files are refused clearly', async (t) => {
  assert.deepEqual(launchPlan('/usr/bin/git', ['status']), { program: '/usr/bin/git', args: ['status'] });
  if (process.platform === 'win32') {
    const other = launchPlan('C:\\tools\\thing.cmd', ['x']);
    assert.ok('error' in other && /batch file/.test(other.error));
  }
  const npm = resolveExecutable('npm', path.join(TEST_ROOT, 'nowhere'));
  if (!npm) return t.skip('npm is not on PATH here');
  const base = path.join(TEST_ROOT, `fm-npm-${process.pid}-${Date.now()}`);
  fs.mkdirSync(base, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const r = await runCheck({ kind: 'command', argv: ['npm', '--version'] }, { root: base, logFile: path.join(base, 'npm.log'), defaultTimeoutS: 60, maxLogBytes: 10000, env: setupEnv() });
  assert.equal(r.status, 'pass', JSON.stringify(r));
  assert.match(fs.readFileSync(path.join(base, 'npm.log'), 'utf8'), /^\d+\.\d+\.\d+/);
});

// ---- store, API, CLI ---------------------------------------------------------------------------

test('setup: stored on the project, audited, shown in the summary, and a version 3 database is migrated', (t) => {
  const c = makeCase('fm-setup-store');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n' });
  let store = Store.open(c.stateRoot);
  assert.equal(SCHEMA_VERSION, 4);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
  const p = addProject(store, { id: 'alpha', repo }, 'test');
  assert.equal(p.setup, null);
  const set = setProjectSetup(store, 'alpha', ['npm', 'ci'], 300, 'test');
  assert.deepEqual(set.setup, { argv: ['npm', 'ci'], timeout_s: 300 });
  assert.deepEqual(summary(store).projects[0].setup, { argv: ['npm', 'ci'], timeout_s: 300 });
  assert.throws(() => setProjectSetup(store, 'alpha', 'npm ci', undefined, 'test'), /JSON array/);
  assert.throws(() => setProjectSetup(store, 'nope', ['x'], undefined, 'test'), /no such project/);
  const changed = store.events().find((e) => e.kind === 'project-setup-changed');
  assert.deepEqual(changed.data, { id: 'alpha', from: null, to: { argv: ['npm', 'ci'], timeout_s: 300 } });
  assert.equal(setProjectSetup(store, 'alpha', null, undefined, 'test').setup, null);
  // a version 3 database (no setup column) opens and gains the column without losing the project
  store.close();
  const raw = new DatabaseSync(path.join(c.stateRoot, 'foreman', 'foreman.db'));
  raw.exec('ALTER TABLE projects DROP COLUMN setup_json; PRAGMA user_version = 3;');
  raw.close();
  store = Store.open(c.stateRoot);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(store.getProject('alpha').repo, path.resolve(repo));
  assert.equal(store.getProject('alpha').setup, null);
  store.close();
});

test('setup: the command line sets, shows, changes and clears it, and refuses a shell string', { timeout: 120000 }, async (t) => {
  const c = makeCase('fm-setup-cli');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n' });
  const run = (...a) => orch(['foreman', ...a], c.env);
  const added = await run('project', 'add', '--id', 'alpha', '--repo', repo, '--setup', '["npm","ci"]', '--setup-timeout', '300', '--json');
  assert.equal(added.code, 0, added.stderr);
  assert.deepEqual(JSON.parse(added.stdout).setup, { argv: ['npm', 'ci'], timeout_s: 300 });
  assert.match((await run('project', 'list')).stdout, /alpha .*setup: npm ci/);
  const updated = await run('project', 'update', 'alpha', '--setup', '["uv","sync"]', '--json');
  assert.deepEqual(JSON.parse(updated.stdout).setup, { argv: ['uv', 'sync'], timeout_s: 900 });
  const bad = await run('project', 'update', 'alpha', '--setup', 'npm ci');
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr + bad.stdout, /JSON array/);
  assert.notEqual((await run('project', 'update', 'alpha')).code, 0, 'nothing to update');
  const cleared = await run('project', 'update', 'alpha', '--setup', 'none', '--json');
  assert.equal(JSON.parse(cleared.stdout).setup, null);
  const listed = (await run('project', 'list')).stdout;
  assert.match(listed, /^alpha\s+.*repo\s*$/m);
  assert.ok(!listed.includes('setup:'), 'no setup is shown once cleared');
});

// ---- the dispatcher ------------------------------------------------------------------------------

test('dispatcher: setup runs before the worker, its ignored files are accepted as the baseline, the item reaches needs-review', { timeout: 150000 }, async (t) => {
  const { c, store, dispatcher } = setupCase(t, 'fm-setup-ok', MAKE_DEP);
  const it = enqueue(store, item({ route: flags('--write-file', 'out.txt', '--ls') }), 'test');
  const done = await drive(dispatcher, store, it.id);
  assert.equal(done.state, 'needs-review', done.park_reason);
  const run = store.currentRun(it.id);
  const stdout = fs.readFileSync(path.join(c.stateRoot, 'runs', run.run_id, 'stdout.log'), 'utf8');
  assert.match(stdout, /LS node_modules[\\/]dep\.js/, 'the worker already saw what setup created');
  const setupEvent = store.events({ item: it.id }).find((e) => e.kind === 'setup');
  assert.equal(setupEvent.data.status, 'pass');
  assert.equal(setupEvent.data.ignored_files, 1);
  assert.ok(fs.existsSync(setupEvent.data.log));
  assert.ok(fs.existsSync(path.join(c.stateRoot, 'foreman', 'setup', `run-${run.id}.baseline.json`)));
});

test('dispatcher: a failing, timing-out or unrunnable setup parks the item as setup-failed and no worker starts', { timeout: 200000 }, async (t) => {
  const { c, store, dispatcher } = setupCase(t, 'fm-setup-fail', ['node', '-e', "console.error('boom: no network');process.exit(3)"]);
  const failing = enqueue(store, item({ title: 'setup exits 3' }), 'test');
  const a = await drive(dispatcher, store, failing.id);
  assert.equal(a.state, 'parked');
  assert.equal(a.park_tag, 'setup-failed');
  assert.match(a.park_reason, /setup \(node -e .*\) exited 3/);
  assert.match(a.park_reason, /boom: no network/, 'the tail of the log is in the reason');
  const run = store.currentRun(failing.id);
  assert.equal(run.state, 'abandoned');
  assert.equal(run.run_id, null, 'no worker run was started');
  assert.equal(store.events({ item: failing.id }).find((e) => e.kind === 'setup').data.status, 'fail');
  // a claim left behind would block a retry
  const claims = await makeCall(c.stateRoot)(['claims']);
  assert.equal((Array.isArray(claims.out) ? claims.out : claims.out?.claims).length, 0, 'the claim was released');

  setProjectSetup(store, 'alpha', ['node', '-e', 'setTimeout(()=>{},20000)'], 2, 'test');
  const slow = enqueue(store, item({ title: 'setup hangs' }), 'test');
  const b = await drive(dispatcher, store, slow.id);
  assert.equal(b.park_tag, 'setup-failed');
  assert.match(b.park_reason, /timed out after 2 s/);

  setProjectSetup(store, 'alpha', ['definitely-not-a-program-xyz'], undefined, 'test');
  const missing = enqueue(store, item({ title: 'setup program missing' }), 'test');
  const c2 = await drive(dispatcher, store, missing.id);
  assert.equal(c2.park_tag, 'setup-failed');
  assert.match(c2.park_reason, /could not run \(cannot find definitely-not-a-program-xyz/);

  // fixing the project and requeueing works: the same item then runs
  setProjectSetup(store, 'alpha', null, undefined, 'test');
  store.transition(missing.id, 'ready', { actor: 'test', reason: 'setup removed' });
  const again = await drive(dispatcher, store, missing.id);
  assert.equal(again.state, 'needs-review', again.park_reason);
});

test('dispatcher: setup may only create git-ignored files', { timeout: 150000 }, async (t) => {
  const { store, dispatcher } = setupCase(t, 'fm-setup-dirty', ['node', '-e', "require('fs').appendFileSync('README.md','changed by setup\\n')"]);
  const tracked = enqueue(store, item({ title: 'setup edits a tracked file' }), 'test');
  const a = await drive(dispatcher, store, tracked.id);
  assert.equal(a.park_tag, 'setup-failed');
  assert.match(a.park_reason, /changed files git tracks or would add: M README\.md/);
  assert.match(a.park_reason, /add what it creates to \.gitignore/);

  setProjectSetup(store, 'alpha', ['node', '-e', "require('fs').writeFileSync('generated.js','x')"], undefined, 'test');
  const untracked = enqueue(store, item({ title: 'setup adds an untracked file' }), 'test');
  const b = await drive(dispatcher, store, untracked.id);
  assert.equal(b.park_tag, 'setup-failed');
  assert.match(b.park_reason, /\?\? generated\.js/);
});

test('dispatcher: a worker cannot hide code in what setup created: a new file or a changed one is a scope violation', { timeout: 250000 }, async (t) => {
  const { store, dispatcher } = setupCase(t, 'fm-setup-tamper', MAKE_DEP);
  const marker = path.join(TEST_ROOT, `fm-setup-marker-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const check = { kind: 'command', argv: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] };
  const planted = enqueue(store, item({ title: 'plants a new file', route: flags('--write-file', 'node_modules/evil.js'), acceptance: [check] }), 'test');
  const a = await drive(dispatcher, store, planted.id);
  assert.equal(a.park_tag, 'scope-violation');
  assert.match(a.park_reason, /git-ignored files outside the allowlist.*node_modules[\\/]evil\.js/);
  const changed = enqueue(store, item({ title: 'overwrites a setup file', route: flags('--write-file', 'node_modules/dep.js'), acceptance: [check] }), 'test');
  const b = await drive(dispatcher, store, changed.id);
  assert.equal(b.park_tag, 'scope-violation');
  assert.match(b.park_reason, /node_modules[\\/]dep\.js/);
  assert.equal(fs.existsSync(marker), false, 'no acceptance command ran');
});

test('dispatcher: the setup process gets the reduced environment plus package-manager settings, not keys', { timeout: 150000 }, async (t) => {
  const keys = ['ANTHROPIC_API_KEY', 'NPM_CONFIG_REGISTRY', 'PIP_INDEX_URL', 'GITHUB_TOKEN'];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-test-secret', NPM_CONFIG_REGISTRY: 'https://registry.example/', PIP_INDEX_URL: 'https://pypi.example/simple', GITHUB_TOKEN: 'ghp_test_secret' });
  t.after(() => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const dump = ['node', '-e', "const fs=require('fs');fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/env.json',JSON.stringify({key:process.env.ANTHROPIC_API_KEY||null,gh:process.env.GITHUB_TOKEN||null,reg:process.env.NPM_CONFIG_REGISTRY||null,pip:process.env.PIP_INDEX_URL||null}))"];
  const { store, dispatcher } = setupCase(t, 'fm-setup-env', dump);
  const it = enqueue(store, item(), 'test');
  const done = await drive(dispatcher, store, it.id);
  assert.equal(done.state, 'needs-review', done.park_reason);
  const seen = JSON.parse(fs.readFileSync(path.join(store.currentRun(it.id).worktree, 'node_modules', 'env.json'), 'utf8'));
  assert.deepEqual(seen, { key: null, gh: null, reg: 'https://registry.example/', pip: 'https://pypi.example/simple' });
});

test('acceptance: the ignored-file baseline accepts unchanged files and rejects new, changed or tolerated-name tricks', (t) => {
  const dir = path.join(TEST_ROOT, `fm-baseline-${process.pid}-${Date.now()}`);
  makeRepo(dir, { '.gitignore': 'node_modules/\n', 'a.txt': '1\n' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'one');
  const snap = snapshotIgnored(dir);
  assert.equal(snap.ok, true);
  assert.equal(snap.count, 1);
  assert.deepEqual(ignoredOutsideAllowlist(dir, [], [], snap.files).offending, []);
  assert.deepEqual(ignoredOutsideAllowlist(dir, [], []).offending, ['node_modules/pkg/index.js'], 'without a baseline it is still offending');
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'one!'); // changed
  assert.deepEqual(ignoredOutsideAllowlist(dir, [], [], snap.files).offending, ['node_modules/pkg/index.js']);
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'one'); // restored exactly
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'extra.js'), 'x'); // new
  assert.deepEqual(ignoredOutsideAllowlist(dir, [], [], snap.files).offending, ['node_modules/pkg/extra.js']);
  assert.equal(snapshotIgnored(dir, { maxFiles: 1 }).ok, false, 'a runaway setup is refused');
});

test('acceptance: a same-size change, a changed target outside the worktree, and a changed nested tree are all caught', (t) => {
  const base = path.join(TEST_ROOT, `fm-baseline2-${process.pid}-${Date.now()}`);
  const dir = path.join(base, 'repo');
  makeRepo(dir, { '.gitignore': 'node_modules/\n.venv/\n', 'a.txt': '1\n' });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'one');
  // the shared tool a venv would link to: outside the worktree, so the file hash alone would not see it change
  const outside = path.join(base, 'shared-python');
  fs.mkdirSync(path.join(outside, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'python.js'), 'interpreter v1');
  fs.writeFileSync(path.join(outside, 'lib', 'site.js'), 'stdlib v1');
  let linked = true;
  try { fs.symlinkSync(outside, path.join(dir, '.venv'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { linked = false; }
  const snap = snapshotIgnored(dir);
  assert.equal(snap.ok, true, snap.error);
  assert.deepEqual(ignoredOutsideAllowlist(dir, [], [], snap.files).offending, [], 'everything is as setup left it');
  // a same-size change is found by hashing, not by the size
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'two');
  assert.deepEqual(ignoredOutsideAllowlist(dir, [], [], snap.files).offending, ['node_modules/dep.js']);
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'one');
  assert.deepEqual(ignoredOutsideAllowlist(dir, [], [], snap.files).offending, []);
  if (!linked) return t.diagnostic('this platform would not create the directory link; the outside-target part was skipped');
  // a change to what the link resolves to, outside the worktree, is a change
  fs.writeFileSync(path.join(outside, 'lib', 'site.js'), 'stdlib v2 (planted)');
  assert.ok(ignoredOutsideAllowlist(dir, [], [], snap.files).offending.length > 0, 'a changed target outside the worktree is offending');
  fs.writeFileSync(path.join(outside, 'lib', 'site.js'), 'stdlib v1');
  assert.deepEqual(ignoredOutsideAllowlist(dir, [], [], snap.files).offending, []);
});

test('acceptance: what cannot be hashed within the budget is refused when recording and offending when checking', (t) => {
  const dir = path.join(TEST_ROOT, `fm-baseline3-${process.pid}-${Date.now()}`);
  makeRepo(dir, { '.gitignore': 'node_modules/\n', 'a.txt': '1\n' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'big.bin'), Buffer.alloc(4096, 7));
  const refused = snapshotIgnored(dir, { maxBytes: 1024 });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /node_modules[\/]big\.bin.*cannot be recorded/);
  const snap = snapshotIgnored(dir);
  assert.equal(snap.ok, true);
  // a verify-time budget smaller than what the baseline needs: nothing is hashed past it, and the rest is offending
  assert.deepEqual(ignoredOutsideAllowlist(dir, [], [], snap.files, { maxBytes: 1024 }).offending, ['node_modules/big.bin']);
  // a file that grew is reported without being read
  fs.appendFileSync(path.join(dir, 'node_modules', 'big.bin'), 'x');
  assert.deepEqual(ignoredOutsideAllowlist(dir, [], [], snap.files, { maxBytes: 1 }).offending, ['node_modules/big.bin']);
});

test('dispatcher: a baseline file that no longer matches the digest the Foreman recorded is not used', { timeout: 150000 }, async (t) => {
  const { store, dispatcher } = setupCase(t, 'fm-setup-digest', MAKE_DEP);
  const run = { id: 4242 };
  const file = dispatcher.setupBaselineFile(run);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify({ 'node_modules/dep.js': '8:abc' });
  fs.writeFileSync(file, text);
  assert.equal(dispatcher.setupBaseline(run), null, 'a file with no recorded digest is not trusted');
  store.kvSet('setup-baseline:4242', (await import('node:crypto')).createHash('sha256').update(text).digest('hex'));
  assert.deepEqual(dispatcher.setupBaseline(run), { 'node_modules/dep.js': '8:abc' }, 'with its digest it is used');
  fs.writeFileSync(file, JSON.stringify({ 'node_modules/dep.js': '8:abc', 'node_modules/evil.js': '4:def' })); // someone widens it
  assert.equal(dispatcher.setupBaseline(run), null, 'a changed file is rejected');
  const rejected = store.events().filter((e) => e.kind === 'setup-baseline-rejected');
  assert.equal(rejected.length, 2);
  assert.deepEqual(rejected.map((e) => e.data.reason), ['no digest recorded', 'digest mismatch']);
});
