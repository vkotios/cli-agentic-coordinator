// `orch adopt --repo <path> [--dry-run] [--update]` (slice 3, deliverable 5).
//
// Installs the GENERIC kit pieces into an adopted repository (or a worktree of it):
//   .claude/settings.json            PreToolUse hook -> <kit>/hooks/guard.mjs   (JSON merge)
//   .claude/skills/orchestrate/      SKILL.md + workflow.md                      (copy)
//   .claude/agents/*.md              researcher, escalation reviewers            (copy)
//   .agents/skills/orchestrate/      SKILL.md + workflow.md for Codex            (copy)
//   .mcp.json                        mcpServers.orch -> `orch mcp`              (JSON merge)
//   .codex/hooks.json                PreToolUse hook for Codex -> guard.mjs     (JSON merge)
//   .orch-adopt.json                 the MANIFEST: what adopt itself wrote (path + sha256)
//
// RULES
//  - It never deletes. A JSON file it merges into must parse (otherwise `refused`).
//  - A copied file that differs from the kit is replaced ONLY with `--update`, and only when
//    adopt itself wrote it and nobody changed it since: its content hash equals the manifest
//    entry. Anything else (including a copy with no manifest entry) is a `conflict`.
//  - The whole plan is computed first; NOTHING is written if any item is a conflict or a
//    refusal. Every file it replaces is re-read right before the replacement and the write
//    is abandoned if it changed since the plan (CODE-REVIEW FIX c4).
//  - Content is compared with line endings normalised (git may check copies out as CRLF).
//  - Idempotent; `--dry-run` computes and prints the same plan and writes nothing.
// Global registration (claude mcp add / codex mcp add) is printed, never executed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OrchError } from './errors.mjs';
import { topLevel } from './git.mjs';

export const KIT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const fwd = (p) => p.replace(/\\/g, '/');

export const GUARD_PATH = path.join(KIT_ROOT, 'hooks', 'guard.mjs');
export const ORCH_BIN_PATH = path.join(KIT_ROOT, 'orch', 'bin', 'orch.mjs');
/** Claude Code tools the guard inspects (commands, plus .env paths for the file tools). */
export const CLAUDE_TOOLS = ['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export const CLAUDE_MATCHER = CLAUDE_TOOLS.join('|');
export const CODEX_TOOLS = ['Bash'];
export const CODEX_MATCHER = '^Bash$';
export const GUARD_COMMAND = `node "${fwd(GUARD_PATH)}"`;
export const MANIFEST = '.orch-adopt.json';

/** Copied files: kit source -> repo-relative destination. `{{KIT}}` is rendered. */
export const COPIES = [
  ['skills/orchestrate/SKILL.md', '.claude/skills/orchestrate/SKILL.md'],
  ['skills/orchestrate/workflow.md', '.claude/skills/orchestrate/workflow.md'],
  ['agents/researcher.md', '.claude/agents/researcher.md'],
  ['agents/escalation-reviewer.md', '.claude/agents/escalation-reviewer.md'],
  ['agents/escalation-reviewer-opus.md', '.claude/agents/escalation-reviewer-opus.md'],
  ['.agents/skills/orchestrate/SKILL.md', '.agents/skills/orchestrate/SKILL.md'],
  ['skills/orchestrate/workflow.md', '.agents/skills/orchestrate/workflow.md'],
];

export const lf = (s) => String(s).replace(/\r\n/g, '\n');
export const sha = (s) => crypto.createHash('sha256').update(lf(s)).digest('hex');

export function renderKitText(text) {
  return String(text).split('{{KIT}}').join(fwd(KIT_ROOT));
}

/** The exact global-registration commands, for the owner to run (adopt never runs them). */
export function registrationCommands() {
  const bin = fwd(ORCH_BIN_PATH);
  return [`claude mcp add --scope user orch -- node "${bin}" mcp`, `codex mcp add orch -- node "${bin}" mcp`];
}

/* --------------------------------------------------------- JSON merges -- */

function readJsonForMerge(file) {
  if (!fs.existsSync(file)) return { exists: false, obj: {}, bom: false, raw: null };
  const raw = fs.readFileSync(file, 'utf8');
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  if (!body.trim()) return { exists: true, obj: {}, bom, raw };
  let obj;
  try {
    obj = JSON.parse(body);
  } catch (e) {
    return { exists: true, error: `unparseable JSON (${e.message})`, raw };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { exists: true, error: 'the top level is not a JSON object', raw };
  return { exists: true, obj, bom, raw };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** A command hook handler that runs the kit guard. */
function runsGuard(handler) {
  if (!isObj(handler) || (handler.type !== undefined && handler.type !== 'command')) return false;
  const parts = [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])].filter((x) => typeof x === 'string');
  const want = fwd(GUARD_PATH).toLowerCase();
  return parts.some((p) => fwd(p).toLowerCase().includes(want));
}

/** Does a matcher fire for every one of `tools`? (empty / "*" = every tool; else an anchored regex) */
export function matcherCovers(matcher, tools) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (typeof matcher !== 'string') return false;
  let re;
  try {
    re = new RegExp(`^(?:${matcher})$`);
  } catch {
    return false;
  }
  return tools.every((t) => re.test(t));
}

