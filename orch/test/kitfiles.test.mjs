// Slice 3, gate T5: the skill and subagent files carry the frontmatter each host documents.
// Sources (checked 2026-09-23):
//  - Claude Code subagents (code.claude.com/docs/en/sub-agents): `name` and `description` required;
//    `tools` a comma-separated string or YAML list; `model` = sonnet|opus|haiku|fable|inherit|full id;
//    a name may not contain ":".
//  - Claude Code skills (code.claude.com/docs/en/skills): frontmatter must open on line 1; every field
//    optional, `description` recommended; description (+ when_to_use) truncated at 1,536 chars.
//  - Codex skills (openai/codex rust-v0.154.0, codex-rs/skills parser.rs + loader): `name` and
//    `description` required; name <= 64 chars (lowercase letters, digits, hyphens); description <= 1024.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KIT } from './helpers.mjs';
import { COMMANDS } from '../src/cli.mjs';

const ROOT = path.resolve(KIT, '..');

/** Frontmatter of a markdown file: flat `key: value` lines (the files use nothing else). */
export function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.startsWith('﻿'), `${file}: no BOM before the frontmatter`);
  const lines = text.split(/\r?\n/);
  assert.equal(lines[0], '---', `${file}: frontmatter must open on the first line`);
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, `${file}: frontmatter must be closed`);
  const fm = {};
  for (const l of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(l);
    assert.ok(m, `${file}: unexpected frontmatter line: ${l}`);
    assert.ok(!(m[1] in fm), `${file}: duplicate key ${m[1]}`);
    fm[m[1]] = m[2].trim();
  }
  return { fm, body: lines.slice(end + 1).join('\n') };
}

const CLAUDE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'Skill']);
const READ_ONLY = new Set(['Read', 'Grep', 'Glob']);

test('T5: Claude Code subagents - required name/description, documented model values, read-only tools', () => {
  const expect = {
    'researcher.md': { name: 'researcher', model: 'sonnet', allowed: new Set([...READ_ONLY, 'WebFetch', 'WebSearch']), mustHave: ['WebFetch', 'WebSearch'] },
    'escalation-reviewer.md': { name: 'escalation-reviewer', model: 'sonnet', allowed: READ_ONLY, template: true },
    'escalation-reviewer-opus.md': { name: 'escalation-reviewer-opus', model: 'opus', allowed: READ_ONLY, template: true },
  };
  const dir = path.join(ROOT, 'agents');
  assert.deepEqual(fs.readdirSync(dir).sort(), Object.keys(expect).sort());
  for (const [f, e] of Object.entries(expect)) {
    const { fm, body } = frontmatter(path.join(dir, f));
    assert.equal(fm.name, e.name, f);
    assert.ok(!fm.name.includes(':'), `${f}: ":" is reserved`);
    assert.ok(fm.description && fm.description.length > 30, `${f}: description required`);
    assert.ok(/^(sonnet|opus|haiku|fable|inherit|claude-[\w.-]+)$/.test(fm.model), `${f}: model ${fm.model}`);
    assert.equal(fm.model, e.model, f);
    const tools = fm.tools.split(',').map((x) => x.trim()).filter(Boolean);
    assert.ok(tools.length > 0, `${f}: an empty tool list would fail to launch`);
    for (const tl of tools) {
      assert.ok(CLAUDE_TOOLS.has(tl), `${f}: unknown tool ${tl}`);
      assert.ok(e.allowed.has(tl), `${f}: ${tl} is not read-only`);
    }
    for (const tl of e.mustHave || []) assert.ok(tools.includes(tl), `${f}: needs ${tl}`);
    for (const k of Object.keys(fm)) assert.ok(['name', 'description', 'tools', 'model'].includes(k), `${f}: unexpected field ${k}`);
    if (e.template) assert.match(body, /templates\/review-prompt\.md/, `${f}: uses the review-prompt template`);
    assert.match(body, /READ-ONLY/, `${f}: says it is read-only`);
  }
});

test('T5: the orchestrate skill - Claude Code and Codex wrappers over one shared body', () => {
  const claude = frontmatter(path.join(ROOT, 'skills', 'orchestrate', 'SKILL.md'));
  const codex = frontmatter(path.join(ROOT, '.agents', 'skills', 'orchestrate', 'SKILL.md'));
  for (const { host, fm, body } of [{ host: 'claude', ...claude }, { host: 'codex', ...codex }]) {
    assert.equal(fm.name, 'orchestrate', host);
    assert.ok(/^[a-z0-9-]{1,64}$/.test(fm.name), `${host}: name format`);
    assert.ok(fm.description && fm.description.length > 50, `${host}: description`);
    assert.ok(fm.description.length <= 1024, `${host}: description <= 1024 (Codex cap; below Claude's 1,536)`);
    assert.match(body, /workflow\.md/, `${host}: points at the shared body`);
    assert.ok(body.split('\n').length < 30, `${host}: the wrapper stays thin`);
  }
  assert.equal(claude.fm.description, codex.fm.description, 'one description for both hosts');
  assert.match(claude.body, /Monitor tool/);
  assert.match(codex.body, /periodically/);

  const wf = fs.readFileSync(path.join(ROOT, 'skills', 'orchestrate', 'workflow.md'), 'utf8');
  assert.match(wf, /ORCHESTRATOR\.md/, 'points to ORCHESTRATOR.md for the why');
  // the sequence, in order
  const steps = ['orch claim', 'orch pick', 'orch worktree create', 'templates/handoff.md', 'orch run', 'orch status', 'orch scope', 'own checks', 'orch review', 'orch gate record', 'another-round', 'orch record', 'orch release'];
  let at = -1;
  for (const s of steps) {
    const i = wf.indexOf(s, at + 1);
    assert.ok(i > at, `workflow.md: "${s}" missing or out of order`);
    at = i;
  }
  // every `orch <command>` named is a real command
  const named = [...wf.matchAll(/`orch ([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(named.length >= 12);
  for (const n of named) assert.ok([...COMMANDS, 'mcp'].includes(n), `workflow.md names a command orch does not have: ${n}`);
});
