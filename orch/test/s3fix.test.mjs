// Slice 3 code-review fix round: one regression test per accepted finding
// (the slice-3 code review). Each test failed before its fix and passes after
// the fix; the report maps them. Product modules are imported INSIDE the tests so that a
// missing export on the old code fails that one test, not the whole file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { KIT, ORCH_BIN, makeCase, orch, idFrom, keeperLines, waitFor } from './helpers.mjs';
import { makeRepo, g } from './wf-helpers.mjs';

const ROOT = path.resolve(KIT, '..');
const GUARD = path.join(ROOT, 'hooks', 'guard.mjs');
const R = 'r' + 'eset'; // keep the literal out of any command line that runs this file

function hook(tool_name, command, cwd = KIT) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command }, cwd }),
    encoding: 'utf8',
    cwd,
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}
const denied = (tool, cmd, cwd) => {
  const d = hook(tool, cmd, cwd);
  assert.ok(d && d.permissionDecision === 'deny', `expected DENY: ${cmd}`);
  return d.permissionDecisionReason;
};
const allowed = (tool, cmd, cwd) => assert.equal(hook(tool, cmd, cwd), null, `expected ALLOW: ${cmd}`);

/* ------------------------------------------------------------ guard ---- */

test('FIX c1: PowerShell variable launches, Start-Process argument arrays, @() and deep nesting are denied', { timeout: 120000 }, () => {
  const deny = [
    ['PowerShell', "$exe='opencode'; & $exe run"],
    ['PowerShell', '$exe = "C:\\Tools\\opencode.exe"; & $exe run --model x'],
    ['PowerShell', '$c = (Get-Command codex).Source; & $c exec -'],
    ['PowerShell', '$exe="codex"; . $exe exec -'],
    ['PowerShell', '$env:W = "copilot"; & $env:W -p x'],
    ['Bash', 'exe=opencode; $exe run'],
    ['Bash', 'exe=codex; "${exe}" exec -'],
    ['PowerShell', "Start-Process -FilePath opencode -ArgumentList @('run','--model','x')"],
    ['PowerShell', "Start-Process -FilePath 'C:\\t\\agy.exe' -ArgumentList @('--print', 'x') -Wait"],
    ['PowerShell', "$exe='vibe'; Start-Process -FilePath $exe -ArgumentList @('-p')"],
    ['PowerShell', 'Write-Output @(codex exec -)'],
  ];
  for (const [tool, cmd] of deny) assert.match(denied(tool, cmd), /orch run --cli/, cmd);
  let deep = 'codex exec -';
  for (let i = 0; i < 12; i++) deep = `cmd /c "${deep.replace(/"/g, '')}"`;
  assert.match(denied('PowerShell', deep), /too deep/);
  // not launches
  allowed('PowerShell', "$exe='notepad'; & $exe x.txt");
  allowed('PowerShell', '$m = "codex exec is blocked"; Write-Host $m');
  allowed('PowerShell', "Start-Process -FilePath notepad -ArgumentList @('run.txt')");
});

test('FIX c2: git global options before the subcommand (-C, -c, --no-pager, git.exe, full path) no longer bypass the git rules', { timeout: 120000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-s3fix-git-'));
  const q = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...a], { cwd: tmp, stdio: 'ignore', timeout: 30000 });
  try {
    q('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(tmp, 'clean.txt'), 'a\n');
    fs.writeFileSync(path.join(tmp, 'dirty.txt'), 'a\n');
    q('add', '.');
    q('commit', '-q', '-m', 'base');
    fs.writeFileSync(path.join(tmp, 'dirty.txt'), 'changed\n');
    for (const cmd of [
      `git -C ${tmp} ${R} --hard HEAD`,
      `git -C "C:\\my repo" clean -fd`,
      'git -c core.editor=x commit --no-verify -m x',
      'git --no-pager push --force origin main',
      `git --git-dir=.git --work-tree=. ${R} --hard`,
      `git.exe ${R} --hard`,
      `"C:\\Program Files\\Git\\cmd\\git.exe" ${R} --hard`,
      'git -C C:\\repo branch -D old',
      'git -C C:\\repo stash drop',
    ])
      assert.match(denied('PowerShell', cmd), /^Blocked: /, cmd);
    // -C moves the directory the dirty-path check uses (the hook's own cwd is the kit)
    denied('Bash', `git -C ${tmp} checkout -- dirty.txt`);
    allowed('Bash', `git -C ${tmp} checkout -- clean.txt`);
    allowed('Bash', `git -C ${tmp} status`);
    allowed('Bash', `git -c core.x=y ${R} --soft HEAD`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true }); // created by this test
  }
});

