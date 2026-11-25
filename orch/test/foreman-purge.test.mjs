import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeCase, orch } from './helpers.mjs';
import { makeRepo } from './wf-helpers.mjs';
import { ignoredOutsideAllowlist, purgeIgnored, snapshotIgnored } from '../src/foreman/acceptance.mjs';
import { DEFAULT_SETTINGS } from '../src/foreman/settings.mjs';

const patterns = DEFAULT_SETTINGS.purgeIgnored;
const linkDirectory = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

function fixture(t, name, files) {
  const c = makeCase(name);
  t.after(() => c.cleanup());
  const dir = path.join(c.base, 'repo');
  makeRepo(dir, files);
  const write = (rel, content = 'cache') => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  return { dir, write, base: c.base };
}

test('purge: removes new and changed ignored cache files at any depth and prunes empty directories', (t) => {
  const ignore = '__pycache__\nnode_modules/\n*.tsbuildinfo\n*.log\n!unignored/__pycache__/\n';
  const { dir, write } = fixture(t, 'fm-purge', {
    '.gitignore': ignore + '!tracked/__pycache__/\n',
    'tracked/__pycache__/keep.pyc': 'tracked',
  });
  write('.gitignore', ignore);
  write('src/__pycache__/same.pyc', 'one');
  write('src/__pycache__/changed.pyc', 'one');
  const snap = snapshotIgnored(dir);
  assert.equal(snap.ok, true, snap.error);
  write('src/__pycache__/changed.pyc', 'two');
  write('a/b/__pycache__/x.pyc');
  write('pkg/node_modules/.vite/vitest/results.json');
  write('pkg/tsconfig.tsbuildinfo');
  write('pkg/other.tsbuildinfo');
  write('pkg/node_modules/.vite-similar/keep');
  write('pkg/debug.log');
  write('unignored/__pycache__/keep.pyc');

  const purged = purgeIgnored(dir, patterns, snap.files);
  assert.equal(purged.error, null);
  assert.deepEqual(purged.offending, []);
  assert.equal(purged.count, 4);
  assert.equal(purged.bytes, 18);
  assert.deepEqual(purged.paths.sort(), [
    'a/b/__pycache__/x.pyc', 'pkg/node_modules/.vite/vitest/results.json',
    'pkg/tsconfig.tsbuildinfo', 'src/__pycache__/changed.pyc',
  ]);
  for (const file of [...purged.paths, 'a/b/__pycache__', 'pkg/node_modules/.vite']) {
    assert.equal(fs.existsSync(path.join(dir, file)), false, file);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'src/__pycache__/same.pyc'), 'utf8'), 'one');
  assert.equal(fs.readFileSync(path.join(dir, 'tracked/__pycache__/keep.pyc'), 'utf8'), 'tracked');
  assert.equal(fs.readFileSync(path.join(dir, 'unignored/__pycache__/keep.pyc'), 'utf8'), 'cache');
  assert.deepEqual(ignoredOutsideAllowlist(dir, [], [], snap.files).offending.sort(), [
    'pkg/debug.log', 'pkg/node_modules/.vite-similar/keep', 'pkg/other.tsbuildinfo',
  ]);
});

test('purge: refuses an ignored matching link into another directory outside the worktree', (t) => {
  const { dir, base } = fixture(t, 'fm-purge-outside', { '.gitignore': 'node_modules/\n' });
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'x.pyc'), 'original');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  linkDirectory(outside, path.join(dir, 'node_modules/__pycache__'));
  const baseline = snapshotIgnored(dir);
  assert.equal(baseline.ok, true, baseline.error);

  const purged = purgeIgnored(dir, patterns, baseline.files);
  assert.equal(purged.error, null);
  assert.equal(purged.count, 0);
  assert.equal(purged.offending.length, 1);
  assert.match(purged.offending[0], /^node_modules\/__pycache__(?:\/x\.pyc)?$/);
  assert.equal(fs.readFileSync(path.join(outside, 'x.pyc'), 'utf8'), 'original');
  assert.equal(fs.lstatSync(path.join(dir, 'node_modules/__pycache__')).isSymbolicLink(), true);
});

test('ignored workspace links: skip a non-ignored workspace, but record an ignored target and reject a repointed link', (t) => {
  const { dir, base, write } = fixture(t, 'fm-workspace-link', {
    '.gitignore': 'node_modules/\nignored/\n',
    'packages/pkg/src/a.js': 'before',
    'packages/pkg/tsconfig.tsbuildinfo': 'tracked through the workspace link',
  });
  const at = path.join(dir, 'node_modules', '@scope', 'pkg');
  fs.mkdirSync(path.dirname(at), { recursive: true });
  linkDirectory(path.join(dir, 'packages/pkg'), at);
  write('ignored/pkg/src/a.js', 'before');
  linkDirectory(path.join(dir, 'ignored/pkg'), path.join(dir, 'node_modules', 'ignored-pkg'));
  const snap = snapshotIgnored(dir);
  assert.equal(snap.ok, true, snap.error);
  const recorded = Object.keys(snap.files);
  assert.ok(!recorded.some((name) => name.startsWith('node_modules/@scope/pkg')));
  assert.ok(recorded.some((name) => name.startsWith('node_modules/ignored-pkg')));
  const allowlist = ['packages/pkg/src/a.js'];

  write('packages/pkg/src/a.js', 'after!');
  assert.deepEqual(ignoredOutsideAllowlist(dir, allowlist, [], snap.files).offending, []);
  const purged = purgeIgnored(dir, patterns, snap.files);
  assert.equal(purged.count, 0);
  assert.deepEqual(purged.offending, []);
  assert.equal(fs.readFileSync(path.join(dir, 'packages/pkg/tsconfig.tsbuildinfo'), 'utf8'), 'tracked through the workspace link');
  write('ignored/pkg/src/a.js', 'after!');
  assert.ok(ignoredOutsideAllowlist(dir, allowlist, [], snap.files).offending.some((name) => name.startsWith('node_modules/ignored-pkg')));
  write('ignored/pkg/src/a.js', 'before');

  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(outside, 'src'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'src/a.js'), 'before');
  fs.unlinkSync(at);
  linkDirectory(outside, at);
  const checked = ignoredOutsideAllowlist(dir, allowlist, [], snap.files);
  assert.equal(checked.ok, true, checked.error);
  assert.equal(checked.offending.length, 1);
  assert.match(checked.offending[0], /^node_modules\/@scope\/pkg(?:\/src\/a\.js)?$/);
});

test('settings: purgeIgnored is displayed, validated and configurable', async (t) => {
  const c = makeCase('fm-purge-settings');
  t.after(() => c.cleanup());
  const run = (...args) => orch(['foreman', 'settings', ...args], c.env);
  const initial = await run();
  assert.equal(initial.code, 0, initial.stderr);
  assert.ok(initial.stdout.includes(`purgeIgnored: ${JSON.stringify(patterns)}`));
  for (const value of ['"__pycache__/"', '["valid/",1]', 'null']) {
    const bad = await run('--purgeIgnored', value);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr + bad.stdout, /purgeIgnored must be a JSON array of strings/);
  }
  const updated = await run('--purgeIgnored', '[]', '--json');
  assert.equal(updated.code, 0, updated.stderr);
  assert.deepEqual(JSON.parse(updated.stdout).purgeIgnored, []);
});
