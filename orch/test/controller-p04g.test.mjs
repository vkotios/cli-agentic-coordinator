import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {additionalControllerProfile,additionalProfileFiles,controllerWorkdir} from '../src/controller-profiles.mjs';
import {assertClaimant} from '../src/claims.mjs';
import {startSetup,answerSetup} from '../src/setup.mjs';
import {previewSetup,applySetup} from '../src/setup-apply.mjs';
import {offerController,prepareController,runController,controllerNativeToolSpec,observeControllerTrace,controllerStep,qualifyController,controllerQualification} from '../src/setup-controller.mjs';
import {resourceFile} from '../src/resources.mjs';
import {rolePrompt} from '../src/role-packet.mjs';
import {aliasFor} from '../src/adapters/vibe.mjs';
import {runCommand,parseArgs} from '../src/cli.mjs';
import {makeCase} from './helpers.mjs';
import {makeRepo} from './wf-helpers.mjs';
/** @type {any} */ const subscription=await import('../src/controller-subscriptions.mjs').catch(()=>({}));
const marker='ORCH_CONTROLLER:nonce:claim',model='gpt-5.6-luna',tool='orch-controller_step';
const copilot=(out={step:'claim',marker})=>[
 {type:'model.call_start',data:{turnId:'t1',model}},
 {type:'model.call_finished',data:{turnId:'t1',outcome:'success'}},
 {type:'tool.execution_start',data:{toolCallId:'c1',toolName:tool,arguments:{step:'claim'},model}},
 {type:'tool.execution_complete',data:{toolCallId:'c1',success:true,result:{content:JSON.stringify(out)},model}},
 {type:'result',sessionId:'s',exitCode:0}
];
const muse=(out={step:'claim',marker})=>[
 {schema_version:1,payload_type:'run.model.configured',stream:{kind:'session',id:'s'},payload:{provider_id:'meta',model_id:'muse-spark-1.3',run_stream:{kind:'run',id:'r'}}},
 {schema_version:1,payload_type:'tool.result',stream:{kind:'session',id:'s'},payload:{call_id:'c1',run_stream:{kind:'run',id:'r'},text:JSON.stringify(out),correlation_facts:{tool_name:'mcp__orch__controller_step',outcome:'success'}}},
 {schema_version:1,payload_type:'run.terminal.completed',stream:{kind:'session',id:'s'},payload:{run_stream:{kind:'run',id:'r'},terminal:'completed'}}
];
test('P04g: subscription controllers get their own claimant identities without accepting arbitrary labels',()=>{
 for(const harness of ['copilot','muse']){assert.equal(assertClaimant(harness),harness);assert.equal(additionalControllerProfile({harness,billing:'subscription',model:harness==='copilot'?'auto':'muse-spark-1.3'}).commandPolicy,'fixed-owned-step-tool');for(const billing of ['api','local'])assert.throws(()=>additionalControllerProfile({harness,billing,model}));}
 assert.throws(()=>assertClaimant('Copilot'));
});
test('P04g: scoped MCP configurations bind only the fixed tool and preserve the child source directory',()=>{
 for(const harness of ['copilot','muse']){const dir=path.resolve('fixture','controller'),p={session:path.resolve('session'),offerHash:'a'.repeat(64),controller:{harness,model:harness==='copilot'?'auto':'muse-spark-1.3',billing:'subscription'},binding:{harness,exe:'controller.exe'},smoke:{workdir:path.resolve('child-source'),configFile:path.resolve('config.json'),bindings:[],roster:{}}};const workdir=controllerWorkdir(p,dir);assert.equal(workdir,path.join(dir,'workspace'));const files=additionalProfileFiles(p,dir,[],process.execPath,'guard','server');assert.equal(files.length,1);const cfg=JSON.parse(files[0].text);assert.deepEqual(Object.keys(cfg.mcpServers),['orch']);assert.deepEqual(cfg.mcpServers.orch.args,['server',p.session,p.offerHash]);assert.equal(cfg.mcpServers.orch.env.ORCH_CONFIG,p.smoke.configFile);assert.ok(!files.some(f=>f.file.startsWith(p.smoke.workdir)));}
});
test('P04g: Copilot native calls prove explicit/Auto observed models, never assistant prose',()=>{
 assert.equal(typeof subscription.observeSubscriptionControllerTrace,'function');const opt={harness:'copilot',model,markers:[marker]};
 assert.equal(subscription.observeSubscriptionControllerTrace(copilot(),opt).model,model);
 const automatic=subscription.observeSubscriptionControllerTrace(copilot(),{...opt,model:'auto'});assert.equal(automatic.accessKind,'automatic-access');assert.equal(automatic.model,model);
 for(const events of [copilot({step:'claim',marker,replayed:true}),copilot().map(e=>e.type==='tool.execution_start'?{...e,data:{...e.data,arguments:{step:'claim',command:'shell'}}}:e),copilot().map(e=>e.type==='tool.execution_start'?{...e,data:{...e.data,toolName:'shell'}}:e),copilot().map(e=>e.type==='result'?{...e,exitCode:1}:e),copilot().filter(e=>e.type!=='model.call_finished'),[...copilot().slice(0,-1),copilot()[3],copilot().at(-1)]])assert.throws(()=>subscription.observeSubscriptionControllerTrace(events,opt));
 assert.throws(()=>subscription.observeSubscriptionControllerTrace(copilot(),{...opt,model:'other'}));
 assert.throws(()=>observeControllerTrace(JSON.stringify({type:'assistant.message',data:{content:marker}}),opt));
});
test('P04g: Muse trace binds one session/run, native runtime model and successful fixed-tool results',()=>{
 assert.equal(typeof subscription.observeSubscriptionControllerTrace,'function');const opt={harness:'muse',model:'muse-spark-1.3',markers:[marker]};const proof=subscription.observeSubscriptionControllerTrace(muse(),opt);assert.equal(proof.model,opt.model);assert.equal(proof.source,'muse-runtime-model');
 for(const events of [muse({step:'claim',marker,replayed:true}),muse().map(e=>e.payload_type==='tool.result'?{...e,stream:{kind:'session',id:'foreign'}}:e),muse().map(e=>e.payload_type==='tool.result'?{...e,payload:{...e.payload,correlation_facts:{tool_name:'shell',outcome:'success'}}}:e),muse().map(e=>e.payload_type==='run.model.configured'?{...e,payload:{...e.payload,provider_id:'foreign'}}:e),muse().slice(0,-1),[...muse(),muse().at(-1)],[muse()[1],muse()[0],muse()[2]],[muse()[0],muse()[2],muse()[1]]])assert.throws(()=>subscription.observeSubscriptionControllerTrace(events,opt));
 assert.throws(()=>subscription.observeSubscriptionControllerTrace(muse(),{...opt,model:'other'}));
});
test('P04g: launch specs exclude APIs, reject inherited MCP/hooks and keep only approved tools',t=>{
 assert.equal(typeof subscription.subscriptionControllerSpec,'function');const fixture=makeCase('p04g-spec');t.after(()=>fixture.cleanup());const dir=fixture.base,workdir=path.join(dir,'workspace'),ctx={dir,workdir,instructions:path.join(dir,'instructions.txt')},env={USERPROFILE:dir,PATH:'path',GH_TOKEN:'unused',META_API_KEY:'unused',NODE_OPTIONS:'unused'};fs.writeFileSync(ctx.instructions,'Owned lifecycle steps only');
 const c=subscription.subscriptionControllerSpec({harness:'copilot',model:'auto'},ctx,env,{settings:{},mcp:{}});assert.ok(c.args.includes('orch-controller_step'));assert.equal(c.env.GH_TOKEN,undefined);assert.equal(c.env.NODE_OPTIONS,undefined);assert.equal(env.GH_TOKEN,'unused');assert.equal(c.authSource,'copilot-api-overrides-cleared');
 const m=subscription.subscriptionControllerSpec({harness:'muse',model:'muse-spark-1.3'},ctx,env,{settings:{},mcp:{}});assert.ok(m.args.includes('--disable-shell'));assert.ok(m.args.includes('--disable-write'));assert.equal(m.env.META_API_KEY,undefined);
 for(const bad of [{settings:{hooks:{}},mcp:{}},{settings:{mcpServers:{foreign:{command:'foreign'}}},mcp:{}},{settings:{},mcp:{mcpServers:{foreign:{command:'foreign'}}}}])assert.throws(()=>subscription.subscriptionControllerSpec({harness:'copilot',model},ctx,env,bad));
});
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('P04g review: foreign Muse tool attempts without results and missing run bindings refuse proof',()=>{
 const opt={harness:'muse',model:'muse-spark-1.3',markers:[marker]},proposal=kind=>({...muse()[1],payload_type:'task.lifecycle.proposed',payload:{run_stream:{kind:'run',id:'r'},event:{task_kind:kind}}});
 assert.equal(subscription.observeSubscriptionControllerTrace([muse()[0],proposal('tool.mcp__orch__controller_step'),...muse().slice(1)],opt).steps,1);
 for(const events of [[muse()[0],proposal('tool.shell'),...muse().slice(1)],[muse()[0],{...proposal('tool.shell'),payload_type:'tool.call'},...muse().slice(1)],muse().map(e=>e.payload_type==='run.model.configured'?{...e,payload:{...e.payload,run_stream:undefined}}:e),muse().map(e=>e.payload_type==='tool.result'?{...e,payload:{...e.payload,run_stream:undefined}}:e)])assert.throws(()=>subscription.observeSubscriptionControllerTrace(events,opt));
});
test('P04g review: launch specs keep stdin empty, bound prompts and refuse unknown inherited MCP shapes',t=>{
 const c=makeCase('p04g-reviewed-spec');t.after(()=>c.cleanup());const ctx={dir:c.base,workdir:c.base,instructions:path.join(c.base,'instructions.txt')},env={USERPROFILE:c.base,MUSE_TRANSPORT_TRACE:'1'},saved={settings:{},mcp:{}};fs.writeFileSync(ctx.instructions,'Owned lifecycle');
 for(const harness of ['copilot','muse']){const s=subscription.subscriptionControllerSpec({harness,model:harness==='copilot'?'auto':'muse-spark-1.3'},ctx,env,saved);assert.equal(fs.readFileSync(s.stdinFile,'utf8'),'');if(harness==='muse')assert.equal(s.env.MUSE_TRANSPORT_TRACE,undefined);}
 for(const mcp of [{mcp_servers:{foreign:{command:'foreign'}}},{servers:{foreign:{command:'foreign'}}}])assert.throws(()=>subscription.subscriptionControllerSpec({harness:'copilot',model:'auto'},ctx,env,{settings:{},mcp}));
 for(const prompt of ['x'.repeat(12001),'bad\0prompt']){fs.writeFileSync(ctx.instructions,prompt);assert.throws(()=>subscription.subscriptionControllerSpec({harness:'copilot',model:'auto'},ctx,env,saved));}
});
test('P04g review: malformed and oversized inherited JSON get classified refusals',t=>{
 const c=makeCase('p04g-reviewed-config');t.after(()=>c.cleanup());const env={USERPROFILE:c.base,COPILOT_HOME:c.base},ctx={dir:c.base,workdir:c.base,instructions:path.join(c.base,'instructions.txt')};fs.writeFileSync(ctx.instructions,'Owned lifecycle');
 for(const text of ['{bad',' '.repeat(1048577)]){fs.writeFileSync(path.join(c.base,'config.json'),text);assert.throws(()=>subscription.subscriptionControllerSpec({harness:'copilot',model:'auto'},ctx,env),e=>e instanceof Error&&'code' in e&&e.code==='controller-qualification-refused');}
});
test('P04g review: controller selector aliases refuse before an offer can consume a native launch',async t=>{
 await assert.rejects(prepared(t,'muse','auto'),/exact model selector/i);await assert.rejects(prepared(t,'copilot','gpt'),/exact model selector/i);
});
test('P04g live repair: commented Copilot legacy state is readable while current settings hooks still refuse',t=>{
 const c=makeCase('p04g-config-locations');t.after(()=>c.cleanup());const ctx={dir:c.base,workdir:c.base,instructions:path.join(c.base,'instructions.txt')},env={USERPROFILE:c.base,COPILOT_HOME:c.base};fs.writeFileSync(ctx.instructions,'Owned lifecycle');
 fs.writeFileSync(path.join(c.base,'config.json'),'// Automatically managed legacy state\n{"trustedFolders":[],"note":"https://example.invalid/a//b"}\n');
 fs.writeFileSync(path.join(c.base,'settings.json'),'/* User settings */\n{"model":"auto"}');assert.equal(subscription.subscriptionControllerSpec({harness:'copilot',model:'auto'},ctx,env).authSource,'copilot-api-overrides-cleared');
 for(const text of ['// Native hooks\n{"hooks":{"PreToolUse":[]}}','{"note":"/* not a comment */", "mcpServers":{"foreign":{}}}','/* unfinished']){fs.writeFileSync(path.join(c.base,'settings.json'),text);assert.throws(()=>subscription.subscriptionControllerSpec({harness:'copilot',model:'auto'},ctx,env));}
});
test('P04g live repair: subscription MCP children receive home-location metadata without credentials',()=>{
 const dir=path.resolve('fixture','controller'),p={session:path.resolve('session'),offerHash:'a'.repeat(64),controller:{harness:'muse',model:'muse-spark-1.3',billing:'subscription'},binding:{harness:'muse',exe:'controller.exe'},smoke:{workdir:path.resolve('source'),configFile:path.resolve('config.json'),bindings:[],roster:{}}};
 const cfg=JSON.parse(additionalProfileFiles(p,dir,[],process.execPath,'guard','server')[0].text),env=cfg.mcpServers.orch.env;
 assert.ok(path.isAbsolute(env.HOME));if(process.platform==='win32')assert.equal(env.USERPROFILE,env.HOME);assert.ok(path.isAbsolute(env.VIBE_HOME));assert.ok(path.isAbsolute(env.XDG_CONFIG_HOME));assert.ok(!Object.keys(env).some(k=>/(?:TOKEN|API_KEY|SECRET)/i.test(k)));
});
async function prepared(t,harness,selectedModel){
 const c=makeCase('p04g-'+harness);t.after(()=>c.cleanup());const repo=path.join(c.base,'repo');makeRepo(repo,{'AGENTS.md':'Owner instructions stay unchanged\n'});const session=path.join(c.base,'session'),config=path.join(c.base,'config.json'),route=(h,m)=>({harness:h,model:m,billing:'subscription',permission:'ask'}),controller=route(harness,selectedModel??(harness==='copilot'?'auto':'muse-spark-1.3'));
 let s=await startSetup({repo,harness,session,roster:undefined,catalog:undefined});for(const answer of [{controller,workers:[route('codex','example-worker')],reviewers:[route('vibe','example-reviewer')]},{mode:'deterministic'},{enabled:false},{stateRoot:c.stateRoot,reviewRoot:path.join(c.base,'packages'),cleanup:'retain-unmerged'},{enabled:false}])s=await answerSetup(session,{expectedRevision:s.revision,questionId:s.nextQuestion.id,answer});
 const v=await previewSetup(session,{configFile:config,adopt:false,update:false});await applySetup(session,{previewHash:v.previewHash,approve:true});const raw=JSON.parse(fs.readFileSync(config,'utf8'));raw.exe={copilot:process.execPath,muse:process.execPath,codex:process.execPath,vibe:process.execPath};fs.writeFileSync(config,JSON.stringify(raw));const seams={binding:h=>({harness:h,exe:process.execPath,target:fs.realpathSync.native(process.execPath),sha256:sha(fs.readFileSync(process.execPath))})};const o=await offerController(session,{configFile:config,worker:0,reviewer:0,maxAgeSeconds:3600},seams),p=await prepareController(session,{offerHash:o.offerHash,approve:true},seams);return {...c,session,config,o,p,seams};
}
test('P04g: offers and preparations bind subscription routes, scoped profile bytes and explicit one-shot launch approval',async t=>{
 for(const harness of ['copilot','muse']){const c=await prepared(t,harness);assert.equal(c.o.controller.harness,harness);assert.equal(c.o.activation,false);assert.equal(c.o.providerCalls,0);assert.equal(c.p.profileFiles.length,2);assert.notEqual(c.p.workdir,c.o.workdir);assert.ok(fs.existsSync(path.join(c.p.workdir,'AGENTS.md')));assert.equal(fs.readFileSync(path.join(c.base,'repo','AGENTS.md'),'utf8'),'Owner instructions stay unchanged\n');await assert.rejects(runController(c.session,{offerHash:c.o.offerHash,approve:false},c.seams));await runController(c.session,{offerHash:c.o.offerHash,approve:true},{...c.seams,spawn:()=>({pid:999999,unref(){}})});assert.equal(controllerNativeToolSpec(c.session,c.o.offerHash,c.seams).plan.controller.harness,harness);await assert.rejects(runController(c.session,{offerHash:c.o.offerHash,approve:true},c.seams));fs.appendFileSync(c.p.profileFiles[0].file,' ');await assert.rejects(prepareController(c.session,{offerHash:c.o.offerHash,approve:true},c.seams));}
});

