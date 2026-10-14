// Scoped subscription controllers. Native lifecycle proof never authorizes a launch.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {OrchError} from './errors.mjs';
import {canonicalId} from './models.mjs';
import {subscriptionEnvironment} from './setup-qualification.mjs';
import {readBounded} from './adapters/subscription-cli.mjs';
import {samePath} from './git.mjs';
import {getAdapter} from './adapters/index.mjs';
const STEPS=['claim','worker','monitor-worker','reviewer','monitor-reviewer','finalize','record','finish'];
const fail=m=>{throw new OrchError(m,'controller-qualification-refused');};
// Copilot's settings and managed legacy state may contain JSON comments.
function withoutComments(text){
  let out='',quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){
    const c=text[i],next=text[i+1];
    if(quoted){out+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;out+=c;continue;}
    if(c==='/'&&next==='/'){while(i+1<text.length&&text[i+1]!=='\n'&&text[i+1]!=='\r')i++;out+=' ';continue;}
    if(c==='/'&&next==='*'){const end=text.indexOf('*/',i+2);if(end<0)fail('Inherited controller configuration has an unfinished comment');out+=' ';i=end+1;continue;}
    out+=c;
  }
  return out;
}
const json=(f,comments=false)=>{if(!fs.existsSync(f))return {};try{const text=readBounded(f,1048576).replace(/^\uFEFF/,'');return JSON.parse(comments?withoutComments(text):text);}catch{fail('Inherited controller configuration is malformed or unavailable');}};
const replayed=x=>x&&typeof x==='object'&&(x.replayed===true||Object.values(x).some(replayed));
export function subscriptionControllerSpec(route,files,source=process.env,saved){
  if(!['copilot','muse'].includes(route.harness))fail('Unknown subscription controller profile');getAdapter(route.harness).validateRequest({model:route.model});
  const env=subscriptionEnvironment(source),home=source.USERPROFILE||os.homedir();
  const copilotHome=source.COPILOT_HOME||path.join(home,'.copilot'),museHome=path.join(source.XDG_CONFIG_HOME||path.join(home,'.config'),'muse');
  const settingsDocs=saved?[saved.settings??{}]:route.harness==='copilot'?['config.json','settings.json'].map(n=>json(path.join(copilotHome,n),true)):[json(path.join(museHome,'settings.json'))];
  const mcp=saved?.mcp??(route.harness==='copilot'?json(path.join(copilotHome,'mcp-config.json'),true):{});
  if(settingsDocs.some(settings=>!settings||typeof settings!=='object'||Array.isArray(settings))||!mcp||typeof mcp!=='object'||Array.isArray(mcp))fail('Inherited controller configuration is malformed');
  if(settingsDocs.some(settings=>settings.hooks||settings.managed_hooks_path||Object.keys(settings.mcpServers??{}).length||Object.keys(settings.mcp_servers??{}).length||Object.keys(settings.providers??{}).length||Object.keys(settings.modelProviders??{}).length)||Object.keys(mcp).some(k=>k!=='mcpServers')||Object.keys(mcp.mcpServers??{}).length)fail('Inherited controller MCP/hooks/providers require a separate scoped configuration');
  env.PWD=files.workdir;
  if(route.harness==='copilot'){
    const prompt=readBounded(files.instructions,12000);if(!prompt||prompt.includes('\0')||prompt.length>12000)fail('Copilot controller instructions are unavailable or exceed the bounded argv limit');
    delete env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;env.COPILOT_PLUGIN_DIR_ONLY='true';env.COPILOT_AUTO_UPDATE='false';
    return {env,stdinFile:os.devNull,authSource:'copilot-api-overrides-cleared',args:['-C',files.workdir,'--model',/^auto$/i.test(route.model)?'auto':route.model,'--output-format','json','--no-ask-user','--no-color','--no-auto-update','--no-remote-export','--disable-builtin-mcps','--additional-mcp-config','@'+path.join(files.dir,'native-copilot.json'),'--available-tools','orch-controller_step','--allow-tool','orch','--log-level','none','--usage-output-file',path.join(files.dir,'copilot-usage.json'),'-p',prompt]};
  }
  if(route.harness==='muse'){
    const nativeAuth=path.join(museHome,'auth.json');if(source.MUSE_AUTH_PATH&&!samePath(path.resolve(source.MUSE_AUTH_PATH),nativeAuth))fail('Muse controller requires the native saved sign-in location');delete env.MUSE_AUTH_PATH;for(const k of Object.keys(env))if(k.toUpperCase()==='MUSE_TRANSPORT_TRACE')delete env[k];
    return {env,stdinFile:os.devNull,authSource:'muse-device-subscription',authFile:nativeAuth,args:['exec','--provider','meta','--json','--workspace',files.workdir,'--prompt-file',files.instructions,'--model',route.model,'--reasoning-effort','medium','--worktree','off','--approval-mode','never','--approval-judge','off','--disable-reminders','--disable-web-tools','--no-foreign-personal-context','--trust-workspace','--disable-write','--disable-shell','--no-session-log']};
  }
  fail('Unknown subscription controller profile');
}
function result(text){let out;try{out=JSON.parse(text);}catch{fail('Native step result is not structured');}if(!out||Array.isArray(out)||replayed(out))fail('Replayed or malformed native step cannot qualify');return out;}
function collect(out,id,markers,observed,toolCalls){
  if(typeof id!=='string'||!id||!STEPS.includes(out.step))fail('Native fixed step or call identity is missing');
  if(out.pending===true){if(out.marker)fail('Pending step contains a completion marker');return;}
  const hits=markers.filter(m=>JSON.stringify(out).includes(m));if(hits.length!==1||hits[0]!==out.marker||!out.marker.endsWith(':'+out.step))fail('Native step marker is missing, ambiguous or mismatched');
  observed.push(out.marker);toolCalls.push({id,step:out.step,marker:out.marker});
}
export function observeSubscriptionControllerTrace(events,o){
  const observed=[],toolCalls=[],used=new Set();let model,source,sessionId;
  if(o.harness==='copilot'){
    const terminals=events.filter(e=>e.type==='result');if(terminals.length!==1||terminals[0]!==events.at(-1)||terminals[0].exitCode!==0||typeof terminals[0].sessionId!=='string'||!terminals[0].sessionId)fail('Copilot native terminal session is missing or failed');sessionId=terminals[0].sessionId;
    const starts=new Map(),successful=new Set(),models=new Set();for(const e of events){if(e.agentId||e.data?.agentId)fail('Unexpected child agent in fixed controller trace');if(e.type==='session.error'||e.type==='turn.failed'||e.data?.isByok===true)fail('Native controller failed or used a foreign billing route');if(e.type==='model.call_start'){if(typeof e.data?.turnId!=='string'||starts.has(e.data.turnId)||typeof e.data.model!=='string')fail('Ambiguous native model call');starts.set(e.data.turnId,e.data.model);}if(e.type==='model.call_finished'){if(e.data?.outcome!=='success'||!starts.has(e.data.turnId)||successful.has(e.data.turnId))fail('Native model call failed or is unbound');successful.add(e.data.turnId);models.add(canonicalId(starts.get(e.data.turnId)));}}
    if(!successful.size||successful.size!==starts.size||models.size!==1)fail('Actual Copilot model is unknown or mixed');model=[...models][0];source='copilot-native-call-events';
    const calls=new Map();for(const e of events){if(e.sessionId&&e.sessionId!==sessionId)fail('Copilot native session changed');if(e.type==='tool.execution_start'){const d=e.data;if(d?.toolName!=='orch-controller_step'||typeof d.toolCallId!=='string'||calls.has(d.toolCallId)||!d.arguments||Object.keys(d.arguments).join(',')!=='step'||!STEPS.includes(d.arguments.step)||d.model&&canonicalId(d.model)!==model)fail('Native controller tool exceeds its fixed profile');calls.set(d.toolCallId,d.arguments.step);}if(e.type==='tool.execution_complete'){const d=e.data;if(d?.success!==true||!calls.has(d.toolCallId)||used.has(d.toolCallId))fail('Native tool result is failed, duplicated or unbound');used.add(d.toolCallId);const out=result(d.result?.content);if(out.step!==calls.get(d.toolCallId))fail('Native tool input/result step mismatch');collect(out,d.toolCallId,o.markers,observed,toolCalls);}}
    if(calls.size!==used.size)fail('Native tool call did not complete');
  }else if(o.harness==='muse'){
    const terminals=events.filter(e=>e.payload_type==='run.terminal.completed'),configs=events.filter(e=>e.payload_type==='run.model.configured');if(terminals.length!==1||configs.length!==1)fail('Muse terminal/model evidence is missing or ambiguous');const end=terminals[0],cfg=configs[0],runId=end.payload?.run_stream?.id;sessionId=end.stream?.id;
    if(end!==events.at(-1)||events.indexOf(cfg)>events.findIndex(e=>e.payload_type==='tool.result')||end.schema_version!==1||end.stream?.kind!=='session'||typeof sessionId!=='string'||typeof runId!=='string'||end.payload?.terminal!=='completed'||cfg.payload?.run_stream?.id!==runId||cfg.payload?.provider_id!=='meta'||typeof cfg.payload.model_id!=='string')fail('Muse runtime model/session evidence is invalid');model=canonicalId(cfg.payload.model_id);source='muse-runtime-model';
    for(const e of events){
      if(e.schema_version!==1||e.stream?.kind!=='session'||e.stream.id!==sessionId||e.payload?.run_stream&&e.payload.run_stream.id!==runId||['run.terminal.failed','runtime.command.rejected'].includes(e.payload_type))fail('Muse native session/run changed or failed');
      const taskKind=e.payload?.event?.task_kind;if(typeof taskKind==='string'&&taskKind.startsWith('tool.')&&taskKind!=='tool.mcp__orch__controller_step'||e.payload_type?.startsWith('tool.')&&e.payload_type!=='tool.result')fail('Muse native tool attempt exceeds its fixed profile');
      if(e.payload_type==='tool.result'){const p=e.payload;if(p.run_stream?.id!==runId||p.correlation_facts?.tool_name!=='mcp__orch__controller_step'||p.correlation_facts?.outcome!=='success'||used.has(p.call_id))fail('Muse native tool result exceeds its fixed profile');used.add(p.call_id);collect(result(p.text),p.call_id,o.markers,observed,toolCalls);}
    }
  }else fail('Unknown subscription controller trace');
  const automatic=o.harness==='copilot'&&/^auto$/i.test(o.model);if(!model||!automatic&&model!==canonicalId(o.model))fail('Actual controller model is unknown or mismatched');if(!isDeepStrictEqual(observed,o.markers))fail('Complete ordered native controller steps are missing');
  return {model,steps:observed.length,source,sessionId,profile:o.harness==='copilot'?'orch-controller_step':'mcp__orch__controller_step',toolCalls,...(automatic?{accessKind:'automatic-access'}:{})};
}
