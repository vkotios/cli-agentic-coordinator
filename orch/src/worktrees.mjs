// Implementation worktrees and the scope command (slice 2).
//
// Destructive git operations happen ONLY on explicit command, ONLY on worktrees and
// branches orch created and recorded, and a worktree with uncommitted changes is
// refused unless --force (lesson 4 of the slice-2 brief).
//
// Files: <state-root>/worktrees/<id>.json   written by `orch worktree create` (create)
//        and `orch worktree remove` (the removal fields)
//        <run dir>/scope.json                 sole writer: `orch scope`
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OrchError } from './errors.mjs';
import { nowIso, readJson, writeJsonAtomic, readTailLines } from './util.mjs';
import { git, gitOk, splitZ, topLevel, resolveCommit, worktreeList, samePath } from './git.mjs';
import { requireClaim, wpKey } from './claims.mjs';
import { paths, readRun, keeperFacts } from './store.mjs';
import { evaluateScope } from './scope.mjs';

const wtDir = (cfg) => path.join(cfg.stateRoot, 'worktrees');
const wtFile = (cfg, id) => path.join(wtDir(cfg), `${id}.json`);

export function sliceKey(slice) {
  const s = String(slice ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(s)) {
    throw new OrchError(`invalid slice id "${s}" (letters, digits, . _ - ; max 60)`, 'bad-slice');
  }
  return s.toLowerCase();
}

export function listWorktreeRecords(cfg) {
  let files = [];
  try {
    files = fs.readdirSync(wtDir(cfg)).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    files = [];
  }
  return files
    .sort()
    .map((f) => readJson(path.join(wtDir(cfg), f), null))
    .filter(Boolean);
}

/** The recorded, not-yet-removed worktree whose path is `dir`, if any. */
export function worktreeRecordForDir(cfg, dir) {
  return listWorktreeRecords(cfg).find((r) => !r.removed_at && samePath(r.path, dir)) || null;
}

export async function cmdWorktree(cfg, args, io) {
  const sub = (args._ || [])[0];
  if (sub === 'create') return worktreeCreate(cfg, args, io);
  if (sub === 'list') return worktreeListCmd(cfg, args, io);
  if (sub === 'remove') return worktreeRemove(cfg, args, io);
  throw new OrchError('usage: orch worktree create|list|remove ...', 'missing-arg');
}

async function worktreeCreate(cfg, args, io) {
  const repoArg = req(args, 'repo');
  const wp = req(args, 'wp');
  const slice = req(args, 'slice');
  const by = req(args, 'by');
  const wk = wpKey(wp);
  const sk = sliceKey(slice);
  requireClaim(cfg, wp, by);

  const repo = path.resolve(repoArg);
  if (!fs.existsSync(repo)) throw new OrchError(`--repo does not exist: ${repo}`, 'bad-repo');
  const topRaw = await topLevel(repo);
  if (!topRaw) throw new OrchError(`--repo is not inside a git work tree: ${repo}`, 'bad-repo');
  const top = path.resolve(topRaw);
  const baseRef = args.base || 'HEAD';
  const baseline = await resolveCommit(top, baseRef);
  if (!baseline) throw new OrchError(`--base ${baseRef} does not resolve to a commit in ${top}`, 'bad-base');

  const branch = `orch/${wk}/${sk}`;
  const wtPath = path.join(top, '.worktrees', `${wk}-${sk}`);
  if (fs.existsSync(wtPath)) throw new OrchError(`refusing: ${wtPath} already exists (orch never reuses or overwrites a path)`, 'path-exists');
  const br = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: top });
  if (br.ok && br.stdout.trim()) throw new OrchError(`refusing: branch ${branch} already exists`, 'branch-exists');

  const exclude = await ensureWorktreesExcluded(top);
  await gitOk(['worktree', 'add', '-b', branch, wtPath, baseline], { cwd: top, timeoutMs: 120000 });
  let real = wtPath;
  try {
    real = fs.realpathSync.native(wtPath);
  } catch {
    /* keep the resolved path */
  }
  const id = `wt-${wk}-${sk}-${crypto.randomBytes(3).toString('hex')}`;
  const rec = {
    id,
    wp,
    slice,
    by,
    repo: top,
    path: real,
    branch,
    base_ref: baseRef,
    baseline,
    created_at: nowIso(),
    created_by: 'orch worktree create',
    info_exclude: exclude,
  };
  writeJsonAtomic(wtFile(cfg, id), rec);
  emit(args, io, { ...rec, exitCode: undefined }, `worktree ${id}\n  path ${real}\n  branch ${branch}\n  baseline ${baseline} (${baseRef})`);
  return { ...rec, exitCode: 0 };
}

