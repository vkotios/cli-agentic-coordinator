import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {startSetup,answerSetup} from '../src/setup.mjs';
import {previewSetup,applySetup} from '../src/setup-apply.mjs';
import {makeCase} from './helpers.mjs';
import {makeRepo} from './wf-helpers.mjs';
import {setupHealth} from '../src/setup-health.mjs';
import {subscriptionControllerSpec} from '../src/controller-subscriptions.mjs';
import {runCommand,parseArgs} from '../src/cli.mjs';
import {closureFile,resourceFile} from '../src/resources.mjs';
import {verifyTaskImplementation} from '../src/task-cases.mjs';
import {callTool,toolList} from '../src/mcp.mjs';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
/** @type {any} */ const setup=await import('../src/setup-repository-controller.mjs').catch(()=>({}));
/** @type {any} */ const api=await import('../src/repository-controller.mjs').catch(()=>({}));
const tools=['claim','run','status','result','scope','review','review_finish','record','cleanup','finish'];
const plan=()=>({offerHash:'a'.repeat(64),wp:'repository-case',by:'muse',workdir:path.resolve('fixture','repo'),stateRoot:path.resolve('fixture','state'),worker:{harness:'codex',model:'example-worker'},reviewer:{harness:'vibe',model:'example-reviewer'},workerPrompt:path.resolve('fixture','worker.txt'),reviewerPrompt:path.resolve('fixture','reviewer.txt'),reviewRoot:path.resolve('fixture','reviews'),baseline:'b'.repeat(40),allow:['stats.mjs'],expiresAt:'2099-01-01T00:00:00Z'});
const output=value=>({isError:false,structuredContent:{exit_code:0,output:value},content:[{type:'text',text:JSON.stringify(value)}]});
test('P04i: repository profile advertises ordinary tools and cannot reuse a fixed-step receipt',()=>{
 assert.equal(typeof api.repositoryProfile,'function');
 const p=api.repositoryProfile('muse');assert.equal(p.commandPolicy,'owned-repository-tools');assert.ok(tools.every(t=>p.tools.includes(t)));assert.ok(!p.tools.includes('controller_step'));assert.throws(()=>api.repositoryProfile('arbitrary'));
});
test('P04i: scope guard refuses foreign paths, route substitutions and extra arguments before dispatch',async()=>{
 const p=plan(),calls=[];const invoke=(tool,args)=>api.invokeRepositoryTool(p,[],tool,args,{dispatch:async(n,a)=>{calls.push([n,a]);return output({});}});
 for(const [tool,args] of [['claim',{wp:'foreign',by:p.by}],['claim',{wp:p.wp,by:'owner'}],['run',{cli:'vibe',model:'other',wp:p.wp,by:p.by,allow:p.allow}],['status',{id:'foreign'}],['cleanup',{wp:p.wp,apply:true}],['finish',{wp:p.wp,by:p.by,retain:'foreign.json'}],['controller_step',{step:'claim'}]])await assert.rejects(invoke(tool,args));
 assert.equal(calls.length,0);
});
test('P04i: uncertain launch is durably reserved and is never automatically repeated',async()=>{
 const p=plan(),journal=[];let calls=0;
 const options={persist:async row=>journal.push(row),dispatch:async()=>{calls++;throw Error('connection lost after spawn');}};
 const args={cli:p.worker.harness,model:p.worker.model,wp:p.wp,by:p.by,allow:p.allow};
 await assert.rejects(api.invokeRepositoryTool(p,journal,'run',args,options));
 assert.ok(journal.some(r=>r.kind==='attempt'&&r.tool==='run'));
 await assert.rejects(api.invokeRepositoryTool(p,journal,'run',args,options));assert.equal(calls,1);
});

test('P04i live regression: bounded native claim session metadata preserves exact ownership',async()=>{
 const p={...plan(),discoveryChallenge:'OWNER_RULE_SYNTHETIC'},args={wp:p.wp,by:p.by,note:p.discoveryChallenge,session:'native-session-123'},journal=[],calls=[];
 const result=await api.invokeRepositoryTool(p,journal,'claim',args,{persist:async row=>journal.push(row),dispatch:async(name,input)=>{calls.push({name,input});return output({claim:'acquired',token:'synthetic'});}});
 assert.deepEqual(calls,[{name:'claim',input:args}]);assert.equal(result.structuredContent.output.claim,'acquired');assert.equal(journal[0].input.session,args.session);
});
test('P04i live regression: session metadata cannot override WP, claimant, owner note or scope',()=>{
 const p={...plan(),discoveryChallenge:'OWNER_RULE_SYNTHETIC'},args={wp:p.wp,by:p.by,note:p.discoveryChallenge,session:'native-session-123'};
 for(const bad of [{...args,wp:'foreign'},{...args,by:'owner'},{...args,note:'wrong'},{...args,session:'../foreign'},{...args,session:'x'.repeat(81)},{...args,force:true}])assert.throws(()=>api.validateRepositoryRequest(p,[],'claim',bad));
});
test('P04i: completed native dispatch binds later status/review inputs to returned IDs',async()=>{
 const p=plan(),journal=[],options={persist:async row=>journal.push(row),dispatch:async tool=>output(tool==='run'?{id:'run-a'}:{status:'running'})};
 const r=await api.invokeRepositoryTool(p,journal,'run',{cli:p.worker.harness,model:p.worker.model,wp:p.wp,by:p.by,allow:p.allow},options);
 assert.match(r.structuredContent.repositoryProof.requestId,/^[a-f0-9]{32}$/);assert.equal(r.structuredContent.repositoryProof.offerHash,p.offerHash);
 await api.invokeRepositoryTool(p,journal,'status',{id:'run-a'},options);
 await assert.rejects(api.invokeRepositoryTool(p,journal,'status',{id:'foreign'},options));
 await assert.rejects(api.invokeRepositoryTool(p,journal,'run',{cli:p.worker.harness,model:p.worker.model,wp:p.wp,by:p.by,allow:p.allow},options));
});
function nativeCopilot(rows){return [{type:'model.call_start',data:{turnId:'t1',model:'actual-model'}},{type:'model.call_finished',data:{turnId:'t1',outcome:'success'}},...rows.flatMap((r,i)=>[{type:'tool.execution_start',data:{toolCallId:'call-'+i,toolName:'orch-'+r.tool,arguments:r.input}},{type:'tool.execution_complete',data:{toolCallId:'call-'+i,success:true,result:{content:JSON.stringify(r.response)}}}]),{type:'result',sessionId:'native-session',exitCode:0}];}
function journalRow(tool,id){return {kind:'result',requestId:id,tool,input:{wp:'repository-case',by:'copilot'},response:{isError:false,structuredContent:{exit_code:0,output:{},repositoryProof:{offerHash:'a'.repeat(64),requestId:id}}}};}
test('P04i: native ordinary-tool proof requires exact audited inputs/results and actual terminal model',()=>{
 assert.equal(typeof api.observeRepositoryTrace,'function');const rows=[journalRow('claim','1'.repeat(32)),journalRow('finish','2'.repeat(32))],events=nativeCopilot(rows),o={harness:'copilot',model:'auto',offerHash:'a'.repeat(64),journal:rows};
 const proof=api.observeRepositoryTrace(events,o);assert.equal(proof.model,'actual-model');assert.equal(proof.accessKind,'automatic-access');assert.equal(proof.calls.length,2);
 for(const altered of [events.slice(0,-1),events.map(e=>e.type==='tool.execution_start'?{...e,data:{...e.data,arguments:{wp:'foreign'}}}:e),events.map(e=>e.type==='tool.execution_start'?{...e,data:{...e.data,toolName:'shell'}}:e),events.map(e=>e.type==='tool.execution_complete'?{...e,data:{...e.data,success:false}}:e)])assert.throws(()=>api.observeRepositoryTrace(altered,o));
 assert.throws(()=>api.observeRepositoryTrace(events,{...o,model:'wrong'}));assert.throws(()=>api.observeRepositoryTrace(events,{...o,journal:rows.slice(0,1)}));
});
test('P04i: journal evidence alone or assistant prose cannot qualify a native controller',()=>{
 const rows=[journalRow('claim','1'.repeat(32))];
 assert.throws(()=>api.observeRepositoryTrace([{type:'assistant.message',data:{content:JSON.stringify(rows)}}],{harness:'copilot',model:'auto',offerHash:'a'.repeat(64),journal:rows}));
});

