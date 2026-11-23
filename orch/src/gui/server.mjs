// The control-plane web GUI for orch (DESIGN.md section 3.8, D10, D11).
//
// A small `node:http` server: static pages plus a JSON API under /api/. Every action calls an
// engine function (`foreman/api.mjs`, or `runCommand` through `makeCall`), never a
// re-implementation, so the safety checks of the CLI apply unchanged. Every mutation is written
// to the Foreman's audit log with the browser session that took it. Reachable on a LAN address
// only behind a password (HttpOnly cookie, CSRF token, Host and Origin checks, login rate limit).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { OrchError } from '../errors.mjs';
import { laneOccupancy } from '../commands.mjs';
import { Store } from '../foreman/store.mjs';
import { makeCall } from '../foreman/engine.mjs';
import { foremanHolder } from '../foreman/lock.mjs';
import { readSettings, saveSettings } from '../foreman/settings.mjs';
import { IgmClient } from '../foreman/igm.mjs';
import * as fm from '../foreman/api.mjs';
import { Sessions, COOKIE, parseCookies, verifyPassword, hasPassword } from './auth.mjs';

const GUI_DIR = path.resolve(fileURLToPath(new URL('../../gui/', import.meta.url)));
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const MAX_BODY = 256 * 1024;
const WP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const RUN = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;
const CLAIMANTS = new Set(['owner', 'claude-code', 'codex', 'opencode', 'vibe', 'copilot', 'muse', 'foreman']);

class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);

/**
 * @param {{stateRoot?: string|null, host?: string, port?: number, allowedHosts?: string[], igm?: any, log?: (s: string) => void, now?: () => number, inProcessForeman?: boolean}} options
 * @returns {Promise<{server: http.Server, port: number, host: string, close: () => Promise<void>, sessions: Sessions}>}
 */
