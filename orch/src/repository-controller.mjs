// Ordinary orch tools, constrained to one approved disposable repository task.
// This module does not launch a model, enable a policy, or turn a receipt into permission.
import crypto from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {canonicalId} from './models.mjs';
import {OrchError} from './errors.mjs';

export const REPOSITORY_TOOLS=['repository_instructions','repository_verify','claim','run','status','result','scope','review','review_finish','gate_record','gate_status','record','cleanup','finish'];
const READ_ONLY=new Set(['repository_instructions','repository_verify','status','result','scope','gate_status','cleanup']);
const fail=m=>{throw new OrchError(m,'repository-controller-refused');};
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(x);
const nonce=()=>crypto.randomBytes(16).toString('hex');
const exact=(actual,expected)=>{if(!equal(actual,expected))fail('Tool arguments exceed the exact approved repository scope');};
const results=journal=>journal.filter(r=>r.kind==='result'&&r.response?.isError!==true&&r.response?.structuredContent?.exit_code===0);
const value=row=>row?.response?.structuredContent?.output;

export function repositoryProfile(harness){
 if(!['copilot','muse'].includes(harness))fail('Repository controller requires an explicitly selected Copilot or Muse subscription');
 return {version:3,mode:'native-cli',statusWaitMs:20000,tools:[...REPOSITORY_TOOLS],commandPolicy:'owned-repository-tools',scope:'One adopted repository task; no general controller admission or future launch permission'};
}

/** Validate against successful IDs, never user-supplied path prefixes or run names. */
export function validateRepositoryRequest(p,journal,tool,args){
 if(!REPOSITORY_TOOLS.includes(tool)||!object(args)||!Array.isArray(journal)||journal.length>512)fail('Unknown repository tool or invalid journal');
 if(!p||!id(p.wp)||!['copilot','muse'].includes(p.by)||!p.offerHash||!Number.isFinite(Date.parse(p.expiresAt))||Date.now()>Date.parse(p.expiresAt))fail('Repository offer expired or unavailable');
 const done=results(journal),launched=done.find(r=>r.tool==='run'),reviewed=done.find(r=>r.tool==='review'),worker=value(launched)?.run_id??value(launched)?.id,review=value(reviewed)?.review_id,reviewer=value(reviewed)?.run_id;
 if(!READ_ONLY.has(tool)){
  if(journal.some(r=>['failure','refusal'].includes(r.kind))||journal.some(r=>r.kind==='attempt'&&!journal.some(x=>x.kind==='result'&&x.requestId===r.requestId)))fail('A prior call failed or is uncertain; inspect existing evidence without relaunch');
  if(journal.some(r=>r.kind==='attempt'&&r.tool===tool&&(tool!=='record'||r.input.run_id===args.run_id)))fail('Mutation already attempted; inspect its existing result');
 }
 if(done.some(r=>r.tool==='finish'))fail('Repository trial already finished');
 if(['repository_instructions','repository_verify'].includes(tool))exact(args,{});
 else if(tool==='claim'){
  // The ordinary claim schema permits a native session label. It is metadata,
  // never a replacement for the exact WP, claimant or discovered owner note.
  if(args.session!==undefined&&!id(args.session))fail('Invalid native claim session label');
  exact(args,{wp:p.wp,by:p.by,...(p.discoveryChallenge?{note:p.discoveryChallenge}:{}),...(args.session!==undefined?{session:args.session}:{})});
 }
 else if(tool==='run')exact(args,{cli:p.worker.harness,model:p.worker.model,wp:p.wp,by:p.by,allow:p.allow});
 else if(['status','result','scope'].includes(tool)){
  if(!id(args.id??args.run_id)||![worker,reviewer].filter(Boolean).includes(args.id??args.run_id))fail('Read requires an actually returned owned run ID');
  exact(args,tool==='scope'?{run_id:args.run_id}:{id:args.id});
 }else if(tool==='review'){
  if(!id(worker))fail('Launch and inspect the owned worker first');
  exact(args,{run:worker,ref:'HEAD',reviewer:p.reviewer.harness,model:p.reviewer.model,by:p.by});
 }else if(tool==='review_finish'){
  if(!id(review))fail('Finish requires the actually returned owned review ID');exact(args,{review_id:review,by:p.by});
 }else if(tool==='record'){
  if(!done.some(r=>r.tool==='repository_verify'&&value(r)?.passed===true)||!done.some(r=>r.tool==='review_finish'))fail('Verify the implementation and finalize its independent review before acceptance');
  if(!id(args.run_id)||![worker,reviewer].filter(Boolean).includes(args.run_id))fail('Disposition requires an owned run');
  exact(args,{run_id:args.run_id,disposition:'accepted'});
 }else if(tool==='gate_record'){if(!done.some(r=>r.tool==='repository_verify'&&value(r)?.passed===true))fail('Run the independent repository checks before a passing gate');if(args.round!==1&&args.round!=='1')fail('Only the approved repository review round is allowed');exact(args,{wp:p.wp,slice:'repository-case',round:args.round,findings:'[]',verification:'pass',scope:'pass',by:p.by});}
 else if(tool==='gate_status')exact(args,{wp:p.wp,slice:'repository-case'});
 else if(tool==='cleanup')exact(args,{wp:p.wp,'dry-run':true});
 else if(tool==='finish')exact(args,{wp:p.wp,by:p.by});
 return {mutating:!READ_ONLY.has(tool)};
}

