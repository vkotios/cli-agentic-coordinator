// orch control-plane GUI. Plain ES module, no build step. Everything shown from the server is
// rendered with textContent, never as markup. Destructive actions use the native <dialog>, name
// their target and consequence, focus Cancel first, and (where a reason is recorded) require one.
const $ = (id) => document.getElementById(id);
const SCREENS = ['overview', 'queue', 'claims', 'runs', 'worktrees'];
let csrf = '';
let screen = 'overview';
let epoch = 0;          // bumps on sign-in/out so a late response never repopulates a closed session
let timer = null;
let busy = false;       // a refresh is in flight (polls never overlap)
let lastHtml = '';      // the rendered screen; an unchanged poll leaves the DOM alone
const ui = { expanded: new Set(), project: '', state: '', runDetail: null, stream: 'stdout', job: null, preview: null };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}
const notice = (text) => { $('notice').textContent = text || ''; };
// Coarse on purpose: a time that changes every second would change the page on every poll.
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'under a minute ago' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
};

async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const my = epoch;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const response = await fetch(path, { method, headers, credentials: 'same-origin', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let data;
  try { data = await response.json(); } catch { data = { error: 'The server sent an unreadable answer.' }; }
  if (my !== epoch) throw new Error('Connection changed.');
  if (!response.ok) {
    if (response.status === 401) signedOut('Session expired. Sign in again.');
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.details = data.details || null;
    throw error;
  }
  return data;
}

// ---- dialog ----------------------------------------------------------------------------------

let resolveDialog = null;
function ask({ title, text, action = 'Continue', detail = null, reason = false }) {
  if (resolveDialog) return Promise.resolve(null);
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-detail').hidden = !detail;
  $('confirm-detail').textContent = detail || '';
  $('confirm-reason-field').hidden = !reason;
  $('confirm-reason').value = '';
  $('confirm-accept').textContent = action;
  $('confirm-accept').disabled = reason;
  return new Promise((resolve) => { resolveDialog = resolve; $('confirm').showModal(); $('confirm-cancel').focus(); });
}
function closeDialog(ok) {
  const resolve = resolveDialog; resolveDialog = null;
  const reason = $('confirm-reason').value.trim();
  $('confirm').close();
  resolve?.(ok ? { reason } : null);
}
$('confirm-cancel').onclick = () => closeDialog(false);
$('confirm-accept').onclick = () => closeDialog(true);
$('confirm-reason').addEventListener('input', () => { $('confirm-accept').disabled = !$('confirm-reason').value.trim(); });
$('confirm').addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(false); });

async function act(label, fn) {
  const my = epoch;
  try {
    const result = await fn();
    if (my === epoch) { notice(label); await refresh(true); }
    return result;
  } catch (error) {
    if (my === epoch) notice(error.details?.length ? `${error.message}` : error.message);
    return null;
  }
}

// ---- sign in ---------------------------------------------------------------------------------

function signedOut(message = '') {
  epoch += 1; csrf = ''; clearInterval(timer); timer = null;
  $('login').hidden = false; $('app').hidden = true; $('signout').hidden = true;
  $('connection').textContent = 'DISCONNECTED'; $('connection').className = 'badge';
  $('login-error').textContent = message; $('password').value = '';
  if ($('confirm').open) $('confirm').close();
}
async function signedIn(session) {
  epoch += 1; csrf = session.csrf_token;
  $('login').hidden = true; $('app').hidden = false; $('signout').hidden = false;
  $('connection').textContent = 'CONNECTED'; $('connection').className = 'badge';
  await refresh(true);
  clearInterval(timer);
  timer = setInterval(() => refresh(false), 3000);
}
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('password').value; $('password').value = '';
  if (!password) { $('login-error').textContent = 'Enter the password.'; $('password').focus(); return; }
  $('login-submit').disabled = true;
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    $('login-error').textContent = '';
    await signedIn(data);
  } catch (error) { $('login-error').textContent = error.message; $('password').focus(); }
  finally { $('login-submit').disabled = false; }
});
$('signout').onclick = async () => { try { await api('/api/auth/logout', {}); } catch { /* signing out anyway */ } signedOut('Signed out.'); };

