// One-shot native subscription launch, with no retries, credential copying or kills.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {repositoryExecutionSpec} from './setup-repository-controller.mjs';
import {subscriptionControllerSpec} from './controller-subscriptions.mjs';
import {subscriptionEnvironment} from './setup-qualification.mjs';
import {ownChildCreationTime,creationTimesOf} from './procs.mjs';
import {REPOSITORY_TOOLS} from './repository-controller.mjs';
import {validateMuseSubscription} from './adapters/muse.mjs';
import {readBounded} from './adapters/subscription-cli.mjs';
import {createHash} from 'node:crypto';
async function main(){
 const [session,id,...extra]=process.argv.slice(2);if(extra.length)throw Error('Use one exact repository offer');let dir,runnerCreatedAt,stage='approval';
 const write=(name,data)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
 try{
  const {p,f,r}=repositoryExecutionSpec(session,id);dir=f.dir;const attempt=JSON.parse(fs.readFileSync(path.join(dir,'launch-attempt.json'),'utf8'));
  if(attempt.offerHash!==id||attempt.approve!==true||attempt.runnerHash!==createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'))throw Error('Native repository approval/source changed');
  stage='runner-identity';runnerCreatedAt=(await creationTimesOf([process.pid])).times[process.pid];if(!runnerCreatedAt)throw Error('Runner incarnation unknown');
  stage='subscription-auth';const spec=subscriptionControllerSpec(p.controller,{dir,workdir:r.workdir,instructions:f.instructions,repositoryTools:REPOSITORY_TOOLS},subscriptionEnvironment());
  if(p.controller.harness==='muse')validateMuseSubscription(JSON.parse(readBounded(spec.authFile,1048576).replace(/^\uFEFF/,'')));
  const handles=[fs.openSync(spec.stdinFile,'r'),fs.openSync(path.join(dir,'stdout.jsonl'),'wx'),fs.openSync(path.join(dir,'stderr.txt'),'wx')];
  stage='spawn';const startedAt=new Date().toISOString(),child=spawn(p.binding.exe,spec.args,{cwd:r.workdir,env:spec.env,windowsHide:true,shell:false,stdio:handles});handles.forEach(fd=>fs.closeSync(fd));
  let spawned=false;child.once('spawn',()=>{spawned=true;});const closed=new Promise(resolve=>{child.once('close',(code,signal)=>resolve({code,signal}));child.once('error',e=>resolve({code:null,signal:null,error:'code' in e?String(e.code):'unknown'}));});
  if(!Number.isInteger(child.pid)){const outcome=await closed;if(!spawned&&outcome.error){stage='spawn-refused';throw Error('Native process refused before spawn');}throw Error('Native process identity uncertain');}
  stage='controller-identity';const createdAt=await ownChildCreationTime(child.pid);write('launch.json',{offerHash:id,exe:p.binding.exe,pid:child.pid,createdAt,runnerPid:process.pid,runnerCreatedAt,profile:p.profile,workdir:r.workdir,instructionsHash:r.instructionsHash,authSource:spec.authSource,apiOverridesRemoved:true,intervened:false,startedAt});
  stage='completion';write('exit.json',{...await closed,endedAt:new Date().toISOString()});
 }catch{if(dir)try{write('runner-error.json',{offerHash:id,runnerPid:process.pid,runnerCreatedAt:runnerCreatedAt??null,stage,state:['spawn','controller-identity','completion'].includes(stage)?'uncertain':'preflight-refused',automaticRetries:0,at:new Date().toISOString()});}catch{}process.exitCode=2;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
