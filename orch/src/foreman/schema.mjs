// Work-item schema for the Foreman (DESIGN.md section 3.4). Pure: no I/O, no clock.
//
// `validateItem` never throws on bad input; it returns every problem at once so a frontier
// session or the GUI form can fix them in one round. An item with no acceptance check is
// refused: the Foreman only runs work that can be checked mechanically or is explicitly
// marked for review.

export const STATES = ['ready', 'blocked', 'running', 'verifying', 'needs-review', 'parked', 'done', 'archived'];
export const DOMAINS = ['code', 'academic', 'work'];
export const SIZES = ['XS', 'S', 'M'];
export const LATENCIES = ['blocking', 'today', 'whenever'];
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const REVIEWS = ['full', 'light'];
export const PARK_TAGS = ['spec-ambiguous', 'flaky-test', 'timeout', 'scope-violation', 'capability-wall', 'needs-input', 'check-failed', 'setup-failed', 'operator'];
export const ACCEPTANCE_KINDS = ['command', 'validator', 'rubric'];

export const MAX_HANDOFF_BYTES = 64 * 1024;
export const MAX_ACCEPTANCE = 16;
export const MAX_ALLOWLIST = 200;
const ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,30}-\d{4,}$/;

/** Allowed state transitions. The store refuses anything else. */
export const TRANSITIONS = {
  ready: ['running', 'blocked', 'parked', 'archived'],
  blocked: ['ready', 'parked', 'archived'],
  running: ['verifying', 'parked', 'ready'],
  verifying: ['needs-review', 'done', 'parked'],
  'needs-review': ['done', 'parked', 'ready', 'archived'],
  parked: ['ready', 'archived'],
  done: ['archived'],
  archived: [],
};

export function isProjectId(value) {
  return typeof value === 'string' && ID.test(value);
}

export function isItemId(value) {
  return typeof value === 'string' && ITEM_ID.test(value);
}

export const SETUP_DEFAULT_TIMEOUT_S = 900;
export const SETUP_MAX_TIMEOUT_S = 3600;
export const SETUP_MAX_ARGV = 32;

/**
 * A project's setup command: one argv list (never a shell string) that runs once in each fresh
 * worktree before the worker starts, for example `["npm","ci"]`. Returns `{ok, setup, error}`;
 * `setup` is `{argv, timeout_s}` or null (clear it).
 * @param {unknown} argv an array of strings, or null / [] to clear
 * @param {unknown} [timeoutS]
 */
export function validateSetup(argv, timeoutS) {
  if (argv === null || argv === undefined || (Array.isArray(argv) && argv.length === 0)) return { ok: true, setup: null, error: null };
  if (!Array.isArray(argv) || argv.length > SETUP_MAX_ARGV || !argv.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 4096 && !a.includes('\0'))) {
    return { ok: false, setup: null, error: `setup must be a JSON array of 1 to ${SETUP_MAX_ARGV} non-empty strings, for example ["npm","ci"]` };
  }
  const seconds = timeoutS === undefined || timeoutS === null || timeoutS === '' ? SETUP_DEFAULT_TIMEOUT_S : Number(timeoutS);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > SETUP_MAX_TIMEOUT_S) {
    return { ok: false, setup: null, error: `setup timeout must be a whole number of seconds from 1 to ${SETUP_MAX_TIMEOUT_S}` };
  }
  return { ok: true, setup: { argv: [...argv], timeout_s: seconds }, error: null };
}

const isString = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function relativePath(p) {
  if (typeof p !== 'string' || !p || p.length > 300 || p.includes('\0')) return false;
  if (/^([a-zA-Z]:|[\\/])/.test(p)) return false; // absolute
  return !p.split(/[\\/]/).some((part) => part === '..');
}

function validateAcceptance(list, errors) {
  if (!Array.isArray(list) || list.length === 0) {
    errors.push('acceptance: at least one acceptance check is required (a command, a validator or a rubric); an item with none is refused');
    return [];
  }
  if (list.length > MAX_ACCEPTANCE) errors.push(`acceptance: at most ${MAX_ACCEPTANCE} checks`);
  const out = [];
  list.slice(0, MAX_ACCEPTANCE).forEach((check, i) => {
    const at = `acceptance[${i}]`;
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    if (!ACCEPTANCE_KINDS.includes(check.kind)) {
      errors.push(`${at}.kind: must be one of ${ACCEPTANCE_KINDS.join(', ')}`);
      return;
    }
    if (check.kind === 'rubric') {
      if (!isString(check.text, 4000)) errors.push(`${at}.text: a rubric needs its text (at most 4000 characters)`);
      else out.push({ kind: 'rubric', text: check.text.trim() });
      return;
    }
    // command and validator: argv only, never a shell string.
    if (!Array.isArray(check.argv) || check.argv.length === 0 || check.argv.length > 64 || check.argv.some((a) => typeof a !== 'string' || !a || a.includes('\0') || a.length > 2000)) {
      errors.push(`${at}.argv: a non-empty array of non-empty strings (no shell string)`);
      return;
    }
    if (check.cwd !== undefined && !relativePath(check.cwd) && check.cwd !== '.') errors.push(`${at}.cwd: a relative path inside the worktree`);
    const entry = { kind: check.kind, argv: check.argv.slice() };
    if (check.cwd !== undefined) entry.cwd = check.cwd;
    if (check.timeout_s !== undefined) {
      if (!Number.isInteger(check.timeout_s) || check.timeout_s < 1 || check.timeout_s > 3600) errors.push(`${at}.timeout_s: a whole number from 1 to 3600`);
      else entry.timeout_s = check.timeout_s;
    }
    out.push(entry);
  });
  return out;
}

