// Cleanup must prove ownership and quiescence, and must preserve recoverable work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { makeCase, orch } from './helpers.mjs';
import { makeRepo, g, commitAll, craftFinishedRun, contendEach } from './wf-helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import { beginResource, confirmResource, readResource, resourceFile, closureFile, withResourceLock, withOperationLock } from '../src/resources.mjs';
import { cmdFinish } from '../src/cleanup.mjs';
import { readClaim } from '../src/claims.mjs';

async function lockFile(t, file) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$f=[IO.File]::Open($env:ORCH_FIXTURE_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null; $f.Dispose()"], { env: { ...process.env, ORCH_FIXTURE_LOCK: file }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.stdin.end('\n'));
  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('fixture file lock not ready')), 10000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('ready')) { clearTimeout(timer); resolve(null); } });
    child.on('exit', (code) => { if (!out.includes('ready')) { clearTimeout(timer); reject(new Error(`lock process exited ${code}`)); } });
  });
  return async () => {
    child.stdin.end('\n');
    await new Promise((resolve) => child.on('close', resolve));
  };
}

const json = (r) => JSON.parse(r.stdout);

test('P04: a previous operation lock disappearing during path inspection permits the next holder', async (t) => {
  const c = makeCase('p04-lock-disappears');
  t.after(() => c.cleanup());
  const key = 'wp:wp-next';
  const file = path.join(c.stateRoot, 'resources', 'locks', `${crypto.createHash('sha256').update(key).digest('hex')}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'previous holder');
  let disappeared = false;
  // Model the previous holder releasing immediately after an existence/stat probe.
  // Both APIs can observe a lock that is already gone by the next filesystem call.
  const probeMethods = /** @type {Array<'existsSync' | 'lstatSync'>} */ (['existsSync', 'lstatSync']);
  for (const method of probeMethods) {
    const original = fs[method].bind(fs);
    t.mock.method(fs, method, (p, ...args) => {
      const result = original(p, ...args);
      if (!disappeared && String(p) === file) {
        fs.unlinkSync(file);
        disappeared = true;
      }
      return result;
    });
  }
  let executed = false;
  await withOperationLock({ stateRoot: c.stateRoot }, key, () => { executed = true; });
  assert.equal(disappeared, true, 'the transient-lock scenario must be exercised');
  assert.equal(executed, true);
  assert.equal(fs.existsSync(file), false, 'the next holder releases its own lock');
});

test('P04: a linked operation lock is refused without touching its target', async (t) => {
  const c = makeCase('p04-lock-link');
  t.after(() => c.cleanup());
  const key = 'wp:wp-linked';
  const file = path.join(c.stateRoot, 'resources', 'locks', `${crypto.createHash('sha256').update(key).digest('hex')}.lock`);
  const target = path.join(c.base, 'owner-lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(target);
  const ownerFile = path.join(target, 'original.txt');
  fs.writeFileSync(ownerFile, 'owner original');
  fs.symlinkSync(target, file, 'junction');
  await assert.rejects(withOperationLock({ stateRoot: c.stateRoot }, key, () => assert.fail('linked lock acquired')), { code: 'resource-path-unsafe' });
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), 'owner original');
});

test('P04: a directory operation lock is refused without changing its contents', async (t) => {
  const c = makeCase('p04-lock-directory');
  t.after(() => c.cleanup());
  const key = 'wp:wp-directory';
  const file = path.join(c.stateRoot, 'resources', 'locks', `${crypto.createHash('sha256').update(key).digest('hex')}.lock`);
  fs.mkdirSync(file, { recursive: true });
  const original = path.join(file, 'original.txt');
  fs.writeFileSync(original, 'preserved');
  await assert.rejects(withOperationLock({ stateRoot: c.stateRoot }, key, () => assert.fail('directory lock acquired')), { code: 'resource-path-unsafe' });
  assert.equal(fs.readFileSync(original, 'utf8'), 'preserved');
});

async function fixture(t, name) {
  const c = makeCase(name);
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'a.txt': 'original\n', '.gitignore': 'private.bin\n' });
  assert.equal((await orch(['claim', 'WP-clean', '--by', 'owner'], c.env)).code, 0);
  const r = await orch(['worktree', 'create', '--repo', repo, '--wp', 'WP-clean', '--slice', 's1', '--by', 'owner', '--json'], c.env);
  assert.equal(r.code, 0, r.stderr);
  return { c, repo, w: json(r) };
}

test('P02: a queued dependent run prevents even forced worktree removal', async (t) => {
  const { c, w } = await fixture(t, 'p02-active');
  craftFinishedRun(c.stateRoot, { dir: w.path, baseline: w.baseline, allow: ['a.txt'], wp: 'WP-clean', extra: { status: 'queued' } });
  const r = await orch(['worktree', 'remove', w.id, '--force', '--json'], c.env);
  assert.equal(r.code, 3, 'force must not discard a directory with a queued launch');
  assert.ok(fs.existsSync(path.join(w.path, 'a.txt')));
});

test('P02: queued runs in worktree subdirectories protect the whole resource', async (t) => {
  const { c, w } = await fixture(t, 'p02-subdir-active');
  const dir = path.join(w.path, 'nested');
  fs.mkdirSync(dir);
  craftFinishedRun(c.stateRoot, { dir, baseline: w.baseline, allow: ['a.txt'], wp: 'another-WP', extra: { status: 'queued' } });
  const r = await orch(['worktree', 'remove', w.id, '--force', '--json'], c.env);
  assert.equal(r.code, 3, 'a subdirectory launch must block even forced removal');
  assert.ok(fs.existsSync(path.join(w.path, 'a.txt')));
});

test('P02: cleanup dry-run is read-only; apply removes only a clean owned worktree', async (t) => {
  const { c, repo, w } = await fixture(t, 'p02-cycle');
  const before = g(repo, 'worktree', 'list', '--porcelain');
  const dry = await orch(['cleanup', '--wp', 'WP-clean', '--dry-run', '--json'], c.env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(json(dry).resources.find((r) => r.id === w.id).action, 'remove');
  assert.equal(g(repo, 'worktree', 'list', '--porcelain'), before);
  const applied = await orch(['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'], c.env);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(json(applied).resources.find((r) => r.id === w.id).state, 'removed');
  assert.equal(fs.existsSync(w.path), false);
  const listed = json(await orch(['worktree', 'list', '--json'], c.env)).worktrees.find((r) => r.id === w.id);
  assert.ok(listed.removed_at, 'worktree listing must use the verified cleanup receipt');
  assert.ok(g(repo, 'rev-parse', '--verify', `refs/heads/${w.branch}`).trim(), 'branch stays independently recoverable');
  const repeated = await orch(['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'], c.env);
  assert.equal(repeated.code, 0, repeated.stderr);
});

test('P02: ignored owner data and unique commits are retained by package cleanup', async (t) => {
  const { c, w } = await fixture(t, 'p02-protected');
  fs.writeFileSync(path.join(w.path, 'private.bin'), 'owner data');
  let r = await orch(['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'], c.env);
  assert.equal(r.code, 3, r.stderr);
  assert.equal(fs.readFileSync(path.join(w.path, 'private.bin'), 'utf8'), 'owner data');
  fs.unlinkSync(path.join(w.path, 'private.bin'));
  fs.writeFileSync(path.join(w.path, 'a.txt'), 'unique work\n');
  commitAll(w.path);
  r = await orch(['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'], c.env);
  assert.equal(r.code, 3, r.stderr);
  assert.match(json(r).resources[0].reason, /unmerged/);
  assert.equal(fs.readFileSync(path.join(w.path, 'a.txt'), 'utf8'), 'unique work\n');
});

test('P02: reused worktree paths do not inherit ownership', async (t) => {
  const { c, repo, w } = await fixture(t, 'p02-reuse');
  g(repo, 'worktree', 'remove', w.path);
  g(repo, 'worktree', 'add', '-b', 'foreign', w.path, 'HEAD');
  const r = await orch(['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'], c.env);
  assert.equal(r.code, 3, r.stderr);
  assert.ok(fs.existsSync(w.path));
  assert.match(json(r).resources[0].reason, /identity|registration/);
});

test('P02: finish rejects unrecorded work and accepts an explicit retained resource decision', async (t) => {
  const { c, w } = await fixture(t, 'p02-finish');
  const id = craftFinishedRun(c.stateRoot, { dir: w.path, baseline: w.baseline, allow: ['a.txt'], wp: 'WP-clean', slice: 's1' });
  let r = await orch(['finish', 'WP-clean', '--by', 'owner', '--json'], c.env);
  assert.equal(r.code, 3, r.stderr);
  assert.equal(json(r).state, 'incomplete');
  assert.equal((await orch(['record', id, '--disposition', 'blocked', '--notes', 'no implementation accepted', '--json'], c.env)).code, 0);
  fs.writeFileSync(path.join(w.path, 'a.txt'), 'work to preserve\n');
  const decisions = path.join(c.base, 'retain.json');
  fs.writeFileSync(decisions, JSON.stringify([{ id: w.id, reason: 'owner investigation', revisit: 'after investigation' }]));
  r = await orch(['finish', 'WP-clean', '--by', 'owner', '--retain', decisions, '--json'], c.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).state, 'finished');
  assert.equal(json(await orch(['claims', '--json'], c.env)).claims.length, 0);
  assert.equal(fs.readFileSync(path.join(w.path, 'a.txt'), 'utf8'), 'work to preserve\n');
  r = await orch(['finish', 'WP-clean', '--by', 'owner', '--json'], c.env);
  assert.equal(r.code, 0, r.stderr);
  await orch(['claim', 'WP-clean', '--by', 'codex'], c.env);
  r = await orch(['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'], c.env);
  assert.notEqual(r.code, 0, 'a closed receipt cannot authorize cleanup after a new claim');
});

test('P02: a failed Git removal is pending and retry removes the same verified resource', async (t) => {
  const { c, w } = await fixture(t, 'p02-retry');
  const unlock = await lockFile(t, path.join(w.path, 'a.txt'));
  const args = ['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'];
  const first = await orch(args, c.env);
  assert.equal(first.code, 3, first.stderr);
  assert.equal(json(first).state, 'cleanup-pending', first.stdout);
  assert.ok(fs.existsSync(w.path));
  await unlock();
  const retry = await orch(args, c.env);
  assert.equal(retry.code, 0, retry.stdout + retry.stderr);
  const rec = readResource(loadConfig(c.stateRoot), w.id);
  assert.equal(rec.attempts.length, 2);
  assert.equal(rec.attempts[0].state, 'cleanup-pending');
  assert.equal(rec.attempts[1].state, 'removed');
});

test('P02: review cleanup retry preserves the original review result bytes', async (t) => {
  const { c, repo } = await fixture(t, 'p02-review-retry');
  const cfg = loadConfig(c.stateRoot);
  const id = 'rv-20260923-130000-abcdef';
  const wt = path.join(c.base, 'reviews', id);
  const baseline = g(repo, 'rev-parse', 'HEAD').trim();
  const r = await beginResource(cfg, { id, kind: 'review', review_id: id, wp: 'WP-clean', by: 'owner', repo, root: path.dirname(wt), path: wt, baseline });
  g(repo, 'worktree', 'add', '--detach', wt, baseline);
  await confirmResource(cfg, r);
  const rv = { id, wp: 'WP-clean', by: 'owner', worktree: wt, source_repo: repo, worktree_created: true, finished_at: '2026-09-23T13:00:00Z', status: 'finished', outcome: 'reviewed', containment: 'clean', breaches: [], unknown: [], blinded: [], evidence: { immutable: 'original findings' } };
  const file = path.join(c.stateRoot, 'reviews', `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rv, null, 2));
  const original = fs.readFileSync(file);
  const unlock = await lockFile(t, path.join(wt, 'a.txt'));
  let result = await orch(['review', '--finish', id, '--by', 'owner', '--json'], c.env);
  assert.equal(result.code, 3, result.stderr);
  await unlock();
  result = await orch(['review', '--finish', id, '--by', 'owner', '--json'], c.env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(json(result).worktree_removed, true);
  assert.deepEqual(fs.readFileSync(file), original, 'cleanup cannot re-grade or rewrite a finished review');
});

