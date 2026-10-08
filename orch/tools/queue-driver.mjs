// Queue driver: runs a plan folder's task backlog unattended, one `orch run` per task,
// verifies each task with a project-supplied checks file, commits per task, and stops
// hard on the first sign the run went off the rails (model fallback, forbidden path,
// stall, no changes). Generic kit tool: nothing project-specific is hard-coded - the
// worktree, plan folder, model, checks and forbidden paths are all options.
// Manual: docs/QUEUE_DRIVER.md. Unit tests: orch/test/queuedriver.test.mjs.
//
// Usage: node tools/queue-driver.mjs --wt <worktree> --plan <dir> [options]
//        node tools/queue-driver.mjs --help
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setting, resolveStateRoot } from '../src/config.mjs';
import { vibeLogDir } from '../src/adapters/vibe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORCH = path.resolve(HERE, '..', 'bin', 'orch.mjs'); // the kit's own orch entry point
const DEFAULT_STALL_MINUTES = 20;
const POLL_SECONDS = 30;
const SUPPORTED_CLIS = ['vibe'];

export const USAGE = `queue-driver - run a plan folder's task backlog unattended through orch

Usage:
  node tools/queue-driver.mjs --wt <worktree> --plan <dir> --checks <file> [options]

Plan folder (--plan, absolute or relative to --wt):
  COMMON.md  prepended to every task handoff
  TASKS.md   the task sections; a section opens with a "##### <ID>" line and carries a
             "TASK <ID>: <title>" line and a "TESTS: <paths>" line ("TESTS: (...)" means
             the task has no test command); RUNLOG.md is appended here as the queue runs

Checks file (--checks, JSON):
  {"test": ["cmd", "arg", ...],      runs with the task's TESTS paths appended
   "extra": [["cmd", "arg"], ...],   runs for every task (lint, typecheck, ...)
   "cwd": "dir",                     working dir, relative to the worktree (default ".")
   "env": {"KEY": "value"}}          extra environment for every check command

Options:
  --wt PATH         required; the worktree the tasks edit (git and checks run here)
  --plan DIR        required; the plan folder
  --checks FILE     the checks file above; without it tasks are committed unverified
  --model ID        worker model; required unless ORCH_QUEUE_MODEL or "queueDriver.model"
                    in orch.config.json names one
  --cli NAME        worker CLI (default: vibe; supported: ${SUPPORTED_CLIS.join(', ')})
  --forbid REGEX    a changed path matching REGEX stops the queue, uncommitted (repeatable)
  --stall-minutes N cancel a worker whose last activity is older than N minutes (default ${DEFAULT_STALL_MINUTES})
  --from ID         start the queue at task ID
  --only ID         run only task ID
  --dry-run         print the selected tasks and every command; no orch calls, no commits
  --help            this text

The queue stops (exit 1) on: a model fallback/mismatch, a forbidden path changed, a worker
stall, a task with no file changes, a failed commit, or two consecutive tasks with failing
checks. Every step is appended to <plan>/RUNLOG.md. Full manual: docs/QUEUE_DRIVER.md.
`;

/** A usage or configuration problem: the operator can fix it and restart (exit 2). */
export class QueueDriverError extends Error {}

/** A deliberate mid-queue stop (exit 1): model fallback, forbidden path, stall, no changes. */
export class QueueStopped extends Error {}

// ---------------------------------------------------------------- options ----

/**
 * Parse the driver's command line. Pure: no fs, no process access.
 * @param {string[]} argv
 * @returns {{wt:string|null, plan:string|null, model:string|null, cli:string, checksPath:string|null,
 *            forbid:RegExp[], stallMinutes:number, from:string|null, only:string|null,
 *            dryRun:boolean, help:boolean}}
 */
