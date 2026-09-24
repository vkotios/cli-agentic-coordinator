// Slice-2 test scaffolding: real git repositories created by the test, under the test's
// own case directory (<kit>/.state-test/<case>), removed by the test's own cleanup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { CONTENDER } from './helpers.mjs';

/** Synchronous git for test setup only; bounded. */
export function g(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * A fresh repository with one commit. `files` maps repo-relative paths to contents.
 * The identity is set in the repo's OWN config (never the user's global config).
 */
export function makeRepo(dir, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.name', 'orch-test');
  g(dir, 'config', 'user.email', 'orch-test@example.invalid');
  g(dir, 'config', 'commit.gpgsign', 'false');
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'initial');
  return g(dir, 'rev-parse', 'HEAD').trim();
}

export function commitAll(dir, msg = 'change') {
  g(dir, 'add', '-A');
  g(dir, '-c', 'user.name=orch-test', '-c', 'user.email=orch-test@example.invalid', 'commit', '-q', '-m', msg);
  return g(dir, 'rev-parse', 'HEAD').trim();
}

/** Hand-craft a finished run whose record carries a scope block (for scope scenarios). */
export function craftFinishedRun(stateRoot, { dir, baseline, allow, wp = null, slice = null, extra = {} }) {
  const id = `20260923-120000-${crypto.randomBytes(3).toString('hex')}`;
  const rdir = path.join(stateRoot, 'runs', id);
  fs.mkdirSync(rdir, { recursive: true });
  for (const f of ['stdout.log', 'stderr.log', 'prompt.txt']) fs.writeFileSync(path.join(rdir, f), '');
  const rec = {
    id,
    cli: 'fake',
    lane: 'cloud',
    model_requested: 'none',
    model_canonical: 'none',
    dir,
    status: 'completed',
    reason: 'exit-0-with-output',
    created_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    role: 'implement',
    wp,
    slice,
    scope: { allow, baseline, repo_top: dir, worktree_id: null },
    ...extra,
  };
  fs.writeFileSync(path.join(rdir, 'run.json'), JSON.stringify(rec, null, 2));
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(rdir, 'keeper.ndjson'),
    [
      { event: 'lane-acquired', at: now },
      { event: 'spawned', worker_pid: 1, at: now },
      { event: 'worker-exit', code: 0, signal: null, at: now },
      { event: 'keeper-exit', write_failures: 0, at: now },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n',
  );
  return id;
}

/**
 * N separate OS processes, each running `orch <its own args>`, released at one barrier
 * (contender.mjs). Unlike helpers.contend, every process gets its own argv.
 * @returns {Promise<any[]>}
 */
export function contendEach(argsList, env, { leadMs = 900 } = {}) {
  const barrier = Date.now() + leadMs;
  return Promise.all(
    argsList.map(
      (args, i) =>
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
    ),
  );
}

/** What a reviewer could damage in a source repo: compared before/after by the tests. */
export function repoFingerprint(dir) {
  return {
    head: g(dir, 'rev-parse', 'HEAD').trim(),
    status: g(dir, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'),
    refs: g(dir, 'for-each-ref', '--format=%(refname) %(objectname)'),
    reflog: g(dir, 'reflog', 'show', '--format=%H %gs', 'HEAD', '--'),
  };
}
