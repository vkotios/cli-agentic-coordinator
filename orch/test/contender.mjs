// One contender: a SEPARATE OS process that waits for an absolute-epoch barrier and
// then runs the orch CLI once. Contention is never tested with same-process
// `Promise.all` (design v3 R8 / v4 §9).
//
// Usage: node contender.mjs <barrierEpochMs> <label> <...orch args>
// Prints exactly one JSON line on stdout.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ORCH_BIN = path.resolve(fileURLToPath(new URL('../bin/orch.mjs', import.meta.url)));
const [barrierRaw, label, ...args] = process.argv.slice(2);
const barrier = Number(barrierRaw);

// Self-destruct backstop: a contender can never outlive the suite. `unref()` matters -
// a referenced timer would itself keep the process alive for the full 120 s after the
// work finished, which is exactly the hang it is meant to prevent.
setTimeout(() => process.exit(96), 120000).unref();

function spinToBarrier() {
  return new Promise((resolve) => {
    const tick = () => {
      const left = barrier - Date.now();
      if (left <= 0) return resolve();
      setTimeout(tick, left > 25 ? left - 20 : 1);
    };
    tick();
  });
}

await spinToBarrier();
const t0 = Date.now();
execFile(
  process.execPath,
  [ORCH_BIN, ...args],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  (err, stdout, stderr) => {
    const res = {
      label,
      code: err ? (err.code ?? 1) : 0,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
      ms: Date.now() - t0,
      startedAt: t0,
    };
    process.stdout.write(JSON.stringify(res) + '\n');
  },
);
