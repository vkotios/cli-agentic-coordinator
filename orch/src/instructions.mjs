// Native entrypoint discovery and byte-preserving ownership of shared instruction regions.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';

export const START = '<!-- orch:bootstrap:v1:start -->';
export const END = '<!-- orch:bootstrap:v1:end -->';
export const rawSha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const BOOTSTRAP = [
  START,
  '## Using orch in this repository',
  'Enter the orchestrator role only when the user asks you to coordinate work with orch.',
  'An orch launch packet assigns the implementer or reviewer role; do not become an orchestrator in those roles.',
  'Before using orch, read `.orch/instructions/common.md`, then the selected role file:',
  '`orchestrator.md`, `implementer.md`, or `reviewer.md` in that directory (paths relative to the repository root).',
  'Keep existing owner/project instructions in force. Report conflicting instructions instead of silently overriding them.',
  'A worker worktree may lack the adopted payload; use its supplied launch packet. For orchestration, if the payload is absent, bootstrap with orch adopt first.',
  END,
].join('\n');

/** Refuse symlinks/reparse points at every existing component, not just the leaf. */
export function targetProblem(repo, rel) {
  const segments = rel.replace(/\\/g, '/').split('/');
  if (path.isAbsolute(rel) || segments.some((s) => !s || s === '..' || s === '.' || s.toLowerCase() === '.git') || /[:\x00-\x1f]/.test(rel)) return 'target must be a repository-relative path without traversal or Git metadata';
  let cur = repo;
  for (let i = 0; i < segments.length; i++) {
    cur = path.join(cur, segments[i]);
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) return 'symlink/reparse-point target or ancestor';
      if (i < segments.length - 1 && !st.isDirectory()) return 'target ancestor is not a directory';
      if (i === segments.length - 1 && !st.isFile()) return 'target is not a regular file';
    } catch (e) {
      if (e.code !== 'ENOENT') return `target cannot be inspected (${e.code})`;
    }
  }
  return null;
}

export function utf8Text(buf) {
  if (buf.includes(0)) throw new Error('binary or unsupported encoding (NUL byte)');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); }
  catch { throw new Error('unsupported encoding; expected UTF-8'); }
}

export function planBlock(repo, rel, entry, { update = false, harnesses = [], discovery = [], ownerSources = [] } = {}) {
  const problem = targetProblem(repo, rel);
  if (problem) return { path: rel, action: 'refused', detail: problem };
  const file = path.join(repo, rel);
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  let text;
  try { text = utf8Text(before || Buffer.alloc(0)); }
  catch (e) { return { path: rel, action: 'refused', detail: e.message }; }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  ownerSources = [...new Set([...(entry?.ownerSources || []), ...ownerSources])].sort();
  const additions = ownerSources.length ? `Read these existing owner instruction sources too: ${ownerSources.map((s) => '`' + s + '`').join(', ')} (repository-relative).\n` : '';
  const desired = Buffer.from(BOOTSTRAP.replace(END, additions + END).replace(/\n/g, eol));
  const record = {
    id: 'orch:bootstrap', schema: 1, sha256: rawSha(desired), source: 'bootstrap:v1',
    ownerSources,
    harnesses: [...new Set([...(entry?.harnesses || []), ...harnesses])].sort(),
    discovery: [...new Set([...(entry?.discovery || []), ...discovery])].sort(),
  };
  const markers = text.match(/<!--\s*orch:bootstrap:[^>]*-->/g) || [];
  if (!markers.length && !text.includes('orch:bootstrap:')) {
    if (entry) return { path: rel, action: 'conflict', detail: 'owned bootstrap disappeared; left untouched' };
    const separator = text && !text.endsWith('\n') ? eol + eol : text ? eol : '';
    return { path: rel, action: before === null ? 'create' : 'update', detail: 'append orch bootstrap; existing bytes preserved', before,
      content: Buffer.concat([before || Buffer.alloc(0), Buffer.from(separator), desired, Buffer.from(eol)]), blockRecord: record };
  }
  if (markers.length !== 2 || markers[0] !== START || markers[1] !== END || (entry && (entry.id !== record.id || entry.schema !== 1))) {
    return { path: rel, action: 'conflict', detail: 'duplicate, unmatched, unsupported or foreign orch bootstrap markers' };
  }
  const begin = before.indexOf(START);
  const end = before.indexOf(END, begin) + Buffer.byteLength(END);
  const owned = before.subarray(begin, end);
  // A completed write may outlive its private manifest. Reclaim only exact current
  // kit bytes without touching the file; foreign or edited regions still conflict.
  if (owned.equals(desired)) return { path: rel, action: 'unchanged', detail: 'bootstrap identical to the current kit; ownership recorded', before, blockRecord: record };
  if (!entry) return { path: rel, action: 'conflict', detail: 'foreign orch bootstrap markers; left untouched' };
  if (rawSha(owned) !== entry.sha256) return { path: rel, action: 'conflict', detail: 'owner edited the orch bootstrap; left untouched' };
  if (!update) return { path: rel, action: 'stale', detail: 'owned bootstrap is older; run with --update', before };
  return { path: rel, action: 'update', detail: 'replace only the unchanged owned bootstrap', before,
    content: Buffer.concat([before.subarray(0, begin), desired, before.subarray(end)]), blockRecord: record };
}

