import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {makeCase} from './helpers.mjs';
import {makeRepo} from './wf-helpers.mjs';
import {startSetup,answerSetup} from '../src/setup.mjs';
import {previewSetup,applySetup} from '../src/setup-apply.mjs';
import {rolePrompt} from '../src/role-packet.mjs';
import {resourceFile} from '../src/resources.mjs';
import {aliasFor} from '../src/adapters/vibe.mjs';
import {parseArgs,runCommand} from '../src/cli.mjs';
import {setupHealth} from '../src/setup-health.mjs';
/** @type {any} */ const api=await import('../src/setup-task.mjs').catch(()=>({}));
/** @type {any} */ const cases=await import('../src/task-cases.mjs').catch(()=>({}));
test('P07g: coding evidence tests the specified helper rather than trusting the worker report',async t=>{
  assert.equal(typeof cases.verifyTaskImplementation,'function');const c=makeCase('p07g-code');t.after(()=>c.cleanup());const file=path.join(c.base,'stats.mjs');
  fs.writeFileSync(file,'export function summarizeReadings(v){return {count:0,min:null,max:null,total:0};}');assert.equal((await cases.verifyTaskImplementation(file)).passed,false);
  fs.writeFileSync(file,'export function summarizeReadings(v){if(!Array.isArray(v))throw new TypeError("invalid");let total=0,min=null,max=null;for(const x of v){if(typeof x!=="number"||!Number.isFinite(x))throw new TypeError("invalid");total+=x;min=min===null?x:Math.min(min,x);max=max===null?x:Math.max(max,x);}return {count:v.length,min,max,total};}');const r=await cases.verifyTaskImplementation(file);assert.equal(r.passed,true,JSON.stringify(r));assert.ok(r.checks>=12);assert.equal(r.scope,'numeric-summary-v1');
});
test('P07g: reviewer needs real witnesses for both seeded defects, not a clean self-report',()=>{
  assert.equal(typeof cases.verifyTaskReview,'function');const finding=(input,observed,expected)=>({file:'review-target.mjs',input,observed,expected,explanation:'The implementation violates the finite-number contract'}),report={challenge:'nonce',findings:[finding([0],0,1),finding(['x'],1,0)]};
  assert.equal(cases.verifyTaskReview(report,'nonce').passed,true);
  for(const bad of [{...report,challenge:'other'},{...report,findings:[]},{...report,findings:[finding([0],0,1)]},{...report,findings:[finding([0],1,0),finding(['x'],1,0)]}])assert.equal(cases.verifyTaskReview(bad,'nonce').passed,false);
});
test('P07g: implementation verification refuses imports, process access, dynamic execution and prototype access',()=>{
  assert.equal(typeof cases.validateTaskSource,'function');for(const code of ['import fs from "node:fs"; export function summarizeReadings(v){return v;}','export function summarizeReadings(v){return process.env;}','export function summarizeReadings(v){return v.constructor.constructor("return process")();}','export function summarizeReadings(v){return eval("1");}'])assert.throws(()=>cases.validateTaskSource(code));
});
test('P07g: verifier executes its validated bytes when the original file changes',async t=>{
  const c=makeCase('p07g-bytes');t.after(()=>c.cleanup());const file=path.join(c.base,'stats.mjs'),original=fs.readFileSync;fs.writeFileSync(file,correct);
  fs.readFileSync=function(candidate,...options){const result=original.call(fs,candidate,...options);if(candidate===file)fs.writeFileSync(file,'export function summarizeReadings(v){return null;}');return result;};
  try{const r=await cases.verifyTaskImplementation(file);assert.equal(r.passed,true);assert.equal(r.sourceHash,hash(correct));}finally{fs.readFileSync=original;}
});
test('P07g: partially sparse inputs cannot receive a successful case result',async t=>{
  const c=makeCase('p07g-holes');t.after(()=>c.cleanup());const file=path.join(c.base,'stats.mjs');fs.writeFileSync(file,'export function summarizeReadings(v){if(!Array.isArray(v)||(v.length!==0&&v.every(x=>x===undefined))||v.some(x=>typeof x!=="number"||!Number.isFinite(x)))throw new TypeError("invalid");return {count:v.length,min:v.length?Math.min(...v):null,max:v.length?Math.max(...v):null,total:v.reduce((a,b)=>a+b,0)};}');assert.equal((await cases.verifyTaskImplementation(file)).passed,false);
});
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function taskFixture(t){const c=makeCase('p07g-offer');t.after(()=>c.cleanup());const repo=path.join(c.base,'repo');makeRepo(repo,{'AGENTS.md':'Preserve owner instructions\n'});const session=path.join(c.base,'session'),config=path.join(c.base,'private.json'),route=(h,model)=>({harness:h,model,billing:'subscription',permission:'allowed'});let s=await startSetup({repo,harness:'codex',session,roster:undefined,catalog:undefined});for(const answer of [{controller:route('codex','example-controller'),workers:[route('codex','example-worker')],reviewers:[route('vibe','example-reviewer')]},{mode:'deterministic'},{enabled:false},{stateRoot:c.stateRoot,reviewRoot:path.join(c.base,'packages'),cleanup:'retain-unmerged'},{enabled:false}])s=await answerSetup(session,{expectedRevision:s.revision,questionId:s.nextQuestion.id,answer});const v=await previewSetup(session,{configFile:config,adopt:false,update:false});await applySetup(session,{previewHash:v.previewHash,approve:true});const raw=JSON.parse(fs.readFileSync(config,'utf8'));fs.writeFileSync(config,JSON.stringify({...raw,exe:{codex:process.execPath,vibe:process.execPath}}));const seams={binding:h=>({harness:h,exe:process.execPath,target:fs.realpathSync.native(process.execPath),sha256:hash(fs.readFileSync(process.execPath))})};return {...c,session,repo,config,seams};}
test('P07g: task offers are model-free, case-bound, private and never activate the owner configuration',async t=>{
  assert.equal(typeof api.offerTask,'function');const c=await taskFixture(t),before=fs.readFileSync(c.config),o=await api.offerTask(c.session,{configFile:c.config,worker:0,reviewer:0,caseId:'numeric-summary-v1',maxAgeSeconds:3600},c.seams);assert.equal(o.providerCalls,0);assert.equal(o.scope,'Representative numeric helper and finite-number review cases only');assert.deepEqual(fs.readFileSync(c.config),before);assert.equal(fs.existsSync(o.workdir),false);await assert.rejects(api.startTask(c.session,{offerHash:o.offerHash,approve:false},c.seams));const p=await api.startTask(c.session,{offerHash:o.offerHash,approve:true},c.seams);assert.equal(p.steps.length,9);assert.equal(fs.readFileSync(path.join(c.repo,'AGENTS.md'),'utf8'),'Preserve owner instructions\n');await assert.rejects(api.taskStep(c.session,{offerHash:o.offerHash,approve:true,step:'reviewer'},c.seams));
});
test('P07g: unknown task cases and access-only records cannot qualify coding capability',async t=>{
  assert.equal(typeof api.taskQualification,'function');const c=await taskFixture(t);await assert.rejects(api.offerTask(c.session,{configFile:c.config,worker:0,reviewer:0,caseId:'all-features',maxAgeSeconds:3600},c.seams));const s=await api.taskQualification(c.session,{configFile:c.config},c.seams);assert.equal(s.routes.length,0);assert.equal(s.providerCalls,0);assert.equal(s.activation,false);
});

