// The review gate (slice 2, ORCHESTRATOR §6). The ORCHESTRATOR judges every finding
// (severity, in scope, confirmed); this file only records those judgments and computes
// their consequences. Nothing here asks a model anything.
//
// Rules, exactly as computed by `computeGate`:
//  - a finding COUNTS unless it re-raises a finding refuted in an earlier round (same
//    `id`, or `reraised_of` naming it) - such a finding is listed and ignored;
//  - BLOCKING = counted AND in scope AND confirmed AND severity H or M;
//  - converged(round) = no blocking finding AND verification pass AND scope pass
//    (scope `unknown` is not pass);
//  - the same area BLOCKING in two consecutive rounds -> `escalate-design` (stop, go to
//    the owner);
//  - max 3 rounds; a 4th only when round 3 has a counted in-scope confirmed High; never a 5th.
//
// Files: <state-root>/gates/<wp-key>/<slice-key>/round-<n>.json, each created once
// (exclusive publication; a round is never rewritten).
import fs from 'node:fs';
import path from 'node:path';
import { OrchError } from './errors.mjs';
import { nowIso, readJson } from './util.mjs';
import { publishExclusive } from './exclusive.mjs';
import { wpKey } from './claims.mjs';
import { sliceKey } from './worktrees.mjs';

const SEV = { h: 'H', high: 'H', m: 'M', medium: 'M', l: 'L', low: 'L' };
const STATUSES = ['confirmed', 'refuted', 'unverifiable', 'filed'];
export const MAX_ROUNDS = 3;
export const HARD_MAX_ROUNDS = 4;

function yesNo(v, where) {
  if (v === true || v === 'yes' || v === 'true' || v === 'y') return true;
  if (v === false || v === 'no' || v === 'false' || v === 'n') return false;
  throw new OrchError(`${where}: in_scope must be yes/no (got ${JSON.stringify(v)})`, 'bad-finding');
}

/** Validate and normalise the orchestrator's findings. Every judgment is mandatory. */
export function normalizeFindings(list) {
  if (!Array.isArray(list)) throw new OrchError('--findings must be a JSON array', 'bad-findings');
  return list.map((f, i) => {
    const where = `finding #${i + 1}`;
    if (!f || typeof f !== 'object') throw new OrchError(`${where}: not an object`, 'bad-finding');
    const sev = SEV[String(f.severity ?? '').toLowerCase()];
    if (!sev) throw new OrchError(`${where}: severity must be H, M or L`, 'bad-finding');
    const status = String(f.status ?? '').toLowerCase();
    if (!STATUSES.includes(status)) throw new OrchError(`${where}: status must be one of ${STATUSES.join(', ')}`, 'bad-finding');
    const area = String(f.area ?? '').trim();
    if (!area) throw new OrchError(`${where}: area is required`, 'bad-finding');
    return {
      ...f,
      id: f.id !== undefined && f.id !== null && f.id !== '' ? String(f.id) : null,
      reraised_of: f.reraised_of ? String(f.reraised_of) : null,
      severity: sev,
      in_scope: yesNo(f.in_scope ?? f.inScope, where),
      status,
      area,
    };
  });
}

const areaKey = (a) => String(a).trim().toLowerCase();

/**
 * Pure: the gate decision for an ordered list of rounds.
 * @param {Array<{round:number, findings:any[], verification:string, scope:string}>} rounds
 * @returns {any} one shape per decision; `decision`, `reason`, `rounds_used`, `per_round` always present
 */
