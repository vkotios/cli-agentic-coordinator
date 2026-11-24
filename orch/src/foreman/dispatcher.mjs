// The Foreman's dispatcher (DESIGN.md section 3.3): select -> route -> claim -> worktree -> run
// -> watch -> verify -> park or hand over. Deterministic: no model sits in this loop.
//
// `tick()` is one bounded step and is safe to call at any time. All durable state is in the
// store (items, run rows) and in orch's own records, so a restart simply calls `tick()` again:
// `reconcile()` finds what was running and carries on from the evidence, never from memory.
//
// Nothing here merges, pushes or deletes. A verified item stops at `needs-review` with its
// worktree retained; a failed one is parked with a tag and a reason. A run is never cancelled
// on a number (tier-1 signals only raise a check; see progress.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { getAdapter } from '../adapters/index.mjs';
import { laneOccupancy } from '../commands.mjs';
import { foremanDir } from './store.mjs';
import { readSettings } from './settings.mjs';
import { runAcceptance, runCheck, tailOf, ignoredOutsideAllowlist, snapshotIgnored } from './acceptance.mjs';
import { setupEnv } from './env.mjs';
import { gitSafe } from './git.mjs';
import { needsReview } from './schema.mjs';

const TERMINAL_RUN = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'blocked', 'blocked-quota', 'turn-cap']);

/** Park tag for a run that did not complete. A cancel by us carries its own tag in the item. */
const PARK_FOR_STATUS = {
  failed: 'capability-wall',
  'turn-cap': 'capability-wall',
  interrupted: 'needs-input',
  blocked: 'needs-input',
  'blocked-quota': 'needs-input',
  cancelled: 'operator',
};

export class Dispatcher {
  /**
   * @param {{store: any, stateRoot: string, call: (argv: string[]) => Promise<any>, progress?: any, now?: () => number, occupancy?: (cfg: any, lane: string) => Promise<any>}} o
   */
  constructor({ store, stateRoot, call, progress = null, now = () => Date.now(), occupancy = laneOccupancy }) {
    this.store = store;
    this.stateRoot = stateRoot;
    this.call = call;
    this.progress = progress;
    this.now = now;
    this.occupancy = occupancy;
    this.cfg = loadConfig(stateRoot);
    this.dir = foremanDir(this.cfg.stateRoot);
  }

  get settings() {
    return readSettings(this.store);
  }

  /** One step: watch what is running, then start the next item if capacity allows. */
  async tick() {
    const settings = this.settings;
    await this.reconcile(settings);
    if (!settings.paused) await this.launchNext(settings);
    return { counts: this.store.counts() };
  }

  // ---- watching ------------------------------------------------------------------------

  async reconcile(settings) {
    for (const item of this.store.activeItems()) {
      try {
        await this.reconcileItem(item, settings);
      } catch (error) {
        this.store.event('dispatcher-error', { item: item.id, actor: settings.actor, data: { error: String(error && error.message ? error.message : error) } });
      }
    }
  }

  async reconcileItem(item, settings) {
    const run = this.store.currentRun(item.id);
    if (!run) {
      this.store.transition(item.id, 'parked', { actor: settings.actor, parkTag: 'needs-input', reason: 'no run row for a running item; inspect it' });
      return;
    }
    if (run.state === 'preparing' && run.run_id) this.store.updateRun(run.id, { state: 'running' });
    if (run.state === 'preparing') {
      // The Foreman stopped between recording the launch and learning its result. An uncertain
      // launch is never retried automatically: orch may or may not have started a worker.
      if (!run.run_id) {
        this.store.updateRun(run.id, { state: 'abandoned', ended_at: new Date(this.now()).toISOString() });
        this.store.transition(item.id, 'parked', { actor: settings.actor, parkTag: 'needs-input', reason: 'launch interrupted before the run id was recorded; inspect the worktree and orch runs, then requeue' });
        await this.releaseClaim(item, settings);
        return;
      }
    }
    if (item.state === 'verifying') {
      await this.verify(item, run, settings);
      return;
    }
    const status = await this.call(['status', run.run_id]);
    const view = status.out?.runs?.[0];
    if (!view) {
      this.store.event('status-unavailable', { item: item.id, run: run.run_id, actor: settings.actor, data: { error: status.error || status.text.slice(0, 300) } });
      return;
    }
    const derived = view.derived_status || view.status;
    if (TERMINAL_RUN.has(derived)) {
      await this.finishRun(item, run, derived, settings);
      return;
    }
    if (this.progress) await this.progress.observe(item, run, view, settings);
  }

