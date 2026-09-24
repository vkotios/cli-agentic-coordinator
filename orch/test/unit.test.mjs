// Unit tests: pure logic, no processes. Every finding of review rounds 2-3 and of the
// two v4 reviews that is answered by a pure function has its named test here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseArgs } from '../bin/orch.mjs';
import { verifyIdentity, normalizeCreationTime, descendantsOf } from '../src/procs.mjs';
import { deriveStatus, protocolErrorText, WRONG_DIRECTORY_NOTE, DIRECTORY_UNVERIFIED_NOTE } from '../src/statusrules.mjs';
import { DirectoryEvidence, parseSessionLine, parseBootstrapLine, stripAnsi, compareDirs, realpathOrNull } from '../src/direvidence.mjs';
import { Tailer } from '../src/tailer.mjs';
import { laneScope, userLaneIdentifier, assertLaneOverrideAllowed, laneHome } from '../src/lanescope.mjs';
import { resolveStateRoot } from '../src/config.mjs';
import { keeperFacts, TERMINAL } from '../src/store.mjs';
import { mergeVibeConfig, pickModelFromMeta, findSessionMeta, fallbackWarningsSince, isModelMismatch, messageText } from '../src/adapters/vibe.mjs';
import vibe from '../src/adapters/vibe.mjs';
import opencode from '../src/adapters/opencode.mjs';
import { scanNewestMtime, Deadline, withDeadline, readTailLines } from '../src/util.mjs';

