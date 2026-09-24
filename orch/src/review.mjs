// `orch review` (slice 2, ORCHESTRATOR §6): a blind, read-only review in a throwaway
// DETACHED worktree, launched through the slice-1 run machinery, with a containment
// check afterwards.
//
//  1. refuse when the reviewer's canonical model equals the implementer's (warn when
//     only the family matches);
//  2. `git worktree add --detach <review-root>/<review-id> <commit>` - the review root is
//     neutral (default: a per-user directory under %LOCALAPPDATA%), never under the temp/scratch path
//     and never inside the source repo;
//  3. optionally delete the `--blind <glob>` files from that copy;
//  4. snapshot: review worktree HEAD + reflog + status; source repo HEAD + reflog +
//     status + refs + worktree list; implementer worktree HEAD + status;
//  5. launch the reviewer with cmdRun (role review, linked to the implementer run);
//  6. after the run: the review worktree status must show ONLY the blinding deletions
//     (plus a file orch itself wrote, while byte-identical), its HEAD and reflog must be
//     unchanged, and every source snapshot must be unchanged - otherwise the review is
//     `containment-breach`, with the evidence. A snapshot that could not be read makes
//     the answer `unknown`, never `clean`;
//  7. remove the review worktree (orch created and recorded it).
//
// Files: <state-root>/reviews/<review-id>.json  (sole writer: the `orch review` process
// running that review; `--finish` takes <review-id>.finish.lock with wx first).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrchError } from './errors.mjs';
import { loadConfig, setting, localAppData } from './config.mjs';
import { nowIso, readJson, writeJsonAtomic, readTailLines, sleep, newRunId } from './util.mjs';
import { git, gitOk, splitZ, resolveCommit, worktreeList, samePath, isInside, topLevel } from './git.mjs';
import { requireClaim } from './claims.mjs';
import { paths, readRun, keeperFacts, TERMINAL } from './store.mjs';
import { getAdapter } from './adapters/index.mjs';
import { canonicalId, familyOf, loadRoster } from './models.mjs';
import { normalizeRepoPath, sha256File } from './scope.mjs';
import { cmdRun } from './commands.mjs';

/**
 * The default review root: a neutral per-user directory, never the temp directory and
 * never inside a repository (`%LOCALAPPDATA%` + `cli-agentic-coordinator/reviews`).
 */
export function defaultReviewRoot() {
  return path.join(localAppData(), 'cli-agentic-coordinator', 'reviews');
}

/** --review-root > ORCH_REVIEW_ROOT > `reviewRoot` in orch.config.json > the default. */
export function resolveReviewRoot(explicit) {
  return path.resolve(explicit || setting('ORCH_REVIEW_ROOT', 'reviewRoot', defaultReviewRoot, { isPath: true }));
}

const reviewsDir = (cfg) => path.join(cfg.stateRoot, 'reviews');
const reviewFile = (cfg, id) => path.join(reviewsDir(cfg), `${id}.json`);

/** The review root must be neutral: not temp/scratch, not inside a repo under review. */
export function assertNeutralRoot(root, forbiddenParents) {
  const tmp = realOr(os.tmpdir());
  const r = realOr(root);
  if (isInside(r, tmp) || isInside(root, os.tmpdir())) {
    throw new OrchError(`review root ${root} is under the temp directory ${os.tmpdir()}; reviews must run under a neutral path`, 'review-root-not-neutral');
  }
  if (/[\\/](scratchpad|temp|tmp)([\\/]|$)/i.test(root)) {
    throw new OrchError(`review root ${root} looks like a scratch/temp path; reviews must run under a neutral path`, 'review-root-not-neutral');
  }
  for (const p of forbiddenParents.filter(Boolean)) {
    if (isInside(r, realOr(p)) || isInside(root, p)) {
      throw new OrchError(`review root ${root} is inside ${p}; a reviewer must not start inside the repository it could damage`, 'review-root-not-neutral');
    }
  }
}

function realOr(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Glob (`*`, `?`, `**`) to an anchored RegExp over '/'-separated repo paths. */
export function globToRegex(glob, ignoreCase) {
  const g = normalizeRepoPath(glob, false);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, ignoreCase ? 'i' : '');
}

/* ---------------------------------------------------------- snapshots ---- */

