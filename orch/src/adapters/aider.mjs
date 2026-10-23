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
//    into the git root, so a run that carries an allowlist turns the map off
//    (`--map-tokens 0`) and hands the allowed files to aider with `--file`. A run
//    without an allowlist has no scope check and keeps aider's default repo map.
//  - Reasoning models make aider print a THINKING block and an ANSWER block; the
//    final message is the ANSWER block only.
import fs from 'node:fs';
import path from 'node:path';
import { OrchError } from '../errors.mjs';
import { resolveCliExe } from '../exe.mjs';
import { canonicalId, assertModelPermitted } from '../models.mjs';

export const ALLOWED_EFFORTS = ['minimal', 'low', 'medium', 'high'];

/** Flags orch sets itself or forbids; a `--flag` may not smuggle a second value in. */
const FORBIDDEN_FLAGS = /^(?:-m|--msg|--message|--message-file|-f|--model|--yes|--yes-always|--no-yes-always|--auto-commits|--no-auto-commits|--dirty-commits|--no-dirty-commits|--auto-lint|--no-auto-lint|--auto-test|--no-auto-test|--test|--lint|--reasoning-effort|--thinking-tokens|--edit-format|--architect|--auto-accept-architect|--no-auto-accept-architect|--weak-model|--editor-model|--apply|--commit|--dry-run|--no-dry-run|--upgrade|--install-main-branch|--file|--read|--map-tokens|--input-history-file|--chat-history-file|--llm-history-file|--restore-chat-history|--no-restore-chat-history)(?:=|$)/;

/** One allowlist entry, handed to aider as `--file=<path>`: an exact repo-relative path only. */
function allowedFileArg(entry) {
  const p = String(entry).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.endsWith('/') || path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split('/').includes('..') || /[\0\r\n*?]/.test(p)) {
    throw new OrchError(`allowlist entry "${entry}" cannot be handed to aider as a file (exact repo-relative file paths only)`, 'bad-allow');
  }
  return `--file=${p}`;
}

export function resolveAiderExe() {
  return resolveCliExe('aider');
}

const FAMILY_ALIASES = ['auto', 'default', 'sonnet', 'opus', 'haiku', 'gpt', 'gemini'];

function validateRequest(ctx) {
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
  for (const entry of ctx.allow || []) allowedFileArg(entry);
  for (const f of ctx.flags || []) {
    if (FORBIDDEN_FLAGS.test(String(f))) throw new OrchError(`--flag ${f} is forbidden or set by orch for aider`, 'forbidden-flag');
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
    validateRequest(ctx);
    const exe = resolveAiderExe();
    const prompt = fs.readFileSync(ctx.promptPath, 'utf8');
    if (prompt.includes('\0')) throw new OrchError('the handoff contains a NUL byte', 'bad-handoff');
    const runDir = ctx.runDir || path.dirname(ctx.promptPath);
    const stdinFile = path.join(runDir, 'stdin-empty.txt');
    fs.writeFileSync(stdinFile, '');
    const allowFiles = (ctx.allow || []).map(allowedFileArg);
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
      ...(allowFiles.length ? ['--map-tokens', '0', ...allowFiles] : []),
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
        allowFiles.length
          ? `repo map off; ${allowFiles.length} allowlisted file(s) passed with --file (no tags cache in the worktree)`
          : 'no allowlist: repo map on; aider writes .aider.tags.cache.v4/ into the worktree (no scope check applies)',
      ],
    };
  },

  /** One-shot mode: the captured stdout, reduced to the ANSWER block when a reasoning model printed a THINKING block. */
  extractFinalMessage(stdout) {
    const text = String(stdout);
    const marks = [...text.matchAll(/^\s*► \*\*ANSWER\*\*\s*$/gm)];
    const last = marks[marks.length - 1];
    return (last ? text.slice(last.index + last[0].length) : text).trim();
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
