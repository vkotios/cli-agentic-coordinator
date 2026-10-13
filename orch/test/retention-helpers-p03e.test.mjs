// Disposable fixtures only: helper reconciliation never kills or rewrites a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { makeCase, waitFor } from './helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import { cmdMaintain, quiescent } from '../src/retention.mjs';
import { dependentRunBlock } from '../src/resources.mjs';
import { readArchived } from '../src/archive.mjs';
import { ownChildCreationTime } from '../src/procs.mjs';
import { once } from 'node:events';

const old='2026-01-01T00:00:00.000Z',pid=424242;
function fixture(t,name){
  const c=makeCase(name,{config:{retention:{mode:'manual',successDays:0,otherDays:0,maxMs:10000,metadata:{enabled:true,successDays:0,otherDays:0}}}});t.after(()=>c.cleanup());
  const id='20260101-000000-abc123',dir=path.join(c.stateRoot,'runs',id);fs.mkdirSync(dir,{recursive:true});
  const rec={id,cli:'fake',lane:'cloud',status:'completed',exit_code:0,created_at:old,ended_at:old,dir:c.work,helper_audit:{state:'observed',checked_at:old},escaped_helpers:[{pid,created_at:old,ancestry:'verified',state:'alive',name:'fixture-helper'}]};
  fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify(rec));
  for(const [file,text] of Object.entries({'stdout.log':'fixture final answer\n','stderr.log':'','prompt.txt':'fixture handoff','events.monitor.ndjson':'{}\n','keeper.ndjson':[{event:'worker-exit',at:old,code:0},{event:'streams-closed',at:old},{event:'keeper-exit',at:old,write_failures:0}].map(v=>JSON.stringify(v)).join('\n')+'\n'}))fs.writeFileSync(path.join(dir,file),text);
  fs.writeFileSync(path.join(c.stateRoot,'ledger.jsonl'),JSON.stringify({run_id:id,disposition:'blocked',recorded_at:old})+'\n');
  return {c,id,dir,rec,cfg:loadConfig(c.stateRoot),resource:{id:'fixture-resource',path:c.work}};
}
function processFixture(t){
  const original=cp.execFile,state={mode:'gone',queries:[],unexpected:[]};
  cp.execFile=/** @type {any} */((exe,args,opts,cb)=>{
    if(exe!=='powershell.exe'||!String(args.at(-1)).includes('Get-CimInstance Win32_Process')){state.unexpected.push(exe);return original(exe,args,opts,cb);}
    state.queries.push(String(args.at(-1)));const child=/** @type {any} */(new EventEmitter());child.kill=()=>true;
    setImmediate(()=>{const rows=state.mode==='gone'?[]:[{ProcessId:state.mode==='invalid-pid'?'broken':pid,ParentProcessId:1,CreationDate:state.mode==='mismatch'?'2026-06-01T00:00:00.000Z':state.mode==='missing-birth'?null:state.mode==='invalid-birth'?'broken':state.mode==='padded-birth'?'ms:0'+Date.parse(old):old,Name:'fixture-helper'}];cb(state.mode==='unknown'?new Error('fixture unavailable'):null,state.mode==='unknown'?'':JSON.stringify(rows),'');child.emit('close',0);});return child;
  });syncBuiltinESMExports();t.after(()=>{cp.execFile=original;syncBuiltinESMExports();});return state;
}
const maintain=(f,args)=>cmdMaintain(f.cfg,args,{log(){}});
async function enroll(f){return maintain(f,{enroll:f.id,by:'fixture-owner',reason:'disposable fixture'});}