const TMP = path.join(os.tmpdir(), 'orch-unit-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(TMP, { recursive: true });
test.after?.(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
const tmpFile = (name, content = '') => {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, content);
  return f;
};

/* ------------------------------------------------------------- argv ------- */

test('parseArgs: booleans, repeatables, = form, and a missing value', () => {
  const a = parseArgs(['--cli', 'fake', '--json', '--flag', 'x', '--flag', 'y', '--model=a b', 'pos']);
  assert.equal(a.cli, 'fake');
  assert.equal(a.json, true);
  assert.deepEqual(a.flag, ['x', 'y']);
  assert.equal(a.model, 'a b');
  assert.deepEqual(a._, ['pos']);
  assert.equal(parseArgs(['--keeper']).keeper, true);
  assert.throws(() => parseArgs(['--model']), /needs a value/);
});

/* --------------------------------------------- T-identity (r2-1, r3-5) ---- */

test('T-identity: verifyIdentity has four labels and never converts unknown to gone', () => {
  const table = [
    { pid: 10, ppid: 1, name: 'a.exe', createdAt: 'ms:1000' },
    { pid: 11, ppid: 10, name: 'b.exe', createdAt: null },
  ];
  assert.equal(verifyIdentity(10, 'ms:1000', table).verdict, 'match');
  assert.equal(verifyIdentity(10, 'ms:9999', table).verdict, 'mismatch', 'pid reuse must be a mismatch');
  assert.equal(verifyIdentity(12, 'ms:1000', table).verdict, 'gone');
  assert.equal(verifyIdentity(10, null, table).verdict, 'unknown', 'nothing recorded to compare => unknown');
  assert.equal(verifyIdentity(11, 'ms:1000', table).verdict, 'unknown', 'null creation time => unknown');
  assert.equal(verifyIdentity(10, 'ms:1000', null).verdict, 'unknown', 'unreadable table => unknown, NEVER gone');
  assert.equal(verifyIdentity(null, 'ms:1', table).verdict, 'unknown', 'astra H2: no recorded pid is not evidence of death');
});

test('normalizeCreationTime accepts the CIM /Date(n)/ form, ISO strings and numbers', () => {
  assert.equal(normalizeCreationTime('/Date(1789766490459)/'), 'ms:1789766490459');
  assert.equal(normalizeCreationTime(1789766490459), 'ms:1789766490459');
  assert.equal(normalizeCreationTime('2026-09-18T21:21:31.868Z'), `ms:${Date.parse('2026-09-18T21:21:31.868Z')}`);
  assert.equal(normalizeCreationTime(null), null);
});

test('descendantsOf walks a snapshot without touching the OS', () => {
  const table = [
    { pid: 1, ppid: 0, name: 'root', createdAt: null },
    { pid: 2, ppid: 1, name: 'child', createdAt: null },
    { pid: 3, ppid: 2, name: 'grand', createdAt: null },
    { pid: 4, ppid: 99, name: 'other', createdAt: null },
  ];
  assert.deepEqual(descendantsOf(1, table).map((p) => p.pid), [2, 3]);
  assert.deepEqual(descendantsOf(1, null), []);
});

/* ------------------------------------------------------- lane scope ------- */

test('r2-4: the lane pipe and the lane directory come from ONE identifier, never from --state-root', () => {
  const before = process.env.ORCH_LANE_ID;
  delete process.env.ORCH_LANE_ID;
  const s = laneScope('local');
  assert.equal(s.laneId, userLaneIdentifier());
  assert.match(s.pipeName, /^\\\\\.\\pipe\\orch-lane-[0-9a-f]{12}-local$/);
  assert.equal(s.laneDir, path.join(laneHome(), `${s.laneId}-local`));
  // Not inside the state root in effect (whatever ORCH_STATE_ROOT / the config say).
  const rel = path.relative(resolveStateRoot(), s.laneDir);
  assert.ok(rel.startsWith('..') || path.isAbsolute(rel), 'the lane directory must not live under a state root');
  assert.ok(!s.laneDir.includes(`${path.sep}.state${path.sep}`), 'nor under the default state root');
  // The identifier is derived, not inherited.
  // Derived from the TOKEN-backed account data, never from os.homedir() (astra H1).
  const expected = crypto.createHash('sha256').update(`${os.userInfo().homedir}|${os.userInfo().username}`).digest('hex').slice(0, 12);
  assert.equal(s.laneId, expected);
  process.env.ORCH_LANE_ID = before ?? '';
  if (before === undefined) delete process.env.ORCH_LANE_ID;
});

test('local and cloud are different lanes; the override is sanitised', () => {
  const before = process.env.ORCH_LANE_ID;
  process.env.ORCH_LANE_ID = 'te st/../weird';
  const l = laneScope('local');
  const c = laneScope('cloud');
  assert.notEqual(l.pipeName, c.pipeName);
  assert.equal(l.laneId, 'test..weird'.replace(/[^A-Za-z0-9_-]/g, ''));
  assert.ok(!l.pipeName.includes('/'));
  if (before === undefined) delete process.env.ORCH_LANE_ID;
  else process.env.ORCH_LANE_ID = before;
});

test('the lane override is refused for a real CLI and allowed for the fake worker', () => {
  const before = process.env.ORCH_LANE_ID;
  process.env.ORCH_LANE_ID = 'unit';
  assert.throws(() => assertLaneOverrideAllowed({ name: 'opencode' }), /lane override|ORCH_LANE_ID is set/);
  assert.throws(() => assertLaneOverrideAllowed({ name: 'vibe' }), /ORCH_LANE_ID is set/);
  assert.doesNotThrow(() => assertLaneOverrideAllowed({ name: 'fake', testOnly: true }));
  delete process.env.ORCH_LANE_ID;
  assert.doesNotThrow(() => assertLaneOverrideAllowed({ name: 'opencode' }));
  if (before !== undefined) process.env.ORCH_LANE_ID = before;
});

/* ------------------------------------------- keeper facts / A2 / A3 ------- */

test('keeperFacts reads the fixed line shapes, including the A2 worker-identity line', () => {
  const lines = [
    '{"event":"lane-acquired","at":"t0"}',
    '{"event":"spawned","worker_pid":42,"at":"t1"}',
    '{"event":"worker-identity","worker_pid":42,"worker_created_at":"ms:5","at":"t2"}',
    'this line is not json',
    '{"event":"worker-exit","code":0,"signal":null,"at":"t3"}',
    '{"event":"keeper-exit","write_failures":2,"at":"t4"}',
  ];
  const f = keeperFacts(lines);
  assert.equal(f.workerPid, 42);
  assert.equal(f.workerCreatedAt, 'ms:5');
  assert.deepEqual(f.workerExit, { code: 0, signal: null, at: 't3' });
  assert.equal(f.writeFailures, 2);
  assert.equal(keeperFacts(['{"blocked":"no-exe-entrypoint","at":"t"}']).blocked.reason, 'no-exe-entrypoint');
});

test('M7: `blocked` is a terminal status', () => {
  assert.ok(TERMINAL.has('blocked'));
  assert.ok(TERMINAL.has('completed') && TERMINAL.has('failed') && TERMINAL.has('interrupted'));
});

/* --------------------------------- status precedence (v3 §5 + M7 + A3) ---- */

/** @type {any} */
const base = {
  cancelRequested: false,
  workerConfirmedGone: true,
  blocked: null,
  workerExitSeen: true,
  keeperVerdict: 'gone',
  exitCode: 0,
  signal: null,
  stdout: 'output',
  stderr: '',
  events: [],
  dirEvidence: 'match',
  directoryRelevant: true,
};

test('T-v2-10: the precedence table, cross-product', () => {
  const d = (/** @type {any} */ o) => deriveStatus([], { ...base, ...o });
  // 1 cancel, only once the worker is confirmed gone
  assert.equal(d({ cancelRequested: true }).status, 'cancelled');
  // 2 blocked precedes interrupted (M7): a Phase-A refusal has no worker-exit line
  assert.deepEqual(
    pick(d({ blocked: { reason: 'no-exe-entrypoint' }, workerExitSeen: false, keeperVerdict: 'gone' })),
    ['blocked', 'no-exe-entrypoint'],
  );
  // 3 interrupted
  assert.deepEqual(pick(d({ workerExitSeen: false, keeperVerdict: 'gone' })), ['interrupted', 'keeper-gone-without-exit']);
  // 4 latched mismatch beats exit 0 with output
  assert.deepEqual(pick(d({ dirEvidence: 'mismatch' })), ['failed', 'wrong-directory']);
  // 5 adapter reclassification requires a non-zero exit
  assert.equal(deriveStatus(vibe.statusRules, { ...base, directoryRelevant: false, exitCode: 1, stderr: '<vibe_stop_event>Turn limit of 6 reached</vibe_stop_event>' }).status, 'turn-cap');
  // 6 exit non-zero
  assert.deepEqual(pick(d({ exitCode: 1, dirEvidence: 'none' })), ['failed', 'exit-1']);
  // 7 empty output
  assert.deepEqual(pick(d({ stdout: '   ' })), ['failed', 'empty-output']);
  // 8 missing evidence
  assert.deepEqual(pick(d({ dirEvidence: 'none' })), ['failed', 'directory-unverified']);
  // 9 completed
  assert.deepEqual(pick(d({})), ['completed', 'exit-0-with-output']);
  // a signal-terminated worker
  assert.deepEqual(pick(d({ exitCode: null, signal: 'SIGKILL' })), ['failed', 'exit-signal-SIGKILL']);
});

test('A3 / codex H3: cancel.json alone can NEVER make a live worker look terminal', () => {
  const live = deriveStatus([], { ...base, cancelRequested: true, workerExitSeen: false, workerConfirmedGone: false, keeperVerdict: 'match' });
  assert.equal(live.terminal, false);
  assert.equal(live.status, 'running');
  assert.match(live.reason, /cancel-requested-worker-not-confirmed-gone/);
  // and an unknown keeper is not a licence either
  const unknown = deriveStatus([], { ...base, cancelRequested: true, workerExitSeen: false, workerConfirmedGone: false, keeperVerdict: 'unknown' });
  assert.equal(unknown.terminal, false);
});

test('M7: vibe has a `completed` branch with no directory clause', () => {
  assert.equal(vibe.directoryEvidence, false);
  const r = deriveStatus(vibe.statusRules, { ...base, directoryRelevant: false, dirEvidence: 'none' });
  assert.equal(r.status, 'completed');
});

test('THE RULE ABOUT RULES: free worker text on stdout can never reclassify a run', () => {
  const hostile = 'the file said: You have hit your usage limit and quota exceeded\n';
  const r = deriveStatus(vibe.statusRules, { ...base, directoryRelevant: false, exitCode: 0, stdout: hostile, stderr: '' });
  assert.equal(r.status, 'completed', 'stdout content must never be matched by a rule');
  // the same phrase on stderr WITH a non-zero exit is a real signal
  const real = deriveStatus(vibe.statusRules, { ...base, directoryRelevant: false, exitCode: 1, stdout: hostile, stderr: 'usage limit' });
  assert.equal(real.status, 'blocked-quota');
});

test('protocolErrorText reads error records only, never an effect payload', () => {
  const events = [
    { type: 'effect', title: 'read_file', detail: 'usage limit appears in this file' },
    { type: 'message', role: 'assistant', content: 'quota exceeded' },
    { type: 'turn.failed', message: 'provider says: usage limit' },
    { type: 'x', error: { message: 'rate limit exceeded' } },
  ];
  const text = protocolErrorText(events);
  assert.match(text, /provider says: usage limit/);
  assert.match(text, /rate limit exceeded/);
  assert.doesNotMatch(text, /appears in this file/);
});

test('mandated wording: neither directory verdict overclaims', () => {
  assert.doesNotMatch(WRONG_DIRECTORY_NOTE, /untouched/);
  assert.match(WRONG_DIRECTORY_NOTE, /BOTH places/);
  assert.match(DIRECTORY_UNVERIFIED_NOTE, /MISSING EVIDENCE/);
});

function pick(r) {
  return [r.status, r.reason];
}

/* --------------------------------------- T-v2-7: directory evidence ------- */

const WT = path.join(TMP, 'worktree');
const ELSEWHERE = path.join(TMP, 'elsewhere');
fs.mkdirSync(WT, { recursive: true });
fs.mkdirSync(ELSEWHERE, { recursive: true }); // must EXIST, or it is `unresolved`, not `mismatch`
const WT_REAL = realpathOrNull(WT);
const line = (dir, id = 'ses_aaa111') =>
  `timestamp=2026-09-18T21:21:32.905Z level=INFO run=4080e72a message=created id=${id} slug=swift-wolf version=1.18.31 directory="${String(dir).replace(/\\/g, '\\\\')}"`;

test('T-v2-7: the directory evidence table', () => {
  const ev = (lines) => {
    const e = new DirectoryEvidence(WT_REAL);
    e.feed(lines);
    return e.verdict();
  };
  assert.equal(ev([line(WT)]), 'match');
  assert.equal(ev([line(ELSEWHERE)]), 'mismatch', 'a resolvable OTHER directory is a genuine mismatch');
  assert.equal(ev([]), 'none', 'no session line at all');
  assert.equal(ev(['timestamp=x level=INFO message=bootstrapping directory="C:\\\\other"']), 'none', 'a bootstrapping line never decides');
  // O3 shape: several bootstrapping lines naming different directories + one good session line
  assert.equal(
    ev([
      'timestamp=x level=INFO run=a message=bootstrapping directory="C:\\\\one"',
      'timestamp=x level=INFO run=a message=bootstrapping directory="C:\\\\two"',
      line(WT),
    ]),
    'match',
  );
  // mixed match + unresolved -> none (unresolved prevents completion)
  assert.equal(ev([line(WT), line(path.join(TMP, 'does-not-exist-xyz'), 'ses_bbb222')]), 'none');
  // mixed match + a real mismatch -> mismatch
  assert.equal(ev([line(WT), line(ELSEWHERE, 'ses_bbb222')]), 'mismatch');
  // ANSI-coloured interleaving is tolerated
  assert.equal(ev(['\u001b[0m> build \u00b7 qwen3.8-flash-next\u001b[0m', line(WT)]), 'match');
});

test('T-v2-7: a mismatch LATCHES - no later evidence can undo it', () => {
  const e = new DirectoryEvidence(WT_REAL);
  e.feed([line(ELSEWHERE)]);
  assert.equal(e.verdict(), 'mismatch');
  e.feed([line(WT), line(WT, 'ses_ccc333')]);
  assert.equal(e.verdict(), 'mismatch', 'the latch was lost');
  // and a replacement monitor restores it from the persisted latch
  const restored = new DirectoryEvidence(WT_REAL, { latched: true });
  restored.feed([line(WT)]);
  assert.equal(restored.verdict(), 'mismatch');
});

test('T-v2-7: an unresolvable logged path is `unresolved`, never `mismatch`', () => {
  assert.equal(compareDirs(path.join(TMP, 'no-such-dir-at-all'), WT_REAL), 'unresolved');
  const e = new DirectoryEvidence(WT_REAL);
  e.feed([line(path.join(TMP, 'no-such-dir-at-all'))]);
  assert.equal(e.verdict(), 'none', 'unresolved evidence prevents completion but is not a mismatch');
  assert.equal(e.mismatchLatched, false);
});

test('T-v2-7: path identity over case differences, measured not assumed', () => {
  const upper = WT.toUpperCase();
  const verdict = compareDirs(upper, WT_REAL);
  // Record what realpathSync.native() actually does on this filesystem. Both outcomes
  // are acceptable to the design; what is NOT acceptable is a silent assumption.
  console.log(`measured: realpath case-normalisation on this filesystem -> "${upper}" vs "${WT_REAL}" = ${verdict}`);
  assert.ok(['match', 'mismatch'].includes(verdict));
});

test('parseSessionLine requires the FULL line shape; parseBootstrapLine is informational', () => {
  assert.equal(parseSessionLine('message=created directory="C:\\\\x"'), null, 'no session id => not the decision line');
  assert.equal(parseSessionLine('message=created id=ses_x'), null, 'no directory => not the decision line');
  const ok = parseSessionLine(line('C:\\x'));
  assert.equal(ok.directory, 'C:\\x');
  assert.equal(ok.sessionId, 'ses_aaa111');
  assert.equal(parseBootstrapLine('timestamp=x message=bootstrapping directory="C:\\\\y"'), 'C:\\y');
  assert.equal(stripAnsi('\u001b[0m> build\u001b[31m x'), '> build x');
});

/* ------------------------------------------------- tailer / framing ------- */

test('Tailer: a line split across reads, and a UTF-8 sequence split mid-character', () => {
  const f = tmpFile('tail1.log', '');
  const t = new Tailer(f);
  const full = Buffer.from('timestamp=1 message=created id=ses_x directory="C:\\\\wt" \u00b7 end\n', 'utf8');
  // write byte by byte; only a complete line may ever be emitted
  let emitted = [];
  for (let i = 0; i < full.length; i++) {
    fs.appendFileSync(f, full.subarray(i, i + 1));
    emitted = emitted.concat(t.poll().lines);
  }
  assert.equal(emitted.length, 1, 'exactly one complete line, whatever the split points');
  assert.match(emitted[0], /\u00b7 end$/, 'the multi-byte character survived a mid-character split');
});

test('Tailer.drain returns a final line that has no trailing newline', () => {
  const f = tmpFile('tail2.log', 'one\ntwo');
  const t = new Tailer(f);
  assert.deepEqual(t.poll().lines, ['one']);
  assert.deepEqual(t.drain(), ['two']);
});

test('Tailer notices truncation instead of skewing forever', () => {
  const f = tmpFile('tail3.log', 'aaaa\n');
  const t = new Tailer(f);
  t.poll();
  fs.writeFileSync(f, 'b\n');
  assert.deepEqual(t.poll().lines, ['b']);
  assert.equal(t.truncations, 1);
});

test('readTailLines returns only complete lines from the last N bytes', () => {
  const f = tmpFile('tail4.log', 'first-line-is-long-and-will-be-cut\nsecond\nthird\n');
  const lines = readTailLines(f, 20);
  assert.ok(!lines.includes('first-line-is-long-and-will-be-cut'));
  assert.deepEqual(lines.slice(-2), ['second', 'third']);
});

/* ------------------------------------------------------- deadlines -------- */

test('codex M1: every bounded step yields an `undetermined: <step> exceeded <ms>ms` line', async () => {
  const dl = new Deadline(30, 'status');
  dl.at('read run.json');
  const r = await withDeadline(new Promise(() => {}), 25, 'FALLBACK');
  assert.equal(r, 'FALLBACK', 'an operation that never settles must not hang the command');
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(dl.expired());
  assert.equal(dl.text(), 'undetermined: read run.json exceeded 30ms');
});

test('withDeadline returns the real value when the work finishes in time', async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 1000, 'nope'), 7);
  assert.equal(await withDeadline(Promise.reject(new Error('x')), 1000, 'fallback'), 'fallback');
});

