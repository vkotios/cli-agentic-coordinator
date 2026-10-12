// Original record retirement; immutable compact evidence precedes exact unlinks.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { OrchError } from './errors.mjs';
import { paths, TERMINAL, keeperFacts } from './store.mjs';
import { nowIso, writeJsonAtomic, readTailLines } from './util.mjs';
import { publishExclusive } from './exclusive.mjs';
import { wpKey, readClaim } from './claims.mjs';
import { listResources, readClosure, recordsIn, withOperationLock } from './resources.mjs';
import { readLedger, ledgerPath } from './ledger.mjs';
import { computeGate } from './gate.mjs';
import { dependencies, quiescent, timestamp, transcriptEvidence, retentionFile } from './retention.mjs';
import { readProcessTable, verifyIdentity } from './procs.mjs';
import { ARCHIVE_LIMIT, DOCUMENT_LIMIT, digest, identity, stamp, safe, evidencePath, evidenceIds, readDocument, readEvidence, readArchived, listReviewEvidence, listRunEvidence, checkedId } from './archive.mjs';

const DAY = 86400000;
const RUN_FILES = new Set(['run.json', 'keeper.ndjson', 'events.monitor.ndjson', 'spawned.json', 'holder.json', 'admission.json', 'monitor.alive', 'dirlatch.json', 'cancel.json', 'cancel-result.json', 'viewer.pid', 'viewer.json', 'scope.json']);
const sameWp = (a, b) => !!a && !!b && wpKey(a) === wpKey(b);
const originalPath = (cfg, kind, id) => kind === 'run' ? paths(cfg, id).dir : path.join(cfg.stateRoot, 'reviews', `${id}.json`);
const journalFile = (cfg, kind, id) => evidencePath(cfg, 'retired', kind, id);
const sealFile = (cfg, kind, id) => evidencePath(cfg, 'sealed', kind, id);
const controlPath = (cfg, id, area) => retentionFile(cfg, area, id);
function write(file, doc) { writeJsonAtomic(safe(file), doc); }
function operator(args) {
  if (typeof args.by !== 'string' || !args.by.trim() || typeof args.reason !== 'string' || !args.reason.trim()) throw new OrchError('--by and --reason required', 'missing-arg');
  return { by: args.by, reason: args.reason, at: nowIso() };
}
export function beginReviewMetadata(cfg, id) {
  const target = safe(originalPath(cfg, 'review', checkedId(id)));
  if (fs.existsSync(target) || readArchived(cfg, 'review', id)) throw new OrchError('review id already exists', 'review-exists');
  const doc = { version: 1, state: 'intent', source: 'orch-review', id, state_root: path.resolve(cfg.stateRoot), state_identity: stamp(safe(cfg.stateRoot)), reviews_identity: stamp(safe(path.dirname(target))), path: target };
  if (!publishExclusive(safe(evidencePath(cfg, 'metadata-owned', 'review', id)), JSON.stringify(doc)).created) throw new OrchError('review ownership already exists', 'review-exists');
}
export function confirmReviewMetadata(cfg, id) {
  const file = evidencePath(cfg, 'metadata-owned', 'review', id), doc = readDocument(file);
  if (!doc) return; // pre-existing reviews remain explicit-enrollment only
  if (!doc || doc.state !== 'intent' || doc.source !== 'orch-review' || doc.id !== id || doc.state_root !== path.resolve(cfg.stateRoot) || doc.state_identity !== stamp(safe(cfg.stateRoot)) || doc.reviews_identity !== stamp(safe(path.dirname(doc.path)))) throw new OrchError('review ownership intent invalid', 'retirement-unowned');
  const record = readDocument(safe(doc.path));
  if (!record || record.id !== id || !record.finished_at) throw new OrchError('review record not finalized', 'retirement-unowned');
  write(file, { ...doc, state: 'confirmed', identity: stamp(doc.path), record_sha256: digest(JSON.stringify(record)) });
}
async function hashFile(file, deadline) {
  const fd = await fsp.open(safe(file), 'r');
  try {
    const before = await fd.stat({ bigint: true });
    if (!before.isFile()) throw new OrchError('metadata is not a regular file', 'retirement-unsafe');
    const hash = crypto.createHash('sha256');
    const b = Buffer.allocUnsafe(65536); let bytes = 0;
    for (;;) {
      if (Date.now() >= deadline) throw new OrchError('metadata hashing time budget reached', 'retirement-budget');
      const { bytesRead } = await fd.read(b, 0, b.length, null);
      if (!bytesRead) break;
      hash.update(b.subarray(0, bytesRead)); bytes += bytesRead;
    }
    const after = await fd.stat({ bigint: true });
    if (identity(before) !== identity(after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || identity(after) !== stamp(safe(file))) throw new OrchError('metadata changed while hashing', 'retirement-changed');
    return { identity: identity(after), sha256: hash.digest('hex'), bytes };
  } finally { await fd.close(); }
}
async function snapshotFiles(cfg, kind, id, deadline) {
  const target = safe(originalPath(cfg, kind, id));
  const names = kind === 'run' ? fs.readdirSync(target) : [`${id}.json`];
  const files = {};
  for (const name of names) {
    if (kind === 'run' && !RUN_FILES.has(name)) throw new OrchError(`unexpected original file: ${name}`, 'retirement-unsafe');
    const file = kind === 'run' ? path.join(target, name) : target;
    const s = fs.lstatSync(safe(file));
    if (!s.isFile() || s.isSymbolicLink()) throw new OrchError('unexpected directory or linked metadata', 'retirement-unsafe');
    files[name] = await hashFile(file, deadline);
  }
  if (kind === 'run' && (!files['run.json'] || !files['keeper.ndjson'])) throw new OrchError('required original metadata missing', 'retirement-unreadable');
  return files;
}
async function liveCheck(cfg, kind, record, deadline, archived = null) {
  if (kind === 'run') {
    if (!TERMINAL.has(record.status)) return 'run not terminal';
    if (!archived) return quiescent(cfg, record, deadline);
    if (!archived.quiescent || (record.escaped_helpers || []).some((h) => h.verdict !== 'gone' && h.status !== 'gone')) return 'historical process evidence uncertain';
    const checks = archived.processes || [];
    if (checks.length) {
      const left = deadline - Date.now(); if (left <= 0) return 'maintenance time budget reached';
      const table = await readProcessTable({ deadlineMs: Math.min(1000, left), pids: checks.map((p) => p.pid) });
      // Historical quiescence is already proven. PID reuse identifies a different
      // process; match and unknown still protect this record, with no kill action.
      if (checks.some((p) => !['gone', 'mismatch'].includes(verifyIdentity(p.pid, p.created_at, table).verdict))) return 'process live or uncertain';
    }
    return null;
  }
  if (!record.finished_at || !['clean', 'not-applicable'].includes(record.containment) || (record.breaches || []).length || (record.unknown || []).length) return 'review unresolved or containment incident';
  for (const id of [record.implementer_run, record.run_id].filter(Boolean)) {
    const e = readEvidence(cfg, 'run', id);
    if (!e) return 'review dependency missing';
    if (e.metadata.state === 'retirement-pending') return 'review dependency retirement pending';
    const reason = await liveCheck(cfg, 'run', e.record, deadline, e.metadata.state !== 'available' ? e : null);
    if (reason) return reason;
  }
  return null;
}
function dependencyCheck(cfg, kind, record, seal) {
  if (kind === 'run') {
    const reviews = listReviewEvidence(cfg);
    const linked = listRunEvidence(cfg).filter((r) => r.review_of === record.id || r.implementer_run === record.id);
    if (linked.some((r) => !TERMINAL.has(r.status) || !reviews.some((v) => v.run_id === r.id && v.finished_at))) return { reason: 'linked review run active or accountability missing' };
    return dependencies(cfg, record, seal);
  }
  const pin = readDocument(retentionFile(cfg, 'pins', record.id));
  if (pin && (pin.version !== 1 || typeof pin.active !== 'boolean' || pin.active)) return { reason: 'review pin or unreadable investigation pin' };
  const resources = listResources(cfg).filter((r) => r.id === record.id || sameWp(r.wp, record.wp));
  if (resources.some((r) => r.cleanup_error || r.state === 'cleanup-pending' || r.kind === 'review' && r.state !== 'removed')) return { reason: 'review cleanup pending or evidence retained' };
  if (!resources.some((r) => r.id === record.id && r.state === 'removed') && !record.worktree_removed && record.worktree_created) return { reason: 'review resource removal unconfirmed' };
  if (record.wp) {
    if (readClaim(cfg, record.wp).state !== 'absent') return { reason: 'package active or unreadable' };
    const closure = readClosure(cfg, record.wp);
    if (!closure || closure.state !== 'finished') return { reason: 'package closure pending' };
    const gates = path.join(cfg.stateRoot, 'gates', wpKey(record.wp));
    if (fs.existsSync(safe(gates))) for (const e of fs.readdirSync(gates, { withFileTypes: true })) {
      if (!e.isDirectory() || computeGate(recordsIn(safe(path.join(gates, e.name))).sort((a, b) => a.round - b.round)).decision !== 'converged') return { reason: 'gate unresolved' };
    }
    return { finalized_at: closure.closed_at };
  }
  return { finalized_at: seal.finalized_at };
}
async function completeSnapshot(cfg, kind, id, record, deadline) {
  const runFields = new Set(['id', 'cli', 'lane', 'status', 'reason', 'status_note', 'exit_code', 'created_at', 'started_at', 'ended_at', 'updated_at', 'dir', 'dir_real', 'dir_evidence', 'wp', 'slice', 'role', 'review_of', 'by', 'scope', 'orch_written', 'escaped_helpers', 'keeper_pid', 'keeper_created_at', 'worker_pid', 'last_activity_at', 'last_activity_signal', 'post_exit_warnings', 'routed_default_model', 'quota', 'routing']);
  const reviewFields = new Set(['id', 'implementer_run', 'implementer_models', 'wp', 'slice', 'by', 'reviewer_cli', 'reviewer_model', 'reviewer_canonical', 'reviewer_model_actual', 'reviewer_run_status', 'reviewer_run_reason', 'warnings', 'ref', 'commit', 'source_repo', 'implementer_dir', 'worktree', 'worktree_created', 'worktree_removed', 'worktree_remove_error', 'blinded', 'blinding_verified', 'status', 'outcome', 'containment', 'finished_at', 'created_at', 'run_id', 'breaches', 'unknown', 'admission', 'launch_error', 'setup_error']);
  const compactRecord = Object.fromEntries(Object.entries(record).filter(([k]) => (kind === 'run' ? runFields.has(k) || k.startsWith('model_') : reviewFields.has(k))));
  if (kind === 'review') return { record: compactRecord, record_sha256: digest(JSON.stringify(record)), captured_at: nowIso(), evidence_hashes: Object.fromEntries(Object.entries(record.evidence || {}).map(([k, v]) => [k, digest(JSON.stringify(v))])), cleanup: listResources(cfg).filter((r) => r.id === id).map((r) => ({ id: r.id, state: r.state, cleanup_error: r.cleanup_error || null })) };
  const transcripts = transcriptEvidence(cfg, id);
  if (!transcripts.snapshot || Object.values(transcripts.files).some((f) => f.state !== 'purged')) throw new OrchError('transcript retirement must complete first', 'retirement-protected');
  const P = paths(cfg, id);
  const facts = keeperFacts(readTailLines(safe(P.keeper), 32768));
  const spawned = readDocument(P.spawned) || {};
  const monitor = readDocument(P.monitorAlive) || {};
  const processes = [];
  for (const [pid, at] of [[spawned.monitor_pid, spawned.monitor_created_at], [monitor.pid, monitor.created_at]]) if (pid) processes.push({ pid, created_at: at });
  const reason = await quiescent(cfg, record, deadline);
  if (reason) throw new OrchError(reason, 'retirement-protected');
  return { record: compactRecord, record_sha256: digest(JSON.stringify(record)), captured_at: nowIso(), facts, spawned, processes, quiescent: true, transcripts: { ...transcripts, snapshot: { ...transcripts.snapshot, run: compactRecord } }, scope: readDocument(path.join(P.dir, 'scope.json')), package: record.wp ? readClosure(cfg, record.wp) : null };
}
async function prepareSeal(cfg, kind, id, record, authorization, deadline) {
  const reason = await liveCheck(cfg, kind, record, deadline);
  if (reason) throw new OrchError(reason, 'retirement-protected');
  const dep = dependencyCheck(cfg, kind, record, { finalized_at: nowIso() });
  if (dep.reason) throw new OrchError(dep.reason, 'retirement-protected');
  const data = await completeSnapshot(cfg, kind, id, record, deadline);
  const target = safe(originalPath(cfg, kind, id)), files = await snapshotFiles(cfg, kind, id, deadline), controls = {};
  if (kind === 'run') for (const area of ['owned', 'receipts']) controls[area] = await hashFile(controlPath(cfg, id, area), deadline);
  data.source_files = files; data.control_files = controls;
  const doc = { version: 1, kind, id, state_root: path.resolve(cfg.stateRoot), state_identity: stamp(safe(cfg.stateRoot)), original: { path: target, identity: stamp(target) }, files, controls, data, authorization, finalized_at: nowIso() };
  const sealed = { ...doc, seal_sha256: digest(JSON.stringify(doc)) };
  if (Buffer.byteLength(JSON.stringify({ version: 1, kind, id, state_root: doc.state_root, state_identity: doc.state_identity, original: doc.original, data, sha256: digest(JSON.stringify(data)) })) > ARCHIVE_LIMIT) throw new OrchError('required compact evidence exceeds 256 KiB', 'archive-oversized');
  return sealed;
}
function autoOperator(cfg, kind, id) {
  const owned = readDocument(kind === 'run' ? retentionFile(cfg, 'owned', id) : evidencePath(cfg, 'metadata-owned', kind, id));
  if (!owned || owned.version !== 1 || owned.id !== id || owned.state !== 'confirmed' || owned.state_root !== path.resolve(cfg.stateRoot) || owned.state_identity !== stamp(safe(cfg.stateRoot))) return null;
  if (kind === 'run') { if (owned.source !== 'orch-run' || owned.metadata_version !== 1) return null; }
  else if (owned.source !== 'orch-review' || owned.path !== originalPath(cfg, kind, id) || owned.reviews_identity !== stamp(safe(path.dirname(owned.path))) || owned.identity !== stamp(safe(owned.path)) || owned.record_sha256 !== digest(JSON.stringify(readDocument(owned.path)))) return null;
  const record = readEvidence(cfg, kind, id)?.record;
  return record?.wp ? readClosure(cfg, record.wp)?.by : kind === 'run' ? owned.finalization?.by : record?.by;
}
export async function enrollMetadata(cfg, args) {
  const authorization = operator(args), id = checkedId(args.enroll), kind = id.startsWith('rv-') ? 'review' : 'run';
  const initial = readEvidence(cfg, kind, id);
  if (!initial || initial.metadata.state !== 'available') throw new OrchError('metadata already retired or missing', 'record-retired');
  const action = () => withOperationLock(cfg, `${kind}:${id}`, async () => {
    const current = readEvidence(cfg, kind, id);
    if (!current || current.metadata.state !== 'available' || digest(JSON.stringify(current.record)) !== digest(JSON.stringify(initial.record))) throw new OrchError('record changed while acquiring guard', 'retirement-changed');
    const prior = readDocument(sealFile(cfg, kind, id));
    if (prior) {
      const { seal_sha256, ...body } = prior;
      if (prior.kind !== kind || prior.id !== id || seal_sha256 !== digest(JSON.stringify(body)) || prior.state_identity !== stamp(safe(cfg.stateRoot)) || !prior.authorization?.by) throw new OrchError('metadata seal invalid', 'retirement-unreadable');
      return { id, kind, state: 'enrolled', by: prior.authorization.by };
    }
    const deadline = Math.min(Date.now() + 10000, args.deadline || Infinity);
    const doc = await prepareSeal(cfg, kind, id, current.record, authorization, deadline);
    if (!publishExclusive(safe(sealFile(cfg, kind, id)), JSON.stringify(doc)).created) throw new OrchError('metadata seal already exists', 'retirement-sealed');
    return { id, kind, state: 'enrolled', by: authorization.by };
  });
  return initial.record.wp ? withOperationLock(cfg, `wp:${wpKey(initial.record.wp)}`, action) : action();
}
async function validateRemaining(cfg, kind, id, seal, journal, deadline) {
  for (const [area, before] of Object.entries(seal.controls || {})) {
    const file = controlPath(cfg, id, area);
    if (!fs.existsSync(file)) { if (!['deleting', 'removed'].includes(journal?.controls?.[area]?.state)) throw new OrchError('collector evidence unexpectedly missing', 'retirement-changed'); continue; }
    const actual = await hashFile(file, deadline);
    if (actual.identity !== before.identity || actual.sha256 !== before.sha256) throw new OrchError('collector evidence changed after sealing', 'retirement-changed');
  }
  const target = safe(originalPath(cfg, kind, id));
  if (!fs.existsSync(target)) {
    if (kind === 'run' ? journal && ['deleting', 'removed'].includes(journal.directory_state) : journal && ['deleting', 'removed'].includes(journal.files[`${id}.json`]?.state)) return;
    throw new OrchError('original evidence unexpectedly missing', 'retirement-changed');
  }
  if (stamp(target) !== seal.original.identity) throw new OrchError('original identity changed', 'retirement-changed');
  const names = kind === 'run' ? fs.readdirSync(target) : [`${id}.json`];
  for (const name of names) {
    if (!seal.files[name]) throw new OrchError(`unexpected original file: ${name}`, 'retirement-unsafe');
    const file = kind === 'run' ? path.join(target, name) : target;
    const actual = await hashFile(file, deadline), expected = seal.files[name];
    if (actual.identity !== expected.identity || actual.sha256 !== expected.sha256) throw new OrchError('metadata content or identity changed', 'retirement-changed');
  }
  for (const name of Object.keys(seal.files)) if (!names.includes(name) && !['deleting', 'removed'].includes(journal?.files[name]?.state)) throw new OrchError('metadata unexpectedly missing', 'retirement-changed');
}
/** @returns {Promise<any>} */
async function plan(cfg, kind, id, policy, deadline, prospective = null) {
  const base = { id, kind, state: 'protected', bytes: 0, pending_cleanup: false, ...(prospective ? { would_auto_seal: true } : {}) };
  try {
    const archived = readArchived(cfg, kind, id);
    if (archived?.metadata.state === 'retired') return { ...base, state: 'collected' };
    const seal = prospective || readDocument(sealFile(cfg, kind, id));
    if (!seal) return { ...base, state: 'legacy', reason: 'explicit metadata enrollment required' };
    const { seal_sha256, ...sealedBody } = seal;
    if (seal_sha256 !== digest(JSON.stringify(sealedBody)) || seal.version !== 1 || seal.kind !== kind || seal.id !== id || seal.state_identity !== stamp(safe(cfg.stateRoot)) || seal.state_root !== path.resolve(cfg.stateRoot) || !seal.data || !seal.files || seal.original.path !== originalPath(cfg, kind, id) || Object.keys(seal.files).some((name) => kind === 'run' ? !RUN_FILES.has(name) : name !== `${id}.json`) || Object.keys(seal.controls || {}).some((area) => !['owned', 'receipts'].includes(area))) throw new OrchError('metadata seal invalid', 'retirement-unreadable');
    const journal = readDocument(journalFile(cfg, kind, id));
    base.pending_cleanup = !!journal;
    const record = archived ? archived.record : readEvidence(cfg, kind, id)?.record;
    if (!record || (archived ? digest(JSON.stringify(record)) !== digest(JSON.stringify(seal.data.record)) : digest(JSON.stringify(record)) !== seal.data.record_sha256)) throw new OrchError('record changed after sealing', 'retirement-changed');
    const dep = dependencyCheck(cfg, kind, record, seal);
    if (dep.reason) return { ...base, reason: dep.reason };
    const ended = timestamp(kind === 'run' ? record.ended_at : record.finished_at), finalized = timestamp(dep.finalized_at);
    if (ended === null || finalized === null || ended > Date.now() || finalized > Date.now()) return { ...base, reason: 'invalid or future finalization time' };
    const row = kind === 'run' ? readLedger(ledgerPath(cfg)).rows.find((r) => r.run_id === id) : null;
    const success = kind === 'run' ? record.status === 'completed' && row && row.disposition.startsWith('accepted') : record.outcome === 'reviewed';
    if (Date.now() - Math.max(ended, finalized) < (success ? policy.metadata.successDays : policy.metadata.otherDays) * DAY) return { ...base, reason: 'metadata retention age not reached' };
    const live = await liveCheck(cfg, kind, record, deadline, archived);
    if (live) return { ...base, reason: live };
    await validateRemaining(cfg, kind, id, seal, journal, deadline);
    for (const [name, data] of Object.entries(seal.files)) if (fs.existsSync(kind === 'run' ? path.join(seal.original.path, name) : seal.original.path)) base.bytes += data.bytes;
    for (const [area, data] of Object.entries(seal.controls || {})) if (fs.existsSync(controlPath(cfg, id, area))) base.bytes += data.bytes;
    return { ...base, state: 'eligible' };
  } catch (e) { return { ...base, state: e.code === 'retirement-budget' ? 'deferred' : 'protected', reason: e.message }; }
}
async function collect(cfg, kind, id, policy, deadline, authorization) {
  let check = await plan(cfg, kind, id, policy, deadline);
  if (check.state !== 'eligible') return check;
  const seal = readDocument(sealFile(cfg, kind, id));
  const file = journalFile(cfg, kind, id);
  let journal = readDocument(file), removed = 0;
  try {
    if (!journal) {
      const entry = { version: 1, kind, id, state_root: seal.state_root, state_identity: seal.state_identity, original: seal.original, data: seal.data, sha256: digest(JSON.stringify(seal.data)) };
      journal = { version: 1, kind, id, state: 'prepared', entry, archive_sha256: digest(JSON.stringify(entry)), files: Object.fromEntries(Object.entries(seal.files).map(([name, data]) => [name, { ...data, state: 'planned' }])), controls: Object.fromEntries(Object.entries(seal.controls || {}).map(([area, data]) => [area, { ...data, state: 'planned' }])), directory_state: kind === 'run' ? 'present' : null, authorization: authorization || seal.authorization, prepared_at: nowIso() };
      // A durable prepared journal holds the immutable entry through publication.
      write(file, journal);
    }
    const archiveFile = safe(evidencePath(cfg, 'archive', kind, id));
    if (!fs.existsSync(archiveFile)) {
      if (journal.state !== 'prepared' || Object.values(journal.files).some((f) => f.state !== 'planned') || !journal.entry) throw new OrchError('compact evidence unexpectedly missing', 'retirement-unreadable');
      if (!publishExclusive(archiveFile, JSON.stringify(journal.entry)).created) throw new OrchError('compact publication raced another writer', 'retirement-unreadable');
    }
    readArchived(cfg, kind, id); // validate the immutable pair before recovery
    for (const name of Object.keys(journal.files).sort((a, b) => (a === 'run.json' ? 1 : b === 'run.json' ? -1 : a.localeCompare(b)))) {
      const data = journal.files[name], target = kind === 'run' ? path.join(seal.original.path, name) : seal.original.path;
      if (data.state === 'removed' && !fs.existsSync(target)) continue;
      const next = await plan(cfg, kind, id, policy, deadline);
      if (next.state !== 'eligible') throw new OrchError(next.reason || 'retirement dependency changed', 'retirement-protected');
      if (fs.existsSync(target)) {
        data.state = 'deleting'; journal.state = 'partial'; write(file, journal);
        const actual = await hashFile(safe(target), deadline);
        if (actual.identity !== data.identity || actual.sha256 !== data.sha256) throw new OrchError('metadata changed before unlink', 'retirement-changed');
        fs.unlinkSync(target); removed += data.bytes;
      } else if (!['deleting', 'removed'].includes(data.state)) throw new OrchError('metadata unexpectedly missing', 'retirement-changed');
      data.state = 'removed'; write(file, journal);
    }
    if (kind === 'run' && fs.existsSync(seal.original.path)) {
      const next = await plan(cfg, kind, id, policy, deadline);
      if (next.state !== 'eligible') throw new OrchError(next.reason || 'retirement dependency changed', 'retirement-protected');
      journal.directory_state = 'deleting'; write(file, journal);
      if (stamp(safe(seal.original.path)) !== seal.original.identity) throw new OrchError('run directory identity changed', 'retirement-changed');
      fs.rmdirSync(seal.original.path);
    }
    journal.directory_state = kind === 'run' ? 'removed' : null;
    write(file, journal);
    for (const [area, data] of Object.entries(journal.controls || {})) {
      const target = controlPath(cfg, id, area);
      if (data.state === 'removed' && !fs.existsSync(target)) continue;
      const next = await plan(cfg, kind, id, policy, deadline);
      if (next.state !== 'eligible') throw new OrchError(next.reason || 'retirement dependency changed', 'retirement-protected');
      if (fs.existsSync(target)) {
        data.state = 'deleting'; write(file, journal);
        const actual = await hashFile(target, deadline);
        if (actual.identity !== data.identity || actual.sha256 !== data.sha256) throw new OrchError('collector evidence changed before unlink', 'retirement-changed');
        fs.unlinkSync(target); removed += data.bytes;
      } else if (data.state !== 'deleting') throw new OrchError('collector evidence unexpectedly missing', 'retirement-changed');
      data.state = 'removed'; write(file, journal);
    }
    delete journal.entry;
    journal.state = 'complete'; journal.completed_at = nowIso(); delete journal.error; write(file, journal);
    return { ...check, state: 'collected', removed_bytes: removed, pending_cleanup: false };
  } catch (e) {
    if (journal) {
      // An IO error before publication is recoverable through the prepared entry.
      // Never downgrade actual deletion intent or progress back to prepared.
      const untouched = journal.state === 'prepared' && Object.values(journal.files).every((f) => f.state === 'planned') && Object.values(journal.controls || {}).every((f) => f.state === 'planned') && (kind !== 'run' || journal.directory_state === 'present');
      journal.state = untouched ? 'prepared' : 'partial'; journal.error = e.message; write(file, journal);
    }
    return { ...check, state: 'pending', reason: e.message, removed_bytes: removed, pending_cleanup: true };
  }
}
export async function maintainMetadata(cfg, args, policy) {
  let authorization = args.authorization;
  if (!policy.metadata?.enabled && args.apply && (args.run || args.review)) {
    authorization = { ...operator(args), overrode_policy: true, configured_policy: policy };
    policy = { ...policy, metadata: { enabled: true, successDays: 0, otherDays: 0 } };
  }
  if (args.apply && !policy.metadata?.enabled) return { state: 'disabled', runs: [], removed_bytes: 0, exitCode: 0 };
  const effective = { ...policy, metadata: policy.metadata?.enabled ? policy.metadata : { enabled: false, successDays: 0, otherDays: 0 } };
  const deadline = Date.now() + policy.maxMs;
  let candidates = args.run ? [['run', checkedId(args.run)]] : args.review ? [['review', checkedId(args.review)]] : [...evidenceIds(cfg, 'run').map((id) => ['run', id]), ...evidenceIds(cfg, 'review').map((id) => ['review', id])].sort((a, b) => a[1].localeCompare(b[1]));
  if (args.after) candidates = candidates.filter(([, id]) => id > checkedId(args.after));
  const runs = []; let used = 0;
  for (const [kind, id] of candidates) {
    if (runs.length >= policy.maxRuns || Date.now() >= deadline) break;
    let prospective = null;
    try {
      if (policy.metadata?.enabled && !readDocument(sealFile(cfg, kind, id))) {
        const by = autoOperator(cfg, kind, id);
        if (by) {
          const reason = 'configured metadata policy after recorded finalization';
          if (args.apply) await enrollMetadata(cfg, { enroll: id, by, reason, deadline });
          else prospective = await prepareSeal(cfg, kind, id, readEvidence(cfg, kind, id).record, { by, reason, at: nowIso() }, deadline);
        }
      }
    } catch (e) { runs.push({ id, kind, state: e.code === 'retirement-budget' ? 'deferred' : 'protected', bytes: 0, reason: e.message }); continue; }
    let item = await plan(cfg, kind, id, effective, deadline, prospective);
    if (item.state === 'eligible' && used + item.bytes > policy.maxBytes) item = { ...item, state: 'deferred', reason: 'maintenance byte budget reached' };
    if (args.apply && item.state === 'eligible') {
      try {
        const evidence = readEvidence(cfg, kind, id);
        const action = () => withOperationLock(cfg, `${kind}:${id}`, () => collect(cfg, kind, id, effective, deadline, authorization));
        item = evidence.record.wp ? await withOperationLock(cfg, `wp:${wpKey(evidence.record.wp)}`, action) : await action();
      } catch (e) { item = { ...item, state: 'pending', reason: e.message }; }
    }
    if (['eligible', 'pending', 'collected'].includes(item.state)) used += item.bytes;
    runs.push(item);
  }
  const pending = runs.some((r) => r.state === 'pending' || r.pending_cleanup && r.state !== 'collected');
  return { state: pending ? 'pending' : 'complete', kind: 'metadata', dry_run: !args.apply, policy_enabled: !!policy.metadata?.enabled, runs, scanned: runs.length, unscanned: candidates.length - runs.length, truncated: runs.length < candidates.length, next_after: runs.length < candidates.length ? runs.at(-1)?.id || args.after || null : null, counts: runs.reduce((o, r) => ({ ...o, [r.state]: (o[r.state] || 0) + 1 }), {}), removed_bytes: runs.reduce((n, r) => n + (r.removed_bytes || 0), 0), eligible_bytes: runs.filter((r) => ['eligible', 'deferred'].includes(r.state)).reduce((n, r) => n + r.bytes, 0), deferred_bytes: runs.filter((r) => r.state === 'deferred').reduce((n, r) => n + r.bytes, 0), protected_bytes: runs.filter((r) => ['protected', 'legacy'].includes(r.state)).reduce((n, r) => n + r.bytes, 0), exitCode: pending ? 3 : 0 };
}
