// State root, lane configuration, and the optional user configuration file.
//
// Every machine-specific value is resolved in ONE order: command-line flag (where the
// command has one) > environment variable > `orch.config.json` > a default derived from
// the kit location or the current user's profile. Nothing defaults to a drive or a path
// chosen for one machine.
//
// `orch.config.json` lives at the repository root (next to `orch/`), or at the path in
// ORCH_CONFIG. It is optional; `orch.config.example.json` lists every key. Relative paths
// in it resolve against the directory the file is in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './util.mjs';
import { OrchError } from './errors.mjs';

/** The `orch/` directory. */
export const KIT_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
/** The repository root (the directory that holds `orch/`, `hooks/`, `skills/`, ...). */
export const REPO_ROOT = path.resolve(KIT_ROOT, '..');
export const DEFAULT_CONFIG_FILE = path.join(REPO_ROOT, 'orch.config.json');

export const DEFAULTS = {
  lanes: {
    // Thresholds are in seconds. A stall is advisory: nothing here ever kills a run.
    local: { serial: true, quietSeconds: 300, stallSeconds: 600 },
    cloud: { serial: false, quietSeconds: 180, stallSeconds: 360 },
  },
  // Monitor polling. The monitor is disposable and off the exclusion path (K2).
  pollMs: 1000,
  // Bounded process-table snapshots for escaped-helper discovery: slow on purpose.
  procScanMs: 15000,
};

/** The config file in effect: $ORCH_CONFIG, else `<repo>/orch.config.json`. */
export function configFilePath() {
  return process.env.ORCH_CONFIG ? path.resolve(process.env.ORCH_CONFIG) : DEFAULT_CONFIG_FILE;
}

const configCache = new Map();

/**
 * The user configuration. A missing default file is simply `{}`; a file named by
 * ORCH_CONFIG must exist. An unreadable or invalid file is an error, never ignored.
 * @returns {{file:string, exists:boolean, values:any}}
 */
export function userConfig() {
  const file = configFilePath();
  if (configCache.has(file)) return configCache.get(file);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT' && !process.env.ORCH_CONFIG) {
      const none = { file, exists: false, values: {} };
      configCache.set(file, none);
      return none;
    }
    throw new OrchError(`cannot read the orch config file ${file} (${(e && e.code) || e})`, 'bad-config');
  }
  let values;
  try {
    values = JSON.parse(raw.replace(/^﻿/, '') || '{}');
  } catch (e) {
    throw new OrchError(`the orch config file ${file} is not valid JSON (${e.message})`, 'bad-config');
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new OrchError(`the orch config file ${file} must hold a JSON object`, 'bad-config');
  }
  const doc = { file, exists: true, values };
  configCache.set(file, doc);
  return doc;
}

/**
 * One setting: environment variable > config key (dotted, e.g. `exe.codex`) > fallback.
 * @param {string|null} envName
 * @param {string} key
 * @param {any} fallback a value, or a function computing it
 * @param {{isPath?:boolean}} [opts] isPath: a config value is resolved against the config file's directory
 */
export function setting(envName, key, fallback, opts = {}) {
  const env = envName ? process.env[envName] : undefined;
  if (env) return env;
  const { file, values } = userConfig();
  const v = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), values);
  if (v !== undefined && v !== null && v !== '') {
    if (typeof v !== 'string') throw new OrchError(`the orch config file ${file}: "${key}" must be a string`, 'bad-config');
    return opts.isPath ? path.resolve(path.dirname(file), v) : v;
  }
  return typeof fallback === 'function' ? fallback() : fallback;
}

/** `%LOCALAPPDATA%` of the current user (from the process token when the variable is unset). */
export function localAppData() {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  return path.join(os.userInfo().homedir, 'AppData', 'Local');
}

/**
 * Resolve the state root. Order: explicit argument, ORCH_STATE_ROOT, `stateRoot` in the
 * config file, `<kit>/.state`. Default is inside the kit, never inside the target repo.
 */
export function resolveStateRoot(explicit) {
  const root = explicit || setting('ORCH_STATE_ROOT', 'stateRoot', () => path.join(KIT_ROOT, '.state'), { isPath: true });
  return path.resolve(root);
}

/** Config = DEFAULTS merged with `<stateRoot>/config.json` when present. */
export function loadConfig(stateRootArg) {
  const stateRoot = resolveStateRoot(stateRootArg);
  const file = path.join(stateRoot, 'config.json');
  const user = readJson(file, {}) || {};
  const lanes = { ...DEFAULTS.lanes };
  for (const [k, v] of Object.entries(user.lanes || {})) lanes[k] = { ...(lanes[k] || {}), ...v };
  // NOTE: there is no lane directory under the state root any more (review r2-4).
  // The lane's pipe name and its one advisory file both come from `lanescope.mjs`.
  return {
    stateRoot,
    runsDir: path.join(stateRoot, 'runs'),
    lanes,
    pollMs: user.pollMs ?? DEFAULTS.pollMs,
    procScanMs: user.procScanMs ?? DEFAULTS.procScanMs,
    configFile: file,
  };
}

export function ensureDirs(cfg) {
  fs.mkdirSync(cfg.runsDir, { recursive: true });
}
