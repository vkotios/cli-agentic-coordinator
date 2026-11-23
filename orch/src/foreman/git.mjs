// git, run in a directory a worker has been writing to.
//
// The worker shares the file system with the repository, so everything under its `.git` (the
// repository config above all) is attacker-controlled: `git status` runs a configured clean filter,
// and options such as core.fsmonitor or diff.external make git run a program. Checking the config
// first and running git afterwards leaves a window between the two, so nothing is checked: git is
// never allowed to read the worktree's config at all.
//
// Each command runs against a git directory Foreman owns and builds for the call:
//   - `config` is written by Foreman: no programs, plus a short allowlist of plain values copied
//     from the worktree's config after validation (core.filemode, core.ignorecase, ...);
//   - `HEAD` is the commit id Foreman resolved by reading the worktree's HEAD file;
//   - `objects/info/alternates` points at the real object store (data);
//   - `info/exclude` is a copy of the repository's (so ignore rules match what the worker saw);
//   - GIT_INDEX_FILE points at the worktree's real index (data), GIT_WORK_TREE at the worktree.
// With GIT_DIR set, git does not look for or read any `.git` in the worktree again, so the worker
// changing its config (or its `.git` file) while the command runs changes nothing that git reads.
// Index, object, .gitignore and .gitattributes content stay worker-controlled, but without a
// configured program they are data: no filter, textconv, external diff, hook or monitor exists to run.
// The command-line overrides below are a second layer, and the environment is the reduced one used
// for acceptance commands (no keys or tokens).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { safeEnv } from './env.mjs';

const NO_HOOKS = process.platform === 'win32' ? 'NUL' : '/dev/null';
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SMALL = 1024 * 1024;
const PACKED_REFS_MAX = 64 * 1024 * 1024;

// An empty file to stand in for the global git config and attributes file (the null device is not
// usable as a config path on every platform). It lives in a private directory made for this process,
// not at a predictable path in the shared temp directory.
let emptyFile = null;
function empty() {
  if (emptyFile) return emptyFile;
  const dir = privateDir('orch-foreman-git-');
  const file = path.join(dir, 'empty-gitconfig');
  fs.writeFileSync(file, '', { flag: 'w', mode: 0o600 });
  process.once('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover empty temp directory is harmless */ } });
  emptyFile = file;
  return file;
}

function privateDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on Windows */ }
  return dir;
}

/** The per-command overrides; built on first use so importing this module creates nothing. */
export const hardening = () => ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'core.untrackedCache=false', '-c', 'submodule.recurse=false', '-c', `core.attributesFile=${empty()}`];

function readSmall(file, max = SMALL) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > max) throw new Error(`${path.basename(file)} is not a regular file of a sensible size`);
  return fs.readFileSync(file, 'utf8');
}

/** Where the worktree's git directory and the shared (common) one are. Reads files only. */
function locate(dir) {
  const dot = path.join(dir, '.git');
  let gitdir;
  if (fs.statSync(dot).isDirectory()) gitdir = dot;
  else {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readSmall(dot));
    if (!m) throw new Error('.git is neither a directory nor a gitdir pointer');
    gitdir = path.resolve(dir, m[1]);
  }
  let common = gitdir;
  const pointer = path.join(gitdir, 'commondir');
  if (fs.existsSync(pointer)) common = path.resolve(gitdir, readSmall(pointer).trim());
  return { gitdir, common };
}

/** The commit HEAD names, found by reading the files (nothing is run). */
function resolveHead({ gitdir, common }) {
  const head = readSmall(path.join(gitdir, 'HEAD')).trim();
  if (SHA.test(head)) return head;
  const m = /^ref:\s*(refs\/\S+)$/.exec(head);
  if (!m || m[1].split('/').includes('..')) throw new Error('HEAD is not a commit id or a branch reference');
  const ref = m[1];
  for (const base of [gitdir, common]) {
    try {
      const value = readSmall(path.join(base, ref)).trim();
      if (SHA.test(value)) return value;
    } catch { /* not a loose ref here; try the next place, then packed-refs */ }
  }
  try {
    for (const line of readSmall(path.join(common, 'packed-refs'), PACKED_REFS_MAX).split(/\r?\n/)) {
      const parts = line.split(' ');
      if (parts.length === 2 && parts[1] === ref && SHA.test(parts[0])) return parts[0];
    }
  } catch { /* no packed-refs */ }
  throw new Error(`${ref} does not resolve to a commit`);
}

