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
import { performance } from 'node:perf_hooks';

/**
 * One atomic bind attempt.
 * @returns {Promise<{ok:boolean, server?:import('node:net').Server, code?:string}>}
 */
export function tryListen(name) {
  return new Promise((resolve) => {
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
    server.listen(name, () => {
      if (settled) return;
      settled = true;
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
 * @returns {Promise<{state:'free'|'held'|'held-unresponsive', code:string|null,
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
