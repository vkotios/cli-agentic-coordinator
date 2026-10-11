// Optional deterministic task fit. Research/catalog entries do not enable launches.
import fs from 'node:fs';
import path from 'node:path';
import {setting} from './config.mjs';
import {OrchError} from './errors.mjs';
import {getAdapter,PUBLIC_ADAPTERS} from './adapters/index.mjs';
import {canonicalId,familyOf,loadRoster} from './models.mjs';
import {computePick,readLedger,ledgerPath} from './ledger.mjs';
import {evaluateQuota,quotaSnapshot} from './quota.mjs';

const ID=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const TYPES={format:0,triage:1,helper:2,integration:2,feature:3,refactor:3,visual:3,build:3,migration:3,auth:3,race:4,architecture:4,review:2};
const CRITICAL=new Set(['migration','auth','race','architecture']);
function fail(message,code='bad-routing-policy'){throw new OrchError(message,code);}
function identifier(v){if(typeof v!=='string'||!ID.test(v))fail('Invalid routing identifier');return v;}
function list(v,allowed=null){if(!Array.isArray(v)||v.length>32||new Set(v).size!==v.length||v.some(x=>typeof x!=='string'||!ID.test(x)||(allowed&&!allowed.includes(x))))fail('Invalid distinct routing requirements');return [...v];}
function amount(v,max=10000000){if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>max)fail('Invalid bounded routing number');return v;}
function date(v){return typeof v==='string'&&Number.isFinite(Date.parse(v));}
function read(file){try{const stat=fs.statSync(file);if(!stat.isFile()||stat.size>262144)fail('Routing input must be a bounded regular file');return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch(e){if(e instanceof OrchError)throw e;fail('Cannot read routing policy/task JSON');}}

export function validateTask(raw){
  if(raw?.version!==1||!Object.hasOwn(TYPES,raw.type)||!/^C[0-4]$/.test(raw.class)||!['XS','S','M'].includes(raw.size)||!['standard','critical'].includes(raw.risk))fail('Task requires version, type, C0-C4 class, XS/S/M size and risk','bad-routing-task');
  if(Number(raw.class[1])<TYPES[raw.type]||(raw.class==='C0'&&raw.type!=='format'))fail('Task class cannot lower the required workload demand','bad-routing-task');
  return {version:1,type:raw.type,class:raw.class,size:raw.size,risk:CRITICAL.has(raw.type)?'critical':raw.risk,tools:list(raw.tools),modalities:list(raw.modalities,['text','image','audio','video','document']),contextTokens:amount(raw.contextTokens),capability:identifier(raw.capability)};
}

export function validateRoutingPolicy(raw){
  if(raw?.version!==1||!Array.isArray(raw.profiles)||!raw.profiles.length||raw.profiles.length>128||!['rotation','cost','latency'].includes(raw.preference))fail('Routing policy needs version 1, profiles and tie preference');
  const maxAge=amount(raw.availabilityMaxAgeMinutes,10080);if(!maxAge)fail('Availability freshness must be positive');
  const profiles=raw.profiles.map(p=>{
    if(!PUBLIC_ADAPTERS.includes(p.cli)&&!(p.cli==='fake'&&process.env.ORCH_ALLOW_FAKE==='1'))fail('Profile needs an existing launch adapter');
    const adapter=getAdapter(p.cli);
    if(!['worker','reviewer'].includes(p.role)||!['local','subscription'].includes(p.billing)||typeof p.enabled!=='boolean'||typeof p.model!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,119}$/.test(p.model)||typeof p.harnessVersion!=='string'||!p.harnessVersion||p.harnessVersion.length>64)fail('Invalid execution profile identity');
    if((p.billing==='local')!==(adapter.lane==='local')||(p.billing==='local'&&p.account!=='local'))fail('Profile billing must match its adapter and explicit account');
    if(!['available','unknown','unavailable'].includes(p.availability?.status)||(p.availability.status==='available'&&!date(p.availability.checkedAt)))fail('Availability requires status and a checked timestamp');
    if(!['qualified','trial','unqualified'].includes(p.qualification?.status)||(p.qualification.evidence!=null&&(typeof p.qualification.evidence!=='string'||!p.qualification.evidence.trim()||p.qualification.evidence.length>256))||(p.qualification.status==='qualified'&&!p.qualification.evidence))fail('Qualified profiles require an evidence reference');
    const s=p.supports;
    if(!s)fail('Profiles require task-specific capability declarations');
    const launch=p.launch??{agent:null,effort:null,flags:[]};
    if(!Array.isArray(launch.flags)||launch.flags.length>16||launch.flags.some(f=>typeof f!=='string'||!f||f.length>256)||[launch.agent,launch.effort].some(v=>v!=null&&(typeof v!=='string'||!v||v.length>64)))fail('Invalid declared launch selectors');
    return {id:identifier(p.id),cli:p.cli,harnessVersion:p.harnessVersion,model:p.model,role:p.role,account:identifier(p.account),billing:p.billing,enabled:p.enabled,availability:{status:p.availability.status,checkedAt:p.availability.checkedAt??null},qualification:{status:p.qualification.status,evidence:p.qualification.evidence??null},launch:{agent:launch.agent??null,effort:launch.effort??null,flags:[...launch.flags]},capability:identifier(p.capability),supports:{types:list(s.types,Object.keys(TYPES)),classes:list(s.classes,['C1','C2','C3','C4']),risks:list(s.risks,['standard','critical']),tools:list(s.tools),modalities:list(s.modalities,['text','image','audio','video','document']),contextTokens:amount(s.contextTokens)},costRank:amount(p.costRank,100),latencyRank:amount(p.latencyRank,100)};
  });
  if(new Set(profiles.map(p=>p.id)).size!==profiles.length||new Set(profiles.map(p=>JSON.stringify([p.role,p.cli,canonicalId(p.model)]))).size!==profiles.length)fail('Ambiguous profile/model/account selectors; an execution route must be unique');
  return {version:1,catalogVersion:identifier(raw.catalogVersion),availabilityMaxAgeMinutes:maxAge,preference:raw.preference,profiles};
}

