import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {makeCase,orch,waitForStatus} from './helpers.mjs';
import {makeRepo,craftFinishedRun} from './wf-helpers.mjs';
import {loadConfig} from '../src/config.mjs';
import {callTool} from '../src/mcp.mjs';
import {cmdRun} from '../src/commands.mjs';
import {cmdPick} from '../src/ledger.mjs';
/** @type {any} */
const quota = await import('../src/quota.mjs').catch(() => ({}));
const now = Date.parse('2026-01-10T12:00:00Z');
const iso = n => new Date(n).toISOString();
const rawUsage = {version:1,pools:['a','b'].map(id=>({id,provider:id,account:'personal',workspace:'default',billing:'subscription',collector:{kind:'json',command:process.execPath,args:[],version:'1',source:'json',accountFingerprint:id.repeat(64)}})),bindings:['a','b'].flatMap(pool=>['controller','worker','reviewer'].map(role=>({id:pool+role,role,harness:pool==='a'?'codex':'vibe',model:pool+'-model',pool})))};
function rawPolicy() {
  return {version:1,usageConfig:'usage.json',stateRoot:'shared',pools:['a','b'].map(id=>({id,windows:[{id:'session',unit:'percent',controller:5,review:10,retry:5,warn:25}]})),routes:['a','b'].flatMap(pool=>['controller','worker','reviewer'].map(role=>({binding:pool+role,capability:'coding',costs:{session:{XS:5,S:10,M:20}}})))};
}
function policy() { return quota.validateQuotaPolicy(rawPolicy(),rawUsage,process.cwd()); }
function usage(remaining=[80,80], elapsed=[0.9,0.1]) {
  return {enabled:true,checkedAt:iso(now),bindings:rawUsage.bindings,pools:['a','b'].map((id,i)=>({id,billing:'subscription',freshness:'fresh',error:null,observation:{bindingVerified:true,observedAt:iso(now),windows:[{id:'session',kind:'quota',unit:'percent',used:100-remaining[i],remaining:remaining[i],limit:100,durationMinutes:100,resetsAt:iso(now+(1-elapsed[i])*6000000),models:[],freshness:'fresh'}]}}))};
}
const candidates = [{cli:'codex',model:'a-model',same_family:false},{cli:'vibe',model:'b-model',same_family:false}];
function decide(extra={}) { return quota.evaluateQuota({policy:policy(),usage:usage(),leases:[],candidates,role:'worker',size:'S',capability:'coding',purpose:'normal',now,...extra}); }

