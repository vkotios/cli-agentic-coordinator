#!/usr/bin/env node
// orch - launch/job layer for cli-agentic-coordinator: keeper, monitor, workflow commands.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrchError } from '../src/errors.mjs';
import { assertSupportedPlatform } from '../src/platform.mjs';
import { terminateSelf } from '../src/procs.mjs';
import { PUBLIC_ADAPTERS } from '../src/adapters/index.mjs';
import { parseArgs, runCommand, COMMANDS } from '../src/cli.mjs';

// The parser lives in src/cli.mjs (shared with the MCP front end); re-exported for the tests.
export { parseArgs };

const USAGE = `orch - launch and supervise worker CLI runs, and record the work-package workflow

  orch run --cli <${PUBLIC_ADAPTERS.join('|')}> --model <id> --dir <worktree> --handoff <file>
           [--agent <name>] [--flag <x>]... [--max-turns N] [--max-price X]
           [--lane local|cloud] [--allow-non-ascii] [--no-window] [--json]
  orch status <id> | --all [--json]
  orch list [--json]
  orch result <id> [--json]
  orch log <id> [--tail N] [--stream stderr|stdout|keeper|events]
  orch cancel <id> [--json]              target: the MAIN worker (tree kill)
  orch cancel --keeper <id> [--json]     operator escalation: the keeper only
  orch wait-lane [--lane local] [--timeout <s>] [--json]
  orch monitor <id> [--json]
  orch gc [--lane local] [--json]

Workflow (slice 2)
  orch claim <WP> --by <claude-code|codex|owner> [--session <s>] [--note <t>]
  orch release <WP> --by <x> [--force --reason <t>]      only the holder, or --force (recorded)
  orch claims [--json]                                    every claim with its age; never auto-reclaimed
  orch worktree create --repo <path> --wp <WP> --slice <id> --by <x> [--base <ref>]
  orch worktree list [--json]
  orch worktree remove <id> [--force] [--delete-branch]   only orch-recorded worktrees
  orch run ... --wp <WP> --slice <id> --by <x> [--allow <path>]... [--size XS|S|M]
           [--effort <e>] [--print-timeout <t>] [--owner-approved-model]
           (an ALLOW: block in the handoff is read too)
  orch scope <run-id> [--json]                             changed paths vs the allowlist
  orch review --run <impl-run> --ref <commit> --reviewer <cli> --model <id> --prompt <file> --by <x>
           [--blind <glob>]... [--review-root <dir>] [--no-wait] [--wait-timeout <s>]
  orch review --finish <review-id>
  orch gate record --wp <WP> --slice <id> --round <n> --findings <json|file>
           --verification pass|fail (--scope pass|fail | --scope-run <run-id>) [--override-reason <t>]
  orch gate status --wp <WP> --slice <id> [--json]
  orch record <run-id> --disposition <accepted|accepted-with-fixes|rejected|blocked|inconclusive-timeout|failed-launch>
           [--notes <t>] [--attempt N] [--turns N] [--checks <json>] [--ledger <file>] ...
  orch pick --workload implement|review --size XS|S|M [--for-run <id>] [--json]

Integration (slice 3)
  orch mcp [--state-root <dir>]                           stdio MCP server over the same commands
  orch adopt --repo <path> [--dry-run] [--update] [--json]  install the kit's hook/skill/agents/MCP entry;
           --update replaces only files adopt wrote and nobody changed since (.orch-adopt.json)

Common: --state-root <dir>   (default: orch/.state; or $ORCH_STATE_ROOT / "stateRoot" in orch.config.json)
Configuration: orch.config.json at the repository root (see orch.config.example.json and README.md).
Platform: Windows 10/11 only for now.
Local gateway benchmark: node orch/tools/bench-gateway.mjs --help

Exit codes
  run       0 admitted | 3 lane-busy | 2 usage-or-preflight | 4 undetermined
  cancel    0 confirmed gone or already terminal | 3 unconfirmed | 2 usage
  wait-lane 0 lane free | 3 timed out while held
  monitor   0 started | 3 already-running | 4 run is terminal

Notes
  - The prompt is delivered as a FILE DESCRIPTOR, not written to a pipe (K1).
  - A stall is advisory: orch never kills a run on its own initiative.
  - 'local' is a strictly serial lane across every orch invocation on this machine;
    admission is one atomic named-pipe bind, and a refusal is immediate, never a wait.
  - status / list / result / log / wait-lane write nothing and start nothing.
`;

async function main() {
  // Windows only for now: fail fast, before any command (help included) does anything.
  assertSupportedPlatform();
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  const args = parseArgs(cmd ? argv.slice(1) : argv);

  if (!cmd || args.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === 'mcp') {
    // A long-running stdio server; stdout belongs to the protocol from here on.
    const { serveMcp } = await import('../src/mcp.mjs');
    await serveMcp({ stateRoot: args['state-root'] });
    return;
  }
  if (!COMMANDS.includes(cmd)) {
    process.stderr.write(`unknown command: ${cmd}

${USAGE}`);
    process.exitCode = 2;
    return;
  }
  /** @type {any} */
  const r = await runCommand(cmd, args, console);
  if (r && typeof r.exitCode === 'number' && r.exitCode !== 0) process.exitCode = r.exitCode;
}

/**
 * EXIT GUARD (astra M5). Once a command has printed its answer, nothing may hold the
 * process open: a deadline can abandon an fs read, but the read keeps its threadpool
 * thread and the process then never exits (measured). If the process is still alive
 * shortly after the answer, it terminates itself. The timer is unref'd, so in every
 * normal case the process has already exited and the guard never fires.
 */
export function armExitGuard(ms = 2000) {
  const t = setTimeout(() => {
    try {
      process.stderr.write(`orch: an abandoned operation was still pending ${ms} ms after the answer; terminating
`);
    } catch {
      /* ignore */
    }
    terminateSelf();
  }, ms);
  t.unref();
  return t;
}

// Only run when invoked as a program; the test suite imports parseArgs from here.
const invokedDirectly = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .finally(() => armExitGuard())
    .catch((e) => {
    if (e instanceof OrchError) {
      process.stderr.write(`orch: ${e.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`orch: unexpected error: ${(e && e.stack) || e}\n`);
      process.exitCode = 1;
    }
  });
}
