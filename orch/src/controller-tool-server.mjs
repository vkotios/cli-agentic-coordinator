// One approved trial, one native MCP tool, fixed lifecycle inputs only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {controllerNativeToolSpec,controllerStep} from './setup-controller.mjs';
import {checkedSetupPath} from './setup.mjs';
import {creationTimesOf} from './procs.mjs';
import {withOperationLock} from './resources.mjs';
export const CONTROLLER_STEPS=['claim','worker','monitor-worker','reviewer','monitor-reviewer','finalize','record','finish'];
export const controllerToolDefinition={name:'controller_step',description:'Perform one approved owned lifecycle step. Poll unfinished monitor steps; stop after any refused or uncertain mutation.',inputSchema:{type:'object',additionalProperties:false,required:['step'],properties:{step:{type:'string',enum:CONTROLLER_STEPS}}}};
export async function invokeControllerTool(session,id,args,seams={}){
  if(!args||Object.keys(args).length!==1||!CONTROLLER_STEPS.includes(args.step))throw Error('Use only the fixed lifecycle step');
  const spec=controllerNativeToolSpec(session,id,seams),result=await controllerStep(session,{offerHash:id,approve:true,step:args.step},seams);
  await withOperationLock({stateRoot:spec.files.dir},'native-tool-audit',async()=>{
    const file=path.join(spec.files.dir,'native-tool-events.ndjson');checkedSetupPath(path.dirname(file),true);try{const leaf=fs.lstatSync(file);if(!leaf.isFile()||leaf.isSymbolicLink()||leaf.nlink!==1)throw Error('Unsafe native tool audit');}catch(e){if(e.code!=='ENOENT')throw e;}
    const fd=fs.openSync(file,'a',0o600);try{fs.writeFileSync(fd,JSON.stringify({at:new Date().toISOString(),requestId:crypto.randomBytes(16).toString('hex'),step:args.step,marker:result.marker??null,pending:result.pending===true,replayed:result.replayed===true})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  });
  return result;
}
async function main(){
  const [session,id,...extra]=process.argv.slice(2);if(extra.length)throw Error('Use one bound native controller trial');const spec=controllerNativeToolSpec(session,id),createdAt=(await creationTimesOf([process.pid])).times[process.pid];if(!createdAt)throw Error('Native tool process identity unknown');
  const connections=path.join(spec.files.dir,'native-tool-servers'),record=path.join(connections,process.pid+'-'+crypto.randomBytes(16).toString('hex')+'.json');
  await withOperationLock({stateRoot:spec.files.dir},'native-tool-connection',async()=>{checkedSetupPath(connections,true);fs.mkdirSync(connections,{recursive:true,mode:0o700});if(fs.readdirSync(connections).filter(n=>/^\d+-[a-f0-9]{32}\.json$/.test(n)).length>=128)throw Error('Native tool connection evidence bound reached');fs.writeFileSync(record,JSON.stringify({offerHash:id,pid:process.pid,createdAt,startedAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});});
  const server=new Server({name:'orch-controller',version:'1.0.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[controllerToolDefinition]}));
  server.setRequestHandler(CallToolRequestSchema,async r=>{if(r.params.name!=='controller_step')throw Error('Unknown controller tool');try{const out=await invokeControllerTool(session,id,r.params.arguments);return {content:[{type:'text',text:JSON.stringify(out)}],structuredContent:out};}catch{return {isError:true,content:[{type:'text',text:'Controller step refused or uncertain; inspect retained evidence and stop this trial'}]};}});
  server.onclose=()=>{fs.writeFileSync(record.replace(/\.json$/,'.exit.json'),JSON.stringify({code:0,endedAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});process.exit(0);};
  await server.connect(new StdioServerTransport());
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
