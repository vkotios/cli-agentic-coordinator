// G5 — cancel tells the truth (amendment A3).
//
// `orch cancel` may report success ONLY when a post-kill process-table read shows the
// recorded MAIN worker gone. A refused kill is NOT evidence of death, and `cancel.json`
// is a request that can never make a live worker look terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeCase,
  orch,
  idFrom,
  waitFor,
  waitForStatus,
  keeperLines,
  readRunRecord,
  identityOf,
  killOwnedChecked, testReps } from './helpers.mjs';
import { probeFree } from '../src/lanepipe.mjs';
import { readProcessTable, verifyIdentity } from '../src/procs.mjs';

const REPS = testReps(20, 'ORCH_G5_REPS');

function runArgs(c, extra = []) {
  return ['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--lane', 'local', '--no-window', ...extra];
}

async function launch(c, holdS = 40, extra = []) {
  const r = await orch(runArgs(c, ['--flag', '--alive-marker', '--flag', '--hold', '--flag', String(holdS), ...extra]), c.env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const id = idFrom(r.stdout);
  const workerPid = await waitFor(
    () => {
      const l = keeperLines(c.stateRoot, id).find((x) => x.event === 'spawned');
      return l ? l.worker_pid : null;
    },
    { timeoutMs: 20000, what: 'the worker pid' },
  );
  const workerCreatedAt = await waitFor(
    () => {
      const l = keeperLines(c.stateRoot, id).find((x) => x.event === 'worker-identity');
      return l ? l.worker_created_at : null;
    },
    { timeoutMs: 20000, what: 'the worker OS creation time' },
  );
  return { id, workerPid, workerCreatedAt };
}

test(`G5/TE: cancel at ${REPS} randomised offsets -> never 'cancelled' without a verified-gone worker`, { timeout: 25 * 60 * 1000 }, async (t) => {
  const c = makeCase('g5');
  t.after(() => c.cleanup());
  const dist = { cancelled: 0, unconfirmed: 0, offsets: [], laneFreed: 0 };

  for (let rep = 0; rep < REPS; rep++) {
    const { id, workerPid, workerCreatedAt } = await launch(c, 40);
    const offset = Math.round(Math.random() * 1500);
    dist.offsets.push(offset);
    await new Promise((r) => setTimeout(r, offset));

    const res = await orch(['cancel', id, '--json'], c.env);
    const out = JSON.parse(res.stdout);
    const after = await identityOf(workerPid, workerCreatedAt);

    if (out.cancel_state === 'cancelled') {
      dist.cancelled++;
      assert.equal(res.code, 0);
      assert.ok(['gone', 'mismatch'].includes(after), `rep ${rep}: 'cancelled' was claimed while the worker verifies ${after}`);
      assert.ok(['gone', 'mismatch'].includes(out.worker_identity_after), `rep ${rep}: no post-kill verification: ${res.stdout}`);
      assert.deepEqual(out.survivors, []);
    } else {
      dist.unconfirmed++;
      assert.equal(res.code, 3, `rep ${rep}: an unconfirmed cancel must exit 3`);
      assert.match(res.stdout, /unconfirmed/);
    }
    // The lane must be released once the worker is gone.
    if (['gone', 'mismatch'].includes(after)) {
      const free = await waitFor(async () => (await probeFree(c.lanePipe)).free, { timeoutMs: 20000, what: 'lane free after cancel' });
      if (free) dist.laneFreed++;
    }
    // And the record must be terminal only because the worker really ended.
    const rec = await waitForStatus(c.stateRoot, id, ['cancelled', 'failed', 'interrupted', 'completed'], { timeoutMs: 40000 });
    assert.ok(keeperLines(c.stateRoot, id).some((l) => l.event === 'worker-exit'), `rep ${rep}: terminal without a worker-exit line`);
    assert.ok(['cancelled', 'failed'].includes(rec.status), `rep ${rep}: unexpected terminal status ${rec.status}`);
  }
  console.log(`G5 distribution over ${REPS} reps: cancelled=${dist.cancelled} unconfirmed=${dist.unconfirmed} laneFreed=${dist.laneFreed}`);
  console.log(`  cancel offsets ms: ${dist.offsets.join(',')}`);
  assert.equal(dist.cancelled + dist.unconfirmed, REPS);
});

test('G5: PID-REUSE simulation -> no kill at all, `unconfirmed`, and the worker is still alive', { timeout: 180000 }, async (t) => {
  const c = makeCase('g5-pidreuse');
  t.after(() => c.cleanup());
  const { id, workerPid, workerCreatedAt } = await launch(c, 40);

  // Simulate a stale record: the pid is right, the recorded OS creation time is not.
  // (Exactly what a recycled pid looks like from the outside.)
  const keeperFile = path.join(c.stateRoot, 'runs', id, 'keeper.ndjson');
  fs.appendFileSync(
    keeperFile,
    JSON.stringify({ event: 'worker-identity', worker_pid: workerPid, worker_created_at: 'ms:1', at: new Date().toISOString() }) + '\n',
  );

  const res = await orch(['cancel', id, '--json'], c.env);
  const out = JSON.parse(res.stdout);
  assert.equal(out.kill_verdict, 'mismatch', `the kill should have been REFUSED on identity: ${res.stdout}`);
  assert.equal(out.killed, false);
  assert.equal(out.cancel_state, 'unconfirmed-identity-mismatch');
  assert.equal(res.code, 3);
  assert.match(res.stdout, /unconfirmed/);

  // r2-8 / r3-4: a refused kill is not evidence of death. The worker is untouched...
  assert.equal(await identityOf(workerPid, workerCreatedAt), 'match', 'the worker was killed despite an identity mismatch');
  // ...and the run is NOT terminal.
  const st = await orch(['status', id, '--json'], c.env);
  const row = JSON.parse(st.stdout).runs[0];
  assert.equal(row.cancel_requested, true, 'the request is recorded...');
  assert.ok(!['cancelled', 'completed', 'failed'].includes(row.record_status), `...but it must not terminalize a live worker: ${row.record_status}`);
  assert.equal(row.derived_status, 'running', 'a mismatch is NOT evidence that our worker died (A3)');
  assert.match(row.derived_reason, /cancel-requested-worker-not-confirmed-gone/);

  // Clean up the run properly: repair the record and cancel for real.
  fs.appendFileSync(
    keeperFile,
    JSON.stringify({ event: 'worker-identity', worker_pid: workerPid, worker_created_at: workerCreatedAt, at: new Date().toISOString() }) + '\n',
  );
  fs.rmSync(path.join(c.stateRoot, 'runs', id, 'cancel.json'), { force: true });
  const real = await orch(['cancel', id, '--json'], c.env);
  assert.equal(JSON.parse(real.stdout).cancel_state, 'cancelled');
});

test('G5: concurrent cancels are serialised by `wx`; the loser prints the standing request and changes nothing', { timeout: 180000 }, async (t) => {
  const c = makeCase('g5-concurrent');
  t.after(() => c.cleanup());
  const { id, workerPid, workerCreatedAt } = await launch(c, 30);
  const [a, b] = await Promise.all([orch(['cancel', id, '--json'], c.env), orch(['cancel', id, '--json'], c.env)]);
  const outs = [JSON.parse(a.stdout), JSON.parse(b.stdout)];
  assert.equal(outs.filter((o) => o.first_requester === true).length, 1, 'exactly one cancel process may create cancel.json');
  assert.ok(['gone', 'mismatch'].includes(await identityOf(workerPid, workerCreatedAt)));
  const rec = await waitForStatus(c.stateRoot, id, ['cancelled', 'failed'], { timeoutMs: 40000 });
  assert.ok(['cancelled', 'failed'].includes(rec.status));
});

test('G5: cancel with NO recorded worker identity refuses to kill and says so', { timeout: 120000 }, async (t) => {
  const c = makeCase('g5-noidentity');
  t.after(() => c.cleanup());
  // A run that was refused at Phase A has no worker at all.
  const r = await orch(runArgs(c), { ...c.env, ORCH_FAKE_EXE: path.join(c.base, 'nope.exe') });
  assert.notEqual(r.code, 0);
  const id = fs.readdirSync(path.join(c.stateRoot, 'runs')).sort().pop();
  const res = await orch(['cancel', id, '--json'], c.env);
  const out = JSON.parse(res.stdout);
  assert.equal(out.cancel_state, 'unconfirmed-no-identity');
  assert.equal(res.code, 3);
  assert.match(res.stdout, /no worker pid was ever recorded|unconfirmed/);
});

test('G5/T4: cancel leaves no non-detached descendant behind, and says that /T reached the tree', { timeout: 180000 }, async (t) => {
  const c = makeCase('g5-tree');
  const strays = [];
  t.after(async () => {
    for (const s of strays) await killOwnedChecked(s.pid, s.createdAt);
    c.cleanup();
  });
  const { id, workerPid, workerCreatedAt } = await launch(c, 40, ['--flag', '--grandchild']);
  // Record the descendants BEFORE the kill, so cleanup can verify them by identity.
  await new Promise((r) => setTimeout(r, 1500));
  const full = await readProcessTable({ deadlineMs: 6000 });
  const before = full ? full.filter((p) => p.ppid === workerPid) : [];
  for (const d of before) strays.push({ pid: d.pid, createdAt: d.createdAt });
  assert.ok(before.length >= 1, 'the fake worker did not produce a descendant to test against');

  const res = await orch(['cancel', id, '--json'], c.env);
  const out = JSON.parse(res.stdout);
  assert.equal(out.cancel_state, 'cancelled', res.stdout);
  assert.match(String(out.note), /tree kill also ends descendants/, 'the accepted /T conflict must be stated in the output');
  const human = await orch(['cancel', id], c.env); // already terminal now, but the text path must carry it too
  assert.equal(human.code, 0);
  assert.ok(['gone', 'mismatch'].includes(await identityOf(workerPid, workerCreatedAt)));
  const after = await readProcessTable({ deadlineMs: 6000, pids: before.map((d) => d.pid) });
  for (const d of before) {
    const v = verifyIdentity(d.pid, d.createdAt, after).verdict;
    assert.ok(['gone', 'mismatch'].includes(v), `a non-detached descendant survived the tree kill (${d.pid}: ${v})`);
  }
});

test('cancel of an already-terminal run is a no-op that exits 0', { timeout: 120000 }, async (t) => {
  const c = makeCase('g5-terminal');
  t.after(() => c.cleanup());
  const r = await orch(runArgs(c), c.env);
  const id = idFrom(r.stdout);
  await waitForStatus(c.stateRoot, id, ['completed', 'failed'], { timeoutMs: 40000 });
  const res = await orch(['cancel', id, '--json'], c.env);
  assert.equal(res.code, 0);
  assert.equal(JSON.parse(res.stdout).cancel_state, 'already-terminal');
  assert.ok(!fs.existsSync(path.join(c.stateRoot, 'runs', id, 'cancel.json')), 'no cancel request should be created for a finished run');
});
