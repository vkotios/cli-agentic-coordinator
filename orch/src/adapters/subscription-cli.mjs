import fs from 'node:fs';
import {OrchError} from '../errors.mjs';
import {canonicalId,assertModelPermitted} from '../models.mjs';
import {protocolErrorText} from '../statusrules.mjs';
export const EFFORTS=['none','minimal','low','medium','high','xhigh','max','ultra'];
export function validateRequest(ctx){
  if(typeof ctx.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._/-]{1,199}$/.test(ctx.model)||['auto','default','sonnet','opus','haiku','gpt','gemini'].includes(canonicalId(ctx.model)))throw new OrchError('An exact model selector is required; automatic/family aliases are not supported','bad-model');
  if(ctx.flags?.length)throw new OrchError('Extra --flag values are not supported: model, billing, prompt and role policy are owned by orch','forbidden-flag');
  if(ctx.agent)throw new OrchError('Custom --agent is not supported for these scoped adapters','forbidden-agent');
  if(ctx.maxPrice!=null)throw new OrchError('--max-price is not a subscription quota limit','bad-price');
  if(ctx.effort&&!EFFORTS.includes(ctx.effort))throw new OrchError('Invalid reasoning effort','bad-effort');
}
export function preflight(ctx){validateRequest(ctx);assertModelPermitted(ctx.model,!!ctx.ownerApprovedModel);return {notes:['Saved subscription route; no automatic API fallback'],extra:{}};}
export function readBounded(file,max=64*1024*1024){try{const st=fs.statSync(file);return st.isFile()&&st.size<=max?fs.readFileSync(file,'utf8'):'';}catch{return '';}}
export function parseJsonl(text){const out=[];for(const line of String(text||'').split(/\r?\n/)){try{const e=JSON.parse(line);if(e&&typeof e==='object'&&!Array.isArray(e))out.push(e);}catch{/* partial/non-JSON diagnostics */}}return out;}
export function modelResult(models,requested,source){const unique=[...new Set(models.filter(x=>typeof x==='string'&&x.trim()).map(canonicalId))];const model=unique.length===1?unique[0]:null,mismatch=model&&requested&&canonicalId(requested)!=='auto'?model!==canonicalId(requested):undefined;return {actual_model:model,actual_model_source:model?source:'none',model_mismatch:mismatch,warnings:model?(mismatch?['MODEL MISMATCH: native usage reported another model']:[]):['Native model identity is unknown or ambiguous; requested/configured model is not proof']};}
export function deletedEnvironment(prefixes,exact=[]){return [...new Set([...exact,...Object.keys(process.env).filter(k=>prefixes.some(p=>k.toUpperCase().startsWith(p))||exact.some(x=>x.toUpperCase()===k.toUpperCase()))])];}
export function validateNativeArgv(file,args){if(typeof file!=='string'||!file||file.includes('\0')||(process.platform==='win32'?!/\.exe$/i.test(file):/\.(cmd|bat|ps1)$/i.test(file))||args.some(a=>typeof a!=='string'||a.includes('\0'))||args.reduce((n,a)=>n+(process.platform==='win32'?a.length*2+3:Buffer.byteLength(a)+1),file.length*2+3)>30000)throw new OrchError('These adapters require a direct executable and bounded arguments','bad-native-launch');}
export const subscriptionStatusRules=[
  {name:'subscription-quota',test:o=>o.exitCode!==0&&/usage limit|quota exceeded|insufficient credit|rate limit|credits exhausted/i.test(o.stderr+'\n'+protocolErrorText(o.events)),status:'blocked-quota',reason:'provider-quota'},
  {name:'subscription-auth',test:o=>o.exitCode!==0&&/not authenticated|no authentication information|authentication failed|unauthorized|sign in required|subscription required/i.test(o.stderr+'\n'+protocolErrorText(o.events)),status:'blocked-auth',reason:'provider-auth'},
];