test('P04i: Muse ordinary tools bind one runtime model/session/run and every server nonce',()=>{
 const rows=[journalRow('claim','1'.repeat(32)),journalRow('finish','2'.repeat(32))];
 const events=[{schema_version:1,payload_type:'run.model.configured',stream:{kind:'session',id:'s'},payload:{provider_id:'meta',model_id:'muse-spark-1.3',run_stream:{kind:'run',id:'r'}}},...rows.map((row,i)=>({schema_version:1,payload_type:'tool.result',stream:{kind:'session',id:'s'},payload:{call_id:'c'+i,run_stream:{kind:'run',id:'r'},text:JSON.stringify(row.response),correlation_facts:{tool_name:'mcp__orch__'+row.tool,outcome:'success'}}})),{schema_version:1,payload_type:'run.terminal.completed',stream:{kind:'session',id:'s'},payload:{run_stream:{kind:'run',id:'r'},terminal:'completed'}}];
 const options={harness:'muse',model:'muse-spark-1.3',offerHash:'a'.repeat(64),journal:rows};assert.equal(api.observeRepositoryTrace(events,options).calls.length,2);
 const wire=events.map(e=>e.payload_type==='tool.result'?{...e,payload:{...e.payload,text:JSON.stringify(api.repositoryNativeResult(JSON.parse(e.payload.text)))}}:e);assert.equal(api.observeRepositoryTrace(wire,options).calls.length,2);
 for(const changed of [events.slice(1),events.map(e=>e.payload_type==='tool.result'?{...e,stream:{kind:'session',id:'foreign'}}:e),events.map(e=>e.payload_type==='tool.result'?{...e,payload:{...e.payload,correlation_facts:{tool_name:'shell',outcome:'success'}}}:e),[...events,events.at(-1)]])assert.throws(()=>api.observeRepositoryTrace(changed,options));
});

