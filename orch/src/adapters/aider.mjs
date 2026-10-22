// aider adapter. CLI facts: aider.chat/docs/config/options.html and scripting docs
// (unverified: no run recorded yet; re-check after upgrading and record quirks in
// docs/CLI_GUIDE.md).
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
import fs from 'node:fs';
import path from 'node:path';
import { OrchError } from '../errors.mjs';
import { resolveCliExe } from '../exe.mjs';
import { canonicalId, assertModelPermitted } from '../models.mjs';

export const ALLOWED_EFFORTS = ['minimal', 'low', 'medium', 'high'];

/** Flags orch sets itself or forbids; a `--flag` may not smuggle a second value in. */
const FORBIDDEN_FLAGS = /^(?:-m|--msg|--message|--message-file|-f|--model|--yes|--yes-always|--no-yes-always|--auto-commits|--no-auto-commits|--dirty-commits|--no-dirty-commits|--auto-lint|--no-auto-lint|--auto-test|--no-auto-test|--test|--lint|--reasoning-effort|--thinking-tokens|--edit-format|--architect|--auto-accept-architect|--no-auto-accept-architect|--weak-model|--editor-model|--apply|--commit|--dry-run|--no-dry-run|--upgrade|--install-main-branch)(?:=|$)/;

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
      ],
    };
  },

  /** One-shot mode: the captured stdout is the run's output. */
  extractFinalMessage(stdout) {
    return String(stdout).trim();
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
