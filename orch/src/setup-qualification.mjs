// Explicit runtime access evidence. A smoke is not task-quality qualification.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {setupProposal,readSetupInput,checkedSetupPath,localPath} from './setup.mjs';
import {configFilePath} from './config.mjs';
import {whereAll} from './exe.mjs';
import {gitOk,samePath,isInside} from './git.mjs';
import {canonicalId,ROSTER_FILE} from './models.mjs';
import {rolePrompt} from './role-packet.mjs';
import {extractFinalMessage} from './commands.mjs';
import {keeperFacts} from './store.mjs';
import {aliasFor,mergeVibeConfig,FALLBACK_WARNING_RE} from './adapters/vibe.mjs';
import {withOperationLock,resourceFile} from './resources.mjs';
import {OrchError} from './errors.mjs';

const MAX=1048576,BOUND=16,HEX=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const BIN=fileURLToPath(new URL('../bin/orch.mjs',import.meta.url));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),encode=x=>JSON.stringify(x,null,2)+'\n';
const fail=message=>{throw new OrchError(message,'qualification-refused');};
function exact(x,keys){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join(',')!==[...keys].sort().join(','))fail('Unexpected qualification fields');}
function bytes(file,max=MAX){checkedSetupPath(file);const fd=fs.openSync(file,'r');try{const before=fs.fstatSync(fd);if(before.size>max)fail('Qualification evidence exceeds its bound');const b=fs.readFileSync(fd),after=fs.fstatSync(fd);if(b.length>max||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('Qualification evidence changed during read');return b;}finally{fs.closeSync(fd);}}
const input=file=>readSetupInput(file,{max:MAX}).raw;
const digest=file=>hash(bytes(file));
function executableDigest(file){
  checkedSetupPath(file);const fd=fs.openSync(file,'r'),h=crypto.createHash('sha256'),buffer=Buffer.alloc(262144);
  try{const before=fs.fstatSync(fd);if(before.size>536870912)fail('Executable exceeds fingerprint bound');let count=0,n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){count+=n;if(count>536870912)fail('Executable exceeds fingerprint bound');h.update(buffer.subarray(0,n));}const after=fs.fstatSync(fd);if(count!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('Executable changed during fingerprint');return h.digest('hex');}finally{fs.closeSync(fd);}
}
function bounded(dir){checkedSetupPath(dir,true);const names=fs.existsSync(dir)?fs.readdirSync(dir):[];if(names.length>BOUND)fail('Qualification evidence directory exceeds its bound; inspect it explicitly');return names;}
function exclusive(file,value){checkedSetupPath(path.dirname(file),true);const text=encode(value);if(Buffer.byteLength(text)>MAX)fail('Qualification record exceeds bound');let fd;try{fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,text);fs.fsyncSync(fd);return true;}catch(e){if(e.code==='EEXIST')return false;throw e;}finally{if(fd!==undefined)fs.closeSync(fd);}}
function root(session){const p=setupProposal(session);return {p,dir:path.join(path.resolve(session),'qualification')};}
function configFor(session,configFile){const {p}=root(session),file=path.resolve(localPath(configFile,p.repo));if(isInside(file,session)||isInside(file,p.answers.resources.stateRoot)||isInside(file,p.answers.resources.reviewRoot))fail('Qualification needs a separate private runtime config');const raw=input(file),a=p.answers,expected={version:1,repo:p.repo,controller:p.harness,routes:a.routes,router:a.router,cleanup:a.resources.cleanup};if(!isDeepStrictEqual(raw.setupPreferences,expected)||raw.stateRoot!==a.resources.stateRoot||raw.reviewRoot!==a.resources.reviewRoot)fail('Setup configuration differs; preview and apply before qualification');return {p,file,raw,configHash:digest(file)};}
function nativeBinding(harness){const active=configFilePath(),raw=fs.existsSync(active)?input(active):{},override=process.env[`ORCH_${harness.toUpperCase()}_EXE`]||raw.exe?.[harness];const candidates=override?[path.resolve(process.env[`ORCH_${harness.toUpperCase()}_EXE`]?process.cwd():path.dirname(active),override)]:[...whereAll(harness+'.exe'),...(['claude','vibe'].includes(harness)?[path.join(process.env.USERPROFILE||os.homedir(),'.local','bin',harness+'.exe')]:[])];const exe=candidates.find(f=>{try{return /\.exe$/i.test(f)&&fs.statSync(f).isFile();}catch{return false;}});if(!exe)fail('Selected probe executable is unavailable');const target=fs.realpathSync.native(exe);return {harness,exe,target,sha256:executableDigest(target)};}
function rosterBinding(c,routes){
  const value=process.env.ORCH_ROSTER||c.raw.roster;
  const file=value?path.resolve(process.env.ORCH_ROSTER?process.cwd():path.dirname(c.file),value):ROSTER_FILE;
  if(!fs.existsSync(file)){if(value)fail('Selected roster is unavailable');return {file,sha256:null};}
  const raw=input(file);
  if(!Array.isArray(raw.models)||raw.models.length>64||raw.models.some(m=>!m||typeof m.cli!=='string'||typeof m.model!=='string'))fail('Inspect the bounded current roster before qualification');
  if(routes.some(r=>raw.models.some(m=>m.cli===r.harness&&canonicalId(m.model)===canonicalId(r.model)&&m.enabled===false)))fail('Selected route is disabled in the current roster');
  return {file,sha256:digest(file)};
}
function planFile(session,id){if(typeof id!=='string'||!HEX.test(id))fail('Use an exact qualification offer hash');return path.join(root(session).dir,'offers',id+'.json');}
function loadPlan(session,id,seams={},reuse=false){const envelope=input(planFile(session,id));exact(envelope,['offerHash','plan']);if(envelope.offerHash!==id||hash(JSON.stringify(envelope.plan))!==id)fail('Qualification offer changed');const p=envelope.plan,current=configFor(session,p.configFile);if(current.p.sessionHash!==p.sessionHash||!reuse&&current.configHash!==p.configHash)fail('Setup/configuration changed; make a fresh offer');if(!isDeepStrictEqual(rosterBinding(current,p.routes),p.roster))fail('Roster changed; make a fresh offer');for(const b of p.bindings){const currentBinding=(seams.binding??nativeBinding)(b.harness);if(!isDeepStrictEqual(currentBinding,b))fail('Executable binding changed; make a fresh offer');}for(let i=0;i<p.routes.length;i++)if(rolePrompt(Buffer.alloc(0),p.routes[i].role==='worker'?'implement':'review').provenance.sha256!==p.packets[i])fail('Kit role instructions changed; make a fresh offer');return p;}
const trialPaths=p=>({dir:p.trialRoot,config:path.join(p.trialRoot,'runtime.json'),worker:path.join(p.trialRoot,'worker.txt'),reviewer:path.join(p.trialRoot,'reviewer.txt')});

