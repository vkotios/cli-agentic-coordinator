// Repeatable, read-only setup health. Preferences and declarations never grant access.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {setupProposal,setupStatus,localPath,readSetupInput,checkedSetupPath} from './setup.mjs';
import {samePath,isInside} from './git.mjs';
import {configFilePath} from './config.mjs';
import {whereAll,npmPrefixes} from './exe.mjs';
import {OPENCODE_EXE_IN_PREFIX} from './adapters/opencode.mjs';
import {validateRoutingPolicy} from './routing.mjs';
import {validateAdviserPolicy} from './adviser.mjs';
import {validateUsageConfig,getUsage} from './usage.mjs';
import {validateQuotaPolicy} from './quota.mjs';
import {planAdopt} from './adopt.mjs';
import {OrchError} from './errors.mjs';
import {canonicalId} from './models.mjs';
import {qualificationStatus} from './setup-qualification.mjs';
import {controllerQualification} from './setup-controller.mjs';
import {museBinaryInDirectory} from './adapters/muse.mjs';
import {copilotStoreCandidates} from './adapters/copilot.mjs';

const MAX=1048576,HARNESSES=['claude','codex','opencode','vibe','agy','copilot','muse'];
const fail=()=>{throw new OrchError('Use setup health with a complete session and separate private configuration; no refresh or activation options','setup-health-refused');};
const equal=isDeepStrictEqual;
function input(file){const x=readSetupInput(file,{max:MAX}).raw;if(!x||typeof x!=='object'||Array.isArray(x))fail();return x;}
function reference(value,repo,session){const file=path.resolve(localPath(value,repo));if(isInside(file,session))fail();return file;}
function existing(file){try{checkedSetupPath(file);return true;}catch{return false;}}
// Discovery only inspects executable files, never runs the harness or login commands.
function discover(config,base){return Object.fromEntries(HARNESSES.map(h=>{
  const override=process.env[`ORCH_${h.toUpperCase()}_EXE`]||config.exe?.[h];
  const fallback=override?[]:['claude','vibe'].includes(h)?[path.join(process.env.USERPROFILE||os.homedir(),'.local','bin',h+'.exe')]:h==='opencode'?npmPrefixes('opencode').map(p=>path.join(p,...OPENCODE_EXE_IN_PREFIX)):h==='muse'?whereAll('muse.cmd').map(f=>museBinaryInDirectory(path.dirname(f))).filter(Boolean):h==='copilot'?copilotStoreCandidates():[];
  const files=override?[typeof override==='string'?path.resolve(process.env[`ORCH_${h.toUpperCase()}_EXE`]?process.cwd():base,override):'']:[...(h==='muse'?[]:whereAll(h+'.exe')),...fallback];
  return [h,files.some(f=>{try{return /\.exe$/i.test(f)&&fs.statSync(f).isFile();}catch{return false;}})];
}));}
/** @param {any} options @param {any} seams */
export async function setupHealth(session,options,seams={}){
  if(!options||Object.keys(options).join(',')!=='configFile'||typeof options.configFile!=='string')fail();
  const p=setupProposal(session),s=setupStatus(session),a=p.answers,repo=p.repo;
  const stateRoot=reference(a.resources.stateRoot,repo,session),reviewRoot=reference(a.resources.reviewRoot,repo,session),file=reference(options.configFile,repo,session);
  if(isInside(stateRoot,reviewRoot)||isInside(reviewRoot,stateRoot)||isInside(session,stateRoot)||isInside(session,reviewRoot)||isInside(file,stateRoot)||isInside(file,reviewRoot))fail();
  // Unsafe files are refused, not read and reported as ordinary malformed config.
  if(fs.existsSync(file))checkedSetupPath(file);
  const now=seams.now??Date.now(),checks=[];
  const finding=(id,status,reason,nextStep)=>{const x={id,status,reason,nextStep};checks.push(x);return x;};
  let config={};try{config=input(file);}catch{finding('configuration','blocked','config-unreadable','Restore a bounded private JSON configuration, then run health again');}
  const expected={version:1,repo,controller:p.harness,routes:a.routes,router:a.router,cleanup:a.resources.cleanup};
  const expectedUsage=a.usage.enabled?path.resolve(a.usage.configFile):null;
  const matched=equal(config.setupPreferences,expected)&&config.stateRoot===stateRoot&&config.reviewRoot===reviewRoot&&config.usageConfig===expectedUsage;
  if(!checks.some(c=>c.id==='configuration'))finding('configuration',matched?'ok':'blocked',matched?'setup-settings-match':'setup-settings-differ','Inspect current setup settings; reconfiguration needs a fresh preview and explicit approval');
  const configuration={status:matched?'matched':'blocked',selected:samePath(configFilePath(),file),executableSource:'effective-runtime-config',overrides:[]};
  for(const [env,key] of [['ORCH_STATE_ROOT','stateRoot'],['ORCH_REVIEW_ROOT','reviewRoot'],['ORCH_USAGE_CONFIG','usageConfig'],['ORCH_ROUTING_POLICY','routingPolicy'],['ORCH_ADVICE_POLICY','advicePolicy'],['ORCH_QUOTA_POLICY','quotaPolicy'],['ORCH_ROSTER','roster']])if(process.env[env]){configuration.overrides.push(env);if(['stateRoot','reviewRoot','usageConfig'].includes(key)&&!samePath(path.resolve(process.env[env]),config[key]??file))finding(env,'blocked','runtime-location-overridden','Inspect the effective environment override before using this configuration');}
  if(!configuration.selected)finding('selection','pending','config-not-selected','Select this private configuration explicitly through ORCH_CONFIG; health changes no environment');
  const expectedRetention=a.retention.enabled?{mode:a.retention.mode,successDays:a.retention.transcriptDays,otherDays:a.retention.transcriptDays,metadata:{enabled:true,successDays:a.retention.runDays,otherDays:a.retention.runDays}}:{mode:'disabled',successDays:30,otherDays:90,metadata:{enabled:false}};
  try{const state=input(path.join(stateRoot,'config.json'));finding('retention',equal(state.retention,expectedRetention)?'ok':'blocked',equal(state.retention,expectedRetention)?'retention-settings-match':'retention-settings-differ','Inspect retention settings; health never enables maintenance or removes data');}catch{finding('retention','blocked','state-config-unreadable','Inspect private state configuration; no repair was attempted');}
  for(const [id,dir] of [['state-location',stateRoot],['review-location',reviewRoot]]){try{const stat=checkedSetupPath(dir,true);finding(id,stat?'ok':'pending',stat?'ordinary-directory':'directory-not-created','Inspect the private resource location; health creates no directories');}catch{finding(id,'blocked','unsafe-resource-location','Restore an ordinary private directory before use');}}
  const base=path.dirname(file);
  const selected=(env,key)=>process.env[env]||config[key];
  const policy=(id,env,key,validate,missing='pending')=>{
    const value=selected(env,key);if(value==null||value===''){finding(id,missing,id+'-policy-missing','Supply the complete explicit private policy; preferences do not create one');return {status:missing,doc:null,file:null};}
    try{const f=reference(path.resolve(process.env[env]?process.cwd():base,value),repo,session),doc=validate(input(f),path.dirname(f));finding(id,'ok','policy-valid','Policy structure is valid; this is not live access or launch admission');return {status:'valid',doc,file:f};}catch{finding(id,'blocked','policy-invalid','Inspect the bounded private policy and its bindings, then run health again');return {status:'blocked',doc:null,file:null};}
  };
  const routing=policy('routing','ORCH_ROUTING_POLICY','routingPolicy',validateRoutingPolicy);
  const usage=policy('usage','ORCH_USAGE_CONFIG','usageConfig',validateUsageConfig,a.usage.enabled?'pending':'disabled');
  let telemetry={pools:[],bindings:[]};
  if(a.usage.enabled&&!usage.doc){usage.status='blocked';}
  if(usage.doc){
    try{checkedSetupPath(stateRoot,true);checkedSetupPath(path.join(stateRoot,'usage'),true);telemetry=await getUsage({stateRoot,configFile:usage.file,refresh:false,now});}catch{usage.status='blocked';finding('usage-cache','blocked','usage-cache-unavailable','Inspect protected cached telemetry; health never refreshes it');}
  }
  const quota=policy('quota','ORCH_QUOTA_POLICY','quotaPolicy',(raw,dir)=>{
    const f=reference(path.resolve(dir,raw.usageConfig),repo,session),u=validateUsageConfig(input(f),path.dirname(f)),q=validateQuotaPolicy(raw,u,dir);
    if(!samePath(q.stateRoot,stateRoot)||!usage.file||!samePath(f,usage.file))fail();return q;
  },'disabled');
  if(quota.status==='blocked'&&!usage.file){const check=checks.find(c=>c.id==='quota');check.reason='quota-usage-not-configured';check.nextStep='Configure the bound subscription telemetry before validating quota policy';}
  const advice=policy('advice','ORCH_ADVICE_POLICY','advicePolicy',validateAdviserPolicy,a.router.mode==='deterministic'?'disabled':'pending');
  if(advice.doc?.enabled){if(!samePath(advice.doc.stateRoot,stateRoot)||a.router.mode==='deterministic'||advice.doc.mode!==a.router.mode.slice(4)||advice.doc.keyEnv!==a.router.keyEnv||advice.doc.maxSpendUsd>a.router.budgetUsd){advice.status='blocked';finding('advice-binding','blocked','advice-preferences-differ','Inspect adviser mode, state and approved budget; health reads no key');}else finding('advice-admission','pending','key-and-provider-not-checked','Key presence, finite provider limit and account admission require the explicit advice path');}
  else if(a.router.mode!=='deterministic'&&advice.doc){advice.status='blocked';finding('advice-binding','blocked','advice-disabled','The adviser policy is disabled; inspect before requesting advice');}
  let models=s.discovery.models.filter(m=>m.source==='owner-roster').map(m=>({cli:m.harness,model:m.model,enabled:m.enabled,requires_permission:m.requiresPermission}));
  const roster=selected('ORCH_ROSTER','roster');
  let rosterEvidence='historical';
  if(roster){try{const raw=input(reference(path.resolve(process.env.ORCH_ROSTER?process.cwd():base,roster),repo,session));if(!Array.isArray(raw.models)||raw.models.length>64||raw.models.some(m=>!m||typeof m.cli!=='string'||typeof m.model!=='string'||m.model.length>200))fail();models=raw.models;rosterEvidence='current';finding('roster','ok','roster-readable','Roster availability and permissions remain explicit owner declarations');}catch{finding('roster','blocked','roster-unreadable','Inspect the private roster before launch');}}
  else finding('roster','pending','roster-evidence-historical','Supply the current private roster through configuration or ORCH_ROSTER; original discovery is historical');
  let installed={};try{const active=configFilePath();const activeConfig=configuration.selected?config:fs.existsSync(active)?input(active):process.env.ORCH_CONFIG?fail():{};installed=(seams.discover??discover)(activeConfig,path.dirname(active));}catch{finding('executables','blocked','discovery-unavailable','Inspect effective runtime executable configuration; no harness was run');}
  try{const plan=await planAdopt(repo,{harness:[p.harness],update:false});const actions=plan.items.map(i=>i.action);finding('adoption',actions.some(x=>['conflict','refused','stale'].includes(x))?'blocked':actions.some(x=>x==='create')?'pending':'ok',actions.some(x=>x==='create')?'adoption-incomplete':actions.some(x=>['conflict','refused','stale'].includes(x))?'adoption-needs-attention':'adoption-present','Inspect setup preview or adopt dry-run; health never writes instruction files');}catch{finding('adoption','blocked','adoption-unreadable','Inspect repository instruction routing; health attempted no repair');}
  let access={routes:[],status:'unavailable'};
  try{access=await qualificationStatus(session,{configFile:file},seams);}catch{ /* Invalid evidence grants no readiness. */ }
  let controllers={routes:[],childRoutes:[]};try{controllers=await (seams.controllerQualification??controllerQualification)(session,{configFile:file},seams);access.routes.push(...controllers.childRoutes);}catch{ /* Native controller evidence fails closed. */ }
  let tasks={routes:[]};try{const {taskQualification}=await import('./setup-task.mjs');tasks=await taskQualification(session,{configFile:file},seams);access.routes.push(...tasks.routes.map(r=>({...r,status:'access-verified',verifiedAt:r.endedAt})));}catch{ /* Measured cases never activate policies or broaden role qualification. */ }
  const roles=['controller','worker','reviewer'].flatMap(role=>(role==='controller'?[a.routes.controller]:a.routes[role==='worker'?'workers':'reviewers']).map(r=>{
    const missing=[],sameModel=models.filter(m=>canonicalId(m.model)===canonicalId(r.model)),own=sameModel.filter(m=>m.cli===r.harness),profiles=routing.doc?.profiles.filter(x=>x.cli===r.harness&&canonicalId(x.model)===canonicalId(r.model)&&x.role===role&&x.billing===r.billing)??[];
    if(!installed[r.harness])missing.push('cli-not-installed');if(own.some(m=>m.enabled===false))missing.push('owner-route-disabled');if(r.permission==='ask'||sameModel.some(m=>m.requires_permission===true))missing.push('owner-model-permission-required');
    if(role!=='controller'&&routing.status==='blocked')missing.push('routing-policy-invalid');
    if(a.router.mode!=='deterministic'&&advice.status==='blocked')missing.push('advice-policy-invalid');
    if(quota.status==='blocked')missing.push('quota-policy-invalid');
    if(rosterEvidence==='historical')missing.push('roster-not-rechecked');
    if(profiles.length>1)missing.push('multiple-capability-profiles');if(profiles.length===1&&!profiles[0].enabled)missing.push('routing-profile-disabled');
    const profile=profiles.length===1?profiles[0]:null,age=profile?.availability.checkedAt?now-Date.parse(profile.availability.checkedAt):null;
    const taskCases=tasks.routes.filter(x=>x.role===role&&x.harness===r.harness&&canonicalId(x.model)===canonicalId(r.model)&&x.billing===r.billing).map(x=>({caseId:x.caseId,status:x.status,evidenceRef:x.evidenceRef,verifiedAt:x.endedAt,expiresAt:x.expiresAt,scope:x.scope,...(x.accessKind?{accessKind:x.accessKind,observedModel:x.observedModel,modelEvidenceSource:x.modelEvidenceSource}:{}),contextCapacityQualified:false}));
    const availability=profile?.availability.status==='available'&&age!==null&&age>=0&&age<=routing.doc.availabilityMaxAgeMinutes*60000?'fresh':profile?.availability.status==='unavailable'?'unavailable':profile?.availability.status==='available'?'stale':'unknown';
    if(profile&&availability!=='fresh')missing.push('routing-availability-'+availability);
    if(!profile&&role!=='controller')missing.push('routing-profile-missing');
    const binding=telemetry.bindings.filter(b=>b.harness===r.harness&&canonicalId(b.model)===canonicalId(r.model)&&b.role===role);
    if(a.usage.enabled&&r.billing==='subscription'){if(usage.status==='blocked')missing.push('usage-unavailable');else if(binding.length!==1)missing.push('usage-binding-missing-or-ambiguous');else{const pool=telemetry.pools.find(x=>x.id===binding[0].pool);if(!pool||pool.freshness!=='fresh'||pool.error||!pool.observation?.windows.length||pool.observation.windows.some(w=>w.freshness!=='fresh'))missing.push('usage-not-fresh');}}
    if(checks.some(c=>c.status==='blocked'&&['configuration','retention','state-location','review-location','roster','executables','ORCH_STATE_ROOT','ORCH_REVIEW_ROOT','ORCH_USAGE_CONFIG'].includes(c.id)))missing.push('setup-health-blocked');
    const controller=role==='controller'?controllers.routes.find(x=>x.harness===r.harness&&canonicalId(x.model)===canonicalId(r.model)&&x.billing===r.billing&&x.status==='controller-observed'):null;
    if(controller&&config.controllerProfile!==undefined&&!equal(config.controllerProfile,controller.profile))missing.push('controller-tool-profile-mismatch');
    const blockers=missing.filter(x=>!['routing-profile-missing','multiple-capability-profiles','roster-not-rechecked'].includes(x));
    const observations=access.routes.filter(x=>x.harness===r.harness&&canonicalId(x.model)===canonicalId(r.model)&&x.billing===r.billing&&x.status==='access-verified');
    const smoke=controller??observations.find(x=>x.role===role&&!x.evidenceRef?.startsWith('orch-task:')),observed=smoke??observations[0];
    if(controller&&config.controllerProfile===undefined)missing.push('controller-tool-profile-not-selected');
    if(role==='controller'&&['copilot','muse'].includes(r.harness))missing.push('repository-controller-profile-unqualified');
    if(observed?.accessKind==='automatic-access')missing.push('exact-model-access-not-qualified');
    if(!observed)missing.push('authentication-not-checked','model-access-not-checked');
    if(!smoke)missing.push(role==='controller'?'controller-operation-not-qualified':'role-smoke-needed');
    if(role==='controller'?!controller:profile?.qualification.status!=='qualified')missing.push('role-qualification-needed');
    if(!configuration.selected)missing.push('config-not-selected');
    if(checks.find(c=>c.id==='adoption')?.status!=='ok')missing.push('adoption-not-ready');
    return {role,harness:r.harness,model:r.model,billing:r.billing,status:blockers.length?'blocked':missing.length?'installed-but-unqualified':'runtime-ready',authentication:observed?'subscription-observed':'not-checked',modelAccess:observed?.accessKind==='automatic-access'?'automatic-selection':observed?'verified':'not-checked',roleSmoke:smoke?{status:'verified',offerHash:smoke.offerHash,expiresAt:smoke.expiresAt,otherProfileWarnings:smoke.otherProfileWarnings,...(smoke.accessKind?{accessKind:smoke.accessKind,observedModel:smoke.observedModel,modelEvidenceSource:smoke.modelEvidenceSource}:{}),scope:smoke.scope,...(controller?{profile:controller.profile}:{})}:{status:'unqualified'},rosterEvidence,qualification:{status:controller?'controller-observed':profile?.qualification.status??'unqualified',source:controller?'native-controller-receipt':profile?'owner-routing-policy':'not-checked',evidencePresent:!!controller||!!profile?.qualification.evidence},taskCases,availability,missing,launchAllowed:false,nextStep:'Resolve reported requirements; a read-only smoke does not qualify coding capability or authorize a task launch'};
  }));
  return {version:1,mode:'setup-health',checkedAt:new Date(now).toISOString(),repo,configuration,checks,roles,routing:{status:routing.status,profiles:routing.doc?.profiles.length??0},usage:{status:usage.status,pools:telemetry.pools.map(x=>({id:x.id,freshness:x.freshness,error:!!x.error}))},quota:{status:quota.status},advice:{status:advice.status,providerAdmission:'not-checked'},readOnly:true,providerCalls:0,credentialReads:0,activation:false};
}
export async function cmdSetupHealth(args,io){const [action,...extra]=args._??[];if(action!=='health'||extra.length||Object.keys(args).some(k=>!['_','json','session','config'].includes(k))||typeof args.session!=='string'||typeof args.config!=='string')fail();const out=await setupHealth(args.session,{configFile:args.config});io.log(args.json?JSON.stringify(out,null,2):`setup health: ${out.roles.filter(r=>r.status==='blocked').length} blocked route(s); ${out.roles.filter(r=>r.status==='runtime-ready').length} runtime-ready route(s); no launch authorized`);return {...out,exitCode:0};}
