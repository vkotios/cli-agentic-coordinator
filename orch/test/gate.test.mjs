// Slice 2, gate S5: the review gate. Table-driven over the pure `computeGate`, plus the
// CLI's record/status path (validation, ordering, immutability, closed gate, override).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeCase, orch } from './helpers.mjs';
import { computeGate, normalizeFindings } from '../src/gate.mjs';

const F = (severity, area, { in_scope = 'yes', status = 'confirmed', id = null, reraised_of = null } = {}) => ({ severity, area, in_scope, status, id, reraised_of });
const R = (round, findings, verification = 'pass', scope = 'pass') => ({ round, findings: normalizeFindings(findings), verification, scope });

const TABLE = [
  // --- convergence
  { name: 'no findings, verification pass, scope pass -> converged', rounds: [R(1, [])], decision: 'converged' },
  { name: 'only Lows -> converged (Lows never trigger a round)', rounds: [R(1, [F('L', 'docs'), F('L', 'style')])], decision: 'converged' },
  { name: 'out-of-scope High -> converged (filed, not fixed here)', rounds: [R(1, [F('H', 'other', { in_scope: 'no' })])], decision: 'converged' },
  { name: 'refuted High -> converged', rounds: [R(1, [F('H', 'lane', { status: 'refuted', id: 'h1' })])], decision: 'converged' },
  { name: 'unverifiable Medium -> converged', rounds: [R(1, [F('M', 'lane', { status: 'unverifiable' })])], decision: 'converged' },
  { name: 'filed Medium -> converged', rounds: [R(1, [F('M', 'lane', { status: 'filed' })])], decision: 'converged' },
  { name: 'in-scope confirmed Medium -> another round', rounds: [R(1, [F('M', 'parser')])], decision: 'another-round', next: 2 },
  { name: 'no findings but verification fail -> another round', rounds: [R(1, [], 'fail')], decision: 'another-round', next: 2 },
  { name: 'no findings but scope fail -> another round', rounds: [R(1, [], 'pass', 'fail')], decision: 'another-round', next: 2 },
  { name: 'scope unknown is not pass', rounds: [R(1, [], 'pass', 'unknown')], decision: 'another-round', next: 2 },
  { name: 'round 2 clean after round 1 Medium -> converged', rounds: [R(1, [F('M', 'parser')]), R(2, [])], decision: 'converged' },
  // --- round cap and the 4th-round exception
  { name: 'round 3 with a Medium -> stop (cap), no 4th', rounds: [R(1, [F('M', 'a')]), R(2, [F('M', 'b')]), R(3, [F('M', 'c')])], decision: 'stop-round-cap' },
  { name: 'round 3 with only verification fail -> stop (cap)', rounds: [R(1, [F('M', 'a')]), R(2, [F('M', 'b')]), R(3, [], 'fail')], decision: 'stop-round-cap' },
  { name: 'round 3 with an in-scope confirmed High -> a 4th round is allowed', rounds: [R(1, [F('M', 'a')]), R(2, [F('M', 'b')]), R(3, [F('H', 'c')])], decision: 'another-round', next: 4, fourth: true },
  { name: 'round 3 High but OUT of scope -> stop (the exception needs in-scope)', rounds: [R(1, [F('M', 'a')]), R(2, [F('M', 'b')]), R(3, [F('M', 'c'), F('H', 'x', { in_scope: 'no' })])], decision: 'stop-round-cap' },
  { name: 'round 3 High but refuted -> stop (the exception needs confirmed)', rounds: [R(1, [F('M', 'a')]), R(2, [F('M', 'b')]), R(3, [F('M', 'c'), F('H', 'x', { status: 'refuted' })])], decision: 'stop-round-cap' },
  { name: 'round 4 still failing -> stop, never a 5th', rounds: [R(1, [F('M', 'a')]), R(2, [F('M', 'b')]), R(3, [F('H', 'c')]), R(4, [F('H', 'd')])], decision: 'stop-round-cap' },
  { name: 'round 4 clean -> converged', rounds: [R(1, [F('M', 'a')]), R(2, [F('M', 'b')]), R(3, [F('H', 'c')]), R(4, [])], decision: 'converged' },
  // --- escalate-design
  { name: 'same area blocking in rounds 1 and 2 -> escalate-design', rounds: [R(1, [F('M', 'Lane Pipe')]), R(2, [F('H', 'lane pipe ')])], decision: 'escalate-design', areas: ['lane pipe'] },
  { name: 'same area in rounds 1 and 3 but not 2 -> not consecutive, another round', rounds: [R(1, [F('M', 'a')]), R(2, [F('M', 'b')]), R(3, [F('H', 'a')])], decision: 'another-round', next: 4 },
  { name: 'same area, but round 2 finding is a Low -> not failing, another round', rounds: [R(1, [F('M', 'a')]), R(2, [F('L', 'a'), F('M', 'b')])], decision: 'another-round', next: 3 },
  { name: 'same area, but round 2 finding out of scope -> another round only for b', rounds: [R(1, [F('M', 'a')]), R(2, [F('M', 'a', { in_scope: 'no' }), F('M', 'b')])], decision: 'another-round', next: 3 },
  { name: 'escalate-design outranks the cap at round 3', rounds: [R(1, [F('M', 'a')]), R(2, [F('M', 'b')]), R(3, [F('M', 'b')])], decision: 'escalate-design', areas: ['b'] },
  // --- re-raised refuted findings do not count
  { name: 'a refuted finding re-raised (same id) as confirmed does not count -> converged', rounds: [R(1, [F('H', 'lane', { status: 'refuted', id: 'X1' }), F('M', 'parser')]), R(2, [F('H', 'lane', { id: 'X1' })])], decision: 'converged', reraised: 1 },
  { name: 're-raised via reraised_of does not count', rounds: [R(1, [F('M', 'lane', { status: 'refuted', id: 'X1' }), F('M', 'p')]), R(2, [F('M', 'lane', { id: 'NEW', reraised_of: 'X1' })])], decision: 'converged', reraised: 1 },
  { name: 're-raised refuted does not feed escalate-design', rounds: [R(1, [F('M', 'lane'), F('M', 'x', { status: 'refuted', id: 'r1' })]), R(2, [F('M', 'lane', { id: 'r1' }), F('M', 'other')])], decision: 'another-round', next: 3, reraised: 1 },
  { name: 're-raised refuted does not grant the 4th round', rounds: [R(1, [F('H', 'a', { status: 'refuted', id: 'h' }), F('M', 'q')]), R(2, [F('M', 'b')]), R(3, [F('M', 'c'), F('H', 'a', { id: 'h' })])], decision: 'stop-round-cap', reraised: 1 },
  { name: 'a DIFFERENT id in the same area counts normally', rounds: [R(1, [F('M', 'lane', { status: 'refuted', id: 'X1' }), F('M', 'p')]), R(2, [F('M', 'lane', { id: 'X2' })])], decision: 'another-round', next: 3 },
];