const correct='export function summarizeReadings(v){if(!Array.isArray(v))throw new TypeError("invalid");let total=0,min=null,max=null;for(const x of v){if(typeof x!=="number"||!Number.isFinite(x))throw new TypeError("invalid");total+=x;min=min===null?x:Math.min(min,x);max=max===null?x:Math.max(max,x);}return {count:v.length,min,max,total};}';
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
async function completeTask(t,through='finish'){
  const c=await taskFixture(t),o=await api.offerTask(c.session,{configFile:c.config,worker:0,reviewer:0,caseId:'numeric-summary-v1',maxAgeSeconds:3600},c.seams),p=await api.startTask(c.session,{offerHash:o.offerHash,approve:true},c.seams),dir=path.dirname(o.workdir),state=path.join(dir,'state'),binding=c.seams.binding;
  const seams={binding,processTable:async()=>[],command:async(plan,args)=>{
    if(args[0]==='status')return {status:'completed'};
    if(args[0]==='review'){const rvFile=path.join(state,'reviews','controller-review.json'),rv=JSON.parse(fs.readFileSync(rvFile,'utf8'));Object.assign(rv,{finished_at:new Date().toISOString(),outcome:'reviewed',containment:'clean'});write(rvFile,rv);write(resourceFile({stateRoot:state},rv.id),{id:rv.id,kind:'review',review_id:rv.id,wp:plan.wp,by:plan.by,state:'removed',removed_at:new Date().toISOString(),path:rv.worktree,root:plan.smoke.reviewRoot,repo:plan.smoke.workdir});return {outcome:'reviewed'};}
    const prior=process.env.ORCH_CONFIG;process.env.ORCH_CONFIG=path.join(dir,'runtime.json');try{return await runCommand(args[0],parseArgs([...args.slice(1),'--state-root',state,'--json']),{log(){}});}finally{if(prior===undefined)delete process.env.ORCH_CONFIG;else process.env.ORCH_CONFIG=prior;}
  },launch:async ctx=>{
    if(ctx.role==='worker')fs.writeFileSync(path.join(ctx.workdir,'stats.mjs'),correct);const role=ctx.role,id='controller-'+role+'-proof',now=new Date().toISOString(),runDir=path.join(state,'runs',id),workdir=role==='worker'?ctx.workdir:path.join(ctx.plan.reviewRoot,'controller-review');fs.mkdirSync(runDir,{recursive:true});
    write(path.join(runDir,'run.json'),{id,cli:ctx.route.harness,role:role==='worker'?'implement':'review',wp:ctx.wp,by:ctx.by,slice:'capability-case',model_requested:ctx.route.model,model_actual:ctx.route.model,model_actual_alias:ctx.route.harness==='vibe'?aliasFor(ctx.route.model):null,model_mismatch:false,status:'completed',exit_code:0,started_at:now,ended_at:now,dir:workdir,dir_real:workdir,...(role==='reviewer'?{review_of:ctx.workerId,review_id:'controller-review'}:{}),escaped_helpers:[],handoff_source:ctx.prompt,handoff_sha256:hash(fs.readFileSync(ctx.prompt)),launch:{exe:ctx.binding.exe},role_packet:rolePrompt(Buffer.alloc(0),role==='worker'?'implement':'review').provenance});
    const message=role==='worker'?'ORCH_TASK:'+ctx.challenge+':worker':JSON.stringify({challenge:ctx.challenge,findings:[{file:'review-target.mjs',input:[0],observed:0,expected:1,explanation:'Zero is finite and must count'},{file:'review-target.mjs',input:['x'],observed:1,expected:0,explanation:'Strings must not count'}]});fs.writeFileSync(path.join(runDir,'stdout.log'),JSON.stringify(role==='worker'?{type:'item.completed',item:{type:'agent_message',text:message}}:{type:'message',role:'assistant',content:[{type:'text',text:message}]})+'\n');fs.writeFileSync(path.join(runDir,'stderr.log'),'');fs.writeFileSync(path.join(runDir,'keeper.ndjson'),[{event:'spawned',worker_pid:1,at:now},{event:'worker-exit',code:0,at:now},{event:'keeper-exit',write_failures:0,at:now}].map(x=>JSON.stringify(x)).join('\n')+'\n');
    if(role==='reviewer')write(path.join(state,'reviews','controller-review.json'),{id:'controller-review',run_id:id,implementer_run:ctx.workerId,wp:ctx.wp,by:ctx.by,worktree:workdir,source_repo:ctx.workdir,review_root:ctx.plan.reviewRoot,reviewer_cli:ctx.route.harness,reviewer_model:ctx.route.model});
    return {run_id:id,...(role==='reviewer'?{review_id:'controller-review'}:{})};
  }};

  for(const step of p.steps){await api.taskStep(c.session,{offerHash:o.offerHash,approve:true,step},seams);if(step===through)break;}
  return {...c,o,p,dir,state,seams};
}
test('P07g: complete task proof reuses without launches and preserves broad readiness requirements',async t=>{
  const c=await completeTask(t),request={offerHash:c.o.offerHash},r=await api.qualifyTask(c.session,request,c.seams);assert.equal(r.status,'task-observed');assert.equal(r.results.worker.passed,true);assert.equal(r.results.reviewer.defects,2);assert.equal(r.cleanup.review,'removed');assert.equal(r.cleanup.claim,'released');assert.equal(r.contextCapacityQualified,false);assert.equal(r.launchAllowed,false);assert.equal((await api.qualifyTask(c.session,request,c.seams)).replayed,true);
  const status=await api.taskQualification(c.session,{configFile:c.config},c.seams);assert.equal(status.routes.length,2);assert.equal(status.providerCalls,0);assert.equal(status.proposals.length,2);assert.equal(status.proposals[0].enabled,false);assert.equal(status.proposals[0].qualification.status,'trial');
  const h=await setupHealth(c.session,{configFile:c.config},{...c.seams,discover:()=>({codex:true,vibe:true})});const worker=h.roles.find(r=>r.role==='worker');assert.equal(worker.taskCases.length,1);assert.ok(worker.missing.includes('role-qualification-needed'));assert.ok(worker.missing.includes('role-smoke-needed'));assert.equal(worker.roleSmoke.status,'unqualified');assert.equal(worker.authentication,'subscription-observed');assert.equal(worker.launchAllowed,false);
});
test('P07g: receipt tampering, code drift and expiry cannot retain measured qualification',async t=>{
  const c=await completeTask(t),request={offerHash:c.o.offerHash};await api.qualifyTask(c.session,request,c.seams);const receipt=path.join(c.session,'task-qualification','receipts',c.o.offerHash+'.json'),original=fs.readFileSync(receipt),r=JSON.parse(original.toString());write(receipt,{...r,launchAllowed:true});await assert.rejects(api.qualifyTask(c.session,request,c.seams));fs.writeFileSync(receipt,original);fs.appendFileSync(path.join(c.o.workdir,'stats.mjs'),'\n');await assert.rejects(api.qualifyTask(c.session,request,c.seams));const s=await api.taskQualification(c.session,{configFile:c.config},{...c.seams,now:Date.now()+3600001});assert.equal(s.routes.length,0);assert.equal(s.invalid.length,1);
});
test('P07g: uncertain mutations stay single-attempt and protected files are never accepted',async t=>{
  const c=await taskFixture(t),o=await api.offerTask(c.session,{configFile:c.config,worker:0,reviewer:0,caseId:'numeric-summary-v1',maxAgeSeconds:3600},c.seams);await api.startTask(c.session,{offerHash:o.offerHash,approve:true},c.seams);let calls=0;const request={offerHash:o.offerHash,approve:true,step:'claim'},seams={...c.seams,command:async()=>{calls++;throw Error('unknown');}};await assert.rejects(api.taskStep(c.session,request,seams));await assert.rejects(api.taskStep(c.session,request,seams));assert.equal(calls,1);fs.appendFileSync(path.join(o.workdir,'review-target.mjs'),'\n');await assert.rejects(api.taskStep(c.session,request,c.seams));
});
test('P07g: a failed empty trial can close with source retained and no qualification or relaunch',async t=>{
  assert.equal(typeof api.closeTask,'function');const c=await taskFixture(t),o=await api.offerTask(c.session,{configFile:c.config,worker:0,reviewer:0,caseId:'numeric-summary-v1',maxAgeSeconds:3600},c.seams);await api.startTask(c.session,{offerHash:o.offerHash,approve:true},c.seams);fs.appendFileSync(path.join(o.workdir,'review-target.mjs'),'\n');const r=await api.closeTask(c.session,{offerHash:o.offerHash,approve:true},c.seams);assert.equal(r.source,'intentionally-retained');assert.equal(r.providerCalls,0);assert.equal((await api.closeTask(c.session,{offerHash:o.offerHash,approve:true},c.seams)).replayed,true);await assert.rejects(api.taskStep(c.session,{offerHash:o.offerHash,approve:true,step:'claim'},c.seams));await assert.rejects(api.qualifyTask(c.session,{offerHash:o.offerHash},c.seams));
});
test('P07g: failed-trial closure refuses active jobs, then records terminal jobs and releases the claim',async t=>{
  const c=await completeTask(t,'worker'),file=path.join(c.state,'runs','controller-worker-proof','run.json'),before=fs.readFileSync(file),run=JSON.parse(before.toString());write(file,{...run,status:'running'});await assert.rejects(api.closeTask(c.session,{offerHash:c.o.offerHash,approve:true},c.seams),/active or uncertain/);fs.writeFileSync(file,before);const result=await api.closeTask(c.session,{offerHash:c.o.offerHash,approve:true},c.seams);assert.equal(result.claim,'released');assert.equal(result.source,'intentionally-retained');assert.ok(fs.existsSync(path.join(c.o.workdir,'stats.mjs')));await assert.rejects(api.qualifyTask(c.session,{offerHash:c.o.offerHash},c.seams));
});

