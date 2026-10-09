// Adoption boundaries: preserve owner bytes, select native discovery, and recover partial writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cmdAdopt, GUARD_COMMAND } from '../src/adopt.mjs';
import { parseArgs } from '../src/cli.mjs';
import { makeCase, idFrom, orch, waitForStatus } from './helpers.mjs';
import { makeRepo } from './wf-helpers.mjs';

const START = '<!-- orch:bootstrap:v1:start -->';
const END = '<!-- orch:bootstrap:v1:end -->';
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t, name) {
  const c = makeCase(`p01-${name}`);
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'example\n', 'src/a.js': '1\n' });
  const config = path.join(c.base, 'codex.toml');
  fs.writeFileSync(config, '');
  const adopt = (args = {}, opts = {}) => cmdAdopt({ repo, harness: ['codex'], 'codex-config': config, json: true, ...args }, { log() {} }, opts);
  return { ...c, repo, config, adopt };
}
function block(buf) {
  const a = buf.indexOf(START);
  const b = buf.indexOf(END, a) + Buffer.byteLength(END);
  assert.ok(a >= 0 && b > a);
  return buf.subarray(a, b);
}
function olderBlock(repo, rel = 'AGENTS.md') {
  const f = path.join(repo, rel);
  const cur = fs.readFileSync(f);
  const owned = block(cur);
  const older = Buffer.from(`${START}\nEarlier orch bootstrap\n${END}`);
  fs.writeFileSync(f, Buffer.concat([cur.subarray(0, cur.indexOf(START)), older, cur.subarray(cur.indexOf(END) + Buffer.byteLength(END))]));
  const manFile = path.join(repo, '.orch-adopt.json');
  const man = JSON.parse(fs.readFileSync(manFile, 'utf8'));
  man.blocks[rel].sha256 = hash(older);
  fs.writeFileSync(manFile, JSON.stringify(man, null, 2) + '\n');
  return owned;
}

test('P01: repeatable harness selection does not install unselected integrations', async (t) => {
  const f = fixture(t, 'selection');
  const args = parseArgs(['--harness', 'opencode', '--harness=vibe']);
  assert.deepEqual(args.harness, ['opencode', 'vibe']);
  const r = await f.adopt(args);
  assert.equal(r.exitCode, 0);
  assert.ok(fs.existsSync(path.join(f.repo, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(f.repo, '.orch/instructions/orchestrator.md')));
  for (const rel of ['CLAUDE.md', '.claude', '.codex', '.mcp.json', '.agents']) assert.equal(fs.existsSync(path.join(f.repo, rel)), false, rel);
  assert.deepEqual(r.harnesses, ['opencode', 'vibe']);
  assert.equal(r.register_globally.length, 0);
});

for (const [name, original] of [
  ['empty', Buffer.alloc(0)], ['LF', Buffer.from('Owner rules\n')],
  ['CRLF', Buffer.from('Owner rules\r\n')], ['mixed', Buffer.from('one\r\ntwo\nthree')],
  ['BOM', Buffer.from('\ufeffOwner rules\r\n')], ['no-final-newline', Buffer.from('Owner rules')],
]) test(`P01: append preserves every owner byte (${name}) and repeated adoption preserves mtime`, async (t) => {
  const f = fixture(t, name);
  const file = path.join(f.repo, 'AGENTS.md');
  fs.writeFileSync(file, original);
  assert.equal((await f.adopt()).exitCode, 0);
  const after = fs.readFileSync(file);
  assert.deepEqual(after.subarray(0, original.length), original);
  assert.equal(after.toString('utf8').split(START).length, 2);
  const mtime = fs.statSync(file).mtimeMs;
  const again = await f.adopt();
  assert.equal(again.exitCode, 0, JSON.stringify(again));
  assert.equal(again.written.length, 0);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  const man = JSON.parse(fs.readFileSync(path.join(f.repo, '.orch-adopt.json'), 'utf8'));
  assert.equal(man.blocks['AGENTS.md'].sha256, hash(block(after)));
});

test('P01: updating an owned block preserves later edits outside it; editing inside conflicts', async (t) => {
  const f = fixture(t, 'update');
  const file = path.join(f.repo, 'AGENTS.md');
  fs.writeFileSync(file, 'Owner\r\n');
  await f.adopt();
  const current = olderBlock(f.repo);
  fs.appendFileSync(file, 'New owner text\r\n');
  const before = fs.readFileSync(file);
  const stale = await f.adopt();
  assert.equal(stale.items.find((i) => i.path === 'AGENTS.md').action, 'stale');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal((await f.adopt({ update: true })).exitCode, 0);
  const after = fs.readFileSync(file);
  assert.deepEqual(block(after), current);
  assert.ok(after.toString().startsWith('Owner\r\n'));
  assert.ok(after.toString().endsWith('New owner text\r\n'));
  fs.writeFileSync(file, after.toString().replace('.orch/instructions/common.md', 'owner-custom.md'));
  const edited = fs.readFileSync(file);
  const conflict = await f.adopt({ update: true });
  assert.equal(conflict.exitCode, 3);
  assert.equal(conflict.written.length, 0);
  assert.deepEqual(fs.readFileSync(file), edited);
});

for (const [name, input] of [
  ['unmatched', START], ['duplicate', `${START}\n${END}\n${START}\n${END}`],
  ['foreign', `${START}\nforeign\n${END}`], ['future-marker', '<!-- orch:bootstrap:v2:start -->'],
  ['UTF16', Buffer.from([255, 254, 65, 0])], ['invalid-UTF8', Buffer.from([0xc3, 0x28])], ['binary', 'owner\0rules'],
]) test(`P01: ${name} instructions refuse all writes`, async (t) => {
  const f = fixture(t, name);
  const file = path.join(f.repo, 'AGENTS.md');
  fs.writeFileSync(file, input);
  const before = fs.readFileSync(file);
  const r = await f.adopt({ update: true });
  assert.equal(r.exitCode, 3);
  assert.equal(r.written.length, 0);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(f.repo, '.orch')), false);
});

