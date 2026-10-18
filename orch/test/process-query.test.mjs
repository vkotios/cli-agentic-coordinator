import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readProcessTable,verifyIdentity} from '../src/procs.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFile,spawn} from 'node:child_process';

// Exercise the keeper's real narrow function without executing its admission loop.
const keeperSource=fs.readFileSync(new URL('../src/keeper.mjs',import.meta.url),'utf8');
const captureSource=keeperSource.slice(keeperSource.indexOf('function captureWorkerIdentity('),keeperSource.indexOf('\nfunction closeFds('));
async function captureIdentity({stdout='',error=null,exited=false,pid=42,parent=43,native=false,spawnFailure=false}={}){
  const events=[];let command;
  await new Promise(resolve=>{
    const context=vm.createContext({process:{platform:'win32',pid:parent},workerExited:exited,F:{keeper:'keeper.ndjson'},nowIso:()=>new Date().toISOString(),
      append:(_file,event)=>events.push(event),execFile:(exe,args,options,callback)=>{
        command=args.at(-1);
        assert.equal(options.timeout,5000,'the identity read must stay bounded');
        if(spawnFailure){queueMicrotask(()=>resolve());throw Error('spawn unavailable');}
        if(native)return execFile(exe,[...args.slice(0,-1),"function Get-CimInstance { throw 'CIM deliberately unavailable' }; "+command],options,(err,out)=>{callback(err,out);resolve();});
        queueMicrotask(()=>{callback(error,stdout);resolve();});return {on(){}};
      }});
    vm.runInContext(captureSource+'\ncaptureWorkerIdentity('+pid+');',context);
  });
  return {events:events.filter(event=>event.event==='worker-identity'),diagnostics:events.filter(event=>event.event!=='worker-identity'),command};
}

test('keeper captures its live child without the CIM provider',async()=>{
  const result=await captureIdentity({stdout:'ORCH_WORKER:42:43:1700000000123'});
  assert.doesNotMatch(result.command,/Get-CimInstance/);
  assert.equal(result.events[0]?.worker_created_at,'ms:1700000000123');
  assert.equal(result.events[0]?.worker_pid,42);
});

test('keeper never records foreign, malformed, failed or exited-child identity evidence',async()=>{
  for(const value of ['ORCH_WORKER:99:43:1700000000123','ORCH_WORKER:42:99:1700000000123','ORCH_WORKER:42:43:-1','ORCH_WORKER:42:43:9007199254740992','prefix ORCH_WORKER:42:43:1700000000123','ORCH_WORKER:42:43:1700000000123 suffix','not evidence']){
    assert.equal((await captureIdentity({stdout:value})).events.length,0,value);
  }
  for(const error of [Object.assign(Error('timeout'),{killed:true}),Error('query failed')]){
    assert.equal((await captureIdentity({stdout:'ORCH_WORKER:42:43:1700000000123',error})).events.length,0);
  }
  assert.equal((await captureIdentity({stdout:'ORCH_WORKER:42:43:1700000000123',exited:true})).events.length,0);
  assert.equal((await captureIdentity({spawnFailure:true})).events.length,0);
});

test('keeper reads a genuine Windows child birth and parent with CIM unavailable',{skip:process.platform!=='win32',timeout:15000},async()=>{
  const child=spawn(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setTimeout(()=>process.exit(1),12000).unref()"],{windowsHide:true});
  const closed=new Promise(resolve=>child.once('close',resolve));
  try{
    const result=await captureIdentity({pid:child.pid,parent:process.pid,native:true});
    assert.equal(result.events.length,1,'the live child must have a keeper-bound native identity even when CIM fails');
    const stamp=result.events[0].worker_created_at;
    assert.match(stamp,/^ms:\d+$/);
    const observed=await readProcessTable({pids:[child.pid]});
    assert.equal(verifyIdentity(child.pid,stamp,observed).verdict,'match','native handle birth must equal the independent OS table');
    assert.equal((await captureIdentity({pid:child.pid,parent:process.pid+1,native:true})).events.length,0,'the native handle query itself must refuse a foreign parent');
  }finally{child.stdin.end();await closed;}
});

test('unreadable process queries retain bounded failure reasons without inventing liveness',async()=>{
  for(const result of [{raw:null,failure:{reason:'query-timeout',code:null,signal:'SIGTERM'}},{raw:null,failure:{reason:'query-error',code:'ENOENT',signal:null}},{raw:'not json',failure:null}]){
    const failures=[];
    const table=await readProcessTable({attempts:1,onFailure:f=>failures.push(f)},{query:async()=>result});
    assert.equal(table,null);
    assert.equal(verifyIdentity(42,'ms:1',table).verdict,'unknown');
    assert.equal(failures.length,1);
    assert.equal(failures[0].reason,result.failure?.reason??'invalid-json');
    assert.equal('raw' in failures[0],false);
    assert.equal('stderr' in failures[0],false);
  }
});

test('a failed query can recover within its existing budget and diagnostics cannot break a read',async()=>{
  let calls=0;const failures=[];
  const table=await readProcessTable({onFailure:f=>failures.push(f)},{query:async()=>++calls===1?{raw:null,failure:{reason:'query-error',code:1,signal:null}}:{raw:'{"ProcessId":42,"ParentProcessId":1,"Name":"test","CreationDate":"ms:1"}',failure:null}});
  assert.equal(calls,2);assert.equal(failures.length,1);assert.equal(verifyIdentity(42,'ms:1',table).verdict,'match');
  assert.equal(await readProcessTable({attempts:1,onFailure:()=>{throw Error('diagnostics unavailable');}},{query:async()=>({raw:null,failure:{reason:'query-timeout'}})}),null);
});
