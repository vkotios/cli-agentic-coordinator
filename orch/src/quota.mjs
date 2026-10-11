// Opt-in subscription admission. Forecast holds are estimates, never provider usage.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setting, loadConfig } from './config.mjs';
import { getUsage, validateUsageConfig } from './usage.mjs';
import { OrchError } from './errors.mjs';
import { canonicalId } from './models.mjs';
import { PUBLIC_ADAPTERS, getAdapter } from './adapters/index.mjs';
import { withOperationLock, resolvedPath } from './resources.mjs';
import { keeperFacts, paths } from './store.mjs';
import { readArchived } from './archive.mjs';
import { readTailLines, writeJsonAtomic } from './util.mjs';

const ID=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const UNITS=new Set(['percent','tokens','requests','seconds','credits']);
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const poolContract=p=>hash([p.windows.map(w=>[w.id,w.unit,w.controller,w.review,w.retry,(w.models??[]).map(canonicalId).sort()]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0),Object.keys(p.ignore).sort()]);
const fail=(message,code='bad-quota-policy')=>{throw new OrchError(message,code);};
const id=v=>{if(typeof v!=='string'||!ID.test(v))fail('Invalid quota identifier');return v;};
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
function number(v) {if(!finite(v))fail('Quota estimates and reserves must be finite nonnegative numbers');return v;}
function readFile(file,owned=false) {
  if(owned && path.resolve(file)!==resolvedPath(file))fail('Quota state path traverses a link','quota-state-unsafe');
  const s=owned?fs.lstatSync(file):fs.statSync(file);
  if(!s.isFile()||s.size>262144||(owned&&(s.isSymbolicLink()||s.nlink!==1)))fail('Quota file must be a regular bounded file','quota-state-unsafe');
  return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}

/** Bind an explicit capability/forecast policy to already validated subscription accounts. */
export function validateQuotaPolicy(raw,usageConfig,baseDir) {
  try {
    if(raw?.version!==1||typeof raw.usageConfig!=='string'||!raw.usageConfig||typeof raw.stateRoot!=='string'||!raw.stateRoot||!Array.isArray(raw.pools)||!raw.pools.length||raw.pools.length>8||!Array.isArray(raw.routes)||!raw.routes.length||raw.routes.length>128)fail('Invalid quota policy');
    const pools=raw.pools.map(p=>{
      const source=usageConfig.pools.find(x=>x.id===p.id);
      if(!source||source.billing!=='subscription'||!Array.isArray(p.windows)||!p.windows.length||p.windows.length>32)fail('Quota policy requires bound subscription windows');
      const windows=p.windows.map(w=>{
        if(!UNITS.has(w.unit))fail('Spend and credit balances cannot supply subscription quota');
        if(w.models!=null&&(!Array.isArray(w.models)||w.models.length>16||w.models.some(m=>typeof m!=='string'||!m)))fail('Invalid window model scope');
        return {id:id(w.id),unit:w.unit,controller:number(w.controller),review:number(w.review),retry:number(w.retry),warn:number(w.warn),models:w.models??[]};
      });
      if(new Set(windows.map(w=>w.id)).size!==windows.length)fail('Duplicate quota windows');
      const ignore=p.ignore??{};
      if(typeof ignore!=='object'||Array.isArray(ignore)||Object.keys(ignore).length>32)fail('Invalid ignored windows');
      for(const [key,reason] of Object.entries(ignore))if(!ID.test(key)||typeof reason!=='string'||!reason.trim()||reason.length>256||windows.some(w=>w.id===key))fail('Ignored windows need distinct IDs and explanations');
      return {id:source.id,key:hash([source.provider,source.collector.accountFingerprint,source.collector.kind==='codexbar'?null:source.workspace]),windows,ignore:{...ignore}};
    });
    if(new Set(pools.map(p=>p.id)).size!==pools.length||new Set(pools.map(p=>p.key)).size!==pools.length)fail('Billing aliases must share one policy pool');
    const routes=raw.routes.map(r=>{
      const binding=usageConfig.bindings.find(b=>b.id===r.binding),pool=pools.find(p=>p.id===binding?.pool);
      if(!binding||!binding.model||!pool)fail('Each quota route needs an exact model/account/role binding');
      const costs={};
      for(const w of pool.windows) {
        if(w.models.length&&!w.models.some(m=>canonicalId(m)===canonicalId(binding.model)))continue;
        const c=r.costs?.[w.id];
        if(!c||Object.keys(c).some(k=>!['XS','S','M'].includes(k)))fail('Every blocking window needs per-size forecasts');
        costs[w.id]={};
        for(const size of ['XS','S','M']) {if(number(c[size])===0)fail('Launch forecasts must be positive');costs[w.id][size]=c[size];}
      }
      if(!Object.keys(costs).length||Object.keys(r.costs??{}).some(k=>!Object.hasOwn(costs,k)))fail('Invalid route forecast windows');
      return {binding:binding.id,role:binding.role,cli:binding.harness,model:binding.model,pool:pool.id,poolKey:pool.key,capability:id(r.capability),costs};
    });
    if(new Set(routes.map(r=>JSON.stringify([r.role,r.cli,r.model]))).size!==routes.length)fail('Duplicate or ambiguous quota routes');
    if(!Array.isArray(raw.localRoutes??[])||(raw.localRoutes??[]).length>64)fail('Invalid local routes');
    const localRoutes=(raw.localRoutes??[]).map(r=>{
      if(!['worker','reviewer','controller'].includes(r.role)||getAdapter(r.cli).lane!=='local'||typeof r.model!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,119}$/.test(r.model))fail('Unmetered routes require an explicitly selected local adapter/model');
      return {cli:r.cli,model:r.model,role:r.role,capability:id(r.capability)};
    });
    if(new Set([...routes,...localRoutes].map(r=>JSON.stringify([r.role,r.cli,r.model]))).size!==routes.length+localRoutes.length)fail('Ambiguous local/subscription route');
    return {version:1,usageConfig:path.resolve(baseDir,raw.usageConfig),stateRoot:path.resolve(baseDir,raw.stateRoot),pools,routes,localRoutes};
  } catch(e) {if(e instanceof OrchError&&e.code==='bad-quota-policy')throw e;fail('Invalid quota policy: explicitly bind subscription pools, capabilities, windows, reserves and forecasts');}
}