// Read only the two discovery settings. Unrecognised TOML forms yield partial readiness;
// this is not a replacement for the harness's full configuration resolver.
function codexSettings(file, explicit = false) {
  const out = { fallbacks: [], maxBytes: 32768, rootUnknown: false, warnings: [] };
  if (!fs.existsSync(file)) {
    if (explicit) { out.rootUnknown = true; out.warnings.push('supplied Codex configuration not found; native discovery is unresolved'); }
    return out;
  }
  let text;
  try { text = utf8Text(fs.readFileSync(file)).replace(/^\ufeff/, ''); }
  catch { out.rootUnknown = true; out.warnings.push('Codex configuration unreadable; native discovery is unresolved'); return out; }
  const root = text.split(/^\s*\[/m)[0];
  const rootMarkers = /^\s*project_root_markers\s*=\s*(.*)$/m.exec(root);
  if (rootMarkers && rootMarkers[1].replace(/\s+#.*$/, '').trim() !== '[".git"]') {
    out.rootUnknown = true;
    out.warnings.push('non-default project_root_markers require explicit native discovery; use --instruction-file codex=<path>');
  }
  for (const key of ['project_doc_fallback_filenames', 'project_doc_max_bytes']) {
    if (!new RegExp(`^\\s*${key}\\s*=`, 'm').test(text)) continue;
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm').exec(root);
    if (!match) { out.warnings.push(`scoped ${key} needs an explicit effective configuration`); continue; }
    if (key === 'project_doc_max_bytes') {
      const value = match[1].replace(/\s+#.*$/, '').trim();
      if (/^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))) out.maxBytes = Number(value);
      else out.warnings.push('cannot resolve project_doc_max_bytes; using the default byte limit for the preview');
    } else {
      try {
        const value = JSON.parse(match[1].replace(/\s+#.*$/, ''));
        if (!Array.isArray(value) || !value.every((s) => typeof s === 'string' && s && !/[\\/:]/.test(s) && s !== '.' && s !== '..')) throw new Error();
        out.fallbacks = value;
      } catch { out.warnings.push('cannot resolve project_doc_fallback_filenames; use --instruction-file codex=<path>'); }
    }
  }
  return out;
}

function firstFile(dir, names) {
  return names.find((name) => {
    const f = path.join(dir, name);
    // Discovery sees symlinks too: the planner must refuse them rather than create a shadow.
    try {
      const st = fs.lstatSync(f);
      return st.isSymbolicLink() || st.isFile();
    } catch { return false; }
  });
}

export function discoverEntrypoints(repo, given, harnesses, args = {}, priorBlocks = {}) {
  const config = args['codex-config'] || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  const settings = harnesses.includes('codex') ? codexSettings(config, !!args['codex-config']) : { fallbacks: [], maxBytes: 32768, rootUnknown: false, warnings: [] };
  const explicit = new Map();
  for (const value of args['instruction-file'] || []) {
    const match = /^(claude|codex|opencode|vibe)=(.+)$/.exec(value);
    if (!match || !harnesses.includes(match[1]) || explicit.has(match[1])) throw new Error('--instruction-file requires one selected harness=<repository-relative path>');
    if (targetProblem(repo, match[2])?.startsWith('target must')) throw new Error('invalid --instruction-file path');
    explicit.set(match[1], match[2].replace(/\\/g, '/'));
  }
  const routes = harnesses.map((harness) => {
    const names = harness === 'claude' ? ['CLAUDE.md', '.claude/CLAUDE.md'] : harness === 'codex' ? ['AGENTS.override.md', 'AGENTS.md', ...settings.fallbacks] : harness === 'opencode' ? ['AGENTS.md', 'CLAUDE.md'] : ['AGENTS.md'];
    let native = firstFile(repo, names) || names[harness === 'codex' ? 1 : 0];
    const parts = path.relative(repo, given).split(path.sep).filter(Boolean);
    if (harness === 'opencode' || harness === 'vibe') {
      for (let i = parts.length; i > 0; i--) {
        const dir = path.join(repo, ...parts.slice(0, i));
        const found = firstFile(dir, names);
        if (found) { native = path.relative(repo, path.join(dir, found)).replace(/\\/g, '/'); break; }
      }
    }
    const rel = explicit.get(harness) || native;
    const warnings = harness === 'codex' ? [...settings.warnings] : [];
    if (explicit.has(harness) && rel !== native) warnings.push('explicit bootstrap path; native discovery is not established');
    if (harness === 'codex' && !args['codex-config'] && fs.existsSync(path.join(repo, '.codex/config.toml'))) warnings.push('project Codex configuration may override discovery; supply --codex-config with effective settings');
    if (harness === 'opencode' && ['1', 'true'].includes(process.env.OPENCODE_DISABLE_PROJECT_CONFIG)) warnings.push('project configuration is disabled; native discovery must be confirmed');
    if (harness === 'opencode' && ['1', 'true'].includes(process.env.OPENCODE_DISABLE_CLAUDE_CODE) && native.endsWith('CLAUDE.md')) warnings.push('Claude fallback discovery is disabled; use --instruction-file opencode=AGENTS.md');
    if (harness === 'vibe') warnings.push('project instruction discovery requires the selected folder to be trusted by Vibe');
    const discovery = [rel];
    if (harness === 'codex') {
      for (let i = 1; i <= parts.length; i++) {
        const dir = path.join(repo, ...parts.slice(0, i));
        const found = firstFile(dir, names);
        if (found) discovery.push(path.relative(repo, path.join(dir, found)).replace(/\\/g, '/'));
      }
    }
    const unresolved = harness === 'codex' && !explicit.has(harness) && (settings.rootUnknown || settings.warnings.some((s) => /fallback_filenames/.test(s)) && !firstFile(repo, ['AGENTS.override.md', 'AGENTS.md']));
    return { harness, path: rel, discovery, ownerSources: [], warnings,
      refusal: unresolved ? 'unresolved Codex instruction discovery; use --instruction-file codex=<path>' : null,
      maxBytes: settings.maxBytes,
      instructions: 'prepared', hooks: harness === 'claude' || harness === 'codex' ? 'configured-unqualified' : 'not-installed',
      qualification: 'not-run' };
  });
  // Another selected harness can provision AGENTS.md and change OpenCode's fallback.
  // Keep the original owner source explicit instead of silently hiding its rules.
  for (const route of routes.filter((r) => r.harness === 'opencode' && r.path.endsWith('CLAUDE.md'))) {
    const agentRel = route.path.replace(/CLAUDE\.md$/, 'AGENTS.md');
    if (routes.some((r) => r.path === agentRel)) {
      route.path = agentRel;
      route.discovery.unshift(agentRel);
      route.ownerSources.push(route.discovery[1]);
      route.warnings.push(`read existing ${route.discovery[1]} as owner instructions; AGENTS.md from another selected harness takes precedence`);
    }
  }
  // A later invocation may select a different harness and provision AGENTS.md.
  // Preserve fallback rules already adopted for OpenCode, not only current routes.
  for (const [rel, entry] of Object.entries(priorBlocks)) {
    if (!entry?.harnesses?.includes('opencode') || !rel.endsWith('CLAUDE.md')) continue;
    const agentRel = rel.replace(/CLAUDE\.md$/, 'AGENTS.md');
    for (const route of routes.filter((r) => r.path === agentRel)) {
      if (!route.ownerSources.includes(rel)) route.ownerSources.push(rel);
      route.warnings.push(`preserve previously adopted OpenCode owner instructions in ${rel}`);
    }
  }
  return routes;
}
