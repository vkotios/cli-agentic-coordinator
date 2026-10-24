// Windows, Linux and macOS process helpers. Every read is BOUNDED and asynchronous; every kill is
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
import { readDarwinProcessTable } from './darwin-processes.mjs';
import { creationPoint, tableClockScope } from './process-time.mjs';

const PS = 'powershell.exe';
// One-shot identity reads at spawn get one shared bound. A freshly booted hosted Windows
// runner was observed to need more than 5 s just to start powershell.exe; a timed-out
// read leaves identity `unknown` for good, since it is never adopted later.
export const IDENTITY_QUERY_MS = 15000;
const PS_BASE = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/** Normalise whatever CIM hands back into a stable comparable string. */
export function normalizeCreationTime(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    if (/^ms:-?\d+$/.test(v) || /^ticks:\d+$/.test(v) || v.startsWith('linux:') || v.startsWith('darwin:')) return v; // already normalised: MUST be idempotent
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
          done({ raw: err && !stdout ? null : String(stdout || ''), failure: err
            ? { reason: err.killed ? 'query-timeout' : 'query-error', code: err.code ?? null, signal: err.signal ?? null } : null });
        },
      );
    } catch (e) {
      done({ raw: null, failure: { reason: 'query-error', code: e?.code ?? null, signal: null } });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done({ raw: null, failure: { reason: 'query-timeout', code: null, signal: null } });
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

function parseLinuxStat(pid, raw, scope) {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close <= open) return null;
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const actualPid = Number(raw.slice(0, open).trim());
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  const session = Number(fields[3]);
  const startTicks = fields[19]; // procfs stat field 22; stable across PID reuse
  if (actualPid !== Number(pid) || !Number.isInteger(ppid) || ppid < 0 || !Number.isInteger(pgrp) || !Number.isInteger(session) || !creationPoint(`${scope}:${startTicks}`)) return null;
  return { pid: actualPid, ppid, pgrp, session, name: raw.slice(open + 1, close), createdAt: `${scope}:${startTicks}` };
}