let screenChanged = true;
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => { screen = tab.dataset.screen; ui.runDetail = null; screenChanged = true; refresh(true); });

// ---- screens ---------------------------------------------------------------------------------

async function refresh(force) {
  if ($('app').hidden || (busy && !force)) return;
  busy = true;
  const my = epoch;
  try {
    for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-current', String(tab.dataset.screen === screen));
    // A form the person is typing in is never rebuilt under them.
    if (!force && document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && $('screen').contains(document.activeElement)) return;
    const view = await ({ overview, queue, claims, runs, worktrees }[screen])();
    // Replace the DOM only when something changed: a button must not be swapped between the pointer
    // going down and coming up, and a poll should not flicker.
    if (my === epoch && (force && screenChanged || view.outerHTML !== lastHtml)) { $('screen').replaceChildren(view); lastHtml = view.outerHTML; }
    screenChanged = false;
    $('connection').textContent = 'CONNECTED'; $('connection').className = 'badge';
  } catch (error) {
    if (my === epoch) { $('connection').textContent = 'UNAVAILABLE'; $('connection').className = 'badge warn'; notice(`${error.message} Retrying.`); }
  } finally { busy = false; }
}

const stateChip = (state, tag) => el('span', { class: `state ${state}`, text: tag ? `${state}:${tag}` : state });

async function overview() {
  const o = await api('/api/overview');
  const f = o.foreman;
  const card = (title, ...kids) => el('article', { class: 'card' }, el('h2', { text: title }), ...kids);
  const counts = el('div', { class: 'chips' }, Object.entries(o.counts).map(([k, n]) => el('span', { class: 'chip' }, `${k} `, el('b', { text: n }))));
  const lane = o.lane;
  const gateway = o.igm == null ? el('p', { class: 'small', text: 'No gateway configured. Set one with: orch foreman settings --igmUrl <url>' })
    : o.igm.error ? el('p', { class: 'error', text: `Gateway unreachable: ${o.igm.error}` })
      : el('div', {}, el('div', { class: 'big', text: o.igm.chat_slots ? `${o.igm.chat_slots.total - (o.igm.chat_slots.available ?? 0)}/${o.igm.chat_slots.total} slots busy` : 'slots unknown' }),
        el('p', { class: 'small', text: `${o.igm.loaded_model || 'no model'} · queued ${o.igm.admission?.queue?.length ?? 0} · mode ${o.igm.admission?.mode ?? '?'} · reserved ${o.igm.admission?.reserved_now ?? 0}` }));
  const goals = o.goals.map((g) => el('div', { class: 'item' }, el('span', { class: 'grow', text: `${g.project}/${g.id}: ${g.text}` }), el('span', { class: 'state', text: g.status }),
    g.status === 'proposed' ? el('button', { class: 'small', onclick: () => act(`Goal ${g.id} approved.`, () => api(`/api/goals/${g.project}/${encodeURIComponent(g.id)}/approve`, {})) }, 'Approve') : null));
  const events = o.events.map((e) => el('div', { class: 'item' }, el('span', { class: 'small', text: ago(e.at) }), el('span', { class: 'grow', text: `${e.kind}${e.item ? ' · ' + e.item : ''} · ${e.actor}` })));
  return el('div', { class: 'grid' },
    card('Foreman',
      el('div', { class: 'big', text: f.running ? (f.paused ? 'Paused' : 'Running') : 'Not running' }),
      el('p', { class: 'small', text: f.running ? `pid ${f.holder?.pid ?? '?'}, started ${f.holder?.started_at ? ago(f.holder.started_at) : 'unknown'}` : 'Start it with: orch foreman start (or orch gui serve)' }),
      el('div', { class: 'actions' }, el('button', { class: 'secondary', onclick: async () => {
        const pause = !f.paused;
        const ok = await ask({ title: pause ? 'Pause the Foreman?' : 'Resume the Foreman?', text: pause ? 'Running work is finished and watched. Nothing new starts.' : 'New work starts again.', action: pause ? 'Pause' : 'Resume' });
        if (ok) await act(pause ? 'Paused.' : 'Resumed.', () => api(`/api/foreman/${pause ? 'pause' : 'resume'}`, {}));
      } }, f.paused ? 'Resume' : 'Pause'))),
    card('Queue', counts, el('p', { class: 'small', text: `${o.pending_checks} progress check(s) waiting for a verdict` })),
    card('Local lane', el('div', { class: 'big', text: `${lane.used}/${lane.total} permits used` }),
      el('p', { class: 'small', text: lane.permits.map((p) => `#${p.permit} ${p.state === 'free' ? 'free' : p.holder_run || p.state}`).join(' · ') })),
    card('Inference gateway', gateway),
    card('Goals', el('div', { class: 'list' }, goals.length ? goals : el('p', { class: 'small', text: 'No goals yet. enqueue proposes one.' }))),
    card('Recent activity', el('div', { class: 'list' }, events.length ? events : el('p', { class: 'small', text: 'Nothing yet.' }))));
}

