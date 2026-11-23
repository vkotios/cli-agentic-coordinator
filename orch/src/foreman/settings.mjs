// Foreman policy: defaults, and the live, versioned copy kept in the store (DESIGN.md D2).
// A setting is read at the start of every tick, so a change applies without a restart.

export const DEFAULT_SETTINGS = {
  tickSeconds: 60,
  maxConcurrent: 1,
  paused: false,
  /** Used when an item names no route: {cli, model, flags?}. Null means the item is parked `needs-input`. */
  defaultRoute: null,
  /** Who the Foreman names itself as on claims, worktrees and runs. */
  actor: 'foreman',
  acceptanceTimeoutSeconds: 600,
  maxLogBytes: 262144,
};

export function readSettings(store) {
  const { value } = store.getSetting('foreman', {});
  return { ...DEFAULT_SETTINGS, ...(value || {}) };
}

export function saveSettings(store, patch, actor) {
  const current = store.getSetting('foreman', {}).value || {};
  for (const key of Object.keys(patch)) {
    if (!(key in DEFAULT_SETTINGS)) throw new Error(`unknown Foreman setting: ${key}`);
  }
  return store.setSetting('foreman', { ...current, ...patch }, actor);
}
