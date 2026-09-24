// G4 (keeper death, suspended keeper) and G8 (spawn-failure paths).
//
// Every kill here is identity-checked against the pid AND OS creation time that
// `orch run` itself recorded in `spawned.json` (amendment A2), taken immediately
// before the kill. Nothing is ever killed by image name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeCase,
  orch,
  idFrom,
  waitFor,
  keeperLines,
  readRunRecord,
  killOwnedChecked,
  identityOf,
  spawnedIdentity,
  suspendProcess,
  resumeProcess, testReps } from './helpers.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectHello, probeFree } from '../src/lanepipe.mjs';

const KEEPER_SRC = path.resolve(fileURLToPath(new URL('../src/keeper.mjs', import.meta.url)));

const KEEPER_REPS = testReps(20, 'ORCH_G4_REPS');

function runArgs(c, extra = []) {
  return [
    'run',
    '--cli',
    'fake',
    '--dir',
    c.work,
    '--handoff',
    c.handoffPath,
    '--lane',
    'local',
    '--no-window',
    '--no-monitor',
    ...extra,
  ];
}

async function launchHeld(c, holdSeconds = 25) {
  const r = await orch(runArgs(c, ['--flag', '--alive-marker', '--flag', '--hold', '--flag', String(holdSeconds)]), c.env);
  assert.equal(r.code, 0, `run was not admitted:\n${r.stdout}${r.stderr}`);
  const id = idFrom(r.stdout);
  const spawned = await waitFor(() => spawnedIdentity(c.stateRoot, id), { timeoutMs: 20000, what: 'spawned.json' });
  const worker = await waitFor(
    () => {
      const line = keeperLines(c.stateRoot, id).find((l) => l.event === 'spawned');
      return line ? line.worker_pid : null;
    },
    { timeoutMs: 20000, what: 'the keeper to record the worker pid' },
  );
  return { id, spawned, workerPid: worker };
}