  async finishRun(item, run, derived, settings) {
    const ended = new Date(this.now()).toISOString();
    this.store.updateRun(run.id, { state: 'finished', ended_at: ended, result: { derived_status: derived } });
    // A verdict that arrived after the run ended has nothing left to act on; say so instead of leaving it open.
    for (const check of this.store.listChecks({ item: item.id, status: 'done', tier: 2 })) {
      if (check.run === run.run_id && !check.applied) {
        this.store.markCheckApplied(check.id);
        this.store.event('verdict-moot', { item: item.id, run: run.run_id, actor: settings.actor, data: { check: check.id, verdict: check.verdict, reason: 'the run ended before the verdict was applied' } });
      }
    }
    if (derived !== 'completed') {
      // A cancel the Foreman asked for after a written verdict carries that verdict's tag and reason.
      const asked = this.store.kvGet(`park:${item.id}`);
      const override = asked ? JSON.parse(asked) : null;
      if (asked) this.store.kvDelete(`park:${item.id}`);
      const tag = override?.tag || PARK_FOR_STATUS[derived] || 'capability-wall';
      this.store.transition(item.id, 'parked', { actor: settings.actor, parkTag: tag, reason: override ? `${override.reason} (run ${run.run_id} ${derived})` : `run ${run.run_id} ended ${derived}` });
      await this.releaseClaim(item, settings);
      return;
    }
    this.store.transition(item.id, 'verifying', { actor: settings.actor, reason: 'worker finished', data: { run: run.run_id } });
    await this.verify(this.store.getItem(item.id), run, settings);
  }

  /**
   * The scope guard first, then the acceptance commands. Nothing the worker produced is
   * executed until orch has shown it changed only allowed files; any violation parks the item
   * without running a single command.
   */
  async verify(item, run, settings) {
    const actor = settings.actor;
    const scope = await this.call(['scope', run.run_id]);
    this.store.event('scope', { item: item.id, run: run.run_id, actor, data: { exit_code: scope.exitCode, result: scope.out?.result ?? null, offending: scope.out?.offending ?? [] } });
    if (scope.exitCode === 3) {
      this.store.transition(item.id, 'parked', { actor, parkTag: 'scope-violation', reason: `changed files outside the allowlist: ${(scope.out?.offending || []).join(', ')}` });
      await this.releaseClaim(item, settings);
      return;
    }
    if (scope.exitCode !== 0) {
      this.store.transition(item.id, 'parked', { actor, parkTag: 'needs-input', reason: `scope check was inconclusive: ${scope.error || scope.text.slice(0, 300)}` });
      await this.releaseClaim(item, settings);
      return;
    }
    // orch's scope guard sees tracked and untracked files but not git-ignored ones; a worker could
    // hide code there for an acceptance command to run. Nothing executes until that is ruled out.
    const ignored = ignoredOutsideAllowlist(run.worktree, item.spec.allowlist, settings.toleratedIgnored, this.setupBaseline(run));
    if (!ignored.ok || ignored.offending.length) {
      this.store.event('ignored-files', { item: item.id, run: run.run_id, actor, data: { error: ignored.error, offending: ignored.offending.slice(0, 20) } });
      this.store.transition(item.id, 'parked', {
        actor,
        parkTag: ignored.ok ? 'scope-violation' : 'needs-input',
        reason: ignored.ok ? `git-ignored files outside the allowlist (nothing was run): ${ignored.offending.slice(0, 5).join(', ')}${ignored.offending.length > 5 ? ` and ${ignored.offending.length - 5} more` : ''}` : ignored.error,
      });
      await this.releaseClaim(item, settings);
      return;
    }
    const logDir = path.join(this.dir, 'checks');
    const checks = item.spec.acceptance;
    const results = await runAcceptance(checks, { root: run.worktree, logDir, defaultTimeoutS: settings.acceptanceTimeoutSeconds, maxLogBytes: settings.maxLogBytes }, `${item.id}-a${item.attempt}`);
    const failed = results.find((r) => ['fail', 'timeout', 'error'].includes(r.status));
    this.store.event('acceptance', { item: item.id, run: run.run_id, actor, data: { results: results.map(({ index, kind, status, exit_code, ms, log }) => ({ index, kind, status, exit_code, ms, log })) } });
    if (failed) {
      const why = failed.status === 'timeout' ? 'timed out' : failed.status === 'error' ? `could not run (${failed.error})` : `exited ${failed.exit_code}`;
      const tail = failed.log ? tailOf(failed.log) : '';
      this.store.transition(item.id, 'parked', { actor, parkTag: failed.status === 'timeout' ? 'timeout' : 'check-failed', reason: `acceptance check ${failed.index} (${(failed.argv || []).join(' ')}) ${why}${tail ? '\n' + tail : ''}` });
      await this.releaseClaim(item, settings);
      return;
    }
    // Everything checkable passed. Review, grading and merging stay with a person or a frontier
    // session (a deterministic daemon cannot grade findings), so the item waits here.
    this.store.transition(item.id, 'needs-review', {
      actor,
      reason: needsReview(item.spec) ? 'checks passed; awaiting review' : 'checks passed',
      data: { run: run.run_id, worktree: run.worktree, checks: results.length, judgement: results.filter((r) => r.status === 'needs-judgement').length },
    });
    await this.releaseClaim(item, settings);
  }