async function readLinuxProcessTable(list, deadlineMs) {
  const started = Date.now();
  const work = (async () => {
    let ids, scope;
    try {
      const [boot, namespace] = await Promise.all([fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'), fs.readlink('/proc/self/ns/pid')]);
      const ns = /^pid:\[([1-9]\d*)\]$/.exec(namespace);
      scope = ns ? `linux:${boot.trim()}:${ns[1]}` : null;
      if (!creationPoint(`${scope}:0`)) return null;
      ids = list || (await fs.readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number);
    } catch {
      return null;
    }
    const rows = [];
    Object.defineProperty(rows, 'clockScope', { value: scope });
    for (let i = 0; i < ids.length; i += 32) {
      if (Date.now() - started >= deadlineMs) return null;
      const batch = await Promise.all(ids.slice(i, i + 32).map(async (pid) => {
        try {
          return { row: parseLinuxStat(pid, await fs.readFile(`/proc/${pid}/stat`, 'utf8'), scope) };
        } catch (e) {
          return { error: e?.code || 'PROC-READ-FAILED' };
        }
      }));
      for (const result of batch) {
        if (result.row) rows.push(result.row);
        else if (!['ENOENT', 'ESRCH'].includes(result.error)) return null;
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
 * @returns {Promise<Array<{pid:number,ppid:number,pgrp?:number,session?:number,state?:string,name:string,createdAt:string|null}>|null>}
 *          `null` means UNKNOWN (not "nothing is alive").
 */
/** @param {{deadlineMs?:number,pids?:Array|null,attempts?:number,onFailure?:(failure:any)=>void}} [options]
 * @param {{query?:(command:string,deadlineMs:number)=>Promise<any>}} [seams] */
export async function readProcessTable({ deadlineMs = 5000, pids = null, attempts = 2, onFailure = null } = {}, seams = {}) {
  const list = Array.isArray(pids) ? [...new Set(pids.map(Number).filter((n) => Number.isFinite(n) && n > 0))] : null;
  if (list && list.length === 0) return [];
  if (['linux', 'darwin'].includes(process.platform) && !seams.query) {
    const started = Date.now();
    for (let i = 0; i < Math.max(1, attempts); i++) {
      const left = deadlineMs - (Date.now() - started);
      if (left <= 0) break;
      const table = await (process.platform === 'darwin' ? readDarwinProcessTable : readLinuxProcessTable)(list, left);
      if (table !== null) return table;
      try { onFailure?.({ reason: `${process.platform}-process-table-unreadable`, attempt: i + 1, elapsed_ms: Date.now() - started }); } catch { /* diagnostics never change evidence */ }
    }
    return null;
  }
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
    const result = await (seams.query ?? runPs)(cmd, left), parsed = parseTable(result.raw);
    if (result.failure || parsed === null) {
      // Error category and timing only: no command, environment, table or stderr.
      // Diagnostics must not change the three-valued answer or its time budget.
      try { onFailure?.({ ...(result.failure ?? { reason: 'invalid-json' }), attempt: i + 1, elapsed_ms: Date.now() - started }); } catch { /* bookkeeping cannot cost a read */ }
    }
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

function creationEpoch(value, scope = null) {
  const point = creationPoint(normalizeCreationTime(value));
  return point && (scope === null || point.scope === scope) ? point.value : null;
}

/** A PPID snapshot is adjacency, not ownership. Bind every edge to creation order.
 * A keeper-recorded exit permits a historical root: its direct children must have
 * been born during that worker's lifetime, even if the PID is now absent/reused.
 * @param {number} root @param {string|null} recordedCreatedAt @param {Array|null} table
 * @param {{exitedAt?:string|null}} [options]
 */
export function observeDescendants(root, recordedCreatedAt, table, options = {}) {
  const identity = verifyIdentity(root, recordedCreatedAt, table), point = creationPoint(normalizeCreationTime(recordedCreatedAt));
  const scope = point?.scope ?? null, birth = point?.value ?? null;
  const exit = options.exitedAt == null ? null : creationEpoch(options.exitedAt, scope);
  const unknown = (reason, adjacency = false) => ({ state: 'unknown', rootVerified: false, rootIdentity: identity.verdict, reason,
    candidates: adjacency ? descendantsOf(root, table).map(p => ({ ...p, ancestry: 'unknown' })) : [] });
  if (!Number.isSafeInteger(Number(root)) || Number(root) <= 0) return unknown('worker-pid-unreadable');
  if (!table) return unknown('process-table-unreadable');
  if (birth === null) return unknown('worker-creation-time-unreadable', true);
  if (['linux', 'darwin'].includes(point.kind) && tableClockScope(table, identity.found) !== scope) return unknown('worker-clock-scope-unreadable');
  if (options.exitedAt != null && (exit === null || exit < birth)) return unknown('worker-lifetime-unreadable');
  if (identity.verdict !== 'match' && exit === null) return unknown('worker-identity-' + identity.verdict);
  const replacementBirth = identity.verdict !== 'match' && identity.found ? creationEpoch(identity.found.createdAt, scope) : null;
  if (identity.verdict !== 'match' && identity.found && (replacementBirth === null || replacementBirth <= birth)) return unknown('replacement-identity-unreadable');
  const byParent = new Map();
  for (const p of table) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const candidates = [], seen = new Set([Number(root)]), stack = [{ pid: Number(root), birth, ancestry: 'verified' }];
  let uncertain = false;
  while (stack.length) {
    const parent = stack.pop();
    for (const child of byParent.get(parent.pid) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      const at = creationEpoch(child.createdAt, scope);
      // Reject an entire impossible branch; never traverse an older incarnation.
      if (at !== null && (at < birth || parent.birth !== null && at < parent.birth || parent.pid === Number(root) && (exit !== null && at > exit || replacementBirth !== null && at > replacementBirth))) continue;
      const overlapsReplacement = parent.pid === Number(root) && replacementBirth !== null && at === replacementBirth;
      const ancestry = parent.ancestry === 'verified' && at !== null && !overlapsReplacement ? 'verified' : 'unknown';
      if (ancestry === 'unknown') uncertain = true;
      candidates.push({ ...child, ancestry });
      stack.push({ pid: child.pid, birth: at, ancestry });
    }
  }
  return { state: uncertain ? 'unknown' : 'observed', rootVerified: true, rootIdentity: identity.verdict,
    reason: uncertain ? 'descendant-creation-time-unreadable' : null, candidates };
}

/** Remember incarnations, not just PIDs. A later query cannot fill an old missing birth. */
export function rememberDescendants(map, observation) {
  for (const p of observation.candidates) {
    const createdAt = normalizeCreationTime(p.createdAt), key = `${p.pid}@${createdAt ?? '?'}`, previous = map.get(key);
    if (!previous || previous.ancestry !== 'verified' && p.ancestry === 'verified') {
      map.set(key, { pid: p.pid, name: p.name, createdAt, ancestry: p.ancestry });
    }
  }
}

/** Read-only identity classification. A current identity match cannot prove ancestry. */
export function classifyObservedHelpers(map, table) {
  const out = [];
  for (const p of map.values()) {
    const v = verifyIdentity(p.pid, p.createdAt, table);
    if (v.verdict === 'gone' || v.verdict === 'mismatch') continue;
    const verified = v.verdict === 'match' && p.ancestry === 'verified';
    out.push({ pid: p.pid, name: p.name, created_at: p.createdAt, ancestry: p.ancestry,
      state: verified ? 'alive' : 'unknown', ...(verified ? {} : { reason: v.reason || 'ancestry-unverified' }) });
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
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return { verdict: 'unknown', reason: 'no-pid' };
  if (!table) return { verdict: 'unknown', reason: 'process-table-unreadable' };
  const hit = table.find(p => p.pid === Number(pid));
  const recorded = normalizeCreationTime(recordedCreatedAt), point = creationPoint(recorded);
  const scope = tableClockScope(table, hit), currentScope = creationPoint(scope === 'ms' ? 'ms:0' : scope ? `${scope}:0` : null);
  if (typeof recorded === 'string' && /^(?:ticks:|linux:|darwin:)/.test(recorded) && !point) return { verdict: 'unknown', reason: 'native-clock-scope-unreadable', found: hit };
  if (point?.kind === 'darwin') {
    if (currentScope?.kind !== 'darwin') return { verdict: 'unknown', reason: 'native-clock-scope-unreadable', found: hit };
    if (point.boot !== currentScope.boot) return { verdict: 'mismatch', reason: 'boot-changed', found: hit };
  } else if (point?.kind === 'linux') {
    if (currentScope?.kind !== 'linux') return { verdict: 'unknown', reason: 'native-clock-scope-unreadable', found: hit };
    if (point.boot !== currentScope.boot) return { verdict: 'mismatch', reason: 'boot-changed', found: hit };
    if (point.namespace !== currentScope.namespace) return { verdict: 'unknown', reason: 'pid-namespace-unreadable', found: hit };
  } else if (point?.kind === 'wall' && ['linux', 'darwin'].includes(currentScope?.kind)) return { verdict: 'unknown', reason: 'creation-clock-mismatch', found: hit };
  if (!hit) return { verdict: 'gone', reason: 'pid-not-present' };
  if (!recordedCreatedAt) return { verdict: 'unknown', reason: 'no-creation-time-recorded', found: hit };
  if (!hit.createdAt) return { verdict: 'unknown', reason: 'creation-time-unreadable', found: hit };
  return recorded === normalizeCreationTime(hit.createdAt)
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

function signalPosix(pid, processGroup = false) {
  const numericPid = Number(pid);
  // kill(-1, signal) broadcasts to every process the caller may signal; never derive it from PID 1.
  if (!Number.isSafeInteger(numericPid) || numericPid <= 1) {
    return { ok: false, output: `refusing unsafe POSIX process id ${pid}` };
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
  const r = process.platform !== 'win32'
    ? signalPosix(pid)
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
  if (process.platform !== 'win32') {
    if (!hit || hit.pgrp !== Number(pid) || hit.session !== Number(pid)) {
      return { killed: false, verdict: 'unknown', output: `pid ${pid} is not a verified POSIX session leader; refusing process-group kill` };
    }
    const r = signalPosix(pid, true);
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
export async function ownChildCreationTime(pid, { deadlineMs = IDENTITY_QUERY_MS } = {}) {
  const t = await readProcessTable({ deadlineMs, pids: [pid] });
  const hit = t && t.find((p) => p.pid === Number(pid));
  if (!hit || hit.ppid !== process.pid) return null;
  return hit.createdAt ?? null;
}