export function computeGate(rounds) {
  const sorted = [...rounds].sort((a, b) => a.round - b.round);
  const refuted = new Map(); // id -> round it was refuted in
  const per = [];
  for (const r of sorted) {
    const counted = [];
    const reraised = [];
    for (const f of r.findings || []) {
      const key = f.reraised_of || f.id;
      if (key && refuted.has(key)) {
        reraised.push({ ...f, refuted_in_round: refuted.get(key) });
        continue;
      }
      counted.push(f);
    }
    for (const f of r.findings || []) if (f.id && f.status === 'refuted' && !refuted.has(f.id)) refuted.set(f.id, r.round);
    const blocking = counted.filter((f) => f.in_scope && f.status === 'confirmed' && (f.severity === 'H' || f.severity === 'M'));
    const highs = blocking.filter((f) => f.severity === 'H');
    const converged = blocking.length === 0 && r.verification === 'pass' && r.scope === 'pass';
    per.push({
      round: r.round,
      verification: r.verification,
      scope: r.scope,
      blocking: blocking.length,
      blocking_highs: highs.length,
      blocking_areas: [...new Set(blocking.map((f) => areaKey(f.area)))],
      reraised_refuted: reraised.map((f) => ({ id: f.id || f.reraised_of, area: f.area, refuted_in_round: f.refuted_in_round })),
      converged,
    });
  }
  if (!per.length) return { decision: 'no-rounds', reason: 'no round recorded yet', rounds_used: 0, next_round: 1, per_round: [] };
  const last = per[per.length - 1];
  const prev = per.length > 1 ? per[per.length - 2] : null;
  const base = { rounds_used: per.length, per_round: per };
  if (last.converged) {
    return { ...base, decision: 'converged', reason: `round ${last.round}: no in-scope confirmed High/Medium, verification pass, scope pass`, next_round: null };
  }
  const why = [];
  if (last.blocking) why.push(`${last.blocking} in-scope confirmed H/M (areas: ${last.blocking_areas.join(', ')})`);
  if (last.verification !== 'pass') why.push(`verification ${last.verification}`);
  if (last.scope !== 'pass') why.push(`scope ${last.scope}`);
  const notConv = `round ${last.round} not converged: ${why.join('; ')}`;
  if (prev && prev.round === last.round - 1) {
    const same = last.blocking_areas.filter((a) => prev.blocking_areas.includes(a));
    if (same.length) {
      return { ...base, decision: 'escalate-design', reason: `${notConv}. Area(s) ${same.join(', ')} failed in rounds ${prev.round} and ${last.round}: a design problem - stop and go to the owner`, next_round: null, areas: same };
    }
  }
  if (last.round >= HARD_MAX_ROUNDS) {
    return { ...base, decision: 'stop-round-cap', reason: `${notConv}. ${HARD_MAX_ROUNDS} rounds used; no further round is allowed - go to the owner`, next_round: null };
  }
  if (last.round >= MAX_ROUNDS) {
    if (last.blocking_highs > 0) {
      return { ...base, decision: 'another-round', reason: `${notConv}. A 4th round is allowed: round ${last.round} has ${last.blocking_highs} in-scope confirmed High`, next_round: last.round + 1, fourth_round_exception: true };
    }
    return { ...base, decision: 'stop-round-cap', reason: `${notConv}. ${MAX_ROUNDS} rounds used and no in-scope confirmed High justifies a 4th - go to the owner`, next_round: null };
  }
  return { ...base, decision: 'another-round', reason: notConv, next_round: last.round + 1 };
}

const gateDir = (cfg, wp, slice) => path.join(cfg.stateRoot, 'gates', wpKey(wp), sliceKey(slice));

export function readRounds(cfg, wp, slice) {
  const dir = gateDir(cfg, wp, slice);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^round-\d+\.json$/.test(f));
  } catch {
    files = [];
  }
  return files.map((f) => readJson(path.join(dir, f), null)).filter(Boolean).sort((a, b) => a.round - b.round);
}

function parseFindingsArg(v) {
  const s = String(v ?? '').trim();
  if (!s) throw new OrchError('--findings is required (a JSON array, or a path to a JSON file; [] for none)', 'missing-arg');
  let text = s;
  if (!(s.startsWith('[') || s.startsWith('{'))) {
    if (!fs.existsSync(s)) throw new OrchError(`--findings is neither JSON nor an existing file: ${s}`, 'bad-findings');
    text = fs.readFileSync(s, 'utf8').replace(/^﻿/, '');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new OrchError(`--findings is not valid JSON: ${(e && e.message) || e}`, 'bad-findings');
  }
}

export async function cmdGate(cfg, args, io) {
  const sub = (args._ || [])[0];
  if (sub === 'record') return gateRecord(cfg, args, io);
  if (sub === 'status') return gateStatus(cfg, args, io);
  throw new OrchError('usage: orch gate record|status --wp <WP> --slice <id> ...', 'missing-arg');
}

