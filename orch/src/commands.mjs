// Command implementations for `orch`.
//
// `status`, `list`, `result`, `log` and `wait-lane` are STRICTLY read-only: they never
// write a run record, never start a monitor and never bind the lane pipe (v4 §4,
// closing r2-5 and v3 M1). Every one of them runs under a whole-command deadline and
// prints `undetermined: <step> exceeded <ms>ms` rather than hanging (v4 §0).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureDirs } from './config.mjs';
import { paths, readRun, writeRun, listRuns, listRunIds, TERMINAL, keeperFacts } from './store.mjs';
import { getAdapter, PUBLIC_ADAPTERS } from './adapters/index.mjs';
import { assertModelPermitted } from './models.mjs';
import { OrchError } from './errors.mjs';
import { laneScope, assertLaneOverrideAllowed } from './lanescope.mjs';
import { connectHello } from './lanepipe.mjs';
import { readProcessTable, verifyIdentity, creationTimesOf, ownChildCreationTime, killChecked, treeKillChecked } from './procs.mjs';
import { deriveStatus } from './statusrules.mjs';
import { closeViewer } from './viewer.mjs';
import { newRunId, nowIso, writeJsonAtomic, readJson, readJsonAsync, readTailLines, readTailLinesAsync, sleep, Deadline, withDeadline } from './util.mjs';
import { requireClaim, wpKey } from './claims.mjs';
import { parseAllowBlock, sha256File } from './scope.mjs';
import { topLevel as gitTopLevel, resolveCommit } from './git.mjs';
import { worktreeRecordForDir, sliceKey } from './worktrees.mjs';

export const KEEPER = path.resolve(fileURLToPath(new URL('./keeper.mjs', import.meta.url)));
export const MONITOR = path.resolve(fileURLToPath(new URL('./monitor.mjs', import.meta.url)));

const ADMISSION_TIMEOUT_MS = Number(process.env.ORCH_ADMISSION_TIMEOUT_MS || 5000);
const HELLO_DEADLINE_MS = Number(process.env.ORCH_HELLO_DEADLINE_MS || 2000);

/* ------------------------------------------------------------------ run ---- */

/**
 * @param {any} args
 * @param {{log:(s:string)=>void}} [io]
 * @param {{role?:string, recordExtra?:object}} [opts] used by `orch review` to launch a
 *   reviewer through this exact machinery and link the record to the implementer run.
 */