const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
async function completeSubscription(t,harness){
  const c=await prepared(t,harness),{o,p}=c,binding=c.seams.binding,dir=path.dirname(p.instructions),state=path.join(path.dirname(dir),'state'),started=new Date().toISOString();
  const seams={binding,processTable:async()=>[],command:async(plan,args)=>{
    if(args[0]==='status')return {status:'completed'};
    if(args[0]==='review'){const rvFile=path.join(state,'reviews','controller-review.json'),rv=JSON.parse(fs.readFileSync(rvFile,'utf8'));Object.assign(rv,{finished_at:new Date().toISOString(),outcome:'reviewed',containment:'clean'});write(rvFile,rv);write(resourceFile({stateRoot:state},rv.id),{id:rv.id,kind:'review',review_id:rv.id,wp:plan.wp,by:plan.by,state:'removed',removed_at:new Date().toISOString(),path:rv.worktree,root:plan.smoke.reviewRoot,repo:plan.smoke.workdir});return {outcome:'reviewed'};}
    const prior=process.env.ORCH_CONFIG;process.env.ORCH_CONFIG=path.join(path.dirname(dir),'runtime.json');try{return await runCommand(args[0],parseArgs([...args.slice(1),'--state-root',state,'--json']),{log(){}});}finally{if(prior===undefined)delete process.env.ORCH_CONFIG;else process.env.ORCH_CONFIG=prior;}
  },launch:async ctx=>{
    const role=ctx.role,id='controller-'+role+'-proof',now=new Date().toISOString(),runDir=path.join(state,'runs',id),workdir=role==='worker'?ctx.workdir:path.join(ctx.plan.reviewRoot,'controller-review');fs.mkdirSync(runDir,{recursive:true});
    write(path.join(runDir,'run.json'),{id,cli:ctx.route.harness,role:role==='worker'?'implement':'review',wp:ctx.wp,by:ctx.by,slice:'controller-smoke',model_requested:ctx.route.model,model_actual:ctx.route.model,model_actual_alias:ctx.route.harness==='vibe'?aliasFor(ctx.route.model):null,model_mismatch:false,status:'completed',exit_code:0,started_at:now,ended_at:now,dir:workdir,dir_real:workdir,...(role==='reviewer'?{review_of:ctx.workerId,review_id:'controller-review'}:{}),escaped_helpers:[],handoff_source:ctx.prompt,handoff_sha256:sha(fs.readFileSync(ctx.prompt)),launch:{exe:ctx.binding.exe},role_packet:rolePrompt(Buffer.alloc(0),role==='worker'?'implement':'review').provenance});
    fs.writeFileSync(path.join(runDir,'stdout.log'),JSON.stringify(role==='worker'?{type:'item.completed',item:{type:'agent_message',text:`ORCH_QUALIFICATION:${ctx.challenge}:worker`}}:{type:'message',role:'assistant',content:[{type:'text',text:`ORCH_QUALIFICATION:${ctx.challenge}:reviewer`} ]})+'\n');fs.writeFileSync(path.join(runDir,'stderr.log'),'');fs.writeFileSync(path.join(runDir,'keeper.ndjson'),[{event:'spawned',worker_pid:1,at:now},{event:'worker-exit',code:0,at:now},{event:'keeper-exit',write_failures:0,at:now}].map(x=>JSON.stringify(x)).join('\n')+'\n');
    if(role==='reviewer')write(path.join(state,'reviews','controller-review.json'),{id:'controller-review',run_id:id,implementer_run:ctx.workerId,wp:ctx.wp,by:ctx.by,worktree:workdir,source_repo:ctx.workdir,review_root:ctx.plan.reviewRoot,reviewer_cli:ctx.route.harness,reviewer_model:ctx.route.model});
    return {run_id:id,...(role==='reviewer'?{review_id:'controller-review'}:{})};
  }};

  const rows=[];for(const step of p.steps)rows.push(await controllerStep(c.session,{offerHash:o.offerHash,approve:true,step},seams));
  const ended=new Date().toISOString(),startedMs=Date.parse(started),endedMs=Date.parse(ended);
  write(path.join(dir,'launch-attempt.json'),{offerHash:o.offerHash,approve:true,at:started,runnerHash:sha(fs.readFileSync(new URL('../src/controller-native.mjs',import.meta.url)))});
  write(path.join(dir,'runner-started.json'),{offerHash:o.offerHash,runnerPid:888888});
  write(path.join(dir,'launch.json'),{offerHash:o.offerHash,exe:process.execPath,pid:999999,createdAt:started,runnerPid:888888,runnerCreatedAt:started,workdir:p.workdir,profile:p.profile,instructionsHash:p.instructionsHash,authSource:harness==='copilot'?'copilot-api-overrides-cleared':'muse-device-subscription',apiOverridesRemoved:true,intervened:false,startedAt:started});write(path.join(dir,'exit.json'),{code:0,signal:null,endedAt:ended});
  const serverFile=path.join(dir,'native-tool-servers','888887-'+('a'.repeat(32))+'.json');write(serverFile,{offerHash:o.offerHash,pid:888887,createdAt:started,startedAt:started});
  const nativeModel=harness==='copilot'?model:'muse-spark-1.3';
  /** @type {any[]} */ const trace=harness==='copilot'?[{type:'model.call_start',data:{turnId:'native-turn',model:nativeModel}},{type:'model.call_finished',data:{turnId:'native-turn',outcome:'success'}},...rows.flatMap((r,i)=>[{type:'tool.execution_start',data:{toolCallId:'step-'+i,toolName:'orch-controller_step',arguments:{step:r.step},model:nativeModel}},{type:'tool.execution_complete',data:{toolCallId:'step-'+i,success:true,result:{content:JSON.stringify(r)}}}]),{type:'result',sessionId:'native-session',exitCode:0}]:[{schema_version:1,payload_type:'run.model.configured',stream:{kind:'session',id:'native-session'},payload:{provider_id:'meta',model_id:nativeModel,run_stream:{id:'native-run'}}},...rows.map((r,i)=>({schema_version:1,payload_type:'tool.result',stream:{kind:'session',id:'native-session'},payload:{call_id:'step-'+i,run_stream:{id:'native-run'},text:JSON.stringify(r),correlation_facts:{tool_name:'mcp__orch__controller_step',outcome:'success'}}})),{schema_version:1,payload_type:'run.terminal.completed',stream:{kind:'session',id:'native-session'},payload:{run_stream:{id:'native-run'},terminal:'completed'}}];
  fs.writeFileSync(path.join(dir,'stdout.jsonl'),trace.map(x=>JSON.stringify(x)).join('\n'));fs.writeFileSync(path.join(dir,'stderr.txt'),'');fs.writeFileSync(path.join(dir,'native-tool-events.ndjson'),rows.map(r=>JSON.stringify({step:r.step,marker:r.marker,pending:false,replayed:false})).join('\n'));
  return {...c,dir,seams,serverFile,started};
}

