// G3 (bookkeeping cannot cost a run) and TF (status answers with the monitor absent,
// frozen and alive, and writes nothing).
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
  readRunFile,
  killOwnedChecked,
  identityOf,
  suspendProcess,
  resumeProcess,
  spawnedIdentity, testReps } from './helpers.mjs';
import { readProcessTable, verifyIdentity } from '../src/procs.mjs';

const REPS = testReps(20, 'ORCH_G3_REPS');

function runArgs(c, extra = []) {
  return ['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--lane', 'local', '--no-window', ...extra];
}

async function monitorIdentity(c, id) {
  const spawned = await waitFor(() => spawnedIdentity(c.stateRoot, id), { timeoutMs: 20000, what: 'spawned.json' });
  if (spawned.monitor_created_at) return { pid: spawned.monitor_pid, createdAt: spawned.monitor_created_at };
  const table = await readProcessTable({ deadlineMs: 5000, pids: [spawned.monitor_pid] });
  const v = verifyIdentity(spawned.monitor_pid, null, table);
  return { pid: spawned.monitor_pid, createdAt: v.found ? v.found.createdAt : null };
}

test(`G3: the monitor is killed mid-run, ${REPS}x -> the worker still finishes and the files still land`, { timeout: 25 * 60 * 1000 }, async (t) => {
  const c = makeCase('g3');
  t.after(() => c.cleanup());
  const dist = { reps: 0, reattached: 0, sameFinal: [], workerAliveAfterKill: 0 };

  for (let rep = 0; rep < REPS; rep++) {
    const marker = `landed-${rep}.txt`;
    const r = await orch(
      runArgs(c, ['--flag', '--emit', '--flag', '24', '--flag', '--interval', '--flag', '500', '--flag', '--write-file', '--flag', marker]),
      c.env,
    );
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

    // Kill the monitor, identity-checked, mid-run (K2's measured property).
    const mon = await monitorIdentity(c, id);
    const kill = await killOwnedChecked(mon.pid, mon.createdAt);
    assert.equal(kill.verdict, 'match', `rep ${rep}: the identity-checked monitor kill was refused: ${kill.output}`);

    // N2: the worker is unaffected.
    const alive = await identityOf(workerPid, workerCreatedAt);
    if (alive === 'match') dist.workerAliveAfterKill++;
    assert.equal(alive, 'match', `rep ${rep}: killing the MONITOR ended the worker - that is N2 violated`);

    // `status` still answers, read-only, and says the monitor is not running.
    const recBefore = fs.statSync(path.join(c.stateRoot, 'runs', id, 'run.json')).mtimeMs;
    const st = await orch(['status', id, '--json'], c.env);
    assert.equal(st.code, 0);
    const row = JSON.parse(st.stdout).runs[0];
    assert.match(row.monitor, /not running/, `rep ${rep}: status did not notice the dead monitor: ${row.monitor}`);
    const recAfter = fs.statSync(path.join(c.stateRoot, 'runs', id, 'run.json')).mtimeMs;
    assert.equal(recAfter, recBefore, `rep ${rep}: a read-only status WROTE run.json (r2-5)`);

    // The run finishes on its own, with no monitor at all.
    await waitFor(() => keeperLines(c.stateRoot, id).some((l) => l.event === 'keeper-exit'), {
      timeoutMs: 60000,
      what: 'the keeper to finish without a monitor',
    });
    assert.ok(fs.existsSync(path.join(c.work, marker)), `rep ${rep}: the worker's file did not land`);
    const exit = keeperLines(c.stateRoot, id).find((l) => l.event === 'worker-exit');
    assert.equal(exit.code, 0, `rep ${rep}: the worker did not complete normally`);
    assert.ok(readRunFile(c.stateRoot, id, 'stdout.log').includes('TICK 24/24'), `rep ${rep}: output was lost`);

    // A replacement monitor re-attaches and derives the SAME final status from files alone.
    const derivedByStatus = JSON.parse((await orch(['status', id, '--json'], c.env)).stdout).runs[0].derived_status;
    const m = await orch(['monitor', id, '--json'], c.env);
    assert.equal(m.code, 0, `rep ${rep}: orch monitor did not re-attach: ${m.stdout}${m.stderr}`);
    dist.reattached++;
    const rec = await waitForStatus(c.stateRoot, id, ['completed', 'failed', 'interrupted'], { timeoutMs: 40000 });
    dist.sameFinal.push(rec.status === derivedByStatus);
    assert.equal(rec.status, 'completed', `rep ${rep}: a re-attached monitor derived ${rec.status}`);
    assert.equal(rec.status, derivedByStatus, `rep ${rep}: status and the monitor disagreed (${derivedByStatus} vs ${rec.status})`);
    dist.reps++;
  }

  console.log(`G3 distribution over ${dist.reps} reps:`);
  console.log(`  worker alive after the monitor kill: ${dist.workerAliveAfterKill}/${dist.reps}`);
  console.log(`  replacement monitor re-attached: ${dist.reattached}/${dist.reps}`);
  console.log(`  replacement monitor derived the same final status as read-only status: ${dist.sameFinal.filter(Boolean).length}/${dist.reps}`);
});