export async function cmdRun(args, io = console, opts = {}) {
  const cfg = loadConfig(args['state-root']);
  ensureDirs(cfg);

  const cliName = req(args, 'cli');
  const adapter = getAdapter(cliName);
  if (adapter.testOnly && process.env.ORCH_ALLOW_FAKE !== '1') {
    throw new OrchError(`--cli ${cliName} is test-only (set ORCH_ALLOW_FAKE=1)`, 'test-only-cli');
  }
  // A real CLI may never be launched into an overridden (test) lane.
  assertLaneOverrideAllowed(adapter);

  const model = adapter.needsModel ? req(args, 'model') : args.model || 'none';
  // A model the roster marks `requires_permission` runs only with --owner-approved-model,
  // whichever CLI serves it (checked before anything exists).
  if (args.model) assertModelPermitted(String(args.model), !!args['owner-approved-model']);
  const dir = path.resolve(req(args, 'dir'));
  const handoff = path.resolve(req(args, 'handoff'));

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new OrchError(`--dir does not exist or is not a directory: ${dir}`, 'bad-dir');
  }
  if (!fs.existsSync(handoff) || !fs.statSync(handoff).isFile()) {
    throw new OrchError(`--handoff file does not exist: ${handoff}`, 'bad-handoff');
  }

  // Slice 2: a run for a work package requires the caller to hold its claim, and carries
  // the allowlist + baseline the scope guard will check. Checked BEFORE anything exists.
  const role = opts.role || (args.role === 'review' ? 'review' : 'implement');
  const workflow = await runWorkflowFields(cfg, args, dir, handoff);

  const laneName = args.lane || adapter.lane;
  if (!cfg.lanes[laneName]) {
    throw new OrchError(`unknown lane "${laneName}" (known: ${Object.keys(cfg.lanes).join(', ')})`, 'bad-lane');
  }
  // CODE-REVIEW FIX (agy g1): a local-model adapter can NEVER run outside the local lane.
  // `--lane cloud` for opencode bound the cloud pipe instead, so a second local-model
  // worker ran next to the first on the single gateway (N1).
  if (adapter.lane === 'local' && laneName !== 'local') {
    throw new OrchError(
      `--cli ${cliName} drives a LOCAL model and may only run in the serial local lane (asked for --lane ${laneName}). ` +
        'Two local-model workers must never run at once.',
      'local-adapter-off-lane',
    );
  }
  const scope = laneScope(laneName);
  fs.mkdirSync(scope.laneDir, { recursive: true });

  // Adapter pre-flight runs in THIS process, BEFORE any record exists, so a bad handoff
  // or a bad model config fails the caller's command loudly and leaves nothing half-born.
  const pre = adapter.preLaunch
    ? adapter.preLaunch({ model, dir, promptPath: handoff, allowNonAscii: !!args['allow-non-ascii'], role, ownerApprovedModel: !!args['owner-approved-model'] })
    : { notes: [], extra: {} };

  const id = newRunId();
  const P = paths(cfg, id);
  fs.mkdirSync(P.dir, { recursive: true });

  const promptBuf = fs.readFileSync(handoff);
  fs.writeFileSync(P.prompt, promptBuf);
  fs.writeFileSync(P.stdout, '');
  fs.writeFileSync(P.stderr, '');

  const built = adapter.build({
    model,
    dir,
    agent: args.agent || null,
    flags: args.flag || [],
    maxTurns: args['max-turns'] != null ? Number(args['max-turns']) : null,
    maxPrice: args['max-price'] != null ? String(args['max-price']) : null,
    promptPath: P.prompt,
    allowNonAscii: !!args['allow-non-ascii'],
    role,
    effort: args.effort || null,
    printTimeout: args['print-timeout'] || null,
    runDir: P.dir,
  });

  // `dir_real` is resolved ONCE, here, and stored (v3 §5).
  let dirReal = dir;
  try {
    dirReal = String(fs.realpathSync.native(dir)).replace(/[\\/]+$/, '');
  } catch {
    dirReal = dir;
  }

  const rec = {
    id,
    cli: cliName,
    lane: laneName,
    model_requested: model,
    model_canonical: adapter.canonicalModel(model),
    model_actual: null,
    dir,
    dir_real: dirReal,
    agent: args.agent || null,
    flags: args.flag || [],
    max_turns: args['max-turns'] != null ? Number(args['max-turns']) : null,
    max_price: args['max-price'] != null ? String(args['max-price']) : null,
    allow_non_ascii: !!args['allow-non-ascii'],
    no_window: !!args['no-window'],
    handoff_source: handoff,
    prompt_bytes: promptBuf.length,
    prompt_sha256: crypto.createHash('sha256').update(promptBuf).digest('hex'),
    // slice 2: workflow fields (null when the run is not tied to a work package)
    role,
    wp: workflow.wp,
    slice: workflow.slice,
    by: workflow.by,
    size: workflow.size,
    scope: workflow.scope,
    // Files orch itself writes into the worktree before the worker starts; the scope
    // guard and the review containment check exempt them only while byte-identical.
    orch_written: orchWrittenFiles(dir, pre.extra || {}),
    status: 'queued',
    exit_code: null,
    reason: null,
    worker_pid: null,
    worker_created_at: null,
    keeper_pid: null,
    keeper_created_at: null,
    monitor_pid: null,
    monitor_created_at: null,
    viewer_pid: null,
    last_activity_at: null,
    last_activity_signal: null,
    created_at: nowIso(),
    started_at: null,
    ended_at: null,
    state_root: cfg.stateRoot,
    lane_id: scope.laneId,
    lane_pipe: scope.pipeName,
    lane_dir: scope.laneDir,
    notes: [...(pre.notes || []), ...(built.notes || [])],
    // The keeper's ENTIRE input. It parses this once and nothing else.
    launch: {
      exe: built.file,
      args: built.args,
      cwd: built.cwd,
      env_set: built.envSet || {},
      env_delete: built.envDelete || [],
      // stdin. An adapter that takes its prompt on argv (agy) supplies an empty file
      // instead, so the prompt is not delivered twice.
      prompt: built.stdinFile || P.prompt,
      stdout: P.stdout,
      stderr: P.stderr,
      pipe_name: scope.pipeName,
      lane_holder: scope.holderFile,
      lane_id: scope.laneId,
      lane: laneName,
      // astra M8: only a serial lane binds the pipe; cloud runs never refuse each other.
      lane_exclusive: cfg.lanes[laneName].serial !== false,
    },
  };
  Object.assign(rec, pre.extra || {});
  Object.assign(rec, opts.recordExtra || {});
  writeJsonAtomic(P.record, rec);

  /* ---- amendment A1: the keeper's bind result BEFORE `orch run` returns ---- */

  const keeper = spawn(process.execPath, [KEEPER, '--state-root', cfg.stateRoot, '--id', id, '--run-dir', P.dir], {
    detached: true,
    shell: false,
    windowsHide: true,
    env: process.env,
    // fd 1 is the admission channel. It exists before the keeper detaches, so the
    // answer can never be lost, and the caller can never be hung by it: EOF or the
    // deadline both end the wait.
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  // CODE-REVIEW FIX (astra H3): the keeper's identity is captured by the spawner
  // IMMEDIATELY - in parallel with the admission wait - and written BEFORE any branch
  // below can return. The first version captured it only on the `acquired` path, so an
  // `undetermined` answer (a keeper frozen after its bind) left only a bare pid, and
  // `cancel --keeper` then refused forever. Identity is recorded here, at spawn, and
  // nowhere else (never adopted later from whatever process holds the pid).
  const keeperIdentity = ownChildCreationTime(keeper.pid, { deadlineMs: 4000 });
  const admission = await readAdmission(keeper, P.admission, ADMISSION_TIMEOUT_MS);
  try {
    keeper.stdout.destroy();
  } catch {
    /* already gone */
  }
  keeper.unref();
  const keeperCreatedAt = await keeperIdentity;
  const spawned = {
    run_id: id,
    keeper_pid: keeper.pid,
    keeper_created_at: keeperCreatedAt,
    monitor_pid: null,
    monitor_created_at: null,
    captured_by_pid: process.pid,
    at: nowIso(),
  };
  writeJsonAtomic(P.spawned, spawned);
  rec.keeper_pid = keeper.pid;
  rec.keeper_created_at = spawned.keeper_created_at;

  if (admission.admission === 'lane-busy') {
    const holderText = admission.holder_text || 'held by: unknown (holder starting)';
    rec.status = 'blocked';
    rec.reason = 'lane-busy';
    rec.ended_at = nowIso();
    rec.keeper_pid = keeper.pid;
    rec.holder = admission.holder || null;
    writeJsonAtomic(P.record, rec); // no monitor was started; `orch run` is still the writer
    const out = { id, admission: 'lane-busy', holder: admission.holder || null, holder_text: holderText, lane: laneName };
    if (args.json) io.log(JSON.stringify(out, null, 2));
    else io.log(`lane-busy: ${holderText}`);
    return { ...out, exitCode: 3 };
  }

  if (admission.admission !== 'acquired') {
    const reason = admission.reason || admission.admission || 'undetermined';
    rec.status = admission.admission === 'undetermined' ? 'queued' : 'blocked';
    rec.reason = reason;
    rec.keeper_pid = keeper.pid;
    if (rec.status === 'blocked') rec.ended_at = nowIso();
    writeJsonAtomic(P.record, rec);
    const out = { id, admission: admission.admission || 'undetermined', reason };
    if (args.json) io.log(JSON.stringify(out, null, 2));
    else io.log(`${out.admission}: ${reason}`);
    return { ...out, exitCode: out.admission === 'undetermined' ? 4 : 2 };
  }

  /* ---- admitted: start the monitor, then record spawner-captured identity ---- */

  let monitor = null;
  let monitorError = null;
  if (!args['no-monitor']) {
    // Test knob, fake runs only: a monitor executable that cannot be spawned.
    const monitorExe = process.env.ORCH_ALLOW_FAKE === '1' && process.env.ORCH_TEST_MONITOR_EXE ? process.env.ORCH_TEST_MONITOR_EXE : process.execPath;
    try {
      monitor = spawn(monitorExe, [MONITOR, '--state-root', cfg.stateRoot, '--id', id, '--run-dir', P.dir], {
        detached: true,
        shell: false,
        windowsHide: true,
        env: process.env,
        stdio: 'ignore',
      });
      // CODE-REVIEW FIX (slice 3, c6): a spawn failure arrives as an 'error' EVENT; unhandled
      // it would crash the caller (the CLI, or the long-lived `orch mcp` server) after the
      // worker was admitted. The run goes on unmonitored and the answer says so.
      monitor.on('error', (e) => {
        monitorError = e;
      });
      monitor.unref();
    } catch (e) {
      monitorError = e;
      monitor = null;
    }
    if (monitor && !monitor.pid) {
      await new Promise((r) => setImmediate(r)); // let the pending 'error' event land
      monitor = null;
      if (!monitorError) monitorError = new Error('the monitor process got no pid');
    }
  }

  // Amendment A2: the SPAWNER captures pid + OS creation time of what it spawned, so
  // nothing an operator needs in order to clear a stuck state depends on a monitor
  // having run (agy H4, codex H2). The keeper's identity is already on disk.
  if (monitor) {
    spawned.monitor_pid = monitor.pid;
    spawned.monitor_created_at = await ownChildCreationTime(monitor.pid, { deadlineMs: 4000 });
    writeJsonAtomic(P.spawned, spawned); // atomic rewrite by the same sole writer
  }

  const out = {
    id,
    admission: 'acquired',
    cli: cliName,
    lane: laneName,
    model_requested: model,
    model_canonical: rec.model_canonical,
    dir,
    state_root: cfg.stateRoot,
    run_dir: P.dir,
    keeper_pid: keeper.pid,
    keeper_created_at: spawned.keeper_created_at,
    monitor_pid: spawned.monitor_pid,
    lane_pipe: scope.pipeName,
    status: 'running',
    role,
    wp: rec.wp,
    slice: rec.slice,
    baseline: rec.scope ? rec.scope.baseline : null,
  };
  if (monitorError) out.monitor_error = `the monitor did not start (${(monitorError && monitorError.code) || monitorError.message || monitorError}); the run continues unmonitored - start one with \`orch monitor ${id}\``;
  if (args.json) io.log(JSON.stringify(out, null, 2));
  else {
    io.log(`job ${id}`);
    io.log(`  cli=${cliName} lane=${laneName} model=${model} dir=${dir}`);
    io.log(`  record ${P.record}`);
    io.log(`  keeper pid ${keeper.pid}${spawned.monitor_pid ? ` monitor pid ${spawned.monitor_pid}` : ' (no monitor)'}`);
    if (out.monitor_error) io.log(`  WARNING: ${out.monitor_error}`);
  }
  return { ...out, exitCode: 0 };
}

/**
 * Slice 2 run fields: claim check, allowlist (`--allow` + the handoff's `ALLOW:` block)
 * and the baseline the scope guard diffs against. The baseline is the recorded one when
 * `--dir` is an orch-created worktree, else HEAD of `--dir` at launch. An allowlist with
 * no git baseline is refused: it could never be checked.
 */
async function runWorkflowFields(cfg, args, dir, handoff) {
  const wp = args.wp || null;
  const slice = args.slice || null;
  const by = args.by || null;
  if (wp) {
    wpKey(wp);
    if (!by) throw new OrchError('--wp needs --by <claude-code|codex|owner>: a run for a work package requires its claim', 'missing-arg');
    requireClaim(cfg, wp, by);
  }
  if (slice) sliceKey(slice);
  if (args.size && !['XS', 'S', 'M'].includes(String(args.size))) throw new OrchError('--size must be XS, S or M', 'bad-size');
  const cliAllow = [].concat(args.allow || []).map(String);
  const blockAllow = parseAllowBlock(fs.readFileSync(handoff, 'utf8'));
  const allow = [...cliAllow, ...blockAllow];
  let scope = null;
  if (wp || allow.length) {
    const wt = worktreeRecordForDir(cfg, dir);
    if (wt && wp && wpKey(wt.wp) !== wpKey(wp)) {
      throw new OrchError(`--dir is the worktree of ${wt.wp}, not of ${wp}`, 'wp-mismatch');
    }
    const top = await gitTopLevel(dir);
    let baseline = wt ? wt.baseline : null;
    if (!baseline && top) baseline = await resolveCommit(top, 'HEAD');
    if (allow.length && (!top || !baseline)) {
      throw new OrchError(`an allowlist was given but ${dir} is not a git work tree with a commit; the scope guard could never check it`, 'no-baseline');
    }
    scope = {
      allow,
      allow_sources: { cli: cliAllow, handoff_block: blockAllow },
      baseline: baseline || null,
      baseline_source: wt ? `worktree ${wt.id}` : baseline ? 'HEAD of --dir at launch' : null,
      repo_top: top ? path.resolve(top) : null,
      worktree_id: wt ? wt.id : null,
    };
  }
  return { wp, slice, by, size: args.size || null, scope };
}

/** Record what orch itself wrote into the worktree (vibe's config), with its hash. */
function orchWrittenFiles(dir, extra) {
  const out = [];
  if (extra.vibe_config) {
    const rel = path.relative(dir, extra.vibe_config).replace(/\\/g, '/');
    out.push({ path: rel, sha256: sha256File(extra.vibe_config) });
  }
  return out;
}

/**
 * Read the keeper's one admission line from fd 1. Bounded three ways: the line
 * arrives, the pipe reaches EOF (the keeper died), or the deadline expires. It can
 * never hang `orch run` (A1).
 */
function readAdmission(child, admissionFile, timeoutMs) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const fromFile = (fallback) => {
      // The keeper writes admission.json atomically before it writes the line, so a
      // torn-down pipe still leaves a usable answer.
      const o = readJson(admissionFile, null);
      finish(o && o.admission ? o : fallback);
    };
    const timer = setTimeout(
      () => fromFile({ admission: 'undetermined', reason: `keeper did not answer within ${timeoutMs}ms` }),
      timeoutMs,
    );
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)));
      } catch {
        fromFile({ admission: 'undetermined', reason: 'keeper answered with an unparseable line' });
      }
    });
    child.stdout.on('error', () => fromFile({ admission: 'undetermined', reason: 'admission pipe error' }));
    child.stdout.on('close', () => fromFile({ admission: 'undetermined', reason: 'keeper exited without an admission line' }));
    child.on('error', (e) =>
      fromFile({ admission: 'blocked', reason: `keeper could not be started: ${(e && e.code) || e}` }),
    );
  });
}

