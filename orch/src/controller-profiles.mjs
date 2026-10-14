// Additional native profiles. Configuration is intent; native results prove operation.
import {isDeepStrictEqual} from 'node:util';
import {canonicalId} from './models.mjs';
import {samePath} from './git.mjs';
import {OrchError} from './errors.mjs';
import path from 'node:path';
import os from 'node:os';
import {isIP} from 'node:net';
import {aliasFor,mergeVibeConfig} from './adapters/vibe.mjs';
const fail=m=>{throw new OrchError(m,'controller-qualification-refused');};
export const MCP_CONTROLLERS=['vibe','opencode','copilot','muse'];
export const controllerWorkdir=(p,dir)=>MCP_CONTROLLERS.includes(p.controller.harness)?path.join(dir,'workspace'):p.smoke.workdir;
export function additionalProfileFiles(p,dir,commands,node,guard,server){
  const workdir=controllerWorkdir(p,dir),q=JSON.stringify,args=[server,p.session,p.offerHash],env={ORCH_CONFIG:p.smoke.configFile,...Object.fromEntries([...p.smoke.bindings,p.binding].map(b=>['ORCH_'+b.harness.toUpperCase()+'_EXE',b.exe])),...(p.smoke.roster.sha256?{ORCH_ROSTER:p.smoke.roster.file}:{})};
  if(['copilot','muse'].includes(p.controller.harness)){
    // Muse's MCP environment is explicit: child Python CLIs need home metadata.
    // Forward locations only; credentials and provider overrides stay excluded.
    const home=os.homedir(),locations={HOME:home,...(process.platform==='win32'?{USERPROFILE:home}:{}),VIBE_HOME:process.env.VIBE_HOME||path.join(home,'.vibe'),XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME||path.join(home,'.config')};
    return [{file:p.controller.harness==='copilot'?path.join(dir,'native-copilot.json'):path.join(workdir,'.mcp.json'),text:q({mcpServers:{orch:{type:'stdio',command:node,args,cwd:workdir,env:{...env,...locations},...(p.controller.harness==='copilot'?{tools:['controller_step']}:{required:true})}}})+'\n'}];
  }
  if(p.controller.harness==='vibe')return [
    {file:path.join(workdir,'.vibe','config.toml'),text:mergeVibeConfig('',{alias:aliasFor(p.controller.model),name:p.controller.model.split('/').pop(),provider:'mistral'})+`\n[[mcp_servers]]\nname = "orch"\ntransport = "stdio"\ncommand = ${q([node])}\nargs = ${q(args)}\ncwd = ${q(workdir)}\n[mcp_servers.env]\n${Object.entries(env).map(([k,v])=>k+' = '+q(v)).join('\n')}\n`},
    {file:path.join(workdir,'.vibe','agents','orch-controller.toml'),text:`description = "Owned controller qualification steps only"\nbypass_tool_permissions = false\nenabled_tools = ["orch_controller_step"]\n[tools.orch_controller_step]\npermission = "always"\n`}
  ];
  if(p.controller.harness==='opencode'){
    const local=validateControllerLocalProvider(p.controller,p.localProvider),model=p.controller.model.split('/').slice(1).join('/'),permission={'*':'deny',orch_controller_step:'allow'};
    return [{file:path.join(dir,'native-opencode.json'),text:JSON.stringify({model:p.controller.model,enabled_providers:[local.id],plugin:[],mcp:{orch:{type:'local',command:[node,...args],environment:env,enabled:true}},permission,agent:{'orch-controller':{mode:'primary',description:'Owned controller qualification',tools:{orch_controller_step:true,bash:false,read:false,edit:false,write:false,webfetch:false,task:false},permission}},provider:{[local.id]:{npm:'@ai-sdk/openai-compatible',name:'Explicit local controller',env:[],options:{baseURL:local.baseURL},models:{[model]:{name:model,limit:{context:local.context,output:local.output}}}}}},null,2)+'\n'}];
  }
  return [];
}
export function additionalControllerProfile(r){
  if(!(['vibe','copilot','muse'].includes(r.harness)&&r.billing==='subscription'||r.harness==='opencode'&&r.billing==='local'))fail('Additional controllers require saved subscriptions or an explicit OpenCode local route');
  return {version:4,mode:'native-cli',tools:[r.harness==='copilot'?'orch-controller_step':r.harness==='muse'?'mcp__orch__controller_step':'orch_controller_step'],effort:r.harness==='muse'?'medium':'provider-default',commandPolicy:'fixed-owned-step-tool'};
}
export function validateControllerLocalProvider(r,p){
  if(!p||Object.keys(p).sort().join(',')!=='baseURL,context,id,output'||p.id!==r.model.split('/')[0]||!r.model.includes('/')||!Number.isInteger(p.context)||p.context<4096||p.context>1048576||!Number.isInteger(p.output)||p.output<1024||p.output>p.context)fail('Use an explicit credential-free local controller provider');
  let url;try{url=new URL(p.baseURL);}catch{fail('Invalid local provider URL');}
  const host=url.hostname,privateHost=host==='localhost'||host==='[::1]'||isIP(host)===4&&(/^127\./.test(host)||/^10\./.test(host)||/^192\.168\./.test(host)||/^172\.(?:1[6-9]|2\d|3[01])\./.test(host));
  if(!privateHost||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('Local controller provider must be a credential-free private or loopback endpoint');
  return p;
}
export function observeAdditionalControllerTrace(events,o){
  if(!o.nativeModel||canonicalId(o.nativeModel)!==canonicalId(o.model))fail('Actual controller model is unknown or mismatched');
  const observed=[],toolCalls=[],used=new Set();let terminal=false;
  for(const e of events){
    let id,command,text;
    if(o.harness==='vibe'){
      if(e.sessionId!==o.sessionId)fail('Native Vibe session changed');
      if(e.type==='message'&&e.role==='assistant'&&e.generationStatus==='completed')terminal=true;
      if(e.type!=='effect'||!['orch_controller_step','mcp.orch.controller_step','mcp.orch_controller_step','mcp_orch.controller_step'].includes(e.detail?.toolName))continue;
      if(e.generationStatus!=='completed'||e.state?.status!=='completed')fail('Native controller step effect failed');
      id=e.id;command=e.detail.input?.step;text=JSON.stringify(e.state.output);
    }else if(o.harness==='opencode'){
      if(e.sessionID!==o.sessionId)fail('Native OpenCode session changed');
      if(e.type==='error')fail('Native OpenCode controller failed');
      if(e.type==='step_finish'&&e.part?.reason==='stop')terminal=true;
      if(e.type!=='tool_use'||e.part?.tool!=='orch_controller_step')continue;
      if(e.part.state?.status!=='completed')fail('Native controller step tool did not complete');
      id=e.part.callID;command=e.part.state.input?.step;text=String(e.part.state.output??'');
    }else fail('Unknown additional native profile');
    if(!['claim','worker','monitor-worker','reviewer','monitor-reviewer','finalize','record','finish'].includes(command))fail('Native tool exceeds its fixed lifecycle schema');
    const hits=o.markers.filter(m=>text.includes(m));if(hits.length>1||hits.length&&used.has(id)||typeof id!=='string')fail('Ambiguous native lifecycle tool call');
    if(hits.length){if(replayed(e.state?.output??e.part?.state?.output)||!hits[0].endsWith(':'+command))fail('Parent-assisted, replayed or mismatched operation cannot qualify');observed.push(hits[0]);toolCalls.push({id,step:command,marker:hits[0]});used.add(id);}
  }
  if(o.harness==='vibe')terminal=terminal&&events.at(-1)?.type==='message'&&events.at(-1)?.role==='assistant';
  if(!terminal||!isDeepStrictEqual(observed,o.markers))fail('Complete ordered terminal native tool evidence is missing');
  return {model:canonicalId(o.nativeModel),steps:observed.length,source:'native-tool-trace',profile:'orch_controller_step',toolCalls};
}
const replayed=x=>typeof x==='string'?/"replayed"\s*:\s*true/.test(x):x&&typeof x==='object'?(x.replayed===true||Object.values(x).some(replayed)):false;
export function openCodeExportModel(doc,o){
  if(doc.info?.id!==o.sessionId||!samePath(doc.info.directory,o.workdir)||!Number.isFinite(doc.info.time?.created)||doc.info.time.created<o.started-5000||doc.info.time.created>o.ended)fail('OpenCode export session/directory/time is unbound');
  const assistants=doc.messages?.filter(m=>m.info?.role==='assistant');if(!assistants?.length)fail('OpenCode assistant model evidence missing');
  const models=new Set();for(const m of assistants){const i=m.info;if(i.sessionID!==o.sessionId||!samePath(i.path?.cwd,o.workdir)||!i.modelID||!i.providerID||!Number.isFinite(i.time?.created)||!Number.isFinite(i.time?.completed)||i.time.created<o.started-5000||i.time.completed>o.ended||i.time.completed<i.time.created||i.error)fail('OpenCode actual assistant model evidence is unbound');models.add(i.providerID+'/'+i.modelID);}
  if(models.size!==1||[...models][0]!==o.model||assistants.at(-1).info.finish!=='stop')fail('OpenCode actual model or terminal evidence mismatched');return [...models][0];
}