async function selected(t,harness='copilot'){
 const c=makeCase('p04i-'+harness);t.after(()=>c.cleanup());const repo=path.join(c.base,'repo');makeRepo(repo,{'AGENTS.md':'Original project rules\n'});
 const session=path.join(c.base,'session'),config=path.join(c.base,'runtime.json'),route=(h,model)=>({harness:h,model,billing:'subscription',permission:'ask'});
 let s=await startSetup({repo,harness,session,roster:undefined,catalog:undefined});for(const answer of [{controller:route(harness,harness==='copilot'?'auto':'muse-spark-1.3'),workers:[route('codex','example-worker')],reviewers:[route('vibe','example-reviewer')]},{mode:'deterministic'},{enabled:false},{stateRoot:c.stateRoot,reviewRoot:path.join(c.base,'reviews'),cleanup:'retain-unmerged'},{enabled:false}])s=await answerSetup(session,{expectedRevision:s.revision,questionId:s.nextQuestion.id,answer});
 const preview=await previewSetup(session,{configFile:config,adopt:false,update:false});await applySetup(session,{previewHash:preview.previewHash,approve:true});
 const doc=JSON.parse(fs.readFileSync(config,'utf8'));doc.exe={copilot:process.execPath,muse:process.execPath,codex:process.execPath,vibe:process.execPath};fs.writeFileSync(config,JSON.stringify(doc));
 const binding=h=>({harness:h,exe:process.execPath,target:fs.realpathSync.native(process.execPath),sha256:crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex')});return {...c,repo,session,config,seams:{binding}};
}
test('P04i: offers do not launch and preparation preserves owner repository bytes',async t=>{
 assert.equal(typeof setup.offerRepositoryController,'function');
 for(const harness of ['copilot','muse']){
  const c=await selected(t,harness),before=fs.readFileSync(path.join(c.repo,'AGENTS.md')),config=fs.readFileSync(c.config);
  const o=await setup.offerRepositoryController(c.session,{configFile:c.config,worker:0,reviewer:0,maxAgeSeconds:3600},c.seams);assert.equal(o.providerCalls,0);assert.equal(o.activation,false);assert.equal(o.profile.commandPolicy,'owned-repository-tools');
  await assert.rejects(setup.prepareRepositoryController(c.session,{offerHash:o.offerHash,approve:false},c.seams));
  const r=await setup.prepareRepositoryController(c.session,{offerHash:o.offerHash,approve:true},c.seams);assert.notEqual(r.workdir,c.repo);assert.deepEqual(fs.readFileSync(path.join(c.repo,'AGENTS.md')),before);assert.deepEqual(fs.readFileSync(c.config),config);
  assert.ok(fs.readFileSync(path.join(r.workdir,'AGENTS.md'),'utf8').startsWith('Owner rules must survive adoption.'));
  assert.ok(!fs.existsSync(path.join(r.workdir,'launch-attempt.json')));assert.equal((await setup.prepareRepositoryController(c.session,{offerHash:o.offerHash,approve:true},c.seams)).replayed,true);
  const f=setup.repositoryExecutionSpec(c.session,o.offerHash,c.seams).f;assert.ok(!fs.readFileSync(f.instructions,'utf8').includes('OWNER_RULE_'));assert.ok(fs.existsSync(path.join(f.dir,'adoption-original.json')));
  await assert.rejects(setup.invokeRepositoryFromFile(c.session,o.offerHash,'claim',{wp:'foreign',by:harness},c.seams));
  await assert.rejects(setup.qualifyRepositoryController(c.session,{offerHash:o.offerHash},c.seams));
 }
});

test('P04i: real instruction reads and claim dispatch require exact launch approval; tampered bytes refuse',async t=>{
 const c=await selected(t,'muse'),o=await setup.offerRepositoryController(c.session,{configFile:c.config,worker:0,reviewer:0,maxAgeSeconds:3600},c.seams),request={offerHash:o.offerHash,approve:true};
 await setup.prepareRepositoryController(c.session,request,c.seams);const {p,f,r}=setup.repositoryExecutionSpec(c.session,o.offerHash,c.seams);
 await assert.rejects(setup.invokeRepositoryFromFile(c.session,o.offerHash,'repository_instructions',{},c.seams));
 await setup.runRepositoryController(c.session,request,{...c.seams,spawn:()=>({pid:999999,unref(){}})});
 await assert.rejects(setup.runRepositoryController(c.session,request,{...c.seams,spawn:()=>{throw Error('must never spawn twice');}}),{code:'repository-controller-refused'});
 const read=await setup.invokeRepositoryFromFile(c.session,o.offerHash,'repository_instructions',{},c.seams);assert.ok(read.structuredContent.output.files.some(x=>x.path==='AGENTS.md'&&x.text.includes(p.discoveryChallenge)));assert.ok(read.structuredContent.output.files.some(x=>x.path==='.orch/instructions/protocol.md'));
 const claim=await setup.invokeRepositoryFromFile(c.session,o.offerHash,'claim',{wp:p.wp,by:'muse',note:p.discoveryChallenge},c.seams);assert.equal(claim.structuredContent.output.claim,'acquired');
 await assert.rejects(setup.invokeRepositoryFromFile(c.session,o.offerHash,'claim',{wp:p.wp,by:'muse',note:p.discoveryChallenge},c.seams));
 await assert.rejects(setup.qualifyRepositoryController(c.session,{offerHash:o.offerHash},c.seams));
 fs.appendFileSync(path.join(r.workdir,'AGENTS.md'),'changed owner rules');await assert.rejects(setup.invokeRepositoryFromFile(c.session,o.offerHash,'repository_instructions',{},c.seams),/Protected/);
 assert.ok(fs.readdirSync(f.journal).length>=4);
});

test('P04i: repository native launch profiles expose only the exact ordinary-tool set',t=>{
 const c=makeCase('p04i-native-tools');t.after(()=>c.cleanup());const instructions=path.join(c.base,'instructions.txt');fs.writeFileSync(instructions,'Read the adopted repository instructions and perform the approved task.');
 const files={dir:c.base,workdir:c.base,instructions,repositoryTools:api.REPOSITORY_TOOLS};
 const spec=subscriptionControllerSpec({harness:'copilot',model:'auto'},files,{USERPROFILE:c.base,GH_TOKEN:'must-not-forward',NODE_OPTIONS:'must-not-forward'},{settings:{},mcp:{}});
 assert.ok(!spec.args.includes('orch-controller_step'));assert.ok(spec.args.includes('orch-run'));assert.ok(spec.args.includes('orch-repository_instructions'));assert.equal(spec.env.GH_TOKEN,undefined);assert.equal(spec.env.NODE_OPTIONS,undefined);
 assert.throws(()=>subscriptionControllerSpec({harness:'copilot',model:'auto'},{...files,repositoryTools:['shell']},{USERPROFILE:c.base},{settings:{},mcp:{}}));
});

test('P04i: setup CLI offers the repository flow without launching a model',async t=>{
 const c=await selected(t),request=path.join(c.base,'request.json');fs.writeFileSync(request,JSON.stringify({worker:0,reviewer:0,maxAgeSeconds:3600}));
 // CLI rejection proves argument routing, without replacing native executable discovery.
 const out=[];await assert.rejects(runCommand('setup',parseArgs(['repository-run','--session',c.session,'--request',request,'--json']),{log:s=>out.push(s)}),/exact repository/);assert.deepEqual(out,[]);
 assert.ok(setup.repositoryToolList().some(t=>t.name==='run'));assert.ok(!setup.repositoryToolList().some(t=>t.name==='cancel'));
 const wire=await callTool('setup_repository_qualification',{session:c.session,config:c.config},{stateRoot:c.stateRoot});assert.equal(wire.isError,false,'private session must not receive an unrelated MCP server state-root argument');
});

test('P04i: health clears only the matching fresh repository profile and stays read-only',async t=>{
 const c=await selected(t,'muse'),profile=api.repositoryProfile('muse'),doc=JSON.parse(fs.readFileSync(c.config,'utf8'));doc.controllerProfile=profile;fs.writeFileSync(c.config,JSON.stringify(doc));
 const saved=Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('ORCH_')));for(const k of Object.keys(saved))delete process.env[k];process.env.ORCH_CONFIG=c.config;
 const route={harness:'muse',model:'muse-spark-1.3',billing:'subscription',status:'repository-controller-observed',profile,scope:profile.scope,expiresAt:'2099-01-01T00:00:00Z',offerHash:'a'.repeat(64)};
 try{
  const before=fs.readFileSync(c.config),seams={discover:()=>({muse:true,codex:true,vibe:true}),controllerQualification:async()=>({routes:[],childRoutes:[]}),repositoryControllerQualification:async()=>({routes:[route]})};
  const health=await setupHealth(c.session,{configFile:c.config},seams);assert.ok(!health.roles[0].missing.includes('repository-controller-profile-unqualified'));assert.equal(health.roles[0].qualification.status,'repository-controller-observed');assert.equal(health.roles[0].launchAllowed,false);assert.equal(health.providerCalls,0);assert.deepEqual(fs.readFileSync(c.config),before);
  const wrong=await setupHealth(c.session,{configFile:c.config},{...seams,repositoryControllerQualification:async()=>({routes:[{...route,profile:{...profile,tools:['shell']}}]})});assert.ok(wrong.roles[0].missing.includes('repository-controller-profile-unqualified'));
 }finally{for(const k of Object.keys(process.env))if(k.startsWith('ORCH_'))delete process.env[k];Object.assign(process.env,saved);}
});