export function loadQuotaPolicy(policyFile=undefined) {
  const file=policyFile===undefined?setting('ORCH_QUOTA_POLICY','quotaPolicy',null,{isPath:true}):policyFile;
  if(!file)return null;
  try {
    const raw=readFile(path.resolve(file)),base=path.dirname(path.resolve(file));
    const usageFile=path.resolve(base,raw.usageConfig);
    const usageConfig=validateUsageConfig(readFile(usageFile),path.dirname(usageFile));
    return validateQuotaPolicy(raw,usageConfig,base);
  } catch(e) {if(e instanceof OrchError&&e.code==='bad-quota-policy')throw e;fail('Cannot load the explicit quota policy and bound usage configuration');}
}

const applies=(models,model)=>!models?.length||models.some(m=>canonicalId(m)===canonicalId(model));
/** Pure decision; candidates must already pass roster/workload/permission/reviewer checks. */
export function evaluateQuota({policy,usage,leases=[],stateError=null,candidates,role,size,capability,purpose='normal',now=Date.now()}) {
  if(!['controller','worker','reviewer'].includes(role)||!['XS','S','M'].includes(size)||!['normal','retry'].includes(purpose)||!ID.test(capability??''))fail('Quota selection needs role, size, capability and normal|retry purpose','bad-quota-selection');
  const routes=candidates.map((candidate,index)=>{
    const r=policy.routes.find(r=>r.role===role&&r.cli===candidate.cli&&r.model===candidate.model);
    const result={...candidate,index,pool:r?.pool??null,eligible:false,reasons:[],warnings:[],windows:[],pacingDeficit:null};
    const reject=why=>{result.reasons.push(why);return result;};
    if(policy.localRoutes?.some(r=>r.role===role&&r.cli===candidate.cli&&r.model===candidate.model&&r.capability===capability)) {
      result.eligible=true;result.warnings.push('explicit unmetered local route; existing serial lane guard applies');return result;
    }
    if(!r||r.capability!==capability)return reject('route is not explicitly qualified for this capability');
    if(stateError)return reject('shared quota reservations unavailable; inspect protected state');
    if(role!=='controller'&&!PUBLIC_ADAPTERS.includes(candidate.cli)&&!(candidate.cli==='fake'&&process.env.ORCH_ALLOW_FAKE==='1'))return reject('no installed orch launch adapter for this harness');
    const p=policy.pools.find(p=>p.id===r.pool),observed=usage.pools.find(p=>p.id===r.pool);
    if(leases.some(l=>l.poolKey===p.key&&l.contract&&l.contract!==poolContract(p)))return reject('shared pool window/reserve contract changed while holds remain');
    if(!observed||observed.billing!=='subscription'||observed.freshness!=='fresh'||observed.error||!observed.observation?.bindingVerified)return reject('subscription observation is missing, stale, unbound or failed');
    const actual=observed.observation.windows.filter(w=>w.kind==='quota'&&applies(w.models,r.model));
    for(const w of actual)if(!p.windows.some(rule=>rule.id===w.id&&applies(rule.models,r.model))&&!Object.hasOwn(p.ignore,w.id))return reject(`unaccounted quota window ${w.id}`);
    for(const rule of p.windows.filter(w=>applies(w.models,r.model))) {
      const w=actual.find(w=>w.id===rule.id);
      if(!w||w.unit!==rule.unit||w.freshness!=='fresh'||!finite(w.remaining)||(w.resetsAt&&Date.parse(w.resetsAt)<=now))return reject(`unknown, stale or incompatible window ${rule.id}`);
      const holds=leases.filter(l=>l.poolKey===p.key).map(l=>Object.hasOwn(l.costs,rule.id)?l.costs[rule.id]:null).filter(Boolean);
      if(holds.some(h=>h.unit!==w.unit||!finite(h.amount)))return reject(`incompatible reservations for ${rule.id}`);
      const held=holds.reduce((a,h)=>a+h.amount,0),remaining=w.remaining-held;
      const reserve=rule.controller+(role==='reviewer'?0:rule.review)+(purpose==='retry'?0:rule.retry);
      const forecast=r.costs[rule.id]?.[size];
      if(!finite(forecast)||forecast<=0)return reject(`missing forecast for ${rule.id}`);
      let pacingDeficit=null;
      if(finite(w.limit)&&w.limit>0&&finite(w.durationMinutes)&&w.durationMinutes>0&&w.resetsAt) {
        const elapsed=1-Math.min(1,Math.max(0,(Date.parse(w.resetsAt)-now)/(w.durationMinutes*60000)));
        pacingDeficit=elapsed-(1-Math.max(0,Math.min(w.limit,remaining))/w.limit);
      }
      result.windows.push({id:w.id,unit:w.unit,reportedRemaining:w.remaining,held,remaining,reserve,forecast,pacingDeficit,resetsAt:w.resetsAt,observedAt:observed.observation.observedAt});
      if(remaining<=rule.warn)result.warnings.push(`${p.id}/${w.id}: low subscription headroom; checkpoint controller work`);
      if(remaining-forecast<reserve)result.reasons.push(`${p.id}/${w.id}: forecast would consume protected reserves`);
    }
    if(!result.windows.length)return reject('no applicable known subscription windows');
    result.eligible=!result.reasons.length;
    // A missing cycle cannot be guessed. Existing rotation breaks unpaced ties.
    if(result.windows.every(w=>w.pacingDeficit!=null))result.pacingDeficit=Math.min(...result.windows.map(w=>w.pacingDeficit));
    else result.warnings.push('reset-cycle pacing unknown; using existing rotation within unpaced routes');
    return result;
  });
  const eligible=routes.filter(r=>r.eligible);
  const independent=eligible.some(r=>!r.same_family);
  const paced=eligible.filter(r=>!independent||!r.same_family).every(r=>r.pacingDeficit!=null);
  eligible.sort((a,b)=>(!!a.same_family===!!b.same_family?0:a.same_family?1:-1)||(paced?(b.pacingDeficit??-1)-(a.pacingDeficit??-1):0)||a.index-b.index);
  const best=eligible[0];
  return {enabled:true,estimates:true,capability,role,size,purpose,allocationMode:paced?'reset-cycle':'rotation-unknown-cycle',pick:best?{cli:best.cli,model:best.model,pool:best.pool}:null,deferred:!best,reason:best?paced?'equal-capability subscription allocation by limiting reset-cycle deficit and rotation':'equal-capability rotation: reset-cycle metadata incomplete; do not starve unpaced subscriptions':'deferred: no qualified subscription route has known usable headroom',routes};
}

