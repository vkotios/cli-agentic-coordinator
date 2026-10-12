// Only the prepared complete step commands may execute in a native Claude trial.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {checkedSetupPath,readSetupInput} from './setup.mjs';

export function controllerCommandDecision(input,policy){
  const command=input?.tool_input?.command;
  const allowed=input?.tool_name==='Bash'&&typeof command==='string'&&Array.isArray(policy?.commands)&&policy.commands.length>0&&policy.commands.length<=8&&policy.commands.every(c=>typeof c==='string')&&policy.commands.includes(command);
  return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:allowed?'allow':'deny',permissionDecisionReason:allowed?'Exact approved controller step':'Only exact prepared controller step commands are permitted'}};
}
async function main(){
  let decision=controllerCommandDecision({},null),raw='';
  try{
    for await(const chunk of process.stdin){raw+=chunk.toString('utf8');if(Buffer.byteLength(raw)>65536)throw Error('input-bound');}
    const file=process.env.ORCH_CONTROLLER_COMMAND_POLICY;checkedSetupPath(file);
    const bytes=fs.readFileSync(file);if(bytes.length>65536||crypto.createHash('sha256').update(bytes).digest('hex')!==process.env.ORCH_CONTROLLER_COMMAND_POLICY_SHA)throw Error('policy-changed');
    const policy=readSetupInput(file,{max:65536}).raw;if(policy.offerHash!==process.env.ORCH_CONTROLLER_OFFER_HASH)throw Error('offer-changed');
    const input=JSON.parse(raw);decision=controllerCommandDecision(input,policy);
    const audit=path.join(path.dirname(file),'guard-events.ndjson');checkedSetupPath(path.dirname(audit),true);try{const leaf=fs.lstatSync(audit);if(!leaf.isFile()||leaf.isSymbolicLink()||leaf.nlink>1)throw Error('audit-unsafe');}catch(e){if(e.code!=='ENOENT')throw e;}
    fs.appendFileSync(audit,JSON.stringify({at:new Date().toISOString(),toolUseId:input.tool_use_id??null,commandHash:crypto.createHash('sha256').update(String(input.tool_input?.command??'')).digest('hex'),decision:decision.hookSpecificOutput.permissionDecision})+'\n',{mode:0o600});
  }catch{decision=controllerCommandDecision({},null);}
  process.stdout.write(JSON.stringify(decision));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