test('P02: interrupted creation intent is inventoried without assuming ownership', async (t) => {
  const { c, repo } = await fixture(t, 'p02-intent');
  const cfg = loadConfig(c.stateRoot);
  const target = path.join(repo, '.worktrees', 'interrupted');
  const id = 'wt-interrupted-abcdef';
  await beginResource(cfg, { id, kind: 'implementation', wp: 'WP-clean', by: 'owner', repo, root: path.dirname(target), path: target, branch: 'interrupted', baseline: g(repo, 'rev-parse', 'HEAD').trim() });
  assert.equal(fs.existsSync(target), false, 'intent is durable before Git creation');
  g(repo, 'worktree', 'add', '-b', 'interrupted', target, 'HEAD');
  const result = await orch(['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'], c.env);
  assert.equal(result.code, 3, result.stderr);
  assert.match(json(result).resources.find((r) => r.id === id).reason, /intent.*identity/);
  assert.ok(fs.existsSync(target));
});

test('P02: concurrent cleanup produces one removal and a stable receipt', async (t) => {
  const { c, w } = await fixture(t, 'p02-concurrent');
  const args = ['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'];
  const results = await contendEach([args, args], c.env);
  assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
  assert.equal(readResource(loadConfig(c.stateRoot), w.id).attempts.length, 1);
  assert.equal(fs.existsSync(w.path), false);
});

