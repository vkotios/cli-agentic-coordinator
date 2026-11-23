// Runs an item's acceptance commands in its worktree: argv only (never a shell), a bounded
// time, output captured to a log file with a size cap. A command that exits 0 passes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Worker-written code runs inside acceptance commands (that is what a test is), so the process
// gets a reduced environment: no API keys, no gateway keys, nothing the Foreman itself holds.
const SAFE_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'LANG', 'LC_ALL', 'TZ', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'CI']);

export function safeEnv(env = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (SAFE_ENV.has(key.toUpperCase()) || key.toUpperCase().startsWith('LC_'))) out[key] = value;
  }
  return out;
}

/**
 * Resolve a bare program name through PATH, never through the worktree: on Windows a process is
 * also looked up in the current directory, so a file the worker planted there would otherwise
 * win. A name with a path separator must stay inside the worktree (the scope guard has already
 * limited what the worker may have created there).
 */
export function resolveExecutable(name, root, env = process.env) {
  if (/[\\/]/.test(name)) {
    const full = path.resolve(root, name);
    return insideRoot(root, full) ? full : null;
  }
  const exts = process.platform === 'win32' ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
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
 * @param {{root:string, logFile:string, defaultTimeoutS:number, maxLogBytes:number}} o
 */
export function runCheck(check, { root, logFile, defaultTimeoutS, maxLogBytes }) {
  if (check.kind === 'rubric') return Promise.resolve({ status: 'needs-judgement', kind: 'rubric', text: check.text });
  const cwd = path.resolve(root, check.cwd || '.');
  if (!insideRoot(root, cwd)) return Promise.resolve({ status: 'error', kind: check.kind, argv: check.argv, error: 'cwd leaves the worktree' });
  const program = resolveExecutable(check.argv[0], root);
  if (!program) return Promise.resolve({ status: 'error', kind: check.kind, argv: check.argv, error: `cannot find ${check.argv[0]} on PATH (the worktree is never searched)` });
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
      child = spawn(program, check.argv.slice(1), { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: safeEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
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
