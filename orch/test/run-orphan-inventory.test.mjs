// One run folder without run.json must not make every inventory (finish, cleanup, status) fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeCase } from './helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import { runInventory, listRunEvidence, ORPHAN_GRACE_MS } from '../src/archive.mjs';
import { listRuns } from '../src/store.mjs';

function orphan(cfg, id, files, ageMs) {
  const dir = path.join(cfg.runsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), '');
  const when = new Date(Date.now() - ageMs);
  for (const f of files) fs.utimesSync(path.join(dir, f), when, when);
  fs.utimesSync(dir, when, when);
}
const OLD = ORPHAN_GRACE_MS + 60_000;

test('an old inert run folder without run.json is reported as an orphan, not fatal', (t) => {
  const c = makeCase('orphan-inert'); t.after(() => c.cleanup());
  const cfg = loadConfig(c.stateRoot);
  orphan(cfg, 'orphan-inert', ['prompt.txt', 'stdout.log', 'stderr.log'], OLD);
  const inv = runInventory(cfg);
  assert.deepEqual(inv.orphans.map((o) => o.id), ['orphan-inert']);
  assert.deepEqual(listRunEvidence(cfg), []);
  assert.deepEqual(listRuns(cfg), []);
});

test('a young run folder without run.json may be a launch in progress and still fails', (t) => {
  const c = makeCase('orphan-young'); t.after(() => c.cleanup());
  const cfg = loadConfig(c.stateRoot);
  orphan(cfg, 'orphan-young', ['prompt.txt', 'stdout.log', 'stderr.log'], 1000);
  assert.throws(() => listRunEvidence(cfg), /run inventory unreadable/);
});

test('an old folder with a keeper trail may hold a live process and still fails', (t) => {
  const c = makeCase('orphan-keeper'); t.after(() => c.cleanup());
  const cfg = loadConfig(c.stateRoot);
  orphan(cfg, 'orphan-keeper', ['prompt.txt', 'keeper.ndjson'], OLD);
  assert.throws(() => listRunEvidence(cfg), /run inventory unreadable/);
  assert.throws(() => listRuns(cfg), /run inventory unreadable/);
});

test('a corrupt run.json is still a blocker', (t) => {
  const c = makeCase('orphan-corrupt'); t.after(() => c.cleanup());
  const cfg = loadConfig(c.stateRoot);
  orphan(cfg, 'orphan-corrupt', ['prompt.txt'], OLD);
  fs.writeFileSync(path.join(cfg.runsDir, 'orphan-corrupt', 'run.json'), '{not json');
  assert.throws(() => listRunEvidence(cfg));
});