export function parseOptions(argv) {
  const opts = {
    wt: null, plan: null, model: null, cli: 'vibe', checksPath: null,
    forbid: [], stallMinutes: DEFAULT_STALL_MINUTES, from: null, only: null,
    dryRun: false, help: false,
  };
  /** @type {string[]} */
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--dry-run') { opts.dryRun = true; continue; }
    if (tok === '--help') { opts.help = true; continue; }
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(tok);
    if (!m) { errors.push(`unexpected argument: ${tok}`); continue; }
    const name = m[1];
    let value = m[2];
    if (value === undefined) value = argv[++i];
    if (value === undefined) { errors.push(`--${name} needs a value`); continue; }
    switch (name) {
      case 'wt': opts.wt = value; break;
      case 'plan': opts.plan = value; break;
      case 'model': opts.model = value; break;
      case 'cli': opts.cli = value; break;
      case 'checks': opts.checksPath = value; break;
      case 'forbid':
        try { opts.forbid.push(new RegExp(value)); }
        catch { errors.push(`--forbid is not a valid regular expression: ${value}`); }
        break;
      case 'stall-minutes': {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) errors.push(`--stall-minutes needs a positive number, got: ${value}`);
        else opts.stallMinutes = n;
        break;
      }
      case 'from': opts.from = value; break;
      case 'only': opts.only = value; break;
      case 'dry-run': opts.dryRun = value !== 'false'; break;
      case 'help': opts.help = true; break;
      default: errors.push(`unknown option: --${name}`);
    }
  }
  if (!opts.help) {
    if (!opts.wt) errors.push('--wt <path> is required: the worktree the tasks edit');
    if (!opts.plan) errors.push('--plan <dir> is required: the folder holding COMMON.md and TASKS.md');
    if (!SUPPORTED_CLIS.includes(opts.cli)) errors.push(`--cli ${opts.cli} is not supported (supported: ${SUPPORTED_CLIS.join(', ')})`);
  }
  if (errors.length) throw new QueueDriverError(errors.join('\n  '));
  return opts;
}

// ------------------------------------------------------------------ tasks ----

/**
 * Parse a plan's TASKS.md into its ordered task list. Pure.
 * A task section opens with a "##### <ID>" line (a single-token ID); the title comes
 * from its "TASK <ID>: <title>" line (the ID itself when absent), the test files from
 * its "TESTS: <paths>" line. "TESTS: (<anything>)" means the task has no test command.
 * Text before the first section (a heading, notes) is ignored.
 * @param {string} md
 * @returns {{id:string, title:string, body:string, tests:string[]}[]}
 */
export function parseTasks(md) {
  return md
    .split(/^##### /m)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const nl = s.indexOf('\n');
      return { id: (nl < 0 ? s : s.slice(0, nl)).trim(), body: nl < 0 ? '' : s.slice(nl + 1).trim() };
    })
    .filter((t) => t.id && !/\s/.test(t.id))
    .map((t) => {
      const testsLine = (t.body.match(/^TESTS: (.*)$/m) || [])[1] || '';
      const tests = testsLine.trim().startsWith('(') ? [] : testsLine.trim().split(/\s+/).filter(Boolean);
      const title = ((t.body.match(/^TASK [^:]+: (.*)$/m) || [])[1] || t.id).trim();
      return { id: t.id, title, body: t.body, tests };
    });
}

/**
 * The tasks a run will process: everything from --from (inclusive) on, or just --only.
 * Pure. An unknown --from/--only id yields an empty list (main rejects it earlier).
 * @param {{id:string, title:string, body:string, tests:string[]}[]} tasks
 * @param {string|null} from
 * @param {string|null} only
 * @returns {{id:string, title:string, body:string, tests:string[]}[]}
 */