test('P08c ranks equal-capability useful work by reset-cycle deficit before rotation',()=>{
  assert.equal(typeof quota.evaluateQuota,'function');
  const d=decide({candidates:[...candidates].reverse()});
  assert.equal(d.pick.cli,'codex');
  assert.ok(d.routes.find(r=>r.cli==='codex').windows[0].pacingDeficit>0.6);
  assert.equal(d.estimates,true);
});
test('capability membership is explicit; an unqualified alternative never fills an exhausted pool',()=>{
  const p=policy();p.routes.find(r=>r.binding==='bworker').capability='other';
  const d=decide({policy:p,usage:usage([2,90])});
  assert.equal(d.pick,null);assert.equal(d.deferred,true);
});
test('review family preference and existing candidate order break pacing ties',()=>{
  const u=usage([80,80],[0.5,0.5]);
  assert.equal(decide({usage:u,candidates:[...candidates].reverse()}).pick.cli,'vibe');
  assert.equal(decide({usage:usage(),candidates:[{...candidates[0],same_family:true},candidates[1]]}).pick.cli,'vibe');
});
test('low capacity warns and chooses an available equally capable pool; otherwise defers',()=>{
  const d=decide({usage:usage([25,80])});
  assert.equal(d.pick.cli,'vibe');assert.ok(d.routes[0].warnings.length);
  assert.equal(decide({usage:usage([25,25])}).pick,null);
});
test('controller, review and retry reserves differ by role and purpose',()=>{
  const u=usage([26,26]);
  assert.equal(decide({usage:u}).pick,null);
  assert.ok(decide({usage:u,role:'reviewer'}).pick);
  assert.ok(decide({usage:u,purpose:'retry'}).pick);
  assert.equal(decide({usage:usage([4,4]),role:'reviewer',purpose:'retry'}).pick,null);
});
test('unknown, stale, reset-stale, collector errors and unbound observations do not admit',()=>{
  for(const mutate of [p=>p.freshness='unknown',p=>p.freshness='stale',p=>p.error={code:'collector-exit'},p=>p.observation.bindingVerified=false,p=>p.observation.windows[0].freshness='reset-stale',p=>p.observation.windows[0].remaining=null]) {
    const u=usage();u.pools.forEach(mutate);assert.equal(decide({usage:u}).pick,null);
  }
});
test('weekly bottleneck controls admission, never just the generous short window',()=>{
  const p=policy(),u=usage();
  for(const pool of p.pools)pool.windows.push({...pool.windows[0],id:'weekly'});
  for(const r of p.routes)r.costs.weekly={XS:5,S:10,M:20};
  for(const pool of u.pools)pool.observation.windows.push({...pool.observation.windows[0],id:'weekly',remaining:12,used:88});
  assert.equal(decide({policy:p,usage:u}).pick,null);
});
test('spend and balance are not included subscription capacity; native-unit mismatches defer',()=>{
  for(const mutate of [w=>w.kind='credits',w=>w.kind='spend',w=>w.unit='tokens']) {
    const u=usage();u.pools.forEach(p=>mutate(p.observation.windows[0]));assert.equal(decide({usage:u}).pick,null);
  }
});
test('every applicable quota window needs an explicit policy rule or ignored-window reason',()=>{
  const u=usage();for(const p of u.pools)p.observation.windows.push({...p.observation.windows[0],id:'extra'});
  assert.equal(decide({usage:u}).pick,null);
  const p=policy();p.pools.forEach(x=>x.ignore={extra:'duplicate display of session allowance'});
  assert.ok(decide({policy:p,usage:u}).pick);
});
test('prototype property names cannot silently ignore an undeclared quota window',()=>{
  const u=usage();for(const p of u.pools)p.observation.windows.push({...p.observation.windows[0],id:'constructor',remaining:0});
  assert.equal(decide({usage:u}).pick,null);
});
test('model-scoped windows do not debit unrelated models',()=>{
  const u=usage();u.pools.forEach(p=>p.observation.windows.push({...p.observation.windows[0],id:'other',models:['other-model'],remaining:0}));
  assert.ok(decide({usage:u}).pick);
});
test('reported credit quota without denominator admits by native forecast but has unknown pacing',()=>{
  const p=policy(),u=usage();
  p.pools.forEach(x=>x.windows[0].unit='credits');u.pools.forEach(x=>Object.assign(x.observation.windows[0],{unit:'credits',limit:null,durationMinutes:null,resetsAt:null}));
  const d=decide({policy:p,usage:u});assert.ok(d.pick);assert.equal(d.routes[0].windows[0].pacingDeficit,null);
});
test('a subscription with known headroom but unknown cycle is not starved by paced pools',()=>{
  const u=usage();u.pools[1].observation.windows[0].durationMinutes=null;
  const d=decide({usage:u,candidates:[...candidates].reverse()});assert.equal(d.pick.cli,'vibe');assert.equal(d.allocationMode,'rotation-unknown-cycle');
});
test('same subscription aliases debit one pool and pending holds survive reset',()=>{
  const p=policy(),lease={poolKey:p.pools[0].key,costs:{session:{unit:'percent',amount:60}}};
  assert.equal(decide({policy:p,leases:[lease]}).pick.cli,'vibe');
  assert.equal(decide({policy:p,leases:[lease],usage:usage([90,90],[0,0])}).pick.cli,'vibe');
});
test('changed reservation units block that pool instead of inventing headroom',()=>{
  const p=policy();assert.equal(decide({policy:p,leases:[{poolKey:p.pools[0].key,costs:{session:{unit:'tokens',amount:1}}}]}).pick.cli,'vibe');
});
test('another controller cannot silently change the shared pool rules while a hold exists',async t=>{
  const s=setup(t,80);await reserve(s,'existing');
  const raw=rawPolicy();raw.pools[0].windows[0].controller=0;const other=path.join(s.root,'other-policy.json');fs.writeFileSync(other,JSON.stringify(raw));
  await assert.rejects(quota.withQuotaAdmission({args:{...s.args,'quota-policy':other},cfg:s.cfg,cli:'codex',model:'a-model',role:'implement',id:'conflict'},async()=>{}),{code:'quota-deferred'});
  assert.equal(quota.readQuotaState(s.policy).leases.length,1);
});
test('policy rejects duplicate routes, API pools, unbound roles and incomplete cost forecasts',()=>{
  for(const mutate of [p=>p.routes.push(p.routes[0]),p=>p.routes[0].binding='missing',p=>p.routes[0].costs.session.S=0,p=>p.pools[0].windows[0].unit='currency',p=>p.stateRoot='']) {
    const raw=rawPolicy();mutate(raw);assert.throws(()=>quota.validateQuotaPolicy(raw,rawUsage,process.cwd()),{code:'bad-quota-policy'});
  }
});
test('disabled quota policy is read-only and does not launch collectors or create shared state',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-quota-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const result=await quota.quotaSnapshot({policyFile:null});assert.equal(result.enabled,false);assert.equal(fs.readdirSync(root).length,0);
});