/* --------------------------------------------------------------- status ---- */

/**
 * Everything `status` knows about one run, read-only. Never writes, never binds,
 * never starts anything.
 */
/**
 * @returns {Promise<any>} deliberately loose: the `record-unreadable` answer and the
 * full answer are different shapes, and both are printed by the same loop.
 */
export async function inspect(cfg, id, dl) {
  const P = paths(cfg, id);
  const rec = await withDeadline(() => fsp.readFile(P.record, 'utf8').then(JSON.parse), dl.at('read run.json').remaining(), null, dl);
  if (!rec) {
    return { id, status: 'record-unreadable', reason: 'run.json missing or malformed', paths: P, undetermined: dl.expired() ? dl.text() : null };
  }
  const scope = laneScope(rec.lane || 'local');

  const keeperLines = await withDeadline(() => readTailLinesAsync(P.keeper, 8192), dl.at('read keeper.ndjson').remaining(), [], dl);
  const facts = keeperFacts(keeperLines);
  const spawned = await withDeadline(() => fsp.readFile(P.spawned, 'utf8').then(JSON.parse), dl.at('read spawned.json').remaining(), null, dl);
  const cancelReq = await withDeadline(() => fsp.stat(P.cancel).then(() => true).catch(() => false), dl.at('stat cancel.json').remaining(), false, dl);
  const cancelDoc = cancelReq ? await withDeadline(() => readJsonAsync(P.cancel, null), dl.at('read cancel.json').remaining(), null, dl) : null;
  const outStat = await withDeadline(() => fsp.stat(P.stdout).catch(() => null), dl.at('stat stdout.log').remaining(), null, dl);
  const errStat = await withDeadline(() => fsp.stat(P.stderr).catch(() => null), dl.at('stat stderr.log').remaining(), null, dl);
  const errTail = await withDeadline(() => readTailLinesAsync(P.stderr, 65536), dl.at('read stderr.log tail').remaining(), [], dl);
  const outTail = await withDeadline(() => readTailLinesAsync(P.stdout, 262144), dl.at('read stdout.log tail').remaining(), [], dl);

  // The lane and the monitor are probed by CONNECTING, never by binding.
  const exclusive = !(rec.launch && rec.launch.lane_exclusive === false);
  const lane = !exclusive ? { state: 'not-exclusive', hello: null, code: null } : await withDeadline(
    () => connectHello(scope.pipeName, { deadlineMs: Math.min(HELLO_DEADLINE_MS, dl.remaining()) }),
    dl.at('probe lane pipe').remaining(),
    { state: 'unknown', hello: null, code: 'deadline' },
    dl,
  );
  const mon = await withDeadline(
    () => connectHello(scope.monitorPipe(id), { deadlineMs: Math.min(HELLO_DEADLINE_MS, dl.remaining()) }),
    dl.at('probe monitor pipe').remaining(),
    { state: 'unknown', hello: null, code: 'deadline' },
    dl,
  );
  const laneHolder = await withDeadline(
    () => fsp.readFile(scope.holderFile, 'utf8').then(JSON.parse).catch(() => null),
    dl.at('read lane holder').remaining(),
    null,
    dl,
  );

  // ONE bounded process-table read, and only when it can change the answer: a worker
  // pid is recorded with no exit line, or a keeper identity has to be classified.
  const workerPid = facts.workerPid ?? rec.worker_pid ?? null;
  const workerCreatedAt = facts.workerCreatedAt ?? null; // the keeper trail is the ONLY source (astra H4)
  const keeperPid = (spawned && spawned.keeper_pid) ?? rec.keeper_pid ?? null;
  const keeperCreatedAt = (spawned && spawned.keeper_created_at) ?? rec.keeper_created_at ?? null;
  const needTable = (workerPid && !facts.workerExit) || (keeperPid && !facts.keeperExit);
  let table = null;
  let tableRead = false;
  if (needTable && !dl.expired()) {
    table = await withDeadline(
      () => readProcessTable({ deadlineMs: Math.min(4000, dl.remaining()), pids: [workerPid, keeperPid].filter(Boolean) }),
      dl.at('read process table').remaining(),
      null,
      dl,
    );
    tableRead = true;
  }
  // Re-read the keeper's trail AFTER the process query: a keeper-gone verdict paired
  // with a stale "no worker-exit line" would report `interrupted` for a run that has
  // just finished cleanly. Process facts and file facts must be read together.
  if (tableRead) {
    const again = keeperFacts(await withDeadline(() => readTailLinesAsync(P.keeper, 8192), dl.at('re-read keeper.ndjson').remaining(), [], dl));
    if (again.lines >= facts.lines) Object.assign(facts, again);
  }
  // Missing identity is `unknown`, never `gone` (astra H2).
  const workerId = workerPid ? verifyIdentity(workerPid, workerCreatedAt, tableRead ? table : null) : { verdict: 'unknown', reason: 'no-worker-pid-recorded' };
  const keeperId = keeperPid ? verifyIdentity(keeperPid, keeperCreatedAt, tableRead ? table : null) : { verdict: 'unknown', reason: 'no-keeper-pid-recorded' };

  const adapter = safeAdapter(rec.cli);
  const derived = deriveStatus(adapter ? adapter.statusRules || [] : [], {
    cancelRequested: cancelReq,
    cancelRequestedAt: cancelDoc ? cancelDoc.requested_at ?? null : null,
    workerExitAt: facts.workerExit ? facts.workerExit.at ?? null : null,
    workerConfirmedGone: !!facts.workerExit || workerId.verdict === 'gone',
    blocked: facts.blocked,
    workerExitSeen: !!facts.workerExit,
    keeperVerdict: facts.keeperExit ? 'gone' : keeperId.verdict,
    exitCode: facts.workerExit ? facts.workerExit.code : null,
    signal: facts.workerExit ? facts.workerExit.signal : null,
    // Only the EMPTINESS of worker output may reach a rule, never its content.
    stdout: outStat && outStat.size > 0 ? 'x' : '',
    // CODE-REVIEW FIX (agy g5): rules MAY read stderr and protocol ERROR records (the
    // rule about rules), and the monitor feeds them; status must feed the same, or the
    // two derive different final states (turn-cap vs failed). Bounded tails, async.
    stderr: facts.workerExit ? errTail.join('\n') : '',
    events: facts.workerExit && adapter && adapter.parseProtocol ? safeProtocol(adapter, outTail.join('\n')) : [],
    dirEvidence: rec.dir_evidence || 'none',
    directoryRelevant: !!(adapter && adapter.directoryEvidence),
  });

  return {
    id,
    status: TERMINAL.has(rec.status) ? rec.status : derived.terminal ? `${derived.status} (derived, not written)` : rec.status,
    record_status: rec.status,
    derived_status: derived.status,
    derived_reason: derived.reason,
    derived_rule: derived.rule,
    reason: rec.reason || (derived.terminal ? derived.reason : null),
    note: derived.note || null,
    cli: rec.cli,
    lane: rec.lane,
    model_canonical: rec.model_canonical,
    model_actual: rec.model_actual || null,
    model_mismatch: rec.model_mismatch === undefined ? null : rec.model_mismatch,
    dir: rec.dir,
    worker_pid: workerPid,
    // A recorded exit line is stronger evidence than any later table read: say so
    // rather than printing `unknown` for a run that finished cleanly.
    worker_identity: facts.workerExit ? 'exited' : String(workerId.verdict),
    keeper_pid: keeperPid,
    keeper_identity: facts.keeperExit ? 'exited' : String(keeperId.verdict),
    keeper_blocked: facts.blocked ? facts.blocked.reason : null,
    keeper_write_failures: facts.writeFailures,
    monitor: monitorLine(mon, spawned),
    monitor_pid: spawned ? spawned.monitor_pid : null,
    lane_state: laneStateLine(lane, laneHolder, id),
    lane_probe: lane.state,
    lane_holder_run: laneHolder ? laneHolder.run_id : null,
    cancel_requested: cancelReq,
    cancel_result: await withDeadline(() => readJsonAsync(P.cancelResult, null), dl.at('read cancel-result.json').remaining(), null, dl),
    exit_code: facts.workerExit ? facts.workerExit.code : (rec.exit_code ?? null),
    dir_evidence: rec.dir_evidence || 'none',
    escaped_helpers: rec.escaped_helpers || [],
    last_activity_at: rec.last_activity_at || null,
    last_activity_signal: rec.last_activity_signal || null,
    quiet_seconds: rec.last_activity_at ? Math.round((Date.now() - Date.parse(rec.last_activity_at)) / 1000) : null,
    stdout_bytes: outStat ? outStat.size : 0,
    stderr_bytes: errStat ? errStat.size : 0,
    process_table_read: tableRead ? table !== null : false,
    created_at: rec.created_at,
    ended_at: rec.ended_at || null,
    paths: P,
    undetermined: dl.expired() ? dl.text() : null,
  };
}