/** @param {any} options @param {any} seams */
export async function offerSmoke(session,options,seams={}){
  exact(options,['configFile','worker','reviewer','maxAgeSeconds']);if(![options.worker,options.reviewer].every(n=>Number.isInteger(n)&&n>=0)||!Number.isInteger(options.maxAgeSeconds)||options.maxAgeSeconds<60||options.maxAgeSeconds>86400)fail('Choose route indexes and a qualification age between 60 and 86400 seconds');
  const c=configFor(session,options.configFile),a=c.p.answers,routes=[{role:'worker',...a.routes.workers[options.worker]},{role:'reviewer',...a.routes.reviewers[options.reviewer]}];
  if(routes.some(r=>!['codex','vibe'].includes(r.harness)||!r.model||r.billing!=='subscription'))fail('Live smoke currently supports selected Codex/Vibe subscription routes; other routes remain unqualified');if(canonicalId(routes[0].model)===canonicalId(routes[1].model))fail('Reviewer must use a different canonical model');
  if(routes[0].harness===routes[1].harness||routes.some(r=>r.harness==='vibe'&&r.model.includes('/')&&r.model.split('/')[0]!=='mistral'))fail('Choose one Codex and one native Mistral Vibe subscription route for this smoke');
  if(['routingPolicy','quotaPolicy','advicePolicy'].some(k=>c.raw[k]||process.env['ORCH_'+k.replace(/Policy$/,'_POLICY').toUpperCase()]))fail('Configured admission policies need a matching admitted task; smoke never silently bypasses them');
  const dir=root(session).dir;
  return withOperationLock({stateRoot:path.resolve(session)},'setup-qualification',async()=>{
    const offers=path.join(dir,'offers');if(bounded(offers).length>=BOUND)fail('Qualification offers are full; retain evidence and inspect explicitly');
    for(const name of ['offers','trials','receipts']){const d=path.join(dir,name);checkedSetupPath(d,true);fs.mkdirSync(d,{recursive:true,mode:0o700});}
    const challenge=crypto.randomBytes(16).toString('hex'),trialRoot=path.join(dir,'trials',crypto.randomBytes(16).toString('hex')),plan={version:1,sessionHash:c.p.sessionHash,configFile:c.file,configHash:c.configHash,createdAt:new Date(seams.now??Date.now()).toISOString(),maxAgeSeconds:options.maxAgeSeconds,challenge,routes,roster:rosterBinding(c,routes),bindings:routes.map(r=>(seams.binding??nativeBinding)(r.harness)),trialRoot,workdir:path.join(trialRoot,'source'),stateRoot:path.join(trialRoot,'state'),reviewRoot:path.join(trialRoot,'review-packages'),packets:routes.map(r=>rolePrompt(Buffer.alloc(0),r.role==='worker'?'implement':'review').provenance.sha256)};
    const offerHash=hash(JSON.stringify(plan));if(!exclusive(path.join(offers,offerHash+'.json'),{offerHash,plan}))fail('Offer already exists');return {mode:'setup-smoke-offer',offerHash,routes,workdir:plan.workdir,stateRoot:plan.stateRoot,bounds:{modelLaunches:2,automaticRetries:0},scope:'Exact model access and read-only role smoke; no coding-quality qualification',providerCalls:0,activation:false};
  });
}
async function materialize(p){const t=trialPaths(p);if(fs.existsSync(t.dir))fail('Trial directory already exists; inspect an interrupted preparation');fs.mkdirSync(t.dir);for(const d of [p.workdir,p.stateRoot,path.join(t.dir,'attempts'),path.join(t.dir,'empty-hooks')])fs.mkdirSync(d);fs.writeFileSync(path.join(p.workdir,'challenge.txt'),p.challenge+'\n',{flag:'wx'});fs.writeFileSync(path.join(p.workdir,'.gitignore'),'.vibe/\n',{flag:'wx'});fs.writeFileSync(path.join(p.workdir,'.gitattributes'),'* text eol=lf\n',{flag:'wx'});
  const vibe=p.routes.filter(r=>r.harness==='vibe');if(vibe.length){fs.mkdirSync(path.join(p.workdir,'.vibe'));let config='';for(const r of [...vibe].reverse())config=mergeVibeConfig(config,{alias:aliasFor(r.model),name:r.model.split('/').pop(),provider:'mistral'});fs.writeFileSync(path.join(p.workdir,'.vibe','config.toml'),config,{flag:'wx'});}
  await gitOk(['init','-q','-b','main'],{cwd:p.workdir});await gitOk(['add','--','challenge.txt','.gitignore','.gitattributes'],{cwd:p.workdir});if(vibe.length)await gitOk(['add','-f','--','.vibe/config.toml'],{cwd:p.workdir});await gitOk(['-c','user.name=orch-qualification','-c','user.email=orch-qualification@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath='+path.join(t.dir,'empty-hooks'),'commit','-q','-m','Qualification fixture'],{cwd:p.workdir});
  fs.writeFileSync(t.config,encode({stateRoot:p.stateRoot,reviewRoot:p.reviewRoot,roster:p.roster.file,exe:Object.fromEntries(p.bindings.map(b=>[b.harness,b.exe]))}),{flag:'wx'});for(const role of ['worker','reviewer'])fs.writeFileSync(t[role],`Read-only access qualification. Read challenge.txt. Make no edits, commits or configuration changes. Return one line: ORCH_QUALIFICATION:<the value from challenge.txt>:${role}. This tests model access and this role's read-only operation, not coding quality.\n`,{flag:'wx'});
  const baseline=(await gitOk(['rev-parse','HEAD'],{cwd:p.workdir})).trim(),source=Object.fromEntries(['challenge.txt','.gitignore','.gitattributes',...(vibe.length?['.vibe/config.toml']:[])].map(f=>[f,digest(path.join(p.workdir,f))]));exclusive(path.join(t.dir,'fixture.json'),{baseline,source,challengeHash:digest(path.join(p.workdir,'challenge.txt')),configHash:digest(t.config),prompts:{worker:digest(t.worker),reviewer:digest(t.reviewer)}});
}
export function subscriptionEnvironment(source=process.env){const env={...source};for(const k of Object.keys(env))if(k.toUpperCase().startsWith('ORCH_')||/(?:_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_BASE_URL|_API_BASE)$/i.test(k)||['NODE_OPTIONS','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX'].includes(k.toUpperCase()))delete env[k];return env;}
function child(exe,args,env,cwd){return new Promise((resolve,reject)=>execFile(exe,args,{cwd,env,windowsHide:true,timeout:30000,maxBuffer:65536},(e,stdout,stderr)=>{if(e)reject(new OrchError('Probe command did not complete cleanly; inspect the retained attempt','qualification-launch-uncertain'));else resolve({stdout,stderr});}));}
async function nativeLaunch(p){const t=trialPaths(p.plan),env=subscriptionEnvironment();env.ORCH_CONFIG=t.config;
  try{
    if(p.route.harness==='codex'){const auth=await child(p.binding.exe,['login','status'],env,p.workdir);if(!/(?:^|\r?\n)Logged in using ChatGPT(?:\r?\n|$)/.test(auth.stderr+auth.stdout))fail('Codex subscription login not verified');}
    if(p.route.harness==='vibe'){const dot=path.join(process.env.VIBE_HOME||path.join(process.env.USERPROFILE||os.homedir(),'.vibe'),'.env');if(fs.existsSync(dot)&&/^\s*MISTRAL_API_KEY\s*=\s*[^\r\n]+/im.test(bytes(dot,65536).toString('utf8')))fail('Vibe API dotenv material configured');}
  }catch{throw new OrchError('Subscription authentication was refused before any model launch','qualification-auth-refused');}
  // This private path is reached only after exact offer/role approve:true. The
  // existing model-permission flag authorizes this probe, never future runs.
  const common=['--model',p.route.model,'--state-root',p.stateRoot,'--no-window','--effort','medium','--json','--owner-approved-model'];
  const args=p.role==='worker'?['run','--cli',p.route.harness,'--dir',p.workdir,'--handoff',p.prompt,...common]:['review','--run',p.workerId,'--reviewer',p.route.harness,'--ref','HEAD','--prompt',p.prompt,'--by','owner','--no-wait',...common];if(p.route.harness==='vibe')args.push('--max-turns','8');const out=await child(process.execPath,[BIN,...args],env,p.workdir);let result;try{result=JSON.parse(out.stdout);}catch{fail('Probe launch response is unknown; inspect existing jobs and never relaunch blindly');}if(result.admission&&result.admission!=='acquired')fail('Probe launch was not admitted; inspect the retained attempt');return {run_id:result.run_id??result.id,...(result.review_id?{review_id:result.review_id}:{})};
}
function launchFile(p,role){return path.join(p.trialRoot,'attempts',role+'-launched.json');}
function refusalFile(p,role){return path.join(p.trialRoot,'attempts',role+'-outcome.json');}
function attemptState(p,role){
  if(fs.existsSync(launchFile(p,role)))return 'launch-recorded';
  if(!fs.existsSync(path.join(p.trialRoot,'attempts',role+'.json')))return 'not-attempted';
  if(fs.existsSync(refusalFile(p,role))&&input(refusalFile(p,role)).state==='refused')return 'refused';
  return 'uncertain';
}
function reviewRecord(p){
  const launch=input(launchFile(p,'reviewer'));
  if(!ID.test(launch.review_id))fail('Invalid probe review id');
  const file=path.join(p.stateRoot,'reviews',launch.review_id+'.json'),review=input(file);
  if(review.id!==launch.review_id||review.run_id!==launch.run_id||review.implementer_run!==input(launchFile(p,'worker')).run_id||!samePath(review.source_repo??'',p.workdir)||!samePath(review.review_root??'',p.reviewRoot)||!samePath(review.worktree??'',path.join(p.reviewRoot,launch.review_id)))fail('Review is not bound to the owned smoke');
  return {file,review};
}
function otherProfileWarning(w,route){
  if(route.harness!=='vibe'||typeof w!=='string'||!w.startsWith('vibe.log fallback warning (this-run):'))return false;
  const match=FALLBACK_WARNING_RE.exec(w);
  return !!match&&!['',aliasFor(route.model).toLowerCase(),canonicalId(route.model)].includes(match[1].toLowerCase());
}
async function cleanSource(p){const f=input(path.join(p.trialRoot,'fixture.json')),t=trialPaths(p);if(!f.source||Object.entries(f.source).some(([file,sha])=>!isInside(path.resolve(p.workdir,file),p.workdir)||digest(path.join(p.workdir,file))!==sha)||digest(path.join(p.workdir,'challenge.txt'))!==f.challengeHash||digest(t.config)!==f.configHash||['worker','reviewer'].some(role=>digest(t[role])!==f.prompts[role]))fail('Owned smoke fixture changed');const status=await gitOk(['status','--porcelain','--untracked-files=all'],{cwd:p.workdir}),head=(await gitOk(['rev-parse','HEAD'],{cwd:p.workdir})).trim();if(status.trim()||head!==f.baseline)fail('Smoke fixture contains changes; preserve it and inspect before qualification');}
function runProof(p,role,proofs){const launched=input(launchFile(p,role));if(!ID.test(launched.run_id))fail('Invalid probe run id');const dir=path.join(p.stateRoot,'runs',launched.run_id),recordFile=path.join(dir,'run.json'),keeperFile=path.join(dir,'keeper.ndjson'),stdoutFile=path.join(dir,'stdout.log'),r=input(recordFile),route=p.routes.find(x=>x.role===role),binding=p.bindings.find(x=>x.harness===route.harness),prompt=trialPaths(p)[role];
  const expectedDir=role==='worker'?p.workdir:reviewRecord(p).review.worktree;
  if(!samePath(r.dir??'',expectedDir)||!samePath(r.dir_real??'',expectedDir)||role==='reviewer'&&(r.review_of!==input(launchFile(p,'worker')).run_id||r.review_id!==launched.review_id))fail('Run source or review link differs from the owned smoke');
  if(r.id!==launched.run_id||r.cli!==route.harness||r.role!==(role==='worker'?'implement':'review')||r.status!=='completed'||r.exit_code!==0||r.model_mismatch===true||!r.model_actual||canonicalId(r.model_requested)!==canonicalId(route.model)||canonicalId(r.model_actual)!==canonicalId(route.model)||route.harness==='vibe'&&r.model_actual_alias!==aliasFor(route.model)||!samePath(r.launch?.exe??'',binding.exe)||!samePath(r.handoff_source??'',prompt)||r.handoff_sha256!==digest(prompt)||r.role_packet?.role!==(role==='worker'?'implementer':'reviewer')||r.role_packet?.sha256!==p.packets[role==='worker'?0:1]||(r.escaped_helpers??[]).length||(r.post_exit_warnings??[]).some(w=>/unknown|best-effort|substitut|fallback/i.test(w)&&!otherProfileWarning(w,route)))fail('Run lacks terminal exact-model and role evidence; no readiness granted');
  const facts=keeperFacts(bytes(keeperFile).toString('utf8').split(/\r?\n/));if(facts.workerExit?.code!==0||!facts.keeperExit||facts.keeperExit.write_failures!==0)fail('Worker/keeper finalization is not verified');const message=extractFinalMessage(route.harness,bytes(stdoutFile).toString('utf8'));if(!message.split(/\r?\n/).some(line=>line.trim()===`ORCH_QUALIFICATION:${p.challenge}:${role}`))fail('Model did not return the private fixture challenge');const ended=Date.parse(r.ended_at);if(!Number.isFinite(ended)||ended<Date.parse(p.createdAt)-5000||ended>Date.now()+5000)fail('Run time is not bound to this offer');
  for(const file of [recordFile,keeperFile,stdoutFile,prompt])proofs.push({file,sha256:digest(file)});return {role,...route,observedModel:r.model_actual,runId:r.id,endedAt:r.ended_at,otherProfileWarnings:(r.post_exit_warnings??[]).filter(w=>otherProfileWarning(w,route)).length};
}
/** @param {any} request @param {any} seams */
export async function probeSmoke(session,request,seams={}){exact(request,['offerHash','approve','role']);if(request.approve!==true||!['worker','reviewer'].includes(request.role))fail('Approve the exact offer and worker/reviewer role explicitly');const p=loadPlan(session,request.offerHash,seams);
  return withOperationLock({stateRoot:path.resolve(session)},'setup-qualification',async()=>{const role=request.role,t=trialPaths(p),attempt=path.join(t.dir,'attempts',role+'.json');if(fs.existsSync(attempt)){if(attemptState(p,role)==='refused')throw new OrchError('Probe authentication was previously refused; inspect login and use a fresh approved offer','qualification-auth-refused');if(!fs.existsSync(launchFile(p,role)))fail('Probe attempt is uncertain; inspect existing jobs, never relaunch automatically');return {...input(launchFile(p,role)),mode:'setup-probe',replayed:true};}
    if((seams.now??Date.now())-Date.parse(p.createdAt)>p.maxAgeSeconds*1000)fail('Qualification offer expired; make a fresh offer before launching');
    if(role==='worker'&&!fs.existsSync(t.dir))await materialize(p);if(!fs.existsSync(t.dir))fail('Start the worker before the reviewer');
    await cleanSource(p);let workerId=null;if(role==='reviewer')workerId=runProof(p,'worker',[]).runId;const route=p.routes.find(r=>r.role===role),binding=p.bindings.find(b=>b.harness===route.harness);if(!exclusive(attempt,{offerHash:request.offerHash,role,approve:true,at:new Date().toISOString()}))fail('Probe was already attempted');
    try{
      const result=await (seams.launch??nativeLaunch)({plan:p,role,route,binding,stateRoot:p.stateRoot,workdir:p.workdir,prompt:t[role],challenge:p.challenge,workerId});if(typeof result.run_id!=='string'||!ID.test(result.run_id)||role==='reviewer'&&(typeof result.review_id!=='string'||!ID.test(result.review_id)))fail('Launch identities are unknown; inspect retained attempt');exclusive(launchFile(p,role),result);return {mode:'setup-probe',...result,role,status:'launched',automaticRetries:0};
    }catch(e){const refused=e?.code==='qualification-auth-refused';exclusive(refusalFile(p,role),{state:refused?'refused':'uncertain',reason:refused?'subscription-auth-not-verified':'launch-outcome-unverified',offerHash:request.offerHash,role,at:new Date().toISOString()});throw new OrchError(refused?'Subscription authentication refused before model launch; retained attempt cannot be retried':'Probe launch outcome is uncertain; inspect retained jobs, never relaunch automatically',refused?'qualification-auth-refused':'qualification-launch-uncertain');}
  });
}
function receiptFile(session,id){return path.join(root(session).dir,'receipts',id+'.json');}
const SCOPE='Exact model access and read-only role smoke only; no task quality, controller qualification or launch permission';
const CLEANUP={review:'removed',source:'intentionally-retained',reason:'Private qualification challenge and source evidence',revisit:'Explicit evidence retention/disposal after qualification expires'};
function removedReview(p,review){
  const file=resourceFile({stateRoot:p.stateRoot},review.id),r=input(file);
  if(r.id!==review.id||r.kind!=='review'||r.review_id!==review.id||r.state!=='removed'||!r.removed_at||r.cleanup_error||!samePath(r.path,review.worktree)||!samePath(r.root,p.reviewRoot)||!samePath(r.repo,p.workdir)||fs.existsSync(r.path))fail('Registered review removal is not verified');
  return file;
}
async function proofSet(p){
  await cleanSource(p);
  const proofs=[],routes=[runProof(p,'worker',proofs),runProof(p,'reviewer',proofs)],{file,review}=reviewRecord(p);
  if(!review.finished_at||review.outcome!=='reviewed'||review.containment!=='clean')fail('Independent review must be finalized cleanly');
  // Logical review metadata is immutable before cleanup; the registered resource is
  // authoritative even when the original review's removal flag is still false.
  const removal=removedReview(p,review);
  for(const f of [file,removal,path.join(p.workdir,'challenge.txt'),path.join(p.trialRoot,'fixture.json'),trialPaths(p).config,launchFile(p,'worker'),launchFile(p,'reviewer')])proofs.push({file:f,sha256:digest(f)});
  return {proofs,routes,expiresAt:new Date(Math.min(...routes.map(r=>Date.parse(r.endedAt)))+p.maxAgeSeconds*1000).toISOString()};
}
async function validateReceipt(session,id,seams={}){
  const p=loadPlan(session,id,seams,true),r=input(receiptFile(session,id));exact(r,['version','mode','offerHash','sessionHash','status','routes','proofs','createdAt','expiresAt','cleanup','scope']);
  if(r.version!==1||r.mode!=='setup-qualification-receipt'||r.offerHash!==id||r.sessionHash!==p.sessionHash||r.status!=='access-verified'||!Array.isArray(r.proofs)||r.proofs.length>20||r.scope!==SCOPE||!isDeepStrictEqual(r.cleanup,CLEANUP))fail('Qualification receipt is invalid');
  const expected=await proofSet(p);
  if(!isDeepStrictEqual(r.routes,expected.routes)||!isDeepStrictEqual(r.proofs,expected.proofs)||r.expiresAt!==expected.expiresAt)fail('Receipt claims do not match source evidence');
  return {p,r};
}
async function finalizeReview(p){
  const {review}=reviewRecord(p);
  if(review.finished_at){try{removedReview(p,review);return;}catch{ /* Existing finalizer can resume owned cleanup. */ }}
  const env=subscriptionEnvironment();env.ORCH_CONFIG=trialPaths(p).config;
  // Existing review finish refuses an active worker and removes only its registered resource.
  await child(process.execPath,[BIN,'review','--finish',review.id,'--by','owner','--state-root',p.stateRoot,'--json'],env,p.workdir);
}
/** @param {any} request @param {any} seams */
export async function qualifySmoke(session,request,seams={}){exact(request,['offerHash']);const file=receiptFile(session,request.offerHash),p=loadPlan(session,request.offerHash,seams,fs.existsSync(file));return withOperationLock({stateRoot:path.resolve(session)},'setup-qualification',async()=>{
  if(fs.existsSync(file)){const {r}=await validateReceipt(session,request.offerHash,seams);if(Date.parse(r.expiresAt)<(seams.now??Date.now()))fail('Qualification evidence expired');return {...r,replayed:true};}
  await (seams.finish??finalizeReview)(p);
  const {routes,proofs,expiresAt}=await proofSet(p);
  if(Date.parse(expiresAt)<(seams.now??Date.now()))fail('Probe evidence is already expired');if(bounded(path.dirname(file)).length>=BOUND)fail('Qualification receipt directory is full');
  const receipt={version:1,mode:'setup-qualification-receipt',offerHash:request.offerHash,sessionHash:p.sessionHash,status:'access-verified',routes,proofs,createdAt:new Date(seams.now??Date.now()).toISOString(),expiresAt,cleanup:CLEANUP,scope:SCOPE};if(!exclusive(file,receipt))fail('Receipt was concurrently published; read status');return receipt;
});}
function trialReport(session){
  const dir=path.join(root(session).dir,'offers'),trials=[];
  for(const name of bounded(dir)){
    try{if(!/^[a-f0-9]{64}\.json$/.test(name))fail('Invalid offer name');const {plan:p,offerHash}=input(path.join(dir,name));if(hash(JSON.stringify(p))!==offerHash||offerHash!==name.slice(0,-5))fail('Changed offer');
      const attempts=['worker','reviewer'].map(role=>({role,state:attemptState(p,role)}));
      let review='not-recorded';if(attempts[1].state==='launch-recorded'){const {review:r}=reviewRecord(p);try{removedReview(p,r);review='removal-recorded';}catch{review=r.containment==='containment-breach'?'incident-retained':'inspect-existing-review';}}
      trials.push({offerHash,attempts,stateRoot:p.stateRoot,cleanup:{review,source:fs.existsSync(p.workdir)?'intentionally-retained':'not-created',reason:'Private qualification evidence; inspect uncertain attempts without relaunch',revisit:'Explicit evidence retention/disposal after qualification expires'}});
    }catch{trials.push({offerHash:name.slice(0,-5),status:'unavailable',cleanup:'inspect-retained-evidence'});}
  }
  return trials;
}
/** @param {any} options @param {any} seams */
export async function qualificationStatus(session,options,seams={}){
  exact(options,['configFile']);configFor(session,options.configFile);const dir=path.join(root(session).dir,'receipts'),routes=[],invalid=[];
  for(const name of bounded(dir)){
    try{if(!/^[a-f0-9]{64}\.json$/.test(name))fail('Invalid receipt name');const {p,r}=await validateReceipt(session,name.slice(0,-5),seams);if(!samePath(p.configFile,options.configFile))continue;const expired=Date.parse(r.expiresAt)<(seams.now??Date.now());for(const route of r.routes)routes.push({role:route.role,harness:route.harness,model:route.model,billing:route.billing,status:expired?'expired':'access-verified',offerHash:r.offerHash,verifiedAt:route.endedAt,expiresAt:r.expiresAt,otherProfileWarnings:route.otherProfileWarnings,scope:r.scope});}
    catch{invalid.push({offerHash:/^[a-f0-9]{64}\.json$/.test(name)?name.slice(0,-5):null,status:'unavailable'});}
  }
  routes.sort((a,b)=>Date.parse(b.verifiedAt)-Date.parse(a.verifiedAt));
  return {mode:'setup-qualification',routes,invalid,trials:trialReport(session),status:routes.some(r=>r.status==='access-verified')?'recorded':routes.length?'expired':invalid.length?'unavailable':'not-recorded',providerCalls:0};
}
export async function cmdSetupQualification(args,io){const [action,...extra]=args._??[],allowed=['_','json','session',...(['smoke','qualification'].includes(action)?['config']:[]),...(['smoke','probe','qualify'].includes(action)?['request']:[])];if(extra.length||!['smoke','probe','qualify','qualification'].includes(action)||typeof args.session!=='string'||Object.keys(args).some(k=>!allowed.includes(k)))fail('Use setup smoke/probe/qualify/qualification with explicit private files');let out;if(action==='qualification')out=await qualificationStatus(args.session,{configFile:args.config});else{const request=input(args.request);if(action==='smoke'){exact(request,['worker','reviewer','maxAgeSeconds']);out=await offerSmoke(args.session,{...request,configFile:args.config});}else out=action==='probe'?await probeSmoke(args.session,request):await qualifySmoke(args.session,request);}io.log(args.json?JSON.stringify(out,null,2):`${out.mode}: ${out.status??'explicit offer approval required'}`);return {...out,exitCode:0};}
