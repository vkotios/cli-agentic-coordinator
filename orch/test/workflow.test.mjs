// Slice 2: claims (S2), worktrees, the handoff allowlist and the scope guard (S3).
// Real git repositories, created and removed by each test under its own case directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCase, orch, idFrom, waitFor, waitForStatus, readRunRecord, testReps } from './helpers.mjs';
import { g, makeRepo, commitAll, craftFinishedRun, contendEach } from './wf-helpers.mjs';
import { normalizeRepoPath, parseAllowBlock } from '../src/scope.mjs';
import { wpKey, ageText } from '../src/claims.mjs';

const json = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`not JSON (exit ${r.code}): ${r.stdout}\n${r.stderr}`);
  }
};

/* ------------------------------------------------------------- claims ----- */

const CLAIM_REPS = testReps(20);

test(`S2: 10 separate processes claim one WP at once, ${CLAIM_REPS} repetition(s) -> exactly one holder each time`, { timeout: 600000 }, async (t) => {
  const c = makeCase('s2-race');
  t.after(() => c.cleanup());
  const BY = ['claude-code', 'codex', 'owner'];
  const winnersPerRep = [];
  const latencies = [];
  for (let rep = 0; rep < CLAIM_REPS; rep++) {
    const wp = `WP-race-${rep}`;
    const res = await contendEach(
      Array.from({ length: 10 }, (_, i) => ['claim', wp, '--by', BY[i % 3], '--session', `p${i}`, '--json']),
      c.env,
    );
    const parsed = res.map((r) => ({ code: r.code, ms: r.ms, out: JSON.parse(r.stdout || '{}'), stderr: r.stderr }));
    const winners = parsed.filter((p) => p.code === 0);
    const losers = parsed.filter((p) => p.code === 3);
    assert.equal(winners.length, 1, `rep ${rep}: ${winners.length} holders: ${JSON.stringify(parsed.map((p) => [p.code, p.out.claim, p.stderr]))}`);
    assert.equal(losers.length, 9, `rep ${rep}: every other contender must be refused with exit 3`);
    const win = winners[0].out;
    for (const l of losers) {
      assert.equal(l.out.claim, 'refused');
      assert.ok(l.out.holder, `rep ${rep}: a refusal must name the holder: ${JSON.stringify(l.out)}`);
      assert.equal(l.out.holder.token, win.token, `rep ${rep}: a refusal named the wrong holder`);
      assert.equal(l.out.holder.by, win.by);
    }
    // The claim on disk is the winner's, complete.
    const onDisk = JSON.parse(fs.readFileSync(path.join(c.stateRoot, 'claims', `${wpKey(wp)}.json`), 'utf8'));
    assert.equal(onDisk.token, win.token);
    winnersPerRep.push(win.by);
    latencies.push(...parsed.map((p) => p.ms));
  }
  latencies.sort((a, b) => a - b);
  console.log(`S2: ${CLAIM_REPS} reps x 10 processes -> exactly 1 holder every rep; winners by: ${winnersPerRep.join(',')}; claim latency ms min=${latencies[0]} max=${latencies[latencies.length - 1]}`);
});

