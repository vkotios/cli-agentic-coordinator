// Worker CLI executables, resolved at run time on the current machine.
//
// Order for every CLI: its environment override (ORCH_<CLI>_EXE) > `exe.<cli>` in
// orch.config.json > the real `.exe` found on PATH (`where.exe`, bounded) > CLI-specific
// fallbacks. Nothing assumes one user's profile: the npm global prefix is found from the
// PATH entry holding the npm shim, from `npm_config_prefix`, or from the CURRENT user's
// `%APPDATA%\npm`. A CLI that is not installed is a clear `cli-not-found` error.
//
// `.cmd` / `.ps1` shims are never returned: cmd.exe in the process chain destroys tree
// containment (opencode, see docs/CLI_GUIDE.md), and Node refuses to spawn a .cmd with
// shell:false anyway.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OrchError } from './errors.mjs';
import { setting } from './config.mjs';

/**
 * Every match `where.exe <name>` reports on PATH (bounded: an unreachable UNC entry on
 * PATH can stall where.exe, agy g12). Empty when there is none or where.exe fails.
 * @param {string} name e.g. `codex.exe` or `opencode.cmd`
 * @param {NodeJS.ProcessEnv} [env]
 */
export function whereAll(name, env = process.env) {
  try {
    return execFileSync('where.exe', [name], { encoding: 'utf8', timeout: 3000, windowsHide: true, env, stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The explicit override for a CLI, or null. */
export function exeOverride(cli) {
  const env = `ORCH_${cli.toUpperCase()}_EXE`;
  return setting(env, `exe.${cli}`, null, { isPath: true }) || null;
}

/** The first real `.exe` for `<cli>.exe` on PATH, or null. */
export function exeOnPath(cli, env = process.env) {
  return whereAll(`${cli}.exe`, env).find((p) => /\.exe$/i.test(p)) || null;
}

/**
 * Candidate npm global prefixes, most specific first: every PATH directory that holds the
 * npm shim for `shimName` (npm puts shims in the prefix root on Windows), then
 * `npm_config_prefix`, then the current user's `%APPDATA%\npm` (npm's Windows default).
 */
export function npmPrefixes(shimName, env = process.env) {
  const out = [];
  for (const p of whereAll(`${shimName}.cmd`, env)) out.push(path.dirname(p));
  if (env.npm_config_prefix) out.push(env.npm_config_prefix);
  const appData = env.APPDATA || path.join(os.userInfo().homedir, 'AppData', 'Roaming');
  out.push(path.join(appData, 'npm'));
  return [...new Set(out.map((p) => path.resolve(p)))];
}

/**
 * Resolve a CLI or throw `cli-not-found`.
 * @param {string} cli adapter name (opencode, codex, agy, vibe)
 * @param {{fallbacks?: (env: NodeJS.ProcessEnv) => string[], hint?: string, env?: NodeJS.ProcessEnv}} [opts]
 */
export function resolveCliExe(cli, opts = {}) {
  const env = opts.env || process.env;
  const explicit = exeOverride(cli);
  if (explicit) return explicit;
  const onPath = exeOnPath(cli, env);
  if (onPath) return onPath;
  const tried = [`${cli}.exe on PATH`];
  for (const cand of opts.fallbacks ? opts.fallbacks(env) : []) {
    tried.push(cand);
    if (fs.existsSync(cand)) return cand;
  }
  throw new OrchError(
    `${cli} is not installed or not found (looked for: ${tried.join('; ')}). Install it and log in, ` +
      `or set ORCH_${cli.toUpperCase()}_EXE / "exe": {"${cli}": "<path to the real .exe>"} in orch.config.json.` +
      (opts.hint ? ` ${opts.hint}` : ''),
    'cli-not-found',
  );
}
