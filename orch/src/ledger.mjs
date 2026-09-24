// The ledger and `orch pick` (slice 2; docs/MODELS.md describes the rotation rule).
//
// `orch record <run-id> --disposition <d>` appends ONE JSON line per run. The append is
// one write through an O_APPEND handle - on Windows libuv opens it FILE_APPEND_DATA
// only, so concurrent appends land whole and never interleave (tested with 10
// processes). A per-run marker created exclusively first means a run is recorded once.
//
// Ledger location: --ledger, else $ORCH_LEDGER, else `ledger` in orch.config.json, else
// <state-root>/ledger.jsonl.
//
// `orch pick` is deterministic given the roster and the ledger.
import fs from 'node:fs';
import path from 'node:path';
import { OrchError } from './errors.mjs';
import { nowIso, readJson, readTailLines, writeJsonAtomic } from './util.mjs';
import { setting } from './config.mjs';
import { paths, readRun, keeperFacts, TERMINAL } from './store.mjs';
import { canonicalId, familyOf, loadRoster } from './models.mjs';
import { git, splitZ, topLevel, worktreeList } from './git.mjs';
import { readRounds, computeGate } from './gate.mjs';
import { publishExclusive } from './exclusive.mjs';

export const DISPOSITIONS = ['accepted', 'accepted-with-fixes', 'rejected', 'blocked', 'inconclusive-timeout', 'failed-launch'];
/** What counts as a FAILURE of a workload for the rotation rule. `blocked` (quota,
 *  infrastructure) and `inconclusive-timeout` are not model failures (ORCHESTRATOR §3). */
export const FAILURE_DISPOSITIONS = new Set(['rejected', 'failed-launch']);
export const WORKLOADS = ['implement', 'review'];
export const SIZES = ['XS', 'S', 'M'];

export function ledgerPath(cfg, args = {}) {
  return path.resolve(args.ledger || setting('ORCH_LEDGER', 'ledger', () => path.join(cfg.stateRoot, 'ledger.jsonl'), { isPath: true }));
}

/** Every well-formed line of the ledger; a torn or foreign line is skipped and counted. */
export function readLedger(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { rows: [], bad: 0 };
  }
  const rows = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object') rows.push(o);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { rows, bad };
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function diffStats(rec) {
  if (!rec.scope || !rec.scope.baseline || !rec.dir || !fs.existsSync(rec.dir)) return { files_changed: null, diff_lines: null };
  const top = await topLevel(rec.dir);
  if (!top) return { files_changed: null, diff_lines: null };
  const ns = await git(['diff', '--numstat', '-z', '--no-renames', rec.scope.baseline, '--'], { cwd: top });
  const un = await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: top });
  if (!ns.ok || !un.ok) return { files_changed: null, diff_lines: null };
  let files = 0;
  let lines = 0;
  for (const e of splitZ(ns.stdout)) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(e);
    if (!m) continue;
    files++;
    if (m[1] !== '-') lines += Number(m[1]);
    if (m[2] !== '-') lines += Number(m[2]);
  }
  return { files_changed: files + splitZ(un.stdout).length, diff_lines: lines };
}

function reviewsOf(cfg, runId) {
  const dir = path.join(cfg.stateRoot, 'reviews');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^rv-.*\.json$/.test(f))
      .map((f) => readJson(path.join(dir, f), null))
      .filter((r) => r && r.implementer_run === runId);
  } catch {
    return [];
  }
}

