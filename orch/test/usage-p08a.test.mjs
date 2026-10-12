import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import { callTool } from '../src/mcp.mjs';
import {collectorEnvironment,invokeCollector} from '../src/usage-collector.mjs';
/** @type {any} */
const usage = await import('../src/usage.mjs').catch(() => ({}));
const fingerprint = crypto.createHash('sha256').update('member@example.org').digest('hex');
const observedAt = '2026-01-10T12:00:00Z';
const resetAt = '2026-01-11T12:00:00Z';
function pool(provider='codex', kind='codexbar') {
  return {id:provider+'-personal',provider,account:'personal',workspace:'default',billing:'subscription',collector:{kind,command:process.execPath,args:[],version:'0.74.0',source:provider==='mistral'?'web':'oauth',accountFingerprint:fingerprint}};
}
function config(pools=[pool()]) { return {version:1,pools,bindings:[{id:'controller',role:'controller',harness:'codex',model:'example-model',pool:pools[0].id}]}; }
/** @returns {any} */
function bar(provider='codex') {
  return [{provider,version:'0.74.0',source:provider==='mistral'?'web':'oauth',usage:{updatedAt:observedAt,identity:{accountEmail:'Member@Example.Org'},primary:{usedPercent:87,windowMinutes:300,resetsAt:resetAt},secondary:{usedPercent:62,windowMinutes:10080,resetsAt:null},tertiary:null},credits:{remaining:999},secret:'canary'}];
}
function external(provider='cursor') {
  const p=pool(provider,'json');
  return {version:1,observations:[{provider,pool:p.id,account:p.account,workspace:p.workspace,billing:'subscription',accountFingerprint:fingerprint,sourceVersion:'0.74.0',observedAt,windows:[{id:'included',kind:'quota',unit:'requests',used:12,remaining:null,limit:100,resetsAt:resetAt,durationMinutes:null,models:['example-model']},{id:'overages',kind:'spend',unit:'currency',used:8,remaining:null,limit:null,resetsAt:null,currency:'USD'}],email:'PRIVATE-IDENTITY',token:'canary'}]};
}
function setup(t, providers=['codex']) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-usage-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const marker=path.join(root,'calls.jsonl'), stateRoot=path.join(root,'state'), configFile=path.join(root,'usage.json');
  const helper=path.resolve('test/fixtures/usage-helper.mjs');
  const pools=providers.map(provider=>{const p=pool(provider,'json');p.collector.args=[helper,marker,observedAt];return p;});
  const c=config(pools);
  c.bindings.push({id:'worker',role:'worker',harness:'opencode',model:'another-model',pool:pools[0].id});
  if(pools.length>1)c.bindings.push({id:'reviewer',role:'reviewer',harness:'vibe',model:'review-model',pool:pools[1].id});
  fs.writeFileSync(configFile,JSON.stringify(c));
  return {root,marker,stateRoot,configFile,c,now:Date.parse(observedAt),calls:()=>fs.existsSync(marker)?fs.readFileSync(marker,'utf8').trim().split('\n').map(x=>JSON.parse(x)):[]};
}