async function worktreeListCmd(cfg, args, io) {
  const rows = [];
  for (const r of listWorktreeRecords(cfg)) {
    const exists = fs.existsSync(r.path);
    let dirty = null;
    if (exists && !r.removed_at) {
      const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: r.path });
      dirty = st.ok ? splitZ(st.stdout).length : null;
    }
    rows.push({ id: r.id, wp: r.wp, slice: r.slice, path: r.path, branch: r.branch, baseline: r.baseline, created_at: r.created_at, removed_at: r.removed_at || null, exists, dirty_entries: dirty });
  }
  if (args.json) io.log(JSON.stringify({ worktrees: rows }, null, 2));
  else if (!rows.length) io.log('(no recorded worktrees)');
  else {
    for (const r of rows) {
      const state = r.removed_at ? `removed ${r.removed_at}` : r.exists ? `present, ${r.dirty_entries === null ? 'status unknown' : `${r.dirty_entries} uncommitted entr${r.dirty_entries === 1 ? 'y' : 'ies'}`}` : 'MISSING on disk';
      io.log(`${r.id}  ${r.wp}/${r.slice}  ${r.branch}  ${state}\n  ${r.path}`);
    }
  }
  return { worktrees: rows, exitCode: 0 };
}

async function worktreeRemove(cfg, args, io) {
  const id = (args._ || [])[1];
  if (!id) throw new OrchError('usage: orch worktree remove <id> [--force] [--delete-branch]', 'missing-arg');
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new OrchError(`invalid worktree id "${id}"`, 'bad-id');
  const file = wtFile(cfg, id);
  const rec = readJson(file, null);
  if (!rec) throw new OrchError(`no orch-recorded worktree ${id}: orch removes only worktrees it created and recorded`, 'not-recorded');
  if (rec.removed_at) {
    const out = { id, remove: 'already-removed', removed_at: rec.removed_at };
    emit(args, io, out, `${id} was already removed at ${rec.removed_at}`);
    return { ...out, exitCode: 0 };
  }
  const force = !!args.force;
  const list = await worktreeList(rec.repo);
  if (!list) throw new OrchError(`cannot list worktrees of ${rec.repo}; nothing removed`, 'git-failed');
  const entry = list.find((w) => samePath(w.path, rec.path));
  if (!entry) {
    throw new OrchError(`${rec.path} is not a registered worktree of ${rec.repo} any more; nothing removed (inspect it yourself)`, 'not-registered');
  }
  if (entry.branch && entry.branch !== `refs/heads/${rec.branch}`) {
    throw new OrchError(`${rec.path} is on ${entry.branch}, not the recorded ${rec.branch}; nothing removed`, 'branch-changed');
  }
  const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: rec.path });
  if (!st.ok) throw new OrchError(`git status failed in ${rec.path}; refusing to remove what cannot be inspected`, 'git-failed');
  const dirty = splitZ(st.stdout);
  if (dirty.length && !force) {
    const out = { id, remove: 'refused', reason: 'uncommitted changes', entries: dirty.slice(0, 50) };
    emit(args, io, out, `remove refused: ${rec.path} has ${dirty.length} uncommitted entr${dirty.length === 1 ? 'y' : 'ies'}:\n  ${dirty.slice(0, 20).join('\n  ')}\nCommit them, or pass --force to discard them.`);
    return { ...out, exitCode: 3 };
  }
  await gitOk(['worktree', 'remove', ...(force ? ['--force'] : []), rec.path], { cwd: rec.repo, timeoutMs: 120000 });
  let branchResult = 'kept';
  if (args['delete-branch']) {
    // -d refuses an unmerged branch; -D only with --force.
    const d = await git(['branch', force ? '-D' : '-d', rec.branch], { cwd: rec.repo });
    branchResult = d.ok ? 'deleted' : `not deleted: ${d.stderr.trim()}`;
  }
  const stillThere = fs.existsSync(rec.path);
  rec.removed_at = nowIso();
  rec.removed_by = args.by || null;
  rec.removed_forced = force;
  rec.discarded_entries = force ? dirty.slice(0, 200) : [];
  rec.branch_result = branchResult;
  rec.path_still_exists = stillThere;
  writeJsonAtomic(file, rec);
  const out = { id, remove: 'removed', forced: force, discarded_entries: rec.discarded_entries.length, branch: rec.branch, branch_result: branchResult, path_still_exists: stillThere };
  emit(args, io, out, `removed ${id} (${rec.path})${force && dirty.length ? ` - ${dirty.length} uncommitted entries DISCARDED (--force)` : ''}; branch ${rec.branch}: ${branchResult}${stillThere ? '\n  WARNING: the directory still exists on disk' : ''}`);
  return { ...out, exitCode: 0 };
}