test('P02: terminal status without process evidence never permits deletion', async (t) => {
  const { c, w } = await fixture(t, 'p02-unknown');
  const id = craftFinishedRun(c.stateRoot, { dir: w.path, baseline: w.baseline, allow: ['a.txt'], wp: 'WP-clean' });
  fs.writeFileSync(path.join(c.stateRoot, 'runs', id, 'keeper.ndjson'), '');
  const r = await orch(['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'], c.env);
  assert.equal(r.code, 3, r.stderr);
  assert.match(json(r).resources[0].reason, /liveness unknown/);
  assert.ok(fs.existsSync(w.path));
});

test('P02: a replaced path on the original branch is still foreign', async (t) => {
  const { c, repo, w } = await fixture(t, 'p02-samebranch');
  g(repo, 'worktree', 'remove', w.path);
  g(repo, 'worktree', 'add', w.path, w.branch);
  const r = await orch(['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'], c.env);
  assert.equal(r.code, 3, r.stderr);
  assert.match(json(r).resources[0].reason, /identity/);
  assert.ok(fs.existsSync(w.path));
});

test('P02: an interrupted resource lock is not taken over', async (t) => {
  const { c, w } = await fixture(t, 'p02-resource-lock');
  const cfg = loadConfig(c.stateRoot);
  const rec = readResource(cfg, w.id);
  await withResourceLock(cfg, rec, async () => {
    const result = await orch(['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'], c.env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /operation locked/);
    assert.ok(fs.existsSync(w.path));
  });
});

