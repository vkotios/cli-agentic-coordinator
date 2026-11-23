// Password sign-in for the control-plane GUI (D11): a scrypt hash in a private file, an HttpOnly
// SameSite=Strict session cookie, a CSRF token per session, and a login rate limit. The same
// pattern as IGM's browser_auth.py. The password is never stored, logged or put in a URL.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
/** @returns {Promise<Buffer>} */
const scrypt = (password, salt, keylen, options) => new Promise((resolve, reject) => crypto.scrypt(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key))));
const COST = { N: 16384, r: 8, p: 1, keylen: 32 };
export const MIN_PASSWORD = 12;
export const COOKIE = 'orch_session';
const IDLE_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

export function authFile(stateRoot) {
  return path.join(stateRoot, 'gui', 'auth.json');
}

export function hasPassword(stateRoot) {
  try {
    return typeof JSON.parse(fs.readFileSync(authFile(stateRoot), 'utf8')).hash === 'string';
  } catch {
    return false;
  }
}

export async function setPassword(stateRoot, password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new Error(`the password must be at least ${MIN_PASSWORD} characters`);
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, COST.keylen, { N: COST.N, r: COST.r, p: COST.p });
  const file = authFile(stateRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ hash: `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`, set_at: new Date().toISOString() });
  fs.writeFileSync(file, body, { mode: 0o600 });
}

export async function verifyPassword(stateRoot, password) {
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(authFile(stateRoot), 'utf8')).hash;
  } catch {
    return false;
  }
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || typeof password !== 'string' || password.length > 1024) return false;
  const [, n, r, p, salt, expected] = parts;
  const derived = await scrypt(password, Buffer.from(salt, 'base64'), COST.keylen, { N: Number(n), r: Number(r), p: Number(p) });
  const want = Buffer.from(expected, 'base64');
  return want.length === derived.length && crypto.timingSafeEqual(want, Buffer.from(derived));
}

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

export class Sessions {
  constructor(now = () => Date.now()) {
    this.now = now;
    /** @type {Map<string, any>} */
    this.map = new Map();
    this.failures = new Map();
  }

  create(ip) {
    const token = crypto.randomBytes(32).toString('base64url');
    const session = { id: crypto.randomBytes(6).toString('hex'), csrf: crypto.randomBytes(24).toString('base64url'), created: this.now(), seen: this.now(), ip };
    this.map.set(sha(token), session);
    return { token, session };
  }

  get(token) {
    if (!token) return null;
    const key = sha(token);
    const session = this.map.get(key);
    if (!session) return null;
    const t = this.now();
    if (t - session.seen > IDLE_MS || t - session.created > ABSOLUTE_MS) {
      this.map.delete(key);
      return null;
    }
    session.seen = t;
    return session;
  }

  destroy(token) {
    if (token) this.map.delete(sha(token));
  }

  /** Reserve the one login attempt an address may have in flight (and a global cap). */
  beginLogin(ip) {
    this.inflight = this.inflight || new Set();
    if (this.inflight.has(ip) || this.inflight.size >= 4) return false;
    this.inflight.add(ip);
    return true;
  }

  endLogin(ip) {
    this.inflight?.delete(ip);
  }

  /** Seconds a client must wait after repeated failures; 0 when it may try. */
  blocked(ip) {
    const f = this.failures.get(ip);
    if (!f || f.until <= this.now()) return 0;
    return Math.ceil((f.until - this.now()) / 1000);
  }

  failed(ip) {
    const f = this.failures.get(ip) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= 5) f.until = this.now() + Math.min(15 * 60_000, 60_000 * 2 ** (f.count - 5));
    this.failures.set(ip, f);
  }

  succeeded(ip) {
    this.failures.delete(ip);
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