test('P01: Codex override and configured fallback are selected without shadow files', async (t) => {
  const f = fixture(t, 'override');
  fs.writeFileSync(path.join(f.repo, 'AGENTS.md'), 'normal owner\n');
  fs.writeFileSync(path.join(f.repo, 'AGENTS.override.md'), 'override owner\n');
  const r = await f.adopt();
  assert.equal(r.exitCode, 0);
  assert.match(fs.readFileSync(path.join(f.repo, 'AGENTS.override.md'), 'utf8'), /orch:bootstrap/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'AGENTS.md'), 'utf8'), 'normal owner\n');
  const g = fixture(t, 'fallback');
  fs.writeFileSync(g.config, 'project_doc_fallback_filenames = ["TEAM.md"]\nproject_doc_max_bytes = 8192\n');
  fs.writeFileSync(path.join(g.repo, 'TEAM.md'), 'team owner\n');
  assert.equal((await g.adopt()).exitCode, 0);
  assert.match(fs.readFileSync(path.join(g.repo, 'TEAM.md'), 'utf8'), /orch:bootstrap/);
  assert.equal(fs.existsSync(path.join(g.repo, 'AGENTS.md')), false);
});

test('P01: a subdirectory adoption reports nested instruction scope and the Codex byte limit', async (t) => {
  const f = fixture(t, 'nested');
  fs.writeFileSync(path.join(f.repo, 'AGENTS.md'), 'Owner\n');
  fs.writeFileSync(path.join(f.repo, 'src/AGENTS.override.md'), 'Nested owner\n');
  fs.writeFileSync(f.config, 'project_doc_max_bytes = 10\n');
  const r = await f.adopt({ repo: path.join(f.repo, 'src') });
  assert.equal(r.exitCode, 0);
  const readiness = r.readiness.find((x) => x.harness === 'codex');
  assert.equal(readiness.instructions, 'partial');
  assert.ok(readiness.warnings.some((s) => /byte limit/.test(s)));
  assert.ok(readiness.discovery.some((s) => s === 'src/AGENTS.override.md'));
  assert.equal(fs.readFileSync(path.join(f.repo, 'src/AGENTS.override.md'), 'utf8'), 'Nested owner\n');
  assert.notEqual(readiness.hooks, 'enforced');
});