test('S2: release by a non-holder is refused; --force needs a reason, works, and is recorded', { timeout: 120000 }, async (t) => {
  const c = makeCase('s2-release');
  t.after(() => c.cleanup());
  assert.equal((await orch(['claim', 'WP-1', '--by', 'codex', '--json'], c.env)).code, 0);
  const again = await orch(['claim', 'wp-1', '--by', 'codex', '--json'], c.env);
  assert.equal(again.code, 3, 'a claim is exclusive even for the same claimant, and WP names fold case');
  const bad = await orch(['release', 'WP-1', '--by', 'claude-code', '--json'], c.env);
  assert.equal(bad.code, 3);
  assert.equal(json(bad).release, 'refused');
  assert.equal(json(await orch(['claims', '--json'], c.env)).claims.length, 1, 'a refused release changes nothing');
  const noReason = await orch(['release', 'WP-1', '--by', 'claude-code', '--force', '--json'], c.env);
  assert.equal(noReason.code, 2, '--force without --reason is a usage error');
  assert.match(noReason.stderr, /--reason/);
  const forced = await orch(['release', 'WP-1', '--by', 'claude-code', '--force', '--reason', 'codex session died', '--json'], c.env);
  assert.equal(forced.code, 0, forced.stdout + forced.stderr);
  const fo = json(forced);
  assert.equal(fo.release, 'force-released');
  assert.equal(fo.previous_holder, 'codex');
  const log = fs.readFileSync(path.join(c.stateRoot, 'claims', 'claims-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ev = log.find((e) => e.event === 'force-release');
  assert.ok(ev, 'the forced release is recorded');
  assert.equal(ev.by, 'claude-code');
  assert.equal(ev.reason, 'codex session died');
  assert.equal(ev.previous.by, 'codex');
  assert.ok(fs.existsSync(ev.aside), 'the released claim is kept aside, not deleted');
  assert.equal(json(await orch(['claims', '--json'], c.env)).claims.length, 0);
  // The holder can release its own claim without --force.
  assert.equal((await orch(['claim', 'WP-1', '--by', 'owner'], c.env)).code, 0);
  const own = await orch(['release', 'WP-1', '--by', 'owner', '--json'], c.env);
  assert.equal(own.code, 0);
  assert.equal(json(own).release, 'released');
  assert.equal((await orch(['release', 'WP-1', '--by', 'owner'], c.env)).code, 3, 'releasing an unclaimed WP says so');
});

test('S2: a stale claim is SHOWN with its age and never reclaimed automatically', { timeout: 60000 }, async (t) => {
  const c = makeCase('s2-stale');
  t.after(() => c.cleanup());
  const dir = path.join(c.stateRoot, 'claims');
  fs.mkdirSync(dir, { recursive: true });
  // A claim whose owner is long gone: the pid is meaningless, the date is ancient.
  fs.writeFileSync(
    path.join(dir, 'wp-old.json'),
    JSON.stringify({ wp: 'WP-old', wp_key: 'wp-old', by: 'codex', session: null, token: 'deadbeef', claimed_at: '2026-01-01T00:00:00.000Z', claimed_by_pid: 999999 }),
  );
  const list = json(await orch(['claims', '--json'], c.env));
  assert.equal(list.claims[0].by, 'codex');
  assert.match(list.claims[0].age, /^\d+d\d+h$/);
  assert.ok(list.claims[0].age_s > 86400 * 30);
  const r = await orch(['claim', 'WP-old', '--by', 'claude-code', '--json'], c.env);
  assert.equal(r.code, 3, 'no liveness guess: a dead owner does not free the claim');
  assert.equal(json(r).holder.by, 'codex');
  assert.equal(ageText('2026-09-23T10:00:00Z', Date.parse('2026-09-23T11:02:03Z')), '1h2m');
  assert.throws(() => wpKey('../evil'), /invalid work-package/);
  assert.throws(() => wpKey('a b'), /invalid work-package/);
});

/* ---------------------------------------------------------- worktrees ----- */

test('worktree create/list/remove: claim required, branch + baseline recorded, dirty refused, --force recorded', { timeout: 120000 }, async (t) => {
  const c = makeCase('wt-cycle');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  const base = makeRepo(repo, { 'a.txt': 'a\n' });
  const noClaim = await orch(['worktree', 'create', '--repo', repo, '--wp', 'WP-7', '--slice', 's1', '--by', 'codex'], c.env);
  assert.equal(noClaim.code, 2);
  assert.match(noClaim.stderr, /not claimed/);
  await orch(['claim', 'WP-7', '--by', 'owner'], c.env);
  const other = await orch(['worktree', 'create', '--repo', repo, '--wp', 'WP-7', '--slice', 's1', '--by', 'codex'], c.env);
  assert.equal(other.code, 2);
  assert.match(other.stderr, /held by owner/);
  const cr = await orch(['worktree', 'create', '--repo', repo, '--wp', 'WP-7', '--slice', 's1', '--by', 'owner', '--json'], c.env);
  assert.equal(cr.code, 0, cr.stderr);
  const w = json(cr);
  assert.equal(w.baseline, base);
  assert.equal(w.branch, 'orch/wp-7/s1');
  assert.ok(fs.existsSync(path.join(w.path, 'a.txt')));
  assert.ok(path.resolve(w.path).toLowerCase().startsWith(path.join(repo, '.worktrees').toLowerCase()));
  assert.equal(g(w.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'orch/wp-7/s1');
  const dup = await orch(['worktree', 'create', '--repo', repo, '--wp', 'WP-7', '--slice', 's1', '--by', 'owner'], c.env);
  assert.equal(dup.code, 2, 'orch never reuses a path or a branch');
  const listed = json(await orch(['worktree', 'list', '--json'], c.env)).worktrees;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].dirty_entries, 0);

  fs.writeFileSync(path.join(w.path, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(w.path, 'new.txt'), 'n\n');
  const refused = await orch(['worktree', 'remove', w.id, '--json'], c.env);
  assert.equal(refused.code, 3);
  assert.equal(json(refused).reason, 'uncommitted changes');
  assert.ok(fs.existsSync(path.join(w.path, 'new.txt')), 'a refused removal touches nothing');
  const unknown = await orch(['worktree', 'remove', 'wt-not-mine-000000'], c.env);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /only worktrees it created and recorded/);

  const forced = await orch(['worktree', 'remove', w.id, '--force', '--delete-branch', '--json'], c.env);
  assert.equal(forced.code, 0, forced.stderr);
  const fo = json(forced);
  assert.equal(fo.forced, true);
  assert.equal(fo.discarded_entries, 2);
  assert.equal(fo.branch_result, 'deleted');
  assert.ok(!fs.existsSync(w.path));
  const rec = JSON.parse(fs.readFileSync(path.join(c.stateRoot, 'worktrees', `${w.id}.json`), 'utf8'));
  assert.ok(rec.removed_at && rec.removed_forced === true && rec.discarded_entries.length === 2, 'the forced removal is recorded with what it discarded');
});

test('worktree remove without --force keeps an unmerged branch (git branch -d refuses) and says so', { timeout: 120000 }, async (t) => {
  const c = makeCase('wt-branch');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'a.txt': 'a\n' });
  await orch(['claim', 'WP-8', '--by', 'codex'], c.env);
  const w = json(await orch(['worktree', 'create', '--repo', repo, '--wp', 'WP-8', '--slice', 's1', '--by', 'codex', '--json'], c.env));
  fs.writeFileSync(path.join(w.path, 'a.txt'), 'work\n');
  commitAll(w.path, 'implementer work');
  const r = json(await orch(['worktree', 'remove', w.id, '--delete-branch', '--json'], c.env));
  assert.equal(r.remove, 'removed');
  assert.match(r.branch_result, /^not deleted/);
  assert.ok(g(repo, 'rev-parse', '--verify', 'refs/heads/orch/wp-8/s1').trim(), 'the unmerged branch survives');
});

