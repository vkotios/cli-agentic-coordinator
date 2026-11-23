// Foreman git inspection: a worker can write the worktree's git config, and git runs programs the
// config names (a clean filter, an fsmonitor, an external diff). These tests prove that no program
// the worker configures runs, including when the config changes between Foreman looking at the
// repository and git running (the window a "check, then run" design would leave open).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { TEST_ROOT } from './helpers.mjs';
import { makeRepo } from './wf-helpers.mjs';
import { gitSafe, openInspection } from '../src/foreman/git.mjs';
import { ignoredOutsideAllowlist } from '../src/foreman/acceptance.mjs';
import { worktreeFingerprint } from '../src/foreman/progress.mjs';

const fwd = (p) => p.replace(/\\/g, '/');
const sh = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });

/** A repository with a tracked, then modified, file and a program-writing script. */
function setup(t, name) {
  const base = path.join(TEST_ROOT, `fm-git-${name}-${process.pid}-${Date.now()}`);
  const dir = path.join(base, 'repo');
  makeRepo(dir, { 'a.txt': 'one\n', '.gitattributes': '*.txt filter=evil diff=evil\n', '.gitignore': 'hidden.log\n' });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const marker = path.join(base, 'ran.txt');
  const script = path.join(base, 'mark.cjs'); // CommonJS: the package is an ES module package
  fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\nprocess.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>{});\n`);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one and more\n'); // size changed, so git has to look at the content
  fs.writeFileSync(path.join(dir, 'hidden.log'), 'x');
  const command = `node "${fwd(script)}"`;
  /** Every way a repository config can make git run a program. */
  const plant = (cfg) => {
    sh(dir, 'config', '--file', cfg, 'filter.evil.clean', command);
    sh(dir, 'config', '--file', cfg, 'filter.evil.smudge', command);
    sh(dir, 'config', '--file', cfg, 'filter.evil.process', command);
    sh(dir, 'config', '--file', cfg, 'diff.evil.textconv', command);
    sh(dir, 'config', '--file', cfg, 'diff.external', command);
    sh(dir, 'config', '--file', cfg, 'core.fsmonitor', command);
    sh(dir, 'config', '--file', cfg, 'core.hooksPath', fwd(base));
  };
  return { base, dir, marker, command, plant, cfg: path.join(dir, '.git', 'config') };
}

const ran = (c) => fs.existsSync(c.marker);

test('git: the planted config does run a program under plain git (so the other tests can detect one)', (t) => {
  const c = setup(t, 'control');
  c.plant(c.cfg);
  sh(c.dir, 'status', '--porcelain');
  assert.equal(ran(c), true, 'the control: ordinary git ran the configured filter');
});

test('git: config planted before the call never runs a program, and the answers are still right', (t) => {
  const c = setup(t, 'before');
  c.plant(c.cfg);
  const fp = worktreeFingerprint(c.dir);
  assert.match(fp.diffStat, /a\.txt/, 'the diff is still seen');
  assert.equal(fp.files, 1, 'status lists only the modified a.txt (hidden.log is ignored)');
  const ignored = ignoredOutsideAllowlist(c.dir, []);
  assert.equal(ignored.ok, true);
  assert.deepEqual(ignored.offending, ['hidden.log']);
  assert.equal(ran(c), false, 'no configured program ran');
});

test('git: config changed between setup and the git call does not run a program', (t) => {
  const c = setup(t, 'between');
  const inspection = openInspection(c.dir);
  assert.equal(inspection.ok, true);
  // The worker rewrites its config now, after Foreman has looked at the repository and before git runs.
  c.plant(c.cfg);
  const status = inspection.run(['status', '--porcelain']);
  const diff = inspection.run(['diff', '--stat']);
  const listing = inspection.run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  inspection.close();
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /a\.txt/);
  assert.equal(diff.status, 0, diff.stderr);
  assert.equal(listing.stdout, 'hidden.log\0');
  assert.equal(ran(c), false, 'no configured program ran');
});

test('git: a worker rewriting its config continuously while Foreman inspects it never gets a program run', { timeout: 120000 }, async (t) => {
  const c = setup(t, 'race');
  const clean = fs.readFileSync(c.cfg, 'utf8');
  c.plant(c.cfg);
  const planted = fs.readFileSync(c.cfg, 'utf8');
  fs.writeFileSync(c.cfg, clean);
  fs.writeFileSync(path.join(c.base, 'clean.cfg'), clean);
  fs.writeFileSync(path.join(c.base, 'planted.cfg'), planted);
  // A separate process flips the config between clean and booby-trapped as fast as it can.
  const flipper = spawn(process.execPath, ['-e', `
    const fs = require('fs'); const [file, a, b] = process.argv.slice(1);
    const A = fs.readFileSync(a, 'utf8'), B = fs.readFileSync(b, 'utf8');
    let i = 0; setInterval(() => { for (let n = 0; n < 50; n++) { try { fs.writeFileSync(file, (i++ % 2) ? A : B); } catch {} } }, 1);
  `, c.cfg, path.join(c.base, 'clean.cfg'), path.join(c.base, 'planted.cfg')], { stdio: 'ignore', windowsHide: true });
  t.after(() => flipper.kill());
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < 12; i++) {
    worktreeFingerprint(c.dir);
    assert.equal(ignoredOutsideAllowlist(c.dir, []).ok, true);
  }
  flipper.kill();
  assert.equal(ran(c), false, 'no configured program ran in any of the runs');
});

test('git: a linked worktree is inspected through Foreman\'s own git directory too', (t) => {
  const c = setup(t, 'linked');
  sh(c.dir, 'stash', '-u'); // a clean main checkout to branch from
  const wt = path.join(c.base, 'linked-wt');
  sh(c.dir, 'worktree', 'add', '-q', wt, '-b', 'work');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'changed in the worktree\n');
  fs.writeFileSync(path.join(wt, 'hidden.log'), 'x');
  c.plant(c.cfg); // worktrees share the repository config
  const fp = worktreeFingerprint(wt);
  assert.match(fp.diffStat, /a\.txt/);
  assert.deepEqual(ignoredOutsideAllowlist(wt, []).offending, ['hidden.log']);
  assert.equal(ran(c), false, 'no configured program ran');
});

test('git: a clean checkout reports nothing changed (the copied file-mode and line-ending settings agree)', (t) => {
  const base = path.join(TEST_ROOT, `fm-git-clean-${process.pid}-${Date.now()}`);
  const dir = path.join(base, 'repo');
  makeRepo(dir, { 'a.txt': 'one\n', 'run.sh': '#!/bin/sh\n' });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  sh(dir, 'config', 'core.autocrlf', 'true');
  sh(dir, 'config', 'core.filemode', 'false');
  assert.equal(gitSafe(dir, ['status', '--porcelain']).stdout, '');
  assert.equal(worktreeFingerprint(dir).files, 0);
});

test('git: a worktree that cannot be set up fails closed, never as "nothing changed"', (t) => {
  const base = path.join(TEST_ROOT, `fm-git-bad-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.join(base, 'notarepo'), { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const r = gitSafe(path.join(base, 'notarepo'), ['status', '--porcelain']);
  assert.notEqual(r.status, 0);
  assert.equal(ignoredOutsideAllowlist(path.join(base, 'notarepo'), []).ok, false);
  fs.writeFileSync(path.join(base, 'notarepo', '.git'), 'gitdir: ../nowhere\n');
  assert.notEqual(gitSafe(path.join(base, 'notarepo'), ['status']).status, 0);
  assert.equal(openInspection(path.join(base, 'notarepo')).ok, false);
});
