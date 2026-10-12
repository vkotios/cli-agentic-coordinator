import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { laneScope } from '../src/lanescope.mjs';
import { connectHello, probeFree, tryListen } from '../src/lanepipe.mjs';
import { killChecked, ownChildCreationTime, readProcessTable, treeKillChecked, verifyIdentity } from '../src/procs.mjs';
import { resolveCliExe } from '../src/exe.mjs';
import { buildViewerAttempts } from '../src/viewer.mjs';

test('Linux serial lanes use a private filesystem socket and release it on close', { skip: process.platform !== 'linux' }, async (t) => {
  const scope = laneScope('local');
  assert.ok(path.isAbsolute(scope.pipeName), 'the lane address must be an absolute Unix socket path');
  assert.ok(scope.pipeName.endsWith('.sock'));
  assert.ok(scope.pipeName.length < 108, 'Unix socket path must fit Linux sockaddr_un');
  assert.equal(path.dirname(scope.pipeName), path.join(os.tmpdir(), `.orch-${process.getuid()}`));

  const bound = await tryListen(scope.pipeName);
  assert.equal(bound.ok, true, JSON.stringify(bound));
  const server = bound.server;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.on('connection', (socket) => socket.end('keeper-ready\n'));

  const dir = fs.statSync(path.dirname(scope.pipeName));
  assert.equal(dir.uid, process.getuid());
  assert.equal(dir.mode & 0o777, 0o700);
  assert.deepEqual(await probeFree(scope.pipeName), { free: false, code: 'EADDRINUSE' });
  assert.equal((await connectHello(scope.pipeName)).hello, 'keeper-ready');

  await new Promise((resolve) => server.close(resolve));
  assert.equal(fs.existsSync(scope.pipeName), false, 'closing the owner releases the socket path');
  assert.deepEqual(await probeFree(scope.pipeName), { free: true, code: null });
});

