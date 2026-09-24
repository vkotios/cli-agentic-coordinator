// THE MONITOR — restartable, files-only, sole writer of `run.json`.
//
// K2 measured that a monitor is disposable: killing it changed nothing about the
// worker, the keeper, the lane lock or the output, and a fresh monitor rebuilt the
// complete picture from the files alone. That is what licenses everything here.
//
// Forbidden (v3 §2.5):
//  - never signals, kills or touches the worker or the keeper. Its ONLY kill is the
//    viewer's own pid, identity-checked (gate G7).
//  - never holds the lane pipe and never influences admission.
//  - never blocks on an unbounded operation.
//
// Exactly one monitor per run, machine-wide: it binds `\\.\pipe\orch-mon-<lane>-<id>`
// and exits at once on EADDRINUSE. The same primitive that gives the lane its
// exclusion gives the record its single writer.
//
// Usage: node monitor.mjs --state-root <root> --id <runId> --run-dir <dir>
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { paths, readRun, writeRun, appendMonitorEvent, TERMINAL, keeperFacts } from './store.mjs';
import { getAdapter } from './adapters/index.mjs';
import { laneScope } from './lanescope.mjs';
import { tryListen } from './lanepipe.mjs';
import { readProcessTable, verifyIdentity, descendantsOf } from './procs.mjs';
import { Tailer } from './tailer.mjs';
import { DirectoryEvidence } from './direvidence.mjs';
import { deriveStatus } from './statusrules.mjs';
import { openViewer, viewerIdentity, closeViewer } from './viewer.mjs';
import { nowIso, readJson, writeJsonAtomic, readTailLines, sleep, withDeadline } from './util.mjs';

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

const args = parseArgv(process.argv.slice(2));
const cfg = loadConfig(args['state-root']);
const ID = String(args.id || '');
const P = paths(cfg, ID);

/** Nothing in the monitor may throw its way out. A monitor crash is harmless but noisy. */
function guard(fn, label) {
  try {
    return fn();
  } catch (e) {
    appendMonitorEvent(cfg, ID, { type: 'monitor-error', where: label, detail: String((e && e.message) || e) });
    return null;
  }
}

// CODE-REVIEW FIX (agy g7): no stray rejection may crash the monitor. A crash is harmless
// to the run (K2) but it abandons the viewer and the record; record and carry on.
process.on('unhandledRejection', (e) => {
  appendMonitorEvent(cfg, ID, { type: 'monitor-unhandled-rejection', detail: String((e && /** @type {any} */ (e).message) || e) });
});