const stateFile=p=>path.join(p.stateRoot,'quota','reservations.json');
export function readQuotaState(policy) {
  try {
    const state=readFile(stateFile(policy),true);
    if(state?.version!==1||!Array.isArray(state.leases)||state.leases.length>256)throw new Error();
    const ids=new Set();
    for(const l of state.leases) {
      if(!ID.test(l.id)||ids.has(l.id)||!/^[a-f0-9]{64}$/.test(l.poolKey)||!/^[a-f0-9]{64}$/.test(l.contract)||typeof l.runRoot!=='string'||!path.isAbsolute(l.runRoot)||!Number.isFinite(Date.parse(l.createdAt))||!l.costs||Array.isArray(l.costs)||typeof l.costs!=='object'||!Object.keys(l.costs).length||Object.keys(l.costs).length>32)throw new Error();
      ids.add(l.id);
      for(const [key,h] of Object.entries(l.costs))if(!ID.test(key)||!UNITS.has(h?.unit)||!finite(h.amount)||h.amount<=0)throw new Error();
    }
    return state;
  } catch(e) {if(e.code==='ENOENT')return {version:1,leases:[]};fail('Quota reservations unreadable or unsafe; admission deferred, inspect shared state','quota-state-unsafe');}
}
function writeState(policy,state) {
  // Inspect existing leaf and parents again before atomic publication.
  readQuotaState(policy);
  const file=stateFile(policy);
  if(path.resolve(file)!==resolvedPath(file)||Buffer.byteLength(JSON.stringify(state))>262144)fail('Quota reservation storage is unsafe or full','quota-state-unsafe');
  fs.mkdirSync(path.dirname(file),{recursive:true});writeJsonAtomic(file,state);
}
export function reconcileQuota(policy,state,usage) {
  return {...state,leases:state.leases.filter(l=>{
    const p=policy.pools.find(p=>p.key===l.poolKey),o=usage.pools.find(o=>o.id===p?.id);
    if(!o||o.freshness!=='fresh'||o.error||!o.observation?.bindingVerified)return true;
    try {
      const cfg=loadConfig(l.runRoot),archived=readArchived(cfg,'run',l.id);
      const facts=archived?.facts??keeperFacts(readTailLines(paths(cfg,l.id).keeper,32768));
      // Worker exit plus closed streams (or an explicit keeper refusal) is required.
      const completed=facts.workerExit&&facts.streamsClosed==='streams-closed'&&facts.keeperExit?.write_failures===0?facts.keeperExit.at:!facts.spawned?facts.blocked?.at:null;
      if(!Number.isFinite(Date.parse(completed)))return true;
      if(Object.keys(l.costs).some(id=>{const w=o.observation.windows.find(w=>w.id===id);return !w||w.kind!=='quota'||w.unit!==l.costs[id].unit||w.freshness!=='fresh';}))return true;
      return Date.parse(o.observation.observedAt)<Date.parse(completed);
    } catch {return true;}
  })};
}

