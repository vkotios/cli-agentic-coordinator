// G2 / TA / TB — lane admission under contention.
//
// Contention is ALWAYS between separate OS processes released at one absolute-epoch
// barrier (design R8): never same-process `Promise.all`. Every repetition is reported
// as a distribution, not as a yes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeCase, contend, orch, idFrom, waitFor, aliveMarkers, keeperLines, readRunRecord, testReps } from './helpers.mjs';

const REPS = testReps(20, 'ORCH_G2_REPS');
const N = Number(process.env.ORCH_G2_N || 4);

function runArgs(c, holdSeconds) {
  const a = [
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
    '--flag',
    '--alive-marker',
  ];
  if (holdSeconds) a.push('--flag', '--hold', '--flag', String(holdSeconds));
  return a;
}

function classify(results) {
  const admitted = results.filter((r) => r.code === 0 && /^job /m.test(r.stdout));
  const busy = results.filter((r) => r.code === 3 && /lane-busy/.test(r.stdout));
  const other = results.filter((r) => !admitted.includes(r) && !busy.includes(r));
  return { admitted, busy, other };
}

test(
  `G2/TA: ${N} simultaneous orch run x ${REPS} reps -> exactly one admitted, the rest lane-busy naming the holder`,
  { timeout: 20 * 60 * 1000 },
  async (t) => {
    const c = makeCase('g2');
    const sampling = { stop: false };
    t.after(() => {
      sampling.stop = true;
      c.cleanup();
    });

    const dist = { admitted: [], busy: [], other: [], maxConcurrentWorkers: 0, holderNamed: 0, holderStarting: 0, slowestMs: 0 };

    for (let rep = 0; rep < REPS; rep++) {
      // Sample the number of fake MAIN workers that declare themselves alive. Two must
      // never overlap (N1). The marker is written by the worker itself in its cwd, so
      // this proof needs no process-table read and no image-name lookup.
      // HANG FIX (found when this file kept its process alive for 25+ minutes after an
      // assertion failed): the sampler must stop on EVERY exit path, and its timer is
      // unref'd so it can never by itself hold the test process open.
      sampling.stop = false;
      const sampler = (async () => {
        while (!sampling.stop) {
          const n = aliveMarkers(c.work).length;
          if (n > dist.maxConcurrentWorkers) dist.maxConcurrentWorkers = n;
          await new Promise((r) => setTimeout(r, 40).unref());
        }
      })();
      try {

      const results = await contend(N, runArgs(c, 2), c.env);
      const { admitted, busy, other } = classify(results);

      assert.equal(admitted.length, 1, `rep ${rep}: expected exactly 1 admitted, got ${admitted.length}\n${JSON.stringify(results, null, 1)}`);
      assert.equal(busy.length, N - 1, `rep ${rep}: expected ${N - 1} lane-busy, got ${busy.length}\n${JSON.stringify(results.map((r) => r.stdout))}`);
      assert.equal(other.length, 0, `rep ${rep}: unexpected outcomes ${JSON.stringify(other)}`);

      const holderId = idFrom(admitted[0].stdout);
      for (const b of busy) {
        // A4: either the holder is named, or the refusal says the holder is starting -
        // and it never blocks.
        const named = b.stdout.includes(`held by run ${holderId}`);
        const starting = b.stdout.includes('unknown (holder starting)');
        assert.ok(named || starting, `rep ${rep}: refusal named neither holder nor "holder starting": ${b.stdout}`);
        if (named) dist.holderNamed++;
        else dist.holderStarting++;
        // TB: never a wait. The bind is one attempt.
        assert.ok(b.ms < 15000, `rep ${rep}: a refused caller took ${b.ms}ms - refusals must be immediate`);
      }
      for (const r of results) dist.slowestMs = Math.max(dist.slowestMs, r.ms);

      // The holder must finish and free the lane, and a NEW run must then be admitted.
      await waitFor(async () => {
        const w = await orch(['wait-lane', '--lane', 'local', '--timeout', '30', '--json'], c.env);
        return w.code === 0 ? w : null;
      }, { timeoutMs: 60000, what: 'the lane to free after the holder ended' });

      dist.admitted.push(admitted[0].ms);
      dist.busy.push(...busy.map((b) => b.ms));
      } finally {
        sampling.stop = true;
        await sampler;
      }

      const after = await orch(runArgs(c, 0), c.env);
      assert.equal(after.code, 0, `rep ${rep}: a new run was not admitted after the lane freed:\n${after.stdout}${after.stderr}`);
      const afterId = idFrom(after.stdout);
      await waitFor(
        () => keeperLines(c.stateRoot, afterId).some((l) => l.event === 'keeper-exit'),
        { timeoutMs: 30000, what: 'the follow-up run to finish' },
      );

    }

    // N1, sampled: two fake MAIN workers were never alive at the same instant.
    assert.ok(
      dist.maxConcurrentWorkers <= 1,
      `two MAIN workers were alive at once (max observed ${dist.maxConcurrentWorkers})`,
    );

    // Reported as a distribution, not a yes.
    const summarise = (a) => (a.length ? `n=${a.length} min=${Math.min(...a)} max=${Math.max(...a)} mean=${Math.round(a.reduce((x, y) => x + y, 0) / a.length)}` : 'n=0');
    console.log(`G2 distribution over ${REPS} reps of ${N} contenders:`);
    console.log(`  admitted ms   ${summarise(dist.admitted)}`);
    console.log(`  lane-busy ms  ${summarise(dist.busy)}`);
    console.log(`  refusals naming the holder: ${dist.holderNamed}; "holder starting": ${dist.holderStarting}`);
    console.log(`  max concurrent MAIN workers observed: ${dist.maxConcurrentWorkers}`);
  },
);

