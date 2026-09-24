// Code-review fix round (codex gpt-6-astra review of b4ed2a7): one test per finding.
// Every test here FAILS on b4ed2a7 and passes after the fix; the report states which
// assertion fails on the old code and why.
//
// Safety, as everywhere in this suite: every process a test starts is its own, every
// kill is identity-checked (pid + OS creation time) immediately before it, and every
// fake process self-destructs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  KIT,
  makeCase,
  orch,
  contend,
  idFrom,
  waitFor,
  waitForStatus,
  keeperLines,
  readRunRecord,
  killOwnedChecked,
  identityOf,
  spawnedIdentity,
} from './helpers.mjs';
import { readProcessTable, verifyIdentity } from '../src/procs.mjs';
import { laneScope } from '../src/lanescope.mjs';
import { scanNewestMtime } from '../src/util.mjs';

const FAKE_VIEWER = path.join(KIT, 'test', 'fake-viewer.mjs');
const STALL_CHILD = path.join(KIT, 'test', 'fixtures', 'stall-child.mjs');

function runArgs(c, extra = []) {
  return ['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--no-window', ...extra];
}

/** A long-lived decoy process this test owns: stands in for "an unrelated process". */
async function startDecoy() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 90000)'], { stdio: 'ignore', windowsHide: true });
  const createdAt = await waitFor(
    async () => {
      const t = await readProcessTable({ deadlineMs: 5000, pids: [child.pid] });
      const hit = t && t.find((p) => p.pid === child.pid);
      return hit ? hit.createdAt : null;
    },
    { timeoutMs: 20000, what: 'decoy creation time' },
  );
  return { pid: child.pid, createdAt };
}

/** Hand-craft a run directory, exactly as the files would look after a given failure. */
function craftRun(c, id, { keeperLinesText, spawned, cancel = false, extra = {} }) {
  const dir = path.join(c.stateRoot, 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['stdout.log', 'stderr.log', 'prompt.txt']) fs.writeFileSync(path.join(dir, f), '');
  const scope = { lane_id: c.laneId };
  const rec = {
    id,
    cli: 'fake',
    lane: 'local',
    model_canonical: 'none',
    dir: c.work,
    dir_real: c.work,
    status: 'running',
    no_window: true,
    created_at: new Date().toISOString(),
    lane_id: scope.lane_id,
    launch: { exe: process.execPath, args: [], lane: 'local', lane_exclusive: true },
    ...extra,
  };
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(rec, null, 2));
  fs.writeFileSync(path.join(dir, 'keeper.ndjson'), keeperLinesText);
  if (spawned) fs.writeFileSync(path.join(dir, 'spawned.json'), JSON.stringify(spawned, null, 2));
  if (cancel) fs.writeFileSync(path.join(dir, 'cancel.json'), JSON.stringify({ requested_at: new Date().toISOString(), by_pid: 1 }));
  return dir;
}

/* ================================================================= H1 ==== */

test('astra H1: the lane id does not depend on inheritable environment (USERPROFILE / HOMEDRIVE / HOMEPATH / USERNAME)', async () => {
  const probe = `import('${pathToFileUrl(path.join(KIT, 'src', 'lanescope.mjs'))}').then(m => process.stdout.write(m.laneScope('local').pipeName))`;
  const run = (envPatch) =>
    new Promise((resolve) => {
      const env = { ...process.env, ...envPatch };
      delete env.ORCH_LANE_ID;
      execFile(process.execPath, ['-e', probe], { env, encoding: 'utf8', windowsHide: true }, (err, out) => resolve(err ? `ERR ${err.message}` : out));
    });
  const normal = await run({});
  const skewed = await run({ USERPROFILE: 'C:\\Elsewhere\\profile', HOMEDRIVE: 'D:', HOMEPATH: '\\other', USERNAME: 'mallory' });
  assert.match(normal, /^\\\\\.\\pipe\\orch-lane-[0-9a-f]{12}-local$/, normal);
  assert.equal(skewed, normal, 'a shell with a different profile environment derived a DIFFERENT lane - two local lanes');
});