/**
 * @param {any} raw
 * @returns {{ok:true, item:any, errors:[]} | {ok:false, item:null, errors:string[]}}
 */
export function validateItem(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, item: null, errors: ['the item must be a JSON object'] };
  const known = new Set(['project', 'title', 'domain', 'goal_ref', 'allowlist', 'acceptance', 'context_budget', 'size', 'capability', 'latency',
    'priority', 'depends_on', 'review', 'handoff', 'route', 'notes']);
  for (const key of Object.keys(raw)) if (!known.has(key)) errors.push(`${key}: unknown field`);

  if (!isProjectId(raw.project)) errors.push('project: a registered project id (lowercase letters, digits, hyphen; at most 31 characters)');
  if (!isString(raw.title, 200)) errors.push('title: required, at most 200 characters');
  const domain = raw.domain ?? 'code';
  if (!DOMAINS.includes(domain)) errors.push(`domain: one of ${DOMAINS.join(', ')}`);
  const size = raw.size ?? 'S';
  if (!SIZES.includes(size)) errors.push(`size: one of ${SIZES.join(', ')}`);
  const latency = raw.latency ?? 'whenever';
  if (!LATENCIES.includes(latency)) errors.push(`latency: one of ${LATENCIES.join(', ')}`);
  const priority = raw.priority ?? 'P2';
  if (!PRIORITIES.includes(priority)) errors.push(`priority: one of ${PRIORITIES.join(', ')}`);
  const review = raw.review ?? 'full';
  if (!REVIEWS.includes(review)) errors.push(`review: one of ${REVIEWS.join(', ')}`);
  let goalRef = null;
  if (raw.goal_ref !== undefined && raw.goal_ref !== null) {
    if (!isString(raw.goal_ref, 80)) errors.push('goal_ref: a goal id, at most 80 characters');
    else goalRef = raw.goal_ref.trim();
  }
  const contextBudget = raw.context_budget ?? 32000;
  if (!Number.isInteger(contextBudget) || contextBudget < 1000 || contextBudget > 262144) errors.push('context_budget: a whole number of tokens from 1000 to 262144');
  if (raw.capability !== undefined && !isString(raw.capability, 80)) errors.push('capability: at most 80 characters');

  let allowlist = [];
  if (!Array.isArray(raw.allowlist) || raw.allowlist.length === 0) errors.push('allowlist: the files the worker may change (the scope guard input); at least one path');
  else if (raw.allowlist.length > MAX_ALLOWLIST) errors.push(`allowlist: at most ${MAX_ALLOWLIST} paths`);
  else {
    const bad = raw.allowlist.filter((p) => !relativePath(p));
    if (bad.length) errors.push(`allowlist: relative paths inside the repository only (no absolute paths, no ".."): ${bad.slice(0, 3).map(String).join(', ')}`);
    else allowlist = [...new Set(raw.allowlist)];
  }

  const acceptance = validateAcceptance(raw.acceptance, errors);

  let dependsOn = [];
  if (raw.depends_on !== undefined) {
    if (!Array.isArray(raw.depends_on) || raw.depends_on.some((d) => !isItemId(d))) errors.push('depends_on: a list of item ids');
    else dependsOn = [...new Set(raw.depends_on)];
  }

  if (!isString(raw.handoff, MAX_HANDOFF_BYTES)) errors.push(`handoff: the worker's instructions, required, at most ${MAX_HANDOFF_BYTES} characters`);

  let route = null;
  if (raw.route !== undefined && raw.route !== null) {
    if (typeof raw.route !== 'object' || !isString(raw.route.cli, 40) || !isString(raw.route.model, 200)) errors.push('route: {cli, model} when given');
    else if (raw.route.flags !== undefined && (!Array.isArray(raw.route.flags) || raw.route.flags.length > 20 || raw.route.flags.some((f) => typeof f !== 'string' || !f || f.length > 200))) errors.push('route.flags: at most 20 non-empty strings');
    else route = { cli: raw.route.cli, model: raw.route.model, ...(raw.route.flags ? { flags: raw.route.flags } : {}) };
  }
  if (raw.notes !== undefined && !isString(raw.notes, 2000)) errors.push('notes: at most 2000 characters');

  if (errors.length) return { ok: false, item: null, errors };
  return {
    ok: true,
    errors: [],
    item: {
      project: raw.project,
      title: raw.title.trim(),
      domain,
      goal_ref: goalRef,
      allowlist,
      acceptance,
      context_budget: contextBudget,
      size,
      capability: raw.capability ?? null,
      latency,
      priority,
      depends_on: dependsOn,
      review,
      handoff: raw.handoff,
      route,
      notes: raw.notes ?? null,
    },
  };
}

/** Does the item need a person or a frontier session to judge the result (no command can)? */
export function needsReview(item) {
  return item.acceptance.some((c) => c.kind === 'rubric') || item.review === 'full';
}
