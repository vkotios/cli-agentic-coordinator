// Two-tier progress supervision of running work (DESIGN.md section 3.6, D4).
//
// Tier 1 is deterministic and free: it reads `orch status`, the worktree and the log tail and
// raises SIGNALS. Tier 2 is a judgement: a small fixed packet is written and a verdict is
// answered by an executor (a frontier session through `foreman verdict`, or a cloud run).
//
// NOTHING IN THIS FILE CANCELS A RUN ON A NUMBER. A signal only asks for a check. Only a written
// tier-2 verdict can cancel, and every cancel carries that verdict as its recorded reason.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { foremanDir } from './store.mjs';

export const VERDICTS = ['progressing', 'looping', 'off-track', 'blocked', 'unsure'];

export const PROGRESS_DEFAULTS = {
  noProgressMinutes: 15,
  repeatThreshold: 3,
  thrashThreshold: 4,
  budgetMinutes: { XS: 15, S: 30, M: 60 },
  tier2Max: 4,
  tier2MinGapMinutes: 10,
  tier2EveryMinutesM: 20,
  logTailLines: 200,
};

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : '';
};

/** A fingerprint of what the worker has changed so far: tracked diff plus untracked files. */
export function worktreeFingerprint(dir) {
  const status = git(dir, ['status', '--porcelain']);
  const diff = git(dir, ['diff', '--stat']);
  return { hash: crypto.createHash('sha256').update(status).update('\0').update(diff).digest('hex').slice(0, 16), diffStat: diff.trim(), files: status.split('\n').filter(Boolean).length };
}

/** The longest run of identical normalised lines in a log tail (digits and timestamps removed). */
export function longestRepeat(lines) {
  let best = { count: 0, line: null };
  let current = { count: 0, line: null };
  for (const raw of lines) {
    const line = raw.replace(/\d{4}-\d\d-\d\d[T ][\d:.]+Z?/g, '').replace(/\d+/g, '#').trim();
    if (!line) continue;
    if (line === current.line) current.count++;
    else current = { count: 1, line };
    if (current.count > best.count) best = { ...current };
  }
  return best;
}

/** Failing-test lines that keep recurring in the tail (a heuristic for test thrash). */
export function repeatedFailures(lines, threshold) {
  const counts = new Map();
  for (const raw of lines) {
    const m = /^\s*(?:✖|FAIL|not ok)\s+(.{3,160})$/.exec(raw);
    if (!m) continue;
    const name = m[1].replace(/\(\d[\d.]*ms\)/g, '').trim();
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= threshold).map(([name, n]) => ({ name, runs: n }));
}

export class Progress {
  /**
   * @param {{store: any, stateRoot: string, call: (argv: string[]) => Promise<any>, igm?: any, executor?: ((packet: any, ctx: any) => Promise<any>) | null,
   *          now?: () => number, thresholds?: any}} o
   * `executor` answers a tier-2 packet with `{verdict, reason, tag?}` or null (pending: a person answers later).
   */
  constructor({ store, stateRoot, call, igm = null, executor = null, now = () => Date.now(), thresholds = {} }) {
    this.store = store;
    this.call = call;
    this.igm = igm;
    this.executor = executor;
    this.now = now;
    this.t = { ...PROGRESS_DEFAULTS, ...thresholds, budgetMinutes: { ...PROGRESS_DEFAULTS.budgetMinutes, ...(thresholds.budgetMinutes || {}) } };
    this.dir = path.join(foremanDir(stateRoot), 'checks');
  }

  stateFor(runId) {
    const raw = this.store.kvGet(`progress:${runId}`);
    return raw ? JSON.parse(raw) : { fingerprint: null, changedAt: null, tier2: 0, lastTier2At: 0, halfFired: false, fullFired: false, lastEveryAt: 0, unsure: 0, igmPending: false };
  }

  saveState(runId, state) {
    this.store.kvSet(`progress:${runId}`, JSON.stringify(state));
  }