test('P02: foreign legacy resources stay inventory-only', async (t) => {
  const { c } = await fixture(t, 'p02-legacy');
  const foreign = path.join(c.base, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'owner.txt'), 'preserve');
  fs.writeFileSync(path.join(c.stateRoot, 'worktrees', 'wt-foreign.json'), JSON.stringify({ id: 'wt-foreign', wp: 'WP-clean', path: foreign }));
  const result = await orch(['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'], c.env);
  assert.equal(result.code, 3, result.stderr);
  assert.match(json(result).resources.find((r) => r.id === 'wt-foreign').reason, /legacy or foreign/);
  assert.equal(fs.readFileSync(path.join(foreign, 'owner.txt'), 'utf8'), 'preserve');
});

test('P02: finish can release a logically closed package and retry pending cleanup', async (t) => {
  const { c, w } = await fixture(t, 'p02-finish-pending');
  const unlock = await lockFile(t, path.join(w.path, 'a.txt'));
  let result = await orch(['finish', 'WP-clean', '--by', 'owner', '--json'], c.env);
  assert.equal(result.code, 3, result.stdout + result.stderr);
  assert.equal(json(result).state, 'cleanup-pending');
  assert.equal(json(await orch(['claims', '--json'], c.env)).claims.length, 0);
  const closedAt = json(result).closed_at;
  await unlock();
  result = await orch(['finish', 'WP-clean', '--by', 'owner', '--json'], c.env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(json(result).state, 'finished');
  assert.equal(json(result).closed_at, closedAt);
  assert.equal(fs.existsSync(w.path), false);
});

test('P02: intervening owner content prevents partial-removal retry', async (t) => {
  const { c, w } = await fixture(t, 'p02-partial-new');
  const original = fs.readFileSync(path.join(w.path, 'a.txt'));
  const unlock = await lockFile(t, path.join(w.path, 'a.txt'));
  const args = ['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'];
  assert.equal((await orch(args, c.env)).code, 3);
  await unlock();
  fs.writeFileSync(path.join(w.path, 'owner-new.txt'), 'new owner work');
  const result = await orch(args, c.env);
  assert.equal(result.code, 3, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(w.path, 'owner-new.txt'), 'utf8'), 'new owner work');
  assert.deepEqual(fs.readFileSync(path.join(w.path, 'a.txt')), original);
});