test('P01: concurrent root instruction edit aborts before any write', async (t) => {
  const f = fixture(t, 'concurrent');
  const file = path.join(f.repo, 'AGENTS.md');
  fs.writeFileSync(file, 'Before');
  const r = await f.adopt({}, { beforeWrite: () => fs.writeFileSync(file, 'Concurrent owner edit') });
  assert.equal(r.exitCode, 3);
  assert.equal(r.written.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Concurrent owner edit');
});

test('P01: later write failure records only successful ownership and can be resumed', async (t) => {
  const f = fixture(t, 'partial');
  const r = await f.adopt({}, { beforeItemWrite: (item) => {
    if (item.path === '.orch/instructions/common.md') throw new Error('injected disk failure');
  } });
  assert.equal(r.exitCode, 3);
  assert.ok(r.written.includes('AGENTS.md'));
  assert.ok(r.write_errors.some((e) => /injected disk failure/.test(e.detail)));
  const man = JSON.parse(fs.readFileSync(path.join(f.repo, '.orch-adopt.json'), 'utf8'));
  assert.ok(man.blocks['AGENTS.md']);
  assert.equal(man.files['.orch/instructions/common.md'], undefined);
  const again = await f.adopt();
  assert.equal(again.exitCode, 0, JSON.stringify(again));
  assert.ok(fs.existsSync(path.join(f.repo, '.orch/instructions/common.md')));
});

test('P01: moved known guard replaces the handler, preserving adjacent hooks', async (t) => {
  const f = fixture(t, 'relocation');
  await f.adopt({ harness: ['claude', 'codex'] });
  const manFile = path.join(f.repo, '.orch-adopt.json');
  const man = JSON.parse(fs.readFileSync(manFile, 'utf8'));
  man.kit = 'Z:/previous-kit';
  fs.writeFileSync(manFile, JSON.stringify(man));
  for (const rel of ['.claude/settings.json', '.codex/hooks.json']) {
    const file = path.join(f.repo, rel);
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    obj.hooks.PreToolUse[0].hooks[0].command = 'node "Z:/previous-kit/hooks/guard.mjs"';
    obj.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'node owner-check.mjs', timeout: 10 });
    obj.hooks.PreToolUse.push({ matcher: 'Read', hooks: [{ type: 'command', command: 'echo "Z:/previous-kit/hooks/guard.mjs"' }] });
    fs.writeFileSync(file, JSON.stringify(obj));
  }
  const r = await f.adopt({ harness: ['claude', 'codex'], update: true });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  for (const rel of ['.claude/settings.json', '.codex/hooks.json']) {
    const obj = JSON.parse(fs.readFileSync(path.join(f.repo, rel), 'utf8'));
    assert.equal(obj.hooks.PreToolUse.length, 2, 'no new guard group');
    assert.equal(obj.hooks.PreToolUse[0].hooks[0].command, GUARD_COMMAND);
    assert.equal(obj.hooks.PreToolUse[0].hooks[1].command, 'node owner-check.mjs');
    assert.equal(obj.hooks.PreToolUse[1].hooks[0].command, 'echo "Z:/previous-kit/hooks/guard.mjs"');
  }
});

