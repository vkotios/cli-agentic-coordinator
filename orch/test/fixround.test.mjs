// Slice-2 code-review fix round: one test per finding (c1-c4, a1-a5) and per smoke
// follow-up (F1-F3). Every test here FAILS on 8413ba6 and passes after the fix; the report
// maps each to the assertion that fails on the old tree. Fake workers, real git, no models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KIT, makeCase, orch, idFrom, waitForStatus } from './helpers.mjs';
import { g, makeRepo, commitAll, craftFinishedRun, repoFingerprint } from './wf-helpers.mjs';

const FIX = path.join(KIT, 'test', 'fixtures');
const SRC = (f) => new URL(`../src/${f}`, import.meta.url).href;
const json = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`not JSON (exit ${r.code}): ${r.stdout}\n${r.stderr}`);
  }
};

/** Repo + claim + worktree + a finished fake implementer run + a commit to review. */
async function setupImpl(c) {
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'src/a.js': '1\n', 'secret/answer.md': 'the answer\n', 'README.md': 'r\n' });
  assert.equal((await orch(['claim', 'WP-F', '--by', 'codex'], c.env)).code, 0);
  const w = json(await orch(['worktree', 'create', '--repo', repo, '--wp', 'WP-F', '--slice', 's1', '--by', 'codex', '--json'], c.env));
  const r = await orch(['run', '--cli', 'fake', '--model', 'localai/qwen3-coder-30b', '--dir', w.path, '--handoff', c.handoffPath, '--wp', 'WP-F', '--slice', 's1', '--by', 'codex', '--allow', 'src/a.js', '--no-window'], c.env);
  const runId = idFrom(r.stdout);
  await waitForStatus(c.stateRoot, runId, ['completed', 'failed'], { timeoutMs: 60000 });
  fs.writeFileSync(path.join(w.path, 'src/a.js'), '2\n');
  const commit = commitAll(w.path, 'implementation');
  return { repo, wt: w, commit, runId, reviewRoot: path.join(c.base, 'reviews') };
}
const reviewArgs = (s, c, extra = []) => ['review', '--run', s.runId, '--ref', s.commit, '--reviewer', 'fake', '--model', 'gemini-3.8-flash-high', '--prompt', c.handoffPath, '--by', 'codex', '--review-root', s.reviewRoot, '--no-window', '--json', ...extra];
const registered = (repo, wt) => g(repo, 'worktree', 'list', '--porcelain').toLowerCase().includes(path.basename(wt).toLowerCase());

/* ------------------------------------------------------------------ c1 ---- */

test('c1: a crash between the marker and the append never blocks the run silently; --force retries; a torn line never swallows a row', { timeout: 60000 }, async (t) => {
  const c = makeCase('fx-c1');
  t.after(() => c.cleanup());
  const ledger = path.join(c.base, 'ledger.jsonl');
  const id = craftFinishedRun(c.stateRoot, { dir: c.work, baseline: null, allow: [], extra: { model_requested: 'm1', scope: null } });
  const crash = await orch(['record', id, '--disposition', 'accepted', '--ledger', ledger], { ...c.env, ORCH_TEST_LEDGER_CRASH: 'after-marker' });
  assert.equal(crash.code, 9, `the test hook must end the process between marker and append (exit ${crash.code}: ${crash.stdout})`);
  assert.ok(!fs.existsSync(ledger) || !fs.readFileSync(ledger, 'utf8').includes(id), 'no row was written');
  const again = await orch(['record', id, '--disposition', 'accepted', '--ledger', ledger, '--json'], c.env);
  assert.equal(again.code, 3);
  assert.match(json(again).reason, /did not complete/, 'the refusal says the earlier attempt did not complete - it never claims the row exists');
  const forced = await orch(['record', id, '--disposition', 'accepted', '--ledger', ledger, '--force', '--json'], c.env);
  assert.equal(forced.code, 0, forced.stdout + forced.stderr);
  const marker = JSON.parse(fs.readFileSync(path.join(c.base, 'ledger.jsonl.d', `${id}.recorded`), 'utf8'));
  assert.equal(marker.state, 'recorded');
  assert.equal(marker.forced_over.state, 'pending');
  assert.equal((await orch(['record', id, '--disposition', 'accepted', '--ledger', ledger], c.env)).code, 3, 'and now it is a duplicate');
  // A torn fragment at the end of the ledger (a crashed writer) must not swallow the next row.
  fs.appendFileSync(ledger, '{"run_id":"torn-frag');
  const id2 = craftFinishedRun(c.stateRoot, { dir: c.work, baseline: null, allow: [], extra: { model_requested: 'm2', scope: null } });
  assert.equal((await orch(['record', id2, '--disposition', 'rejected', '--ledger', ledger], c.env)).code, 0);
  const { readLedger } = await import(SRC('ledger.mjs'));
  const { rows, bad } = readLedger(ledger);
  assert.ok(rows.some((r) => r.run_id === id2), 'the new row is intact on its own line');
  assert.equal(bad, 1, 'only the fragment is unreadable');
});

