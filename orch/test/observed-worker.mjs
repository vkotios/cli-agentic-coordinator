// Owned fake-worker fixtures only. No production identity or cleanup policy is replaced.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { orch } from './helpers.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
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
                    const record = JSON.parse(fs.readFileSync(path.join(runs, fresh[0], 'run.json'), 'utf8'));
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
        fs.writeFileSync(release, 'release\n');
    }
    await pending;
    if (error)
        throw error;
    if (loopError)
        throw loopError;
    if (!observed && !notLaunched && (newRun || result?.code === 0))
        throw Error('Fixture worker identity was not observed before release deadline');
    return result;
}
