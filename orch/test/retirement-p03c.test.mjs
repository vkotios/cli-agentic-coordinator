import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { makeCase, orch } from './helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import { dependentRunBlock } from '../src/resources.mjs';
import { callTool } from '../src/mcp.mjs';
import { cmdMaintain } from '../src/retention.mjs';
import { beginRunArtifacts, confirmRunArtifacts, maintainOnUse } from '../src/retention.mjs';
import { beginReviewMetadata, confirmReviewMetadata } from '../src/metadata.mjs';
import { withOperationLock } from '../src/resources.mjs';

const old = '2026-01-01T00:00:00.000Z';
const json = (r) => JSON.parse(r.stdout);
/** @param {any} t @param {string} name @param {any} [metadata] */
function fixture(t, name, metadata = { enabled: true, successDays: 0, otherDays: 0 }) {
  const c = makeCase(name, { config: { retention: { mode: 'manual', successDays: 0, otherDays: 0, maxMs: 10000, metadata } } });
  t.after(() => c.cleanup());
  const id = '20260101-000000-abc123';
  const dir = path.join(c.stateRoot, 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  const rec = { id, cli: 'fake', lane: 'cloud', status: 'completed', ended_at: old, created_at: old, exit_code: 0, dir: c.work, model_requested: 'fixture-model', model_canonical: 'fixture-model', model_actual: null };
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(rec));
  const files = { 'stdout.log': 'original final answer\n', 'stderr.log': '', 'prompt.txt': 'private test handoff', 'keeper.ndjson': [{ event: 'worker-exit', at: old, code: 0 }, { event: 'streams-closed', at: old }, { event: 'keeper-exit', at: old, write_failures: 0 }].map((r) => JSON.stringify(r)).join('\n') + '\n', 'events.monitor.ndjson': '{"event":"finished"}\n' };
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  fs.writeFileSync(path.join(c.stateRoot, 'ledger.jsonl'), JSON.stringify({ run_id: id, disposition: 'blocked', model_canonical: 'fixture-model', recorded_at: old }) + '\n');
  return { c, id, dir, rec };
}
async function transcripts(f) {
  let r = await orch(['maintain', '--enroll', f.id, '--by', 'owner', '--reason', 'disposable fixture', '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr);
  r = await orch(['maintain', '--apply', '--run', f.id, '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).runs[0].state, 'collected', JSON.stringify(json(r)));
}
async function seal(f) {
  const r = await orch(['maintain', '--kind', 'metadata', '--enroll', f.id, '--by', 'owner', '--reason', 'explicit original record retirement', '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr);
  return r;
}
const collect = (f) => orch(['maintain', '--kind', 'metadata', '--apply', '--run', f.id, '--json'], f.c.env);

test('P03c: explicit metadata enrollment preserves the original record bytes', async (t) => {
  const f = fixture(t, 'p03c-seal');
  await transcripts(f);
  const before = fs.readFileSync(path.join(f.dir, 'run.json'));
  await seal(f);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'run.json')), before);
  assert.ok(fs.existsSync(path.join(f.dir, 'keeper.ndjson')));
});

test('P03c: original folder retirement keeps answers, model uncertainty, inventory and cleanup usable', async (t) => {
  const f = fixture(t, 'p03c-readers');
  await transcripts(f);
  const ledger = fs.readFileSync(path.join(f.c.stateRoot, 'ledger.jsonl'));
  const pickBefore = await orch(['pick', '--workload', 'review', '--size', 'S', '--for-run', f.id, '--json'], f.c.env);
  assert.equal(pickBefore.code, 0, pickBefore.stderr);
  await seal(f);
  const r = await collect(f);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).runs[0].state, 'collected');
  assert.equal(fs.existsSync(f.dir), false);
  const result = await orch(['result', f.id, '--json'], f.c.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(json(result).final_message, 'original final answer');
  assert.equal(json(result).model_actual, null);
  assert.equal(json(result).metadata.state, 'retired');
  const status = await orch(['status', f.id, '--json'], f.c.env);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(json(status).runs[0].status, 'completed');
  const all = await orch(['status', '--all', '--json'], f.c.env);
  assert.equal(json(all).runs[0].id, f.id);
  const list = await orch(['list', '--json'], f.c.env);
  assert.equal(json(list)[0].id, f.id);
  const pickAfter = await orch(['pick', '--workload', 'review', '--size', 'S', '--for-run', f.id, '--json'], f.c.env);
  assert.equal(pickAfter.code, 0, pickAfter.stderr);
  assert.deepEqual(json(pickAfter), json(pickBefore));
  assert.equal(await dependentRunBlock(loadConfig(f.c.stateRoot), { id: 'fixture', path: f.c.work }), null);
  assert.deepEqual(fs.readFileSync(path.join(f.c.stateRoot, 'ledger.jsonl')), ledger);
  const log = await orch(['log', f.id, '--stream', 'keeper'], f.c.env);
  assert.equal(log.code, 0, log.stderr);
  assert.match(log.stdout, /retired|purged/i);
  assert.equal(fs.existsSync(f.dir), false, 'queries never recreate retired folders');
});

test('P03c: metadata is disabled separately from enabled transcript collection', async (t) => {
  const f = fixture(t, 'p03c-disabled', { enabled: false });
  await transcripts(f);
  await seal(f);
  const r = await orch(['maintain', '--kind', 'metadata', '--apply', '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).state, 'disabled');
  assert.ok(fs.existsSync(path.join(f.dir, 'run.json')));
});

test('P03c: unexpected owner content refuses metadata enrollment and is preserved', async (t) => {
  const f = fixture(t, 'p03c-foreign');
  await transcripts(f);
  fs.writeFileSync(path.join(f.dir, 'owner-notes.txt'), 'keep this owner content');
  const r = await orch(['maintain', '--kind', 'metadata', '--enroll', f.id, '--by', 'owner', '--reason', 'disposable fixture', '--json'], f.c.env);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /unexpected|unknown|allowlist/i);
  assert.equal(fs.readFileSync(path.join(f.dir, 'owner-notes.txt'), 'utf8'), 'keep this owner content');
  assert.ok(fs.existsSync(path.join(f.dir, 'run.json')));
});

test('P03c: retired run mutations cannot recreate its folder or append a disposition', async (t) => {
  const f = fixture(t, 'p03c-mutations');
  await transcripts(f);
  await seal(f);
  assert.equal((await collect(f)).code, 0);
  const ledger = fs.readFileSync(path.join(f.c.stateRoot, 'ledger.jsonl'));
  for (const args of [['cancel', f.id], ['monitor', f.id], ['record', f.id, '--disposition', 'rejected'], ['scope', f.id]]) {
    const r = await orch(args, f.c.env);
    assert.notEqual(r.code, 0, args[0]);
    assert.match(r.stderr + r.stdout, /retired|archived|preserved|no.*scope/i, args[0]);
    assert.equal(fs.existsSync(f.dir), false, args[0]);
  }
  assert.deepEqual(fs.readFileSync(path.join(f.c.stateRoot, 'ledger.jsonl')), ledger);
});

test('P03c: preserved scope lookup answers after original scope.json is gone', async (t) => {
  const f = fixture(t, 'p03c-scope');
  f.rec.scope = { baseline: 'fixture-baseline', allow: ['src/allowed.mjs'] };
  fs.writeFileSync(path.join(f.dir, 'run.json'), JSON.stringify(f.rec));
  fs.writeFileSync(path.join(f.dir, 'scope.json'), JSON.stringify({ run_id: f.id, result: 'pass', baseline: 'fixture-baseline', allow: ['src/allowed.mjs'], changed: [], untracked: [], offending: [], exempt: [], errors: [], checked_at: old }));
  await transcripts(f);
  await seal(f);
  assert.equal((await collect(f)).code, 0);
  const r = await orch(['scope', f.id, '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).result, 'pass');
  assert.equal(json(r).baseline, 'fixture-baseline');
  assert.equal(fs.existsSync(f.dir), false);
});

test('P03c: changes after sealing protect all original metadata', async (t) => {
  const f = fixture(t, 'p03c-change');
  await transcripts(f);
  await seal(f);
  fs.writeFileSync(path.join(f.dir, 'events.monitor.ndjson'), 'new owner evidence\n');
  const r = await collect(f);
  assert.notEqual(json(r).runs[0].state, 'collected');
  assert.match(json(r).runs[0].reason, /changed|identity|hash/i);
  assert.ok(fs.existsSync(path.join(f.dir, 'run.json')));
  assert.equal(fs.readFileSync(path.join(f.dir, 'events.monitor.ndjson'), 'utf8'), 'new owner evidence\n');
});

test('P03c: investigation pin blocks retirement after metadata enrollment', async (t) => {
  const f = fixture(t, 'p03c-pin');
  await transcripts(f);
  await seal(f);
  const pin = await orch(['maintain', '--pin', f.id, '--by', 'owner', '--reason', 'investigation', '--json'], f.c.env);
  assert.equal(pin.code, 0, pin.stderr);
  const r = await collect(f);
  assert.equal(json(r).runs[0].state, 'protected');
  assert.match(json(r).runs[0].reason, /pin/i);
  assert.ok(fs.existsSync(path.join(f.dir, 'run.json')));
});

test('P03c: a corrupt seal cannot authorize a parent-path file', async (t) => {
  const f = fixture(t, 'p03c-seal-path'); await transcripts(f); await seal(f);
  const file = path.join(f.c.stateRoot, 'retention', 'sealed', 'run', f.id + '.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.files['../owner.txt'] = doc.files['run.json'];
  fs.writeFileSync(file, JSON.stringify(doc));
  const r = await collect(f);
  assert.equal(json(r).runs[0].state, 'protected');
  assert.match(json(r).runs[0].reason, /seal|allowlist|unexpected|invalid/i);
  assert.ok(fs.existsSync(path.join(f.dir, 'run.json')));
});

test('P03c: compact corruption is visible and never invents an actual model or answer', async (t) => {
  const f = fixture(t, 'p03c-corrupt'); await transcripts(f); await seal(f); assert.equal((await collect(f)).code, 0);
  const file = path.join(f.c.stateRoot, 'retention', 'archive', 'run', f.id + '.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')); doc.data.record.model_actual = 'invented-model';
  fs.writeFileSync(file, JSON.stringify(doc));
  const r = await orch(['result', f.id, '--json'], f.c.env);
  assert.notEqual(r.code, 0); assert.match(r.stderr, /invalid|unreadable/i);
  const status = await orch(['status', f.id, '--json'], f.c.env);
  assert.equal(status.code, 0); assert.equal(json(status).runs[0].status, 'record-unreadable');
  assert.match(json(status).runs[0].retention_evidence_error, /invalid|unreadable/i);
  assert.match(await dependentRunBlock(loadConfig(f.c.stateRoot), { id: 'fixture', path: f.c.work }), /unreadable/);
});

test('P03c: a reused original folder cannot inherit an archived answer or id', async (t) => {
  const f = fixture(t, 'p03c-reuse'); await transcripts(f); await seal(f); assert.equal((await collect(f)).code, 0);
  fs.mkdirSync(f.dir); fs.writeFileSync(path.join(f.dir, 'run.json'), JSON.stringify(f.rec));
  const r = await orch(['result', f.id, '--json'], f.c.env);
  assert.notEqual(r.code, 0); assert.match(r.stderr, /identity|changed/i);
  assert.throws(() => beginRunArtifacts(loadConfig(f.c.stateRoot), f.id), /identity|changed|retired/i);
});

test('P03c: review retirement preserves independent review outcome and finish idempotence', async (t) => {
  const f = fixture(t, 'p03c-review'); await transcripts(f);
  const review = 'rv-20260101-000000-def123'; const file = path.join(f.c.stateRoot, 'reviews', review + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rv = { id: review, implementer_run: f.id, implementer_models: ['fixture-model'], reviewer_model: 'another-model', reviewer_canonical: 'another-model', reviewer_cli: 'fake', status: 'finished', outcome: 'reviewed', containment: 'clean', finished_at: old, created_at: old, worktree_removed: true, worktree_created: false, breaches: [], unknown: [], warnings: [] };
  fs.writeFileSync(file, JSON.stringify(rv));
  const enroll = await orch(['maintain', '--kind', 'metadata', '--enroll', review, '--by', 'owner', '--reason', 'disposable review record', '--json'], f.c.env);
  assert.equal(enroll.code, 0, enroll.stderr);
  const r = await orch(['maintain', '--kind', 'metadata', '--apply', '--review', review, '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr); assert.equal(json(r).runs[0].state, 'collected'); assert.equal(fs.existsSync(file), false);
  const finish = await orch(['review', '--finish', review, '--json'], f.c.env);
  assert.equal(finish.code, 0, finish.stderr); assert.equal(json(finish).outcome, 'reviewed'); assert.equal(json(finish).reviewer_canonical, 'another-model');
  assert.equal(json(finish).containment, 'clean'); assert.equal(fs.existsSync(file), false);
});

test('P03c: real collector death at publication, intent, unlink and rmdir preserves recovery authority', async (t) => {
  for (const point of ['prepared', 'published', 'deleting', 'unlinked', 'directory', 'control']) {
    const f = fixture(t, 'p03c-crash-' + point); await transcripts(f); await seal(f);
    fs.writeFileSync(path.join(f.c.stateRoot, 'config.json'), JSON.stringify({ retention: { mode: 'manual', successDays: 0, otherDays: 0, maxMs: 10000, metadata: { enabled: false } } }));
    const journal = path.join(f.c.stateRoot, 'retention', 'retired', 'run', f.id + '.json');
    const archive = path.join(f.c.stateRoot, 'retention', 'archive', 'run', f.id + '.json');
    const target = path.join(f.dir, 'events.monitor.ndjson');
    const code = `import fs from 'node:fs'; import {cmdMaintain} from ${JSON.stringify(new URL('../src/retention.mjs', import.meta.url).href)}; import {loadConfig} from ${JSON.stringify(new URL('../src/config.mjs', import.meta.url).href)};
      const journal=${JSON.stringify(journal)},archive=${JSON.stringify(archive)},target=${JSON.stringify(target)},dir=${JSON.stringify(f.dir)},point=${JSON.stringify(point)};
      const rename=fs.renameSync,link=fs.linkSync,unlink=fs.unlinkSync,rmdir=fs.rmdirSync;
      fs.renameSync=(a,b)=>{rename(a,b);if(b===journal){const d=JSON.parse(fs.readFileSync(b,'utf8'));if(point==='prepared'&&d.state==='prepared'||point==='deleting'&&d.files['events.monitor.ndjson'].state==='deleting')process.kill(process.pid);}};
      fs.linkSync=(a,b)=>{link(a,b);if(b===archive&&point==='published')process.kill(process.pid);};
      fs.unlinkSync=(f)=>{unlink(f);if(f===target&&point==='unlinked'||point==='control'&&f.includes('retention')&&f.includes('receipts'))process.kill(process.pid);};
      fs.rmdirSync=(f)=>{rmdir(f);if(f===dir&&point==='directory')process.kill(process.pid);};
      await cmdMaintain(loadConfig(${JSON.stringify(f.c.stateRoot)}),{kind:'metadata',apply:true,run:${JSON.stringify(f.id)},by:'original-operator',reason:'bounded recovery fixture'},{log(){}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: f.c.env, windowsHide: true, stdio: 'ignore' });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.notEqual(exit, 0, point);
    const before = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.equal(before.authorization.by, 'original-operator', point);
    const answer = await orch(['result', f.id, '--json'], f.c.env);
    assert.equal(answer.code, 0, answer.stderr); assert.equal(json(answer).final_message, 'original final answer');
    if (point === 'prepared' || point === 'published') {
      const log = await orch(['log', f.id, '--stream', 'events'], f.c.env);
      assert.equal(log.code, 0, log.stderr); assert.match(log.stdout, /finished/, 'unchanged original logs remain available during partial retirement');
    }
    const selected = ['maintain', '--kind', 'metadata', '--apply', '--run', f.id, '--by', 'retry-operator', '--reason', 'recover fixture', '--json'];
    const blocked = await orch(selected, f.c.env); assert.match(blocked.stderr, /operation locked/);
    const locks = path.join(f.c.stateRoot, 'resources', 'locks');
    for (const name of fs.readdirSync(locks)) { const file = path.join(locks, name); const ino = fs.statSync(file, { bigint: true }).ino; assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, child.pid); assert.equal(fs.statSync(file, { bigint: true }).ino, ino); fs.unlinkSync(file); }
    const retry = await orch(selected, f.c.env); assert.equal(retry.code, 0, retry.stderr); assert.equal(json(retry).runs[0].state, 'collected', JSON.stringify(json(retry)));
    const after = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.deepEqual(after.authorization, before.authorization); assert.equal(after.archive_sha256, before.archive_sha256);
    assert.equal(fs.existsSync(f.dir), false);
  }
});

function reviewFixture(f, owned = false) {
  const id = 'rv-20260101-000000-def123', file = path.join(f.c.stateRoot, 'reviews', id + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cfg = loadConfig(f.c.stateRoot);
  if (owned) beginReviewMetadata(cfg, id);
  const record = { id, by: 'owner', implementer_run: f.id, reviewer_canonical: 'another-model', status: 'finished', outcome: 'reviewed', containment: 'clean', finished_at: old, created_at: old, worktree_removed: true, worktree_created: false, breaches: [], unknown: [] };
  fs.writeFileSync(file, JSON.stringify(record));
  if (owned) confirmReviewMetadata(cfg, id);
  return { id, file, record };
}

test('P03c: review pins and scoped disabled-policy authority use the shared collector', async (t) => {
  const f = fixture(t, 'p03c-review-control'); await transcripts(f);
  const rv = reviewFixture(f);
  assert.equal((await orch(['maintain', '--kind', 'metadata', '--enroll', rv.id, '--by', 'owner', '--reason', 'fixture', '--json'], f.c.env)).code, 0);
  let r = await orch(['maintain', '--kind', 'metadata', '--pin', rv.id, '--by', 'owner', '--reason', 'investigation', '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr);
  r = await orch(['maintain', '--kind', 'metadata', '--apply', '--review', rv.id, '--json'], f.c.env);
  assert.match(json(r).runs[0].reason, /pin/); assert.ok(fs.existsSync(rv.file));
  assert.equal((await orch(['maintain', '--kind', 'metadata', '--unpin', rv.id, '--by', 'owner', '--reason', 'resolved'], f.c.env)).code, 0);
  fs.writeFileSync(path.join(f.c.stateRoot, 'config.json'), JSON.stringify({ retention: { mode: 'disabled', successDays: 30, otherDays: 90, metadata: { enabled: false } } }));
  const options = { stateRoot: f.c.stateRoot };
  const reply = await callTool('maintain', { kind: 'metadata', apply: true, review: rv.id, by: 'owner', reason: 'explicit fixture retirement' }, options);
  assert.equal(reply.isError, false, JSON.stringify(reply)); assert.equal(fs.existsSync(rv.file), false);
  const journal = JSON.parse(fs.readFileSync(path.join(f.c.stateRoot, 'retention', 'retired', 'review', rv.id + '.json'), 'utf8'));
  assert.equal(journal.authorization.overrode_policy, true); assert.equal(journal.authorization.by, 'owner');
});

test('P03c: missing compact pair and altered journals remain visible to cleanup and status', async (t) => {
  for (const damage of ['missing', 'journal']) {
    const f = fixture(t, 'p03c-index-' + damage); await transcripts(f); await seal(f); assert.equal((await collect(f)).code, 0);
    const journal = path.join(f.c.stateRoot, 'retention', 'retired', 'run', f.id + '.json');
    if (damage === 'missing') {
      fs.unlinkSync(path.join(f.c.stateRoot, 'retention', 'archive', 'run', f.id + '.json')); fs.unlinkSync(journal);
    } else {
      const doc = JSON.parse(fs.readFileSync(journal, 'utf8')); doc.files['run.json'].identity = 'foreign'; fs.writeFileSync(journal, JSON.stringify(doc));
    }
    const status = await orch(['status', '--all', '--json'], f.c.env);
    assert.equal(status.code, 0, status.stderr); assert.equal(json(status).runs[0].id, f.id); assert.equal(json(status).runs[0].status, 'record-unreadable');
    assert.match(await dependentRunBlock(loadConfig(f.c.stateRoot), { id: 'fixture', path: f.c.work }), /unreadable/);
  }
});

test('P03c: metadata ages, byte limits and held collector guards preserve all original bytes', async (t) => {
  for (const boundary of ['age', 'bytes', 'lock']) {
    const f = fixture(t, 'p03c-budget-' + boundary); await transcripts(f); await seal(f);
    const before = fs.readFileSync(path.join(f.dir, 'run.json'));
    const policy = { mode: 'manual', successDays: 0, otherDays: 0, maxMs: 10000, maxBytes: boundary === 'bytes' ? 1 : 67108864, metadata: { enabled: true, successDays: 1, otherDays: boundary === 'age' ? 1 : 0 } };
    fs.writeFileSync(path.join(f.c.stateRoot, 'config.json'), JSON.stringify({ retention: policy }));
    const r = boundary === 'lock' ? await withOperationLock(loadConfig(f.c.stateRoot), 'retention:collector', () => collect(f)) : await collect(f);
    if (boundary === 'lock') assert.match(r.stderr, /operation locked/);
    else assert.match(json(r).runs[0].reason, boundary === 'age' ? /age/ : /byte budget/);
    assert.deepEqual(fs.readFileSync(path.join(f.dir, 'run.json')), before);
    assert.equal(fs.existsSync(path.join(f.c.stateRoot, 'retention', 'archive', 'run', f.id + '.json')), false);
  }
});

test('P03c: reopened packages protect sealed runs and completed compact history still supports finish', async (t) => {
  const f = fixture(t, 'p03c-package'); f.rec.wp = 'WP-retirement'; f.rec.slice = 's1';
  fs.writeFileSync(path.join(f.dir, 'run.json'), JSON.stringify(f.rec));
  fs.mkdirSync(path.join(f.c.stateRoot, 'finishes'));
  fs.writeFileSync(path.join(f.c.stateRoot, 'finishes', 'wp-retirement.json'), JSON.stringify({ wp: f.rec.wp, state: 'finished', by: 'owner', closed_at: old, run_ids: [f.id], claim_token: 'previous-generation' }));
  for (const file of ['stdout.log', 'stderr.log', 'prompt.txt']) fs.utimesSync(path.join(f.dir, file), new Date(old), new Date(old));
  await transcripts(f); await seal(f);
  assert.equal((await orch(['claim', f.rec.wp, '--by', 'owner'], f.c.env)).code, 0);
  let r = await collect(f); assert.match(json(r).runs[0].reason, /claim|package/i); assert.ok(fs.existsSync(f.dir));
  assert.equal((await orch(['release', f.rec.wp, '--by', 'owner'], f.c.env)).code, 0);
  r = await collect(f); assert.equal(r.code, 0, r.stderr); assert.equal(json(r).runs[0].state, 'collected');
  const finish = await orch(['finish', f.rec.wp, '--by', 'owner', '--json'], f.c.env);
  assert.equal(finish.code, 0, finish.stderr); assert.equal(fs.existsSync(f.dir), false);
});

test('P03c: large event streams use bounded hashing and partial hashes never authorize deletion', async (t) => {
  const f = fixture(t, 'p03c-stream'); await transcripts(f);
  const event = path.join(f.dir, 'events.monitor.ndjson'); fs.writeFileSync(event, Buffer.alloc(9 * 1024 * 1024, 32));
  await seal(f);
  const cfg = loadConfig(f.c.stateRoot);
  fs.writeFileSync(path.join(f.c.stateRoot, 'config.json'), JSON.stringify({ retention: { mode: 'manual', successDays: 0, otherDays: 0, maxMs: 1, metadata: { enabled: true, successDays: 0, otherDays: 0 } } }));
  const limited = await cmdMaintain(cfg, { kind: 'metadata', apply: true, run: f.id, json: true }, { log() {} });
  assert.notEqual(limited.runs[0]?.state, 'collected'); assert.ok(fs.existsSync(event));
  fs.writeFileSync(path.join(f.c.stateRoot, 'config.json'), JSON.stringify({ retention: { mode: 'manual', successDays: 0, otherDays: 0, maxMs: 10000, metadata: { enabled: true, successDays: 0, otherDays: 0 } } }));
  const r = await collect(f); assert.equal(r.code, 0, r.stderr); assert.equal(json(r).runs[0].state, 'collected');
});

test('P03c: future owned reviews seal automatically while containment incidents and links refuse retirement', async (t) => {
  const f = fixture(t, 'p03c-owned-review'); await transcripts(f); const rv = reviewFixture(f, true);
  const r = await orch(['maintain', '--kind', 'metadata', '--apply', '--review', rv.id, '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr); assert.equal(json(r).runs[0].state, 'collected'); assert.equal(fs.existsSync(rv.file), false);
  for (const hazard of ['incident', 'link']) {
    const g = fixture(t, 'p03c-protection-' + hazard); await transcripts(g);
    if (hazard === 'link') fs.symlinkSync(g.c.work, path.join(g.dir, 'scope.json'), 'junction');
    else { const v = reviewFixture(g); v.record.breaches = [{ path: 'fixture.txt' }]; fs.writeFileSync(v.file, JSON.stringify(v.record)); }
    const enrolled = await orch(['maintain', '--kind', 'metadata', '--enroll', g.id, '--by', 'owner', '--reason', 'fixture'], g.c.env);
    assert.notEqual(enrolled.code, 0); assert.ok(fs.existsSync(path.join(g.dir, 'run.json')));
  }
});

test('P03c: required compact evidence cannot exceed its cap or hide unknown process evidence', async (t) => {
  for (const boundary of ['oversized', 'process']) {
    const f = fixture(t, 'p03c-cap-' + boundary); await transcripts(f);
    let id = f.id;
    if (boundary === 'oversized') {
      const rv = reviewFixture(f); rv.record.warnings = ['x'.repeat(300 * 1024)]; fs.writeFileSync(rv.file, JSON.stringify(rv.record)); id = rv.id;
    } else fs.writeFileSync(path.join(f.dir, 'keeper.ndjson'), '{}\n');
    const r = await orch(['maintain', '--kind', 'metadata', '--enroll', id, '--by', 'owner', '--reason', 'fixture'], f.c.env);
    assert.notEqual(r.code, 0); assert.match(r.stderr, boundary === 'oversized' ? /256 KiB|exceeds/ : /exit|liveness|process/);
    assert.ok(fs.existsSync(path.join(f.dir, 'run.json')));
  }
});

test('P03c: changed collector receipts and concurrent run guards prevent original retirement', async (t) => {
  for (const boundary of ['control', 'guard']) {
    const f = fixture(t, 'p03c-guard-' + boundary); await transcripts(f); await seal(f);
    if (boundary === 'control') fs.appendFileSync(path.join(f.c.stateRoot, 'retention', 'receipts', f.id + '.json'), ' ');
    const r = boundary === 'guard' ? await withOperationLock(loadConfig(f.c.stateRoot), `run:${f.id}`, () => collect(f)) : await collect(f);
    assert.match(json(r).runs[0].reason, boundary === 'control' ? /collector evidence changed/ : /operation locked/);
    assert.ok(fs.existsSync(path.join(f.dir, 'run.json'))); assert.ok(fs.existsSync(path.join(f.dir, 'events.monitor.ndjson')));
    const result = await orch(['result', f.id, '--json'], f.c.env); assert.equal(result.code, 0, result.stderr);
  }
});

async function ownedFixture(t, name) {
  const f = fixture(t, name);
  const backup = path.join(f.c.work, 'original-fixture');
  fs.renameSync(f.dir, backup);
  const cfg = loadConfig(f.c.stateRoot);
  beginRunArtifacts(cfg, f.id);
  fs.mkdirSync(f.dir);
  for (const file of fs.readdirSync(backup)) fs.copyFileSync(path.join(backup, file), path.join(f.dir, file));
  confirmRunArtifacts(cfg, f.id);
  return f;
}

test('P03c: future owned runs seal automatically only after explicit finalization and opt-in', async (t) => {
  const f = await ownedFixture(t, 'p03c-owned'); await transcripts(f);
  const r = await collect(f);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).runs[0].state, 'collected', JSON.stringify(json(r)));
  assert.equal(fs.existsSync(f.dir), false);
});

test('P03c: on-use with a one-item budget alternates classes so metadata cannot starve', async (t) => {
  const f = await ownedFixture(t, 'p03c-on-use'); await transcripts(f);
  fs.writeFileSync(path.join(f.c.stateRoot, 'config.json'), JSON.stringify({ retention: { mode: 'on-use', successDays: 0, otherDays: 0, maxRuns: 1, maxMs: 10000, minIntervalMs: 1, metadata: { enabled: true, successDays: 0, otherDays: 0 } } }));
  const cfg = loadConfig(f.c.stateRoot);
  await maintainOnUse(cfg);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await maintainOnUse(cfg);
  assert.equal(fs.existsSync(f.dir), false, 'bounded automatic metadata maintenance progresses');
});

test('P03c: MCP offers metadata enrollment and collection through the same guarded path', async (t) => {
  const f = fixture(t, 'p03c-mcp'); await transcripts(f);
  const options = { stateRoot: f.c.stateRoot, env: f.c.env };
  let r = await callTool('maintain', { kind: 'metadata', enroll: f.id, by: 'owner', reason: 'disposable fixture' }, options);
  assert.equal(r.isError, false, JSON.stringify(r));
  r = await callTool('maintain', { kind: 'metadata', apply: true, run: f.id }, options);
  assert.equal(r.isError, false, JSON.stringify(r));
  assert.equal(fs.existsSync(f.dir), false);
});

test('P03c review: a review selector cannot authorize an all-class transcript sweep', async (t) => {
  for (const mode of ['manual', 'disabled']) {
    const f = fixture(t, 'p03c-r1-' + mode);
    assert.equal((await orch(['maintain', '--enroll', f.id, '--by', 'owner', '--reason', 'fixture'], f.c.env)).code, 0);
    fs.writeFileSync(path.join(f.c.stateRoot, 'config.json'), JSON.stringify({ retention: { mode, successDays: 0, otherDays: 0, metadata: { enabled: true, successDays: 0, otherDays: 0 } } }));
    const r = await orch(['maintain', '--kind', 'all', '--apply', '--review', 'rv-20260101-000000-cccccc', '--by', 'owner', '--reason', 'one review only', '--json'], f.c.env);
    assert.notEqual(r.code, 0); assert.match(r.stderr, /kind|selector/);
    assert.equal(fs.readFileSync(path.join(f.dir, 'stdout.log'), 'utf8'), 'original final answer\n');
    assert.equal(fs.existsSync(path.join(f.c.stateRoot, 'retention', 'receipts', f.id + '.json')), false);
  }
});

test('P03c review: ordinary first-publication failure preserves readable answers and recovery', async (t) => {
  const f = fixture(t, 'p03c-r2'); await transcripts(f); await seal(f);
  const archive = path.join(f.c.stateRoot, 'retention', 'archive', 'run', f.id + '.json'), original = fs.linkSync;
  let first;
  fs.linkSync = (a, b) => { if (b === archive) throw Object.assign(new Error('fixture publication IO failure'), { code: 'EIO' }); return original(a, b); };
  try { first = await cmdMaintain(loadConfig(f.c.stateRoot), { kind: 'metadata', apply: true, run: f.id }, { log() {} }); } finally { fs.linkSync = original; }
  assert.equal(first.runs[0].state, 'pending'); assert.ok(fs.existsSync(path.join(f.dir, 'run.json')));
  const journalFile = path.join(f.c.stateRoot, 'retention', 'retired', 'run', f.id + '.json');
  const before = JSON.parse(fs.readFileSync(journalFile, 'utf8')); assert.equal(before.state, 'prepared');
  const answer = await orch(['result', f.id, '--json'], f.c.env); assert.equal(answer.code, 0, answer.stderr); assert.equal(json(answer).final_message, 'original final answer');
  const retry = await collect(f); assert.equal(retry.code, 0, retry.stderr); assert.equal(json(retry).runs[0].state, 'collected');
  assert.deepEqual(JSON.parse(fs.readFileSync(journalFile, 'utf8')).authorization, before.authorization);
});

test('P03c review: future-owned previews accurately forecast automatic sealing without writing', async (t) => {
  for (const kind of ['run', 'review']) {
    const f = kind === 'run' ? await ownedFixture(t, 'p03c-r3-run') : fixture(t, 'p03c-r3-review'); await transcripts(f);
    const rv = kind === 'review' ? reviewFixture(f, true) : null, id = rv?.id || f.id;
    const cfg = loadConfig(f.c.stateRoot), selector = kind === 'run' ? { run: id } : { review: id };
    const before = fs.readdirSync(f.c.stateRoot, { recursive: true }).sort();
    const preview = await cmdMaintain(cfg, { kind: 'metadata', 'dry-run': true, ...selector }, { log() {} });
    assert.equal(preview.runs[0].state, 'eligible', JSON.stringify(preview)); assert.equal(preview.runs[0].would_auto_seal, true); assert.ok(preview.runs[0].bytes > 0);
    assert.deepEqual(fs.readdirSync(f.c.stateRoot, { recursive: true }).sort(), before);
    fs.writeFileSync(path.join(f.c.stateRoot, 'config.json'), JSON.stringify({ retention: { mode: 'manual', successDays: 0, otherDays: 0, maxMs: 10000, metadata: { enabled: true, successDays: 1, otherDays: 1 } } }));
    const aged = await cmdMaintain(cfg, { kind: 'metadata', 'dry-run': true, ...selector }, { log() {} });
    assert.equal(aged.runs[0].state, 'protected'); assert.match(aged.runs[0].reason, /age/); assert.equal(aged.runs[0].would_auto_seal, true);
    assert.equal(fs.existsSync(path.join(f.c.stateRoot, 'retention', 'sealed', kind, id + '.json')), false);
  }
});

test('P03c review: list isolates damaged history while cleanup still blocks on it', async (t) => {
  const f = fixture(t, 'p03c-r4'); await transcripts(f); await seal(f); assert.equal((await collect(f)).code, 0);
  const healthy = '20260101-000000-bbbbbb'; fs.mkdirSync(path.join(f.c.stateRoot, 'runs', healthy)); fs.writeFileSync(path.join(f.c.stateRoot, 'runs', healthy, 'run.json'), JSON.stringify({ ...f.rec, id: healthy }));
  const file = path.join(f.c.stateRoot, 'retention', 'archive', 'run', f.id + '.json'), doc = JSON.parse(fs.readFileSync(file, 'utf8')); doc.sha256 = 'damaged'; fs.writeFileSync(file, JSON.stringify(doc));
  const list = await orch(['list', '--json'], f.c.env); assert.equal(list.code, 0, list.stderr);
  assert.equal(json(list).find(r => r.id === f.id).status, 'record-unreadable'); assert.match(json(list).find(r => r.id === f.id).reason, /invalid/);
  assert.equal(json(list).find(r => r.id === healthy).status, 'completed');
  assert.match(await dependentRunBlock(loadConfig(f.c.stateRoot), { id: 'fixture', path: f.c.work }), /unreadable/);
});

test('P03c review: archived PID reuse permits retention while match and unknown still protect', async (t) => {
  const f = fixture(t, 'p03c-r5'), original = cp.execFile; let verdict = 'gone';
  cp.execFile = /** @type {any} */ ((exe, args, opts, cb) => {
    if (exe !== 'powershell.exe' || !String(args.at(-1)).includes('Get-CimInstance Win32_Process')) return original(exe, args, opts, cb);
    const child = /** @type {any} */ (new EventEmitter()); child.kill = () => true;
    setImmediate(() => { cb(verdict === 'unknown' ? new Error('fixture unavailable') : null, verdict === 'gone' || verdict === 'unknown' ? '' : JSON.stringify([{ ProcessId: 424242, CreationDate: verdict === 'match' ? old : '2026-06-01T00:00:00Z' }]), ''); child.emit('close', 0); }); return child;
  }); syncBuiltinESMExports();
  try {
    fs.writeFileSync(path.join(f.dir, 'spawned.json'), JSON.stringify({ monitor_pid: 424242, monitor_created_at: old }));
    // In-process calls keep the process-query fixture local to this test.
    const cfg = loadConfig(f.c.stateRoot);
    await cmdMaintain(cfg, { enroll: f.id, by: 'owner', reason: 'fixture' }, { log() {} }); await cmdMaintain(cfg, { apply: true, run: f.id }, { log() {} });
    await cmdMaintain(cfg, { kind: 'metadata', enroll: f.id, by: 'owner', reason: 'fixture' }, { log() {} }); await cmdMaintain(cfg, { kind: 'metadata', apply: true, run: f.id }, { log() {} });
    const rv = reviewFixture(f); verdict = 'mismatch';
    await cmdMaintain(cfg, { kind: 'metadata', enroll: rv.id, by: 'owner', reason: 'fixture' }, { log() {} });
    for (const blocked of ['match', 'unknown']) { verdict = blocked; const out = await cmdMaintain(cfg, { kind: 'metadata', apply: true, review: rv.id }, { log() {} }); assert.equal(out.runs[0].state, 'protected'); assert.ok(fs.existsSync(rv.file)); }
    verdict = 'mismatch'; const out = await cmdMaintain(cfg, { kind: 'metadata', apply: true, review: rv.id }, { log() {} }); assert.equal(out.runs[0].state, 'collected');
  } finally { cp.execFile = original; syncBuiltinESMExports(); }
});

test('P03c review: pinning tolerates monitor status updates but rejects a changed run identity', async (t) => {
  for (const change of ['status', 'identity']) {
    const f = fixture(t, 'p03c-r6-' + change), file = path.join(f.dir, 'run.json'), original = fs.openSync; let reads = 0;
    fs.openSync = (p, ...args) => { if (p === file && args[0] === 'r' && ++reads === 2) fs.writeFileSync(file, JSON.stringify({ ...f.rec, ...(change === 'status' ? { status: 'running', updated_at: new Date().toISOString() } : { id: '20260101-000000-bbbbbb' }) })); return original(p, ...args); };
    try {
      const action = () => cmdMaintain(loadConfig(f.c.stateRoot), { pin: f.id, by: 'owner', reason: 'live investigation' }, { log() {} });
      if (change === 'identity') await assert.rejects(action, /changed/);
      else assert.equal((await action()).state, 'pinned');
    } finally { fs.openSync = original; }
  }
});

test('P03c review: all-class text output reports metadata collection explicitly', async (t) => {
  const f = fixture(t, 'p03c-r7'); await transcripts(f); await seal(f);
  const r = await orch(['maintain', '--kind', 'all', '--apply', '--run', f.id], f.c.env);
  assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /metadata/); assert.match(r.stdout, new RegExp(`metadata[\\s\\S]*${f.id}: collected`));
  assert.match(r.stdout, /transcripts: 1 records inspected, 0 bytes removed/);
  assert.match(r.stdout, /metadata: 1 records inspected, [1-9][0-9]* bytes removed/);
});

test('P03c review: failed on-use attempts reserve the next class order without taking over locks', async (t) => {
  const f = await ownedFixture(t, 'p03c-r8'); await transcripts(f);
  fs.writeFileSync(path.join(f.c.stateRoot, 'config.json'), JSON.stringify({ retention: { mode: 'on-use', successDays: 0, otherDays: 0, maxRuns: 1, maxMs: 10000, minIntervalMs: 1, metadata: { enabled: true, successDays: 0, otherDays: 0 } } }));
  const file = path.join(f.c.stateRoot, 'retention', 'on-use.json'), archive = path.join(f.c.stateRoot, 'retention', 'archive', 'run'); fs.mkdirSync(archive, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: old, after: null, metadata_after: null, metadata_first: true }));
  const original = fs.readdirSync;
  fs.readdirSync = /** @type {any} */ ((p, ...args) => { if (p === archive) throw new Error('fixture inventory IO failure'); return original(p, ...args); });
  try {
    assert.equal((await maintainOnUse(loadConfig(f.c.stateRoot))).state, 'pending');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).metadata_first, false);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await maintainOnUse(loadConfig(f.c.stateRoot))).state, 'pending');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).metadata_first, true);
  } finally { fs.readdirSync = original; }
});
