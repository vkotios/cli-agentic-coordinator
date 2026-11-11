// Read-only process-query transport fixture for retention tests. Never launches a worker.
export const DARWIN_FIXTURE_SCOPE = 'darwin:00000000-0000-4000-8000-000000000001';
export function darwinFixtureSnapshot(mode, pid = 424242, match = '100', mismatch = '200') {
  const birth = mode === 'missing-birth' ? null : mode === 'invalid-birth' ? 'broken' :
    `${DARWIN_FIXTURE_SCOPE}:${mode === 'padded-birth' ? '0' + match : mode === 'mismatch' ? mismatch : match}`;
  return JSON.stringify({ clockScope: DARWIN_FIXTURE_SCOPE, now: `${DARWIN_FIXTURE_SCOPE}:2000000`,
    rows: mode === 'gone' ? [] : [{ pid: mode === 'invalid-pid' ? 'broken' : pid,
      ppid: 1, pgrp: 1, session: 1, name: '', state: 'R', createdAt: birth }] });
}
