// K02: unit tests for the generic queue driver (orch/tools/queue-driver.mjs).
// The pure helpers are tested directly; --dry-run is driven through main() with an
// injected spawn that records every call. The live loop (orch run/status polling,
// commits) is deliberately not exercised here: it needs a real orch state dir and a
// worker CLI, and the kit's rule is fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  QueueDriverError,
  parseOptions,
  parseTasks,
  selectTasks,
  parseChecks,
  buildChecksCommands,
  filterChangedPaths,
  matchForbidden,
  main,
} from '../tools/queue-driver.mjs';

const SAMPLE_TASKS = [
  '# Kit fixes backlog', // preamble: not a task section
  '',
  '##### T01',
  'TASK T01: Add the widget parser.',
  'TESTS: test/widget.test.mjs',
  '',
  'Parse widgets.',
  '',
  '##### T02',
  'TASK T02: Document the parser.',
  'TESTS: (none - documentation only)',
  '',
  'Docs body.',
  '',
  '##### T03',
  'TASK T03: Two test files.',
  'TESTS: test/a.test.mjs test/b.test.mjs',
  '',
  '##### T04',
  'No TASK line, body only.',
  '',
].join('\n');

const PY_CHECKS = JSON.stringify({
  test: ['python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider'],
  extra: [['python', '-m', 'ruff', 'check', 'src', 'tests'], ['python', '-m', 'mypy', 'src']],
  cwd: '.',
  env: { PYTHONPATH: 'src' },
});
const NODE_CHECKS = JSON.stringify({ test: ['node', '--test'], extra: [['npm', 'run', 'typecheck']], cwd: 'orch' });

/** A thrower that asserts the error is a QueueDriverError matching `re`. */
function throwsDriver(fn, re, what) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof QueueDriverError, `${what}: expected a QueueDriverError, got: ${e}`);
    assert.match(e.message, re, what);
    return;
  }
  assert.fail(`${what}: expected a throw`);
}

/** A plan + worktree + checks file under a fresh temp dir; the test removes it. */
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-driver-'));
  const wt = path.join(dir, 'wt');
  const plan = path.join(wt, 'docs', 'plans', 'p1');
  fs.mkdirSync(plan, { recursive: true });
  fs.writeFileSync(path.join(plan, 'COMMON.md'), 'Common handoff rules.\n');
  fs.writeFileSync(path.join(plan, 'TASKS.md'), SAMPLE_TASKS);
  const checksFile = path.join(dir, 'checks.json');
  fs.writeFileSync(checksFile, NODE_CHECKS);
  return {
    dir, wt, plan, checksFile,
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* locked handles on Windows */ } },
  };
}

/** A spawn fake that records every call and answers exit 0 with empty output. */
function recordingSpawn(calls) {
  return (file, argv) => { calls.push([file, ...argv]); return { status: 0, stdout: '', stderr: '' }; };
}

/* ------------------------------------------------------------- task parsing */

test('parseTasks: sections, titles, TESTS lines; preamble ignored', () => {
  const tasks = parseTasks(SAMPLE_TASKS);
  assert.deepEqual(tasks.map((t) => t.id), ['T01', 'T02', 'T03', 'T04']);
  assert.equal(tasks[0].title, 'Add the widget parser.');
  assert.deepEqual(tasks[0].tests, ['test/widget.test.mjs']);
  assert.ok(tasks[0].body.includes('Parse widgets.'));
  assert.deepEqual(tasks[1].tests, [], 'TESTS: (...) means no test command');
  assert.equal(tasks[1].title, 'Document the parser.');
  assert.deepEqual(tasks[2].tests, ['test/a.test.mjs', 'test/b.test.mjs']);
  assert.equal(tasks[3].title, 'T04', 'no TASK line: the id is the title');
  assert.deepEqual(parseTasks('no sections at all'), []);
});

test('selectTasks: --from starts at the id, --only picks one, only wins over from', () => {
  const tasks = parseTasks(SAMPLE_TASKS);
  assert.deepEqual(selectTasks(tasks, null, null).map((t) => t.id), ['T01', 'T02', 'T03', 'T04']);
  assert.deepEqual(selectTasks(tasks, 'T02', null).map((t) => t.id), ['T02', 'T03', 'T04']);
  assert.deepEqual(selectTasks(tasks, null, 'T03').map((t) => t.id), ['T03']);
  assert.deepEqual(selectTasks(tasks, 'T04', 'T01').map((t) => t.id), []);
});

