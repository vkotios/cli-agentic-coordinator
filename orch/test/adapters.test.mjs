// Slice 2, gate S7: the codex and agy adapters. argv exactly as specified, prompt
// delivery, and model-used extraction from recorded fixtures of REAL codex and agy output
// (copied from the orchestrator's review runs; see the report). No real codex or agy is
// ever launched here: node.exe stands in where a process is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { KIT, makeCase, orch, idFrom, waitForStatus, readRunRecord, readRunFile, hostileHandoff } from './helpers.mjs';
import codex, { extractCodexModel } from '../src/adapters/codex.mjs';
import agy, { extractAgyModel, MAX_PROMPT_CHARS } from '../src/adapters/agy.mjs';
import { deriveStatus } from '../src/statusrules.mjs';

const FIX = path.join(KIT, 'test', 'fixtures');
const ECHO = path.join(FIX, 'echo-args.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-adapters-'));
test.after?.(() => fs.rmSync(TMP, { recursive: true, force: true }));

function withEnv(vars, fn) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function runDirWith(prompt) {
  const d = fs.mkdtempSync(path.join(TMP, 'run-'));
  fs.writeFileSync(path.join(d, 'prompt.txt'), prompt);
  return d;
}

/* -------------------------------------------------------------- codex ----- */