test('subscription windows preserve unknowns and exclude identities, credits and raw fields', () => {
  assert.equal(typeof usage.normalizeCodexBar,'function','subscription adapter is missing');
  const result=usage.normalizeCodexBar(bar(),pool());
  assert.equal(result.observedAt,observedAt);
  assert.equal(result.windows[0].used,87);
  assert.equal(result.windows[0].remaining,13);
  assert.equal(result.windows[1].resetsAt,null);
  assert.equal(result.windows[2].used,null);
  assert.ok(!JSON.stringify(result).includes('example.org'));
  assert.ok(!JSON.stringify(result).includes('canary'));
  assert.ok(!JSON.stringify(result).includes('999'));
});
test('Vibe uses its separate allowance, never the included API primary window', () => {
  const raw=bar('mistral');
  raw[0].usage.extraRateWindows=[{id:'mistral-monthly-plan',title:'Monthly Plan',window:{usedPercent:4.22,windowMinutes:null,resetsAt:resetAt}}];
  const result=usage.normalizeCodexBar(raw,pool('mistral'));
  assert.deepEqual(result.windows.map(w=>w.id),['mistral-monthly-plan']);
  assert.equal(result.windows[0].remaining,95.78);
  delete raw[0].usage.extraRateWindows;
  assert.equal(usage.normalizeCodexBar(raw,pool('mistral')).windows[0].used,null);
});
test('a changed account, source, version or provider cannot populate the configured subscription pool', () => {
  for(const mutate of [r=>r[0].usage.identity.accountEmail='other@example.org',r=>r[0].source='api',r=>r[0].version='0.75.0',r=>r[0].provider='claude',r=>delete r[0].usage.identity]) {
    const raw=bar();mutate(raw);
    assert.throws(()=>usage.normalizeCodexBar(raw,pool()), {name:'OrchError'});
  }
});
test('external Cursor, Muse and Copilot windows retain units, scope, unknown denominator and separate spend', () => {
  for(const provider of ['cursor','muse','copilot']) {
    const raw=external(provider);
    if(provider==='copilot') {raw.observations[0].windows[0].limit=null;raw.observations[0].windows[0].resetsAt=null;}
    const result=usage.normalizeExternal(raw,pool(provider,'json'));
    assert.equal(result.windows[0].unit,'requests');
    assert.equal(result.windows[0].remaining,null,'missing reported remainder stays unknown');
    assert.deepEqual(result.windows[0].models,['example-model']);
    assert.equal(result.windows[1].kind,'spend');
    assert.equal(result.windows[1].currency,'USD');
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.ok(!JSON.stringify(result).includes('canary'));
    assert.equal(result.windows[0].limit,provider==='copilot'?null:100);
  }
});
test('external observation binding must match the explicit account, workspace, pool and fingerprint', () => {
  for(const field of ['provider','pool','account','workspace','billing','accountFingerprint','sourceVersion']) {
    const raw=external();raw.observations[0][field]='wrong';
    assert.throws(()=>usage.normalizeExternal(raw,pool('cursor','json')), {name:'OrchError'});
  }
  const raw=external();raw.observations.push(external('muse').observations[0]);
  assert.throws(()=>usage.normalizeExternal(raw,pool('cursor','json')), {name:'OrchError'}, 'out-of-scope pool payload');
});
test('invalid quota numbers and observation times do not become usable capacity', () => {
  for(const value of [-1,'62',Infinity,NaN]) {const raw=bar();raw[0].usage.primary.usedPercent=value;assert.throws(()=>usage.normalizeCodexBar(raw,pool()), {name:'OrchError'});}
  const raw=bar();raw[0].usage.updatedAt='not-a-time';assert.throws(()=>usage.normalizeCodexBar(raw,pool()), {name:'OrchError'});
  raw[0].usage.updatedAt=observedAt;raw[0].usage.primary.resetsAt='invalid';assert.throws(()=>usage.normalizeCodexBar(raw,pool()), {name:'OrchError'});
});
test('configuration binds multiple roles to one real pool and rejects implicit API modes or credential arguments', () => {
  const c=config();c.bindings.push({id:'reviewer',role:'reviewer',harness:'opencode',model:'second-model',pool:c.pools[0].id});
  assert.equal(usage.validateUsageConfig(c,process.cwd()).pools.length,1);
  for(const mutate of [x=>x.pools[0].collector.source='auto',x=>x.pools[0].billing='api',x=>x.pools[0].account='member@example.org',x=>x.pools[0].collector.args=['--api-key','secret'],x=>x.pools.push(pool()),x=>x.bindings[0].pool='unknown']) {
    const bad=structuredClone(c);mutate(bad);assert.throws(()=>usage.validateUsageConfig(bad,process.cwd()), {name:'OrchError'});
  }
});