/* ------------------------------------------- r2-14 / r3-6: mtime scan ----- */

test('r2-14/r3-6: the mtime scan has no entry cap and reports truncation with a resume point', () => {
  const big = path.join(TMP, 'flat');
  fs.mkdirSync(big, { recursive: true });
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), 'x');
  const full = scanNewestMtime(big, { budgetMs: 5000 });
  assert.equal(full.truncated, false);
  assert.ok(full.scanned >= 300, 'every entry is reachable: there is no fixed entry cap');
  assert.ok(full.newest > 0);
  const tiny = scanNewestMtime(big, { budgetMs: 0 });
  assert.equal(tiny.truncated, true, 'an exhausted budget must be reported, not hidden');
  assert.ok(Array.isArray(tiny.pending), 'and it must hand back where to resume');
});

/* ------------------------------------------------- adapters (kept) -------- */

/**
 * Build with a fake opencode.exe so these tests never need a real opencode install.
 * @template T @param {() => T} fn @returns {T}
 */
function withFakeOpencode(fn) {
  const prev = process.env.ORCH_OPENCODE_EXE;
  process.env.ORCH_OPENCODE_EXE = path.join(WT, 'fake-bin', 'opencode.exe');
  try { return fn(); } finally { if (prev === undefined) delete process.env.ORCH_OPENCODE_EXE; else process.env.ORCH_OPENCODE_EXE = prev; }
}

