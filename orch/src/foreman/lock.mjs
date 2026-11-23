// One Foreman per state root (DESIGN.md section 3.8, point 5). The lock is a bound pipe or
// socket, the same primitive as the lane: the operating system releases it when the process
// ends, so a crash can never leave a stale lock, and a second Foreman learns who holds it.
import { tryListen, connectHello } from '../lanepipe.mjs';
import { foremanPipeName } from '../lanescope.mjs';
import { OrchError } from '../errors.mjs';

/**
 * @param {string} stateRoot
 * @param {object} [extra] merged into the hello a contender reads
 * @returns {Promise<{release: () => Promise<void>, name: string}>}
 */
export async function acquireForemanLock(stateRoot, extra = {}) {
  const name = foremanPipeName(stateRoot);
  const bind = await tryListen(name);
  if (!bind.ok) {
    const holder = await foremanHolder(stateRoot);
    const who = holder && holder.pid ? `pid ${holder.pid}, started ${holder.started_at}` : 'a Foreman that did not answer';
    throw new OrchError(`another Foreman already runs on this state root (${who})`, 'foreman-locked');
  }
  const started = new Date().toISOString();
  const hello = JSON.stringify({ foreman: true, pid: process.pid, state_root: stateRoot, started_at: started, ...extra }) + '\n';
  bind.server.on('connection', (socket) => {
    socket.on('error', () => {});
    socket.end(hello);
  });
  return {
    name,
    release: () => new Promise((resolve) => bind.server.close(() => resolve())),
  };
}

/** Who holds the Foreman lock, or null when nobody does. Connects only; never binds. */
export async function foremanHolder(stateRoot) {
  const probe = await connectHello(foremanPipeName(stateRoot), { deadlineMs: 1500 });
  if (probe.state === 'free') return null;
  try {
    return probe.hello ? JSON.parse(probe.hello) : { pid: null, started_at: null, unresponsive: true };
  } catch {
    return { pid: null, started_at: null, unresponsive: true };
  }
}