for (const [role, label] of [['implement', 'implementer'], ['review', 'reviewer']]) test(`P01: ${label} receives a private role packet and the original handoff bytes`, { timeout: 120000 }, async (t) => {
  const f = fixture(t, `packet-${role}`);
  // A freshly created worktree has no ignored adoption payload. A root pointer cannot
  // supply its role; the prompt must carry the packet independent of those files.
  fs.writeFileSync(path.join(f.work, 'AGENTS.md'), 'Owner rules\nUse orch when asked\n');
  const original = fs.readFileSync(f.handoffPath);
  const { cmdRun } = await import('../src/commands.mjs');
  const oldEnv = { ...process.env };
  Object.assign(process.env, f.env);
  let launch;
  try {
    launch = await cmdRun({ cli: 'fake', dir: f.work, handoff: f.handoffPath, 'state-root': f.stateRoot, 'no-window': true, json: true }, { log() {} }, { role });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete process.env[k];
    Object.assign(process.env, oldEnv);
  }
  const rec = await waitForStatus(f.stateRoot, launch.id, ['completed', 'failed'], { timeoutMs: 60000 });
  assert.equal(rec.status, 'completed');
  const prompt = fs.readFileSync(path.join(f.stateRoot, 'runs', launch.id, 'prompt.txt'));
  assert.ok(prompt.length > original.length, 'role packet missing');
  assert.deepEqual(prompt.subarray(prompt.length - original.length), original, 'handoff suffix byte-exact');
  assert.equal(rec.handoff_sha256, hash(original));
  assert.equal(rec.handoff_bytes, original.length);
  assert.equal(rec.prompt_sha256, hash(prompt));
  assert.equal(rec.role_packet.role, label);
  assert.match(prompt.toString('utf8'), new RegExp(`Role: ${label}`));
  assert.deepEqual(fs.readFileSync(f.handoffPath), original);
  assert.equal(fs.existsSync(path.join(f.work, '.orch')), false);
  const result = JSON.parse((await orch(['result', launch.id, '--json'], f.env)).stdout);
  assert.match(result.final_message, new RegExp(`STDIN-SHA256 ${hash(prompt)}`));
});

test('P01: a public run cannot choose the reviewer or orchestrator role', async (t) => {
  const f = fixture(t, 'role-contract');
  const r = await orch(['run', '--cli', 'fake', '--dir', f.work, '--handoff', f.handoffPath, '--role', 'review', '--no-window'], f.env);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /role.*orch review/i);
});

test('P01: partial application cannot overwrite a concurrently edited manifest', async (t) => {
  const f = fixture(t, 'manifest-race');
  await f.adopt();
  olderBlock(f.repo);
  const manFile = path.join(f.repo, '.orch-adopt.json');
  let concurrent;
  const r = await f.adopt({ update: true }, { beforeItemWrite: (item) => {
    if (item.path === 'AGENTS.md') {
      concurrent = JSON.stringify({ ...JSON.parse(fs.readFileSync(manFile, 'utf8')), owner_note: 'concurrent' });
      fs.writeFileSync(manFile, concurrent);
    }
  } });
  assert.equal(r.exitCode, 3);
  assert.equal(fs.readFileSync(manFile, 'utf8'), concurrent);
  const again = await f.adopt({ update: true });
  assert.equal(again.exitCode, 0);
  assert.equal(JSON.parse(fs.readFileSync(manFile, 'utf8')).owner_note, 'concurrent');
});

test('P01: OpenCode preserves its existing Claude fallback; nearest nested entrypoints are selected', async (t) => {
  const f = fixture(t, 'opencode-fallback');
  fs.writeFileSync(path.join(f.repo, 'CLAUDE.md'), 'Existing owner rules\n');
  assert.equal((await f.adopt({ harness: ['opencode'] })).exitCode, 0);
  assert.equal(fs.existsSync(path.join(f.repo, 'AGENTS.md')), false);
  assert.match(fs.readFileSync(path.join(f.repo, 'CLAUDE.md'), 'utf8'), /orch:bootstrap/);
  const g = fixture(t, 'nearest');
  fs.writeFileSync(path.join(g.repo, 'src/AGENTS.md'), 'Nested owner rules\n');
  const r = await g.adopt({ harness: ['opencode', 'vibe'], repo: path.join(g.repo, 'src') });
  assert.equal(r.exitCode, 0);
  assert.match(fs.readFileSync(path.join(g.repo, 'src/AGENTS.md'), 'utf8'), /orch:bootstrap/);
  assert.equal(fs.existsSync(path.join(g.repo, 'AGENTS.md')), false);
});

test('P01: junction ancestors refuse writes outside the selected repository', async (t) => {
  const f = fixture(t, 'junction');
  const foreign = path.join(f.base, 'foreign');
  fs.mkdirSync(foreign);
  try { fs.symlinkSync(foreign, path.join(f.repo, '.orch'), 'junction'); }
  catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') { t.skip('host denied creation of the junction fixture'); return; }
    throw e;
  }
  const r = await f.adopt();
  assert.equal(r.exitCode, 3);
  assert.equal(r.written.length, 0);
  assert.deepEqual(fs.readdirSync(foreign), []);
});

