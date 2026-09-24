// G7 (no autonomous kill) and TG (the keeper's static surface), plus the core
// behaviour checks that survive from the old suite: prompt fidelity from a file
// descriptor, surviving the caller's shell, and PWD forced to the worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  KIT,
  makeCase,
  orch,
  orchViaShell,
  idFrom,
  waitFor,
  waitForStatus,
  keeperLines,
  readRunFile,
  readRunRecord,
  hostileHandoff,
  CANARY_TOKEN,
  identityOf,
} from './helpers.mjs';

const SRC = path.join(KIT, 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const sourceFiles = () => fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs'));

/**
 * A source audit must look at CODE, not at prose. These files document what they must
 * never do ("the keeper never calls taskkill"), and a naive scan reads that as a
 * violation. Strip comments first.
 */
function codeOnly(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const readCode = (f) => codeOnly(read(f));

/* ------------------------------------------------------------- G7 -------- */

test('G7: kill helpers are DEFINED only in procs.mjs and REACHED only from cancel and the viewer', () => {
  const offenders = [];
  for (const f of sourceFiles()) {
    if (f === 'procs.mjs') continue;
    const text = readCode(f);
    if (/\btaskkill\b/i.test(text)) offenders.push(`${f}: names taskkill directly`);
    if (/\bkillChecked\b|\btreeKillChecked\b/.test(text) && !['commands.mjs', 'viewer.mjs'].includes(f)) {
      offenders.push(`${f}: reaches a kill helper`);
    }
    // process.kill() as a signal-sender is forbidden outside procs.mjs entirely.
    if (/process\.kill\s*\(/.test(text)) offenders.push(`${f}: calls process.kill`);
  }
  // adapters must not be able to kill anything either
  for (const f of fs.readdirSync(path.join(SRC, 'adapters'))) {
    const text = codeOnly(fs.readFileSync(path.join(SRC, 'adapters', f), 'utf8'));
    if (/killChecked|treeKillChecked|taskkill|process\.kill\s*\(/i.test(text)) offenders.push(`adapters/${f}: can kill`);
  }
  assert.deepEqual(offenders, [], `autonomous kill surface found:\n${offenders.join('\n')}`);
});

test('G7: the monitor cannot kill the worker or the keeper - its only kill is the viewer', () => {
  const mon = readCode('monitor.mjs');
  assert.ok(!/killChecked|treeKillChecked|taskkill/i.test(mon), 'the monitor must not reach a kill helper directly');
  assert.match(mon, /closeViewer/, 'the viewer close is the monitor\'s only termination path');
  const viewer = readCode('viewer.mjs');
  assert.match(viewer, /killChecked\(pid, recordedCreatedAt/, 'the viewer close must be identity-checked');
  assert.ok(!/treeKillChecked/.test(viewer), 'the viewer must never tree-kill');
});

test('G7: treeKillChecked is reached ONLY by `orch cancel <id>`; killChecked only by cancel --keeper and the viewer', () => {
  const cmds = readCode('commands.mjs');
  // The tree kill appears exactly once, in the worker-cancel path.
  assert.equal((cmds.match(/treeKillChecked\(/g) || []).length, 1);
  const treeIdx = cmds.indexOf('treeKillChecked(');
  const cancelIdx = cmds.indexOf('export async function cmdCancel');
  const keeperIdx = cmds.indexOf('async function cancelKeeper');
  assert.ok(treeIdx > cancelIdx && treeIdx < keeperIdx, 'the tree kill must live inside cmdCancel');
  const singleIdx = cmds.indexOf('killChecked(keeperPid');
  assert.ok(singleIdx > keeperIdx, 'the single kill must live inside cancelKeeper');
  // No kill anywhere in run / status / list / result / log / wait-lane / monitor / gc.
  for (const fn of ['cmdRun', 'cmdStatus', 'cmdList', 'cmdResult', 'cmdLog', 'cmdWaitLane', 'cmdMonitor', 'cmdGc']) {
    const start = cmds.indexOf(`function ${fn}`);
    assert.ok(start > 0, `${fn} not found`);
    // Comments (and therefore the section banners) are stripped, so the body ends at
    // the next top-level declaration.
    const rest = cmds.slice(start + 10);
    const nextDecl = rest.search(/\n(export )?(async )?function /);
    const body = nextDecl > 0 ? rest.slice(0, nextDecl) : rest;
    assert.ok(!/(tree)?[kK]illChecked\(/.test(body), `${fn} can kill something`);
  }
});

test('G7 behavioural: no kill happens during a normal run, a monitor restart, or a failure', { timeout: 180000 }, async (t) => {
  const c = makeCase('g7-behaviour');
  t.after(() => c.cleanup());
  const r = await orch(
    ['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--lane', 'local', '--no-window',
      '--flag', '--emit', '--flag', '240', '--flag', '--interval', '--flag', '500', '--flag', '--stderr', '--flag', 'FAKE-QUOTA'],
    c.env,
  );
  const id = idFrom(r.stdout);
  const workerPid = await waitFor(
    () => {
      const l = keeperLines(c.stateRoot, id).find((x) => x.event === 'spawned');
      return l ? l.worker_pid : null;
    },
    { timeoutMs: 20000, what: 'worker pid' },
  );
  const createdAt = await waitFor(
    () => keeperLines(c.stateRoot, id).find((x) => x.event === 'worker-identity')?.worker_created_at ?? null,
    { timeoutMs: 20000, what: 'worker identity' },
  );
  // Hammer the read-only surface while the run is live. The worker must never be
  // ENDED by any of it; a bounded process query may legitimately answer `unknown`
  // under load, and `unknown` is not evidence of death (it is also not evidence of
  // life, so at least one positive `match` is required).
  const verdicts = [];
  for (let i = 0; i < 5; i++) {
    await orch(['status', '--all', '--json'], c.env);
    await orch(['list', '--json'], c.env);
    await orch(['wait-lane', '--timeout', '1', '--json'], c.env);
    await orch(['monitor', id, '--json'], c.env);
    const v = await identityOf(workerPid, createdAt);
    verdicts.push(v);
    assert.ok(v !== 'gone' && v !== 'mismatch', `a read-only command ended the worker (verdict ${v} at iteration ${i})`);
  }
  assert.ok(verdicts.includes('match'), `the worker was never positively confirmed alive: ${verdicts.join(',')}`);
  // Now end it deliberately - the ONLY sanctioned way a run is terminated.
  const cancelled = await orch(['cancel', id, '--json'], c.env);
  assert.equal(JSON.parse(cancelled.stdout).cancel_state, 'cancelled');
  const rec = await waitForStatus(c.stateRoot, id, ['cancelled', 'failed', 'interrupted'], { timeoutMs: 60000 });
  assert.equal(rec.status, 'cancelled', 'only an operator-directed cancel may end a run');
  assert.ok(keeperLines(c.stateRoot, id).some((l) => l.event === 'worker-exit'));
});

/* ------------------------------------------------------------- TG -------- */

test('TG: the keeper imports only node:fs, node:net, node:child_process and node:path', () => {
  const src = readCode('keeper.mjs');
  const imports = [...src.matchAll(/^import .*? from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(new Set(imports), new Set(['node:fs', 'node:net', 'node:path', 'node:child_process']), `keeper imports: ${imports}`);
  assert.ok(!/require\(/.test(src));
});

test('TG: the keeper contains no execFileSync, no taskkill and no kill of any kind', () => {
  const src = readCode('keeper.mjs');
  assert.ok(!/execFileSync|execSync|spawnSync/.test(src), 'a synchronous process call can block the keeper forever');
  assert.ok(!/taskkill/i.test(src));
  assert.ok(!/\.kill\s*\(|killChecked|treeKillChecked/.test(src), 'the keeper never kills anything (N3)');
});

test('TG: the keeper parses JSON only in Phase A, and never after the spawn', () => {
  const src = readCode('keeper.mjs');
  const spawnIdx = src.indexOf('child = spawn(');
  assert.ok(spawnIdx > 0);
  const after = src.slice(spawnIdx);
  assert.ok(!/JSON\.parse/.test(after), 'a parse after the spawn is exactly the class of bug that killed v1 runs');
  const parses = (src.match(/JSON\.parse/g) || []).length;
  assert.equal(parses, 2, `expected exactly two Phase-A parses (run.json and the holder facts), found ${parses}`);
});

test('TG: the keeper has no process.exit between the spawn and the keeper-exit line', () => {
  const src = readCode('keeper.mjs');
  const spawnIdx = src.indexOf('child = spawn(');
  const finishIdx = src.indexOf("append(F.keeper, { event: 'keeper-exit'");
  assert.ok(spawnIdx > 0 && finishIdx > spawnIdx);
  const between = src.slice(spawnIdx, finishIdx);
  assert.ok(!/process\.exit\(/.test(between), 'Phase B must not be able to exit before the keeper-exit line');
  // The only exits after that point are inside the final teardown.
  const tail = src.slice(finishIdx);
  assert.equal((tail.match(/process\.exit\(/g) || []).length, 1, 'exactly one exit in the final teardown');
});

test('TG: server.close() happens only after the worker exit is observed (v3 H1)', () => {
  const src = readCode('keeper.mjs');
  assert.equal((src.match(/server\.close\(/g) || []).length, 1);
  const closeIdx = src.indexOf('server.close(');
  const exitLineIdx = src.indexOf("append(F.keeper, { event: 'worker-exit'");
  assert.ok(closeIdx > exitLineIdx, 'the lane must not be released before the worker exit is recorded');
  // agy L2: the process exit happens in the close callback, not on the next line.
  assert.match(src, /server\.close\(go\)/);
});

test('TG: the keeper attaches a socket error handler INSIDE the connection callback (agy H3)', () => {
  const src = readCode('keeper.mjs');
  const m = /server\.on\('connection', \(s\) => \{([\s\S]*?)\n  \}\);/.exec(src);
  assert.ok(m, 'connection handler not found');
  assert.match(m[1], /s\.on\('error'/, "the socket's own error handler must be inside the callback");
  assert.match(m[1], /s\.end\(HELLO\)/, 'agy H2: `end(payload)` must be used, never write-then-destroy');
  assert.ok(!/s\.write\(/.test(m[1]), 'a queued write followed by destroy can discard the hello');
  // and `s` is never referenced outside the callback
  assert.ok(!/^\s*s\.on\('error'/m.test(src.replace(m[0], '')), 'the socket identifier must not leak out of scope');
});

test('TG: the deleted surface really is gone', () => {
  const files = fs.readdirSync(SRC);
  assert.ok(!files.includes('supervisor.mjs'), 'supervisor.mjs must be deleted');
  assert.ok(!files.includes('lane.mjs'), 'the file-lease lane must be deleted');
  assert.ok(!files.includes('lanelive.mjs'), 'the live/ survivor precheck must not exist');
  const all = sourceFiles().map(readCode).join('\n');
  for (const gone of ['ORCH_LANE_ROOT', 'escapees.json', 'unclaimedHoldSeconds', 'queuePosition', 'identityMatches', 'isAlive(']) {
    assert.ok(!all.includes(gone), `deleted symbol still present: ${gone}`);
  }
  // no ticket sequencer, no acquisition loop
  assert.ok(!/queue\/<?NNNNNN|ticket/i.test(all), 'the ticket sequencer must be gone');
});

test('TG: nothing in src/ reaches the opencode shared log or a cmd.exe shim', () => {
  const all = sourceFiles()
    .map(readCode)
    .concat(fs.readdirSync(path.join(SRC, 'adapters')).map((f) => codeOnly(fs.readFileSync(path.join(SRC, 'adapters', f), 'utf8'))))
    .join('\n');
  assert.ok(!/opencode[\\/]log|bindSession|hasOwnedActivity|parseRunTag/.test(all), 'the shared-log reader must be gone (r2-6, r3-1)');
  assert.ok(!/cmd\.exe['"]\s*,/.test(all), 'nothing may spawn cmd.exe');
  assert.ok(!/['"]\/d['"],\s*['"]\/s['"]/.test(all), 'the cmd.exe shim argv must be gone');
});

/* ------------------------------------------- core behaviour (T1/T2/T8) --- */

test('T1: the prompt reaches the worker BYTE-EXACT from a file descriptor', { timeout: 120000 }, async (t) => {
  const handoff = hostileHandoff({ nonAscii: true });
  const c = makeCase('t1-fidelity', { handoff });
  t.after(() => c.cleanup());
  const r = await orch(['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--no-window'], c.env);
  const id = idFrom(r.stdout);
  await waitForStatus(c.stateRoot, id, ['completed', 'failed'], { timeoutMs: 60000 });
  const out = readRunFile(c.stateRoot, id, 'stdout.log');
  const expected = crypto.createHash('sha256').update(Buffer.from(handoff, 'utf8')).digest('hex');
  assert.match(out, new RegExp(`STDIN-SHA256 ${expected}`), 'the prompt was altered on the way to the worker');
  assert.match(out, new RegExp(`STDIN-BYTES ${Buffer.byteLength(handoff, 'utf8')}`));
  // The prompt file itself is a byte copy of the handoff.
  assert.equal(readRunFile(c.stateRoot, id, 'prompt.txt'), handoff);
  const rec = readRunRecord(c.stateRoot, id);
  assert.equal(rec.prompt_sha256, expected);
  assert.ok(handoff.includes(CANARY_TOKEN));
});

test('T1: the prompt is delivered as a FILE DESCRIPTOR, not written to a pipe', () => {
  const src = readCode('keeper.mjs');
  assert.match(src, /stdio: \[fdIn, fdOut, fdErr\]/, 'all three streams must be file descriptors (K1)');
  assert.ok(!/stdin\.write|stdin\.end/.test(src), 'the write-then-close stdin path is deleted');
});

test('T2/T8: the run survives its caller and its shell, and PWD is forced to the worktree', { timeout: 180000 }, async (t) => {
  const c = makeCase('t2-survive');
  t.after(() => c.cleanup());
  const res = await orchViaShell(
    ['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--no-window',
      '--flag', '--emit', '--flag', '6', '--flag', '--interval', '--flag', '400', '--flag', '--write-file', '--flag', 'survived.txt'],
    c.env,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const id = idFrom(res.stdout);
  // The launching shell is gone; the run is not.
  const rec = await waitForStatus(c.stateRoot, id, ['completed', 'failed'], { timeoutMs: 90000 });
  assert.equal(rec.status, 'completed');
  assert.ok(fs.existsSync(path.join(c.work, 'survived.txt')));
  const out = readRunFile(c.stateRoot, id, 'stdout.log');
  // T8: the adapter must override the poisoned PWD the test environment set.
  assert.match(out, new RegExp(`PWD-ENV ${c.work.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`), 'PWD was not forced to --dir');
  assert.match(out, new RegExp(`CWD ${c.work.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  assert.ok(!out.includes('C:\\definitely\\not\\the\\worktree'));
  assert.match(out, /TICK 6\/6/);
});

test('T6: exit 0 with empty output is `failed: empty-output`, never `completed`', { timeout: 120000 }, async (t) => {
  const c = makeCase('t6-empty');
  t.after(() => c.cleanup());
  const r = await orch(['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--no-window', '--flag', '--empty'], c.env);
  const id = idFrom(r.stdout);
  const rec = await waitForStatus(c.stateRoot, id, ['completed', 'failed'], { timeoutMs: 60000 });
  assert.equal(rec.status, 'failed');
  assert.equal(rec.reason, 'empty-output');
});

test('the run record carries every field an operator needs, and the launch block the keeper reads', { timeout: 120000 }, async (t) => {
  const c = makeCase('record');
  t.after(() => c.cleanup());
  const r = await orch(['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--no-window'], c.env);
  const id = idFrom(r.stdout);
  const rec = readRunRecord(c.stateRoot, id);
  for (const k of ['id', 'cli', 'lane', 'model_canonical', 'dir', 'dir_real', 'prompt_sha256', 'prompt_bytes',
    'created_at', 'state_root', 'lane_id', 'lane_pipe', 'lane_dir', 'launch']) {
    assert.ok(rec[k] !== undefined, `run.json is missing ${k}`);
  }
  assert.equal(typeof rec.launch.exe, 'string');
  assert.ok(Array.isArray(rec.launch.args));
  assert.deepEqual(rec.launch.env_set, { PWD: c.work });
  assert.equal(rec.launch.pipe_name, `\\\\.\\pipe\\orch-lane-${c.laneId}-${rec.lane}`);
  await waitForStatus(c.stateRoot, id, ['completed', 'failed'], { timeoutMs: 60000 });
});

test('T-v2-7 end to end: directory evidence is read from the run\'s OWN stderr.log', { timeout: 120000 }, async (t) => {
  const match = makeCase('dir-match', { dirEvidence: true });
  const mism = makeCase('dir-mismatch', { dirEvidence: true });
  t.after(() => {
    match.cleanup();
    mism.cleanup();
  });

  const a = await orch(
    ['run', '--cli', 'fake', '--dir', match.work, '--handoff', match.handoffPath, '--no-window',
      '--flag', '--session-dir', '--flag', match.work, '--flag', '--session-split', '--flag', '7'],
    match.env,
  );
  const aId = idFrom(a.stdout);
  const aRec = await waitForStatus(match.stateRoot, aId, ['completed', 'failed'], { timeoutMs: 60000 });
  assert.equal(aRec.dir_evidence, 'match', `evidence: ${JSON.stringify(aRec.dir_sessions)}`);
  assert.equal(aRec.status, 'completed', 'a session line split at every 7 bytes must still be framed correctly');

  const b = await orch(
    ['run', '--cli', 'fake', '--dir', mism.work, '--handoff', mism.handoffPath, '--no-window',
      '--flag', '--session-dir', '--flag', match.work],
    mism.env,
  );
  const bId = idFrom(b.stdout);
  const bRec = await waitForStatus(mism.stateRoot, bId, ['completed', 'failed'], { timeoutMs: 60000 });
  assert.equal(bRec.dir_evidence, 'mismatch');
  assert.equal(bRec.status, 'failed');
  assert.equal(bRec.reason, 'wrong-directory');
  assert.match(bRec.status_note, /BOTH places/, 'the wording must not claim the worktree is untouched');
  assert.ok(fs.existsSync(path.join(mism.stateRoot, 'runs', bId, 'dirlatch.json')), 'the mismatch latch must be persisted');
});

test('a run with no session line at all is `directory-unverified`, stated as missing evidence', { timeout: 120000 }, async (t) => {
  const c = makeCase('dir-none', { dirEvidence: true });
  t.after(() => c.cleanup());
  const r = await orch(['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--no-window'], c.env);
  const id = idFrom(r.stdout);
  const rec = await waitForStatus(c.stateRoot, id, ['completed', 'failed'], { timeoutMs: 60000 });
  assert.equal(rec.status, 'failed');
  assert.equal(rec.reason, 'directory-unverified');
  assert.match(rec.status_note, /MISSING EVIDENCE/);
});
