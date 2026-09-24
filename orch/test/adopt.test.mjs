// Slice 3, gate T4: `orch adopt` against temp repositories created by the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeCase, orch } from './helpers.mjs';
import { g, makeRepo } from './wf-helpers.mjs';
import { GUARD_COMMAND, KIT_ROOT } from '../src/adopt.mjs';

/** Every file under dir (except .git) -> sha256 + mtime. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out[path.relative(dir, p).replace(/\\/g, '/')] = `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${st.mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}

const json = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`not JSON (exit ${r.code}): ${r.stdout}\n${r.stderr}`);
  }
};

const EXPECTED = [
  '.claude/settings.json',
  '.claude/skills/orchestrate/SKILL.md',
  '.claude/skills/orchestrate/workflow.md',
  '.claude/agents/researcher.md',
  '.claude/agents/escalation-reviewer.md',
  '.claude/agents/escalation-reviewer-opus.md',
  '.agents/skills/orchestrate/SKILL.md',
  '.agents/skills/orchestrate/workflow.md',
  '.mcp.json',
  '.codex/hooks.json',
  '.orch-adopt.json',
];

test('T4: dry-run changes nothing; real run creates exactly the listed files; a second run changes nothing', { timeout: 120000 }, async (t) => {
  const c = makeCase('t4-fresh');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n', 'src/a.js': '1\n' });
  const before = snapshot(repo);
  const statusBefore = g(repo, 'status', '--porcelain');

  const dry = await orch(['adopt', '--repo', repo, '--dry-run', '--json'], c.env);
  assert.equal(dry.code, 0, dry.stderr);
  const d = json(dry);
  assert.equal(d.dry_run, true);
  assert.equal(d.wrote, 'nothing');
  assert.deepEqual(d.items.map((i) => i.path), EXPECTED);
  assert.ok(d.items.every((i) => i.action === 'create'), JSON.stringify(d.items));
  assert.deepEqual(snapshot(repo), before, 'dry run: not one byte changed');
  assert.equal(g(repo, 'status', '--porcelain'), statusBefore);
  assert.ok(d.register_globally.some((x) => x.startsWith('claude mcp add --scope user orch -- node ')));
  assert.ok(d.register_globally.some((x) => x.startsWith('codex mcp add orch -- node ')));

  const real = await orch(['adopt', '--repo', repo, '--json'], c.env);
  assert.equal(real.code, 0, real.stderr);
  const r = json(real);
  assert.equal(r.wrote, `${EXPECTED.length} file(s)`);
  const after = snapshot(repo);
  const created = Object.keys(after).filter((k) => !(k in before)).sort();
  assert.deepEqual(created, [...EXPECTED].sort(), 'exactly the listed files were created');
  for (const k of Object.keys(before)) assert.equal(after[k], before[k], `${k} untouched`);
  console.log(`T4: created ${created.length} files: ${created.join(', ')}`);

  // content: hook, MCP entry, Codex hook, rendered copies
  const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Bash|PowerShell|Read|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: GUARD_COMMAND, timeout: 20 }] }]);
  const mcp = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.orch.command, 'node');
  assert.deepEqual(mcp.mcpServers.orch.args, [path.join(KIT_ROOT, 'orch', 'bin', 'orch.mjs').replace(/\\/g, '/'), 'mcp']);
  const codex = JSON.parse(fs.readFileSync(path.join(repo, '.codex/hooks.json'), 'utf8'));
  assert.equal(codex.hooks.PreToolUse[0].matcher, '^Bash$');
  assert.equal(codex.hooks.PreToolUse[0].hooks[0].command, GUARD_COMMAND);
  for (const f of EXPECTED.filter((p) => p.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(repo, f), 'utf8');
    assert.ok(!text.includes('{{KIT}}'), `${f}: {{KIT}} rendered`);
  }
  assert.match(fs.readFileSync(path.join(repo, '.claude/skills/orchestrate/workflow.md'), 'utf8'), /node "[A-Za-z]:\/[^"]*\/orch\/bin\/orch\.mjs"/);

  const again = await orch(['adopt', '--repo', repo, '--json'], c.env);
  assert.equal(again.code, 0, again.stderr);
  const a = json(again);
  assert.ok(a.items.every((i) => i.action === 'unchanged'), JSON.stringify(a.items));
  assert.equal(a.wrote, '0 file(s)');
  assert.deepEqual(snapshot(repo), after, 'second run: nothing changed (content and mtime)');
});

test('T4: an existing .claude/settings.json keeps its other hooks and settings; .mcp.json keeps other servers', { timeout: 120000 }, async (t) => {
  const c = makeCase('t4-merge');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n' });
  const existing = {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/mine.mjs"', timeout: 10 }] }],
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node lint.mjs' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node stop.mjs' }] }],
    },
  };
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify(existing, null, 2));
  fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'npx', args: ['-y', 'x'] } } }, null, 2));
  const r = await orch(['adopt', '--repo', repo, '--json'], c.env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const items = Object.fromEntries(json(r).items.map((i) => [i.path, i.action]));
  assert.equal(items['.claude/settings.json'], 'update');
  assert.equal(items['.mcp.json'], 'update');
  const s = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s.permissions, existing.permissions);
  assert.deepEqual(s.hooks.PostToolUse, existing.hooks.PostToolUse);
  assert.deepEqual(s.hooks.Stop, existing.hooks.Stop);
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.deepEqual(s.hooks.PreToolUse[0], existing.hooks.PreToolUse[0], 'the existing PreToolUse hook is kept, first');
  assert.equal(s.hooks.PreToolUse[1].hooks[0].command, GUARD_COMMAND);
  const m = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(m.mcpServers), ['other', 'orch']);
  // idempotent on the merged files too
  const again = json(await orch(['adopt', '--repo', repo, '--json'], c.env));
  assert.ok(again.items.every((i) => i.action === 'unchanged'), JSON.stringify(again.items));
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse.length, 2);
});

test('T4: unparseable JSON is refused and NOTHING is written; a differing copied file is a conflict, never overwritten', { timeout: 120000 }, async (t) => {
  const c = makeCase('t4-refuse');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n' });
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  const broken = '{ "hooks": { "PreToolUse": [ } '; // unparseable
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), broken);
  const before = snapshot(repo);
  const r = await orch(['adopt', '--repo', repo, '--json'], c.env);
  assert.equal(r.code, 3, r.stdout + r.stderr);
  const out = json(r);
  assert.equal(out.wrote, 'nothing');
  const it = out.items.find((i) => i.path === '.claude/settings.json');
  assert.equal(it.action, 'refused');
  assert.match(it.detail, /unparseable JSON/);
  assert.deepEqual(snapshot(repo), before, 'nothing written anywhere');
  assert.equal(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'), broken);

  // a hooks value of the wrong type is refused too (never guessed)
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: [] }));
  const r2 = json(await orch(['adopt', '--repo', repo, '--json'], c.env));
  assert.equal(r2.items.find((i) => i.path === '.claude/settings.json').action, 'refused');

  // conflict: a local edit of a copied file
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{}\n');
  fs.mkdirSync(path.join(repo, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'agents', 'researcher.md'), 'my own researcher\n');
  const before3 = snapshot(repo);
  const r3 = await orch(['adopt', '--repo', repo], c.env);
  assert.equal(r3.code, 3);
  assert.match(r3.stdout, /conflict\s+\.claude\/agents\/researcher\.md/);
  assert.match(r3.stdout, /nothing written/);
  assert.deepEqual(snapshot(repo), before3);
});

test('T4: adopt into a git WORKTREE of the repo (and from a subdirectory) installs at that worktree top level only', { timeout: 120000 }, async (t) => {
  const c = makeCase('t4-wt');
  t.after(() => c.cleanup());
  const repo = path.join(c.base, 'repo');
  makeRepo(repo, { 'README.md': 'r\n', 'src/a.js': '1\n' });
  const wt = path.join(c.base, 'wt');
  g(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
  const repoBefore = snapshot(repo);
  const r = await orch(['adopt', '--repo', path.join(wt, 'src'), '--json'], c.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(path.resolve(json(r).repo).toLowerCase(), path.resolve(wt).toLowerCase());
  for (const f of EXPECTED) assert.ok(fs.existsSync(path.join(wt, f)), `${f} in the worktree`);
  assert.deepEqual(snapshot(repo), repoBefore, 'the main worktree is untouched');
  // not a git repository -> refused
  const plain = path.join(c.base, 'plain');
  fs.mkdirSync(plain);
  const bad = await orch(['adopt', '--repo', plain], { ...c.env, GIT_CEILING_DIRECTORIES: c.base });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /not inside a git repository/);
  assert.deepEqual(fs.readdirSync(plain), []);
});