/** Cached snapshots never create/reconcile state. Refresh can retire confirmed holds. */
export async function quotaSnapshot({policyFile=undefined,refresh=false,now=undefined}={}) {
  const policy=loadQuotaPolicy(policyFile);
  if(!policy)return {enabled:false,policy:null,usage:null,leases:[],warnings:[]};
  const usage=await getUsage({stateRoot:policy.stateRoot,configFile:policy.usageConfig,refresh,now});
  let state={version:1,leases:[]},stateError=null;
  try {state=readQuotaState(policy);
  if(refresh)state=await withOperationLock({stateRoot:policy.stateRoot},'quota-admission',async()=>{
    const cached=await getUsage({stateRoot:policy.stateRoot,configFile:policy.usageConfig,now});
    const old=readQuotaState(policy),next=reconcileQuota(policy,old,cached);
    if(next.leases.length!==old.leases.length)writeState(policy,next);
    return next;
  },5000);
  } catch(e) {if(!['quota-state-unsafe','resource-locked','resource-path-unsafe'].includes(e.code))throw e;stateError=e.code;}
  const warnings=[];
  if(stateError)warnings.push('shared quota reservations unknown; subscription admission deferred');
  for(const p of policy.pools) {
    const o=usage.pools.find(o=>o.id===p.id);
    if(o?.freshness!=='fresh'||o.error)warnings.push(`${p.id}: subscription headroom unknown or stale`);
    else for(const w of p.windows) {
      const actual=o.observation?.windows.find(x=>x.id===w.id);
      const held=state.leases.filter(l=>l.poolKey===p.key).reduce((sum,l)=>sum+(l.costs[w.id]?.amount??0),0);
      if(actual?.freshness!=='fresh'||actual.remaining==null)warnings.push(`${p.id}/${w.id}: headroom unknown`);
      else if(actual.remaining-held<=w.warn)warnings.push(`${p.id}/${w.id}: low headroom; checkpoint controller work`);
    }
  }
  return {enabled:true,policy,usage,leases:state.leases,stateError,warnings};
}