test(`G4/TC: keeper killed mid-run, ${KEEPER_REPS}x -> worker reaped, pipe re-bindable, status says why`, { timeout: 25 * 60 * 1000 }, async (t) => {
  const c = makeCase('g4-keeperdeath');
  t.after(() => c.cleanup());

  const dist = { rebindMs: [], workerGoneAt2s: 0, workerGoneAt10s: 0, reps: 0, refusedKills: 0 };

  for (let rep = 0; rep < KEEPER_REPS; rep++) {
    const { id, spawned, workerPid } = await launchHeld(c, 30);
    assert.match(String(spawned.keeper_created_at), /^ms:\d+$/, 'the spawner must have captured the keeper identity');

    // The worker's OS creation time must be knowable WITHOUT a monitor (A2 / agy H4).
    const workerCreatedAt = await waitFor(
      () => {
        const l = keeperLines(c.stateRoot, id).find((x) => x.event === 'worker-identity');
        return l ? l.worker_created_at : null;
      },
      { timeoutMs: 20000, what: 'the keeper to record the worker OS creation time' },
    );

    // Identity-checked kill of ONLY the keeper: /F, never /T, never by image name.
    const kill = await killOwnedChecked(spawned.keeper_pid, spawned.keeper_created_at);
    if (kill.verdict !== 'match') {
      dist.refusedKills++;
      assert.fail(`rep ${rep}: the identity-checked kill was refused: ${kill.output}`);
    }

    const t0 = Date.now();
    // agy g10: the pipe is sampled from the moment of the kill (every 50 ms), in parallel
    // with the t+2 s / t+10 s identity checks - not only after t+10 s, as the first
    // version did while its log line claimed otherwise.
    /** @type {number|null} */
    let freeAtMs = null;
    const pipeSampler = (async () => {
      while (freeAtMs === null && Date.now() - t0 < 15000) {
        if ((await probeFree(c.lanePipe)).free) freeAtMs = Date.now() - t0;
        else await new Promise((r) => setTimeout(r, 50));
      }
    })();
    await new Promise((r) => setTimeout(r, 2000));
    const at2 = await identityOf(workerPid, workerCreatedAt);
    if (at2 === 'gone' || at2 === 'mismatch') dist.workerGoneAt2s++;
    await new Promise((r) => setTimeout(r, 8000));
    const at10 = await identityOf(workerPid, workerCreatedAt);
    if (at10 === 'gone' || at10 === 'mismatch') dist.workerGoneAt10s++;
    assert.ok(at10 === 'gone' || at10 === 'mismatch', `rep ${rep}: the MAIN worker survived the keeper at t+10s (${at10})`);

    // The pipe must have become bindable, and quickly (X3 D/E and K3 measured ~0.2 s).
    await pipeSampler;
    assert.ok(freeAtMs !== null, `rep ${rep}: the lane pipe never became bindable within 15 s of the keeper kill`);
    assert.ok(Number(freeAtMs) < 5000, `rep ${rep}: the pipe took ${freeAtMs} ms to free after the keeper kill`);
    dist.rebindMs.push(Number(freeAtMs));

    // N4: status must say WHY, read-only, without a monitor.
    const st = await orch(['status', id, '--json'], c.env);
    const row = JSON.parse(st.stdout).runs[0];
    assert.match(row.derived_status, /interrupted/, `rep ${rep}: status did not explain the keeper death: ${st.stdout}`);
    assert.equal(row.derived_reason, 'keeper-gone-without-exit');
    assert.equal(row.lane_probe, 'free');
    assert.equal(st.code, 0, 'status must always exit 0');
    dist.reps++;
  }

  console.log(`G4 distribution over ${dist.reps} reps:`);
  console.log(`  MAIN worker gone at t+2s: ${dist.workerGoneAt2s}/${dist.reps}; at t+10s: ${dist.workerGoneAt10s}/${dist.reps}`);
  console.log(`  pipe re-bindable after: min=${Math.min(...dist.rebindMs)}ms max=${Math.max(...dist.rebindMs)}ms (probed every 50 ms from the kill; granularity = one probe cycle)`);
  console.log(`  identity-checked kills refused: ${dist.refusedKills}`);
});

test('G4: a SUSPENDED keeper reports `held, unresponsive`, nothing is auto-released, and cancel --keeper clears it', { timeout: 180000 }, async (t) => {
  const c = makeCase('g4-frozen');
  let suspended = null;
  t.after(async () => {
    // Never leave a suspended process behind, whatever the assertions did.
    if (suspended) await resumeProcess(suspended.pid, suspended.createdAt);
    c.cleanup();
  });

  const { id, spawned, workerPid } = await launchHeld(c, 60);

  // A healthy keeper answers the hello (A5).
  const healthy = await connectHello(c.lanePipe, { deadlineMs: 2000 });
  assert.equal(healthy.state, 'held', `a healthy keeper did not answer: ${JSON.stringify(healthy)}`);
  assert.match(String(healthy.hello), new RegExp(id));

  const s = await suspendProcess(spawned.keeper_pid, spawned.keeper_created_at);
  assert.ok(s.ok, `could not suspend the keeper: ${s.output}`);
  suspended = { pid: spawned.keeper_pid, createdAt: spawned.keeper_created_at };

  // X5: connect still succeeds; only the reply is missing. That is the third state.
  const frozen = await connectHello(c.lanePipe, { deadlineMs: 2000 });
  assert.equal(frozen.state, 'held-unresponsive', `a suspended keeper was not classified as unresponsive: ${JSON.stringify(frozen)}`);

  const st = await orch(['status', id, '--json'], c.env);
  const row = JSON.parse(st.stdout).runs[0];
  assert.match(row.lane_state, /held, unresponsive/, `status did not say "held, unresponsive": ${row.lane_state}`);
  assert.equal(st.code, 0);

  // NOTHING is auto-released: the lane is still held and the worker is still alive.
  const stillHeld = await probeFree(c.lanePipe);
  assert.equal(stillHeld.free, false, 'a frozen keeper must keep holding the lane - nothing releases it automatically');
  const before = await orch(runArgs(c), c.env);
  assert.equal(before.code, 3, 'a frozen holder must still refuse a new run');

  // The ONLY clearing path, and it reports truthfully.
  const cancel = await orch(['cancel', '--keeper', id, '--json'], c.env);
  suspended = null; // the keeper is dead; there is nothing left to resume
  const out = JSON.parse(cancel.stdout);
  assert.equal(out.kill_verdict, 'match', 'cancel --keeper must identity-check before killing');
  assert.ok(['gone', 'mismatch'].includes(out.keeper_identity_after), `keeper was not confirmed gone: ${cancel.stdout}`);
  assert.ok(['gone', 'mismatch'].includes(out.worker_identity_after), `agy M1: exit must not be claimed while the worker lives: ${cancel.stdout}`);
  assert.equal(out.lane_state_after, 'free');
  assert.equal(out.cancel_state, 'keeper-cleared');
  assert.equal(cancel.code, 0);

  // And the lane really is usable again.
  const after = await orch(runArgs(c), c.env);
  assert.equal(after.code, 0, `the lane was not usable after cancel --keeper:\n${after.stdout}${after.stderr}`);
  assert.equal(await identityOf(workerPid, null) === 'match', false);
});