  /** Called by the dispatcher for every active run on every tick. */
  async observe(item, run, view, settings) {
    const actor = settings.actor;
    const now = this.now();
    const state = this.stateFor(run.run_id);
    const startedAt = Date.parse(run.started_at) || now;
    const elapsedMin = (now - startedAt) / 60000;
    const budget = this.t.budgetMinutes[item.size] ?? this.t.budgetMinutes.S;

    // 1. Apply any verdict a person or executor has given since the last tick.
    await this.applyAnswered(item, run, settings, state);
    if (this.store.getItem(item.id).state !== 'running') return;

    // 2. Tier-1 signals.
    const signals = [];
    if ((view.derived_status || view.status) === 'suspected_stall') signals.push({ kind: 'no-activity', detail: view.derived_reason || 'orch reports suspected_stall' });
    if (run.worktree && fs.existsSync(run.worktree)) {
      const fp = worktreeFingerprint(run.worktree);
      if (fp.hash !== state.fingerprint) { state.fingerprint = fp.hash; state.changedAt = now; }
      const idleMin = (now - (state.changedAt ?? startedAt)) / 60000;
      if (idleMin >= this.t.noProgressMinutes) signals.push({ kind: 'no-progress', detail: `worktree unchanged for ${Math.round(idleMin)} min`, files: fp.files });
    }
    const tail = await this.call(['log', run.run_id, '--stream', 'stdout', '--tail', String(this.t.logTailLines)]);
    const lines = tail.text ? tail.text.split(/\r?\n/) : [];
    const repeat = longestRepeat(lines);
    if (repeat.count >= this.t.repeatThreshold) signals.push({ kind: 'repetition', detail: `the same step ${repeat.count} times in a row`, sample: repeat.line.slice(0, 160) });
    const thrash = repeatedFailures(lines, this.t.thrashThreshold);
    if (thrash.length) signals.push({ kind: 'test-thrash', detail: `${thrash[0].name} failed ${thrash[0].runs} times (heuristic)`, tests: thrash.slice(0, 3) });
    if (elapsedMin >= budget) signals.push({ kind: 'over-budget', detail: `${Math.round(elapsedMin)} min against a ${budget} min ${item.size} budget` });

    // 3. IGM operator abort or drop on this run's requests: the agent's turn just broke.
    let igmEvent = null;
    if (this.igm) igmEvent = await this.igm.eventsFor(run.run_id, this.store, actor, item.id);
    if (igmEvent) state.igmPending = true;

    // 4. Decide whether a tier-2 check is due. A signal only ever asks for a check.
    const reasons = [];
    if (signals.length) reasons.push(`tier-1: ${signals.map((s) => s.kind).join(', ')}`);
    if (!state.halfFired && elapsedMin >= budget * 0.5) { state.halfFired = true; reasons.push('50% of the time budget'); }
    if (!state.fullFired && elapsedMin >= budget) { state.fullFired = true; reasons.push('100% of the time budget'); }
    if (item.size === 'M' && elapsedMin >= budget && (now - state.lastEveryAt) / 60000 >= this.t.tier2EveryMinutesM) { state.lastEveryAt = now; reasons.push(`every ${this.t.tier2EveryMinutesM} min`); }
    if (state.igmPending) { reasons.push('operator aborted or dropped a request of this run'); state.igmPending = false; }
    const asked = this.store.kvGet(`check_now:${run.run_id}`);
    if (asked) { reasons.push(`requested by ${asked}`); this.store.kvDelete(`check_now:${run.run_id}`); }
    const pendingCheck = this.store.listChecks({ item: item.id, status: 'pending' }).length > 0;
    const gapOk = (now - state.lastTier2At) / 60000 >= this.t.tier2MinGapMinutes || igmEvent || asked;
    if (reasons.length && !pendingCheck && gapOk) {
      if (state.tier2 >= this.t.tier2Max) {
        // The check budget is spent. The next alarm parks the item rather than buying another check.
        if (signals.length) await this.cancelAndPark(item, run, settings, 'timeout', `${state.tier2} progress checks used and the run is still alarming (${signals.map((s) => s.kind).join(', ')})`);
      } else {
        await this.requestCheck(item, run, settings, state, signals, reasons, lines);
      }
    }
    this.saveState(run.run_id, state);
    if (signals.length) this.store.event('tier1', { item: item.id, run: run.run_id, actor, data: { signals: signals.map(({ kind, detail }) => ({ kind, detail })) } });
  }