test('FIX c5: a local script merely NAMED like a worker is not a worker launch; the installed package still is', { timeout: 60000 }, () => {
  allowed('PowerShell', 'node .\\tools\\codex.mjs exec');
  allowed('Bash', 'node tools/opencode.js run');
  allowed('Bash', 'python scripts/vibe.py -p x');
  denied('PowerShell', 'node C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js exec -');
  denied('PowerShell', 'node C:\\x\\node_modules\\opencode-ai\\bin\\opencode run');
});

/* ------------------------------------------------------------ adopt ---- */

const adoptJson = async (args, env) => {
  const r = await orch(['adopt', ...args, '--json'], env);
  try {
    return { code: r.code, out: JSON.parse(r.stdout) };
  } catch {
    throw new Error(`adopt not JSON (exit ${r.code}): ${r.stdout}\n${r.stderr}`);
  }
};
const action = (out, p) => (out.items.find((i) => i.path === p) || {}).action;

test('FIX c3: a guard entry with a NARROWER matcher is not "installed" - a full entry is added, the old one kept', { timeout: 120000 }, async (t) => {
  const c = makeCase('s3fix-c3');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n' });
  const guard = `node "${GUARD.replace(/\\/g, '/')}"`;
  const narrow = { hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: guard }] }] } };
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify(narrow, null, 2));
  fs.mkdirSync(path.join(repo, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^Edit$', hooks: [{ type: 'command', command: guard }] }] } }, null, 2));
  const r = await adoptJson(['--repo', repo], c.env);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(action(r.out, '.claude/settings.json'), 'update');
  assert.equal(action(r.out, '.codex/hooks.json'), 'update');
  const s = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s.hooks.PreToolUse[0], narrow.hooks.PreToolUse[0], 'the narrow entry is kept as it was');
  assert.equal(s.hooks.PreToolUse[1].matcher, 'Bash|PowerShell|Read|Edit|Write|MultiEdit|NotebookEdit');
  const cx = JSON.parse(fs.readFileSync(path.join(repo, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(cx.hooks.PreToolUse[1].matcher, '^Bash$');
  // a catch-all matcher DOES count as installed
  const all = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: guard }] }] } };
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify(all, null, 2));
  const r2 = await adoptJson(['--repo', repo, '--dry-run'], c.env);
  assert.equal(action(r2.out, '.claude/settings.json'), 'unchanged');
});

test('FIX c4: a file edited between the plan and the write is NOT overwritten (re-read before replace)', { timeout: 120000 }, async (t) => {
  const c = makeCase('s3fix-c4');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n' });
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  const settings = path.join(repo, '.claude', 'settings.json');
  fs.writeFileSync(settings, '{"permissions":{"allow":[]}}\n');
  const owners = '{"permissions":{"allow":["Bash(npm test)"]},"note":"edited by the owner meanwhile"}\n';
  const { cmdAdopt } = await import('../src/adopt.mjs');
  const lines = [];
  const r = await cmdAdopt({ repo, json: true }, { log: (s) => lines.push(s) }, { beforeWrite: () => fs.writeFileSync(settings, owners) });
  assert.equal(fs.readFileSync(settings, 'utf8'), owners, "the owner's edit survives");
  assert.equal(r.exitCode, 3);
  assert.ok((r.aborted_changed_since_plan || []).includes('.claude/settings.json'), JSON.stringify(r));
  assert.equal(r.written.length, 0, 'nothing written: the change was caught before the first write');
});

test('FIX a5: a copy checked out with CRLF line endings is still recognised as unchanged', { timeout: 120000 }, async (t) => {
  const c = makeCase('s3fix-a5');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n' });
  assert.equal((await adoptJson(['--repo', repo], c.env)).code, 0);
  for (const f of ['.claude/skills/orchestrate/workflow.md', '.claude/agents/researcher.md', '.agents/skills/orchestrate/SKILL.md']) {
    const p = path.join(repo, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\n/g, '\r\n'));
  }
  const r = await adoptJson(['--repo', repo], c.env);
  assert.equal(r.code, 0, JSON.stringify(r.out.items));
  assert.ok(r.out.items.every((i) => i.action === 'unchanged'), JSON.stringify(r.out.items));
});