test('cached status launches nothing, writes nothing and shows unknown headroom before refresh', async t => {
  const c=setup(t);
  const r=await usage.getUsage(c);
  assert.equal(r.pools[0].freshness,'unknown');
  assert.equal(r.pools[0].observation,null);
  assert.equal(fs.existsSync(c.stateRoot),false);
  assert.equal(c.calls().length,0);
});
test('one refresh observes controller and child pools without double counting shared harness/model routes', async t => {
  const c=setup(t,['codex','claude','mistral']);
  const r=await usage.getUsage({...c,refresh:true});
  assert.equal(r.pools.length,3);
  assert.equal(r.bindings.filter(b=>b.pool==='codex-personal').length,2);
  assert.equal(c.calls().length,3);
  assert.ok(r.pools.every(p=>p.freshness==='fresh'));
  assert.equal(r.pools[0].observation.windows[0].remaining,75);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  for(const f of fs.readdirSync(path.join(c.stateRoot,'usage'))) assert.ok(!fs.readFileSync(path.join(c.stateRoot,'usage',f),'utf8').includes('SECRET'));
});
test('concurrent refreshes and a new caller respect the durable pool cooldown', async t => {
  const c=setup(t);
  await Promise.all([usage.getUsage({...c,refresh:true}),usage.getUsage({...c,refresh:true})]);
  assert.equal(c.calls().length,1);
  const r=await usage.getUsage({...c,refresh:true,now:c.now+59000});
  assert.equal(c.calls().length,1);
  assert.equal(r.pools[0].refreshState,'cooldown');
  await usage.getUsage({...c,refresh:true,now:c.now+61000});
  assert.equal(c.calls().length,2);
});
test('collector failure preserves sibling results and old observations with their original age', async t => {
  const c=setup(t,['codex','claude']);
  await usage.getUsage({...c,refresh:true});
  c.c.pools[0].collector.args.push('fail');fs.writeFileSync(c.configFile,JSON.stringify(c.c));
  const r=await usage.getUsage({...c,refresh:true,now:c.now+61000});
  assert.equal(r.pools[0].error.code,'collector-exit');
  assert.equal(r.pools[0].observation,null,'changed helper config invalidates old evidence');
  assert.equal(r.pools[1].freshness,'fresh');
  assert.ok(!JSON.stringify(r).includes('secret-from-provider'));
});
test('freshness follows original observations and reset expiry, never the cache access time', async t => {
  const c=setup(t);
  await usage.getUsage({...c,refresh:true});
  const stale=await usage.getUsage({...c,now:c.now+301000});
  assert.equal(stale.pools[0].freshness,'stale');
  assert.equal(stale.pools[0].observation.observedAt,observedAt);
  const expired=await usage.getUsage({...c,now:Date.parse(resetAt)+1});
  assert.equal(expired.pools[0].observation.windows[0].freshness,'reset-stale');
});
test('a helper account change is rejected and failures cannot immediately retry', async t => {
  const c=setup(t);c.c.pools[0].collector.version='0.75.0';fs.writeFileSync(c.configFile,JSON.stringify(c.c));
  const r=await usage.getUsage({...c,refresh:true});
  assert.equal(r.pools[0].error.code,'collector-invalid');
  assert.equal(r.pools[0].freshness,'unknown');
  await usage.getUsage({...c,refresh:true});
  assert.equal(c.calls().length,1);
});
test('role/pool selection returns configured mappings without exposing other pools', async t => {
  const c=setup(t,['codex','claude']);
  const r=await usage.getUsage({...c,role:'reviewer'});
  assert.deepEqual(r.pools.map(p=>p.id),['claude-personal']);
  assert.deepEqual(r.bindings.map(b=>b.id),['reviewer']);
  await assert.rejects(()=>usage.getUsage({...c,pool:'not-configured'}),{name:'OrchError'});
});
test('failed unchanged collector retains last successful evidence rather than making it current', async t => {
  const c=setup(t);await usage.getUsage({...c,refresh:true});
  fs.writeFileSync(c.marker+'.fail','yes');
  const r=await usage.getUsage({...c,refresh:true,now:c.now+301000});
  assert.equal(r.pools[0].observation.observedAt,observedAt);
  assert.equal(r.pools[0].freshness,'stale');
  assert.equal(r.pools[0].error.code,'collector-exit');
});
test('inherited billing keys and runtime injection do not reach telemetry helpers', async t => {
  const c=setup(t);
  const original=process.env.MISTRAL_API_KEY;
  process.env.MISTRAL_API_KEY='billing-key-canary';
  try {await usage.getUsage({...c,refresh:true});}finally {if(original===undefined)delete process.env.MISTRAL_API_KEY;else process.env.MISTRAL_API_KEY=original;}
  assert.equal(c.calls()[0].keyPresent,false);
});