/* ------------------------------------------------------------------ c2 ---- */

test('c2: a reviewer that changes the SHARED git config (core.hooksPath) or writes a hook is a containment-breach', { timeout: 180000 }, async (t) => {
  const c = makeCase('fx-c2');
  t.after(() => c.cleanup());
  const s = await setupImpl(c);
  const r = await orch([...reviewArgs(s, c), '--flag', '--git-config', '--flag', 'core.hooksPath=C:/evil/hooks'], c.env);
  const rv = json(r);
  assert.equal(g(s.repo, 'config', '--local', 'core.hooksPath').trim(), 'C:/evil/hooks', 'precondition: the fake reviewer really wrote the shared config');
  assert.equal(r.code, 5, `expected a breach, got ${rv.containment}`);
  assert.ok(rv.breaches.includes('source admin changed'), JSON.stringify(rv.breaches));
  assert.ok(rv.evidence.source_admin_after.some((l) => l.startsWith('config ')));
  g(s.repo, 'config', '--local', '--unset', 'core.hooksPath');
  const hook = path.join(s.repo, '.git', 'hooks', 'post-checkout');
  const r2 = await orch([...reviewArgs(s, c), '--flag', '--write-abs', '--flag', hook], c.env);
  assert.equal(r2.code, 5, json(r2).containment);
  assert.ok(json(r2).evidence.source_admin_after.some((l) => l.startsWith('hooks/post-checkout ')));
});

/* ------------------------------------------------------------------ c3 ---- */

test('c3: review --finish of a WP review needs --by holding the claim NOW', { timeout: 180000 }, async (t) => {
  const c = makeCase('fx-c3');
  t.after(() => c.cleanup());
  const s = await setupImpl(c);
  const r = await orch([...reviewArgs(s, c), '--no-wait'], c.env);
  assert.equal(r.code, 0, r.stderr);
  const id = json(r).review_id;
  const rid = json(r).run_id;
  await waitForStatus(c.stateRoot, rid, ['completed', 'failed'], { timeoutMs: 60000 });
  const noBy = await orch(['review', '--finish', id], c.env);
  assert.equal(noBy.code, 2);
  assert.match(noBy.stderr, /--by is required/);
  const other = await orch(['review', '--finish', id, '--by', 'owner'], c.env);
  assert.equal(other.code, 2);
  assert.match(other.stderr, /held by codex/);
  const wtPath = JSON.parse(fs.readFileSync(path.join(c.stateRoot, 'reviews', `${id}.json`), 'utf8')).worktree;
  assert.ok(fs.existsSync(wtPath), 'a refused finish removes nothing');
  const ok = await orch(['review', '--finish', id, '--by', 'codex', '--json'], c.env);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(json(ok).outcome, 'reviewed');
  assert.ok(!fs.existsSync(wtPath));
});

/* ------------------------------------------------------------------ c4 ---- */

test('c4: a failure after the worktree exists (unreadable prompt) removes the worktree and says so', { timeout: 120000 }, async (t) => {
  const c = makeCase('fx-c4');
  t.after(() => c.cleanup());
  const s = await setupImpl(c);
  const promptDir = path.join(c.base, 'prompt-is-a-directory');
  fs.mkdirSync(promptDir);
  const r = await orch(reviewArgs(s, c).map((a) => (a === c.handoffPath ? promptDir : a)), c.env);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /failed during setup .* Review worktree .*: removed/);
  const recs = fs.readdirSync(path.join(c.stateRoot, 'reviews')).filter((f) => /^rv-.*\.json$/.test(f));
  const rv = JSON.parse(fs.readFileSync(path.join(c.stateRoot, 'reviews', recs[0]), 'utf8'));
  assert.equal(rv.outcome, 'setup-failed');
  assert.equal(rv.worktree_removed, true);
  assert.ok(!fs.existsSync(rv.worktree), 'no leaked worktree directory');
  assert.ok(!registered(s.repo, rv.worktree), 'and git does not list it');
});

