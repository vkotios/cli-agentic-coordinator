// G6 / TD — `orch wait-lane`.
//
// It must NEVER bind (proved by a contender binding while it runs), must exit when the
// lane frees, must always have a deadline, and must write no file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeCase, orch, ORCH_BIN, idFrom, waitFor, keeperLines, suspendProcess, resumeProcess, spawnedIdentity, contend, testReps } from './helpers.mjs';
import { probeFree } from '../src/lanepipe.mjs';

const REPS = testReps(20, 'ORCH_G6_REPS');

function runArgs(c, extra = []) {
  return ['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--lane', 'local', '--no-window', '--no-monitor', ...extra];
}

/** `orch wait-lane` as a separate OS process, so it really runs concurrently. */
function startWaitLane(c, args = []) {
  const child = spawn(process.execPath, [ORCH_BIN, 'wait-lane', '--lane', 'local', '--json', ...args], {
    env: c.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout: out, stderr: err })));
  return { child, done };
}

function laneSnapshot(dir) {
  try {
    return fs
      .readdirSync(dir)
      .sort()
      .map((f) => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`)
      .join('|');
  } catch {
    return '(missing)';
  }
}

test(`G6/TD: wait-lane against held / free / frozen holders, ${REPS}x each`, { timeout: 25 * 60 * 1000 }, async (t) => {
  const c = makeCase('g6');
  let frozen = null;
  t.after(async () => {
    if (frozen) await resumeProcess(frozen.pid, frozen.createdAt);
    c.cleanup();
  });

  const dist = { free: [], held: [], frozen: [] };

  // FREE: exits 0 at once.
  for (let i = 0; i < REPS; i++) {
    const t0 = Date.now();
    const r = await orch(['wait-lane', '--lane', 'local', '--timeout', '5', '--json'], c.env);
    assert.equal(r.code, 0, `free lane rep ${i}: ${r.stdout}${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).state, 'free');
    dist.free.push(Date.now() - t0);
  }

  // HELD: exits 3 on its deadline, naming the holder, and writes nothing.
  for (let i = 0; i < REPS; i++) {
    const run = await orch(runArgs(c, ['--flag', '--hold', '--flag', '20']), c.env);
    const id = idFrom(run.stdout);
    await waitFor(() => keeperLines(c.stateRoot, id).some((l) => l.event === 'spawned'), { timeoutMs: 20000, what: 'spawn' });
    const before = laneSnapshot(c.laneDirLocal);
    const t0 = Date.now();
    const r = await orch(['wait-lane', '--lane', 'local', '--timeout', '2', '--json'], c.env);
    const ms = Date.now() - t0;
    dist.held.push(ms);
    assert.equal(r.code, 3, `held lane rep ${i}: expected exit 3, got ${r.code}: ${r.stdout}`);
    const o = JSON.parse(r.stdout);
    assert.equal(o.timed_out, true);
    assert.equal(o.holder_run, id, 'the timed-out answer must name the holder');
    assert.ok(ms < 12000, `held lane rep ${i}: the deadline was not honoured (${ms}ms)`);
    assert.equal(laneSnapshot(c.laneDirLocal), before, `held lane rep ${i}: wait-lane WROTE into the lane directory`);
    await orch(['cancel', id, '--json'], c.env);
    await waitFor(async () => (await probeFree(c.lanePipe)).free, { timeoutMs: 20000, what: 'lane free' });
  }

  // FROZEN holder: the answer is `held, unresponsive`, and nothing is released.
  for (let i = 0; i < Math.min(REPS, 5); i++) {
    const run = await orch(runArgs(c, ['--flag', '--hold', '--flag', '25']), c.env);
    const id = idFrom(run.stdout);
    const spawned = await waitFor(() => spawnedIdentity(c.stateRoot, id), { timeoutMs: 20000, what: 'spawned.json' });
    await waitFor(() => keeperLines(c.stateRoot, id).some((l) => l.event === 'spawned'), { timeoutMs: 20000, what: 'spawn' });
    const s = await suspendProcess(spawned.keeper_pid, spawned.keeper_created_at);
    assert.ok(s.ok, s.output);
    frozen = { pid: spawned.keeper_pid, createdAt: spawned.keeper_created_at };
    const t0 = Date.now();
    const r = await orch(['wait-lane', '--lane', 'local', '--timeout', '3', '--json'], c.env);
    dist.frozen.push(Date.now() - t0);
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.stdout).state, 'held, unresponsive', `a frozen holder was misclassified: ${r.stdout}`);
    const cleared = await orch(['cancel', '--keeper', id, '--json'], c.env);
    frozen = null;
    assert.equal(cleared.code, 0, `cancel --keeper did not clear the frozen holder: ${cleared.stdout}`);
  }

  const sum = (a) => `n=${a.length} min=${Math.min(...a)} max=${Math.max(...a)}`;
  console.log(`G6 distribution: free ${sum(dist.free)}ms | held ${sum(dist.held)}ms | frozen ${sum(dist.frozen)}ms`);
});

