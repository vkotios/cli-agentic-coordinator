// Git helpers for the workflow layer (slice 2). Argv is always built in Node and
// git.exe is spawned with shell:false; every call is asynchronous and bounded.
//
// A git error is never read as "nothing changed": callers get `{ok:false}` and turn it
// into `unknown` (lesson: missing or ambiguous evidence is unknown, never success).
import { execFile } from 'node:child_process';
import { OrchError } from './errors.mjs';

/** Environment variables that would silently point git at a different repository. */
const GIT_ENV_STRIP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE'];

function gitEnv() {
  const env = { ...process.env };
  for (const k of GIT_ENV_STRIP) delete env[k];
  // Never let git open an editor or a credential prompt: nothing here is interactive.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_EDITOR = 'true';
  return env;
}

/**
 * Run git once. `core.quotepath=off` so non-ASCII paths come back as UTF-8, never as
 * octal escapes.
 * @param {string[]} args
 * @param {{cwd?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, code:number, stdout:string, stderr:string, args:string[]}>}
 */
export function git(args, opts = {}) {
  const { cwd, timeoutMs = 60000 } = opts;
  const full = ['-c', 'core.quotepath=off', ...args];
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        full,
        { cwd, env: gitEnv(), encoding: 'buffer', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err ? (typeof (/** @type {any} */ (err).code) === 'number' ? /** @type {any} */ (err).code : -1) : 0;
          resolve({
            ok: !err,
            code,
            stdout: Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || ''),
            stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || (err && err.message) || ''),
            args: full,
          });
        },
      );
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String((e && e.message) || e), args: full });
    }
  });
}

/**
 * Run git and throw a clean OrchError when it fails.
 * @param {string[]} args
 * @param {{cwd?:string, timeoutMs?:number}} [opts]
 */
export async function gitOk(args, opts = {}) {
  const r = await git(args, opts);
  if (!r.ok) {
    throw new OrchError(`git ${args.join(' ')} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`, 'git-failed');
  }
  return r.stdout;
}

/** Split `-z` output into entries. */
export function splitZ(s) {
  return String(s || '')
    .split('\0')
    .filter((x) => x.length > 0);
}

/** Top-level directory of the work tree that contains `dir`, or null. */
export async function topLevel(dir) {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd: dir });
  return r.ok ? r.stdout.trim() : null;
}

/** Resolve a ref to a full commit id, or null. */
export async function resolveCommit(cwd, ref) {
  const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  const v = r.stdout.trim();
  return r.ok && /^[0-9a-f]{40,64}$/.test(v) ? v : null;
}

/**
 * `git worktree list --porcelain`, parsed. The first entry is the main worktree.
 * @returns {Promise<Array<{path:string, head:string|null, branch:string|null, detached:boolean}>|null>}
 */
export async function worktreeList(cwd) {
  const r = await git(['worktree', 'list', '--porcelain', '-z'], { cwd });
  if (!r.ok) return null;
  const out = [];
  let cur = null;
  for (const line of String(r.stdout).split('\0')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null, detached: false };
      out.push(cur);
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7);
    else if (cur && line === 'detached') cur.detached = true;
  }
  return out;
}

/** Case-insensitive, separator-insensitive path equality for Windows paths. */
export function samePath(a, b) {
  if (!a || !b) return false;
  const n = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
}

/** Is `child` equal to or inside `parent` (Windows semantics: case-insensitive)? */
export function isInside(child, parent) {
  if (!child || !parent) return false;
  const n = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const c = n(child);
  const p = n(parent);
  return c === p || c.startsWith(p + '/');
}
