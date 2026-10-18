// Ordinary orch tools with offer-specific schemas and unchanged CLI dispatch.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {repositoryExecutionSpec,repositoryToolList,invokeRepositoryFromFile} from './setup-repository-controller.mjs';
import {creationTimesOf} from './procs.mjs';
import {repositoryNativeResult} from './repository-controller.mjs';
import {checkedSetupPath} from './setup.mjs';
import {subscriptionEnvironment} from './setup-qualification.mjs';
async function main(){
 const [session,id,...extra]=process.argv.slice(2);if(extra.length)throw Error('Use one exact repository offer');
 const {p,f,r}=repositoryExecutionSpec(session,id),birth=(await creationTimesOf([process.pid])).times[process.pid];if(!birth)throw Error('Repository tool process identity unknown');
 const env=subscriptionEnvironment();for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env,{ORCH_CONFIG:f.runtime});
 const dir=path.join(f.dir,'connections');checkedSetupPath(dir,true);fs.mkdirSync(dir,{recursive:true,mode:0o700});if(fs.readdirSync(dir).length>=128)throw Error('Repository tool connection bound reached');
 fs.writeFileSync(path.join(dir,process.pid+'-'+crypto.randomBytes(16).toString('hex')+'.json'),JSON.stringify({offerHash:id,pid:process.pid,createdAt:birth,startedAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
 const server=new Server({name:'orch',version:'1.0.0'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:repositoryToolList(p,r)}));
 server.setRequestHandler(CallToolRequestSchema,async request=>{
  try{const out=await invokeRepositoryFromFile(p.session,id,request.params.name,request.params.arguments??{});return {content:[{type:'text',text:JSON.stringify(repositoryNativeResult(out))}],structuredContent:out.structuredContent};}
  catch{return {isError:true,content:[{type:'text',text:'Repository call refused or uncertain. Stop and inspect the retained offer and journal; do not repeat a mutation.'}]};}
 });
 await server.connect(new StdioServerTransport());
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
