// Test-fixture process control only; no production keeper behavior is replaced.
import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import * as helpers from './helpers.mjs';

function mockedControl(t, native) {
  mock.method(childProcess, 'execFile', (_exe, args, options, callback) => {
    const script = args.at(-1);
    if (script.includes('Get-CimInstance')) queueMicrotask(() => callback(null, JSON.stringify({ProcessId:77, ParentProcessId:1, Name:'fixture', CreationDate:'ms:2000'}), ''));
    else queueMicrotask(() => native(script, options, callback));
    return {on(){},kill(){}};
  });
  syncBuiltinESMExports();
  t.after(() => {mock.restoreAll();syncBuiltinESMExports();});
}

test('keeper fixture: cold compilation is outside the bounded suspend/resume command', async t => {
  const c = helpers.makeCase('keeper-control-cold');t.after(() => c.cleanup());
  const assemblyPath = path.join(c.base, 'control.dll');fs.writeFileSync(assemblyPath, 'fixture');
  const scripts = [];
  mockedControl(t, (script, options, done) => {
    scripts.push(script);assert.equal(options.timeout, 15000);
    if (script.includes('-MemberDefinition')) done(Object.assign(Error('cold compile exceeded control deadline'), {killed:true, signal:'SIGTERM'}), '', '');
    else done(null, 'rc=0\n', '');
  });
  const out = await helpers.suspendProcess(77, 'ms:2000', false, {assemblyPath});
  assert.equal(out.ok, true, out.output);
  assert.match(scripts[0], /Add-Type -Path/);
  assert.doesNotMatch(scripts[0], /MemberDefinition/);
  assert.match(scripts[0], /StartTime/);
  assert.match(scripts[0], /identity=mismatch/);
  assert.equal((await helpers.resumeProcess(77, 'ms:2000', {assemblyPath})).ok, true);
  assert.match(scripts[1], /NtResumeProcess/);
});

test('keeper fixture: an uncertain control result retains error category and stderr', async t => {
  const c = helpers.makeCase('keeper-control-error');t.after(() => c.cleanup());
  const assemblyPath = path.join(c.base, 'control.dll');fs.writeFileSync(assemblyPath, 'fixture');
  mockedControl(t, (_script, _options, done) => done(Object.assign(Error('deadline'), {killed:true, signal:'SIGTERM',code:null}), 'partial output', 'diagnostic stderr'));
  const out = await helpers.suspendProcess(77, 'ms:2000', false, {assemblyPath});
  assert.equal(out.ok, false);
  assert.equal(out.failure, 'control-timeout');
  assert.match(out.output, /partial output/);assert.match(out.output, /diagnostic stderr/);assert.match(out.output, /SIGTERM/);
});

test('keeper fixture: an identity mismatch refuses control before the native command', async t => {
  let calls = 0;
  mockedControl(t, () => {calls++;throw Error('must not control an unrelated incarnation');});
  const out = await helpers.suspendProcess(77, 'ms:3000', false, {assemblyPath:'unused'});
  assert.equal(out.ok, false);assert.equal(out.verdict, 'mismatch');assert.equal(calls, 0);
});

test('keeper fixture: preparation has a separate bounded compilation budget', async t => {
  const c = helpers.makeCase('keeper-control-prepare');t.after(() => c.cleanup());
  let preparations = 0;
  mockedControl(t, (script, options, done) => {
    preparations++;
    assert.equal(options.timeout, 60000);
    assert.match(script, /Add-Type -MemberDefinition/);
    fs.writeFileSync(path.join(c.base, 'orch-test-process-control.dll'), 'fixture');
    done(null, '', '');
  });
  const assembly = await helpers.prepareProcessControl(c.base);
  assert.ok(fs.existsSync(assembly));
  await assert.rejects(helpers.prepareProcessControl(c.base), /already exists/);
  assert.equal(preparations, 1);
});
