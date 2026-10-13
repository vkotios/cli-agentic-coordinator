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
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function taskFixture(t,reverse=false,exact=false){const c=makeCase('p07g-offer');t.after(()=>c.cleanup());const repo=path.join(c.base,'repo');makeRepo(repo,{'AGENTS.md':'Preserve owner instructions\n'});const session=path.join(c.base,'session'),config=path.join(c.base,'private.json'),route=(h,model)=>({harness:h,model,billing:'subscription',permission:'allowed'});let s=await startSetup({repo,harness:'codex',session,roster:undefined,catalog:undefined});for(const answer of [{controller:route('codex','example-controller'),workers:[reverse?route('muse','example-muse'):route('copilot',exact?'example-pinned':'Auto')],reviewers:[reverse?route('copilot',exact?'example-pinned':'Auto'):route('muse','example-muse')]},{mode:'deterministic'},{enabled:false},{stateRoot:c.stateRoot,reviewRoot:path.join(c.base,'packages'),cleanup:'retain-unmerged'},{enabled:false}])s=await answerSetup(session,{expectedRevision:s.revision,questionId:s.nextQuestion.id,answer});const v=await previewSetup(session,{configFile:config,adopt:false,update:false});await applySetup(session,{previewHash:v.previewHash,approve:true});const raw=JSON.parse(fs.readFileSync(config,'utf8'));fs.writeFileSync(config,JSON.stringify({...raw,exe:{codex:process.execPath,vibe:process.execPath}}));const seams={binding:h=>({harness:h,exe:process.execPath,target:fs.realpathSync.native(process.execPath),sha256:hash(fs.readFileSync(process.execPath))})};return {...c,session,repo,config,seams};}