async function main() {
  const rec0 = readRun(cfg, ID);
  if (!rec0) return;
  const scope = laneScope(rec0.lane || 'local');

  // Single-writer election.
  const bind = await tryListen(scope.monitorPipe(ID));
  if (!bind.ok) {
    process.exit(3); // another monitor owns this record
    return;
  }
  const hello = Buffer.from(JSON.stringify({ run: ID, monitor: process.pid }) + '\n', 'utf8');
  bind.server.on('error', () => {});
  bind.server.on('connection', (s) => {
    try {
      s.on('error', () => {});
    } catch {
      /* ignore */
    }
    try {
      s.end(hello);
    } catch {
      /* ignore */
    }
  });

  guard(() => fs.writeFileSync(P.monitorAlive, JSON.stringify({ pid: process.pid, at: nowIso() })), 'monitor.alive');
  appendMonitorEvent(cfg, ID, { type: 'monitor-start', pid: process.pid });

  const adapter = safeAdapter(rec0.cli);
  const heartbeatStream = (adapter && adapter.heartbeatStream) || 'stderr';
  const directoryRelevant = !!(adapter && adapter.directoryEvidence);

  // Restartable by construction: a replacement monitor starts at byte 0 and rebuilds
  // everything, including the stretch when no monitor existed (K2).
  const outTail = new Tailer(P.stdout);
  const errTail = new Tailer(P.stderr);
  // Slice 2: an adapter whose heartbeat is its own per-run log file (agy --log-file).
  // Keepalive lines are not activity. Read-only, like the other two tailers.
  const hbFile = adapter && adapter.heartbeatFile ? guard(() => adapter.heartbeatFile(P.dir), 'heartbeatFile') : null;
  const hbTail = hbFile ? new Tailer(hbFile) : null;
  const latch = readJson(P.dirLatch, null);
  const dirEv = new DirectoryEvidence(rec0.dir_real || rec0.dir, { latched: !!(latch && latch.latched) });

  const state = {
    lastActivityAt: null,
    lastActivitySignal: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    events: [],
    descendants: new Map(),
    viewerOpened: false,
    viewerPid: null,
    viewerCreatedAt: null,
    /** @type {Promise<any>|null} */
    viewerPromise: null,
    lastProcScan: 0,
  };

  // astra M7: a replacement monitor RE-USES the viewer a previous monitor opened, if the
  // identity recorded at its opening still verifies `match`. Only if it does not is a new
  // tab opened. (This verifies a recorded identity; it never adopts an unrecorded one.)
  {
    const known = readJson(P.viewerRecord, null) || (rec0.viewer_pid ? { pid: rec0.viewer_pid, created_at: rec0.viewer_created_at } : null);
    if (known && known.pid && known.created_at) {
      const t = await readProcessTable({ deadlineMs: 4000, pids: [known.pid] });
      if (verifyIdentity(known.pid, known.created_at, t).verdict === 'match') {
        state.viewerOpened = true;
        state.viewerPid = known.pid;
        state.viewerCreatedAt = known.created_at;
        appendMonitorEvent(cfg, ID, { type: 'viewer-reused', pid: known.pid });
      }
    }
  }

  const pollMs = cfg.pollMs;
  let recordMisses = 0;
  for (;;) {
    // A monitor must be able to STOP. Found while running this suite: when a run
    // directory was removed under a live monitor, the monitor polled forever AND
    // re-created `run.json` on every poll (writeRun mkdir's the directory), so the
    // record kept coming back from the dead and the process never exited. A monitor
    // owns its record only for as long as that record exists.
    if (!runDirIntact()) {
      process.exit(0);
      return;
    }
    if (!fs.existsSync(P.record)) {
      // run.json is published by atomic rename, so ONE miss can be the rename window.
      // Several in a row means it is genuinely gone.
      if (++recordMisses >= 10) {
        appendMonitorEvent(cfg, ID, { type: 'monitor-stop', reason: 'run.json disappeared' });
        process.exit(0);
        return;
      }
      await sleep(pollMs);
      continue;
    }
    recordMisses = 0;

    const rec = readRun(cfg, ID) || rec0;
    const facts = keeperFacts(readTailLines(P.keeper, 32768));
    const cancelRequested = fs.existsSync(P.cancel);

    // ---- tail both logs; frame complete lines only -------------------------
    const finished = !!facts.workerExit || !!facts.blocked;
    const o = finished ? outTail.drain() : outTail.poll().lines;
    const e = finished ? errTail.drain() : errTail.poll().lines;
    const outLines = Array.isArray(o) ? o : [];
    const errLines = Array.isArray(e) ? e : [];
    if (outLines.length || errLines.length) {
      state.lastActivityAt = nowIso();
      state.lastActivitySignal = outLines.length ? 'stdout' : 'stderr';
    }
    if (hbTail) {
      const h = finished ? hbTail.drain() : hbTail.poll().lines;
      const real = (Array.isArray(h) ? h : []).filter((l) => l.trim() && !(adapter.isKeepalive && adapter.isKeepalive(l)));
      if (real.length) {
        state.lastActivityAt = nowIso();
        state.lastActivitySignal = 'cli-log';
      }
    }
    state.stdoutBytes = sizeOf(P.stdout);
    state.stderrBytes = sizeOf(P.stderr);

    // Persist the latch BEFORE any status write, so a monitor restart cannot forget a
    // mismatch it already saw (v3 M5). Used by every path that feeds the evidence.
    const feedEvidence = (lines) => {
      if (!directoryRelevant) return;
      const before = dirEv.mismatchLatched;
      dirEv.feed(lines);
      if (dirEv.mismatchLatched && !before) {
        guard(() => writeJsonAtomic(P.dirLatch, { latched: true, at: nowIso(), sessions: dirEv.sessions }), 'dirlatch');
      }
    };
    feedEvidence(heartbeatStream === 'stdout' ? outLines : errLines);
    if (adapter && adapter.parseProtocol && heartbeatStream === 'stdout' && outLines.length) {
      guard(() => {
        for (const ev of adapter.parseProtocol(outLines.join('\n'))) state.events.push(ev);
        if (state.events.length > 500) state.events = state.events.slice(-500);
      }, 'parseProtocol');
    }

    // ---- viewer (never fatal; the monitor's death is harmless anyway) -------
    if (!state.viewerOpened && !rec.no_window && facts.spawned && !finished) {
      state.viewerOpened = true;
      guard(() => {
        state.viewerPromise = openViewer({
          logPath: heartbeatStream === 'stdout' ? P.stdout : P.stderr,
          pidFile: P.viewerPid,
          title: `orch ${ID}`,
        }).then(
          (v) => {
            if (!v.pid) {
              appendMonitorEvent(cfg, ID, { type: 'viewer-failed', error: v.error });
              return;
            }
            // Hand the pid to the poll loop rather than writing run.json here. A
            // second read-modify-write of the record from the same process can be
            // clobbered by the poll that is already in flight, and losing the viewer
            // pid means the tab is never closed at the end of the run.
            return viewerIdentity(v.pid).then((createdAt) => {
              state.viewerPid = v.pid;
              state.viewerCreatedAt = createdAt;
              // Persist the viewer's identity at once, in the monitor's own small file,
              // so a REPLACEMENT monitor can find and verify it instead of opening a
              // second tab and leaking the first (astra M7).
              guard(() => writeJsonAtomic(P.viewerRecord, { pid: v.pid, created_at: createdAt, how: v.how, at: nowIso() }), 'viewer.json');
              appendMonitorEvent(cfg, ID, { type: 'viewer-open', pid: v.pid, how: v.how });
            }).catch((e) => appendMonitorEvent(cfg, ID, { type: 'viewer-identity-failed', detail: String((e && e.message) || e) }));
          },
          () => {},
        );
      }, 'viewer');
    }

    // ---- identity + escaped-helper accumulation (bounded, slow) ------------
    const workerPid = facts.workerPid ?? rec.worker_pid ?? null;
    const workerCreatedAt = facts.workerCreatedAt ?? null;
    let workerVerdict = 'unknown';
    // CODE-REVIEW FIX (astra H4): the monitor NEVER fills in a missing creation time.
    // It used to copy the creation time of whatever process held the recorded pid "now";
    // after a pid reuse that made an unrelated process verify `match`, and `orch cancel`
    // would tree-kill it. Identity is recorded only at spawn, by the keeper (worker) and
    // by `orch run` (keeper, monitor). Without it the worker's identity stays `unknown`,
    // and every kill path refuses.
    if (workerPid && (Date.now() - state.lastProcScan > cfg.procScanMs || finished)) {
      state.lastProcScan = Date.now();
      const table = await readProcessTable({ deadlineMs: 5000 });
      if (table) {
        const id = verifyIdentity(workerPid, workerCreatedAt, table);
        workerVerdict = id.verdict;
        for (const d of descendantsOf(workerPid, table)) {
          if (!state.descendants.has(d.pid)) state.descendants.set(d.pid, { pid: d.pid, name: d.name, createdAt: d.createdAt });
        }
      }
    }

    const spawnedFile = readJson(P.spawned, null);
    const keeperPid = (spawnedFile && spawnedFile.keeper_pid) ?? rec.keeper_pid ?? null;
    const keeperCreatedAt = (spawnedFile && spawnedFile.keeper_created_at) ?? rec.keeper_created_at ?? null;

    // RE-READ the keeper's trail here, immediately before deriving. The identity reads
    // above can take most of a second, and the first version of this loop derived
    // `interrupted: keeper-gone-without-exit` from a keeper-gone verdict paired with a
    // STALE "no worker-exit line". Process facts and file facts must be read together.
    const fresh = keeperFacts(readTailLines(P.keeper, 32768));
    /** @type {string} */
    let keeperVerdict = /** @type {string} */ (fresh.keeperExit ? 'gone' : 'unknown');
    if (!fresh.keeperExit && !fresh.workerExit && keeperPid) {
      const kt = await readProcessTable({ deadlineMs: 3000, pids: [keeperPid] });
      keeperVerdict = verifyIdentity(keeperPid, keeperCreatedAt, kt).verdict;
      // One more re-read: the keeper may have finished while we were asking.
      if (keeperVerdict === 'gone') {
        const again = keeperFacts(readTailLines(P.keeper, 32768));
        if (again.workerExit) Object.assign(fresh, again);
      }
    }
    const finishedNow = !!fresh.workerExit || !!fresh.blocked;
    if (finishedNow && !finished) {
      // The worker finished while the identity reads were in flight: drain now, so the
      // last bytes of the log still reach the directory evidence (v3 §5 final drain).
      const lateOut = outTail.drain();
      const lateErr = errTail.drain();
      feedEvidence(heartbeatStream === 'stdout' ? lateOut : lateErr);
      if (lateOut.length || lateErr.length) state.lastActivityAt = nowIso();
    }

    // ---- derive, then write (monitor is the ONLY writer of run.json) -------
    const stdoutText = finishedNow ? safeRead(P.stdout) : '';
    const stderrText = finishedNow ? safeRead(P.stderr) : '';
    const derived = deriveStatus(adapter ? adapter.statusRules || [] : [], {
      cancelRequested,
      cancelRequestedAt: cancelRequested ? (readJson(P.cancel, null) || {}).requested_at ?? null : null,
      workerExitAt: fresh.workerExit ? fresh.workerExit.at ?? null : null,
      workerConfirmedGone: !!fresh.workerExit || workerVerdict === 'gone',
      blocked: fresh.blocked,
      workerExitSeen: !!fresh.workerExit,
      keeperVerdict,
      exitCode: fresh.workerExit ? fresh.workerExit.code : null,
      signal: fresh.workerExit ? fresh.workerExit.signal : null,
      stdout: stdoutText,
      stderr: stderrText,
      events: state.events,
      dirEvidence: directoryRelevant ? dirEv.verdict() : 'match',
      directoryRelevant,
    });

    const next = readRun(cfg, ID) || rec;
    next.worker_pid = workerPid;
    next.worker_created_at = workerCreatedAt;
    next.keeper_pid = keeperPid;
    next.keeper_created_at = keeperCreatedAt;
    next.monitor_pid = process.pid;
    next.monitor_created_at = (spawnedFile && spawnedFile.monitor_created_at) ?? null;
    next.stdout_bytes = state.stdoutBytes;
    next.stderr_bytes = state.stderrBytes;
    next.last_activity_at = state.lastActivityAt;
    next.last_activity_signal = state.lastActivitySignal;
    if (state.viewerPid) {
      next.viewer_pid = state.viewerPid;
      next.viewer_created_at = state.viewerCreatedAt;
    }
    next.cancel_requested = cancelRequested;
    next.cancel_result = readJson(P.cancelResult, null);
    if (directoryRelevant) Object.assign(next, dirSnapshot(dirEv));

    if (derived.terminal) {
      next.status = derived.status;
      next.reason = derived.reason;
      if (derived.note) next.status_note = derived.note;
      next.exit_code = fresh.workerExit ? fresh.workerExit.code : null;
      next.ended_at = next.ended_at || nowIso();
      next.started_at = next.started_at || rec.started_at || null;
      // Adapter post-exit hook (vibe's session binding and fallback warnings).
      if (adapter && adapter.postExit) {
        const post = guard(
          () =>
            adapter.postExit({
              dir: next.dir,
              alias: next.vibe_alias,
              requestedCanonical: next.model_canonical,
              startedAtMs: next.started_at ? Date.parse(next.started_at) : Date.parse(next.created_at),
              endedAtMs: Date.now(),
              runDir: P.dir,
              stdoutPath: P.stdout,
              stderrPath: P.stderr,
            }),
          'postExit',
        );
        if (post) {
          next.model_actual = post.actual_model ?? null;
          for (const k of ['actual_model_source', 'codex_effort_reported', 'codex_sandbox_reported', 'agy_model_resolved_via', 'agy_model_label', 'agy_model_evidence', 'agy_model_claimed', 'codex_rollout']) {
            if (post[k] !== undefined) next[k === 'actual_model_source' ? 'model_actual_source' : k] = post[k];
          }
          next.model_actual_alias = post.actual_model_alias ?? null;
          next.routed_default_model = post.routed_default_model ?? null;
          next.vibe_meta_binding = post.vibe_meta_binding ?? null;
          if (post.model_mismatch !== undefined) next.model_mismatch = post.model_mismatch;
          next.post_exit_warnings = post.warnings || [];
        }
      }
      // Escaped helpers: one final bounded classification. Reported, never killed,
      // never counted for exclusion.
      next.escaped_helpers = await classifyHelpers(state.descendants);
      guard(() => writeRun(cfg, next), 'final-write');
      appendMonitorEvent(cfg, ID, { type: 'final', status: next.status, reason: next.reason });
      // astra M7: a viewer still starting up (short run, slow tab) is waited for, bounded,
      // so its identity is known and it can be closed - instead of being left open.
      if (state.viewerPromise) await withDeadline(state.viewerPromise, 15000, null);
      const vPid = state.viewerPid ?? next.viewer_pid;
      const vCreated = state.viewerPid ? state.viewerCreatedAt : next.viewer_created_at;
      if (vPid) {
        const c = await closeViewer(vPid, vCreated);
        appendMonitorEvent(cfg, ID, { type: 'viewer-closed', pid: vPid, ...c });
      }
      guard(() => fs.unlinkSync(P.monitorAlive), 'monitor.alive-remove');
      process.exit(0);
      return;
    }

    if (!TERMINAL.has(next.status)) {
      next.status = classifyActivity(cfg, next, state, fresh);
      if (fresh.spawned && !next.started_at) next.started_at = nowIso();
      // Slice-2 fix: writeRun creates missing directories, so a write racing the removal
      // of the run directory used to RE-CREATE it (with only run.json in it), and the
      // "directory is gone" check above never fired again: a monitor leaked for an hour.
      if (!runDirIntact()) {
        process.exit(0);
        return;
      }
      guard(() => writeRun(cfg, next), 'poll-write');
    }

    await sleep(pollMs);
  }
}