test('P02: a junction cannot redirect cleanup to an outside directory', async (t) => {
  const { c, repo, w } = await fixture(t, 'p02-junction');
  const moved = path.join(c.base, 'moved-worktree');
  g(repo, 'worktree', 'move', w.path, moved);
  const outside = path.join(c.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'owner.txt'), 'preserve outside');
  fs.symlinkSync(outside, w.path, 'junction');
  const result = await orch(['cleanup', '--wp', 'WP-clean', '--apply', '--by', 'owner', '--json'], c.env);
  assert.equal(result.code, 3, result.stdout + result.stderr);
  assert.match(json(result).resources[0].reason, /identity|link/);
  assert.equal(fs.readFileSync(path.join(outside, 'owner.txt'), 'utf8'), 'preserve outside');
});

test('P02: a terminal record with unknown processes cannot close even with retention', async (t) => {
  const { c, w } = await fixture(t, 'p02-close-unknown');
  const id = craftFinishedRun(c.stateRoot, { dir: w.path, baseline: w.baseline, allow: ['a.txt'], wp: 'WP-clean', slice: 's1' });
  assert.equal((await orch(['record', id, '--disposition', 'blocked'], c.env)).code, 0);
  fs.writeFileSync(path.join(c.stateRoot, 'runs', id, 'keeper.ndjson'), '');
  const decisions = path.join(c.base, 'retain.json');
  fs.writeFileSync(decisions, JSON.stringify([{ id: w.id, reason: 'preserve', revisit: 'later' }]));
  const result = await orch(['finish', 'WP-clean', '--by', 'owner', '--retain', decisions, '--json'], c.env);
  assert.equal(result.code, 3, result.stdout + result.stderr);
  assert.equal(json(result).state, 'incomplete');
  assert.equal(json(await orch(['claims', '--json'], c.env)).claims.length, 1);
});

test('P02: accepting a run without a completed independent review cannot close it', async (t) => {
  const { c, w } = await fixture(t, 'p02-acceptance');
  const id = craftFinishedRun(c.stateRoot, { dir: w.path, baseline: w.baseline, allow: ['a.txt'], wp: 'WP-clean', slice: 's1' });
  assert.equal((await orch(['record', id, '--disposition', 'accepted'], c.env)).code, 0);
  const result = await orch(['finish', 'WP-clean', '--by', 'owner', '--json'], c.env);
  assert.equal(result.code, 3, result.stdout + result.stderr);
  assert.match(json(result).issues.join('\n'), /independent review/);
  assert.ok(fs.existsSync(w.path));
});

