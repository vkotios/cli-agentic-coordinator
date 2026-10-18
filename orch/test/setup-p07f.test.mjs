import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {makeCase} from './helpers.mjs';
import {makeRepo} from './wf-helpers.mjs';
import {startSetup,answerSetup} from '../src/setup.mjs';
import {previewSetup,applySetup} from '../src/setup-apply.mjs';
import {offerController,prepareController,runController} from '../src/setup-controller.mjs';
import {controllerToolDefinition,invokeControllerTool} from '../src/controller-tool-server.mjs';
import * as native from '../src/controller-native.mjs';
import * as api from '../src/setup-controller.mjs';
import {rolePrompt} from '../src/role-packet.mjs';
import {resourceFile} from '../src/resources.mjs';
import {aliasFor} from '../src/adapters/vibe.mjs';
import {parseArgs,runCommand} from '../src/cli.mjs';
import {OrchError} from '../src/errors.mjs';
/** @type {any} */ const profiles=await import('../src/controller-profiles.mjs').catch(()=>({}));
const command='node "kit/orch.mjs" setup controller-step --session "session" --request "request-claim.json" --json';
const marker='ORCH_CONTROLLER:nonce:claim';
test('P07f: new native profiles explicitly separate Vibe subscriptions and OpenCode local billing',()=>{
  assert.equal(typeof profiles.additionalControllerProfile,'function');
  assert.equal(profiles.additionalControllerProfile({harness:'vibe',billing:'subscription'}).commandPolicy,'fixed-owned-step-tool');
  assert.equal(profiles.additionalControllerProfile({harness:'opencode',billing:'local'}).commandPolicy,'fixed-owned-step-tool');
  for(const r of [{harness:'vibe',billing:'api'},{harness:'opencode',billing:'api'},{harness:'opencode',billing:'subscription'},{harness:'vibe/../../foreign',billing:'subscription'}])assert.throws(()=>profiles.additionalControllerProfile(r));
});
test('P07f: local provider configuration cannot carry credentials or target a public paid endpoint',()=>{
  assert.equal(typeof profiles.validateControllerLocalProvider,'function');const r={harness:'opencode',model:'local/example',billing:'local'},p={id:'local',baseURL:'http://127.0.0.1:1234/v1',context:16384,output:4096};
  assert.deepEqual(profiles.validateControllerLocalProvider(r,p),p);
  assert.deepEqual(profiles.validateControllerLocalProvider(r,{...p,baseURL:'http://[::1]:1234/v1'}),{...p,baseURL:'http://[::1]:1234/v1'});
  for(const bad of [{...p,apiKey:'credential'},{...p,baseURL:'https://api.example.com/v1'},{...p,baseURL:'http://10.public.example/v1'},{...p,baseURL:'http://secret@127.0.0.1/v1'},{...p,baseURL:'http://[::1]:1234/v1?key=secret'},{...p,baseURL:'http://[::1]:1234/v1#secret'},{...p,baseURL:'http://[::ffff:127.0.0.1]:1234/v1'},{...p,id:'other'},null])assert.throws(()=>profiles.validateControllerLocalProvider(r,bad));
});