function itemForm(projects) {
  const field = (label, control, wide = false) => el('label', { class: wide ? 'wide' : '' }, label, control);
  const project = el('select', { id: 'f-project' }, projects.map((p) => el('option', { value: p.id, text: p.id })));
  const title = el('input', { id: 'f-title', maxlength: '200' });
  const goal = el('input', { id: 'f-goal', placeholder: 'g1' });
  const size = el('select', { id: 'f-size' }, ['XS', 'S', 'M'].map((s) => el('option', { value: s, text: s })));
  const priority = el('select', { id: 'f-priority' }, ['P2', 'P0', 'P1', 'P3'].map((s) => el('option', { value: s, text: s })));
  const handoff = el('textarea', { id: 'f-handoff', rows: '5', placeholder: 'TASK: ...' });
  const allow = el('textarea', { id: 'f-allow', rows: '3', placeholder: 'one path per line' });
  const accept = el('textarea', { id: 'f-accept', rows: '3', placeholder: 'one command per line, e.g. node --test test/a.test.mjs' });
  const errors = el('div', { class: 'error', role: 'alert', id: 'f-errors' });
  const form = el('form', { class: 'grid-form', novalidate: true, onsubmit: async (event) => {
    event.preventDefault();
    const commands = accept.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => ({ kind: 'command', argv: l.startsWith('[') ? JSON.parse(l) : l.split(/\s+/) }));
    const item = { project: project.value, title: title.value, goal_ref: goal.value || undefined, size: size.value, priority: priority.value, handoff: handoff.value,
      allowlist: allow.value.split('\n').map((l) => l.trim()).filter(Boolean), acceptance: commands };
    errors.textContent = '';
    try {
      const created = await api('/api/items', item);
      notice(`Added ${created.id}.`); form.reset(); await refresh(true);
    } catch (error) { errors.textContent = (error.details && error.details.length ? error.details.join('\n') : error.message); }
  } },
  field('Project', project), field('Title', title), field('Goal', goal), field('Size', size), field('Priority', priority),
  field('Handoff (the worker\'s instructions)', handoff, true), field('Allowed files', allow, true), field('Acceptance commands (an item with none is refused)', accept, true),
  el('div', { class: 'wide' }, errors, el('button', { type: 'submit' }, 'Add item')));
  return el('details', {}, el('summary', { text: 'Add an item' }), form);
}