/** Atomic forecast hold precedes all launch side effects. Never reroutes a direct launch. */
export async function withQuotaAdmission({args,cfg,cli,model,role,id},launch) {
  const policy=loadQuotaPolicy(args['quota-policy']);
  if(!policy)return launch(null,()=>{});
  if(!args.capability||!args.size)fail('Enabled quota policy requires --capability and --size on every launch','bad-quota-selection');
  if(!['XS','S','M'].includes(args.size)||!['normal','retry'].includes(args['quota-purpose']??'normal'))fail('Invalid quota size or purpose','bad-quota-selection');
  if(policy.localRoutes.some(r=>r.role===(role==='review'?'reviewer':'worker')&&r.cli===cli&&r.model===model&&r.capability===args.capability))return launch({billing:'local',reserved:false,capability:args.capability,size:args.size},()=>{});
  await getUsage({stateRoot:policy.stateRoot,configFile:policy.usageConfig,refresh:true});
  const reservation=await withOperationLock({stateRoot:policy.stateRoot},'quota-admission',async()=>{
    const usage=await getUsage({stateRoot:policy.stateRoot,configFile:policy.usageConfig});
    const state=reconcileQuota(policy,readQuotaState(policy),usage);
    const decision=evaluateQuota({policy,usage,leases:state.leases,candidates:[{cli,model}],role:role==='review'?'reviewer':'worker',size:args.size,capability:args.capability,purpose:args['quota-purpose']??'normal'});
    if(!decision.pick)fail(`${decision.reason}; ${decision.routes.flatMap(r=>r.reasons).join('; ')}. Use orch pick with the same capability for equal alternatives. Running jobs continue.`, 'quota-deferred');
    if(state.leases.length>=256||state.leases.some(l=>l.id===id))fail('Quota reservation capacity exhausted or run ID already reserved','quota-deferred');
    const route=decision.routes[0],p=policy.pools.find(p=>p.id===route.pool);
    const lease={id,poolKey:p.key,contract:poolContract(p),runRoot:path.resolve(cfg.stateRoot),createdAt:new Date().toISOString(),costs:Object.fromEntries(route.windows.map(w=>[w.id,{unit:w.unit,amount:w.forecast}]))};
    writeState(policy,{version:1,leases:[...state.leases,lease]});
    return {lease,decision};
  },5000);
  let attempted=false;
  try {return await launch({reservation:id,pool:reservation.decision.pick.pool,capability:args.capability,size:args.size,purpose:args['quota-purpose']??'normal',estimates:true,windows:reservation.decision.routes[0].windows,warnings:reservation.decision.routes[0].warnings},()=>{attempted=true;});}
  catch(e) {
    if(!attempted)try {await withOperationLock({stateRoot:policy.stateRoot},'quota-admission',()=>{
      const state=readQuotaState(policy);writeState(policy,{...state,leases:state.leases.filter(l=>hash(l)!==hash(reservation.lease))});
    },5000);}catch { /* Unknown state stays held. Never mask the launch error. */ }
    throw e;
  }
}

export async function cmdQuota(args,io) {
  if(args._.length||Object.keys(args).some(k=>!['_','json','quota-policy','refresh','state-root'].includes(k)))fail('Usage: orch quota [--quota-policy <private file>] [--refresh] [--json]','bad-quota-selection');
  const snapshot=await quotaSnapshot({policyFile:args['quota-policy'],refresh:args.refresh===true});
  const out={enabled:snapshot.enabled,estimates:true,usage:snapshot.usage,stateError:snapshot.stateError??null,holds:snapshot.stateError?null:snapshot.leases.map(l=>({id:l.id,poolKey:l.poolKey,createdAt:l.createdAt,costs:l.costs})),warnings:snapshot.warnings};
  if(args.json)io.log(JSON.stringify(out));
  else io.log(out.enabled?`${out.holds?.length??'unknown'} forecast holds; ${out.warnings.join('; ')||'no low-headroom warnings'}`:'Subscription quota policy is disabled.');
  return out;
}
