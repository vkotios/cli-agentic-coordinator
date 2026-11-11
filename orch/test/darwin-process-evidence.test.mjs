import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDarwinSnapshot } from '../src/darwin-processes.mjs';
import { creationPoint } from '../src/process-time.mjs';
import { normalizeCreationTime, verifyIdentity, observeDescendants } from '../src/procs.mjs';
const boot = '00000000-0000-4000-8000-000000000001';
const scope = `darwin:${boot}`;
const stamp = n => `${scope}:${n}`;
const row = (pid, ppid, start) => ({ pid, ppid, pgrp: 42, session: 42, name: '', state: 'R', createdAt: stamp(start) });
const snapshot = rows => JSON.stringify({ clockScope: scope, now: stamp(2000000), rows });

test('macOS process identities preserve microseconds and boot scope', () => {
  const value = stamp(1790000000123456);
  assert.equal(normalizeCreationTime(value), value);
  assert.equal(creationPoint(value).value, 1790000000123456);
  assert.equal(creationPoint(value).kind, 'darwin');
  assert.equal(creationPoint(`${scope}:9007199254740992`), null);
  assert.equal(creationPoint('darwin:missing:1'), null);
});

test('macOS snapshot parsing rejects incomplete, ambiguous and malformed evidence', () => {
  for (const raw of ['', '{', snapshot([row(42, 1, 100), row(42, 1, 101)]), snapshot([{ ...row(42, 1, 100), createdAt: 'ms:100' }]), snapshot([{ ...row(42, 1, 100), state: 'unknown' }]), snapshot([{ ...row(42, 1, 100), session: null }]), snapshot([{ ...row(42, 1, 100), ppid: -1 }])]) {
    assert.equal(parseDarwinSnapshot(raw), null, raw);
  }
  const empty = parseDarwinSnapshot(snapshot([]));
  assert.equal(empty.clockScope, scope);
  assert.equal(verifyIdentity(42, stamp(100), empty).verdict, 'gone');
});

test('macOS identity checks refuse reused PIDs and unknown evidence', () => {
  const table = parseDarwinSnapshot(snapshot([row(42, 1, 100)]));
  assert.equal(verifyIdentity(42, stamp(100), table).verdict, 'match');
  assert.equal(verifyIdentity(42, stamp(101), table).verdict, 'mismatch');
  assert.equal(verifyIdentity(42, stamp(100), null).verdict, 'unknown');
  assert.equal(verifyIdentity(42, 'darwin:invalid:100', table).verdict, 'unknown');
  assert.equal(verifyIdentity(42, 'ms:100', table).verdict, 'unknown');
  assert.equal(verifyIdentity(42, stamp(100).replace(boot, '00000000-0000-4000-8000-000000000002'), table).reason, 'boot-changed');
});

test('macOS ancestry requires native birth ordering and bounds historical root lifetime', () => {
  const table = parseDarwinSnapshot(snapshot([row(42, 1, 100), row(43, 42, 90), row(44, 42, 110)]));
  assert.deepEqual(observeDescendants(42, stamp(100), table).candidates.map(p => p.pid), [44]);
  const exited = parseDarwinSnapshot(snapshot([row(44, 42, 110), row(45, 42, 130)]));
  assert.deepEqual(observeDescendants(42, stamp(100), exited, { exitedAt: stamp(120) }).candidates.map(p => p.pid), [44]);
});