/** Protocol ERROR records only reach a rule through protocolErrorText; never throws. */
function safeProtocol(adapter, text) {
  try {
    return adapter.parseProtocol(text);
  } catch {
    return [];
  }
}

function monitorLine(mon, spawned) {
  if (mon.state === 'held') return 'running';
  if (mon.state === 'held-unresponsive') return 'not running (pipe held, no hello)';
  if (mon.state === 'unknown') return 'unknown (probe exceeded its deadline)';
  return spawned && spawned.monitor_pid ? 'not running' : 'not running (never started)';
}

function laneStateLine(lane, holder, myId) {
  if (lane.state === 'not-exclusive') return 'lane not exclusive (runs in parallel)';
  if (lane.state === 'free') return 'lane free';
  if (lane.state === 'unknown') return 'lane state unknown (probe exceeded its deadline)';
  const who = holder ? (holder.run_id === myId ? 'this run' : `run ${holder.run_id}`) : 'unknown (holder starting)';
  if (lane.state === 'held-unresponsive') return `held, unresponsive (holder: ${who})`;
  return `lane held by ${who}`;
}

export async function cmdStatus(args, io = console) {
  const cfg = loadConfig(args['state-root']);
  // No ensureDirs here: status is read-only and creates nothing (r2-5), and every fs
  // call below is asynchronous so the whole-command deadline can actually fire (M5).
  const all = !!args.all;
  // The documented budget is 3 s per run / 10 s for --all. A bounded process query
  // costs 0.45-0.55 s idle on this machine but was measured past 5 s under load, and a
  // status that answers `unknown` exactly when a keeper has just died fails N4. The
  // budget is therefore 6 s / 15 s, with each individual step still bounded.
  const dl = new Deadline(all ? 15000 : 6000, 'status');
  const ids = all
    ? await withDeadline(
        () => fsp.readdir(cfg.runsDir, { withFileTypes: true }).then((es) => es.filter((e) => e.isDirectory()).map((e) => e.name).sort()),
        dl.at('list runs').remaining(),
        [],
        dl,
      )
    : [reqPositional(args, 'status <id> | --all')];
  /** @type {any[]} */
  const rows = [];
  for (const id of ids) {
    if (dl.expired()) {
      rows.push({ id, status: 'undetermined', undetermined: dl.text() });
      continue;
    }
    if (!all) {
      const exists = await withDeadline(() => fsp.stat(paths(cfg, id).dir).then(() => 'yes', () => 'no'), dl.at('stat run dir').remaining(), 'unknown', dl);
      if (exists === 'no') throw new OrchError(`no such run: ${id}`, 'no-such-run');
    }
    rows.push(await inspect(cfg, id, dl));
  }
  if (args.json) {
    io.log(JSON.stringify({ runs: rows }, null, 2));
    return { runs: rows };
  }
  for (const r of rows) {
    if (r.undetermined && r.status === 'undetermined') {
      io.log(`${r.id}  ${r.undetermined}`);
      continue;
    }
    io.log(`${r.id}  ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
    io.log(`  cli=${r.cli} lane=${r.lane} model=${r.model_canonical}`);
    io.log(`  monitor: ${r.monitor}   ${r.lane_state}`);
    io.log(`  keeper pid=${r.keeper_pid ?? '-'} [${r.keeper_identity}]  worker pid=${r.worker_pid ?? '-'} [${r.worker_identity}]`);
    if (r.keeper_blocked) io.log(`  blocked: ${r.keeper_blocked}`);
    if (r.cancel_requested) io.log('  cancel requested');
    if (r.note) io.log(`  note: ${r.note}`);
    for (const h of r.escaped_helpers || []) {
      io.log(`  ESCAPED HELPER pid ${h.pid} (${h.name}) is alive. orch did not kill it and never will.`);
    }
    io.log(`  stdout=${r.stdout_bytes}B stderr=${r.stderr_bytes}B  last activity ${r.last_activity_at ?? '-'} (${r.quiet_seconds ?? '-'}s ago)`);
    if (r.undetermined) io.log(`  ${r.undetermined}`);
  }
  return { runs: rows };
}

/* ----------------------------------------------------------------- list ---- */

export async function cmdList(args, io = console) {
  const cfg = loadConfig(args['state-root']);
  ensureDirs(cfg);
  const rows = listRuns(cfg).map((r) => ({
    id: r.id,
    status: r.status,
    reason: r.reason || null,
    cli: r.cli,
    lane: r.lane,
    model_canonical: r.model_canonical,
    dir: r.dir,
  }));
  if (args.json) {
    io.log(JSON.stringify(rows, null, 2));
    return rows;
  }
  if (!rows.length) io.log('(no runs)');
  for (const r of rows) {
    io.log(`${r.id}  ${pad(r.status, 16)} ${pad(r.cli, 9)} ${pad(r.lane, 6)} ${pad(r.model_canonical, 24)} ${r.dir}`);
  }
  return rows;
}

/* --------------------------------------------------------------- result ---- */

export function cmdResult(args, io = console) {
  const cfg = loadConfig(args['state-root']);
  const id = reqPositional(args, 'result <id>');
  const rec = readRun(cfg, id);
  if (!rec) throw new OrchError(`no such run: ${id}`, 'no-such-run');
  const P = paths(cfg, id);
  const stdout = safeRead(P.stdout);
  const finalMessage = extractFinalMessage(rec.cli, stdout);
  const out = {
    id,
    status: rec.status,
    reason: rec.reason || null,
    exit_code: rec.exit_code ?? null,
    model_requested: rec.model_requested,
    model_canonical: rec.model_canonical,
    model_actual: rec.model_actual || null,
    model_actual_alias: rec.model_actual_alias || null,
    routed_default_model: rec.routed_default_model || null,
    model_mismatch: rec.model_mismatch === undefined ? null : rec.model_mismatch,
    dir_evidence: rec.dir_evidence || 'none',
    final_message: finalMessage,
    warnings: rec.post_exit_warnings || [],
    escaped_helpers: rec.escaped_helpers || [],
    paths: { ...P },
  };
  if (args.json) {
    io.log(JSON.stringify(out, null, 2));
    return out;
  }
  io.log(`${id}  ${rec.status}${rec.reason ? ` (${rec.reason})` : ''}  exit=${rec.exit_code ?? '-'}`);
  if (out.model_actual) io.log(`model actual: ${out.model_actual}`);
  if (out.model_mismatch === true) io.log(`** MODEL MISMATCH ** requested ${out.model_canonical}`);
  for (const w of out.warnings) io.log(`warning: ${w}`);
  io.log('--- final message ---');
  io.log(finalMessage || '(no output)');
  return out;
}

/* ------------------------------------------------------------------ log ---- */

export function cmdLog(args, io = console) {
  const cfg = loadConfig(args['state-root']);
  const id = reqPositional(args, 'log <id>');
  const P = paths(cfg, id);
  if (!fs.existsSync(P.dir)) throw new OrchError(`no such run: ${id}`, 'no-such-run');
  const which = args.stream || 'stderr';
  const file =
    which === 'stdout' ? P.stdout : which === 'keeper' ? P.keeper : which === 'events' ? P.events : P.stderr;
  const text = safeRead(file);
  const n = args.tail != null ? Number(args.tail) : 0;
  const lines = text.split(/\r?\n/);
  const slice = n > 0 ? lines.slice(-n) : lines;
  io.log(slice.join('\n'));
  return { file, lines: slice.length };
}

/* ------------------------------------------------------------ wait-lane ---- */

/**
 * Waits for the lane to free. It NEVER binds, so a contender can take the lane while
 * `wait-lane` is running, and it writes no file. It always has a deadline.
 */
export async function cmdWaitLane(args, io = console) {
  const laneName = args.lane || 'local';
  const scope = laneScope(laneName);
  // There is ALWAYS a deadline, with or without --timeout (codex M1).
  const defaultS = Number(process.env.ORCH_WAIT_LANE_DEFAULT_S || 300);
  const timeoutS = args.timeout != null ? Number(args.timeout) : defaultS;
  const dl = new Deadline(timeoutS * 1000, 'wait-lane');
  let last = null;
  for (;;) {
    dl.at('probe lane pipe');
    last = await connectHello(scope.pipeName, { deadlineMs: Math.min(HELLO_DEADLINE_MS, Math.max(1, dl.remaining())) });
    if (last.state === 'free') {
      const out = { lane: laneName, state: 'free', waited_ms: Math.round(dl.elapsed()) };
      if (args.json) io.log(JSON.stringify(out, null, 2));
      else io.log('lane free');
      return { ...out, exitCode: 0 };
    }
    if (dl.expired()) break;
    const holder = await withDeadline(() => readJsonAsync(scope.holderFile, null), Math.min(1000, Math.max(1, dl.remaining())), null);
    if (args.verbose) {
      io.log(last.state === 'held-unresponsive' ? 'held, unresponsive' : `lane held by run ${holder ? holder.run_id : 'unknown (holder starting)'}`);
    }
    await sleep(Math.min(1000, Math.max(1, dl.remaining())));
    if (dl.expired()) break;
  }
  const holder = await withDeadline(() => readJsonAsync(scope.holderFile, null), 1000, null);
  const state = last && last.state === 'held-unresponsive' ? 'held, unresponsive' : 'held';
  const text =
    state === 'held, unresponsive'
      ? 'held, unresponsive'
      : `lane held by run ${holder ? holder.run_id : 'unknown (holder starting)'}`;
  const out = { lane: laneName, state, holder_run: holder ? holder.run_id : null, waited_ms: Math.round(dl.elapsed()), timed_out: true };
  if (args.json) io.log(JSON.stringify(out, null, 2));
  else io.log(text);
  return { ...out, exitCode: 3 };
}

/* --------------------------------------------------------------- cancel ---- */

/**
 * Amendment A3 — cancel tells the truth.
 *
 * Success is reported ONLY when a post-kill process-table read shows the recorded
 * MAIN worker gone (or a mismatch, i.e. the pid is now somebody else). Anything else
 * is `unconfirmed` with the survivors named. `cancel.json` is a REQUEST; it never
 * makes a live worker look terminal.
 */
export async function cmdCancel(args, io = console) {
  const cfg = loadConfig(args['state-root']);
  const id = reqPositional(args, 'cancel <id>');
  const rec = readRun(cfg, id);
  if (!rec) throw new OrchError(`no such run: ${id}`, 'no-such-run');
  const P = paths(cfg, id);
  if (args.keeper) return cancelKeeper(cfg, rec, args, io);

  const facts = keeperFacts(readTailLines(P.keeper, 16384));
  const workerPid = facts.workerPid ?? rec.worker_pid ?? null;
  const workerCreatedAt = facts.workerCreatedAt ?? null; // the keeper trail is the ONLY source (astra H4)

  // agy g6: once the keeper has recorded the worker's exit there is nothing to cancel,
  // whatever run.json says (it can lag when no monitor is running). No request is written.
  if (facts.workerExit) {
    const out = { id, cancel_state: 'already-terminal', status: rec.status, survivors: [] };
    emit(args, io, out, `${id} is already ${rec.status}; nothing to cancel`);
    return { ...out, exitCode: 0 };
  }

  // Serialise concurrent cancels with `wx`; the loser prints the existing request.
  let firstRequester = true;
  try {
    fs.writeFileSync(P.cancel, JSON.stringify({ requested_at: nowIso(), by_pid: process.pid }, null, 2) + '\n', { flag: 'wx' });
  } catch (e) {
    if (e && e.code === 'EEXIST') firstRequester = false;
    else throw e;
  }

  // CODE-REVIEW FIX (astra M6): `cancel.json` only records that cancellation was
  // requested. The ATTEMPT is serialised by a second, identity-stamped lock file: one
  // process kills and writes `cancel-result.json`; a concurrent caller waits and serves
  // that result without killing anything. A lock whose holder is verifiably gone is
  // taken over, so a crashed canceller never blocks a retry.
  const lock = await acquireCancelLock(P, 25000);
  if (!lock.acquired) {
    if (lock.served) {
      const out = { ...lock.served, first_requester: firstRequester, served_from: 'concurrent-cancel', kill_performed: false };
      emit(args, io, out, `${id}: another orch cancel performed this attempt; its result: ${out.cancel_state}`);
      return { ...out, exitCode: out.cancel_state === 'cancelled' ? 0 : 3 };
    }
    const out = { id, cancel_state: 'unconfirmed-cancel-in-progress', reason: lock.reason, first_requester: firstRequester, kill_performed: false };
    emit(args, io, out, `${id}: NOT confirmed - another cancel attempt is still in progress (${lock.reason}).`);
    return { ...out, exitCode: 3 };
  }
  try {
    return await performCancel({ id, rec, P, args, io, firstRequester, workerPid, workerCreatedAt, attempt: lock.me.attempt });
  } finally {
    releaseCancelLock(P, lock.me);
  }
}

async function performCancel({ id, rec, P, args, io, firstRequester, workerPid, workerCreatedAt, attempt }) {
  if (!workerPid) {
    const out = { id, cancel_state: 'unconfirmed-no-identity', reason: 'no worker pid was ever recorded', survivors: null, first_requester: firstRequester, attempt, kill_performed: false, at: nowIso() };
    writeJsonAtomic(P.cancelResult, out);
    emit(args, io, out, `${id}: NOT cancelled - no worker pid was ever recorded, so nothing could be targeted. Use \`orch cancel --keeper ${id}\`.`);
    return { ...out, exitCode: 3 };
  }

  const kill = await treeKillChecked(workerPid, workerCreatedAt, { deadlineMs: 3000 });

  // Give the keeper up to 15 s to reap and record the exit.
  const reapDeadline = new Deadline(15000, 'reap wait');
  while (!reapDeadline.expired()) {
    const f = keeperFacts(readTailLines(P.keeper, 16384));
    if (f.workerExit) break;
    await sleep(400);
  }

  // Final, bounded identity read. Nothing is claimed before this.
  const finalTable = await readProcessTable({ deadlineMs: 3000, pids: [workerPid] });
  const finalId = verifyIdentity(workerPid, workerCreatedAt, finalTable);
  const exitRecorded = !!keeperFacts(readTailLines(P.keeper, 16384)).workerExit;
  // Success needs POSITIVE evidence of death: the keeper recorded the exit, or the pid
  // is gone from a table we could read. A `mismatch` is not evidence - it says the
  // recorded identity never matched the live process (A3).
  const gone = exitRecorded || finalId.verdict === 'gone';

  let state;
  if (kill.verdict === 'mismatch' || kill.verdict === 'unknown') {
    // A REFUSED kill is not evidence of death. PID-reuse simulation lands here.
    state = `unconfirmed-identity-${kill.verdict}`;
  } else if (gone) {
    // A recorded `worker-exit` line is positive evidence on its own, so it outranks an
    // unreadable process table: the keeper watched the worker die.
    state = 'cancelled';
  } else if (finalTable === null) {
    state = 'unconfirmed-no-process-table';
  } else {
    state = 'unconfirmed-survivors';
  }

  const survivors = gone ? [] : finalTable === null ? null : [{ pid: workerPid, role: 'worker', identity: finalId.verdict }];
  const out = {
    id,
    cancel_state: state,
    kill_verdict: kill.verdict,
    killed: kill.killed,
    kill_output: kill.output,
    worker_pid: workerPid,
    worker_identity_after: finalId.verdict,
    survivors,
    process_table_read: finalTable !== null,
    first_requester: firstRequester,
    attempt,
    kill_performed: kill.verdict === 'match',
    exit_recorded: exitRecorded,
    note: TREE_KILL_NOTE,
    at: nowIso(),
  };
  writeJsonAtomic(P.cancelResult, out);

  if (rec.viewer_pid) {
    const c = await closeViewer(rec.viewer_pid, rec.viewer_created_at);
    out.viewer = c;
  }

  emit(args, io, out, cancelText(out));
  return { ...out, exitCode: state === 'cancelled' ? 0 : 3 };
}