async function queue() {
  const query = new URLSearchParams();
  if (ui.project) query.set('project', ui.project);
  if (ui.state) query.set('state', ui.state);
  const [list, overviewData, checks] = await Promise.all([api(`/api/items?${query}`), api('/api/overview'), api('/api/checks?status=pending')]);
  const details = new Map(await Promise.all(list.items.filter((i) => ui.expanded.has(i.id)).map(async (i) => [i.id, await api(`/api/items/${i.id}`).catch(() => null)])));
  const projects = overviewData.projects;
  const filters = el('div', { class: 'row' },
    el('select', { 'aria-label': 'Project', onchange: (e) => { ui.project = e.target.value; refresh(true); } }, el('option', { value: '', text: 'All projects' }), projects.map((p) => el('option', { value: p.id, text: p.id, selected: p.id === ui.project }))),
    el('select', { 'aria-label': 'State', onchange: (e) => { ui.state = e.target.value; refresh(true); } }, el('option', { value: '', text: 'All states' }), ['ready', 'blocked', 'running', 'verifying', 'needs-review', 'parked', 'done', 'archived'].map((s) => el('option', { value: s, text: s, selected: s === ui.state }))),
    projects.map((p) => el('button', { class: 'secondary small', onclick: async () => {
      const ok = await ask({ title: `${p.paused ? 'Resume' : 'Pause'} project ${p.id}?`, text: p.paused ? 'Its ready items can start again.' : 'None of its items will start. Running work finishes.', action: p.paused ? 'Resume' : 'Pause' });
      if (ok) await act(`Project ${p.id} ${p.paused ? 'resumed' : 'paused'}.`, () => api(`/api/projects/${p.id}/${p.paused ? 'resume' : 'pause'}`, {}));
    } }, `${p.paused ? 'Resume' : 'Pause'} ${p.id}`)));
  const pendingBox = checks.checks.length ? el('article', { class: 'card' }, el('h2', { text: `${checks.checks.length} check(s) waiting for your verdict` }), checks.checks.map(checkCard)) : null;
  const rows = list.items.map((item) => itemRow(item, details.get(item.id)));
  return el('div', {}, pendingBox, el('article', { class: 'card' }, el('h2', { text: 'Queue' }), filters, itemForm(projects), el('div', { class: 'list' }, rows.length ? rows : el('p', { class: 'small', text: 'No items.' }))));
}

function checkCard(check) {
  const verdict = el('select', { 'aria-label': 'Verdict' }, ['progressing', 'looping', 'off-track', 'blocked', 'unsure'].map((v) => el('option', { value: v, text: v })));
  const reason = el('input', { placeholder: 'one-line reason', 'aria-label': 'Reason' });
  return el('div', { class: 'detail' }, el('div', { class: 'small', text: `Check #${check.id} for ${check.item} (${check.signals?.map((s) => s.kind).join(', ') || 'milestone'}). Packet: ${check.packet_path}` }),
    el('div', { class: 'row' }, verdict, reason, el('button', { class: 'small', onclick: async () => {
      if (!reason.value.trim()) { notice('A verdict needs a one-line reason.'); reason.focus(); return; }
      if (['looping', 'off-track', 'blocked'].includes(verdict.value)) {
        const ok = await ask({ title: `Answer "${verdict.value}"?`, text: `This cancels the run of ${check.item} with your verdict as the recorded reason, and parks the item.`, action: 'Cancel the run' });
        if (!ok) return;
      }
      await act(`Verdict recorded for check #${check.id}.`, () => api(`/api/checks/${check.id}/verdict`, { verdict: verdict.value, reason: reason.value }));
    } }, 'Answer')));
}

function itemRow(item, detail) {
  const open = ui.expanded.has(item.id);
  const row = el('div', {},
    el('div', { class: 'item' }, stateChip(item.state, item.park_tag), el('span', { class: 'state', text: item.priority }),
      el('span', { class: 'grow', text: `${item.id} · ${item.title}${item.paused ? ' (paused)' : ''}` }),
      el('button', { class: 'secondary small', 'aria-expanded': String(open), onclick: () => { if (open) ui.expanded.delete(item.id); else ui.expanded.add(item.id); screenChanged = true; refresh(true); } }, open ? 'Hide' : 'Details')));
  if (open && detail) row.append(el('div', { class: 'detail' }, itemDetail(detail)));
  return row;
}