/**
 * CODE-REVIEW FIX c3: the guard counts as installed only when ONE matcher group both covers
 * every required tool and runs the guard. A narrower guard entry is left alone and a full
 * one is added next to it (adopt never edits an entry it did not write).
 * @returns {{changed:boolean, error?:string, detail?:string}}
 */
function mergePreToolUse(obj, matcher, tools, handler) {
  if (obj.hooks === undefined) obj.hooks = {};
  if (!isObj(obj.hooks)) return { changed: false, error: '"hooks" is not an object' };
  if (obj.hooks.PreToolUse === undefined) obj.hooks.PreToolUse = [];
  if (!Array.isArray(obj.hooks.PreToolUse)) return { changed: false, error: '"hooks.PreToolUse" is not an array' };
  const guardGroups = obj.hooks.PreToolUse.filter((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(runsGuard));
  if (guardGroups.some((g) => matcherCovers(g.matcher, tools))) return { changed: false, detail: 'the guard hook is already registered for every required tool' };
  obj.hooks.PreToolUse.push({ matcher, hooks: [handler] });
  const partial = guardGroups.map((g) => JSON.stringify(g.matcher ?? '')).join(', ');
  return {
    changed: true,
    detail: guardGroups.length
      ? `an existing guard entry covers only ${partial}; adding a full entry PreToolUse "${matcher}" -> ${GUARD_COMMAND}`
      : `PreToolUse "${matcher}" -> ${GUARD_COMMAND}`,
  };
}

/**
 * @param {string} repo
 * @param {string} rel
 * @param {(obj:any)=>any} mutate
 * @param {{newFileExtra?:object}} [opts]
 */
function planJson(repo, rel, mutate, { newFileExtra = {} } = {}) {
  const file = path.join(repo, rel);
  const cur = readJsonForMerge(file);
  if (cur.error) return { path: rel, action: 'refused', detail: `${cur.error}; fix or remove it by hand - adopt never overwrites it` };
  const obj = cur.exists ? cur.obj : { ...newFileExtra };
  const r = mutate(obj);
  if (r.error) return { path: rel, action: 'refused', detail: `${r.error}; unexpected structure - adopt never guesses` };
  if (r.conflict) return { path: rel, action: 'conflict', detail: r.conflict };
  if (r.stale) return { path: rel, action: 'stale', detail: r.stale };
  if (!r.changed) return { path: rel, action: 'unchanged', detail: r.detail || 'already present' };
  const text = (cur.bom ? '﻿' : '') + JSON.stringify(obj, null, 2) + '\n';
  return { path: rel, action: cur.exists ? 'update' : 'create', detail: r.detail, content: text, before: cur.raw };
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/* ---------------------------------------------------------------- plan -- */

/**
 * @param {string} repoArg
 * @param {{update?:boolean}} [opts]
 */
export async function planAdopt(repoArg, { update = false } = {}) {
  if (!repoArg) throw new OrchError('adopt needs --repo <path>', 'missing-arg');
  const given = path.resolve(repoArg);
  if (!fs.existsSync(given) || !fs.statSync(given).isDirectory()) throw new OrchError(`--repo is not a directory: ${given}`, 'bad-repo');
  const top = await topLevel(given);
  if (!top) throw new OrchError(`--repo is not inside a git repository or worktree: ${given}`, 'bad-repo');
  const repo = path.resolve(top);
  /** @type {any[]} */
  const items = [];

  // the manifest (adopt's own record)
  const manFile = path.join(repo, MANIFEST);
  const manRaw = fs.existsSync(manFile) ? fs.readFileSync(manFile, 'utf8') : null;
  /** @type {{files:any, mcp_entry:any}} */
  let manifest = { files: {}, mcp_entry: null };
  let manifestBad = false;
  if (manRaw !== null) {
    try {
      const m = JSON.parse(manRaw.replace(/^﻿/, ''));
      if (!isObj(m) || !isObj(m.files)) throw new Error('no "files" object');
      manifest = { files: { ...m.files }, mcp_entry: m.mcp_entry ?? null };
    } catch (e) {
      manifestBad = true;
      items.push({ path: MANIFEST, action: 'refused', detail: `the adopt manifest is unreadable (${e.message}); fix or remove it by hand` });
    }
  }

  // 1. Claude Code hook (shell form, as the owner's working hooks use).
  items.push(planJson(repo, '.claude/settings.json', (obj) => mergePreToolUse(obj, CLAUDE_MATCHER, CLAUDE_TOOLS, { type: 'command', command: GUARD_COMMAND, timeout: 20 })));

  // 2. copied skill / agent files
  for (const [src, rel] of COPIES) {
    const from = path.join(KIT_ROOT, src);
    if (!fs.existsSync(from)) throw new OrchError(`kit file missing: ${from}`, 'kit-incomplete');
    const content = lf(renderKitText(fs.readFileSync(from, 'utf8')));
    const file = path.join(repo, rel);
    const record = { source: src, sha256: sha(content) };
    if (!fs.existsSync(file)) {
      items.push({ path: rel, action: 'create', detail: `copy of ${src}`, content, record });
      continue;
    }
    const cur = fs.readFileSync(file, 'utf8');
    // CODE-REVIEW FIX a5: compared with line endings normalised.
    if (lf(cur) === content) {
      items.push({ path: rel, action: 'unchanged', detail: `identical to ${src}`, record });
      continue;
    }
    const entry = manifest.files[rel];
    const ownedByManifest = isObj(entry) && entry.sha256 === sha(cur);
    if (ownedByManifest) {
      const why = 'written by adopt (manifest hash matches)';
      items.push(
        update
          ? { path: rel, action: 'update', detail: `${why}; replaced by the current ${src}`, content, record, before: cur }
          : { path: rel, action: 'stale', detail: `${why}, but the kit's ${src} changed; run with --update to replace it` },
      );
    } else {
      items.push({
        path: rel,
        action: 'conflict',
        detail: entry ? 'changed since adopt wrote it; left untouched' : `exists, differs from the kit's ${src} and was not written by adopt; left untouched`,
      });
    }
  }

  // 3. project MCP entry
  const server = { command: 'node', args: [fwd(ORCH_BIN_PATH), 'mcp'] };
  let mcpRecord = manifest.mcp_entry;
  const mcpItem = planJson(repo, '.mcp.json', (obj) => {
    if (obj.mcpServers === undefined) obj.mcpServers = {};
    if (!isObj(obj.mcpServers)) return { error: '"mcpServers" is not an object' };
    const cur = obj.mcpServers.orch;
    if (cur === undefined) {
      obj.mcpServers.orch = server;
      mcpRecord = server;
      return { changed: true, detail: `mcpServers.orch -> node ${server.args.join(' ')}` };
    }
    if (JSON.stringify(cur) === JSON.stringify(server)) {
      mcpRecord = server;
      return { changed: false, detail: 'mcpServers.orch already present' };
    }
    if (manifest.mcp_entry && JSON.stringify(cur) === JSON.stringify(manifest.mcp_entry)) {
      if (!update) return { stale: 'mcpServers.orch was written by adopt and the kit path changed; run with --update' };
      obj.mcpServers.orch = server;
      mcpRecord = server;
      return { changed: true, detail: 'mcpServers.orch (written by adopt) updated to the current kit' };
    }
    return { conflict: `mcpServers.orch exists with different settings (${JSON.stringify(cur)}); left untouched` };
  });
  items.push(mcpItem);

  // 4. Codex hook (project .codex/hooks.json; Codex asks the owner to trust it once).
  items.push(
    planJson(repo, '.codex/hooks.json', (obj) => mergePreToolUse(obj, CODEX_MATCHER, CODEX_TOOLS, { type: 'command', command: GUARD_COMMAND, timeout: 20 }), {
      newFileExtra: { description: 'cli-agentic-coordinator guard: worker CLIs only through orch; destructive commands denied' },
    }),
  );

  // 5. the manifest: every copy adopt wrote, or found identical to its own output
  if (!manifestBad) {
    const files = { ...manifest.files };
    for (const it of items) if (it.record && ['create', 'update', 'unchanged'].includes(it.action)) files[it.path] = it.record;
    const next = JSON.stringify({ tool: 'orch adopt', kit: fwd(KIT_ROOT), files: sortKeys(files), mcp_entry: mcpRecord }, null, 2) + '\n';
    if (manRaw === null) items.push({ path: MANIFEST, action: 'create', detail: 'what adopt wrote (path + sha256), used by --update', content: next });
    else if (lf(manRaw) === next) items.push({ path: MANIFEST, action: 'unchanged', detail: 'manifest current' });
    else items.push({ path: MANIFEST, action: 'update', detail: 'manifest refreshed', content: next, before: manRaw });
  }
  return { repo, given, items };
}

/* ------------------------------------------------------------- command -- */

/**
 * @param {any} args
 * @param {any} io
 * @param {{beforeWrite?:(plan:any)=>void}} [opts] test seam: runs after planning, before writing
 */
export async function cmdAdopt(args, io, opts = {}) {
  const dryRun = !!args['dry-run'];
  const plan = await planAdopt(args.repo, { update: !!args.update });
  /** @type {any[]} */
  let blocked = plan.items.filter((i) => i.action === 'refused' || i.action === 'conflict');
  const toWrite = plan.items.filter((i) => i.action === 'create' || i.action === 'update');
  const written = [];
  /** @type {string[]|null} */
  let aborted = null;
  if (!dryRun && !blocked.length && toWrite.length) {
    if (opts.beforeWrite) opts.beforeWrite(plan);
    // CODE-REVIEW FIX c4: everything planned from a snapshot is checked against the disk
    // again before the first write, and each replaced file once more right before its rename.
    const changed = (it) => {
      const f = path.join(plan.repo, it.path);
      const exists = fs.existsSync(f);
      if (it.action === 'create') return exists;
      return !exists || fs.readFileSync(f, 'utf8') !== it.before;
    };
    const moved = toWrite.filter(changed);
    if (moved.length) aborted = moved.map((i) => i.path);
    for (const it of aborted ? [] : toWrite) {
      const file = path.join(plan.repo, it.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (it.action === 'create') {
        fs.writeFileSync(file, it.content, { flag: 'wx' }); // never replaces a file that appeared meanwhile
      } else {
        const tmp = `${file}.orch-adopt-${process.pid}.tmp`;
        fs.writeFileSync(tmp, it.content, { flag: 'wx' });
        if (changed(it)) {
          fs.unlinkSync(tmp); // adopt's own temp file; the target stays as the owner has it
          aborted = [it.path];
          break;
        }
        fs.renameSync(tmp, file);
      }
      written.push(it.path);
    }
  }
  if (aborted) blocked = blocked.concat(aborted.map((p) => ({ path: p, action: 'changed-since-plan' })));
  const out = {
    repo: plan.repo,
    dry_run: dryRun,
    update: !!args.update,
    wrote: written.length ? `${written.length} file(s)` : dryRun || blocked.length ? 'nothing' : '0 file(s)',
    written,
    items: plan.items.map(({ content, before, record, ...rest }) => rest),
    blocked: blocked.map((b) => b.path),
    aborted_changed_since_plan: aborted,
    register_globally: registrationCommands(),
  };
  if (args.json) io.log(JSON.stringify(out, null, 2));
  else {
    io.log(`adopt ${plan.repo}${dryRun ? '  (dry run - nothing written)' : ''}${args.update ? '  (--update)' : ''}`);
    for (const it of plan.items) io.log(`  ${it.action.padEnd(9)} ${it.path}  - ${it.detail}`);
    if (aborted) io.log(`stopped: ${aborted.join(', ')} changed on disk after the plan was made; not overwritten. Wrote ${written.length} file(s) before that. Run adopt again.`);
    else if (blocked.length) io.log(`nothing written: ${blocked.length} item(s) refused or in conflict (${out.blocked.join(', ')})`);
    else if (!dryRun) io.log(`wrote ${written.length} file(s)`);
    if (plan.items.some((i) => i.action === 'stale')) io.log('some files adopt wrote are older than the kit: run `orch adopt --repo <path> --update` to refresh them');
    io.log('Global registration is NOT done by adopt. For the owner to run:');
    for (const c of out.register_globally) io.log(`  ${c}`);
  }
  return { ...out, exitCode: blocked.length ? 3 : 0 };
}
