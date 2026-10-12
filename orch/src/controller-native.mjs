// One ephemeral, approved native controller process. No scheduler, retry or tree kill.
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {controllerExecutionSpec} from './setup-controller.mjs';
import {subscriptionEnvironment} from './setup-qualification.mjs';
import {ownChildCreationTime,creationTimesOf} from './procs.mjs';
import {fileURLToPath} from 'node:url';

export async function nativeControllerIdentity(){const observed=await creationTimesOf([process.pid]);return observed.times[process.pid]??null;}
async function main(){
const [session,id]=process.argv.slice(2);
let directory,stage='approval';
const write=(name,value)=>fs.writeFileSync(path.join(directory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
try{
  const spec=controllerExecutionSpec(session,id),p=spec.plan,f=spec.files;directory=f.dir;
  const env=subscriptionEnvironment();env.ORCH_CONFIG=p.smoke.configFile;
  for(const b of [...p.smoke.bindings,p.binding])env[`ORCH_${b.harness.toUpperCase()}_EXE`]=b.exe;
  if(p.smoke.roster.sha256)env.ORCH_ROSTER=p.smoke.roster.file;
  stage='subscription-auth';let authSource,args;
  if(p.controller.harness==='claude'){
    const auth=JSON.parse(execFileSync(p.binding.exe,['auth','status','--json'],{env,cwd:p.smoke.workdir,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:65536}));
    if(!auth.loggedIn||auth.authMethod!=='claude.ai'||auth.apiKeySource)throw Error('subscription-auth-refused');authSource='claude.ai';
    env.ORCH_CONTROLLER_COMMAND_POLICY=path.join(directory,'command-policy.json');env.ORCH_CONTROLLER_COMMAND_POLICY_SHA=JSON.parse(fs.readFileSync(f.prepared,'utf8')).policyHash;env.ORCH_CONTROLLER_OFFER_HASH=id;
    args=['-p','--model',p.controller.model,'--effort','medium','--output-format','stream-json','--verbose','--tools','Bash','--permission-mode','default','--settings',path.join(directory,'native-settings.json'),'--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--max-turns','80'];
  }else{
    const result=spawnSync(p.binding.exe,['login','status'],{env,cwd:p.smoke.workdir,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
    if(result.status!==0||!/(?:^|\r?\n)Logged in using ChatGPT(?:\r?\n|$)/.test((result.stderr??'')+(result.stdout??'')))throw Error('subscription-auth-refused');authSource='ChatGPT';
    args=['exec','-m',p.controller.model,'-c','model_reasoning_effort=medium','-c','model_provider="openai"','-c','sandbox_workspace_write.writable_roots='+JSON.stringify([p.smoke.trialRoot]),'--sandbox','workspace-write','--json','--cd',p.smoke.workdir,'-'];
  }
  stage='runner-identity';const runnerCreatedAt=await nativeControllerIdentity();if(!runnerCreatedAt)throw Error('native-runner-identity-unknown');
  const handles=[fs.openSync(f.instructions,'r'),fs.openSync(path.join(directory,'stdout.jsonl'),'wx'),fs.openSync(path.join(directory,'stderr.txt'),'wx')];
  stage='spawn';const startedAt=new Date().toISOString(),child=spawn(p.binding.exe,args,{cwd:p.smoke.workdir,env,windowsHide:true,shell:false,stdio:handles});handles.forEach(fd=>fs.closeSync(fd));
  const closed=new Promise(resolve=>{child.once('close',(code,signal)=>resolve({code,signal}));child.once('error',()=>resolve({code:null,signal:null}));});
  stage='controller-identity';const createdAt=await ownChildCreationTime(child.pid);
  write('launch.json',{offerHash:id,exe:p.binding.exe,pid:child.pid,createdAt,runnerPid:process.pid,runnerCreatedAt,profile:p.profile,instructionsHash:spec.instructionsHash,authSource,apiOverridesRemoved:true,intervened:false,startedAt});
  stage='completion';const outcome=await closed;write('exit.json',{...outcome,endedAt:new Date().toISOString()});
}catch{
  if(directory){try{write('runner-error.json',{state:['spawn','controller-identity','completion'].includes(stage)?'uncertain':'preflight-refused',stage,reason:'native-launch-or-authentication-unverified',controllerLaunchAttempted:['spawn','controller-identity','completion'].includes(stage),at:new Date().toISOString(),automaticRetries:0});}catch{}}
  process.exitCode=1;
}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