for(const mode of ['gone','mismatch'])test(`P03e: ${mode} helper incarnation permits quiescence without rewriting original audit`,async t=>{
  const f=fixture(t,'p03e-'+mode),state=processFixture(t);state.mode=mode;const before=fs.readFileSync(path.join(f.dir,'run.json'));
  assert.equal(await quiescent(f.cfg,f.rec,Date.now()+4000),null);assert.ok(state.queries.length);assert.match(state.queries[0],/ProcessId=424242/);assert.deepEqual(state.unexpected,[]);assert.deepEqual(fs.readFileSync(path.join(f.dir,'run.json')),before);assert.equal(f.rec.escaped_helpers[0].state,'alive');
});
for(const mode of ['match','unknown','missing-birth','invalid-birth','invalid-pid'])test(`P03e: ${mode} helper protects transcripts and worktree cleanup`,async t=>{
  const f=fixture(t,'p03e-protect-'+mode),state=processFixture(t);state.mode=mode;
  assert.match(await quiescent(f.cfg,f.rec,Date.now()+4000),/helper.*live|helper.*uncertain/i);
  assert.match(await dependentRunBlock(f.cfg,f.resource),/helper/i);assert.deepEqual(state.unexpected,[]);assert.ok(fs.existsSync(path.join(f.dir,'stdout.log')));
});
test('P03e: unknown historical ancestry and malformed identities never become disposable from an empty table',async t=>{
  const f=fixture(t,'p03e-uncertain'),state=processFixture(t);
  const cases=[{helper_audit:{state:'unknown'}},{helper_audit:null},{helper_audit:undefined},{helper_audit:{state:'not-applicable'}},{escaped_helpers:null},{escaped_helpers:[null]},{escaped_helpers:[{...f.rec.escaped_helpers[0],pid:-1}]},{escaped_helpers:[{...f.rec.escaped_helpers[0],pid:'424242'}]},{escaped_helpers:[{...f.rec.escaped_helpers[0],created_at:null}]},{escaped_helpers:[{...f.rec.escaped_helpers[0],created_at:'not-a-date'}]},{escaped_helpers:[{...f.rec.escaped_helpers[0],ancestry:'unknown'}]},{escaped_helpers:Array.from({length:61},()=>f.rec.escaped_helpers[0])}];
  for(const change of cases){const rec={...f.rec,...change};fs.writeFileSync(path.join(f.dir,'run.json'),JSON.stringify(rec));assert.match(await quiescent(f.cfg,rec,Date.now()+4000),/helper/i,JSON.stringify(change));assert.match(await dependentRunBlock(f.cfg,f.resource),/helper/i,JSON.stringify(change));}
  assert.equal(state.queries.length,0,'incomplete historical proof must not be upgraded by a later process query');
});
test('P03e: spent maintenance budget defers helper reads',async t=>{
  const f=fixture(t,'p03e-budget'),state=processFixture(t);assert.match(await quiescent(f.cfg,f.rec,Date.now()-1),/time budget/);assert.equal(state.queries.length,0);
});
test('P03e: padded epoch strings cannot fabricate PID reuse',async t=>{
  const f=fixture(t,'p03e-padded'),state=processFixture(t);
  for(const variant of ['recorded','current']){
    const rec={...f.rec,escaped_helpers:[{...f.rec.escaped_helpers[0],created_at:variant==='recorded'?'ms:0'+Date.parse(old):old}]};state.mode=variant==='current'?'padded-birth':'match';fs.writeFileSync(path.join(f.dir,'run.json'),JSON.stringify(rec));
    assert.match(await quiescent(f.cfg,rec,Date.now()+4000),/helper/i);assert.match(await dependentRunBlock(f.cfg,f.resource),/helper/i);
  }
});
test('P03e: legacy runs without helper candidates remain compatible',async t=>{
  const f=fixture(t,'p03e-legacy');delete f.rec.helper_audit;delete f.rec.escaped_helpers;fs.writeFileSync(path.join(f.dir,'run.json'),JSON.stringify(f.rec));processFixture(t);
  assert.equal(await quiescent(f.cfg,f.rec,Date.now()+4000),null);assert.equal(await dependentRunBlock(f.cfg,f.resource),null);
});
test('P03e: preview is read-only and apply freshly protects a helper that is live or uncertain',async t=>{
  const f=fixture(t,'p03e-preview'),state=processFixture(t);await enroll(f);
  const before=fs.readFileSync(path.join(f.dir,'run.json')),names=fs.readdirSync(f.c.stateRoot,{recursive:true}).sort();
  const preview=await maintain(f,{'dry-run':true,run:f.id});assert.equal(preview.runs[0].state,'eligible');assert.equal(preview.runs[0].helper_reconciliation.state,'quiescent');assert.equal(preview.runs[0].helper_reconciliation.identities[0].verdict,'gone');assert.deepEqual(fs.readdirSync(f.c.stateRoot,{recursive:true}).sort(),names);
  for(const mode of ['match','unknown']){state.mode=mode;const result=await maintain(f,{apply:true,run:f.id});assert.equal(result.runs[0].state,'protected');assert.ok(fs.existsSync(path.join(f.dir,'stdout.log')));}
  state.mode='mismatch';const result=await maintain(f,{apply:true,run:f.id});assert.equal(result.runs[0].state,'collected');const receipt=JSON.parse(fs.readFileSync(path.join(f.c.stateRoot,'retention','receipts',f.id+'.json'),'utf8'));assert.deepEqual(receipt.snapshot.run,f.rec);assert.deepEqual(fs.readFileSync(path.join(f.dir,'run.json')),before);
});
test('P03e: metadata retirement preserves historical helper audit and separate current reconciliation',async t=>{
  const f=fixture(t,'p03e-archive'),state=processFixture(t);state.mode='mismatch';await enroll(f);assert.equal((await maintain(f,{apply:true,run:f.id})).runs[0].state,'collected');
  await maintain(f,{kind:'metadata',enroll:f.id,by:'fixture-owner',reason:'disposable fixture'});assert.equal((await maintain(f,{kind:'metadata',apply:true,run:f.id})).runs[0].state,'collected');
  const archived=readArchived(f.cfg,'run',f.id);assert.deepEqual(archived.record.escaped_helpers,f.rec.escaped_helpers);assert.deepEqual(archived.record.helper_audit,f.rec.helper_audit);assert.equal(archived.helper_reconciliation.state,'quiescent');assert.equal(archived.helper_reconciliation.identities[0].verdict,'mismatch');
  assert.equal(await dependentRunBlock(f.cfg,f.resource),null);state.mode='match';assert.match(await dependentRunBlock(f.cfg,f.resource),/helper/i);state.mode='unknown';assert.match(await dependentRunBlock(f.cfg,f.resource),/helper/i);
});
test('P03e: partial metadata retirement rechecks helpers after archive publication and on recovery',async t=>{
  const f=fixture(t,'p03e-recovery'),state=processFixture(t);await enroll(f);await maintain(f,{apply:true,run:f.id});await maintain(f,{kind:'metadata',enroll:f.id,by:'fixture-owner',reason:'disposable fixture'});
  const original=fs.linkSync,archive=path.join(f.c.stateRoot,'retention','archive','run',f.id+'.json');fs.linkSync=(a,b)=>{original(a,b);if(b===archive)state.mode='match';};
  let first;try{first=await maintain(f,{kind:'metadata',apply:true,run:f.id});}finally{fs.linkSync=original;}
  assert.equal(first.runs[0].state,'pending');assert.match(first.runs[0].reason,/helper/i);assert.ok(fs.existsSync(path.join(f.dir,'run.json')));
  state.mode='unknown';assert.equal((await maintain(f,{kind:'metadata',apply:true,run:f.id})).runs[0].state,'protected');assert.ok(fs.existsSync(path.join(f.dir,'run.json')));
  state.mode='gone';assert.equal((await maintain(f,{kind:'metadata',apply:true,run:f.id})).runs[0].state,'collected');assert.equal(fs.existsSync(f.dir),false);
});
test('P03e: transcript collection rechecks helpers between exact unlinks',async t=>{
  const f=fixture(t,'p03e-transcript-recovery'),state=processFixture(t);await enroll(f);const original=fs.unlinkSync;
  fs.unlinkSync=file=>{original(file);if(file===path.join(f.dir,'stdout.log'))state.mode='match';};
  let first;try{first=await maintain(f,{apply:true,run:f.id});}finally{fs.unlinkSync=original;}
  assert.equal(first.runs[0].state,'pending');assert.match(first.runs[0].reason,/helper/i);assert.ok(fs.existsSync(path.join(f.dir,'stderr.log')));assert.ok(fs.existsSync(path.join(f.dir,'prompt.txt')));
  state.mode='gone';assert.equal((await maintain(f,{apply:true,run:f.id})).runs[0].state,'collected');
});
test('P03e: an owned real helper is protected until its natural exit, with original bytes preserved',{timeout:30000},async t=>{
  const f=fixture(t,'p03e-native'),child=cp.spawn(process.execPath,['-e',"process.on('message',()=>process.exit(0));"],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  t.after(()=>{if(child.connected)child.send('stop');});const closed=once(child,'close'),birth=await ownChildCreationTime(child.pid,{deadlineMs:5000});assert.ok(birth,'own helper birth is required');
  f.rec.escaped_helpers[0]={...f.rec.escaped_helpers[0],pid:child.pid,created_at:birth};fs.writeFileSync(path.join(f.dir,'run.json'),JSON.stringify(f.rec));const before=fs.readFileSync(path.join(f.dir,'run.json'));
  assert.match(await quiescent(f.cfg,f.rec,Date.now()+4000),/helper.*live|helper.*uncertain/);assert.match(await dependentRunBlock(f.cfg,f.resource),/helper/);
  child.send('stop');await closed;
  await waitFor(async()=>await quiescent(f.cfg,f.rec,Date.now()+4000)===null,{timeoutMs:15000,intervalMs:250,what:'owned helper exit visible to bounded process query'});assert.deepEqual(fs.readFileSync(path.join(f.dir,'run.json')),before);
});