export function selectTasks(tasks, from, only) {
  let started = !from;
  const out = [];
  for (const t of tasks) {
    if (only && t.id !== only) continue;
    if (!started) {
      if (t.id === from) started = true;
      else continue;
    }
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- checks ----

/**
 * Parse and validate the checks file (a JSON document). Pure.
 * Shape: {"test": ["cmd", "arg", ...], "extra": [["cmd", "arg"], ...],
 *         "cwd": "dir relative to the worktree", "env": {"KEY": "value"}}
 * "test" runs with the task's TESTS paths appended; every "extra" command runs for
 * every task. All keys are optional; unknown keys are rejected.
 * @param {string} text
 * @param {string} [source] where the text came from, for error messages
 * @returns {{test:string[]|null, extra:string[][], cwd:string, env:Record<string,string>}}
 */
export function parseChecks(text, source = 'checks file') {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { throw new QueueDriverError(`${source} is not valid JSON: ${e && e.message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new QueueDriverError(`${source} must be a JSON object`);
  const cmd = (v, what) => {
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string'))
      throw new QueueDriverError(`${source}: "${what}" must be a non-empty array of strings`);
    return v.slice();
  };
  /** @type {{test:string[]|null, extra:string[][], cwd:string, env:Record<string,string>}} */
  const checks = { test: null, extra: [], cwd: '.', env: {} };
  if (raw.test !== undefined) checks.test = cmd(raw.test, 'test');
  if (raw.extra !== undefined) {
    if (!Array.isArray(raw.extra)) throw new QueueDriverError(`${source}: "extra" must be an array of commands`);
    checks.extra = raw.extra.map((c, i) => cmd(c, `extra[${i}]`));
  }
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string' || !raw.cwd.trim()) throw new QueueDriverError(`${source}: "cwd" must be a non-empty string relative to the worktree`);
    checks.cwd = raw.cwd;
  }
  if (raw.env !== undefined) {
    if (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env) || Object.values(raw.env).some((v) => typeof v !== 'string'))
      throw new QueueDriverError(`${source}: "env" must map names to string values`);
    checks.env = { ...raw.env };
  }
  const unknown = Object.keys(raw).filter((k) => !['test', 'extra', 'cwd', 'env'].includes(k));
  if (unknown.length) throw new QueueDriverError(`${source}: unknown key(s): ${unknown.join(', ')}`);
  return checks;
}

/**
 * The check commands for one task: the "test" command with the task's TESTS paths
 * appended (when it lists any), then every "extra" command. Pure.
 * @param {{test:string[]|null, extra:string[][], cwd:string, env:Record<string,string>}|null} checks
 * @param {string[]} tests the task's TESTS paths
 * @returns {{label:string, argv:string[]}[]}
 */
export function buildChecksCommands(checks, tests) {
  if (!checks) return [];
  const cmds = [];
  if (tests.length) {
    if (!checks.test) throw new QueueDriverError('the checks file defines no "test" command but the task lists TESTS paths');
    cmds.push({ label: [...checks.test, ...tests].join(' '), argv: [...checks.test, ...tests] });
  }
  for (const extra of checks.extra) cmds.push({ label: extra.join(' '), argv: extra.slice() });
  return cmds;
}

// ----------------------------------------------------------- changed paths ----

/**
 * Repo-relative paths from `git status --porcelain --untracked-files=all` output, with
 * the driver's own bookkeeping excluded: .vibe/ (the worker's session files) and the
 * plan folder (COMMON.md / TASKS.md / RUNLOG.md). Pure.
 * @param {string} porcelain
 * @param {string} planRel the plan folder relative to the worktree, forward slashes ('' or '.' excludes nothing)
 * @returns {string[]}
 */
export function filterChangedPaths(porcelain, planRel) {
  const prefix = planRel && planRel !== '.' ? planRel.replace(/\/+$/, '') + '/' : null;
  return String(porcelain)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop())
    .filter((p) => p && !p.startsWith('.vibe/') && !(prefix && p.startsWith(prefix)));
}

/**
 * The paths matching any forbidden regex; a non-empty result stops the queue. Pure.
 * @param {string[]} paths
 * @param {RegExp[]} forbid
 * @returns {string[]}
 */
export function matchForbidden(paths, forbid) {
  return paths.filter((p) => forbid.some((re) => re.test(p)));
}

// ------------------------------------------------------------------- main ----

/**
 * Run the driver. `deps.spawnSync` (a fake in tests) backs every child process; every
 * printed line goes to `deps.out`. Throws QueueDriverError for operator errors (exit 2)
 * and QueueStopped when the queue stops itself (exit 1).
 * @param {string[]} argv
 * @param {{spawnSync?: Function, out?: Function}} [deps]
 * @returns {Promise<number>} the process exit code (0)
 */
export async function main(argv, deps = {}) {
  // A MISTRAL_API_KEY in the environment makes vibe bill that API key instead of the
  // vibe CLI's own plan allowance; the driver's workers must use the CLI allowance.
  delete process.env.MISTRAL_API_KEY;
  const spawn = deps.spawnSync || spawnSync;
  const out = deps.out || ((s) => process.stdout.write(s + '\n'));
  const opts = parseOptions(argv);
  if (opts.help) { out(USAGE); return 0; }

  const wt = path.resolve(opts.wt);
  const plan = path.isAbsolute(opts.plan) ? path.resolve(opts.plan) : path.resolve(wt, opts.plan);
  if (!fs.existsSync(ORCH)) throw new QueueDriverError(`orch CLI not found at ${ORCH}`);
  if (!fs.existsSync(wt) || !fs.statSync(wt).isDirectory()) throw new QueueDriverError(`--wt is not a directory: ${wt}`);
  const tasksPath = path.join(plan, 'TASKS.md');
  const commonPath = path.join(plan, 'COMMON.md');
  if (!fs.existsSync(tasksPath)) throw new QueueDriverError(`--plan has no TASKS.md: ${plan}`);
  if (!fs.existsSync(commonPath)) throw new QueueDriverError(`--plan has no COMMON.md: ${plan}`);
  const common = fs.readFileSync(commonPath, 'utf8');
  const tasks = parseTasks(fs.readFileSync(tasksPath, 'utf8'));
  if (!tasks.length) throw new QueueDriverError(`no "##### <ID>" task sections found in ${tasksPath}`);
  for (const [flag, id] of [['--from', opts.from], ['--only', opts.only]]) {
    if (id && !tasks.some((t) => t.id === id))
      throw new QueueDriverError(`${flag} ${id}: no such task in TASKS.md (tasks: ${tasks.map((t) => t.id).join(', ')})`);
  }
  const selected = selectTasks(tasks, opts.from, opts.only);
  const checks = opts.checksPath
    ? parseChecks(fs.readFileSync(path.resolve(opts.checksPath), 'utf8'), `--checks file ${opts.checksPath}`)
    : null;
  for (const t of selected) {
    if (t.tests.length && checks && !checks.test)
      throw new QueueDriverError(`the checks file defines no "test" command but task ${t.id} lists TESTS paths`);
  }
  // --model > ORCH_QUEUE_MODEL > "queueDriver.model" in orch.config.json; no built-in default.
  opts.model = opts.model || setting('ORCH_QUEUE_MODEL', 'queueDriver.model', null);
  if (!opts.model)
    throw new QueueDriverError('no worker model: pass --model <id>, or set ORCH_QUEUE_MODEL or "queueDriver.model" in orch.config.json');
  // Handoff files: ORCH_QUEUE_HANDOFF_DIR > "queueDriver.handoffDir" > <state root>/queue-handoffs
  // (inside orch's git-ignored state root by default, never inside the worktree).
  const handoffDir = setting('ORCH_QUEUE_HANDOFF_DIR', 'queueDriver.handoffDir', () => path.join(resolveStateRoot(), 'queue-handoffs'), { isPath: true });

  const stallSeconds = opts.stallMinutes * 60;
  const planRel = path.relative(wt, plan).split(path.sep).join('/');
  const vibeLog = path.join(vibeLogDir(), 'vibe.log'); // ORCH_VIBE_LOG_DIR / "vibeLogDir" / ~/.vibe/logs
  const runlog = path.join(plan, 'RUNLOG.md');
  const checkCwd = path.join(wt, checks ? checks.cwd : '.');
  const checkEnv = { ...process.env, ...(checks ? checks.env : {}) };

  /** @param {string} file @param {string[]} argv @param {object} [shOpts] */
  const sh = (file, argv, shOpts = {}) => {
    const r = spawn(file, argv, { cwd: wt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...shOpts });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const git = (...a) => sh('git', a);
  const orch = (...a) => sh(process.execPath, [ORCH, ...a]);
  const log = (md) => { fs.appendFileSync(runlog, md + '\n'); out(md); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => new Date().toISOString();
  const ascii = (s) => s.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?');
  const tail = (s, n) => String(s).split(/\r?\n/).slice(-n).join('\n');
  const changedPaths = () => filterChangedPaths(git('status', '--porcelain', '--untracked-files=all').out, planRel);
  const runChecks = (tests) => {
    const cmds = buildChecksCommands(checks, tests);
    const parts = [];
    let pass = true;
    for (const c of cmds) {
      const r = sh(c.argv[0], c.argv.slice(1), { cwd: checkCwd, env: checkEnv });
      pass &&= r.code === 0;
      parts.push(`${c.label} -> exit ${r.code}\n${tail(r.out, 25)}`);
    }
    return { pass, text: parts.join('\n\n') || '(no checks configured)', labels: cmds.map((c) => c.label) };
  };
  /** @param {string} id @param {string} label */
  const orchRunArgv = (id, label) => ['run', '--cli', opts.cli, '--model', opts.model, '--dir', wt,
    '--handoff', path.join(handoffDir, `handoff-${id}-${label}.md`), '--no-window', '--json'];

  if (opts.dryRun) {
    out('queue-driver dry run - nothing below is executed');
    out(`wt: ${wt}`);
    out(`plan: ${plan}`);
    out(`cli: ${opts.cli}  model: ${opts.model}  stall: ${opts.stallMinutes} min  poll: ${POLL_SECONDS}s`);
    out(`checks: ${checks ? path.resolve(opts.checksPath) + ` (cwd ${checks.cwd})` : '(none - tasks will not be verified)'}`);
    out(`forbid: ${opts.forbid.map((re) => re.source).join(', ') || '(none)'}`);
    out(`tasks (${selected.length} of ${tasks.length}):`);
    for (const t of selected) {
      out(`  ${t.id}  ${t.title}`);
      out(`    tests: ${t.tests.join(' ') || '(none)'}`);
      out(`    run:   orch ${orchRunArgv(t.id, 'a1').join(' ')}`);
      const cmds = buildChecksCommands(checks, t.tests);
      if (cmds.length) {
        out(`    checks (cwd ${checkCwd}):`);
        for (const c of cmds) out(`      ${c.label}`);
      } else out('    checks: (none)');
      out(`    commit: git add -A -- . ':(exclude).vibe' then git commit -m "feat(${t.id}): ${t.title}"`);
      out('    repair: one more round of the same run + checks if the worker fails or checks fail');
    }
    return 0;
  }

  /** One worker run: launch, poll `orch status`, detect fallback and stall. */
  async function runWorker(id, handoffText, label) {
    const hf = path.join(handoffDir, `handoff-${id}-${label}.md`);
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(hf, ascii(handoffText), 'utf8');
    const started = new Date();
    const r = orch(...orchRunArgv(id, label));
    let runId;
    try { runId = JSON.parse(r.out.slice(r.out.indexOf('{'))).id; }
    catch { return { ok: false, why: 'launch-failed: ' + tail(r.out, 5) }; }
    for (;;) {
      await sleep(POLL_SECONDS * 1000);
      const s = orch('status', runId, '--json');
      let st;
      try { st = JSON.parse(s.out.slice(s.out.indexOf('{'))).runs[0]; }
      catch { continue; }
      if (st.status === 'completed' || st.status === 'failed') {
        const res = orch('result', runId);
        const fb = fs.existsSync(vibeLog) ? fs.readFileSync(vibeLog, 'utf8').split(/\r?\n/)
          .filter((l) => l.includes('falling back') && new Date(l.slice(0, 32)) >= started) : [];
        return {
          ok: st.status === 'completed',
          runId,
          status: `${st.status} (${st.reason})`,
          fallback: st.model_mismatch === true || (st.model_actual == null && fb.length > 0),
          result: res.out,
        };
      }
      if (st.quiet_seconds > stallSeconds) {
        orch('cancel', runId);
        return { ok: false, runId, status: `stalled ${st.quiet_seconds}s, cancelled`, stall: true, result: '' };
      }
    }
  }

  log(`\n## Queue started ${now()} (cli ${opts.cli}, model ${opts.model})\n`);
  let consecutiveFailures = 0;
  for (const t of selected) {
    log(`### ${t.id} - ${t.title}\nstart ${now()}`);
    let w = await runWorker(t.id, common + '\n' + t.body + '\n', 'a1');
    /** @param {string} why */
    const stop = (why) => { log(`**QUEUE STOPPED at ${t.id}: ${why}** ${now()}`); throw new QueueStopped(`${t.id}: ${why}`); };
    if (w.fallback) stop(`${opts.cli} fell back to another model (see vibe.log)`);
    if (w.stall) stop(`worker stalled (run ${w.runId})`);
    let bad = matchForbidden(changedPaths(), opts.forbid);
    if (bad.length) stop(`forbidden paths changed, left uncommitted: ${bad.join(', ')}`);
    let c = runChecks(t.tests);
    let repaired = false;
    if (!c.pass || !w.ok) {
      log(`checks after attempt 1: ${c.pass ? 'PASS' : 'FAIL'}; worker ${w.status || w.why || 'failed'}; repair attempt starting`);
      const repair = common + '\n' + t.body + '\n\nREPAIR ROUND: a previous attempt at this task already edited the files (see git diff). '
        + 'Finish the task and make these checks pass. Check output:\n' + c.text + '\n';
      w = await runWorker(t.id, repair, 'a2');
      if (w.fallback) stop(`${opts.cli} fell back to another model (see vibe.log)`);
      if (w.stall) stop(`worker stalled in repair (run ${w.runId})`);
      bad = matchForbidden(changedPaths(), opts.forbid);
      if (bad.length) stop(`forbidden paths changed, left uncommitted: ${bad.join(', ')}`);
      c = runChecks(t.tests);
      repaired = true;
    }
    const paths = changedPaths();
    const report = tail(ascii(w.result || ''), 60);
    log(`worker: ${w.status || w.why || 'failed'} run ${w.runId || '-'}${repaired ? ' (after repair)' : ''}\nchecks: **${c.pass ? 'PASS' : 'FAIL'}**\nfiles: ${paths.join(', ') || '(none)'}\n\n<details><summary>checks</summary>\n\n\`\`\`\n${c.text}\n\`\`\`\n</details>\n<details><summary>worker report (tail)</summary>\n\n\`\`\`\n${report}\n\`\`\`\n</details>\n`);
    if (!paths.length) stop('task produced no file changes; later tasks depend on it');
    git('add', '-A', '--', '.', ':(exclude).vibe');
    const msg = `feat(${t.id}): ${t.title}\n\nUnattended ${opts.cli}/${opts.model} run ${w.runId}; unreviewed.\nChecks: ${c.pass ? 'PASS' : 'FAIL'}${c.labels.length ? ` (${c.labels.join('; ')})` : ' (no checks configured)'}`;
    const cm = git('commit', '-q', '-m', msg);
    log(cm.code === 0 ? `committed ${git('rev-parse', '--short', 'HEAD').out.trim()}` : `COMMIT FAILED: ${tail(cm.out, 5)}`);
    if (cm.code !== 0) stop('git commit failed');
    consecutiveFailures = c.pass ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= 2) stop('two consecutive tasks ended with failing checks or no changes');
  }
  log(`\n## Queue finished ${now()}\n`);
  return 0;
}

// Only run the queue when executed directly; importing the module gives the helpers.
const invokedDirectly = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { if (typeof code === 'number' && code !== 0) process.exitCode = code; })
    .catch((e) => {
      if (e instanceof QueueStopped) {
        process.exitCode = 1; // the reason is already in RUNLOG.md and on stdout
      } else if (e instanceof QueueDriverError) {
        process.stderr.write(`queue-driver: ${e.message}\n\n${USAGE}\n`);
        process.exitCode = 2;
      } else {
        process.stderr.write(`queue-driver: unexpected error: ${(e && e.stack) || e}\n`);
        process.exitCode = 1;
      }
    });
}
