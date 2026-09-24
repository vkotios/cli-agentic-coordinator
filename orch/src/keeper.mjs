// THE KEEPER — design v4 §2, amended by BUILD_BRIEF_v4 A1–A6.
//
// Vocabulary, in full: bind the lane pipe once, publish holder facts, answer the
// admission handshake, open three file descriptors, spawn the worker, wait, append,
// close, exit. Nothing else, ever.
//
// Two phases:
//   PHASE A — failure is safe. No worker exists; exiting releases the lane.
//   PHASE B — nothing may throw or change control flow. Every write is guarded and a
//             write failure can never end the worker (N2).
//
// Deliberately narrow import surface (test TG): node:fs, node:net, node:child_process,
// node:path only. No `execFileSync`, no `taskkill`, no kill of any kind (N3), and the
// only `JSON.parse` calls are the two Phase-A reads.
//
// Usage: node keeper.mjs --state-root <root> --id <runId> --run-dir <dir>
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

/* ============================== tiny local helpers ======================== */
// Local, not imported, so the keeper's surface stays exactly four core modules.

const nowIso = () => new Date().toISOString();

let writeFailures = 0;
let workerExited = false; // set on the worker's `exit`; guards the identity capture

// CODE-REVIEW FIX (agy g9): `orch run` destroys the admission pipe once it has its
// answer (or gives up). A later write then raises EPIPE asynchronously on stdout - before
// the Phase-B handlers exist that would have been fatal. The error is swallowed here,
// installed before anything is written.
process.stdout.on('error', () => {});

/** Append one NDJSON line. Never throws; a failure is only counted. */
function append(file, obj) {
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
    return true;
  } catch {
    writeFailures++;
    return false;
  }
}

