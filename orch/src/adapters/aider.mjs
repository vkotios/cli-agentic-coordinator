// aider adapter. CLI facts: aider.chat/docs/config/options.html and scripting docs,
// confirmed by one real run on aider 0.86.2 (re-check after upgrading and record quirks
// in docs/CLI_GUIDE.md).
//
//  - Headless one-shot: `--message-file <file>` reads the prompt from the handoff
//    file, processes one reply, then exits (disables chat mode).
//  - `--yes-always` answers every confirmation, required for an unattended run.
//  - `--no-auto-commits` and `--no-dirty-commits`: orch owns git (dedicated
//    worktrees, its own record and review flow); aider must not commit.
//  - `--no-auto-lint` / `--no-auto-test`: verification belongs to orch's review
//    flow; a hidden lint/test shell command would run outside the handoff.
//  - `--model <m>` is REQUIRED: an unpinned launch would silently use aider's
//    config default. A roster model marked `requires_permission` needs
//    `--owner-approved-model` (shared rule via assertModelPermitted).
//  - Streaming stays ON: stdout is the heartbeat (like agy). `--no-pretty`
//    keeps ANSI escapes out of the captured output.
//  - Reviewer role is REFUSED: aider has no read-only confinement; under
//    --yes-always it applies edits, so `orch review` must use another CLI.
//  - Model used: one-shot output names no machine-readable model identity, so it
//    stays UNKNOWN - never the requested model.
//  - Worktree stays clean (the scope guard counts untracked files): the chat, input
//    and LLM history files are redirected into the run folder. The repo-map tags
//    cache (`.aider.tags.cache.v4/`) has no relocation flag and is always written
//    into the git root, so a run that has a scope guard (an allowlist, or a work
//    package) turns the map off (`--map-tokens 0`) and hands the allowed files to
//    aider with `--file`. A run with no scope guard keeps aider's default repo map.
//  - Reasoning models make aider print a THINKING block and an ANSWER block; the
//    final message is the ANSWER block only.
import fs from 'node:fs';
import path from 'node:path';
import { OrchError } from '../errors.mjs';
import { resolveCliExe } from '../exe.mjs';
import { canonicalId, assertModelPermitted } from '../models.mjs';
import { normalizeRepoPath } from '../scope.mjs';

export const ALLOWED_EFFORTS = ['minimal', 'low', 'medium', 'high'];

/** Long flags orch sets itself or forbids; a `--flag` may not smuggle a second value in. */
const OWNED_LONG_FLAGS = ['--msg', '--message', '--message-file', '--model', '--yes', '--yes-always', '--no-yes-always', '--auto-commits', '--no-auto-commits', '--dirty-commits', '--no-dirty-commits', '--auto-lint', '--no-auto-lint', '--auto-test', '--no-auto-test', '--test', '--lint', '--reasoning-effort', '--thinking-tokens', '--edit-format', '--architect', '--auto-accept-architect', '--no-auto-accept-architect', '--weak-model', '--editor-model', '--apply', '--commit', '--dry-run', '--no-dry-run', '--upgrade', '--install-main-branch', '--file', '--read', '--map-tokens', '--input-history-file', '--chat-history-file', '--llm-history-file', '--restore-chat-history', '--no-restore-chat-history',
  // orch passes the `--no-*` form of each of these; the positive form would undo it (`--suggest-shell-commands` runs commands under --yes-always).
  '--show-model-warnings', '--no-show-model-warnings', '--check-update', '--no-check-update', '--analytics', '--no-analytics', '--gitignore', '--no-gitignore', '--pretty', '--no-pretty', '--fancy-input', '--no-fancy-input', '--suggest-shell-commands', '--no-suggest-shell-commands', '--notifications', '--no-notifications', '--detect-urls', '--no-detect-urls', '--disable-playwright'];
/** Short owned flags (`-m`, `-f`); aider also takes the value glued on (`-mhello`). */
const OWNED_SHORT_FLAGS = 'mf';

