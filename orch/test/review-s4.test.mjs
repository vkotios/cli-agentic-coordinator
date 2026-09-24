// Slice 2, gate S4: `orch review` - canonical-model refusal, blinding, containment.
// Fake reviewers (test-only adapter), real git, no model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCase, orch, idFrom, waitForStatus, readRunRecord, readRunFile } from './helpers.mjs';
import { g, makeRepo, commitAll, repoFingerprint } from './wf-helpers.mjs';
import { globToRegex } from '../src/review.mjs';

const json = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`not JSON (exit ${r.code}): ${r.stdout}\n${r.stderr}`);
  }
};

/** Repo + claim + worktree + a finished fake implementer run with a commit to review. */
async function setupImpl(c, { model = 'localai/qwen3-coder-30b' } = {}) {
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'src/a.js': '1\n', 'secret/answer.md': 'the answer\n', 'secret/deep/x.md': 'x\n', 'README.md': 'r\n' });
  assert.equal((await orch(['claim', 'WP-R', '--by', 'codex'], c.env)).code, 0);
  const w = json(await orch(['worktree', 'create', '--repo', repo, '--wp', 'WP-R', '--slice', 's1', '--by', 'codex', '--json'], c.env));
  const r = await orch(['run', '--cli', 'fake', '--model', model, '--dir', w.path, '--handoff', c.handoffPath, '--wp', 'WP-R', '--slice', 's1', '--by', 'codex', '--allow', 'src/a.js', '--no-window'], c.env);
  assert.equal(r.code, 0, r.stderr);
  const runId = idFrom(r.stdout);
  await waitForStatus(c.stateRoot, runId, ['completed', 'failed'], { timeoutMs: 60000 });
  fs.writeFileSync(path.join(w.path, 'src/a.js'), '2\n');
  const commit = commitAll(w.path, 'implementation');
  return { repo, wt: w, commit, runId, reviewRoot: path.join(c.base, 'reviews') };
}

function reviewArgs(s, c, extra = []) {
  return ['review', '--run', s.runId, '--ref', s.commit, '--reviewer', 'fake', '--prompt', c.handoffPath, '--by', 'codex', '--review-root', s.reviewRoot, '--no-window', '--json', ...extra];
}

function assertWorktreeGone(s, rv) {
  assert.equal(rv.worktree_removed, true, `worktree not removed: ${rv.worktree_remove_error}`);
  assert.ok(!fs.existsSync(rv.worktree), 'the review worktree directory is gone');
  assert.ok(!g(s.repo, 'worktree', 'list', '--porcelain').toLowerCase().includes(path.basename(rv.worktree).toLowerCase()), 'and git no longer lists it');
}

