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
//  - Legacy copies compare normalised line endings; shared instruction blocks use raw bytes.
//  - Idempotent; `--dry-run` computes and prints the same plan and writes nothing.
// Global registration (claude mcp add / codex mcp add) is printed, never executed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OrchError } from './errors.mjs';
import { topLevel } from './git.mjs';
import { discoverEntrypoints, planBlock, targetProblem, utf8Text } from './instructions.mjs';

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

const PAYLOAD_COPIES = [
  ['templates/instructions/common.md', '.orch/instructions/common.md'],
  ['templates/instructions/orchestrator.md', '.orch/instructions/orchestrator.md'],
  ['templates/instructions/implementer.md', '.orch/instructions/implementer.md'],
  ['templates/instructions/reviewer.md', '.orch/instructions/reviewer.md'],
  ['ORCHESTRATOR.md', '.orch/instructions/protocol.md'],
  ['skills/orchestrate/workflow.md', '.orch/instructions/workflow.md'],
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
  let raw;
  try { raw = utf8Text(fs.readFileSync(file)); }
  catch (e) { return { exists: true, error: e.message, raw: null }; }
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
function runsGuard(handler, roots = [KIT_ROOT]) {
  if (!isObj(handler) || (handler.type !== undefined && handler.type !== 'command')) return false;
  const command = fwd(String(handler.command || '')).toLowerCase();
  return roots.some((root) => {
    const want = `${fwd(root).replace(/\/$/, '')}/hooks/guard.mjs`.toLowerCase();
    if (Array.isArray(handler.args)) return /^(node|node\.exe)$/.test(command) && handler.args.length === 1 && fwd(String(handler.args[0])).toLowerCase() === want;
    // Exact invocation only. A suffix/substring in echo, a wrapper, or another command
    // is not authority to replace an owner's handler.
    return command === `node "${want}"` || (!/\s/.test(want) && command === `node ${want}`);
  });
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
 * @returns {{changed:boolean, error?:string, detail?:string, stale?:string}}
 */
function mergePreToolUse(obj, matcher, tools, handler, { roots = [KIT_ROOT], update = false } = {}) {
  if (obj.hooks === undefined) obj.hooks = {};
  if (!isObj(obj.hooks)) return { changed: false, error: '"hooks" is not an object' };
  if (obj.hooks.PreToolUse === undefined) obj.hooks.PreToolUse = [];
  if (!Array.isArray(obj.hooks.PreToolUse)) return { changed: false, error: '"hooks.PreToolUse" is not an array' };
  const known = (h) => runsGuard(h, roots);
  const guardGroups = obj.hooks.PreToolUse.filter((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(known));
  const moved = guardGroups.some((g) => g.hooks.some((h) => known(h) && !runsGuard(h)));
  if (moved && !update) return { changed: false, stale: 'known orch guard uses an older kit path; run with --update' };
  let changed = false;
  let fullGuardSeen = false;
  const emptied = new Set();
  for (const g of guardGroups) {
    const covers = matcherCovers(g.matcher, tools);
    g.hooks = g.hooks.filter((h) => {
      if (!known(h)) return true;
      if (covers && fullGuardSeen && update) { changed = true; return false; }
      if (covers) fullGuardSeen = true;
      if (!runsGuard(h)) {
        h.command = handler.command;
        delete h.args;
        changed = true;
      }
      return true;
    });
    if (!g.hooks.length) emptied.add(g);
  }
  obj.hooks.PreToolUse = obj.hooks.PreToolUse.filter((g) => !emptied.has(g));
  if (fullGuardSeen) return { changed, detail: changed ? 'known orch guard refreshed; adjacent handlers preserved' : 'the guard hook is already registered for every required tool' };
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
  const problem = targetProblem(repo, rel);
  if (problem) return { path: rel, action: 'refused', detail: problem };
  const file = path.join(repo, rel);
  const cur = readJsonForMerge(file);
  if (cur.error) return { path: rel, action: 'refused', detail: `${cur.error}; fix or remove it by hand - adopt never overwrites it` };
  const obj = cur.exists ? cur.obj : { ...newFileExtra };
  const r = mutate(obj);
  if (r.error) return { path: rel, action: 'refused', detail: `${r.error}; unexpected structure - adopt never guesses` };
  if (r.conflict) return { path: rel, action: 'conflict', detail: r.conflict };
  if (r.stale) return { path: rel, action: 'stale', detail: r.stale };
  if (!r.changed) return { path: rel, action: 'unchanged', detail: r.detail || 'already present', before: cur.raw };
  const text = (cur.bom ? '﻿' : '') + JSON.stringify(obj, null, 2) + '\n';
  return { path: rel, action: cur.exists ? 'update' : 'create', detail: r.detail, content: text, before: cur.raw };
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/* ---------------------------------------------------------------- plan -- */

/**
 * @param {string} repoArg
 * @param {any} [opts]
 */
export async function planAdopt(repoArg, opts = {}) {
  const update = !!opts.update;
  const harnesses = [...new Set(opts.harness ? Array.isArray(opts.harness) ? opts.harness : [opts.harness] : ['claude', 'codex'])];
  if (!harnesses.length || harnesses.some((h) => !['claude', 'codex', 'opencode', 'vibe'].includes(h))) throw new OrchError('--harness must be claude, codex, opencode or vibe', 'bad-harness');
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
  const manifestProblem = targetProblem(repo, MANIFEST);
  const manRaw = !manifestProblem && fs.existsSync(manFile) ? fs.readFileSync(manFile, 'utf8') : null;
  /** @type {any} */
  let manifest = { files: {}, blocks: {}, mcp_entry: null };
  let manifestBad = false;
  if (manRaw !== null) {
    try {
      const m = JSON.parse(utf8Text(fs.readFileSync(manFile)).replace(/^﻿/, ''));
      if (!isObj(m) || !isObj(m.files)) throw new Error('no "files" object');
      if (m.blocks !== undefined && !isObj(m.blocks)) throw new Error('invalid "blocks" object');
      if (m.schema !== undefined && m.schema !== 1 && m.schema !== 2) throw new Error('unsupported manifest schema');
      for (const [rel, entry] of Object.entries(m.blocks || {})) {
        const b = /** @type {any} */ (entry);
        if (!isObj(b) || b.id !== 'orch:bootstrap' || b.schema !== 1 || !/^[a-f0-9]{64}$/.test(b.sha256) ||
          ['harnesses', 'discovery', 'ownerSources'].some((key) => b[key] !== undefined && (!Array.isArray(b[key]) || b[key].some((v) => typeof v !== 'string')))) {
          throw new Error(`invalid managed block record for ${rel}`);
        }
      }
      manifest = { ...m, files: { ...m.files }, blocks: { ...(m.blocks || {}) }, mcp_entry: m.mcp_entry ?? null };
    } catch (e) {
      manifestBad = true;
      items.push({ path: MANIFEST, action: 'refused', detail: `the adopt manifest is unreadable (${e.message}); fix or remove it by hand` });
    }
  }
  if (manifestProblem) {
    manifestBad = true;
    items.push({ path: MANIFEST, action: 'refused', detail: manifestProblem });
  }

  const readiness = discoverEntrypoints(repo, given, harnesses, opts, manifest.blocks);
  const discoverySignature = JSON.stringify(readiness);
  const reserved = new Set([MANIFEST, '.claude/settings.json', '.codex/hooks.json', '.mcp.json',
    ...COPIES.map(([, rel]) => rel), ...PAYLOAD_COPIES.map(([, rel]) => rel)].map((rel) => rel.toLowerCase()));
  for (const route of readiness) {
    if (reserved.has(route.path.toLowerCase())) throw new OrchError('instruction target collides with a reserved managed file', 'bad-instruction-file');
  }
  for (const rel of [...new Set(readiness.map((r) => r.path))]) {
    const routes = readiness.filter((r) => r.path === rel);
    const refusal = routes.find((r) => r.refusal);
    items.push(refusal ? { path: rel, action: 'refused', detail: refusal.refusal } : planBlock(repo, rel, manifest.blocks[rel], { update, harnesses: routes.map((r) => r.harness), discovery: routes.map((r) => `${r.harness}:${rel}`), ownerSources: [...new Set(routes.flatMap((r) => r.ownerSources))] }));
  }
  const roots = [KIT_ROOT, ...(typeof manifest.kit === 'string' ? [manifest.kit] : []), ...(Array.isArray(manifest.previous_kits) ? manifest.previous_kits.filter((s) => typeof s === 'string') : [])];

  // 1. Claude Code hook (shell form, as the owner's working hooks use).
  if (harnesses.includes('claude')) items.push(planJson(repo, '.claude/settings.json', (obj) => mergePreToolUse(obj, CLAUDE_MATCHER, CLAUDE_TOOLS, { type: 'command', command: GUARD_COMMAND, timeout: 20 }, { roots, update })));

  // 2. copied skill / agent files
  const selectedCopies = COPIES.filter(([, rel]) => rel.startsWith('.claude/') ? harnesses.includes('claude') : harnesses.includes('codex'));
  for (const [src, rel] of [...PAYLOAD_COPIES, ...selectedCopies]) {
    const from = path.join(KIT_ROOT, src);
    if (!fs.existsSync(from)) throw new OrchError(`kit file missing: ${from}`, 'kit-incomplete');
    const content = lf(renderKitText(fs.readFileSync(from, 'utf8')));
    const file = path.join(repo, rel);
    const problem = targetProblem(repo, rel);
    if (problem) { items.push({ path: rel, action: 'refused', detail: problem }); continue; }
    const record = { source: src, sha256: sha(content) };
    if (!fs.existsSync(file)) {
      items.push({ path: rel, action: 'create', detail: `copy of ${src}`, content, record });
      continue;
    }
    let cur;
    try { cur = utf8Text(fs.readFileSync(file)); }
    catch (e) { items.push({ path: rel, action: 'refused', detail: e.message }); continue; }
    // CODE-REVIEW FIX a5: compared with line endings normalised.
    if (lf(cur) === content) {
      items.push({ path: rel, action: 'unchanged', detail: `identical to ${src}`, record, before: cur });
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
  const mcpItem = harnesses.includes('claude') ? planJson(repo, '.mcp.json', (obj) => {
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
    return { conflict: 'mcpServers.orch exists with different settings; left untouched' };
  }) : null;
  if (harnesses.includes('claude')) items.push(mcpItem);

  // 4. Codex hook (project .codex/hooks.json; Codex asks the owner to trust it once).
  if (harnesses.includes('codex')) items.push(
    planJson(repo, '.codex/hooks.json', (obj) => mergePreToolUse(obj, CODEX_MATCHER, CODEX_TOOLS, { type: 'command', command: GUARD_COMMAND, timeout: 20 }, { roots, update }), {
      newFileExtra: { description: 'cli-agentic-coordinator guard: worker CLIs only through orch; destructive commands denied' },
    }),
  );

  // 5. the manifest: every copy adopt wrote, or found identical to its own output
  const manifestContent = (successful) => {
    const files = { ...manifest.files }, blocks = { ...manifest.blocks };
    for (const it of successful) {
      if (it.record) files[it.path] = it.record;
      if (it.blockRecord) blocks[it.path] = it.blockRecord;
    }
    const mcpDone = successful.some((it) => it.path === '.mcp.json');
    return JSON.stringify({ ...manifest, tool: 'orch adopt', schema: 2, kit: fwd(KIT_ROOT),
      previous_kits: [...new Set(roots.map(fwd).filter((r) => r !== fwd(KIT_ROOT)))].sort(),
      files: sortKeys(files), blocks: sortKeys(blocks), mcp_entry: mcpDone ? mcpRecord : manifest.mcp_entry }, null, 2) + '\n';
  };
  if (!manifestBad) {
    const next = manifestContent(items.filter((i) => ['create', 'update', 'unchanged'].includes(i.action)));
    if (manRaw === null) items.push({ path: MANIFEST, action: 'create', detail: 'what adopt wrote (path + sha256), used by --update', content: next });
    else if (lf(manRaw) === next) items.push({ path: MANIFEST, action: 'unchanged', detail: 'manifest current', before: manRaw });
    else items.push({ path: MANIFEST, action: 'update', detail: 'manifest refreshed', content: next, before: manRaw });
  }
  for (const route of readiness) {
    const entry = items.find((i) => i.path === route.path);
    const readyActions = ['create', 'update', 'unchanged'];
    if (!readyActions.includes(entry.action)) route.warnings.push(`bootstrap ${entry.action}`);
    if (items.some((i) => ['stale', 'conflict', 'refused'].includes(i.action))) route.warnings.push('adoption contains stale, conflicting or refused items');
    if (route.harness === 'codex') {
      const bytes = route.discovery.reduce((n, rel) => {
        const it = items.find((i) => i.path === rel);
        if (it?.content !== undefined) return n + Buffer.byteLength(it.content);
        try { return n + fs.statSync(path.join(repo, rel)).size; } catch { return n; }
      }, 0);
      if (bytes > route.maxBytes) route.warnings.push(`instruction bytes ${bytes} exceed the Codex byte limit ${route.maxBytes}; the bootstrap may be truncated`);
    }
    if (route.warnings.length) route.instructions = 'partial';
  }
  return { repo, given, harnesses, readiness, items, manifestContent, discoverySignature, priorBlocks: manifest.blocks };
}

/* ------------------------------------------------------------- command -- */

/**
 * @param {any} args
 * @param {any} io
 * @param {{beforeWrite?:(plan:any)=>void, beforeItemWrite?:(item:any, plan:any)=>void}} [opts] concurrency/failure test seams
 */
export async function cmdAdopt(args, io, opts = {}) {
  const dryRun = !!args['dry-run'];
  const plan = await planAdopt(args.repo, args);
  /** @type {any[]} */
  let blocked = plan.items.filter((i) => i.action === 'refused' || i.action === 'conflict');
  const toWrite = plan.items.filter((i) => i.action === 'create' || i.action === 'update');
  const written = [];
  const writeErrors = [];
  /** @type {string[]|null} */
  let aborted = null;
  if (!dryRun && !blocked.length && toWrite.length) {
    if (opts.beforeWrite) opts.beforeWrite(plan);
    // CODE-REVIEW FIX c4: everything planned from a snapshot is checked against the disk
    // again before the first write, and each replaced file once more right before its rename.
    const changed = (it) => {
      if (targetProblem(plan.repo, it.path)) return true;
      const f = path.join(plan.repo, it.path);
      const exists = fs.existsSync(f);
      if (it.action === 'create') return exists;
      return !exists || !fs.readFileSync(f).equals(Buffer.from(it.before));
    };
    const moved = plan.items.filter((i) => i.action === 'create' || i.before !== undefined).filter(changed);
    if (JSON.stringify(discoverEntrypoints(plan.repo, plan.given, plan.harnesses, args, plan.priorBlocks)) !== plan.discoverySignature) moved.push({ path: 'instruction-discovery' });
    if (moved.length) aborted = moved.map((i) => i.path);
    const successful = plan.items.filter((i) => i.action === 'unchanged' && i.path !== MANIFEST);
    const writeItem = (it) => {
      const file = path.join(plan.repo, it.path);
      if (changed(it)) { aborted = [it.path]; return false; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.orch-adopt-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, it.content, { flag: 'wx' });
        if (changed(it)) {
          aborted = [it.path];
          return false;
        }
        // Publish a complete create exclusively: link fails if a target appeared.
        // rename is atomic for replacement but would overwrite a concurrent create.
        if (it.action === 'create') fs.linkSync(tmp, file);
        else fs.renameSync(tmp, file);
      } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
      written.push(it.path);
      return true;
    };
    for (const it of aborted ? [] : toWrite.filter((i) => i.path !== MANIFEST)) {
      try {
        opts.beforeItemWrite?.(it, plan);
        if (!writeItem(it)) break;
        successful.push(it);
      } catch (e) { writeErrors.push({ path: it.path, detail: e.message }); break; }
    }
    // On a contained late failure, persist ONLY completed ownership. Never use the
    // projected manifest for files that were not written. Concurrent manifest edits win.
    if (written.length || (!aborted && !writeErrors.length)) {
      const man = plan.items.find((i) => i.path === MANIFEST);
      const content = plan.manifestContent(successful);
      if (man && changed(man)) {
        aborted = [...new Set([...(aborted || []), MANIFEST])];
      } else if (man && man.action !== 'refused' && (man.action !== 'unchanged' || Buffer.from(man.before).toString('utf8') !== content)) {
        try {
          const it = { ...man, action: man.action === 'create' ? 'create' : 'update', content,
            before: man.before };
          writeItem(it);
        } catch (e) { writeErrors.push({ path: MANIFEST, detail: e.message }); }
      }
    }
  }
  if (aborted) blocked = blocked.concat(aborted.map((p) => ({ path: p, action: 'changed-since-plan' })));
  blocked = blocked.concat(writeErrors.map((e) => ({ path: e.path, action: 'write-error' })));
  const out = {
    repo: plan.repo,
    dry_run: dryRun,
    update: !!args.update,
    harnesses: plan.harnesses,
    readiness: plan.readiness.map((r) => ({ ...r, instructions: blocked.length ? 'partial' : r.instructions,
      hooks: r.hooks === 'not-installed' ? r.hooks : blocked.length ? 'not-confirmed'
        : plan.items.find((i) => i.path === (r.harness === 'claude' ? '.claude/settings.json' : '.codex/hooks.json'))?.action === 'stale'
          ? 'stale-unqualified' : dryRun ? 'planned-unqualified' : r.hooks })),
    wrote: written.length ? `${written.length} file(s)` : dryRun || blocked.length ? 'nothing' : '0 file(s)',
    written,
    items: plan.items.map(({ content, before, record, blockRecord, ...rest }) => rest),
    blocked: blocked.map((b) => b.path),
    aborted_changed_since_plan: aborted,
    write_errors: writeErrors,
    register_globally: registrationCommands().filter((c) => c.startsWith('claude ') ? plan.harnesses.includes('claude') : plan.harnesses.includes('codex')),
  };
  if (args.json) io.log(JSON.stringify(out, null, 2));
  else {
    io.log(`adopt ${plan.repo}${dryRun ? '  (dry run - nothing written)' : ''}${args.update ? '  (--update)' : ''}`);
    for (const it of plan.items) io.log(`  ${it.action.padEnd(9)} ${it.path}  - ${it.detail}`);
    if (aborted) io.log(`stopped: ${aborted.join(', ')} changed on disk after the plan was made; not overwritten. Wrote ${written.length} file(s) before that. Run adopt again.`);
    else if (blocked.length) io.log(`${written.length ? `stopped after ${written.length} file(s)` : 'nothing written'}: ${blocked.length} item(s) blocked (${out.blocked.join(', ')}). ${writeErrors.map((e) => e.detail).join('; ')}`);
    else if (!dryRun) io.log(`wrote ${written.length} file(s)`);
    if (plan.items.some((i) => i.action === 'stale')) io.log('some files adopt wrote are older than the kit: run `orch adopt --repo <path> --update` to refresh them');
    for (const r of out.readiness) io.log(`${r.harness}: instructions ${r.instructions}; hooks ${r.hooks}; live qualification ${r.qualification}${r.warnings.length ? `; ${r.warnings.join('; ')}` : ''}`);
    io.log('Global registration is NOT done by adopt. For the owner to run:');
    for (const c of out.register_globally) io.log(`  ${c}`);
  }
  return { ...out, exitCode: blocked.length ? 3 : 0 };
}