function setup(t,remaining=40,parent=os.tmpdir()) {
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(parent,'orch-quota-state-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const values=path.join(root,'value.json'),usageFile=path.join(root,'usage.json'),policyFile=path.join(root,'quota.json'),runRoot=path.join(root,'runs-state');
  fs.writeFileSync(values,JSON.stringify({remaining}));
  const u=structuredClone(rawUsage);u.pools.forEach(p=>p.collector.args=[path.resolve('test/fixtures/quota-helper.mjs'),values]);
  fs.writeFileSync(usageFile,JSON.stringify(u));fs.writeFileSync(policyFile,JSON.stringify(rawPolicy()));
  return {root,policyFile,runRoot,values,policy:quota.loadQuotaPolicy(policyFile),args:{'quota-policy':policyFile,capability:'coding',size:'S'},cfg:loadConfig(runRoot)};
}
const reserve=(s,id,launch=async()=>{})=>quota.withQuotaAdmission({args:s.args,cfg:s.cfg,cli:'codex',model:'a-model',role:'implement',id},launch);

test('owned quota fixture resolves a temporary-directory alias before protected storage',async t=>{
  const c=makeCase('quota-temp-alias');t.after(()=>c.cleanup());
  const target=path.join(c.base,'actual-temp'),alias=path.join(c.base,'temp-alias');fs.mkdirSync(target);fs.symlinkSync(target,alias,'junction');
  const s=setup(t,80,alias);assert.equal(s.root,fs.realpathSync.native(s.root));await reserve(s,'canonical-fixture');assert.equal(quota.readQuotaState(s.policy).leases.length,1);
});
test('durable holds serialize same-pool launches across controllers and allow a different subscription',async t=>{
  const s=setup(t,35);
  await reserve(s,'first');
  await assert.rejects(reserve(s,'second'),{code:'quota-deferred'});
  await quota.withQuotaAdmission({args:s.args,cfg:loadConfig(path.join(s.root,'other-controller')),cli:'vibe',model:'b-model',role:'implement',id:'other'},async()=>{});
  assert.equal(quota.readQuotaState(s.policy).leases.length,2);
});
test('two child processes cannot both reserve the final usable job allowance',async t=>{
  const s=setup(t,35);await quota.quotaSnapshot({policyFile:s.policyFile,refresh:true});
  const child=id=>new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,[path.resolve('test/fixtures/quota-contender.mjs'),s.policyFile,path.join(s.root,id),id],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>resolve({code,out,err}));
  });
  const results=await Promise.all([child('one'),child('two')]);
  assert.deepEqual(results.map(r=>r.code).sort(),[0,3],JSON.stringify(results));
  assert.equal(quota.readQuotaState(s.policy).leases.length,1);
});
test('known pre-launch errors release the hold; an attempted or crashed launch remains reserved',async t=>{
  const s=setup(t,80);
  await assert.rejects(reserve(s,'pre',async()=>{throw new Error('preflight');}),/preflight/);
  assert.equal(quota.readQuotaState(s.policy).leases.length,0);
  await assert.rejects(reserve(s,'uncertain',async(q,mark)=>{assert.equal(q.estimates,true);mark();throw new Error('unknown spawn');}),/unknown spawn/);
  assert.equal(quota.readQuotaState(s.policy).leases.length,1);
});
test('status alone cannot release a hold; completion also needs a newer fresh observation',async t=>{
  const s=setup(t,80);await reserve(s,'done');
  const dir=path.join(s.cfg.runsDir,'done');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify({status:'completed',ended_at:iso(now)}));
  let state=quota.readQuotaState(s.policy),u=usage();
  assert.equal(quota.reconcileQuota(s.policy,state,u).leases.length,1);
  const events=[{event:'spawned',at:iso(now-5000)},{event:'worker-exit',at:iso(now+1000),code:0},{event:'streams-closed',at:iso(now+1000)},{event:'keeper-exit',at:iso(now+1000),write_failures:0}];
  fs.writeFileSync(path.join(dir,'keeper.ndjson'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  assert.equal(quota.reconcileQuota(s.policy,state,u).leases.length,1);
  u.pools[0].observation.observedAt=iso(now+2000);
  assert.equal(quota.reconcileQuota(s.policy,state,u).leases.length,0);
  u.pools[0].observation.windows[0].freshness='reset-stale';assert.equal(quota.reconcileQuota(s.policy,state,u).leases.length,1);
});
test('corrupt shared state refuses admission and remains byte-identical',async t=>{
  const s=setup(t);const file=path.join(s.policy.stateRoot,'quota','reservations.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{broken');
  await assert.rejects(reserve(s,'new'),{code:'quota-state-unsafe'});assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
test('quota CLI and MCP share cached warnings and do not mutate observations or holds',async t=>{
  const s=setup(t,25);await quota.quotaSnapshot({policyFile:s.policyFile,refresh:true});
  const files=fs.readdirSync(path.join(s.policy.stateRoot,'usage')).map(f=>path.join(s.policy.stateRoot,'usage',f));const before=files.map(f=>fs.readFileSync(f,'utf8'));
  const lines=[];const cli=await quota.cmdQuota({_ : [],json:true,'quota-policy':s.policyFile},{log:l=>lines.push(l)});
  const mcp=await callTool('quota',{'quota-policy':s.policyFile});assert.equal(mcp.isError,false);
  mcp.structuredContent.output.usage.checkedAt=cli.usage.checkedAt;assert.deepEqual(mcp.structuredContent.output,cli);
  assert.ok(cli.warnings.length);assert.deepEqual(files.map(f=>fs.readFileSync(f,'utf8')),before);
  assert.ok(!fs.existsSync(path.join(s.policy.stateRoot,'quota')));
});
test('pick retains roster permission/workload/reviewer eligibility before quota routing',async t=>{
  const s=setup(t,80);await quota.quotaSnapshot({policyFile:s.policyFile,refresh:true});
  const roster=path.join(s.root,'roster.json');fs.writeFileSync(roster,JSON.stringify({models:[{cli:'codex',model:'a-model',lane:'cloud',workloads:['implement','review'],family:'a',requires_permission:true},{cli:'vibe',model:'b-model',lane:'cloud',workloads:['implement','review'],family:'b'}]}));
  const r=await cmdPick(s.cfg,{...s.args,roster,workload:'implement',json:true},{log:()=>{}});
  assert.equal(r.pick.cli,'vibe');assert.ok(r.excluded.some(e=>e.why.includes('permission')));
  fs.mkdirSync(path.join(s.cfg.runsDir,'impl'),{recursive:true});fs.writeFileSync(path.join(s.cfg.runsDir,'impl','run.json'),JSON.stringify({id:'impl',model_requested:'b-model'}));
  const review=await cmdPick(s.cfg,{...s.args,roster,workload:'review','for-run':'impl',json:true},{log:()=>{}});assert.equal(review.pick,null);
  assert.match(review.reason,/no suited model/);
});
test('explicit qualified unmetered local routes stay usable when subscription telemetry fails',()=>{
  const p=policy();p.localRoutes=[{cli:'opencode',model:'local-model',role:'worker',capability:'coding'}];
  const u=usage();u.pools.forEach(p=>p.error={code:'collector-exit'});
  const d=decide({policy:p,usage:u,candidates:[...candidates,{cli:'opencode',model:'local-model'}]});assert.equal(d.pick.cli,'opencode');assert.equal(d.pick.pool,null);
  assert.equal(decide({usage:u,candidates:[{cli:'opencode',model:'local-model'}]}).pick,null,'unqualified locals are not a silent downgrade');
});
test('unmetered route declarations cannot bypass subscription accounting for a cloud adapter',()=>{
  const p=rawPolicy();p.localRoutes=[{cli:'codex',model:'a-model',role:'worker',capability:'coding'}];assert.throws(()=>quota.validateQuotaPolicy(p,rawUsage,process.cwd()),{code:'bad-quota-policy'});
});
test('explicit local admission does not contact collectors or depend on a corrupt cloud store',async t=>{
  const s=setup(t),p=rawPolicy();p.localRoutes=[{cli:'opencode',model:'local-model',role:'worker',capability:'coding'}];fs.writeFileSync(s.policyFile,JSON.stringify(p));
  fs.unlinkSync(s.values);const file=path.join(s.policy.stateRoot,'quota','reservations.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{broken');
  const result=await quota.withQuotaAdmission({args:s.args,cfg:s.cfg,cli:'opencode',model:'local-model',role:'implement',id:'local'},async q=>q);
  assert.equal(result.billing,'local');assert.equal(result.reserved,false);assert.ok(!fs.existsSync(path.join(s.policy.stateRoot,'usage')));assert.equal(fs.readFileSync(file,'utf8'),'{broken');
  const snapshot=await quota.quotaSnapshot({policyFile:s.policyFile});assert.equal(snapshot.stateError,'quota-state-unsafe');
  const d=decide({policy:snapshot.policy,usage:snapshot.usage,leases:snapshot.leases,stateError:snapshot.stateError,candidates:[...candidates,{cli:'opencode',model:'local-model'}]});assert.equal(d.pick.cli,'opencode');
});
test('direct quota refusal occurs before adapter config, run records or worker launch',async t=>{
  const s=setup(t,20),dir=path.join(s.root,'target'),handoff=path.join(s.root,'handoff.md');fs.mkdirSync(dir);fs.writeFileSync(handoff,'Implement this small task.');
  await assert.rejects(cmdRun({_ : [],...s.args,'state-root':s.runRoot,cli:'codex',model:'a-model',dir,handoff,json:true},{log:()=>{}}),{code:'quota-deferred'});
  assert.deepEqual(fs.readdirSync(dir),[]);assert.deepEqual(fs.readdirSync(s.cfg.runsDir),[]);
});
test('admitted fake run records forecast provenance and release requires a post-result refresh',async t=>{
  const c=makeCase('quota-admitted');t.after(()=>c.cleanup());
  const s=setup(t,80),raw=JSON.parse(fs.readFileSync(path.join(s.root,'usage.json'),'utf8'));
  raw.bindings.find(b=>b.id==='aworker').harness='fake';fs.writeFileSync(path.join(s.root,'usage.json'),JSON.stringify(raw));s.policy=quota.loadQuotaPolicy(s.policyFile);
  const run=await orch(['run','--cli','fake','--model','a-model','--dir',c.work,'--handoff',c.handoffPath,'--no-window','--quota-policy',s.policyFile,'--capability','coding','--size','S','--json'],c.env);
  assert.equal(run.code,0,run.stderr);const r=JSON.parse(run.stdout);
  assert.equal(r.quota.pool,'a');assert.equal(r.quota.estimates,true);
  const rec=JSON.parse(fs.readFileSync(path.join(c.stateRoot,'runs',r.id,'run.json'),'utf8'));assert.deepEqual(rec.quota,r.quota);
  await waitForStatus(c.stateRoot,r.id,['completed','failed'],{timeoutMs:30000});
  assert.equal(quota.readQuotaState(s.policy).leases.length,1);
  // Explicitly age only this fixture cache's last attempt, preserving its observation.
  for(const file of fs.readdirSync(path.join(s.policy.stateRoot,'usage')).filter(f=>f.endsWith('.json'))) {
    const target=path.join(s.policy.stateRoot,'usage',file),cache=JSON.parse(fs.readFileSync(target,'utf8'));cache.lastAttemptAt=iso(Date.now()-120000);fs.writeFileSync(target,JSON.stringify(cache));
  }
  const refreshed=await quota.quotaSnapshot({policyFile:s.policyFile,refresh:true});assert.equal(refreshed.leases.length,0);
});
test('quota-deferred reviewer preserves its decision and cleans its detached review worktree',async t=>{
  const c=makeCase('quota-review-deferred');t.after(()=>c.cleanup());const s=setup(t,12);
  const raw=JSON.parse(fs.readFileSync(path.join(s.root,'usage.json'),'utf8'));raw.bindings.find(b=>b.id==='areviewer').harness='fake';fs.writeFileSync(path.join(s.root,'usage.json'),JSON.stringify(raw));
  const repo=path.join(c.base,'repo'),head=makeRepo(repo,{'a.txt':'fixture\n'});
  const impl=craftFinishedRun(c.stateRoot,{dir:repo,baseline:head,allow:['a.txt'],extra:{model_requested:'b-model',model_canonical:'b-model',size:'S'}});
  const result=await orch(['review','--run',impl,'--ref',head,'--reviewer','fake','--model','a-model','--prompt',c.handoffPath,'--by','codex','--review-root',path.join(c.base,'reviews'),'--no-window','--quota-policy',s.policyFile,'--capability','coding','--size','S','--json'],c.env);
  assert.ok(result.stdout,result.stderr);const r=JSON.parse(result.stdout);assert.equal(r.run_id,null);assert.match(r.launch_error,/deferred/);assert.equal(r.worktree_removed,true);assert.ok(!fs.existsSync(r.worktree));
});
