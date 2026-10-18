import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { laneScope } from '../src/lanescope.mjs';
import { connectHello, probeFree, tryListen, recoverLinuxSocket } from '../src/lanepipe.mjs';
import { killChecked, ownChildCreationTime, readProcessTable, treeKillChecked, verifyIdentity } from '../src/procs.mjs';
import { resolveCliExe } from '../src/exe.mjs';
import { buildViewerAttempts } from '../src/viewer.mjs';
import { waitFor, suspendProcess, releaseSuspendedProcess, makeCase, orch, idFrom, readRunRecord, killOwnedChecked } from './helpers.mjs';

test('Linux serial lanes use a private filesystem socket and release it on close', { skip: process.platform !== 'linux' }, async (t) => {
  const scope = laneScope('local');
  assert.ok(path.isAbsolute(scope.pipeName), 'the lane address must be an absolute Unix socket path');
  assert.ok(scope.pipeName.endsWith('.sock'));
  assert.ok(scope.pipeName.length < 108, 'Unix socket path must fit Linux sockaddr_un');
  assert.equal(path.dirname(scope.pipeName), path.join('/tmp', `.orch-${process.getuid()}`));

  const bound = await tryListen(scope.pipeName);
  assert.equal(bound.ok, true, JSON.stringify(bound));
  const server = bound.server;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.on('connection', (socket) => socket.end('keeper-ready\n'));

  const dir = fs.statSync(path.dirname(scope.pipeName));
  assert.equal(dir.uid, process.getuid());
  assert.equal(dir.mode & 0o777, 0o700);
  assert.deepEqual(await probeFree(scope.pipeName), { free: false, code: 'EADDRINUSE' });
  assert.equal((await connectHello(scope.pipeName)).hello, 'keeper-ready');

  await new Promise((resolve) => server.close(resolve));
  assert.equal(fs.existsSync(scope.pipeName), false, 'closing the owner releases the socket path');
  assert.deepEqual(await probeFree(scope.pipeName), { free: true, code: null });
});

