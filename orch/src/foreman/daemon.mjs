// The Foreman daemon: take the one-per-state-root lock, open the store, and tick. It is a plain
// Node process inside orch (D3); SQLite carries everything across restarts, so killing it at any
// moment loses nothing the next start cannot rebuild from the store and orch's own records.
import { loadConfig } from '../config.mjs';
import { acquireForemanLock } from './lock.mjs';
import { Store } from './store.mjs';
import { Dispatcher } from './dispatcher.mjs';
import { makeCall } from './engine.mjs';
import { readSettings } from './settings.mjs';
import { Progress } from './progress.mjs';
import { IgmClient } from './igm.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{stateRoot?: string|null, once?: boolean, tickSeconds?: number|null, log?: (s: string) => void,
 *          stopSignal?: {stopped: boolean}, progressFactory?: (store: any, stateRoot: string) => any}} o
 */
export async function runForeman({ stateRoot = null, once = false, tickSeconds = null, log = () => {}, stopSignal = { stopped: false }, progressFactory = null } = {}) {
  const cfg = loadConfig(stateRoot);
  const lock = await acquireForemanLock(cfg.stateRoot);
  const store = Store.open(cfg.stateRoot);
  try {
    const settings = readSettings(store);
    const call = makeCall(cfg.stateRoot);
    const progress = progressFactory
      ? progressFactory(store, cfg.stateRoot)
      : new Progress({ store, stateRoot: cfg.stateRoot, call, igm: settings.igmUrl ? new IgmClient({ baseUrl: settings.igmUrl, keyEnv: settings.igmKeyEnv }) : null, thresholds: settings.progress });
    const dispatcher = new Dispatcher({ store, stateRoot: cfg.stateRoot, call, progress });
    store.event('foreman-started', { actor: 'foreman', data: { pid: process.pid } });
    log(`foreman started (pid ${process.pid})`);
    for (;;) {
      if (stopSignal.stopped || store.kvGet('stop_requested') === '1') break;
      try {
        const r = await dispatcher.tick();
        log(`tick: ${Object.entries(r.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'empty queue'}`);
      } catch (error) {
        store.event('tick-error', { actor: 'foreman', data: { error: String(error && error.message ? error.message : error) } });
        log(`tick failed: ${error && error.message ? error.message : error}`);
      }
      if (once) break;
      const seconds = tickSeconds ?? readSettings(store).tickSeconds;
      const until = Date.now() + seconds * 1000;
      while (Date.now() < until && !stopSignal.stopped && store.kvGet('stop_requested') !== '1') await sleep(Math.min(250, until - Date.now()));
    }
    store.kvSet('stop_requested', '0');
    store.event('foreman-stopped', { actor: 'foreman', data: { pid: process.pid } });
    log('foreman stopped');
  } finally {
    store.close();
    await lock.release();
  }
}
