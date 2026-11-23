// git, run in a directory a worker has been writing to. The worker shares the file system with the
// repository, so its worktree's git configuration is not trusted: options that make git run a
// program (an fsmonitor hook, hooks, an external diff, a pager) are switched off for the command,
// and the environment is the reduced one used for acceptance commands (no keys or tokens).
import { spawnSync } from 'node:child_process';
import { safeEnv } from './env.mjs';

const NO_HOOKS = process.platform === 'win32' ? 'NUL' : '/dev/null';

export const HARDENING = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'core.untrackedCache=false'];

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{timeout?: number, maxBuffer?: number}} [options]
 */
export function gitSafe(cwd, args, { timeout = 20000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return spawnSync('git', [...HARDENING, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer,
    env: { ...safeEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
}