test('S5: the gate decision table', () => {
  const lines = [];
  for (const row of TABLE) {
    const g = computeGate(row.rounds);
    lines.push(`${g.decision.padEnd(16)} ${row.name}`);
    assert.equal(g.decision, row.decision, `${row.name}: got ${g.decision} (${g.reason})`);
    if (row.next !== undefined) assert.equal(g.next_round, row.next, `${row.name}: next round`);
    if (row.fourth) assert.equal(g.fourth_round_exception, true, row.name);
    if (row.areas) assert.deepEqual(g.areas, row.areas, row.name);
    if (row.reraised) {
      const n = g.per_round.reduce((a, r) => a + r.reraised_refuted.length, 0);
      assert.equal(n, row.reraised, `${row.name}: re-raised count`);
    }
    assert.equal(g.rounds_used, row.rounds.length);
    assert.ok(g.reason && g.reason.length > 10, 'every decision carries a reason');
  }
  console.log(`S5: ${TABLE.length} table rows\n  ${lines.join('\n  ')}`);
  assert.equal(computeGate([]).decision, 'no-rounds');
});

test('S5: findings validation - every judgment is mandatory', () => {
  assert.throws(() => normalizeFindings([{ severity: 'X', area: 'a', in_scope: 'yes', status: 'confirmed' }]), /severity/);
  assert.throws(() => normalizeFindings([{ severity: 'H', area: '', in_scope: 'yes', status: 'confirmed' }]), /area/);
  assert.throws(() => normalizeFindings([{ severity: 'H', area: 'a', status: 'confirmed' }]), /in_scope/);
  assert.throws(() => normalizeFindings([{ severity: 'H', area: 'a', in_scope: 'yes', status: 'maybe' }]), /status/);
  assert.throws(() => normalizeFindings({}), /array/);
  const n = normalizeFindings([{ severity: 'High', area: ' x ', in_scope: true, status: 'Confirmed', title: 't' }]);
  assert.deepEqual([n[0].severity, n[0].area, n[0].in_scope, n[0].status, n[0].title], ['H', 'x', true, 'confirmed', 't']);
});