test('P01: Codex project instruction budget excludes global user guidance', async (t) => {
  const f = fixture(t, 'global-budget');
  fs.writeFileSync(path.join(f.base, 'AGENTS.md'), 'Global '.repeat(5000));
  const r = await f.adopt();
  assert.equal(r.readiness[0].instructions, 'prepared');
  assert.ok(!r.readiness[0].warnings.some((s) => /byte limit/.test(s)));
});

test('P01: an initially unchanged manifest also preserves concurrent owner edits', async (t) => {
  const f = fixture(t, 'unchanged-manifest-race');
  await f.adopt();
  fs.unlinkSync(path.join(f.repo, '.orch/instructions/common.md'));
  const manFile = path.join(f.repo, '.orch-adopt.json');
  let concurrent;
  const r = await f.adopt({}, { beforeItemWrite: (item) => {
    if (item.path === '.orch/instructions/common.md') {
      concurrent = JSON.stringify({ ...JSON.parse(fs.readFileSync(manFile, 'utf8')), owner_note: 'concurrent' });
      fs.writeFileSync(manFile, concurrent);
    }
  } });
  assert.equal(r.exitCode, 3);
  assert.equal(fs.readFileSync(manFile, 'utf8'), concurrent);
});

test('P01: unresolved Codex fallback configuration requires explicit bootstrap without a shadow file', async (t) => {
  const f = fixture(t, 'unresolved-config');
  fs.writeFileSync(f.config, "project_doc_fallback_filenames = [\n  'TEAM.md',\n]\n");
  fs.writeFileSync(path.join(f.repo, 'TEAM.md'), 'Owner team rules\n');
  const r = await f.adopt();
  assert.equal(r.exitCode, 3);
  assert.equal(r.written.length, 0);
  assert.equal(fs.existsSync(path.join(f.repo, 'AGENTS.md')), false);
  const explicit = await f.adopt({ 'instruction-file': ['codex=TEAM.md'] });
  assert.equal(explicit.exitCode, 0);
  assert.equal(explicit.readiness[0].instructions, 'partial');
  assert.match(fs.readFileSync(path.join(f.repo, 'TEAM.md'), 'utf8'), /orch:bootstrap/);
});

test('P01: new native override appearing after planning aborts adoption before any write', async (t) => {
  const f = fixture(t, 'discovery-race');
  const r = await f.adopt({}, { beforeWrite: () => fs.writeFileSync(path.join(f.repo, 'AGENTS.override.md'), 'New owner override\n') });
  assert.equal(r.exitCode, 3);
  assert.equal(r.written.length, 0);
  assert.equal(fs.existsSync(path.join(f.repo, 'AGENTS.md')), false);
});

test('P01: combining OpenCode fallback with Vibe retains the owner instruction source across re-adoption', async (t) => {
  const f = fixture(t, 'combined-fallback');
  fs.writeFileSync(path.join(f.repo, 'CLAUDE.md'), 'Owner Claude rules\n');
  const r = await f.adopt({ harness: ['opencode', 'vibe'] });
  assert.equal(r.exitCode, 0);
  const entry = fs.readFileSync(path.join(f.repo, 'AGENTS.md'), 'utf8');
  assert.match(entry, /Read these existing owner instruction sources too: `CLAUDE.md`/);
  const again = await f.adopt({ harness: ['opencode', 'vibe'], update: true });
  assert.equal(again.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(f.repo, 'AGENTS.md'), 'utf8'), entry);
  assert.equal(again.written.length, 0);
});