/**
 * The cancel ATTEMPT lock (astra M6). Written with `wx` by the `orch cancel` process
 * only, stamped with that process's pid AND OS creation time so a stale lock can be
 * told apart from a live one without guessing.
 */
async function acquireCancelLock(P, waitMs) {
  const { times } = await creationTimesOf([process.pid], { deadlineMs: 4000 });
  const me = { pid: process.pid, created_at: times[process.pid] ?? null, attempt: crypto.randomBytes(6).toString('hex'), at: nowIso() };
  const dl = new Deadline(waitMs, 'cancel lock');
  const waitStartedMs = Date.now();
  let waited = false;
  let reason = 'no-attempt';
  while (!dl.expired()) {
    try {
      fs.writeFileSync(P.cancelLock, JSON.stringify(me) + '\n', { flag: 'wx' });
      if (waited) {
        // We waited on a concurrent attempt that has now finished: serve its result.
        const res = readJson(P.cancelResult, null);
        if (res && res.at && Date.parse(res.at) >= waitStartedMs) {
          releaseCancelLock(P, me);
          return { acquired: false, served: res, me };
        }
      }
      return { acquired: true, me };
    } catch (/** @type {any} */ e) {
      if (!e || e.code !== 'EEXIST') throw e;
    }
    waited = true;
    const holder = readJson(P.cancelLock, null);
    if (holder && holder.pid) {
      const t = await readProcessTable({ deadlineMs: 3000, pids: [holder.pid] });
      const v = holder.created_at ? verifyIdentity(holder.pid, holder.created_at, t).verdict : 'unknown';
      if (v === 'gone' || v === 'mismatch') {
        // Stale: its holder is verifiably not running. Move it aside atomically; if a
        // concurrent caller moved it first, the rename simply fails.
        try {
          fs.renameSync(P.cancelLock, `${P.cancelLock}.stale-${crypto.randomBytes(4).toString('hex')}`);
        } catch {
          /* someone else took it over */
        }
        continue;
      }
      reason = `attempt ${holder.attempt || '?'} by pid ${holder.pid} is ${v}`;
    }
    await sleep(Math.min(500, Math.max(1, dl.remaining())));
  }
  return { acquired: false, served: null, reason, me };
}

