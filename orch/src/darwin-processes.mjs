import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { creationPoint } from './process-time.mjs';
export const DARWIN_HELPER = fileURLToPath(new URL('../native/darwin-processes', import.meta.url));

/** Reject partial or malformed native evidence as unknown, never as an empty table. */
export function parseDarwinSnapshot(raw) {
  try {
    const result = JSON.parse(raw);
    if (creationPoint(result.now)?.kind !== 'darwin' || creationPoint(result.now).scope !== result.clockScope || !Array.isArray(result.rows)) return null;
    const seen = new Set();
    for (const row of result.rows) {
      if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || seen.has(row.pid) ||
          !Number.isSafeInteger(row.ppid) || row.ppid < 0 || !Number.isSafeInteger(row.pgrp) || row.pgrp < 0 ||
          !Number.isSafeInteger(row.session) || row.session < -1 || row.name !== '' || !['R', 'T', 'Z'].includes(row.state) ||
          creationPoint(row.createdAt)?.scope !== result.clockScope) return null;
      seen.add(row.pid);
    }
    Object.defineProperty(result.rows, 'clockScope', { value: result.clockScope });
    return result.rows;
  } catch { return null; }
}

export async function readDarwinProcessTable(pids, deadlineMs) {
  // One full snapshot for multiple PIDs preserves a single bounded query.
  const args = pids?.length === 1 ? [String(pids[0])] : [];
  return new Promise(resolve => {
    execFile(DARWIN_HELPER, args, { encoding: 'utf8', timeout: Math.max(1, Math.round(deadlineMs)), maxBuffer: 48 * 1024 * 1024 }, (error, stdout) => {
      const table = error ? null : parseDarwinSnapshot(stdout);
      if (table && pids) {
        const filtered = table.filter(row => pids.includes(row.pid));
        Object.defineProperty(filtered, 'clockScope', { value: table.clockScope });
        resolve(filtered);
      } else resolve(table);
    });
  });
}