function itemDetail({ item, events, checks, runs }) {
  const button = (label, onclick, cls = 'secondary small') => el('button', { class: cls, onclick }, label);
  const a = [];
  const post = (verb, body = {}) => api(`/api/items/${item.id}/${verb}`, body);
  if (['ready', 'blocked'].includes(item.state)) a.push(button(item.paused ? 'Resume item' : 'Pause item', () => act('Updated.', () => post('edit', { paused: !item.paused }))));
  if (['ready', 'blocked', 'needs-review'].includes(item.state)) a.push(button('Park…', async () => {
    const r = await ask({ title: `Park ${item.id}?`, text: 'It will not start until you requeue it.', action: 'Park', reason: true });
    if (r) await act('Parked.', () => post('park', { reason: r.reason }));
  }));
  if (['parked', 'needs-review'].includes(item.state)) a.push(button('Requeue', () => act('Back in the queue.', () => post('requeue'))));
  if (item.state === 'needs-review') a.push(button('Accept…', async () => {
    const r = await ask({ title: `Accept ${item.id}?`, text: 'Use this after you have reviewed and merged the work yourself. The Foreman does not merge. Its worktree is kept until you clean it up.', action: 'Accept' });
    if (r) await act('Accepted.', () => post('accept'));
  }, 'small'));
  if (['parked', 'done', 'needs-review'].includes(item.state)) a.push(button('Archive…', async () => {
    const r = await ask({ title: `Archive ${item.id}?`, text: 'It leaves the queue. The record and history are kept.', action: 'Archive' });
    if (r) await act('Archived.', () => post('archive'));
  }));
  if (item.state === 'running') a.push(button('Request progress check now', () => act('A check will run on the next tick.', () => post('check-now'))));
  const priority = el('select', { 'aria-label': 'Priority', onchange: (e) => act('Priority changed.', () => post('edit', { priority: e.target.value })) }, ['P0', 'P1', 'P2', 'P3'].map((p) => el('option', { value: p, text: p, selected: p === item.priority })));
  if (!['running', 'verifying'].includes(item.state)) a.push(priority);
  return el('div', {},
    item.park_reason ? el('p', { class: 'error', text: `Parked (${item.park_tag}): ${item.park_reason}` }) : null,
    el('div', { class: 'small', text: `project ${item.project} · goal ${item.goal_ref || 'none'} · size ${item.size} · latency ${item.latency} · attempt ${item.attempt} · depends on ${item.depends_on.join(', ') || 'nothing'}` }),
    el('h3', { text: 'Acceptance' }), el('pre', { text: item.spec.acceptance.map((c) => c.kind === 'rubric' ? `rubric: ${c.text}` : `${c.kind}: ${c.argv.join(' ')}`).join('\n') }),
    el('h3', { text: 'Allowed files' }), el('pre', { text: item.spec.allowlist.join('\n') }),
    el('div', { class: 'actions' }, a),
    runs.length ? el('div', {}, el('h3', { text: 'Runs' }), runs.map((r) => el('div', { class: 'item' }, el('span', { class: 'grow', text: `attempt ${r.attempt} · ${r.state} · ${r.run_id || 'not started'}${r.worktree ? ' · ' + r.worktree : ''}` }),
      r.run_id ? el('button', { class: 'secondary small', onclick: () => { screen = 'runs'; ui.runDetail = r.run_id; refresh(true); } }, 'Open run') : null))) : null,
    checks.length ? el('div', {}, el('h3', { text: 'Checks' }), checks.map((c) => el('div', { class: 'small', text: `#${c.id} tier ${c.tier} ${c.status}${c.verdict ? ' · ' + c.verdict + ': ' + (c.reason || '') : ''}` }))) : null,
    el('h3', { text: 'History' }), el('div', { class: 'list' }, events.slice(-15).reverse().map((e) => el('div', { class: 'small', text: `${ago(e.at)} · ${e.kind} · ${e.actor}${e.data?.reason ? ' · ' + e.data.reason : ''}` }))));
}