/* ------------------------------------------------------------------ a1 ---- */

test('a1: a reviewer that never launched, or whose run did not complete, is NOT a review: exit 6, stated', { timeout: 180000 }, async (t) => {
  const c = makeCase('fx-a1');
  t.after(() => c.cleanup());
  const s = await setupImpl(c);
  const before = repoFingerprint(s.repo);
  const r = await orch(reviewArgs(s, c), { ...c.env, ORCH_FAKE_EXE: 'C:\\definitely\\missing\\reviewer.exe' });
  const rv = json(r);
  assert.equal(r.code, 6, `a review that never ran must not exit 0 (got ${r.code}, ${rv.containment})`);
  assert.equal(rv.outcome, 'not-launched');
  assert.match(rv.launch_error, /admission blocked/);
  assert.equal(rv.worktree_removed, true);
  assert.deepEqual(repoFingerprint(s.repo), before);
  const txt = await orch(['review', '--finish', rv.id, '--by', 'codex'], c.env);
  assert.match(txt.stdout, /NO REVIEW PERFORMED \(not-launched\)/);
  assert.equal(txt.code, 6);
  const f = await orch([...reviewArgs(s, c), '--flag', '--exit', '--flag', '3'], c.env);
  assert.equal(f.code, 6);
  assert.equal(json(f).outcome, 'not-reviewed');
  assert.equal(json(f).reviewer_run_status, 'failed');
});

/* ------------------------------------------------------------------ a2 ---- */

test('a2: overlapping --blind globs delete each file once; no crash, no leaked worktree', { timeout: 120000 }, async (t) => {
  const c = makeCase('fx-a2');
  t.after(() => c.cleanup());
  const s = await setupImpl(c);
  const r = await orch([...reviewArgs(s, c), '--blind', 'secret/**', '--blind', 'secret/answer.md', '--blind', '**/*.md'], c.env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const rv = json(r);
  assert.deepEqual([...rv.blinded].sort(), ['README.md', 'secret/answer.md']);
  assert.equal(rv.blinding_verified, true);
  assert.equal(rv.worktree_removed, true);
});

/* ------------------------------------------------------------------ a3 ---- */

test('a3: a backslash provider separator cannot bypass the same-model refusal', { timeout: 120000 }, async (t) => {
  const { canonicalId } = await import(SRC('models.mjs'));
  assert.equal(canonicalId('localai\\qwen3-coder-30b'), 'qwen3-coder-30b');
  assert.equal(canonicalId('a\\b/QWEN3-coder-30b'), 'qwen3-coder-30b');
  const c = makeCase('fx-a3');
  t.after(() => c.cleanup());
  const s = await setupImpl(c);
  const r = await orch(reviewArgs(s, c).map((a) => (a === 'gemini-3.8-flash-high' ? 'localai\\qwen3-coder-30b' : a)), c.env);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /is the implementer's model/);
});

/* ------------------------------------------------------------------ a4 ---- */

test('a4: orch record refuses a run whose run.json is not terminal yet, even with a worker-exit line', { timeout: 60000 }, async (t) => {
  const c = makeCase('fx-a4');
  t.after(() => c.cleanup());
  const id = craftFinishedRun(c.stateRoot, { dir: c.work, baseline: null, allow: [], extra: { status: 'running', model_requested: 'm', scope: null } });
  const ledger = path.join(c.base, 'ledger.jsonl');
  const r = await orch(['record', id, '--disposition', 'accepted', '--ledger', ledger], c.env);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /not terminal .*run\.json is not final yet/);
  assert.ok(!fs.existsSync(ledger));
  assert.ok(!fs.existsSync(path.join(c.base, 'ledger.jsonl.d', `${id}.recorded`)), 'and no marker blocks a later record');
});

/* ------------------------------------------------------------------ a5 ---- */

