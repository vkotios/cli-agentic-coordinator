// Shared test scaffolding. Every test gets its own state root, its own worktree and
// its own LANE (via `ORCH_LANE_ID`), all created by the test and removed by it.
//
// SAFETY RULES THIS FILE ENFORCES
//  - Nothing is ever killed by image name. `killOwnedChecked` verifies pid + OS
//    creation time immediately before the kill and refuses otherwise (r3-5).
//  - Only pids this suite spawned and recorded are ever touched.
//  - Every fake process carries its own self-destruct timer (see fake-worker.mjs).
//  - Nothing outside `<kit>/.state-test` and `<kit>/.lane/<test lane id>` is written.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readProcessTable, verifyIdentity, killChecked } from '../src/procs.mjs';
import { laneHome } from '../src/lanescope.mjs';

export const KIT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const ORCH_BIN = path.join(KIT, 'bin', 'orch.mjs');
export const FAKE_WORKER = path.join(KIT, 'test', 'fake-worker.mjs');
export const CONTENDER = path.join(KIT, 'test', 'contender.mjs');
export const TEST_ROOT = path.join(KIT, '.state-test');
export const TEST_ROSTER = path.join(KIT, 'test', 'fixtures', 'roster.test.json');

/**
 * Repetition count for the process-level stress tests (lane contention, keeper death,
 * monitor kill, cancel, wait-lane, claim race, ledger concurrency). ONE switch:
 *   ORCH_TEST_REPS unset  -> 1 (the fast default suite, `npm test`), unless the suite was
 *                            started as `npm run test:stress`, which means "stress";
 *   ORCH_TEST_REPS=stress -> each test's full count (`stressCount`);
 *   ORCH_TEST_REPS=<n>    -> n for every such test.
 * A per-test variable (e.g. ORCH_G2_REPS), when set, still wins for that test.
 * @param {number} stressCount the full repetition count of the test
 * @param {string} [perTestVar]
 */
