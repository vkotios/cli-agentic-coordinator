import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observedFixture } from './observed-worker.mjs';
const delay = n => new Promise(r => setTimeout(r, n));
const args = ['run', '--cli', 'fake', '--flag', '--hold', '--flag', '5'];
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ci-barrier-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, env: { ...process.env, ORCH_ALLOW_FAKE: '1', ORCH_STATE_ROOT: root } }; }
test('fixture release requires both worker birth and observed helper evidence', async (t) => { const { root, env } = fixture(t), file = path.join(root, 'runs', 'owned', 'run.json'); let release; const launch = async (a) => { release = a.at(-1); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ worker_created_at: 'ms:123', helper_audit: { state: 'unknown' } })); await delay(25); assert.equal(fs.existsSync(release), false); fs.writeFileSync(file, JSON.stringify({ helper_audit: { state: 'observed' } })); await delay(25); assert.equal(fs.existsSync(release), false); fs.writeFileSync(file, JSON.stringify({ worker_created_at: 'ms:123', helper_audit: { state: 'observed' } })); while (!fs.existsSync(release))
    await delay(5); return { code: 0, stdout: 'job owned', stderr: '' }; }; const out = await observedFixture(args, env, { launch, timeoutMs: 2000, pollMs: 5 }); assert.equal(out.code, 0); assert.ok(fs.existsSync(release)); });
test('pre-launch refusals return without fabricating a run or waiting for a worker', async (t) => { const { root, env } = fixture(t), out = await observedFixture(args, env, { launch: async () => ({ code: 2, stdout: '', stderr: 'refused' }), timeoutMs: 100 }); assert.equal(out.code, 2); assert.equal(fs.existsSync(path.join(root, 'runs')), false); });
test('an unobserved fixture is released for cleanup but fails verification', async (t) => { const { root, env } = fixture(t); const launch = async (a) => { const release = a.at(-1), file = path.join(root, 'runs', 'owned', 'run.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ worker_created_at: 'ms:123', helper_audit: { state: 'unknown' } })); while (!fs.existsSync(release))
    await delay(5); return { code: 0, stdout: 'job owned', stderr: '' }; }; await assert.rejects(observedFixture(args, env, { launch, timeoutMs: 40, pollMs: 5 }), /identity.*observed/); });
test('a queued record from explicitly refused admission is not a launched worker', async (t) => { const { root, env } = fixture(t), launch = async () => { const file = path.join(root, 'runs', 'refused', 'run.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ status: 'queued', worker_created_at: null })); return { code: 6, stdout: JSON.stringify({ outcome: 'not-launched', launch_error: 'admission blocked' }), stderr: '' }; }; const out = await observedFixture(['review', '--reviewer', 'fake', '--flag', '--hold', '--flag', '5'], env, { launch, timeoutMs: 50, pollMs: 5 }); assert.equal(out.code, 6); assert.equal(JSON.parse(out.stdout).outcome, 'not-launched'); assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'runs/refused/run.json'), 'utf8')).worker_created_at, null); });

test('fixture timeout preserves bounded identity diagnostics without exposing raw query output', async (t) => {
  const { root, env } = fixture(t);
  const launch = async (a) => {
    const release = a.at(-1), dir = path.join(root, 'runs', 'owned');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ status: 'running', worker_pid: 123,
      worker_created_at: null, helper_audit: { state: 'unknown', reason: 'worker-creation-time-unreadable' } }));
    fs.writeFileSync(path.join(dir, 'keeper.ndjson'), JSON.stringify({ event: 'worker-identity-unavailable',
      reason: 'query-timeout', at: '2026-01-01T00:00:00.000Z', stderr: 'private query output' }) + '\n');
    fs.writeFileSync(path.join(dir, 'events.monitor.ndjson'), JSON.stringify({ type: 'process-query-failed',
      reason: 'query-error', at: '2026-01-01T00:00:01.000Z', stderr: 'private query output' }) + '\n');
    while (!fs.existsSync(release)) await delay(5);
    return { code: 0, stdout: 'job owned', stderr: '' };
  };
  await assert.rejects(observedFixture(args, env, { launch, timeoutMs: 40, pollMs: 5 }), error => {
    const failure = /** @type {any} */ (error);
    assert.equal(failure.evidence?.worker_created_at, null);
    assert.equal(failure.evidence?.worker_pid, 123);
    assert.equal(failure.evidence?.helper_audit.reason, 'worker-creation-time-unreadable');
    assert.deepEqual(failure.evidence?.query_failures, [
      { source: 'keeper', reason: 'query-timeout', at: '2026-01-01T00:00:00.000Z' },
      { source: 'monitor', reason: 'query-error', at: '2026-01-01T00:00:01.000Z' },
    ]);
    assert.match(failure.message, /worker-creation-time-unreadable/);
    assert.doesNotMatch(failure.message, /private query output/);
    return true;
  });
});
