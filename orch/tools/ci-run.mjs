import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPolicy, testInventory, validatePolicy, sourceInventory, createPlan } from './ci-plan.mjs';
const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export function checkRequiredJobs(results, required) { const names = required.full ? ['full'] : ['plan', 'commit', ...(required.integration ? ['integration'] : []), ...(required.stress ? ['stress'] : [])]; for (const name of names)
    if (results[name] !== 'success')
        throw Error(`Required ${name} job did not succeed: ${results[name] ?? 'missing'}`); return true; }
function runTests(root, files, concurrency, stress, quiet) {
    return new Promise(resolve => {
        /** @type {NodeJS.ProcessEnv} */
        const env = { ...process.env, FORCE_COLOR: '0', NODE_DISABLE_COLORS: '1', ORCH_TEST_REPS: stress ? 'stress' : '1' };
        for (const key of Object.keys(env))
            if (/^ORCH_.*_REPS$/.test(key) && key !== 'ORCH_TEST_REPS')
                delete env[key];
        // A nested runner must start a new test process, not inherit Node's IPC test context.
        delete env.NODE_TEST_CONTEXT;
        const args = ['--test', `--test-concurrency=${concurrency}`, '--test-force-exit', '--test-timeout=1800000', '--test-reporter=spec', ...files.map(f => path.join(root, f))], started = Date.now();
        let tail = '', launchError = null;
        const child = spawn(process.execPath, args, { cwd: path.join(root, 'orch'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const output = (chunk, stream) => { if (!quiet)
            stream.write(chunk); tail = (tail + chunk.toString()).slice(-2 * 1024 * 1024); };
        child.stdout.on('data', b => output(b, process.stdout));
        child.stderr.on('data', b => output(b, process.stderr));
        child.on('error', e => { launchError = e.message; });
        child.on('close', (code, signal) => { const counts = {}; for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) {
            const m = [...tail.matchAll(new RegExp(`(?:ℹ|#)\\s+${key}\\s+(\\d+)\\s*$`, 'gm'))];
            counts[key] = m.length ? Number(m.at(-1)[1]) : null;
        } const valid = Object.values(counts).every(v => v !== null) && counts.tests > 0 && counts.fail === 0 && counts.cancelled === 0; resolve({ files, concurrency, elapsedMs: Date.now() - started, code: code === 0 && valid && !launchError ? 0 : code || 1, signal, counts, ...(launchError ? { error: launchError } : {}) }); });
    });
}
export async function executeGroups(root, policy, ids, { quiet = false, label = 'subset', stress = false } = {}) {
    const unique = [...new Set(ids)];
    for (const id of unique)
        if (!policy.groups[id])
            throw Error('Unknown CI group ' + id);
    const parallel = unique.filter(id => policy.groups[id].execution === 'parallel'), serial = unique.filter(id => policy.groups[id].execution === 'serial'), phases = [], started = Date.now();
    if (parallel.length) {
        if (!quiet)
            console.log(`CI ${label}: isolated batch (${parallel.join(', ')}), at most 2 files at once`);
        const r = await runTests(root, parallel.flatMap(id => policy.groups[id].files), 2, stress, quiet);
        phases.push({ groups: parallel, ...r });
    }
    if (!phases.some(p => p.code !== 0))
        for (const id of serial) {
            if (!quiet)
                console.log(`CI ${label}: exclusive batch ${id}, one file at a time`);
            const r = await runTests(root, policy.groups[id].files, 1, stress, quiet);
            phases.push({ groups: [id], ...r });
            if (r.code !== 0)
                break;
        }
    const result = { scope: label, groups: unique, stress, elapsedMs: Date.now() - started, code: phases.some(p => p.code !== 0) ? 1 : 0, phases };
    if (!quiet)
        console.log('CI_RESULT ' + JSON.stringify(result));
    return result;
}
export function saveResult(root, result) { const dir = path.join(root, 'orch/.state-test/ci-results'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, `${result.scope}-${Date.now()}-${process.pid}.json`); fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n'); if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = result.phases.map(p => `| ${p.groups.join(', ')} | ${p.counts.tests ?? 'unavailable'} | ${p.counts.pass ?? 'unavailable'} | ${p.counts.fail ?? 'unavailable'} | ${p.counts.skipped ?? 'unavailable'} | ${(p.elapsedMs / 1000).toFixed(1)} |`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### ${result.scope} checks (${result.code === 0 ? 'passed' : 'failed'})\n\nThis reports only the selected groups; full acceptance is a separate result.\n\n| Groups | Tests | Passed | Failed | Skipped | Seconds |\n|---|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n`);
} return file; }
async function main() {
    const args = process.argv.slice(2), value = k => { const i = args.indexOf(k); return i < 0 ? undefined : args[i + 1]; };
    if (args.includes('--gate')) {
        const full = process.env.CI_FULL_REQUIRED === 'true', raw = JSON.parse(process.env.CI_JOB_RESULTS ?? '{}'), results = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v : v.result]));
        checkRequiredJobs(results, { full, integration: process.env.CI_INTEGRATION_REQUIRED === 'true', stress: process.env.CI_STRESS_REQUIRED === 'true' });
        console.log('All required CI jobs succeeded');
        return;
    }
    const mode = value('--mode') ?? 'commit', policy = readPolicy(ROOT);
    validatePolicy(policy, testInventory(ROOT), sourceInventory(ROOT));
    let ids;
    if (mode === 'commit')
        ids = Object.keys(policy.groups).filter(id => policy.groups[id].stage === 'commit');
    else if (mode === 'integration') {
        const id = value('--group');
        if (!id || policy.groups[id]?.stage !== 'integration')
            throw Error('Expected a registered integration group');
        ids = [id];
    }
    else if (['full', 'stress'].includes(mode))
        ids = Object.keys(policy.groups);
    else if (mode === 'affected') {
        const plan = await createPlan({ base: value('--base'), head: value('--head') ?? 'HEAD' });
        console.log('CI_PLAN ' + JSON.stringify(plan));
        ids = [...plan.commit, ...plan.integration];
    }
    else
        throw Error('Unknown CI mode ' + mode);
    const result = await executeGroups(ROOT, policy, ids, { label: mode, stress: mode === 'stress' });
    saveResult(ROOT, result);
    process.exitCode = result.code;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch(e => { console.error(e.message); process.exitCode = 1; });