test('A5: the hello reply arrives on Windows, 20 consecutive connections', { timeout: 180000 }, async (t) => {
  const c = makeCase('a5-hello');
  t.after(() => c.cleanup());
  const { id } = await launchHeld(c, 30);
  const results = [];
  for (let i = 0; i < 20; i++) results.push(await connectHello(c.lanePipe, { deadlineMs: 2000 }));
  const held = results.filter((r) => r.state === 'held' && String(r.hello).includes(id));
  console.log(`A5: ${held.length}/20 connections received a complete hello; latencies ${results.map((r) => r.ms).join(',')}ms`);
  assert.equal(held.length, 20, `agy H2: a write+destroy would lose the payload. Got: ${JSON.stringify(results)}`);
  // ...and the keeper survived being probed 20 times.
  const lines = keeperLines(c.stateRoot, id);
  assert.ok(!lines.some((l) => l.event === 'keeper-exception'), 'probing must not raise anything inside the keeper');
  assert.ok(!lines.some((l) => l.event === 'worker-exit'), 'the worker must still be running');
});

/* ------------------------------------------------------------ G8 --------- */

test('G8: a MISSING exe is a safe pre-worker failure - lane released, clear status', { timeout: 120000 }, async (t) => {
  const c = makeCase('g8-missing');
  t.after(() => c.cleanup());
  const env = { ...c.env, ORCH_FAKE_EXE: path.join(c.base, 'no-such-binary.exe') };
  const r = await orch(runArgs(c), env);
  assert.notEqual(r.code, 0, `a missing exe must not be reported as an admitted run:\n${r.stdout}`);
  assert.match(r.stdout + r.stderr, /spawn-failed/);
  const id = (fs.readdirSync(path.join(c.stateRoot, 'runs')) || []).sort().pop();
  const lines = keeperLines(c.stateRoot, id);
  const blocked = lines.find((l) => l.blocked);
  assert.ok(blocked, `no blocked line was written: ${JSON.stringify(lines)}`);
  assert.match(blocked.blocked, /^spawn-failed-/);
  assert.ok(!lines.some((l) => l.event === 'spawned'), 'no worker may exist after a pre-worker failure');
  // The lane must be free again: a failure before the worker releases everything.
  const free = await waitFor(async () => {
    const p = await probeFree(c.lanePipe);
    return p.free ? p : null;
  }, { timeoutMs: 15000, what: 'the lane to be released after a spawn failure' });
  assert.ok(free.free);
  const next = await orch(runArgs(c), c.env);
  assert.equal(next.code, 0, 'the lane must be usable after a spawn failure');
});