const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function prepared(t,harness,withAuthentication=false){
  const c=makeCase('p07f-'+harness);t.after(()=>c.cleanup());const repo=path.join(c.base,'repo');makeRepo(repo,{'AGENTS.md':'Preserve existing instructions\n'});const session=path.join(c.base,'session'),config=path.join(c.base,'config.json'),route=(h,model,billing='subscription')=>({harness:h,model,billing,permission:'ask'}),controller=route(harness,harness==='vibe'?'example-controller':'local/example',harness==='vibe'?'subscription':'local');
  let s=await startSetup({repo,harness,session,roster:undefined,catalog:undefined});for(const answer of [{controller,workers:[route('codex','example-worker')],reviewers:[route('vibe','example-reviewer')]},{mode:'deterministic'},{enabled:false},{stateRoot:c.stateRoot,reviewRoot:path.join(c.base,'packages'),cleanup:'retain-unmerged'},{enabled:false}])s=await answerSetup(session,{expectedRevision:s.revision,questionId:s.nextQuestion.id,answer});
  const v=await previewSetup(session,{configFile:config,adopt:false,update:false});await applySetup(session,{previewHash:v.previewHash,approve:true});const raw=JSON.parse(fs.readFileSync(config,'utf8'));raw.exe={vibe:process.execPath,codex:process.execPath,opencode:process.execPath};if(harness==='opencode')raw.controllerLocalProvider={id:'local',baseURL:'http://127.0.0.1:1234/v1',context:16384,output:4096};fs.writeFileSync(config,JSON.stringify(raw));
  const authenticationFile=path.join(c.base,'local-auth.json');if(withAuthentication){fs.writeFileSync(authenticationFile,JSON.stringify({local:{type:'api',key:'synthetic-local-token'}}));raw.controllerLocalAuthentication={file:authenticationFile};fs.writeFileSync(config,JSON.stringify(raw));}
  const seams={binding:h=>({harness:h,exe:process.execPath,target:fs.realpathSync.native(process.execPath),sha256:hash(fs.readFileSync(process.execPath))})},o=await offerController(session,{configFile:config,worker:0,reviewer:0,maxAgeSeconds:3600},seams),p=await prepareController(session,{offerHash:o.offerHash,approve:true},seams);return {...c,session,config,o,p,seams,authenticationFile};
}
function localAuthenticationCase(t){const c=makeCase('local-auth');t.after(()=>c.cleanup());const file=path.join(c.base,'auth.json');fs.writeFileSync(file,JSON.stringify({local:{type:'api',key:'synthetic-local-token'},other:{type:'api',key:'synthetic-other-token'}}));return {file,route:{harness:'opencode',model:'local/example',billing:'local'},provider:{id:'local',baseURL:'http://127.0.0.1:1234/v1',context:16384,output:4096}};}
test('P07f local auth: selected saved credentials are fingerprinted without retaining secret bytes',t=>{
  const c=localAuthenticationCase(t),binding=profiles.controllerLocalAuthentication(c.route,{file:c.file});assert.equal(binding.provider,'local');assert.equal(binding.file,c.file);assert.match(binding.sha256,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(binding).includes('synthetic'));
  const raw=JSON.parse(fs.readFileSync(c.file,'utf8'));raw.other.key='changed-unrelated';fs.writeFileSync(c.file,JSON.stringify(raw));assert.equal(profiles.controllerLocalAuthentication(c.route,{file:c.file}).sha256,binding.sha256);raw.local.key='changed-selected';fs.writeFileSync(c.file,JSON.stringify(raw));assert.notEqual(profiles.controllerLocalAuthentication(c.route,{file:c.file}).sha256,binding.sha256);
});
test('P07f local auth: unknown, OAuth, relative and inline credential sources refuse',t=>{
  const c=localAuthenticationCase(t);for(const source of [{file:c.file,key:'inline'},{file:'relative.json'},{file:c.file,provider:'other'}])assert.throws(()=>profiles.controllerLocalAuthentication(c.route,source));
  for(const raw of [{local:{type:'oauth',access:'synthetic'}},{other:{type:'api',key:'synthetic'}}]){fs.writeFileSync(c.file,JSON.stringify(raw));assert.throws(()=>profiles.controllerLocalAuthentication(c.route,{file:c.file}));}
});
test('P07f local auth: isolated memory-only key binding refuses rotation and public endpoints',t=>{
  const c=localAuthenticationCase(t),p={controller:c.route,localProvider:c.provider,localAuthentication:profiles.controllerLocalAuthentication(c.route,{file:c.file})},original={KEEP:'yes'},env=profiles.controllerLocalEnvironment(p,original);
  assert.equal(env.ORCH_CONTROLLER_LOCAL_KEY,'synthetic-local-token');assert.equal(original.ORCH_CONTROLLER_LOCAL_KEY,undefined);assert.equal(env.KEEP,'yes');assert.throws(()=>profiles.controllerLocalEnvironment({...p,localProvider:{...c.provider,baseURL:'https://api.example.com/v1'}},original));fs.writeFileSync(c.file,JSON.stringify({local:{type:'api',key:'changed'}}));assert.throws(()=>profiles.controllerLocalEnvironment(p,original));
});
test('P07f local auth: prepared native settings reference only the scoped environment key',async t=>{
  const c=await prepared(t,'opencode',true),nativeText=fs.readFileSync(c.p.profileFiles[0].file,'utf8'),doc=JSON.parse(nativeText),saved=fs.readFileSync(path.join(c.session,'controller-qualification','offers',c.o.offerHash+'.json'),'utf8');assert.equal(doc.provider.local.options.apiKey,'{env:ORCH_CONTROLLER_LOCAL_KEY}');assert.equal(doc.permission['*'],'deny');assert.deepEqual(doc.provider.local.env,[]);assert.ok(!nativeText.includes('synthetic-local-token'));assert.ok(!saved.includes('synthetic-local-token'));assert.equal(JSON.parse(saved).plan.localAuthentication.provider,'local');
});
test('P07f local auth: changed saved authentication cannot consume a native attempt',async t=>{
  const c=await prepared(t,'opencode',true);fs.writeFileSync(c.authenticationFile,JSON.stringify({local:{type:'api',key:'changed'}}));await assert.rejects(runController(c.session,{offerHash:c.o.offerHash,approve:true},c.seams),/binding changed/);assert.equal(fs.existsSync(path.join(path.dirname(c.p.instructions),'launch-attempt.json')),false);
});
test('P07f bootstrap regression: fixed controller runner revalidates its sealed private executable selection',async t=>{
 const c=await prepared(t,'opencode',true);/** @type {{env?:NodeJS.ProcessEnv}} */const captured={};await runController(c.session,{offerHash:c.o.offerHash,approve:true},{...c.seams,spawn:(_exe,_args,options)=>{captured.env=options.env;return {pid:888888,unref(){}};}});assert.ok(captured.env);const env=captured.env;assert.equal(env.ORCH_CONFIG,c.config);for(const name of ['OPENCODE','CODEX','VIBE'])assert.equal(env['ORCH_'+name+'_EXE'],process.execPath);
 const saved=Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('ORCH_')));try{for(const k of Object.keys(process.env))if(k.startsWith('ORCH_'))delete process.env[k];for(const [k,v]of Object.entries(env))if(k.startsWith('ORCH_'))process.env[k]=v;assert.equal(api.controllerExecutionSpec(c.session,c.o.offerHash).plan.offerHash,c.o.offerHash);}finally{for(const k of Object.keys(process.env))if(k.startsWith('ORCH_'))delete process.env[k];Object.assign(process.env,saved);}
});
test('P07f: new preparations hash-bind scoped native configs without changing child source or owner instructions',async t=>{
  for(const harness of ['vibe','opencode']){const c=await prepared(t,harness);assert.equal(c.p.profile.version,4);assert.ok(c.p.profileFiles.length);assert.notEqual(c.p.workdir,c.o.workdir);assert.equal(c.p.providerCalls,0);fs.appendFileSync(c.p.profileFiles[0].file,' ');await assert.rejects(prepareController(c.session,{offerHash:c.o.offerHash,approve:true},c.seams));}
});
test('P07f: scoped native tool accepts only fixed steps and rejects arbitrary commands or extra authority',async t=>{
  assert.equal(controllerToolDefinition.name,'controller_step');assert.equal(controllerToolDefinition.inputSchema.additionalProperties,false);assert.equal(controllerToolDefinition.inputSchema.properties.step.enum.length,8);const c=await prepared(t,'vibe');
  for(const args of [{step:'claim',command:'node arbitrary.js'},{step:'shell'},{step:'claim',session:c.session},{step:'claim',approve:true}])await assert.rejects(invokeControllerTool(c.session,c.o.offerHash,args,c.seams));
  await assert.rejects(invokeControllerTool(c.session,c.o.offerHash,{step:'claim'},c.seams));
});
test('P07f: real scoped MCP server exposes one tool and performs a bound local claim without model calls',async t=>{
  const c=await prepared(t,'vibe');await runController(c.session,{offerHash:c.o.offerHash,approve:true},{...c.seams,spawn:()=>({pid:999999,unref(){}})});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/controller-tool-server.mjs',import.meta.url)),c.session,c.o.offerHash],env:{...process.env,ORCH_CONFIG:c.config},stderr:'pipe'}),client=new Client({name:'controller-test',version:'1.0.0'});t.after(async()=>client.close());await client.connect(transport);
  const list=await client.listTools();assert.deepEqual(list.tools.map(x=>x.name),['controller_step']);assert.equal((await client.callTool({name:'controller_step',arguments:{step:'shell'}})).isError,true);
  const result=await client.callTool({name:'controller_step',arguments:{step:'claim'}});assert.equal(result.isError,undefined);assert.match(JSON.stringify(result),/ORCH_CONTROLLER:/);const audit=fs.readFileSync(path.join(path.dirname(c.p.instructions),'native-tool-events.ndjson'),'utf8');assert.match(audit,/"step":"claim"/);await client.close();
  const secondTransport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/controller-tool-server.mjs',import.meta.url)),c.session,c.o.offerHash],env:{...process.env,ORCH_CONFIG:c.config},stderr:'pipe'}),second=new Client({name:'controller-reconnect-test',version:'1.0.0'});t.after(async()=>second.close());await second.connect(secondTransport);assert.deepEqual((await second.listTools()).tools.map(x=>x.name),['controller_step']);await second.close();
});
test('P07f: Vibe proof binds native MCP effects, one session, fixed steps and unique tool IDs',()=>{
  const event={id:'effect-call-1',sessionId:'s',type:'effect',generationStatus:'completed',detail:{kind:'tool',toolName:'mcp.orch.controller_step',input:{step:'claim'}},state:{status:'completed',output:{content:[{type:'text',text:JSON.stringify({marker})}]}}};
  const options={harness:'vibe',model:'example',nativeModel:'example',markers:[marker],policyCommands:[command],sessionId:'s'},end={type:'message',role:'assistant',sessionId:'s',generationStatus:'completed'};
  assert.equal(profiles.observeAdditionalControllerTrace([event,end],options).steps,1);
  for(const e of [{...event,sessionId:'other'},{...event,state:{status:'failed'}},{...event,detail:{...event.detail,input:{step:'shell'}}},{...event,state:{...event.state,output:{content:[{type:'text',text:JSON.stringify({marker,replayed:true})}]}}}])assert.throws(()=>profiles.observeAdditionalControllerTrace([e,end],options));
  assert.throws(()=>profiles.observeAdditionalControllerTrace([event,end],{...options,nativeModel:'other'}));
});
test('P07f: OpenCode actual assistant export must match the native stream session, model, directory and time',()=>{
  assert.equal(typeof profiles.openCodeExportModel,'function');const info={id:'s',directory:'C:/fixture',time:{created:100}},assistant={role:'assistant',sessionID:'s',modelID:'example',providerID:'local',path:{cwd:'C:/fixture'},time:{created:120,completed:140},finish:'stop'};
  const doc={info,messages:[{info:assistant,parts:[]}]},expected={sessionId:'s',workdir:'C:/fixture',model:'local/example',started:90,ended:150};
  assert.equal(profiles.openCodeExportModel(doc,expected),'local/example');
  for(const bad of [{...doc,info:{...info,id:'other'}},{...doc,messages:[{info:{...assistant,providerID:'other'},parts:[]}]},{...doc,messages:[{info:{...assistant,path:{cwd:'C:/foreign'}},parts:[]}]}])assert.throws(()=>profiles.openCodeExportModel(bad,expected));
});
test('P07f: post-completion export failure never reports that the controller was not launched',()=>{
  assert.equal(typeof native.controllerFailureState,'function');assert.deepEqual(native.controllerFailureState('native-export'),{state:'uncertain',controllerLaunchAttempted:true});assert.deepEqual(native.controllerFailureState('subscription-auth'),{state:'preflight-refused',controllerLaunchAttempted:false});
});

