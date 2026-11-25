// Runs an item's acceptance commands in its worktree: argv only (never a shell), a bounded
// time, output captured to a log file with a size cap. A command that exits 0 passes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

import { safeEnv } from './env.mjs';
import { gitSafe, openInspection } from './git.mjs';

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
 * A digest of a directory tree (or a single file) that a baseline entry depends on: names, sizes and contents, with every
 * symlink inside it followed and digested too (its text, then what it resolves to), so nothing a link leads to can change
 * unseen. A target is digested once per check (`ctx.cache`, by real path) and a loop is cut by `visited`. Spends the shared
 * hashing budget; null when the tree has too many entries, is too big for what is left of the budget, or cannot be read
 * (so it cannot be verified).
 * @param {string} target a real path
 * @param {{left: number, entriesLeft: number, cache: Map<string, string | null>}} ctx
 * @param {Set<string>} [visited]
 * @returns {string | null}
 */
function treeDigest(target, ctx, visited = new Set()) {
  if (ctx.cache.has(target)) return ctx.cache.get(target) ?? null;
  visited.add(target);
  const hash = crypto.createHash('sha256');
  let entries = 0;
  const walk = (p, name) => {
    if (++entries > EXTERNAL_MAX_ENTRIES || --ctx.entriesLeft < 0) return false;
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
      hash.update(`L${name}\0${fs.readlinkSync(p)}\0`);
      let real;
      try {
        real = fs.realpathSync(p);
      } catch {
        hash.update('dangling\0');
        return true;
      }
      if (visited.has(real)) { hash.update('loop\0'); return true; } // already being digested further up
      const inner = treeDigest(real, ctx, visited);
      if (!inner) return false;
      hash.update(`${inner}\0`);
      return true;
    }
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
  let digest = null;
  try {
    digest = walk(target, '') ? hash.digest('hex') : null;
  } catch {
    digest = null;
  }
  visited.delete(target);
  ctx.cache.set(target, digest);
  return digest;
}

/**
 * A comparable signature of one entry under `dir`, or null when it cannot be vouched for (a special file, or something
 * too big or too deep to hash within the budget). A regular file is its size and SHA-256; a symlink is its text plus, when
 * it resolves outside the worktree, a digest of what it points at (a venv's `python` links to a shared interpreter, and
 * an acceptance command would run it); a directory entry (a nested repository, for instance) is a digest of its tree.
 * `expected` is the baseline's signature: a size that no longer matches is reported without reading the file.
 * @param {string} dir
 * @param {string} rel
 * @param {{root: string, left: number, entriesLeft: number, cache: Map<string, string | null>}} ctx from `hashingContext`: `left` is the remaining hashing budget in bytes
 * @param {string} [expected]
 * @returns {string | null}
 */
