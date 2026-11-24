// Runs an item's acceptance commands in its worktree: argv only (never a shell), a bounded
// time, output captured to a log file with a size cap. A command that exits 0 passes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

import { safeEnv } from './env.mjs';
import { gitSafe } from './git.mjs';

export { safeEnv };

/**
 * Resolve a bare program name through PATH, never through the worktree: on Windows a process is
 * also looked up in the current directory, so a file the worker planted there would otherwise
 * win. A name with a path separator must stay inside the worktree. What the worker may have put
 * there is bounded before anything runs: orch's scope guard covers tracked and untracked files, and
 * `ignoredOutsideAllowlist` (below) covers git-ignored files, which that guard does not see.
 */
export function resolveExecutable(name, root, env = process.env) {
  if (/[\\/]/.test(name)) {
    const full = path.resolve(root, name);
    return insideRoot(root, full) ? full : null;
  }
  // On Windows the executable extensions come first: `npm` is also a shell script without an extension in the same
  // folder as `npm.cmd`, and that script cannot be started.
  const exts = process.platform === 'win32' ? [...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), ''] : [''];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    if (insideRoot(root, path.resolve(dir))) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

function insideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * What to execute for a resolved program. On Windows a `.cmd` or `.bat` file cannot be started without a shell
 * (Node refuses, and a shell would bring argument-injection with it), so `npm` and `npx` are started the way their
 * own launcher does, as `node <npm>/bin/npm-cli.js`; any other batch file is an error that names the way out.
 * @returns {{program: string, args: string[]} | {error: string}}
 */
export function launchPlan(program, args) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(program)) return { program, args };
  const base = path.basename(program).replace(/\.(cmd|bat)$/i, '').toLowerCase();
  const dir = path.dirname(program);
  if (base === 'npm' || base === 'npx') {
    const script = path.join(dir, 'node_modules', 'npm', 'bin', `${base}-cli.js`);
    const node = fs.existsSync(path.join(dir, 'node.exe')) ? path.join(dir, 'node.exe') : process.execPath;
    if (fs.existsSync(script)) return { program: node, args: [script, ...args] };
  }
  return { error: `${path.basename(program)} is a batch file, which cannot be started without a shell; use the program it wraps, for example ["node", "<path to its script>", ...]` };
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * @param {{kind:string, argv?:string[], cwd?:string, timeout_s?:number, text?:string}} check
 * @param {{root:string, logFile:string, defaultTimeoutS:number, maxLogBytes:number, env?: NodeJS.ProcessEnv}} o
 */
export function runCheck(check, { root, logFile, defaultTimeoutS, maxLogBytes, env }) {
  if (check.kind === 'rubric') return Promise.resolve({ status: 'needs-judgement', kind: 'rubric', text: check.text });
  const cwd = path.resolve(root, check.cwd || '.');
  if (!insideRoot(root, cwd)) return Promise.resolve({ status: 'error', kind: check.kind, argv: check.argv, error: 'cwd leaves the worktree' });
  const resolved = resolveExecutable(check.argv[0], root);
  if (!resolved) return Promise.resolve({ status: 'error', kind: check.kind, argv: check.argv, error: `cannot find ${check.argv[0]} on PATH (the worktree is never searched)` });
  const plan = launchPlan(resolved, check.argv.slice(1));
  if ('error' in plan) return Promise.resolve({ status: 'error', kind: check.kind, argv: check.argv, error: plan.error });
  const { program, args: programArgs } = plan;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.createWriteStream(logFile, { flags: 'w' });
  const started = Date.now();
  const timeoutMs = (check.timeout_s || defaultTimeoutS) * 1000;
  return new Promise((resolve) => {
    let written = 0;
    let finished = false;
    let timedOut = false;
    let child;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      out.end();
      resolve({ kind: check.kind, argv: check.argv, ms: Date.now() - started, log: logFile, ...result });
    };
    const sink = (chunk) => {
      if (written < maxLogBytes) {
        const room = maxLogBytes - written;
        out.write(chunk.length > room ? chunk.subarray(0, room) : chunk);
      }
      written += chunk.length;
    };
    try {
      child = spawn(program, programArgs, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: env || safeEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ status: 'error', error: String(error.message || error) });
      return;
    }
    child.stdout?.on('data', sink);
    child.stderr?.on('data', sink);
    child.on('error', (error) => finish({ status: 'error', error: String(error.message || error) }));
    child.on('close', (code, signal) => {
      if (timedOut) finish({ status: 'timeout', exit_code: null, signal });
      else finish({ status: code === 0 ? 'pass' : 'fail', exit_code: code, signal });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    timer.unref?.();
  });
}

