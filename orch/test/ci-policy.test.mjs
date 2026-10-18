import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validatePolicy, selectPlan, changedSince, resolveBaseline, inputDependencies, readPolicy } from '../tools/ci-plan.mjs';
import { executeGroups, checkRequiredJobs } from '../tools/ci-run.mjs';
const policy = () => ({ version: 1, critical: ['orch/src/keeper.mjs'], shared: ['orch/test/helpers.mjs', 'orch/package-lock.json', 'orch/tools/**', '.github/**'], ignored: ['docs/**', 'README.md'], groups: { contracts: { stage: 'commit', execution: 'parallel', files: ['orch/test/unit.test.mjs'], inputs: [] }, native: { stage: 'commit', execution: 'serial', files: ['orch/test/native.test.mjs'], inputs: ['orch/src/keeper.mjs'] }, review: { stage: 'integration', execution: 'serial', files: ['orch/test/review.test.mjs'], inputs: ['orch/src/review.mjs'] }, routing: { stage: 'integration', execution: 'parallel', files: ['orch/test/routing.test.mjs'], inputs: ['orch/src/routing.mjs'] } } });
test('inventory refuses new tests without a group instead of silently skipping them', () => { assert.throws(() => validatePolicy(policy(), ['orch/test/unit.test.mjs', 'orch/test/native.test.mjs', 'orch/test/review.test.mjs', 'orch/test/routing.test.mjs', 'orch/test/new.test.mjs']), /unclassified.*new.test/); });
test('inventory refuses duplicate and missing registered tests', () => { const p = policy(); p.groups.review.files.push('orch/test/unit.test.mjs'); assert.throws(() => validatePolicy(p, ['orch/test/unit.test.mjs', 'orch/test/native.test.mjs', 'orch/test/review.test.mjs', 'orch/test/routing.test.mjs']), /duplicate/); assert.throws(() => validatePolicy(policy(), ['orch/test/unit.test.mjs']), /missing/); });
test('inventory rejects unsupported execution and unsafe test paths', () => { const p = policy(); p.groups.review.execution = 'unbounded'; assert.throws(() => validatePolicy(p, []), /execution/); const q = policy(); q.groups.review.files = ['../outside.test.mjs']; assert.throws(() => validatePolicy(q, []), /path/); });
test('an unrelated documentation change retains commit checks without full integration', () => { const out = selectPlan(policy(), { changedFiles: ['docs/SETUP.md'] }); assert.deepEqual(out.commit, ['contracts', 'native']); assert.deepEqual(out.integration, []); assert.equal(out.stress, false); });
test('feature changes select their integration group and declared dependants', () => { const out = selectPlan(policy(), { changedFiles: ['orch/src/routing.mjs'], dependencies: { review: ['orch/src/routing.mjs'] } }); assert.deepEqual(out.integration, ['review', 'routing']); assert.equal(out.stress, false); });
test('new unknown runtime input falls back to all integration', () => { const out = selectPlan(policy(), { changedFiles: ['orch/src/new-runtime.mjs'] }); assert.deepEqual(out.integration, ['review', 'routing']); assert.match(out.reasons.join('\n'), /unknown.*new-runtime/); });
test('shared test helpers and locks select all integration', () => { for (const f of ['orch/test/helpers.mjs', 'orch/package-lock.json', 'orch/tools/ci-plan.mjs', '.github/workflows/test.yml'])
    assert.deepEqual(selectPlan(policy(), { changedFiles: [f] }).integration, ['review', 'routing']); });