const BOOL = { true: 'true', yes: 'true', on: 'true', 1: 'true', false: 'false', no: 'false', off: 'false', 0: 'false' };
// Plain values that change how git reads files, not what it runs. Each is validated, then written
// into Foreman's own config; nothing else is taken from the worktree's.
const COPIED = {
  'core.filemode': (v) => BOOL[v.toLowerCase()],
  'core.ignorecase': (v) => BOOL[v.toLowerCase()],
  'core.symlinks': (v) => BOOL[v.toLowerCase()],
  'core.precomposeunicode': (v) => BOOL[v.toLowerCase()],
  'core.autocrlf': (v) => (BOOL[v.toLowerCase()] ?? (v.toLowerCase() === 'input' ? 'input' : undefined)),
  'core.eol': (v) => (['lf', 'crlf', 'native'].includes(v.toLowerCase()) ? v.toLowerCase() : undefined),
};

function copiedConfig(configFile, cwd) {
  const out = new Map();
  let r;
  try { r = spawnSync('git', ['config', '--file', configFile, '--list', '-z'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: SMALL, env: { ...safeEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty() } }); } catch { return out; }
  if (r.status !== 0) return out;
  for (const entry of r.stdout.split('\0').filter(Boolean)) {
    const at = entry.indexOf('\n');
    const key = (at < 0 ? entry : entry.slice(0, at)).toLowerCase();
    const value = at < 0 ? '' : entry.slice(at + 1);
    if (Object.hasOwn(COPIED, key)) {
      const clean = COPIED[key](value);
      if (clean) out.set(key, clean); // the last valid value wins, as in git
    }
  }
  return out;
}

/**
 * A git directory owned by Foreman for one inspection of `dir`.
 * @param {string} dir the worktree
 * @returns {{ok: true, run: (args: string[], options?: {timeout?: number, maxBuffer?: number}) => import('node:child_process').SpawnSyncReturns<string>, close: () => void} | {ok: false, error: string}}
 */
export function openInspection(dir) {
  let root = null;
  try {
    const located = locate(dir);
    const head = resolveHead(located);
    root = privateDir('orch-foreman-gd-');
    const gitdir = path.join(root, 'git');
    fs.mkdirSync(path.join(gitdir, 'objects', 'info'), { recursive: true });
    fs.mkdirSync(path.join(gitdir, 'refs'), { recursive: true });
    fs.mkdirSync(path.join(gitdir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitdir, 'HEAD'), `${head}\n`);
    fs.writeFileSync(path.join(gitdir, 'objects', 'info', 'alternates'), `${path.join(located.common, 'objects')}\n`);
    try { fs.writeFileSync(path.join(gitdir, 'info', 'exclude'), readSmall(path.join(located.common, 'info', 'exclude'))); } catch { /* no exclude file */ }
    const sha256 = head.length === 64;
    const lines = ['[core]', `\trepositoryformatversion = ${sha256 ? 1 : 0}`, '\tbare = false'];
    for (const [key, value] of copiedConfig(path.join(located.common, 'config'), root)) lines.push(`\t${key.slice('core.'.length)} = ${value}`);
    if (sha256) lines.push('[extensions]', '\tobjectformat = sha256');
    fs.writeFileSync(path.join(gitdir, 'config'), `${lines.join('\n')}\n`);
    const env = {
      ...safeEnv(),
      GIT_DIR: gitdir,
      GIT_WORK_TREE: dir,
      GIT_INDEX_FILE: path.join(located.gitdir, 'index'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: empty(),
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    };
    return {
      ok: true,
      run: (args, { timeout = 20000, maxBuffer = 4 * 1024 * 1024 } = {}) => spawnSync('git', [...hardening(), ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout, maxBuffer, env }),
      close: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* a leftover temp directory is harmless */ } },
    };
  } catch (error) {
    if (root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* nothing to do */ } }
    return { ok: false, error: `the worktree could not be set up for inspection (${error.message})` };
  }
}

/**
 * Run git against `dir` without letting it read the worktree's git config (see the top of the file).
 * Setup failures come back as a failed result (status -1), never as an empty success.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{timeout?: number, maxBuffer?: number}} [options]
 */
export function gitSafe(cwd, args, options = {}) {
  const inspection = openInspection(cwd);
  if ('error' in inspection) return { status: -1, stdout: '', stderr: inspection.error, error: new Error(inspection.error) };
  try {
    return inspection.run(args, options);
  } finally {
    inspection.close();
  }
}