export function signatureOf(dir, rel, ctx, expected) {
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
    // Always digest what it resolves to, inside the worktree or not: an in-tree target is not necessarily checked by anything
    // else (a tolerated cache directory, an allowlisted path and `.git` are all skipped by the ignored-file check).
    const digest = treeDigest(real, ctx);
    return digest ? `${text}|to:${digest}` : null;
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

/** The state one check or snapshot shares: the hashing budget, an entry budget and the digests already computed. */
export function hashingContext(dir, left) {
  let root = dir;
  try { root = fs.realpathSync(dir); } catch { /* use the path as given */ }
  return { root, left, entriesLeft: 400000, cache: new Map() };
}

const IGNORED_BUFFER = 256 * 1024 * 1024;

function gitFailure(action, r) {
  return `git could not ${action} (${r.error?.message || r.stderr?.slice(0, 200) || 'exit ' + r.status})`;
}

function listIgnored(dir, timeout) {
  const r = gitSafe(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { timeout, maxBuffer: IGNORED_BUFFER });
  return r.status === 0
    ? { files: r.stdout.split('\0').filter(Boolean), error: null }
    : { files: [], error: gitFailure('list ignored files', r) };
}

function worktreePath(root, real) {
  const rel = path.relative(root, real).split(path.sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  // Repository metadata is not covered by the scope guard.
  return rel.split('/').some((part) => part.toLowerCase() === '.git') ? null : rel;
}

function gitQuoted(name) {
  // check-ignore quotes control characters, quotes and backslashes even with core.quotePath=false.
  const escapes = { '\x07': 'a', '\b': 'b', '\t': 't', '\n': 'n', '\v': 'v', '\f': 'f', '\r': 'r', '"': '"', '\\': '\\' };
  const quoted = name.replace(/[\x01-\x1f\x7f"\\]/g, (c) => '\\' + (escapes[c] ?? c.charCodeAt(0).toString(8).padStart(3, '0')));
  return quoted === name ? name : '"' + quoted + '"';
}

/** Resolve a directory once, then inspect each child at its resolved parent for additional links. */
function workspaceAliases(dir, root, files) {
  const directories = new Map([['.', root]]);
  const inspect = (full) => {
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isSymbolicLink()) return { real: full, directory: stat.isDirectory() };
      const real = fs.realpathSync.native(full);
      return { real, directory: fs.lstatSync(real).isDirectory() };
    } catch {
      return null; // An unresolved path must still go through the ignored-file check.
    }
  };
  const resolveDirectory = (name) => {
    if (directories.has(name)) return directories.get(name);
    const parent = resolveDirectory(path.posix.dirname(name));
    const real = parent && inspect(path.join(parent, path.posix.basename(name)))?.real;
    directories.set(name, real);
    return real;
  };

  const aliases = new Map();
  for (const file of files) {
    const name = file.replace(/\/$/, '');
    const parent = resolveDirectory(path.posix.dirname(name));
    const entry = parent && inspect(path.join(parent, path.posix.basename(name)));
    if (!entry || path.relative(path.join(root, name), entry.real) === '') continue;
    const target = worktreePath(root, entry.real);
    if (target) {
      // A directory-only ignore rule also applies to the target of a directory link.
      // Prefix with ./ so Git treats a leading colon as part of the filename.
      const key = './' + target + (entry.directory ? '/' : '');
      if (!aliases.has(key)) aliases.set(key, []);
      aliases.get(key).push(file);
    }
  }
  if (!aliases.size) return { skipped: new Set(), error: null };

  const inspection = openInspection(dir);
  if ('error' in inspection) return { skipped: new Set(), error: inspection.error };
  const ignored = new Set();
  try {
    let batch = [];
    let length = 0;
    const checkBatch = () => {
      const r = inspection.run(['-c', 'core.quotePath=false', 'check-ignore', '--', ...batch], { timeout: 30000 });
      if (r.status !== 0 && r.status !== 1) return gitFailure('check linked targets', r);
      const queried = new Set(batch.map(gitQuoted));
      for (const name of r.stdout.split('\n').filter(Boolean)) {
        if (!queried.has(name)) return 'git returned an unexpected path while checking linked targets';
        ignored.add(name);
      }
      return null;
    };
    for (const target of aliases.keys()) {
      // Leave room for command-line quoting and Git's own arguments on Windows.
      const size = Buffer.byteLength(target) + 3;
      if (length + size > 12000 && batch.length) {
        const error = checkBatch();
        if (error) return { skipped: new Set(), error };
        batch = [];
        length = 0;
      }
      batch.push(target);
      length += size;
    }
    if (batch.length) {
      const error = checkBatch();
      if (error) return { skipped: new Set(), error };
    }
  } finally {
    inspection.close();
  }
  const skipped = new Set();
  for (const [target, names] of aliases) {
    if (!ignored.has(gitQuoted(target))) for (const name of names) skipped.add(name);
  }
  return { skipped, error: null };
}

/** Remove ignored worker caches, keeping setup's unchanged files and refusing unsafe paths. */
export function purgeIgnored(dir, patterns, baseline = null, { maxBytes = 4 * 1024 ** 3 } = {}) {
  const result = { count: 0, bytes: 0, paths: [], offending: [], error: null };
  if (!patterns.length) return result;
  const { files, error } = listIgnored(dir, 30000);
  if (error) return { ...result, error };
  const ctx = hashingContext(dir, maxBytes);
  const ignored = new Set(files);
  const removals = new Map();
  const emptyDirs = new Set();
  const matching = patterns.filter(Boolean).map((pattern) => pattern.replace(/\\/g, '/'));
  const unchanged = (name) => {
    if (!baseline || !Object.hasOwn(baseline, name)) return false;
    const sig = signatureOf(dir, name, ctx, baseline[name]);
    if (sig === null) throw new Error('cannot verify the setup file before purging');
    return sig === baseline[name];
  };

  for (const name of files) {
    const rel = name.replace(/\/$/, '');
    const parents = '/' + path.posix.dirname(rel) + '/';
    const basename = path.posix.basename(rel);
    const matches = (directory) => matching.some((p) => p.endsWith('/')
      ? parents.includes('/' + p) || (directory && ('/' + rel + '/').endsWith('/' + p))
      : basename === p);
    if (!matches(true)) continue;

    const full = path.join(dir, rel);
    try {
      const st = fs.lstatSync(full);
      if (!matches(st.isDirectory() || (st.isSymbolicLink() && fs.statSync(full).isDirectory()))) continue;
      const real = fs.realpathSync.native(full);
      const realParent = fs.realpathSync.native(path.dirname(full));
      // Unlinking a symlink removes the link entry. For a file below a junction,
      // require Git to have listed the physical entry itself as ignored.
      const entry = worktreePath(ctx.root, path.join(realParent, basename));
      if (!worktreePath(ctx.root, real) || !entry) {
        result.offending.push(name);
        continue;
      }
      if (!ignored.has(entry) && !ignored.has(entry + '/')) continue;
      if (unchanged(name) || (entry !== name && unchanged(entry))) continue;
      if (st.isFile() || st.isSymbolicLink()) removals.set(entry, { name, size: st.size });
      else result.offending.push(name);
    } catch {
      result.offending.push(name);
    }
  }
  for (const [entry, { name, size }] of removals) {
    const full = path.join(ctx.root, entry);
    try {
      const parent = path.dirname(full);
      if (path.relative(parent, fs.realpathSync.native(parent)) !== '' ||
          !worktreePath(ctx.root, fs.realpathSync.native(full))) {
        result.offending.push(name);
        continue;
      }
      fs.unlinkSync(full);
      result.count++;
      result.bytes += size;
      if (result.paths.length < 50) result.paths.push(entry);
      emptyDirs.add(parent);
    } catch {
      result.offending.push(name);
    }
  }
  for (const parent of emptyDirs) {
    for (let dir = parent; worktreePath(ctx.root, dir); dir = path.dirname(dir)) {
      try {
        if (path.relative(dir, fs.realpathSync.native(dir)) !== '') break;
        fs.rmdirSync(dir);
      } catch { break; } // Nonempty directories and links are left in place.
    }
  }
  return result;
}

/**
 * The git-ignored files a worktree holds right now, each with a signature (size and sha-256, or a symlink's target).
 * Taken after a project's setup command ran: the setup legitimately creates ignored files (`node_modules`, a venv),
 * and `ignoredOutsideAllowlist` then treats exactly those, unchanged, as the baseline. Bounded, so a runaway setup
 * output is refused rather than hashed for minutes.
 * @returns {{ok: boolean, error?: string, files?: Record<string, string>, count?: number, bytes?: number}} `files`, `count` and `bytes` are set when `ok`, `error` when not
 */
export function snapshotIgnored(dir, { maxFiles = 200000, maxBytes = 4 * 1024 ** 3 } = {}) {
  const listed = listIgnored(dir, 120000);
  if (listed.error) return { ok: false, error: listed.error };
  const ctx = hashingContext(dir, maxBytes);
  const { skipped, error } = workspaceAliases(dir, ctx.root, listed.files);
  if (error) return { ok: false, error };
  const names = listed.files.filter((name) => !skipped.has(name));
  if (names.length > maxFiles) return { ok: false, error: `setup left ${names.length} ignored files (the limit is ${maxFiles})` };
  /** @type {Record<string, string>} */
  const files = Object.create(null);
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
  const { files, error } = listIgnored(dir, 30000);
  if (error) return { ok: false, error, offending: [] };
  const aliases = workspaceAliases(dir, ctx.root, files);
  if (aliases.error) return { ok: false, error: aliases.error, offending: [] };
  // Tolerated cache directories count only at the worktree root: a `.cache` folder deeper down
  // could hide code, and a nested one the item really needs can be named in its allowlist.
  const offending = files.filter((f) => {
    if (aliases.skipped.has(f) || underAllowlist(f, allowlist) || tolerated.some((t) => underAllowlist(f, [t]))) return false;
    if (baseline && Object.hasOwn(baseline, f)) {
      const sig = signatureOf(dir, f, ctx, baseline[f]);
      return sig === null || sig !== baseline[f]; // what cannot be verified is not accepted
    }
    return true;
  });
  return { ok: true, error: null, offending };
}