/** Caller holds the existing operation lock and persists each row before proceeding. */
export async function invokeRepositoryTool(p,journal,tool,args,options={}){
 const {mutating}=validateRepositoryRequest(p,journal,tool,args),requestId=nonce();
 if(typeof options.persist!=='function'||typeof options.dispatch!=='function')fail('Durable repository journal and real tool dispatch are required');
 const input=structuredClone(args),attempt={kind:'attempt',offerHash:p.offerHash,requestId,tool,input,mutating,at:new Date().toISOString()};
 await options.persist(attempt);
 let refused=false;
 try{
  const response=await options.dispatch(tool,input);
  if(object(response)&&Number.isInteger(response.structuredContent?.exit_code)&&response.structuredContent.exit_code>0){
   await options.persist({kind:'refusal',offerHash:p.offerHash,requestId,tool,input,mutating,response,at:new Date().toISOString(),reason:'tool-returned-nonzero'});refused=true;fail('Repository tool returned a nonzero outcome; inspect its retained response');
  }
  if(!object(response)||response.isError===true||response.structuredContent?.exit_code!==0)fail('Tool failed or outcome is unverified; inspect retained evidence');
  if(tool==='run'&&!id(response.structuredContent.output?.run_id??response.structuredContent.output?.id)||tool==='review'&&(!id(response.structuredContent.output?.run_id)||!id(response.structuredContent.output?.review_id)))fail('Launched process identity is unavailable');
  const out={...response,structuredContent:{...response.structuredContent,repositoryProof:{offerHash:p.offerHash,requestId}}};
  await options.persist({kind:'result',offerHash:p.offerHash,requestId,tool,input,response:out,at:new Date().toISOString()});
  return out;
 }catch{
  if(!refused)await options.persist({kind:'failure',offerHash:p.offerHash,requestId,tool,input,mutating,at:new Date().toISOString(),reason:'outcome-unverified'});
  fail(refused?'Repository tool returned a nonzero outcome; inspect evidence, never automatically repeat a mutation':'Repository tool outcome is uncertain; inspect evidence, never automatically repeat a mutation');
 }
}