export function testReps(stressCount, perTestVar) {
  if (perTestVar && process.env[perTestVar]) return Number(process.env[perTestVar]);
  const sw = process.env.ORCH_TEST_REPS || (process.env.npm_lifecycle_event === 'test:stress' ? 'stress' : '');
  if (sw === 'stress') return stressCount;
  const n = Number(sw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

// The suite never reads the developer's own orch.config.json or roster: every test (and
// every orch child process, which inherits this environment) sees an empty config file
// and the fixture roster. Environment overrides (ORCH_STATE_ROOT, ORCH_LANE_HOME,
// ORCH_REVIEW_ROOT, ...) still apply, so the suite can run against other roots.
process.env.ORCH_CONFIG = path.join(KIT, 'test', 'fixtures', 'orch.config.empty.json');
process.env.ORCH_ROSTER = TEST_ROSTER;

/** The checksum token the hostile handoff carries; must survive the fd trip. */
export const CANARY_TOKEN = 'ZQ7-4KX-9PM-2WV';

/**
 * An 80+ line handoff full of the hazards the spike found: quotes, backslashes,
 * %VAR%, $var, backticks, shell metacharacters, JSON, tabs, trailing spaces and
 * (optionally) non-ASCII. Built in code so no editor can quietly normalise it.
 */
export function hostileHandoff({ nonAscii = true } = {}) {
  const lines = [
    'SPIKE HANDOFF - hostile fixture for orch slice 1',
    'CANARY-01 quotes: "double" \'single\' `backtick` and a \\"escaped\\" one',
    'CANARY-02 backslashes: C:\\work\\sandbox\\wt-1\\file.txt and \\\\server\\share',
    'CANARY-03 percent vars: %USERPROFILE% %PATH% %CD%',
    'CANARY-04 dollar vars: $HOME $env:PATH ${BRACED}',
    'CANARY-05 shell metacharacters: ^ & | > < ( ) ; @ !',
    'CANARY-06 redirection lookalikes: 2>&1 1>nul <input.txt',
    nonAscii
      ? 'CANARY-07 non-ASCII: placeholder, replaced below'
      : 'CANARY-07 ascii-only variant of the non-ASCII line',
    'CANARY-08 json: {"key":"value with \\"escaped\\" quotes","n":[1,2,3]}',
    'CANARY-09 tab:\tafter-a-literal-tab',
    'CANARY-10 long token: ' + 'A'.repeat(60),
    'CANARY-11 trailing spaces:   ',
    `CANARY-12 checksum token: ${CANARY_TOKEN}`,
    '',
    '| column a | column b |',
    '|---|---|',
    '| value 1 | value 2 |',
    '',
  ];
  if (nonAscii) {
    lines[7] = 'CANARY-07 non-ASCII: \u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac, \u00f1, \u00fc, \u00df, \u65e5\u672c\u8a9e, \u00a9 \u00b1 \u00a7';
  }
  for (let i = 1; i <= 64; i++) lines.push(`filler line ${String(i).padStart(2, '0')} - lorem ipsum dolor sit amet`);
  return lines.join('\n') + '\n';
}

let laneCounter = 0;

/**
 * Create an isolated state root + worktree + handoff for one test.
 * @param {string} name
 * @param {{handoff?:string, config?:object, spaces?:boolean, laneId?:string, dirEvidence?:boolean}} [opts]
 */
export function makeCase(name, opts = {}) {
  const { handoff, config, spaces } = opts;
  const id = `${name}-${crypto.randomBytes(3).toString('hex')}`;
  const base = path.join(TEST_ROOT, spaces ? `${id} with spaces` : id);
  const stateRoot = path.join(base, spaces ? 'state root dir' : 'state');
  const work = path.join(base, spaces ? 'work tree dir' : 'work');
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const handoffPath = path.join(base, spaces ? 'the handoff file.txt' : 'handoff.txt');
  fs.writeFileSync(handoffPath, handoff ?? hostileHandoff(), 'utf8');
  if (config) fs.writeFileSync(path.join(stateRoot, 'config.json'), JSON.stringify(config, null, 2));

  // The lane is machine-wide by design, so each test gets its own lane id; otherwise
  // the suite would contend with the owner's real runs and with itself. `laneId` can be
  // shared deliberately between two cases to prove cross-state-root serialisation.
  const laneId = opts.laneId || `t${process.pid}x${laneCounter++}${crypto.randomBytes(2).toString('hex')}`;

  /** @type {any} */
  const env = {
    ...process.env,
    ORCH_STATE_ROOT: stateRoot,
    ORCH_LANE_ID: laneId,
    ORCH_ALLOW_FAKE: '1',
    ORCH_FAKE_WORKER: FAKE_WORKER,
    PWD: 'C:\\definitely\\not\\the\\worktree', // must be overridden by the adapter
  };
  if (opts.dirEvidence) env.ORCH_FAKE_DIR_EVIDENCE = '1';
  delete env.ORCH_LANE_ROOT; // deleted knob; must not leak in from a developer shell

  return {
    id,
    base,
    stateRoot,
    laneId,
    work,
    handoffPath,
    env,
    lanePipe: `\\\\.\\pipe\\orch-lane-${laneId}-local`,
    laneDirLocal: path.join(laneHome(), `${laneId}-local`),
    cleanup() {
      if (process.env.ORCH_KEEP_TEST_DIRS === '1') return; // keep evidence while debugging
      for (const p of [base, path.join(laneHome(), `${laneId}-local`), path.join(laneHome(), `${laneId}-cloud`)]) {
        try {
          fs.rmSync(p, { recursive: true, force: true }); // only what this test created
        } catch {
          /* leave it rather than fight it */
        }
      }
    },
  };
}

/** Run the orch CLI as a child process and collect its output. */
export function orch(args, env, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [ORCH_BIN, ...args],
      { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...opts },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

/** Run the orch CLI through a PowerShell child that then exits (parent-exit test). */
export function orchViaShell(args, env) {
  return new Promise((resolve) => {
    const quoted = [ORCH_BIN, ...args].map((a) => `'${String(a).replace(/'/g, "''")}'`).join(' ');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& '${process.execPath}' ${quoted}`],
      { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err, shellPid: child.pid }));
  });
}

/**
 * Release N separate OS processes at one barrier, each running `orch <args>`.
 * Contention is NEVER tested with same-process `Promise.all` (R8).
 * @returns {Promise<Array<{label:string, code:number, stdout:string, stderr:string, ms:number}>>}
 */
export function contend(n, args, env, { leadMs = 700 } = {}) {
  const barrier = Date.now() + leadMs;
  const runs = [];
  for (let i = 0; i < n; i++) {
    runs.push(
      new Promise((resolve) => {
        let out = '';
        const child = spawn(process.execPath, [CONTENDER, String(barrier), `c${i}`, ...args], {
          env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        child.stdout.on('data', (d) => (out += d));
        child.on('close', () => {
          let parsed = null;
          for (const line of out.split(/\r?\n/)) {
            if (line.startsWith('{')) {
              try {
                parsed = JSON.parse(line);
              } catch {
                /* keep looking */
              }
            }
          }
          resolve(parsed || { label: `c${i}`, code: -1, stdout: out, stderr: 'no result line', ms: 0 });
        });
      }),
    );
  }
  return Promise.all(runs);
}

export function readRunRecord(stateRoot, id) {
  const f = path.join(stateRoot, 'runs', id, 'run.json');
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

export function readRunFile(stateRoot, id, name) {
  try {
    return fs.readFileSync(path.join(stateRoot, 'runs', id, name), 'utf8');
  } catch {
    return '';
  }
}

export function keeperLines(stateRoot, id) {
  return readRunFile(stateRoot, id, 'keeper.ndjson')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function waitFor(fn, { timeoutMs = 60000, intervalMs = 150, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what} (last value: ${JSON.stringify(last)})`);
}

export function waitForStatus(stateRoot, id, statuses, opts = {}) {
  const want = new Set([].concat(statuses));
  return waitFor(
    () => {
      const rec = readRunRecord(stateRoot, id);
      return rec && want.has(rec.status) ? rec : null;
    },
    { what: `run ${id} to reach ${[...want].join('|')}`, ...opts },
  );
}

/** Job id printed by `orch run`. */
export function idFrom(stdout) {
  const m = /^job ([0-9]{8}-[0-9]{6}-[0-9a-f]{6})/m.exec(stdout);
  if (!m) throw new Error(`no job id in orch output:\n${stdout}`);
  return m[1];
}

/**
 * THE ONLY kill a test may perform (r3-5). Identity is re-verified from a fresh
 * process-table read immediately before the kill; anything but `match` refuses and
 * the refusal is returned, never swallowed.
 */
export async function killOwnedChecked(pid, recordedCreatedAt) {
  if (!pid) return { killed: false, verdict: 'gone', output: 'no pid' };
  return killChecked(pid, recordedCreatedAt, { deadlineMs: 4000 });
}

/** Identity of a pid this suite recorded. Never used to find a process by name. */
export async function identityOf(pid, recordedCreatedAt) {
  const table = await readProcessTable({ deadlineMs: 5000, pids: [pid] });
  return verifyIdentity(pid, recordedCreatedAt, table).verdict;
}

/**
 * OS-level suspend/resume of a pid THIS SUITE started, through one PowerShell
 * `Add-Type` of `ntdll!NtSuspendProcess` - the same harness the lane experiments used
 * for X5. Identity is verified first; anything but `match` refuses.
 *
 * A suspended process is ALWAYS resumed or killed by the test that suspended it.
 */
export async function suspendProcess(pid, recordedCreatedAt, resume = false) {
  const verdict = await identityOf(pid, recordedCreatedAt);
  if (verdict !== 'match') return { ok: false, verdict, output: 'refused: identity is not a match' };
  const fn = resume ? 'NtResumeProcess' : 'NtSuspendProcess';
  const script = [
    '$sig = @"',
    '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);',
    '[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);',
    '"@',
    'Add-Type -MemberDefinition $sig -Name NtSusp -Namespace OrchTest | Out-Null',
    `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop`,
    `$rc = [OrchTest.NtSusp]::${fn}($p.Handle)`,
    'Write-Output "rc=$rc"',
  ].join('\n');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => resolve({ ok: !err && /rc=0/.test(String(stdout)), verdict, output: String(stdout || stderr || err) }),
    );
  });
}

export const resumeProcess = (pid, createdAt) => suspendProcess(pid, createdAt, true);

/** The pids `orch run` captured for one run, with their OS creation times (A2). */
export function spawnedIdentity(stateRoot, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateRoot, 'runs', id, 'spawned.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Count the fake workers that currently declare themselves alive in a worktree. */
export function aliveMarkers(work) {
  try {
    return fs.readdirSync(work).filter((f) => f.startsWith('alive-'));
  } catch {
    return [];
  }
}
