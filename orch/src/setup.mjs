// Resumable onboarding choices only. No config/adoption/credential/provider mutations.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { OrchError } from './errors.mjs';
import { topLevel, samePath, isInside } from './git.mjs';
import { REPO_ROOT } from './config.mjs';
import { resolvedPath, withOperationLock } from './resources.mjs';
import { publishExclusive } from './exclusive.mjs';
import { resolveCliExe } from './exe.mjs';
import { validateCatalog } from './catalog.mjs';
import { resolveOpencodeExe } from './adapters/opencode.mjs';
import { resolveMuseExe } from './adapters/muse.mjs';
import { resolveCopilotExe } from './adapters/copilot.mjs';
const LIMIT = 65536, HARNESSES = ['claude', 'codex', 'opencode', 'vibe', 'copilot', 'muse'], WORKERS = ['codex', 'opencode', 'vibe', 'agy', 'copilot', 'muse'];
const authority = { configChanges: false, adoptionChanges: false, credentialChanges: false, launchChanges: false };
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const encoded = x => JSON.stringify(x, null, 2) + '\n';
const stamp = file => { const s = fs.lstatSync(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.birthtimeNs}`; };
const repoIdentity = repo => `${stamp(repo)}/${stamp(path.join(repo, '.git'))}`;
const fail = message => { throw new OrchError(message, 'setup-refused'); };
function object(x, keys) { if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).sort().join(',') !== [...keys].sort().join(','))
    fail('Unexpected setup fields'); }
function text(x, max = 4096) { if (typeof x !== 'string' || !x || x.length > max || /[\x00-\x1f]/.test(x) || /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_|Bearer\s)/i.test(x))
    fail('Invalid setup value; submit references, never credentials'); return x; }
function safe(file, dir = false) { text(file); const abs = path.resolve(file); if (abs.startsWith('\\\\') || path.basename(abs).includes(':'))
    fail('Setup needs a local path'); try {
    if (!samePath(abs, resolvedPath(abs)))
        fail('Setup path traverses a link');
    const s = fs.lstatSync(abs);
    if (s.isSymbolicLink() || (dir ? !s.isDirectory() : !s.isFile() || s.nlink !== 1))
        fail('Setup path must be an unlinked directory or single-link file');
    return s;
}
catch (e) {
    if (e.code === 'ENOENT' && dir)
        return null;
    if (e instanceof OrchError)
        throw e;
    fail('Setup path is unavailable');
} }
function read(file, { max = LIMIT, journal = false } = {}) { let fd; try {
    safe(file);
    fd = fs.openSync(file, 'r');
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > max || s.nlink !== 1)
        fail('Setup input exceeds limit or is not regular');
    const b = Buffer.alloc(max + 1);
    let n = 0;
    while (n < b.length) {
        const count = fs.readSync(fd, b, n, b.length - n, null);
        if (!count)
            break;
        n += count;
    }
    const end = fs.fstatSync(fd);
    if (n > max || s.size !== end.size || s.mtimeMs !== end.mtimeMs || s.ctimeMs !== end.ctimeMs)
        fail('Setup input changed during read');
    const bytes = b.subarray(0, n), raw = JSON.parse(bytes.toString('utf8'));
    if (journal && bytes.toString('utf8') !== encoded(raw))
        fail('Setup evidence changed');
    return { raw, hash: sha(bytes) };
}
catch (e) {
    if (e instanceof OrchError)
        throw e;
    fail('Setup input/evidence is unreadable');
}
finally {
    if (fd !== undefined)
        fs.closeSync(fd);
} }
const routeSchema = { type: 'object', additionalProperties: false, required: ['harness', 'model', 'billing', 'permission'], properties: { harness: { enum: [...new Set([...HARNESSES, ...WORKERS])] }, model: { type: 'string', maxLength: 200 }, billing: { enum: ['subscription', 'local', 'api'] }, permission: { enum: ['ask', 'allowed'] } } };
export const SETUP_QUESTIONS = [
    { id: 'routes', prompt: 'Choose exact controller, worker and reviewer harness/model/billing routes. These choices record intent; they do not qualify or enable models.', schema: { type: 'object', additionalProperties: false, required: ['controller', 'workers', 'reviewers'], properties: { controller: { ...routeSchema, properties: { ...routeSchema.properties, harness: { enum: HARNESSES } } }, workers: { type: 'array', maxItems: 16, items: { ...routeSchema, properties: { ...routeSchema.properties, harness: { enum: WORKERS } } } }, reviewers: { type: 'array', maxItems: 16, items: { ...routeSchema, properties: { ...routeSchema.properties, harness: { enum: WORKERS } } } } } } },
    { id: 'router', prompt: 'Choose deterministic routing, Jev shadow or Jev assist. Jev choices require an environment variable name and explicit advice budget; never paste a key.', schema: { oneOf: [{ type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'deterministic' } } }, { type: 'object', additionalProperties: false, required: ['mode', 'keyEnv', 'budgetUsd'], properties: { mode: { enum: ['jev-shadow', 'jev-assist'] }, keyEnv: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,79}$' }, budgetUsd: { type: 'number', exclusiveMinimum: 0, maximum: 10 } } }] } },
    { id: 'usage', prompt: 'Use subscription telemetry? Supply the path to a private usage configuration, or explicitly leave it disabled. No account data is read here.', schema: { oneOf: [{ type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { const: false } } }, { type: 'object', additionalProperties: false, required: ['enabled', 'configFile'], properties: { enabled: { const: true }, configFile: { type: 'string' } } }] } },
    { id: 'resources', prompt: 'Choose private state/review locations and retain-unmerged cleanup. Every work package must finalize; uncertain, dirty or unmerged work is preserved.', schema: { type: 'object', additionalProperties: false, required: ['stateRoot', 'reviewRoot', 'cleanup'], properties: { stateRoot: { type: 'string' }, reviewRoot: { type: 'string' }, cleanup: { const: 'retain-unmerged' } } } },
    { id: 'retention', prompt: 'Explicitly leave retention disabled, or choose transcript/run days and manual or on-use maintenance. This proposal does not activate retention or install a scheduler.', schema: { oneOf: [{ type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { const: false } } }, { type: 'object', additionalProperties: false, required: ['enabled', 'mode', 'transcriptDays', 'runDays'], properties: { enabled: { const: true }, mode: { enum: ['manual', 'on-use'] }, transcriptDays: { type: 'integer', minimum: 1, maximum: 3650 }, runDays: { type: 'integer', minimum: 1, maximum: 3650 } } }] } }
];
export function localPath(value, repo) { text(value); const abs=path.resolve(value); if (!path.isAbsolute(value) || value.startsWith('\\\\') || abs.slice(path.parse(abs).root.length).includes(':') || !samePath(abs, resolvedPath(value)) || isInside(abs, repo))
    fail('Choose an absolute private path outside the target repository'); return value; }
function validDiscovery(d) {
    object(d, ['platform', 'nodeMajor', 'harnesses', 'models', 'authentication', 'modelAccess', 'providerCalls']);
    if (typeof d.platform !== 'string' || !Number.isInteger(d.nodeMajor) || !Array.isArray(d.harnesses) || d.harnesses.length < 5 || d.harnesses.length > new Set([...HARNESSES,...WORKERS]).size || !['claude','codex','opencode','vibe','agy'].every(name=>d.harnesses.some(h=>h.harness===name)) || !Array.isArray(d.models) || d.models.length > 128 || d.authentication !== 'not-checked' || d.modelAccess !== 'not-checked' || d.providerCalls !== 0)
        fail('Invalid setup discovery evidence');
    const seen = new Set();
    for (const h of d.harnesses) {
        object(h, ['harness', 'installed', 'status', 'nextStep']);
        if (![...HARNESSES, ...WORKERS].includes(h.harness) || seen.has(h.harness) || typeof h.installed !== 'boolean' || h.status !== (h.installed ? 'installed-but-unqualified' : 'blocked'))
            fail('Invalid discovered harness');
        seen.add(h.harness);
        text(h.nextStep);
    }
    for (const m of d.models) {
        object(m, m.source === 'owner-roster' ? ['harness', 'model', 'billing', 'source', 'qualification', 'requiresPermission', 'enabled'] : ['harness', 'model', 'billing', 'source', 'qualification']);
        text(m.harness, 64);
        if(m.model!==null||m.source==='owner-roster')text(m.model, 200);
        if (!['subscription', 'local', 'api', 'unknown'].includes(m.billing) || !['generic-catalogue', 'owner-roster'].includes(m.source) || m.qualification !== (m.source === 'owner-roster' ? 'unknown' : 'unqualified') || m.source === 'owner-roster' && (typeof m.requiresPermission !== 'boolean' || typeof m.enabled !== 'boolean'))
            fail('Invalid discovered model');
    }
}
function validateAnswer(id, a, meta) {
    if (id === 'routes') {
        object(a, ['controller', 'workers', 'reviewers']);
        for (const role of ['controller', 'workers', 'reviewers']) {
            const values = role === 'controller' ? [a.controller] : a[role];
            if (!Array.isArray(values) || values.length > 16)
                fail('Invalid role routes');
            for (const r of values) {
                object(r, ['harness', 'model', 'billing', 'permission']);
                text(r.model, 200);
                if (['copilot','muse'].includes(r.harness) && r.billing !== 'subscription') fail('Copilot and Muse adapters currently support subscription routes only');
                if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(r.model) || !(role === 'controller' ? HARNESSES : WORKERS).includes(r.harness) || !['subscription', 'local', 'api'].includes(r.billing) || !['ask', 'allowed'].includes(r.permission) || role === 'controller' && r.harness !== meta.harness)
                    fail('Invalid harness/model/billing role route');
            }
        }
    }
    else if (id === 'router') {
        if (a?.mode === 'deterministic')
            object(a, ['mode']);
        else {
            object(a, ['mode', 'keyEnv', 'budgetUsd']);
            if (!['jev-shadow', 'jev-assist'].includes(a.mode) || typeof a.keyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(a.keyEnv) || typeof a.budgetUsd !== 'number' || !Number.isFinite(a.budgetUsd) || a.budgetUsd <= 0 || a.budgetUsd > 10)
                fail('Jev needs an environment key reference and explicit bounded advice budget');
        }
    }
    else if (id === 'usage') {
        if (a?.enabled === false)
            object(a, ['enabled']);
        else {
            object(a, ['enabled', 'configFile']);
            if (a.enabled !== true)
                fail('Invalid usage choice');
            localPath(a.configFile, meta.repo);
        }
    }
    else if (id === 'resources') {
        object(a, ['stateRoot', 'reviewRoot', 'cleanup']);
        localPath(a.stateRoot, meta.repo);
        localPath(a.reviewRoot, meta.repo);
        if (a.cleanup !== 'retain-unmerged' || samePath(a.stateRoot, a.reviewRoot))
            fail('Finalization with preserved unmerged work and separate resource locations is required');
    }
    else if (id === 'retention') {
        if (a?.enabled === false)
            object(a, ['enabled']);
        else {
            object(a, ['enabled', 'mode', 'transcriptDays', 'runDays']);
            if (a.enabled !== true || !['manual', 'on-use'].includes(a.mode) || ![a.transcriptDays, a.runDays].every(n => Number.isInteger(n) && n >= 1 && n <= 3650))
                fail('Invalid explicit retention choice');
        }
    }
    else
        fail('Unknown setup question');
}
function state(session) {
    session = path.resolve(text(session));
    safe(session, true);
    const h = read(path.join(session, 'session.json'), { journal: true }), m = h.raw;
    object(m, ['version', 'session', 'repo', 'repoIdentity', 'harness', 'discovery']);
    text(m.session);
    text(m.repo);
    if (m.version !== 1 || !HARNESSES.includes(m.harness) || !samePath(m.session, session) || isInside(session, m.repo))
        fail('Invalid setup session binding');
    if (!safe(m.repo, true) || m.repoIdentity !== repoIdentity(m.repo))
        fail('Setup repository identity changed');
    validDiscovery(m.discovery);
    const dir = path.join(session, 'answers');
    let names = [];
    if (safe(dir, true))
        names = fs.readdirSync(dir);
    if (names.length > SETUP_QUESTIONS.length)
        fail('Setup answer history exceeds its bound');
    names.sort();
    let hash = h.hash;
    const answers = {};
    for (let i = 0; i < names.length; i++) {
        const expected = String(i + 1).padStart(4, '0') + '.json';
        if (names[i] !== expected)
            fail('Setup answer chain has gaps or unexpected files');
        const r = read(path.join(dir, expected), { journal: true });
        object(r.raw, ['version', 'revision', 'previousHash', 'questionId', 'answer']);
        if (r.raw.version !== 1 || r.raw.revision !== i + 1 || r.raw.previousHash !== hash || r.raw.questionId !== SETUP_QUESTIONS[i].id)
            fail('Setup answer chain changed');
        validateAnswer(r.raw.questionId, r.raw.answer, m);
        answers[r.raw.questionId] = r.raw.answer;
        hash = r.hash;
    }
    return { meta: m, revision: names.length, hash, answers };
}
function view(s) { return { mode: 'setup', repo: s.meta.repo, harness: s.meta.harness, revision: s.revision, answers: s.answers, discovery: s.meta.discovery, nextQuestion: SETUP_QUESTIONS[s.revision] ?? null, complete: s.revision === SETUP_QUESTIONS.length, activation: false, authority }; }
export function setupStatus(session) { return view(state(session)); }
export const readSetupInput = read;
export const checkedSetupPath = safe;
function discover(catalog, roster) {
    const harnesses = [...new Set([...HARNESSES, ...WORKERS])].map(harness => { try {
        const exe = harness === 'opencode' ? resolveOpencodeExe() : harness === 'muse' ? resolveMuseExe() : harness === 'copilot' ? resolveCopilotExe() : resolveCliExe(harness, { fallbacks: env => ['vibe', 'claude'].includes(harness) ? [path.join(env.USERPROFILE || os.homedir(), '.local', 'bin', harness + '.exe')] : [] });
        const installed = fs.existsSync(exe) && fs.statSync(exe).isFile();
        return { harness, installed, status: installed ? 'installed-but-unqualified' : 'blocked', nextStep: installed ? 'Verify subscription authentication and exact model access before qualification' : 'Install the CLI and log in explicitly; setup does not perform either action' };
    }
    catch(e) {
        if(!(e instanceof OrchError)||e.code!=='cli-not-found')throw e;
        return { harness, installed: false, status: 'blocked', nextStep: 'Install the CLI and log in explicitly; setup does not perform either action' };
    } });
    const generic = validateCatalog(read(catalog || path.join(REPO_ROOT, 'model-catalog.json'), { max: 1048576 }).raw), models = generic.models.flatMap(m => m.routes.map(r => ({ harness: r.harness, model: r.selector, billing: r.billing, source: 'generic-catalogue', qualification: 'unqualified' }))).slice(0, 64);
    if (roster) {
        const owner = read(roster).raw;
        if (!owner || !Array.isArray(owner.models) || owner.models.length > 64)
            fail('Invalid or oversized optional owner roster');
        for (const m of owner.models) {
            text(m.cli, 30);
            text(m.model, 200);
            models.push({ harness: m.cli, model: m.model, billing: 'unknown', source: 'owner-roster', qualification: 'unknown', requiresPermission: m.requires_permission === true, enabled: m.enabled !== false });
        }
    }
    return { platform: process.platform, nodeMajor: Number(process.versions.node.split('.')[0]), harnesses, models, authentication: 'not-checked', modelAccess: 'not-checked', providerCalls: 0 };
}
export async function startSetup({ repo, harness, session, catalog, roster }) {
    if (!HARNESSES.includes(harness))
        fail('Choose a supported controlling harness');
    safe(path.resolve(text(repo)), true);
    const top = await topLevel(path.resolve(repo));
    if (!top)
        fail('Setup needs an existing Git repository');
    repo = path.resolve(top);
    safe(repo, true);
    session = path.resolve(text(session));
    safe(session, true);
    if (isInside(session, repo))
        fail('Keep the private setup session outside the target repository');
    if (fs.existsSync(path.join(session, 'session.json'))) {
        const s = state(session);
        if (!samePath(s.meta.repo, repo) || s.meta.harness !== harness)
            fail('Setup session belongs to another repository/harness');
        if (catalog || roster)
            fail('Resume preserves discovered choices; new input sources need a new session');
        return view(s);
    }
    if (fs.existsSync(session) && fs.readdirSync(session).length)
        fail('Refuse to initialize a nonempty unknown session directory');
    const metadata = { version: 1, session, repo, repoIdentity: repoIdentity(repo), harness, discovery: discover(catalog, roster) };
    validDiscovery(metadata.discovery);
    if (Buffer.byteLength(encoded(metadata)) > LIMIT)
        fail('Setup discovery exceeds record limit');
    fs.mkdirSync(session, { recursive: true, mode: 0o700 });
    safe(session, true);
    publishExclusive(path.join(session, 'session.json'), encoded(metadata));
    const s = state(session);
    if (!samePath(s.meta.repo, repo) || s.meta.harness !== harness)
        fail('Concurrent session initialization chose a different context');
    return view(s);
}
export async function answerSetup(session, request) {
    try {
        request = structuredClone(request);
    }
    catch {
        fail('Invalid setup answer');
    }
    object(request, ['expectedRevision', 'questionId', 'answer']);
    if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0 || request.expectedRevision >= SETUP_QUESTIONS.length)
        fail('Invalid setup answer revision');
    const before = state(session);
    if (before.revision !== request.expectedRevision || SETUP_QUESTIONS[before.revision]?.id !== request.questionId)
        fail('Setup answer is stale or for the wrong question');
    validateAnswer(request.questionId, request.answer, before.meta);
    return withOperationLock({ stateRoot: path.resolve(session) }, 'setup', async () => { const fresh = state(session); if (fresh.hash !== before.hash || fresh.revision !== request.expectedRevision)
        fail('Setup session changed; read status again'); const dir = path.join(path.resolve(session), 'answers'); safe(dir, true); const record = { version: 1, revision: fresh.revision + 1, previousHash: fresh.hash, questionId: request.questionId, answer: request.answer }; if (Buffer.byteLength(encoded(record)) > LIMIT)
        fail('Setup answer exceeds record limit'); const file = path.join(dir, String(record.revision).padStart(4, '0') + '.json'); if (!publishExclusive(file, encoded(record)).created)
        fail('Setup answer already exists; resume instead of overwriting'); return setupStatus(session); });
}
export function setupProposal(session) { const s = state(session); if (s.revision !== SETUP_QUESTIONS.length)
    fail('Answer all setup questions before requesting a proposal'); return { mode: 'setup-proposal', version: 1, repo: s.meta.repo, harness: s.meta.harness, revision: s.revision, sessionHash: s.hash, answers: s.answers, intentOnly: true, applyAvailable: false, activation: false, authority, readiness: ['controller', 'workers', 'reviewers'].flatMap(role => (role === 'controller' ? [s.answers.routes.controller] : s.answers.routes[role]).map(r => ({ role, harness: r.harness, model: r.model, status: s.meta.discovery.harnesses.find(h => h.harness === r.harness)?.installed ? 'installed-but-unqualified' : 'blocked', nextStep: 'Review and apply the setup proposal, then verify authentication, access and role qualification explicitly' }))) }; }
export async function cmdSetup(args, io) {
    const [action, ...extra] = args._ ?? [];
    if (String(action).startsWith('task-')) {
        const {cmdSetupTask} = await import('./setup-task.mjs');
        return cmdSetupTask(args, io);
    }
    if (String(action).startsWith('controller-')) {
        const {cmdSetupController} = await import('./setup-controller.mjs');
        return cmdSetupController(args, io);
    }
    if (['repository-smoke','repository-start','repository-run','repository-qualify','repository-qualification','repository-close'].includes(action)) {
        const {cmdSetupRepositoryController} = await import('./setup-repository-controller.mjs');
        return cmdSetupRepositoryController(args, io);
    }
    if (['smoke', 'probe', 'qualify', 'qualification'].includes(action)) {
        const {cmdSetupQualification} = await import('./setup-qualification.mjs');
        return cmdSetupQualification(args, io);
    }
    if (action === 'health') {
        const {cmdSetupHealth} = await import('./setup-health.mjs');
        return cmdSetupHealth(args, io);
    }
    if (['preview', 'apply', 'receipt'].includes(action)) {
        const { cmdSetupApply } = await import('./setup-apply.mjs');
        return cmdSetupApply(args, io);
    }
    const allowed = ['_', 'json', 'session', 'state-root', ...(action === 'start' ? ['repo', 'harness', 'catalog', 'roster'] : action === 'answer' ? ['answers'] : [])];
    if (extra.length || !['start', 'status', 'answer', 'proposal'].includes(action) || Object.keys(args).some(k => !allowed.includes(k)) || typeof args.session !== 'string')
        fail('Use setup start/status/answer/proposal with explicit --session; no activation options');
    if (action === 'start' && Array.isArray(args.harness) && args.harness.length !== 1)
        fail('Setup needs exactly one controlling harness');
    const out = action === 'start' ? await startSetup({ ...args, harness: Array.isArray(args.harness) ? args.harness[0] : args.harness }) : action === 'answer' ? await answerSetup(args.session, read(text(args.answers)).raw) : action === 'proposal' ? setupProposal(args.session) : setupStatus(args.session);
    io.log(args.json ? JSON.stringify(out, null, 2) : `setup ${out.mode}: revision ${out.revision}; ${out.nextQuestion?.prompt ?? 'proposal available; configuration unchanged'}`);
    return { ...out, exitCode: 0 };
}
