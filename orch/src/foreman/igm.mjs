// A small client for the inference gateway (IGM): its status for dashboards and its admission
// event log (D12). The Foreman reads the log with a cursor on each tick, so IGM never needs to
// call out and a restart simply catches up. The control key comes from the environment variable
// named in the settings; it is sent as a bearer token and never stored, logged or returned.

const ACTIONS_THAT_BREAK_A_TURN = new Set(['aborted_by_operator', 'dropped_by_operator']);

export class IgmClient {
  /**
   * @param {{baseUrl: string, keyEnv?: string, fetchImpl?: typeof fetch, timeoutMs?: number, env?: any}} o
   */
  constructor({ baseUrl, keyEnv = 'IGM_CONTROL_KEY', fetchImpl = fetch, timeoutMs = 5000, env = process.env }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.keyEnv = keyEnv;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.env = env;
    /** @type {Map<string, any[]>} */
    this.pending = new Map();
    this.lastPoll = 0;
  }

  async get(path) {
    const key = this.env[this.keyEnv];
    if (!key) throw new Error(`the gateway control key is not set in ${this.keyEnv}`);
    const response = await this.fetch(this.baseUrl + path, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`gateway answered ${response.status} for ${path}`);
    return response.json();
  }

  /** The parts of /api/status a dashboard needs: slots, admission queue and counters. */
  async status() {
    const s = await this.get('/api/status');
    return { phase: s.phase, loaded_model: s.loaded_model, chat_slots: s.chat_slots ?? null, admission: s.admission ?? null, active_requests: s.active_requests };
  }

  /**
   * Read new admission events (at most once per `minGapMs`), keep the cursor in the store, and index
   * those for `orch/<run-id>` clients by run id. A changed boot id means the gateway restarted.
   */
  async poll(store, minGapMs = 1000) {
    if (Date.now() - this.lastPoll < minGapMs) return;
    this.lastPoll = Date.now();
    let cursor = Number(store.kvGet('igm_cursor') || 0);
    let boot = store.kvGet('igm_boot');
    for (let page = 0; page < 5; page++) {
      const queriedFrom = cursor;
      const result = await this.get(`/api/admission/events?after=${cursor}&limit=200`);
      if (boot && result.boot_id !== boot) {
        // The gateway restarted: its sequence numbers begin again. Read the new log from the start.
        boot = result.boot_id;
        store.kvSet('igm_boot', boot);
        store.kvSet('igm_cursor', 0);
        cursor = 0;
        if (queriedFrom !== 0) continue;
      }
      if (!boot) {
        boot = result.boot_id;
        store.kvSet('igm_boot', boot);
      }
      for (const event of result.events) {
        const m = /^orch\/(.+)$/.exec(event.client || '');
        if (!m) continue; // not orch's: logged by the gateway only
        if (!this.pending.has(m[1])) this.pending.set(m[1], []);
        this.pending.get(m[1]).push(event);
      }
      cursor = result.next;
      store.kvSet('igm_cursor', cursor);
      if (result.events.length < 200) break;
    }
  }

  /**
   * Events for one run since the last call. Every one is recorded on the item; the return value is the
   * first one that broke an agent turn (an operator abort or drop), which asks for an immediate check.
   */
  async eventsFor(runId, store, actor, itemId) {
    try {
      await this.poll(store);
    } catch (error) {
      if (!this.warned) store.event('igm-unavailable', { actor, data: { error: String(error.message || error) } });
      this.warned = true;
      return null;
    }
    this.warned = false;
    const events = this.pending.get(runId) || [];
    this.pending.delete(runId);
    let breaker = null;
    for (const event of events) {
      store.event('igm-event', { item: itemId, run: runId, actor, data: { action: event.action, reason: event.reason ?? null, by: event.actor ?? null, seq: event.seq } });
      if (!breaker && ACTIONS_THAT_BREAK_A_TURN.has(event.action)) breaker = event;
    }
    return breaker;
  }
}