/** Run every check in order and stop at the first failure (later checks would only repeat it). */
export async function runAcceptance(checks, options, prefix) {
  const results = [];
  for (let i = 0; i < checks.length; i++) {
    const logFile = path.join(options.logDir, `${prefix}-${i + 1}.log`);
    const result = await runCheck(checks[i], { root: options.root, logFile, defaultTimeoutS: options.defaultTimeoutS, maxLogBytes: options.maxLogBytes });
    results.push({ index: i + 1, ...result });
    if (['fail', 'timeout', 'error'].includes(result.status)) break;
  }
  return results;
}

/** The last lines of a log file, for a park reason. */
export function tailOf(file, maxChars = 800) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > maxChars ? '...' + text.slice(-maxChars) : text;
  } catch {
    return '';
  }
}

/** Does `file` fall under an allowlist entry (an exact path, or a directory prefix)? */
export function underAllowlist(file, allowlist) {
  const f = file.replace(/\\/g, '/');
  return allowlist.some((entry) => {
    const e = String(entry).replace(/\\/g, '/').replace(/^\.\//, '');
    return f === e || f.startsWith(e.endsWith('/') ? e : e + '/');
  });
}

function fileDigest(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const EXTERNAL_MAX_ENTRIES = 20000;

/**
 * A digest of a directory tree (or a single file) that a baseline entry depends on: names, symlink texts, sizes and
 * contents. Nested symlinks are recorded by their text, not followed. Spends the shared hashing budget; null when the
 * target has too many entries, is too big for what is left of the budget, or cannot be read (so it cannot be verified).
 * @param {string} target
 * @param {{left: number}} ctx
 */
function treeDigest(target, ctx) {
  const hash = crypto.createHash('sha256');
  let entries = 0;
  const walk = (p, name) => {
    if (++entries > EXTERNAL_MAX_ENTRIES) return false;
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { hash.update(`L${name}\0${fs.readlinkSync(p)}\0`); return true; }
    if (st.isDirectory()) {
      hash.update(`D${name}\0`);
      for (const entry of fs.readdirSync(p).sort()) if (!walk(path.join(p, entry), `${name}/${entry}`)) return false;
      return true;
    }
    if (st.isFile()) {
      if (st.size > ctx.left) return false;
      ctx.left -= st.size;
      hash.update(`F${name}\0${st.size}\0${fileDigest(p)}\0`);
      return true;
    }
    return false; // a socket, device or pipe: not something a baseline can vouch for
  };
  try {
    return walk(target, '') ? hash.digest('hex') : null;
  } catch {
    return null;
  }
}

/**
 * A comparable signature of one entry under `dir`, or null when it cannot be vouched for (a special file, or something
 * too big or too deep to hash within the budget). A regular file is its size and SHA-256; a symlink is its text plus, when
 * it resolves outside the worktree, a digest of what it points at (a venv's `python` links to a shared interpreter, and
 * an acceptance command would run it); a directory entry (a nested repository, for instance) is a digest of its tree.
 * `expected` is the baseline's signature: a size that no longer matches is reported without reading the file.
 * @param {string} dir
 * @param {string} rel
 * @param {{root: string, left: number}} ctx `root` is the real path of `dir`; `left` is the remaining hashing budget in bytes
 * @param {string} [expected]
 * @returns {string | null}
 */
function signatureOf(dir, rel, ctx, expected) {
  const full = path.join(dir, rel);
  let st;
  try {
    st = fs.lstatSync(full);
  } catch {
    return 'missing';
  }
  if (st.isSymbolicLink()) {
    const text = `link:${fs.readlinkSync(full)}`;
    let real;
    try {
      real = fs.realpathSync(full);
    } catch {
      return `${text}|dangling`;
    }
    if (insideRoot(ctx.root, real)) return text; // what it points at is itself an entry that is checked (ignored) or watched (tracked)
    const digest = treeDigest(real, ctx);
    return digest ? `${text}|outside:${digest}` : null;
  }
  if (st.isFile()) {
    const recorded = expected === undefined ? null : /^(\d+):/.exec(expected);
    if (recorded && Number(recorded[1]) !== st.size) return `${st.size}:resized`; // changed; no need to read it
    if (st.size > ctx.left) return null;
    ctx.left -= st.size;
    return `${st.size}:${fileDigest(full)}`;
  }
  if (st.isDirectory()) {
    const digest = treeDigest(full, ctx);
    return digest ? `dir:${digest}` : null;
  }
  return null;
}

function hashingContext(dir, left) {
  let root = dir;
  try { root = fs.realpathSync(dir); } catch { /* use the path as given */ }
  return { root, left };
}

/**
 * The git-ignored files a worktree holds right now, each with a signature (size and sha-256, or a symlink's target).
 * Taken after a project's setup command ran: the setup legitimately creates ignored files (`node_modules`, a venv),
 * and `ignoredOutsideAllowlist` then treats exactly those, unchanged, as the baseline. Bounded, so a runaway setup
 * output is refused rather than hashed for minutes.
 * @returns {{ok: boolean, error?: string, files?: Record<string, string>, count?: number, bytes?: number}} `files`, `count` and `bytes` are set when `ok`, `error` when not
 */
export function snapshotIgnored(dir, { maxFiles = 200000, maxBytes = 4 * 1024 ** 3 } = {}) {
  const r = gitSafe(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false, error: `git could not list ignored files (${r.error?.message || r.stderr?.slice(0, 200) || 'exit ' + r.status})` };
  const names = r.stdout.split('\0').filter(Boolean);
  if (names.length > maxFiles) return { ok: false, error: `setup left ${names.length} ignored files (the limit is ${maxFiles})` };
  /** @type {Record<string, string>} */
  const files = Object.create(null);
  const ctx = hashingContext(dir, maxBytes);
  for (const name of names) {
    const sig = signatureOf(dir, name, ctx);
    if (sig === null) return { ok: false, error: `setup left "${name}", which cannot be recorded (a special file, or more than ${Math.round(maxBytes / 1024 ** 3)} GiB or ${EXTERNAL_MAX_ENTRIES} entries to hash)` };
    files[name] = sig;
  }
  return { ok: true, files, count: names.length, bytes: maxBytes - ctx.left };
}

/**
 * Git-ignored files in a worktree that are not covered by the item's allowlist or by the
 * tolerated cache directories. A freshly created worktree has none, so anything here was made by
 * the worker, and the scope guard (tracked and untracked files only) cannot see it. Acceptance
 * commands execute worker-written code, so this is checked before any of them runs.
 *
 * `baseline` (from `snapshotIgnored`, taken right after the project's setup command) names the ignored files that
 * setup made. Those are accepted only while they are byte-for-byte what setup left: a new file, or a changed one,
 * is still offending, so a worker cannot hide code inside `node_modules`.
 */
export function ignoredOutsideAllowlist(dir, allowlist, tolerated = [], baseline = null, { maxBytes = 4 * 1024 ** 3 } = {}) {
  const ctx = hashingContext(dir, maxBytes); // one budget for everything hashed in this check
  const r = gitSafe(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { timeout: 30000, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false, error: `git could not list ignored files (${r.error?.message || r.stderr?.slice(0, 200) || 'exit ' + r.status})`, offending: [] };
  const files = r.stdout.split('\0').filter(Boolean);
  // Tolerated cache directories count only at the worktree root: a `.cache` folder deeper down
  // could hide code, and a nested one the item really needs can be named in its allowlist.
  const offending = files.filter((f) => {
    if (underAllowlist(f, allowlist) || tolerated.some((t) => underAllowlist(f, [t]))) return false;
    if (baseline && Object.hasOwn(baseline, f)) {
      const sig = signatureOf(dir, f, ctx, baseline[f]);
      return sig === null || sig !== baseline[f]; // what cannot be verified is not accepted
    }
    return true;
  });
  return { ok: true, error: null, offending };
}