test('astra H1: two contenders whose profile environment differs still exclude each other on the real local lane', { timeout: 120000 }, async (t) => {
  // This one uses the REAL per-user lane (no ORCH_LANE_ID), because the override is
  // exactly what cannot show the defect. It first checks the lane is free and refuses
  // to proceed otherwise, so it can never interfere with a real run.
  const c = makeCase('h1-real');
  t.after(() => c.cleanup());
  const base = { ...c.env };
  delete base.ORCH_LANE_ID;
  const free = await orch(['wait-lane', '--lane', 'local', '--timeout', '2', '--json'], base);
  if (free.code !== 0) {
    t.skip(`the real local lane is in use (${free.stdout.trim()}); not interfering`);
    return;
  }
  const skewed = { ...base, USERPROFILE: 'C:\\Elsewhere\\profile', HOMEDRIVE: 'D:', HOMEPATH: '\\other' };
  const args = [...runArgs(c, ['--lane', 'local', '--no-monitor', '--flag', '--hold', '--flag', '4'])];
  const [a, b] = await Promise.all([contend(1, args, base, { leadMs: 1200 }), contend(1, args, skewed, { leadMs: 1200 })]);
  const results = [...a, ...b];
  const admitted = results.filter((r) => r.code === 0);
  assert.equal(admitted.length, 1, `different profile env must not create a second lane: ${JSON.stringify(results.map((r) => [r.code, r.stdout.split('\n')[0]]))}`);
  await waitFor(async () => (await orch(['wait-lane', '--lane', 'local', '--timeout', '20', '--json'], base)).code === 0, {
    timeoutMs: 60000,
    what: 'the real lane to be free again',
  });
});

function pathToFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

/* ================================================================= H2 ==== */

test('astra H2: a missing worker pid is `unknown`, so a cancel request can never make that run `cancelled`', { timeout: 120000 }, async (t) => {
  const c = makeCase('h2');
  const decoy = await startDecoy(); // stands in for a keeper that is alive and running a worker
  t.after(async () => {
    await killOwnedChecked(decoy.pid, decoy.createdAt);
    c.cleanup();
  });
  // The keeper bound the lane and spawned, but its `spawned` line never reached disk.
  const id = '20260923-000000-h2h2h2';
  craftRun(c, id, {
    keeperLinesText: JSON.stringify({ event: 'lane-acquired', at: new Date().toISOString() }) + '\n',
    spawned: { run_id: id, keeper_pid: decoy.pid, keeper_created_at: decoy.createdAt },
    cancel: true,
  });
  const st = await orch(['status', id, '--json'], c.env);
  const row = JSON.parse(st.stdout).runs[0];
  assert.equal(row.keeper_identity, 'match', 'precondition: the keeper is alive');
  assert.equal(row.worker_identity, 'unknown', `no recorded worker pid must read as unknown, got ${row.worker_identity}`);
  assert.notEqual(row.derived_status, 'cancelled', 'a live run was derived `cancelled` from a missing pid');
  assert.equal(row.derived_status, 'running');
});

/* ================================================================= H3 ==== */

test('astra H3: an `undetermined` admission still records the keeper identity, so cancel --keeper can clear it', { timeout: 180000 }, async (t) => {
  const c = makeCase('h3');
  t.after(() => c.cleanup());
  // A 1 ms admission deadline forces the `undetermined` branch - the path that returned
  // before the identity capture in b4ed2a7.
  const env = { ...c.env, ORCH_ADMISSION_TIMEOUT_MS: '1' };
  const r = await orch(runArgs(c, ['--lane', 'local', '--no-monitor', '--flag', '--hold', '--flag', '40']), env);
  assert.equal(r.code, 4, `expected undetermined (exit 4): ${r.stdout}${r.stderr}`);
  const id = fs.readdirSync(path.join(c.stateRoot, 'runs')).sort().pop();
  const spawned = spawnedIdentity(c.stateRoot, id);
  assert.ok(spawned, 'spawned.json was not written on the undetermined path');
  assert.match(String(spawned.keeper_created_at), /^ms:\d+$/, 'the keeper creation time was not captured before the early return');
  await waitFor(() => keeperLines(c.stateRoot, id).some((l) => l.event === 'worker-identity'), { timeoutMs: 20000, what: 'worker identity' });

  const res = await orch(['cancel', '--keeper', id, '--json'], c.env);
  const out = JSON.parse(res.stdout);
  assert.equal(out.kill_verdict, 'match', `cancel --keeper refused: ${res.stdout}`);
  assert.equal(out.cancel_state, 'keeper-cleared', res.stdout);
  assert.equal(res.code, 0);
});