test('P01: malformed block ownership produces a complete refusal preview', async (t) => {
  const f = fixture(t, 'malformed-ownership');
  await f.adopt();
  const file = path.join(f.repo, '.orch-adopt.json');
  const man = JSON.parse(fs.readFileSync(file, 'utf8'));
  man.blocks['AGENTS.md'].harnesses = 42;
  fs.writeFileSync(file, JSON.stringify(man));
  const r = await f.adopt({ update: true });
  assert.equal(r.exitCode, 3);
  assert.equal(r.written.length, 0);
  assert.equal(r.items.find((i) => i.path === '.orch-adopt.json').action, 'refused');
  assert.ok(r.items.some((i) => i.path === '.codex/hooks.json'));
});

test('P01: an existing empty Codex override wins discovery without altering normal owner rules', async (t) => {
  const f = fixture(t, 'empty-override');
  fs.writeFileSync(path.join(f.repo, 'AGENTS.override.md'), '');
  fs.writeFileSync(path.join(f.repo, 'AGENTS.md'), 'Normal owner rules\n');
  const r = await f.adopt();
  assert.equal(r.exitCode, 0);
  assert.equal(r.readiness[0].path, 'AGENTS.override.md');
  assert.match(fs.readFileSync(path.join(f.repo, 'AGENTS.override.md'), 'utf8'), /orch:bootstrap/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'AGENTS.md'), 'utf8'), 'Normal owner rules\n');
});

test('P01: a zero Codex instruction budget reports disabled project discovery', async (t) => {
  const f = fixture(t, 'zero-budget');
  fs.writeFileSync(f.config, 'project_doc_max_bytes = 0\n');
  const r = await f.adopt();
  assert.equal(r.readiness[0].instructions, 'partial');
  assert.ok(r.readiness[0].warnings.some((s) => /byte limit 0/.test(s)));
});

test('P01: custom Codex project-root markers require an explicit bootstrap', async (t) => {
  const f = fixture(t, 'custom-root');
  fs.writeFileSync(f.config, 'project_root_markers = []\n');
  const r = await f.adopt({ repo: path.join(f.repo, 'src') });
  assert.equal(r.exitCode, 3);
  assert.equal(r.written.length, 0);
  const explicit = await f.adopt({ repo: path.join(f.repo, 'src'), 'instruction-file': ['codex=src/AGENTS.md'] });
  assert.equal(explicit.exitCode, 0);
  assert.equal(explicit.readiness[0].instructions, 'partial');
});

test('P01 review repair: identical bootstrap can recover missing or stale ownership without rewriting owner bytes', async (t) => {
  const f = fixture(t, 'recover-block');
  fs.writeFileSync(path.join(f.repo, 'AGENTS.md'), 'Owner rules\r\n');
  await f.adopt();
  const file = path.join(f.repo, 'AGENTS.md'), manFile = path.join(f.repo, '.orch-adopt.json');
  const original = fs.readFileSync(file);
  fs.unlinkSync(manFile); // this fixture's own record, modelling a clone without the private manifest
  assert.equal((await f.adopt()).exitCode, 0);
  assert.deepEqual(fs.readFileSync(file), original);
  const man = JSON.parse(fs.readFileSync(manFile, 'utf8'));
  man.blocks['AGENTS.md'].sha256 = hash('old record');
  man.owner_note = 'keep';
  fs.writeFileSync(manFile, JSON.stringify(man));
  assert.equal((await f.adopt()).exitCode, 0);
  assert.deepEqual(fs.readFileSync(file), original);
  const repaired = JSON.parse(fs.readFileSync(manFile, 'utf8'));
  assert.equal(repaired.blocks['AGENTS.md'].sha256, hash(block(original)));
  assert.equal(repaired.owner_note, 'keep');
});

test('P01 review repair: manifest write failure is recoverable on rerun', async (t) => {
  const f = fixture(t, 'manifest-write-failure');
  const write = fs.writeFileSync;
  let first;
  try {
    fs.writeFileSync = function (file, ...args) {
      if (String(file).includes('.orch-adopt.json')) throw new Error('manifest disk failure');
      return write.call(fs, file, ...args);
    };
    first = await f.adopt();
  } finally { fs.writeFileSync = write; }
  assert.equal(first.exitCode, 3);
  assert.ok(first.written.includes('AGENTS.md'));
  assert.equal((await f.adopt()).exitCode, 0);
});