async function claims() {
  const data = await api('/api/claims');
  const claimWp = el('input', { 'aria-label': 'Work package', placeholder: 'work package name' });
  const claimBy = el('select', { 'aria-label': 'Holder' }, ['owner', 'claude-code', 'codex', 'opencode', 'vibe', 'copilot', 'muse', 'foreman'].map((b) => el('option', { value: b, text: b })));
  const rows = data.claims.map((c) => el('div', { class: 'item' },
    el('span', { class: 'grow', text: `${c.wp} · held by ${c.by}${c.claimed_at ? ' · ' + ago(c.claimed_at) : ''}${c.note ? ' · ' + c.note : ''}` }),
    el('button', { class: 'secondary small', onclick: async () => {
      const ok = await ask({ title: `Release ${c.wp}?`, text: 'This frees the claim only. It does not finalise the package or remove its worktrees. Use Finish for that.', action: 'Release' });
      if (ok) await act('Released.', () => api(`/api/claims/${encodeURIComponent(c.wp)}/release`, { by: c.by }));
    } }, 'Release…'),
    el('button', { class: 'secondary small', onclick: async () => {
      const ok = await ask({ title: `Finish ${c.wp}?`, text: 'orch runs its finish checks: every worktree and resource must end removed, pending cleanup or retained with a reason. Nothing unmerged or uncertain is discarded.', action: 'Run finish' });
      if (ok) await act('Finish started.', async () => { const job = await api(`/api/claims/${encodeURIComponent(c.wp)}/finish`, { by: c.by, confirm: true }); ui.job = job.id; });
    } }, 'Finish…')));
  const job = ui.job ? await api(`/api/jobs/${ui.job}`).catch(() => null) : null;
  const jobBox = el('div', {}, job ? el('p', { class: job.state === 'failed' ? 'error' : 'small', text: `Job ${job.name}: ${job.state}${job.outcome ? ' · ' + JSON.stringify(job.outcome).slice(0, 600) : ''}` }) : null);
  return el('article', { class: 'card' }, el('h2', { text: 'Claims' }), jobBox,
    el('div', { class: 'list' }, rows.length ? rows : el('p', { class: 'small', text: 'No claims held.' })),
    el('details', {}, el('summary', { text: 'Claim a work package' }), el('div', { class: 'row' }, claimWp, claimBy,
      el('button', { onclick: async () => { if (!claimWp.value.trim()) { notice('Name the work package.'); return; } await act('Claimed.', () => api('/api/claims', { wp: claimWp.value.trim(), by: claimBy.value })); } }, 'Claim'))));
}

async function runs() {
  if (ui.runDetail) return runDetail(ui.runDetail);
  const data = await api('/api/runs');
  const rows = data.runs.map((r) => el('div', { class: 'item' }, stateChip(r.status), el('span', { class: 'grow', text: `${r.id} · ${r.cli} · ${r.model_canonical || ''}${r.item ? ' · ' + r.item : ''}` }),
    el('button', { class: 'secondary small', onclick: () => { ui.runDetail = r.id; refresh(true); } }, 'Open')));
  return el('article', { class: 'card' }, el('h2', { text: 'Recent runs' }), el('div', { class: 'list' }, rows.length ? rows : el('p', { class: 'small', text: 'No runs yet.' })));
}

async function runDetail(id) {
  const [d, log] = await Promise.all([api(`/api/runs/${id}`), api(`/api/runs/${id}/log?stream=${ui.stream}&tail=150`).catch(() => ({ lines: [] }))]);
  const r = d.run;
  const active = ['queued', 'running', 'running_quiet', 'suspected_stall'].includes(r.derived_status || r.status);
  return el('article', { class: 'card' },
    el('div', { class: 'row' }, el('button', { class: 'secondary small', onclick: () => { ui.runDetail = null; refresh(true); } }, 'Back to runs'), stateChip(r.derived_status || r.status), el('span', { class: 'small', text: `${id}${d.item ? ' · ' + d.item : ''}` })),
    el('p', { class: 'small', text: `${r.cli || ''} · ${r.model_canonical || r.model_requested || ''} · ${r.lane_state || ''} · ${r.derived_reason || r.reason || ''}` }),
    el('div', { class: 'row' }, el('select', { 'aria-label': 'Log stream', onchange: (e) => { ui.stream = e.target.value; refresh(true); } }, ['stdout', 'stderr', 'keeper'].map((s) => el('option', { value: s, text: s, selected: s === ui.stream }))),
      el('button', { class: 'secondary small', onclick: async () => { const res = await api(`/api/runs/${id}/result`).catch((e) => ({ result: e.message })); await ask({ title: 'Run result', text: 'The compact result orch recorded.', detail: typeof res.result === 'string' ? res.result : JSON.stringify(res.result, null, 2), action: 'Close' }); } }, 'Result'),
      active ? el('button', { class: 'danger small', onclick: async () => {
        const reason = await ask({ title: `Cancel run ${id}?`, text: 'The worker is stopped now and its current turn is lost. The item is parked with your reason. orch verifies the worker is gone first.', action: 'Cancel the run', reason: true });
        if (reason) await act('Cancel requested.', () => api(`/api/runs/${id}/cancel`, { reason: reason.reason, confirm: true }));
      } }, 'Cancel run…') : null,
      d.item && active ? el('button', { class: 'secondary small', onclick: () => act('A check will run on the next tick.', () => api(`/api/items/${d.item}/check-now`, {})) }, 'Request progress check now') : null),
    el('pre', { class: 'log', text: log.lines.join('\n') || '(no output yet)' }));
}