for(const harness of ['copilot','muse'])test(`P04g: offline ${harness} full receipt refuses live/unknown helpers, tampered audits and source drift; reuse makes zero calls`,async t=>{
 const c=await completeSubscription(t,harness),request={offerHash:c.o.offerHash};
 await assert.rejects(qualifyController(c.session,request,{...c.seams,processTable:async()=>null}),/process exit/);
 await assert.rejects(qualifyController(c.session,request,{...c.seams,processTable:async()=>[{pid:888887,createdAt:'ms:'+Date.parse(c.started)}]}),/process exit/);
 const auditFile=path.join(c.dir,'native-tool-events.ndjson'),original=fs.readFileSync(auditFile);fs.writeFileSync(auditFile,'');await assert.rejects(qualifyController(c.session,request,c.seams),/execution audit/);fs.writeFileSync(auditFile,original);
 const receipt=await qualifyController(c.session,request,c.seams);assert.equal(receipt.status,'controller-observed');assert.equal(receipt.controller.harness,harness);assert.equal(receipt.controller.observedModel,harness==='copilot'?model:'muse-spark-1.3');assert.equal(receipt.controller.model,harness==='copilot'?'auto':'muse-spark-1.3');assert.equal(receipt.launchAllowed,false);assert.equal(receipt.cleanup.review,'removed');if(harness==='copilot')assert.equal(receipt.controller.accessKind,'automatic-access');
 const reused=await qualifyController(c.session,request,{...c.seams,launch:()=>{throw Error('Reuse must not launch');},command:()=>{throw Error('Reuse must not execute');}});assert.equal(reused.replayed,true);assert.equal(reused.providerCalls,0);
 const listed=await controllerQualification(c.session,{configFile:c.config},c.seams);assert.equal(listed.routes.length,1);assert.equal(listed.routes[0].observedModel,receipt.controller.observedModel);assert.equal(listed.launchAllowed,false);
 const nativeProfile=c.p.profileFiles[0].file;fs.appendFileSync(nativeProfile,' ');await assert.rejects(qualifyController(c.session,request,c.seams),/configuration changed/);assert.equal((await controllerQualification(c.session,{configFile:c.config},c.seams)).status,'unavailable');
});
