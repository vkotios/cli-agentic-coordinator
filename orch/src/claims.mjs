// Work-package claims (slice 2, ORCHESTRATOR §1: one orchestrator per WP).
//
// A claim is an EXPLICIT record, released explicitly. It is never "reclaimed" because
// its owner looks dead: there is no liveness guess anywhere in this file. A stale claim
// is SHOWN (holder, age) by `orch claims`, and only an explicit `--force` by the
// operator removes it - and that is recorded.
//
// Files (all under <state-root>/claims/):
//   <wp-key>.json           the live claim; created by `orch claim` via publishExclusive
//                           (hard link: exclusive AND never half-written)
//   released/<...>.json     a released claim, moved aside by `orch release` (atomic rename)
//   claims-log.ndjson       append-only history: claim / release / force-release
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { OrchError } from './errors.mjs';
import { nowIso, readJson } from './util.mjs';
import { publishExclusive, readRecord } from './exclusive.mjs';

export const CLAIMANTS = ['claude-code', 'codex', 'owner'];

/** A WP name is also a file name: restrict it, and fold case (NTFS is case-insensitive). */
export function wpKey(wp) {
  const s = String(wp ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(s)) {
    throw new OrchError(`invalid work-package name "${s}" (letters, digits, . _ - ; max 80; must start with a letter or digit)`, 'bad-wp');
  }
  return s.toLowerCase();
}

export function assertClaimant(by) {
  if (!CLAIMANTS.includes(String(by))) {
    throw new OrchError(`--by must be one of ${CLAIMANTS.join(', ')} (got "${by ?? ''}")`, 'bad-by');
  }
  return String(by);
}

const claimsDir = (cfg) => path.join(cfg.stateRoot, 'claims');
const claimFile = (cfg, wp) => path.join(claimsDir(cfg), `${wpKey(wp)}.json`);
const logFile = (cfg) => path.join(claimsDir(cfg), 'claims-log.ndjson');

function appendLog(cfg, obj) {
  fs.mkdirSync(claimsDir(cfg), { recursive: true });
  // One write per line through an O_APPEND handle (FILE_APPEND_DATA on Windows).
  fs.appendFileSync(logFile(cfg), JSON.stringify({ at: nowIso(), ...obj }) + '\n');
}

export function ageText(fromIso, nowMs = Date.now()) {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return 'unknown';
  let s = Math.max(0, Math.round((nowMs - t) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${m}m`;
  if (m) return `${m}m${s}s`;
  return `${s}s`;
}

function holderText(c) {
  return `${c.by}${c.session ? ` (${c.session})` : ''} since ${c.claimed_at} (age ${ageText(c.claimed_at)})`;
}

/** The current claim on a WP: `{state:'absent'|'ok'|'unreadable', value?}`. */
export function readClaim(cfg, wp) {
  return readRecord(claimFile(cfg, wp));
}

/**
 * Refuse unless `by` holds the claim on `wp`. Used by `orch run --wp`, `orch worktree
 * create` and `orch review`. An unreadable claim is NOT a pass.
 */
export function requireClaim(cfg, wp, by) {
  assertClaimant(by);
  const r = readClaim(cfg, wp);
  if (r.state === 'absent') {
    throw new OrchError(`work package ${wp} is not claimed. Run \`orch claim ${wp} --by ${by}\` first.`, 'not-claimed');
  }
  if (r.state !== 'ok') {
    throw new OrchError(`the claim on ${wp} is unreadable (${r.error}); refusing rather than guessing who holds it`, 'claim-unreadable');
  }
  if (r.value.by !== by) {
    throw new OrchError(`work package ${wp} is held by ${holderText(r.value)}, not by ${by}`, 'claim-held-by-other');
  }
  return r.value;
}

export async function cmdClaim(cfg, args, io) {
  const wp = (args._ || [])[0];
  if (!wp) throw new OrchError('usage: orch claim <WP> --by <claude-code|codex|owner> [--session <label>] [--note <text>]', 'missing-arg');
  const key = wpKey(wp);
  const by = assertClaimant(args.by);
  const rec = {
    wp,
    wp_key: key,
    by,
    session: args.session || null,
    note: args.note || null,
    token: crypto.randomBytes(8).toString('hex'),
    claimed_at: nowIso(),
    claimed_by_pid: process.pid,
    host: os.hostname(),
  };
  const res = publishExclusive(claimFile(cfg, wp), JSON.stringify(rec, null, 2) + '\n');
  if (res.created) {
    appendLog(cfg, { event: 'claim', wp, by, session: rec.session, token: rec.token });
    const out = { wp, claim: 'acquired', by, token: rec.token, claimed_at: rec.claimed_at };
    emit(args, io, out, `claimed ${wp} for ${by}`);
    return { ...out, exitCode: 0 };
  }
  // Refused: name the current holder. A hard-linked record is complete when visible; the
  // `wx` fallback can be caught mid-write, so re-read briefly before saying `unknown`.
  let cur = readClaim(cfg, wp);
  for (let i = 0; i < 10 && cur.state === 'unreadable'; i++) {
    await new Promise((r) => setTimeout(r, 30));
    cur = readClaim(cfg, wp);
  }
  const holder = cur.state === 'ok' ? cur.value : null;
  const out = {
    wp,
    claim: 'refused',
    holder: holder ? { by: holder.by, session: holder.session, claimed_at: holder.claimed_at, age: ageText(holder.claimed_at), token: holder.token } : null,
    holder_state: cur.state,
  };
  emit(args, io, out, `claim refused: ${wp} is held by ${holder ? holderText(holder) : `an unreadable claim (${cur.state})`}`);
  return { ...out, exitCode: 3 };
}