test('P01 review repair: a partial create is never published and its temp is removed', async (t) => {
  const f = fixture(t, 'partial-create');
  const write = fs.writeFileSync;
  let result;
  try {
    fs.writeFileSync = function (file, content, ...args) {
      if (path.basename(String(file)).startsWith('AGENTS.md')) {
        const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
        write.call(fs, file, bytes.subarray(0, 12), ...args);
        throw new Error('injected mid-write failure');
      }
      return write.call(fs, file, content, ...args);
    };
    result = await f.adopt();
  } finally { fs.writeFileSync = write; }
  assert.equal(result.exitCode, 3);
  assert.equal(fs.existsSync(path.join(f.repo, 'AGENTS.md')), false);
  assert.equal(fs.readdirSync(f.repo).some((n) => n.includes('.orch-adopt-')), false);
  assert.equal((await f.adopt()).exitCode, 0);
});

test('P01 review repair: later harness adoption preserves previously adopted OpenCode fallback', async (t) => {
  const f = fixture(t, 'sequential-fallback');
  fs.writeFileSync(path.join(f.repo, 'CLAUDE.md'), 'Owner OpenCode rules\n');
  await f.adopt({ harness: ['opencode'] });
  const claude = fs.readFileSync(path.join(f.repo, 'CLAUDE.md'));
  assert.equal((await f.adopt({ harness: ['vibe'] })).exitCode, 0);
  assert.match(fs.readFileSync(path.join(f.repo, 'AGENTS.md'), 'utf8'), /Read these existing owner instruction sources too: `CLAUDE.md`/);
  assert.deepEqual(fs.readFileSync(path.join(f.repo, 'CLAUDE.md')), claude);
});

for (const rel of ['.codex/hooks.json', '.orch/instructions/common.md', '.orch-adopt.json', '.CLAUDE/settings.json']) test(`P01 review repair: explicit instruction path cannot collide with ${rel}`, async (t) => {
  const f = fixture(t, 'reserved-target');
  await assert.rejects(f.adopt({ 'instruction-file': [`codex=${rel}`] }), /instruction.*(reserved|managed|collision)/i);
  assert.equal(fs.existsSync(path.join(f.repo, 'AGENTS.md')), false);
});

test('P01 review repair: duplicate current guards are preserved without update and empty groups are removed only on update', async (t) => {
  const f = fixture(t, 'guard-duplicates');
  await f.adopt({ harness: ['claude'] });
  const file = path.join(f.repo, '.claude/settings.json');
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  obj.hooks.PreToolUse.push(structuredClone(obj.hooks.PreToolUse[0]));
  const original = JSON.stringify(obj);
  fs.writeFileSync(file, original);
  assert.equal((await f.adopt({ harness: ['claude'] })).exitCode, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  await f.adopt({ harness: ['claude'], update: true });
  const groups = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse;
  assert.equal(groups.length, 1);
  assert.ok(groups.every((g) => g.hooks.length));
});

test('P01 review repair: stale guard reports stale readiness rather than configured', async (t) => {
  const f = fixture(t, 'stale-hook-readiness');
  await f.adopt();
  const manFile = path.join(f.repo, '.orch-adopt.json'), file = path.join(f.repo, '.codex/hooks.json');
  const man = JSON.parse(fs.readFileSync(manFile, 'utf8'));
  man.kit = 'Z:/previous-kit';
  fs.writeFileSync(manFile, JSON.stringify(man));
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  obj.hooks.PreToolUse[0].hooks[0].command = 'node "Z:/previous-kit/hooks/guard.mjs"';
  fs.writeFileSync(file, JSON.stringify(obj));
  assert.equal((await f.adopt()).readiness[0].hooks, 'stale-unqualified');
});

test('P01 review repair: missing explicitly supplied Codex config refuses default assumptions', async (t) => {
  const f = fixture(t, 'missing-config');
  const r = await f.adopt({ 'codex-config': path.join(f.base, 'not-found.toml') });
  assert.equal(r.exitCode, 3);
  assert.equal(r.written.length, 0);
  assert.ok(r.readiness[0].warnings.some((w) => /config.*(missing|not found)/i.test(w)));
});
