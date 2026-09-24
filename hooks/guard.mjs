#!/usr/bin/env node
// PreToolUse guard hook for Claude Code (and Codex, same JSON contract).
//
// Input (stdin): the hook JSON, e.g. {"hook_event_name":"PreToolUse","tool_name":"Bash",
//   "tool_input":{"command":"..."},"cwd":"..."}. Codex sends its shell tool as tool_name
//   "Bash" with tool_input.command.
// Output: nothing (no decision, the normal permission flow applies) or, to deny,
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
//    "permissionDecisionReason":"<one line naming the orch command to use>"}}
// Exit code is always 0; the decision travels in the JSON.
// Sources: code.claude.com/docs/en/hooks (PreToolUse input/output, exit codes) and the
// Codex hooks engine (codex-rs/hooks, rust-v0.154.0).
import { checkCommand, checkPath } from './rules.mjs';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function decide(input) {
  const tool = input && typeof input.tool_name === 'string' ? input.tool_name : '';
  const args = input && input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = (input && input.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (SHELL_TOOLS.has(tool)) return checkCommand(args.command, cwd);
  if (FILE_TOOLS.has(tool)) return checkPath(args.file_path || args.notebook_path);
  return { block: false };
}

export function denyJson(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: String(reason).replace(/\s+/g, ' ').trim(),
    },
  });
}

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw.replace(/^﻿/, '') || '{}');
  } catch {
    return; // unparseable input: no decision (as in the owner's guard)
  }
  const result = decide(input);
  if (result.block) process.stdout.write(denyJson(result.reason));
}

const invokedDirectly = process.argv[1] && /guard\.mjs$/i.test(process.argv[1]);
if (invokedDirectly) {
  main()
    .catch((e) => process.stderr.write(`guard: ${(e && e.message) || e}\n`))
    .finally(() => {
      process.exitCode = 0;
    });
}