test('ORCH addition: manifest + --update replaces ONLY files adopt wrote and nobody changed; everything else is a conflict', { timeout: 180000 }, async (t) => {
  const c = makeCase('s3fix-upd');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n' });
  const first = await adoptJson(['--repo', repo], c.env);
  assert.equal(first.code, 0);
  const manFile = path.join(repo, '.orch-adopt.json');
  const man = JSON.parse(fs.readFileSync(manFile, 'utf8'));
  assert.equal(Object.keys(man.files).length, 7, 'the manifest lists the 7 copied files');
  const hash = (s) => crypto.createHash('sha256').update(String(s).replace(/\r\n/g, '\n')).digest('hex');
  const kitCopy = fs.readFileSync(path.join(repo, '.claude/agents/researcher.md'), 'utf8');

  // (1) "adopt wrote an older version": content X with the manifest recording X
  const older = '---\nname: researcher\ndescription: an OLDER kit version\n---\nold body\n';
  fs.writeFileSync(path.join(repo, '.claude/agents/researcher.md'), older);
  man.files['.claude/agents/researcher.md'].sha256 = hash(older);
  fs.writeFileSync(manFile, JSON.stringify(man, null, 2) + '\n');
  const stale = await adoptJson(['--repo', repo], c.env);
  assert.equal(stale.code, 0);
  assert.equal(action(stale.out, '.claude/agents/researcher.md'), 'stale');
  assert.equal(fs.readFileSync(path.join(repo, '.claude/agents/researcher.md'), 'utf8'), older, 'without --update nothing is replaced');
  const dry = await adoptJson(['--repo', repo, '--update', '--dry-run'], c.env);
  assert.equal(action(dry.out, '.claude/agents/researcher.md'), 'update');
  assert.equal(fs.readFileSync(path.join(repo, '.claude/agents/researcher.md'), 'utf8'), older, '--dry-run --update writes nothing');
  const upd = await adoptJson(['--repo', repo, '--update'], c.env);
  assert.equal(upd.code, 0, JSON.stringify(upd.out));
  assert.equal(fs.readFileSync(path.join(repo, '.claude/agents/researcher.md'), 'utf8'), kitCopy, 'replaced by the current kit copy');
  assert.equal(JSON.parse(fs.readFileSync(manFile, 'utf8')).files['.claude/agents/researcher.md'].sha256, hash(kitCopy), 'manifest refreshed');

  // (2) a file adopt wrote but someone edited since -> conflict even with --update
  fs.writeFileSync(path.join(repo, '.claude/agents/escalation-reviewer.md'), 'my own edit\n');
  const before = fs.readFileSync(path.join(repo, '.claude/agents/escalation-reviewer.md'), 'utf8');
  const edited = await adoptJson(['--repo', repo, '--update'], c.env);
  assert.equal(edited.code, 3);
  assert.equal(action(edited.out, '.claude/agents/escalation-reviewer.md'), 'conflict');
  assert.equal(fs.readFileSync(path.join(repo, '.claude/agents/escalation-reviewer.md'), 'utf8'), before);
  fs.writeFileSync(path.join(repo, '.claude/agents/escalation-reviewer.md'), fs.readFileSync(path.join(ROOT, 'agents', 'escalation-reviewer.md'), 'utf8').split('{{KIT}}').join(ROOT.replace(/\\/g, '/')));

  // (3) a file adopt never wrote (no manifest entry, not a known kit release) -> conflict
  const man2 = JSON.parse(fs.readFileSync(manFile, 'utf8'));
  delete man2.files['.claude/agents/escalation-reviewer-opus.md'];
  fs.writeFileSync(manFile, JSON.stringify(man2, null, 2) + '\n');
  fs.writeFileSync(path.join(repo, '.claude/agents/escalation-reviewer-opus.md'), 'the owner wrote this\n');
  const foreign = await adoptJson(['--repo', repo, '--update'], c.env);
  assert.equal(foreign.code, 3);
  assert.equal(action(foreign.out, '.claude/agents/escalation-reviewer-opus.md'), 'conflict');
  assert.equal(fs.readFileSync(path.join(repo, '.claude/agents/escalation-reviewer-opus.md'), 'utf8'), 'the owner wrote this\n');
});

/* -------------------------------------------------------------- MCP ---- */