/**
 * The run directory is still the one `orch run` created: prompt.txt is written by `orch run`
 * before any monitor exists and nothing ever deletes it, so its absence means the directory
 * was removed (possibly re-created by a racing write of ours) - the monitor must stop.
 */
function runDirIntact() {
  return fs.existsSync(P.dir) && fs.existsSync(P.prompt);
}

function dirSnapshot(dirEv) {
  const s = dirEv.snapshot();
  return {
    dir_evidence: s.evidence,
    dir_evidence_latched: s.latched,
    dir_sessions: s.sessions,
    bootstrap_directories: s.bootstrap_directories,
  };
}

/** Advisory only. Nothing here ever kills a run (N3). */
function classifyActivity(cfg, rec, state, facts) {
  if (!facts.spawned) return 'queued';
  const lane = cfg.lanes[rec.lane] || cfg.lanes.local;
  // CODE-REVIEW FIX (astra M9): the quiet clock starts at the SPAWN, not at the first
  // output. A worker that hangs before writing anything used to stay `running` forever.
  // The spawn time comes from the keeper's own `spawned` line.
  const ref = state.lastActivityAt || (typeof facts.spawned === 'string' ? facts.spawned : null);
  if (!ref || !Number.isFinite(Date.parse(ref))) return 'running';
  const quiet = (Date.now() - Date.parse(ref)) / 1000;
  if (quiet > lane.stallSeconds) return 'suspected_stall';
  if (quiet > lane.quietSeconds) return 'running_quiet';
  return 'running';
}

async function classifyHelpers(map) {
  if (!map.size) return [];
  const pids = [...map.keys()];
  const table = await readProcessTable({ deadlineMs: 5000, pids });
  const out = [];
  for (const d of map.values()) {
    const v = verifyIdentity(d.pid, d.createdAt, table);
    if (v.verdict === 'match') out.push({ pid: d.pid, name: d.name, state: 'alive' });
    else if (v.verdict === 'unknown') out.push({ pid: d.pid, name: d.name, state: 'unknown' });
  }
  return out;
}

function sizeOf(f) {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
}

function safeRead(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

function safeAdapter(name) {
  try {
    return getAdapter(name);
  } catch {
    return null;
  }
}

main().catch((e) => {
  appendMonitorEvent(cfg, ID, { type: 'monitor-fatal', detail: String((e && e.stack) || e) });
  process.exit(1);
});
