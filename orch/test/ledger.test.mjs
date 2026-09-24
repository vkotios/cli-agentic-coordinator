// Slice 2, gate S6: `orch record` (concurrent appends) and `orch pick` (determinism and
// every rule of the rotation rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeCase, orch, testReps } from './helpers.mjs';
import { craftFinishedRun, contendEach, makeRepo, g } from './wf-helpers.mjs';
import { computePick, readLedger } from '../src/ledger.mjs';
import { loadRoster, canonicalId } from '../src/models.mjs';

function craftRun(c, model, extra = {}) {
  return craftFinishedRun(c.stateRoot, { dir: c.work, baseline: null, allow: [], extra: { model_requested: model, model_canonical: canonicalId(model), cli: 'opencode', scope: null, ...extra } });
}

const RECORD_REPS = testReps(3);

test(`S6: 10 processes run 'orch record' at once -> 10 intact lines (${RECORD_REPS} repetition(s))`, { timeout: 300000 }, async (t) => {
  const c = makeCase('s6-concurrent');
  t.after(() => c.cleanup());
  const ledger = path.join(c.base, 'ledger.jsonl');
  const all = [];
  for (let rep = 0; rep < RECORD_REPS; rep++) {
    const ids = Array.from({ length: 10 }, (_, i) => craftRun(c, `localai/model-${rep}-${i}`, { notes_pad: 'x'.repeat(2000 + i * 300) }));
    all.push(...ids);
    const res = await contendEach(
      ids.map((id) => ['record', id, '--disposition', 'accepted', '--ledger', ledger, '--notes', `rep ${rep} ${'y'.repeat(1500)}`, '--json']),
      c.env,
    );
    assert.deepEqual(res.map((r) => r.code), Array(10).fill(0), JSON.stringify(res.map((r) => r.stderr)));
    const starts = res.map((r) => r.startedAt);
    console.log(`S6 rep ${rep}: 10 record processes released within ${Math.max(...starts) - Math.min(...starts)} ms of each other; each took ${Math.min(...res.map((r) => r.ms))}-${Math.max(...res.map((r) => r.ms))} ms`);
    const text = fs.readFileSync(ledger, 'utf8');
    assert.ok(text.endsWith('\n'));
    const lines = text.split('\n').filter(Boolean);
    assert.equal(lines.length, (rep + 1) * 10, `rep ${rep}: line count`);
    for (const l of lines) JSON.parse(l); // every line intact, none interleaved
  }
  const { rows, bad } = readLedger(ledger);
  assert.equal(bad, 0);
  assert.deepEqual(rows.map((r) => r.run_id).sort(), [...all].sort(), 'each run exactly once');
  const sizes = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => l.length);
  console.log(`S6: ${RECORD_REPS} reps x 10 concurrent records -> ${rows.length} intact lines, 0 torn; line sizes ${Math.min(...sizes)}-${Math.max(...sizes)} chars`);
  // a run is recorded once
  const again = await orch(['record', all[0], '--disposition', 'rejected', '--ledger', ledger, '--json'], c.env);
  assert.equal(again.code, 3);
  assert.equal(readLedger(ledger).rows.length, RECORD_REPS * 10);
});

test('S6: record fills the automatic fields from the run record and refuses an unfinished run', { timeout: 60000 }, async (t) => {
  const c = makeCase('s6-fields');
  t.after(() => c.cleanup());
  const ledger = path.join(c.base, 'ledger.jsonl');
  const id = craftRun(c, 'localai/qwen3-coder-30b', { wp: 'WP-L', slice: 's1', size: 'S', model_actual: 'qwen3-coder-30b' });
  const r = await orch(['record', id, '--disposition', 'accepted-with-fixes', '--ledger', ledger, '--attempt', '2', '--turns', '14', '--checks', '{"npm test":"pass"}', '--controller-intervened', '--quirks', 'slow load', '--json'], c.env);
  assert.equal(r.code, 0, r.stderr);
  const row = readLedger(ledger).rows[0];
  for (const k of ['run_id', 'date', 'project', 'wp', 'slice', 'size', 'workload', 'cli', 'model_requested', 'model_actual', 'attempt', 'handoff_version', 'cold_or_warm', 'elapsed_s', 'turns', 'files_changed', 'diff_lines', 'checks', 'reviewer_model', 'review_rounds', 'findings', 'controller_intervened', 'credits_or_cost', 'disposition', 'quirks']) {
    assert.ok(k in row, `playbook field ${k} is present (null when unknown)`);
  }
  assert.equal(row.run_id, id);
  assert.equal(row.wp, 'WP-L');
  assert.equal(row.size, 'S');
  assert.equal(row.workload, 'implement');
  assert.equal(row.model_canonical, 'qwen3-coder-30b');
  assert.equal(row.attempt, 2);
  assert.equal(row.turns, 14);
  assert.deepEqual(row.checks, { 'npm test': 'pass' });
  assert.equal(row.controller_intervened, true);
  assert.equal(row.disposition, 'accepted-with-fixes');
  const bad = await orch(['record', id, '--disposition', 'great', '--ledger', ledger], c.env);
  assert.equal(bad.code, 2);
  const unfinished = craftRun(c, 'x', { status: 'running' });
  fs.writeFileSync(path.join(c.stateRoot, 'runs', unfinished, 'keeper.ndjson'), JSON.stringify({ event: 'spawned', worker_pid: 1, at: new Date().toISOString() }) + '\n');
  const u = await orch(['record', unfinished, '--disposition', 'accepted', '--ledger', ledger], c.env);
  assert.equal(u.code, 2);
  assert.match(u.stderr, /is not terminal/);
});

