// N permits on the serial local lane: `lanes.local.permits`.
//
// Each permit is its own exclusive pipe, so the one-run-per-permit guarantee is the same
// OS-level bind as before. Runs here are separate OS processes with real keepers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCase, orch, idFrom, waitFor, aliveMarkers, readRunRecord } from './helpers.mjs';
import { laneOccupancy } from '../src/commands.mjs';
import { loadConfig } from '../src/config.mjs';

function runArgs(c, holdSeconds = 90) {
  return ['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--lane', 'local', '--no-window', '--no-monitor',
    '--flag', '--alive-marker', '--flag', '--hold', '--flag', String(holdSeconds)];
}

async function occupancy(c) {
  const before = process.env.ORCH_LANE_ID;
  process.env.ORCH_LANE_ID = c.laneId;
  try {
    return await laneOccupancy(loadConfig(c.stateRoot), 'local');
  } finally {
    if (before === undefined) delete process.env.ORCH_LANE_ID; else process.env.ORCH_LANE_ID = before;
  }
}

test('permits: two runs are admitted at once, the third is lane-busy, a cancel frees a permit', { timeout: 6 * 60 * 1000 }, async (t) => {
  const c = makeCase('permits', { config: { lanes: { local: { permits: 2 } } } });
  t.after(() => c.cleanup());

  const a = await orch(runArgs(c), c.env);
  assert.equal(a.code, 0, a.stdout + a.stderr);
  const b = await orch(runArgs(c), c.env);
  assert.equal(b.code, 0, `the second run must be admitted into the second permit:\n${b.stdout}${b.stderr}`);
  const idA = idFrom(a.stdout), idB = idFrom(b.stdout);
  await waitFor(() => aliveMarkers(c.work).length === 2, { what: 'two workers alive at once', timeoutMs: 60000 });

  // Each run took its own permit; permit 0 keeps the historical record shape.
  assert.equal(readRunRecord(c.stateRoot, idA).lane_permit, undefined);
  assert.equal(readRunRecord(c.stateRoot, idB).lane_permit, 1);
  assert.notEqual(readRunRecord(c.stateRoot, idA).lane_pipe, readRunRecord(c.stateRoot, idB).lane_pipe);

  const busy = await orch(runArgs(c), c.env);
  assert.equal(busy.code, 3, busy.stdout + busy.stderr);
  assert.match(busy.stdout, /lane-busy/);
  assert.match(busy.stdout, /all 2 permits/);
  assert.equal(aliveMarkers(c.work).length, 2, 'a refused run must not start a worker');

  const full = await occupancy(c);
  assert.equal(full.total, 2);
  assert.equal(full.used, 2);
  assert.deepEqual(full.permits.map((p) => p.holder_run).sort(), [idA, idB].sort());

  const waited = await orch(['wait-lane', '--lane', 'local', '--json', '--timeout', '2'], c.env);
  assert.equal(waited.code, 3, 'no permit is free');
  const waitedJson = JSON.parse(waited.stdout);
  assert.equal(waitedJson.permits, 2);
  assert.deepEqual(waitedJson.holder_runs.slice().sort(), [idA, idB].sort());

  // Cancelling one run frees exactly one permit; wait-lane then reports it free.
  const cancelled = await orch(['cancel', idB, '--json'], c.env);
  assert.equal(cancelled.code, 0, cancelled.stdout + cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).cancel_state, 'cancelled');
  const freed = await orch(['wait-lane', '--lane', 'local', '--json', '--timeout', '30'], c.env);
  assert.equal(freed.code, 0, freed.stdout + freed.stderr);
  const freedJson = JSON.parse(freed.stdout);
  assert.equal(freedJson.free_permits, 1);
  assert.equal(freedJson.permit, 1);
  const half = await occupancy(c);
  assert.equal(half.used, 1);
  assert.equal(half.free, 1);

  // The freed permit is reused, and the other run was never disturbed.
  const d = await orch(runArgs(c), c.env);
  assert.equal(d.code, 0, d.stdout + d.stderr);
  assert.equal(readRunRecord(c.stateRoot, idFrom(d.stdout)).lane_permit, 1);
  assert.equal(readRunRecord(c.stateRoot, idA).status === 'running' || readRunRecord(c.stateRoot, idA).status === 'queued', true);

  const gc = await orch(['gc', '--lane', 'local', '--json'], c.env);
  assert.equal(gc.code, 0, gc.stdout + gc.stderr);
  assert.equal(JSON.parse(gc.stdout).permits.length, 2);
});

test('permits: a status probe uses the permit the run holds', { timeout: 4 * 60 * 1000 }, async (t) => {
  const c = makeCase('permit-status', { config: { lanes: { local: { permits: 2 } } } });
  t.after(() => c.cleanup());
  const a = await orch(runArgs(c), c.env);
  const b = await orch(runArgs(c), c.env);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  await waitFor(() => aliveMarkers(c.work).length === 2, { what: 'both alive', timeoutMs: 60000 });
  const status = await orch(['status', idFrom(b.stdout), '--json'], c.env);
  assert.equal(status.code, 0, status.stdout + status.stderr);
  const run = JSON.parse(status.stdout).runs[0];
  assert.equal(run.derived_status, 'running');
  assert.equal(run.lane_state, 'lane held by this run', 'the probe must look at the permit this run holds, not permit 0');
});

test('permits: the default stays one run at a time, and an invalid count is refused', { timeout: 3 * 60 * 1000 }, async (t) => {
  const one = makeCase('permit-default');
  t.after(() => one.cleanup());
  assert.equal((await orch(runArgs(one), one.env)).code, 0);
  const second = await orch(runArgs(one), one.env);
  assert.equal(second.code, 3);
  assert.doesNotMatch(second.stdout, /permits/);

  for (const bad of [0, 1.5, 99, '2']) {
    const c = makeCase('permit-bad', { config: { lanes: { local: { permits: bad } } } });
    t.after(() => c.cleanup());
    const r = await orch(['gc', '--lane', 'local'], c.env);
    assert.notEqual(r.code, 0, `permits=${bad} must be refused`);
    assert.match(r.stdout + r.stderr, /permits must be a whole number/);
  }
});
