// Explicit cleanup and package closure. Retention collection is a separate policy.
import fs from 'node:fs';
import path from 'node:path';
import { OrchError } from './errors.mjs';
import { wpKey, readClaim, requireClaim, cmdRelease } from './claims.mjs';
import { listRuns, TERMINAL } from './store.mjs';
import { nowIso, writeJsonAtomic } from './util.mjs';
import { ledgerPath, readLedger } from './ledger.mjs';
import { readRounds, computeGate } from './gate.mjs';
import { listResources, recordsIn, readResource, saveResource, withWpOperation, withResourceLock, inspectRemoval, removeResource, dependentRunBlock, cleanupAuthority, readClosure, closureFile } from './resources.mjs';

const emit = (args, io, out) => io.log(args.json ? JSON.stringify(out, null, 2) : [
  `${out.wp}: ${out.state}`,
  ...(out.issues || []).map((issue) => `  ${issue}`),
  ...(out.resources || []).map((r) => `  ${r.id}: ${r.state || r.action}${r.reason ? ` (${r.reason})` : ''}`),
].join('\n'));
const sameWp = (a, b) => a && wpKey(a) === wpKey(b);
const needsRetention = (resources) => resources.some((r) => r.action === 'retain' && !r.intentional);
function inventory(cfg, wp) {
  const owned = listResources(cfg).filter((r) => sameWp(r.wp, wp));
  const known = new Set(owned.map((r) => r.id));
  const legacy = [...recordsIn(path.join(cfg.stateRoot, 'worktrees')), ...recordsIn(path.join(cfg.stateRoot, 'reviews'))]
    .filter((r) => sameWp(r.wp, wp) && !known.has(r.id) && !r.removed_at && !r.worktree_removed)
    .map((r) => ({ id: r.id, state: 'retained', action: 'retain', reason: 'legacy or foreign resource: confirmed ownership unavailable', legacy: true }));
  return { owned, legacy };
}
function retentionDecisions(file, ids) {
  if (!file) return new Map();
  let rows;
  try { rows = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch { throw new OrchError('--retain needs a readable JSON decision file', 'bad-retention'); }
  if (!Array.isArray(rows)) throw new OrchError('--retain must contain an array', 'bad-retention');
  const out = new Map();
  for (const r of rows) {
    if (!r || !ids.has(r.id) || out.has(r.id) || typeof r.reason !== 'string' || !r.reason.trim() || typeof r.revisit !== 'string' || !r.revisit.trim()) throw new OrchError('each retention needs a unique resource id, reason and revisit condition', 'bad-retention');
    out.set(r.id, { reason: r.reason.trim(), revisit: r.revisit.trim() });
  }
  return out;
}

async function cleanupLocked(cfg, args) {
  const wp = args.wp;
  const { owned, legacy } = inventory(cfg, wp);
  const retained = retentionDecisions(args.retain, new Set([...owned, ...legacy].map((r) => r.id)));
  const previous = readClosure(cfg, wp);
  const reviews = recordsIn(path.join(cfg.stateRoot, 'reviews'));
  const resources = [];
  for (const initial of owned) {
    const inspect = async () => {
      const r = readResource(cfg, initial.id);
      const artifacts = (r.artifacts || []).map((a) => ({ ...a, cleanup: 'retained-audit', reason: 'review prompt evidence', revisit: 'configured evidence retention policy' }));
      if (r.state === 'removed') return { id: r.id, state: 'removed', action: 'none', artifacts };
      const decision = retained.get(r.id) || r.retention;
      if (decision) {
        if (args.apply) { r.retention = decision; r.state = 'retained'; saveResource(cfg, r); }
        return { id: r.id, state: 'retained', action: 'retain', ...decision, intentional: true, artifacts };
      }
      const review = reviews.find((v) => v.id === r.review_id);
      if (!args.apply) return { id: r.id, state: r.state, artifacts, ...await inspectRemoval(cfg, r, { review }) };
      const authority = cleanupAuthority(cfg, wp, args.by); // recheck authorization at deletion
      if (r.claim_token && r.claim_token !== authority.token) return { id: r.id, state: 'retained', action: 'retain', reason: 'resource belongs to an earlier claim; explicit retention required', artifacts };
      return { ...await removeResource(cfg, r, { review }), artifacts };
    };
    resources.push(args.apply ? await withResourceLock(cfg, initial, inspect) : await inspect());
  }
  for (const r of legacy) {
    const saved = previous && (previous.resources || []).find((v) => v.id === r.id && v.intentional && v.reason && v.revisit);
    const decision = retained.get(r.id) || saved && { reason: saved.reason, revisit: saved.revisit };
    resources.push(decision ? { ...r, ...decision, intentional: true } : r);
  }
  const pending = resources.some((r) => r.state === 'cleanup-pending');
  const unresolved = resources.some((r) => r.action === 'retain' && !r.intentional);
  return { wp, state: pending ? 'cleanup-pending' : unresolved ? 'retained' : 'complete', dry_run: !args.apply, resources, exitCode: args.apply && (pending || unresolved) ? 3 : 0 };
}
export async function cmdCleanup(cfg, args, io) {
  if (!args.wp || args.wp === true) throw new OrchError('usage: orch cleanup --wp <WP> --dry-run | --apply --by <holder>', 'missing-arg');
  wpKey(args.wp);
  if (!!args.apply === !!args['dry-run']) throw new OrchError('choose exactly one of --dry-run and --apply', 'missing-arg');
  if (args.force || args['delete-branch']) throw new OrchError('package cleanup does not discard content or delete branches', 'bad-cleanup-option');
  const perform = async () => {
    if (args.apply) cleanupAuthority(cfg, args.wp, args.by);
    const out = await cleanupLocked(cfg, args);
    emit(args, io, out);
    return out;
  };
  return args.apply ? withWpOperation(cfg, args.wp, perform) : perform();
}

export async function cmdFinish(cfg, args, io) {
  const wp = (args._ || [])[0];
  if (!wp || !args.by) throw new OrchError('usage: orch finish <WP> --by <holder> [--retain <decisions.json>]', 'missing-arg');
  if (args.force || args['dry-run'] || args['delete-branch']) throw new OrchError('finish does not support --force, --dry-run or --delete-branch; preview with cleanup --dry-run', 'bad-cleanup-option');
  return withWpOperation(cfg, wp, async () => {
    const previous = readClosure(cfg, wp);
    const authority = cleanupAuthority(cfg, wp, args.by);
    const current = readClaim(cfg, wp);
    if (previous && previous.closed_at && previous.claim_token === authority.token) {
      // Resume after interrupted claim release or failed directory removal.
      const cleanup = await cleanupLocked(cfg, { ...args, wp, apply: true });
      const unresolved = needsRetention(cleanup.resources);
      const out = { ...previous, state: unresolved ? 'retained' : cleanup.state === 'cleanup-pending' ? 'cleanup-pending' : 'finished', issues: unresolved ? ['explicit retained-resource decisions required'] : [], resources: cleanup.resources, updated_at: nowIso() };
      writeJsonAtomic(closureFile(cfg, wp), out);
      if (current.state === 'ok') {
        const release = await cmdRelease(cfg, { _: [wp], by: args.by }, { log() {} });
        if (release.exitCode) { emit(args, io, { ...out, state: 'release-pending' }); return { ...out, state: 'release-pending', exitCode: 3 }; }
      }
      emit(args, io, out);
      return { ...out, exitCode: out.state === 'finished' ? 0 : 3 };
    }
    requireClaim(cfg, wp, args.by);
    const issues = [];
    // Strictly read the complete inventory; corrupt/missing run files are blockers.
    if (fs.existsSync(cfg.runsDir)) for (const id of fs.readdirSync(cfg.runsDir)) {
      if (!fs.statSync(path.join(cfg.runsDir, id)).isDirectory()) continue;
      try { JSON.parse(fs.readFileSync(path.join(cfg.runsDir, id, 'run.json'), 'utf8')); } catch { issues.push(`run inventory unreadable: ${id}`); }
    }
    const runs = listRuns(cfg).filter((r) => sameWp(r.wp, wp));
    const ledger = readLedger(ledgerPath(cfg));
    if (ledger.bad) issues.push('ledger has unreadable rows');
    const reviews = recordsIn(path.join(cfg.stateRoot, 'reviews')).filter((r) => sameWp(r.wp, wp));
    for (const run of runs) {
      if (!TERMINAL.has(run.status)) issues.push(`run ${run.id} not terminal`);
      const active = await dependentRunBlock(cfg, { id: run.scope && run.scope.worktree_id, path: run.dir_real || run.dir });
      if (active) issues.push(active);
      const row = ledger.rows.find((r) => r.run_id === run.id);
      if (!row) issues.push(`run ${run.id} has no recorded disposition`);
      else if (run.role !== 'review' && row.disposition.startsWith('accepted')) {
        const gate = computeGate(readRounds(cfg, wp, run.slice));
        if (gate.decision !== 'converged') issues.push(`slice ${run.slice} lacks a converged acceptance gate`);
        if (!reviews.some((r) => r.implementer_run === run.id && r.finished_at && r.outcome === 'reviewed' && r.containment === 'clean')) issues.push(`run ${run.id} lacks a clean completed independent review`);
      }
    }
    for (const review of reviews) if (!review.finished_at) issues.push(`review ${review.id} not finalized`);
    if (issues.length) {
      const out = { wp, state: 'incomplete', issues, exitCode: 3 };
      emit(args, io, out);
      return out;
    }
    const cleanup = await cleanupLocked(cfg, { ...args, wp, apply: true });
    // Failed removal is retryable; an unexplained retain decision is not closure.
    if (needsRetention(cleanup.resources)) {
      const out = { ...cleanup, state: 'incomplete', issues: ['explicit retained-resource decisions required'], exitCode: 3 };
      emit(args, io, out);
      return out;
    }
    const out = { wp, by: args.by, claim_token: authority.token, closed_at: nowIso(), state: cleanup.state === 'cleanup-pending' ? 'cleanup-pending' : 'finished', run_ids: runs.map((r) => r.id), resources: cleanup.resources };
    writeJsonAtomic(closureFile(cfg, wp), out); // durable receipt BEFORE claim release
    const release = await cmdRelease(cfg, { _: [wp], by: args.by }, { log() {} });
    if (release.exitCode) { emit(args, io, { ...out, state: 'release-pending' }); return { ...out, state: 'release-pending', exitCode: 3 }; }
    emit(args, io, out);
    return { ...out, exitCode: out.state === 'finished' ? 0 : 3 };
  });
}