test('G8: a SYNCHRONOUS spawn throw is a safe pre-worker failure', { timeout: 120000 }, async (t) => {
  // A NUL byte in an argv element makes Node's own validation throw synchronously from
  // spawn(). It cannot travel through a Windows environment variable or command line,
  // so the keeper is driven DIRECTLY with a crafted record - which is also the most
  // precise way to test Phase B's very first statement.
  const c = makeCase('g8-throw');
  t.after(() => c.cleanup());
  const r = await runKeeperDirect(c, 'syncthrow', (launch) => {
    launch.args = ['--ok', 'bad' + String.fromCharCode(0) + 'arg'];
  });
  assert.notEqual(r.code, 0, `the keeper must not exit 0 after a synchronous spawn throw: ${JSON.stringify(r.admission)}`);
  assert.equal(r.admission.admission, 'blocked', `the caller must be told: ${JSON.stringify(r.admission)}`);
  assert.match(String(r.admission.reason), /^spawn-failed-/);
  const blocked = r.lines.find((l) => l.blocked);
  assert.ok(blocked, 'a synchronous throw must still produce a blocked line');
  assert.match(blocked.blocked, /^spawn-failed-/);
  assert.ok(!r.lines.some((l) => l.event === 'spawned'), 'no worker may exist after a synchronous throw');
  assert.ok(r.lines.some((l) => l.event === 'keeper-exit'), 'the keeper must still close its own trail');
  assert.ok((await probeFree(r.pipe)).free, 'the lane must be released after a synchronous spawn throw');
});

test('G8: an async error event with no prior spawn event is treated exactly like a throw', { timeout: 120000 }, async (t) => {
  const c = makeCase('g8-errorevent');
  t.after(() => c.cleanup());
  const r = await runKeeperDirect(c, 'errorevent', (launch) => {
    launch.exe = path.join(c.base, 'definitely-absent.exe');
  });
  assert.notEqual(r.code, 0);
  assert.equal(r.admission.admission, 'blocked', JSON.stringify(r.admission));
  assert.match(String(r.admission.reason), /^spawn-failed-/);
  assert.ok(!r.lines.some((l) => l.event === 'spawned'));
  assert.ok((await probeFree(r.pipe)).free, 'the lane must be released');
});

/**
 * Run `src/keeper.mjs` directly against a hand-written record, on a pipe of its own.
 * Returns the keeper's exit code, its admission line and its whole trail.
 */
async function runKeeperDirect(c, label, mutate) {
  const runDir = path.join(c.stateRoot, 'runs', `direct-${label}`);
  fs.mkdirSync(runDir, { recursive: true });
  const pipe = `\\\\.\\pipe\\orch-lane-${c.laneId}-d${label}`;
  fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'x');
  fs.writeFileSync(path.join(runDir, 'stdout.log'), '');
  fs.writeFileSync(path.join(runDir, 'stderr.log'), '');
  const launch = {
    exe: process.execPath,
    args: ['-e', 'setTimeout(()=>{},50)'],
    cwd: c.work,
    env_set: { PWD: c.work },
    env_delete: [],
    prompt: path.join(runDir, 'prompt.txt'),
    stdout: path.join(runDir, 'stdout.log'),
    stderr: path.join(runDir, 'stderr.log'),
    pipe_name: pipe,
    lane_holder: path.join(runDir, 'lane-holder.json'),
    lane_id: c.laneId,
    lane: 'local',
  };
  mutate(launch);
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ id: `direct-${label}`, launch }, null, 2));

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [KEEPER_SRC, '--state-root', c.stateRoot, '--id', `direct-${label}`, '--run-dir', runDir], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => {
      let admission = {};
      for (const line of out.split(/\r?\n/)) {
        if (line.startsWith('{')) {
          try {
            admission = JSON.parse(line);
          } catch {
            /* keep looking */
          }
        }
      }
      let lines = [];
      try {
        lines = fs
          .readFileSync(path.join(runDir, 'keeper.ndjson'), 'utf8')
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l));
      } catch {
        /* no trail at all is itself a failure the assertions will catch */
      }
      resolve({ code, admission, lines, pipe, runDir });
    });
  });
}