function server(env) {
  const child = spawn(process.execPath, [ORCH_BIN, 'mcp'], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const waiters = new Map();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (l) => {
    try {
      const m = JSON.parse(l);
      const w = waiters.get(m.id);
      if (w) {
        waiters.delete(m.id);
        w(m);
      }
    } catch {
      /* ignore */
    }
  });
  let n = 0;
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  return {
    child,
    exited,
    get stderr() {
      return stderr;
    },
    send: (o) => child.stdin.write(JSON.stringify(o) + '\n'),
    req(method, params, ms = 30000) {
      const id = ++n;
      return new Promise((res, rej) => {
        const tm = setTimeout(() => rej(new Error(`${method}: no answer in ${ms} ms (server exit ${child.exitCode}); stderr: ${stderr}`)), ms);
        waiters.set(id, (m) => {
          clearTimeout(tm);
          res(m);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
  };
}

test('FIX a1: a call that fails AFTER its bound does not crash orch mcp (the late rejection is handled)', { timeout: 120000 }, async (t) => {
  const c = makeCase('s3fix-a1');
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-s3fix-plain-'));
  const env = { ...c.env, ORCH_MCP_BOUND_MS: '1', GIT_CEILING_DIRECTORIES: path.dirname(plain) };
  const srv = server(env);
  t.after(async () => {
    srv.child.stdin.end();
    await srv.exited;
    fs.rmSync(plain, { recursive: true, force: true }); // created by this test
    c.cleanup();
  });
  assert.equal((await orch(['claim', 'WP-A1', '--by', 'owner'], c.env)).code, 0);
  await srv.req('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const r = await srv.req('tools/call', { name: 'worktree_create', arguments: { repo: plain, wp: 'WP-A1', slice: 's1', by: 'owner' } });
  assert.equal(r.result.structuredContent.error, 'bound-exceeded', JSON.stringify(r.result));
  await waitFor(() => /failed after its bound/.test(srv.stderr), { timeoutMs: 20000, what: 'the late failure to be logged' });
  const alive = await srv.req('tools/call', { name: 'claims', arguments: {} }, 20000);
  assert.ok(alive.result, 'the server still answers');
  assert.equal(srv.child.exitCode, null, 'and is still running');
});

test('FIX a2: the client closing stdout (EPIPE) does not crash orch mcp', { timeout: 60000 }, async (t) => {
  const c = makeCase('s3fix-a2');
  t.after(() => c.cleanup());
  const srv = server(c.env);
  await srv.req('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  srv.child.stdout.destroy(); // the client stops reading
  for (let i = 0; i < 20; i++) srv.send({ jsonrpc: '2.0', id: 100 + i, method: 'tools/list', params: {} });
  await new Promise((r) => setTimeout(r, 1500));
  srv.child.stdin.end();
  const code = await srv.exited;
  assert.equal(code, 0, `exit ${code}; stderr: ${srv.stderr}`);
  assert.doesNotMatch(srv.stderr, /Unhandled 'error' event|EPIPE.*at /);
});

test('FIX a4: prototype property names are unknown tools (-32602), not a TypeError', { timeout: 60000 }, async (t) => {
  const c = makeCase('s3fix-a4');
  const srv = server(c.env);
  t.after(async () => {
    srv.child.stdin.end();
    await srv.exited;
    c.cleanup();
  });
  await srv.req('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const r = await srv.req('tools/call', { name, arguments: {} });
    assert.ok(r.error, `${name}: ${JSON.stringify(r)}`);
    assert.equal(r.error.code, -32602, name);
    assert.match(r.error.message, /Unknown tool/);
  }
});

test('FIX c6: a monitor that cannot be spawned does not crash orch run or orch mcp; the answer says the run is unmonitored', { timeout: 120000 }, async (t) => {
  const c = makeCase('s3fix-c6');
  const env = { ...c.env, ORCH_TEST_MONITOR_EXE: 'C:\\definitely\\missing\\node-monitor.exe' };
  const ids = [];
  t.after(async () => {
    for (const id of ids) await waitFor(() => keeperLines(c.stateRoot, id).some((l) => l.event === 'keeper-exit'), { timeoutMs: 60000, what: `keeper of ${id} to finish` }).catch(() => {});
    c.cleanup();
  });
  const cli = await orch(['run', '--cli', 'fake', '--dir', c.work, '--handoff', c.handoffPath, '--no-window'], env);
  assert.equal(cli.code, 0, `orch run: exit ${cli.code}\n${cli.stdout}\n${cli.stderr}`);
  ids.push(idFrom(cli.stdout));
  assert.match(cli.stdout, /monitor did not start/);
  const srv = server(env);
  await srv.req('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const r = await srv.req('tools/call', { name: 'run', arguments: { cli: 'fake', dir: c.work, handoff: c.handoffPath, 'no-window': true } }, 60000);
  assert.equal(r.result.isError, false, JSON.stringify(r.result));
  ids.push(r.result.structuredContent.output.id);
  assert.match(r.result.structuredContent.output.monitor_error, /monitor did not start/);
  const alive = await srv.req('tools/call', { name: 'claims', arguments: {} });
  assert.ok(alive.result, 'the server still answers');
  srv.child.stdin.end();
  assert.equal(await srv.exited, 0);
});

/* ------------------------------------------------------------- docs ---- */

test('FIX a3 (+ c1 limitation): workflow.md gives --by for review --finish / review_finish and states what the guard cannot see', () => {
  const wf = fs.readFileSync(path.join(ROOT, 'skills', 'orchestrate', 'workflow.md'), 'utf8');
  assert.match(wf, /orch review --finish <review-id> --by <you>/);
  assert.match(wf, /review_finish[^\n]*\n?[^\n]*by=<you>/);
  assert.match(wf, /not a sandbox/);
  assert.match(wf, /variable set in an earlier command/);
});