test('S6: record names the REPOSITORY as project (not the slice worktree) and measures the diff against the baseline', { timeout: 60000 }, async (t) => {
  const c = makeCase('s6-project');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'my-project');
  const baseline = makeRepo(repo, { 'a.txt': 'one\n' });
  const wt = path.join(repo, '.worktrees', 'wp-x-s1');
  g(repo, 'worktree', 'add', '-q', '-b', 'orch/wp-x/s1', wt, baseline);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(wt, 'new.txt'), 'n\n');
  const id = craftFinishedRun(c.stateRoot, { dir: wt, baseline, allow: ['a.txt'], extra: { model_requested: 'm', cli: 'opencode', scope: { allow: ['a.txt'], baseline, repo_top: wt } } });
  const ledger = path.join(c.base, 'ledger.jsonl');
  const r = await orch(['record', id, '--disposition', 'accepted', '--ledger', ledger], c.env);
  assert.equal(r.code, 0, r.stderr);
  const row = readLedger(ledger).rows[0];
  assert.equal(row.project, 'my-project');
  assert.equal(row.files_changed, 2, 'one tracked change + one untracked file');
  assert.equal(row.diff_lines, 1);
});

/* ------------------------------------------------------------------ pick --- */

const ROSTER = [
  { cli: 'opencode', model: 'localai/qwen3-coder-30b', family: 'qwen', lane: 'local', workloads: ['implement', 'review'] },
  { cli: 'opencode', model: 'localai/qwen3.8-flash-next', family: 'qwen', lane: 'local', workloads: ['implement'] },
  { cli: 'opencode', model: 'localai/qwen3.8-27b', family: 'qwen', lane: 'local', workloads: ['review'] },
  { cli: 'vibe', model: 'mistral-medium-3.5', family: 'mistral', lane: 'cloud', workloads: ['implement', 'review'] },
  { cli: 'agy', model: 'gemini-3.8-flash-high', family: 'gemini', lane: 'cloud', workloads: ['review'] },
  { cli: 'codex', model: 'gpt-6-astra', family: 'gpt', lane: 'cloud', workloads: ['implement', 'review'], requires_permission: true },
];
const row = (model, workload, disposition = 'accepted') => ({ model_canonical: canonicalId(model), workload, disposition });

