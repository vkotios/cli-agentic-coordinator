// Current liveness is separate from the immutable monitor ancestry observation.
// No names, kill operations, run writes or cached deletion authority.
import { normalizeCreationTime, readProcessTable, verifyIdentity } from './procs.mjs';
import { creationPoint } from './process-time.mjs';

const readableBirth = value => {
  if (typeof value !== 'string') return false;
  const point = creationPoint(normalizeCreationTime(value));
  return point !== null && (point.kind !== 'wall' || point.value >= 0);
};

export async function reconcileHelpers(record, deadline) {
  const out = { state: 'protected', reason: null, checked_at: null, identities: [] };
  const refuse = reason => ({ ...out, reason });
  if (record.helper_audit !== undefined && !['observed', 'not-applicable'].includes(record.helper_audit?.state)) return refuse('helper ancestry unverified');
  const helpers = record.escaped_helpers === undefined ? [] : record.escaped_helpers;
  if (!Array.isArray(helpers) || helpers.length > 60) return refuse('helper inventory unreadable or exceeds bound');
  if (!helpers.length) return { ...out, state: 'quiescent' };
  if (record.helper_audit?.state !== 'observed') return refuse('helper ancestry unverified');
  for (const h of helpers) {
    if (!h || !Number.isSafeInteger(h.pid) || h.pid <= 0 || !readableBirth(h.created_at) || h.ancestry !== 'verified' || h.state === 'unknown') return refuse('helper recorded identity or ancestry unverified');
  }
  const left = deadline - Date.now();
  if (!Number.isFinite(left) || left <= 0) return refuse('maintenance time budget reached');
  let table;
  try { table = await readProcessTable({ deadlineMs: Math.min(1000, left), pids: helpers.map(h => h.pid) }); }
  catch { return refuse('helper process table unreadable'); }
  out.checked_at = new Date().toISOString();
  const tableValid = Array.isArray(table) && table.every(p => Number.isSafeInteger(p.pid) && p.pid > 0) && new Set(table.map(p => p.pid)).size === table.length;
  out.identities = helpers.map(h => {
    const current = tableValid ? table.find(p => p.pid === h.pid) : null;
    const v = !tableValid || current && !readableBirth(current.createdAt)
      ? { verdict: 'unknown', reason: 'helper process identity unreadable' } : verifyIdentity(h.pid, h.created_at, table);
    return { pid: h.pid, created_at: h.created_at, verdict: v.verdict, ...(v.reason ? { reason: v.reason } : {}) };
  });
  if (Date.now() >= deadline) return refuse('maintenance time budget reached');
  if (out.identities.some(h => !['gone', 'mismatch'].includes(h.verdict))) return refuse('escaped helper live or uncertain');
  return { ...out, state: 'quiescent' };
}