test('r2-2: no adapter ever routes a worker through cmd.exe or a .cmd shim', () => {
  const built = withFakeOpencode(() => opencode.build({ model: 'localai/qwen3.8-flash-next', dir: WT, flags: [], agent: null }));
  assert.ok(String(built.file).toLowerCase().endsWith('.exe'));
  assert.notEqual(path.basename(String(built.file)).toLowerCase(), 'cmd.exe');
  assert.ok(!built.args.includes('/c') && !built.args.includes('/d'));
  assert.ok(built.args.includes('--print-logs'), '--print-logs is what puts the session line in our stderr.log');
  assert.deepEqual(built.envSet, { PWD: WT }, 'PWD must be forced to --dir (spike Q1c)');
  // the deleted cmd-safety surface really is gone
  assert.equal(opencode.assertCmdSafe, undefined);
  assert.equal(opencode.bindSession, undefined);
  assert.equal(opencode.opencodeLogDir, undefined);
});

test('r2-2: values that used to need cmd.exe escaping now pass through untouched', () => {
  const nasty = path.join(WT, 'a&b %VAR% ^c');
  fs.mkdirSync(nasty, { recursive: true });
  const built = withFakeOpencode(() => opencode.build({ model: 'm', dir: nasty, flags: ['--x=a|b'], agent: 'a b' }));
  assert.ok(built.args.includes(nasty), 'a directory with shell metacharacters is passed as one argv element');
  assert.ok(built.args.includes('--x=a|b'));
  assert.ok(built.args.includes('a b'));
});

