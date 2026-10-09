// These fixtures exercise deletion authority and retained evidence, not owner data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeCase, orch, waitForStatus } from './helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import { withOperationLock, dependentRunBlock } from '../src/resources.mjs';
import { callTool } from '../src/mcp.mjs';
import { contendEach } from './wf-helpers.mjs';
import { cmdMaintain, beginRunArtifacts, confirmRunArtifacts } from '../src/retention.mjs';

const output = (r) => JSON.parse(r.stdout);
const old = '2026-01-01T00:00:00.000Z';
function fixture(t, name, policy = { mode: 'manual', successDays: 30, otherDays: 90 }) {
  const c = makeCase(name, { config: { retention: policy } });
  t.after(() => c.cleanup());
  const id = '20260101-000000-abcdef';
  const dir = path.join(c.stateRoot, 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  const rec = { id, cli: 'fake', lane: 'cloud', status: 'completed', reason: null, exit_code: 0, created_at: old, ended_at: old, dir: c.work, wp: 'WP-retain', slice: 's1', model_requested: 'fixture-model', model_canonical: 'fixture-model', model_actual: null };
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(rec));
  for (const [file, text] of Object.entries({ 'stdout.log': 'a retained final answer\n', 'stderr.log': 'diagnostic\n', 'prompt.txt': 'fixture prompt\n', 'keeper.ndjson': [{ event: 'worker-exit', at: old, code: 0 }, { event: 'streams-closed', at: old }, { event: 'keeper-exit', at: old, write_failures: 0 }].map((r) => JSON.stringify(r)).join('\n') })) {
    fs.writeFileSync(path.join(dir, file), text + (file === 'keeper.ndjson' ? '\n' : ''));
    fs.utimesSync(path.join(dir, file), new Date(old), new Date(old));
  }
  fs.mkdirSync(path.join(c.stateRoot, 'finishes'));
  fs.writeFileSync(path.join(c.stateRoot, 'finishes', 'WP-retain.json'), JSON.stringify({ wp: 'WP-retain', state: 'finished', closed_at: old, run_ids: [id], claim_token: 'fixture-token' }));
  fs.writeFileSync(path.join(c.stateRoot, 'ledger.jsonl'), JSON.stringify({ run_id: id, disposition: 'blocked', model_canonical: 'fixture-model', wp: 'WP-retain', recorded_at: old }) + '\n');
  return { c, id, dir, rec };
}
async function enroll(f) {
  const r = await orch(['maintain', '--enroll', f.id, '--by', 'owner', '--reason', 'verified disposable fixture', '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr);
}
const collect = (f) => orch(['maintain', '--apply', '--json'], f.c.env);
function fingerprint(dir) {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((rel) => fs.statSync(path.join(dir, rel)).isFile()).map((rel) => [rel, fs.readFileSync(path.join(dir, rel)).toString('base64')]);
}

test('P03: preview leaves bytes unchanged and legacy data cannot be collected by age', async (t) => {
  const f = fixture(t, 'p03-legacy');
  const before = fingerprint(f.c.stateRoot);
  const r = await orch(['maintain', '--dry-run', '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(output(r).runs[0].state, 'legacy');
  assert.deepEqual(fingerprint(f.c.stateRoot), before);
  await collect(f);
  assert.equal(fs.readFileSync(path.join(f.dir, 'stdout.log'), 'utf8'), 'a retained final answer\n');
});

test('P03: collection keeps compact results, model provenance and process/ledger evidence', async (t) => {
  const f = fixture(t, 'p03-evidence');
  await enroll(f);
  const kept = ['run.json', 'keeper.ndjson'].map((p) => fs.readFileSync(path.join(f.dir, p)));
  const ledger = fs.readFileSync(path.join(f.c.stateRoot, 'ledger.jsonl'));
  const pickBefore = await orch(['pick', '--workload', 'review', '--size', 'S', '--for-run', f.id, '--json'], f.c.env);
  assert.equal(pickBefore.code, 0, pickBefore.stderr);
  const r = await collect(f);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(output(r).runs[0].state, 'collected');
  for (const p of ['stdout.log', 'stderr.log', 'prompt.txt']) assert.equal(fs.existsSync(path.join(f.dir, p)), false);
  assert.deepEqual(['run.json', 'keeper.ndjson'].map((p) => fs.readFileSync(path.join(f.dir, p))), kept);
  assert.deepEqual(fs.readFileSync(path.join(f.c.stateRoot, 'ledger.jsonl')), ledger);
  const pickAfter = await orch(['pick', '--workload', 'review', '--size', 'S', '--for-run', f.id, '--json'], f.c.env);
  assert.equal(pickAfter.code, 0, pickAfter.stderr);
  assert.deepEqual(output(pickAfter), output(pickBefore), 'rotation and reviewer selection survive payload retirement');
  assert.equal(await dependentRunBlock(loadConfig(f.c.stateRoot), { id: 'fixture-resource', path: f.c.work }), null, 'worktree cleanup still has positive process evidence');
  const result = await orch(['result', f.id, '--json'], f.c.env);
  assert.equal(output(result).final_message, 'a retained final answer');
  assert.equal(output(result).transcripts.stdout.state, 'purged');
  assert.equal(output(result).model_actual, null, 'no invented actual model');
  const log = await orch(['log', f.id, '--stream', 'stdout'], f.c.env);
  assert.match(log.stdout, /purged/i);
  const again = await collect(f);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(output(again).runs[0].state, 'collected');
});

test('P03: absent policy is disabled and malformed policy refuses apply', async (t) => {
  const f = fixture(t, 'p03-disabled', null);
  await enroll(f);
  let r = await collect(f);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(output(r).state, 'disabled');
  assert.ok(fs.existsSync(path.join(f.dir, 'stdout.log')));
  fs.writeFileSync(path.join(f.c.stateRoot, 'config.json'), JSON.stringify({ retention: { mode: 'manual', successDays: -1, otherDays: 90 } }));
  r = await collect(f);
  assert.notEqual(r.code, 0);
  assert.ok(fs.existsSync(path.join(f.dir, 'stdout.log')));
});

test('P03: an active or uncertain worker protects all transcript files', async (t) => {
  const f = fixture(t, 'p03-active');
  await enroll(f);
  f.rec.status = 'queued';
  fs.writeFileSync(path.join(f.dir, 'run.json'), JSON.stringify(f.rec));
  let r = await collect(f);
  assert.equal(output(r).runs[0].state, 'protected');
  f.rec.status = 'completed';
  fs.writeFileSync(path.join(f.dir, 'run.json'), JSON.stringify(f.rec));
  fs.writeFileSync(path.join(f.dir, 'keeper.ndjson'), '{}\n');
  r = await collect(f);
  assert.match(output(r).runs[0].reason, /liveness|process|exit/i);
  assert.ok(fs.existsSync(path.join(f.dir, 'stdout.log')));
});

test('P03: investigation pins persist until an explicit unpin', async (t) => {
  const f = fixture(t, 'p03-pin');
  await enroll(f);
  let r = await orch(['maintain', '--pin', f.id, '--by', 'owner', '--reason', 'investigation', '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr);
  r = await collect(f);
  assert.match(output(r).runs[0].reason, /pin/i);
  r = await orch(['maintain', '--unpin', f.id, '--by', 'owner', '--reason', 'investigation closed', '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr);
  r = await collect(f);
  assert.equal(output(r).runs[0].state, 'collected');
});

test('P03: enrolled replaced/changed/linked/missing files cannot inherit deletion authority', async (t) => {
  for (const kind of ['replace', 'rewrite', 'link', 'missing']) {
    const f = fixture(t, `p03-${kind}`);
    await enroll(f);
    const file = path.join(f.dir, 'stdout.log');
    if (kind === 'rewrite') { fs.writeFileSync(file, 'new owner content'); fs.utimesSync(file, new Date(old), new Date(old)); }
    else {
      fs.renameSync(file, path.join(f.dir, 'preserved-original'));
      if (kind === 'replace') { fs.writeFileSync(file, 'new owner content'); fs.utimesSync(file, new Date(old), new Date(old)); }
      if (kind === 'link') fs.symlinkSync(f.c.work, file, 'junction');
    }
    const r = await collect(f);
    assert.notEqual(output(r).runs[0].state, 'collected', kind);
    assert.ok(fs.existsSync(path.join(f.dir, 'stderr.log')), 'whole candidate checked before deleting anything');
    if (kind === 'replace' || kind === 'rewrite') assert.equal(fs.readFileSync(file, 'utf8'), 'new owner content');
  }
});

test('P03: fresh writes, future clocks and reopened claims pin old runs', async (t) => {
  for (const kind of ['fresh', 'future', 'claim']) {
    const f = fixture(t, `p03-${kind}`);
    await enroll(f);
    if (kind === 'fresh') fs.writeFileSync(path.join(f.dir, 'stdout.log'), 'fresh write');
    if (kind === 'future') { f.rec.ended_at = '2999-01-01T00:00:00Z'; fs.writeFileSync(path.join(f.dir, 'run.json'), JSON.stringify(f.rec)); }
    if (kind === 'claim') assert.equal((await orch(['claim', 'WP-retain', '--by', 'owner'], f.c.env)).code, 0);
    const r = await collect(f);
    assert.equal(output(r).runs[0].state, 'protected', kind);
    assert.ok(fs.existsSync(path.join(f.dir, 'stdout.log')));
  }
});

function createdFixture(t, name) {
  const f = fixture(t, name, { mode: 'manual', successDays: 0, otherDays: 0, maxMs: 8000 });
  const cfg = loadConfig(f.c.stateRoot);
  const prior = f.dir + '-original';
  fs.renameSync(f.dir, prior);
  beginRunArtifacts(cfg, f.id);
  fs.cpSync(prior, f.dir, { recursive: true, preserveTimestamps: true });
  confirmRunArtifacts(cfg, f.id);
  return f;
}

test('P03 repair: owned standalone enrollment explicitly finalizes without replacing creation evidence', async (t) => {
  const f = createdFixture(t, 'p03-owned-finalize');
  f.rec.wp = null; fs.writeFileSync(path.join(f.dir, 'run.json'), JSON.stringify(f.rec));
  const file = path.join(f.c.stateRoot, 'retention', 'owned', f.id + '.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(output(await collect(f)).runs[0].reason, /finalization/);
  await enroll(f);
  const finalized = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of Object.keys(original)) assert.deepEqual(finalized[key], original[key]);
  assert.equal(finalized.finalization.by, 'owner');
  assert.ok(finalized.finalized_at);
  const first = fs.readFileSync(file);
  await enroll(f);
  assert.deepEqual(fs.readFileSync(file), first, 'repeat cannot reset the retention clock');
  assert.equal(output(await collect(f)).runs[0].state, 'collected');
});

test('P03 repair: collection never materializes payloads through unbounded whole-file reads', async (t) => {
  const f = fixture(t, 'p03-bounded-read'); await enroll(f);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (['stdout.log', 'stderr.log', 'prompt.txt'].some((p) => file === path.join(f.dir, p))) throw new Error('unbounded payload read');
    return read(file, ...args);
  });
  assert.equal((await cmdMaintain(loadConfig(f.c.stateRoot), { apply: true }, { log() {} })).runs[0].state, 'collected');
});

test('P03 repair: oversized owned payloads remain intact with an explicit memory-limit reason', async (t) => {
  const f = createdFixture(t, 'p03-large-payload');
  const file = path.join(f.dir, 'stdout.log');
  fs.truncateSync(file, 8 * 1024 * 1024 + 1); fs.utimesSync(file, new Date(old), new Date(old));
  const r = output(await collect(f));
  assert.equal(r.runs[0].state, 'protected');
  assert.match(r.runs[0].reason, /payload.*limit/i);
  assert.equal(fs.statSync(file).size, 8 * 1024 * 1024 + 1);
});

test('P03 repair: payload growth during a bounded read cannot exceed its allocation ceiling or cause deletion', async (t) => {
  const f = fixture(t, 'p03-read-growth'); await enroll(f);
  const file = path.join(f.dir, 'stdout.log');
  const open = /** @type {(...args:any[])=>any} */ (fs.openSync);
  const read = /** @type {(...args:any[])=>any} */ (fs.readSync);
  let targetFd, bytes = 0, grew = false;
  t.mock.method(fs, 'openSync', (p, ...args) => { const fd = open(p, ...args); if (p === file && args[0] === 'r') targetFd = fd; return fd; });
  t.mock.method(fs, 'readSync', (fd, ...args) => {
    const n = read(fd, ...args);
    if (fd === targetFd) {
      bytes += n;
      if (!grew) { grew = true; fs.truncateSync(file, 8 * 1024 * 1024 + 1); }
    }
    return n;
  });
  const r = await cmdMaintain(loadConfig(f.c.stateRoot), { apply: true }, { log() {} });
  assert.equal(r.runs[0].state, 'pending'); assert.match(r.runs[0].reason, /payload.*limit/);
  assert.equal(bytes, 8 * 1024 * 1024 + 1);
  assert.ok(fs.existsSync(file)); assert.ok(fs.existsSync(path.join(f.dir, 'stderr.log')));
});

test('P03 repair: corrupt compact evidence preserves verified original readers and exposes integrity diagnostics', async (t) => {
  const f = fixture(t, 'p03-intact-corrupt'); await enroll(f);
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (file) => { if (file === path.join(f.dir, 'stdout.log')) throw new Error('fixture sharing failure'); return unlink(file); });
  await cmdMaintain(loadConfig(f.c.stateRoot), { apply: true }, { log() {} });
  t.mock.restoreAll();
  const receipt = path.join(f.c.stateRoot, 'retention', 'receipts', f.id + '.json');
  const doc = JSON.parse(fs.readFileSync(receipt, 'utf8')); doc.snapshot.final_message = 'invalid'; fs.writeFileSync(receipt, JSON.stringify(doc));
  const result = await orch(['result', f.id, '--json'], f.c.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(output(result).final_message, 'a retained final answer');
  assert.match(output(result).retention_evidence_error, /invalid/);
  const keeper = await orch(['log', f.id, '--stream', 'keeper'], f.c.env);
  assert.equal(keeper.code, 0, keeper.stderr); assert.match(keeper.stdout, /worker-exit/);
  const status = output(await orch(['status', f.id, '--json'], f.c.env)).runs[0];
  assert.match(status.retention_evidence_error, /invalid/);
  assert.equal(status.transcripts.stdout.state, 'available');
});

test('P03 repair: scoped disabled-policy retirement saves original authorization before deletion and retries', async (t) => {
  const f = fixture(t, 'p03-override-audit', { mode: 'disabled', successDays: 9999, otherDays: 9999 }); await enroll(f);
  const args = { apply: true, run: f.id, by: 'retirement-operator', reason: 'specific retirement authority' };
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (file) => {
    if (file === path.join(f.dir, 'stdout.log')) {
      const receipt = JSON.parse(fs.readFileSync(path.join(f.c.stateRoot, 'retention', 'receipts', f.id + '.json'), 'utf8'));
      assert.equal(receipt.authorization.by, args.by); assert.equal(receipt.authorization.reason, args.reason);
      assert.equal(receipt.authorization.overrode_policy, true);
      throw new Error('fixture sharing failure');
    }
    return unlink(file);
  });
  await cmdMaintain(loadConfig(f.c.stateRoot), args, { log() {} }); t.mock.restoreAll();
  const file = path.join(f.c.stateRoot, 'retention', 'receipts', f.id + '.json');
  const before = JSON.parse(fs.readFileSync(file, 'utf8')).authorization;
  assert.ok(before);
  await cmdMaintain(loadConfig(f.c.stateRoot), { ...args, by: 'retry-operator', reason: 'retry existing retirement' }, { log() {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).authorization, before);
  assert.equal(fs.existsSync(path.join(f.dir, 'stdout.log')), false);
});

test('P03 repair: byte-budget deferral is distinct from safety-protected storage', async (t) => {
  const f = fixture(t, 'p03-budget-counts', { mode: 'manual', successDays: 0, otherDays: 0, maxBytes: 1 }); await enroll(f);
  const r = output(await collect(f));
  assert.equal(r.runs[0].state, 'deferred'); assert.equal(r.protected_bytes, 0);
  assert.equal(r.deferred_bytes, r.runs[0].bytes); assert.equal(r.eligible_bytes, r.deferred_bytes);
});

test('P03 repair: conflicting explicit run and inventory cursor selectors refuse before collection', async (t) => {
  const f = fixture(t, 'p03-selector-conflict'); await enroll(f);
  const r = await orch(['maintain', '--apply', '--run', f.id, '--after', f.id, '--json'], f.c.env);
  assert.notEqual(r.code, 0); assert.match(r.stderr, /run.*after|selector/i);
  assert.ok(fs.existsSync(path.join(f.dir, 'stdout.log')));
});

test('P03 repair: real collector crashes around deletion recover only after explicit dead-lock inspection', async (t) => {
  for (const point of ['prepared', 'deleting', 'unlinked', 'purged']) {
    const f = fixture(t, 'p03-crash-' + point, { mode: 'disabled', successDays: 9999, otherDays: 9999 }); await enroll(f);
    const selected = ['maintain', '--apply', '--run', f.id, '--by', 'fixture-owner', '--reason', 'fixture crash recovery', '--json'];
    const receipt = path.join(f.c.stateRoot, 'retention', 'receipts', f.id + '.json');
    const target = path.join(f.dir, 'stdout.log');
    const source = new URL('../src/retention.mjs', import.meta.url).href;
    const config = new URL('../src/config.mjs', import.meta.url).href;
    const code = `import fs from 'node:fs'; import {cmdMaintain} from ${JSON.stringify(source)}; import {loadConfig} from ${JSON.stringify(config)};
      const receipt=${JSON.stringify(receipt)},target=${JSON.stringify(target)},point=${JSON.stringify(point)};
      const rename=fs.renameSync,unlink=fs.unlinkSync;
      fs.renameSync=(a,b)=>{rename(a,b);if(b===receipt){const d=JSON.parse(fs.readFileSync(b,'utf8'));if(point==='prepared'&&d.state==='prepared'||point==='deleting'&&d.files.stdout.state==='deleting'||point==='purged'&&d.files.stdout.state==='purged')process.kill(process.pid);}};
      fs.unlinkSync=(f)=>{unlink(f);if(f===target&&point==='unlinked')process.kill(process.pid);};
      await cmdMaintain(loadConfig(${JSON.stringify(f.c.stateRoot)}),{apply:true,run:${JSON.stringify(f.id)},by:'fixture-owner',reason:'fixture crash recovery'},{log(){}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: f.c.env, windowsHide: true, stdio: 'ignore' });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.notEqual(exit, 0, point);
    const original = JSON.parse(fs.readFileSync(receipt, 'utf8')).snapshot;
    const authorization = JSON.parse(fs.readFileSync(receipt, 'utf8')).authorization;
    assert.equal(authorization.by, 'fixture-owner', 'authority must survive even the first prepared-receipt crash');
    assert.equal(fs.existsSync(target), ['prepared', 'deleting'].includes(point));
    assert.equal((await orch(['result', f.id, '--json'], f.c.env)).code, 0);
    const blocked = await orch(selected, f.c.env); assert.match(blocked.stderr, /operation locked/);
    const dir = path.join(f.c.stateRoot, 'resources', 'locks');
    for (const name of fs.readdirSync(dir)) {
      const lock = path.join(dir, name); const identity = fs.statSync(lock, { bigint: true }).ino;
      assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, child.pid, 'only the exited fixture collector owns these locks');
      assert.equal(fs.statSync(lock, { bigint: true }).ino, identity); fs.unlinkSync(lock);
    }
    assert.equal(output(await orch(selected, f.c.env)).runs[0].state, 'collected');
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')).snapshot, original);
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')).authorization, authorization);
    assert.equal(output(await orch(['result', f.id, '--json'], f.c.env)).final_message, 'a retained final answer');
  }
});

test('P03: monitor, record and pin actions share the collector run guard', async (t) => {
  const f = fixture(t, 'p03-run-guard');
  await enroll(f);
  await withOperationLock(loadConfig(f.c.stateRoot), `run:${f.id}`, async () => {
    for (const argv of [['monitor', f.id], ['record', f.id, '--disposition', 'blocked'], ['review', '--run', f.id], ['maintain', '--pin', f.id, '--by', 'owner', '--reason', 'investigation']]) {
      const r = await orch(argv, f.c.env);
      assert.match(r.stderr + r.stdout, /operation locked/, argv.join(' '));
      if (argv[0] === 'monitor') assert.equal(r.code, 3, 'monitor contention preserves its refusal code');
    }
    const r = await collect(f);
    assert.equal(output(r).runs[0].state, 'pending');
    assert.ok(fs.existsSync(path.join(f.dir, 'stdout.log')));
  });
});

test('P03: bounded on-use scans advance past legacy data rather than starving later runs', async (t) => {
  const f = fixture(t, 'p03-cursor', { mode: 'on-use', successDays: 30, otherDays: 90, maxRuns: 1, minIntervalMs: 1 });
  const second = '20260102-000000-abcdef';
  const dir = path.join(f.c.stateRoot, 'runs', second);
  fs.cpSync(f.dir, dir, { recursive: true, preserveTimestamps: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ ...f.rec, id: second }));
  fs.appendFileSync(path.join(f.c.stateRoot, 'ledger.jsonl'), JSON.stringify({ run_id: second, disposition: 'blocked', recorded_at: old }) + '\n');
  const closed = path.join(f.c.stateRoot, 'finishes', 'wp-retain.json');
  fs.writeFileSync(closed, JSON.stringify({ wp: f.rec.wp, state: 'finished', closed_at: old, run_ids: [f.id, second] }));
  await enroll({ ...f, id: second, dir });
  for (let i = 0; i < 2; i++) await orch(['run', '--cli', 'missing-cli', '--dir', f.c.work, '--handoff', f.c.handoffPath], f.c.env);
  assert.equal(fs.existsSync(path.join(dir, 'stdout.log')), false, 'later eligible run must be reached');
  assert.ok(fs.existsSync(path.join(f.dir, 'stdout.log')), 'legacy run remains intact');
});

test('P03: a replaced run folder cannot reuse a prior compact result', async (t) => {
  const f = fixture(t, 'p03-folder-reuse');
  await enroll(f); await collect(f);
  fs.renameSync(f.dir, f.dir + '-original');
  fs.mkdirSync(f.dir);
  fs.writeFileSync(path.join(f.dir, 'run.json'), JSON.stringify({ ...f.rec, model_actual: 'new-owner-model' }));
  const r = await orch(['result', f.id, '--json'], f.c.env);
  assert.notEqual(r.code, 0, 'old answer must not be attached to a different physical run');
});

test('P03: corrupt compact evidence is never treated as an empty or valid result', async (t) => {
  const f = fixture(t, 'p03-corrupt');
  await enroll(f); await collect(f);
  const file = path.join(f.c.stateRoot, 'retention', 'receipts', `${f.id}.json`);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.snapshot.final_message = 'corrupted answer';
  fs.writeFileSync(file, JSON.stringify(doc));
  const r = await orch(['result', f.id, '--json'], f.c.env);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /invalid|unreadable/);
});

test('P03: Windows sharing failure leaves a compact result and retry completes exact files', async (t) => {
  const f = fixture(t, 'p03-partial');
  await enroll(f);
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$f=[IO.File]::Open($env:ORCH_FIXTURE_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null; $f.Dispose()"], { env: { ...process.env, ORCH_FIXTURE_LOCK: path.join(f.dir, 'stderr.log') }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.stdin.end('\n'));
  await new Promise((resolve, reject) => { let ready = ''; const timer = setTimeout(() => reject(new Error('fixture not ready')), 10000); child.stdout.on('data', (b) => { ready += b; if (ready.includes('ready')) { clearTimeout(timer); resolve(null); } }); });
  let r = await collect(f);
  assert.equal(r.code, 3, r.stderr);
  assert.equal(output(r).runs[0].state, 'pending');
  assert.equal(fs.existsSync(path.join(f.dir, 'stdout.log')), false);
  assert.ok(fs.existsSync(path.join(f.dir, 'stderr.log')));
  const receipt = path.join(f.c.stateRoot, 'retention', 'receipts', `${f.id}.json`);
  const before = JSON.parse(fs.readFileSync(receipt, 'utf8')).snapshot;
  r = await orch(['result', f.id, '--json'], f.c.env);
  assert.equal(output(r).final_message, 'a retained final answer');
  r = await orch(['status', f.id, '--json'], f.c.env);
  assert.equal(output(r).runs[0].transcripts.stdout.state, 'purged');
  assert.equal(output(r).runs[0].derived_status, 'completed', 'missing logs must not change the terminal classification');
  const closed = new Promise((resolve) => child.once('close', resolve)); child.stdin.end('\n'); await closed;
  r = await collect(f);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(output(r).runs[0].state, 'collected');
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')).snapshot, before, 'retry preserves original compact evidence');
});

test('P03: on-use is opt-in, rate-limited and records ownership for newly launched runs', async (t) => {
  const f = fixture(t, 'p03-onuse', { mode: 'on-use', successDays: 30, otherDays: 90, minIntervalMs: 3600000, maxMs: 8000 });
  await enroll(f);
  const r = await orch(['run', '--cli', 'fake', '--model', 'test-model', '--dir', f.c.work, '--handoff', f.c.handoffPath, '--lane', 'cloud', '--no-window', '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr);
  const id = output(r).id;
  await waitForStatus(f.c.stateRoot, id, ['completed', 'failed'], { timeoutMs: 30000 });
  assert.equal(fs.existsSync(path.join(f.dir, 'stdout.log')), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.c.stateRoot, 'retention', 'owned', `${id}.json`), 'utf8'));
  assert.equal(manifest.source, 'orch-run');
  assert.equal(manifest.state, 'confirmed');
  const schedule = path.join(f.c.stateRoot, 'retention', 'on-use.json');
  const first = fs.readFileSync(schedule);
  const again = await orch(['run', '--cli', 'missing-cli', '--model', 'test-model', '--dir', f.c.work, '--handoff', f.c.handoffPath, '--json'], f.c.env);
  assert.notEqual(again.code, 0);
  assert.deepEqual(fs.readFileSync(schedule), first, 'within-interval calls do not collect again');
});

test('P03: byte budgets and pending reviews/gates retain their dependencies', async (t) => {
  for (const kind of ['budget', 'review', 'gate', 'incident', 'cleanup']) {
    const f = fixture(t, `p03-${kind}`, { mode: 'manual', successDays: 30, otherDays: 90, maxBytes: kind === 'budget' ? 1 : 1024 });
    await enroll(f);
    if (kind === 'review' || kind === 'incident') {
      fs.mkdirSync(path.join(f.c.stateRoot, 'reviews'));
      fs.writeFileSync(path.join(f.c.stateRoot, 'reviews', 'rv-fixture.json'), JSON.stringify({ id: 'rv-fixture', implementer_run: f.id, wp: f.rec.wp, ...(kind === 'incident' ? { finished_at: old, containment: 'breach', breaches: ['fixture breach'] } : {}) }));
    }
    if (kind === 'gate') {
      const dir = path.join(f.c.stateRoot, 'gates', 'wp-retain', 's1'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'round-1.json'), JSON.stringify({ round: 1, findings: [], verification: 'fail', scope: 'pass' }));
    }
    if (kind === 'cleanup') { fs.mkdirSync(path.join(f.c.stateRoot, 'resources'), { recursive: true }); fs.writeFileSync(path.join(f.c.stateRoot, 'resources', 'r.json'), JSON.stringify({ id: 'r', wp: f.rec.wp, state: 'cleanup-pending' })); }
    const r = await collect(f);
    assert.equal(output(r).runs[0].state, kind === 'budget' ? 'deferred' : 'protected', kind);
    assert.ok(fs.existsSync(path.join(f.dir, 'stdout.log')));
  }
});

test('P03: successful and other-terminal policies use finalization age, not file dates', async (t) => {
  for (const [accepted, days, state] of [[true, 29, 'protected'], [true, 31, 'collected'], [false, 89, 'protected'], [false, 91, 'collected']]) {
    const f = fixture(t, `p03-age-${accepted}-${days}`);
    const at = new Date(Date.now() - Number(days) * 86400000).toISOString();
    f.rec.ended_at = at;
    fs.writeFileSync(path.join(f.dir, 'run.json'), JSON.stringify(f.rec));
    fs.writeFileSync(path.join(f.c.stateRoot, 'finishes', 'wp-retain.json'), JSON.stringify({ wp: f.rec.wp, state: 'finished', closed_at: at, run_ids: [f.id] }));
    fs.writeFileSync(path.join(f.c.stateRoot, 'ledger.jsonl'), JSON.stringify({ run_id: f.id, disposition: accepted ? 'accepted' : 'rejected', model_canonical: 'fixture-model', recorded_at: old }) + '\n');
    if (accepted) {
      const gates = path.join(f.c.stateRoot, 'gates', 'wp-retain', 's1'); fs.mkdirSync(gates, { recursive: true });
      fs.writeFileSync(path.join(gates, 'round-1.json'), JSON.stringify({ round: 1, findings: [], verification: 'pass', scope: 'pass' }));
      const reviews = path.join(f.c.stateRoot, 'reviews'); fs.mkdirSync(reviews);
      fs.writeFileSync(path.join(reviews, 'rv-fixture.json'), JSON.stringify({ id: 'rv-fixture', implementer_run: f.id, finished_at: at, containment: 'clean' }));
    }
    await enroll(f);
    const r = await collect(f);
    assert.equal(output(r).runs[0].state, state, `${accepted}, ${days}: ${r.stdout}`);
  }
});

test('P03: MCP exposes the same explicit enrollment, preview, pin and collection controls', async (t) => {
  const f = fixture(t, 'p03-mcp');
  const options = { stateRoot: f.c.stateRoot };
  for (const args of [{ enroll: f.id, by: 'owner', reason: 'fixture' }, { pin: f.id, by: 'owner', reason: 'fixture' }, { unpin: f.id, by: 'owner', reason: 'closed' }]) {
    const r = await callTool('maintain', args, options);
    assert.equal(r.isError, false, JSON.stringify(r));
  }
  let r = await callTool('maintain', { 'dry-run': true }, options);
  assert.equal(r.isError, false);
  assert.ok(fs.existsSync(path.join(f.dir, 'stdout.log')));
  r = await callTool('maintain', { apply: true }, options);
  assert.equal(r.isError, false, JSON.stringify(r));
  assert.equal(fs.existsSync(path.join(f.dir, 'stdout.log')), false);
});

test('P03: unsupported maintenance flags cannot silently select destructive apply', async (t) => {
  const f = fixture(t, 'p03-options'); await enroll(f);
  const r = await orch(['maintain', '--apply', '--keep', f.id, '--json'], f.c.env);
  assert.notEqual(r.code, 0);
  assert.ok(fs.existsSync(path.join(f.dir, 'stdout.log')));
});

test('P03: failure after a partial purge remains actionable when a dependency becomes pinned', async (t) => {
  const f = fixture(t, 'p03-pending-pin'); await enroll(f); await collect(f);
  const file = path.join(f.c.stateRoot, 'retention', 'receipts', `${f.id}.json`);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.state = 'partial'; doc.files.prompt.state = 'deleting';
  fs.writeFileSync(file, JSON.stringify(doc));
  await orch(['maintain', '--pin', f.id, '--by', 'owner', '--reason', 'new investigation'], f.c.env);
  const r = await collect(f);
  assert.equal(r.code, 3);
  assert.equal(output(r).state, 'pending');
});

test('P03: standalone runs need an explicit finalization decision before scoped collection', async (t) => {
  const f = fixture(t, 'p03-standalone', null);
  f.rec.wp = null; fs.writeFileSync(path.join(f.dir, 'run.json'), JSON.stringify(f.rec));
  const selected = ['maintain', '--apply', '--run', f.id, '--by', 'owner', '--reason', 'fixture retirement', '--json'];
  let r = await orch(selected, f.c.env);
  assert.equal(output(r).runs[0].state, 'legacy');
  await enroll(f);
  r = await orch(selected, f.c.env);
  assert.equal(output(r).runs[0].state, 'collected');
});

test('P03: finish invokes on-use outside the package guard and emits one structured result', async (t) => {
  const f = fixture(t, 'p03-finish-onuse', { mode: 'on-use', successDays: 0, otherDays: 0, maxMs: 8000 });
  await enroll(f);
  fs.unlinkSync(path.join(f.c.stateRoot, 'finishes', 'wp-retain.json'));
  assert.equal((await orch(['claim', f.rec.wp, '--by', 'owner'], f.c.env)).code, 0);
  const r = await orch(['finish', f.rec.wp, '--by', 'owner', '--json'], f.c.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(output(r).state, 'finished');
  assert.equal(output(r).maintenance.runs[0].state, 'collected');
  assert.equal(fs.existsSync(path.join(f.dir, 'stdout.log')), false);
});

test('P03: unknown monitor identity and stream-close timeouts block collection', async (t) => {
  for (const kind of ['monitor', 'streams']) {
    const f = fixture(t, `p03-${kind}-unknown`); await enroll(f);
    if (kind === 'monitor') fs.writeFileSync(path.join(f.dir, 'spawned.json'), JSON.stringify({ monitor_pid: process.pid, monitor_created_at: null }));
    else fs.writeFileSync(path.join(f.dir, 'keeper.ndjson'), [{ event: 'worker-exit', at: old, code: 0 }, { event: 'streams-close-timeout', at: old }, { event: 'keeper-exit', at: old }].map((v) => JSON.stringify(v)).join('\n') + '\n');
    const r = await collect(f);
    assert.equal(output(r).runs[0].state, 'protected');
    assert.ok(fs.existsSync(path.join(f.dir, 'stdout.log')));
  }
});

test('P03: concurrent processes collect once or report a lock without changing compact evidence', async (t) => {
  const f = fixture(t, 'p03-collector-contention'); await enroll(f);
  const bytes = ['stdout.log', 'stderr.log', 'prompt.txt'].reduce((n, p) => n + fs.statSync(path.join(f.dir, p)).size, 0);
  const results = await contendEach([['maintain', '--apply', '--json'], ['maintain', '--apply', '--json']], f.c.env);
  assert.ok(results.some((r) => r.code === 0));
  for (const r of results) if (r.code !== 0) assert.match(r.stderr, /operation locked/);
  assert.equal(results.filter((r) => r.code === 0).reduce((n, r) => n + output(r).removed_bytes, 0), bytes);
  const receipt = path.join(f.c.stateRoot, 'retention', 'receipts', `${f.id}.json`);
  const snapshot = JSON.parse(fs.readFileSync(receipt, 'utf8')).snapshot;
  assert.equal((await collect(f)).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')).snapshot, snapshot);
});

test('P03: a gate override cannot change dependency decisions while package maintenance holds its guard', async (t) => {
  const f = fixture(t, 'p03-gate-guard'); await enroll(f);
  await withOperationLock(loadConfig(f.c.stateRoot), 'wp:wp-retain', async () => {
    const r = await orch(['gate', 'record', '--wp', f.rec.wp, '--slice', 's1', '--round', '1', '--findings', '[]', '--verification', 'pass', '--scope', 'pass', '--json'], f.c.env);
    assert.match(r.stderr, /operation locked/);
    assert.equal(fs.existsSync(path.join(f.c.stateRoot, 'gates')), false);
  });
});

test('P03: a linked lock directory cannot redirect maintenance writes outside its state root', async (t) => {
  const f = fixture(t, 'p03-linked-locks');
  fs.symlinkSync(f.c.work, path.join(f.c.stateRoot, 'resources'), 'junction');
  const r = await orch(['maintain', '--enroll', f.id, '--by', 'owner', '--reason', 'fixture', '--json'], f.c.env);
  assert.notEqual(r.code, 0);
  assert.equal(fs.existsSync(path.join(f.c.work, 'locks')), false);
});

test('P03: malformed timestamps cannot acquire deletion eligibility through permissive date parsing', async (t) => {
  const f = fixture(t, 'p03-clock-invalid'); await enroll(f);
  f.rec.ended_at = '0';
  fs.writeFileSync(path.join(f.dir, 'run.json'), JSON.stringify(f.rec));
  const r = await collect(f);
  assert.equal(output(r).runs[0].state, 'protected');
  assert.ok(fs.existsSync(path.join(f.dir, 'stdout.log')));
});

test('P03: package incidents are protected across equivalent claim-name casing', async (t) => {
  const f = fixture(t, 'p03-wp-case'); await enroll(f);
  const reviews = path.join(f.c.stateRoot, 'reviews'); fs.mkdirSync(reviews);
  fs.writeFileSync(path.join(reviews, 'rv-other.json'), JSON.stringify({ id: 'rv-other', wp: 'wp-retain', implementer_run: 'another-run', finished_at: old, containment: 'breach', breaches: ['fixture incident'] }));
  const r = await collect(f);
  assert.equal(output(r).runs[0].state, 'protected');
  assert.ok(fs.existsSync(path.join(f.dir, 'stdout.log')));
});

test('P03: retries spend their bounded action time on remaining files, not already purged streams', async (t) => {
  const f = fixture(t, 'p03-retry-budget', { mode: 'manual', successDays: 30, otherDays: 90, maxMs: 8 });
  await enroll(f);
  const at = Date.now();
  let ticks = 0;
  t.mock.method(Date, 'now', () => at + ++ticks);
  let r;
  for (let i = 0; i < 3; i++) {
    ticks = 0;
    r = await cmdMaintain(loadConfig(f.c.stateRoot), { apply: true }, { log() {} });
  }
  assert.equal(r.state, 'complete');
  assert.equal(fs.existsSync(path.join(f.dir, 'prompt.txt')), false);
});

test('P03: graceful exit releases owned guards but abrupt death never authorizes stale takeover', async (t) => {
  for (const mode of ['exit', 'kill']) {
    const f = fixture(t, `p03-lock-${mode}`);
    const src = new URL('../src/resources.mjs', import.meta.url).href;
    const cfg = new URL('../src/config.mjs', import.meta.url).href;
    const code = `import { withOperationLock } from ${JSON.stringify(src)}; import { loadConfig } from ${JSON.stringify(cfg)}; await withOperationLock(loadConfig(${JSON.stringify(f.c.stateRoot)}), 'run:${f.id}', async () => { ${mode === 'exit' ? 'process.exit(9)' : 'process.kill(process.pid)'}; });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: f.c.env, windowsHide: true, stdio: 'ignore' });
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.notEqual(exit, 0);
    const locks = fs.readdirSync(path.join(f.c.stateRoot, 'resources', 'locks'));
    assert.equal(locks.length, mode === 'exit' ? 0 : 1);
    if (mode === 'kill') {
      const r = await orch(['maintain', '--pin', f.id, '--by', 'owner', '--reason', 'fixture', '--json'], f.c.env);
      assert.match(r.stderr, /operation locked/);
      assert.equal(fs.readdirSync(path.join(f.c.stateRoot, 'resources', 'locks')).length, 1);
    }
  }
});