test('a5: pick --for-run falls back to the ledger row when the run directory is gone', { timeout: 60000 }, async (t) => {
  const c = makeCase('fx-a5');
  t.after(() => c.cleanup());
  const ledger = path.join(c.base, 'ledger.jsonl');
  fs.writeFileSync(ledger, JSON.stringify({ run_id: 'run-old-01', workload: 'implement', model_requested: 'localai/qwen3-coder-30b', model_actual: null, model_canonical: 'qwen3-coder-30b', disposition: 'accepted' }) + '\n');
  const r = await orch(['pick', '--workload', 'review', '--size', 'S', '--for-run', 'run-old-01', '--ledger', ledger, '--json'], c.env);
  assert.equal(r.code, 0, r.stderr);
  const p = json(r);
  assert.ok(p.excluded.some((e) => /qwen3-coder-30b/.test(e.model) && /implementer's own model/.test(e.why)));
  const none = await orch(['pick', '--workload', 'review', '--size', 'S', '--for-run', 'never-existed', '--ledger', ledger], c.env);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /no run record and no ledger row/);
});

/* ------------------------------------------------------------------ F1 ---- */

test('F1: codex model-used from THIS run\'s session rollout (recorded --json review run, no header); ambiguity = unknown', async () => {
  const mod = await import(SRC('adapters/codex.mjs'));
  const THREAD = '00000000-0000-7000-8000-000000000003';
  const DIR = 'C:\\work\\sandbox\\reviews\\rv-20260101-000000-aaaaaa';
  const START = Date.parse('2026-09-23T16:16:01.652Z');
  const stdout = fs.readFileSync(path.join(FIX, 'codex-json-review.stdout.jsonl'), 'utf8');
  const events = mod.default.parseProtocol(stdout);
  assert.equal(mod.extractCodexModel('', events).model, null, 'the recorded --json run carries no model on stdout, and its stderr.log was 0 bytes');
  assert.equal(typeof mod.codexModelFromRollout, 'function', 'a rollout-based source exists');
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-codex-sessions-'));
  try {
    const day = path.join(sessions, '2026', '09', '23');
    fs.mkdirSync(day, { recursive: true });
    const rollout = path.join(day, `rollout-2026-09-23T17-16-00-${THREAD}.jsonl`);
    fs.copyFileSync(path.join(FIX, 'codex-rollout-review.reduced.jsonl'), rollout);
    // decoys: another session's rollout the same day
    fs.writeFileSync(path.join(day, 'rollout-2026-09-23T17-18-29-00000000-0000-7000-8000-000000000007.jsonl'), '{"type":"session_meta","payload":{"id":"00000000-0000-7000-8000-000000000007","cwd":"C:\\\\x"}}\n{"type":"turn_context","payload":{"model":"gpt-6-astra"}}\n');
    const got = mod.codexModelFromRollout({ events, dir: DIR, startedAtMs: START, sessionsDir: sessions });
    assert.deepEqual([got.model, got.effort, got.source], ['gpt-5.6-terra', 'medium', 'codex-rollout'], got.reason);
    assert.equal(mod.codexModelFromRollout({ events, dir: 'C:\\somewhere\\else', startedAtMs: START, sessionsDir: sessions }).model, null, 'a different --dir is not this run');
    assert.equal(mod.codexModelFromRollout({ events: [], dir: DIR, startedAtMs: START, sessionsDir: sessions }).model, null, 'no thread id -> unknown');
    // postExit wires it (through ORCH_CODEX_SESSIONS)
    const rd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-codex-run-'));
    fs.writeFileSync(path.join(rd, 'stdout.log'), stdout);
    fs.writeFileSync(path.join(rd, 'stderr.log'), '');
    process.env.ORCH_CODEX_SESSIONS = sessions;
    try {
      const post = mod.default.postExit({ stdoutPath: path.join(rd, 'stdout.log'), stderrPath: path.join(rd, 'stderr.log'), dir: DIR, startedAtMs: START, requestedCanonical: 'gpt-5.6-terra' });
      assert.equal(post.actual_model, 'gpt-5.6-terra');
      assert.equal(post.actual_model_source, 'codex-rollout');
      assert.equal(post.model_mismatch, false);
    } finally {
      delete process.env.ORCH_CODEX_SESSIONS;
      fs.rmSync(rd, { recursive: true, force: true });
    }
    // two rollouts for the same thread (e.g. a copy in the next day's folder) -> unknown
    const next = path.join(sessions, '2026', '09', '24');
    fs.mkdirSync(next, { recursive: true });
    fs.copyFileSync(rollout, path.join(next, path.basename(rollout)));
    const amb = mod.codexModelFromRollout({ events, dir: DIR, startedAtMs: START, sessionsDir: sessions });
    assert.equal(amb.model, null);
    assert.match(amb.reason, /2 rollout files/);
  } finally {
    fs.rmSync(sessions, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ F2 ---- */

test('F2: agy "not in local config, defaulting" / "resolved via default" -> model used UNKNOWN, never the requested id', async () => {
  const mod = await import(SRC('adapters/agy.mjs'));
  const log = fs.readFileSync(path.join(FIX, 'agy-defaulting.log.txt'), 'utf8');
  const got = mod.extractAgyModel(log);
  assert.equal(got.model, null, 'the recorded run logged the defaulting lines: the model used is unknown');
  assert.equal(got.claimed, 'gemini-3.8-flash-high');
  assert.equal(got.defaultTarget, 'CCPA');
  const rd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agy-run-'));
  try {
    fs.writeFileSync(path.join(rd, 'agy.log'), log);
    const post = mod.default.postExit({ runDir: rd, requestedCanonical: 'gemini-3.8-flash-high' });
    assert.equal(post.actual_model, null);
    assert.ok(post.warnings.some((w) => /not in its local config .*UNKNOWN/.test(w)));
    // Without the defaulting lines, the logged model is accepted.
    fs.writeFileSync(path.join(rd, 'agy.log'), log.split('\n').filter((l) => !/resolver\.go/.test(l)).join('\n'));
    assert.equal(mod.default.postExit({ runDir: rd, requestedCanonical: 'gemini-3.8-flash-high' }).actual_model, 'gemini-3.8-flash-high');
  } finally {
    fs.rmSync(rd, { recursive: true, force: true });
  }
  // GeminiDir: orch sets no Gemini-related variable - only PWD (see the report for why
  // the "must be an absolute path" line is agy's own, not orch's).
  process.env.ORCH_AGY_EXE = 'C:\\fake\\agy.exe';
  try {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agy-b-'));
    fs.writeFileSync(path.join(d, 'prompt.txt'), 'x');
    const b = mod.default.build({ model: 'm', dir: d, flags: [], promptPath: path.join(d, 'prompt.txt'), runDir: d });
    assert.deepEqual(b.envSet, { PWD: d });
    assert.deepEqual(b.envDelete, []);
    fs.rmSync(d, { recursive: true, force: true });
  } finally {
    delete process.env.ORCH_AGY_EXE;
  }
  // keepalive refinement: real model calls through http_helpers ARE activity
  const lines = log.split(/\r?\n/);
  assert.ok(!mod.default.isKeepalive(lines.find((l) => /streamGenerateContent/.test(l))), 'a streamGenerateContent call is activity');
  assert.ok(mod.default.isKeepalive(lines.find((l) => /fetchAvailableModels/.test(l))));
});

/* ------------------------------------------------------------------ F3 ---- */

test('F3: worktree create puts /.worktrees/ into .git/info/exclude once; the source status stays clean; tracked files untouched', { timeout: 120000 }, async (t) => {
  const c = makeCase('fx-f3');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'a.txt': 'a\n', '.gitignore': 'node_modules/\n' });
  const exclude = path.join(repo, '.git', 'info', 'exclude');
  fs.writeFileSync(exclude, '# pre-existing user line\n*.tmp'); // no trailing newline on purpose
  await orch(['claim', 'WP-X', '--by', 'codex'], c.env);
  for (const slice of ['s1', 's2']) {
    const r = await orch(['worktree', 'create', '--repo', repo, '--wp', 'WP-X', '--slice', slice, '--by', 'codex'], c.env);
    assert.equal(r.code, 0, r.stderr);
  }
  const text = fs.readFileSync(exclude, 'utf8');
  assert.equal(text.split(/\r?\n/).filter((l) => l.trim() === '/.worktrees/').length, 1, `exactly one entry:\n${text}`);
  assert.ok(text.includes('# pre-existing user line\n*.tmp\n'), 'the existing lines are kept intact');
  assert.equal(g(repo, 'status', '--porcelain', '--untracked-files=all'), '', 'the managed repo shows no .worktrees/ entry');
  assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), 'node_modules/\n', 'the tracked .gitignore is untouched');
});
