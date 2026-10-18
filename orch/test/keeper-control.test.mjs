// Test-fixture process control only; no production keeper behavior is replaced.
import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import * as helpers from './helpers.mjs';
const windowsTest = (name, fn) => test(name, { skip: process.platform !== 'win32' && 'Windows native process-control API' }, fn);

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

windowsTest('keeper fixture: cold compilation is outside the bounded suspend/resume command', async t => {
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

windowsTest('keeper fixture: an uncertain control result retains error category and stderr', async t => {
  const c = helpers.makeCase('keeper-control-error');t.after(() => c.cleanup());
  const assemblyPath = path.join(c.base, 'control.dll');fs.writeFileSync(assemblyPath, 'fixture');
  mockedControl(t, (_script, _options, done) => done(Object.assign(Error('deadline'), {killed:true, signal:'SIGTERM',code:null}), 'partial output', 'diagnostic stderr'));
  const out = await helpers.suspendProcess(77, 'ms:2000', false, {assemblyPath});
  assert.equal(out.ok, false);
  assert.equal(out.failure, 'control-timeout');
  assert.match(out.output, /partial output/);assert.match(out.output, /diagnostic stderr/);assert.match(out.output, /SIGTERM/);
});

windowsTest('keeper fixture: an identity mismatch refuses control before the native command', async t => {
  let calls = 0;
  mockedControl(t, () => {calls++;throw Error('must not control an unrelated incarnation');});
  const out = await helpers.suspendProcess(77, 'ms:3000', false, {assemblyPath:'unused'});
  assert.equal(out.ok, false);assert.equal(out.verdict, 'mismatch');assert.equal(calls, 0);
});

windowsTest('keeper fixture: preparation has a separate bounded compilation budget', async t => {
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

windowsTest('keeper fixture: native mismatch and nonzero NTSTATUS never report success', async t => {
  const c = helpers.makeCase('keeper-control-native-refusal');t.after(() => c.cleanup());
  const assemblyPath = path.join(c.base, 'control.dll');fs.writeFileSync(assemblyPath, 'fixture');
  let code = 4;
  mockedControl(t, (_script, _options, done) => done(Object.assign(Error('native refusal'), {code}), code === 4 ? 'identity=mismatch\r\n' : 'rc=-1\r\n', ''));
  for (code of [4,5]) {
    const out = await helpers.suspendProcess(77, 'ms:2000', false, {assemblyPath});
    assert.equal(out.ok, false);assert.equal(out.failure, code === 4 ? 'identity-mismatch' : 'control-error');
    assert.equal(out.verdict, code === 4 ? 'mismatch' : 'match');
    assert.match(out.output, code === 4 ? /identity=mismatch/ : /rc=-1/);
  }
});

windowsTest('keeper fixture: absent preparation refuses without a native control command', async t => {
  let controls = 0;mockedControl(t, () => {controls++;throw Error('must not execute');});
  for (const options of [{}, {assemblyPath:'missing-fixture.dll'}]) {
    const out = await helpers.suspendProcess(77, 'ms:2000', false, options);
    assert.equal(out.ok, false);assert.equal(out.failure, 'fixture-refused');
  }
  assert.equal(controls, 0);
});

test('keeper fixture: failed resume falls back to checked kill and verifies disappearance', async () => {
  const calls = [];
  const out = await helpers.releaseSuspendedProcess(77, 'ms:2000', {}, {
    resume:async () => {calls.push('resume');return {ok:false};},
    kill:async (pid, createdAt) => {assert.equal(pid,77);assert.equal(createdAt,'ms:2000');calls.push('kill');return {killed:false,verdict:'match'};},
    identity:async () => {calls.push('identity');return 'gone';},
  });
  assert.equal(out.ok, true);assert.equal(out.identityAfter,'gone');assert.deepEqual(calls,['resume','kill','identity']);
});

test('keeper fixture: unknown cleanup remains uncertain; successful resume never kills', async () => {
  const unknown = await helpers.releaseSuspendedProcess(77, 'ms:2000', {}, {resume:async()=>({ok:false}),kill:async()=>({verdict:'unknown'}),identity:async()=> 'unknown'});
  assert.equal(unknown.ok,false);assert.equal(unknown.identityAfter,'unknown');
  const resumed = await helpers.releaseSuspendedProcess(77, 'ms:2000', {}, {resume:async()=>({ok:true}),kill:async()=>{throw Error('unnecessary kill');}});
  assert.equal(resumed.ok,true);assert.equal(resumed.method,'resumed');
});

windowsTest('keeper fixture: timeout recovery uses the prepared resume and missing confirmation stays unknown', async t => {
  const c = helpers.makeCase('keeper-control-recovery');t.after(() => c.cleanup());
  const assemblyPath = path.join(c.base, 'control.dll');fs.writeFileSync(assemblyPath,'fixture');
  let unconfirmed = false, resumed = 0;
  mockedControl(t, (script, _options, done) => {
    if (unconfirmed) return done(null, '', '');
    if (script.includes('NtResumeProcess')) {resumed++;return done(null, 'rc=0\n', '');}
    done(Object.assign(Error('timeout after uncertain action'),{killed:true}), '', '');
  });
  assert.equal((await helpers.suspendProcess(77,'ms:2000',false,{assemblyPath})).failure,'control-timeout');
  const cleanup = await helpers.releaseSuspendedProcess(77,'ms:2000',{assemblyPath});
  assert.equal(cleanup.ok,true);assert.equal(cleanup.method,'resumed');assert.equal(resumed,1);
  unconfirmed = true;
  const out = await helpers.suspendProcess(77,'ms:2000',false,{assemblyPath});
  assert.equal(out.ok,false);assert.equal(out.failure,'control-unconfirmed');
});

windowsTest('keeper fixture: compilation failure reports its cause and never retries a partial assembly', async t => {
  const c = helpers.makeCase('keeper-control-preparation-failure');t.after(() => c.cleanup());
  let calls = 0;
  mockedControl(t, (_script, _options, done) => {
    calls++;fs.writeFileSync(path.join(c.base,'orch-test-process-control.dll'),'partial');
    done(Object.assign(Error('compile timeout'),{killed:true,signal:'SIGTERM'}),'','compiler diagnostic');
  });
  await assert.rejects(helpers.prepareProcessControl(c.base),/timeout.*SIGTERM.*compiler diagnostic/);
  await assert.rejects(helpers.prepareProcessControl(c.base),/already exists/);
  assert.equal(calls,1);
});