export async function startGui(options = {}) {
  const cfg = loadConfig(options.stateRoot ?? null);
  const host = options.host ?? '127.0.0.1';
  const log = options.log ?? (() => {});
  const passwordSet = hasPassword(cfg.stateRoot);
  if (!isLoopback(host) && !passwordSet) {
    throw new OrchError(`refusing to listen on ${host}: set a password first (orch gui set-password); a LAN address is never served without one`, 'gui-no-password');
  }
  const store = Store.open(cfg.stateRoot);
  const call = makeCall(cfg.stateRoot);
  const sessions = new Sessions(options.now);
  const jobs = new Map();
  const igmCache = { at: 0, value: null };
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', host, ...(options.allowedHosts ?? [])].map((h) => String(h).toLowerCase()));

  const settingsNow = () => readSettings(store);

  function igmStatus() {
    const s = settingsNow();
    if (!s.igmUrl) return Promise.resolve(null);
    if (Date.now() - igmCache.at < 4000) return Promise.resolve(igmCache.value);
    const client = options.igm ?? new IgmClient({ baseUrl: s.igmUrl, keyEnv: s.igmKeyEnv });
    return client.status().then((v) => v, (e) => ({ error: String(e.message || e) })).then((v) => { igmCache.at = Date.now(); igmCache.value = v; return v; });
  }

  // ---- helpers ------------------------------------------------------------------------------

  function audit(session, action, target, ok, extra = {}) {
    try {
      store.event('gui-action', { item: target?.item ?? null, run: target?.run ?? null, actor: `gui:${session.id}`, data: { action, target, ok, ...extra } });
    } catch (error) {
      log(`audit write failed: ${error.message}`);
    }
  }

  const need = (cond, message, status = 400) => { if (!cond) throw new HttpError(status, message); };
  const reasonOf = (body) => {
    const r = typeof body.reason === 'string' ? body.reason.trim() : '';
    need(r.length > 0 && r.length <= 500, 'a reason is required (at most 500 characters)');
    return r;
  };
  const wpOf = (value) => { need(typeof value === 'string' && WP.test(value), 'invalid work package name'); return value; };
  const runOf = (value) => { need(typeof value === 'string' && RUN.test(value), 'invalid run id'); return value; };
  const byOf = (value) => { const by = value ?? 'owner'; need(CLAIMANTS.has(by), 'unknown claimant'); return by; };
  const fail = (result, what) => { throw new HttpError(result.exitCode === 3 ? 409 : 502, `${what}: ${result.error || result.out?.reason || result.text.slice(0, 300) || 'exit ' + result.exitCode}`, result.code); };

  function startJob(name, session, fn) {
    const id = crypto.randomBytes(6).toString('hex');
    const job = { id, name, state: 'running', started_at: new Date().toISOString(), outcome: null };
    jobs.set(id, job);
    if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
    Promise.resolve().then(fn).then(
      (outcome) => { job.state = 'done'; job.outcome = outcome; audit(session, `${name}:finished`, { job: id }, true); },
      (error) => { job.state = 'failed'; job.outcome = { error: String(error.message || error) }; audit(session, `${name}:finished`, { job: id }, false, { error: job.outcome.error }); },
    );
    return job;
  }

  const itemView = ({ spec, ...rest }) => rest;

  // ---- the API --------------------------------------------------------------------------------

  /** Each route: [method, regex, handler(ctx)]. `ctx` has params, body, session, query. */
  const routes = [];
  const route = (method, pattern, handler, { mutates = method !== 'GET' } = {}) => routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler, mutates });

  route('GET', '/api/overview', async () => {
    const settings = settingsNow();
    const holder = await foremanHolder(cfg.stateRoot);
    return {
      foreman: { running: holder !== null, holder, paused: settings.paused, in_process: options.inProcessForeman === true },
      counts: store.counts(),
      lane: await laneOccupancy(cfg, 'local'),
      igm: await igmStatus(),
      pending_checks: store.listChecks({ status: 'pending' }).length,
      projects: store.listProjects(),
      goals: store.listGoals(),
      events: store.events({ after: Math.max(0, Number(store.q('SELECT COALESCE(MAX(seq),0) AS m FROM events').get().m) - 15), limit: 15 }).reverse(),
      settings: { tickSeconds: settings.tickSeconds, maxConcurrent: settings.maxConcurrent, igmUrl: settings.igmUrl },
    };
  });

  route('POST', '/api/foreman/(pause|resume)', async ({ params, session }) => {
    saveSettings(store, { paused: params[0] === 'pause' }, `gui:${session.id}`);
    audit(session, `foreman:${params[0]}`, {}, true);
    return { paused: params[0] === 'pause' };
  });

  route('GET', '/api/items', async ({ query }) => ({ items: store.listItems({ project: query.get('project') || undefined, state: query.get('state') || undefined }).map(itemView) }));
  route('GET', '/api/items/([a-z0-9-]+-\\d{4,})', async ({ params }) => {
    const item = store.getItem(params[0]);
    need(item, 'no such item', 404);
    return { item, events: store.events({ item: params[0], limit: 100 }), checks: store.listChecks({ item: params[0] }), runs: store.runsFor(params[0]) };
  });
  route('POST', '/api/items', async ({ body, session }) => {
    const created = fm.enqueue(store, body, `gui:${session.id}`);
    audit(session, 'enqueue', { item: created.id }, true);
    return itemView(created);
  });
  route('POST', '/api/items/([a-z0-9-]+-\\d{4,})/(park|requeue|archive|accept|edit|check-now)', async ({ params, body, session }) => {
    const [id, action] = params;
    const actor = `gui:${session.id}`;
    let result;
    if (action === 'park') result = fm.parkItem(store, id, reasonOf(body), actor, body.tag || 'operator');
    else if (action === 'requeue') result = fm.requeueItem(store, id, actor, body.reason ? String(body.reason).slice(0, 200) : 'requeued from the GUI');
    else if (action === 'archive') result = fm.archiveItem(store, id, actor);
    else if (action === 'accept') result = store.transition(id, 'done', { actor, reason: body.note ? String(body.note).slice(0, 300) : 'accepted from the GUI (merged outside the Foreman)' });
    else if (action === 'check-now') return (audit(session, 'check-now', { item: id }, true), fm.requestCheckNow(store, id, actor));
    else {
      const fields = {};
      for (const key of ['priority', 'latency', 'paused']) if (body[key] !== undefined) fields[key] = body[key];
      result = store.updateItem(id, fields, actor);
    }
    audit(session, action, { item: id }, true, action === 'park' ? { reason: body.reason } : {});
    return itemView(result);
  });
  route('POST', '/api/projects/([a-z0-9-]+)/(pause|resume)', async ({ params, session }) => {
    const p = store.setProjectPaused(params[0], params[1] === 'pause', `gui:${session.id}`);
    audit(session, `project:${params[1]}`, { project: params[0] }, true);
    return p;
  });
  route('POST', '/api/goals/([a-z0-9-]+)/([^/]+)/(approve|retire)', async ({ params, body, session }) => {
    const goal = store.setGoalStatus(params[0], decodeURIComponent(params[1]), params[2] === 'approve' ? 'approved' : 'retired', `gui:${session.id}`, typeof body.text === 'string' ? body.text.slice(0, 300) : undefined);
    audit(session, `goal:${params[2]}`, { project: params[0], goal: params[1] }, true);
    return goal;
  });

  route('GET', '/api/checks', async ({ query }) => ({ checks: store.listChecks({ status: query.get('status') || undefined }) }));
  route('POST', '/api/checks/(\\d+)/verdict', async ({ params, body, session }) => {
    const c = fm.answerCheck(store, Number(params[0]), { verdict: body.verdict, reason: body.reason, tag: body.tag ?? null }, `gui:${session.id}`);
    audit(session, 'verdict', { check: c.id, item: c.item, run: c.run }, true, { verdict: c.verdict });
    return c;
  });

  route('GET', '/api/claims', async () => {
    const r = await call(['claims']);
    if (!r.ok) fail(r, 'claims');
    return { claims: Array.isArray(r.out) ? r.out : r.out?.claims ?? [] };
  });
  route('POST', '/api/claims', async ({ body, session }) => {
    const wp = wpOf(body.wp);
    const by = byOf(body.by);
    const r = await call(['claim', wp, '--by', by]);
    audit(session, 'claim', { wp, by }, r.ok, r.ok ? {} : { error: r.error || r.text });
    if (!r.ok) fail(r, 'claim');
    return r.out;
  });
  route('POST', '/api/claims/([A-Za-z0-9][A-Za-z0-9._-]{0,79})/release', async ({ params, body, session }) => {
    const by = byOf(body.by);
    const argv = ['release', params[0], '--by', by];
    if (body.force === true) argv.push('--force', '--reason', reasonOf(body));
    const r = await call(argv);
    audit(session, body.force === true ? 'release:force' : 'release', { wp: params[0], by }, r.ok, { reason: body.reason ?? null });
    if (!r.ok) fail(r, 'release');
    return r.out;
  });
  route('POST', '/api/claims/([A-Za-z0-9][A-Za-z0-9._-]{0,79})/finish', async ({ params, body, session }) => {
    const wp = params[0];
    const by = byOf(body.by);
    need(body.confirm === true, 'finish needs an explicit confirmation');
    const job = startJob('finish', session, async () => {
      const r = await call(['finish', wp, '--by', by]);
      return { exit_code: r.exitCode, out: r.out, error: r.error };
    });
    audit(session, 'finish', { wp, by, job: job.id }, true);
    return job;
  });

  route('GET', '/api/runs', async () => {
    const r = await call(['list']);
    if (!r.ok && !Array.isArray(r.out)) fail(r, 'list runs');
    const runs = (Array.isArray(r.out) ? r.out : []).slice(-60).reverse();
    const byRun = new Map();
    for (const row of store.q('SELECT item, run_id FROM runs WHERE run_id IS NOT NULL').all()) byRun.set(row.run_id, row.item);
    return { runs: runs.map((x) => ({ ...x, item: byRun.get(x.id) ?? null })) };
  });
  route('GET', '/api/runs/([0-9-]+[0-9a-f]{6})', async ({ params }) => {
    const r = await call(['status', runOf(params[0])]);
    need(r.out?.runs?.[0], r.error || 'no such run', 404);
    return { run: r.out.runs[0], item: store.q('SELECT item FROM runs WHERE run_id = ?').get(params[0])?.item ?? null };
  });
  route('GET', '/api/runs/([0-9-]+[0-9a-f]{6})/log', async ({ params, query }) => {
    const stream = ['stdout', 'stderr', 'keeper'].includes(query.get('stream')) ? query.get('stream') : 'stdout';
    const tail = Math.min(400, Math.max(10, Number(query.get('tail')) || 120));
    const r = await call(['log', runOf(params[0]), '--stream', stream, '--tail', String(tail)]);
    need(r.ok || r.text, r.error || 'no log', 404);
    return { stream, lines: r.text.split(/\r?\n/).slice(-tail) };
  });
  route('GET', '/api/runs/([0-9-]+[0-9a-f]{6})/result', async ({ params }) => {
    const r = await call(['result', runOf(params[0])]);
    need(r.out || r.text, r.error || 'no result', 404);
    return { result: r.out ?? r.text };
  });
  route('POST', '/api/runs/([0-9-]+[0-9a-f]{6})/cancel', async ({ params, body, session }) => {
    const id = runOf(params[0]);
    const reason = reasonOf(body);
    need(body.confirm === true, 'cancel needs an explicit confirmation');
    const item = store.q('SELECT item FROM runs WHERE run_id = ?').get(id)?.item ?? null;
    if (item) store.kvSet(`park:${item}`, JSON.stringify({ tag: 'operator', reason: `cancelled from the GUI: ${reason}` }));
    const r = await call(['cancel', id]);
    audit(session, 'cancel', { run: id, item }, r.ok, { reason });
    if (!r.ok) fail(r, 'cancel');
    return r.out;
  });

  route('GET', '/api/worktrees', async () => {
    const r = await call(['worktree', 'list']);
    if (!r.ok) fail(r, 'worktree list');
    return { worktrees: Array.isArray(r.out) ? r.out : r.out?.worktrees ?? r.out ?? [] };
  });
  route('POST', '/api/cleanup/preview', async ({ body, session }) => {
    const wp = wpOf(body.wp);
    const r = await call(['cleanup', '--wp', wp, '--dry-run']);
    audit(session, 'cleanup:preview', { wp }, r.ok);
    if (!r.out) fail(r, 'cleanup preview');
    return { wp, exit_code: r.exitCode, preview: r.out };
  });
  route('POST', '/api/cleanup/apply', async ({ body, session }) => {
    const wp = wpOf(body.wp);
    const by = byOf(body.by);
    need(body.confirm === true, 'cleanup needs an explicit confirmation of the previewed list');
    const job = startJob('cleanup', session, async () => {
      const r = await call(['cleanup', '--wp', wp, '--apply', '--by', by]);
      return { exit_code: r.exitCode, out: r.out, error: r.error };
    });
    audit(session, 'cleanup:apply', { wp, by, job: job.id }, true);
    return job;
  });
  route('GET', '/api/jobs/([0-9a-f]+)', async ({ params }) => {
    const job = jobs.get(params[0]);
    need(job, 'no such job', 404);
    return job;
  });
  route('GET', '/api/audit', async ({ query }) => {
    const rows = store.q("SELECT seq FROM events WHERE kind = 'gui-action' ORDER BY seq DESC LIMIT ?").all(Math.min(200, Number(query.get('limit')) || 50)).map((r) => r.seq);
    return { actions: rows.length ? store.events({ after: Math.min(...rows) - 1, limit: 500 }).filter((e) => e.kind === 'gui-action').reverse() : [] };
  });

  // ---- request handling -----------------------------------------------------------------------

  function send(res, status, body, headers = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': typeof body === 'string' ? headers['Content-Type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
      ...headers,
    });
    res.end(text);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => req.destroy(new Error('body timeout')), 15000);
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new HttpError(413, 'body too large');
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(408, 'the request body did not arrive in time');
    } finally {
      clearTimeout(timer);
    }
    if (!size) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      need(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'the body must be a JSON object');
      return parsed;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'the body is not valid JSON');
    }
  }

  const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://x');
    // DNS rebinding and wrong-address defence: only known host names are served.
    const hostHeader = String(req.headers.host || '').toLowerCase();
    const hostName = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
    if (!allowedHosts.has(hostName)) return send(res, 403, { error: 'Host not allowed' });

    if (req.method === 'GET' && STATIC.has(url.pathname)) {
      const [file, type] = STATIC.get(url.pathname);
      try {
        return send(res, 200, fs.readFileSync(path.join(GUI_DIR, file), 'utf8'), { 'Content-Type': type });
      } catch {
        return send(res, 404, { error: 'not found' });
      }
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    const cookies = parseCookies(req.headers.cookie);
    const ip = req.socket.remoteAddress || '?';

    // ---- sign in, out and the session probe (no session needed for the first two) ----
    if (url.pathname === '/api/auth/config' && req.method === 'GET') return send(res, 200, { password: passwordSet || !isLoopback(host), loopback_only: isLoopback(host) });
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 415, { error: 'JSON required' });
      const wait = sessions.blocked(ip);
      if (wait) return send(res, 429, { error: `too many attempts; try again in ${wait} s` }, { 'Retry-After': String(wait) });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'Cross-origin sign-in refused' });
      // Read the body first (size cap and a time limit), so a slow client never holds a slot.
      const body = await readBody(req);
      // The hash takes tens of milliseconds, so a burst could pass the lockout check before any failure is
      // counted: one hash per address at a time, and a global cap, closes that. The slot covers the hash only.
      if (!sessions.beginLogin(ip)) return send(res, 429, { error: 'another sign-in attempt is in progress; try again in a moment' }, { 'Retry-After': '1' });
      let good = false;
      try {
        good = await verifyPassword(cfg.stateRoot, body.password);
      } finally {
        sessions.endLogin(ip);
      }
      if (!good) {
        sessions.failed(ip);
        return send(res, 401, { error: 'Invalid password' });
      }
      sessions.succeeded(ip);
      const { token, session } = sessions.create(ip);
      return send(res, 200, { authenticated: true, csrf_token: session.csrf, session_id: session.id }, { 'Set-Cookie': sessionCookie(token, 12 * 3600) });
    }
    const session = sessions.get(cookies[COOKIE]);
    if (!session) {
      // A loopback server with no password configured is open to this machine only.
      if (!(isLoopback(host) && !passwordSet && isLoopback(String(req.socket.remoteAddress || '').replace('::ffff:', '')))) return send(res, 401, { error: 'Sign in required' });
    }
    const effective = session || (() => { const s = sessions.create(ip); return s.session; })();
    if (url.pathname === '/api/auth/session' && req.method === 'GET') return send(res, 200, { authenticated: true, csrf_token: effective.csrf, session_id: effective.id });
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      if (req.headers['x-csrf-token'] !== effective.csrf) return send(res, 403, { error: 'CSRF token missing or wrong' });
      sessions.destroy(cookies[COOKIE]);
      return send(res, 200, { authenticated: false }, { 'Set-Cookie': sessionCookie('', 0) });
    }

    const found = routes.map((r) => ({ r, m: r.pattern.exec(url.pathname) })).find((x) => x.m && x.r.method === req.method);
    if (!found) return send(res, 404, { error: 'not found' });
    if (found.r.mutates) {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'Cross-origin request refused' });
      if (req.headers['x-csrf-token'] !== effective.csrf) return send(res, 403, { error: 'CSRF token missing or wrong' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 415, { error: 'JSON required' });
    }
    try {
      const body = found.r.mutates ? await readBody(req) : {};
      const result = await found.r.handler({ params: found.m.slice(1), body, session: effective, query: url.searchParams });
      return send(res, 200, result);
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message, code: error.code });
      if (error instanceof OrchError) {
        const refused = error.code === 'foreman-bad-item';
        return send(res, refused ? 422 : 409, { error: error.message, code: error.code, details: /** @type {any} */ (error).details ?? null });
      }
      log(`unexpected error on ${req.method} ${url.pathname}: ${error && error.stack ? error.stack : error}`);
      return send(res, 500, { error: 'unexpected error (see the server log)' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((error) => { log(`handler failed: ${error && error.message}`); try { send(res, 500, { error: 'unexpected error' }); } catch { /* connection gone */ } }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 7842, host, () => resolve(undefined)); });
  const address = /** @type {any} */ (server.address());
  return {
    server,
    sessions,
    host,
    port: address.port,
    close: () => new Promise((resolve) => { server.close(() => { store.close(); resolve(); }); server.closeAllConnections?.(); }),
  };
}
