// opencode adapter — rebuilt on design v4.
//
// What changed, and why (v3 §13, review r2-2 / r2-6 / r3-1):
//  - The real `opencode.exe` is spawned DIRECTLY. The `cmd.exe /d /s /c <shim>` form
//    is deleted: X1 `cmdwrap` measured that an interposed `cmd.exe` destroys libuv
//    containment (the wrapper dies, the whole subtree it started survives), and K3's
//    whole result depends on its absence. With the direct `.exe` the tree is
//    `node -> opencode.exe` and nothing else (K1).
//  - `CMD_UNSAFE_CHARS` / `assertCmdSafe` / `resolveShim` are deleted with it: there
//    is no shell in the chain, so there is nothing for a shell to reinterpret.
//  - The shared-log reader (`opencodeLogDir`, `logFiles`, `bindSession`,
//    `hasOwnedActivity`, `parseRunTag`, `initWatch`, `pollWatch`) is deleted. Directory
//    evidence now comes only from the run's OWN `stderr.log` (`direvidence.mjs`), so a
//    foreign opencode session can neither fake our heartbeat nor implicate our run.
//  - `--print-logs` is mandatory: it is what puts the session-creation line into this
//    run's stderr.log (K1), and stderr.log is the only usable heartbeat because stdout
//    is a single chunk at exit (K1).
import path from 'node:path';
import { resolveCliExe, npmPrefixes } from '../exe.mjs';

/** Where the npm package `opencode-ai` keeps the real executable, under a global prefix. */
export const OPENCODE_EXE_IN_PREFIX = ['node_modules', 'opencode-ai', 'bin', 'opencode.exe'];

/**
 * The real `.exe`, never the `.cmd` shim: ORCH_OPENCODE_EXE / `exe.opencode`, else
 * `opencode.exe` on PATH, else the npm global prefix of THIS machine and user.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveOpencodeExe(env = process.env) {
  return resolveCliExe('opencode', {
    env,
    fallbacks: (e) => npmPrefixes('opencode', e).map((p) => path.join(p, ...OPENCODE_EXE_IN_PREFIX)),
    hint: 'The opencode.cmd shim is deliberately not accepted: cmd.exe in the chain destroys process containment.',
  });
}

export default {
  name: 'opencode',
  lane: 'local',
  needsModel: true,
  /** The run's own stderr.log carries the session line and the progress lines (K1). */
  heartbeatStream: 'stderr',
  /** Only opencode's session-creation line can decide the directory question. */
  directoryEvidence: true,

  canonicalModel(model) {
    // `localai/qwen3.8-flash-next` and `qwen3.8-flash-next` are the same model.
    return String(model).includes('/') ? String(model).split('/').pop() : String(model);
  },

  preLaunch() {
    return {
      notes: ['opencode.exe spawned directly; no cmd.exe in the chain (X1 cmdwrap, K3)'],
      extra: {},
    };
  },

  build(ctx) {
    const exe = resolveOpencodeExe();
    const args = ['run', '--model', String(ctx.model), '--dir', String(ctx.dir), '--print-logs'];
    if (ctx.agent) args.push('--agent', String(ctx.agent));
    for (const f of ctx.flags || []) args.push(String(f));
    return {
      file: exe,
      args,
      cwd: ctx.dir,
      // opencode takes its project directory from the inherited PWD, not the spawn cwd
      // (spike Q1c, confirmed in K1): pass --dir AND force PWD.
      envSet: { PWD: ctx.dir },
      envDelete: [],
      notes: [`opencode exe: ${exe}`, 'PWD forced to --dir in the child env', '--print-logs is required for directory evidence'],
    };
  },

  /** opencode puts only the final assistant message on stdout (K1). */
  extractFinalMessage(stdout) {
    return String(stdout).trim();
  },

  // No adapter-level status rule. The directory question is answered by the §5
  // precedence table (rules 4 and 8), which ranks BELOW exit code and empty output -
  // the ordering v3 M7 required and the old `opencode-directory-unverified` rule got
  // wrong by sitting above them.
  statusRules: [],
};