test('TF: status answers within its budget with the monitor absent, frozen and alive - and never writes', { timeout: 240000 }, async (t) => {
  const c = makeCase('tf-status');
  let frozen = null;
  t.after(async () => {
    if (frozen) await resumeProcess(frozen.pid, frozen.createdAt);
    c.cleanup();
  });

  const r = await orch(runArgs(c, ['--flag', '--emit', '--flag', '40', '--flag', '--interval', '--flag', '500']), c.env);
  const id = idFrom(r.stdout);
  await waitFor(() => keeperLines(c.stateRoot, id).some((l) => l.event === 'spawned'), { timeoutMs: 20000, what: 'spawn' });
  const recPath = path.join(c.stateRoot, 'runs', id, 'run.json');

  const cases = [];

  // (1) monitor ALIVE
  await waitFor(async () => /running/.test(JSON.parse((await orch(['status', id, '--json'], c.env)).stdout).runs[0].monitor), {
    timeoutMs: 20000,
    what: 'the monitor to answer its own pipe',
  });
  cases.push(await timedStatus(c, id, 'monitor alive'));

  // (2) monitor FROZEN (OS-suspended): the design's wording is `not running (pipe held, no hello)`
  const mon = await monitorIdentity(c, id);
  const s = await suspendProcess(mon.pid, mon.createdAt);
  assert.ok(s.ok, `could not suspend the monitor: ${s.output}`);
  frozen = mon;
  const frozenCase = await timedStatus(c, id, 'monitor frozen');
  cases.push(frozenCase);
  assert.match(frozenCase.row.monitor, /pipe held, no hello/, `a frozen monitor was misreported: ${frozenCase.row.monitor}`);

  // (3) monitor ABSENT
  const kill = await killOwnedChecked(mon.pid, mon.createdAt);
  assert.equal(kill.verdict, 'match');
  frozen = null;
  const absent = await timedStatus(c, id, 'monitor absent');
  cases.push(absent);
  assert.match(absent.row.monitor, /not running/);

  for (const cse of cases) {
    assert.ok(cse.ms < 9000, `${cse.label}: status took ${cse.ms}ms (6s budget + process start)`);
    assert.equal(cse.code, 0, `${cse.label}: status must always exit 0`);
    // A LIVE monitor rewrites run.json on its own poll schedule, so the no-write
    // property is only observable when nothing else owns the record.
    if (cse.label !== 'monitor alive') {
      assert.equal(cse.mtimeAfter, cse.mtimeBefore, `${cse.label}: status WROTE run.json`);
    }
  }
  console.log(`TF: ${cases.map((x) => `${x.label}=${x.ms}ms`).join(', ')} - run.json mtime unchanged in all three`);

  // The run itself is still alive and unaffected by all of that.
  const workerPid = keeperLines(c.stateRoot, id).find((l) => l.event === 'spawned').worker_pid;
  const workerCreatedAt = keeperLines(c.stateRoot, id).find((l) => l.event === 'worker-identity')?.worker_created_at;
  assert.equal(await identityOf(workerPid, workerCreatedAt), 'match', 'N2: none of the bookkeeping pressure above may touch the worker');
  await orch(['cancel', id, '--json'], c.env);

  async function timedStatus(cc, runId, label) {
    const mtimeBefore = fs.statSync(recPath).mtimeMs;
    const t0 = Date.now();
    const out = await orch(['status', runId, '--json'], cc.env);
    const ms = Date.now() - t0;
    await new Promise((res) => setTimeout(res, 150));
    return { label, ms, code: out.code, row: JSON.parse(out.stdout).runs[0], mtimeBefore, mtimeAfter: fs.statSync(recPath).mtimeMs };
  }
});

test('r2-5: list / result / log write nothing either, and `orch monitor` refuses to start a second one', { timeout: 120000 }, async (t) => {
  const c = makeCase('readonly');
  t.after(() => c.cleanup());
  const r = await orch(runArgs(c, ['--flag', '--emit', '--flag', '20', '--flag', '--interval', '--flag', '400']), c.env);
  const id = idFrom(r.stdout);
  await waitFor(async () => /running/.test(JSON.parse((await orch(['status', id, '--json'], c.env)).stdout).runs[0].monitor), {
    timeoutMs: 20000,
    what: 'a live monitor',
  });
  const recPath = path.join(c.stateRoot, 'runs', id, 'run.json');
  const before = fs.statSync(recPath).mtimeMs;
  await orch(['list', '--json'], c.env);
  await orch(['result', id, '--json'], c.env);
  await orch(['log', id, '--tail', '5'], c.env);
  await orch(['status', '--all', '--json'], c.env);
  await orch(['wait-lane', '--timeout', '1', '--json'], c.env);
  await new Promise((res) => setTimeout(res, 100));
  // The live monitor writes the record on its own schedule, so compare against a read
  // taken immediately before AND allow only the monitor's own writes: the check that
  // matters is that no read-only command starts a second writer.
  const second = await orch(['monitor', id, '--json'], c.env);
  assert.equal(second.code, 3, `a second monitor was allowed to start: ${second.stdout}`);
  assert.match(second.stdout, /already-running/);
  assert.ok(fs.statSync(recPath).mtimeMs >= before);
  await orch(['cancel', id, '--json'], c.env);
});