/* ------------------------------------------------------ run + allowlist --- */

test('orch run --wp: claim enforced; allowlist from --allow AND the handoff ALLOW: block; baseline = the worktree\'s', { timeout: 120000 }, async (t) => {
  const c = makeCase('run-wp');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  const base = makeRepo(repo, { 'src/a.js': '1\n', 'docs/x.md': 'x\n' });
  await orch(['claim', 'WP-9', '--by', 'codex'], c.env);
  const w = json(await orch(['worktree', 'create', '--repo', repo, '--wp', 'WP-9', '--slice', 's1', '--by', 'codex', '--json'], c.env));
  // A later commit in the worktree must not move the recorded baseline.
  fs.writeFileSync(path.join(w.path, 'docs/x.md'), 'y\n');
  commitAll(w.path, 'prep');
  const handoff = path.join(c.base, 'h.txt');
  fs.writeFileSync(handoff, 'Do the thing.\n\nALLOW:\n- src/a.js\n- "docs/with space.md"\n\nFORBIDDEN: everything else\n');
  const noBy = await orch(['run', '--cli', 'fake', '--dir', w.path, '--handoff', handoff, '--wp', 'WP-9', '--no-window'], c.env);
  assert.equal(noBy.code, 2);
  assert.match(noBy.stderr, /--by/);
  const wrong = await orch(['run', '--cli', 'fake', '--dir', w.path, '--handoff', handoff, '--wp', 'WP-9', '--by', 'owner', '--no-window'], c.env);
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /held by codex/);
  assert.ok(!fs.existsSync(path.join(c.stateRoot, 'runs')) || fs.readdirSync(path.join(c.stateRoot, 'runs')).length === 0, 'a refused run leaves no record');
  const ok = await orch(['run', '--cli', 'fake', '--dir', w.path, '--handoff', handoff, '--wp', 'WP-9', '--slice', 's1', '--by', 'codex', '--allow', 'docs/x.md', '--size', 'S', '--no-window'], c.env);
  assert.equal(ok.code, 0, ok.stderr);
  const id = idFrom(ok.stdout);
  await waitForStatus(c.stateRoot, id, ['completed', 'failed'], { timeoutMs: 60000 });
  const rec = readRunRecord(c.stateRoot, id);
  assert.equal(rec.wp, 'WP-9');
  assert.equal(rec.slice, 's1');
  assert.equal(rec.by, 'codex');
  assert.equal(rec.size, 'S');
  assert.equal(rec.role, 'implement');
  assert.deepEqual(rec.scope.allow, ['docs/x.md', 'src/a.js', 'docs/with space.md']);
  assert.equal(rec.scope.baseline, base, 'the baseline is the one recorded at worktree creation');
  assert.equal(rec.scope.worktree_id, w.id);
  // an allowlist on a directory that is not a git work tree is refused. (The case
  // directory itself lives inside the kit's own repository, so this one is in OS temp.)
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-plain-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const np = await orch(['run', '--cli', 'fake', '--dir', plain, '--handoff', handoff, '--no-window'], c.env);
  assert.equal(np.code, 2, np.stdout);
  assert.match(np.stderr, /not a git work tree/);
});