/* ================================================================= H4 ==== */

test('astra H4: the monitor never adopts the identity of whatever process holds the worker pid now', { timeout: 180000 }, async (t) => {
  const c = makeCase('h4');
  const decoy = await startDecoy(); // an UNRELATED process that happens to hold the recorded pid
  t.after(async () => {
    await killOwnedChecked(decoy.pid, decoy.createdAt);
    c.cleanup();
  });
  // Keeper died before recording the worker's identity; the worker was reaped and its
  // pid is now held by the decoy.
  const id = '20260923-000000-h4h4h4';
  craftRun(c, id, {
    keeperLinesText:
      JSON.stringify({ event: 'lane-acquired', at: new Date().toISOString() }) +
      '\n' +
      JSON.stringify({ event: 'spawned', worker_pid: decoy.pid, at: new Date().toISOString() }) +
      '\n',
    spawned: { run_id: id, keeper_pid: 999999, keeper_created_at: 'ms:1' },
  });
  const m = await orch(['monitor', id, '--json'], c.env);
  assert.equal(m.code, 0, m.stdout + m.stderr);
  const rec = await waitForStatus(c.stateRoot, id, ['interrupted', 'failed', 'completed', 'cancelled'], { timeoutMs: 60000 });
  assert.equal(rec.worker_created_at ?? null, null, `the monitor adopted a creation time for pid ${decoy.pid}: ${rec.worker_created_at}`);

  const res = await orch(['cancel', id, '--json'], c.env);
  const out = JSON.parse(res.stdout);
  assert.notEqual(out.kill_verdict, 'match', 'cancel was allowed to target the decoy');
  assert.equal(out.killed, false);
  assert.equal(await identityOf(decoy.pid, decoy.createdAt), 'match', 'an UNRELATED process was killed');
});

/* ================================================================= M5 ==== */