const write=(f,x)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(x)+'\n');};
const goodSource='export function summarizeReadings(values) { if (!Array.isArray(values)) throw new TypeError(); let total=0; let min=null; let max=null; for (const value of values) { if (typeof value!=="number" || !Number.isFinite(value)) throw new TypeError(); total+=value; min=min===null?value:Math.min(min,value); max=max===null?value:Math.max(max,value); } return {count:values.length,min,max,total}; }\n';
async function offlineRepository(t,harness){
 const c=await selected(t,harness),o=await setup.offerRepositoryController(c.session,{configFile:c.config,worker:0,reviewer:0,maxAgeSeconds:3600},c.seams);await setup.prepareRepositoryController(c.session,{offerHash:o.offerHash,approve:true},c.seams);await setup.runRepositoryController(c.session,{offerHash:o.offerHash,approve:true},{...c.seams,spawn:()=>({pid:888888,unref(){}})});
 const {p,f,r}=setup.repositoryExecutionSpec(c.session,o.offerHash,c.seams),started=new Date(Date.now()-20).toISOString(),ids=['repository-worker','repository-reviewer'],reviewId='repository-review',claimValue='owned-claim-token',journal=[];
 const invoke=async(tool,args)=>{const out=await setup.invokeRepositoryFromFile(c.session,o.offerHash,tool,args,{...c.seams,dispatch:async(name,a)=>{
  if(name==='repository_instructions')return output({files:[{path:'AGENTS.md',text:fs.readFileSync(path.join(r.workdir,'AGENTS.md'),'utf8')}]});
  if(name==='claim')return output({claim:'acquired',token:claimValue});
  if(name==='run'||name==='review'){
   if(name==='review')assert.equal(a['review-root'],p.smoke.reviewRoot,'Real CLI dispatch receives only the exact offered directory');
   if(name==='run'){assert.equal(a.dir,r.workdir);assert.equal(a.handoff,path.join(f.dir,'worker.txt'));}
   const i=name==='review'?1:0,route=p.smoke.routes.find(x=>x.role===(i?'reviewer':'worker')),dir=path.join(p.smoke.stateRoot,'runs',ids[i]),workdir=i?path.join(p.smoke.reviewRoot,reviewId):r.workdir,prompt=i?a.prompt:path.join(f.dir,'worker.txt'),now=new Date().toISOString();
   if(!i)fs.writeFileSync(path.join(r.workdir,'stats.mjs'),goodSource);
   write(path.join(dir,'run.json'),{id:ids[i],cli:route.harness,role:i?'review':'implement',wp:p.wp,by:harness,status:'completed',exit_code:0,model_requested:route.model,model_actual:route.model,helper_audit:{state:'observed'},model_mismatch:false,launch:{exe:process.execPath},handoff_source:prompt,handoff_sha256:crypto.createHash('sha256').update(fs.readFileSync(prompt)).digest('hex'),dir:workdir,...(i?{review_of:ids[0],review_id:reviewId}:{})});
   fs.writeFileSync(path.join(dir,'keeper.ndjson'),[{event:'worker-exit',code:0,at:now},{event:'keeper-exit',write_failures:0,at:now}].map(x=>JSON.stringify(x)).join('\n'));
   const report={challenge:p.smoke.challenge,findings:[{file:'review-target.mjs',input:[0],observed:0,expected:1,explanation:'Zero is finite'},{file:'review-target.mjs',input:['text'],observed:1,expected:0,explanation:'Strings are not numbers'}]};
   write(path.join(dir,'stdout.log'),i?{type:'message',role:'assistant',content:[{type:'text',text:JSON.stringify(report)}]}:{type:'item.completed',item:{type:'agent_message',text:'Implemented the helper'}});
   if(i){write(path.join(p.smoke.stateRoot,'reviews',reviewId+'.json'),{id:reviewId,run_id:ids[1],implementer_run:ids[0],wp:p.wp,containment:'clean',outcome:'reviewed',finished_at:now,source_repo:r.workdir,worktree:workdir});write(resourceFile({stateRoot:p.smoke.stateRoot},reviewId),{state:'removed'});}
   return output(i?{run_id:ids[i],review_id:reviewId}:{id:ids[i]});
  }
  if(name==='repository_verify')return output(await verifyTaskImplementation(path.join(r.workdir,'stats.mjs')));
  if(name==='gate_record')return output({gate:{decision:'converged'}});
  if(name==='record'){const file=path.join(p.smoke.stateRoot,'ledger.jsonl');fs.appendFileSync(file,JSON.stringify({run_id:a.run_id,wp:p.wp,disposition:a.disposition})+'\n');return output({recorded:true});}
  if(name==='finish'){write(closureFile({stateRoot:p.smoke.stateRoot},p.wp),{state:'finished',by:harness,claim_token:claimValue,run_ids:ids,resources:[]});return output({state:'finished'});}
  return output({status:'completed',scope:'pass'});
 }});journal.push({kind:'result',tool,input:args,response:out});return out;};
 await invoke('repository_instructions',{});await invoke('claim',{wp:p.wp,by:harness,note:p.discoveryChallenge});
 await invoke('run',{cli:'codex',model:'example-worker',wp:p.wp,by:harness,allow:['stats.mjs']});await invoke('status',{id:ids[0]});await invoke('result',{id:ids[0]});await invoke('scope',{run_id:ids[0]});await invoke('repository_verify',{});
 await invoke('review',{run:ids[0],ref:'HEAD',reviewer:'vibe',model:'example-reviewer',by:harness});await invoke('status',{id:ids[1]});await invoke('result',{id:ids[1]});await invoke('review_finish',{review_id:reviewId,by:harness});await invoke('gate_record',{wp:p.wp,slice:'repository-case',round:1,findings:'[]',verification:'pass',scope:'pass',by:harness});
 for(const run_id of ids)await invoke('record',{run_id,disposition:'accepted'});await invoke('cleanup',{wp:p.wp,'dry-run':true});await invoke('finish',{wp:p.wp,by:harness});
 write(path.join(f.dir,'launch.json'),{offerHash:o.offerHash,exe:process.execPath,pid:999999,createdAt:started,runnerPid:888888,runnerCreatedAt:started,profile:p.profile,workdir:r.workdir,instructionsHash:r.instructionsHash,authSource:harness==='copilot'?'copilot-api-overrides-cleared':'muse-device-subscription',apiOverridesRemoved:true,intervened:false,startedAt:started});
 write(path.join(f.dir,'exit.json'),{code:0,signal:null,endedAt:new Date().toISOString()});write(path.join(f.dir,'connections','888887-'+('a'.repeat(32))+'.json'),{offerHash:o.offerHash,pid:888887,createdAt:started,startedAt:started});
 const trace=harness==='copilot'?nativeCopilot(journal):[{schema_version:1,payload_type:'run.model.configured',stream:{kind:'session',id:'s'},payload:{provider_id:'meta',model_id:'muse-spark-1.3',run_stream:{kind:'run',id:'r'}}},...journal.map((row,i)=>({schema_version:1,payload_type:'tool.result',stream:{kind:'session',id:'s'},payload:{call_id:'c'+i,run_stream:{kind:'run',id:'r'},text:JSON.stringify(row.response),correlation_facts:{tool_name:'mcp__orch__'+row.tool,outcome:'success'}}})),{schema_version:1,payload_type:'run.terminal.completed',stream:{kind:'session',id:'s'},payload:{run_stream:{kind:'run',id:'r'},terminal:'completed'}}];
 fs.writeFileSync(path.join(f.dir,'stdout.jsonl'),trace.map(x=>JSON.stringify(x)).join('\n'));fs.writeFileSync(path.join(f.dir,'stderr.txt'),'');return {...c,o,p,f,r,journal,seams:{...c.seams,processTable:async()=>[]}};
}
test('P04i schema regression: trial rejects unapproved launch options without changing ordinary global tools',()=>{
 const validator=new AjvJsonSchemaValidator(),trial=setup.repositoryToolList().find(t=>t.name==='run').inputSchema,ordinary=/** @type {Parameters<AjvJsonSchemaValidator['getValidator']>[0]} */(toolList().find(t=>t.name==='run').inputSchema),p=plan(),args={cli:p.worker.harness,model:p.worker.model,wp:p.wp,by:p.by,allow:p.allow};
 assert.equal(validator.getValidator(trial)(args).valid,true);for(const extra of [{lane:'local'},{'no-window':true},{size:'M'}]){assert.equal(validator.getValidator(ordinary)({...args,dir:p.workdir,handoff:p.workerPrompt,...extra}).valid,true);assert.equal(validator.getValidator(trial)({...args,...extra}).valid,false,'The trial must not advertise options its exact guard refuses');}
});
test('P04i schema regression: real guarded lifecycle requests match advertised required fields and keep discovery blind',async t=>{
 const c=await offlineRepository(t,'copilot'),schemas=setup.repositoryToolList(c.p,c.r),validator=new AjvJsonSchemaValidator();assert.ok(!JSON.stringify(schemas).includes(c.p.discoveryChallenge),'The owner note must still be discovered from installed instructions');
 for(const row of c.journal){const schema=/** @type {Parameters<AjvJsonSchemaValidator['getValidator']>[0]} */(schemas.find(x=>x.name===row.tool).inputSchema),validate=validator.getValidator(schema);assert.equal(validate(row.input).valid,true,`${row.tool}: ${validate(row.input).errorMessage}`);for(const key of Object.keys(row.input)){if(key==='session')continue;const partial={...row.input};delete partial[key];assert.equal(validate(partial).valid,false,`${row.tool} must require guard input ${key}`);}}
});
test('P04i bootstrap regression: repository runner carries its sealed config and executable bindings',async t=>{
 const c=await selected(t,'copilot'),o=await setup.offerRepositoryController(c.session,{configFile:c.config,worker:0,reviewer:0,maxAgeSeconds:3600},c.seams);await setup.prepareRepositoryController(c.session,{offerHash:o.offerHash,approve:true},c.seams);/** @type {{env?:NodeJS.ProcessEnv}} */const captured={};
 await setup.runRepositoryController(c.session,{offerHash:o.offerHash,approve:true},{...c.seams,spawn:(_exe,_args,options)=>{captured.env=options.env;return {pid:888888,unref(){}};}});assert.ok(captured.env);const env=captured.env;assert.equal(env.ORCH_CONFIG,c.config);for(const name of ['COPILOT','CODEX','VIBE'])assert.equal(env['ORCH_'+name+'_EXE'],process.execPath);
 const saved=Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('ORCH_')));try{for(const k of Object.keys(process.env))if(k.startsWith('ORCH_'))delete process.env[k];for(const [k,v]of Object.entries(env))if(k.startsWith('ORCH_'))process.env[k]=v;assert.equal(setup.repositoryExecutionSpec(c.session,o.offerHash).p.offerHash,o.offerHash);}finally{for(const k of Object.keys(process.env))if(k.startsWith('ORCH_'))delete process.env[k];Object.assign(process.env,saved);}
});
for(const harness of ['copilot','muse'])test(`P04i: offline ${harness} full receipt checks code/review/processes and reuses without model calls`,async t=>{
 const c=await offlineRepository(t,harness),request={offerHash:c.o.offerHash};
 await assert.rejects(setup.qualifyRepositoryController(c.session,request,{...c.seams,processTable:async()=>null}),/process exit/);
 const profileFile=path.join(c.f.dir,'native-copilot.json'),profileBytes=fs.readFileSync(profileFile);fs.appendFileSync(profileFile,' ');
 await assert.rejects(setup.qualifyRepositoryController(c.session,request,c.seams),/profile changed/);fs.writeFileSync(profileFile,profileBytes);
 const receipt=await setup.qualifyRepositoryController(c.session,request,c.seams);assert.equal(receipt.status,'repository-controller-observed');assert.equal(receipt.verification.passed,true);assert.equal(receipt.review.defects,2);assert.equal(receipt.launchAllowed,false);assert.equal(receipt.activation,false);
 const again=await setup.qualifyRepositoryController(c.session,request,c.seams);assert.equal(again.replayed,true);assert.equal(again.providerCalls,0);
 assert.equal((await setup.repositoryControllerQualification(c.session,{configFile:c.config},c.seams)).routes.length,1);
 fs.writeFileSync(path.join(c.r.workdir,'stats.mjs'),'export function summarizeReadings(values) { return {}; }');await assert.rejects(setup.qualifyRepositoryController(c.session,request,c.seams),/checks failed/);
});