test('leak fix: a monitor whose run directory was removed and re-created by its own write STOPS', { timeout: 120000 }, async (t) => {
  // Found in this build: a test's cleanup removed a live run's directory, the monitor's
  // next writeRun re-created it holding only run.json, and the monitor then polled for an
  // hour. The state that race leaves behind is simulated here: prompt.txt gone.
  const c = makeCase('leak-monitor');
  let keeperFile = null;
  // Cleanup must never delete a LIVE run's directory (that is how the leak happened):
  // wait for the keeper to finish first, whatever the assertions did.
  t.after(async () => {
    if (keeperFile) {
      await waitFor(() => fs.existsSync(keeperFile) && fs.readFileSync(keeperFile, 'utf8').includes('keeper-exit'), { timeoutMs: 120000, what: 'the keeper to finish' }).catch(() => {});
    }
    c.cleanup();
  });
  const r = await orch(['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--no-window', '--flag', '--hold', '--flag', '60'], c.env);
  const id = idFrom(r.stdout);
  const runDir = path.join(c.stateRoot, 'runs', id);
  keeperFile = path.join(runDir, 'keeper.ndjson');
  await waitForStatus(c.stateRoot, id, ['running'], { timeoutMs: 30000 });
  const sp = JSON.parse(fs.readFileSync(path.join(runDir, 'spawned.json'), 'utf8'));
  assert.ok(sp.monitor_pid && sp.monitor_created_at, 'monitor identity recorded');
  fs.unlinkSync(path.join(runDir, 'prompt.txt'));
  const { identityOf } = await import('./helpers.mjs');
  // The worker is still running (it holds 60 s): the monitor must stop on its own account,
  // not because the run ended. Observed within ~12 s.
  const until = Date.now() + 12000;
  let verdict = 'match';
  while (Date.now() < until && verdict === 'match') {
    await new Promise((res) => setTimeout(res, 500));
    verdict = await identityOf(sp.monitor_pid, sp.monitor_created_at);
  }
  assert.ok(!fs.readFileSync(path.join(runDir, 'keeper.ndjson'), 'utf8').includes('worker-exit'), 'precondition: the run had not ended');
  assert.equal(verdict, 'gone', 'the monitor must stop once its run directory is no longer the one orch run created');
  // let the fake worker finish on its own (60 s hold, then exit; self-destruct backstop)
  await waitFor(() => fs.readFileSync(path.join(runDir, 'keeper.ndjson'), 'utf8').includes('keeper-exit'), { timeoutMs: 90000, what: 'the keeper to finish' });
});