  async releaseClaim(item, settings) {
    const r = await this.call(['release', item.wp || item.id, '--by', settings.actor]);
    if (!r.ok && r.out?.release !== 'not-claimed') {
      this.store.event('release-failed', { item: item.id, actor: settings.actor, data: { exit: r.exitCode, text: (r.error || r.text).slice(0, 300) } });
    }
  }

  // ---- starting ------------------------------------------------------------------------

  resolveRoute(item, settings) {
    const route = item.spec.route || settings.defaultRoute;
    if (!route || !route.cli || !route.model) return null;
    return route;
  }

  async launchNext(settings) {
    const running = this.store.activeItems().length;
    if (running >= settings.maxConcurrent) return null;
    const item = this.store.pickNext();
    if (!item) return null;
    const actor = settings.actor;
    const route = this.resolveRoute(item, settings);
    if (!route) {
      this.store.transition(item.id, 'parked', { actor, parkTag: 'needs-input', reason: 'no route: the item names none and the Foreman has no default route' });
      return item.id;
    }
    let adapter;
    try {
      adapter = getAdapter(route.cli);
    } catch {
      adapter = null;
    }
    if (!adapter) {
      this.store.transition(item.id, 'parked', { actor, parkTag: 'needs-input', reason: `unknown worker CLI "${route.cli}"` });
      return item.id;
    }
    if ((route.flags || []).length && !adapter.testOnly) {
      // Adapter flags can loosen a worker's own sandbox, so only the test adapter may take them.
      this.store.transition(item.id, 'parked', { actor, parkTag: 'needs-input', reason: 'route.flags are only accepted for the test adapter; remove them or ask the owner to allow them' });
      return item.id;
    }
    // A local run needs a free lane permit. Not free is not an error: the item stays ready.
    const occupancy = await this.occupancy(this.cfg, adapter.lane);
    if (occupancy.serial && occupancy.free < 1) return null;

    const project = this.store.getProject(item.project);
    const run = this.store.startRun(item.id, route, actor);
    this.store.kvSet('last_project', item.project);
    try {
      await this.start(item, project, run, route, settings);
    } catch (error) {
      this.store.updateRun(run.id, { state: 'abandoned', ended_at: new Date(this.now()).toISOString(), result: { error: String(error && error.message ? error.message : error) } });
      this.store.transition(item.id, 'parked', { actor, parkTag: 'needs-input', reason: `launch failed: ${String(error && error.message ? error.message : error).slice(0, 400)}` });
      await this.releaseClaim({ id: item.id, wp: item.id }, settings);
    }
    return item.id;
  }

  /** Where the ignored-file baseline of a run's setup is kept. */
  setupBaselineFile(run) {
    return path.join(this.dir, 'setup', `run-${run.id}.baseline.json`);
  }