test('critical lifecycle changes retain full integration and stress on both OSs', () => { const out = selectPlan(policy(), { changedFiles: ['orch/src/keeper.mjs'] }); assert.deepEqual(out.integration, ['review', 'routing']); assert.equal(out.stress, true); });
test('changed tests select their owning group and unknown tests fail inventory', () => { assert.deepEqual(selectPlan(policy(), { changedFiles: ['orch/test/review.test.mjs'] }).integration, ['review']); });
test('missing reliable baseline selects integration and stress because lifecycle changes are unknown', () => { const out = selectPlan(policy(), { changedFiles: [], fullReason: 'missing baseline' }); assert.deepEqual(out.integration, ['review', 'routing']); assert.equal(out.stress, true); assert.match(out.reasons.join('\n'), /missing baseline/); });
test('PR baseline comes from its target revision; main uses last successful main run', async () => { assert.deepEqual(await resolveBaseline({ event: 'pull_request', payload: { pull_request: { base: { sha: 'base' } } }, head: 'head', successfulRuns: async () => [] }), { base: 'base', reason: null }); const out = await resolveBaseline({ event: 'push', payload: { ref: 'refs/heads/main' }, head: 'current', successfulRuns: async () => [{ head_sha: 'current' }, { head_sha: 'last-green' }] }); assert.equal(out.base, 'last-green'); });
test('unavailable main history broadens verification and does not guess HEAD~1', async () => { for (const fn of [async () => [], async () => { throw Error('unavailable'); }]) {
    const out = await resolveBaseline({ event: 'push', payload: { ref: 'refs/heads/main' }, head: 'current', successfulRuns: fn });
    assert.equal(out.base, null);
    assert.match(out.reason, /baseline/);
} });
test('Git selection includes both sides of renames, deletions and local new inputs', t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ci-policy-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); git('init', '-q'); fs.writeFileSync(path.join(root, 'old.mjs'), 'original\n'); fs.writeFileSync(path.join(root, 'deleted.mjs'), 'delete\n'); git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD'); fs.renameSync(path.join(root, 'old.mjs'), path.join(root, 'renamed.mjs')); fs.unlinkSync(path.join(root, 'deleted.mjs')); git('add', '-A'); git('commit', '-qm', 'change'); fs.writeFileSync(path.join(root, 'new.mjs'), 'new\n'); const out = changedSince(root, base, 'HEAD'); assert.deepEqual(out.files.sort(), ['deleted.mjs', 'new.mjs', 'old.mjs', 'renamed.mjs']); assert.equal(out.reason, null); assert.match(changedSince(root, 'missing-ref', 'HEAD').reason, /baseline/); });
test('runner executes isolated files together, then exclusive files, retaining actual counts', async (t) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ci-run-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(path.join(root, 'orch/test'), { recursive: true }); const pre = "import {test} from 'node:test';import fs from 'node:fs';import assert from 'node:assert/strict';"; for (const id of ['a', 'b'])
    fs.writeFileSync(path.join(root, `orch/test/${id}.test.mjs`), pre + `test('parallel ${id}',async()=>{fs.writeFileSync('${id}.ready','');const end=Date.now()+5000;while(!fs.existsSync('${id === 'a' ? 'b' : 'a'}.ready')&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(fs.existsSync('${id === 'a' ? 'b' : 'a'}.ready'));fs.writeFileSync('${id}.done','');});`); fs.writeFileSync(path.join(root, 'orch/test/c.test.mjs'), pre + "test('exclusive starts last',()=>{assert.ok(fs.existsSync('a.done'));assert.ok(fs.existsSync('b.done'));});"); const p = { groups: { parallel: { execution: 'parallel', files: ['orch/test/a.test.mjs', 'orch/test/b.test.mjs'] }, serial: { execution: 'serial', files: ['orch/test/c.test.mjs'] } } }; const out = await executeGroups(root, p, ['serial', 'parallel'], { quiet: true, label: 'subset' }); assert.equal(out.scope, 'subset'); assert.equal(out.phases.length, 2); assert.equal(out.phases[0].concurrency, 2); assert.equal(out.phases[1].concurrency, 1); assert.equal(out.phases.reduce((n, x) => n + x.counts.pass, 0), 3); assert.equal(out.code, 0); });
test('runner propagates a real assertion failure and does not start later groups', async (t) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ci-fail-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(path.join(root, 'orch/test'), { recursive: true }); fs.writeFileSync(path.join(root, 'orch/test/a.test.mjs'), "import {test} from 'node:test';import assert from 'node:assert/strict';test('failure',()=>assert.equal(1,2));"); fs.writeFileSync(path.join(root, 'orch/test/b.test.mjs'), "import fs from 'node:fs';fs.writeFileSync('should-not-start','');"); const out = await executeGroups(root, { groups: { p: { execution: 'parallel', files: ['orch/test/a.test.mjs'] }, s: { execution: 'serial', files: ['orch/test/b.test.mjs'] } } }, ['p', 's'], { quiet: true, label: 'subset' }); assert.notEqual(out.code, 0); assert.equal(out.phases[0].counts.fail, 1); assert.equal(fs.existsSync(path.join(root, 'orch/should-not-start')), false); });
test('aggregate gate refuses missing, cancelled and skipped required jobs', () => { assert.equal(checkRequiredJobs({ plan: 'success', commit: 'success', integration: 'skipped', stress: 'skipped', full: 'skipped' }, { integration: false, stress: false, full: false }), true); for (const value of ['failure', 'cancelled', 'skipped', undefined])
    assert.throws(() => checkRequiredJobs({ plan: 'success', commit: value, integration: 'skipped', stress: 'skipped', full: 'skipped' }, { integration: false, stress: false, full: false }), /commit/); assert.throws(() => checkRequiredJobs({ plan: 'success', commit: 'success', integration: 'skipped', stress: 'skipped', full: 'skipped' }, { integration: true, stress: false, full: false }), /integration/); assert.throws(() => checkRequiredJobs({ full: 'skipped' }, { full: true }), /full/); });