export async function cmdRecord(cfg, args, io) {
  const id = (args._ || [])[0];
  if (!id) throw new OrchError('usage: orch record <run-id> --disposition <d> [--notes <text>] ...', 'missing-arg');
  const disposition = String(args.disposition || '');
  if (!DISPOSITIONS.includes(disposition)) throw new OrchError(`--disposition must be one of ${DISPOSITIONS.join(', ')}`, 'bad-disposition');
  const rec = readRun(cfg, id);
  if (!rec) throw new OrchError(`no such run: ${id}`, 'no-such-run');
  const P = paths(cfg, id);
  const facts = keeperFacts(readTailLines(P.keeper, 32768));
  // Code-review fix a4: only a TERMINAL record is recordable. A keeper `worker-exit` line
  // alone is not enough: the monitor writes the final status and the model actually used
  // (postExit) a moment later, and a row taken before that would carry `running` / null.
  if (!TERMINAL.has(rec.status)) {
    const hint = facts.workerExit || facts.blocked
      ? 'the worker has exited but run.json is not final yet (the monitor writes it; retry shortly, or `orch monitor <id>` if no monitor is running)'
      : 'record it once it has ended';
    throw new OrchError(`run ${id} is not terminal (status ${rec.status}): ${hint}`, 'run-not-finished');
  }

  const workload = args.workload ? String(args.workload) : rec.role === 'review' || rec.review_of ? 'review' : 'implement';
  if (!['implement', 'review', 'adjudicate'].includes(workload)) throw new OrchError('--workload must be implement, review or adjudicate', 'bad-workload');
  const size = args.size || rec.size || null;
  if (size && !SIZES.includes(String(size))) throw new OrchError('--size must be XS, S or M', 'bad-size');
  const startedAt = typeof facts.spawned === 'string' ? facts.spawned : rec.started_at;
  const endedAt = facts.workerExit && facts.workerExit.at ? facts.workerExit.at : rec.ended_at;
  const elapsed = startedAt && endedAt ? Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000) : null;
  const stats = workload === 'implement' ? await diffStats(rec) : { files_changed: null, diff_lines: null };
  const rounds = rec.wp && rec.slice ? readRounds(cfg, rec.wp, rec.slice) : [];
  const gate = rounds.length ? computeGate(rounds) : null;
  const lastRound = rounds.length ? rounds[rounds.length - 1] : null;
  const findings = lastRound
    ? ['H', 'M', 'L'].reduce((o, s) => ({ ...o, [s]: lastRound.findings.filter((f) => f.severity === s && f.in_scope && f.status === 'confirmed').length }), {})
    : null;
  const reviews = workload === 'implement' ? reviewsOf(cfg, id) : [];
  let checks = null;
  if (args.checks) {
    try {
      checks = JSON.parse(String(args.checks));
    } catch {
      checks = String(args.checks);
    }
  }
  // The project is the REPOSITORY, i.e. its main worktree - not the slice worktree the
  // run happened in (found in the S8 smoke: `project` came out as "wp-s8-s1").
  let project = args.project || null;
  if (!project && rec.dir && fs.existsSync(rec.dir)) {
    const wts = await worktreeList(rec.dir);
    if (wts && wts.length) project = path.basename(wts[0].path);
  }
  if (!project && rec.scope && rec.scope.repo_top) project = path.basename(rec.scope.repo_top);

  const row = {
    run_id: id,
    date: (endedAt || nowIso()).slice(0, 10),
    recorded_at: nowIso(),
    project,
    wp: rec.wp || null,
    slice: rec.slice || null,
    size,
    workload,
    cli: rec.cli,
    model_requested: rec.model_requested,
    model_actual: rec.model_actual || null,
    // The rotation rule counts by canonical id of what actually ran when known.
    model_canonical: canonicalId(rec.model_actual || rec.model_requested),
    attempt: numOrNull(args.attempt),
    handoff_version: args['handoff-version'] || null,
    cold_or_warm: args['cold-or-warm'] || null,
    elapsed_s: elapsed,
    turns: numOrNull(args.turns),
    files_changed: stats.files_changed,
    diff_lines: stats.diff_lines,
    checks,
    reviewer_model: workload === 'review' ? rec.model_actual || rec.model_requested : reviews.map((r) => r.reviewer_model).join(', ') || null,
    review_rounds: gate ? gate.rounds_used : null,
    findings,
    controller_intervened: args['controller-intervened'] ? true : null,
    credits_or_cost: args['credits-or-cost'] || null,
    disposition,
    quirks: args.quirks || null,
    notes: args.notes || null,
    run_status: rec.status,
    run_reason: rec.reason || null,
    review_of: rec.review_of || null,
  };

  const file = ledgerPath(cfg, args);
  const markerDir = path.join(path.dirname(file), `${path.basename(file)}.d`);
  const markerFile = path.join(markerDir, `${id}.recorded`);
  // CODE-REVIEW FIX c1. The marker is a per-run EXCLUSIVE record with a state:
  //   pending   -> taken, the append has not been confirmed
  //   recorded  -> the line is in the ledger (verified by reading it back)
  //   failed    -> the append failed; the error is in the marker
  // The LEDGER is the truth: a marker that is not `recorded` never blocks a row silently.
  // A later `orch record` that meets a pending/failed marker looks for the row: if the
  // row is there it completes the marker and refuses as a duplicate; if not, it refuses
  // and names the incomplete attempt - `--force` (the operator) retries. There is no
  // liveness guess about the process that left the marker.
  /** @type {any} */
  const markerDoc = { run_id: id, state: 'pending', at: row.recorded_at, disposition, pid: process.pid };
  const pub = publishExclusive(markerFile, JSON.stringify(markerDoc) + '\n');
  if (!pub.created) {
    const prev = readJson(markerFile, null);
    const inLedger = readLedger(file).rows.some((r) => r.run_id === id);
    if (inLedger) {
      if (prev && prev.state !== 'recorded') writeMarker(markerFile, { ...prev, state: 'recorded', completed_by: 'a later orch record that found the row' });
      const out = { run_id: id, record: 'refused', reason: 'this run is already in the ledger' };
      emit(args, io, out, `record refused: run ${id} is already in the ledger (${file})`);
      return { ...out, exitCode: 3 };
    }
    if (!args.force) {
      const out = { run_id: id, record: 'refused', reason: 'an earlier record of this run did not complete', marker: prev };
      emit(args, io, out, `record refused: an earlier \`orch record\` of ${id} did not complete (marker ${markerFile}: ${prev ? `${prev.state} by pid ${prev.pid} at ${prev.at}${prev.error ? `, error ${prev.error}` : ''}` : 'unreadable'}) and the ledger has no row for it. If that attempt is not still running, retry with --force.`);
      return { ...out, exitCode: 3 };
    }
    markerDoc.forced_over = prev; // kept in every later state of the marker
    writeMarker(markerFile, markerDoc);
  }
  if (process.env.ORCH_ALLOW_FAKE === '1' && process.env.ORCH_TEST_LEDGER_CRASH === 'after-marker') {
    process.exit(9); // test hook: die between the marker and the append
  }
  const line = Buffer.from(JSON.stringify(row) + '\n', 'utf8');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd = null;
  try {
    fd = fs.openSync(file, 'a');
    // A line must never be glued onto a torn fragment left by an earlier failed write.
    const st = fs.fstatSync(fd);
    let prefix = Buffer.alloc(0);
    if (st.size > 0) {
      const last = Buffer.alloc(1);
      const rfd = fs.openSync(file, 'r');
      try {
        fs.readSync(rfd, last, 0, 1, st.size - 1);
      } finally {
        fs.closeSync(rfd);
      }
      if (last[0] !== 0x0a) prefix = Buffer.from('\n');
    }
    const buf = prefix.length ? Buffer.concat([prefix, line]) : line;
    const n = fs.writeSync(fd, buf, 0, buf.length);
    if (n !== buf.length) {
      try {
        fs.writeSync(fd, Buffer.from('\n')); // isolate the fragment from the next writer
      } catch {
        /* reported below */
      }
      throw new OrchError(`short write to the ledger (${n}/${buf.length} bytes); the fragment is isolated on its own line - inspect ${file}`, 'ledger-write');
    }
  } catch (e) {
    writeMarker(markerFile, { ...markerDoc, state: 'failed', error: String((e && e.message) || e) });
    throw e;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  // Read back: the row must be in the ledger, whole, before the marker says so.
  const back = readLedger(file).rows.some((r) => r.run_id === id && r.recorded_at === row.recorded_at);
  writeMarker(markerFile, { ...markerDoc, state: back ? 'recorded' : 'failed', error: back ? null : 'row not found on read-back' });
  if (!back) throw new OrchError(`the ledger row for ${id} was not found on read-back - inspect ${file}`, 'ledger-write');
  emit(args, io, { record: 'appended', ledger: file, row }, `recorded ${id}: ${workload} ${row.model_canonical} -> ${disposition} (${file})`);
  return { record: 'appended', ledger: file, row, exitCode: 0 };
}