test('Linux supervisor removes its lane socket when the keeper died before supervisor startup', { skip: process.platform !== 'linux' }, async (t) => {
  const socketDir = path.join('/tmp', `.orch-${process.getuid()}`);
  const socketPath = path.join(socketDir, `lane-${process.pid}-orphan.sock`);
  const sentinel = path.join(os.tmpdir(), `orch-orphan-worker-${process.pid}-${Date.now()}`);
  const supervisorPath = fileURLToPath(new URL('../src/linux-worker-supervisor.mjs', import.meta.url));
  t.after(() => fs.rmSync(sentinel, { force: true }));

  const keeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { if (keeper.exitCode === null && keeper.signalCode === null) keeper.kill('SIGKILL'); });
  await once(keeper, 'spawn');
  const keeperIdentity = await ownChildCreationTime(keeper.pid, { deadlineMs: 1000 });
  assert.ok(/^linux:[0-9a-f-]{36}:\d+:\d+$/.test(keeperIdentity || ''), `unexpected keeper identity: ${keeperIdentity}`);
  const keeperClosed = once(keeper, 'close');
  keeper.kill('SIGKILL');
  await keeperClosed;

  const bound = await tryListen(socketPath);
  assert.equal(bound.ok, true, JSON.stringify(bound));
  t.after(() => new Promise((resolve) => bound.server.close(resolve)));
  const socket = fs.lstatSync(socketPath);
  const workerCode = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'started')`;
  const supervisor = spawn(process.execPath, [
    supervisorPath,
    process.execPath,
    JSON.stringify(['-e', workerCode]),
    String(keeper.pid),
    keeperIdentity,
    socketPath,
    String(socket.dev),
    String(socket.ino),
  ], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const [code] = await once(supervisor, 'close');

  assert.equal(code, 125, 'a dead keeper must prevent worker admission');
  assert.equal(fs.existsSync(sentinel), false, 'the requested worker must not start');
  assert.equal(fs.existsSync(socketPath), false, 'the supervisor must release only its captured socket');
});

test('Linux CLI discovery resolves executable names directly from PATH', { skip: process.platform !== 'linux' }, (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-path-test-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const cli = path.join(bin, 'codex');
  fs.writeFileSync(cli, '#!/bin/sh\\nexit 0\\n');
  fs.chmodSync(cli, 0o755);
  const notExecutable = path.join(bin, 'not-executable');
  fs.writeFileSync(notExecutable, 'data');
  fs.chmodSync(notExecutable, 0o644);
  const old = process.env.ORCH_CODEX_EXE;
  delete process.env.ORCH_CODEX_EXE;
  try {
    assert.equal(resolveCliExe('codex', { env: { ...process.env, PATH: bin } }), cli);
    assert.throws(
      () => resolveCliExe('not-executable', { env: { ...process.env, PATH: bin } }),
      (error) => error instanceof Error && 'code' in error && error.code === 'cli-not-found' && error.message.includes('<path to the executable>'),
    );
  } finally {
    if (old === undefined) delete process.env.ORCH_CODEX_EXE;
    else process.env.ORCH_CODEX_EXE = old;
  }
});

test('Linux does not attempt to open a Windows terminal viewer', { skip: process.platform !== 'linux' }, () => {
  assert.deepEqual(buildViewerAttempts({ logPath: '/tmp/run.log', pidFile: '/tmp/viewer.pid', title: 'orch run' }), []);
});

test('Linux process identity is read from /proc and a verified child can be killed', { skip: process.platform !== 'linux' }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'spawn');
  const closed = once(child, 'close');

  const createdAt = await ownChildCreationTime(child.pid, { deadlineMs: 1000 });
  assert.match(createdAt || '', /^linux:[0-9a-f-]{36}:\d+:\d+$/);
  const table = await readProcessTable({ deadlineMs: 1000, pids: [child.pid] });
  assert.equal(verifyIdentity(child.pid, createdAt, table).verdict, 'match');

  const refused = await killChecked(child.pid, createdAt.replace(/:\d+$/, ':0'), { deadlineMs: 1000 });
  assert.equal(refused.verdict, 'mismatch');
  assert.equal(refused.killed, false);
  const killed = await killChecked(child.pid, createdAt, { deadlineMs: 1000 });
  assert.equal(killed.killed, true, killed.output);
  await closed;
});

test('Linux refuses PID 1 cancellation without sending a signal', { skip: process.platform !== 'linux' }, async () => {
  const table = await readProcessTable({ deadlineMs: 1000, pids: [1] });
  const init = table?.find((proc) => proc.pid === 1);
  assert.ok(init, 'PID 1 must be visible to validate the dangerous signal target');
  const createdAt = init.createdAt;
  assert.match(createdAt || '', /^linux:[0-9a-f-]{36}:\d+:\d+$/);
  assert.equal(verifyIdentity(1, createdAt, table).verdict, 'match');

  /** @type {Array<[number, unknown]>} */
  const calls = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    return true;
  };
  try {
    const result = await killChecked(1, createdAt, { table });
    assert.equal(result.killed, false, result.output);
    assert.deepEqual(calls, [], 'unsafe PID 1 must be rejected before process.kill(1, ...)');
  } finally {
    process.kill = originalKill;
  }
});

test('Linux refuses PID 1 group cancellation instead of signaling process group -1', { skip: process.platform !== 'linux' }, async (t) => {
  const table = await readProcessTable({ deadlineMs: 1000, pids: [1] });
  const init = table?.find((proc) => proc.pid === 1);
  assert.ok(init, 'PID 1 must be visible to validate the dangerous process-group target');
  if (init.pgrp !== 1 || init.session !== 1) {
    t.skip('PID 1 is not a session leader in this Linux environment');
    return;
  }
  const createdAt = init.createdAt;
  assert.match(createdAt || '', /^linux:[0-9a-f-]{36}:\d+:\d+$/);
  assert.equal(verifyIdentity(1, createdAt, table).verdict, 'match');

  /** @type {Array<[number, unknown]>} */
  const calls = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    return true;
  };
  try {
    const result = await treeKillChecked(1, createdAt, { deadlineMs: 1000 });
    assert.equal(result.killed, false, result.output);
    assert.deepEqual(calls, [], 'unsafe PID 1 must be rejected before process.kill(-1, ...)');
  } finally {
    process.kill = originalKill;
  }
});

test('Linux refuses process-group cancellation for a verified non-session-leader child', { skip: process.platform !== 'linux' }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'spawn');

  const createdAt = await ownChildCreationTime(child.pid, { deadlineMs: 1000 });
  assert.match(createdAt || '', /^linux:[0-9a-f-]{36}:\d+:\d+$/);
  const table = await readProcessTable({ deadlineMs: 1000, pids: [child.pid] });
  const hit = table?.find((proc) => proc.pid === child.pid);
  assert.ok(hit, 'the launched child must be present in the process table');
  assert.equal(verifyIdentity(child.pid, createdAt, table).verdict, 'match');
  assert.ok(hit.pgrp !== child.pid || hit.session !== child.pid, 'a non-detached child must not lead its own process group and session');

  /** @type {Array<[number, unknown]>} */
  const calls = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    return true;
  };
  try {
    const result = await treeKillChecked(child.pid, createdAt, { table });
    assert.equal(result.killed, false, result.output);
    assert.equal(result.verdict, 'unknown');
    assert.match(result.output, /refusing process-group kill/);
    assert.deepEqual(calls, [], 'a non-session-leader child must be rejected before process.kill');
  } finally {
    process.kill = originalKill;
  }

  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
});

test('Linux tree cancellation kills the verified worker process group', { skip: process.platform !== 'linux' }, async (t) => {
  const code = "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);";
  const root = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (root.exitCode === null && root.signalCode === null) root.kill('SIGKILL'); });
  await once(root, 'spawn');
  const grandchildPid = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('worker did not report its child pid')), 3000);
    root.stdout.on('data', (chunk) => {
      text += chunk;
      const pid = Number(text.trim().split(/\\r?\\n/)[0]);
      if (Number.isInteger(pid) && pid > 0) { clearTimeout(timer); resolve(pid); }
    });
    root.once('error', reject);
  });
  const closed = once(root, 'close');
  const table = await readProcessTable({ deadlineMs: 1000, pids: [root.pid, grandchildPid] });
  assert.equal(table?.length, 2);
  assert.equal(table.find((p) => p.pid === root.pid).pgrp, root.pid);
  assert.equal(table.find((p) => p.pid === grandchildPid).pgrp, root.pid);
  const createdAt = await ownChildCreationTime(root.pid, { deadlineMs: 1000 });
  const result = await treeKillChecked(root.pid, createdAt, { deadlineMs: 1000 });
  assert.equal(result.killed, true, result.output);
  await closed;
});


test('Linux supervisor preserves a live worker when keeper procfs reads are denied', {skip:process.platform!=='linux'}, async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'orch-supervisor-read-'));
  const marker=path.join(base,'deny'),started=path.join(base,'started');
  const keeper=spawn(process.execPath,['-e','process.stdin.resume();process.stdin.on("end",()=>process.exit(0));setTimeout(()=>process.exit(0),15000).unref()'],{stdio:['pipe','ignore','ignore']});
  await once(keeper,'spawn');
  const keeperClosed=once(keeper,'close');
  const identity=await ownChildCreationTime(keeper.pid,{deadlineMs:1000});
  const supervisorPath=fileURLToPath(new URL('../src/linux-worker-supervisor.mjs',import.meta.url));
  const loader=fileURLToPath(new URL('./fixtures/proc-read-failure.mjs',import.meta.url));
  const code='require("node:fs").writeFileSync('+JSON.stringify(started)+',"started");setInterval(()=>{},1000)';
  const supervisor=spawn(process.execPath,['--import',loader,supervisorPath,process.execPath,JSON.stringify(['-e',code]),String(keeper.pid),identity,'','',''],{
    detached:true,env:{...process.env,ORCH_TEST_KEEPER_PID:String(keeper.pid),ORCH_TEST_PROC_FAILURE:marker},stdio:['ignore','ignore','ignore','pipe'],
  });
  const closed=once(supervisor,'close');let status='';supervisor.stdio[3].on('data',chunk=>status+=chunk);
  t.after(async()=>{
    fs.rmSync(marker,{force:true});keeper.stdin.end();
    await keeperClosed;
    if(supervisor.exitCode===null&&supervisor.signalCode===null){
      const done=await Promise.race([closed.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),3000))]);
      if(!done) await treeKillChecked(supervisor.pid,await ownChildCreationTime(supervisor.pid),{deadlineMs:1000});
    }
    fs.rmSync(base,{recursive:true,force:true});
  });
  await waitFor(()=>status.includes('READY')&&fs.existsSync(started),{timeoutMs:5000,what:'supervisor worker admission'});
  fs.writeFileSync(marker,'deny keeper read');
  await waitFor(()=>fs.existsSync(marker+'.observed'),{timeoutMs:3000,what:'injected keeper read refusal'});
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(keeper.exitCode,null);assert.equal(supervisor.exitCode,null);assert.equal(supervisor.signalCode,null);
  // Once reads recover, positive keeper exit must still terminate the worker group.
  fs.rmSync(marker);keeper.stdin.end();await keeperClosed;
  await waitFor(()=>supervisor.signalCode!==null||supervisor.exitCode!==null,{timeoutMs:3000,what:'supervisor notices positive keeper exit'});
  await closed;assert.equal(supervisor.signalCode,'SIGKILL');
});

test('Linux fixture control stops and resumes only its recorded child incarnation', {skip:process.platform!=='linux'}, async t=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  await once(child,'spawn');const closed=once(child,'close');
  const identity=await ownChildCreationTime(child.pid,{deadlineMs:1000});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){await releaseSuspendedProcess(child.pid,identity);await killChecked(child.pid,identity,{deadlineMs:1000});}
    await closed;
  });
  const state=()=>{
    const raw=fs.readFileSync('/proc/'+child.pid+'/stat','utf8');return raw.slice(raw.lastIndexOf(')')+1).trim().split(/\s+/)[0];
  };
  const refused=await suspendProcess(child.pid,identity.replace(/:\d+$/,':0'));
  assert.equal(refused.ok,false);assert.equal(refused.verdict,'mismatch');assert.notEqual(state(),'T');
  assert.equal((await suspendProcess(child.pid,identity)).ok,true);
  await waitFor(()=>state()==='T',{timeoutMs:2000,what:'owned child stopped'});
  assert.equal((await releaseSuspendedProcess(child.pid,identity)).method,'resumed');
  await waitFor(()=>state()!=='T',{timeoutMs:2000,what:'owned child resumed'});
});


test('Linux startup uncertainty preserves a live lane until its owner closes it', {skip:process.platform!=='linux',timeout:15000}, async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'orch-startup-lane-')),marker=path.join(base,'deny'),started=path.join(base,'started');
  const socket=path.join('/tmp','.orch-'+process.getuid(),'lane-startup-'+process.pid+'.sock');
  const keeper=spawn(process.execPath,['-e','process.stdin.resume();process.stdin.on("end",()=>process.exit(0));setTimeout(()=>process.exit(0),12000).unref()'],{stdio:['pipe','ignore','ignore']});
  await once(keeper,'spawn');const keeperClosed=once(keeper,'close'),identity=await ownChildCreationTime(keeper.pid,{deadlineMs:1000});
  const first=await tryListen(socket);assert.equal(first.ok,true);const inode=fs.lstatSync(socket);
  t.after(async()=>{keeper.stdin.end();await keeperClosed;if(first.server.listening)await new Promise(resolve=>first.server.close(resolve));fs.rmSync(base,{recursive:true,force:true});});
  fs.writeFileSync(marker,'refuse keeper stat');
  const supervisorPath=fileURLToPath(new URL('../src/linux-worker-supervisor.mjs',import.meta.url)),loader=fileURLToPath(new URL('./fixtures/proc-read-failure.mjs',import.meta.url));
  const workerCode='require("node:fs").writeFileSync('+JSON.stringify(started)+',"started")';
  const supervisor=spawn(process.execPath,['--import',loader,supervisorPath,process.execPath,JSON.stringify(['-e',workerCode]),String(keeper.pid),identity,socket,String(inode.dev),String(inode.ino)],{detached:true,env:{...process.env,ORCH_TEST_KEEPER_PID:String(keeper.pid),ORCH_TEST_PROC_FAILURE:marker},stdio:['ignore','ignore','ignore','pipe']});
  supervisor.stdio[3].on('data',()=>{});const [code]=await once(supervisor,'close');assert.equal(code,125);assert.ok(fs.existsSync(marker+'.observed'));assert.equal(keeper.exitCode,null);assert.equal(fs.existsSync(started),false);
  assert.ok(fs.existsSync(socket),'unreadable keeper metadata must not unlink its live lane');assert.equal(fs.lstatSync(socket).ino,inode.ino);
  const contender=await tryListen(socket);if(contender.ok)t.after(()=>new Promise(resolve=>contender.server.close(resolve)));assert.equal(contender.ok,false);assert.equal(contender.code,'EADDRINUSE');
  await new Promise(resolve=>first.server.close(resolve));const next=await tryListen(socket);assert.equal(next.ok,true,'the owner releases its lane on close');await new Promise(resolve=>next.server.close(resolve));
});

test('Linux lane path ignores inherited temporary-directory settings', {skip:process.platform!=='linux'},()=>{
  const module=new URL('../src/lanescope.mjs',import.meta.url).href,code='import {laneScope} from '+JSON.stringify(module)+';console.log(laneScope().pipeName)';
  const first=execFileSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'}).trim();
  const second=execFileSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,TMPDIR:'/tmp/other-runtime',TMP:'/tmp/another-runtime',TEMP:'/tmp/third-runtime'}}).trim();
  assert.equal(second,first,'one account must retain one lane across inherited temp settings');
});

test('Linux supervisor signal preserves the live keeper lane', {skip:process.platform!=='linux',timeout:15000},async t=>{
  const socket=path.join('/tmp','.orch-'+process.getuid(),'lane-signal-'+process.pid+'.sock'),keeper=spawn(process.execPath,['-e','process.stdin.resume();process.stdin.on("end",()=>process.exit(0));setTimeout(()=>process.exit(0),12000).unref()'],{stdio:['pipe','ignore','ignore']});
  await once(keeper,'spawn');const keeperClosed=once(keeper,'close'),identity=await ownChildCreationTime(keeper.pid,{deadlineMs:1000});
  const first=await tryListen(socket);assert.equal(first.ok,true);const inode=fs.lstatSync(socket);
  t.after(async()=>{keeper.stdin.end();await keeperClosed;if(first.server.listening)await new Promise(resolve=>first.server.close(resolve));});
  const supervisor=spawn(process.execPath,[fileURLToPath(new URL('../src/linux-worker-supervisor.mjs',import.meta.url)),process.execPath,JSON.stringify(['-e','setInterval(()=>{},1000)']),String(keeper.pid),identity,socket,String(inode.dev),String(inode.ino)],{detached:true,stdio:['ignore','ignore','ignore','pipe']});
  const closed=once(supervisor,'close');await once(supervisor.stdio[3],'data');supervisor.kill('SIGTERM');await closed;
  assert.equal(keeper.exitCode,null);assert.ok(fs.existsSync(socket),'supervisor signals must not unlink its live keeper listener');assert.equal(fs.lstatSync(socket).ino,inode.ino);
  const contender=await tryListen(socket);if(contender.ok)t.after(()=>new Promise(resolve=>contender.server.close(resolve)));assert.equal(contender.ok,false);assert.equal(contender.code,'EADDRINUSE');
});

test('Linux post-bind admission failure closes its lane before exiting', {skip:process.platform!=='linux',timeout:15000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-admission-failure-')),socket=path.join('/tmp','.orch-'+process.getuid(),'lane-admission-'+process.pid+'.sock');
  t.after(()=>{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(socket,{force:true});});
  fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify({launch:{exe:process.execPath,args:['-e',''],prompt:path.join(dir,'missing'),stdout:path.join(dir,'stdout.log'),stderr:path.join(dir,'stderr.log'),pipe_name:socket,lane_exclusive:true}}));
  const keeper=spawn(process.execPath,[fileURLToPath(new URL('../src/keeper.mjs',import.meta.url)),'--id','fixture-admission-failure','--run-dir',dir],{stdio:'ignore'});const [code]=await once(keeper,'close');assert.equal(code,8);
  assert.equal(fs.existsSync(socket),false,'post-bind failure must release its listener path');const next=await tryListen(socket);assert.equal(next.ok,true);await new Promise(resolve=>next.server.close(resolve));
});

test('Linux monitor reacquires its lock after a bound monitor dies', {skip:process.platform!=='linux',timeout:30000},async t=>{
  const c=makeCase('linux-monitor-restart'),release=path.join(c.base,'release-worker');t.after(()=>{fs.writeFileSync(release,'release');c.cleanup();});
  const launch=await orch(['run','--cli','fake','--dir',c.work,'--handoff',c.handoffPath,'--lane','cloud','--no-window','--flag','--wait-for-file','--flag',release],c.env);assert.equal(launch.code,0,launch.stdout+launch.stderr);const id=idFrom(launch.stdout),dir=path.join(c.stateRoot,'runs',id),alive=path.join(dir,'monitor.alive');
  const original=await waitFor(()=>{try{return JSON.parse(fs.readFileSync(alive,'utf8'));}catch{return null;}},{timeoutMs:10000,what:'the first monitor to bind'});
  const spawned=JSON.parse(fs.readFileSync(path.join(dir,'spawned.json'),'utf8')),table=await readProcessTable({pids:[original.pid]});const birth=table?.find(row=>row.pid===original.pid)?.createdAt;assert.ok(birth);
  assert.equal(original.pid,spawned.monitor_pid);const killed=await killOwnedChecked(original.pid,birth);assert.equal(killed.killed,true);
  const restart=await orch(['monitor',id,'--json'],c.env);assert.equal(restart.code,0,restart.stdout+restart.stderr);
  const successor=await waitFor(()=>{try{const next=JSON.parse(fs.readFileSync(alive,'utf8'));return next.pid!==original.pid?next:null;}catch{return null;}},{timeoutMs:10000,what:'a successor monitor to bind the exact same lock'});assert.notEqual(successor.pid,original.pid);
  fs.writeFileSync(release,'release');await waitFor(()=>readRunRecord(c.stateRoot,id)?.status==='completed',{timeoutMs:10000,what:'the replacement monitor to finalize the run'});
});

test('Linux socket recovery preserves live owners and incomplete or changed evidence', {skip:process.platform!=='linux'},async t=>{
  const socket=path.join('/tmp','.orch-'+process.getuid(),'lane-recovery-'+process.pid+'.sock'),bound=await tryListen(socket);assert.equal(bound.ok,true);t.after(()=>new Promise(resolve=>bound.server.close(resolve)));
  const ownerFile=socket+'.owner.json',raw=fs.readFileSync(ownerFile,'utf8'),owner=JSON.parse(raw),inode=fs.lstatSync(socket,{bigint:true}).ino;
  assert.equal((await recoverLinuxSocket(socket)).state,'held');
  assert.equal((await recoverLinuxSocket(socket,{readTable:async()=>null})).state,'unknown');
  for(const changed of [{...owner,ino:String(BigInt(owner.ino)+1n)},{...owner,createdAt:'ticks:1'},{...owner,netns:'net:[1]'},{...owner,pid:999999,createdAt:undefined}]){
    fs.writeFileSync(ownerFile,JSON.stringify(changed));assert.equal((await recoverLinuxSocket(socket)).state,'unknown');assert.equal(fs.lstatSync(socket,{bigint:true}).ino,inode);fs.writeFileSync(ownerFile,raw);
  }
  fs.unlinkSync(ownerFile);assert.equal((await recoverLinuxSocket(socket)).state,'unknown');assert.ok(fs.existsSync(socket));fs.writeFileSync(ownerFile,raw);
});

test('Linux gc recovers a recorded lane after keeper death before supervisor startup', {skip:process.platform!=='linux',timeout:30000},async t=>{
  const c=makeCase('linux-early-keeper'),id='fixture-early-keeper',dir=path.join(c.stateRoot,'runs',id);fs.mkdirSync(dir,{recursive:true});
  const loader=path.join(c.base,'pause-prompt.mjs');fs.writeFileSync(loader,'import fs from "node:fs";const open=fs.openSync;fs.openSync=function(file,...args){if(String(file)===process.env.ORCH_TEST_PAUSE_PROMPT)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);return open.call(this,file,...args)};');
  fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify({id,status:'running',lane:'local',launch:{exe:process.execPath,args:['-e',''],prompt:c.handoffPath,stdout:path.join(dir,'stdout.log'),stderr:path.join(dir,'stderr.log'),pipe_name:c.lanePipe,lane_exclusive:true,lane_holder:path.join(c.laneDirLocal,'holder.json')}}));
  const keeper=spawn(process.execPath,['--import',loader,fileURLToPath(new URL('../src/keeper.mjs',import.meta.url)),'--id',id,'--run-dir',dir],{env:{...c.env,ORCH_TEST_PAUSE_PROMPT:c.handoffPath},stdio:'ignore'}),closed=once(keeper,'close');
  await once(keeper,'spawn');const birth=await ownChildCreationTime(keeper.pid,{deadlineMs:1000});assert.ok(birth);t.after(async()=>{if(keeper.exitCode===null&&keeper.signalCode===null){await killOwnedChecked(keeper.pid,birth);await closed;}c.cleanup();});
  const owner=await waitFor(()=>{try{return JSON.parse(fs.readFileSync(c.lanePipe+'.owner.json','utf8'));}catch{return null;}},{timeoutMs:5000,what:'the keeper socket receipt before supervisor startup'});assert.equal(owner.pid,keeper.pid);
  assert.equal((await killOwnedChecked(keeper.pid,birth)).killed,true);await closed;assert.ok(fs.existsSync(c.lanePipe));
  const gc=await orch(['gc','--json'],c.env);assert.equal(gc.code,0,gc.stdout+gc.stderr);assert.ok(JSON.parse(gc.stdout).removed.includes(c.lanePipe));assert.ok(fs.existsSync(path.join(dir,'run.json')),'historical run evidence retained');
  const next=await tryListen(c.lanePipe);assert.equal(next.ok,true);await new Promise(resolve=>next.server.close(resolve));
});

test('Linux supervisor distinguishes adjacent socket inodes above Number precision', {skip:process.platform!=='linux',timeout:15000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-wide-inode-')),socket=path.join('/tmp','.orch-'+process.getuid(),'lane-wide-'+process.pid+'.sock'),started=path.join(dir,'started'),loader=path.join(dir,'wide-inode.mjs');
  fs.writeFileSync(loader,'import fs from "node:fs";const read=fs.lstatSync;fs.lstatSync=function(file,opts){const stat=read.call(this,file,opts);return String(file)===process.env.ORCH_TEST_SOCKET_PATH?new Proxy(stat,{get(target,key){if(key==="ino")return opts?.bigint?9007199254740993n:Number(9007199254740993n);return Reflect.get(target,key)}}):stat};');
  const keeper=spawn(process.execPath,['-e','process.stdin.resume();process.stdin.on("end",()=>process.exit(0));setTimeout(()=>process.exit(0),12000).unref()'],{stdio:['pipe','ignore','ignore']});await once(keeper,'spawn');const keeperClosed=once(keeper,'close'),birth=await ownChildCreationTime(keeper.pid,{deadlineMs:1000});
  const bound=await tryListen(socket);assert.equal(bound.ok,true);const inode=fs.lstatSync(socket,{bigint:true});t.after(async()=>{keeper.stdin.end();await keeperClosed;await new Promise(resolve=>bound.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const supervisor=spawn(process.execPath,['--import',loader,fileURLToPath(new URL('../src/linux-worker-supervisor.mjs',import.meta.url)),process.execPath,JSON.stringify(['-e','require("node:fs").writeFileSync('+JSON.stringify(started)+',"started")']),String(keeper.pid),birth,socket,String(inode.dev),'9007199254740992'],{detached:true,env:{...process.env,ORCH_TEST_SOCKET_PATH:socket},stdio:['ignore','ignore','ignore','pipe']});supervisor.stdio[3].on('data',()=>{});const [code]=await once(supervisor,'close');assert.equal(code,125);assert.equal(fs.existsSync(started),false);assert.ok(fs.existsSync(socket));
});

test('Linux keeper records an exit delivered before buffered supervisor READY data', {skip:process.platform!=='linux',timeout:15000},async t=>{
  const c=makeCase('linux-delayed-ready'),dir=path.join(c.base,'run'),loader=path.join(c.base,'delay.mjs'),marker=path.join(c.base,'order');fs.mkdirSync(dir);
  fs.writeFileSync(loader,'import cp from "node:child_process";import fs from "node:fs";import {syncBuiltinESMExports} from "node:module";const spawn=cp.spawn;cp.spawn=function(exe,args,opts){const child=spawn(exe,args,opts);if(String(args?.[0]).endsWith("linux-worker-supervisor.mjs")){const pipe=child.stdio[3],on=pipe.on;pipe.on=function(event,fn){const answer=on.call(this,event,fn);if(event==="data")process.nextTick(()=>this.pause());return answer};on.call(pipe,"data",()=>fs.appendFileSync(process.env.ORCH_TEST_ORDER,"data\\n"));child.once("exit",()=>{fs.appendFileSync(process.env.ORCH_TEST_ORDER,"exit\\n");setTimeout(()=>pipe.resume(),100)})}return child};syncBuiltinESMExports();');
  fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify({launch:{exe:process.execPath,args:['-e','console.log("finished")'],prompt:c.handoffPath,stdout:path.join(dir,'stdout.log'),stderr:path.join(dir,'stderr.log'),pipe_name:c.lanePipe,lane_exclusive:true}}));
  const keeper=spawn(process.execPath,['--import',loader,fileURLToPath(new URL('../src/keeper.mjs',import.meta.url)),'--id','fixture-delayed-ready','--run-dir',dir],{env:{...c.env,ORCH_TEST_ORDER:marker},stdio:'ignore'});await once(keeper,'spawn');const closed=once(keeper,'close'),birth=await ownChildCreationTime(keeper.pid,{deadlineMs:1000});assert.ok(birth);
  t.after(async()=>{if(keeper.exitCode===null&&keeper.signalCode===null){assert.equal((await killOwnedChecked(keeper.pid,birth)).killed,true);await closed;}c.cleanup();});
  await waitFor(()=>keeper.exitCode!==null||keeper.signalCode!==null,{timeoutMs:5000,what:'the keeper to preserve the deferred real exit'});await closed;assert.equal(keeper.exitCode,0);assert.equal(fs.readFileSync(marker,'utf8'),'exit\ndata\n');
  const lines=fs.readFileSync(path.join(dir,'keeper.ndjson'),'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(lines.filter(row=>row.event==='worker-exit').length,1);assert.equal(lines.find(row=>row.event==='worker-exit').code,0);assert.equal(fs.existsSync(c.lanePipe),false);
});

test('Linux close fallbacks bound admission failure and monitor exit', {skip:process.platform!=='linux',timeout:20000},async t=>{
  for(const kind of ['keeper','monitor']){
    const c=makeCase('linux-close-'+kind),id='fixture-close-'+kind,dir=path.join(c.stateRoot,'runs',id),loader=path.join(c.base,'stuck-close.mjs');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(loader,'import net from "node:net";import {syncBuiltinESMExports} from "node:module";const create=net.createServer;net.createServer=function(...args){const server=create(...args),close=server.close;server.close=function(){setInterval(()=>{},1000);return close.call(this,()=>{})};return server};syncBuiltinESMExports();');
    const record=kind==='keeper'?{id,status:'running',launch:{exe:process.execPath,args:['-e',''],prompt:path.join(c.base,'missing'),stdout:path.join(dir,'stdout.log'),stderr:path.join(dir,'stderr.log'),pipe_name:c.lanePipe,lane_exclusive:true}}:{id,status:'completed',cli:'fake',lane:'cloud',dir:c.work,dir_real:c.work,started_at:new Date().toISOString()};
    fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify(record));fs.writeFileSync(path.join(dir,'prompt.txt'),'fixture');fs.writeFileSync(path.join(dir,'stdout.log'),'finished\n');fs.writeFileSync(path.join(dir,'stderr.log'),'');if(kind==='monitor')fs.writeFileSync(path.join(dir,'keeper.ndjson'),JSON.stringify({event:'worker-exit',code:0,at:new Date().toISOString()})+'\n'+JSON.stringify({event:'keeper-exit',write_failures:0})+'\n');
    const child=spawn(process.execPath,['--import',loader,fileURLToPath(new URL('../src/'+kind+'.mjs',import.meta.url)),'--state-root',c.stateRoot,'--id',id,'--run-dir',dir],{env:c.env,stdio:'ignore'});await once(child,'spawn');const closed=once(child,'close'),birth=await ownChildCreationTime(child.pid,{deadlineMs:1000});assert.ok(birth);
    t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){assert.equal((await killOwnedChecked(child.pid,birth)).killed,true);await closed;}c.cleanup();});
    await waitFor(()=>child.exitCode!==null||child.signalCode!==null,{timeoutMs:4500,what:kind+' to exit despite a stuck socket close callback'});await closed;assert.equal(child.exitCode,kind==='keeper'?8:0);
  }
});