  /** The ignored files the project's setup made for this run (path to signature), or null when no setup ran. */
  setupBaseline(run) {
    try {
      return JSON.parse(fs.readFileSync(this.setupBaselineFile(run), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Run the project's setup command in a fresh worktree. It gets the acceptance environment plus package-manager
   * settings (no keys or tokens), the same output cap, and its own time limit. Afterwards git must show nothing
   * changed that it tracks or would add (the scope guard compares the worktree with its starting commit, so setup may
   * only create git-ignored files), and those ignored files are recorded as the baseline for the acceptance-time check.
   * @returns {Promise<{ok: boolean, reason?: string, log?: string}>} `reason` and `log` are set when `ok` is false
   */
  async runSetup(item, project, run, worktree, settings) {
    const { argv, timeout_s: timeoutS } = project.setup;
    const logFile = path.join(this.dir, 'setup', `${item.id}-a${item.attempt + 1}.log`);
    const result = await runCheck({ kind: 'command', argv, timeout_s: timeoutS }, { root: worktree, logFile, defaultTimeoutS: timeoutS, maxLogBytes: settings.maxLogBytes, env: setupEnv() });
    const finish = (ok, reason, extra = {}) => {
      this.store.event('setup', { item: item.id, actor: settings.actor, data: { project: project.id, argv, status: ok ? 'pass' : result.status === 'pass' ? 'fail' : result.status, exit_code: result.exit_code ?? null, ms: result.ms ?? null, log: logFile, ...extra } });
      return ok ? { ok: true } : { ok: false, reason, log: logFile };
    };
    const command = argv.join(' ');
    if (result.status !== 'pass') {
      const why = result.status === 'timeout' ? `timed out after ${timeoutS} s` : result.status === 'error' ? `could not run (${result.error})` : `exited ${result.exit_code}`;
      const tail = tailOf(logFile);
      return finish(false, `setup (${command}) ${why}${tail ? '\n' + tail : ''}`);
    }
    const status = gitSafe(worktree, ['status', '--porcelain', '--ignore-submodules=all']);
    if (status.status !== 0) return finish(false, `setup (${command}) finished, but git could not check the worktree afterwards (${status.stderr?.slice(0, 200) || 'exit ' + status.status})`);
    const changed = status.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (changed.length) {
      return finish(false, `setup (${command}) changed files git tracks or would add: ${changed.slice(0, 5).join('; ')}${changed.length > 5 ? ` and ${changed.length - 5} more` : ''}. Setup may only create git-ignored files (for example node_modules or .venv); add what it creates to .gitignore.`);
    }
    const snapshot = snapshotIgnored(worktree);
    if (!snapshot.ok) return finish(false, `setup (${command}) finished, but its output could not be recorded: ${snapshot.error}`);
    fs.mkdirSync(path.dirname(this.setupBaselineFile(run)), { recursive: true });
    fs.writeFileSync(this.setupBaselineFile(run), JSON.stringify(snapshot.files));
    return finish(true, '', { ignored_files: snapshot.count, ignored_bytes: snapshot.bytes });
  }

  async start(item, project, run, route, settings) {
    const actor = settings.actor;
    const wp = item.id;
    const claim = await this.call(['claim', wp, '--by', actor]);
    if (!claim.ok) {
      if (claim.exitCode === 3) {
        // Someone else holds the package. Put the item back; nothing was created.
        this.store.updateRun(run.id, { state: 'abandoned', ended_at: new Date(this.now()).toISOString(), result: { claim: 'refused', holder: claim.out?.holder ?? null } });
        this.store.transition(item.id, 'ready', { actor, reason: `claim refused: held by ${claim.out?.holder?.by ?? 'unknown'}` });
        return;
      }
      throw new Error(`claim failed: ${claim.error || claim.text}`);
    }
    const wt = await this.call(['worktree', 'create', '--repo', project.repo, '--wp', wp, '--slice', run.slice, '--by', actor, '--base', project.default_branch]);
    if (!wt.ok || !wt.out?.path) throw new Error(`worktree create failed: ${wt.error || wt.text.slice(0, 300)}`);
    this.store.updateRun(run.id, { worktree: wt.out.path });

    // The project's setup command (`npm ci`, `uv sync`) runs once in the fresh worktree, before the worker exists.
    if (project.setup) {
      const setup = await this.runSetup(item, project, run, wt.out.path, settings);
      if (!setup.ok) {
        this.store.updateRun(run.id, { state: 'abandoned', ended_at: new Date(this.now()).toISOString(), result: { setup: 'failed', log: setup.log } });
        this.store.transition(item.id, 'parked', { actor, parkTag: 'setup-failed', reason: setup.reason });
        await this.releaseClaim(item, settings);
        return;
      }
    }

    const handoffDir = path.join(this.dir, 'handoffs');
    fs.mkdirSync(handoffDir, { recursive: true });
    const handoffFile = path.join(handoffDir, `${item.id}-a${item.attempt + 1}.txt`);
    fs.writeFileSync(handoffFile, item.spec.handoff, 'utf8');

    const argv = ['run', '--cli', route.cli, '--model', route.model, '--dir', wt.out.path, '--handoff', handoffFile, '--wp', wp, '--slice', run.slice, '--by', actor, '--size', item.size, '--no-window'];
    for (const allowed of item.spec.allowlist) argv.push('--allow', allowed);
    for (const flag of route.flags || []) argv.push('--flag', flag);
    const launched = await this.call(argv);
    const id = launched.out?.id ?? null;
    if (id) this.store.updateRun(run.id, { run_id: id });
    if (launched.out?.admission === 'acquired' && id) {
      this.store.updateRun(run.id, { state: 'running' });
      this.store.event('launched', { item: item.id, run: id, actor, data: { route, worktree: wt.out.path, attempt: item.attempt + 1 } });
      return;
    }
    if (launched.out?.admission === 'lane-busy') {
      // The lane filled between our check and orch's bind. Nothing ran; the worktree is kept and
      // the next launch gets a fresh slice, so no path is ever reused.
      this.store.updateRun(run.id, { state: 'abandoned', ended_at: new Date(this.now()).toISOString(), result: { admission: 'lane-busy' } });
      this.store.transition(item.id, 'ready', { actor, reason: 'lane busy at launch' });
      await this.releaseClaim(item, settings);
      return;
    }
    throw new Error(`run did not start: ${launched.error || launched.out?.reason || launched.text.slice(0, 300)}`);
  }
}