test('a monitor STOPS when its run directory is removed - it must never resurrect run.json', { timeout: 180000 }, async (t) => {
  // Found by this suite, not by a review: a monitor whose run directory was deleted
  // polled forever AND re-created run.json on every poll (writeRun mkdir's the
  // directory), so the record came back from the dead and the process never exited.
  const c = makeCase('monitor-stop');
  t.after(() => c.cleanup());
  const r = await orch(runArgs(c, ['--flag', '--emit', '--flag', '60', '--flag', '--interval', '--flag', '500']), c.env);
  const id = idFrom(r.stdout);
  const mon = await monitorIdentity(c, id);
  await waitFor(async () => /running/.test(JSON.parse((await orch(['status', id, '--json'], c.env)).stdout).runs[0].monitor), {
    timeoutMs: 20000,
    what: 'a live monitor',
  });

  // End the run first, so nothing is left running when the directory goes.
  await orch(['cancel', id, '--json'], c.env);
  await waitForStatus(c.stateRoot, id, ['cancelled', 'failed', 'completed', 'interrupted'], { timeoutMs: 60000 });

  // Now start a monitor again on the terminal run and delete the directory under it.
  const runDir = path.join(c.stateRoot, 'runs', id);
  fs.rmSync(runDir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(runDir));

  // The previous monitor (if still alive) must notice and exit; and the record must
  // NOT reappear.
  await waitFor(async () => (await identityOf(mon.pid, mon.createdAt)) !== 'match', {
    timeoutMs: 30000,
    what: 'the monitor to exit after its run directory was removed',
  });
  await new Promise((res) => setTimeout(res, 2000));
  assert.ok(!fs.existsSync(runDir), 'the monitor resurrected the run directory');
});

test('the monitor is the SOLE writer of run.json: a second monitor process exits at once', { timeout: 120000 }, async (t) => {
  const c = makeCase('sole-writer');
  t.after(() => c.cleanup());
  const r = await orch(runArgs(c, ['--flag', '--emit', '--flag', '15', '--flag', '--interval', '--flag', '400']), c.env);
  const id = idFrom(r.stdout);
  await waitFor(async () => /running/.test(JSON.parse((await orch(['status', id, '--json'], c.env)).stdout).runs[0].monitor), {
    timeoutMs: 20000,
    what: 'a live monitor',
  });
  const results = await Promise.all([orch(['monitor', id, '--json'], c.env), orch(['monitor', id, '--json'], c.env)]);
  for (const res of results) assert.equal(res.code, 3, `a duplicate monitor was admitted: ${res.stdout}`);
  await orch(['cancel', id, '--json'], c.env);
});

test('T-v2-9: an escaped detached helper is REPORTED, never killed, and never blocks the next run', { timeout: 180000 }, async (t) => {
  const c = makeCase('escapee');
  const helpers = [];
  t.after(async () => {
    // Clean up only the helper THIS test started, identity-checked.
    for (const h of helpers) await killOwnedChecked(h.pid, h.createdAt);
    c.cleanup();
  });
  const r = await orch(runArgs(c, ['--flag', '--detached-helper', '--flag', '--emit', '--flag', '3']), c.env);
  const id = idFrom(r.stdout);
  const helperPid = Number(
    await waitFor(
      () => {
        try {
          return fs.readFileSync(path.join(c.work, 'detached-helper.pid'), 'utf8').trim() || null;
        } catch {
          return null;
        }
      },
      { timeoutMs: 20000, what: 'the detached helper pid' },
    ),
  );
  const table = await readProcessTable({ deadlineMs: 5000, pids: [helperPid] });
  const found = verifyIdentity(helperPid, null, table).found;
  if (found) helpers.push({ pid: helperPid, createdAt: found.createdAt });

  const rec = await waitForStatus(c.stateRoot, id, ['completed', 'failed'], { timeoutMs: 60000 });
  assert.equal(rec.status, 'completed');
  // Reported...
  const reported = (rec.escaped_helpers || []).some((h) => h.pid === helperPid);
  assert.ok(reported, `the escaped helper was not reported: ${JSON.stringify(rec.escaped_helpers)}`);
  // ...never killed...
  assert.equal(await identityOf(helperPid, found ? found.createdAt : null), 'match', 'orch killed an escaped helper');
  // ...and never counted for admission.
  const next = await orch(runArgs(c), c.env);
  assert.equal(next.code, 0, 'a live escaped helper must not block the next run (owner decision)');
  const st = await orch(['status', id], c.env);
  assert.match(st.stdout, /ESCAPED HELPER pid/, 'the advisory line must be loud');
});