test('G6: wait-lane NEVER binds - a contender takes the lane while wait-lane is running', { timeout: 180000 }, async (t) => {
  const c = makeCase('g6-nobind');
  t.after(() => c.cleanup());

  // Hold the lane, start wait-lane, then release the holder.
  const holder = await orch(runArgs(c, ['--flag', '--hold', '--flag', '4']), c.env);
  const holderId = idFrom(holder.stdout);
  await waitFor(() => keeperLines(c.stateRoot, holderId).some((l) => l.event === 'spawned'), { timeoutMs: 20000, what: 'spawn' });

  const w = startWaitLane(c, ['--timeout', '60']);
  await new Promise((r) => setTimeout(r, 500));

  // While wait-lane is polling, a NEW run must be able to take the lane the moment it
  // frees. If wait-lane were binding, this would fail or the run would be refused.
  const contender = await waitFor(
    async () => {
      const r = await orch(runArgs(c, ['--flag', '--hold', '--flag', '3']), c.env);
      return r.code === 0 ? r : null;
    },
    { timeoutMs: 60000, intervalMs: 300, what: 'a contender to bind the lane while wait-lane runs' },
  );
  const contenderId = idFrom(contender.stdout);
  assert.notEqual(contenderId, holderId);

  const res = await w.done;
  assert.equal(res.code, 0, `wait-lane should have seen the lane free at least once: ${res.stdout}${res.stderr}`);
  assert.equal(JSON.parse(res.stdout).state, 'free');
  console.log(`G6: a contender bound the lane while wait-lane was running (${holderId} -> ${contenderId})`);
  await orch(['cancel', contenderId, '--json'], c.env);
});

test('G6: two notifiers + two runners -> still exactly one admitted', { timeout: 180000 }, async (t) => {
  const c = makeCase('g6-mixed');
  t.after(() => c.cleanup());
  const holder = await orch(runArgs(c, ['--flag', '--hold', '--flag', '3']), c.env);
  const holderId = idFrom(holder.stdout);
  await waitFor(() => keeperLines(c.stateRoot, holderId).some((l) => l.event === 'spawned'), { timeoutMs: 20000, what: 'spawn' });

  const w1 = startWaitLane(c, ['--timeout', '40']);
  const w2 = startWaitLane(c, ['--timeout', '40']);
  await new Promise((r) => setTimeout(r, 200));

  // Two runners released at one barrier, while two notifiers poll the same name.
  const results = await contend(2, runArgs(c, ['--flag', '--alive-marker', '--flag', '--hold', '--flag', '6']), c.env, { leadMs: 3500 });
  const admitted = results.filter((r) => r.code === 0);
  const busy = results.filter((r) => r.code === 3);
  assert.equal(admitted.length, 1, `expected exactly one admitted: ${JSON.stringify(results.map((r) => [r.code, r.stdout.split('\n')[0]]))}`);
  assert.equal(busy.length, 1);

  const [r1, r2] = await Promise.all([w1.done, w2.done]);
  for (const r of [r1, r2]) assert.equal(r.code, 0, `a notifier did not see the lane free: ${r.stdout}${r.stderr}`);
  await orch(['cancel', idFrom(admitted[0].stdout), '--json'], c.env);
});

test('G6: wait-lane has a DEFAULT deadline even with no --timeout (codex M1)', { timeout: 120000 }, async (t) => {
  const c = makeCase('g6-default');
  t.after(() => c.cleanup());
  const holder = await orch(runArgs(c, ['--flag', '--hold', '--flag', '25']), c.env);
  const holderId = idFrom(holder.stdout);
  await waitFor(() => keeperLines(c.stateRoot, holderId).some((l) => l.event === 'spawned'), { timeoutMs: 20000, what: 'spawn' });
  const t0 = Date.now();
  // The default is 300 s in production; the env knob exists so the DEFAULT PATH (no
  // --timeout argument at all) can be exercised without a five-minute test.
  const r = await orch(['wait-lane', '--json'], { ...c.env, ORCH_WAIT_LANE_DEFAULT_S: '2' });
  const ms = Date.now() - t0;
  assert.equal(r.code, 3, `wait-lane with no --timeout must still terminate: ${r.stdout}`);
  assert.ok(ms < 12000, `the default deadline was not applied (${ms}ms)`);
  assert.equal(JSON.parse(r.stdout).timed_out, true);
  await orch(['cancel', holderId, '--json'], c.env);
});