test('P07f: missing native evidence directories refuse qualification with a clear diagnostic',t=>{
  const c=makeCase('p07f-missing-evidence');t.after(()=>c.cleanup());assert.throws(()=>api.controllerEvidenceNames(path.join(c.base,'missing'),'Native tool connection journal'),e=>e instanceof OrchError&&e.code==='controller-qualification-refused'&&e.message==='Native tool connection journal is unavailable');
});

test('P07f: OpenCode MCP effects require ordered distinct steps, one native session and terminal success',()=>{
  const markers=['ORCH_CONTROLLER:n:claim','ORCH_CONTROLLER:n:worker'],events=markers.map((m,i)=>({type:'tool_use',sessionID:'s',part:{tool:'orch_controller_step',callID:'call-'+i,state:{status:'completed',input:{step:i?'worker':'claim'},output:JSON.stringify({marker:m})}}})),end={type:'step_finish',sessionID:'s',part:{reason:'stop'}},options={harness:'opencode',model:'local/example',nativeModel:'local/example',sessionId:'s',markers};
  assert.equal(profiles.observeAdditionalControllerTrace([...events,end],options).steps,2);
  for(const bad of [[...events], [...events,{...end,sessionID:'other'}],[events[1],events[0],end],[events[0],{...events[1],part:{...events[1].part,callID:'call-0'}},end],[events[0],{...events[1],part:{...events[1].part,state:{...events[1].part.state,output:JSON.stringify({marker:markers[1],replayed:true})}}},end]])assert.throws(()=>profiles.observeAdditionalControllerTrace(bad,options));
});