/* ------------------------------------------------------------------ options */

test('parseOptions: defaults, repeatable --forbid, --forbid=REGEX form', () => {
  const o = parseOptions(['--wt', 'w', '--plan', 'p']);
  assert.equal(o.model, null, 'no built-in model: main() resolves --model > ORCH_QUEUE_MODEL > queueDriver.model');
  assert.equal(o.cli, 'vibe');
  assert.equal(o.stallMinutes, 20);
  assert.deepEqual(o.forbid, []);
  assert.equal(o.dryRun, false);
  const f = parseOptions(['--wt', 'w', '--plan', 'p', '--forbid', '^data/', '--forbid', '^\\.env',
    '--stall-minutes', '5', '--model', 'm1', '--from', 'T02', '--dry-run']);
  assert.equal(f.forbid.length, 2);
  assert.ok(f.forbid[0].test('data/x.bin'));
  assert.ok(f.forbid[1].test('.env.local'));
  assert.equal(f.stallMinutes, 5);
  assert.equal(f.model, 'm1');
  assert.equal(f.from, 'T02');
  assert.equal(f.dryRun, true);
  const [buildRe] = parseOptions(['--wt', 'w', '--plan', 'p', '--forbid=^build/']).forbid;
  assert.ok(buildRe.test('build/out.js'), 'the --forbid=REGEX form parses');
  assert.ok(!buildRe.test('src/build/out.js'));
});

test('parseOptions: missing --wt (and --plan) is a clear error; --cli and values are validated', () => {
  throwsDriver(() => parseOptions(['--plan', 'p']), /--wt <path> is required/, 'missing --wt');
  throwsDriver(() => parseOptions(['--wt', 'w']), /--plan <dir> is required/, 'missing --plan');
  throwsDriver(() => parseOptions(['--wt', 'w', '--plan', 'p', '--cli', 'codex']), /--cli codex is not supported.*vibe/, 'unsupported cli');
  throwsDriver(() => parseOptions(['--wt', 'w', '--plan', 'p', '--forbid', '[']), /--forbid is not a valid regular expression/, 'bad regex');
  throwsDriver(() => parseOptions(['--wt', 'w', '--plan', 'p', '--stall-minutes', 'x']), /--stall-minutes needs a positive number/, 'bad stall');
  throwsDriver(() => parseOptions(['--wt', 'w', '--plan', 'p', '--bogus', 'v']), /unknown option: --bogus/, 'unknown option');
  throwsDriver(() => parseOptions(['--wt', 'w', '--plan', 'p', '--model']), /--model needs a value/, 'missing value');
});

/* ------------------------------------------------------------------- checks */

