import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {makeCase,waitForStatus,waitFor,readRunFile} from './helpers.mjs';
import {checkCommand} from '../../hooks/rules.mjs';
import {deriveStatus} from '../src/statusrules.mjs';
import {makeRepo} from './wf-helpers.mjs';
const modules=await Promise.all(['copilot','muse'].map(n=>import(`../src/adapters/${n}.mjs`).catch(()=>({default:null}))));
const [copilot,muse]=modules.map(m=>m.default);
const context=t=>{const c=makeCase('p04b-adapter');t.after(()=>c.cleanup());const promptPath=path.join(c.base,'prompt.txt');fs.writeFileSync(promptPath,'Unicode handoff: café $() & "quoted"\n');return {dir:c.base,runDir:c.base,promptPath,role:'implement',model:'example-exact-model',flags:[],effort:'medium'};};
function env(vars,fn){const before={};for(const[k,v]of Object.entries(vars)){before[k]=process.env[k];process.env[k]=v;}try{return fn();}finally{for(const[k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;}}
const jsonl=xs=>xs.map(x=>JSON.stringify(x)).join('\n');
for(const [name,a]of [['copilot',copilot],['muse',muse]]){
  test(`P04b ${name}: registered adapter requires exact model and protects owned options`,async t=>{
    assert.ok(a,'adapter exists');const ctx=context(t);const {PUBLIC_ADAPTERS,getAdapter}=await import('../src/adapters/index.mjs');assert.ok(PUBLIC_ADAPTERS.includes(name));assert.equal(getAdapter(name),a);
    for(const model of ['', ...(name==='muse'?['auto']:[]),'sonnet'])assert.throws(()=>a.validateRequest({...ctx,model}),/exact|model/i);if(name==='copilot'){assert.doesNotThrow(()=>a.validateRequest({...ctx,model:'auto',effort:null}));assert.throws(()=>a.validateRequest({...ctx,model:'auto'}),/effort/);}
    for(const flags of [['--model','other'],['--yolo'],['--provider','echo'],['--resume'],['--config-dir=other'],['-c','meta.api_key=other']])assert.throws(()=>a.validateRequest({...ctx,flags}),/flag/i);
    assert.throws(()=>a.validateRequest({...ctx,agent:'foreign'}),/agent/i);assert.throws(()=>a.validateRequest({...ctx,maxPrice:'2'}),/price/i);
    assert.equal(a.lane,'cloud');assert.equal(a.heartbeatStream,'stdout');assert.equal(a.canonicalModel('Provider/EXAMPLE-MODEL'),'example-model');
  });
  test(`P04b ${name}: direct executable, role policy, prompt and credentials`,t=>{
    assert.ok(a);const ctx=context(t);
    env({[`ORCH_${name.toUpperCase()}_EXE`]:'C:/fixture/native.exe',META_API_KEY:'private-canary',COPILOT_PROVIDER_API_KEY:'private-canary',COPILOT_PROVIDER_BASE_URL:'https://invalid.example',GH_TOKEN:'private-canary'},()=>{
      const built=a.build(ctx);assert.equal(built.file,'C:/fixture/native.exe');assert.equal(built.cwd,ctx.dir);assert.equal(built.envSet.PWD,ctx.dir);assert.equal(built.args.includes('Unicode handoff: café'),false);assert.ok(built.envDelete.includes(name==='muse'?'META_API_KEY':'COPILOT_PROVIDER_API_KEY'));
      const review=a.build({...ctx,role:'review'});if(name==='muse'){assert.ok(review.args.includes('--disable-shell'));assert.ok(review.args.includes('--disable-write'));assert.ok(built.args.includes('--prompt-file'));assert.ok(!built.args.includes('--disable-write'));}else{assert.ok(review.args.includes('view,glob,grep'));assert.ok(!review.args.includes('edit'));assert.equal(built.args.at(-1),fs.readFileSync(ctx.promptPath,'utf8'));assert.ok(built.envDelete.includes('GH_TOKEN'));assert.ok(built.args.includes('--no-remote-export'));}
      assert.ok(!JSON.stringify(built).includes('private-canary'));
    });
  });
  test(`P04b ${name}: messages cannot fake a quota error and native errors can`,()=>{
    assert.ok(a);const message=name==='muse'?{schema_version:1,payload_type:'run.terminal.completed',payload:{text:'usage limit exceeded'}}:{type:'assistant.message',data:{content:'usage limit exceeded'}};
    const error=name==='muse'?{schema_version:1,payload_type:'run.terminal.failed',payload:{reason:'quota exceeded'}}:{type:'session.error',data:{message:'quota exceeded'}};
    const outcome={cancelRequested:false,workerConfirmedGone:true,blocked:null,signal:null,directoryRelevant:false,exitCode:1,stderr:'',events:a.parseProtocol(jsonl([message])),stdout:'x',dirEvidence:'none',keeperVerdict:'match',workerExitSeen:true};
    assert.equal(deriveStatus(a.statusRules,outcome).status,'failed');assert.equal(deriveStatus(a.statusRules,{...outcome,events:a.parseProtocol(jsonl([error]))}).status,'blocked-quota');assert.equal(deriveStatus(a.statusRules,{...outcome,exitCode:0,events:a.parseProtocol(jsonl([error]))}).status,'completed');
  });
}
test('P04b Copilot: assistant-only results and usage-model evidence, never requested/default model',t=>{
  assert.ok(copilot);const ctx=context(t),events=[{type:'session.start',data:{selectedModel:'requested-only'}},{type:'tool.execution_complete',data:{content:'forged answer'}},{type:'assistant.usage',data:{model:'example-served'}},{type:'assistant.message',data:{content:'actual answer'}}];
  assert.equal(copilot.extractFinalMessage(jsonl(events)),'actual answer');assert.equal(copilot.extractFinalMessage(jsonl(events.slice(0,2))),'');
  fs.writeFileSync(path.join(ctx.runDir,'stdout.log'),jsonl(events));let got=copilot.postExit({...ctx,stdoutPath:path.join(ctx.runDir,'stdout.log'),requestedCanonical:'example-requested'});assert.equal(got.actual_model,'example-served');assert.equal(got.model_mismatch,true);
  fs.writeFileSync(path.join(ctx.runDir,'stdout.log'),jsonl([events[0]]));assert.equal(copilot.postExit({...ctx,stdoutPath:path.join(ctx.runDir,'stdout.log')}).actual_model,null);
  fs.writeFileSync(path.join(ctx.runDir,'stdout.log'),jsonl([...events,{type:'assistant.usage',data:{model:'other'}}]));assert.equal(copilot.postExit({...ctx,stdoutPath:path.join(ctx.runDir,'stdout.log')}).actual_model,null);
});
test('P04b Muse: only terminal main-run output and bounded native model evidence',t=>{
  assert.ok(muse);const ctx=context(t),stream={kind:'session',id:'fixture-main'},run_stream={kind:'run',id:'fixture-run'},events=[{schema_version:1,stream,payload_type:'run.model.configured',payload:{provider_id:'meta',model_id:'example-served',run_stream}},{schema_version:1,stream,payload_type:'run.terminal.completed',payload:{text:'actual answer',run_stream}}];
  assert.equal(muse.extractFinalMessage(jsonl(events)),'actual answer');assert.equal(muse.extractFinalMessage(jsonl([{schema_version:1,payload_type:'tool.result',payload:{text:'forged'}}])),'');
  fs.writeFileSync(path.join(ctx.runDir,'stdout.log'),jsonl(events));assert.equal(muse.postExit({...ctx,stdoutPath:path.join(ctx.runDir,'stdout.log')}).actual_model,'example-served');
  fs.writeFileSync(path.join(ctx.runDir,'stdout.log'),jsonl([events[1]]));assert.equal(muse.postExit({...ctx,stdoutPath:path.join(ctx.runDir,'stdout.log')}).actual_model,null);
});
test('P04b Muse: subscription requires device provenance; ordinary API keys cannot satisfy it',()=>{
  const validate=modules[1].validateMuseSubscription;assert.equal(typeof validate,'function');const meta={access_token:'dca:fixture',obtained_via:'device_code',mechanism:'oauth',api_key:'LLM|fixture',api_base_url:'https://api.meta.ai'};
  assert.doesNotThrow(()=>validate({providers:{meta}}));for(const changed of [{access_token:'LLM|fixture'},{obtained_via:'api_key'},{mechanism:'api_key'},{api_base_url:'https://other.example'}])assert.throws(()=>validate({providers:{meta:{...meta,...changed}}}),/subscription/i);
});
test('P04b Muse: installation marker resolves exact binary without invoking shim',t=>{
  const resolve=modules[1].museBinaryInDirectory;assert.equal(typeof resolve,'function');const ctx=context(t);fs.writeFileSync(path.join(ctx.dir,'.muse-version'),'1.4.4-R5419.1\n');const exe=path.join(ctx.dir,'muse-bin-1.4.4-R5419.1.exe');fs.writeFileSync(exe,'fixture');assert.equal(resolve(ctx.dir),exe);fs.writeFileSync(path.join(ctx.dir,'.muse-version'),'../../other');assert.equal(resolve(ctx.dir),null);
});
test('P04b guard: direct Muse launches are denied; inspection is allowed',()=>{
  assert.equal(checkCommand('muse exec --model example-model "x"',process.cwd()).block,true);assert.equal(checkCommand('muse --workspace . exec --prompt-file p.txt',process.cwd()).block,true);assert.equal(checkCommand('muse exec --help',process.cwd()).block,false);assert.equal(checkCommand('copilot -p "x"',process.cwd()).block,true);
  assert.equal(checkCommand('C:/tools/muse-bin-1.4.4-R5419.1.exe exec "x"',process.cwd()).block,true);
  assert.equal(checkCommand('$worker="C:/tools/muse-bin-1.4.4-R5419.1.exe"; & $worker exec "x"',process.cwd()).block,true);
});
test('P04b native Copilot call pairs and main-agent usage agree; config and child models are not proof',t=>{
  const ctx=context(t),stdoutPath=path.join(ctx.dir,'stdout.log');fs.writeFileSync(stdoutPath,jsonl([{type:'session.auto_mode_resolved',data:{chosenModel:'configured-only'}},{type:'model.call_start',data:{turnId:'0',model:'example-served'}},{type:'model.call_finished',data:{turnId:'0',outcome:'success'}},{type:'model.call_start',agentId:'child',data:{turnId:'1',model:'unrelated'}},{type:'model.call_finished',agentId:'child',data:{turnId:'1',outcome:'success'}}]));
  assert.equal(copilot.postExit({...ctx,stdoutPath,requestedCanonical:'auto'}).actual_model,'example-served');assert.equal(copilot.postExit({...ctx,stdoutPath,requestedCanonical:'auto'}).model_mismatch,undefined);
  fs.writeFileSync(path.join(ctx.runDir,'copilot-usage.json'),JSON.stringify({currentModel:'configured-only',agentMetrics:{main:{modelMetrics:{'different-model':{requests:{count:1}}}},child:{modelMetrics:{unrelated:{requests:{count:1}}}}}}));assert.equal(copilot.postExit({...ctx,stdoutPath}).actual_model,null);
});
test('P04b native Muse model facts are bound to the same completed main run',t=>{
  const ctx=context(t),stdoutPath=path.join(ctx.dir,'stdout.log'),stream={kind:'session',id:'fixture-main'},run_stream={kind:'run',id:'main-run'};const final={schema_version:1,stream,payload_type:'run.terminal.completed',payload:{run_stream,text:'answer'}};
  for(const changed of [{run_stream:{kind:'run',id:'other-run'}},{provider_id:'echo'}]){fs.writeFileSync(stdoutPath,jsonl([{schema_version:1,stream,payload_type:'run.model.configured',payload:{run_stream,provider_id:'meta',model_id:'example-served',...changed}},final]));assert.equal(muse.postExit({...ctx,stdoutPath}).actual_model,null);}
  const quoted={schema_version:1,payload_type:'task.lifecycle.failed',payload:{reason:'quota exceeded'}};assert.ok(!muse.parseProtocol(jsonl([quoted])).some(e=>e.type==='error'));
});
test('P04b onboarding selects subscription worker/reviewer routes and scoped controller intent, never API billing',async t=>{
  const ctx=context(t);const repo=path.join(ctx.dir,'repo');makeRepo(repo,{'AGENTS.md':'Owner instructions\n'});const api=await import('../src/setup.mjs'),session=path.join(ctx.dir,'session'),s=await api.startSetup({repo,harness:'codex',session,catalog:undefined,roster:undefined});
  const route=harness=>({harness,model:'example-model',billing:'subscription',permission:'ask'});const answer={controller:route('codex'),workers:[route('copilot'),route('muse')],reviewers:[route('muse'),route('copilot')]};
  assert.ok(s.nextQuestion.schema.properties.workers.items.properties.harness.enum.includes('muse'));for(const harness of ['muse','copilot'])assert.ok(s.nextQuestion.schema.properties.controller.properties.harness.enum.includes(harness));
  await assert.rejects(api.answerSetup(session,{expectedRevision:s.revision,questionId:'routes',answer:{...answer,workers:[{...route('muse'),billing:'api'}]}}),/subscription/);
  const next=await api.answerSetup(session,{expectedRevision:s.revision,questionId:'routes',answer});assert.deepEqual(next.answers.routes,answer);
});

test('P04b repairs: versioned Muse expressions cannot bypass the direct-launch guard',()=>{
  for(const command of [
    '& "C:/Program Files/Muse/muse-bin-1.4.4-R5419.1.exe" exec "prompt"',
    '& (Get-Command muse-bin-1.4.4-R5419.1.exe).Source exec "prompt"',
    '$bin=(Get-Command muse-bin-1.4.4-R5419.1.exe).Source; & $bin exec "prompt"',
    'Start-Process (Get-Command muse-bin-1.4.4-R5419.1.exe).Source -ArgumentList "exec","prompt"',
    'muse serve --workspace .',
  ])assert.equal(checkCommand(command,process.cwd()).block,true,command);
  assert.equal(checkCommand('& (Get-Command muse-bin-1.4.4-R5419.1.exe).Source exec --help',process.cwd()).block,false);
  assert.equal(checkCommand('Write-Output "(Get-Command muse-bin-1.4.4-R5419.1.exe).Source exec"',process.cwd()).block,false);
});

test('P04b repairs: child output cannot replace the main final answer',()=>{
  assert.equal(copilot.extractFinalMessage(jsonl([{type:'assistant.message',data:{content:'main'}},{type:'assistant.message',data:{agentId:'child',content:'child'}}])),'main');
  assert.equal(muse.extractFinalMessage(jsonl([{schema_version:1,payload_type:'run.terminal.completed',stream:{kind:'session'},payload:{text:'main'}},{schema_version:1,payload_type:'run.terminal.completed',stream:{kind:'subagent'},payload:{text:'child'}}])),'main');
});

test('P04b repairs: Copilot preflight validates delivered prompt, effort, options and real Auto permission',t=>{
  const ctx=context(t),roster=path.join(ctx.dir,'permission-roster.json');fs.writeFileSync(roster,JSON.stringify({models:[{model:'auto',requires_permission:true}]}));
  env({ORCH_COPILOT_EXE:'C:/fixture/native.exe',ORCH_ROSTER:roster},()=>{
    for(const extra of [{flags:['--yolo']},{agent:'foreign'},{maxPrice:2},{maxTurns:2},{effort:'ultra'},{promptBuffer:Buffer.from('a'.repeat(12001))},{promptBuffer:Buffer.from('a\0b')}])assert.throws(()=>copilot.preLaunch({...ctx,promptBuffer:Buffer.from('delivered'),...extra}));
    assert.throws(()=>copilot.preLaunch({...ctx,model:'AUTO',effort:null}),/permission/);
    assert.doesNotThrow(()=>copilot.preLaunch({...ctx,model:'Auto',effort:null,ownerApprovedModel:true}));
    assert.equal(copilot.build({...ctx,model:'Auto',effort:null}).args[3],'auto');
  });
});

test('P04b repairs: marker case and native resolution exclude an unverified muse.exe wrapper',{skip:process.platform!=='win32'&&'Windows Muse marker and launcher layout'},t=>{
  const ctx=context(t);fs.writeFileSync(path.join(ctx.dir,'.muse-version'),'1.4.4-r5419.1\n');const exe=path.join(ctx.dir,'muse-bin-1.4.4-r5419.1.exe');fs.writeFileSync(exe,'fixture');assert.equal(modules[1].museBinaryInDirectory(ctx.dir),exe);
  fs.writeFileSync(path.join(ctx.dir,'muse.exe'),'unverified wrapper');fs.writeFileSync(path.join(ctx.dir,'muse.cmd'),'fixture shim');
  env({ORCH_MUSE_EXE:'',PATH:ctx.dir+';'+path.join(process.env.SystemRoot,'System32')},()=>assert.equal(modules[1].resolveMuseExe(),exe));
});

test('P04b repairs: invalid subscription launches leave no run folders or artifact ownership',async t=>{
  const {cmdRun}=await import('../src/commands.mjs'),c=makeCase('p04b-preflight',{handoff:'short'});t.after(()=>c.cleanup());
  const auth=path.join(c.base,'auth.json');fs.writeFileSync(auth,JSON.stringify({providers:{meta:{access_token:'dca:fixture',obtained_via:'device_code',mechanism:'oauth',api_base_url:'https://api.meta.ai'}}}));
  const native=path.join(c.base,'native.exe');fs.writeFileSync(native,'non-executable fixture');
  const vars={...c.env,MUSE_AUTH_PATH:auth,ORCH_COPILOT_EXE:native,ORCH_MUSE_EXE:native},before={};for(const[k,v]of Object.entries(vars)){before[k]=process.env[k];process.env[k]=v;}
  try{
    for(const [cli,a]of [['copilot',copilot],['muse',muse]]){
      // Test-only in this isolated Node process; no provider executable can run.
      a.testOnly=true;
      try{for(const extra of [{flag:['--yolo']},{agent:'foreign'},{'max-price':2},{effort:'invalid'},{'max-turns':0}]){
        await assert.rejects(cmdRun({cli,model:'example-model',dir:c.work,handoff:c.handoffPath,json:true,...extra}));
        assert.deepEqual(fs.readdirSync(path.join(c.stateRoot,'runs')),[],'refused launch left a run folder');
        const owned=path.join(c.stateRoot,'retention','owned');if(fs.existsSync(owned))assert.deepEqual(fs.readdirSync(owned),[],'refused launch left ownership');
      }}finally{delete a.testOnly;}
    }
    copilot.testOnly=true;
    try{for(const text of ['a'.repeat(12000),'a\0b']){fs.writeFileSync(c.handoffPath,text);await assert.rejects(cmdRun({cli:'copilot',model:'example-model',dir:c.work,handoff:c.handoffPath,json:true}));assert.deepEqual(fs.readdirSync(path.join(c.stateRoot,'runs')),[]);}}finally{delete copilot.testOnly;}
    env({MUSE_AUTH_PATH:path.join(c.base,'missing-auth.json')},()=>assert.throws(()=>muse.preLaunch({...context(t),promptBuffer:Buffer.from('x')}),/sign-in/));
  }finally{for(const[k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('P04b repairs: routing refuses profiles with impossible owned launch options',async()=>{
  const {validateRoutingPolicy}=await import('../src/routing.mjs');
  const profile={id:'fixture',cli:'muse',harnessVersion:'1',model:'example-model',role:'worker',account:'subscription',billing:'subscription',enabled:true,availability:{status:'unknown'},qualification:{status:'unqualified'},capability:'coding',supports:{types:['helper'],classes:['C2'],risks:['standard'],tools:['read'],modalities:['text'],contextTokens:1000},costRank:0,latencyRank:0};
  const policy=profiles=>({version:1,catalogVersion:'fixture',availabilityMaxAgeMinutes:60,preference:'rotation',profiles});
  for(const extra of [{model:'auto'},{launch:{flags:['--yolo']}},{launch:{agent:'foreign',flags:[]}}])assert.throws(()=>validateRoutingPolicy(policy([{...profile,...extra}])));
  assert.doesNotThrow(()=>validateRoutingPolicy(policy([profile])));
});

const copilotOverrideKeys=['COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GH_HOST','COPILOT_GH_HOST','GH_CONFIG_DIR','GITHUB_SERVER_URL','GITHUB_API_URL'];
for(const role of ['implement','review']){
  test(`P04e Copilot ${role}: excludes inherited credentials and host/config redirects for explicit and Auto routes`,t=>{
    const ctx=context(t),keys=copilotOverrideKeys.map(k=>k.toLowerCase());
    const vars={ORCH_COPILOT_EXE:'C:/fixture/native.exe',...Object.fromEntries(keys.map(k=>[k,'fixture-override'])),copilot_provider_api_key:'fixture-override',P04E_KEEP:'fixture-preserved'};
    env(vars,()=>{
      for(const model of ['example-exact-model','Auto']){
        const built=copilot.build({...ctx,role,model,effort:model==='Auto'?null:'medium'}),removed=new Set(built.envDelete.map(k=>k.toUpperCase()));
        for(const key of copilotOverrideKeys)assert.ok(removed.has(key),`inherited ${key} must not reach the subscription child`);
        for(const key of Object.keys(process.env).filter(k=>keys.some(x=>x.toUpperCase()===k.toUpperCase())||k.toUpperCase().startsWith('COPILOT_PROVIDER_')))assert.ok(built.envDelete.includes(key),`actual inherited spelling ${key} must be removed`);
        assert.equal(built.envDelete.includes('P04E_KEEP'),false);assert.equal(process.env.P04E_KEEP,'fixture-preserved');assert.equal(process.env.gh_enterprise_token,'fixture-override');
      }
    });
  });

  test(`P04e Copilot ${role}: generic command and keeper apply the filter before the local fixture starts`,async t=>{
    const {cmdRun}=await import('../src/commands.mjs'),c=makeCase('p04e-environment',{handoff:'Read-only environment fixture'});t.after(()=>c.cleanup());
    const fixture=path.join(c.base,'environment-worker.mjs');
    fs.writeFileSync(fixture,`const names=${JSON.stringify(copilotOverrideKeys)};const presentOverrides=Object.keys(process.env).filter(k=>names.includes(k.toUpperCase())||k.toUpperCase().startsWith('COPILOT_PROVIDER_'));console.log(JSON.stringify({type:'assistant.usage',data:{model:'example-exact-model'}}));console.log(JSON.stringify({type:'assistant.message',data:{content:JSON.stringify({presentOverrides,keep:process.env.P04E_KEEP})}}));`);
    const vars={...c.env,ORCH_COPILOT_EXE:process.execPath,...Object.fromEntries(copilotOverrideKeys.map((k,i)=>[k==='GH_TOKEN'?'Gh_Token':i%2?k.toLowerCase():k,'fixture-override'])),copilot_provider_api_key:'fixture-override',P04E_KEEP:'fixture-preserved'},before={};
    /** @type {any} */ const adapter=copilot;const originalBuild=adapter.build;
    try{
      for(const[k,v]of Object.entries(vars)){before[k]=process.env[k];process.env[k]=v;}
      adapter.testOnly=true;adapter.build=function(ctx){const built=originalBuild.call(this,ctx);return {...built,file:process.execPath,args:[fixture]};};
      const launched=await cmdRun({cli:'copilot',model:'example-exact-model',dir:c.work,handoff:c.handoffPath,'no-window':true,json:true},{log(){}},{role});
      const record=await waitForStatus(c.stateRoot,launched.id??launched.run_id,['completed','failed','blocked'],{timeoutMs:60000});assert.equal(record.status,'completed');assert.equal(record.role,role);
      await waitFor(()=>!fs.existsSync(path.join(c.stateRoot,'runs',record.id,'monitor.alive')),{timeoutMs:30000,what:'environment fixture monitor exit'});
      const message=copilot.extractFinalMessage(readRunFile(c.stateRoot,record.id,'stdout.log')),observed=JSON.parse(message);assert.deepEqual(observed.presentOverrides,[]);assert.equal(observed.keep,'fixture-preserved');assert.equal(process.env.gh_enterprise_token,'fixture-override');
    }finally{adapter.build=originalBuild;delete adapter.testOnly;for(const[k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;}
  });
}