test('P04i: explicit abandonment retains source, refuses uncertain launches and prevents later launches',async t=>{
 const c=await selected(t,'muse'),o=await setup.offerRepositoryController(c.session,{configFile:c.config,worker:0,reviewer:0,maxAgeSeconds:3600},c.seams),request={offerHash:o.offerHash,approve:true},r=await setup.prepareRepositoryController(c.session,request,c.seams),original=fs.readFileSync(path.join(r.workdir,'AGENTS.md'));
 await assert.rejects(setup.closeRepositoryController(c.session,{offerHash:o.offerHash,approve:false},c.seams));
 const closed=await setup.closeRepositoryController(c.session,request,c.seams);assert.equal(closed.source,'intentionally-retained');assert.equal(closed.providerCalls,0);assert.deepEqual(fs.readFileSync(path.join(r.workdir,'AGENTS.md')),original);assert.equal((await setup.closeRepositoryController(c.session,request,c.seams)).replayed,true);await assert.rejects(setup.runRepositoryController(c.session,request,c.seams),/closed/);
 const d=await selected(t,'copilot'),other=await setup.offerRepositoryController(d.session,{configFile:d.config,worker:0,reviewer:0,maxAgeSeconds:3600},d.seams),next={offerHash:other.offerHash,approve:true};await setup.prepareRepositoryController(d.session,next,d.seams);await setup.runRepositoryController(d.session,next,{...d.seams,spawn:()=>({pid:999999,unref(){}})});await assert.rejects(setup.closeRepositoryController(d.session,next,d.seams),/outcome uncertain/);
});

