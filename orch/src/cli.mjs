// The ONE argument parser and the ONE command dispatcher. `bin/orch.mjs` (the CLI) and
// `src/mcp.mjs` (the MCP front end) both go through these two functions, so an MCP tool
// call runs exactly the code path of the matching CLI command (slice 3, deliverable 4).
import {
  cmdRun,
  cmdStatus,
  cmdResult,
  cmdLog,
  cmdCancel,
  cmdList,
  cmdWaitLane,
  cmdMonitor,
  cmdGc,
} from './commands.mjs';
import { OrchError } from './errors.mjs';
import { loadConfig } from './config.mjs';
import { cmdClaim, cmdRelease, cmdClaims } from './claims.mjs';
import { cmdWorktree, cmdScope } from './worktrees.mjs';
import { cmdReview } from './review.mjs';
import { cmdGate } from './gate.mjs';
import { cmdRecord, cmdPick } from './ledger.mjs';
import { cmdAdopt } from './adopt.mjs';

export const BOOLEANS = new Set([
  'json', 'all', 'no-window', 'no-monitor', 'allow-non-ascii', 'keeper', 'verbose', 'help', 'version',
  // slice 2
  'force', 'no-wait', 'delete-branch', 'owner-approved-model', 'controller-intervened',
  // slice 3
  'dry-run', 'update',
]);
export const REPEATABLE = new Set(['flag', 'allow', 'blind']);

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const name = (eq >= 0 ? tok.slice(2, eq) : tok.slice(2)).trim();
    if (BOOLEANS.has(name)) {
      out[name] = eq >= 0 ? tok.slice(eq + 1) !== 'false' : true;
      continue;
    }
    const value = eq >= 0 ? tok.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new OrchError(`--${name} needs a value`, 'missing-value');
    if (REPEATABLE.has(name)) {
      if (!out[name]) out[name] = [];
      out[name].push(value);
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** Commands `runCommand` knows. `mcp` is not one of them: it is a server, started by bin/orch.mjs. */
export const COMMANDS = [
  'run', 'status', 'result', 'log', 'cancel', 'list', 'wait-lane', 'monitor', 'gc',
  'claim', 'release', 'claims', 'worktree', 'scope', 'review', 'gate', 'record', 'pick', 'adopt',
];

/**
 * Run one orch command. `io.log` receives everything the command prints.
 * @param {string} cmd
 * @param {any} args parsed by parseArgs
 * @param {any} io anything with `log(s)` (console for the CLI, a collector for MCP)
 * @returns {Promise<any>} the command's return value (`exitCode` when not 0)
 */
export async function runCommand(cmd, args, io) {
  switch (cmd) {
    case 'run':
      return cmdRun(args, io);
    case 'status':
      return cmdStatus(args, io);
    case 'result':
      return cmdResult(args, io);
    case 'log':
      return cmdLog(args, io);
    case 'cancel':
      return cmdCancel(args, io);
    case 'list':
      return cmdList(args, io);
    case 'wait-lane':
      return cmdWaitLane(args, io);
    case 'monitor':
      return cmdMonitor(args, io);
    case 'gc':
      return cmdGc(args, io);
    case 'claim':
      return cmdClaim(loadConfig(args['state-root']), args, io);
    case 'release':
      return cmdRelease(loadConfig(args['state-root']), args, io);
    case 'claims':
      return cmdClaims(loadConfig(args['state-root']), args, io);
    case 'worktree':
      return cmdWorktree(loadConfig(args['state-root']), args, io);
    case 'scope':
      return cmdScope(loadConfig(args['state-root']), args, io);
    case 'review':
      return cmdReview(args, io);
    case 'gate':
      return cmdGate(loadConfig(args['state-root']), args, io);
    case 'record':
      return cmdRecord(loadConfig(args['state-root']), args, io);
    case 'pick':
      return cmdPick(loadConfig(args['state-root']), args, io);
    case 'adopt':
      return cmdAdopt(args, io);
    default:
      throw new OrchError(`unknown command: ${cmd}`, 'unknown-command');
  }
}