async function worktrees() {
  const data = await api('/api/worktrees');
  const wp = el('input', { 'aria-label': 'Work package', placeholder: 'work package name' });
  const by = el('select', { 'aria-label': 'Claim holder' }, ['owner', 'foreman', 'claude-code', 'codex', 'opencode', 'vibe', 'copilot', 'muse'].map((b) => el('option', { value: b, text: b })));
  const out = el('div', { id: 'preview' });
  const show = () => { if (ui.preview) out.replaceChildren(previewView(ui.preview, by)); };
  show();
  const list = (Array.isArray(data.worktrees) ? data.worktrees : []).map((w) => el('div', { class: 'item' }, el('span', { class: 'grow', text: `${w.wp || ''}/${w.slice || ''} · ${w.path || w.id}${w.branch ? ' · ' + w.branch : ''}` })));
  return el('div', { class: 'grid' },
    el('article', { class: 'card' }, el('h2', { text: 'Worktrees' }), el('div', { class: 'list' }, list.length ? list : el('p', { class: 'small', text: 'No worktrees recorded.' }))),
    el('article', { class: 'card' }, el('h2', { text: 'Cleanup' }),
      el('p', { class: 'small', text: 'Preview first. Apply lists exactly what orch will remove and refuses where ownership is not proven. Apply needs the claim holder.' }),
      el('div', { class: 'row' }, wp, by, el('button', { class: 'secondary', onclick: async () => {
        if (!wp.value.trim()) { notice('Name the work package.'); return; }
        const my = epoch;
        try { ui.preview = await api('/api/cleanup/preview', { wp: wp.value.trim() }); if (my === epoch) { notice(''); show(); } } catch (error) { notice(error.message); }
      } }, 'Preview cleanup')), out));
}

function previewView(p, by) {
  const resources = p.preview?.resources || [];
  const lines = resources.map((r) => `${r.kind || 'resource'}  ${r.state || r.action || ''}  ${r.path || r.id || ''}${r.reason ? '  (' + r.reason + ')' : ''}`);
  return el('div', { class: 'detail' }, el('p', { class: 'small', text: `Preview for ${p.wp}: ${p.preview?.state || 'no state'}` }),
    el('pre', { text: lines.join('\n') || JSON.stringify(p.preview, null, 2) }),
    el('button', { class: 'danger', onclick: async () => {
      const ok = await ask({ title: `Apply cleanup for ${p.wp}?`, text: 'orch removes exactly the resources below, and only where it can prove ownership. Unmerged or uncertain work is kept.', detail: lines.join('\n') || JSON.stringify(p.preview, null, 2), action: 'Apply cleanup' });
      if (ok) await act('Cleanup started.', async () => { const job = await api('/api/cleanup/apply', { wp: p.wp, by: by.value, confirm: true }); notice(`Cleanup job ${job.id} started.`); ui.job = job.id; });
    } }, 'Apply cleanup…'));
}

// ---- start -----------------------------------------------------------------------------------

(async () => {
  try {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
    if (response.ok) await signedIn(await response.json());
    else signedOut('');
  } catch { signedOut('The server is not reachable.'); }
})();