export function routingInputs(args){
  const file=args['routing-policy']??setting('ORCH_ROUTING_POLICY','routingPolicy',null,{isPath:true});
  if(!file){if(args.task||args.profile||args['routing-mode'])fail('Task/profile options require an enabled routing policy');return null;}
  if(typeof args.task!=='string'||!args.task)fail('Enabled routing policy requires --task <JSON file>','bad-routing-task');
  if(args['routing-mode']&&!['qualified','qualification'].includes(args['routing-mode']))fail('Routing mode must be qualified or qualification');
  const policy=validateRoutingPolicy(read(path.resolve(file))),task=validateTask(read(path.resolve(args.task)));
  if(args.size&&args.size!==task.size)fail('Task size must match the launch/pick size','bad-routing-task');
  if(args.capability&&args.capability!==task.capability)fail('Task capability must match the requested quota group','bad-routing-task');
  return {policy,task,mode:args['routing-mode']??'qualified'};
}

/** Candidates already passed the existing roster filters. Quota ranks only this acceptable set. */
/** @param {any} input */
export function selectRouting({policy,task,role,candidates,roster=[],implementerModels=[],quota={enabled:false},mode='qualified',purpose='normal',checkHeadroom=true,now=Date.now()}){
  if(!['worker','reviewer'].includes(role)||!['qualified','qualification'].includes(mode))fail('Invalid routing role/mode');
  const requiredClass=role==='reviewer'&&task.risk==='critical'?'C4':task.class;
  const out={enabled:true,policyVersion:policy.version,catalogVersion:policy.catalogVersion,task,requiredClass,mode,status:'no-eligible-route',profile:null,pick:null,profiles:[],quota:null};
  if(task.class==='C0')return {...out,status:'action-required',reason:'C0 requires an explicit recorded deterministic action route; no model launch selected'};
  const impl=new Set(implementerModels.map(canonicalId)),families=new Set(implementerModels.map(m=>familyOf(m,roster)));
  out.profiles=policy.profiles.map((p,index)=>{
    const c=candidates.find(c=>c.cli===p.cli&&c.model===p.model),reasons=[];let unknown=false;
    if(!c)reasons.push('excluded by roster eligibility');
    if(!p.enabled)reasons.push('profile disabled');
    if(p.role!==role)reasons.push('wrong profile role');
    if(p.billing==='local'&&task.size==='M')reasons.push('local models only for XS/S');
    if(p.capability!==task.capability)reasons.push('not qualified for this capability group');
    if(mode==='qualified'&&p.qualification.status!=='qualified')reasons.push('profile has no qualified task evidence');
    if(!p.supports.types.includes(task.type))reasons.push('task type unsupported');
    if(!p.supports.classes.includes(requiredClass))reasons.push('required class '+requiredClass+' unsupported');
    if(!p.supports.risks.includes(task.risk))reasons.push('risk unsupported');
    if(p.supports.contextTokens<task.contextTokens)reasons.push('insufficient context allowance');
    for(const key of ['tools','modalities'])if(task[key].some(v=>!p.supports[key].includes(v)))reasons.push('required '+key+' unsupported');
    const sameFamily=role==='reviewer'&&families.has(familyOf(p.model,roster));
    if(role==='reviewer'&&impl.has(canonicalId(p.model)))reasons.push('implementer model cannot review itself');
    if(sameFamily&&task.risk==='critical')reasons.push('critical review requires a different model family');
    if(role==='reviewer'&&task.risk==='critical'&&(!implementerModels.length||[p.model,...implementerModels].some(m=>!roster.find(r=>canonicalId(r.model)===canonicalId(m))?.family)))reasons.push('critical review requires known roster family identities');
    // Only task-eligible profiles influence unknown-vs-ineligible outcomes.
    if(!reasons.length){
      if(p.availability.status==='unavailable')reasons.push('profile unavailable');
      else if(p.availability.status!=='available'||!date(p.availability.checkedAt)||Date.parse(p.availability.checkedAt)>now||now-Date.parse(p.availability.checkedAt)>policy.availabilityMaxAgeMinutes*60000){unknown=true;reasons.push('profile availability unknown or stale');}
      if(p.billing==='subscription'){
        const binding=quota.policy?.routes.find(r=>r.cli===p.cli&&r.model===p.model&&r.role===role&&r.pool===p.account&&r.capability===task.capability);
        if(!quota.enabled||!binding){unknown=true;reasons.push('subscription account/quota binding unknown or incompatible');}
      }
    }
    return {id:p.id,cli:p.cli,model:p.model,index,rotationIndex:candidates.indexOf(c),candidate:c,eligible:!reasons.length,reasons,unknown,same_family:sameFamily};
  });
  const eligible=out.profiles.filter(p=>p.eligible);
  eligible.sort((a,b)=>(!!a.same_family===!!b.same_family?0:a.same_family?1:-1)||(policy.preference==='rotation'?0:policy.profiles[a.index][policy.preference+'Rank']-policy.profiles[b.index][policy.preference+'Rank'])||(a.candidate.runs??0)-(b.candidate.runs??0)||a.rotationIndex-b.rotationIndex);
  if(!eligible.length)return {...out,status:out.profiles.some(p=>p.unknown)?'availability-unknown':'no-eligible-route',reason:'No execution profile satisfies the task, qualification and availability requirements'};
  let best=eligible[0];
  if(quota.enabled&&checkHeadroom){
    out.quota=evaluateQuota({policy:quota.policy,usage:quota.usage,leases:quota.leases,stateError:quota.stateError,candidates:eligible.map(p=>({...p.candidate,same_family:p.same_family})),role,size:task.size,capability:task.capability,purpose,now});
    if(!out.quota.pick)return {...out,status:'quota-deferred',reason:out.quota.reason};
    best=eligible.find(p=>p.cli===out.quota.pick.cli&&p.model===out.quota.pick.model);
  }
  const p=policy.profiles[best.index];
  return {...out,status:'selected',profile:p,pick:{cli:p.cli,model:p.model,profile:p.id},reason:'Qualified task-fit profile; '+(out.quota?.reason??policy.preference+' preference and existing rotation')};
}

