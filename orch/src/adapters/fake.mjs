// Test-only adapter. Runs `node <ORCH_FAKE_WORKER> <flags...>` so the automated
// tests can exercise the job core (stdin fidelity, lanes, cancel, stalls,
// reconciliation) without calling a model. Never used by a real dispatch.
import { OrchError } from '../errors.mjs';

export default {
  name: 'fake',
  lane: 'cloud',
  needsModel: false,
  testOnly: true,
  /** The fake worker writes its synthetic opencode session line to stderr. */
  heartbeatStream: 'stderr',
  /** Opt-in per test process, so the directory-evidence path can be exercised end to end. */
  directoryEvidence: process.env.ORCH_FAKE_DIR_EVIDENCE === '1',
  /** Opt-in (slice 2): a per-run heartbeat log, like agy's --log-file, so the monitor's
   *  heartbeat-file path and its keepalive filter can be exercised end to end. */
  heartbeatFile: process.env.ORCH_FAKE_HEARTBEAT === '1' ? (runDir) => `${runDir}\\fake-heartbeat.log` : undefined,
  isKeepalive: (line) => /KEEPALIVE/.test(String(line)),

  canonicalModel(model) {
    return String(model || 'none');
  },

  build(ctx) {
    const worker = process.env.ORCH_FAKE_WORKER;
    if (!worker) throw new OrchError('ORCH_FAKE_WORKER is not set (fake adapter is test-only)', 'fake-not-configured');
    return {
      // node.exe - a real .exe, spawned directly, no shell. ORCH_FAKE_EXE exists so the
      // keeper's spawn-failure paths (missing exe, sync throw, refused entrypoint) can
      // be exercised without inventing a fake CLI.
      file: process.env.ORCH_FAKE_EXE || process.execPath,
      args: [worker, ...ctx.flags],
      cwd: ctx.dir,
      envSet: { PWD: ctx.dir },
      envDelete: [],
      notes: ['fake worker (test-only adapter)'],
    };
  },

  // Same discipline as every real adapter (see "THE RULE ABOUT RULES" in statusrules.mjs):
  // exit code + stderr only, never stdout text. The tests rely on this rule NOT firing when
  // the worker merely prints the trigger phrase in ordinary output.
  statusRules: [
    {
      name: 'fake-quota',
      test: (o) => o.exitCode !== 0 && /FAKE-QUOTA/.test(o.stderr),
      status: 'blocked-quota',
      reason: 'fake-quota-signature',
    },
  ],
};