test('P07g: terminal status waits for keeper completion without relaunching',async t=>{
  const c=await completeTask(t,'worker'),file=path.join(c.state,'runs','controller-worker-proof','keeper.ndjson'),before=fs.readFileSync(file),request={offerHash:c.o.offerHash,approve:true,step:'monitor-worker'};
  fs.writeFileSync(file,before.toString().split(/\r?\n/).filter(line=>!line.includes('keeper-exit')).join('\n'));
  const pending=await api.taskStep(c.session,request,c.seams);assert.equal(pending.pending,true);assert.equal(pending.providerCalls,0);assert.equal(fs.existsSync(path.join(c.dir,'task-steps','monitor-worker.json')),false);
  fs.writeFileSync(file,before);assert.equal((await api.taskStep(c.session,request,c.seams)).result.observedModel,'example-worker');
});
test('P07g: ignored files outside the worker allowlist fail independent scope verification',async t=>{
  const c=await completeTask(t,'worker');fs.writeFileSync(path.join(c.o.workdir,'.vibe','unexpected.mjs'),'retained incident');await api.taskStep(c.session,{offerHash:c.o.offerHash,approve:true,step:'monitor-worker'},c.seams);await assert.rejects(api.taskStep(c.session,{offerHash:c.o.offerHash,approve:true,step:'verify-worker'},c.seams),/allowlist/);
});

test('P07h: explicit unknown helper ancestry cannot qualify an otherwise completed case',async t=>{
  const c=await completeTask(t),file=path.join(c.state,'runs','controller-worker-proof','run.json'),record=JSON.parse(fs.readFileSync(file,'utf8'));write(file,{...record,helper_audit:{state:'unknown',reason:'worker-identity-unknown'}});await assert.rejects(api.qualifyTask(c.session,{offerHash:c.o.offerHash},c.seams),/helper|terminal proof/);
});
