// Visible read-only view: a Windows Terminal tab tailing the run's combined log.
//
// Spike Q5 (verified): `wt -w <name> new-tab` opens the tab, the viewer script
// self-reports its pid, and killing exactly that pid closes exactly that tab and
// leaves sibling tabs running. wt.exe itself exits at once and WindowsTerminal.exe
// outlives its last tab, so only the viewer's own pid is a usable handle.
//
// Failure to open a viewer never fails the run (spec 9).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killChecked, creationTimesOf } from './procs.mjs';
import { sleep } from './util.mjs';
import { setting } from './config.mjs';

const VIEW_SCRIPT = path.resolve(fileURLToPath(new URL('../viewer/tail-view.ps1', import.meta.url)));
const PS_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'];

// Overridable so the "viewer executable is missing" path can be tested (item 7).
const WT_EXE = () => setting('ORCH_WT_EXE', 'exe.wt', 'wt.exe');
const PS_EXE = () => setting('ORCH_PS_EXE', 'exe.powershell', 'powershell.exe');

/**
 * The exact spawn attempts for a viewer, as argv ARRAYS.
 *
 * Every path is its own array element and the child is spawned with shell:false, so a path
 * containing spaces cannot be split into two arguments and nothing needs quoting. Exported
 * so this can be asserted without opening a window.
 */
export function buildViewerAttempts({ logPath, pidFile, title }) {
  const viewerArgs = [...PS_ARGS, VIEW_SCRIPT, '-LogPath', logPath, '-PidFile', pidFile, '-Title', title];
  // TEST-ONLY: a headless stand-in viewer, so the viewer's lifecycle (open, record,
  // close by its own pid) can be tested without opening terminal tabs. Honoured only
  // together with ORCH_ALLOW_FAKE=1, exactly like the fake worker.
  if (process.env.ORCH_ALLOW_FAKE === '1' && process.env.ORCH_FAKE_VIEWER) {
    return [{ how: 'fake', file: process.execPath, args: [process.env.ORCH_FAKE_VIEWER, '-LogPath', logPath, '-PidFile', pidFile] }];
  }
  return [
    { how: 'wt', file: WT_EXE(), args: ['-w', 'orch', 'new-tab', '--title', title, PS_EXE(), ...viewerArgs] },
    { how: 'powershell-window', file: PS_EXE(), args: viewerArgs },
  ];
}

/**
 * Open a viewer. NEVER throws and never rejects: a missing `wt.exe` must not take the
 * supervisor down with it (item 7).
 *
 * On Windows a failure to spawn a missing executable is reported ASYNCHRONOUSLY as an
 * 'error' event, not as a throw from `spawn()`. Without a listener that event is fatal to
 * the process - which is exactly how the supervisor died. Every attempt therefore installs
 * an error listener and waits for either the pid file or that event.
 *
 * @returns {Promise<{pid:number|null, how:string, error:string|null, timeoutMs?:number}>}
 */
export async function openViewer({ logPath, pidFile, title, timeoutMs = 10000 }) {
  try {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); // our own file from a previous attempt
  } catch {
    /* ignore */
  }

  let attempts;
  try {
    attempts = buildViewerAttempts({ logPath, pidFile, title });
  } catch (e) {
    return { pid: null, how: 'none', error: `viewer argv could not be built: ${String((e && e.message) || e)}` };
  }

  const errors = [];
  for (const a of attempts) {
    let spawnError = null;
    let child = null;
    try {
      child = spawn(a.file, a.args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
      // MUST be attached before any await: an unhandled 'error' event kills the process.
      child.on('error', (err) => {
        const e = /** @type {any} */ (err);
        spawnError = `${e && e.code ? e.code : 'spawn-error'}: ${(e && e.message) || e}`;
      });
      child.unref();
    } catch (e) {
      errors.push(`${a.how}: ${String((e && e.message) || e)}`);
      continue;
    }

    const pid = await waitForPidFile(pidFile, timeoutMs, () => spawnError);
    if (pid) return { pid, how: a.how, error: null };
    errors.push(spawnError ? `${a.how}: ${spawnError}` : `${a.how}: no pid reported within ${timeoutMs}ms`);
  }
  return { pid: null, how: 'none', error: errors.join(' | ') };
}

async function waitForPidFile(pidFile, timeoutMs, failedEarly = () => null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(pidFile, 'utf8').trim();
      const pid = Number(raw);
      if (Number.isFinite(pid) && pid > 0) return pid;
    } catch {
      /* not written yet */
    }
    if (failedEarly()) return null; // the spawn already failed; do not sit out the timeout
    await sleep(200);
  }
  return null;
}

/** The viewer's own OS creation time, captured right after it reports its pid. */
export async function viewerIdentity(pid) {
  if (!pid) return null;
  const { times } = await creationTimesOf([pid], { deadlineMs: 5000 });
  return times[pid] ?? null;
}

/**
 * Close exactly the tab we opened, by the viewer's own recorded pid - and only after
 * verifying that pid is still the process we recorded.
 *
 * This is one of exactly two places in the kit that may reach a kill helper; the
 * other is `orch cancel` (gate G7).
 */
export async function closeViewer(pid, recordedCreatedAt) {
  if (!pid) return { closed: false, reason: 'no viewer pid recorded' };
  const r = await killChecked(pid, recordedCreatedAt, { deadlineMs: 3000 });
  return { closed: r.killed, verdict: r.verdict, reason: r.output };
}