test('G8: a non-.exe entrypoint is REFUSED before anything is spawned (X1 cmdwrap)', { timeout: 120000 }, async (t) => {
  const c = makeCase('g8-cmd');
  t.after(() => c.cleanup());
  const shim = path.join(c.base, 'worker.cmd');
  fs.writeFileSync(shim, '@echo off\r\necho hello\r\n');
  const r = await orch(runArgs(c), { ...c.env, ORCH_FAKE_EXE: shim });
  assert.notEqual(r.code, 0);
  const id = fs.readdirSync(path.join(c.stateRoot, 'runs')).sort().pop();
  const blocked = keeperLines(c.stateRoot, id).find((l) => l.blocked);
  assert.equal(blocked.blocked, 'no-exe-entrypoint');
  // cmd.exe itself is refused by name for the same reason.
  const r2 = await orch(runArgs(c), { ...c.env, ORCH_FAKE_EXE: 'C:\\Windows\\System32\\cmd.exe' });
  assert.notEqual(r2.code, 0);
  const id2 = fs.readdirSync(path.join(c.stateRoot, 'runs')).sort().pop();
  assert.equal(keeperLines(c.stateRoot, id2).find((l) => l.blocked).blocked, 'no-exe-entrypoint');
});

test('agy M2: a worker that exits INSTANTLY is still reaped and recorded (no lost exit event)', { timeout: 120000 }, async (t) => {
  const c = makeCase('instant-exit');
  t.after(() => c.cleanup());
  for (let i = 0; i < 5; i++) {
    const r = await orch(runArgs(c, ['--flag', '--no-stdin', '--flag', '--exit', '--flag', '3']), c.env);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const id = idFrom(r.stdout);
    const exit = await waitFor(
      () => keeperLines(c.stateRoot, id).find((l) => l.event === 'worker-exit') || null,
      { timeoutMs: 20000, what: 'the worker-exit line for an instantly-exiting worker' },
    );
    assert.equal(exit.code, 3);
    await waitFor(() => keeperLines(c.stateRoot, id).some((l) => l.event === 'keeper-exit'), {
      timeoutMs: 20000,
      what: 'the keeper to exit (it must not deadlock awaiting an exit it already missed)',
    });
    const free = await waitFor(async () => (await probeFree(c.lanePipe)).free, { timeoutMs: 15000, what: 'lane free' });
    assert.ok(free);
  }
});

test('codex M3 / agy L1: a Phase-A keeper death still yields a bounded, visible reason', { timeout: 120000 }, async (t) => {
  const c = makeCase('phasea');
  t.after(() => c.cleanup());
  // A record the keeper cannot use: the exe entry is missing entirely.
  const r = await orch(runArgs(c), { ...c.env, ORCH_FAKE_EXE: path.join(c.base, 'gone.exe') });
  const id = fs.readdirSync(path.join(c.stateRoot, 'runs')).sort().pop();
  assert.notEqual(r.code, 0);
  const st = await orch(['status', id, '--json'], c.env);
  const row = JSON.parse(st.stdout).runs[0];
  assert.equal(st.code, 0);
  assert.ok(row.keeper_blocked, 'status must name the Phase-A reason');
  assert.match(row.derived_status, /blocked/);
  // agy L1: the keeper pid was recorded by `orch run`, so the run is never a mystery.
  assert.equal(typeof row.keeper_pid, 'number');
  const rec = readRunRecord(c.stateRoot, id);
  assert.equal(rec.status, 'blocked');
});