test('P07f: Vibe scoped MCP command preserves space paths and original approved child config',async t=>{
  const c=await prepared(t,'vibe'),text=fs.readFileSync(c.p.profileFiles[0].file,'utf8');assert.deepEqual(JSON.parse(text.match(/^command = (.+)$/m)[1]),[process.execPath]);assert.ok(text.includes('ORCH_CONFIG = '+JSON.stringify(c.config)));assert.equal(c.p.workdir,path.join(path.dirname(c.p.instructions),'workspace'));
});

const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
async function completeOpenCode(t){
  const c=await prepared(t,'opencode'),{o,p}=c,binding=c.seams.binding,dir=path.dirname(p.instructions),state=path.join(path.dirname(dir),'state'),started=new Date().toISOString();
  const seams={binding,processTable:async()=>[],command:async(plan,args)=>{
    if(args[0]==='status')return {status:'completed'};
    if(args[0]==='review'){const rvFile=path.join(state,'reviews','controller-review.json'),rv=JSON.parse(fs.readFileSync(rvFile,'utf8'));Object.assign(rv,{finished_at:new Date().toISOString(),outcome:'reviewed',containment:'clean'});write(rvFile,rv);write(resourceFile({stateRoot:state},rv.id),{id:rv.id,kind:'review',review_id:rv.id,wp:plan.wp,by:plan.by,state:'removed',removed_at:new Date().toISOString(),path:rv.worktree,root:plan.smoke.reviewRoot,repo:plan.smoke.workdir});return {outcome:'reviewed'};}
    const prior=process.env.ORCH_CONFIG;process.env.ORCH_CONFIG=path.join(path.dirname(dir),'runtime.json');try{return await runCommand(args[0],parseArgs([...args.slice(1),'--state-root',state,'--json']),{log(){}});}finally{if(prior===undefined)delete process.env.ORCH_CONFIG;else process.env.ORCH_CONFIG=prior;}
  },launch:async ctx=>{
    const role=ctx.role,id='controller-'+role+'-proof',now=new Date().toISOString(),runDir=path.join(state,'runs',id),workdir=role==='worker'?ctx.workdir:path.join(ctx.plan.reviewRoot,'controller-review');fs.mkdirSync(runDir,{recursive:true});
    write(path.join(runDir,'run.json'),{id,cli:ctx.route.harness,role:role==='worker'?'implement':'review',wp:ctx.wp,by:ctx.by,slice:'controller-smoke',model_requested:ctx.route.model,model_actual:ctx.route.model,model_actual_alias:ctx.route.harness==='vibe'?aliasFor(ctx.route.model):null,model_mismatch:false,status:'completed',exit_code:0,started_at:now,ended_at:now,dir:workdir,dir_real:workdir,...(role==='reviewer'?{review_of:ctx.workerId,review_id:'controller-review'}:{}),escaped_helpers:[],handoff_source:ctx.prompt,handoff_sha256:hash(fs.readFileSync(ctx.prompt)),launch:{exe:ctx.binding.exe},role_packet:rolePrompt(Buffer.alloc(0),role==='worker'?'implement':'review').provenance});
    fs.writeFileSync(path.join(runDir,'stdout.log'),JSON.stringify(role==='worker'?{type:'item.completed',item:{type:'agent_message',text:`ORCH_QUALIFICATION:${ctx.challenge}:worker`}}:{type:'message',role:'assistant',content:[{type:'text',text:`ORCH_QUALIFICATION:${ctx.challenge}:reviewer`} ]})+'\n');fs.writeFileSync(path.join(runDir,'stderr.log'),'');fs.writeFileSync(path.join(runDir,'keeper.ndjson'),[{event:'spawned',worker_pid:1,at:now},{event:'worker-exit',code:0,at:now},{event:'keeper-exit',write_failures:0,at:now}].map(x=>JSON.stringify(x)).join('\n')+'\n');
    if(role==='reviewer')write(path.join(state,'reviews','controller-review.json'),{id:'controller-review',run_id:id,implementer_run:ctx.workerId,wp:ctx.wp,by:ctx.by,worktree:workdir,source_repo:ctx.workdir,review_root:ctx.plan.reviewRoot,reviewer_cli:ctx.route.harness,reviewer_model:ctx.route.model});
    return {run_id:id,...(role==='reviewer'?{review_id:'controller-review'}:{})};
  }};

  const rows=[];for(const step of p.steps)rows.push(await api.controllerStep(c.session,{offerHash:o.offerHash,approve:true,step},seams));
  const ended=new Date().toISOString(),startedMs=Date.parse(started),endedMs=Date.parse(ended);
  write(path.join(dir,'launch-attempt.json'),{offerHash:o.offerHash,approve:true,at:started,runnerHash:hash(fs.readFileSync(new URL('../src/controller-native.mjs',import.meta.url)))});
  write(path.join(dir,'runner-started.json'),{offerHash:o.offerHash,runnerPid:888888});
  write(path.join(dir,'launch.json'),{offerHash:o.offerHash,exe:process.execPath,pid:999999,createdAt:started,runnerPid:888888,runnerCreatedAt:started,workdir:p.workdir,profile:p.profile,instructionsHash:p.instructionsHash,authSource:'explicit-local-provider',apiOverridesRemoved:true,intervened:false,startedAt:started});write(path.join(dir,'exit.json'),{code:0,signal:null,endedAt:ended});
  const serverFile=path.join(dir,'native-tool-servers','888887-'+('a'.repeat(32))+'.json');write(serverFile,{offerHash:o.offerHash,pid:888887,createdAt:started,startedAt:started});
  /** @type {any[]} */ const trace=rows.map((r,i)=>({type:'tool_use',sessionID:'native-session',part:{tool:'orch_controller_step',callID:'step-'+i,state:{status:'completed',input:{step:r.step},output:JSON.stringify(r)}}}));trace.push({type:'step_finish',sessionID:'native-session',part:{reason:'stop'}});
  fs.writeFileSync(path.join(dir,'stdout.jsonl'),trace.map(x=>JSON.stringify(x)).join('\n'));fs.writeFileSync(path.join(dir,'stderr.txt'),'');fs.writeFileSync(path.join(dir,'native-tool-events.ndjson'),rows.map(r=>JSON.stringify({step:r.step,marker:r.marker,pending:false,replayed:false})).join('\n'));
  write(path.join(dir,'native-export.json'),{info:{id:'native-session',directory:p.workdir,time:{created:startedMs}},messages:[{info:{role:'assistant',sessionID:'native-session',modelID:'example',providerID:'local',path:{cwd:p.workdir},time:{created:startedMs,completed:endedMs},finish:'stop'},parts:[]}]});
  return {...c,dir,seams,serverFile,started};
}
test('P07f: offline OpenCode lifecycle refuses live helpers, missing server proof and missing audit before immutable capture',async t=>{
  const c=await completeOpenCode(t),request={offerHash:c.o.offerHash};
  await assert.rejects(api.qualifyController(c.session,request,{...c.seams,processTable:async()=>[{pid:888887,createdAt:'ms:'+Date.parse(c.started)}]}),/process exit is not verified/);
  const server=fs.readFileSync(c.serverFile);fs.unlinkSync(c.serverFile);await assert.rejects(api.qualifyController(c.session,request,c.seams),/journal is unavailable/);fs.writeFileSync(c.serverFile,server);
  const auditFile=path.join(c.dir,'native-tool-events.ndjson'),audit=fs.readFileSync(auditFile);fs.writeFileSync(auditFile,'');await assert.rejects(api.qualifyController(c.session,request,c.seams),/execution audit/);fs.writeFileSync(auditFile,audit);
  const receipt=await api.qualifyController(c.session,request,c.seams);assert.equal(receipt.status,'controller-observed');assert.equal(receipt.controller.model,'local/example');assert.equal(receipt.controller.observedModel,'example');assert.equal(receipt.cleanup.review,'removed');assert.equal(receipt.launchAllowed,false);assert.equal((await api.qualifyController(c.session,request,c.seams)).replayed,true);
});

