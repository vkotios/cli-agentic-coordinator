// The ONE place that derives the lane pipe name and the lane directory.
//
// Design v4 §3 / v3 §3.1 (closes review r2-4 and H1): the pipe name and the lane
// directory must come from a single value, so they can never disagree. That value is
// a fixed per-user identifier - `sha256(homedir + '|' + username).slice(0,12)` - and
// it is NEVER taken from an inherited environment variable in production.
//
// `ORCH_LANE_ID` survives only as a test override, and `orch run` refuses it unless
// the adapter is the test-only fake worker (see `assertLaneOverrideAllowed`).
//
// `laneDir` lives at `<lane root>/<scope>`. The lane root defaults to `<kit>/.lane` (a
// fixed installation path that does NOT depend on `--state-root`, which is what r2-4
// required) and can be moved with ORCH_LANE_HOME or `laneRoot` in orch.config.json. The
// lane directory holds one advisory file; the authority is the held pipe handle, whose
// name never depends on any setting and is genuinely machine-global. Use the same lane
// root for every invocation so every command sees the same holder file.
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OrchError } from './errors.mjs';
import { setting } from './config.mjs';

export const DEFAULT_LANE_HOME = path.resolve(fileURLToPath(new URL('../.lane', import.meta.url)));

/** The lane root: ORCH_LANE_HOME > `laneRoot` in orch.config.json > `<kit>/.lane`. */
export function laneHome() {
  return path.resolve(setting('ORCH_LANE_HOME', 'laneRoot', DEFAULT_LANE_HOME, { isPath: true }));
}

/**
 * The fixed per-user identifier. Never read from the environment.
 *
 * CODE-REVIEW FIX (astra H1): the first version hashed `os.homedir()`, which on
 * Windows returns the INHERITED `USERPROFILE` variable - two shells of the same account
 * with different profile variables got two different pipes, i.e. two local lanes and
 * two MAIN workers. `os.userInfo()` is answered by libuv from the process TOKEN
 * (GetUserNameW / GetUserProfileDirectoryW), not from the environment; measured on this
 * machine: with USERPROFILE, HOMEDRIVE, HOMEPATH and USERNAME all overridden it still
 * returned the real account name and profile directory, while os.homedir() returned
 * the overridden value. If the token lookup fails there is NO fallback to the
 * environment: orch refuses rather than invent a lane.
 */
export function userLaneIdentifier() {
  let info;
  try {
    info = os.userInfo();
  } catch (e) {
    throw new OrchError(`cannot derive the lane identifier: os.userInfo() failed (${(e && e.message) || e})`, 'lane-id-unavailable');
  }
  if (!info || !info.username || !info.homedir) {
    throw new OrchError('cannot derive the lane identifier: the account has no username or profile directory', 'lane-id-unavailable');
  }
  return crypto.createHash('sha256').update(`${info.homedir}|${info.username}`).digest('hex').slice(0, 12);
}

function sanitizeId(v) {
  return String(v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'invalid';
}

/**
 * @param {string} lane 'local' | 'cloud'
 * @returns {{laneId:string, lane:string, scope:string, pipeName:string, laneDir:string,
 *            holderFile:string, monitorPipe:(runId:string)=>string, overridden:boolean}}
 */
export function laneScope(lane = 'local') {
  const override = process.env.ORCH_LANE_ID;
  const laneId = override ? sanitizeId(override) : userLaneIdentifier();
  const scope = `${laneId}-${lane}`;
  const laneDir = path.join(laneHome(), scope);
  return {
    laneId,
    lane,
    scope,
    overridden: !!override,
    pipeName: `\\\\.\\pipe\\orch-lane-${scope}`,
    laneDir,
    holderFile: path.join(laneDir, 'holder.json'),
    monitorPipe: (runId) => `\\\\.\\pipe\\orch-mon-${laneId}-${runId}`,
  };
}

/**
 * `ORCH_LANE_ID` is a test hatch. A real CLI must never be launched into a fake lane,
 * because that would put a real worker outside the machine-wide exclusion.
 */
export function assertLaneOverrideAllowed(adapter) {
  if (!process.env.ORCH_LANE_ID) return;
  if (adapter && adapter.testOnly === true) return;
  throw new OrchError(
    `ORCH_LANE_ID is set (${process.env.ORCH_LANE_ID}) but --cli ${adapter ? adapter.name : '?'} is a real CLI. ` +
      'The lane override exists only for the test-only fake worker: launching a real worker into an ' +
      'overridden lane would place it outside the machine-wide exclusion. Unset ORCH_LANE_ID.',
    'lane-override-refused',
  );
}