test('r2-12/r3-7: the vibe TOML merge keeps other settings and never duplicates a key', () => {
  const existing = [
    'some_other = true',
    'active_model = "old"',
    '',
    '[[models]]',
    'name = "mistral-medium-3.5"',
    'provider = "mistral"',
    'alias = "medium35"',
    'temperature = 0.3',
    'thinking = true',
    '',
    '[[models]]',
    'name = "other-model"',
    'provider = "mistral"',
    'alias = "other"',
    '',
    '[ui]',
    'colour = "auto"',
  ].join('\n');
  const merged = mergeVibeConfig(existing, { alias: 'medium35', name: 'mistral-medium-3.5', provider: 'mistral' });
  assert.match(merged, /^active_model = "medium35"/);
  assert.equal((merged.match(/^active_model\s*=/gm) || []).length, 1, 'exactly one active_model');
  assert.match(merged, /temperature = 0\.3/, 'other keys of the replaced block are carried');
  assert.match(merged, /thinking = true/);
  assert.match(merged, /some_other = true/, 'unrelated preamble keys survive');
  assert.match(merged, /\[ui\]/, 'unrelated tables survive');
  assert.match(merged, /name = "other-model"/, 'an unrelated model block survives');
  const ourBlocks = (merged.match(/alias = "medium35"/g) || []).length;
  assert.equal(ourBlocks, 1, 'the same alias must not be declared twice');
  assert.equal((merged.match(/^name = "mistral-medium-3\.5"$/gm) || []).length, 1);
});

