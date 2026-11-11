// The only two named-pipe primitives in the kit. No waiting, no protocol.
//
// `tryListen` is the admission act itself: one atomic bind attempt, no retry, no loop.
// `connectHello` is the only way anything else touches the pipe - it CONNECTS, never
// binds (v4 §4: that removes v3 M1's "my own probe looks like a holder" race).
//
// X5 (measured): a successful connect proves nothing about the holder's health - a
// blocked or OS-suspended holder still accepts connections in single-digit ms and
// simply never answers. X6 (measured): a reply is unauthenticated, because a foreign
// second server instance can answer on the same name. A hello therefore corroborates,
// and never authorises.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readProcessTable, verifyIdentity } from './procs.mjs';
import { readDarwinProcessTable } from './darwin-processes.mjs';
import { creationPoint } from './process-time.mjs';

/** Keep POSIX socket endpoints private to this account, matching named-pipe user scope. */
function preparePosixSocketDir(name) {
  if (process.platform === 'win32') return;
  const uid = process.getuid?.();
  if (!Number.isInteger(uid)) throw new Error('cannot determine the POSIX uid for the lane socket');
  // Lane exclusion must not change with inherited TMPDIR/TMP/TEMP settings.
  const expected = path.join('/tmp', `.orch-${uid}`);
  if (path.dirname(name) !== expected || !path.isAbsolute(name)) throw new Error('unsafe POSIX lane socket path');
  try {
    fs.mkdirSync(expected, { mode: 0o700 });
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
  }
  const st = fs.lstatSync(expected);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new Error(`unsafe POSIX lane socket directory: ${expected}`);
  }
}

/** A receipt binds a socket inode to the native incarnation that actually bound it. */
async function recordPosixSocket(name) {
  const socket = fs.lstatSync(name, { bigint: true });
  let createdAt, netns;
  if (process.platform === 'darwin') {
    const table = await readDarwinProcessTable([process.pid], 3000);
    createdAt = table?.find(p => p.pid === process.pid)?.createdAt;
    netns = 'darwin';
  } else {
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const namespace = /^pid:\[([1-9]\d*)\]$/.exec(fs.readlinkSync('/proc/self/ns/pid'));
    const raw = fs.readFileSync('/proc/self/stat', 'utf8'), ticks = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
    if (!namespace || !/^\d+$/.test(ticks)) throw new Error('socket owner identity unavailable');
    createdAt = `linux:${boot}:${namespace[1]}:${ticks}`;
    netns = fs.readlinkSync('/proc/self/ns/net');
  }
  if (!creationPoint(createdAt)) throw new Error('socket owner identity unavailable');
  const receipt = { token: crypto.randomUUID(), pid: process.pid, createdAt,
    netns, dev: String(socket.dev), ino: String(socket.ino), uid: String(socket.uid) };
  const temporary = name + '.owner-' + receipt.token;
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, name + '.owner.json');
  } finally { try { fs.unlinkSync(temporary); } catch { /* already published */ } }
  return receipt;
}

function forgetPosixSocket(name, receipt) {
  try {
    if (JSON.parse(fs.readFileSync(name + '.owner.json', 'utf8')).token === receipt.token) fs.unlinkSync(name + '.owner.json');
  } catch { /* a successor or uncertain receipt is never removed */ }
}

