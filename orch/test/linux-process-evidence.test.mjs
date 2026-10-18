import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {observeDescendants,readProcessTable,verifyIdentity,ownChildCreationTime} from '../src/procs.mjs';
import {reconcileHelpers} from '../src/helper-reconciliation.mjs';
const boot='00000000-0000-4000-8000-000000000001';
const native=(at,namespace='123',system=boot)=>`linux:${system}:${namespace}:${at}`;

test('Linux ancestry compares native birth and exit clocks without treating ticks as Unix milliseconds',()=>{
  const rows=[{pid:10,ppid:1,createdAt:native(100)},{pid:11,ppid:10,createdAt:native(110)},{pid:12,ppid:10,createdAt:native(90)}];
  const live=observeDescendants(10,native(100),rows);
  assert.equal(live.state,'observed');assert.deepEqual(live.candidates.map(p=>p.pid),[11]);
  const exited=observeDescendants(10,native(100),rows.slice(1),{exitedAt:native(120)});
  assert.equal(exited.state,'observed');assert.deepEqual(exited.candidates.map(p=>p.pid),[11]);
  assert.equal(observeDescendants(10,native(100),rows,{exitedAt:'ms:200'}).state,'unknown');
  const foreign=[{pid:11,ppid:10,createdAt:native(110,'124')}];
  assert.equal(observeDescendants(10,native(100),foreign,{exitedAt:native(120)}).rootVerified,false,'an old exit cannot qualify a different PID namespace');
});

test('Linux process identity distinguishes reboot from an unreadable or foreign PID namespace',()=>{
  assert.equal(verifyIdentity(10,native(100),[{pid:10,createdAt:native(100)}]).verdict,'match');
  assert.equal(verifyIdentity(10,native(100),[{pid:10,createdAt:native(101)}]).verdict,'mismatch');
  assert.equal(verifyIdentity(10,native(100),[{pid:10,createdAt:native(100,'124')}]).verdict,'unknown');
  assert.equal(verifyIdentity(10,native(100),[{pid:10,createdAt:native(100,'123','00000000-0000-4000-8000-000000000002')}]).verdict,'mismatch');
  assert.equal(verifyIdentity(10,'ticks:100',[{pid:10,createdAt:native(100)}]).verdict,'unknown');
  assert.equal(verifyIdentity(10,'ms:100',[{pid:10,createdAt:native(100)}]).verdict,'unknown');
  assert.equal(verifyIdentity(10,native(100),[]).verdict,'unknown','a bare array has no native clock scope and cannot prove absence');
});

test('Linux malformed procfs metadata remains unknown rather than proving a process gone',{skip:process.platform!=='linux'},async t=>{
  const read=fsp.readFile.bind(fsp);mock.method(fsp,'readFile',async(file,...args)=>String(file)===`/proc/${process.pid}/stat`?'malformed':read(file,...args));t.after(()=>mock.restoreAll());
  const rows=await readProcessTable({pids:[process.pid],deadlineMs:1000});
  assert.equal(rows,null);assert.equal(verifyIdentity(process.pid,native(100),rows).verdict,'unknown');
});

test('Linux procfs permission failure cannot produce a partial table that claims absence',{skip:process.platform!=='linux'},async t=>{
  const read=fsp.readFile.bind(fsp),list=fsp.readdir.bind(fsp);
  mock.method(fsp,'readdir',async(file,...args)=>String(file)==='/proc'?[String(process.pid)]:list(file,...args));
  mock.method(fsp,'readFile',async(file,...args)=>{if(String(file)===`/proc/${process.pid}/stat`)throw Object.assign(Error('fixture denied'),{code:'EACCES'});return read(file,...args);});t.after(()=>mock.restoreAll());
  assert.equal(await readProcessTable({deadlineMs:1000}),null);
  assert.equal(await readProcessTable({pids:[process.pid],deadlineMs:1000}),null);
});

test('Linux native creation identity binds boot and PID namespace as well as start ticks',{skip:process.platform!=='linux'},async t=>{
  const child=spawn(process.execPath,['-e','process.stdin.resume();process.stdin.on("end",()=>process.exit(0));setTimeout(()=>process.exit(0),5000).unref()'],{stdio:['pipe','ignore','ignore']});
  await once(child,'spawn');t.after(()=>child.stdin.end());
  assert.match(await ownChildCreationTime(child.pid,{deadlineMs:1000}),/^linux:[0-9a-f-]{36}:\d+:\d+$/);
});

test('Linux verified helper evidence can become quiescent without upgrading legacy bare tick records',{skip:process.platform!=='linux'},async()=>{
  const identity=(await readProcessTable({pids:[process.pid],deadlineMs:1000})).find(p=>p.pid===process.pid).createdAt;
  const empty=await readProcessTable({pids:[999999],deadlineMs:1000});assert.equal(empty.length,0);assert.equal(verifyIdentity(999999,identity,empty).verdict,'gone','native empty snapshots retain their clock scope');
  const record={helper_audit:{state:'observed'},escaped_helpers:[{pid:999999,created_at:identity,ancestry:'verified',state:'gone'}]};
  assert.equal((await reconcileHelpers(record,Date.now()+2000)).state,'quiescent');
  record.escaped_helpers[0].created_at='ticks:100';
  assert.equal((await reconcileHelpers(record,Date.now()+2000)).state,'protected');
});

test('Linux procfs failures retain bounded attempt diagnostics without changing unknown evidence',{skip:process.platform!=='linux'},async t=>{
  const read=fsp.readFile.bind(fsp),failures=[];mock.method(fsp,'readFile',async(file,...args)=>{if(String(file)===`/proc/${process.pid}/stat`)throw Object.assign(Error('fixture denied'),{code:'EACCES'});return read(file,...args);});t.after(()=>mock.restoreAll());
  const rows=await readProcessTable({pids:[process.pid],deadlineMs:1000,attempts:2,onFailure:failure=>{failures.push(failure);throw Error('bookkeeping failure');}});
  assert.equal(rows,null);assert.deepEqual(failures.map(f=>f.attempt),[1,2]);assert.ok(failures.every(f=>f.reason==='linux-process-table-unreadable'&&f.elapsed_ms<=1000));
});
