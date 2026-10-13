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
import {setupHealth} from '../src/setup-health.mjs';
import * as api from '../src/setup-qualification.mjs';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const write=(f,x)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(x));};
const binding=h=>({harness:h,exe:process.execPath,sha256:hash(fs.readFileSync(process.execPath))});
async function fixture(t,reverse=false,exact=false){
  const c=makeCase('qualification-p04c');t.after(()=>c.cleanup());const repo=path.join(c.base,'repo');makeRepo(repo,{'AGENTS.md':'Owner rules\n'});
  const session=path.join(c.base,'session'),config=path.join(c.base,'private.json'),route=(h,m)=>({harness:h,model:m,billing:'subscription',permission:'allowed'});
  let s=await startSetup({repo,harness:'codex',session,catalog:undefined,roster:undefined});const pair=[route('copilot',exact?'example-copilot':'Auto'),route('muse','example-muse')];if(reverse)pair.reverse();
  for(const answer of [{controller:route('codex','example-controller'),workers:[pair[0]],reviewers:[pair[1]]},{mode:'deterministic'},{enabled:false},{stateRoot:c.stateRoot,reviewRoot:path.join(c.base,'packages'),cleanup:'retain-unmerged'},{enabled:false}])s=await answerSetup(session,{expectedRevision:s.revision,questionId:s.nextQuestion.id,answer});
  const p=await previewSetup(session,{configFile:config,adopt:false,update:false});await applySetup(session,{previewHash:p.previewHash,approve:true});return {...c,repo,session,config};
}
const offer=c=>api.offerSmoke(c.session,{configFile:c.config,worker:0,reviewer:0,maxAgeSeconds:3600},{binding});
async function launch(c,o,role,extra={}){return api.probeSmoke(c.session,{offerHash:o.offerHash,approve:true,role},{binding,launch:async p=>{
  const id=role+'-proof',now=new Date().toISOString(),dir=path.join(p.stateRoot,'runs',id),model=p.route.harness==='copilot'&&/^auto$/i.test(p.route.model)?'example-served':p.route.model;
  const workdir=role==='worker'?p.workdir:path.join(p.plan.reviewRoot,'review-proof'),message=`ORCH_QUALIFICATION:${p.challenge}:${role}`;
  write(path.join(dir,'run.json'),{id,cli:p.route.harness,role:role==='worker'?'implement':'review',model_requested:p.route.model,model_actual:model,model_actual_source:p.route.harness==='copilot'?'copilot-native-call-usage':'muse-runtime-model',model_mismatch:false,status:'completed',exit_code:0,ended_at:now,dir:workdir,dir_real:workdir,...(role==='reviewer'?{review_of:p.workerId,review_id:'review-proof'}:{}),escaped_helpers:[],helper_audit:{state:'observed'},handoff_source:p.prompt,handoff_sha256:hash(fs.readFileSync(p.prompt)),launch:{exe:p.binding.exe},role_packet:rolePrompt(Buffer.alloc(0),role==='worker'?'implement':'review').provenance,...extra});
  const stream={kind:'session',id:'session'},run_stream={kind:'run',id:'main'};
  const events=p.route.harness==='copilot'?[{type:'assistant.usage',data:{model}},{type:'assistant.message',data:{content:message}}]:[{schema_version:1,stream,payload_type:'run.model.configured',payload:{run_stream,provider_id:'meta',model_id:model}},{schema_version:1,stream,payload_type:'run.terminal.completed',payload:{run_stream,text:message}}];
  fs.writeFileSync(path.join(dir,'stdout.log'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');fs.writeFileSync(path.join(dir,'stderr.log'),'');fs.writeFileSync(path.join(dir,'keeper.ndjson'),[{event:'worker-exit',code:0,at:now},{event:'keeper-exit',write_failures:0,at:now}].map(x=>JSON.stringify(x)).join('\n'));
  if(role==='reviewer'){write(path.join(p.stateRoot,'reviews','review-proof.json'),{id:'review-proof',run_id:id,implementer_run:p.workerId,finished_at:now,outcome:'reviewed',containment:'clean',worktree:workdir,source_repo:p.workdir,review_root:p.plan.reviewRoot});write(resourceFile({stateRoot:p.stateRoot},'review-proof'),{id:'review-proof',kind:'review',review_id:'review-proof',state:'removed',removed_at:now,path:workdir,root:p.plan.reviewRoot,repo:p.workdir});}
  return {run_id:id,...(role==='reviewer'?{review_id:'review-proof'}:{})};
}});}
async function complete(c,o){await launch(c,o,'worker');await launch(c,o,'reviewer');return api.qualifySmoke(c.session,{offerHash:o.offerHash},{binding});}

test('P04c: Copilot/Muse offers are model-free and exact approval is required',async t=>{
  const c=await fixture(t),before=fs.readFileSync(c.config),o=await offer(c);assert.equal(o.providerCalls,0);assert.equal(fs.existsSync(o.workdir),false);
  await assert.rejects(api.probeSmoke(c.session,{offerHash:o.offerHash,approve:false,role:'worker'},{binding,launch:()=>assert.fail('unapproved call')}));assert.deepEqual(fs.readFileSync(c.config),before);
});
test('P04c: both role orientations preserve Auto access-only evidence and zero-call reuse',async t=>{
  for(const reverse of [false,true]){const c=await fixture(t,reverse),o=await offer(c),r=await complete(c,o),auto=r.routes.find(r=>r.harness==='copilot');assert.equal(auto.accessKind,'automatic-access');assert.equal(auto.observedModel,'example-served');assert.equal(r.routes.find(r=>r.harness==='muse').accessKind,'exact-model');assert.equal((await api.qualifySmoke(c.session,{offerHash:o.offerHash},{binding})).replayed,true);
    const status=await api.qualificationStatus(c.session,{configFile:c.config},{binding});assert.equal(status.providerCalls,0);assert.equal(status.routes.find(r=>r.harness==='copilot').accessKind,'automatic-access');assert.equal(r.cleanup.review,'removed');}
});
test('P04c: actual reviewer collision refuses even when requested selectors differ',async t=>{
  const c=await fixture(t),o=await offer(c);await launch(c,o,'worker',{model_actual:'example-muse'});
  // Keep native usage coherent: Auto legitimately selected the Muse worker's model.
  fs.writeFileSync(path.join(o.stateRoot,'runs','worker-proof','stdout.log'),fs.readFileSync(path.join(o.stateRoot,'runs','worker-proof','stdout.log'),'utf8').replaceAll('example-served','example-muse'));
  await launch(c,o,'reviewer');await assert.rejects(api.qualifySmoke(c.session,{offerHash:o.offerHash},{binding}),/independent|same.*model/i);
});
test('P04c: an exact selector cannot turn substituted native evidence into qualification',async t=>{
  const c=await fixture(t,false,true),o=await offer(c);await launch(c,o,'worker',{model_actual:'other-model'});await assert.rejects(launch(c,o,'reviewer'));
});
test('P04c: requested-only or forged native model evidence cannot qualify Auto',async t=>{
  for(const extra of [{model_actual:null},{model_actual_source:'requested-only'},{model_actual:'forged-model'}]){const c=await fixture(t),o=await offer(c);await launch(c,o,'worker',extra);await assert.rejects(launch(c,o,'reviewer'));}
});
test('P04c: mixed-case Copilot billing and authentication overrides are removed',()=>{
  const env=api.subscriptionEnvironment({Gh_Token:'private',GitHub_Token:'private',Copilot_GitHub_Token:'private',Copilot_Provider_Api_Key:'private',COPILOT_PROVIDER_TYPE:'openai',Gh_Enterprise_Token:'private',GitHub_Enterprise_Token:'private',GH_HOST:'untrusted.example',Copilot_Gh_Host:'untrusted.example',GH_CONFIG_DIR:'redirected',GITHUB_SERVER_URL:'https://untrusted.example',GITHUB_API_URL:'https://untrusted.example',META_API_KEY:'private',MUSE_AUTH_PATH:'native-signin',PATH:'native-path'});
  for(const k of ['Gh_Token','GitHub_Token','Copilot_GitHub_Token','Copilot_Provider_Api_Key','COPILOT_PROVIDER_TYPE','Gh_Enterprise_Token','GitHub_Enterprise_Token','GH_HOST','Copilot_Gh_Host','GH_CONFIG_DIR','GITHUB_SERVER_URL','GITHUB_API_URL','META_API_KEY'])assert.equal(env[k],undefined);assert.equal(env.MUSE_AUTH_PATH,'native-signin');
});
test('P04c: Auto native launch omits unsupported effort and turn-limit flags',()=>{
  assert.equal(typeof api.smokeLaunchArguments,'function');const p={route:{harness:'copilot',model:'Auto'},role:'worker',stateRoot:'state',workdir:'source',prompt:'prompt'};
  const args=api.smokeLaunchArguments(p);assert.ok(!args.includes('--effort'));assert.ok(!args.includes('--max-turns'));assert.ok(args.includes('--owner-approved-model'));
});
test('P04c: health reports Auto subscription access without exact model or task readiness',async t=>{
  const c=await fixture(t),o=await offer(c);await complete(c,o);const health=await setupHealth(c.session,{configFile:c.config},{binding,discover:()=>({codex:true,copilot:true,muse:true})});const auto=health.roles.find(r=>r.harness==='copilot');assert.equal(auto.authentication,'subscription-observed');assert.equal(auto.modelAccess,'automatic-selection');assert.ok(auto.missing.includes('exact-model-access-not-qualified'));assert.notEqual(auto.status,'runtime-ready');assert.equal(auto.launchAllowed,false);assert.equal(auto.roleSmoke.modelEvidenceSource,'copilot-native-call-usage');
});

test('P04c: exact Copilot/Muse evidence remains invalid after record or executable drift',async t=>{
  const c=await fixture(t,false,true),o=await offer(c),r=await complete(c,o);assert.ok(r.routes.every(r=>r.accessKind==='exact-model'));
  const changed=await api.qualificationStatus(c.session,{configFile:c.config},{binding:h=>({...binding(h),sha256:'a'.repeat(64)})});assert.equal(changed.routes.length,0);
  fs.appendFileSync(path.join(o.stateRoot,'runs','worker-proof','run.json'),' ');const tampered=await api.qualificationStatus(c.session,{configFile:c.config},{binding});assert.equal(tampered.routes.length,0);
});
test('P04c: an uncertain Auto launch and incomplete cleanup preserve evidence without retries',async t=>{
  const c=await fixture(t),o=await offer(c);let calls=0;await assert.rejects(api.probeSmoke(c.session,{offerHash:o.offerHash,approve:true,role:'worker'},{binding,launch:()=>{calls++;throw Error('private-unknown');}}));
  await assert.rejects(api.probeSmoke(c.session,{offerHash:o.offerHash,approve:true,role:'worker'},{binding,launch:()=>{calls++;throw Error('unsafe retry');}}));assert.equal((await api.qualificationStatus(c.session,{configFile:c.config},{binding})).trials[0].attempts[0].state,'uncertain');assert.equal(calls,1);
  const other=await fixture(t),offer2=await offer(other);await launch(other,offer2,'worker');await launch(other,offer2,'reviewer');const file=resourceFile({stateRoot:offer2.stateRoot},'review-proof'),record=JSON.parse(fs.readFileSync(file,'utf8'));write(file,{...record,state:'cleanup-pending'});
  await assert.rejects(api.qualifySmoke(other.session,{offerHash:offer2.offerHash},{binding,finish:async()=>{}}));assert.ok(fs.existsSync(path.join(offer2.stateRoot,'runs','worker-proof','run.json')));
});
test('P04c: extending access smoke does not enable unqualified controller or task child profiles',async t=>{
  const c=await fixture(t),controller=await import('../src/setup-controller.mjs'),task=await import('../src/setup-task.mjs'),cases=await import('../src/task-cases.mjs');
  const options={configFile:c.config,worker:0,reviewer:0,maxAgeSeconds:3600};
  await assert.rejects(controller.offerController(c.session,options,{binding}),/Codex.*Vibe|child.*profile/i);
  await assert.rejects(task.offerTask(c.session,{...options,caseId:cases.TASK_CASE},{binding}),/Codex.*Vibe|child.*profile/i);
});
test('P04c: a Copilot usage sidecar is sealed and changed native bytes invalidate reuse',async t=>{
  const c=await fixture(t),o=await offer(c);await launch(c,o,'worker');const dir=path.join(o.stateRoot,'runs','worker-proof'),stdout=path.join(dir,'stdout.log');fs.writeFileSync(stdout,fs.readFileSync(stdout,'utf8').split('\n').filter(line=>!line.includes('assistant.usage')).join('\n'));
  const usage=path.join(dir,'copilot-usage.json');write(usage,{agentMetrics:{main:{modelMetrics:{'example-served':{requests:{count:1}}}}}});await launch(c,o,'reviewer');const receipt=await api.qualifySmoke(c.session,{offerHash:o.offerHash},{binding});assert.ok(receipt.proofs.some(p=>p.file===usage));
  write(usage,{agentMetrics:{main:{modelMetrics:{'example-served':{requests:{count:2}}}}}});assert.equal((await api.qualificationStatus(c.session,{configFile:c.config},{binding})).routes.length,0);
});

test('P04c: malformed task requests fail as controlled contract refusals before route access',async t=>{
  const c=await fixture(t),task=await import('../src/setup-task.mjs');for(const options of [undefined,null,{},[]])await assert.rejects(task.offerTask(c.session,options,{binding}),e=>e instanceof Error&&'code' in e&&e.code==='task-qualification-refused');
});

test('P04c: missing Muse authentication is a retained refusal before any model launch',async t=>{
  const c=await fixture(t,true),o=await offer(c),prior=process.env.MUSE_AUTH_PATH;process.env.MUSE_AUTH_PATH=path.join(c.base,'missing-auth.json');
  try{await assert.rejects(api.probeSmoke(c.session,{offerHash:o.offerHash,approve:true,role:'worker'},{binding}),e=>e instanceof Error&&'code' in e&&e.code==='qualification-auth-refused');const status=await api.qualificationStatus(c.session,{configFile:c.config},{binding});assert.equal(status.trials[0].attempts[0].state,'refused');assert.equal(status.routes.length,0);}finally{if(prior===undefined)delete process.env.MUSE_AUTH_PATH;else process.env.MUSE_AUTH_PATH=prior;}
});