test('TA-20: twenty simultaneous orch run processes -> exactly one job id, 19 lane-busy', { timeout: 5 * 60 * 1000 }, async (t) => {
  const c = makeCase('ta20');
  t.after(() => c.cleanup());
  const results = await contend(20, runArgs(c, 3), c.env, { leadMs: 1500 });
  const { admitted, busy, other } = classify(results);
  assert.equal(admitted.length, 1, `expected 1 admitted, got ${admitted.length}: ${JSON.stringify(results.map((r) => [r.label, r.code, r.stdout.split('\n')[0]]))}`);
  assert.equal(busy.length, 19, `expected 19 lane-busy, got ${busy.length}`);
  assert.equal(other.length, 0);
  const holderId = idFrom(admitted[0].stdout);
  const named = busy.filter((b) => b.stdout.includes(`held by run ${holderId}`)).length;
  const starting = busy.filter((b) => b.stdout.includes('unknown (holder starting)')).length;
  assert.equal(named + starting, 19);
  console.log(`TA-20: 1 admitted, ${named} refusals naming the holder, ${starting} "holder starting"`);
  // Exactly one worker ever existed.
  assert.ok(aliveMarkers(c.work).length <= 1);
});

test('the lane is machine-wide: two DIFFERENT state roots sharing one lane id still exclude each other', { timeout: 120000 }, async (t) => {
  // Review r2-4: the lock used to live under the state root, so two state roots had
  // two lanes. The pipe name now comes from the lane identifier alone.
  const a = makeCase('crossroot-a');
  const b = makeCase('crossroot-b', { laneId: a.laneId });
  t.after(() => {
    a.cleanup();
    b.cleanup();
  });
  const first = await orch(runArgs(a, 4), a.env);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const second = await orch(runArgs(b, 0), b.env);
  assert.equal(second.code, 3, `a different state root was admitted into a held lane:\n${second.stdout}`);
  assert.match(second.stdout, /lane-busy/);
  await waitFor(async () => (await orch(['wait-lane', '--timeout', '30', '--json'], a.env)).code === 0, {
    timeoutMs: 60000,
    what: 'lane free',
  });
});

test('different lane ids are independent lanes with independent directories', { timeout: 120000 }, async (t) => {
  const a = makeCase('lane-indep-a');
  const b = makeCase('lane-indep-b');
  t.after(() => {
    a.cleanup();
    b.cleanup();
  });
  assert.notEqual(a.laneId, b.laneId);
  const first = await orch(runArgs(a, 3), a.env);
  const second = await orch(runArgs(b, 3), b.env);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(second.code, 0, `an independent lane refused admission:\n${second.stdout}${second.stderr}`);
  assert.notEqual(a.laneDirLocal, b.laneDirLocal);
  assert.ok(fs.existsSync(path.join(a.laneDirLocal, 'holder.json')));
  assert.ok(fs.existsSync(path.join(b.laneDirLocal, 'holder.json')));
});

test('A4: the lane holder file is REWRITTEN atomically, never appended', { timeout: 120000 }, async (t) => {
  const c = makeCase('holderfile');
  t.after(() => c.cleanup());
  const r = await orch(runArgs(c, 3), c.env);
  const id = idFrom(r.stdout);
  const holderFile = path.join(c.laneDirLocal, 'holder.json');
  const seen = [];
  await waitFor(() => {
    const raw = fs.readFileSync(holderFile, 'utf8');
    seen.push(raw);
    // agy M3: an appended update would make this unparseable.
    const o = JSON.parse(raw);
    return o.worker_pid ? o : null;
  }, { timeoutMs: 20000, what: 'holder.json to carry the worker pid' });
  for (const raw of seen) {
    assert.doesNotThrow(() => JSON.parse(raw), `holder.json was not valid JSON at some point:\n${raw}`);
    assert.equal(raw.trim().lastIndexOf('{'), 0, 'holder.json contains more than one JSON object (it was appended)');
  }
  const o = JSON.parse(fs.readFileSync(holderFile, 'utf8'));
  assert.equal(o.run_id, id);
  assert.equal(typeof o.keeper_pid, 'number');
  const runHolder = JSON.parse(fs.readFileSync(path.join(c.stateRoot, 'runs', id, 'holder.json'), 'utf8'));
  assert.equal(runHolder.run_id, id);
});

test('A2: orch run records keeper pid AND OS creation time itself, before any monitor runs', { timeout: 120000 }, async (t) => {
  const c = makeCase('spawnident');
  t.after(() => c.cleanup());
  // `--no-monitor`: nothing a monitor does may be a prerequisite for clearing state.
  const r = await orch(runArgs(c, 2), c.env);
  const id = idFrom(r.stdout);
  const spawned = JSON.parse(fs.readFileSync(path.join(c.stateRoot, 'runs', id, 'spawned.json'), 'utf8'));
  assert.equal(typeof spawned.keeper_pid, 'number');
  assert.match(String(spawned.keeper_created_at), /^ms:\d+$/, 'keeper OS creation time was not captured by the spawner');
  assert.equal(spawned.monitor_pid, null, 'no monitor was requested');
  const rec = readRunRecord(c.stateRoot, id);
  assert.equal(rec.lane, 'local');
});

test('a real CLI may never be launched into an overridden (test) lane', async () => {
  const c = makeCase('override');
  const res = await orch(
    ['run', '--cli', 'opencode', '--model', 'x', '--dir', c.work, '--handoff', c.handoffPath],
    c.env,
  );
  c.cleanup();
  assert.equal(res.code, 2);
  assert.match(res.stderr, /ORCH_LANE_ID is set/);
});
