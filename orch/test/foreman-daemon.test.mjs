// Foreman daemon: a real `orch foreman start` process, the one-per-state-root lock, pause/stop,
// and the run id reaching the worker's environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeCase, orch, waitFor, ORCH_BIN } from './helpers.mjs';
import { makeRepo } from './wf-helpers.mjs';
import { Store } from '../src/foreman/store.mjs';

function start(c, extra = []) {
  const child = spawn(process.execPath, [ORCH_BIN, 'foreman', 'start', '--tick', '1', ...extra], { env: c.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
  return { child, exited, output: () => out };
}

test('daemon: starts once per state root, runs an item to needs-review, pauses and stops cleanly', { timeout: 240000 }, async (t) => {
  const c = makeCase('fm-daemon');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n' });
  assert.equal((await orch(['foreman', 'project', 'add', '--id', 'alpha', '--repo', repo], c.env)).code, 0);
  assert.equal((await orch(['foreman', 'goal', 'approve', 'g1', '--project', 'alpha'], c.env)).code, 2, 'a goal that was never proposed cannot be approved');
  const file = path.join(c.base, 'item.json');
  fs.writeFileSync(file, JSON.stringify({
    project: 'alpha', title: 'daemon item', goal_ref: 'g1', handoff: 'TASK: write out.txt', allowlist: ['out.txt'], size: 'XS',
    acceptance: [{ kind: 'command', argv: ['node', '-e', "process.exit(require('fs').existsSync('out.txt') ? 0 : 1)"] }],
    route: { cli: 'fake', model: 'localai/qwen3-coder-30b', flags: ['--write-file', 'out.txt', '--echo-env', 'ORCH_RUN_ID'] },
  }));
  assert.equal((await orch(['enqueue', '--file', file], c.env)).code, 0);

  const first = start(c);
  await waitFor(async () => (JSON.parse((await orch(['foreman', 'status', '--json'], c.env)).stdout)).running === true, { what: 'the daemon to hold the lock', timeoutMs: 30000 });
  const second = start(c);
  const refused = await second.exited;
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /another Foreman already runs/);

  // Paused before an approved goal exists: the item waits; approving the goal lets it run.
  assert.equal((await orch(['foreman', 'pause'], c.env)).code, 0);
  assert.equal((await orch(['foreman', 'goal', 'approve', 'g1', '--project', 'alpha'], c.env)).code, 0);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(JSON.parse((await orch(['foreman', 'items', '--json'], c.env)).stdout).items[0].state, 'ready', 'paused: nothing starts');
  assert.equal((await orch(['foreman', 'resume'], c.env)).code, 0);
  const done = await waitFor(async () => {
    const items = JSON.parse((await orch(['foreman', 'items', '--json'], c.env)).stdout).items;
    return ['needs-review', 'parked'].includes(items[0].state) ? items[0] : null;
  }, { what: 'the item to finish', timeoutMs: 90000, intervalMs: 700 });
  assert.equal(done.state, 'needs-review', done.park_reason);

  assert.equal((await orch(['foreman', 'stop'], c.env)).code, 0);
  const stopped = await first.exited;
  assert.equal(stopped.code, 0, stopped.out);
  assert.match(stopped.out, /foreman stopped/);
  const status = JSON.parse((await orch(['foreman', 'status', '--json'], c.env)).stdout);
  assert.equal(status.running, false);

  const store = Store.open(c.stateRoot);
  const kinds = store.events().map((e) => e.kind);
  for (const k of ['foreman-started', 'goal-approved', 'item-needs-review', 'foreman-stopped']) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
  const run = store.currentRun('alpha-0001');
  store.close();
  assert.ok(run.run_id, 'a run id was recorded');
  const stdout = fs.readFileSync(path.join(c.stateRoot, 'runs', run.run_id, 'stdout.log'), 'utf8');
  assert.match(stdout, new RegExp(`ENV ORCH_RUN_ID=${run.run_id}`), 'the worker saw its own run id');
});