test('parseAllowBlock and path normalisation (unit)', () => {
  assert.deepEqual(parseAllowBlock('x\nALLOW: one.txt\n- two.txt\n  * `three file.md`\n\nALLOW:\n- four\nNOTES: x\n- not-me\n'), ['one.txt', 'two.txt', 'three file.md', 'four']);
  assert.deepEqual(parseAllowBlock('no block here'), []);
  assert.equal(normalizeRepoPath('.\\Docs\\\\Read Me.MD', true), 'docs/read me.md');
  assert.equal(normalizeRepoPath('./Docs/Read Me.MD', false), 'Docs/Read Me.MD');
  // NFD input compares equal to NFC
  assert.equal(normalizeRepoPath('ñ.txt', false), 'ñ.txt');
});

/* -------------------------------------------------------------- scope ----- */

/** One scope scenario on its own fresh repository. */
async function scenario(c, name, { files, allow, act, ignore = null }) {
  const repo = path.join(c.base, name);
  const all = { ...files };
  if (ignore) all['.gitignore'] = ignore;
  const baseline = makeRepo(repo, all);
  await act(repo);
  const id = craftFinishedRun(c.stateRoot, { dir: repo, baseline, allow });
  const r = await orch(['scope', id, '--json'], c.env);
  const out = json(r);
  const saved = JSON.parse(fs.readFileSync(path.join(c.stateRoot, 'runs', id, 'scope.json'), 'utf8'));
  assert.equal(saved.result, out.result, 'the result is recorded in the run directory');
  return { code: r.code, out };
}