test('credential pointers and provider-specific token names cannot reach helpers', () => {
  const keys=['GOOGLE_APPLICATION_CREDENTIALS','AWS_SHARED_CREDENTIALS_FILE','AWS_PROFILE','GITHUB_PAT','ARBITRARY_PROVIDER_AUTH'];
  const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {for(const k of keys)process.env[k]='canary';const env=collectorEnvironment();for(const k of keys)assert.equal(env[k],undefined);}
  finally {for(const k of keys)if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}
});

test('exit-before-close draining is bounded and only genuinely unclosed pipes remain cleanup-pending', async () => {
  for(const eventuallyClosed of [true,false]) {
    /** @type {any} */
    const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),unref(){}});
    const p=pool('codex','json');p.collector.timeoutMs=1000;
    const result=invokeCollector(p,{spawnHelper:()=>{setImmediate(()=>{
      child.exitCode=0;child.emit('exit',0);child.stdout.write('x'.repeat(1100000));
      if(eventuallyClosed)setTimeout(()=>child.emit('close',0),5);
    });return child;}});
    const r=await result;assert.equal(r.error.code,'collector-output-limit');assert.equal(r.error.cleanupPending,!eventuallyClosed);
  }
});

test('a persisted uncertain helper cleanup blocks refresh even after cooldown', async t => {
  const c=setup(t);await usage.getUsage({...c,refresh:true});
  const dir=path.join(c.stateRoot,'usage'),file=path.join(dir,fs.readdirSync(dir).find(f=>f.endsWith('.json')));
  const record=JSON.parse(fs.readFileSync(file,'utf8'));record.error={code:'collector-timeout',cleanupPending:true};fs.writeFileSync(file,JSON.stringify(record));
  const again=await usage.getUsage({...c,refresh:true,now:c.now+61000});assert.equal(again.pools[0].refreshState,'cleanup-pending');assert.equal(c.calls().length,1);
});

test('an explicitly selected shared config is readable while cache hardlinks remain protected', async t => {
  const c=setup(t),linked=path.join(c.root,'shared.json');fs.linkSync(c.configFile,linked);
  const r=await usage.getUsage({...c,configFile:linked});assert.equal(r.enabled,true);assert.equal(fs.existsSync(c.stateRoot),false);
});
test('linked cache files are protected and neither followed nor overwritten by refresh', async t => {
  const c=setup(t);await usage.getUsage({...c,refresh:true});
  const cacheDir=path.join(c.stateRoot,'usage');const file=path.join(cacheDir,fs.readdirSync(cacheDir).find(f=>f.endsWith('.json')));
  const linked=path.join(c.root,'preserve.json');fs.linkSync(file,linked);const before=fs.readFileSync(linked,'utf8');
  const r=await usage.getUsage({...c,refresh:true,now:c.now+61000});
  assert.equal(r.pools[0].refreshState,'cache-protected');assert.equal(r.pools[0].observation,null);
  assert.equal(fs.readFileSync(linked,'utf8'),before);assert.equal(c.calls().length,1);
});
test('output is capped and a timed-out telemetry process is stopped without affecting a running job', async t => {
  const c=setup(t);c.c.pools[0].collector.args.push('oversize');fs.writeFileSync(c.configFile,JSON.stringify(c.c));
  const huge=await usage.getUsage({...c,refresh:true});assert.equal(huge.pools[0].error.code,'collector-output-limit');
  const other=setup(t);other.c.pools[0].collector.args.push('hang');other.c.pools[0].collector.timeoutMs=2000;fs.writeFileSync(other.configFile,JSON.stringify(other.c));
  const started=Date.now();const timeout=await usage.getUsage({...other,refresh:true});
  assert.equal(timeout.pools[0].error.code,'collector-timeout');assert.ok(Date.now()-started<10000);
  assert.equal(timeout.pools[0].error.cleanupPending,false,'owned telemetry process gone');
  assert.equal(process.kill(process.pid,0),true,'test/controller process continues');
});
test('same subscription fingerprint cannot become a second pool through a different account alias', () => {
  const p=pool();const duplicate=structuredClone(p);duplicate.id='duplicate';duplicate.account='other-alias';
  assert.throws(()=>usage.validateUsageConfig(config([p,duplicate]),process.cwd()),{name:'OrchError'});
});

