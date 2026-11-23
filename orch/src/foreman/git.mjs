// git, run in a directory a worker has been writing to. The worker shares the file system with the
// repository, so its worktree's git configuration is not trusted: options that make git run a
// program (an fsmonitor hook, hooks, an external diff, a pager) are switched off for the command,
// and the environment is the reduced one used for acceptance commands (no keys or tokens).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { safeEnv } from './env.mjs';

const NO_HOOKS = process.platform === 'win32' ? 'NUL' : '/dev/null';

// An empty file to stand in for the global git config and attributes file (the null device is not
// usable as a config path on every platform). It lives in a private directory made for this process,
// not at a predictable path in the shared temp directory.
let emptyFile = null;
function empty() {
  if (emptyFile) return emptyFile;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-foreman-git-'));
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on Windows */ }
  const file = path.join(dir, 'empty-gitconfig');
  fs.writeFileSync(file, '', { flag: 'w', mode: 0o600 });
  process.once('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover empty temp directory is harmless */ } });
  emptyFile = file;
  return file;
}

/** The per-command overrides; built on first use so importing this module creates nothing. */
export const hardening = () => ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'core.untrackedCache=false', '-c', 'submodule.recurse=false', '-c', `core.attributesFile=${empty()}`];

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{timeout?: number, maxBuffer?: number}} [options]
 */
export function gitSafe(cwd, args, { timeout = 20000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return spawnSync('git', [...hardening(), ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer,
    env: { ...safeEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty(), GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
}

// Configuration keys that make git run a program. The repository's own config sits where a worker
// can write it, and `git status` runs a configured clean filter, so a work tree whose config
// defines any of these is not trusted. Reading the config runs nothing.
const PROGRAM_KEYS = /^(filter\..+\.(clean|smudge|process)|diff\..+\.(textconv|command)|diff\.external|core\.(fsmonitor|sshcommand|editor|pager|askpass|gitproxy)|credential\..*helper|alias\..+|merge\..+\.driver|gpg\..*program|uploadpack\..*|receive\..*|url\..+\.insteadof|protocol\.ext\.allow)$/i;

/** @returns {string[]} the offending config keys (empty when the config defines no programs) */
export function untrustedConfig(cwd) {
  const r = gitSafe(cwd, ['config', '--list', '-z'], { timeout: 15000 });
  if (r.status !== 0) return ['(the git configuration could not be read)'];
  // Our own command-line overrides are listed too (an empty diff.external, core.fsmonitor=false): skip those.
  return r.stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.split('\n'))
    .filter(([key, value]) => PROGRAM_KEYS.test(key) && !(/^diff\.external$/i.test(key) && !value) && !/^core\.(fsmonitor|pager)$/i.test(key))
    .map(([key]) => key);
}