/** Atomic rewrite (temp + rename). Holder and admission files are NEVER appended (A6). */
function writeAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-k${process.pid}-${Date.now().toString(36)}`);
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (/** @type {any} */ e) {
      const code = e && e.code;
      // agy g11: ENOENT is retried too - on Windows a rename over a file being scanned
      // or replaced can transiently report it (the shared util.mjs helper already did).
      if (i >= 11 || !['EPERM', 'EACCES', 'EBUSY', 'ENOENT'].includes(code)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* leave it rather than mask the original error */
        }
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function writeAtomicGuarded(file, text) {
  try {
    writeAtomic(file, text);
    return true;
  } catch {
    writeFailures++;
    return false;
  }
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

/* ================================== PHASE A =============================== */

const args = parseArgv(process.argv.slice(2)); // 1 parse argv; no file parsing yet
const RUN_ID = String(args.id || '');
const RUN_DIR = String(args['run-dir'] || '');
const F = {
  record: path.join(RUN_DIR, 'run.json'),
  keeper: path.join(RUN_DIR, 'keeper.ndjson'),
  holder: path.join(RUN_DIR, 'holder.json'),
  admission: path.join(RUN_DIR, 'admission.json'),
};

/**
 * The admission handshake (amendment A1). `orch run` holds the read end of this
 * pipe from before the keeper detaches, so it learns the bind result synchronously
 * and can never be left guessing: an exit without a line is an EOF, which `orch run`
 * reports as `undetermined`.
 */
let handshakeSent = false;
function answer(obj) {
  if (handshakeSent) return;
  handshakeSent = true;
  const line = JSON.stringify({ run: RUN_ID, keeper: process.pid, at: nowIso(), ...obj });
  writeAtomicGuarded(F.admission, line + '\n'); // durable copy, for a later `status`
  try {
    process.stdout.write(line + '\n');
  } catch {
    /* the caller may already be gone; the run continues regardless */
  }
}

function blockedExit(reason, code, extra = {}) {
  append(F.keeper, { blocked: reason, at: nowIso(), ...extra });
  answer({ admission: 'blocked', reason });
  process.exit(code);
}

// 2 read run.json ONCE. This and the holder read below are the only parses in the file.
let launch;
try {
  const rec = JSON.parse(fs.readFileSync(F.record, 'utf8'));
  launch = rec.launch;
  if (!launch || !launch.exe || !Array.isArray(launch.args)) throw new Error('no launch block');
} catch (/** @type {any} */ e) {
  blockedExit('record-unreadable', 5, { detail: String((e && e.message) || e) });
}

// 3 refuse anything that is not a real .exe, and refuse cmd.exe by name.
//   X1 `cmdwrap` measured that `cmd.exe /d /s /c <shim>` destroys libuv containment:
//   the wrapper dies and the whole subtree it started stays alive.
{
  const exe = String(launch.exe);
  const base = path.basename(exe).toLowerCase();
  if (!base.endsWith('.exe') || base === 'cmd.exe') {
    blockedExit('no-exe-entrypoint', 5, { exe });
  }
}

// 4 build the hello buffer NOW, so Phase B never formats anything (A5).
const HELLO = Buffer.from(JSON.stringify({ run: RUN_ID, keeper: process.pid }) + '\n', 'utf8');

const PIPE = String(launch.pipe_name || '');
// CODE-REVIEW FIX (astra M8): only a SERIAL lane is exclusive. A non-serial lane (cloud)
// never binds the pipe and never publishes lane-wide holder facts, so parallel cloud runs
// cannot refuse each other. Absent flag = exclusive (the safe default for old records).
const EXCLUSIVE = launch.lane_exclusive !== false;
const LANE_HOLDER = EXCLUSIVE && launch.lane_holder ? String(launch.lane_holder) : null;

/** Holder facts a refused caller can name (A4). Unreadable => `unknown`, never a block. */
function readHolderFacts() {
  if (!LANE_HOLDER) return null;
  try {
    const o = JSON.parse(fs.readFileSync(LANE_HOLDER, 'utf8'));
    return o && o.run_id ? o : null;
  } catch {
    return null;
  }
}

const server = net.createServer();
server.on('error', () => {}); // after the bind, a server error may never change control flow

// 5 listen ONCE. No retry, no loop, no ticket.
if (EXCLUSIVE) {
  server.listen(PIPE, onBound);
  server.once('error', onBindError);
} else {
  onBound();
}

function onBindError(e) {
  const code = (e && e.code) || 'UNKNOWN';
  if (code !== 'EADDRINUSE') {
    blockedExit(`lane-unavailable-${code}`, 7, { pipe: PIPE });
    return;
  }
  // A4, corrected by measurement: the lane-wide holder.json is rewritten by the NEW
  // winner only after its bind, so for a few milliseconds it still names the PREVIOUS
  // run. The suite caught a refusal naming a run that no longer held the lane. The
  // live holder's own hello (built before its bind) is the better witness, so the
  // loser asks it once, bounded, and names the file's run only when both agree.
  // Unauthenticated (X6): it names, it never authorises.
  const recorded = readHolderFacts();
  let done = false;
  const refuse = (helloRun) => {
    if (done) return;
    done = true;
    const run = helloRun || null;
    const agreed = !!(run && recorded && recorded.run_id === run);
    append(F.keeper, { blocked: 'lane-busy', at: nowIso(), holder: run, holder_file_agrees: agreed });
    answer({
      admission: 'lane-busy',
      holder: run ? { run_id: run, keeper_pid: agreed ? recorded.keeper_pid ?? null : null, source: 'hello' } : null,
      last_recorded_holder: recorded ? recorded.run_id : null,
      holder_text: run ? `held by run ${run}` : 'held by: unknown (holder starting)',
    });
    process.exit(3);
  };
  const timer = setTimeout(() => refuse(null), 1500);
  try {
    const c = net.connect(PIPE);
    let buf = '';
    c.on('error', () => refuse(null));
    c.on('data', (d) => {
      buf += d.toString('utf8');
      const m = /"run":"([^"]+)"/.exec(buf);
      if (m) {
        clearTimeout(timer);
        refuse(m[1]);
      }
    });
    c.on('end', () => refuse(null));
  } catch {
    refuse(null);
  }
}

function onBound() {
  server.removeListener('error', onBindError);
  if (EXCLUSIVE) installHelloHandler();
  onLane();
}

function installHelloHandler() {
  // 6 the ONLY connection handler. One pre-built buffer, `end()` (never write+destroy,
  //   which can discard the payload), and the socket's own error handler, attached to
  //   the socket, inside this callback.
  server.on('connection', (s) => {
    try {
      s.on('error', () => {});
    } catch {
      /* nothing may escape */
    }
    try {
      s.end(HELLO);
    } catch {
      /* nothing may escape */
    }
  });

  // 7 the lane is ours
}

function onLane() {
  append(F.keeper, EXCLUSIVE ? { event: 'lane-acquired', at: nowIso(), pipe: PIPE } : { event: 'lane-acquired', at: nowIso(), pipe: null, exclusive: false });

  // 8 holder facts, written atomically, BEFORE the spawn and before we answer, so a
  //   refused caller has something to name (A4). Never appended (A6 / agy M3).
  const holder = {
    run_id: RUN_ID,
    keeper_pid: process.pid,
    lane_id: launch.lane_id || null,
    lane: launch.lane || null,
    worker_pid: null,
    at: nowIso(),
  };
  const holderText = JSON.stringify(holder, null, 2) + '\n';
  let holderOk = true;
  try {
    writeAtomic(F.holder, holderText);
    if (LANE_HOLDER) writeAtomic(LANE_HOLDER, holderText);
  } catch (/** @type {any} */ e) {
    holderOk = false;
    blockedExit('holder-write-failed', 9, { detail: String((e && e.message) || e) });
  }
  if (!holderOk) return;

  // NOTE on A1's timing: the bind result is known here, but `orch run` is told
  // `acquired` only once the worker has actually been created (the 'spawn' event in
  // Phase B). Otherwise a missing exe or a failed fd open would be reported to the
  // caller as `job <id>` and only contradicted later by `status`. Every failure
  // between here and the spawn answers `blocked`, so the caller always learns the
  // truth, and the wait stays bounded because 'spawn' fires as soon as the process
  // exists.

  // 9 open the three fds
  let fdIn, fdOut, fdErr;
  try {
    fdIn = fs.openSync(launch.prompt, 'r');
    fdOut = fs.openSync(launch.stdout, 'a');
    fdErr = fs.openSync(launch.stderr, 'a');
  } catch (/** @type {any} */ e) {
    blockedExit('io-open-failed', 8, { detail: String((e && e.message) || e) });
    return;
  }

  // 10 record-and-return handlers, installed BEFORE the spawn. After this point no
  //    orch code path, bug or otherwise, may terminate the worker.
  process.on('uncaughtException', (e) => {
    append(F.keeper, { event: 'keeper-exception', at: nowIso(), detail: String((e && e.message) || e) });
  });
  process.on('unhandledRejection', (/** @type {any} */ e) => {
    append(F.keeper, { event: 'keeper-rejection', at: nowIso(), detail: String((e && e.message) || e) });
  });

  phaseB({ fdIn, fdOut, fdErr, holder, holderText });
}

/* ================================== PHASE B =============================== */
// Nothing below may throw or change control flow. The only `process.exit` is in the
// final teardown, after the worker's exit has been observed and recorded.

function phaseB(ctx) {
  const { fdIn, fdOut, fdErr, holder } = ctx;

  const env = { ...process.env };
  for (const k of launch.env_delete || []) delete env[k];
  for (const [k, v] of Object.entries(launch.env_set || {})) env[k] = String(v);

  // 11 spawnGuarded: a synchronous throw AND an 'error' event with no prior 'spawn'
  //    are both a safe pre-worker failure.
  let child = null;
  try {
    child = spawn(launch.exe, launch.args, {
      cwd: launch.cwd,
      env,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: [fdIn, fdOut, fdErr],
    });
  } catch (/** @type {any} */ e) {
    closeFds(ctx);
    const reason = `spawn-failed-${(e && e.code) || 'THREW'}`;
    append(F.keeper, { blocked: reason, at: nowIso(), detail: String((e && e.message) || e) });
    answer({ admission: 'blocked', reason, detail: String((e && e.message) || e) });
    finish(10);
    return;
  }

  // Every handler is registered synchronously, in this same tick, before any await.
  // Node queues child events on the next tick, so an instantly-exiting worker cannot
  // slip past us (agy M2).
  let sawSpawn = false;
  let settled = false;

  child.on('error', (/** @type {any} */ e) => {
    if (sawSpawn) {
      append(F.keeper, { event: 'worker-error-after-spawn', at: nowIso(), code: (e && e.code) || null });
      return; // recorded and ignored; the exit wait continues
    }
    if (settled) return;
    settled = true;
    closeFds(ctx);
    const reason = `spawn-failed-${(e && e.code) || 'ERROR'}`;
    append(F.keeper, { blocked: reason, at: nowIso(), detail: String((e && e.message) || e) });
    answer({ admission: 'blocked', reason, detail: String((e && e.message) || e) });
    finish(10);
  });

  child.on('spawn', () => {
    sawSpawn = true;
    // 12
    append(F.keeper, { event: 'spawned', worker_pid: child.pid, at: nowIso() });
    // A1: the worker exists. Only now does the caller hear `job started`.
    answer({ admission: 'acquired', worker_pid: child.pid });
    // 13 holder.json is REWRITTEN atomically with the worker pid - never appended.
    holder.worker_pid = child.pid;
    holder.worker_at = nowIso();
    const text = JSON.stringify(holder, null, 2) + '\n';
    writeAtomicGuarded(F.holder, text);
    if (LANE_HOLDER) writeAtomicGuarded(LANE_HOLDER, text);
    // A2: the keeper records the worker's pid AND its OS creation time itself, so that
    // nothing an operator needs in order to clear a stuck state depends on a monitor
    // having run (agy H4). Bounded, asynchronous, guarded: it cannot delay or end the
    // worker, and a failure simply leaves the creation time to the monitor.
    captureWorkerIdentity(child.pid);
  });

  child.on('exit', (code, signal) => {
    workerExited = true;
    if (settled) return;
    settled = true;
    // 14
    append(F.keeper, { event: 'worker-exit', code: code ?? null, signal: signal ?? null, at: nowIso() });
    // 15 wait for the streams, capped: an escaped helper can hold the fds open.
    let closed = false;
    const cap = setTimeout(() => {
      if (closed) return;
      closed = true;
      append(F.keeper, { event: 'streams-close-timeout', at: nowIso() });
      teardown(ctx);
    }, 10000);
    cap.unref?.();
    child.on('close', () => {
      if (closed) return;
      closed = true;
      clearTimeout(cap);
      append(F.keeper, { event: 'streams-closed', at: nowIso() });
      teardown(ctx);
    });
  });
}

/** One bounded, guarded process query. Never blocks, never kills, never throws. */
function captureWorkerIdentity(pid) {
  try {
    const cmd =
      `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | ` +
      'Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress -Depth 2';
    const ps = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return;
        // Record ONLY while this is provably still our child: the worker has not exited
        // (so its pid cannot have been reused) and the process answering is parented by
        // this keeper. Otherwise record nothing - an absent identity stays `unknown`, and
        // every kill path refuses on `unknown` (astra H4).
        if (workerExited) return;
        const pp = /"ParentProcessId":(\d+)/.exec(String(stdout || ''));
        if (!pp || Number(pp[1]) !== process.pid) return;
        const m = /\/Date\((-?\d+)/.exec(String(stdout || ''));
        if (!m) return;
        append(F.keeper, { event: 'worker-identity', worker_pid: Number(pid), worker_created_at: `ms:${m[1]}`, at: nowIso() });
      },
    );
    ps.on('error', () => {});
  } catch {
    /* best-effort; nothing else may fill it in (astra H4), so a failure leaves `unknown` */
  }
}

function closeFds(ctx) {
  for (const fd of [ctx.fdIn, ctx.fdOut, ctx.fdErr]) {
    try {
      if (typeof fd === 'number') fs.closeSync(fd);
    } catch {
      /* may already be gone */
    }
  }
  ctx.fdIn = ctx.fdOut = ctx.fdErr = null;
}

function teardown(ctx) {
  closeFds(ctx); // 16
  finish(0);
}

/**
 * 17–18. The keeper-exit line, then `server.close()` — only now, after the worker's
 * exit has been observed (v3 H1) — and only then the process exit, from inside the
 * close callback (agy L2), with a short fallback so a stuck close cannot wedge the
 * lane forever.
 */
function finish(code) {
  append(F.keeper, { event: 'keeper-exit', write_failures: writeFailures, at: nowIso() });
  let exited = false;
  const go = () => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  const fallback = setTimeout(go, 2000);
  fallback.unref?.();
  try {
    if (EXCLUSIVE) server.close(go);
    else go();
  } catch {
    go();
  }
}
