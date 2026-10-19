// Owned fake-worker fixtures only. No production identity or cleanup policy is replaced.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { orch } from './helpers.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Failure evidence stays small and contains only identity/status categories.
const short = value => typeof value === 'string' ? value.slice(0, 160) : null;
function fixtureQueryFailures(dir) {
    const failures = [];
    for (const [source, name, kind, field] of [
        ['keeper', 'keeper.ndjson', 'worker-identity-unavailable', 'event'],
        ['monitor', 'events.monitor.ndjson', 'process-query-failed', 'type'],
    ]) {
        let fd;
        try {
            fd = fs.openSync(path.join(dir, name), 'r');
            const size = fs.fstatSync(fd).size, length = Math.min(size, 16384), buffer = Buffer.alloc(length);
            const read = fs.readSync(fd, buffer, 0, length, size - length);
            const rows = [];
            for (const line of buffer.toString('utf8', 0, read).split(/\r?\n/)) {
                try { const row = JSON.parse(line); if (row[field] === kind) rows.push({ source, reason: short(row.reason), at: short(row.at) }); }
                catch { /* A partial tail line is not diagnostic evidence. */ }
            }
            failures.push(...rows.slice(-4));
        } catch { /* Diagnostics never prevent fixture release or mask its failure. */ }
        finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* release still runs */ } } }
    }
    return failures;
}

export async function observedFixture(args, env, { launch = orch, timeoutMs = 45000, pollMs = 25 } = {}) {
    const at = args.findIndex((v, i) => v === '--flag' && args[i + 1] === '--hold' && args[i + 2] === '--flag' && args[i + 3] === '5');
    if (at < 0)
        return launch(args, env);
    const fake = (args[0] === 'run' && args[args.indexOf('--cli') + 1] === 'fake') || (args[0] === 'review' && args[args.indexOf('--reviewer') + 1] === 'fake');
    if (env.ORCH_ALLOW_FAKE !== '1' || !fake || !env.ORCH_STATE_ROOT)
        throw Error('Observed fixture requires an owned fake-worker case');
    const runs = path.join(env.ORCH_STATE_ROOT, 'runs'), ids = () => fs.existsSync(runs) ? fs.readdirSync(runs) : [], before = new Set(ids()), release = path.join(env.ORCH_STATE_ROOT, 'fixture-release-' + crypto.randomBytes(8).toString('hex'));
    const next = [...args.slice(0, at), '--flag', '--wait-for-file', '--flag', release, ...args.slice(at + 4)];
    let done = false, error, loopError, observed = false, newRun = false, notLaunched = false;
    let runDir = null, evidence = null;
    /** @type {any} */ let result;
    const pending = Promise.resolve().then(() => launch(next, env)).then(value => { done = true; result = value; }, e => { done = true; error = e; });
    try {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            const fresh = ids().filter(id => !before.has(id));
            if (fresh.length > 1)
                throw Error('Observed fixture created multiple runs');
            if (fresh.length) {
                newRun = true;
                try {
                    runDir = path.join(runs, fresh[0]);
                    const record = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
                    evidence = { status: short(record.status), worker_pid: Number.isSafeInteger(record.worker_pid) ? record.worker_pid : null,
                        worker_created_at: short(record.worker_created_at), helper_audit: { state: short(record.helper_audit?.state), reason: short(record.helper_audit?.reason) },
                        query_failures: [] };
                    if (record.worker_created_at && record.helper_audit?.state === 'observed') {
                        observed = true;
                        break;
                    }
                }
                catch { /* Partial atomic record publication is not observed evidence. */ }
            }
            if (done && result?.code !== 0) {
                try {
                    notLaunched = JSON.parse(result.stdout).outcome === 'not-launched';
                }
                catch { /* A non-JSON failure is not proof of refused admission. */ }
                if (notLaunched)
                    break;
            }
            if (done && !fresh.length)
                break;
            await pause(pollMs);
        }
    }
    catch (e) {
        loopError = e;
    }
    finally {
        if (!observed && evidence && runDir) evidence.query_failures = fixtureQueryFailures(runDir);
        fs.writeFileSync(release, 'release\n');
    }
    await pending;
    if (error)
        throw error;
    if (loopError)
        throw loopError;
    if (!observed && !notLaunched && (newRun || result?.code === 0))
        throw Object.assign(Error('Fixture worker identity was not observed before release deadline; evidence=' + JSON.stringify(evidence)), { evidence });
    return result;
}