export async function cmdRelease(cfg, args, io) {
  const wp = (args._ || [])[0];
  if (!wp) throw new OrchError('usage: orch release <WP> --by <claude-code|codex|owner> [--force --reason <text>]', 'missing-arg');
  const key = wpKey(wp);
  const by = assertClaimant(args.by);
  const force = !!args.force;
  const file = claimFile(cfg, wp);
  const cur = readClaim(cfg, wp);
  if (cur.state === 'absent') {
    const out = { wp, release: 'not-claimed' };
    emit(args, io, out, `${wp} is not claimed; nothing released`);
    return { ...out, exitCode: 3 };
  }
  if (cur.state !== 'ok' && !force) {
    const out = { wp, release: 'refused', reason: `claim unreadable (${cur.error}); only --force can remove it` };
    emit(args, io, out, `release refused: ${out.reason}`);
    return { ...out, exitCode: 3 };
  }
  const holder = cur.state === 'ok' ? cur.value : null;
  if (holder && holder.by !== by && !force) {
    const out = { wp, release: 'refused', holder: holder.by, reason: `held by ${holderText(holder)}; only the holder, or --force, may release it` };
    emit(args, io, out, `release refused: ${wp} is held by ${holderText(holder)}, not by ${by}. Use --force (recorded) to override.`);
    return { ...out, exitCode: 3 };
  }
  if (force && !args.reason) {
    throw new OrchError('--force needs --reason <text>: a forced release is recorded with who and why', 'missing-arg');
  }

  // Take the claim atomically by renaming it aside, then prove it is the claim we judged.
  const releasedDir = path.join(claimsDir(cfg), 'released');
  fs.mkdirSync(releasedDir, { recursive: true });
  const aside = path.join(releasedDir, `${key}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`);
  try {
    fs.renameSync(file, aside);
  } catch (/** @type {any} */ e) {
    if (e && e.code === 'ENOENT') {
      const out = { wp, release: 'not-claimed', reason: 'released concurrently by someone else' };
      emit(args, io, out, `${wp}: the claim disappeared while releasing (released concurrently); nothing done`);
      return { ...out, exitCode: 3 };
    }
    throw e;
  }
  const taken = readJson(aside, null);
  if (holder && (!taken || taken.token !== holder.token)) {
    // A different claim replaced the one we judged between our read and our rename.
    // Put it back; if that fails, say so loudly instead of guessing.
    let restored = false;
    try {
      fs.linkSync(aside, file);
      fs.unlinkSync(aside);
      restored = true;
    } catch {
      restored = false;
    }
    const out = { wp, release: 'refused', reason: 'the claim changed during release', restored, aside: restored ? null : aside };
    emit(args, io, out, `release refused: the claim on ${wp} changed while releasing; ${restored ? 'it was put back untouched' : `COULD NOT RESTORE it - it is at ${aside}`}`);
    return { ...out, exitCode: 3 };
  }
  const forced = force && (!holder || holder.by !== by);
  appendLog(cfg, {
    event: forced ? 'force-release' : 'release',
    wp,
    by,
    reason: args.reason || null,
    previous: taken || { unreadable: true },
    aside,
  });
  const out = { wp, release: forced ? 'force-released' : 'released', by, previous_holder: taken ? taken.by : null, forced, reason: args.reason || null, aside };
  emit(
    args,
    io,
    out,
    forced
      ? `FORCE-released ${wp} (was held by ${taken ? holderText(taken) : 'an unreadable claim'}) by ${by}: ${args.reason}. Recorded in ${logFile(cfg)}`
      : `released ${wp} (${by})`,
  );
  return { ...out, exitCode: 0 };
}

export async function cmdClaims(cfg, args, io) {
  const dir = claimsDir(cfg);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    files = [];
  }
  const rows = [];
  for (const f of files.sort()) {
    const r = readRecord(path.join(dir, f));
    if (r.state === 'ok') {
      const c = r.value;
      rows.push({ wp: c.wp, by: c.by, session: c.session || null, claimed_at: c.claimed_at, age: ageText(c.claimed_at), age_s: Math.round((Date.now() - Date.parse(c.claimed_at)) / 1000), note: c.note || null });
    } else {
      rows.push({ wp: f.replace(/\.json$/, ''), by: null, state: r.state, error: r.error || null });
    }
  }
  if (args.json) io.log(JSON.stringify({ claims: rows }, null, 2));
  else if (!rows.length) io.log('(no claims)');
  else {
    for (const r of rows) {
      if (!r.by) io.log(`${r.wp}  UNREADABLE (${r.error})`);
      else io.log(`${r.wp}  held by ${r.by}${r.session ? ` (${r.session})` : ''}  age ${r.age}  since ${r.claimed_at}${r.note ? `  - ${r.note}` : ''}`);
    }
    io.log('note: a claim is never reclaimed automatically; an old one is released by its holder or with --force (recorded).');
  }
  return { claims: rows, exitCode: 0 };
}

function emit(args, io, obj, text) {
  if (args.json) io.log(JSON.stringify(obj, null, 2));
  else io.log(text);
}