test('S5: gate record/status through the CLI - order, immutability, scope from `orch scope`, closed gate, override', { timeout: 120000 }, async (t) => {
  const c = makeCase('s5-cli');
  t.after(() => c.cleanup());
  const base = ['--wp', 'WP-G', '--slice', 's1', '--json'];
  const st0 = await orch(['gate', 'status', ...base], c.env);
  assert.equal(st0.code, 4);
  assert.equal(JSON.parse(st0.stdout).decision, 'no-rounds');
  const outOfOrder = await orch(['gate', 'record', ...base, '--round', '2', '--findings', '[]', '--verification', 'pass', '--scope', 'pass'], c.env);
  assert.equal(outOfOrder.code, 2);
  assert.match(outOfOrder.stderr, /next round .* is 1/);
  const f1 = JSON.stringify([{ id: 'A', severity: 'M', area: 'parser', in_scope: 'yes', status: 'confirmed' }, { id: 'B', severity: 'H', area: 'lane', in_scope: 'yes', status: 'refuted' }]);
  const r1 = await orch(['gate', 'record', ...base, '--round', '1', '--findings', f1, '--verification', 'pass', '--scope', 'pass'], c.env);
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(JSON.parse(r1.stdout).gate.decision, 'another-round');
  const dup = await orch(['gate', 'record', ...base, '--round', '1', '--findings', '[]', '--verification', 'pass', '--scope', 'pass'], c.env);
  assert.equal(dup.code, 2, 'a round is never rewritten');
  // Round 2: findings from a FILE; scope from a recorded `orch scope` result.
  const runDir = path.join(c.stateRoot, 'runs', '20260923-130000-abcdef');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'scope.json'), JSON.stringify({ result: 'pass', checked_at: '2026-09-23T13:00:00Z' }));
  const ff = path.join(c.base, 'findings.json');
  fs.writeFileSync(ff, '﻿' + JSON.stringify([{ id: 'B', severity: 'H', area: 'lane', in_scope: 'yes', status: 'confirmed' }, { severity: 'L', area: 'docs', in_scope: 'yes', status: 'confirmed' }]));
  const r2 = await orch(['gate', 'record', ...base, '--round', '2', '--findings', ff, '--verification', 'pass', '--scope-run', '20260923-130000-abcdef'], c.env);
  assert.equal(r2.code, 0, r2.stderr);
  const g2 = JSON.parse(r2.stdout).gate;
  assert.equal(g2.decision, 'converged', `the re-raised refuted High B must not count: ${g2.reason}`);
  assert.equal(g2.per_round[1].reraised_refuted[0].id, 'B');
  const st = await orch(['gate', 'status', '--wp', 'WP-G', '--slice', 's1'], c.env);
  assert.equal(st.code, 0);
  assert.match(st.stdout, /decision: converged/);
  assert.match(st.stdout, /finding B \(lane\) re-raises one refuted in round 1 - not counted/);
  // The gate is closed: a 3rd round needs a recorded override reason.
  const closed = await orch(['gate', 'record', ...base, '--round', '3', '--findings', '[]', '--verification', 'pass', '--scope', 'pass'], c.env);
  assert.equal(closed.code, 2);
  assert.match(closed.stderr, /already decided "converged"/);
  const ov = await orch(['gate', 'record', ...base, '--round', '3', '--findings', '[]', '--verification', 'fail', '--scope', 'pass', '--override-reason', 'owner asked for one more pass'], c.env);
  assert.equal(ov.code, 0, ov.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(c.stateRoot, 'gates', 'wp-g', 's1', 'round-3.json'), 'utf8'));
  assert.equal(saved.override_reason, 'owner asked for one more pass');
  // A scope run that was never checked is `unknown`, not pass.
  const c2 = ['--wp', 'WP-H', '--slice', 's1', '--json'];
  const u = await orch(['gate', 'record', ...c2, '--round', '1', '--findings', '[]', '--verification', 'pass', '--scope-run', 'never-checked'], c.env);
  assert.equal(JSON.parse(u.stdout).gate.decision, 'another-round');
  assert.equal(JSON.parse(u.stdout).recorded.scope, 'unknown');
  const bad = await orch(['gate', 'record', ...c2, '--round', '2', '--findings', '[{"severity":"H"}]', '--verification', 'pass', '--scope', 'pass'], c.env);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /status must be/);
});