function releaseCancelLock(P, me) {
  try {
    const cur = readJson(P.cancelLock, null);
    if (cur && cur.attempt === me.attempt) fs.unlinkSync(P.cancelLock); // only our own lock
  } catch {
    /* already gone */
  }
}

function cancelText(o) {
  const lines = [`${o.id} -> ${o.cancel_state}`];
  lines.push(`kill [${o.kill_verdict}]: ${o.kill_output || '(no output)'}`);
  if (String(o.cancel_state).startsWith('unconfirmed-identity')) {
    lines.push(
      `NOT CANCELLED: pid ${o.worker_pid} could not be proven to be this run's worker, so nothing was killed and ` +
        'nothing is claimed. Inspect the process yourself.',
    );
  } else if (o.survivors === null) {
    lines.push('NOT CANCELLED: the process table could not be read, so death is NOT confirmed.');
  } else if (o.survivors.length) {
    lines.push(`NOT CANCELLED: survivors ${JSON.stringify(o.survivors)} - the run is not terminal and the lane stays held.`);
  } else {
    lines.push(`confirmed: the recorded worker pid ${o.worker_pid} is ${o.worker_identity_after}.`);
  }
  lines.push(`note: ${TREE_KILL_NOTE}`);
  return lines.join('\n');
}

/** The accepted, documented conflict with "escaped helpers are never killed" (v4 §6 H6). */
export const TREE_KILL_NOTE =
  'a tree kill also ends descendants the worker spawned detached. This is accepted and documented, not claimed away.';