// Human display content can duplicate or truncate the native structured channel.
// Preserve the complete semantic result and proof, without a second copy of output.
export function repositoryNativeResult(out){
 if(!object(out)||out.isError===true||!object(out.structuredContent)||out.structuredContent.exit_code!==0)fail('Failed native repository result');
 return {isError:false,structuredContent:out.structuredContent};
}
function nativeOutput(text){try{return repositoryNativeResult(typeof text==='string'?JSON.parse(text):text);}catch{fail('Native repository result is not bound structured output');}}
/** Native session evidence must agree with every real server result, not assistant prose. */
export function observeRepositoryTrace(events,o){
 if(!Array.isArray(events)||!events.length||events.length>10000||!Array.isArray(o.journal)||o.journal.length>512)fail('Native repository evidence exceeds its bounds');
 repositoryProfile(o.harness);
 const audit=results(o.journal),calls=[],used=new Set();let model,sessionId,source;
 if(o.journal.some(r=>['failure','refusal'].includes(r.kind))||!audit.length)fail('Failed, refused, uncertain or missing repository audit');
 const accept=(callId,tool,input,text)=>{
  if(typeof callId!=='string'||!callId||used.has(callId)||!REPOSITORY_TOOLS.includes(tool))fail('Duplicate or foreign native tool call');
  const out=nativeOutput(text),proof=out.structuredContent.repositoryProof,row=audit.find(r=>r.requestId===proof?.requestId);
  if(!row||proof.offerHash!==o.offerHash||row.tool!==tool||!equal(row.input,input)||!equal(repositoryNativeResult(row.response),out)||calls.some(c=>c.requestId===row.requestId))fail('Native call disagrees with the owned server audit');
  used.add(callId);calls.push({id:callId,tool,requestId:row.requestId});
 };
 if(o.harness==='copilot'){
  const terminals=events.filter(e=>e.type==='result');if(terminals.length!==1||terminals[0]!==events.at(-1)||terminals[0].exitCode!==0||typeof terminals[0].sessionId!=='string'||!terminals[0].sessionId)fail('Copilot terminal session unavailable');sessionId=terminals[0].sessionId;
  const starts=new Map(),finished=new Set(),models=new Set(),pending=new Map();
  for(const e of events){
   if(e.agentId||e.data?.agentId||e.data?.isByok===true||e.sessionId&&e.sessionId!==sessionId||['session.error','turn.failed'].includes(e.type))fail('Foreign child, billing, session or failed controller');
   const d=e.data;
   if(e.type==='model.call_start'){if(typeof d?.turnId!=='string'||starts.has(d.turnId)||typeof d.model!=='string')fail('Ambiguous model call');starts.set(d.turnId,d.model);}
   if(e.type==='model.call_finished'){if(d?.outcome!=='success'||!starts.has(d.turnId)||finished.has(d.turnId))fail('Unbound model completion');finished.add(d.turnId);models.add(canonicalId(starts.get(d.turnId)));}
   if(e.type==='tool.execution_start'){const name=d?.toolName?.replace(/^orch-/,'');if(d?.toolName!=='orch-'+name||!REPOSITORY_TOOLS.includes(name)||typeof d.toolCallId!=='string'||pending.has(d.toolCallId)||!object(d.arguments))fail('Foreign native tool attempt');pending.set(d.toolCallId,{tool:name,input:d.arguments});}
   if(e.type==='tool.execution_complete'){const call=pending.get(d?.toolCallId);if(!call||d.success!==true)fail('Unbound or failed native result');accept(d.toolCallId,call.tool,call.input,object(d.result)&&Object.hasOwn(d.result,'structuredContent')?{isError:false,structuredContent:d.result.structuredContent}:d.result?.content);}
  }
  if(!finished.size||starts.size!==finished.size||models.size!==1||pending.size!==used.size)fail('Actual model or complete tool result missing');model=[...models][0];source='copilot-native-call-events';
 }else{
  const configs=events.filter(e=>e.payload_type==='run.model.configured'),ends=events.filter(e=>e.payload_type==='run.terminal.completed');
  if(configs.length!==1||ends.length!==1||ends[0]!==events.at(-1))fail('Muse model or terminal evidence unavailable');
  const cfg=configs[0],end=ends[0],runId=end.payload?.run_stream?.id;sessionId=end.stream?.id;
  if(typeof runId!=='string'||typeof sessionId!=='string'||!sessionId||cfg.payload?.provider_id!=='meta'||typeof cfg.payload.model_id!=='string'||cfg.payload.run_stream?.id!==runId||end.payload?.terminal!=='completed'||events.indexOf(cfg)>events.findIndex(e=>e.payload_type==='tool.result'))fail('Muse model/run evidence is unbound');
  for(const e of events){
   if(e.schema_version!==1||e.stream?.kind!=='session'||e.stream.id!==sessionId||e.payload?.run_stream&&e.payload.run_stream.id!==runId||['run.terminal.failed','runtime.command.rejected'].includes(e.payload_type))fail('Muse native session changed or failed');
   const kind=e.payload?.event?.task_kind;if(typeof kind==='string'&&kind.startsWith('tool.')&&!REPOSITORY_TOOLS.some(t=>kind==='tool.mcp__orch__'+t)||e.payload_type?.startsWith('tool.')&&e.payload_type!=='tool.result')fail('Foreign Muse tool attempt');
   if(e.payload_type==='tool.result'){const p=e.payload,tool=p.correlation_facts?.tool_name?.replace(/^mcp__orch__/,''),out=nativeOutput(p.text),row=audit.find(r=>r.requestId===out.structuredContent.repositoryProof?.requestId);if(p.run_stream?.id!==runId||p.correlation_facts?.tool_name!=='mcp__orch__'+tool||p.correlation_facts?.outcome!=='success')fail('Foreign Muse result');accept(p.call_id,tool,row?.input,p.text);}
  }
  model=canonicalId(cfg.payload.model_id);source='muse-runtime-model';
 }
 const automatic=o.harness==='copilot'&&/^auto$/i.test(o.model);
 if(!model||!automatic&&model!==canonicalId(o.model)||calls.length!==audit.length||!equal(calls.map(c=>c.requestId),audit.map(r=>r.requestId)))fail('Actual model or complete ordered server result evidence missing');
 return {model,sessionId,source,calls,profile:repositoryProfile(o.harness),...(automatic?{accessKind:'automatic-access'}:{})};
}
