import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {normalizeExternal,getUsage} from '../src/usage.mjs';
/** @type {any} */
const adapter=await import('../src/subscription-collectors.mjs').catch(()=>({}));
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const now=Date.parse('2026-10-11T12:00:00Z');
const email='member@example.org';
function request(provider){return {version:1,pool:'personal',provider,account:'owner',workspace:'account',billing:'subscription',accountFingerprint:hash(provider==='copilot'?'github.com:123':email),sourceVersion:'1.0.0'};}
function transport(values){const calls=[];return {calls,fetchImpl:async(url,options)=>{calls.push({url,options});assert.ok(values.length,'unexpected endpoint');return new Response(JSON.stringify(values.shift()),{status:200});}};}
async function collect(provider,values,credential=provider==='muse'?'dca:fixture-value':provider==='copilot'?'gho_fixture-value':'WorkosCursorSessionToken=fixture-value'){
  assert.equal(typeof adapter.collectSubscription,'function','scoped subscription adapter missing');
  const t=transport(values),req=request(provider);
  const raw=await adapter.collectSubscription(req,{version:1,provider},credential,{...t,now});
  const pool={...req,id:req.pool,collector:{kind:'json',version:req.sourceVersion,accountFingerprint:req.accountFingerprint}};
  return {...t,raw,observation:normalizeExternal(raw,pool)};
}
test('Cursor preserves included allowance and separate on-demand billing without shared-team inference',async()=>{
  const r=await collect('cursor',[{email},{billingCycleEnd:'2026-11-01T00:00:00Z',individualUsage:{plan:{used:125,limit:2000,autoPercentUsed:0.36,apiPercentUsed:5},onDemand:{used:17,limit:100}},teamUsage:{pooled:{used:9,limit:999}}}]);
  const included=r.observation.windows.find(w=>w.id==='included');
  assert.equal(included.kind,'quota');assert.equal(included.unit,'currency');assert.equal(included.used,1.25);assert.equal(included.limit,20);assert.equal(included.remaining,null);
  assert.equal(r.observation.windows.find(w=>w.id==='cursor-models').used,0.36);
  assert.equal(r.observation.windows.find(w=>w.id==='on-demand').kind,'spend');
  assert.ok(!JSON.stringify(r.raw).includes('fixture-value'));
  assert.ok(!JSON.stringify(r.raw).includes(email));assert.equal(r.calls.length,2);
});
test('Cursor shared team data does not become personal headroom when individual quota is missing',async()=>{
  const r=await collect('cursor',[{email},{teamUsage:{pooled:{used:0,limit:100000}}}]);
  assert.equal(r.observation.windows[0].used,null);assert.equal(r.observation.windows[0].limit,null);
});
test('Cursor zero included entitlement does not advertise percentage headroom on a free account',async()=>{
  const r=await collect('cursor',[{email},{individualUsage:{plan:{used:0,limit:0,totalPercentUsed:0,autoPercentUsed:0,apiPercentUsed:0}}}]);
  const percentages=r.observation.windows.filter(w=>w.unit==='percent');
  assert.equal(percentages.length,3);
  assert.ok(percentages.every(w=>w.used===0 && w.remaining===null && w.limit===null));
  assert.equal(r.observation.windows[0].limit,0);
});
test('Copilot verifies identity using a supported REST version separately from its internal quota API',async()=>{
  const req=request('copilot'),calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});
    if(url==='https://api.github.com/user'){
      if(options.headers['X-Github-Api-Version']!=='2022-11-28')return new Response('{"message":"unsupported REST version"}',{status:400});
      return new Response('{"id":123}',{status:200});
    }
    return new Response('{"quota_snapshots":{"premium_interactions":{"entitlement":200,"remaining":200}}}',{status:200});
  };
  const result=await adapter.collectSubscription(req,{version:1,provider:'copilot'},'gho_fixture',{fetchImpl,now});
  assert.equal(result.observations[0].windows[0].remaining,200);
  assert.equal(calls.length,2);
  assert.equal(calls[1].options.headers['X-Github-Api-Version'],'2025-04-01');
  assert.equal(calls[0].options.headers.Authorization,calls[1].options.headers.Authorization);
});
test('reported over-quota consumption preserves zero headroom; excess remaining percentage is invalid',async()=>{
  const cursor=await collect('cursor',[{email},{individualUsage:{plan:{totalPercentUsed:150}}}]);
  const muse=await collect('muse',[{user_email:email,is_subs_active:true,subs_usage:{window:{used_percent:125,window_duration_mins:300},weekly:{used_percent:150}}}]);
  for(const [window,used] of [[cursor.observation.windows.find(w=>w.id==='included-percent'),150],[muse.observation.windows[0],125],[muse.observation.windows[1],150]]){
    assert.equal(window.used,used);assert.equal(window.limit,100);assert.equal(window.remaining,0);
  }
  await assert.rejects(collect('copilot',[{id:123},{quota_snapshots:{premium_interactions:{percent_remaining:150}}}]),/subscription-collector/);
});
test('Copilot binds actual GitHub identity and preserves missing entitlement and reset',async()=>{
  const r=await collect('copilot',[{id:123,login:'fixture-user'},{quota_snapshots:{premium_interactions:{remaining:12,percent_remaining:40},chat:{unlimited:true,remaining:999}}}]);
  const w=r.observation.windows[0];assert.equal(w.unit,'requests');assert.equal(w.remaining,12);assert.equal(w.used,null);assert.equal(w.limit,null);assert.equal(w.resetsAt,null);
  assert.equal(r.observation.windows.find(w=>w.id==='chat').remaining,null);
  assert.equal(r.calls[0].url,'https://api.github.com/user');assert.equal(r.calls[1].url,'https://api.github.com/copilot_internal/user');
});
test('Copilot token billing credits have no invented denominator or duplicate chat balance',async()=>{
  const r=await collect('copilot',[{id:123},{token_based_billing:true,quota_snapshots:{premium_interactions:{entitlement:0,remaining:0,percent_remaining:100,credits_used:31},chat:{credits_used:31}}}]);
  assert.equal(r.observation.windows[0].remaining,null);
  const credits=r.observation.windows.filter(w=>w.unit==='credits'&&w.used!==null);assert.equal(credits.length,1);assert.equal(credits[0].used,31);assert.equal(credits[0].limit,null);
});
test('Copilot token-billed allowance is AI credits rather than request counts',async()=>{
  const r=await collect('copilot',[{id:123},{token_based_billing:true,quota_snapshots:{premium_interactions:{entitlement:200,remaining:180,percent_remaining:90,credits_used:20},chat:{unlimited:true,credits_used:20}}}]);
  const allowance=r.observation.windows[0];
  assert.equal(allowance.id,'premium-credits');assert.equal(allowance.unit,'credits');
  assert.equal(allowance.limit,200);assert.equal(allowance.remaining,180);assert.equal(allowance.used,20);
  assert.equal(r.observation.windows.filter(w=>w.unit==='credits'&&w.used!==null).length,1);
});
test('Copilot per-window billing flag takes precedence; invalid billing flags are rejected',async()=>{
  const r=await collect('copilot',[{id:123},{token_based_billing:true,quota_snapshots:{premium_interactions:{token_based_billing:false,entitlement:200,remaining:180},chat:{token_based_billing:true,entitlement:100,remaining:80}}}]);
  assert.equal(r.observation.windows[0].unit,'requests');assert.equal(r.observation.windows[1].unit,'credits');
  await assert.rejects(collect('copilot',[{id:123},{token_based_billing:'true'}]));
  await assert.rejects(collect('copilot',[{id:123},{quota_snapshots:{premium_interactions:{token_based_billing:'true'}}}]));
});
test('Muse reads device subscription windows and discards minted inference key and payment metadata',async()=>{
  const r=await collect('muse',[{user_email:email,is_subs_active:true,require_payment:false,key:'LLM|private-canary',payment_method:{last4:'1234'},subs_usage:{window:{used_percent:22,window_duration_mins:300,resets_at:1791723600},weekly:{used_percent:51,resets_at:null}}}]);
  assert.equal(r.observation.windows[0].used,22);assert.equal(r.observation.windows[1].used,51);assert.equal(r.observation.windows[1].resetsAt,null);
  assert.equal(r.calls.length,1);assert.equal(r.calls[0].options.method,'POST');assert.ok(!JSON.stringify(r.raw).includes('private-canary'));assert.ok(!JSON.stringify(r.raw).includes('last4'));
});
test('Muse missing subscription windows remain unknown without selecting or querying a browser team',async()=>{
  const r=await collect('muse',[{user_email:email,is_subs_active:true}]);assert.equal(r.observation.windows.length,2);assert.ok(r.observation.windows.every(w=>w.used===null));assert.equal(r.calls.length,1);
});
test('wrong accounts and unverified workspaces fail before fetching sibling quota',async()=>{
  assert.equal(typeof adapter.collectSubscription,'function');
  for(const provider of ['cursor','copilot','muse']){
    const t=transport([provider==='copilot'?{id:999}:{email:'other@example.org',user_email:'other@example.org',is_subs_active:true}]);
    const credential={cursor:'WorkosCursorSessionToken=fixture',copilot:'gho_fixture',muse:'dca:fixture'}[provider];
    await assert.rejects(adapter.collectSubscription(request(provider),{version:1,provider},credential,{...t,now}));assert.equal(t.calls.length,1);
  }
  const req=request('muse');req.workspace='another-team';const t=transport([]);
  await assert.rejects(adapter.collectSubscription(req,{version:1,provider:'muse'},'dca:fixture',{...t,now}));assert.equal(t.calls.length,0);
});
test('subscription helper rejects inference credentials and inherited credential fallback',async()=>{
  assert.equal(typeof adapter.collectSubscription,'function');
  for(const [provider,credential] of [['muse','LLM|inference'],['copilot','ghp_personal-access-token'],['cursor','unrelated=value']]){
    const t=transport([]);await assert.rejects(adapter.collectSubscription(request(provider),{version:1,provider},credential,{...t,now}));assert.equal(t.calls.length,0);
  }
});
test('HTTP redirects, oversized bodies and invalid quotas fail with a redacted helper error',async()=>{
  assert.equal(typeof adapter.collectSubscription,'function');
  for(const response of [new Response('secret',{status:302}),new Response('x'.repeat(1048577),{status:200})]){
    await assert.rejects(adapter.collectSubscription(request('copilot'),{version:1,provider:'copilot'},'gho_fixture',{fetchImpl:async()=>response,now}),/subscription-collector/);
  }
  await assert.rejects(collect('cursor',[{email},{individualUsage:{plan:{used:-1}}}]));
  await assert.rejects(collect('muse',[{user_email:email,is_subs_active:false}]));
});
test('helper CLI with no profile refuses inherited credentials without printing or writing them',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-p08b-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const helper=path.resolve('tools/subscription-collector.mjs');assert.ok(fs.existsSync(helper),'executable helper missing');
  const r=spawnSync(process.execPath,[helper],{cwd:dir,input:JSON.stringify(request('copilot')),encoding:'utf8',env:{...process.env,COPILOT_API_TOKEN:'private-canary',MISTRAL_API_KEY:'private-canary'}});
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/subscription-collector/);assert.ok(!r.stderr.includes('private-canary'));assert.deepEqual(fs.readdirSync(dir),[]);
});
test('one total timeout bounds a stalled response body without a retry',async()=>{
  let calls=0;
  const response=new Response(new ReadableStream({start(){},cancel(){}}));
  const start=performance.now();
  await assert.rejects(adapter.collectSubscription(request('copilot'),{version:1,provider:'copilot'},'gho_fixture',{fetchImpl:async()=>{calls++;return response;},now,timeoutMs:30}),/subscription-collector/);
  assert.equal(calls,1);assert.ok(performance.now()-start<1000);
});
test('shared usage service imports all three collectors, caches scrubbed results and applies bindings',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-p08b-service-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const pools=['cursor','copilot','muse'].map(provider=>{const req=request(provider);return {id:provider,...req,pool:undefined,collector:{kind:'json',command:process.execPath,args:[path.resolve('test/fixtures/subscription-helper.mjs')],version:'1.0.0',accountFingerprint:req.accountFingerprint}};});
  const configFile=path.join(dir,'usage.json'),stateRoot=path.join(dir,'state');
  fs.writeFileSync(configFile,JSON.stringify({version:1,pools,bindings:pools.map((p,i)=>({id:p.id,role:['controller','worker','reviewer'][i],harness:['opencode','cursor','muse'][i],pool:p.id}))}));
  const result=await getUsage({stateRoot,configFile,refresh:true,now});
  assert.equal(result.pools.length,3);assert.ok(result.pools.every(p=>p.error===null && p.observation.bindingVerified),JSON.stringify(result.pools.map(p=>({provider:p.provider,error:p.error}))));
  assert.equal(result.bindings[0].harness,'opencode');
  const cached=await getUsage({stateRoot,configFile,role:'reviewer',now});assert.deepEqual(cached.pools.map(p=>p.provider),['muse']);
  for(const name of fs.readdirSync(path.join(stateRoot,'usage'))){const text=fs.readFileSync(path.join(stateRoot,'usage',name),'utf8');assert.ok(!/example.org|fixture-value|private-canary/.test(text));}
});