test('r2-11: a vibe session is bound by worktree AND window; ambiguity is reported as unknown', () => {
  const sessions = path.join(TMP, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const mk = (name, wd) => {
    const d = path.join(sessions, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ environment: { working_directory: wd }, config: { active_model: 'a' } }));
  };
  mk('s1', WT);
  const now = Date.now();
  assert.equal(findSessionMeta(sessions, { dir: WT, startedAtMs: now - 1000, endedAtMs: now + 1000 }).candidates, 1);
  assert.equal(findSessionMeta(sessions, { dir: path.join(TMP, 'other'), startedAtMs: now - 1000, endedAtMs: now + 1000 }).file, null);
  mk('s2', WT);
  const amb = findSessionMeta(sessions, { dir: WT, startedAtMs: now - 1000, endedAtMs: now + 1000 });
  assert.equal(amb.file, null);
  assert.equal(amb.reason, 'ambiguous-several-sessions-match');
});

test('round-1 B: routed_default_model is never reported as the model used', () => {
  const picked = pickModelFromMeta({
    config: { active_model: 'medium35', models: { medium35: { name: 'mistral-medium-3.5' } }, routed_default_model: 'something-else' },
  });
  assert.equal(picked.resolved, 'mistral-medium-3.5');
  assert.equal(picked.routedDefault, 'something-else');
  const unknown = pickModelFromMeta({ config: { active_model: 'nope', models: {}, routed_default_model: 'routing-default' } });
  assert.equal(unknown.resolved, null, 'an unresolvable alias must stay null, never fall back to the routing default');
  assert.equal(isModelMismatch(null, 'x'), null, 'a mismatch is never guessed from an unknown model');
  assert.equal(isModelMismatch('localai/a', 'a'), false);
  assert.equal(isModelMismatch('a', 'b'), true);
});