test('S3: scope guard against real repos - allowed, outside, untracked, rename out, delete, ignored, committed', { timeout: 180000 }, async (t) => {
  const c = makeCase('s3-scope');
  t.after(() => c.cleanup());
  const files = { 'src/a.txt': 'a\n', 'b.txt': 'b\n', 'keep.txt': 'k\n' };

  let s = await scenario(c, 'allowed', { files, allow: ['src/a.txt'], act: (d) => fs.writeFileSync(path.join(d, 'src/a.txt'), 'changed\n') });
  assert.equal(s.code, 0);
  assert.equal(s.out.result, 'pass');
  assert.deepEqual(s.out.changed, ['src/a.txt']);

  s = await scenario(c, 'outside', { files, allow: ['src/a.txt'], act: (d) => fs.writeFileSync(path.join(d, 'b.txt'), 'changed\n') });
  assert.equal(s.code, 3);
  assert.deepEqual(s.out.offending, ['b.txt']);

  s = await scenario(c, 'untracked', { files, allow: ['src/a.txt'], act: (d) => fs.writeFileSync(path.join(d, 'src/new.txt'), 'n\n') });
  assert.equal(s.code, 3);
  assert.deepEqual(s.out.offending, ['src/new.txt']);

  // rename OUT of the allowlist, uncommitted (plain filesystem rename)
  s = await scenario(c, 'rename-fs', { files, allow: ['src/a.txt'], act: (d) => fs.renameSync(path.join(d, 'src/a.txt'), path.join(d, 'moved.txt')) });
  assert.equal(s.code, 3);
  assert.deepEqual(s.out.offending, ['moved.txt']);

  // rename out, committed with git mv (the worker committed): --no-renames shows both sides
  s = await scenario(c, 'rename-git', {
    files,
    allow: ['src/a.txt'],
    act: (d) => {
      g(d, 'mv', 'src/a.txt', 'elsewhere.txt');
      commitAll(d, 'rename');
    },
  });
  assert.equal(s.code, 3);
  assert.deepEqual(s.out.offending, ['elsewhere.txt']);
  assert.ok(s.out.changed.includes('src/a.txt') && s.out.changed.includes('elsewhere.txt'), `both sides of the rename are changed paths: ${s.out.changed}`);

  // rename of an UNallowed file: both old and new name are named
  s = await scenario(c, 'rename-unallowed', { files, allow: ['src/a.txt'], act: (d) => fs.renameSync(path.join(d, 'b.txt'), path.join(d, 'c.txt')) });
  assert.deepEqual([...s.out.offending].sort(), ['b.txt', 'c.txt']);

  s = await scenario(c, 'delete', { files, allow: ['src/a.txt'], act: (d) => fs.unlinkSync(path.join(d, 'keep.txt')) });
  assert.equal(s.code, 3);
  assert.deepEqual(s.out.offending, ['keep.txt']);

  s = await scenario(c, 'delete-committed', {
    files,
    allow: ['src/a.txt'],
    act: (d) => {
      g(d, 'rm', '-q', 'keep.txt');
      commitAll(d, 'rm');
    },
  });
  assert.deepEqual(s.out.offending, ['keep.txt']);

  s = await scenario(c, 'ignored', {
    files,
    allow: ['src/a.txt'],
    ignore: '*.log\nbuild/\n',
    act: (d) => {
      fs.writeFileSync(path.join(d, 'debug.log'), 'x\n');
      fs.mkdirSync(path.join(d, 'build'));
      fs.writeFileSync(path.join(d, 'build', 'out.bin'), 'x\n');
    },
  });
  assert.equal(s.code, 0, JSON.stringify(s.out));
  assert.deepEqual(s.out.untracked, [], 'ignored files are not changed paths');

  s = await scenario(c, 'committed-outside', {
    files,
    allow: ['src/a.txt'],
    act: (d) => {
      fs.writeFileSync(path.join(d, 'b.txt'), 'committed change\n');
      commitAll(d, 'sneaky');
    },
  });
  assert.equal(s.code, 3, 'a change the worker COMMITTED is still a change against the baseline');
  assert.deepEqual(s.out.offending, ['b.txt']);

  // missing evidence is unknown, never pass
  const repo = path.join(c.base, 'unknown');
  makeRepo(repo, files);
  const id = craftFinishedRun(c.stateRoot, { dir: repo, baseline: 'f'.repeat(40), allow: ['src/a.txt'] });
  const u = await orch(['scope', id, '--json'], c.env);
  assert.equal(u.code, 4);
  assert.equal(json(u).result, 'unknown');
});