test('S7 codex: argv exactly as specified (implement and review), model required, effort explicit', () => {
  const rd = runDirWith('hello');
  const wt = 'C:\\work\\sandbox\\wt with space';
  const base = { model: 'gpt-5.6-terra', dir: wt, flags: [], promptPath: path.join(rd, 'prompt.txt'), runDir: rd };
  withEnv({ ORCH_CODEX_EXE: 'C:\\fake\\codex.exe' }, () => {
    const impl = codex.build({ ...base, role: 'implement' });
    assert.equal(impl.file, 'C:\\fake\\codex.exe');
    assert.deepEqual(impl.args, ['exec', '--cd', wt, '--sandbox', 'workspace-write', '--json', '--color', 'never', '-m', 'gpt-5.6-terra', '-c', 'model_reasoning_effort=medium', '--output-last-message', path.join(rd, 'last-message.txt'), '-']);
    assert.equal(impl.stdinFile, undefined, 'codex reads the prompt FILE on fd 0');
    assert.deepEqual(impl.envSet, { PWD: wt });
    const rev = codex.build({ ...base, role: 'review', effort: 'high', flags: ['--skip-git-repo-check'] });
    assert.deepEqual(rev.args, ['exec', '--cd', wt, '--sandbox', 'read-only', '--json', '--color', 'never', '-m', 'gpt-5.6-terra', '-c', 'model_reasoning_effort=high', '--output-last-message', path.join(rd, 'last-message.txt'), '--skip-git-repo-check', '-']);
    assert.equal(rev.args[rev.args.length - 1], '-', 'the prompt is never on argv');
    assert.ok(!rev.args.includes('hello'));
    for (const f of ['--sandbox', '-m', '--model=x', '--dangerously-bypass-approvals-and-sandbox', '-c', '--json']) {
      assert.throws(() => codex.build({ ...base, flags: [f] }), /may not be overridden/, f);
    }
    assert.throws(() => codex.build({ ...base, effort: 'ludicrous' }), /effort/);
  });
  assert.equal(codex.needsModel, true);
  assert.throws(() => codex.preLaunch({ model: '' }), /needs --model/);
  assert.throws(() => codex.preLaunch({ model: 'gpt-6-astra' }), /owner's permission/);
  assert.doesNotThrow(() => codex.preLaunch({ model: 'openai/GPT-6-astra', ownerApprovedModel: true }));
  assert.equal(codex.canonicalModel('openai/GPT-5.6-Terra'), 'gpt-5.6-terra');
});

test('S7 codex: model used from the RECORDED header of a real codex run; absent header = unknown', () => {
  const stderr = fs.readFileSync(path.join(FIX, 'codex-review-astra.stderr.txt'), 'utf8');
  const got = extractCodexModel(stderr, []);
  assert.deepEqual([got.model, got.source, got.effort, got.sandbox], ['gpt-6-astra', 'stderr-header', 'medium', 'read-only']);
  // The real --json quota run (spike q8) printed NOTHING on stderr: no header at all.
  const q8 = fs.readFileSync(path.join(FIX, 'codex-quota-q8.stdout.jsonl'), 'utf8');
  const events = codex.parseProtocol(q8);
  assert.equal(events.length, 4);
  const none = extractCodexModel('', events);
  assert.equal(none.model, null, 'no header and no model field -> UNKNOWN, never the requested model');
  // a model field in an event is used when there is no header
  assert.equal(extractCodexModel('', [{ type: 'session.configured', model: 'gpt-5.6-sol' }]).model, 'gpt-5.6-sol');
  // postExit wires it: a mismatch is flagged, unknown is warned
  const rd = runDirWith('x');
  fs.writeFileSync(path.join(rd, 'stderr.log'), stderr);
  fs.writeFileSync(path.join(rd, 'stdout.log'), '');
  const post = codex.postExit({ stderrPath: path.join(rd, 'stderr.log'), stdoutPath: path.join(rd, 'stdout.log'), requestedCanonical: 'gpt-5.6-terra' });
  assert.equal(post.actual_model, 'gpt-6-astra');
  assert.equal(post.model_mismatch, true);
  assert.ok(post.warnings.some((w) => /MODEL MISMATCH/.test(w)));
  fs.writeFileSync(path.join(rd, 'stderr.log'), '');
  const post2 = codex.postExit({ stderrPath: path.join(rd, 'stderr.log'), stdoutPath: path.join(rd, 'stdout.log'), requestedCanonical: 'gpt-5.6-terra' });
  assert.equal(post2.actual_model, null);
  assert.ok(post2.warnings.some((w) => /UNKNOWN/.test(w)));
});

test('S7 codex: the recorded quota run classifies as blocked-quota (exit + protocol error records only)', () => {
  const q8 = fs.readFileSync(path.join(FIX, 'codex-quota-q8.stdout.jsonl'), 'utf8');
  const o = { cancelRequested: false, workerConfirmedGone: true, blocked: null, workerExitSeen: true, keeperVerdict: 'gone', exitCode: 1, signal: null, stdout: q8, stderr: '', events: codex.parseProtocol(q8), dirEvidence: 'none', directoryRelevant: false };
  assert.equal(deriveStatus(codex.statusRules, o).status, 'blocked-quota');
  // the same words as free text of an agent message never reclassify an exit-0 run
  const ok = { ...o, exitCode: 0, events: [{ type: 'item.completed', item: { type: 'agent_message', text: "You've hit your usage limit." } }] };
  assert.equal(deriveStatus(codex.statusRules, ok).status, 'completed');
  assert.equal(codex.extractFinalMessage('{"type":"item.completed","item":{"type":"agent_message","text":"FINAL"}}\n{"type":"turn.completed"}\n'), 'FINAL');
});

test('S7 codex end to end: prompt delivered on stdin BYTE-EXACT via "-", model read from the header, through orch run', { timeout: 120000 }, async (t) => {
  const handoff = hostileHandoff({ nonAscii: true });
  const c = makeCase('s7-codex', { handoff });
  t.after(() => c.cleanup());
  // node.exe stands in for codex.exe: `node exec <args>` runs the file `exec` in the
  // worktree. It prints a codex-shaped header on stderr and JSONL on stdout.
  fs.writeFileSync(
    path.join(c.work, 'exec'),
    [
      "import('node:crypto').then(async (crypto) => {",
      '  const chunks = [];',
      '  for await (const ch of process.stdin) chunks.push(ch);',
      '  const buf = Buffer.concat(chunks);',
      "  const sha = crypto.createHash('sha256').update(buf).digest('hex');",
      "  if (process.env.FAKE_CODEX_NO_HEADER !== '1') process.stderr.write('OpenAI Codex v0.154.0 (stand-in)\\n--------\\nworkdir: x\\nmodel: gpt-5.6-terra\\nprovider: openai\\nsandbox: workspace-write\\nreasoning effort: high\\n--------\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'ARGV ' + JSON.stringify(process.argv.slice(2)) + ' SHA ' + sha + ' BYTES ' + buf.length } }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      '});',
      '',
    ].join('\n'),
  );
  // A real adapter may not run in an overridden test lane; codex is cloud (non-exclusive),
  // so the real cloud lane binds nothing.
  const env = { ...c.env, ORCH_CODEX_EXE: process.execPath };
  delete env.ORCH_LANE_ID;
  const r = await orch(['run', '--cli', 'codex', '--model', 'gpt-5.6-terra', '--effort', 'high', '--dir', c.work, '--handoff', c.handoffPath, '--no-window'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const id = idFrom(r.stdout);
  const rec = await waitForStatus(c.stateRoot, id, ['completed', 'failed', 'blocked'], { timeoutMs: 60000 });
  assert.equal(rec.status, 'completed', JSON.stringify(rec));
  const res = JSON.parse((await orch(['result', id, '--json'], env)).stdout);
  const sha = crypto.createHash('sha256').update(Buffer.from(handoff, 'utf8')).digest('hex');
  assert.match(res.final_message, new RegExp(`SHA ${sha} BYTES ${Buffer.byteLength(handoff, 'utf8')}`), 'the prompt reached codex byte-exact on stdin');
  const argv = JSON.parse(/ARGV (\[.*?\]) SHA/.exec(res.final_message)[1]);
  assert.deepEqual(argv.slice(-1), ['-']);
  assert.ok(argv.includes('-m') && argv[argv.indexOf('-m') + 1] === 'gpt-5.6-terra');
  assert.equal(rec.model_actual, 'gpt-5.6-terra');
  assert.equal(rec.model_actual_source, 'stderr-header');
  assert.equal(rec.codex_effort_reported, 'high');
  assert.equal(rec.model_mismatch, false);
  // No header -> unknown, with a warning; never the requested model.
  const r2 = await orch(['run', '--cli', 'codex', '--model', 'gpt-5.6-terra', '--dir', c.work, '--handoff', c.handoffPath, '--no-window'], { ...env, FAKE_CODEX_NO_HEADER: '1' });
  const id2 = idFrom(r2.stdout);
  const rec2 = await waitForStatus(c.stateRoot, id2, ['completed', 'failed'], { timeoutMs: 60000 });
  assert.equal(rec2.model_actual, null);
  assert.ok(rec2.post_exit_warnings.some((w) => /UNKNOWN/.test(w)));
});

/* ---------------------------------------------------------------- agy ----- */

test('S7 agy: argv exactly as specified; never --sandbox; stdin empty; too-long prompt refused', () => {
  const prompt = 'Review C:\\work\\x.\nLine 2 "quoted" %VAR%\n';
  const rd = runDirWith(prompt);
  const wt = 'C:\\work\\sandbox\\reviews\\rv-1';
  withEnv({ ORCH_AGY_EXE: 'C:\\fake\\agy.exe' }, () => {
    const b = agy.build({ model: 'gemini-3.8-flash-high', dir: wt, flags: [], promptPath: path.join(rd, 'prompt.txt'), runDir: rd, role: 'review' });
    assert.equal(b.file, 'C:\\fake\\agy.exe');
    assert.deepEqual(b.args, ['--model', 'gemini-3.8-flash-high', '--mode', 'plan', '--dangerously-skip-permissions', '--print-timeout', '45m', '--log-file', path.join(rd, 'agy.log'), '-p', prompt]);
    assert.ok(!b.args.some((a) => /^--sandbox/.test(a)), 'never --sandbox');
    assert.equal(b.stdinFile, path.join(rd, 'stdin-empty.txt'));
    assert.equal(fs.readFileSync(b.stdinFile, 'utf8'), '', 'stdin is empty: the prompt is not delivered twice');
    const b2 = agy.build({ model: 'm', dir: wt, flags: ['--effort', 'high'], promptPath: path.join(rd, 'prompt.txt'), runDir: rd, printTimeout: '10m' });
    assert.deepEqual(b2.args.slice(5, 7), ['--print-timeout', '10m']);
    assert.deepEqual(b2.args.slice(-4), ['--effort', 'high', '-p', prompt]);
    for (const f of ['--sandbox', '--sandbox=true', '--mode', '-p', '--log-file']) {
      assert.throws(() => agy.build({ model: 'm', dir: wt, flags: [f], promptPath: path.join(rd, 'prompt.txt'), runDir: rd }), /forbidden or set by orch/, f);
    }
    const big = runDirWith('x'.repeat(MAX_PROMPT_CHARS + 1));
    assert.throws(() => agy.build({ model: 'm', dir: wt, flags: [], promptPath: path.join(big, 'prompt.txt'), runDir: big }), /32 767/);
  });
  assert.equal(agy.needsModel, true);
  assert.equal(agy.lane, 'cloud');
});

test('S7 agy: the prompt survives argv BYTE-EXACT to a real exe (node.exe + echo-args), incl. non-ASCII and quotes', { timeout: 60000 }, async () => {
  for (const nonAscii of [false, true]) {
    const prompt = hostileHandoff({ nonAscii }) + 'ends with a backslash \\\\\n"trailing quote"\\';
    const rd = runDirWith(prompt);
    const b = withEnv({ ORCH_AGY_EXE: process.execPath }, () => agy.build({ model: 'gemini-3.8-flash-high', dir: TMP, flags: [], promptPath: path.join(rd, 'prompt.txt'), runDir: rd }));
    const out = path.join(rd, 'echo.json');
    await new Promise((resolve, reject) =>
      execFile(process.execPath, [ECHO, ...b.args], { env: { ...process.env, ORCH_ECHO_OUT: out }, windowsHide: true, timeout: 30000 }, (err) => (err ? reject(err) : resolve(null))),
    );
    const got = JSON.parse(fs.readFileSync(out, 'utf8')).argv;
    assert.deepEqual(got, b.args, `argv mangled on the way (nonAscii=${nonAscii})`);
    assert.equal(got[got.length - 1], prompt);
  }
});

test('S7 agy: model used from the RECORDED per-run log of a real agy run; no log = unknown', () => {
  const log = fs.readFileSync(path.join(FIX, 'agy-review-gemini.log.txt'), 'utf8');
  const got = extractAgyModel(log);
  // Fix round F2: this recorded log says the model was "not in local config, defaulting",
  // so the model used is UNKNOWN; the id agy echoed is kept as `claimed` only.
  assert.equal(got.model, null);
  assert.equal(got.claimed, 'gemini-3.8-flash-high');
  assert.equal(got.resolvedVia, 'default');
  assert.equal(got.label, 'Gemini 3.8 Flash (High)');
  assert.equal(got.source, 'unknown:resolved-via-default');
  assert.ok(got.evidence.some((l) => /Model resolved via default/.test(l)));
  const rd = runDirWith('x');
  fs.writeFileSync(path.join(rd, 'agy.log'), log);
  const post = agy.postExit({ runDir: rd, requestedCanonical: 'gemini-3.8-flash-high' });
  assert.equal(post.actual_model, null);
  assert.equal(post.model_mismatch, undefined);
  const post2 = agy.postExit({ runDir: runDirWith('y'), requestedCanonical: 'gemini-3.8-flash-high' });
  assert.equal(post2.actual_model, null);
  assert.ok(post2.warnings.some((w) => /UNKNOWN/.test(w)));
  // keepalives are not activity (card): model-list pings, token refresh, quota manager
  const lines = log.split(/\r?\n/).filter(Boolean);
  const keep = lines.filter((l) => agy.isKeepalive(l));
  assert.ok(keep.some((l) => /http_helpers/.test(l)) && keep.some((l) => /browser\.go/.test(l)) && keep.some((l) => /quota_manager/.test(l)));
  assert.ok(!agy.isKeepalive(lines.find((l) => /Resolving model/.test(l))));
  assert.equal(agy.heartbeatFile('C:\\r'), path.join('C:\\r', 'agy.log'));
});

test('S7 agy: exit 0 with EMPTY output is failed, never completed', () => {
  const o = { cancelRequested: false, workerConfirmedGone: true, blocked: null, workerExitSeen: true, keeperVerdict: 'gone', exitCode: 0, signal: null, stdout: '  \n', stderr: '', events: [], dirEvidence: 'none', directoryRelevant: false };
  const d = deriveStatus(agy.statusRules, o);
  assert.deepEqual([d.status, d.reason], ['failed', 'empty-output']);
});

test('S7: a per-run heartbeat LOG counts as activity through the monitor; keepalive lines do not', { timeout: 120000 }, async (t) => {
  const c = makeCase('s7-heartbeat');
  t.after(() => c.cleanup());
  const env = { ...c.env, ORCH_FAKE_HEARTBEAT: '1' };
  const r = await orch(['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--no-window', '--flag', '--silent', '--flag', '--hold', '--flag', '12'], env);
  const id = idFrom(r.stdout);
  const hb = path.join(c.stateRoot, 'runs', id, 'fake-heartbeat.log');
  await new Promise((res) => setTimeout(res, 2500));
  fs.appendFileSync(hb, 'I0923 http KEEPALIVE ping\n');
  await new Promise((res) => setTimeout(res, 2500));
  const quiet = readRunRecord(c.stateRoot, id);
  assert.notEqual(quiet.last_activity_signal, 'cli-log', 'a keepalive line is not activity');
  fs.appendFileSync(hb, 'I0923 model_resolver.go Resolving model x\n');
  const rec = await (async () => {
    for (let i = 0; i < 40; i++) {
      const x = readRunRecord(c.stateRoot, id);
      if (x && x.last_activity_signal === 'cli-log') return x;
      await new Promise((res) => setTimeout(res, 250));
    }
    return readRunRecord(c.stateRoot, id);
  })();
  assert.equal(rec.last_activity_signal, 'cli-log');
  await waitForStatus(c.stateRoot, id, ['completed', 'failed'], { timeoutMs: 60000 });
  assert.equal(readRunFile(c.stateRoot, id, 'stdout.log').trim(), '', 'the worker itself stayed silent');
});