const correct='export function summarizeReadings(v){if(!Array.isArray(v))throw new TypeError("invalid");let total=0,min=null,max=null;for(const x of v){if(typeof x!=="number"||!Number.isFinite(x))throw new TypeError("invalid");total+=x;min=min===null?x:Math.min(min,x);max=max===null?x:Math.max(max,x);}return {count:v.length,min,max,total};}';
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
async function completeTask(t,through='finish',reverse=false,exact=false,mutate=null){
  const c=await taskFixture(t,reverse,exact),o=await api.offerTask(c.session,{configFile:c.config,worker:0,reviewer:0,caseId:'numeric-summary-v1',maxAgeSeconds:3600},c.seams),p=await api.startTask(c.session,{offerHash:o.offerHash,approve:true},c.seams),dir=path.dirname(o.workdir),state=path.join(dir,'state'),binding=c.seams.binding;
  const seams={binding,processTable:async()=>[],command:async(plan,args)=>{
    if(args[0]==='status')return {status:'completed'};
    if(args[0]==='review'){const rvFile=path.join(state,'reviews','controller-review.json'),rv=JSON.parse(fs.readFileSync(rvFile,'utf8'));Object.assign(rv,{finished_at:new Date().toISOString(),outcome:'reviewed',containment:'clean'});write(rvFile,rv);write(resourceFile({stateRoot:state},rv.id),{id:rv.id,kind:'review',review_id:rv.id,wp:plan.wp,by:plan.by,state:'removed',removed_at:new Date().toISOString(),path:rv.worktree,root:plan.smoke.reviewRoot,repo:plan.smoke.workdir});return {outcome:'reviewed'};}
    const prior=process.env.ORCH_CONFIG;process.env.ORCH_CONFIG=path.join(dir,'runtime.json');try{return await runCommand(args[0],parseArgs([...args.slice(1),'--state-root',state,'--json']),{log(){}});}finally{if(prior===undefined)delete process.env.ORCH_CONFIG;else process.env.ORCH_CONFIG=prior;}
  },launch:async ctx=>{
    if(ctx.role==='worker')fs.writeFileSync(path.join(ctx.workdir,'stats.mjs'),correct);const role=ctx.role,id='controller-'+role+'-proof',now=new Date().toISOString(),runDir=path.join(state,'runs',id),workdir=role==='worker'?ctx.workdir:path.join(ctx.plan.reviewRoot,'controller-review');fs.mkdirSync(runDir,{recursive:true});
    write(path.join(runDir,'run.json'),{id,cli:ctx.route.harness,role:role==='worker'?'implement':'review',wp:ctx.wp,by:ctx.by,slice:'capability-case',model_requested:ctx.route.model,model_actual:ctx.route.harness==='copilot'&&ctx.route.model==='Auto'?'example-served':ctx.route.model,model_actual_source:ctx.route.harness==='copilot'?'copilot-native-call-usage':'muse-runtime-model',helper_audit:{state:'observed'},model_actual_alias:ctx.route.harness==='vibe'?aliasFor(ctx.route.model):null,model_mismatch:false,status:'completed',exit_code:0,started_at:now,ended_at:now,dir:workdir,dir_real:workdir,...(role==='reviewer'?{review_of:ctx.workerId,review_id:'controller-review'}:{}),escaped_helpers:[],handoff_source:ctx.prompt,handoff_sha256:hash(fs.readFileSync(ctx.prompt)),launch:{exe:ctx.binding.exe},role_packet:rolePrompt(Buffer.alloc(0),role==='worker'?'implement':'review').provenance});
    const message=role==='worker'?'ORCH_TASK:'+ctx.challenge+':worker':JSON.stringify({challenge:ctx.challenge,findings:[{file:'review-target.mjs',input:[0],observed:0,expected:1,explanation:'Zero is finite and must count'},{file:'review-target.mjs',input:['x'],observed:1,expected:0,explanation:'Strings must not count'}]});const model=ctx.route.harness==='copilot'&&ctx.route.model==='Auto'?'example-served':ctx.route.model,stream={kind:'session',id:'session'},run_stream={kind:'run',id:'main'};const events=ctx.route.harness==='copilot'?[{type:'assistant.usage',data:{model}},{type:'assistant.message',data:{content:message}}]:[{schema_version:1,stream,payload_type:'run.model.configured',payload:{run_stream,provider_id:'meta',model_id:model}},{schema_version:1,stream,payload_type:'run.terminal.completed',payload:{run_stream,text:message}}];fs.writeFileSync(path.join(runDir,'stdout.log'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');fs.writeFileSync(path.join(runDir,'stderr.log'),'');fs.writeFileSync(path.join(runDir,'keeper.ndjson'),[{event:'spawned',worker_pid:1,at:now},{event:'worker-exit',code:0,at:now},{event:'keeper-exit',write_failures:0,at:now}].map(x=>JSON.stringify(x)).join('\n')+'\n');
    if(role==='reviewer')write(path.join(state,'reviews','controller-review.json'),{id:'controller-review',run_id:id,implementer_run:ctx.workerId,wp:ctx.wp,by:ctx.by,worktree:workdir,source_repo:ctx.workdir,review_root:ctx.plan.reviewRoot,reviewer_cli:ctx.route.harness,reviewer_model:ctx.route.model});
    if(mutate)await mutate({ctx,runDir,state});return {run_id:id,...(role==='reviewer'?{review_id:'controller-review'}:{})};
  }};

  for(const step of p.steps){await api.taskStep(c.session,{offerHash:o.offerHash,approve:true,step},seams);if(step===through)break;}
  return {...c,o,p,dir,state,seams};
}

test('P04d: Copilot/Muse task offers need exact approval and prepare without a Vibe child',async t=>{
  const c=await taskFixture(t),before=fs.readFileSync(c.config),o=await api.offerTask(c.session,{configFile:c.config,worker:0,reviewer:0,caseId:'numeric-summary-v1',maxAgeSeconds:3600},c.seams);
  assert.equal(o.providerCalls,0);assert.equal(fs.existsSync(o.workdir),false);await assert.rejects(api.startTask(c.session,{offerHash:o.offerHash,approve:false},c.seams));
  const p=await api.startTask(c.session,{offerHash:o.offerHash,approve:true},c.seams);assert.equal(p.steps.length,9);assert.equal(fs.existsSync(path.join(o.workdir,'.vibe')),false);assert.deepEqual(fs.readFileSync(c.config),before);
});

test('P04d: both orientations measure cases while Auto cannot produce a pinned capability proposal',async t=>{
  for(const reverse of [false,true]){const c=await completeTask(t,'finish',reverse),r=await api.qualifyTask(c.session,{offerHash:c.o.offerHash},c.seams);
    assert.equal(r.results.worker.passed,true);assert.equal(r.results.reviewer.defects,2);assert.equal(r.cleanup.review,'removed');assert.equal(r.cleanup.claim,'released');assert.equal(r.routes.find(x=>x.harness==='copilot').accessKind,'automatic-access');assert.equal(r.routes.find(x=>x.harness==='copilot').observedModel,'example-served');assert.ok(r.routes.every(x=>x.launchProfile.vibeMaxTurns===null));assert.equal(r.routes.find(x=>x.harness==='copilot').launchProfile.effort,null);assert.equal(r.routes.find(x=>x.harness==='muse').launchProfile.effort,'medium');assert.equal(r.contextCapacityQualified,false);assert.equal(r.launchAllowed,false);
    const reused=await api.qualifyTask(c.session,{offerHash:c.o.offerHash},{...c.seams,launch:()=>assert.fail('Receipt reuse must not launch')});assert.equal(reused.replayed,true);
    const status=await api.taskQualification(c.session,{configFile:c.config},c.seams);assert.equal(status.routes.length,2);assert.equal(status.proposals.length,1);assert.equal(status.proposals[0].cli,'muse');assert.equal(status.proposals[0].enabled,false);
    const health=await setupHealth(c.session,{configFile:c.config},{...c.seams,discover:()=>({copilot:true,muse:true,codex:true})}),auto=health.roles.find(x=>x.harness==='copilot');assert.equal(auto.modelAccess,'automatic-selection');assert.ok(auto.missing.includes('exact-model-access-not-qualified'));assert.equal(auto.taskCases.length,1);assert.equal(auto.taskCases[0].observedModel,'example-served');assert.equal(auto.launchAllowed,false);
  }
});

test('P04d: exact Copilot and Muse routes retain disabled case-scoped proposals',async t=>{
  const c=await completeTask(t,'finish',false,true),r=await api.qualifyTask(c.session,{offerHash:c.o.offerHash},c.seams);assert.ok(r.routes.every(x=>x.accessKind==='exact-model'));
  const status=await api.taskQualification(c.session,{configFile:c.config},c.seams);assert.equal(status.proposals.length,2);assert.ok(status.proposals.every(x=>x.enabled===false&&x.qualification.status==='trial'&&x.observedCaseOnly));
});

test('P04d: unknown forged or requested-only native facts cannot pass worker monitoring',async t=>{
  for(const patch of [{model_actual:null},{model_actual:'forged'},{model_actual_source:'requested-only'},{helper_audit:{state:'unknown'}}]){const c=await completeTask(t,'worker'),file=path.join(c.state,'runs','controller-worker-proof','run.json'),r=JSON.parse(fs.readFileSync(file,'utf8'));write(file,{...r,...patch});await assert.rejects(api.taskStep(c.session,{offerHash:c.o.offerHash,approve:true,step:'monitor-worker'},c.seams),/proof|model|evidence|verified/i);}
});

test('P04d: exact selector substitution fails even with a coherent native model report',async t=>{
  const c=await completeTask(t,'worker',false,true),dir=path.join(c.state,'runs','controller-worker-proof'),file=path.join(dir,'run.json'),r=JSON.parse(fs.readFileSync(file,'utf8'));write(file,{...r,model_actual:'substitute'});fs.writeFileSync(path.join(dir,'stdout.log'),fs.readFileSync(path.join(dir,'stdout.log'),'utf8').replaceAll('example-pinned','substitute'));
  await assert.rejects(api.taskStep(c.session,{offerHash:c.o.offerHash,approve:true,step:'monitor-worker'},c.seams),/model|proof/i);
});

test('P04d: Copilot usage sidecar is sealed and changed bytes invalidate receipt reuse',async t=>{
  const c=await completeTask(t,'finish',false,false,({ctx,runDir})=>{if(ctx.route.harness!=='copilot')return;const file=path.join(runDir,'stdout.log');fs.writeFileSync(file,fs.readFileSync(file,'utf8').split('\n').filter(x=>!x.includes('assistant.usage')).join('\n'));write(path.join(runDir,'copilot-usage.json'),{agentMetrics:{main:{modelMetrics:{'example-served':{requests:{count:1}}}}}});});
  const r=await api.qualifyTask(c.session,{offerHash:c.o.offerHash},c.seams),file=path.join(c.state,'runs','controller-worker-proof','copilot-usage.json');assert.ok(r.proofs.some(x=>x.file===file));write(file,{agentMetrics:{main:{modelMetrics:{'example-served':{requests:{count:2}}}}}});await assert.rejects(api.qualifyTask(c.session,{offerHash:c.o.offerHash},c.seams));
});

test('P04d: actual model collision refuses before reviewer finalization',async t=>{
  const c=await completeTask(t,'reviewer',true,false,({ctx,runDir})=>{if(ctx.role!=='reviewer')return;const record=path.join(runDir,'run.json'),r=JSON.parse(fs.readFileSync(record,'utf8'));write(record,{...r,model_actual:'example-muse'});fs.writeFileSync(path.join(runDir,'stdout.log'),fs.readFileSync(path.join(runDir,'stdout.log'),'utf8').replaceAll('example-served','example-muse'));});
  await assert.rejects(api.taskStep(c.session,{offerHash:c.o.offerHash,approve:true,step:'monitor-reviewer'},c.seams),/model|independent|proof/i);assert.equal(fs.existsSync(path.join(c.dir,'task-steps','finalize.json')),false);
});

test('P04d: protected source writes cannot pass independent task checks',async t=>{
  const c=await completeTask(t,'monitor-worker');fs.appendFileSync(path.join(c.o.workdir,'review-target.mjs'),'\n');await assert.rejects(api.taskStep(c.session,{offerHash:c.o.offerHash,approve:true,step:'verify-worker'},c.seams),/source|protected/i);
});

test('P04d: uncertain launches remain single-attempt without automatic retry',async t=>{
  const c=await completeTask(t,'claim');let calls=0;const request={offerHash:c.o.offerHash,approve:true,step:'worker'},seams={...c.seams,launch:()=>{calls++;throw Error('uncertain native launch');}};
  await assert.rejects(api.taskStep(c.session,request,seams));await assert.rejects(api.taskStep(c.session,request,seams),/attempt|uncertain/i);assert.equal(calls,1);
});

test('P04d: coherent actual-model collision after finalize refuses before recording accepted dispositions',async t=>{
  const c=await completeTask(t,'finalize',true),dir=path.join(c.state,'runs','controller-reviewer-proof'),file=path.join(dir,'run.json'),r=JSON.parse(fs.readFileSync(file,'utf8'));write(file,{...r,model_actual:'example-muse'});fs.writeFileSync(path.join(dir,'stdout.log'),fs.readFileSync(path.join(dir,'stdout.log'),'utf8').replaceAll('example-served','example-muse'));
  await assert.rejects(api.taskStep(c.session,{offerHash:c.o.offerHash,approve:true,step:'record'},c.seams),/different actual model/i);assert.equal(fs.existsSync(path.join(c.state,'ledger.jsonl')),false);
});
