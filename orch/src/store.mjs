// Run-directory paths and the per-writer file set of design v4 §3.
//
// ONE WRITER PER FILE. This table is the contract; every module that writes a run
// file must appear here as its sole writer.
//
// | file                         | sole writer                                    |
// |------------------------------|------------------------------------------------|
// | run.json (created `queued`)  | `orch run` creates; the MONITOR thereafter     |
// | prompt.txt, stdout.log,      | `orch run` creates them empty; the WORKER      |
// |   stderr.log                 |   writes the two logs through inherited fds    |
// | spawned.json                 | `orch run` (amendment A2: keeper/monitor pid   |
// |                              |   + OS creation time captured by the spawner)  |
// | keeper.ndjson                | the KEEPER (append-only, fixed line shapes)    |
// | holder.json (run + lane)     | the KEEPER (atomic rewrite, never appended)    |
// | admission.json               | the KEEPER (one atomic write, Phase A)         |
// | events.monitor.ndjson,       | the MONITOR                                    |
// |   monitor.alive, viewer.pid, |
// |   viewer.json,               |                                                |
// |   dirlatch.json              |                                                |
// | cancel.json, cancel.lock,    | the `orch cancel` process (cancel.lock is the  |
// |   cancel-result.json         |   attempt lock, identity-stamped)              |
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, readJson, nowIso } from './util.mjs';

/**
 * Terminal statuses. `blocked` is included (v3 M7): a Phase-A keeper refusal is
 * terminal - no worker ever existed.
 */
export const TERMINAL = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'blocked',
  'blocked-quota',
  'turn-cap',
]);

export const ACTIVE = new Set(['queued', 'running', 'running_quiet', 'suspected_stall']);

export function runDir(cfg, id) {
  return path.join(cfg.runsDir, id);
}

export function paths(cfg, id) {
  const d = runDir(cfg, id);
  return {
    dir: d,
    record: path.join(d, 'run.json'),
    prompt: path.join(d, 'prompt.txt'),
    stdout: path.join(d, 'stdout.log'),
    stderr: path.join(d, 'stderr.log'),
    keeper: path.join(d, 'keeper.ndjson'),
    holder: path.join(d, 'holder.json'),
    admission: path.join(d, 'admission.json'),
    spawned: path.join(d, 'spawned.json'),
    events: path.join(d, 'events.monitor.ndjson'),
    monitorAlive: path.join(d, 'monitor.alive'),
    dirLatch: path.join(d, 'dirlatch.json'),
    cancel: path.join(d, 'cancel.json'),
    cancelLock: path.join(d, 'cancel.lock'),
    cancelResult: path.join(d, 'cancel-result.json'),
    viewerPid: path.join(d, 'viewer.pid'),
    viewerRecord: path.join(d, 'viewer.json'),
  };
}

export function readRun(cfg, id) {
  return readJson(paths(cfg, id).record, null);
}

/** MONITOR ONLY (and `orch run` at creation). Never called by a read-only command. */
export function writeRun(cfg, rec) {
  rec.updated_at = nowIso();
  writeJsonAtomic(paths(cfg, rec.id).record, rec);
  return rec;
}

/** MONITOR ONLY. The monitor's own audit trail. */
export function appendMonitorEvent(cfg, id, event) {
  const p = paths(cfg, id);
  try {
    fs.mkdirSync(p.dir, { recursive: true });
    fs.appendFileSync(p.events, JSON.stringify({ ts: nowIso(), ...event }) + '\n');
    return true;
  } catch {
    return false;
  }
}

export function listRunIds(cfg) {
  try {
    return fs
      .readdirSync(cfg.runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function listRuns(cfg) {
  return listRunIds(cfg)
    .map((id) => readRun(cfg, id))
    .filter(Boolean);
}

/**
 * The keeper's facts, parsed from its append-only trail. This - not `cancel.json`,
 * not `run.json` - is where a run's process truth comes from (amendment A3).
 *
 * @param {string[]} lines complete NDJSON lines
 */
export function keeperFacts(lines) {
  const facts = {
    laneAcquired: null,
    spawned: null,
    workerPid: null,
    workerCreatedAt: null,
    workerExit: null,
    streamsClosed: null,
    keeperExit: null,
    blocked: null,
    writeFailures: null,
    lines: 0,
  };
  for (const line of lines || []) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    facts.lines++;
    if (o.blocked) facts.blocked = { reason: String(o.blocked), at: o.at || null };
    switch (o.event) {
      case 'lane-acquired':
        facts.laneAcquired = o.at || true;
        break;
      case 'spawned':
        facts.spawned = o.at || true;
        facts.workerPid = o.worker_pid ?? facts.workerPid;
        facts.workerCreatedAt = o.worker_created_at ?? facts.workerCreatedAt;
        break;
      case 'worker-identity':
        // Amendment A2: the keeper's own bounded capture of the worker's OS creation
        // time, so cancel never depends on a monitor having run.
        facts.workerPid = o.worker_pid ?? facts.workerPid;
        facts.workerCreatedAt = o.worker_created_at ?? facts.workerCreatedAt;
        break;
      case 'worker-exit':
        facts.workerExit = { code: o.code ?? null, signal: o.signal ?? null, at: o.at || null };
        break;
      case 'streams-closed':
      case 'streams-close-timeout':
        facts.streamsClosed = o.event;
        break;
      case 'keeper-exit':
        facts.keeperExit = { at: o.at || null, write_failures: o.write_failures ?? null };
        facts.writeFailures = o.write_failures ?? null;
        break;
      default:
        break;
    }
  }
  return facts;
}