async function gateRecord(cfg, args, io) {
  const wp = req(args, 'wp');
  const slice = req(args, 'slice');
  const round = Number(req(args, 'round'));
  if (!Number.isInteger(round) || round < 1) throw new OrchError('--round must be a positive integer', 'bad-round');
  const verification = String(req(args, 'verification'));
  if (!['pass', 'fail'].includes(verification)) throw new OrchError('--verification must be pass or fail', 'bad-verification');
  let scope;
  let scopeSource;
  if (args['scope-run']) {
    const s = readJson(path.join(cfg.runsDir, String(args['scope-run']), 'scope.json'), null);
    scope = s && ['pass', 'fail'].includes(s.result) ? s.result : 'unknown';
    scopeSource = `orch scope ${args['scope-run']}${s ? ` at ${s.checked_at}` : ' (no scope.json: never checked)'}`;
  } else {
    scope = String(req(args, 'scope'));
    if (!['pass', 'fail'].includes(scope)) throw new OrchError('--scope must be pass or fail (or use --scope-run <run-id>)', 'bad-scope');
    scopeSource = 'operator';
  }
  const findings = normalizeFindings(parseFindingsArg(args.findings));

  const prior = readRounds(cfg, wp, slice);
  const expectedRound = prior.length ? prior[prior.length - 1].round + 1 : 1;
  const override = args['override-reason'] ? String(args['override-reason']) : null;
  if (round !== expectedRound) {
    throw new OrchError(`--round ${round} is out of order: the next round for ${wp}/${slice} is ${expectedRound}`, 'bad-round');
  }
  if (prior.length) {
    const g = computeGate(prior);
    if (g.decision !== 'another-round' && !override) {
      throw new OrchError(`refused: the gate for ${wp}/${slice} already decided "${g.decision}" (${g.reason}). Recording another round needs --override-reason <text>.`, 'gate-closed');
    }
  }
  const rec = {
    wp,
    slice,
    round,
    findings,
    verification,
    scope,
    scope_source: scopeSource,
    by: args.by || null,
    override_reason: override,
    recorded_at: nowIso(),
  };
  const file = path.join(gateDir(cfg, wp, slice), `round-${round}.json`);
  const res = publishExclusive(file, JSON.stringify(rec, null, 2) + '\n');
  if (!res.created) throw new OrchError(`round ${round} of ${wp}/${slice} is already recorded (rounds are never rewritten)`, 'round-exists');
  const g = computeGate([...prior, rec]);
  const out = { recorded: { wp, slice, round, findings: findings.length, verification, scope }, gate: g };
  emit(args, io, out, `recorded ${wp}/${slice} round ${round}\n${gateText(g)}`);
  return { ...out, exitCode: 0 };
}

async function gateStatus(cfg, args, io) {
  const wp = req(args, 'wp');
  const slice = req(args, 'slice');
  const g = computeGate(readRounds(cfg, wp, slice));
  emit(args, io, { wp, slice, ...g }, `${wp}/${slice}\n${gateText(g)}`);
  const code = g.decision === 'converged' ? 0 : g.decision === 'another-round' ? 3 : g.decision === 'no-rounds' ? 4 : 5;
  return { wp, slice, ...g, exitCode: code };
}

function gateText(g) {
  const lines = [`decision: ${g.decision}`, `reason: ${g.reason}`, `rounds used: ${g.rounds_used}${g.next_round ? `; next round: ${g.next_round}` : ''}`];
  for (const r of g.per_round || []) {
    for (const x of r.reraised_refuted) lines.push(`  round ${r.round}: finding ${x.id} (${x.area}) re-raises one refuted in round ${x.refuted_in_round} - not counted`);
  }
  return lines.join('\n');
}

function req(args, name) {
  const v = args[name];
  if (v === undefined || v === null || v === '' || v === true) throw new OrchError(`--${name} is required`, 'missing-arg');
  return Array.isArray(v) ? v[v.length - 1] : v;
}

function emit(args, io, obj, text) {
  if (args.json) io.log(JSON.stringify(obj, null, 2));
  else io.log(text);
}