test('S3: paths with spaces, non-ASCII, and case-only differences on NTFS', { timeout: 120000 }, async (t) => {
  const c = makeCase('s3-paths');
  t.after(() => c.cleanup());
  const GREEK = 'Ελληνικά';
  const files = { 'docs/my file.md': 'a\n', [`${GREEK}/ñ file.txt`]: 'g\n', 'docs/readme.md': 'r\n', 'other.txt': 'o\n' };

  let s = await scenario(c, 'spaces-ok', {
    files,
    allow: ['docs/my file.md', `${GREEK}/ñ file.txt`],
    act: (d) => {
      fs.writeFileSync(path.join(d, 'docs/my file.md'), 'changed\n');
      fs.writeFileSync(path.join(d, GREEK, 'ñ file.txt'), 'changed\n');
    },
  });
  assert.equal(s.code, 0, JSON.stringify(s.out));
  assert.ok(s.out.changed.includes(`${GREEK}/ñ file.txt`), `non-ASCII path reported verbatim: ${s.out.changed}`);

  // NFD spelling in the allowlist still matches the NFC path git reports
  s = await scenario(c, 'nfd', {
    files,
    allow: [`${GREEK}/ñ file.txt`],
    act: (d) => fs.writeFileSync(path.join(d, GREEK, 'ñ file.txt'), 'changed\n'),
  });
  assert.equal(s.code, 0, JSON.stringify(s.out));

  s = await scenario(c, 'spaces-bad', {
    files,
    allow: ['docs/my file.md'],
    act: (d) => {
      fs.writeFileSync(path.join(d, 'docs/other file.md'), 'new\n');
      fs.writeFileSync(path.join(d, `${GREEK}/new é.txt`), 'new\n');
    },
  });
  assert.equal(s.code, 3);
  assert.deepEqual([...s.out.offending].sort(), ['docs/other file.md', `${GREEK}/new é.txt`].sort());

  // Case: the repository says it is case-insensitive (measured, not assumed), so an
  // allowlist entry that differs only in case names the same file.
  s = await scenario(c, 'case-allow', { files, allow: ['Docs/README.MD'], act: (d) => fs.writeFileSync(path.join(d, 'docs/readme.md'), 'changed\n') });
  console.log(`S3: core.ignorecase measured in a fresh repo on this filesystem = ${s.out.ignore_case}`);
  assert.equal(s.out.ignore_case, true, 'a fresh repo on NTFS reports core.ignorecase=true');
  assert.equal(s.code, 0, JSON.stringify(s.out));

  // A case-only rename of an UNallowed file, committed: named, and not waved through.
  s = await scenario(c, 'case-rename', {
    files,
    allow: ['docs/my file.md'],
    act: (d) => {
      g(d, 'mv', 'other.txt', 'OTHER.txt');
      commitAll(d, 'case rename');
    },
  });
  assert.equal(s.code, 3, JSON.stringify(s.out));
  assert.ok(s.out.offending.includes('OTHER.txt'), `case-only rename must be named: ${s.out.offending}`);

  // A case-only rename of an ALLOWED file passes (both spellings are the allowed file).
  s = await scenario(c, 'case-rename-allowed', {
    files,
    allow: ['other.txt'],
    act: (d) => {
      g(d, 'mv', 'other.txt', 'Other.TXT');
      commitAll(d, 'case rename');
    },
  });
  assert.equal(s.code, 0, JSON.stringify(s.out));
});

test('scope refuses a run that has not finished, and a run with no allowlist', { timeout: 60000 }, async (t) => {
  const c = makeCase('s3-refuse');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'r');
  const baseline = makeRepo(repo, { 'a.txt': 'a\n' });
  const id = craftFinishedRun(c.stateRoot, { dir: repo, baseline, allow: ['a.txt'] });
  fs.writeFileSync(path.join(c.stateRoot, 'runs', id, 'keeper.ndjson'), JSON.stringify({ event: 'spawned', worker_pid: 1, at: new Date().toISOString() }) + '\n');
  const r = await orch(['scope', id], c.env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /has not finished/);
  const id2 = craftFinishedRun(c.stateRoot, { dir: repo, baseline, allow: ['a.txt'], extra: { scope: null } });
  const r2 = await orch(['scope', id2], c.env);
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /no allowlist/);
});