test('P02: launch cannot enter a worktree while its cleanup lock is held', async (t) => {
  const { c, w } = await fixture(t, 'p02-launch-lock');
  const cfg = loadConfig(c.stateRoot);
  await withResourceLock(cfg, readResource(cfg, w.id), async () => {
    const result = await orch(['run', '--cli', 'fake', '--dir', w.path, '--handoff', c.handoffPath, '--no-window', '--json'], c.env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /operation locked/);
    assert.equal(fs.existsSync(path.join(c.stateRoot, 'runs')), false, 'no queued launch may slip through a cleanup lock');
  });
});

test('P02: subdirectory and junction launches share the resource cleanup lock', async (t) => {
  const { c, w } = await fixture(t, 'p02-alias-launch');
  const nested = path.join(w.path, 'nested');
  fs.mkdirSync(nested);
  const alias = path.join(c.base, 'alias');
  fs.symlinkSync(w.path, alias, 'junction');
  await withResourceLock(loadConfig(c.stateRoot), readResource(loadConfig(c.stateRoot), w.id), async () => {
    for (const dir of [nested, alias, path.join(alias, 'nested')]) {
      const result = await orch(['run', '--cli', 'fake', '--dir', dir, '--handoff', c.handoffPath, '--no-window', '--json'], c.env);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /operation locked/);
      assert.equal(fs.existsSync(path.join(c.stateRoot, 'runs')), false);
    }
  });
});

test('P02: retained legacy decisions survive repeated finalization', async (t) => {
  const { c } = await fixture(t, 'p02-legacy-finish');
  const id = 'wt-legacy';
  fs.writeFileSync(path.join(c.stateRoot, 'worktrees', `${id}.json`), JSON.stringify({ id, wp: 'WP-clean', path: c.work }));
  const decisions = path.join(c.base, 'retain.json');
  fs.writeFileSync(decisions, JSON.stringify([{ id, reason: 'legacy owner work', revisit: 'manual ownership inspection' }]));
  let result = await orch(['finish', 'WP-clean', '--by', 'owner', '--retain', decisions, '--json'], c.env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  result = await orch(['finish', 'WP-clean', '--by', 'owner', '--json'], c.env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(json(result).resources.find((r) => r.id === id).intentional, true);
});

test('P02 repair: a cleanup retry reports retention required without reopening the package', async (t) => {
  const { c, w } = await fixture(t, 'p02-retention-status');
  const unlock = await lockFile(t, path.join(w.path, 'a.txt'));
  const first = json(await orch(['finish', 'WP-clean', '--by', 'owner', '--json'], c.env));
  assert.equal(first.state, 'cleanup-pending');
  await unlock();
  fs.writeFileSync(path.join(w.path, 'owner-new.txt'), 'preserve new work');
  const retry = await orch(['finish', 'WP-clean', '--by', 'owner', '--json'], c.env);
  const result = json(retry);
  assert.equal(retry.code, 3);
  assert.equal(result.state, 'retained');
  assert.match(result.issues.join('\n'), /explicit retained-resource decisions required/);
  assert.equal(result.closed_at, first.closed_at, 'logical closure is immutable');
  assert.deepEqual(result.run_ids, first.run_ids);
  assert.equal(json(await orch(['claims', '--json'], c.env)).claims.length, 0);
  const decisions = path.join(c.base, 'retain.json');
  fs.writeFileSync(decisions, JSON.stringify([{ id: w.id, reason: 'inspect new owner work', revisit: 'after inspection' }]));
  const resolved = json(await orch(['finish', 'WP-clean', '--by', 'owner', '--retain', decisions, '--json'], c.env));
  assert.equal(resolved.state, 'finished');
  assert.equal(resolved.closed_at, first.closed_at);
  assert.deepEqual(resolved.issues, [], 'resolved blockers do not survive a successful retry');
  assert.equal(fs.readFileSync(path.join(w.path, 'owner-new.txt'), 'utf8'), 'preserve new work');
});

test('P02 repair: text finish output explains blocking issues', async (t) => {
  const { c, w } = await fixture(t, 'p02-blocking-text');
  const id = craftFinishedRun(c.stateRoot, { dir: w.path, baseline: w.baseline, allow: ['a.txt'], wp: 'WP-clean', extra: { status: 'queued' } });
  const result = await orch(['finish', 'WP-clean', '--by', 'owner'], c.env);
  assert.equal(result.code, 3);
  assert.match(result.stdout, /not terminal/);
  assert.ok(result.stdout.includes(`run ${id} has no recorded disposition`));
  assert.ok(fs.existsSync(w.path));
  assert.equal(json(await orch(['claims', '--json'], c.env)).claims.length, 1);
});

test('P02 repair: resumed finish emits a release-pending response on release failure', async (t) => {
  const c = makeCase('p02-release-response');
  t.after(() => c.cleanup());
  assert.equal((await orch(['claim', 'WP-clean', '--by', 'owner'], c.env)).code, 0);
  const cfg = loadConfig(c.stateRoot);
  const token = readClaim(cfg, 'WP-clean').value.token;
  const file = closureFile(cfg, 'WP-clean');
  const closedAt = '2026-09-23T13:00:00Z';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ wp: 'WP-clean', by: 'owner', claim_token: token, closed_at: closedAt, state: 'finished', resources: [], run_ids: [] }));
  const rename = fs.renameSync;
  // Inject a claim read failure after the durable receipt, before release.
  // All filesystem operations and the claim reader remain real.
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (String(to) === file) fs.writeFileSync(path.join(c.stateRoot, 'claims', 'wp-clean.json'), '{unreadable');
  });
  const output = [];
  try {
    const result = await cmdFinish(cfg, { _: ['WP-clean'], by: 'owner', json: true }, { log: (s) => output.push(s) });
    assert.equal(result.state, 'release-pending');
    assert.equal(result.exitCode, 3);
    assert.equal(output.length, 1, 'the caller must receive the release-pending result');
    assert.equal(JSON.parse(output[0]).state, 'release-pending');
    assert.equal(JSON.parse(output[0]).closed_at, closedAt);
    assert.ok(fs.existsSync(path.join(c.stateRoot, 'claims', 'wp-clean.json')), 'uncertain claim is preserved');
  } finally { t.mock.restoreAll(); }
});