test('astra M5: status and wait-lane use no synchronous fs call on a path that claims a deadline', () => {
  const src = fs.readFileSync(path.join(KIT, 'src', 'commands.mjs'), 'utf8');
  const bodyOf = (sig) => {
    const start = src.indexOf(sig);
    assert.ok(start >= 0, `${sig} not found`);
    const rest = src.slice(start + sig.length);
    const next = rest.search(/\n(export )?(async )?function /);
    return next > 0 ? rest.slice(0, next) : rest;
  };
  for (const sig of ['export async function inspect(', 'export async function cmdStatus(', 'export async function cmdWaitLane(']) {
    const body = bodyOf(sig).replace(/\/\/.*$/gm, '');
    const offenders = body.match(/\breadTailLines\(|\breadJson\(|existsSync|readFileSync|readdirSync|statSync|listRunIds\(|ensureDirs\(/g);
    assert.equal(offenders, null, `${sig} still blocks the event loop with: ${offenders}`);
  }
});

test('astra M5: a stuck read cannot hold a command open - the deadline answers and the process exits', { timeout: 60000 }, async () => {
  // The child blocks an async read on a pipe server that accepts and never writes, then
  // does what the CLI does: answer under a deadline and arm the exit guard.
  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    execFile(process.execPath, [STALL_CHILD], { encoding: 'utf8', windowsHide: true, timeout: 30000 }, (err, stdout) =>
      resolve({ err, stdout }),
    );
  });
  const ms = Date.now() - t0;
  assert.match(res.stdout, /undetermined: read cancel-result\.json exceeded 500ms/, `the deadline never answered: ${res.stdout}`);
  assert.doesNotMatch(res.stdout, /threw|read returned/, 'the read must have STALLED, not failed or returned');
  assert.ok(ms < 15000, `the process was held open for ${ms} ms by an abandoned read`);
});

/* ================================================================= M6 ==== */

test('astra M6: concurrent cancels - exactly one kills, the other serves that result and kills nothing', { timeout: 180000 }, async (t) => {
  const c = makeCase('m6');
  t.after(() => c.cleanup());
  const r = await orch(runArgs(c, ['--lane', 'local', '--flag', '--hold', '--flag', '40']), c.env);
  const id = idFrom(r.stdout);
  await waitFor(() => keeperLines(c.stateRoot, id).some((l) => l.event === 'worker-identity'), { timeoutMs: 20000, what: 'worker identity' });
  const [a, b] = await Promise.all([orch(['cancel', id, '--json'], c.env), orch(['cancel', id, '--json'], c.env)]);
  const outs = [JSON.parse(a.stdout), JSON.parse(b.stdout)];
  const killers = outs.filter((o) => o.kill_performed === true);
  const served = outs.filter((o) => o.served_from === 'concurrent-cancel');
  assert.equal(killers.length, 1, `exactly one cancel may perform the kill: ${JSON.stringify(outs)}`);
  assert.equal(served.length, 1, 'the other must serve the result, not repeat the kill');
  assert.equal(served[0].kill_performed, false);
  assert.equal(served[0].attempt, killers[0].attempt, 'both callers must report the SAME attempt');
  assert.equal(served[0].cancel_state, killers[0].cancel_state);
  const result = JSON.parse(fs.readFileSync(path.join(c.stateRoot, 'runs', id, 'cancel-result.json'), 'utf8'));
  assert.equal(result.attempt, killers[0].attempt, 'cancel-result.json was overwritten by a second attempt');
  assert.ok(!fs.existsSync(path.join(c.stateRoot, 'runs', id, 'cancel.lock')), 'the attempt lock was not released');
});

test('astra M6: a stale attempt lock (its holder is gone) is taken over, so a retry makes progress', { timeout: 180000 }, async (t) => {
  const c = makeCase('m6-stale');
  t.after(() => c.cleanup());
  const r = await orch(runArgs(c, ['--lane', 'local', '--flag', '--hold', '--flag', '40']), c.env);
  const id = idFrom(r.stdout);
  await waitFor(() => keeperLines(c.stateRoot, id).some((l) => l.event === 'worker-identity'), { timeoutMs: 20000, what: 'worker identity' });
  // A cancel process that died holding the lock: its recorded identity is not running.
  fs.writeFileSync(
    path.join(c.stateRoot, 'runs', id, 'cancel.lock'),
    JSON.stringify({ pid: 999999, created_at: 'ms:1', attempt: 'deadbeef0000', at: new Date().toISOString() }),
  );
  const res = await orch(['cancel', id, '--json'], c.env);
  const out = JSON.parse(res.stdout);
  assert.equal(out.cancel_state, 'cancelled', res.stdout);
  assert.equal(out.kill_performed, true);
});

/* ================================================================= M7 ==== */

async function viewerPidsAlive(logFile) {
  let pids = [];
  try {
    pids = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map(Number);
  } catch {
    return { pids: [], alive: [] };
  }
  const table = await readProcessTable({ deadlineMs: 5000, pids });
  const alive = (table || []).filter((p) => pids.includes(p.pid) && /node/i.test(p.name));
  return { pids, alive };
}

async function cleanupViewers(logFile) {
  const { alive } = await viewerPidsAlive(logFile);
  for (const p of alive) await killOwnedChecked(p.pid, p.createdAt); // identity read just now
}

test('astra M7: a viewer still starting when a short run ends is waited for and closed, not leaked', { timeout: 180000 }, async (t) => {
  const c = makeCase('m7-fast');
  const log = path.join(c.base, 'viewers.log');
  t.after(async () => {
    await cleanupViewers(log);
    c.cleanup();
  });
  const env = { ...c.env, ORCH_FAKE_VIEWER: FAKE_VIEWER, ORCH_FAKE_VIEWER_LOG: log, ORCH_FAKE_VIEWER_DELAY_MS: '2500' };
  // Deterministic ordering (was a race): the monitor opens a viewer only while the run is
  // still going, so a ~1 s worker could finish before a loaded machine's monitor ever looked,
  // and no viewer was opened at all. The worker now waits until the viewer has been LAUNCHED
  // (the fake viewer's `.started` marker), then runs ~1 s and exits - well inside the viewer's
  // 2.5 s start-up delay, so the run still ends while the viewer is starting.
  const args = ['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--flag', '--wait-for-file', '--flag', `${log}.started`, '--flag', '--emit', '--flag', '3', '--flag', '--interval', '--flag', '300'];
  const r = await orch(args, env);
  const id = idFrom(r.stdout);
  await waitForStatus(c.stateRoot, id, ['completed', 'failed'], { timeoutMs: 60000 });
  assert.ok(fs.existsSync(`${log}.started`), 'precondition: a viewer was launched while the run was live');
  await waitFor(() => !fs.existsSync(path.join(c.stateRoot, 'runs', id, 'monitor.alive')), { timeoutMs: 30000, what: 'the monitor to finish' });
  // Every launched viewer finishes starting (reports its pid) before we judge leaks: a
  // condition with a deadline, not a fixed sleep.
  const launched = () => fs.readFileSync(`${log}.started`, 'utf8').split(/\r?\n/).filter(Boolean).length;
  const reported = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).length : 0);
  await waitFor(() => reported() >= launched(), { timeoutMs: 30000, what: 'every launched viewer to report its pid' });
  const { pids, alive } = await viewerPidsAlive(log);
  assert.ok(pids.length >= 1, 'precondition: a viewer was opened');
  assert.deepEqual(alive.map((p) => p.pid), [], `viewer(s) left running after the run: ${alive.map((p) => p.pid)}`);
});