test('uncertain dependency matches cannot hide an otherwise unknown input', () => {
    const out = selectPlan(policy(), { changedFiles: ['orch/src/unmapped.mjs'], dependencies: { review: ['**'] } });
    assert.deepEqual(out.integration, ['review', 'routing']);
    assert.match(out.reasons.join('\n'), /unknown input/);
});

test('the real repository keeps documentation commit-only and an adoption test scoped to adoption', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url)), p = readPolicy(root), dependencies = inputDependencies(root, p);
    assert.deepEqual(selectPlan(p, { changedFiles: ['docs/SETUP.md'], dependencies }).integration, []);
    assert.deepEqual(selectPlan(p, { changedFiles: ['orch/test/adoption-p04h.test.mjs'], dependencies }).integration, ['adoption']);
});

test('real import traversal includes test-only consumers of another registered source', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ci-imports-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const write = (f, text) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); };
    const p = policy();
    for (const g of Object.values(p.groups)) for (const f of g.files) write(f, '');
    for (const f of ['keeper', 'review', 'routing']) write(`orch/src/${f}.mjs`, '');
    write('orch/test/review.test.mjs', "import '../src/routing.mjs';");
    write('orch/src/routing.mjs', "export {x} from './transitive.mjs'; import('./literal.mjs');");
    write('orch/src/transitive.mjs', 'export const x=1;'); write('orch/src/literal.mjs', '');
    const dependencies = inputDependencies(root, p);
    for (const file of ['orch/src/routing.mjs', 'orch/src/transitive.mjs', 'orch/src/literal.mjs']) {
        assert.deepEqual(selectPlan(p, { changedFiles: [file], dependencies }).integration, ['review', 'routing']);
    }
    write('orch/src/routing.mjs', 'import(process.env.FIXTURE_MODULE);');
    const uncertain = inputDependencies(root, p);
    assert.deepEqual(selectPlan(p, { changedFiles: ['orch/src/unmapped.mjs'], dependencies: uncertain }).integration, ['review', 'routing']);
});

test('stale critical-path mappings fail inventory rather than silently losing stress', () => {
    const p = policy(), files = Object.values(p.groups).flatMap(g => g.files), inputs = [...files, 'orch/src/keeper.mjs'];
    assert.equal(validatePolicy(p, files, inputs), true);
    p.critical = ['orch/src/keepre.mjs'];
    assert.throws(() => validatePolicy(p, files, inputs), /critical.*match/i);
});

test('shared launch dependencies broaden even when reached through a subprocess boundary', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ci-launch-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.join(root, 'orch/src'), { recursive: true });
    const p = policy(); p.shared.push('orch/src/launch.mjs');
    for (const g of Object.values(p.groups)) for (const f of g.files) {
        fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), '');
    }
    for (const name of ['keeper', 'review']) fs.writeFileSync(path.join(root, `orch/src/${name}.mjs`), '');
    fs.writeFileSync(path.join(root, 'orch/src/launch.mjs'), "import './routing.mjs';");
    fs.writeFileSync(path.join(root, 'orch/src/routing.mjs'), '');
    const out = selectPlan(p, { changedFiles: ['orch/src/routing.mjs'], dependencies: inputDependencies(root, p) });
    assert.deepEqual(out.integration, ['review', 'routing']);
    assert.match(out.reasons.join('\n'), /shared input/);
});

test('stress mode reaches the real repetition helper even under the verify lifecycle', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ci-stress-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'orch/test'), { recursive: true });
    const helper = new URL('./helpers.mjs', import.meta.url).href;
    fs.writeFileSync(path.join(root, 'orch/test/stress.test.mjs'), `import {test} from 'node:test';import assert from 'node:assert/strict';import {testReps} from ${JSON.stringify(helper)};process.env.npm_lifecycle_event='verify';test('actual repetitions',()=>assert.equal(testReps(7,'ORCH_G3_REPS'),7));`);
    const old = process.env.ORCH_G3_REPS; process.env.ORCH_G3_REPS = '1';
    try {
        const out = await executeGroups(root, { groups: { lifecycle: { execution: 'serial', files: ['orch/test/stress.test.mjs'] } } }, ['lifecycle'], { stress: true, quiet: true });
        assert.equal(out.code, 0); assert.equal(out.phases[0].counts.pass, 1);
    } finally { if (old === undefined) delete process.env.ORCH_G3_REPS; else process.env.ORCH_G3_REPS = old; }
});
