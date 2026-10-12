// Windows process helpers. Every read is BOUNDED and asynchronous; every kill is
// identity-checked.
//
// Hard rules (owner rule, spec rule, and v3 §6):
//  - only ever act on a PID this tool spawned and recorded; never look a process up
//    by image name;
//  - identity is (pid, OS creation time); a pid alone is not an identity;
//  - three-valued liveness: `unknown` is never converted to `gone`;
//  - no `execFileSync` anywhere - an unbounded synchronous process query can block a
//    command forever (round-1 review M2).
//
// `isAlive` and `identityMatches` from the old build are DELETED (v3 §13): a boolean
// predicate silently turned "the table could not be read" into "not alive".
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

const PS = 'powershell.exe';
const PS_BASE = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/** Normalise whatever CIM hands back into a stable comparable string. */
export function normalizeCreationTime(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    if (/^ms:-?\d+$/.test(v) || /^ticks:\d+$/.test(v)) return v; // already normalised: MUST be idempotent
    const m = /\/Date\((-?\d+)/.exec(v);
    if (m) return `ms:${m[1]}`;
    const t = Date.parse(v);
    return Number.isFinite(t) ? `ms:${t}` : String(v);
  }
  if (typeof v === 'number') return `ms:${v}`;
  if (typeof v === 'object' && v.DateTime) return normalizeCreationTime(String(v.DateTime));
  return String(v);
}

function runPs(command, deadlineMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child;
    try {
      child = execFile(
        PS,
        [...PS_BASE, command],
        { encoding: 'utf8', maxBuffer: 48 * 1024 * 1024, windowsHide: true, timeout: Math.round(deadlineMs) },
        (err, stdout, stderr) => {
          if (err && process.env.ORCH_DEBUG_PS === '1') {
            try {
              process.stderr.write(`[orch-ps] ${err.code ?? ''} ${err.signal ?? ''} ${String(err.message).slice(0, 300)} | stderr=${String(stderr).slice(0, 300)}\n`);
            } catch {
              /* ignore */
            }
          }
          done(err && !stdout ? null : String(stdout || ''));
        },
      );
    } catch {
      done(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done(null);
    }, deadlineMs + 250);
    timer.unref?.();
    child.on('close', () => clearTimeout(timer));
  });
}

function parseTable(raw) {
  if (raw === null) return null;
  const text = String(raw).trim();
  if (!text) return [];
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    return null;
  }
  if (arr === null || arr === undefined) return [];
  if (!Array.isArray(arr)) arr = [arr];
  return arr.map((p) => ({
    pid: Number(p.ProcessId),
    ppid: Number(p.ParentProcessId),
    name: String(p.Name || ''),
    createdAt: normalizeCreationTime(p.CreationDate),
  }));
}

function parseLinuxStat(pid, raw) {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close <= open) return null;
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const actualPid = Number(raw.slice(0, open).trim());
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  const session = Number(fields[3]);
  const startTicks = fields[19]; // procfs stat field 22; stable across PID reuse
  if (actualPid !== Number(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgrp) || !/^\d+$/.test(startTicks || '')) return null;
  return { pid: actualPid, ppid, pgrp, session, name: raw.slice(open + 1, close), createdAt: `ticks:${startTicks}` };
}

async function readLinuxProcessTable(list, deadlineMs) {
  const started = Date.now();
  const work = (async () => {
    let ids;
    try {
      ids = list || (await fs.readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number);
    } catch {
      return null;
    }
    const rows = [];
    for (let i = 0; i < ids.length; i += 32) {
      if (Date.now() - started >= deadlineMs) return null;
      const batch = await Promise.all(ids.slice(i, i + 32).map(async (pid) => {
        try {
          return { row: parseLinuxStat(pid, await fs.readFile(`/proc/${pid}/stat`, 'utf8')) };
        } catch (e) {
          return { error: e?.code || 'PROC-READ-FAILED' };
        }
      }));
      for (const result of batch) {
        if (result.row) rows.push(result.row);
        else if (list && result.error && !['ENOENT', 'ESRCH'].includes(result.error)) return null;
      }
    }
    return rows;
  })();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(1, deadlineMs));
  });
  const result = await Promise.race([work, timeout]);
  clearTimeout(timer);
  return result;
}

/**
 * Bounded snapshot of the process table.
 * @returns {Promise<Array<{pid:number,ppid:number,pgrp?:number,session?:number,name:string,createdAt:string|null}>|null>}
 *          `null` means UNKNOWN (not "nothing is alive").
 */
