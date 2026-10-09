// Resource journal and operation locks. Never writes run/keeper/monitor records.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OrchError } from './errors.mjs';
import { nowIso, writeJsonAtomic, readTailLines, sleep } from './util.mjs';
import { publishExclusive } from './exclusive.mjs';
import { git, worktreeList, samePath, isInside } from './git.mjs';
import { wpKey, readClaim, requireClaim } from './claims.mjs';
import { paths, readRun, TERMINAL, keeperFacts } from './store.mjs';
import { readProcessTable, verifyIdentity } from './procs.mjs';
import { sha256File } from './scope.mjs';

const directory = (cfg) => path.join(cfg.stateRoot, 'resources');
export const resourceFile = (cfg, id) => {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new OrchError('invalid resource id', 'bad-id');
  return path.join(directory(cfg), `${id}.json`);
};
export function recordsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch { throw new OrchError(`unreadable record ${path.join(dir, f)}; refusing to guess`, 'record-unreadable'); }
  });
}
export const listResources = (cfg) => recordsIn(directory(cfg));
export function readResource(cfg, id) {
  try { return JSON.parse(fs.readFileSync(resourceFile(cfg, id), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new OrchError(`unreadable resource ${id}`, 'record-unreadable'); }
}
export function saveResource(cfg, r) { writeJsonAtomic(resourceFile(cfg, r.id), r); }

/** Resolve even nonexistent descendants using the nearest existing ancestor. */
export function resolvedPath(p) {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return fs.realpathSync.native(abs);
  const parent = path.dirname(abs);
  if (parent === abs) throw new OrchError(`cannot resolve ${abs}`, 'path-unreadable');
  return path.join(resolvedPath(parent), path.basename(abs));
}
function stamp(p) {
  const s = fs.statSync(p, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
// A failed Windows Git removal may have removed the admin record already. Only
// exact, unchanged files/directories observed BEFORE that attempt can be retried.
function snapshotFiles(root) {
  const files = {};
  const dirs = {};
  const walk = (dir) => {
    const rel = path.relative(root, dir).replace(/\\/g, '/');
    dirs[rel] = stamp(dir);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (fs.lstatSync(file).isSymbolicLink()) throw new OrchError('linked content requires explicit retention', 'resource-content-linked');
      if (e.isDirectory()) walk(file);
      else {
        const sha = sha256File(file);
        if (!sha) throw new OrchError('resource content unreadable', 'resource-content-unreadable');
        files[path.relative(root, file).replace(/\\/g, '/')] = { sha256: sha, identity: stamp(file) };
      }
    }
  };
  walk(root);
  return { files, dirs };
}
function remainingSnapshotMatches(r) {
  try {
    const before = r.removal_snapshot;
    if (!before) return false;
    const current = snapshotFiles(r.path);
    return Object.entries(current.files).every(([p, v]) => before.files[p] && before.files[p].identity === v.identity && before.files[p].sha256 === v.sha256)
      && Object.entries(current.dirs).every(([p, v]) => before.dirs[p] === v);
  } catch { return false; }
}
async function inspectPartialRemoval(r, entry) {
  if (entry || r.state !== 'cleanup-pending' || !r.removal_snapshot || fs.existsSync(r.identity.admin_dir) || !remainingSnapshotMatches(r)) return false;
  if (r.branch) {
    const head = await git(['rev-parse', '--verify', `refs/heads/${r.branch}`], { cwd: r.repo });
    if (!head.ok || head.stdout.trim() !== r.removal_snapshot.head) return false;
  }
  return true;
}
function removePartialFiles(r) {
  if (!remainingSnapshotMatches(r)) throw new OrchError('partial cleanup content changed', 'resource-content-changed');
  const snapshot = snapshotFiles(r.path);
  for (const [rel, before] of Object.entries(snapshot.files)) {
    const file = path.join(r.path, rel);
    if (!samePath(file, resolvedPath(file)) || stamp(r.path) !== r.identity.path || stamp(file) !== before.identity || sha256File(file) !== before.sha256) throw new OrchError('partial cleanup identity changed', 'resource-content-changed');
    fs.unlinkSync(file); // exact journaled file, never recursive deletion
  }
  for (const rel of Object.keys(snapshot.dirs).sort((a, b) => b.length - a.length)) {
    const dir = path.join(r.path, rel);
    if (!samePath(dir, resolvedPath(dir)) || stamp(dir) !== snapshot.dirs[rel]) throw new OrchError('partial cleanup directory changed', 'resource-content-changed');
    fs.rmdirSync(dir); // only succeeds while empty
  }
}
export async function withOperationLock(cfg, key, fn, waitMs = 0) {
  const name = crypto.createHash('sha256').update(key).digest('hex');
  const file = path.join(directory(cfg), 'locks', `${name}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const data = JSON.stringify({ token, pid: process.pid, at: nowIso(), key });
  const until = Date.now() + waitMs;
  while (!publishExclusive(file, data).created) {
    if (Date.now() >= until) throw new OrchError(`operation locked: ${key}; inspect an interrupted lock, never take it over automatically`, 'resource-locked');
    await sleep(25);
  }
  try { return await fn(); }
  finally {
    // Only remove the lock we acquired; never a replaced lock.
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch { /* preserve an uncertain lock */ }
  }
}
export const withWpOperation = (cfg, wp, fn) => wp ? withOperationLock(cfg, `wp:${wpKey(wp)}`, fn, 5000) : fn();
export const withResourceLock = (cfg, r, fn) => withOperationLock(cfg, `path:${path.resolve(r.path).replace(/\\/g, '/').toLowerCase()}`, fn);
export const closureFile = (cfg, wp) => path.join(cfg.stateRoot, 'finishes', `${wpKey(wp)}.json`);
export function readClosure(cfg, wp) {
  try { return JSON.parse(fs.readFileSync(closureFile(cfg, wp), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new OrchError('package closure unreadable', 'record-unreadable'); }
}
export function cleanupAuthority(cfg, wp, by) {
  const current = readClaim(cfg, wp);
  const closed = readClosure(cfg, wp);
  if (current.state === 'ok') {
    if (closed && closed.claim_token !== current.value.token && closed.by === by) throw new OrchError('package has a new claim; old cleanup authority is refused', 'package-reclaimed');
    return requireClaim(cfg, wp, by);
  }
  if (current.state === 'absent' && closed && closed.by === by && closed.closed_at) return { token: closed.claim_token, closed: true };
  throw new OrchError('cleanup requires the current claim holder or its recorded closed package authority', 'not-claimed');
}
export function assertPackageOpen(cfg, wp, by) {
  if (!wp) return;
  const claim = requireClaim(cfg, wp, by);
  const closed = readClosure(cfg, wp);
  if (closed && closed.claim_token === claim.token && closed.closed_at) throw new OrchError('package is logically closed; acquire a new claim before reopening', 'package-closed');
}

export async function beginResource(cfg, spec) {
  const repo = resolvedPath(spec.repo);
  const root = resolvedPath(spec.root);
  const target = path.resolve(spec.path);
  if (!samePath(target, resolvedPath(target)) || !isInside(target, root) || samePath(target, root)) {
    throw new OrchError('resource path escapes its root or traverses a link', 'resource-path-unsafe');
  }
  if (fs.existsSync(target)) throw new OrchError('resource path already exists', 'path-exists');
  const common = await git(['rev-parse', '--git-common-dir'], { cwd: repo });
  if (!common.ok) throw new OrchError('cannot identify source repository', 'git-failed');
  const commonDir = resolvedPath(path.resolve(repo, common.stdout.trim()));
  const claim = spec.wp ? requireClaim(cfg, spec.wp, spec.by) : null;
  const r = { ...spec, claim_token: claim ? claim.token : null, repo, root, path: target, common_dir: commonDir, common_identity: stamp(commonDir), state: 'intent', created_at: nowIso(), attempts: [] };
  if (!publishExclusive(resourceFile(cfg, r.id), JSON.stringify(r, null, 2) + '\n').created) throw new OrchError('resource already recorded', 'resource-exists');
  return r;
}
export async function confirmResource(cfg, r) {
  const admin = await git(['rev-parse', '--absolute-git-dir'], { cwd: r.path });
  if (!admin.ok) throw new OrchError('cannot identify created worktree', 'git-failed');
  const adminDir = resolvedPath(admin.stdout.trim());
  Object.assign(r, { state: 'present', identity: { path: stamp(r.path), admin_dir: adminDir, admin: stamp(adminDir) }, confirmed_at: nowIso() });
  saveResource(cfg, r);
  return r;
}

export async function inspectIdentity(r) {
  try {
    if (!r.identity) return { ok: false, reason: 'creation intent lacks confirmed identity; inspect before adopting' };
    if (!samePath(r.path, resolvedPath(r.path)) || !samePath(r.root, resolvedPath(r.root)) || !isInside(r.path, r.root) || samePath(r.path, r.root)) return { ok: false, reason: 'path identity changed or link escapes root' };
    if (stamp(r.common_dir) !== r.common_identity || !samePath(r.common_dir, resolvedPath(r.common_dir))) return { ok: false, reason: 'source repository identity changed' };
    const list = await worktreeList(r.repo);
    if (!list) return { ok: false, reason: 'registration unreadable' };
    const entry = list.find((w) => samePath(w.path, r.path));
    if (!entry && !fs.existsSync(r.path)) return { ok: true, absent: true };
    if (!entry && fs.existsSync(r.path) && stamp(r.path) === r.identity.path && await inspectPartialRemoval(r, entry)) return { ok: true, partial: true };
    if (!entry || entry.locked || entry.prunable || (r.branch ? entry.branch !== `refs/heads/${r.branch}` : !entry.detached)) return { ok: false, reason: 'registration changed, locked, or shared' };
    if (!fs.existsSync(r.path) || stamp(r.path) !== r.identity.path) return { ok: false, reason: 'worktree path identity changed' };
    const admin = await git(['rev-parse', '--absolute-git-dir'], { cwd: r.path });
    const common = await git(['rev-parse', '--git-common-dir'], { cwd: r.path });
    if (!admin.ok || !common.ok || !samePath(resolvedPath(admin.stdout.trim()), r.identity.admin_dir) || stamp(r.identity.admin_dir) !== r.identity.admin || !samePath(resolvedPath(path.resolve(r.path, common.stdout.trim())), r.common_dir)) return { ok: false, reason: 'worktree administrative identity changed' };
    return { ok: true, entry };
  } catch { return { ok: false, reason: 'resource identity unreadable' }; }
}

/** Every run referring to this directory is a dependency, regardless of WP. */
export async function dependentRunBlock(cfg, r) {
  let runs;
  try {
    const root = cfg.runsDir;
    runs = fs.existsSync(root) ? fs.readdirSync(root).filter((f) => fs.statSync(path.join(root, f)).isDirectory()).map((id) => {
      const file = paths(cfg, id).record;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }) : [];
  } catch { return 'run inventory unreadable'; }
  for (const run of runs) {
    let depends = isInside(run.dir_real || run.dir, r.path) || (run.scope && run.scope.worktree_id === r.id);
    if (!depends && run.dir) {
      try { depends = isInside(resolvedPath(run.dir), r.path); }
      catch { return `run ${run.id} directory identity unreadable`; }
    }
    if (!depends) continue;
    if (!TERMINAL.has(run.status)) return `dependent run ${run.id} is active or starting`;
    const P = paths(cfg, run.id);
    const f = keeperFacts(readTailLines(P.keeper, 32768));
    let spawned = {};
    try { spawned = JSON.parse(fs.readFileSync(P.spawned, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return `run ${run.id} process record unreadable`; }
    const checks = [];
    if (!f.workerExit && !f.blocked) {
      if (!f.workerPid || !f.workerCreatedAt) return `run ${run.id} worker liveness unknown`;
      checks.push([f.workerPid, f.workerCreatedAt]);
    }
    if (!f.keeperExit) {
      if (!spawned.keeper_pid || !spawned.keeper_created_at) return `run ${run.id} keeper liveness unknown`;
      checks.push([spawned.keeper_pid, spawned.keeper_created_at]);
    }
    if (spawned.monitor_pid) checks.push([spawned.monitor_pid, spawned.monitor_created_at]);
    if (checks.length) {
      const table = await readProcessTable({ deadlineMs: 4000, pids: checks.map(([pid]) => pid) });
      for (const [pid, at] of checks) if (verifyIdentity(pid, at, table).verdict !== 'gone') return `run ${run.id} process ${pid} still live or uncertain`;
    }
  }
  return null;
}

export async function inspectRemoval(cfg, r, { force = false, review = null } = {}) {
  if (r.wp && r.claim_token) {
    const claim = readClaim(cfg, r.wp);
    if (claim.state === 'unreadable' || claim.state === 'ok' && claim.value.token !== r.claim_token) return { action: 'retain', reason: 'resource claim identity changed or unreadable' };
  }
  const identity = await inspectIdentity(r);
  if (!identity.ok) return { action: 'retain', reason: identity.reason };
  const active = await dependentRunBlock(cfg, r);
  if (active) return { action: 'retain', reason: active };
  if (identity.absent) return { action: 'remove', absent: true, dirty: [] };
  if (identity.partial) {
    if (r.kind === 'review' && (!review || !review.finished_at || !['clean', 'not-applicable'].includes(review.containment))) return { action: 'retain', reason: 'review incident or incomplete review' };
    return { action: 'remove', partial: true, dirty: [] };
  }
  if (r.kind === 'review') {
    if (!review || !review.finished_at) return { action: 'retain', reason: 'review is not finalized' };
    if (review.containment !== 'clean' && review.containment !== 'not-applicable') return { action: 'retain', reason: 'review incident or uncertain containment; evidence retained' };
    if (identity.entry.head !== r.baseline) return { action: 'retain', reason: 'review HEAD changed; evidence retained' };
  }
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored', '--no-renames'], { cwd: r.path });
  if (!status.ok) return { action: 'retain', reason: 'content unreadable' };
  const dirty = status.stdout.split('\0').filter(Boolean);
  const expected = new Set(review ? (review.blinded || []).map((p) => ` D ${p}`) : []);
  const exempt = r.owned_files || [];
  // Exemption is exact-file and exact-hash only; never exempt a whole directory.
  const extras = dirty.filter((e) => !expected.has(e) && !(['?? ', '!! '].includes(e.slice(0, 3)) && exempt.some((v) => v.path === e.slice(3) && v.sha256 && sha256File(path.join(r.path, v.path)) === v.sha256)));
  if (extras.length && !(force && r.kind === 'implementation')) return { action: 'retain', reason: 'uncommitted or ignored content', dirty: extras };
  if (r.kind === 'implementation' && !force) {
    // Unique commits must be reachable from a surviving, non-resource branch.
    const refs = await git(['for-each-ref', '--format=%(refname)', '--contains', 'HEAD', 'refs/heads', 'refs/remotes', 'refs/tags'], { cwd: r.path });
    if (!refs.ok) return { action: 'retain', reason: 'commit reachability unreadable' };
    const ownedBranches = listResources(cfg).filter((v) => samePath(v.common_dir, r.common_dir) && v.branch).map((v) => `refs/heads/${v.branch}`);
    if (!refs.stdout.trim().split(/\r?\n/).filter(Boolean).some((ref) => !ownedBranches.includes(ref))) return { action: 'retain', reason: 'unmerged commits remain in this worktree' };
  }
  return { action: 'remove', dirty };
}

export async function removeResource(cfg, r, opts = {}) {
  const decision = await inspectRemoval(cfg, r, opts);
  if (decision.action !== 'remove') return { id: r.id, state: 'retained', ...decision };
  r.state = 'cleanup-pending';
  if (!decision.absent && !decision.partial) {
    try {
      const head = await git(['rev-parse', 'HEAD'], { cwd: r.path });
      if (!head.ok) throw new Error('HEAD unreadable');
      r.removal_snapshot = { ...snapshotFiles(r.path), head: head.stdout.trim() };
    } catch { return { id: r.id, state: 'retained', action: 'retain', reason: 'removal snapshot unreadable or linked content; retained' }; }
  }
  const attempt = { at: nowIso(), state: 'pending' };
  r.attempts.push(attempt);
  saveResource(cfg, r); // intent before destructive Git operation
  let error = null;
  if (decision.partial) {
    try { removePartialFiles(r); } catch (e) { error = String(e.message || e); }
  } else if (!decision.absent) {
    const result = await git(['worktree', 'remove', ...((opts.force || r.kind === 'review') ? ['--force'] : []), r.path], { cwd: r.repo, timeoutMs: 120000 });
    if (!result.ok) error = result.stderr.trim() || 'Git removal failed';
  }
  const list = await worktreeList(r.repo);
  if (!error && (fs.existsSync(r.path) || !list || list.some((w) => samePath(w.path, r.path)))) error = 'removal could not be verified';
  Object.assign(attempt, { state: error ? 'cleanup-pending' : 'removed', error, ended_at: nowIso() });
  Object.assign(r, { state: attempt.state, cleanup_error: error, removed_at: error ? null : nowIso() });
  saveResource(cfg, r);
  return { id: r.id, state: r.state, action: 'remove', reason: error, dirty: decision.dirty || [] };
}

export async function guardRunResource(cfg, dir, fn) {
  const resources = listResources(cfg);
  if (!resources.length) return fn();
  const real = resolvedPath(dir);
  const r = resources.find((v) => isInside(real, v.path) || isInside(dir, v.path));
  if (!r) return fn();
  return withResourceLock(cfg, r, async () => {
    const current = readResource(cfg, r.id);
    if (!current || current.state !== 'present' || !(await inspectIdentity(current)).ok) throw new OrchError('run resource is not present with verified identity', 'resource-unavailable');
    const result = await fn();
    const run = result && result.id ? readRun(cfg, result.id) : null;
    if (run && run.orch_written && run.orch_written.length) {
      const owned = new Map((current.owned_files || []).map((v) => [v.path, v]));
      for (const item of run.orch_written) {
        const relative = path.relative(current.path, path.resolve(real, item.path)).replace(/\\/g, '/');
        owned.set(relative, { ...item, path: relative });
      }
      current.owned_files = [...owned.values()];
      saveResource(cfg, current);
    }
    return result;
  });
}