test('account-level CodexBar pools cannot multiply quota through workspace aliases', () => {
  const p=pool(),duplicate=structuredClone(p);duplicate.id='other-workspace';duplicate.workspace='another';
  assert.throws(()=>usage.validateUsageConfig(config([p,duplicate]),process.cwd()),{name:'OrchError'});
});
test('CodexBar format without an embedded version requires independently verified CLI version', () => {
  const raw=bar();delete raw[0].version;
  assert.throws(()=>usage.normalizeCodexBar(raw,pool()),{name:'OrchError'});
  assert.equal(usage.normalizeCodexBar(raw,pool(),'0.74.0').windows[0].remaining,13);
  assert.throws(()=>usage.normalizeCodexBar(raw,pool(),'0.75.0'),{name:'OrchError'});
});

test('CodexBar invocation verifies the installed version before usage and rejects a different binary', async t => {
  const c=setup(t);const p=c.c.pools[0];
  p.collector.kind='codexbar';p.collector.source='oauth';p.collector.args.push('codexbar');
  fs.writeFileSync(c.configFile,JSON.stringify(c.c));
  const ok=await usage.getUsage({...c,refresh:true});
  assert.equal(ok.pools[0].observation.windows[0].remaining,80);
  assert.deepEqual(c.calls(),[{version:true,usage:false},{version:false,usage:true}]);
  p.collector.args.push('wrong-version');fs.writeFileSync(c.configFile,JSON.stringify(c.c));
  const bad=await usage.getUsage({...c,refresh:true,now:c.now+61000});
  assert.equal(bad.pools[0].error.code,'collector-version');
  assert.equal(c.calls().length,3,'wrong version must not request quota');
});

test('freshness includes cache publication time before the collector starts', async t => {
  const c=setup(t);c.c.pools[0].collector.args[2]='live';
  fs.writeFileSync(c.configFile,JSON.stringify(c.c));
  const rename=fs.renameSync;
  let delayed=false;
  t.mock.method(fs,'renameSync',(source,target)=>{
    if(!delayed && path.dirname(target)===path.join(c.stateRoot,'usage')){
      delayed=true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80);
    }
    return rename(source,target);
  });
  const r=await usage.getUsage({...c,now:undefined,refresh:true});
  assert.ok(delayed,'the durable cooldown write was delayed');
  assert.equal(r.pools[0].freshness,'fresh',JSON.stringify(r.pools));
  assert.ok(Date.parse(r.checkedAt)>=Date.parse(r.pools[0].observation.observedAt));
});

test('a queued second wave uses its actual request and observation time', async t => {
  const c=setup(t,['codex','claude','mistral','cursor','copilot']);c.now=Date.now();
  c.c.pools.forEach((p,i)=>{p.collector.args[2]='live';if(i<4)p.collector.args.push('delay=6000');});
  fs.writeFileSync(c.configFile,JSON.stringify(c.c));
  const r=await usage.getUsage({...c,now:undefined,refresh:true});
  assert.ok(r.pools.every(p=>p.observation && !p.error && p.freshness==='fresh'),JSON.stringify(r.pools));
  assert.ok(Date.parse(r.pools[4].lastAttemptAt)-c.now>=5500,'queued pool records actual launch time');
  assert.ok(Date.parse(r.checkedAt)>=Date.parse(r.pools[4].observation.observedAt),'checkedAt covers the observations it returns');
});
test('CLI and MCP expose the same side-effect-free usage view to any controlling harness', async t => {
  const c=setup(t);
  const cli=spawnSync(process.execPath,['bin/orch.mjs','usage','--config',c.configFile,'--state-root',c.stateRoot,'--json'],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(cli.status,0,cli.stderr);
  const mcp=await callTool('usage',{config:c.configFile},{stateRoot:c.stateRoot});
  assert.equal(mcp.isError,false);
  const m=JSON.parse(mcp.content.map(x=>x.text).join('\n'));const plain=JSON.parse(cli.stdout);
  delete m.checkedAt;delete plain.checkedAt;assert.deepEqual(m,plain);
  assert.equal(fs.existsSync(c.stateRoot),false);
});