/**
 * aider (argparse) accepts any unique prefix of a long flag (`--map-to 1024` is `--map-tokens`; verified on 0.86.2),
 * so an owned flag is refused under its full name, with `=value`, and under every prefix of it.
 */
function isOwnedFlag(token) {
  const t = String(token);
  if (t.startsWith('--')) {
    const name = t.split('=')[0];
    return OWNED_LONG_FLAGS.some((o) => o.startsWith(name));
  }
  return t.length > 1 && t[0] === '-' && OWNED_SHORT_FLAGS.includes(t[1]);
}

/**
 * The allowlist as `--file=<path>` arguments. Entries are exact repo-relative file paths, normalised the way the
 * scope guard compares them (NFC, `/`), resolved against the repo top (where the guard reads them) and handed to
 * aider relative to its working directory. A file that does not exist yet is a file to be created. `stat: false`
 * skips the filesystem checks (the launch-time rebuild must not be able to throw once run artifacts exist).
 */
function allowFileArgs(ctx, { stat }) {
  const base = ctx.allowBase || ctx.dir;
  return (ctx.allow || []).map((entry) => {
    const bad = () => new OrchError(`allowlist entry "${entry}" cannot be handed to aider as a file (exact repo-relative file paths only)`, 'bad-allow');
    const raw = String(entry).replace(/\\/g, '/');
    if (!raw || raw.startsWith('/') || raw.endsWith('/') || /^[A-Za-z]:/.test(raw) || /[\0\r\n*?<>:"|]/.test(raw)) throw bad();
    const p = normalizeRepoPath(raw, false);
    const segs = p.split('/');
    if (segs.some((s) => s === '' || s === '.' || s === '..') || /[. ]$/.test(segs[segs.length - 1])) throw bad();
    if (stat && base) {
      for (let i = 1; i <= segs.length; i++) {
        let st = null;
        try {
          st = fs.statSync(path.join(base, ...segs.slice(0, i)));
        } catch (e) {
          if (e.code === 'ENOENT') break; // nothing deeper exists either
          throw bad();
        }
        if (i < segs.length ? !st.isDirectory() : st.isDirectory()) throw bad(); // a file as a parent folder, or a directory as the entry
      }
    }
    return `--file=${path.relative(ctx.dir || base, path.join(base, p)).split(path.sep).join('/')}`;
  });
}

export function resolveAiderExe() {
  return resolveCliExe('aider');
}

const FAMILY_ALIASES = ['auto', 'default', 'sonnet', 'opus', 'haiku', 'gpt', 'gemini'];

function validateRequest(ctx, { stat = true } = {}) {
  if (typeof ctx.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{1,199}$/.test(ctx.model) || FAMILY_ALIASES.includes(canonicalId(ctx.model))) {
    throw new OrchError('An exact model selector is required for aider; automatic/family aliases and its config default are never trusted', 'bad-model');
  }
  if (ctx.role === 'review') {
    throw new OrchError('aider cannot be confined to a read-only reviewer: it applies edits under --yes-always; use a different reviewer CLI', 'bad-role');
  }
  if (ctx.effort != null && !ALLOWED_EFFORTS.includes(ctx.effort)) {
    throw new OrchError(`Invalid reasoning effort for aider (supported: ${ALLOWED_EFFORTS.join(', ')})`, 'bad-effort');
  }
  if (ctx.agent) throw new OrchError('Custom --agent is not supported by aider', 'forbidden-agent');
  allowFileArgs(ctx, { stat });
  for (const f of ctx.flags || []) {
    if (isOwnedFlag(f)) throw new OrchError(`--flag ${f} is forbidden or set by orch for aider`, 'forbidden-flag');
  }
}

export default {
  name: 'aider',
  lane: 'cloud',
  needsModel: true,
  heartbeatStream: 'stdout',
  directoryEvidence: false,

  canonicalModel(model) {
    return canonicalId(model);
  },

  validateRequest,

  preLaunch(ctx) {
    validateRequest(ctx);
    assertModelPermitted(ctx.model, !!ctx.ownerApprovedModel);
    return {
      notes: ['BYOK/API-key route: the account and credentials are yours, never touched by orch'],
      extra: {},
    };
  },

  build(ctx) {
    validateRequest(ctx, { stat: false }); // preLaunch already did the filesystem checks, before any run artifact existed
    const exe = resolveAiderExe();
    const prompt = fs.readFileSync(ctx.promptPath, 'utf8');
    if (prompt.includes('\0')) throw new OrchError('the handoff contains a NUL byte', 'bad-handoff');
    const runDir = ctx.runDir || path.dirname(ctx.promptPath);
    const stdinFile = path.join(runDir, 'stdin-empty.txt');
    fs.writeFileSync(stdinFile, '');
    // `allow` is null when the run has no scope check at all, an array (possibly empty) when it has one.
    const scoped = Array.isArray(ctx.allow);
    const allowFiles = allowFileArgs(ctx, { stat: false });
    const args = [
      '--model', String(ctx.model),
      '--message-file', String(ctx.promptPath),
      '--yes-always',
      '--no-auto-commits',
      '--no-dirty-commits',
      '--no-auto-lint',
      '--no-auto-test',
      '--no-show-model-warnings',
      '--no-check-update',
      '--no-analytics',
      '--no-gitignore',
      '--no-pretty',
      '--no-fancy-input',
      '--no-suggest-shell-commands',
      '--no-notifications',
      '--no-detect-urls',
      '--disable-playwright',
      '--no-restore-chat-history',
      '--chat-history-file', path.join(runDir, 'aider-chat-history.md'),
      '--input-history-file', path.join(runDir, 'aider-input-history'),
      '--llm-history-file', path.join(runDir, 'aider-llm-history.log'),
      ...(scoped ? ['--map-tokens', '0', ...allowFiles] : []),
      ...(ctx.effort ? ['--reasoning-effort', String(ctx.effort)] : []),
      ...(ctx.flags || []).map(String),
    ];
    return {
      file: exe,
      args,
      cwd: ctx.dir,
      envSet: { PWD: ctx.dir },
      envDelete: [],
      stdinFile,
      notes: [
        `aider exe: ${exe}`,
        'prompt delivered from the handoff file via --message-file; stdin empty',
        '--no-auto-commits / --no-dirty-commits: git stays with orch; the worker never commits',
        'streaming left on: stdout is the heartbeat',
        'chat/input/LLM history redirected into the run folder: the worktree stays clean',
        scoped
          ? `scope guard active: repo map off; ${allowFiles.length} allowlisted file(s) passed with --file (no tags cache in the worktree)`
          : 'no scope guard (no --wp and no allowlist): repo map on; aider writes .aider.tags.cache.v4/ into the worktree',
      ],
    };
  },

  /**
   * One-shot mode: the captured stdout, reduced to the ANSWER block of the last reply that had a THINKING block (the first
   * ANSWER marker after the last THINKING marker, so an answer that itself contains the marker text is kept whole).
   * Without both markers the whole output is returned.
   */
  extractFinalMessage(stdout) {
    const text = String(stdout);
    const thinking = [...text.matchAll(/^[ \t]*► \*\*THINKING\*\*[ \t]*$/gm)].pop();
    if (!thinking) return text.trim();
    const rest = text.slice(thinking.index + thinking[0].length);
    const answer = /^[ \t]*► \*\*ANSWER\*\*[ \t]*$/m.exec(rest);
    return (answer ? rest.slice(answer.index + answer[0].length) : text).trim();
  },

  postExit() {
    return {
      actual_model: null,
      actual_model_source: 'none',
      model_mismatch: undefined,
      warnings: ['aider one-shot output names no served model; the requested/configured model is not proof'],
    };
  },

  statusRules: [],
};