/** One snapshot field: the command's stdout, or `null` = could not be read. */
async function field(args, cwd) {
  const r = await git(args, { cwd });
  return r.ok ? r.stdout : null;
}

const STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored', '--no-renames'];

async function snapshotReviewWorktree(wt) {
  return {
    head: await field(['rev-parse', 'HEAD'], wt),
    reflog: await field(['reflog', 'show', '--format=%H %gs', 'HEAD', '--'], wt),
    status: await field(STATUS_ARGS, wt),
  };
}

/**
 * `git worktree list --porcelain`, minus the entries of orch's own review worktrees: a
 * second review running in parallel adds and removes its worktree during ours, and that
 * is not a breach by our reviewer.
 */
function worktreesMinusReviews(raw, reviewPaths) {
  if (raw === null) return null;
  return String(raw)
    .split(/\r?\n\r?\n/)
    .filter((block) => {
      const m = /^worktree (.+)$/m.exec(block);
      return !(m && reviewPaths.some((p) => samePath(p, m[1].trim())));
    })
    .join('\n\n');
}

function recordedReviewWorktrees(cfg) {
  try {
    return fs
      .readdirSync(reviewsDir(cfg))
      .filter((f) => /^rv-.*\.json$/.test(f))
      .map((f) => (readJson(path.join(reviewsDir(cfg), f), null) || {}).worktree)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * CODE-REVIEW FIX c2: the shared git administration a reviewer could change from inside
 * its detached worktree without moving any ref or touching any status: `config`
 * (`git config --local core.hooksPath ...`), `packed-refs`, everything under `info/`
 * and `hooks/`, and every linked worktree's `config.worktree`. One line per file:
 * `<relative path> <sha256>`; a missing directory is simply absent. `null` = the
 * common dir could not be found (-> unknown, never clean).
 */
async function adminFingerprint(source) {
  const r = await git(['rev-parse', '--git-common-dir'], { cwd: source });
  if (!r.ok || !r.stdout.trim()) return null;
  const common = path.resolve(source, r.stdout.trim());
  if (!fs.existsSync(common)) return null;
  const lines = [];
  const add = (rel) => {
    const abs = path.join(common, rel);
    lines.push(`${rel.replace(/\\/g, '/')} ${sha256File(abs) ?? 'unreadable'}`);
  };
  const walk = (rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(common, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = path.join(rel, e.name);
      if (e.isDirectory()) walk(child);
      else add(child);
    }
  };
  for (const f of ['config', 'packed-refs', 'config.worktree']) if (fs.existsSync(path.join(common, f))) add(f);
  walk('info');
  walk('hooks');
  try {
    for (const w of fs.readdirSync(path.join(common, 'worktrees'))) {
      if (fs.existsSync(path.join(common, 'worktrees', w, 'config.worktree'))) add(path.join('worktrees', w, 'config.worktree'));
    }
  } catch {
    /* no linked worktrees */
  }
  return lines.sort().join('\n');
}

async function snapshotSource(cfg, source, implDir) {
  const s = {
    admin: await adminFingerprint(source),
    head: await field(['rev-parse', 'HEAD'], source),
    reflog: await field(['reflog', 'show', '--format=%H %gs', 'HEAD', '--'], source),
    status: await field(STATUS_ARGS, source),
    refs: await field(['for-each-ref', '--format=%(refname) %(objectname)'], source),
    worktrees: worktreesMinusReviews(await field(['worktree', 'list', '--porcelain'], source), recordedReviewWorktrees(cfg)),
  };
  if (implDir && fs.existsSync(implDir) && !samePath(implDir, source)) {
    s.impl_head = await field(['rev-parse', 'HEAD'], implDir);
    s.impl_status = await field(STATUS_ARGS, implDir);
  }
  return s;
}

/** Porcelain v1 -z status entries: `XY path`. */
function statusEntries(raw) {
  return splitZ(raw);
}

/* -------------------------------------------------------------- command -- */

export async function cmdReview(args, io = console) {
  const cfg = loadConfig(args['state-root']);
  if (args.finish) return finishReview(cfg, String(args.finish), args, io);

  const implId = req(args, 'run');
  const impl = readRun(cfg, implId);
  if (!impl) throw new OrchError(`no such implementer run: ${implId}`, 'no-such-run');
  const reviewerCli = req(args, 'reviewer');
  const adapter = getAdapter(reviewerCli);
  if (adapter.testOnly && process.env.ORCH_ALLOW_FAKE !== '1') throw new OrchError(`--reviewer ${reviewerCli} is test-only`, 'test-only-cli');
  const model = req(args, 'model');
  const promptFile = path.resolve(req(args, 'prompt'));
  if (!fs.existsSync(promptFile)) throw new OrchError(`--prompt file does not exist: ${promptFile}`, 'bad-prompt');
  const ref = req(args, 'ref');
  const by = req(args, 'by');
  const wp = impl.wp || args.wp || null;
  if (wp) requireClaim(cfg, wp, by);

  // 1. reviewer != implementer, by canonical model id.
  const implModels = [impl.model_requested, impl.model_actual].filter(Boolean);
  const implCanon = [...new Set(implModels.map(canonicalId))];
  const revCanon = canonicalId(model);
  if (implCanon.includes(revCanon)) {
    throw new OrchError(
      `refused: reviewer model ${model} is the implementer's model (canonical "${revCanon}"; implementer ran ${implModels.join(' / ')}). A reviewer must be a different model.`,
      'same-model',
    );
  }
  let roster = null;
  try {
    roster = loadRoster().models;
  } catch {
    roster = null;
  }
  const implFamilies = [...new Set(implModels.map((m) => familyOf(m, roster)))];
  const revFamily = familyOf(model, roster);
  const warnings = [];
  if (implFamilies.includes(revFamily)) warnings.push(`reviewer ${model} is the same model FAMILY (${revFamily}) as the implementer; a different family is preferred`);

  // 2. the source repo, the commit, the neutral review root.
  if (!impl.dir || !fs.existsSync(impl.dir)) throw new OrchError(`the implementer's directory ${impl.dir} no longer exists`, 'bad-dir');
  const list = await worktreeList(impl.dir);
  if (!list || !list.length) throw new OrchError(`${impl.dir} is not inside a git repository`, 'bad-repo');
  const source = path.resolve(list[0].path);
  const implTop = await topLevel(impl.dir);
  const commit = await resolveCommit(impl.dir, ref);
  if (!commit) throw new OrchError(`--ref ${ref} does not resolve to a commit in ${impl.dir}`, 'bad-ref');
  const root = resolveReviewRoot(args['review-root']);
  assertNeutralRoot(root, [source, implTop, impl.dir]);

  const reviewId = `rv-${newRunId()}`;
  const wt = path.join(root, reviewId);
  if (fs.existsSync(wt)) throw new OrchError(`refusing: ${wt} already exists`, 'path-exists');
  fs.mkdirSync(root, { recursive: true });

  const rv = {
    id: reviewId,
    implementer_run: implId,
    implementer_models: implModels,
    wp,
    slice: impl.slice || null,
    by,
    reviewer_cli: reviewerCli,
    reviewer_model: model,
    reviewer_canonical: revCanon,
    warnings,
    ref,
    commit,
    source_repo: source,
    implementer_dir: impl.dir,
    review_root: root,
    worktree: wt,
    worktree_created: false,
    blind_globs: [].concat(args.blind || []),
    blinded: [],
    status: 'creating',
    created_at: nowIso(),
  };
  fs.mkdirSync(reviewsDir(cfg), { recursive: true });
  writeJsonAtomic(reviewFile(cfg, reviewId), rv);

  // CODE-REVIEW FIX c4: from the moment the worktree exists until the reviewer is launched,
  // ANY failure removes the worktree again (orch created and recorded it) and says so.
  let handoffFile = promptFile;
  try {
    await gitOk(['worktree', 'add', '--detach', wt, commit], { cwd: source, timeoutMs: 120000 });
    rv.worktree_created = true;
    writeJsonAtomic(reviewFile(cfg, reviewId), rv);
    handoffFile = await prepareReview(cfg, rv, { wt, source, impl, warnings, promptFile });
  } catch (e) {
    rv.status = 'setup-failed';
    rv.setup_error = String((e && e.message) || e);
    const rm = rv.worktree_created || fs.existsSync(wt) ? await removeReviewWorktree(rv) : { removed: true, error: null };
    rv.worktree_removed = rm.removed;
    rv.worktree_remove_error = rm.error;
    rv.finished_at = nowIso();
    rv.outcome = 'setup-failed';
    rv.containment = 'not-applicable';
    delete rv.pre;
    writeJsonAtomic(reviewFile(cfg, reviewId), rv);
    throw new OrchError(
      `review ${reviewId} failed during setup (nothing was launched): ${rv.setup_error}. Review worktree ${wt}: ${rm.removed ? 'removed' : `NOT removed (${rm.error})`}`,
      'review-setup-failed',
    );
  }

  // 5. launch through the slice-1 machinery.
  const captured = [];
  const quiet = { log: (s) => captured.push(String(s)) };
  let launch = null;
  try {
    launch = await cmdRun(
      {
        cli: reviewerCli,
        model,
        dir: wt,
        handoff: handoffFile,
        'state-root': args['state-root'],
        'no-window': !!args['no-window'],
        'no-monitor': false,
        flag: args.flag || [],
        'max-turns': args['max-turns'],
        'max-price': args['max-price'],
        effort: args.effort,
        'print-timeout': args['print-timeout'],
        agent: args.agent,
        'allow-non-ascii': !!args['allow-non-ascii'],
        'owner-approved-model': !!args['owner-approved-model'],
        json: true,
      },
      quiet,
      { role: 'review', recordExtra: { review_of: implId, review_id: reviewId, wp, slice: impl.slice || null, by } },
    );
  } catch (e) {
    rv.launch_error = String((e && e.message) || e);
  }
  rv.run_id = launch ? launch.id : null;
  rv.admission = launch ? launch.admission : 'launch-error';
  if (launch && launch.admission !== 'acquired') {
    const l = /** @type {any} */ (launch);
    rv.launch_error = `admission ${l.admission}: ${l.reason || l.holder_text || ''}`.trim();
  }
  rv.status = rv.run_id && launch.admission === 'acquired' ? 'running' : 'not-launched';
  writeJsonAtomic(reviewFile(cfg, reviewId), rv);

  if (rv.status === 'running' && args['no-wait']) {
    const out = { review_id: reviewId, run_id: rv.run_id, status: 'running', worktree: wt, warnings };
    emit(args, io, out, `review ${reviewId} running as run ${rv.run_id} in ${wt}\n  finish it with: orch review --finish ${reviewId} --by ${by}${warnings.map((w) => `\n  warning: ${w}`).join('')}`);
    return { ...out, exitCode: 0 };
  }
  if (rv.status === 'running') {
    const waitS = args['wait-timeout'] != null ? Number(args['wait-timeout']) : 3 * 3600;
    const done = await waitRunFinished(cfg, rv.run_id, waitS * 1000);
    if (!done) {
      const out = { review_id: reviewId, run_id: rv.run_id, status: 'still-running', worktree: wt };
      emit(args, io, out, `review ${reviewId}: the reviewer (run ${rv.run_id}) is still running after ${waitS}s. Nothing was killed and the worktree is kept.\n  finish later with: orch review --finish ${reviewId} --by ${by}`);
      return { ...out, exitCode: 4 };
    }
  }
  return finishReview(cfg, reviewId, args, io);
}

/**
 * Blinding, pre-launch snapshots and prompt materialisation. Any throw here is caught by
 * the caller, which removes the worktree (c4).
 * @returns {Promise<string>} the handoff file to launch with
 */
async function prepareReview(cfg, rv, { wt, source, impl, warnings, promptFile }) {
  const reviewId = rv.id;
  // 3. blinding - deletions inside the copy orch just made, nowhere else.
  const icRaw = await git(['config', '--bool', 'core.ignorecase'], { cwd: wt });
  const ic = icRaw.stdout.trim() === 'true';
  if (rv.blind_globs.length) {
    const files = splitZ(await gitOk(['ls-files', '-z'], { cwd: wt }));
    // CODE-REVIEW FIX a2: globs may overlap; each file is deleted once.
    const done = new Set();
    for (const g of rv.blind_globs) {
      const re = globToRegex(g, ic);
      const hits = files.filter((f) => re.test(normalizeRepoPath(f, false)));
      if (!hits.length) warnings.push(`--blind ${g} matched no tracked file`);
      for (const f of hits) {
        if (done.has(f)) continue;
        done.add(f);
        const abs = path.join(wt, f);
        if (!isInside(abs, wt)) continue;
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
        rv.blinded.push(f);
      }
    }
  }

  // 4. snapshots, before the launch.
  const wtPre = await snapshotReviewWorktree(wt);
  const srcPre = await snapshotSource(cfg, source, impl.dir);
  const expected = new Set(rv.blinded.map((f) => ` D ${f}`));
  const preEntries = wtPre.status === null ? null : statusEntries(wtPre.status);
  rv.blinding_verified =
    preEntries !== null &&
    rv.blinded.every((f) => !fs.existsSync(path.join(wt, f))) &&
    preEntries.length === expected.size &&
    preEntries.every((e) => expected.has(e));
  if (!rv.blinding_verified) warnings.push(`blinding could not be verified before launch: status ${JSON.stringify(preEntries)}`);
  rv.pre = { worktree: wtPre, source: srcPre };
  rv.status = 'launching';
  writeJsonAtomic(reviewFile(cfg, reviewId), rv);

  // The card's rule: name the absolute path to review in the prompt. The worktree path
  // is only known now, so a `{{WORKTREE}}` placeholder in the prompt is filled in, into
  // a copy kept next to the review record (the caller's file is never modified).
  let handoffFile = promptFile;
  const promptText = fs.readFileSync(promptFile, 'utf8');
  if (promptText.includes('{{WORKTREE}}')) {
    handoffFile = path.join(reviewsDir(cfg), `${reviewId}.prompt.txt`);
    fs.writeFileSync(handoffFile, promptText.split('{{WORKTREE}}').join(wt));
    rv.prompt_materialized = handoffFile;
  }
  return handoffFile;
}

/** Remove an orch-created review worktree; never anything unregistered. */
async function removeReviewWorktree(rv) {
  const wt = rv.worktree;
  const list = await worktreeList(rv.source_repo);
  const registered = list ? list.some((w) => samePath(w.path, wt)) : null;
  if (registered === false && !fs.existsSync(wt)) return { removed: true, error: null };
  if (!registered) return { removed: false, error: registered === null ? 'could not list worktrees' : `${wt} exists but is not a registered worktree; left alone` };
  const r = await git(['worktree', 'remove', '--force', wt], { cwd: rv.source_repo, timeoutMs: 120000 });
  if (!r.ok) return { removed: false, error: r.stderr.trim() };
  if (fs.existsSync(wt)) return { removed: false, error: 'git reported success but the directory still exists' };
  return { removed: true, error: null };
}

/** Wait (no kill, ever) for the reviewer's worker exit, then briefly for the final record. */
async function waitRunFinished(cfg, runId, maxMs) {
  const P = paths(cfg, runId);
  const until = Date.now() + Math.max(0, maxMs);
  for (;;) {
    const f = keeperFacts(readTailLines(P.keeper, 32768));
    if (f.workerExit || f.blocked) break;
    if (Date.now() >= until) return false;
    await sleep(500);
  }
  // The monitor writes the terminal record (with the model it reported) shortly after.
  const recUntil = Date.now() + 30000;
  while (Date.now() < recUntil) {
    const rec = readRun(cfg, runId);
    if (rec && TERMINAL.has(rec.status)) break;
    await sleep(300);
  }
  return true;
}

async function finishReview(cfg, reviewId, args, io) {
  if (!/^rv-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(reviewId)) throw new OrchError(`invalid review id ${reviewId}`, 'bad-id');
  const file = reviewFile(cfg, reviewId);
  const rv = readJson(file, null);
  if (!rv) throw new OrchError(`no such review: ${reviewId}`, 'no-such-review');
  if (rv.finished_at) {
    emit(args, io, rv, reviewText(rv));
    return { ...rv, exitCode: exitFor(rv) };
  }
  // CODE-REVIEW FIX c3: inspecting and REMOVING a WP review's worktree is a WP action -
  // the caller's --by must hold the claim now (not merely have held it at launch).
  if (rv.wp) {
    const by = args.by;
    if (!by || by === true) throw new OrchError(`--by is required to finish a review of work package ${rv.wp}`, 'missing-arg');
    requireClaim(cfg, rv.wp, String(by));
  }
  // The reviewer must be finished before anything is inspected or removed.
  if (rv.run_id) {
    const f = keeperFacts(readTailLines(paths(cfg, rv.run_id).keeper, 32768));
    if (!f.workerExit && !f.blocked) {
      throw new OrchError(`the reviewer run ${rv.run_id} has not finished; nothing inspected, nothing removed`, 'review-still-running');
    }
  }
  const lock = path.join(reviewsDir(cfg), `${reviewId}.finish.lock`);
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: nowIso() }) + '\n', { flag: 'wx' });
  } catch (/** @type {any} */ e) {
    if (e && e.code === 'EEXIST') {
      throw new OrchError(`another finish of ${reviewId} holds ${lock} (or one was interrupted). Inspect it; nothing is taken over automatically.`, 'finish-in-progress');
    }
    throw e;
  }
  try {
    return await doFinish(cfg, rv, file, args, io);
  } finally {
    try {
      fs.unlinkSync(lock); // our own lock
    } catch {
      /* already gone */
    }
  }
}