test('P04i: definite tool refusals retain their exact response without being labelled unknown',async()=>{
 const p=plan(),journal=[],response={isError:true,structuredContent:{exit_code:3,output:{reason:'fixture-lane-busy'}},content:[{type:'text',text:'fixture-lane-busy'}]};
 await assert.rejects(api.invokeRepositoryTool(p,journal,'claim',{wp:p.wp,by:p.by},{persist:async row=>journal.push(row),dispatch:async()=>response}),{code:'repository-controller-refused'});
 assert.deepEqual(journal.map(r=>r.kind),['attempt','refusal']);assert.deepEqual(journal[1].response,response);assert.equal(journal[1].reason,'tool-returned-nonzero');
 assert.throws(()=>api.validateRepositoryRequest(p,journal,'claim',{wp:p.wp,by:p.by}));
});

test('P04i: explicit closure releases an owned claim after fixture/source drift, without rebinding a receipt',async t=>{
 const c=await selected(t,'muse'),o=await setup.offerRepositoryController(c.session,{configFile:c.config,worker:0,reviewer:0,maxAgeSeconds:3600},c.seams);await setup.prepareRepositoryController(c.session,{offerHash:o.offerHash,approve:true},c.seams);const {p,f,r}=setup.repositoryExecutionSpec(c.session,o.offerHash,c.seams);
 const claim=await callTool('claim',{wp:p.wp,by:'muse'},{stateRoot:p.smoke.stateRoot});assert.equal(claim.isError,false);
 fs.appendFileSync(path.join(r.workdir,'AGENTS.md'),'\nChanged fixture owner rule\n');
 const envelope=JSON.parse(fs.readFileSync(path.join(c.session,'repository-controller','offers',o.offerHash+'.json'),'utf8'));envelope.plan.contract['simulated-older-runtime.mjs']='0'.repeat(64);envelope.offerHash=crypto.createHash('sha256').update(JSON.stringify(envelope.plan)).digest('hex');write(path.join(c.session,'repository-controller','offers',envelope.offerHash+'.json'),envelope);
 const prepared=JSON.parse(fs.readFileSync(f.prepared,'utf8'));prepared.offerHash=envelope.offerHash;prepared.binding=crypto.createHash('sha256').update(JSON.stringify(envelope.plan.contract)).digest('hex');write(f.prepared,prepared);
 await assert.rejects(setup.qualifyRepositoryController(c.session,{offerHash:envelope.offerHash},c.seams),/source changed/);
 const runtimeBytes=fs.readFileSync(f.runtime);fs.appendFileSync(f.runtime,' ');await assert.rejects(setup.closeRepositoryController(c.session,{offerHash:envelope.offerHash,approve:true},c.seams),/runtime\/ownership changed/);fs.writeFileSync(f.runtime,runtimeBytes);
 const gitConfig=path.join(r.workdir,'.git','config'),gitBytes=fs.readFileSync(gitConfig);fs.appendFileSync(gitConfig,'\n');await assert.rejects(setup.closeRepositoryController(c.session,{offerHash:envelope.offerHash,approve:true},c.seams),/Git authority changed/);fs.writeFileSync(gitConfig,gitBytes);
 const closed=await setup.closeRepositoryController(c.session,{offerHash:envelope.offerHash,approve:true},{...c.seams,binding:()=>{throw Error('Closure must not require a current launch executable');}});
 assert.equal(closed.source,'intentionally-retained');assert.equal(closed.runtimeSourceChanged,true);assert.ok(closed.changedProtectedFiles.includes('AGENTS.md'));assert.equal(closed.launchAllowed,false);assert.equal((await callTool('claims',{}, {stateRoot:p.smoke.stateRoot})).structuredContent.output.claims.length,0);
 assert.equal((await setup.closeRepositoryController(c.session,{offerHash:envelope.offerHash,approve:true},c.seams)).replayed,true);
});