function writeMarker(file, doc) {
  writeJsonAtomic(file, doc);
}

/**
 * Pure and deterministic: the pick for a workload, given the roster, the ledger rows and
 * (for a review) the implementer's models.
 */
export function computePick({ roster, rows, workload, size, implementerModels = [] }) {
  if (!WORKLOADS.includes(workload)) throw new OrchError('--workload must be implement or review', 'bad-workload');
  if (!SIZES.includes(size)) throw new OrchError('--size must be XS, S or M', 'bad-size');
  const implCanon = new Set(implementerModels.map(canonicalId).filter(Boolean));
  const implFam = new Set(implementerModels.map((m) => familyOf(m, roster)).filter(Boolean));
  const excluded = [];
  const cands = [];
  roster.forEach((m, idx) => {
    const c = canonicalId(m.model);
    const tag = `${m.cli} ${m.model}`;
    if (!(m.workloads || []).includes(workload)) return excluded.push({ model: tag, why: `not suited to ${workload}` });
    if (m.requires_permission) return excluded.push({ model: tag, why: 'needs the owner\'s permission per run' });
    if (m.lane === 'local' && !['XS', 'S'].includes(size)) return excluded.push({ model: tag, why: `local models only for XS/S (size ${size})` });
    if (workload === 'review' && implCanon.has(c)) return excluded.push({ model: tag, why: 'the implementer\'s own model' });
    const mine = rows.filter((r) => r.workload === workload && canonicalId(r.model_canonical || r.model_actual || r.model_requested) === c);
    const failures = mine.filter((r) => FAILURE_DISPOSITIONS.has(r.disposition)).length;
    if (failures >= 2) return excluded.push({ model: tag, why: `${failures} recorded ${workload} failures` });
    const fam = familyOf(m.model, roster);
    cands.push({ entry: m, idx, canonical: c, runs: mine.length, failures, family: fam, sameFamily: workload === 'review' && implFam.has(fam) });
  });
  cands.sort((a, b) => (a.sameFamily === b.sameFamily ? 0 : a.sameFamily ? 1 : -1) || a.runs - b.runs || a.idx - b.idx);
  if (!cands.length) return { pick: null, reason: `no suited model for ${workload} ${size}`, excluded, candidates: [] };
  const best = cands[0];
  const parts = [`${best.runs} recorded ${workload} run${best.runs === 1 ? '' : 's'} (fewest among ${cands.length} suited)`];
  if (workload === 'review' && implCanon.size) parts.push(best.sameFamily ? `SAME family as the implementer (${best.family}) - no other family available` : `family ${best.family} differs from the implementer's`);
  if (best.failures) parts.push(`${best.failures} recorded failure`);
  return {
    pick: { cli: best.entry.cli, model: best.entry.model, canonical: best.canonical, family: best.family, lane: best.entry.lane, cost_class: best.entry.cost_class || null },
    reason: parts.join('; '),
    candidates: cands.map((c) => ({ cli: c.entry.cli, model: c.entry.model, runs: c.runs, failures: c.failures, same_family: c.sameFamily })),
    excluded,
  };
}