/** Recheck an explicitly bound launch; never switch model/harness/account or grant permission. */
export async function prepareRoutingLaunch({args,cfg,cli,model,role,implementerModels=[]}){
  const inputs=routingInputs(args);if(!inputs)return null;
  if(!args.profile)fail('Enabled routing policy requires --profile from the selected proposal','routing-deferred');
  const profile=inputs.policy.profiles.find(p=>p.id===args.profile);
  if(!profile||profile.cli!==cli||profile.model!==model||profile.role!==role)fail('Bound launch does not match the execution profile','routing-deferred');
  if((args.agent??null)!==profile.launch.agent||(args.effort??null)!==profile.launch.effort||JSON.stringify(args.flag??[])!==JSON.stringify(profile.launch.flags))fail('Launch agent/effort/flags differ from the declared qualified profile','routing-deferred');
  const {models:roster}=loadRoster(args.roster),{rows}=readLedger(ledgerPath(cfg,args));
  const permitted=roster.map(p=>args['owner-approved-model']&&canonicalId(p.model)===canonicalId(model)?{...p,requires_permission:false}:p);
  const legacy=computePick({roster:permitted,rows,workload:role==='reviewer'?'review':'implement',size:inputs.task.size,implementerModels});
  const quota=await quotaSnapshot({policyFile:args['quota-policy']});
  // P08 refreshes and atomically checks headroom immediately after this fixed-profile guard.
  const result=selectRouting({...inputs,policy:{...inputs.policy,profiles:[profile]},role,candidates:legacy.candidates,roster,implementerModels,quota,purpose:args['quota-purpose']??'normal',checkHeadroom:false});
  if(result.status!=='selected')fail(result.status+': '+result.profiles.flatMap(p=>p.reasons).join('; ')+' '+result.reason,'routing-deferred');
  args.size=inputs.task.size;args.capability=inputs.task.capability;
  return {profile:profile.id,model:profile.model,cli:profile.cli,harnessVersion:profile.harnessVersion,role,account:profile.account,billing:profile.billing,qualification:profile.qualification,launch:profile.launch,task:inputs.task,policyVersion:inputs.policy.version,catalogVersion:inputs.policy.catalogVersion,mode:inputs.mode};
}
