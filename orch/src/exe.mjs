// Order for every CLI: its environment override (ORCH_<CLI>_EXE) > `exe.<cli>` in
// orch.config.json > the platform's real executable found on PATH > CLI-specific
// fallbacks. On Windows `.cmd` / `.ps1` launchers are excluded to preserve containment.
// On Linux, native executables and shebang scripts are launched directly with shell:false.
// A CLI that is not installed is a clear `cli-not-found` error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OrchError } from './errors.mjs';
import { setting } from './config.mjs';

/** Find executable matches on PATH using the platform's path delimiter and launch rules. */
export function whereAll(name, env = process.env) {
  if (process.platform === 'win32') {
    try {
      return execFileSync('where.exe', [name], { encoding: 'utf8', timeout: 3000, windowsHide: true, env, stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  const found = [];
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        found.push(candidate);
      }
    } catch {
      // Missing or non-executable PATH entries are not candidates.
    }
  }
  return found;
}

/** Inspect a direct executable only; discovery never invokes it. */
export function isNativeExecutable(file) {
  try {
    if (typeof file !== 'string' || !file || !fs.statSync(file).isFile()) return false;
    if (process.platform === 'win32') return /\.exe$/i.test(file);
    if (/\.(cmd|bat|ps1)$/i.test(file)) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/** The explicit override for a CLI, or null. */
export function exeOverride(cli) {
  const env = `ORCH_${cli.toUpperCase()}_EXE`;
  return setting(env, `exe.${cli}`, null, { isPath: true }) || null;
}

/** The first direct executable for `<cli>` on PATH, or null. */
export function exeOnPath(cli, env = process.env) {
  const name = process.platform === 'win32' ? `${cli}.exe` : cli;
  return whereAll(name, env).find((p) => process.platform !== 'win32' || /\.exe$/i.test(p)) || null;
}

/**
 * Candidate npm global prefixes, most specific first: every PATH directory that holds the
 * npm shim for `shimName` (npm puts shims in the prefix root on Windows), then
 * `npm_config_prefix`, then the current user's `%APPDATA%\npm` (npm's Windows default).
 */
export function npmPrefixes(shimName, env = process.env) {
  const out = [];
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  for (const p of whereAll(`${shimName}${suffix}`, env)) out.push(path.dirname(p));
  if (env.npm_config_prefix) {
    out.push(process.platform === 'win32' ? env.npm_config_prefix : path.join(env.npm_config_prefix, 'bin'));
  }
  if (process.platform === 'win32') {
    const appData = env.APPDATA || path.join(os.userInfo().homedir, 'AppData', 'Roaming');
    out.push(path.join(appData, 'npm'));
  } else {
    out.push(path.join(env.HOME || os.homedir(), '.local', 'bin'));
  }
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
  const tried = [`${process.platform === 'win32' ? `${cli}.exe` : cli} on PATH`];
  for (const cand of opts.fallbacks ? opts.fallbacks(env) : []) {
    tried.push(cand);
    if (fs.existsSync(cand)) return cand;
  }
  const pathHint = process.platform === 'win32' ? '<path to the real .exe>' : '<path to the executable>';
  throw new OrchError(
    `${cli} is not installed or not found (looked for: ${tried.join('; ')}). Install it and log in, ` +
      `or set ORCH_${cli.toUpperCase()}_EXE / "exe": {"${cli}": "${pathHint}"} in orch.config.json.` +
      (opts.hint ? ` ${opts.hint}` : ''),
    'cli-not-found',
  );
}