async function doFinish(cfg, rv, file, args, io) {
  const wt = rv.worktree;
  const breaches = [];
  const unknown = [];
  const evidence = {};
  const runRec = rv.run_id ? readRun(cfg, rv.run_id) : null;

  if (rv.worktree_created && fs.existsSync(wt)) {
    const post = await snapshotReviewWorktree(wt);
    const pre = (rv.pre && rv.pre.worktree) || {};
    // HEAD and reflog of the review worktree.
    if (post.head === null || pre.head === null || pre.head === undefined) unknown.push('review worktree HEAD unreadable');
    else if (post.head !== pre.head) breaches.push(`review worktree HEAD moved: ${String(pre.head).trim()} -> ${post.head.trim()}`);
    if (post.reflog === null || pre.reflog === null || pre.reflog === undefined) unknown.push('review worktree reflog unreadable');
    else if (post.reflog !== pre.reflog) {
      breaches.push('review worktree reflog changed');
      evidence.worktree_reflog_after = post.reflog.split('\n').slice(0, 20);
    }
    // Status: only the blinding deletions, plus orch's own file while byte-identical.
    if (post.status === null) unknown.push('review worktree status unreadable');
    else {
      const expected = new Set((rv.blinded || []).map((f) => ` D ${f}`));
      const exempt = new Map(((runRec && runRec.orch_written) || []).map((w) => [w.path, w.sha256]));
      const extra = [];
      for (const e of statusEntries(post.status)) {
        if (expected.has(e)) continue;
        const p = e.slice(3);
        const bare = p.replace(/\/$/, '');
        // `?? .vibe/config.toml` (or the untracked directory `?? .vibe/`) - orch wrote it.
        const exemptHit = [...exempt.entries()].find(([ep, sha]) => (ep === p || ep.startsWith(bare + '/')) && sha && sha256File(path.join(wt, ep)) === sha);
        if (e.startsWith('?? ') && exemptHit && (p === exemptHit[0] || onlyFileIn(path.join(wt, bare), path.join(wt, exemptHit[0])))) continue;
        extra.push(e);
      }
      const missing = [...expected].filter((e) => !statusEntries(post.status).includes(e));
      if (extra.length) breaches.push(`review worktree changed: ${extra.slice(0, 20).join(' | ')}`);
      if (missing.length) breaches.push(`blinded file(s) reappeared: ${missing.map((m) => m.slice(3)).join(', ')}`);
      if (extra.length || missing.length) {
        evidence.worktree_status_after = statusEntries(post.status).slice(0, 100);
        const d = await git(['diff', '--stat', 'HEAD'], { cwd: wt });
        if (d.ok) evidence.worktree_diff_stat = d.stdout.split('\n').slice(0, 40);
      }
    }
    if (post.head && pre.head && post.head !== pre.head) {
      const lg = await git(['log', '--format=%H %s', `${String(pre.head).trim()}..${post.head.trim()}`], { cwd: wt });
      if (lg.ok) evidence.new_commits = lg.stdout.split('\n').filter(Boolean).slice(0, 20);
    }
  } else if (rv.worktree_created) {
    unknown.push(`the review worktree ${wt} is missing; its state after the run cannot be checked`);
  }

  // The source repository and the implementer worktree.
  const srcPost = await snapshotSource(cfg, rv.source_repo, rv.implementer_dir);
  const srcPre = (rv.pre && rv.pre.source) || null;
  if (!srcPre) unknown.push('no source snapshot was taken before the launch');
  else {
    for (const k of Object.keys(srcPre)) {
      const a = srcPre[k];
      const b = srcPost[k];
      if (a === null || b === null || b === undefined) {
        unknown.push(`source ${k} unreadable`);
        continue;
      }
      if (a !== b) {
        breaches.push(`source ${k} changed`);
        evidence[`source_${k}_before`] = trimLines(a);
        evidence[`source_${k}_after`] = trimLines(b);
      }
    }
  }

  const containment = breaches.length ? 'containment-breach' : unknown.length ? 'unknown' : 'clean';

  // 7. remove the review worktree - orch created and recorded it.
  let removed = false;
  let removeError = null;
  if (rv.worktree_created) {
    const rm = await removeReviewWorktree(rv);
    removed = rm.removed;
    removeError = rm.error;
  }

  // CODE-REVIEW FIX a1: containment says what the reviewer did to the repositories; the
  // OUTCOME says whether a review happened at all. A reviewer that was never launched
  // (lane busy, spawn failure, refused preflight) or whose run did not complete is NOT a
  // review, whatever the containment says - and the exit code says so.
  let outcome;
  if (rv.status === 'not-launched' || !rv.run_id) outcome = 'not-launched';
  else if (!runRec || runRec.status !== 'completed') outcome = 'not-reviewed';
  else outcome = 'reviewed';

  Object.assign(rv, {
    status: 'finished',
    finished_at: nowIso(),
    outcome,
    containment,
    breaches,
    unknown,
    evidence,
    worktree_removed: removed,
    worktree_remove_error: removeError,
    reviewer_run_status: runRec ? runRec.status : null,
    reviewer_run_reason: runRec ? runRec.reason : null,
    reviewer_model_actual: runRec ? runRec.model_actual || null : null,
  });
  delete rv.pre; // bulky; the evidence of any difference is kept above
  writeJsonAtomic(file, rv);
  emit(args, io, rv, reviewText(rv));
  return { ...rv, exitCode: exitFor(rv) };
}