test('P04i: preflight-refused trial closes only after its exact runner incarnation stopped',async t=>{
 const c=await selected(t,'muse'),o=await setup.offerRepositoryController(c.session,{configFile:c.config,worker:0,reviewer:0,maxAgeSeconds:3600},c.seams),request={offerHash:o.offerHash,approve:true};await setup.prepareRepositoryController(c.session,request,c.seams);const {f}=setup.repositoryExecutionSpec(c.session,o.offerHash,c.seams);await setup.runRepositoryController(c.session,request,{...c.seams,spawn:()=>({pid:888888,unref(){}})});
 const createdAt='ms:'+Date.now();write(path.join(f.dir,'runner-error.json'),{offerHash:o.offerHash,runnerPid:888888,runnerCreatedAt:createdAt,stage:'subscription-auth',state:'preflight-refused',automaticRetries:0});
 await assert.rejects(setup.closeRepositoryController(c.session,request,{...c.seams,processTable:async()=>null}));
 await assert.rejects(setup.closeRepositoryController(c.session,request,{...c.seams,processTable:async()=>[{pid:888888,createdAt}]}));
 const closed=await setup.closeRepositoryController(c.session,request,{...c.seams,processTable:async()=>[]});assert.equal(closed.source,'intentionally-retained');assert.equal(closed.providerCalls,0);
});

test('P04i: concurrent ordinary reads serialize without a false native tool refusal',async t=>{
 const c=await selected(t,'muse'),o=await setup.offerRepositoryController(c.session,{configFile:c.config,worker:0,reviewer:0,maxAgeSeconds:3600},c.seams),request={offerHash:o.offerHash,approve:true};await setup.prepareRepositoryController(c.session,request,c.seams);await setup.runRepositoryController(c.session,request,{...c.seams,spawn:()=>({pid:888888,unref(){}})});
 const responses=await Promise.all([1,2].map(()=>setup.invokeRepositoryFromFile(c.session,o.offerHash,'repository_instructions',{}, {...c.seams,dispatch:async()=>{await new Promise(resolve=>setTimeout(resolve,75));return output({files:[]});}})));
 assert.equal(responses.length,2);assert.ok(responses.every(r=>r.isError===false));const {f}=setup.repositoryExecutionSpec(c.session,o.offerHash,c.seams),journal=fs.readdirSync(f.journal).sort().map(n=>JSON.parse(fs.readFileSync(path.join(f.journal,n),'utf8')));assert.deepEqual(journal.map(r=>r.kind),['attempt','result','attempt','result']);
});

test('P04i: closure with a missing birth still requires a reliable table proving that PID absent',async t=>{
 const c=await selected(t,'muse'),o=await setup.offerRepositoryController(c.session,{configFile:c.config,worker:0,reviewer:0,maxAgeSeconds:3600},c.seams),request={offerHash:o.offerHash,approve:true};await setup.prepareRepositoryController(c.session,request,c.seams);const {f}=setup.repositoryExecutionSpec(c.session,o.offerHash,c.seams);await setup.runRepositoryController(c.session,request,{...c.seams,spawn:()=>({pid:888888,unref(){}})});
 const createdAt=new Date().toISOString();write(path.join(f.dir,'launch.json'),{offerHash:o.offerHash,pid:999999,createdAt:null,runnerPid:888888,runnerCreatedAt:createdAt});write(path.join(f.dir,'exit.json'),{code:1,signal:null,endedAt:createdAt});
 await assert.rejects(setup.closeRepositoryController(c.session,request,{...c.seams,processTable:async()=>null}));await assert.rejects(setup.closeRepositoryController(c.session,request,{...c.seams,processTable:async()=>[{pid:999999,createdAt}]}));
 assert.equal((await setup.closeRepositoryController(c.session,request,{...c.seams,processTable:async()=>[]})).source,'intentionally-retained');
});

// Actual native SDK carriers: display text is not the structured result channel.
test('P04i live regression: Copilot uses complete structured results despite truncated or joined display text',()=>{
 const rows=[journalRow('claim','1'.repeat(32))];rows[0].response.content=[{type:'text',text:'display only'}];
 const events=nativeCopilot(rows),complete=events.find(e=>e.type==='tool.execution_complete');
 complete.data.result={content:'Output too large. Preview: {',structuredContent:rows[0].response.structuredContent};
 const options={harness:'copilot',model:'auto',offerHash:'a'.repeat(64),journal:rows};
 assert.equal(api.observeRepositoryTrace(events,options).calls.length,1);
 complete.data.result.content=JSON.stringify(rows[0].response)+'\n\n'+JSON.stringify(rows[0].response.structuredContent);
 assert.equal(api.observeRepositoryTrace(events,options).calls.length,1);
});
test('P04i live regression: present corrupt structured channel cannot fall back to valid display text',()=>{
 const rows=[journalRow('claim','1'.repeat(32))],options={harness:'copilot',model:'auto',offerHash:'a'.repeat(64),journal:rows};
 for(const bad of [null,{}, {...rows[0].response.structuredContent,exit_code:1},{...rows[0].response.structuredContent,output:{forged:true}},{...rows[0].response.structuredContent,repositoryProof:{offerHash:'a'.repeat(64),requestId:'2'.repeat(32)}}]){
  const events=nativeCopilot(rows);events.find(e=>e.type==='tool.execution_complete').data.result.structuredContent=bad;
  assert.throws(()=>api.observeRepositoryTrace(events,options));
 }
});
test('P04i live regression: native wire retains every structured field without duplicated display output',()=>{
 assert.equal(typeof api.repositoryNativeResult,'function');
 const row=journalRow('result','1'.repeat(32));row.response.structuredContent.output={stdout:'x'.repeat(49000),nested:{warning:'retain me'}};row.response.content=[{type:'text',text:JSON.stringify(row.response.structuredContent.output)}];
 const wire=api.repositoryNativeResult(row.response);assert.deepEqual(wire,{isError:false,structuredContent:row.response.structuredContent});
 assert.ok(Buffer.byteLength(JSON.stringify(wire))<50000);assert.ok(!Object.hasOwn(wire,'content'));assert.throws(()=>api.repositoryNativeResult({...row.response,isError:true}));
 const events=nativeCopilot([row]);events.find(e=>e.type==='tool.execution_complete').data.result.content=JSON.stringify(wire);
 assert.equal(api.observeRepositoryTrace(events,{harness:'copilot',model:'auto',offerHash:'a'.repeat(64),journal:[row]}).calls.length,1);
 const forged=structuredClone(wire);forged.structuredContent.output={forged:true};
 const fresh=journalRow('result','1'.repeat(32));const changed=nativeCopilot([fresh]);changed.find(e=>e.type==='tool.execution_complete').data.result.content=JSON.stringify(forged);
 assert.throws(()=>api.observeRepositoryTrace(changed,{harness:'copilot',model:'auto',offerHash:'a'.repeat(64),journal:[fresh]}));
});

