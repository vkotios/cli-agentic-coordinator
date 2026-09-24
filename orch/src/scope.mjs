// Handoff allowlist and the scope guard (slice 2, ORCHESTRATOR §6).
//
// changed paths = `git diff --name-only -z --no-renames <baseline>` (committed, staged
// and unstaged changes against the baseline; `--no-renames` so a rename shows BOTH its
// old and its new path) + `git ls-files --others --exclude-standard -z` (untracked,
// non-ignored). Every changed path must be on the allowlist. Paths are compared EXACTLY
// after normalisation: Unicode NFC, '/' separators, no leading './', and letter case
// folded only when the repository says the filesystem is case-insensitive
// (`core.ignorecase`, measured per repo, not assumed).
//
// A git failure is `unknown`, never `pass`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { git, splitZ } from './git.mjs';

export function normalizeRepoPath(p, ignoreCase) {
  let s = String(p).normalize('NFC').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  return ignoreCase ? s.toLowerCase() : s;
}

/** Strip one pair of surrounding quotes or backticks from an allowlist entry. */
function unquote(s) {
  const t = s.trim();
  const m = /^(["'`])(.*)\1$/.exec(t);
  return m ? m[2] : t;
}

/**
 * The `ALLOW:` block of a handoff. Format:
 *
 *   ALLOW:
 *   - src/a.js
 *   - "docs/with space.md"
 *
 * The block ends at a blank line or at the next `KEY:` header line. Text after
 * `ALLOW:` on the same line is one entry. Several blocks are concatenated.
 */
export function parseAllowBlock(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*ALLOW:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[1].trim()) out.push(unquote(m[1]));
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) break;
      if (/^\s*[A-Z][A-Z _-]*:\s*/.test(l) && !/^\s*[-*]\s/.test(l)) break;
      const entry = unquote(l.replace(/^\s*[-*]\s+/, ''));
      if (entry) out.push(entry);
      i = j;
    }
  }
  return out;
}

/** Is the repo case-insensitive? Read, not assumed. `null` = could not be read. */
export async function repoIgnoresCase(top) {
  const r = await git(['config', '--bool', 'core.ignorecase'], { cwd: top });
  if (r.code === 1 && !r.stdout.trim()) return false; // key not set: git's default is case-sensitive
  if (!r.ok) return null;
  return r.stdout.trim() === 'true';
}

export function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Evaluate the scope guard.
 * @param {{top:string, baseline:string, allow:string[], orchWritten?:Array<{path:string, sha256:string}>}} o
 * @returns {Promise<any>}
 */
export async function evaluateScope({ top, baseline, allow, orchWritten = [] }) {
  const out = {
    result: 'unknown',
    baseline,
    top,
    allow: allow || [],
    ignore_case: null,
    changed: [],
    untracked: [],
    offending: [],
    exempt: [],
    errors: [],
    checked_at: new Date().toISOString(),
  };
  if (!top || !baseline) {
    out.errors.push(!top ? 'the run directory is not inside a git work tree' : 'no baseline commit was recorded');
    return out;
  }
  const ic = await repoIgnoresCase(top);
  out.ignore_case = ic;
  if (ic === null) out.errors.push('git config core.ignorecase could not be read');
  const diff = await git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', baseline, '--'], { cwd: top });
  if (!diff.ok) out.errors.push(`git diff failed (exit ${diff.code}): ${diff.stderr.trim()}`);
  const others = await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: top });
  if (!others.ok) out.errors.push(`git ls-files failed (exit ${others.code}): ${others.stderr.trim()}`);
  if (out.errors.length) return out;

  out.changed = splitZ(diff.stdout);
  out.untracked = splitZ(others.stdout);
  const norm = (p) => normalizeRepoPath(p, !!ic);
  const allowSet = new Set((allow || []).map(norm));
  const exemptMap = new Map((orchWritten || []).map((w) => [norm(w.path), w.sha256]));
  const seen = new Set();
  for (const p of [...out.changed, ...out.untracked]) {
    const k = norm(p);
    if (seen.has(k + '\0' + p)) continue;
    seen.add(k + '\0' + p);
    if (allowSet.has(k)) continue;
    // A file orch itself wrote into the worktree (vibe's .vibe/config.toml) is exempt ONLY
    // while its content is byte-identical to what orch wrote.
    if (exemptMap.has(k) && exemptMap.get(k) && sha256File(path.join(top, p)) === exemptMap.get(k)) {
      out.exempt.push(p);
      continue;
    }
    out.offending.push(p);
  }
  out.result = out.offending.length ? 'fail' : 'pass';
  return out;
}
