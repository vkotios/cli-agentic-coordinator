// Copilot prompt-mode JSONL; native call usage is separate from model selection.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {resolveCliExe} from '../exe.mjs';
import {canonicalId,assertModelPermitted} from '../models.mjs';
import {OrchError} from '../errors.mjs';
import {validateRequest as validateCommon,readBounded,parseJsonl,modelResult,deletedEnvironment,subscriptionStatusRules,validateNativeArgv} from './subscription-cli.mjs';
export function copilotStoreCandidates(env=process.env){return env.LOCALAPPDATA?[path.join(env.LOCALAPPDATA,'GitHubCopilotCLI','copilot.exe')]:[];}
export function resolveCopilotExe(){return resolveCliExe('copilot',{fallbacks:copilotStoreCandidates});}
const isAuto=model=>typeof model==='string'&&/^auto$/i.test(model);
function validateRequest(ctx){validateCommon(isAuto(ctx.model)?{...ctx,model:'example-explicit-auto'}:ctx);if(ctx.maxTurns!=null)throw new OrchError('--max-turns is not supported by Copilot; autopilot continuations are not model turns','unsupported-limit');if(ctx.effort==='ultra'||isAuto(ctx.model)&&ctx.effort)throw new OrchError('Copilot Auto does not accept reasoning effort; explicit models accept supported effort levels','bad-effort');}
export default {
  name:'copilot',lane:'cloud',needsModel:true,heartbeatStream:'stdout',directoryEvidence:false,
  canonicalModel:canonicalId,validateRequest,
  preLaunch(ctx){validateRequest(ctx);assertModelPermitted(ctx.model,!!ctx.ownerApprovedModel);this.build({...ctx,promptPath:ctx.launchPromptPath||ctx.promptPath});return {notes:['Saved subscription route; no automatic API fallback'],extra:{}};},
  build(ctx){
    validateRequest(ctx);
    const prompt=ctx.promptBuffer!=null?ctx.promptBuffer.toString('utf8'):fs.readFileSync(ctx.promptPath,'utf8');
    if(prompt.includes('\0')||prompt.length>12000)throw new OrchError('Copilot prompt contains NUL or exceeds the bounded Windows argv limit (12000 characters)','bad-handoff');
    const args=['-C',ctx.dir,'--model',isAuto(ctx.model)?'auto':ctx.model,...(ctx.effort?['--reasoning-effort',ctx.effort]:[]),'--output-format','json','--no-ask-user','--no-color','--no-auto-update','--no-remote-export','--disable-builtin-mcps','--available-tools',ctx.role==='review'?'view,glob,grep':'view,glob,grep,edit,create,powershell,bash','--allow-all-tools','--log-level','none','--usage-output-file',path.join(ctx.runDir||path.dirname(ctx.promptPath),'copilot-usage.json'),'-p',prompt];
    const empty=os.devNull;
    const file=resolveCopilotExe();validateNativeArgv(file,args);
    return {file,args,cwd:ctx.dir,envSet:{PWD:ctx.dir,COPILOT_AUTO_UPDATE:'false',COPILOT_ALLOW_ALL:'1'},envDelete:deletedEnvironment(['COPILOT_PROVIDER_'],['COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN','COPILOT_MODEL','COPILOT_OFFLINE','COPILOT_ASSISTED_APPROVAL','NODE_OPTIONS']),stdinFile:empty,notes:['Direct native Copilot executable; prompt on bounded argv, stdin empty','Reviewer exposes only view/glob/grep; this tool restriction is not an OS sandbox']};
  },
  parseProtocol(stdout){return parseJsonl(stdout).map(e=>e.type==='session.error'?{...e,message:e.data?.message??e.message}:e);},
  extractFinalMessage(stdout){const events=parseJsonl(stdout).filter(e=>e.type==='assistant.message'&&!e.agentId&&!e.data?.agentId&&typeof e.data?.content==='string');return events.at(-1)?.data.content.trim()||'';},
  postExit(ctx){
    const events=parseJsonl(readBounded(ctx.stdoutPath)),root=events.filter(e=>!e.agentId&&!e.data?.agentId);
    const models=root.filter(e=>e.type==='assistant.usage'&&!e.data?.initiator&&e.data?.isByok!==true).map(e=>e.data?.model);
    const successful=new Set(root.filter(e=>e.type==='model.call_finished'&&e.data?.outcome==='success').map(e=>e.data?.turnId).filter(x=>typeof x==='string'));
    models.push(...root.filter(e=>e.type==='model.call_start'&&successful.has(e.data?.turnId)).map(e=>e.data?.model));
    let usage;try{usage=JSON.parse(readBounded(path.join(ctx.runDir,'copilot-usage.json'),1048576));}catch{/* Missing usage never proves a model. */}
    if(usage?.agentMetrics?.main?.modelMetrics)for(const [model,row]of Object.entries(usage.agentMetrics.main.modelMetrics))if(Number.isFinite(row?.requests?.count)&&row.requests.count>0)models.push(model);
    return modelResult(models,ctx.requestedCanonical,'copilot-native-call-usage');
  },
  statusRules:subscriptionStatusRules,
};