test('parseChecks + buildChecksCommands: a Python project (pytest/ruff/mypy)', () => {
  const checks = parseChecks(PY_CHECKS, 'checks.json');
  assert.deepEqual(checks.test, ['python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider']);
  assert.equal(checks.extra.length, 2);
  assert.equal(checks.cwd, '.');
  assert.deepEqual(checks.env, { PYTHONPATH: 'src' });
  const cmds = buildChecksCommands(checks, ['tests/test_widget.py']);
  assert.equal(cmds.length, 3);
  assert.deepEqual(cmds[0].argv, ['python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'tests/test_widget.py']);
  assert.match(cmds[0].label, /^python -m pytest .* tests\/test_widget\.py$/);
  assert.deepEqual(cmds[1].argv, ['python', '-m', 'ruff', 'check', 'src', 'tests']);
  assert.deepEqual(cmds[2].argv, ['python', '-m', 'mypy', 'src']);
  assert.equal(buildChecksCommands(checks, []).length, 2, 'a task without TESTS runs only the extra commands');
});

test('parseChecks + buildChecksCommands: a Node project (node --test, npm run typecheck)', () => {
  const checks = parseChecks(NODE_CHECKS, 'checks.json');
  assert.equal(checks.cwd, 'orch');
  const cmds = buildChecksCommands(checks, ['test/a.test.mjs', 'test/b.test.mjs']);
  assert.deepEqual(cmds[0].argv, ['node', '--test', 'test/a.test.mjs', 'test/b.test.mjs']);
  assert.deepEqual(cmds[1].argv, ['npm', 'run', 'typecheck']);
  assert.deepEqual(buildChecksCommands(null, ['test/a.test.mjs']), [], 'no checks file: no commands');
  throwsDriver(() => buildChecksCommands(parseChecks('{"extra": [["git", "status"]]}'), ['t.mjs']),
    /no "test" command but the task lists TESTS/, 'checks file without a test command');
});

test('parseChecks: broken JSON, bad shapes and unknown keys are clear errors', () => {
  throwsDriver(() => parseChecks('{', 'c.json'), /c\.json is not valid JSON/, 'broken json');
  throwsDriver(() => parseChecks('[]', 'c.json'), /must be a JSON object/, 'not an object');
  throwsDriver(() => parseChecks('{"test": []}', 'c.json'), /"test" must be a non-empty array of strings/, 'empty test');
  throwsDriver(() => parseChecks('{"test": ["cmd", 1]}', 'c.json'), /"test" must be a non-empty array of strings/, 'non-string arg');
  throwsDriver(() => parseChecks('{"extra": ["npm", "test"]}', 'c.json'), /"extra\[0\]" must be a non-empty array of strings/, 'flat extra');
  throwsDriver(() => parseChecks('{"cwd": ""}', 'c.json'), /"cwd" must be a non-empty string/, 'empty cwd');
  throwsDriver(() => parseChecks('{"env": {"X": 1}}', 'c.json'), /"env" must map names to string values/, 'non-string env');
  throwsDriver(() => parseChecks('{"tests": []}', 'c.json'), /unknown key\(s\): tests/, 'unknown key');
});

/* ----------------------------------------------------------- changed paths */

test('filterChangedPaths: porcelain parsing; .vibe/ and the plan folder excluded', () => {
  const porcelain = [
    ' M src/keep.py',
    'M  docs/keep.md',
    'A  src/added.py',
    'R  old/name.py -> new/name.py',
    '?? .vibe/session/abc',
    '?? docs/plans/p1/RUNLOG.md',
    '?? "quoted name.txt"',
  ].join('\n');
  assert.deepEqual(filterChangedPaths(porcelain, 'docs/plans/p1'), [
    'src/keep.py', 'docs/keep.md', 'src/added.py', 'new/name.py', 'quoted name.txt',
  ]);
  // plan at the worktree root ('.'): only .vibe/ is excluded
  const rootPlan = filterChangedPaths(porcelain, '.');
  assert.ok(rootPlan.includes('docs/plans/p1/RUNLOG.md'));
  assert.ok(!rootPlan.some((p) => p.startsWith('.vibe/')));
  assert.deepEqual(filterChangedPaths('', 'docs/plans/p1'), []);
});

/* --------------------------------------------------------- forbidden paths */

test('matchForbidden: any regex hit; an empty list forbids nothing', () => {
  const paths = ['src/a.py', 'data/x.bin', '.env.local', 'docs/ok.md'];
  assert.deepEqual(matchForbidden(paths, [/^data\//, /^\.env/]), ['data/x.bin', '.env.local']);
  assert.deepEqual(matchForbidden(paths, []), []);
  assert.deepEqual(matchForbidden([], [/./]), []);
});

/* ------------------------------------------------------------------ dry run */

test('dry-run: prints the tasks and the commands, spawns nothing, writes no RUNLOG', async (t) => {
  const fx = makeFixture();
  t.after(() => fx.cleanup());
  const calls = [];
  const lines = [];
  const code = await main(
    ['--wt', fx.wt, '--plan', fx.plan, '--checks', fx.checksFile, '--model', 'example-coder-30b', '--forbid', '^data/', '--dry-run'],
    { spawnSync: recordingSpawn(calls), out: (s) => lines.push(s) },
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 0, 'dry-run must not spawn git, orch or any check command');
  const text = lines.join('\n');
  assert.match(text, /dry run - nothing below is executed/);
  assert.match(text, /T01\s+Add the widget parser\./);
  assert.match(text, /orch run --cli vibe --model example-coder-30b --dir /);
  assert.match(text, /node --test test\/widget\.test\.mjs/);
  assert.match(text, /npm run typecheck/);
  assert.match(text, /git commit -m "feat\(T01\): Add the widget parser\."/);
  assert.match(text, /forbid: \^data\\?\//);
  assert.ok(!fs.existsSync(path.join(fx.plan, 'RUNLOG.md')), 'dry-run must not start a RUNLOG');
});

test('dry-run: --only narrows the printed task list', async (t) => {
  const fx = makeFixture();
  t.after(() => fx.cleanup());
  const calls = [];
  const lines = [];
  await main(
    ['--wt', fx.wt, '--plan', fx.plan, '--checks', fx.checksFile, '--model', 'example-coder-30b', '--only', 'T02', '--dry-run'],
    { spawnSync: recordingSpawn(calls), out: (s) => lines.push(s) },
  );
  assert.equal(calls.length, 0);
  const text = lines.join('\n');
  assert.match(text, /T02\s+Document the parser\./);
  assert.match(text, /tests: \(none\)/);
  assert.ok(!text.includes('T01'), '--only T02 must not print T01');
  assert.ok(!text.includes('node --test'), 'T02 has no TESTS: no test command is printed');
});

/* -------------------------------------------------------------- main errors */

test('main: missing --wt is a clear error', async () => {
  await assert.rejects(main(['--plan', 'x']), /--wt <path> is required/);
});

test('main: bad wt/plan/checks paths and unknown task ids fail before anything runs', async (t) => {
  const fx = makeFixture();
  t.after(() => fx.cleanup());
  const calls = [];
  const deps = { spawnSync: recordingSpawn(calls), out: () => {} };
  await assert.rejects(main(['--wt', path.join(fx.dir, 'nope'), '--plan', 'p'], deps), /--wt is not a directory/);
  const emptyPlan = path.join(fx.dir, 'empty-plan');
  fs.mkdirSync(emptyPlan);
  await assert.rejects(main(['--wt', fx.wt, '--plan', emptyPlan], deps), /--plan has no TASKS\.md/);
  const badChecks = path.join(fx.dir, 'bad-checks.json');
  fs.writeFileSync(badChecks, '{');
  await assert.rejects(main(['--wt', fx.wt, '--plan', fx.plan, '--checks', badChecks], deps), /not valid JSON/);
  await assert.rejects(main(['--wt', fx.wt, '--plan', fx.plan, '--checks', fx.checksFile, '--from', 'T99'], deps),
    /--from T99: no such task/);
  const noTestCmd = path.join(fx.dir, 'no-test-cmd.json');
  fs.writeFileSync(noTestCmd, '{"extra": [["git", "status"]]}');
  await assert.rejects(main(['--wt', fx.wt, '--plan', fx.plan, '--checks', noTestCmd], deps),
    /no "test" command but task T01 lists TESTS/);
  assert.equal(calls.length, 0, 'a rejected run must not have spawned anything');
});

test('main: no model from --model, ORCH_QUEUE_MODEL or the config file is a clear error; the env var is honoured', async (t) => {
  const fx = makeFixture();
  t.after(() => fx.cleanup());
  // Isolate from the developer's own settings: an empty config file, no ORCH_QUEUE_MODEL.
  const emptyConfig = path.join(fx.dir, 'orch.config.json');
  fs.writeFileSync(emptyConfig, '{}');
  const prev = { ORCH_CONFIG: process.env.ORCH_CONFIG, ORCH_QUEUE_MODEL: process.env.ORCH_QUEUE_MODEL };
  process.env.ORCH_CONFIG = emptyConfig;
  delete process.env.ORCH_QUEUE_MODEL;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const calls = [];
  const lines = [];
  const deps = { spawnSync: recordingSpawn(calls), out: (s) => lines.push(s) };
  await assert.rejects(main(['--wt', fx.wt, '--plan', fx.plan, '--dry-run'], deps), /no worker model: pass --model/);
  process.env.ORCH_QUEUE_MODEL = 'example-reasoner-120b';
  assert.equal(await main(['--wt', fx.wt, '--plan', fx.plan, '--dry-run'], deps), 0);
  assert.match(lines.join('\n'), /--model example-reasoner-120b /);
  assert.equal(calls.length, 0);
});