test('astra M7: a replacement monitor re-uses the open viewer and closes it; no second tab is leaked', { timeout: 180000 }, async (t) => {
  const c = makeCase('m7-restart');
  const log = path.join(c.base, 'viewers.log');
  t.after(async () => {
    await cleanupViewers(log);
    c.cleanup();
  });
  const env = { ...c.env, ORCH_FAKE_VIEWER: FAKE_VIEWER, ORCH_FAKE_VIEWER_LOG: log };
  const args = ['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--flag', '--emit', '--flag', '30', '--flag', '--interval', '--flag', '400'];
  const r = await orch(args, env);
  const id = idFrom(r.stdout);
  const runDir = path.join(c.stateRoot, 'runs', id);
  await waitFor(() => fs.existsSync(path.join(runDir, 'viewer.json')) || /viewer-open/.test(safeRead(path.join(runDir, 'events.monitor.ndjson'))), {
    timeoutMs: 30000,
    what: 'the viewer identity to be recorded',
  });
  // Kill the first monitor (identity-checked), then re-attach a new one.
  const spawned = spawnedIdentity(c.stateRoot, id);
  const k = await killOwnedChecked(spawned.monitor_pid, spawned.monitor_created_at);
  assert.equal(k.verdict, 'match', k.output);
  const m = await orch(['monitor', id, '--json'], env);
  assert.equal(m.code, 0, m.stdout + m.stderr);
  await waitForStatus(c.stateRoot, id, ['completed', 'failed'], { timeoutMs: 90000 });
  await waitFor(() => !fs.existsSync(path.join(runDir, 'monitor.alive')), { timeoutMs: 30000, what: 'the monitor to finish' });
  const { pids, alive } = await viewerPidsAlive(log);
  assert.equal(pids.length, 1, `a replacement monitor opened a second viewer: ${pids}`);
  assert.deepEqual(alive.map((p) => p.pid), [], `viewer left running: ${alive.map((p) => p.pid)}`);
});

