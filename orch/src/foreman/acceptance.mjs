// Runs an item's acceptance commands in its worktree: argv only (never a shell), a bounded
// time, output captured to a log file with a size cap. A command that exits 0 passes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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
      child = spawn(check.argv[0], check.argv.slice(1), { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ status: 'error', error: String(error.message || error) });
      return;
    }
    child.stdout.on('data', sink);
    child.stderr.on('data', sink);
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