test('P04i live regression: repository review packet carries exact worker bytes rather than detached baseline',()=>{
 assert.equal(typeof setup.buildRepositoryReviewPrompt,'function');const text=setup.buildRepositoryReviewPrompt(goodSource),hash=crypto.createHash('sha256').update(goodSource).digest('hex');
 assert.ok(text.includes(JSON.stringify({file:'stats.mjs',sourceHash:hash,source:goodSource})));assert.ok(text.includes('detached HEAD is only the baseline'));assert.throws(()=>setup.buildRepositoryReviewPrompt('import fs from "node:fs";'));
});
test('P04i live regression: dispatched review and receipt bind the actual implementation packet; changed packet refuses',async t=>{
 const c=await offlineRepository(t,'muse'),review=c.journal.find(x=>x.tool==='review').response.structuredContent.output,packet=path.join(c.f.dir,'reviewer-implementation.txt'),worker=fs.readFileSync(path.join(c.r.workdir,'stats.mjs'),'utf8');
 assert.equal(review.reviewPacket.sourceHash,crypto.createHash('sha256').update(worker).digest('hex'));assert.equal(fs.readFileSync(packet,'utf8'),setup.buildRepositoryReviewPrompt(worker));
 const good=fs.readFileSync(packet);fs.appendFileSync(packet,'changed');await assert.rejects(setup.qualifyRepositoryController(c.session,{offerHash:c.o.offerHash},c.seams),/review snapshot|terminal identity/);fs.writeFileSync(packet,good);
 assert.equal((await setup.qualifyRepositoryController(c.session,{offerHash:c.o.offerHash},c.seams)).status,'repository-controller-observed');
});

test('P04i live regression: safe non-finite numeric constants remain inside the pure helper case',async t=>{
 const c=makeCase('finite-constant-case');t.after(()=>c.cleanup());const source='export function summarizeReadings(values) { if (!(values instanceof Array)) throw new TypeError("array"); let count=0,min=null,max=null,total=0; for (const value of values) { if (typeof value!=="number" || value!==value || value===Infinity || value===-Infinity) throw new TypeError("finite"); count++; total+=value; min=min===null||value<min?value:min; max=max===null||value>max?value:max; } return {count,min,max,total}; }',file=path.join(c.base,'stats.mjs');fs.writeFileSync(file,source);const result=await verifyTaskImplementation(file);assert.equal(result.passed,true);assert.equal(result.checks,27);
});
test('P04i live regression: owned paths are server-bound and cannot be supplied or substituted',()=>{
 const p=plan(),journal=[{kind:'result',tool:'run',response:output({id:'owned-worker'})}],args={run:'owned-worker',ref:'HEAD',reviewer:p.reviewer.harness,model:p.reviewer.model,by:p.by};
 assert.equal(api.validateRepositoryRequest(p,journal,'review',args).mutating,true);
 const run={cli:p.worker.harness,model:p.worker.model,wp:p.wp,by:p.by,allow:p.allow};assert.equal(api.validateRepositoryRequest(p,[],'run',run).mutating,true);
 for(const [key,value] of [['dir',p.workdir],['handoff',p.workerPrompt]])assert.throws(()=>api.validateRepositoryRequest(p,[],'run',{...run,[key]:value}));
 assert.throws(()=>api.validateRepositoryRequest(p,journal,'review',{...args,prompt:p.reviewerPrompt}));
 for(const root of [p.reviewRoot,'foreign'])assert.throws(()=>api.validateRepositoryRequest(p,journal,'review',{...args,'review-root':root}));
 for(const [tool,keys] of [['review',['review-root','prompt']],['run',['dir','handoff']]])for(const key of keys)assert.ok(!Object.hasOwn(setup.repositoryToolList().find(x=>x.name===tool).inputSchema.properties,key));
});

test('P04i live regression: scoped status waits for actual progress and returns active work honestly at its bound',async t=>{
 const c=await selected(t,'muse'),o=await setup.offerRepositoryController(c.session,{configFile:c.config,worker:0,reviewer:0,maxAgeSeconds:3600},c.seams);await setup.prepareRepositoryController(c.session,{offerHash:o.offerHash,approve:true},c.seams);await setup.runRepositoryController(c.session,{offerHash:o.offerHash,approve:true},{...c.seams,spawn:()=>({pid:888888,unref(){}})});const {p}=setup.repositoryExecutionSpec(c.session,o.offerHash,c.seams),id='owned-active',file=path.join(p.smoke.stateRoot,'runs',id,'run.json'),raw={id,wp:p.wp,by:'muse',role:'implement',status:'running'};
 await setup.invokeRepositoryFromFile(c.session,o.offerHash,'run',{cli:'codex',model:'example-worker',wp:p.wp,by:'muse',allow:['stats.mjs']},{...c.seams,dispatch:async()=>{write(file,raw);return output({id});}});
 let changed=false;const timer=setTimeout(()=>{changed=true;write(file,{...raw,status:'completed'});},5);try{const result=await setup.invokeRepositoryFromFile(c.session,o.offerHash,'status',{id},{...c.seams,statusWaitMs:1000,dispatch:async()=>{assert.equal(changed,true,'Dispatch must follow actual progress, not a busy immediate poll');return output({status:JSON.parse(fs.readFileSync(file,'utf8')).status});}});assert.equal(result.structuredContent.output.status,'completed');}finally{clearTimeout(timer);}
 write(file,raw);const pending=await setup.invokeRepositoryFromFile(c.session,o.offerHash,'status',{id},{...c.seams,statusWaitMs:0,dispatch:async()=>output({status:JSON.parse(fs.readFileSync(file,'utf8')).status})});assert.equal(pending.structuredContent.output.status,'running');
});