export async function readProcessTable({ deadlineMs = 5000, pids = null, attempts = 2 } = {}) {
  const list = Array.isArray(pids) ? [...new Set(pids.map(Number).filter((n) => Number.isFinite(n) && n > 0))] : null;
  if (list && list.length === 0) return [];
  if (process.platform === 'linux') return readLinuxProcessTable(list, deadlineMs);
  const filter = list && list.length <= 60 ? ` -Filter "${list.map((p) => `ProcessId=${p}`).join(' or ')}"` : '';
  const cmd =
    `Get-CimInstance Win32_Process${filter} | ` +
    'Select-Object ProcessId,ParentProcessId,Name,CreationDate | ConvertTo-Json -Compress -Depth 3';
  // MEASURED on this machine: a filtered query costs 455-543 ms idle (12 samples), but
  // under the suite's own concurrent load it was observed to exceed a 5 s cap at least
  // once. `null` (= UNKNOWN) is an expensive answer - it refuses kills and blanks
  // diagnostics - so one retry is taken while budget remains. Two failures still return
  // `null`, and `unknown` is never downgraded to `gone`.
  const started = Date.now();
  for (let i = 0; i < Math.max(1, attempts); i++) {
    const left = deadlineMs - (Date.now() - started);
    if (left <= 50) break;
    const parsed = parseTable(await runPs(cmd, left));
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Descendant pids of `root` (root excluded), computed from a snapshot. */
export function descendantsOf(root, table) {
  if (!table) return [];
  const byParent = new Map();
  for (const p of table) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const out = [];
  const stack = [Number(root)];
  const seen = new Set(stack);
  while (stack.length) {
    const cur = stack.pop();
    for (const child of byParent.get(cur) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

/**
 * THE identity predicate (v3 §6, carried from v2 §2.9). Four labels, and `unknown`
 * is a real answer that no caller may downgrade.
 *
 *  match    - pid present AND its creation time equals the recorded one
 *  gone     - pid absent from a table we could read
 *  mismatch - pid present but it is a DIFFERENT process (pid reuse)
 *  unknown  - table unreadable, nothing recorded to compare, or a null creation time
 *
 * @param {number|null} pid
 * @param {string|null} recordedCreatedAt
 * @param {Array|null} table  `null` = could not be read
 * @returns {{verdict:string, reason?:string, found?:any}}
 */
export function verifyIdentity(pid, recordedCreatedAt, table) {
  // CODE-REVIEW FIX (astra H2): no recorded pid is NOT evidence that a process is
  // gone - it is the absence of evidence. It used to answer `gone`, which let a live
  // worker whose `spawned` line was never written be derived `cancelled`.
  if (!pid || !Number.isFinite(Number(pid))) return { verdict: 'unknown', reason: 'no-pid-recorded' };
  if (table === null || table === undefined) return { verdict: 'unknown', reason: 'process-table-unreadable' };
  const hit = table.find((p) => p.pid === Number(pid));
  if (!hit) return { verdict: 'gone', reason: 'pid-not-in-table' };
  if (!recordedCreatedAt) return { verdict: 'unknown', reason: 'no-creation-time-recorded', found: hit };
  if (!hit.createdAt) return { verdict: 'unknown', reason: 'creation-time-unreadable', found: hit };
  return normalizeCreationTime(recordedCreatedAt) === normalizeCreationTime(hit.createdAt)
    ? { verdict: 'match', found: hit }
    : { verdict: 'mismatch', reason: 'pid-reused', found: hit };
}

/** Creation times for a set of pids, as `{pid: createdAt|null}`; `null` table => `{}`. */
export async function creationTimesOf(pids, { deadlineMs = 5000 } = {}) {
  const table = await readProcessTable({ deadlineMs, pids });
  if (table === null) return { table: null, times: {} };
  const times = {};
  for (const p of table) times[p.pid] = p.createdAt;
  return { table, times };
}

function taskkill(args, deadlineMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child;
    try {
      child = execFile(
        'taskkill.exe',
        args,
        { encoding: 'utf8', windowsHide: true, timeout: deadlineMs },
        (err, stdout, stderr) =>
          done({ ok: !err, output: String(stdout || stderr || (err && err.message) || '').trim() }),
      );
    } catch (e) {
      done({ ok: false, output: String((e && e.message) || e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      done({ ok: false, output: `taskkill exceeded ${deadlineMs}ms` });
    }, deadlineMs + 250);
    timer.unref?.();
    child.on('close', () => clearTimeout(timer));
  });
}

function signalLinux(pid, processGroup = false) {
  const numericPid = Number(pid);
  // kill(-1, signal) broadcasts to every process the caller may signal; never derive it from PID 1.
  if (!Number.isSafeInteger(numericPid) || numericPid <= 1) {
    return { ok: false, output: `refusing unsafe Linux process id ${pid}` };
  }
  try {
    process.kill(processGroup ? -numericPid : numericPid, 'SIGKILL');
    return { ok: true, output: `${processGroup ? 'process group' : 'pid'} ${pid} sent SIGKILL` };
  } catch (e) {
    return { ok: false, output: `${processGroup ? 'process group' : 'pid'} ${pid} SIGKILL failed: ${e?.code || e?.message || e}` };
  }
}

/**
 * Kill EXACTLY one verified pid (`/F`, no `/T`).
 * Reachable only from `orch cancel --keeper` and the viewer-close path (gate G7).
 */
/** @param {{table?:Array|null, deadlineMs?:number}} [opts] */
export async function killChecked(pid, recordedCreatedAt, opts = {}) {
  const { table, deadlineMs = 3000 } = opts;
  const t = table === undefined ? await readProcessTable({ deadlineMs, pids: [pid] }) : table;
  const id = verifyIdentity(pid, recordedCreatedAt, t);
  if (id.verdict !== 'match') {
    return { killed: false, verdict: id.verdict, output: refusal(pid, id, recordedCreatedAt) };
  }
  const r = process.platform === 'linux'
    ? signalLinux(pid)
    : await taskkill(['/PID', String(pid), '/F'], deadlineMs);
  return { killed: r.ok, verdict: 'match', output: r.output };
}

/**
 * Tree-kill a verified root (`/T /F`).
 * Reachable only from `orch cancel <id>` (gate G7).
 *
 * KNOWN AND ACCEPTED CONFLICT (v4 §6 H6, brief line 13): `/T` walks the live process
 * table, so it also ends descendants the worker spawned `detached:true` - the very
 * helpers the design otherwise promises never to kill. This is operator-directed and
 * documented, not claimed away.
 */
/** @param {{table?:Array|null, deadlineMs?:number}} [opts] */
export async function treeKillChecked(pid, recordedCreatedAt, opts = {}) {
  const { table, deadlineMs = 3000 } = opts;
  const t = table === undefined ? await readProcessTable({ deadlineMs, pids: [pid] }) : table;
  const id = verifyIdentity(pid, recordedCreatedAt, t);
  if (id.verdict !== 'match') {
    return { killed: false, verdict: id.verdict, output: refusal(pid, id, recordedCreatedAt) };
  }
  const hit = t?.find((p) => p.pid === Number(pid));
  if (process.platform === 'linux') {
    if (!hit || hit.pgrp !== Number(pid) || hit.session !== Number(pid)) {
      return { killed: false, verdict: 'unknown', output: `pid ${pid} is not a verified Linux session leader; refusing process-group kill` };
    }
    const r = signalLinux(pid, true);
    return { killed: r.ok, verdict: 'match', output: r.output };
  }
  const r = await taskkill(['/PID', String(pid), '/T', '/F'], deadlineMs);
  return { killed: r.ok, verdict: 'match', output: r.output };
}

function refusal(pid, id, recordedCreatedAt) {
  if (id.verdict === 'gone') return `pid ${pid} is not running; nothing to kill`;
  if (id.verdict === 'mismatch') {
    return (
      `pid ${pid} is now a DIFFERENT process (recorded ${recordedCreatedAt}, found ` +
      `${id.found ? id.found.createdAt : '?'} "${id.found ? id.found.name : '?'}") - refusing to kill`
    );
  }
  return `identity of pid ${pid} could not be established (${id.reason}) - refusing to kill`;
}

/**
 * Terminate THIS process. Used only by the CLI's exit guard, after a command has already
 * printed its bounded answer.
 *
 * CODE-REVIEW FIX (astra M5), measured on this machine: with an fs read blocked on the
 * libuv threadpool (a pipe server that accepts and never writes), `withDeadline` fires
 * after 500 ms as designed - but `process.exit(0)` and `process.reallyExit(0)` BOTH
 * failed to end the process within 20-60 s, while terminating self ended it in 0.9 s.
 * So "bounded" needs this last step. The exit code of a self-terminated process is
 * not 0; that is stated in the report.
 */
export function terminateSelf() {
  try {
    process.kill(process.pid);
  } catch {
    /* nothing further is possible */
  }
}

/**
 * The OS creation time of a process THIS process just spawned - recorded only if the
 * process answering for that pid is still parented by us. A child that already exited
 * could have had its pid reused by the time the query runs; in that case nothing is
 * recorded and the identity stays `unknown` (astra H3/H4: identity is captured at spawn
 * or not at all, never adopted from whoever holds the pid now).
 * @returns {Promise<string|null>}
 */
export async function ownChildCreationTime(pid, { deadlineMs = 4000 } = {}) {
  const t = await readProcessTable({ deadlineMs, pids: [pid] });
  const hit = t && t.find((p) => p.pid === Number(pid));
  if (!hit || hit.ppid !== process.pid) return null;
  return hit.createdAt ?? null;
}
