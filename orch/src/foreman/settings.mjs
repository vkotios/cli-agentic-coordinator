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
  /** Ignored directories a worker may create without it being a scope violation (tests often make these). */
  toleratedIgnored: ['.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.cache/'],
  /** Ignored worker caches to remove before acceptance, at any depth. */
  purgeIgnored: ['__pycache__/', 'node_modules/.vite/', 'tsconfig.tsbuildinfo'],
  /** Gateway base URL (for example http://gateway.example:9000); null turns IGM event reading off. */
  igmUrl: null,
  /** The environment variable holding the gateway control key. The key itself is never stored. */
  igmKeyEnv: 'IGM_CONTROL_KEY',
  /** Overrides for the progress thresholds (see PROGRESS_DEFAULTS). */
  progress: {},
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
  if (Object.hasOwn(patch, 'purgeIgnored') &&
      (!Array.isArray(patch.purgeIgnored) || !patch.purgeIgnored.every((pattern) => typeof pattern === 'string'))) {
    throw new Error('purgeIgnored must be a JSON array of strings');
  }
  return store.setSetting('foreman', { ...current, ...patch }, actor);
}
