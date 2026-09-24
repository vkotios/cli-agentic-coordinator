// Test child for astra M5. Blocks an ASYNC read on a named-pipe server that accepts
// and never writes (a stand-in for a stalled filesystem), answers under a deadline
// exactly as `orch status` does, then arms the CLI's exit guard. The parent test
// asserts the answer is printed and the process exits promptly.
// SAFETY: the pipe server is this process's own; a 25 s self-destruct backstops all.
import net from 'node:net';
import { readJsonAsync, withDeadline, Deadline } from '../../src/util.mjs';
import { armExitGuard } from '../../bin/orch.mjs';

setTimeout(() => process.exit(96), 25000).unref();

const name = `\\\\.\\pipe\\orch-stall-${process.pid}`;
const srv = net.createServer((s) => {
  s.on('error', () => {});
});
srv.listen(name, async () => {
  const dl = new Deadline(500, 'status');
  // readFile on a pipe that never writes blocks its threadpool thread (measured). A
  // distinct sentinel, so a thrown error can NOT masquerade as a deadline expiry.
  const SENTINEL = { stalled: true };
  let threw = null;
  const got = await withDeadline(
    () => readJsonAsync(name, 'READ-FAILED').catch((e) => (threw = e)),
    dl.at('read cancel-result.json').remaining(),
    SENTINEL,
    dl, // exactly as inspect() does: the deadline learns that the step timed out
  );
  if (threw) process.stdout.write(`threw ${threw}\n`);
  process.stdout.write(got === SENTINEL && dl.expired() ? `${dl.text()}\n` : `read returned ${JSON.stringify(got)}\n`);
  armExitGuard(1500);
});