/** Explicit recovery only: a refused connection alone never authorizes unlinking. */
export async function recoverLinuxSocket(name, { readTable = readProcessTable } = {}) {
  if (process.platform === 'win32') return { state: 'not-applicable', removed: [] };
  try {
    preparePosixSocketDir(name);
    const socket = fs.lstatSync(name, { bigint: true }), ownerFile = name + '.owner.json', ownerStat = fs.lstatSync(ownerFile);
    if (!socket.isSocket() || socket.uid !== BigInt(process.getuid()) || !ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.uid !== process.getuid() || ownerStat.size > 4096) return { state: 'unknown', removed: [] };
    const raw = fs.readFileSync(ownerFile, 'utf8'), owner = JSON.parse(raw);
    if (creationPoint(owner.createdAt)?.kind !== process.platform) return { state: 'unknown', removed: [] };
    if (owner.uid !== String(socket.uid) || owner.dev !== String(socket.dev) || owner.ino !== String(socket.ino) || owner.netns !== (process.platform === 'darwin' ? 'darwin' : fs.readlinkSync('/proc/self/ns/net'))) return { state: 'unknown', removed: [] };
    const table = await readTable({ deadlineMs: 3000, pids: [owner.pid] }), verdict = verifyIdentity(owner.pid, owner.createdAt, table).verdict;
    if (!['gone', 'mismatch'].includes(verdict)) return { state: verdict === 'match' ? 'held' : 'unknown', removed: [] };
    const current = fs.lstatSync(name, { bigint: true });
    if (!current.isSocket() || current.uid !== socket.uid || current.dev !== socket.dev || current.ino !== socket.ino || fs.readFileSync(ownerFile, 'utf8') !== raw) return { state: 'unknown', removed: [] };
    fs.unlinkSync(name);
    forgetPosixSocket(name, owner);
    return { state: 'recovered', removed: [name] };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      try { fs.lstatSync(name); } catch (missing) { if (missing?.code === 'ENOENT') return { state: 'absent', removed: [] }; }
    }
    return { state: 'unknown', removed: [] };
  }
}

/**
 * One atomic bind attempt.
 * @returns {Promise<{ok:boolean, server?:import('node:net').Server, code?:string}>}
 */
export function tryListen(name) {
  return new Promise((resolve) => {
    try {
      preparePosixSocketDir(name);
    } catch (e) {
      resolve({ ok: false, code: e?.code || 'UNSAFE-SOCKET-PATH' });
      return;
    }
    let settled = false;
    const server = net.createServer();
    server.on('error', (/** @type {any} */ e) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        /* nothing bound */
      }
      resolve({ ok: false, code: (e && e.code) || 'UNKNOWN' });
    });
    server.listen(name, async () => {
      if (settled) return;
      settled = true;
      if (process.platform !== 'win32') {
        try {
          const receipt = await recordPosixSocket(name);
          server.once('close', () => forgetPosixSocket(name, receipt));
        } catch {
          server.close(() => resolve({ ok: false, code: 'SOCKET-OWNER-UNAVAILABLE' }));
          return;
        }
      }
      resolve({ ok: true, server });
    });
  });
}

/** Bind, then immediately release. Used only to answer "is this name free right now?". */
export async function probeFree(name) {
  const r = await tryListen(name);
  if (!r.ok) return { free: false, code: r.code };
  await new Promise((res) => r.server.close(res));
  return { free: true, code: null };
}

/**
 * Connect once, read one line, hang up. Never binds, never writes, never waits past
 * the deadline.
 *
 * @returns {Promise<{state:'free'|'held'|'held-unresponsive'|'unknown', code:string|null,
 *                    hello:string|null, ms:number}>}
 */
export function connectHello(name, { deadlineMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let done = false;
    let connected = false;
    let buf = '';
    let sock;

    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
      resolve({ hello: null, code: null, ...r, ms: Math.round(performance.now() - t0) });
    };

    const timer = setTimeout(
      // CODE-REVIEW FIX (agy g3): a probe that runs out of time BEFORE connecting has
      // learnt nothing - the holder may simply be slow to accept. That is `unknown`,
      // never `free`. Only a connect ERROR (the name is not served) means free.
      () => finish({ state: connected ? 'held-unresponsive' : 'unknown', code: 'deadline' }),
      deadlineMs,
    );
    timer.unref?.();

    try {
      sock = net.connect(name);
    } catch (e) {
      clearTimeout(timer);
      resolve({ state: 'free', code: (e && e.code) || 'CONNECT-THREW', hello: null, ms: 0 });
      return;
    }
    sock.on('connect', () => {
      connected = true;
    });
    sock.on('error', (/** @type {any} */ e) => {
      // Before connect: the name is not served -> free. After connect: the holder
      // exists but told us nothing -> unresponsive. Never call a reset "free".
      finish({ state: connected ? 'held-unresponsive' : 'free', code: (e && e.code) || 'ERR' });
    });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) finish({ state: 'held', hello: buf.slice(0, nl) });
    });
    sock.on('end', () => {
      finish(buf.trim() ? { state: 'held', hello: buf.trim() } : { state: 'held-unresponsive', code: 'eof-without-hello' });
    });
  });
}