test('S6: pick rules - suited, fewest runs, two failures skip, local only XS/S, reviewer != implementer, prefer another family', () => {
  // implement XS, empty ledger: roster order breaks the tie
  let p = computePick({ roster: ROSTER, rows: [], workload: 'implement', size: 'XS' });
  assert.equal(p.pick.model, 'localai/qwen3-coder-30b');
  assert.match(p.reason, /0 recorded implement runs \(fewest among 3 suited\)/);
  // fewest recorded runs FOR THAT WORKLOAD wins (review runs do not count for implement)
  p = computePick({ roster: ROSTER, rows: [row('qwen3-coder-30b', 'implement'), row('qwen3.8-flash-next', 'review'), row('qwen3.8-flash-next', 'review')], workload: 'implement', size: 'S' });
  assert.equal(p.pick.model, 'localai/qwen3.8-flash-next');
  // two recorded failures of the workload -> skipped, even with the fewest runs
  const rows = [row('qwen3-coder-30b', 'implement'), row('qwen3-coder-30b', 'implement'), row('qwen3.8-flash-next', 'implement', 'rejected'), row('qwen3.8-flash-next', 'implement', 'failed-launch'), row('mistral-medium-3.5', 'implement'), row('mistral-medium-3.5', 'implement'), row('mistral-medium-3.5', 'implement')];
  p = computePick({ roster: ROSTER, rows, workload: 'implement', size: 'S' });
  assert.equal(p.pick.model, 'localai/qwen3-coder-30b');
  assert.ok(p.excluded.some((e) => /qwen3.8-flash-next/.test(e.model) && /2 recorded implement failures/.test(e.why)));
  // blocked / inconclusive-timeout are not model failures
  p = computePick({ roster: ROSTER, rows: [row('qwen3-coder-30b', 'implement', 'blocked'), row('qwen3-coder-30b', 'implement', 'inconclusive-timeout'), row('qwen3.8-flash-next', 'implement'), row('qwen3.8-flash-next', 'implement'), row('qwen3.8-flash-next', 'implement')], workload: 'implement', size: 'XS' });
  assert.ok(!p.excluded.some((e) => /qwen3-coder-30b/.test(e.model)), 'blocked + inconclusive are not failures');
  // local models only for XS/S
  p = computePick({ roster: ROSTER, rows: [], workload: 'implement', size: 'M' });
  assert.equal(p.pick.model, 'mistral-medium-3.5');
  assert.ok(p.excluded.filter((e) => /local models only for XS\/S/.test(e.why)).length === 2);
  // requires_permission is never proposed
  assert.ok(p.excluded.some((e) => /gpt-6-astra/.test(e.model) && /permission/.test(e.why)));
  // review: never the implementer's canonical model; prefer a different family even with more runs
  p = computePick({ roster: ROSTER, rows: [row('gemini-3.8-flash-high', 'review'), row('gemini-3.8-flash-high', 'review'), row('mistral-medium-3.5', 'review')], workload: 'review', size: 'S', implementerModels: ['localai/qwen3-coder-30b'] });
  assert.ok(p.excluded.some((e) => /qwen3-coder-30b/.test(e.model) && /implementer's own model/.test(e.why)));
  assert.equal(p.pick.model, 'mistral-medium-3.5', 'different family, fewest runs among those');
  assert.match(p.reason, /family mistral differs/);
  assert.deepEqual(p.candidates.map((x) => x.model), ['mistral-medium-3.5', 'gemini-3.8-flash-high', 'localai/qwen3.8-27b'], 'same family ranks last');
  // same family only when nothing else is suited, and it says so
  p = computePick({ roster: ROSTER.filter((m) => m.family === 'qwen'), rows: [], workload: 'review', size: 'S', implementerModels: ['localai/qwen3-coder-30b'] });
  assert.equal(p.pick.model, 'localai/qwen3.8-27b');
  assert.match(p.reason, /SAME family/);
  // nothing suited
  p = computePick({ roster: ROSTER, rows: [], workload: 'review', size: 'M', implementerModels: ['mistral-medium-3.5', 'gemini-3.8-flash-high'] });
  assert.equal(p.pick, null);
  assert.throws(() => computePick({ roster: ROSTER, rows: [], workload: 'dance', size: 'S' }), /workload/);
  assert.throws(() => computePick({ roster: ROSTER, rows: [], workload: 'review', size: 'XL' }), /size/);
});

test('S6: pick is deterministic given the ledger (pure and through the CLI), and a review pick needs --for-run', { timeout: 60000 }, async (t) => {
  const c = makeCase('s6-pick');
  t.after(() => c.cleanup());
  const { models } = loadRoster();
  assert.ok(models.length >= 10, 'the seeded roster is readable');
  const rows = [row('qwen3-coder-30b', 'implement'), row('mistral-medium-3.5', 'review', 'rejected')];
  const a = computePick({ roster: models, rows, workload: 'review', size: 'S', implementerModels: ['localai/qwen3-coder-30b'] });
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(computePick({ roster: models, rows: [...rows], workload: 'review', size: 'S', implementerModels: ['localai/qwen3-coder-30b'] }), a);
  }
  const ledger = path.join(c.base, 'ledger.jsonl');
  fs.writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n{torn line\n');
  const impl = craftRun(c, 'localai/qwen3-coder-30b');
  const outs = [];
  for (let i = 0; i < 3; i++) {
    const r = await orch(['pick', '--workload', 'review', '--size', 'S', '--for-run', impl, '--ledger', ledger, '--json'], c.env);
    assert.equal(r.code, 0, r.stderr);
    outs.push(JSON.parse(r.stdout));
  }
  assert.deepEqual(outs[0], outs[1]);
  assert.deepEqual(outs[1], outs[2]);
  assert.equal(outs[0].ledger_unreadable_lines, 1, 'a torn line is counted, not fatal');
  assert.notEqual(canonicalId(outs[0].pick.model), 'qwen3-coder-30b');
  const text = await orch(['pick', '--workload', 'implement', '--size', 'XS', '--ledger', ledger], c.env);
  assert.match(text.stdout, /^pick: opencode localai\/\S+ - \d+ recorded implement run/);
  const noRun = await orch(['pick', '--workload', 'review', '--size', 'S', '--ledger', ledger], c.env);
  assert.equal(noRun.code, 2);
  assert.match(noRun.stderr, /--for-run/);
});
