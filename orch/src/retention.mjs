// Collector-owned receipts. Never rewrites monitor/keeper records or removes folders.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { OrchError } from './errors.mjs';
import { paths, readRun, TERMINAL, keeperFacts } from './store.mjs';
import { getAdapter } from './adapters/index.mjs';
import { readLedger, ledgerPath } from './ledger.mjs';
import { computeGate } from './gate.mjs';
import { readClaim, wpKey } from './claims.mjs';
import { resolvedPath, recordsIn, readClosure, listResources, withOperationLock, withWpOperation } from './resources.mjs';
import { samePath } from './git.mjs';
import { readProcessTable, verifyIdentity } from './procs.mjs';
import { writeJsonAtomic, nowIso, readTailLines } from './util.mjs';
import { publishExclusive } from './exclusive.mjs';

const FILES = { stdout: 'stdout.log', stderr: 'stderr.log', prompt: 'prompt.txt' };
const DAY = 86400000;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
function readPayload(file) {
  const fd = fs.openSync(safe(file), 'r');
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > MAX_PAYLOAD_BYTES) throw new OrchError('payload exceeds the 8 MiB read limit', 'retention-payload-limit');
    const chunks = [];
    let bytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, MAX_PAYLOAD_BYTES + 1 - bytes));
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) return Buffer.concat(chunks, bytes);
      bytes += n;
      if (bytes > MAX_PAYLOAD_BYTES) throw new OrchError('payload grew beyond the 8 MiB read limit', 'retention-payload-limit');
      chunks.push(chunk.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
}
const stamp = (file) => { const s = fs.lstatSync(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.birthtimeNs}`; };
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
const samePackage = (a, b) => !!a && !!b && wpKey(a) === wpKey(b);
function checkedId(id) {
  if (!validId(id)) throw new OrchError('invalid retention run id', 'bad-id');
  return id;
}
function safe(file) {
  if (!samePath(path.resolve(file), resolvedPath(file))) throw new OrchError('retention path traverses a link', 'retention-path-unsafe');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new OrchError('retention path is linked', 'retention-path-unsafe');
  return file;
}
export const retentionFile = (cfg, kind, id) => safe(path.join(safe(cfg.stateRoot), 'retention', kind, `${checkedId(id)}.json`));
function readStrict(file) {
  safe(file);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new OrchError(`unreadable retention evidence: ${file}`, 'retention-unreadable'); }
}
function write(file, doc) { safe(file); writeJsonAtomic(file, doc); }
export const withRunOperation = (cfg, id, fn) => withOperationLock(cfg, `run:${checkedId(id)}`, fn);
export function retentionPolicy(cfg) {
  const config = readStrict(cfg.configFile) || {};
  if (typeof config !== 'object' || Array.isArray(config)) throw new OrchError('invalid retention configuration document', 'bad-retention-policy');
  const p = config.retention;
  if (p == null) return { mode: 'disabled', successDays: 30, otherDays: 90, maxRuns: 20, maxBytes: 64 * 1024 * 1024, maxMs: 2000, minIntervalMs: 3600000 };
  if (typeof p !== 'object' || Array.isArray(p) || !['disabled', 'manual', 'on-use'].includes(p.mode)) throw new OrchError('invalid retention mode', 'bad-retention-policy');
  const out = { mode: p.mode, successDays: p.successDays, otherDays: p.otherDays, maxRuns: p.maxRuns ?? 20, maxBytes: p.maxBytes ?? 64 * 1024 * 1024, maxMs: p.maxMs ?? 2000, minIntervalMs: p.minIntervalMs ?? 3600000 };
  if (Object.keys(p).some((k) => !(k in out))) throw new OrchError('unknown retention policy setting', 'bad-retention-policy');
  for (const [k, v] of Object.entries(out)) {
    if (k === 'mode') continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < (k.endsWith('Days') ? 0 : 1)) throw new OrchError(`invalid retention ${k}`, 'bad-retention-policy');
  }
  if (out.maxRuns > 1000 || out.maxMs > 60000) throw new OrchError('retention maxRuns <= 1000 and maxMs <= 60000 required', 'bad-retention-policy');
  return out;
}

export function beginRunArtifacts(cfg, id) {
  const P = paths(cfg, checkedId(id));
  safe(cfg.runsDir); safe(P.dir);
  if (fs.existsSync(P.dir)) throw new OrchError('run directory already exists', 'run-exists');
  const doc = { version: 1, id, state: 'intent', source: 'orch-run', created_at: nowIso(), state_root: path.resolve(cfg.stateRoot), state_identity: stamp(cfg.stateRoot), runs_identity: stamp(cfg.runsDir), dir: P.dir };
  if (!publishExclusive(retentionFile(cfg, 'owned', id), JSON.stringify(doc)).created) throw new OrchError('run artifacts already registered', 'run-exists');
}
export function confirmRunArtifacts(cfg, id) {
  const file = retentionFile(cfg, 'owned', id);
  const doc = readStrict(file);
  if (!doc || doc.state !== 'intent') throw new OrchError('artifact creation intent missing', 'retention-unowned');
  const dir = safe(paths(cfg, id).dir);
  const identities = {};
  for (const [key, name] of Object.entries(FILES)) {
    const f = safe(path.join(dir, name));
    if (!fs.lstatSync(f).isFile()) throw new OrchError('artifact is not a regular file', 'retention-path-unsafe');
    identities[key] = stamp(f);
  }
  write(file, { ...doc, state: 'confirmed', dir_identity: stamp(dir), files: identities });
}
function owned(cfg, id) {
  const doc = readStrict(retentionFile(cfg, 'owned', id));
  if (!doc) return null;
  const dir = safe(paths(cfg, id).dir);
  if (doc.version !== 1 || doc.id !== id || doc.state !== 'confirmed' || doc.state_root !== path.resolve(cfg.stateRoot) || doc.dir !== dir || doc.state_identity !== stamp(safe(cfg.stateRoot)) || doc.runs_identity !== stamp(safe(cfg.runsDir)) || doc.dir_identity !== stamp(dir) || !doc.files || Object.keys(FILES).some((k) => typeof doc.files[k] !== 'string')) throw new OrchError('artifact ownership incomplete or identity changed', 'retention-unowned');
  return doc;
}
function snapshotValid(doc, id) {
  return doc && doc.version === 1 && doc.id === id && doc.snapshot && doc.snapshot_sha256 === digest(JSON.stringify(doc.snapshot)) && doc.files && Object.keys(FILES).every((k) => doc.files[k] && typeof doc.files[k].sha256 === 'string' && ['planned', 'deleting', 'purged'].includes(doc.files[k].state));
}
export function transcriptEvidence(cfg, id) {
  checkedId(id);
  const P = paths(cfg, id);
  let doc, error, authority;
  try {
    doc = readStrict(retentionFile(cfg, 'receipts', id));
    if (doc && !snapshotValid(doc, id)) throw new OrchError('compact retention evidence is invalid', 'retention-unreadable');
    if (doc && (!owned(cfg, id) || digest(fs.readFileSync(safe(P.record))) !== doc.snapshot.run_sha256)) throw new OrchError('compact evidence no longer belongs to this run', 'retention-changed');
  } catch (e) {
    error = e.message;
    authority = owned(cfg, id); // A reused directory may never recover the old answer.
    if (!authority) throw e;
    doc = null;
  }
  const out = {};
  for (const [key, name] of Object.entries(FILES)) {
    const file = safe(path.join(P.dir, name));
    const exists = fs.existsSync(file);
    const verified = exists && (!error || fs.lstatSync(file).isFile() && stamp(file) === authority.files[key]);
    out[key] = { state: error ? verified ? 'available' : 'unknown' : exists ? 'available' : doc && ['deleting', 'purged'].includes(doc.files[key].state) ? 'purged' : 'missing', ...(doc ? { original_bytes: doc.files[key].bytes } : {}) };
  }
  return { files: out, snapshot: doc ? doc.snapshot : null, ...(error ? { error } : {}) };
}
// Status has a real command deadline: keep every filesystem operation off its
// event loop. Errors are labelled unknown by the caller, never inferred as purged.
async function safeAsync(file) {
  const abs = path.resolve(file);
  let real;
  try { real = await fsp.realpath(abs); }
  catch (e) {
    if (e.code !== 'ENOENT' || path.dirname(abs) === abs) throw e;
    real = path.join(await safeAsync(path.dirname(abs)), path.basename(abs));
  }
  if (!samePath(abs, real)) throw new OrchError('retention path traverses a link', 'retention-path-unsafe');
  return abs;
}
async function jsonAsync(file) {
  try { return JSON.parse(await fsp.readFile(await safeAsync(file), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function stampAsync(file) {
  const s = await fsp.lstat(await safeAsync(file), { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
export async function transcriptEvidenceAsync(cfg, id) {
  checkedId(id);
  const P = paths(cfg, id);
  let doc, error, authority;
  const readAuthority = async () => {
    const a = await jsonAsync(path.join(cfg.stateRoot, 'retention', 'owned', `${id}.json`));
    if (!a || a.version !== 1 || a.id !== id || a.state !== 'confirmed' || a.state_root !== path.resolve(cfg.stateRoot) || a.dir !== P.dir || a.state_identity !== await stampAsync(cfg.stateRoot) || a.runs_identity !== await stampAsync(cfg.runsDir) || a.dir_identity !== await stampAsync(P.dir) || !a.files || Object.keys(FILES).some((k) => typeof a.files[k] !== 'string')) throw new OrchError('compact evidence identity changed', 'retention-changed');
    return a;
  };
  try {
    doc = await jsonAsync(path.join(cfg.stateRoot, 'retention', 'receipts', `${id}.json`));
    if (doc) {
      if (!snapshotValid(doc, id)) throw new OrchError('compact retention evidence is invalid', 'retention-unreadable');
      await readAuthority();
      if (digest(await fsp.readFile(await safeAsync(P.record))) !== doc.snapshot.run_sha256) throw new OrchError('compact evidence identity changed', 'retention-changed');
    }
  } catch (e) {
    error = e.message; authority = await readAuthority(); doc = null;
  }
  const files = {};
  for (const [key, name] of Object.entries(FILES)) {
    let exists = true;
    let verified = true;
    try {
      const file = await safeAsync(path.join(P.dir, name));
      const s = await fsp.lstat(file);
      if (error) verified = s.isFile() && await stampAsync(file) === authority.files[key];
    }
    catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
    files[key] = { state: error ? exists && verified ? 'available' : 'unknown' : exists ? 'available' : doc && ['deleting', 'purged'].includes(doc.files[key].state) ? 'purged' : 'missing', ...(doc ? { original_bytes: doc.files[key].bytes } : {}) };
  }
  return { files, snapshot: doc ? doc.snapshot : null, ...(error ? { error } : {}) };
}
function timestamp(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v)) return null;
  const n = Date.parse(v);
  const canonical = v.includes('.') ? v : v.replace('Z', '.000Z');
  return Number.isFinite(n) && new Date(n).toISOString() === canonical ? n : null;
}
function requireOperator(args) {
  if (typeof args.by !== 'string' || !args.by.trim() || typeof args.reason !== 'string' || !args.reason.trim()) throw new OrchError('--by and --reason are required', 'missing-arg');
}
function pin(cfg, id) {
  const doc = readStrict(retentionFile(cfg, 'pins', id));
  if (doc && (doc.version !== 1 || doc.id !== id || typeof doc.active !== 'boolean' || !doc.reason || !doc.by)) throw new OrchError('invalid investigation pin', 'retention-unreadable');
  return doc && doc.active;
}
async function quiescent(cfg, rec, deadline) {
  const P = paths(cfg, rec.id);
  const f = keeperFacts(readTailLines(safe(P.keeper), 32768));
  if (!f.blocked && (!f.workerExit || f.streamsClosed !== 'streams-closed')) return 'worker exit or closed streams not confirmed';
  if (f.writeFailures) return 'keeper write failures require investigation';
  const s = readStrict(P.spawned) || {};
  const m = readStrict(P.monitorAlive);
  const checks = [];
  if (!f.keeperExit) {
    if (!s.keeper_pid || !s.keeper_created_at) return 'keeper liveness unknown';
    checks.push([s.keeper_pid, s.keeper_created_at]);
  }
  if (s.monitor_pid) checks.push([s.monitor_pid, s.monitor_created_at]);
  if (m && m.pid) checks.push([m.pid, m.created_at]);
  for (const h of rec.escaped_helpers || []) {
    if (h.verdict !== 'gone' && h.status !== 'gone') return 'escaped helper needs investigation';
  }
  if (checks.length) {
    const left = deadline - Date.now();
    if (left <= 0) return 'maintenance time budget reached';
    const table = await readProcessTable({ deadlineMs: Math.min(1000, left), pids: checks.map(([pid]) => pid) });
    if (checks.some(([pid, at]) => verifyIdentity(pid, at, table).verdict !== 'gone')) return 'monitor or keeper process live or uncertain';
  }
  return null;
}
function dependencies(cfg, rec, authority) {
  if (pin(cfg, rec.id)) return { reason: 'investigation pin' };
  const ledger = readLedger(ledgerPath(cfg));
  if (ledger.bad) return { reason: 'ledger unreadable rows' };
  const rows = ledger.rows.filter((r) => r.run_id === rec.id);
  if (rows.length !== 1 || !['accepted', 'accepted-with-fixes', 'rejected', 'blocked', 'inconclusive-timeout', 'failed-launch'].includes(rows[0].disposition)) return { reason: 'durable disposition missing or ambiguous' };
  const reviews = recordsIn(safe(path.join(cfg.stateRoot, 'reviews'))).filter((r) => r.implementer_run === rec.id || r.run_id === rec.id || samePackage(r.wp, rec.wp));
  if (reviews.some((r) => !r.finished_at || r.containment !== 'clean' || (r.breaches || []).length || (r.unknown || []).length)) return { reason: 'unresolved review or containment incident' };
  const resources = listResources(cfg).filter((r) => samePackage(r.wp, rec.wp) || reviews.some((v) => v.id === r.id));
  if (resources.some((r) => r.state === 'cleanup-pending' || r.cleanup_error || r.kind === 'review' && r.state !== 'removed')) return { reason: 'resource cleanup pending or incident' };
  if (rec.wp) {
    const claim = readClaim(cfg, rec.wp);
    if (claim.state !== 'absent') return { reason: 'package claim active or unreadable' };
    const closure = readClosure(cfg, rec.wp);
    if (!closure || closure.state !== 'finished' || !Array.isArray(closure.run_ids) || !closure.run_ids.includes(rec.id)) return { reason: 'package closure missing or pending' };
    const gates = safe(path.join(cfg.stateRoot, 'gates', wpKey(rec.wp)));
    // Inspect every recorded slice, including reopened/overridden gates.
    if (fs.existsSync(gates)) for (const e of fs.readdirSync(gates, { withFileTypes: true })) {
      if (!e.isDirectory()) return { reason: 'gate inventory unreadable' };
      const rounds = recordsIn(safe(path.join(gates, e.name)));
      if (computeGate(rounds.sort((a, b) => a.round - b.round)).decision !== 'converged') return { reason: 'unresolved acceptance gate' };
    }
    if (rows[0].disposition.startsWith('accepted') && (!validId(rec.slice) || !fs.existsSync(path.join(gates, rec.slice.toLowerCase())) || !reviews.some((r) => r.implementer_run === rec.id && r.finished_at && r.containment === 'clean'))) return { reason: 'accepted run lacks acceptance gate or independent review' };
    return { finalized_at: closure.closed_at };
  }
  return authority.finalized_at ? { finalized_at: authority.finalized_at } : { reason: 'standalone run needs explicit enrollment/finalization' };
}
/** @returns {Promise<any>} */
async function planRun(cfg, id, policy, deadline) {
  let bytes = 0;
  const base = { id, state: 'protected', bytes, pending_cleanup: false };
  try {
    checkedId(id);
    const P = paths(cfg, id);
    for (const name of Object.values(FILES)) { const f = safe(path.join(P.dir, name)); if (fs.existsSync(f)) bytes += fs.statSync(f).size; }
    base.bytes = bytes;
    const authority = owned(cfg, id);
    if (!authority) return { ...base, state: 'legacy', reason: 'explicit enrollment required' };
    const receipt = readStrict(retentionFile(cfg, 'receipts', id));
    base.pending_cleanup = !!receipt && (receipt.state !== 'complete' || !snapshotValid(receipt, id));
    const rec = readStrict(P.record);
    if (!rec || rec.id !== id || !TERMINAL.has(rec.status)) return { ...base, reason: 'run active or record invalid' };
    const dep = dependencies(cfg, rec, authority);
    if (dep.reason) return { ...base, reason: dep.reason };
    const ended = timestamp(rec.ended_at), finalized = timestamp(dep.finalized_at), now = Date.now();
    if (ended === null || finalized === null || ended > now || finalized > now) return { ...base, reason: 'missing, invalid or future finalization time' };
    const since = Math.max(ended, finalized);
    const success = rec.status === 'completed' && ['accepted', 'accepted-with-fixes'].includes(readLedger(ledgerPath(cfg)).rows.find((r) => r.run_id === id).disposition);
    const days = success ? policy.successDays : policy.otherDays;
    if (now - since < days * DAY) return { ...base, reason: 'retention age not reached', eligible_at: new Date(since + days * DAY).toISOString() };
    const live = await quiescent(cfg, rec, deadline);
    if (live) return { ...base, reason: live };
    if (receipt && !snapshotValid(receipt, id)) return { ...base, reason: 'compact evidence corrupt' };
    for (const [key, name] of Object.entries(FILES)) {
      const file = safe(path.join(P.dir, name));
      if (!fs.existsSync(file)) {
        if (!receipt || !['deleting', 'purged'].includes(receipt.files[key].state)) return { ...base, reason: 'artifact unexpectedly missing' };
      } else {
        const s = fs.lstatSync(file);
        if (!s.isFile() || stamp(file) !== authority.files[key]) return { ...base, reason: 'artifact identity changed' };
        if (s.size > MAX_PAYLOAD_BYTES) return { ...base, reason: 'payload exceeds the 8 MiB read limit' };
        if (s.mtimeMs > since) return { ...base, reason: 'artifact changed after finalization' };
      }
    }
    return { ...base, state: receipt && receipt.state === 'complete' && bytes === 0 ? 'collected' : 'eligible', finalized_at: new Date(since).toISOString() };
  } catch (e) { return { ...base, bytes, reason: e.message }; }
}
function createSnapshot(cfg, id, authority) {
  const P = paths(cfg, id);
  const rec = readStrict(P.record);
  const files = {};
  let stdout = '';
  for (const [key, name] of Object.entries(FILES)) {
    const f = safe(path.join(P.dir, name));
    const b = readPayload(f);
    if (stamp(f) !== authority.files[key]) throw new OrchError('artifact replaced while snapshotting', 'retention-changed');
    const sha256 = digest(b);
    if (authority.sealed_hashes && authority.sealed_hashes[key] !== sha256) throw new OrchError('enrolled artifact content changed', 'retention-changed');
    files[key] = { state: 'planned', sha256, identity: stamp(f), bytes: b.length };
    if (key === 'stdout') stdout = b.toString('utf8');
  }
  let message = stdout.trim();
  try { const adapter = getAdapter(rec.cli); if (adapter.extractFinalMessage) message = adapter.extractFinalMessage(stdout); } catch { /* keep plain output */ }
  const b = Buffer.from(String(message));
  const snapshot = { run: rec, final_message: b.subarray(0, 65536).toString('utf8'), final_message_bytes: b.length, final_message_truncated: b.length > 65536, captured_at: nowIso(), run_sha256: digest(fs.readFileSync(P.record)) };
  return { version: 1, id, state: 'prepared', prepared_at: nowIso(), snapshot, snapshot_sha256: digest(JSON.stringify(snapshot)), files };
}
async function collectRun(cfg, id, policy, deadline, authorization = null) {
  const plan = await planRun(cfg, id, policy, deadline);
  if (plan.state !== 'eligible') return plan;
  const file = retentionFile(cfg, 'receipts', id);
  let receipt = readStrict(file);
  try {
    if (!receipt) {
      receipt = createSnapshot(cfg, id, owned(cfg, id));
      if (authorization) receipt.authorization = authorization;
      write(file, receipt);
    }
    if (!snapshotValid(receipt, id)) throw new OrchError('invalid compact evidence', 'retention-unreadable');
    if (digest(fs.readFileSync(paths(cfg, id).record)) !== receipt.snapshot.run_sha256) throw new OrchError('terminal record changed since snapshot', 'retention-changed');
    if (authorization && !receipt.authorization) { receipt.authorization = authorization; write(file, receipt); }
    for (const [key, name] of Object.entries(FILES)) {
      const target = safe(path.join(paths(cfg, id).dir, name));
      const previous = receipt.files[key];
      if (previous.state === 'purged' && !fs.existsSync(target)) continue;
      if (Date.now() >= deadline) throw new OrchError('maintenance time budget reached', 'retention-budget');
      const check = await planRun(cfg, id, policy, deadline);
      if (!['eligible', 'collected'].includes(check.state)) throw new OrchError(check.reason || 'dependency changed', 'retention-changed');
      if (fs.existsSync(target)) {
        if (stamp(target) !== previous.identity || digest(readPayload(target)) !== previous.sha256) throw new OrchError('artifact content or identity changed before collection', 'retention-changed');
        previous.state = 'deleting'; write(file, receipt);
        // Revalidate after receipt publication, immediately before the exact unlink.
        if (stamp(safe(target)) !== previous.identity || digest(readPayload(target)) !== previous.sha256) throw new OrchError('artifact changed during collection', 'retention-changed');
        fs.unlinkSync(target);
      } else if (!['deleting', 'purged'].includes(previous.state)) throw new OrchError('artifact unexpectedly missing', 'retention-changed');
      previous.state = 'purged'; receipt.state = 'partial'; write(file, receipt);
    }
    receipt.state = 'complete'; receipt.completed_at = nowIso(); delete receipt.error; write(file, receipt);
    return { ...plan, state: 'collected', removed_bytes: plan.bytes };
  } catch (e) {
    if (receipt) { receipt.error = e.message; receipt.state = 'partial'; write(file, receipt); }
    const removed = receipt ? Object.entries(FILES).filter(([key, name]) => receipt.files[key].state === 'purged' && !fs.existsSync(path.join(paths(cfg, id).dir, name))).reduce((n, [key]) => n + receipt.files[key].bytes, 0) : 0;
    return { ...plan, state: 'pending', reason: e.message, removed_bytes: Math.min(plan.bytes, removed) };
  }
}

async function control(cfg, args) {
  requireOperator(args);
  const id = checkedId(args.enroll || args.pin || args.unpin);
  let rec = readStrict(paths(cfg, id).record);
  if (!rec || rec.id !== id) throw new OrchError('no such run or invalid record', 'no-such-run');
  return withWpOperation(cfg, rec.wp, () => withRunOperation(cfg, id, async () => {
    const current = readStrict(paths(cfg, id).record);
    if (!current || current.id !== id || current.wp !== rec.wp) throw new OrchError('run changed while acquiring guard', 'retention-changed');
    rec = current;
    if (args.enroll) {
      if (!TERMINAL.has(rec.status)) throw new OrchError('enrollment requires a terminal run', 'run-not-finished');
      const live = await quiescent(cfg, rec, Date.now() + 4000);
      if (live) throw new OrchError(live, 'retention-live');
      if (readStrict(retentionFile(cfg, 'owned', id))) {
        const prior = owned(cfg, id);
        if (rec.wp || prior.source !== 'orch-run') throw new OrchError('run already enrolled or creation intent incomplete', 'retention-owned');
        if (!prior.finalized_at) write(retentionFile(cfg, 'owned', id), { ...prior, finalized_at: nowIso(), finalization: { by: args.by, reason: args.reason, at: nowIso() } });
        return { id, state: 'finalized', by: prior.finalization ? prior.finalization.by : args.by };
      }
      const P = paths(cfg, id), files = {}, sealed_hashes = {};
      for (const [key, name] of Object.entries(FILES)) {
        const f = safe(path.join(P.dir, name));
        if (!fs.lstatSync(f).isFile()) throw new OrchError('enrollment requires regular files', 'retention-path-unsafe');
        files[key] = stamp(f); sealed_hashes[key] = digest(readPayload(f));
      }
      const doc = { version: 1, id, state: 'confirmed', source: 'operator-enrollment', by: args.by, reason: args.reason, enrolled_at: nowIso(), finalized_at: nowIso(), state_root: path.resolve(cfg.stateRoot), state_identity: stamp(safe(cfg.stateRoot)), runs_identity: stamp(safe(cfg.runsDir)), dir: safe(P.dir), dir_identity: stamp(P.dir), files, sealed_hashes };
      if (!publishExclusive(retentionFile(cfg, 'owned', id), JSON.stringify(doc)).created) throw new OrchError('already enrolled', 'retention-owned');
      return { id, state: 'enrolled', by: args.by };
    }
    const file = retentionFile(cfg, 'pins', id);
    const prior = readStrict(file);
    const doc = { version: 1, id, active: !!args.pin, by: args.by, reason: args.reason, at: nowIso(), history: [...(prior && prior.history || []), ...(prior ? [{ active: prior.active, by: prior.by, reason: prior.reason, at: prior.at }] : [])] };
    write(file, doc);
    return { id, state: doc.active ? 'pinned' : 'unpinned' };
  }));
}
async function maintain(cfg, args, policy) {
  const deadline = Date.now() + policy.maxMs;
  let ids = args.run ? [checkedId(args.run)] : fs.existsSync(safe(cfg.runsDir)) ? fs.readdirSync(cfg.runsDir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).sort() : [];
  if (args.after) { checkedId(args.after); ids = ids.filter((id) => id > args.after); }
  const runs = [];
  let used = 0;
  for (const id of ids) {
    if (runs.length >= policy.maxRuns || Date.now() >= deadline) break;
    let plan = await planRun(cfg, id, policy, deadline);
    if (plan.state === 'eligible' && used + plan.bytes > policy.maxBytes) plan = { ...plan, state: 'deferred', reason: 'maintenance byte budget reached' };
    if (args.apply && plan.state === 'eligible') {
      try {
        const rec = readRun(cfg, id);
        const collect = () => withRunOperation(cfg, id, () => collectRun(cfg, id, policy, deadline, args.authorization));
        // Same package guard, with no wait: opportunistic maintenance must not queue
        // behind a controller or worker launch beyond its own budget.
        plan = rec && rec.wp ? await withOperationLock(cfg, `wp:${wpKey(rec.wp)}`, collect) : await collect();
      } catch (e) { plan = { ...plan, state: 'pending', reason: e.message }; }
    }
    if (['eligible', 'collected', 'pending'].includes(plan.state)) used += plan.bytes;
    runs.push(plan);
  }
  const pending = runs.some((r) => r.state === 'pending' || r.pending_cleanup && r.state !== 'collected');
  const counts = runs.reduce((o, r) => ({ ...o, [r.state]: (o[r.state] || 0) + 1 }), {});
  return { state: pending ? 'pending' : 'complete', policy_mode: policy.mode, dry_run: !args.apply, runs, counts, scanned: runs.length, unscanned: ids.length - runs.length, truncated: runs.length < ids.length, next_after: runs.length < ids.length ? runs.length ? runs[runs.length - 1].id : args.after || null : null, eligible_bytes: runs.filter((r) => ['eligible', 'deferred'].includes(r.state)).reduce((n, r) => n + r.bytes, 0), deferred_bytes: runs.filter((r) => r.state === 'deferred').reduce((n, r) => n + r.bytes, 0), protected_bytes: runs.filter((r) => ['protected', 'legacy'].includes(r.state)).reduce((n, r) => n + r.bytes, 0), removed_bytes: runs.reduce((n, r) => n + (r.removed_bytes || 0), 0), exitCode: pending ? 3 : 0 };
}
/** @param {{log:(s:string)=>void}} [io] */
export async function cmdMaintain(cfg, args, io = console) {
  const known = new Set(['_', 'json', 'state-root', 'dry-run', 'apply', 'run', 'after', 'enroll', 'pin', 'unpin', 'by', 'reason']);
  if (Object.keys(args).some((k) => !known.has(k)) || args._ && args._.length) throw new OrchError('unsupported maintenance option', 'bad-retention-option');
  if (args.force || args['delete-branch']) throw new OrchError('maintenance cannot force deletion', 'bad-retention-option');
  const controls = ['enroll', 'pin', 'unpin'].filter((k) => args[k]);
  if (controls.length > 1 || controls.length && (args.apply || args['dry-run'] || args.run)) throw new OrchError('choose one maintenance operation', 'bad-retention-option');
  if (args.apply && args['dry-run']) throw new OrchError('choose preview or apply', 'bad-retention-option');
  if (args.run && args.after) throw new OrchError('choose an explicit --run or an inventory --after selector', 'bad-retention-option');
  let out;
  if (controls.length) out = await control(cfg, args);
  else {
    let policy = retentionPolicy(cfg);
    if (policy.mode === 'disabled' && args.apply && args.run) {
      requireOperator(args);
      args = { ...args, authorization: { by: args.by, reason: args.reason, at: nowIso(), overrode_policy: true, configured_policy: policy } };
      policy = { ...policy, mode: 'manual', successDays: 0, otherDays: 0 };
    }
    if (args.apply && policy.mode === 'disabled') out = { state: 'disabled', runs: [], removed_bytes: 0 };
    else out = args.apply ? await withOperationLock(cfg, 'retention:collector', () => maintain(cfg, args, policy)) : await maintain(cfg, args, policy);
  }
  io.log(args.json ? JSON.stringify(out, null, 2) : `${out.state}${out.runs ? `: ${out.scanned || 0} runs inspected, ${out.removed_bytes || 0} bytes removed\n${out.runs.map((r) => `${r.id}: ${r.state}${r.reason ? ` (${r.reason})` : ''}`).join('\n')}` : `: ${out.id}`}`);
  return out;
}

export async function maintainOnUse(cfg) {
  try {
    const policy = retentionPolicy(cfg);
    if (policy.mode !== 'on-use') return null;
    return await withOperationLock(cfg, 'retention:collector', async () => {
      const file = safe(path.join(cfg.stateRoot, 'retention', 'on-use.json'));
      const last = readStrict(file);
      const at = last && timestamp(last.at);
      if (last && (at === null || at > Date.now())) return { state: 'pending', reason: 'invalid or future maintenance clock' };
      if (at && Date.now() - at < policy.minIntervalMs) return { state: 'interval', removed_bytes: 0 };
      const started = nowIso();
      write(file, { at: started, after: last && last.after || null }); // reserve before starting; a crash cannot cause a tight loop
      const out = await maintain(cfg, { apply: true, after: last && last.after }, policy);
      write(file, { at: started, after: out.next_after });
      return out;
    });
  } catch (e) { return { state: 'pending', reason: e.message }; }
}