function safeRead(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

/* ================================================================= M8 ==== */

test('astra M8: two cloud runs at once are both admitted - a non-serial lane never binds', { timeout: 120000 }, async (t) => {
  const c = makeCase('m8');
  t.after(() => c.cleanup());
  const args = runArgs(c, ['--lane', 'cloud', '--no-monitor', '--flag', '--hold', '--flag', '3']);
  const results = await contend(2, args, c.env, { leadMs: 1000 });
  for (const r of results) assert.equal(r.code, 0, `a cloud run was refused: ${r.stdout}${r.stderr}`);
  const ids = results.map((r) => idFrom(r.stdout));
  for (const id of ids) {
    const lines = keeperLines(c.stateRoot, id);
    assert.ok(lines.some((l) => l.event === 'lane-acquired' && l.exclusive === false), `cloud keeper bound the pipe: ${JSON.stringify(lines)}`);
  }
  // and the local lane is still exclusive
  assert.equal(laneScope('cloud').pipeName.endsWith('-cloud'), true);
});

/* ================================================================= M9 ==== */

test('astra M9: a worker silent from startup becomes `suspected_stall` (the clock starts at spawn)', { timeout: 120000 }, async (t) => {
  const c = makeCase('m9', { config: { lanes: { local: { quietSeconds: 1, stallSeconds: 2 } } } });
  t.after(() => c.cleanup());
  const r = await orch(runArgs(c, ['--lane', 'local', '--flag', '--silent', '--flag', '--hold', '--flag', '30']), c.env);
  const id = idFrom(r.stdout);
  const rec = await waitForStatus(c.stateRoot, id, ['suspected_stall'], { timeoutMs: 30000 });
  assert.equal(rec.status, 'suspected_stall');
  // advisory only: nothing was killed
  const w = keeperLines(c.stateRoot, id).find((l) => l.event === 'worker-identity');
  assert.ok(w, 'worker identity');
  assert.equal(await identityOf(w.worker_pid, w.worker_created_at), 'match', 'a stall must never kill the worker');
  const cancel = await orch(['cancel', id, '--json'], c.env);
  assert.equal(JSON.parse(cancel.stdout).cancel_state, 'cancelled');
  assert.equal(readRunRecord(c.stateRoot, id) !== null, true);
});

/* ======================================================================== */
/*  Second reviewer (agy / Gemini) - one test per finding (g4 = astra H3)     */
/* ======================================================================== */

test('agy g1: a local-model adapter is refused outside the local lane (opencode --lane cloud)', { timeout: 60000 }, async (t) => {
  const c = makeCase('g1');
  t.after(() => c.cleanup());
  const env = { ...c.env, ORCH_OPENCODE_EXE: path.join(c.base, 'not-a-real-opencode.exe') };
  delete env.ORCH_LANE_ID; // a real adapter may not use the test lane at all
  const r = await orch(['run', '--cli', 'opencode', '--model', 'localai/x', '--dir', c.work, '--handoff', c.handoffPath, '--lane', 'cloud', '--no-window'], env);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /may only run in the serial local lane/, `refusal reason missing: ${r.stdout}${r.stderr}`);
  const runs = fs.existsSync(path.join(c.stateRoot, 'runs')) ? fs.readdirSync(path.join(c.stateRoot, 'runs')) : [];
  assert.deepEqual(runs, [], 'a run record was created: the refusal must come before anything is started');
});