test('P02 repair: unsupported finish options cannot remove resources or release claims', async (t) => {
  const observations = [];
  for (const option of ['--dry-run', '--force', '--delete-branch']) {
    const { c, w } = await fixture(t, `p02-option-${option.slice(2)}`);
    const before = fs.readFileSync(path.join(c.stateRoot, 'claims', 'wp-clean.json'));
    const result = await orch(['finish', 'WP-clean', '--by', 'owner', option, '--json'], c.env);
    observations.push({ option, rejected: result.code !== 0 && /not supported|does not support/.test(result.stderr), worktreePresent: fs.existsSync(w.path), claimUnchanged: fs.existsSync(path.join(c.stateRoot, 'claims', 'wp-clean.json')) && fs.readFileSync(path.join(c.stateRoot, 'claims', 'wp-clean.json')).equals(before), receiptAbsent: !fs.existsSync(closureFile(loadConfig(c.stateRoot), 'WP-clean')) });
  }
  assert.ok(observations.every((r) => r.rejected && r.worktreePresent && r.claimUnchanged && r.receiptAbsent), JSON.stringify(observations));
});

test('P02 repair: missing run directory is validated before resource locks', async (t) => {
  const { c, w } = await fixture(t, 'p02-missing-dir');
  const cfg = loadConfig(c.stateRoot);
  await withResourceLock(cfg, readResource(cfg, w.id), async () => {
    const result = await orch(['run', '--cli', 'fake', '--handoff', c.handoffPath, '--no-window'], c.env, { cwd: w.path });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--dir is required/);
    assert.deepEqual(fs.existsSync(cfg.runsDir) ? fs.readdirSync(cfg.runsDir) : [], [], 'no run or worker is created');
  });
});