test('vibe fallback warnings are attributed by timestamp, not grepped blindly', () => {
  const now = Date.now();
  const old = new Date(now - 10 * 3600 * 1000).toISOString();
  const recent = new Date(now).toISOString();
  const text = [
    `${old} 1 1 WARN Active model 'x' is not in your configured models; falling back to default model 'y'`,
    `${recent} 1 1 WARN Active model 'p' is not in your configured models; falling back to default model 'q'`,
  ].join('\n');
  const hits = fallbackWarningsSince(text, now - 60000);
  assert.equal(hits.length, 1);
  assert.match(hits[0].line, /'p'/);
});

test('r2-13: each adapter extracts its own final message shape', () => {
  const nd = [
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'text', text: 'the prompt' }] }),
    JSON.stringify({ type: 'effect', title: 'write_file' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'FINAL ANSWER' }] }),
  ].join('\n');
  assert.equal(vibe.extractFinalMessage(nd), 'FINAL ANSWER');
  assert.equal(messageText({ content: 'plain' }), 'plain');
  const multi = 'paragraph one\n\nparagraph two\n';
  assert.equal(opencode.extractFinalMessage(multi), multi.trim(), 'opencode keeps the whole stream, not the last paragraph');
});

test('a deadline whose step timed out reports expired even if its clock has not quite crossed the budget', async () => {
  // Found in the full suite: the step timer can fire a hair before performance.now()
  // passes the budget; `expired()` then said false and the `undetermined` line was lost.
  const dl = new Deadline(10000, 'status');
  const r = await withDeadline(new Promise(() => {}), 20, 'FB', dl.at('read cancel-result.json'));
  assert.equal(r, 'FB');
  assert.equal(dl.expired(), true, 'a genuinely timed-out step must mark the whole deadline expired');
  assert.equal(dl.text(), 'undetermined: read cancel-result.json exceeded 10000ms');
  const ok = new Deadline(10000, 'status');
  assert.equal(await withDeadline(Promise.resolve(1), 20, 'FB', ok), 1);
  assert.equal(ok.expired(), false, 'a step that finished in time must not mark the deadline');
});