test('S4: the same canonical model is refused (localai/qwen3-coder-30b vs qwen3-coder-30b); same family only warns', { timeout: 180000 }, async (t) => {
  const c = makeCase('s4-same');
  t.after(() => c.cleanup());
  const s = await setupImpl(c);
  const before = repoFingerprint(s.repo);
  for (const m of ['qwen3-coder-30b', 'QWEN3-Coder-30B', 'other-provider/qwen3-coder-30b']) {
    const r = await orch([...reviewArgs(s, c), '--model', m], c.env);
    assert.equal(r.code, 2, `${m}: ${r.stdout}`);
    assert.match(r.stderr, /refused: reviewer model .* is the implementer's model/);
  }
  assert.ok(!fs.existsSync(s.reviewRoot) || fs.readdirSync(s.reviewRoot).length === 0, 'a refused review creates no worktree');
  assert.deepEqual(repoFingerprint(s.repo), before, 'the source repo is untouched');
  // Same family, different model: allowed, with a warning.
  const fam = await orch([...reviewArgs(s, c), '--model', 'qwen3.8-27b'], c.env);
  assert.equal(fam.code, 0, fam.stdout + fam.stderr);
  const rv = json(fam);
  assert.ok(rv.warnings.some((w) => /same model FAMILY \(qwen\)/.test(w)), `family warning expected: ${rv.warnings}`);
  assert.equal(rv.containment, 'clean');
  assertWorktreeGone(s, rv);
  assert.deepEqual(repoFingerprint(s.repo), before);
});

test('S4: a clean reviewer with blinding -> clean; blinded files invisible to it; worktree removed; source untouched', { timeout: 180000 }, async (t) => {
  const c = makeCase('s4-clean');
  t.after(() => c.cleanup());
  const s = await setupImpl(c);
  const before = repoFingerprint(s.repo);
  const implBefore = repoFingerprint(s.wt.path);
  const prompt = path.join(c.base, 'review-prompt.txt');
  fs.writeFileSync(prompt, 'Review ONLY {{WORKTREE}} (absolute path). Twice: {{WORKTREE}}\n');
  const r = await orch([...reviewArgs(s, c).map((a) => (a === c.handoffPath ? prompt : a)), '--model', 'gemini-3.8-flash-high', '--blind', 'secret/**', '--flag', '--ls'], c.env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const rv = json(r);
  assert.equal(rv.containment, 'clean', JSON.stringify(rv.breaches));
  assert.deepEqual([...rv.blinded].sort(), ['secret/answer.md', 'secret/deep/x.md']);
  assert.equal(rv.blinding_verified, true);
  assert.equal(rv.commit, s.commit);
  const out = readRunFile(c.stateRoot, rv.run_id, 'stdout.log');
  assert.match(out, /^LS src\/a\.js$/m, 'the reviewer saw the implementation');
  assert.match(out, /^LS README\.md$/m);
  assert.doesNotMatch(out, /LS secret\//, 'the reviewer never saw a blinded file');
  const rec = readRunRecord(c.stateRoot, rv.run_id);
  assert.equal(readRunFile(c.stateRoot, rv.run_id, 'prompt.txt'), `Review ONLY ${rv.worktree} (absolute path). Twice: ${rv.worktree}\n`, '{{WORKTREE}} is filled with the review worktree path');
  assert.equal(fs.readFileSync(prompt, 'utf8').includes('{{WORKTREE}}'), true, 'the caller\'s prompt file is untouched');
  assert.equal(rec.review_of, s.runId, 'the review run is linked to the implementer run');
  assert.equal(rec.role, 'review');
  assert.equal(rec.dir.toLowerCase(), rv.worktree.toLowerCase());
  assertWorktreeGone(s, rv);
  assert.deepEqual(repoFingerprint(s.repo), before, 'source repo untouched');
  assert.deepEqual(repoFingerprint(s.wt.path), implBefore, 'implementer worktree untouched');
  // the record is on disk and `--finish` again just reports it
  const again = await orch(['review', '--finish', rv.id, '--json'], c.env);
  assert.equal(again.code, 0);
  assert.equal(json(again).containment, 'clean');
});

test('S4: a reviewer that WRITES a file is flagged containment-breach; worktree still removed; source untouched', { timeout: 180000 }, async (t) => {
  const c = makeCase('s4-write');
  t.after(() => c.cleanup());
  const s = await setupImpl(c);
  const before = repoFingerprint(s.repo);
  const r = await orch([...reviewArgs(s, c), '--model', 'gemini-3.8-flash-high', '--blind', 'secret/*.md', '--flag', '--write-file', '--flag', 'review-notes.txt'], c.env);
  assert.equal(r.code, 5, r.stdout + r.stderr);
  const rv = json(r);
  assert.equal(rv.containment, 'containment-breach');
  assert.ok(rv.breaches.some((b) => /review worktree changed: \?\? review-notes\.txt/.test(b)), JSON.stringify(rv.breaches));
  assert.ok(rv.evidence.worktree_status_after.includes('?? review-notes.txt'), 'the evidence is recorded');
  assert.deepEqual(rv.blinded, ['secret/answer.md'], '`*` does not cross a directory');
  assertWorktreeGone(s, rv);
  assert.deepEqual(repoFingerprint(s.repo), before);
});

test('S4: a reviewer that COMMITS is flagged containment-breach (HEAD + reflog moved), with the commit as evidence', { timeout: 180000 }, async (t) => {
  const c = makeCase('s4-commit');
  t.after(() => c.cleanup());
  const s = await setupImpl(c);
  const before = repoFingerprint(s.repo);
  const r = await orch([...reviewArgs(s, c), '--model', 'gemini-3.8-flash-high', '--flag', '--git-commit'], c.env);
  assert.equal(r.code, 5, r.stdout + r.stderr);
  const rv = json(r);
  assert.match(readRunFile(c.stateRoot, rv.run_id, 'stdout.log'), /GIT-COMMIT done/, 'the fake reviewer really committed');
  assert.equal(rv.containment, 'containment-breach');
  assert.ok(rv.breaches.some((b) => /review worktree HEAD moved/.test(b)), JSON.stringify(rv.breaches));
  assert.ok(rv.breaches.some((b) => /reflog changed/.test(b)));
  assert.ok(rv.evidence.new_commits.some((l) => /a reviewer must never commit/.test(l)));
  assertWorktreeGone(s, rv);
  assert.deepEqual(repoFingerprint(s.repo), before, 'a detached-worktree commit moves no ref of the source repo');
});

test('S4: a reviewer that writes into the SOURCE repo is flagged, with before/after evidence', { timeout: 180000 }, async (t) => {
  const c = makeCase('s4-source');
  t.after(() => c.cleanup());
  const s = await setupImpl(c);
  const intruder = path.join(s.repo, 'intruder.txt');
  const r = await orch([...reviewArgs(s, c), '--model', 'gemini-3.8-flash-high', '--flag', '--write-abs', '--flag', intruder], c.env);
  assert.equal(r.code, 5, r.stdout + r.stderr);
  const rv = json(r);
  assert.equal(rv.containment, 'containment-breach');
  assert.ok(rv.breaches.includes('source status changed'), JSON.stringify(rv.breaches));
  assert.ok(rv.evidence.source_status_after.some((l) => l.includes('intruder.txt')));
  assertWorktreeGone(s, rv);
  assert.ok(fs.existsSync(intruder), 'orch reports; it never cleans up the source repo on its own');
});

test('S4: the review root must be neutral (not temp/scratch, not inside the repo); a WP review needs the claim', { timeout: 180000 }, async (t) => {
  const c = makeCase('s4-root');
  t.after(() => c.cleanup());
  const s = await setupImpl(c);
  const tmpRoot = path.join(os.tmpdir(), 'orch-review-root-test');
  let r = await orch([...reviewArgs(s, c), '--model', 'gemini-x', '--review-root', tmpRoot], c.env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /temp/);
  assert.ok(!fs.existsSync(tmpRoot), 'nothing was created under temp');
  r = await orch([...reviewArgs(s, c), '--model', 'gemini-x', '--review-root', path.join(s.repo, 'reviews')], c.env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /inside/);
  r = await orch([...reviewArgs(s, c).map((a) => (a === 'codex' ? 'owner' : a)), '--model', 'gemini-x'], c.env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /held by codex/);
});

test('globToRegex (unit)', () => {
  assert.ok(globToRegex('secret/**', false).test('secret/a/b.md'));
  assert.ok(globToRegex('**/*.md', false).test('a.md'));
  assert.ok(globToRegex('**/*.md', false).test('x/y/a.md'));
  assert.ok(!globToRegex('secret/*.md', false).test('secret/deep/x.md'));
  assert.ok(globToRegex('Secret/*.MD', true).test('secret/a.md'));
  assert.ok(!globToRegex('a?.txt', false).test('a/.txt'));
  assert.ok(globToRegex('docs/my file (1).md', false).test('docs/my file (1).md'));
});
