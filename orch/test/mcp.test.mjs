// Slice 3, gate T3: `orch mcp` spawned as a process and driven over stdio JSON-RPC.
// Every tool is called at least once against fake workers and temp git repos; every call
// is timed against its bound; read-only answers are compared with the CLI's for the same state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { makeCase, orch, ORCH_BIN, waitForStatus, readRunRecord } from './helpers.mjs';
import { makeRepo, commitAll } from './wf-helpers.mjs';
import { toArgv, TOOLS, WAIT_LANE_DEFAULT_S, WAIT_LANE_MAX_S, callTool, waitLaneSeconds } from '../src/mcp.mjs';

const TOOL_NAMES = [
  'run', 'status', 'result', 'log_tail', 'cancel', 'wait_lane', 'claim', 'release', 'claims', 'worktree_create', 'worktree_list',
  'scope', 'review', 'review_finish', 'gate_record', 'gate_status', 'record', 'pick',
];

/** A minimal JSON-RPC client over the server's stdio. */
function startServer(env) {
  const child = spawn(process.execPath, [ORCH_BIN, 'mcp'], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const stray = [];
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      stray.push(line); // stdout must carry protocol messages only
      return;
    }
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    } else stray.push(line);
  });
  let next = 1;
  const timings = [];
  return {
    child,
    stray,
    timings,
    get stderr() {
      return stderr;
    },
    send(obj) {
      child.stdin.write(JSON.stringify(obj) + '\n');
    },
    request(method, params, { boundMs = 130000, label = method } = {}) {
      const id = next++;
      const t0 = Date.now();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${label}: no answer within ${boundMs} ms`));
        }, boundMs);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          const ms = Date.now() - t0;
          timings.push({ label, ms, boundMs });
          resolve({ ...msg, ms });
        });
        this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    async call(name, args = {}, opts = {}) {
      const bound = opts.boundMs || (name === 'run' ? 60000 : name === 'wait_lane' ? (WAIT_LANE_DEFAULT_S + 15) * 1000 : 120000);
      const r = await this.request('tools/call', { name, arguments: args }, { boundMs: bound + 5000, label: `tools/call ${name}` });
      assert.ok(!r.error, `${name}: protocol error ${JSON.stringify(r.error)}`);
      assert.ok(r.ms <= bound, `${name}: answered in ${r.ms} ms, bound ${bound} ms`);
      return { ...r.result, ms: r.ms };
    },
    close() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once('exit', (code) => resolve(code));
        child.stdin.end();
      });
    },
  };
}

const text = (res) => res.content.map((c) => c.text).join('\n');

/** Remove values that legitimately change between two reads of the same state. */
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (/^(age|age_s|quiet_seconds|last_activity_at|waited_ms|monitor|lane_state|keeper_identity|worker_identity|undetermined|checked_at|finished_at|recorded_at)$/.test(k)) continue;
      o[k] = stable(x);
    }
    return o;
  }
  return v;
}

async function cliJson(args, env) {
  const r = await orch([...args, '--json'], env);
  try {
    return { code: r.code, out: JSON.parse(r.stdout) };
  } catch {
    throw new Error(`CLI not JSON (exit ${r.code}): ${r.stdout}\n${r.stderr}`);
  }
}

test('T3: protocol - legacy initialize, tools/list (every tool), ping, modern server/discover + _meta, errors; stdout carries protocol only', { timeout: 120000 }, async (t) => {
  const c = makeCase('t3-proto');
  const srv = startServer(c.env);
  t.after(async () => {
    await srv.close();
    c.cleanup();
  });
  const init = await srv.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'orch');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  srv.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const unknownVersion = await srv.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(unknownVersion.result.protocolVersion, '2025-11-25', 'an unknown legacy version gets the latest legacy one');

  const list = await srv.request('tools/list', {});
  const names = list.result.tools.map((x) => x.name);
  assert.deepEqual([...names].sort(), [...TOOL_NAMES].sort());
  for (const tl of list.result.tools) {
    assert.equal(tl.inputSchema.type, 'object', tl.name);
    assert.equal(tl.inputSchema.additionalProperties, false, tl.name);
    assert.ok(tl.description.length > 20, tl.name);
    for (const r of tl.inputSchema.required) assert.ok(r in tl.inputSchema.properties, `${tl.name}: required ${r} is a property`);
  }
  assert.equal(list.result.resultType, undefined, 'legacy results carry no resultType');
  assert.deepEqual((await srv.request('ping')).result, {});

  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  const disc = await srv.request('server/discover', { _meta: meta });
  assert.equal(disc.result.resultType, 'complete');
  assert.ok(disc.result.supportedVersions.includes('2026-07-28') && disc.result.supportedVersions.includes('2025-11-25'));
  assert.equal(disc.result._meta['io.modelcontextprotocol/serverInfo'].name, 'orch');
  const mlist = await srv.request('tools/list', { _meta: meta });
  assert.equal(mlist.result.resultType, 'complete');
  assert.equal(mlist.result.tools.length, TOOL_NAMES.length);
  const mcall = await srv.request('tools/call', { _meta: meta, name: 'claims', arguments: {} });
  assert.equal(mcall.result.resultType, 'complete');
  const bad = await srv.request('tools/list', { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } });
  assert.equal(bad.error.code, -32022);
  assert.equal(bad.error.data.requested, '1900-01-01');

  assert.equal((await srv.request('no/such/method')).error.code, -32601);
  assert.equal((await srv.request('tools/call', { name: 'no_such_tool', arguments: {} })).error.code, -32602);
  const invalid = await srv.call('claim', { wp: 'WP-X' }); // missing --by
  assert.equal(invalid.isError, true);
  assert.match(text(invalid), /missing required argument "by"/);
  const unknownArg = await srv.call('claims', { force: true });
  assert.equal(unknownArg.isError, true);
  const flagInjection = await srv.call('status', { id: '--all' });
  assert.equal(flagInjection.isError, true, 'a positional may not smuggle a flag');
  const orchErr = await srv.call('result', { id: 'no-such-run' });
  assert.equal(orchErr.isError, true);
  assert.match(text(orchErr), /^orch: no such run: no-such-run/m, 'the CLI error text');
  srv.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } });
  srv.child.stdin.write('this is not json\n');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(srv.stray.filter((l) => !/"code":-32700/.test(l)), [], 'every stdout line is a JSON-RPC answer to a request');
  assert.ok(srv.stray.some((l) => /"code":-32700/.test(l)), 'a parse error is answered');
  assert.equal(await srv.close(), 0, 'the server exits 0 when stdin ends');
});

test('T3: every tool against fake workers and a temp git repo; each within its bound; read-only answers equal the CLI\'s', { timeout: 900000 }, async (t) => {
  const c = makeCase('t3-tools');
  const srv = startServer(c.env);
  t.after(async () => {
    await srv.close();
    c.cleanup();
  });
  await srv.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't3', version: '1' } });
  srv.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'src/a.js': '1\n', 'README.md': 'r\n' });
  const equalCli = async (name, mcpRes, cliArgs) => {
    const cli = await cliJson(cliArgs, c.env);
    assert.deepEqual(stable(mcpRes.structuredContent.output), stable(cli.out), `${name}: MCP == CLI`);
    assert.equal(mcpRes.structuredContent.exit_code, cli.code, `${name}: same exit code`);
  };

  // claim / claims / pick
  const claim = await srv.call('claim', { wp: 'WP-M', by: 'claude-code', note: 't3' });
  assert.equal(claim.isError, false, text(claim));
  assert.equal(claim.structuredContent.exit_code, 0);
  const claimAgain = await srv.call('claim', { wp: 'WP-M', by: 'codex' });
  assert.equal(claimAgain.structuredContent.exit_code, 3, 'held by claude-code');
  await equalCli('claims', await srv.call('claims'), ['claims']);
  const pick = await srv.call('pick', { workload: 'implement', size: 'XS' });
  await equalCli('pick', pick, ['pick', '--workload', 'implement', '--size', 'XS']);

  // worktree + run (fake implementer)
  const wtc = await srv.call('worktree_create', { repo, wp: 'WP-M', slice: 's1', by: 'claude-code' });
  assert.equal(wtc.isError, false, text(wtc));
  const wtPath = wtc.structuredContent.output.path;
  assert.ok(fs.existsSync(wtPath));
  await equalCli('worktree_list', await srv.call('worktree_list'), ['worktree', 'list']);
  const run = await srv.call('run', { cli: 'fake', model: 'localai/qwen3-coder-30b', dir: wtPath, handoff: c.handoffPath, wp: 'WP-M', slice: 's1', by: 'claude-code', allow: ['src/a.js'], size: 'XS', 'no-window': true, flag: ['--write-file', 'src/a.js'] });
  assert.equal(run.isError, false, text(run));
  assert.equal(run.structuredContent.output.admission, 'acquired');
  const id = run.structuredContent.output.id;
  const st = await srv.call('status', { id });
  assert.equal(st.structuredContent.output.runs[0].id, id);
  await waitForStatus(c.stateRoot, id, ['completed', 'failed'], { timeoutMs: 90000 });
  await equalCli('status', await srv.call('status', { id }), ['status', id]);
  await equalCli('result', await srv.call('result', { id }), ['result', id]);
  const logMcp = await srv.call('log_tail', { id, tail: 20, stream: 'stdout' });
  const logCli = await orch(['log', id, '--tail', '20', '--stream', 'stdout'], c.env);
  assert.equal(text(logMcp), logCli.stdout.replace(/\n$/, ''), 'log_tail == orch log');
  const scope = await srv.call('scope', { run_id: id });
  await equalCli('scope', scope, ['scope', id]);
  assert.equal(scope.structuredContent.output.result, 'pass', text(scope));

  // review (no-wait) + review_finish
  const commit = commitAll(wtPath, 'implementation');
  const prompt = path.join(c.base, 'review-prompt.txt');
  fs.writeFileSync(prompt, 'Review {{WORKTREE}} read-only.\n');
  const rv = await srv.call('review', { run: id, ref: commit, reviewer: 'fake', model: 'gemini-3.8-flash-high', prompt, by: 'claude-code', 'review-root': path.join(c.base, 'reviews'), 'no-window': true });
  assert.equal(rv.isError, false, text(rv));
  const rvOut = rv.structuredContent.output;
  assert.ok(rv.ms < 60000, `review returned at launch (${rv.ms} ms)`);
  await waitForStatus(c.stateRoot, rvOut.run_id, ['completed', 'failed'], { timeoutMs: 90000 });
  const fin = await srv.call('review_finish', { review_id: rvOut.review_id, by: 'claude-code' });
  assert.equal(fin.isError, false, text(fin));
  assert.equal(fin.structuredContent.output.containment, 'clean', text(fin));
  await equalCli('review_finish (again)', await srv.call('review_finish', { review_id: rvOut.review_id, by: 'claude-code' }), ['review', '--finish', rvOut.review_id, '--by', 'claude-code']);
  const sameModel = await srv.call('review', { run: id, ref: commit, reviewer: 'fake', model: 'qwen3-coder-30b', prompt, by: 'claude-code', 'review-root': path.join(c.base, 'reviews'), 'no-window': true });
  assert.equal(sameModel.isError, true, 'the implementer\'s model is refused through MCP too');
  assert.match(text(sameModel), /is the implementer's model/);

  // gate
  const findings = path.join(c.base, 'findings.json');
  fs.writeFileSync(findings, '[]');
  const gr = await srv.call('gate_record', { wp: 'WP-M', slice: 's1', round: 1, findings, verification: 'pass', 'scope-run': id, by: 'claude-code' });
  assert.equal(gr.isError, false, text(gr));
  assert.equal(gr.structuredContent.output.gate.decision, 'converged', text(gr));
  await equalCli('gate_status', await srv.call('gate_status', { wp: 'WP-M', slice: 's1' }), ['gate', 'status', '--wp', 'WP-M', '--slice', 's1']);

  // record
  const rec = await srv.call('record', { run_id: id, disposition: 'accepted', attempt: 1, notes: 't3 via mcp' });
  assert.equal(rec.isError, false, text(rec));
  const ledger = fs.readFileSync(path.join(c.stateRoot, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].run_id, id);
  assert.equal(ledger[0].notes, 't3 via mcp');
  const recAgain = await srv.call('record', { run_id: id, disposition: 'accepted' });
  const recCli = await orch(['record', id, '--disposition', 'accepted', '--json'], c.env);
  assert.equal(recAgain.structuredContent.exit_code === 0, recCli.code === 0, 'a second record behaves the same through MCP and CLI');

  // wait_lane + cancel against a long run holding the (test) local lane
  const hold = await srv.call('run', { cli: 'fake', dir: c.work, handoff: c.handoffPath, lane: 'local', 'no-window': true, flag: ['--hold', '60'] });
  assert.equal(hold.structuredContent.output.admission, 'acquired', text(hold));
  const holdId = hold.structuredContent.output.id;
  await waitForStatus(c.stateRoot, holdId, ['running'], { timeoutMs: 30000 });
  const wl = await srv.call('wait_lane', { lane: 'local', timeout: 2 });
  assert.equal(wl.structuredContent.exit_code, 3, text(wl));
  assert.ok(wl.ms < 8000, `wait_lane timeout 2 answered in ${wl.ms} ms`);
  const wlDefault = await srv.call('wait_lane', { lane: 'local' });
  assert.equal(wlDefault.structuredContent.exit_code, 3);
  assert.ok(wlDefault.ms >= (WAIT_LANE_DEFAULT_S - 1) * 1000 && wlDefault.ms < (WAIT_LANE_DEFAULT_S + 10) * 1000, `default bound ${WAIT_LANE_DEFAULT_S}s: answered in ${wlDefault.ms} ms`);
  const busy = await srv.call('run', { cli: 'fake', dir: c.work, handoff: c.handoffPath, lane: 'local', 'no-window': true });
  assert.equal(busy.structuredContent.exit_code, 3, 'lane-busy through MCP');
  const cancel = await srv.call('cancel', { id: holdId });
  assert.equal(cancel.isError, false, text(cancel));
  assert.equal(cancel.structuredContent.exit_code, 0, text(cancel));
  assert.equal(cancel.structuredContent.output.cancel_state, 'cancelled', text(cancel));
  await waitForStatus(c.stateRoot, holdId, ['cancelled'], { timeoutMs: 60000 });
  const free = await srv.call('wait_lane', { lane: 'local', timeout: 20 });
  assert.equal(free.structuredContent.exit_code, 0, text(free));
  await equalCli('wait_lane (free)', free, ['wait-lane', '--lane', 'local', '--timeout', '20']);

  // release
  const rel = await srv.call('release', { wp: 'WP-M', by: 'claude-code' });
  assert.equal(rel.structuredContent.exit_code, 0, text(rel));
  await equalCli('claims (after release)', await srv.call('claims'), ['claims']);
  assert.equal(readRunRecord(c.stateRoot, id).status, 'completed');

  const called = new Set(srv.timings.filter((x) => x.label.startsWith('tools/call ')).map((x) => x.label.slice(11)));
  assert.deepEqual([...called].sort(), [...TOOL_NAMES].sort(), 'every tool was called at least once');
  console.log('T3 timings (ms, bound):');
  for (const x of srv.timings) console.log(`  ${x.label.padEnd(28)} ${String(x.ms).padStart(6)}  (${x.boundMs - 5000})`);
  assert.deepEqual(srv.stray, [], 'nothing but answers on stdout');
});

test('T3 (unit): tool input -> the CLI argv; wait_lane is capped; review is always --no-wait', async () => {
  assert.deepEqual(toArgv('run', { cli: 'fake', dir: 'C:\\w', handoff: 'h', allow: ['a', 'b'], 'no-window': true, 'max-turns': 5 }), [
    '--cli', 'fake', '--dir', 'C:\\w', '--handoff', 'h', '--allow', 'a', '--allow', 'b', '--max-turns', '5', '--no-window',
  ]);
  assert.deepEqual(toArgv('gate_status', { wp: 'W', slice: 's' }), ['status', '--wp', 'W', '--slice', 's']);
  assert.deepEqual(toArgv('review_finish', { review_id: 'rv-1' }), ['--finish', 'rv-1']);
  assert.deepEqual(toArgv('log_tail', { id: 'x' }), ['x', '--tail', '200']);
  assert.throws(() => toArgv('claim', { wp: '-x', by: 'owner' }), /may not start with/);
  assert.deepEqual(TOOLS.review.force, { 'no-wait': true });
  assert.equal(waitLaneSeconds(undefined), WAIT_LANE_DEFAULT_S);
  assert.equal(waitLaneSeconds('7'), 7);
  assert.equal(waitLaneSeconds(100000), WAIT_LANE_MAX_S);
  assert.equal(waitLaneSeconds('abc'), null);
  assert.equal(waitLaneSeconds(-1), null);
  assert.ok(WAIT_LANE_MAX_S < 60);
  const bad = await callTool('wait_lane', { timeout: 'abc' });
  assert.equal(bad.isError, true);
});

test('T3 interop: the official @modelcontextprotocol/sdk Client (dev dependency only) connects over stdio, lists and calls tools', { timeout: 120000 }, async (t) => {
  const c = makeCase('t3-sdk');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [ORCH_BIN, 'mcp'], env: c.env, stderr: 'pipe' });
  const client = new Client({ name: 'orch-t3-interop', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    c.cleanup();
  });
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'orch');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), [...TOOL_NAMES].sort());
  const claim = await client.callTool({ name: 'claim', arguments: { wp: 'WP-SDK', by: 'owner' } });
  assert.equal(claim.isError, false);
  const claims = /** @type {any} */ (await client.callTool({ name: 'claims', arguments: {} }));
  assert.equal(claims.structuredContent.output.claims[0].wp, 'WP-SDK');
  const cli = await cliJson(['claims'], c.env);
  assert.deepEqual(stable(claims.structuredContent.output), stable(cli.out));
  const err = await client.callTool({ name: 'result', arguments: { id: 'nope' } });
  assert.equal(err.isError, true);
  console.log(`T3 interop: SDK client connected (server ${JSON.stringify(client.getServerVersion())}), ${tools.length} tools, claim/claims/result called`);
});