test('agy g2: cancel --keeper does not count an identity MISMATCH as the worker being dead', { timeout: 120000 }, async (t) => {
  const c = makeCase('g2');
  const keeperDecoy = await startDecoy();
  const workerDecoy = await startDecoy(); // alive; its recorded creation time is wrong
  t.after(async () => {
    await killOwnedChecked(keeperDecoy.pid, keeperDecoy.createdAt);
    await killOwnedChecked(workerDecoy.pid, workerDecoy.createdAt);
    c.cleanup();
  });
  const id = '20260923-000000-g2g2g2';
  const now = new Date().toISOString();
  craftRun(c, id, {
    keeperLinesText: [
      { event: 'lane-acquired', at: now },
      { event: 'spawned', worker_pid: workerDecoy.pid, at: now },
      { event: 'worker-identity', worker_pid: workerDecoy.pid, worker_created_at: 'ms:1', at: now },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n',
    spawned: { run_id: id, keeper_pid: keeperDecoy.pid, keeper_created_at: keeperDecoy.createdAt },
  });
  const res = await orch(['cancel', '--keeper', id, '--json'], c.env);
  const out = JSON.parse(res.stdout);
  assert.equal(out.kill_verdict, 'match', 'precondition: the (decoy) keeper was killed');
  assert.equal(out.worker_identity_after, 'mismatch', 'precondition: the worker verifies mismatch');
  assert.notEqual(out.cancel_state, 'keeper-cleared', 'a MISMATCH was accepted as proof the worker died');
  assert.equal(res.code, 3);
  assert.equal(await identityOf(workerDecoy.pid, workerDecoy.createdAt), 'match', 'the live "worker" was reported dead while alive');
});

test('agy g3: a probe that times out before connecting is `unknown`, never `free`', { timeout: 60000 }, async () => {
  const { tryListen, connectHello } = await import('../src/lanepipe.mjs');
  const name = `\\\\.\\pipe\\orch-g3-${process.pid}`;
  const held = await tryListen(name);
  assert.ok(held.ok);
  held.server.on('connection', (s) => s.on('error', () => {})); // accept, say nothing
  try {
    const states = [];
    for (let i = 0; i < 10; i++) {
      // Start the probe, then hold the event loop for 60 ms. libuv runs the timers phase
      // before it polls for the connect completion, so the probe's deadline expires
      // BEFORE it can learn that it connected - exactly the "timed out before
      // connecting" case, made deterministic.
      const p = connectHello(name, { deadlineMs: 1 });
      const t0 = Date.now();
      while (Date.now() - t0 < 60) {
        /* busy: keep the loop from reaching the poll phase */
      }
      states.push((await p).state);
    }
    assert.ok(!states.includes('free'), `a HELD pipe was reported free: ${states}`);
  } finally {
    await new Promise((r) => held.server.close(r));
  }
});

test('agy g5: status feeds stderr to the adapter rules, so it agrees with the monitor (e.g. quota)', { timeout: 120000 }, async (t) => {
  const c = makeCase('g5');
  t.after(() => c.cleanup());
  const r = await orch(runArgs(c, ['--no-monitor', '--flag', '--stderr', '--flag', 'FAKE-QUOTA', '--flag', '--exit', '--flag', '3']), c.env);
  const id = idFrom(r.stdout);
  await waitFor(() => keeperLines(c.stateRoot, id).some((l) => l.event === 'keeper-exit'), { timeoutMs: 30000, what: 'keeper exit' });
  const row = JSON.parse((await orch(['status', id, '--json'], c.env)).stdout).runs[0];
  assert.equal(row.derived_status, 'blocked-quota', `status ignored stderr: ${row.derived_status}/${row.derived_reason}`);
});

test('agy g6: a finished run is never relabelled `cancelled` by a later cancel request', { timeout: 120000 }, async (t) => {
  const c = makeCase('g6');
  t.after(() => c.cleanup());
  // (a) cancel.json that post-dates the recorded exit
  const r = await orch(runArgs(c, ['--no-monitor']), c.env);
  const id = idFrom(r.stdout);
  await waitFor(() => keeperLines(c.stateRoot, id).some((l) => l.event === 'keeper-exit'), { timeoutMs: 30000, what: 'keeper exit' });
  await new Promise((res) => setTimeout(res, 50));
  fs.writeFileSync(path.join(c.stateRoot, 'runs', id, 'cancel.json'), JSON.stringify({ requested_at: new Date().toISOString(), by_pid: 1 }));
  const row = JSON.parse((await orch(['status', id, '--json'], c.env)).stdout).runs[0];
  assert.equal(row.derived_status, 'completed', `a late cancel request relabelled a finished run: ${row.derived_status}`);
  // (b) orch cancel after the exit is a no-op and writes no request
  const r2 = await orch(runArgs(c, ['--no-monitor']), c.env);
  const id2 = idFrom(r2.stdout);
  await waitFor(() => keeperLines(c.stateRoot, id2).some((l) => l.event === 'keeper-exit'), { timeoutMs: 30000, what: 'keeper exit' });
  const res = await orch(['cancel', id2, '--json'], c.env);
  assert.equal(JSON.parse(res.stdout).cancel_state, 'already-terminal', res.stdout);
  assert.ok(!fs.existsSync(path.join(c.stateRoot, 'runs', id2, 'cancel.json')), 'a cancel request was written for a finished run');
});

test('agy g7: the monitor cannot be crashed by an unhandled rejection from the viewer identity chain', () => {
  const src = fs.readFileSync(path.join(KIT, 'src', 'monitor.mjs'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(src, /process\.on\('unhandledRejection'/, 'the monitor has no unhandledRejection handler');
  // The chain runs from `viewerIdentity(v.pid)` to the next top-level step of the poll
  // loop; its `.then(...)` must be followed by a `.catch(` within it.
  const at = src.indexOf('viewerIdentity(v.pid)');
  const end = src.indexOf('const workerPid = facts.workerPid', at);
  assert.ok(at >= 0 && end > at, 'viewer identity chain not found');
  assert.match(src.slice(at, end), /\}\)\.catch\(/, 'viewerIdentity(...).then(...) has no .catch');
});

test('agy g8: a resumed mtime scan continues INSIDE a large flat directory and reaches every file', () => {
  const dir = fs.mkdtempSync(path.join(c8tmp(), 'flat-'));
  try {
    for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.txt`), 'x');
    const last = path.join(dir, 'zzzz-newest.txt');
    fs.writeFileSync(last, 'x');
    const future = new Date(Date.now() + 3600 * 1000);
    fs.utimesSync(last, future, future);
    let resume = null;
    let newest = 0;
    let calls = 0;
    for (; calls < 200; calls++) {
      const r = scanNewestMtime(dir, { budgetMs: 0, resume });
      newest = Math.max(newest, r.newest);
      if (!r.truncated) break;
      resume = r.pending;
    }
    assert.ok(calls < 200, 'the scan never finished: a resume restarts the directory from entry 0');
    assert.equal(Math.round(newest), Math.round(fs.statSync(last).mtimeMs), 'the newest file (last in the listing) was never reached');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function c8tmp() {
  const d = path.join(KIT, '.state-test');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

test('agy g9: the keeper swallows stdout errors (EPIPE after orch run hangs up) before its first write', () => {
  const src = fs.readFileSync(path.join(KIT, 'src', 'keeper.mjs'), 'utf8').replace(/\/\/.*$/gm, '');
  const handler = src.indexOf("process.stdout.on('error'");
  const firstWrite = src.indexOf('process.stdout.write(');
  assert.ok(handler >= 0, 'no stdout error handler');
  assert.ok(handler < firstWrite, 'the handler must be installed before the first stdout write');
});

test('agy g11: the keeper retries an atomic rename on ENOENT like the shared helper', () => {
  const src = fs.readFileSync(path.join(KIT, 'src', 'keeper.mjs'), 'utf8');
  const m = /function writeAtomic[\s\S]*?\[([^\]]*EPERM[^\]]*)\]/.exec(src);
  assert.ok(m, 'retry list not found');
  assert.match(m[1], /'ENOENT'/, `ENOENT is not retried: [${m[1]}]`);
});

test('agy g12: every synchronous child-process call in src/ carries a timeout', () => {
  const files = [...fs.readdirSync(path.join(KIT, 'src')).map((f) => path.join(KIT, 'src', f)), ...fs.readdirSync(path.join(KIT, 'src', 'adapters')).map((f) => path.join(KIT, 'src', 'adapters', f))].filter((f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    for (const m of src.matchAll(/(execFileSync|execSync|spawnSync)\(([^;]*?)\)\s*[.;]/g)) {
      if (!/timeout\s*:/.test(m[2])) offenders.push(`${path.basename(f)}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, [], `unbounded synchronous process calls:\n${offenders.join('\n')}`);
});