  /** Write the fixed packet, record a pending check, and ask the executor (if there is one). */
  async requestCheck(item, run, settings, state, signals, reasons, logLines) {
    state.tier2 += 1;
    state.lastTier2At = this.now();
    fs.mkdirSync(this.dir, { recursive: true });
    const fp = run.worktree && fs.existsSync(run.worktree) ? worktreeFingerprint(run.worktree) : { diffStat: '', files: 0 };
    const packet = {
      item: { id: item.id, title: item.title, size: item.size, goal_ref: item.goal_ref },
      acceptance: item.spec.acceptance,
      allowlist: item.spec.allowlist,
      reasons,
      signals,
      diff_stat: fp.diffStat,
      log_tail: logLines.slice(-this.t.logTailLines),
      question: 'Is this run progressing toward the acceptance criteria? Answer with one verdict: progressing, looping, off-track, blocked or unsure, and a one-line reason.',
      verdicts: VERDICTS,
    };
    const packetPath = path.join(this.dir, `${run.run_id}-check-${state.tier2}.json`);
    fs.writeFileSync(packetPath, JSON.stringify(packet, null, 2));
    const id = this.store.addCheck({ item: item.id, run: run.run_id, tier: 2, status: 'pending', signals, packetPath });
    this.store.event('check-requested', { item: item.id, run: run.run_id, actor: settings.actor, data: { check: id, reasons } });
    if (!this.executor) return id;
    try {
      const answer = await this.executor(packet, { checkId: id, item, run });
      if (answer && VERDICTS.includes(answer.verdict)) this.store.answerCheck(id, { verdict: answer.verdict, reason: answer.reason ?? null, executor: answer.executor ?? 'executor' });
    } catch (error) {
      this.store.event('check-executor-failed', { item: item.id, run: run.run_id, actor: settings.actor, data: { check: id, error: String(error && error.message ? error.message : error) } });
    }
    return id;
  }

  /** Act on answered, not-yet-applied tier-2 checks of this run. */
  async applyAnswered(item, run, settings, state) {
    for (const check of this.store.listChecks({ item: item.id, status: 'done', tier: 2 })) {
      if (check.run !== run.run_id || check.applied) continue;
      this.store.markCheckApplied(check.id);
      await this.act(item, run, settings, state, check);
    }
  }

  async act(item, run, settings, state, check) {
    const actor = settings.actor;
    const reason = check.reason || '(no reason given)';
    switch (check.verdict) {
      case 'progressing':
        state.unsure = 0;
        this.store.event('verdict-progressing', { item: item.id, run: run.run_id, actor, data: { check: check.id, reason } });
        return;
      case 'unsure':
        state.unsure += 1;
        this.store.event('verdict-unsure', { item: item.id, run: run.run_id, actor, data: { check: check.id, reason, escalate: state.unsure >= 2 ? 'ask a different model family at the next check' : null } });
        return;
      case 'looping':
        await this.cancelAndPark(item, run, settings, 'capability-wall', `verdict looping: ${reason}`, check.id);
        return;
      case 'off-track':
        await this.cancelAndPark(item, run, settings, check.tag === 'scope-violation' ? 'scope-violation' : 'spec-ambiguous', `verdict off-track: ${reason}`, check.id);
        return;
      case 'blocked':
        await this.cancelAndPark(item, run, settings, 'needs-input', `verdict blocked: ${reason}`, check.id);
        return;
      default:
        return;
    }
  }

  /** Cancel with the written verdict as the recorded reason, then let the dispatcher park it with this tag. */
  async cancelAndPark(item, run, settings, tag, reason, checkId = null) {
    this.store.kvSet(`park:${item.id}`, JSON.stringify({ tag, reason }));
    this.store.event('cancel-requested', { item: item.id, run: run.run_id, actor: settings.actor, data: { tag, reason, check: checkId } });
    const r = await this.call(['cancel', run.run_id]);
    if (!r.ok) this.store.event('cancel-failed', { item: item.id, run: run.run_id, actor: settings.actor, data: { exit: r.exitCode, text: (r.error || r.text).slice(0, 300) } });
  }
}
