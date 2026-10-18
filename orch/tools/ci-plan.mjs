import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const slash = s => s.replaceAll('\\', '/');
const safe = p => typeof p === 'string' && p.startsWith('orch/test/') && p.endsWith('.test.mjs') && !p.split('/').includes('..') && !p.includes('\\');
const matches = (value, pattern) => new RegExp('^' + pattern.split('**').map(part => part.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$').test(value);
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
export function readPolicy(root = ROOT) { return JSON.parse(fs.readFileSync(path.join(root, 'orch/tools/ci-policy.json'), 'utf8')); }
export function testInventory(root = ROOT) { const out = []; function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory())
        walk(f);
    else if (e.name.endsWith('.test.mjs'))
        out.push(slash(path.relative(root, f)));
} } walk(path.join(root, 'orch/test')); return out.sort(); }
export function sourceInventory(root = ROOT) {
    return git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(f => f && fs.existsSync(path.join(root, f)));
}
export function validatePolicy(policy, files, inputs = undefined) {
    if (policy.version !== 1 || !policy.groups || !Array.isArray(policy.critical) || !Array.isArray(policy.shared) || !Array.isArray(policy.ignored))
        throw Error('Invalid CI policy');
    const seen = new Set();
    let commit = 0;
    for (const [id, g] of Object.entries(policy.groups)) {
        if (!/^[a-z][a-z0-9-]*$/.test(id) || !['commit', 'integration'].includes(g.stage))
            throw Error('Invalid group ' + id);
        if (!['parallel', 'serial'].includes(g.execution))
            throw Error('Invalid execution ' + id);
        if (!Array.isArray(g.files) || !g.files.length || !Array.isArray(g.inputs))
            throw Error('Empty group ' + id);
        if (g.stage === 'commit')
            commit++;
        for (const f of g.files) {
            if (!safe(f))
                throw Error('Unsafe test path ' + f);
            if (seen.has(f))
                throw Error('duplicate test ' + f);
            seen.add(f);
        }
    }
    if (!commit)
        throw Error('Missing commit stage');
    for (const f of files)
        if (!seen.has(f))
            throw Error('unclassified test ' + f);
    for (const f of seen)
        if (!files.includes(f))
            throw Error('missing test ' + f);
    if (inputs)
        for (const pattern of policy.critical)
            if (!inputs.some(f => matches(f, pattern)))
                throw Error('Critical input pattern has no matching source: ' + pattern);
    return true;
}
export function selectPlan(policy, { changedFiles, dependencies = /** @type {Record<string,string[]>} */ ({}), fullReason = null }) {
    const entries = Object.entries(policy.groups), commit = entries.filter(([, g]) => g.stage === 'commit').map(([id]) => id), all = entries.filter(([, g]) => g.stage === 'integration').map(([id]) => id), selected = new Set(), reasons = [];
    let stress = false;
    const broaden = reason => { for (const id of all)
        selected.add(id); reasons.push(reason); };
    if (fullReason) {
        broaden(fullReason);
        // Unknown history cannot prove that lifecycle inputs stayed unchanged.
        stress = true;
    }
    for (const file of [...new Set(changedFiles)].sort()) {
        if (policy.critical.some(p => matches(file, p))) {
            broaden('critical lifecycle: ' + file);
            stress = true;
            continue;
        }
        if (policy.shared.some(p => matches(file, p)) || (dependencies.$shared ?? []).some(p => matches(file, p))) {
            broaden('shared input: ' + file);
            continue;
        }
        let known = false;
        for (const [id, g] of entries) {
            const deps = dependencies[id] ?? [];
            const concrete = g.files.includes(file) || g.inputs.some(p => matches(file, p)) || deps.some(p => p !== '**' && matches(file, p));
            if (concrete || deps.includes('**')) {
                // An uncertain import selects its consumer but cannot make an unmapped input known.
                if (concrete) known = true;
                if (g.stage === 'integration')
                    selected.add(id);
                reasons.push(id + ': ' + file);
            }
        }
        if (!known && !policy.ignored.some(p => matches(file, p)))
            broaden('unknown input: ' + file);
    }
    return { commit, integration: all.filter(id => selected.has(id)), stress, reasons, changedFiles: [...new Set(changedFiles)].sort() };
}
export function changedSince(root, base, head = 'HEAD', { local = true } = {}) {
    try {
        if (!base)
            throw Error('missing');
        const mergeBase = git(root, ['merge-base', base, head]).trim();
        if (!mergeBase)
            throw Error('missing');
        const split = s => s.split('\0').filter(Boolean), files = split(git(root, ['diff', '--name-only', '--no-renames', '-z', mergeBase, head]));
        if (local) {
            files.push(...split(git(root, ['diff', '--name-only', '--no-renames', '-z', 'HEAD'])), ...split(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])));
        }
        return { files: [...new Set(files)], reason: null, base: mergeBase };
    }
    catch {
        return { files: [], reason: 'missing or unavailable Git baseline; all integration required', base: null };
    }
}
export async function resolveBaseline({ event, payload, head, successfulRuns }) {
    if (event === 'pull_request') {
        const base = payload?.pull_request?.base?.sha;
        return base ? { base, reason: null } : { base: null, reason: 'missing PR baseline; all integration required' };
    }
    if (event === 'push' && payload?.ref === 'refs/heads/main') {
        try {
            const runs = await successfulRuns(), run = runs.find(r => r.head_sha !== head);
            if (run?.head_sha)
                return { base: run.head_sha, reason: null };
        }
        catch { /* An unavailable baseline broadens checks. */ }
        return { base: null, reason: 'unavailable successful-main baseline; all integration required' };
    }
    return { base: null, reason: 'no reliable baseline; all integration required' };
}
export function inputDependencies(root, policy) {
    const files = sourceInventory(root), cache = new Map();
    function collect(rel, seen) {
        if (seen.has(rel))
            return;
        seen.add(rel);
        if (!/\.mjs$/.test(rel))
            return;
        const filename = path.join(root, rel);
        if (!fs.existsSync(filename)) {
            seen.add('**');
            return;
        }
        if (!slash(fs.realpathSync(filename)).startsWith(slash(fs.realpathSync(root)) + '/'))
            throw Error('Input escapes checkout');
        let deps = cache.get(rel);
        if (!deps) {
            deps = [];
            const ast = ts.createSourceFile(rel, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            const add = s => { if (s.startsWith('.'))
                deps.push(slash(path.relative(root, path.resolve(path.dirname(filename), s)))); };
            function walk(n) { if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier))
                add(n.moduleSpecifier.text); if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const a = n.arguments[0];
                if (a && ts.isStringLiteral(a))
                    add(a.text);
                else
                    deps.push('**');
            } ts.forEachChild(n, walk); }
            walk(ast);
            cache.set(rel, deps);
        }
        for (const dep of deps) {
            if (dep === '**')
                seen.add(dep);
            else
                collect(dep, seen);
        }
    }
    const shared = new Set();
    for (const file of files)
        if (policy.shared.some(p => matches(file, p)))
            collect(file, shared);
    /** @type {Record<string, string[]>} */
    const out = { $shared: [...shared] };
    for (const [id, g] of Object.entries(policy.groups)) {
        const seen = new Set();
        for (const file of g.files)
            collect(file, seen);
        for (const file of files)
            if (g.inputs.some(p => matches(file, p)))
                collect(file, seen);
        out[id] = [...seen];
    }
    return out;
}
/** @param {{root?:string,base?:string|null,head?:string,github?:boolean}} [options] */
export async function createPlan({ root = ROOT, base, head = 'HEAD', github = false } = {}) {
    const policy = readPolicy(root);
    validatePolicy(policy, testInventory(root), sourceInventory(root));
    const actualHead = git(root, ['rev-parse', 'HEAD']).trim();
    let baselineReason = null;
    if (git(root, ['rev-parse', head]).trim() !== actualHead)
        throw Error('Plan head must match the checked-out source');
    if (github) {
        head = actualHead;
        const payload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
        const resolved = await resolveBaseline({ event: process.env.GITHUB_EVENT_NAME, payload, head, successfulRuns: async () => { const repo = process.env.GITHUB_REPOSITORY; if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
                throw Error('Invalid repository'); const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/test.yml/runs?branch=main&event=push&status=success&per_page=100`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ''}` } }); if (!res.ok)
                throw Error('Baseline HTTP ' + res.status); const body = await res.json(); return body.workflow_runs; } });
        base = resolved.base;
        baselineReason = resolved.reason;
        if (base) {
            try {
                git(root, ['merge-base', '--is-ancestor', base, head]);
            }
            catch {
                base = null;
                baselineReason = 'non-ancestor baseline; all integration required';
            }
        }
    }
    else if (base === undefined) {
        try {
            git(root, ['rev-parse', '--verify', 'origin/main']);
            base = 'origin/main';
        }
        catch {
            base = null;
        }
    }
    const changed = changedSince(root, base, head, { local: !github }), selection = selectPlan(policy, { changedFiles: changed.files, dependencies: inputDependencies(root, policy), fullReason: baselineReason ?? changed.reason });
    return { version: 1, head: actualHead, base: changed.base, worktreeDirty: !github && git(root, ['status', '--porcelain', '--untracked-files=all']).trim() !== '', ...selection, platforms: ['linux', 'win32'], groups: policy.groups };
}
async function main() { const args = process.argv.slice(2), value = flag => { const i = args.indexOf(flag); if (i < 0)
    return undefined; if (!args[i + 1] || args[i + 1].startsWith('--'))
    throw Error('Missing ' + flag); return args[i + 1]; }; const plan = await createPlan({ base: value('--base'), head: value('--head') ?? 'HEAD', github: args.includes('--github') }), output = value('--output'); if (output)
    fs.writeFileSync(output, JSON.stringify(plan, null, 2) + '\n'); if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `integration=${JSON.stringify(plan.integration)}\nstress=${plan.stress}\n`); console.log(JSON.stringify(plan, null, 2)); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch(e => { console.error(e.message); process.exitCode = 1; });