test('Linux supervisor removes its lane socket when the keeper died before supervisor startup', { skip: process.platform !== 'linux' }, async (t) => {
  const socketDir = path.join(os.tmpdir(), `.orch-${process.getuid()}`);
  const socketPath = path.join(socketDir, `lane-${process.pid}-orphan.sock`);
  const sentinel = path.join(os.tmpdir(), `orch-orphan-worker-${process.pid}-${Date.now()}`);
  const supervisorPath = fileURLToPath(new URL('../src/linux-worker-supervisor.mjs', import.meta.url));
  t.after(() => fs.rmSync(sentinel, { force: true }));

  const keeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { if (keeper.exitCode === null && keeper.signalCode === null) keeper.kill('SIGKILL'); });
  await once(keeper, 'spawn');
  const keeperIdentity = await ownChildCreationTime(keeper.pid, { deadlineMs: 1000 });
  assert.ok(keeperIdentity?.startsWith('ticks:'), `unexpected keeper identity: ${keeperIdentity}`);
  const keeperClosed = once(keeper, 'close');
  keeper.kill('SIGKILL');
  await keeperClosed;

  const bound = await tryListen(socketPath);
  assert.equal(bound.ok, true, JSON.stringify(bound));
  t.after(() => new Promise((resolve) => bound.server.close(resolve)));
  const socket = fs.lstatSync(socketPath);
  const workerCode = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'started')`;
  const supervisor = spawn(process.execPath, [
    supervisorPath,
    process.execPath,
    JSON.stringify(['-e', workerCode]),
    String(keeper.pid),
    keeperIdentity.slice('ticks:'.length),
    socketPath,
    String(socket.dev),
    String(socket.ino),
  ], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const [code] = await once(supervisor, 'close');

  assert.equal(code, 125, 'a dead keeper must prevent worker admission');
  assert.equal(fs.existsSync(sentinel), false, 'the requested worker must not start');
  assert.equal(fs.existsSync(socketPath), false, 'the supervisor must release only its captured socket');
});

test('Linux CLI discovery resolves executable names directly from PATH', { skip: process.platform !== 'linux' }, (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-path-test-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const cli = path.join(bin, 'codex');
  fs.writeFileSync(cli, '#!/bin/sh\\nexit 0\\n');
  fs.chmodSync(cli, 0o755);
  const notExecutable = path.join(bin, 'not-executable');
  fs.writeFileSync(notExecutable, 'data');
  fs.chmodSync(notExecutable, 0o644);
  const old = process.env.ORCH_CODEX_EXE;
  delete process.env.ORCH_CODEX_EXE;
  try {
    assert.equal(resolveCliExe('codex', { env: { ...process.env, PATH: bin } }), cli);
    assert.throws(
      () => resolveCliExe('not-executable', { env: { ...process.env, PATH: bin } }),
      (error) => error instanceof Error && 'code' in error && error.code === 'cli-not-found' && error.message.includes('<path to the executable>'),
    );
  } finally {
    if (old === undefined) delete process.env.ORCH_CODEX_EXE;
    else process.env.ORCH_CODEX_EXE = old;
  }
});

test('Linux does not attempt to open a Windows terminal viewer', { skip: process.platform !== 'linux' }, () => {
  assert.deepEqual(buildViewerAttempts({ logPath: '/tmp/run.log', pidFile: '/tmp/viewer.pid', title: 'orch run' }), []);
});

test('Linux process identity is read from /proc and a verified child can be killed', { skip: process.platform !== 'linux' }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'spawn');
  const closed = once(child, 'close');

  const createdAt = await ownChildCreationTime(child.pid, { deadlineMs: 1000 });
  assert.match(createdAt || '', /^ticks:\d+$/);
  const table = await readProcessTable({ deadlineMs: 1000, pids: [child.pid] });
  assert.equal(verifyIdentity(child.pid, createdAt, table).verdict, 'match');

  const refused = await killChecked(child.pid, 'ticks:0', { deadlineMs: 1000 });
  assert.equal(refused.verdict, 'mismatch');
  assert.equal(refused.killed, false);
  const killed = await killChecked(child.pid, createdAt, { deadlineMs: 1000 });
  assert.equal(killed.killed, true, killed.output);
  await closed;
});

test('Linux refuses PID 1 cancellation without sending a signal', { skip: process.platform !== 'linux' }, async () => {
  const table = await readProcessTable({ deadlineMs: 1000, pids: [1] });
  const init = table?.find((proc) => proc.pid === 1);
  assert.ok(init, 'PID 1 must be visible to validate the dangerous signal target');
  const createdAt = init.createdAt;
  assert.match(createdAt || '', /^ticks:\d+$/);
  assert.equal(verifyIdentity(1, createdAt, table).verdict, 'match');

  /** @type {Array<[number, unknown]>} */
  const calls = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    return true;
  };
  try {
    const result = await killChecked(1, createdAt, { table });
    assert.equal(result.killed, false, result.output);
    assert.deepEqual(calls, [], 'unsafe PID 1 must be rejected before process.kill(1, ...)');
  } finally {
    process.kill = originalKill;
  }
});

test('Linux refuses PID 1 group cancellation instead of signaling process group -1', { skip: process.platform !== 'linux' }, async (t) => {
  const table = await readProcessTable({ deadlineMs: 1000, pids: [1] });
  const init = table?.find((proc) => proc.pid === 1);
  assert.ok(init, 'PID 1 must be visible to validate the dangerous process-group target');
  if (init.pgrp !== 1 || init.session !== 1) {
    t.skip('PID 1 is not a session leader in this Linux environment');
    return;
  }
  const createdAt = init.createdAt;
  assert.match(createdAt || '', /^ticks:\d+$/);
  assert.equal(verifyIdentity(1, createdAt, table).verdict, 'match');

  /** @type {Array<[number, unknown]>} */
  const calls = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    return true;
  };
  try {
    const result = await treeKillChecked(1, createdAt, { deadlineMs: 1000 });
    assert.equal(result.killed, false, result.output);
    assert.deepEqual(calls, [], 'unsafe PID 1 must be rejected before process.kill(-1, ...)');
  } finally {
    process.kill = originalKill;
  }
});

test('Linux refuses process-group cancellation for a verified non-session-leader child', { skip: process.platform !== 'linux' }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'spawn');

  const createdAt = await ownChildCreationTime(child.pid, { deadlineMs: 1000 });
  assert.match(createdAt || '', /^ticks:\d+$/);
  const table = await readProcessTable({ deadlineMs: 1000, pids: [child.pid] });
  const hit = table?.find((proc) => proc.pid === child.pid);
  assert.ok(hit, 'the launched child must be present in the process table');
  assert.equal(verifyIdentity(child.pid, createdAt, table).verdict, 'match');
  assert.ok(hit.pgrp !== child.pid || hit.session !== child.pid, 'a non-detached child must not lead its own process group and session');

  /** @type {Array<[number, unknown]>} */
  const calls = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    return true;
  };
  try {
    const result = await treeKillChecked(child.pid, createdAt, { table });
    assert.equal(result.killed, false, result.output);
    assert.equal(result.verdict, 'unknown');
    assert.match(result.output, /refusing process-group kill/);
    assert.deepEqual(calls, [], 'a non-session-leader child must be rejected before process.kill');
  } finally {
    process.kill = originalKill;
  }

  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
});

test('Linux tree cancellation kills the verified worker process group', { skip: process.platform !== 'linux' }, async (t) => {
  const code = "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);";
  const root = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (root.exitCode === null && root.signalCode === null) root.kill('SIGKILL'); });
  await once(root, 'spawn');
  const grandchildPid = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('worker did not report its child pid')), 3000);
    root.stdout.on('data', (chunk) => {
      text += chunk;
      const pid = Number(text.trim().split(/\\r?\\n/)[0]);
      if (Number.isInteger(pid) && pid > 0) { clearTimeout(timer); resolve(pid); }
    });
    root.once('error', reject);
  });
  const closed = once(root, 'close');
  const table = await readProcessTable({ deadlineMs: 1000, pids: [root.pid, grandchildPid] });
  assert.equal(table?.length, 2);
  assert.equal(table.find((p) => p.pid === root.pid).pgrp, root.pid);
  assert.equal(table.find((p) => p.pid === grandchildPid).pgrp, root.pid);
  const createdAt = await ownChildCreationTime(root.pid, { deadlineMs: 1000 });
  const result = await treeKillChecked(root.pid, createdAt, { deadlineMs: 1000 });
  assert.equal(result.killed, true, result.output);
  await closed;
});