/**
 * `orch cancel --keeper <id>` — explicit operator escalation for a frozen keeper.
 * Kills the identity-checked KEEPER pid only (`/F`, no `/T`), then reports the worker
 * and the lane. Exit 0 requires keeper gone AND the MAIN worker gone AND the lane
 * bindable-by-probe (agy M1: exit 0 must never invite a second worker).
 */
async function cancelKeeper(cfg, rec, args, io) {
  const id = rec.id;
  const P = paths(cfg, id);
  const spawned = readJson(P.spawned, null);
  const facts = keeperFacts(readTailLines(P.keeper, 16384));
  const keeperPid = (spawned && spawned.keeper_pid) ?? rec.keeper_pid ?? null;
  const keeperCreatedAt = (spawned && spawned.keeper_created_at) ?? rec.keeper_created_at ?? null;

  if (!keeperPid) {
    const out = { id, cancel_state: 'unconfirmed-no-keeper-identity', reason: 'no keeper pid was recorded by orch run' };
    emit(args, io, out, `${id}: no keeper pid was recorded; nothing can be targeted.`);
    return { ...out, exitCode: 3 };
  }

  const kill = await killChecked(keeperPid, keeperCreatedAt, { deadlineMs: 3000 });
  await sleep(500);

  const workerPid = facts.workerPid ?? rec.worker_pid ?? null;
  const workerCreatedAt = facts.workerCreatedAt ?? null; // the keeper trail is the ONLY source (astra H4)
  const pids = [keeperPid, workerPid].filter(Boolean);
  const dl = new Deadline(10000, 're-check');
  let table = await readProcessTable({ deadlineMs: dl.remaining(), pids });
  let keeperId = verifyIdentity(keeperPid, keeperCreatedAt, table);
  let workerId = workerPid ? verifyIdentity(workerPid, workerCreatedAt, table) : { verdict: 'unknown', reason: 'no-worker-pid-recorded' };
  // The measured rebind latency after a keeper kill is 195-252 ms (X3 D/E, K3 204 ms),
  // so one re-check is taken after a short settle.
  if ((keeperId.verdict === 'match' || workerId.verdict === 'match') && !dl.expired()) {
    await sleep(Math.min(1500, dl.remaining()));
    table = await readProcessTable({ deadlineMs: Math.max(500, dl.remaining()), pids });
    keeperId = verifyIdentity(keeperPid, keeperCreatedAt, table);
    workerId = workerPid ? verifyIdentity(workerPid, workerCreatedAt, table) : { verdict: 'unknown', reason: 'no-worker-pid-recorded' };
  }

  const scope = laneScope(rec.lane || 'local');
  const lane = await connectHello(scope.pipeName, { deadlineMs: HELLO_DEADLINE_MS });
  const keeperGone = keeperId.verdict === 'gone' || keeperId.verdict === 'mismatch';
  // Positive evidence only (A3, astra H2): a recorded exit, or the recorded pid gone from a
  // table we could read. No pid recorded, unknown and mismatch are not evidence of death.
  const exitRecorded = !!keeperFacts(readTailLines(P.keeper, 16384)).workerExit;
  const workerGone = exitRecorded || workerId.verdict === 'gone';
  const ok = keeperGone && workerGone && lane.state === 'free';

  const out = {
    id,
    cancel_state: ok ? 'keeper-cleared' : 'unconfirmed',
    kill_verdict: kill.verdict,
    kill_output: kill.output,
    keeper_pid: keeperPid,
    keeper_created_at: keeperCreatedAt,
    keeper_identity_after: keeperId.verdict,
    keeper_identity_reason: keeperId.reason || null,
    worker_pid: workerPid,
    worker_created_at: workerCreatedAt,
    worker_identity_after: workerId.verdict,
    worker_identity_reason: workerId.reason || null,
    worker_exit_recorded: exitRecorded,
    process_table_read: table !== null,
    lane_state_after: lane.state,
    at: nowIso(),
  };
  writeJsonAtomic(P.cancelResult, out);
  emit(
    args,
    io,
    out,
    `${id} -> ${out.cancel_state}\n  keeper ${keeperPid} [${keeperId.verdict}]  worker ${workerPid ?? '-'} [${workerId.verdict}]  lane ${lane.state}` +
      (ok ? '' : '\n  NOT CLEARED: the lane may still be held or the worker may still be alive; nothing further was killed.'),
  );
  return { ...out, exitCode: ok ? 0 : 3 };
}