test('P07f native OpenCode regression: CLI schema normalization preserves the sealed profile bytes',async t=>{
 const c=await prepared(t,'opencode'),file=c.p.profileFiles[0].file,before=fs.readFileSync(file,'utf8'),doc=JSON.parse(before);
 assert.equal(doc.$schema,'https://opencode.ai/config.json');
 const normalized=JSON.stringify({...doc,$schema:'https://opencode.ai/config.json'},null,2)+'\n';
 assert.equal(normalized,before);assert.equal(hash(normalized),c.p.profileFiles[0].sha256);
 fs.writeFileSync(file,normalized);await runController(c.session,{offerHash:c.o.offerHash,approve:true},{...c.seams,spawn:()=>({pid:12345,unref(){}})});
 assert.equal(api.controllerNativeToolSpec(c.session,c.o.offerHash,c.seams).plan.offerHash,c.o.offerHash);
});
test('P07f native OpenCode regression: scoped local profile disables the background title request',async t=>{
 const c=await prepared(t,'opencode'),doc=JSON.parse(fs.readFileSync(c.p.profileFiles[0].file,'utf8'));
 assert.equal(doc.agent.title?.disable,true);assert.equal(doc.agent['orch-controller'].mode,'primary');assert.deepEqual(doc.permission,{'*':'deny',orch_controller_step:'allow'});
});

test('P07f native OpenCode regression: effective permission ordering exposes exactly the approved MCP tool',async t=>{
 const c=await prepared(t,'opencode'),doc=JSON.parse(fs.readFileSync(c.p.profileFiles[0].file,'utf8')),agent=doc.agent['orch-controller'];
 // OpenCode 1.18.31 normalizes deprecated tools before assigning permission.
 // Assignment preserves existing keys: a newly appended wildcard can mask them.
 const normalized={};for(const [tool,enabled]of Object.entries(agent.tools??{}))normalized[['write','edit','patch'].includes(tool)?'edit':tool]=enabled?'allow':'deny';Object.assign(normalized,agent.permission);
 const effective=tool=>Object.entries(normalized).filter(([key])=>key==='*'||key===tool).at(-1)?.[1]??'ask';
 assert.equal(effective('orch_controller_step'),'allow');for(const tool of ['bash','read','edit','write','task','webfetch','foreign_tool'])assert.equal(effective(tool),'deny');
});