/** Is `file` the only file under `dir` (recursively)? */
function onlyFileIn(dir, file) {
  try {
    const all = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else all.push(f);
      }
    };
    walk(dir);
    return all.length === 1 && samePath(all[0], file);
  } catch {
    return false;
  }
}

function trimLines(s) {
  return String(s).split(/\n|\0/).filter(Boolean).slice(0, 60);
}

/**
 * Exit codes: 5 containment-breach > 4 containment unknown > 6 no review performed
 * (not launched / reviewer run not completed / setup failed) > 0 reviewed and clean.
 */
function exitFor(rv) {
  if (rv.containment === 'containment-breach') return 5;
  if (rv.containment === 'unknown') return 4;
  if (rv.outcome && rv.outcome !== 'reviewed') return 6;
  return rv.containment === 'clean' ? 0 : 4;
}

function reviewText(rv) {
  const head = rv.outcome && rv.outcome !== 'reviewed' ? `NO REVIEW PERFORMED (${rv.outcome}); containment ${rv.containment}` : rv.containment;
  const lines = [`review ${rv.id}: ${head}`];
  lines.push(`  reviewer ${rv.reviewer_cli} ${rv.reviewer_model} (run ${rv.run_id || '-'}: ${rv.reviewer_run_status || rv.admission || '-'}) of implementer run ${rv.implementer_run} at ${rv.commit}`);
  if (rv.reviewer_model_actual) lines.push(`  model reported: ${rv.reviewer_model_actual}`);
  if (rv.blinded && rv.blinded.length) lines.push(`  blinded: ${rv.blinded.join(', ')} (verified before launch: ${rv.blinding_verified})`);
  for (const b of rv.breaches || []) lines.push(`  BREACH: ${b}`);
  for (const u of rv.unknown || []) lines.push(`  unknown: ${u}`);
  for (const w of rv.warnings || []) lines.push(`  warning: ${w}`);
  lines.push(`  worktree ${rv.worktree}: ${rv.worktree_removed ? 'removed' : `NOT removed (${rv.worktree_remove_error || 'unknown'})`}`);
  if (rv.launch_error) lines.push(`  launch error: ${rv.launch_error}`);
  if (rv.setup_error) lines.push(`  setup error: ${rv.setup_error}`);
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