/* -------------------------------------------------------------- monitor ---- */

export async function cmdMonitor(args, io = console) {
  const cfg = loadConfig(args['state-root']);
  const id = reqPositional(args, 'monitor <id>');
  const rec = readRun(cfg, id);
  if (!rec) throw new OrchError(`no such run: ${id}`, 'no-such-run');
  const P = paths(cfg, id);
  const scope = laneScope(rec.lane || 'local');

  if (TERMINAL.has(rec.status)) {
    const out = { id, monitor: 'not-started', reason: `run is terminal (${rec.status})` };
    emit(args, io, out, `${id} is ${rec.status}; no monitor started`);
    return { ...out, exitCode: 4 };
  }
  const probe = await connectHello(scope.monitorPipe(id), { deadlineMs: HELLO_DEADLINE_MS });
  if (probe.state === 'held') {
    const out = { id, monitor: 'already-running' };
    emit(args, io, out, `${id}: a monitor is already running`);
    return { ...out, exitCode: 3 };
  }

  const child = spawn(process.execPath, [MONITOR, '--state-root', cfg.stateRoot, '--id', id, '--run-dir', P.dir], {
    detached: true,
    shell: false,
    windowsHide: true,
    env: process.env,
    stdio: 'ignore',
  });
  child.unref();
  const out = { id, monitor: 'started', monitor_pid: child.pid };
  emit(args, io, out, `${id}: monitor started (pid ${child.pid})`);
  return { ...out, exitCode: 0 };
}

/* ------------------------------------------------------------------- gc ---- */

/** Removes only advisory lane files whose run is terminal. Kills nothing. */
export async function cmdGc(args, io = console) {
  const cfg = loadConfig(args['state-root']);
  const scope = laneScope(args.lane || 'local');
  const holder = readJson(scope.holderFile, null);
  const probe = await connectHello(scope.pipeName, { deadlineMs: HELLO_DEADLINE_MS });
  const out = { lane: scope.lane, lane_state: probe.state, holder_run: holder ? holder.run_id : null, removed: [] };
  if (holder && probe.state === 'free') {
    const rec = readRun(cfg, holder.run_id);
    if (!rec || TERMINAL.has(rec.status)) {
      try {
        fs.unlinkSync(scope.holderFile);
        out.removed.push(scope.holderFile);
      } catch {
        /* advisory only */
      }
    }
  }
  emit(args, io, out, `lane ${scope.lane}: ${probe.state}; removed ${out.removed.length} stale advisory file(s)`);
  return { ...out, exitCode: 0 };
}

/* ---------------------------------------------------------------- helpers -- */

function emit(args, io, obj, text) {
  if (args.json) io.log(JSON.stringify(obj, null, 2));
  else io.log(text);
}

function safeAdapter(name) {
  try {
    return getAdapter(name);
  } catch {
    return null;
  }
}

function req(args, name) {
  const v = args[name];
  if (v === undefined || v === null || v === '') throw new OrchError(`--${name} is required`, 'missing-arg');
  return Array.isArray(v) ? v[v.length - 1] : v;
}

function reqPositional(args, usage) {
  const v = (args._ || [])[0];
  if (!v) throw new OrchError(`usage: orch ${usage}`, 'missing-arg');
  return v;
}

function safeRead(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

export function extractFinalMessage(cli, stdout) {
  try {
    const adapter = getAdapter(cli);
    if (adapter.extractFinalMessage) return adapter.extractFinalMessage(String(stdout));
  } catch {
    /* unknown CLI: fall through to the raw stream */
  }
  return String(stdout).trim();
}

function pad(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export { PUBLIC_ADAPTERS, writeRun };
