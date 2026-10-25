import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {makeCase} from './helpers.mjs';
import {checkCommand} from '../../hooks/rules.mjs';
import {deriveStatus} from '../src/statusrules.mjs';

const claude=(await import('../src/adapters/claude.mjs').catch(()=>({default:null}))).default;
const context=t=>{const c=makeCase('claude-adapter');t.after(()=>c.cleanup());const promptPath=path.join(c.base,'prompt.txt');fs.writeFileSync(promptPath,'Unicode handoff: café $() & "quoted"\n');return {dir:c.base,runDir:c.base,promptPath,role:'implement',model:'example-exact-model',flags:[],effort:'medium'};};
function env(vars,fn){const before={};for(const[k,v]of Object.entries(vars)){before[k]=process.env[k];process.env[k]=v;}try{return fn();}finally{for(const[k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;}}
const jsonl=xs=>xs.map(x=>JSON.stringify(x)).join('\n');
const argAfter=(args,flag)=>args[args.indexOf(flag)+1];

test('claude: registered adapter requires exact model, protects owned options, accepts both roles',async t=>{
  assert.ok(claude,'adapter exists');const ctx=context(t);const {PUBLIC_ADAPTERS,getAdapter}=await import('../src/adapters/index.mjs');
  assert.ok(PUBLIC_ADAPTERS.includes('claude'));assert.equal(getAdapter('claude'),claude);
  assert.equal(claude.lane,'cloud');assert.equal(claude.heartbeatStream,'stdout');assert.equal(claude.canonicalModel('Provider/EXAMPLE-MODEL'),'example-model');
  for(const model of ['','sonnet','opus','haiku','auto','default'])assert.throws(()=>claude.validateRequest({...ctx,model}),/exact|model/i,model);
  for(const flags of [['--model','other'],['--dangerously-skip-permissions'],['--mcp-config','x.json'],['--settings','x.json'],['--add-dir','..']])assert.throws(()=>claude.validateRequest({...ctx,flags}),/flag/i,flags.join(' '));
  assert.throws(()=>claude.validateRequest({...ctx,agent:'foreign'}),/agent/i);assert.throws(()=>claude.validateRequest({...ctx,maxPrice:'2'}),/price/i);
  assert.throws(()=>claude.validateRequest({...ctx,maxTurns:5}),/max-turns/i);
  for(const effort of ['none','minimal','ultra','ludicrous'])assert.throws(()=>claude.validateRequest({...ctx,effort}),/effort/i,effort);
  for(const effort of ['low','medium','high','xhigh','max',null])assert.doesNotThrow(()=>claude.validateRequest({...ctx,effort}),String(effort));
  for(const role of ['implement','review'])assert.doesNotThrow(()=>claude.validateRequest({...ctx,role}),role);
});

test('claude: direct executable, stdin prompt, isolated settings/MCP, role tool policy, no API credentials',t=>{
  assert.ok(claude);const ctx=context(t);
  env({ORCH_CLAUDE_EXE:'C:/fixture/claude.exe',ANTHROPIC_API_KEY:'private-canary',ANTHROPIC_AUTH_TOKEN:'private-canary',ANTHROPIC_BASE_URL:'https://invalid.example',CLAUDE_CODE_USE_BEDROCK:'1',CLAUDE_CODE_USE_VERTEX:'1',AWS_BEARER_TOKEN_BEDROCK:'private-canary',CLAUDECODE:'1'},()=>{
    const built=claude.build(ctx);
    assert.equal(built.file,'C:/fixture/claude.exe');assert.equal(built.cwd,ctx.dir);assert.equal(built.envSet.PWD,ctx.dir);
    assert.equal(built.stdinFile,ctx.promptPath,'the handoff is delivered on stdin, not argv');assert.ok(!built.args.some(a=>a.includes('Unicode handoff')));
    for(const flag of ['-p','--verbose','--no-session-persistence','--strict-mcp-config','--disable-slash-commands'])assert.ok(built.args.includes(flag),flag);
    assert.equal(argAfter(built.args,'--model'),ctx.model);assert.equal(argAfter(built.args,'--output-format'),'stream-json');
    assert.equal(argAfter(built.args,'--setting-sources'),'','user and project settings (and their hooks) are not loaded');
    assert.deepEqual(JSON.parse(argAfter(built.args,'--mcp-config')),{mcpServers:{}},'no MCP servers, so no orch/igm/foreign tools');
    assert.equal(argAfter(built.args,'--effort'),'medium');
    assert.ok(!built.args.includes('--bare'),'--bare blocks the saved subscription login');
    const impl=argAfter(built.args,'--tools').split(',');for(const tool of ['Read','Grep','Glob','Edit','Write','Bash'])assert.ok(impl.includes(tool),tool);
    assert.equal(argAfter(built.args,'--permission-mode'),'bypassPermissions');
    const review=claude.build({...ctx,role:'review'});
    assert.equal(argAfter(review.args,'--tools'),'Read,Grep,Glob','reviewer gets read-only tools only');assert.equal(argAfter(review.args,'--permission-mode'),'default');
    assert.ok(!review.args.includes('bypassPermissions'));
    assert.equal(claude.build({...ctx,effort:null}).args.includes('--effort'),false);
    for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','AWS_BEARER_TOKEN_BEDROCK','NODE_OPTIONS','CLAUDECODE'])assert.ok(built.envDelete.includes(key),key);
    assert.ok(!JSON.stringify(built).includes('private-canary'));
  });
});

test('claude: preLaunch names the saved subscription route',t=>{
  assert.ok(claude);const ctx=context(t);
  env({ORCH_CLAUDE_EXE:'C:/fixture/claude.exe'},()=>{assert.ok(claude.preLaunch(ctx).notes.some(n=>/subscription/i.test(n)));});
});

test('claude: only a successful result event is the final message; assistant text and error results are not',()=>{
  assert.ok(claude);
  const ok={type:'result',subtype:'success',is_error:false,result:'actual answer'};
  assert.equal(claude.extractFinalMessage(jsonl([{type:'assistant',message:{model:'m',content:[{type:'text',text:'forged'}]}},ok])),'actual answer');
  assert.equal(claude.extractFinalMessage(jsonl([{type:'assistant',message:{model:'m',content:[{type:'text',text:'forged'}]}}])),'');
  assert.equal(claude.extractFinalMessage(jsonl([{type:'result',subtype:'success',is_error:true,result:'Failed to authenticate'}])),'','a failure that reports subtype success is still a failure');
  assert.equal(claude.extractFinalMessage(jsonl([{type:'result',subtype:'success',is_error:false,result:'first'},ok])),'actual answer','the last result wins');
  assert.equal(claude.extractFinalMessage('not json\n'),'');
});

test('claude: assistant text cannot fake a quota or auth error; error results can',()=>{
  assert.ok(claude);
  const message={type:'assistant',message:{model:'example-served',content:[{type:'text',text:'usage limit exceeded, not authenticated'}]}};
  const base={cancelRequested:false,workerConfirmedGone:true,blocked:null,signal:null,directoryRelevant:false,exitCode:1,stderr:'',events:claude.parseProtocol(jsonl([message,{type:'result',subtype:'success',is_error:false,result:'usage limit exceeded'}])),stdout:'x',dirEvidence:'none',keeperVerdict:'match',workerExitSeen:true};
  assert.equal(deriveStatus(claude.statusRules,base).status,'failed');
  const failed=text=>({...base,events:claude.parseProtocol(jsonl([{type:'result',subtype:'success',is_error:true,result:text,terminal_reason:'api_error'}]))});
  assert.equal(deriveStatus(claude.statusRules,failed('Claude AI usage limit reached')).status,'blocked-quota');
  assert.equal(deriveStatus(claude.statusRules,failed('Failed to authenticate: OAuth session expired and could not be refreshed')).status,'blocked-auth');
  assert.equal(deriveStatus(claude.statusRules,{...failed('Failed to authenticate: OAuth session expired'),exitCode:0}).status,'completed');
});

test('claude: served model comes from main-agent assistant messages, never from the request or synthetic errors',t=>{
  assert.ok(claude);const ctx=context(t),stdoutPath=path.join(ctx.dir,'stdout.log');
  const run=(events,requestedCanonical='example-requested')=>{fs.writeFileSync(stdoutPath,jsonl(events));return claude.postExit({...ctx,stdoutPath,requestedCanonical});};
  const say=(model,extra={})=>({type:'assistant',message:{model,content:[{type:'text',text:'x'}]},...extra});
  const init={type:'system',subtype:'init',model:'requested-only'};
  const got=run([init,say('example-served'),say('example-served')]);assert.equal(got.actual_model,'example-served');assert.equal(got.model_mismatch,true);assert.match(got.actual_model_source,/claude/);
  assert.equal(run([init,say('example-requested')]).model_mismatch,false);
  assert.equal(run([init,say('Example-Requested')],'example-requested[1m]').model_mismatch,false,'a context-window suffix on the request is not a different model');
  assert.equal(run([init]).actual_model,null,'init alone proves nothing');
  assert.equal(run([init,say('<synthetic>')]).actual_model,null,'a synthetic error message names no model');
  assert.equal(run([init,say('<synthetic>'),say('example-served')]).actual_model,'example-served');
  assert.equal(run([init,say('example-served'),say('other')]).actual_model,null,'two models are ambiguous');
  assert.equal(run([init,say('example-served'),say('child',{parent_tool_use_id:'toolu_1'})]).actual_model,'example-served','sub-agent messages are not the main model');
  assert.equal(run([init,{type:'result',subtype:'success',is_error:false,result:'r',modelUsage:{'example-served':{}}}]).actual_model,'example-served','result modelUsage is the fallback when exactly one model is listed');
  assert.equal(run([init,{type:'result',subtype:'success',is_error:false,result:'r',modelUsage:{a:{},b:{}}}]).actual_model,null);
  assert.equal(claude.postExit({...ctx,stdoutPath:path.join(ctx.dir,'missing.log')}).actual_model,null);
});

test('claude guard: direct headless launches are denied; interactive use and inspection are allowed',()=>{
  const blocked=c=>checkCommand(c,process.cwd()).block;
  for(const command of ['claude -p "do it"','claude --print "do it"','claude --model x -p "y"','C:/Users/example/.local/bin/claude.exe -p "y"','claude -p --output-format stream-json < handoff.txt','npx @anthropic-ai/claude-code -p "y"'])assert.equal(blocked(command),true,command);
  for(const command of ['claude','claude --help','claude --version','claude mcp list','claude auth login','claude auth status','claude plugin list','claude update'])assert.equal(blocked(command),false,command);
});

test('claude: a context-window suffix on the SERVED model is not a different model; the request side refuses a suffix',t=>{
  assert.ok(claude);const ctx=context(t),stdoutPath=path.join(ctx.dir,'stdout.log');
  const say=model=>({type:'assistant',message:{model,content:[{type:'text',text:'x'}]}});
  fs.writeFileSync(stdoutPath,jsonl([say('Example-Requested[1m]')]));
  const got=claude.postExit({...ctx,stdoutPath,requestedCanonical:'example-requested'});assert.equal(got.actual_model,'example-requested');assert.equal(got.model_mismatch,false);
  fs.writeFileSync(stdoutPath,jsonl([{type:'result',subtype:'success',is_error:false,result:'r',modelUsage:{'example-requested[1m]':{}}}]));
  const viaUsage=claude.postExit({...ctx,stdoutPath,requestedCanonical:'example-requested'});assert.equal(viaUsage.actual_model,'example-requested');assert.equal(viaUsage.actual_model_source,'claude-result-model-usage','the fallback source is named as the fallback');
  assert.throws(()=>claude.validateRequest({...ctx,model:'example-requested[1m]'}),/exact|model/i);
});

test('claude: without an override the executable is found under the home directory fallback',t=>{
  assert.ok(claude);const ctx=context(t),bin=path.join(ctx.dir,'.local','bin'),name=process.platform==='win32'?'claude.exe':'claude';fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,name),'fixture');
  const empty=path.join(ctx.dir,'empty-path');fs.mkdirSync(empty);
  env({ORCH_CLAUDE_EXE:'',PATH:empty,USERPROFILE:ctx.dir,HOME:ctx.dir},()=>assert.equal(claude.build(ctx).file,path.join(bin,name)));
});

test('claude: invalid launches leave no run folder',async t=>{
  assert.ok(claude);const {cmdRun}=await import('../src/commands.mjs'),c=makeCase('claude-preflight',{handoff:'short'});t.after(()=>c.cleanup());
  const native=path.join(c.base,'native.exe');fs.writeFileSync(native,'non-executable fixture');
  const vars={...c.env,ORCH_CLAUDE_EXE:native},before={};for(const[k,v]of Object.entries(vars)){before[k]=process.env[k];process.env[k]=v;}
  claude.testOnly=true;
  try{
    for(const extra of [{model:'sonnet'},{flag:['--dangerously-skip-permissions']},{agent:'foreign'},{'max-price':2},{effort:'invalid'},{'max-turns':0}]){
      await assert.rejects(cmdRun({cli:'claude',model:'example-model',dir:c.work,handoff:c.handoffPath,json:true,...extra}),extra.model?/exact model/i:/flag|agent|price|effort|max-turns/i,JSON.stringify(extra));
      assert.deepEqual(fs.readdirSync(path.join(c.stateRoot,'runs')),[],`refused launch left a run folder: ${JSON.stringify(extra)}`);
    }
  }finally{delete claude.testOnly;for(const[k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