export async function cmdPick(cfg, args, io) {
  const workload = String(args.workload || '');
  const size = String(args.size || '');
  const { models: roster, file: rosterFile } = loadRoster(args.roster);
  const ledger = ledgerPath(cfg, args);
  const { rows, bad } = readLedger(ledger);
  let implementerModels = [];
  if (args['for-run']) {
    const runId = String(args['for-run']);
    const impl = readRun(cfg, runId);
    // Code-review fix a5: a pruned run directory is not fatal when the ledger has the row.
    const row = impl ? null : [...rows].reverse().find((r) => r.run_id === runId);
    if (!impl && !row) throw new OrchError(`no such run: ${runId} (no run record and no ledger row)`, 'no-such-run');
    implementerModels = (impl ? [impl.model_requested, impl.model_actual] : [row.model_requested, row.model_actual, row.model_canonical]).filter(Boolean);
  } else if (workload === 'review') {
    throw new OrchError('a review pick needs --for-run <implementer run id> (the reviewer must differ from the implementer)', 'missing-arg');
  }
  const res = computePick({ roster, rows, workload, size, implementerModels });
  const out = { workload, size, ...res, ledger, ledger_rows: rows.length, ledger_unreadable_lines: bad, roster: rosterFile };
  if (args.json) io.log(JSON.stringify(out, null, 2));
  else if (res.pick) io.log(`pick: ${res.pick.cli} ${res.pick.model} - ${res.reason}`);
  else io.log(`pick: none - ${res.reason}`);
  return { ...out, exitCode: res.pick ? 0 : 3 };
}

function emit(args, io, obj, text) {
  if (args.json) io.log(JSON.stringify(obj, null, 2));
  else io.log(text);
}