/**
 * Follow-up 3 (slice-2 smoke): keep `.worktrees/` out of the managed repo's `git status`
 * through `<common git dir>/info/exclude` - the repository-local, UNTRACKED exclude file.
 * Never `.gitignore` (a tracked file). Idempotent: an existing `/.worktrees/` or
 * `.worktrees/` line is left alone; otherwise one line is appended.
 * @returns {Promise<{file:string, action:string}>}
 */
export async function ensureWorktreesExcluded(top) {
  const r = await git(['rev-parse', '--git-common-dir'], { cwd: top });
  if (!r.ok || !r.stdout.trim()) throw new OrchError(`cannot find the git directory of ${top}`, 'git-failed');
  const common = path.resolve(top, r.stdout.trim());
  const file = path.join(common, 'info', 'exclude');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (/** @type {any} */ e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  const present = text.split(/\r?\n/).some((l) => ['/.worktrees/', '.worktrees/', '/.worktrees', '.worktrees'].includes(l.trim()));
  if (present) return { file, action: 'already-present' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sep = text.length && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${sep}# added by orch worktree create: orch keeps implementation worktrees here\n/.worktrees/\n`);
  return { file, action: 'appended' };
}

/* ------------------------------------------------------------------ scope -- */

export async function cmdScope(cfg, args, io) {
  const id = (args._ || [])[0];
  if (!id) throw new OrchError('usage: orch scope <run-id> [--json]', 'missing-arg');
  const rec = readRun(cfg, id);
  if (!rec) throw new OrchError(`no such run: ${id}`, 'no-such-run');
  if (!rec.scope) throw new OrchError(`run ${id} has no allowlist/baseline (start it with --wp/--slice and --allow or an ALLOW: block)`, 'no-scope');
  const P = paths(cfg, id);
  const facts = keeperFacts(readTailLines(P.keeper, 32768));
  if (!facts.workerExit && !facts.blocked) {
    throw new OrchError(`run ${id} has not finished (no worker-exit recorded); a scope check now would be premature`, 'run-not-finished');
  }
  const top = fs.existsSync(rec.dir) ? await topLevel(rec.dir) : null;
  const res = await evaluateScope({ top, baseline: rec.scope.baseline, allow: rec.scope.allow, orchWritten: rec.orch_written || [] });
  const out = { run_id: id, wp: rec.wp || null, slice: rec.slice || null, ...res };
  writeJsonAtomic(path.join(P.dir, 'scope.json'), out);
  if (args.json) io.log(JSON.stringify(out, null, 2));
  else {
    io.log(`scope ${out.result}: ${id}  baseline ${out.baseline}`);
    io.log(`  changed ${out.changed.length}, untracked ${out.untracked.length}, allowed ${out.allow.length}${out.exempt.length ? `, orch-written exempt ${out.exempt.length}` : ''}`);
    for (const p of out.offending) io.log(`  NOT ALLOWED: ${p}`);
    for (const e of out.errors) io.log(`  unknown: ${e}`);
  }
  return { ...out, exitCode: out.result === 'pass' ? 0 : out.result === 'fail' ? 3 : 4 };
}

/* ---------------------------------------------------------------- helpers -- */

function req(args, name) {
  const v = args[name];
  if (v === undefined || v === null || v === '' || v === true) throw new OrchError(`--${name} is required`, 'missing-arg');
  return Array.isArray(v) ? v[v.length - 1] : v;
}

function emit(args, io, obj, text) {
  if (args.json) io.log(JSON.stringify(obj, null, 2));
  else io.log(text);
}
