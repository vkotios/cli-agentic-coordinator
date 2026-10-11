// Optional typed advice. No endpoint override, inference fallback or launch authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {setting} from './config.mjs';
import {OrchError} from './errors.mjs';
import {resolvedPath,withOperationLock} from './resources.mjs';
import {writeJsonAtomic} from './util.mjs';
import {selectRouting,adviceShortlist,applyRoutingAdvice} from './routing.mjs';

const KEY_URL='https://openrouter.ai/api/v1/key',DECISIONS_URL='https://openrouter.ai/api/alpha/decisions';
const MAX_BYTES=65536;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const fail=()=>{throw new OrchError('Invalid bounded adviser policy; use private env key reference and pinned model','bad-adviser-policy');};
const bound=(value,min,max)=>{if(!finite(value)||value<min||value>max)fail();return value;};
const contract=policy=>hash([policy.model,policy.responseModel,policy.maxRequests,policy.maxSpendUsd,policy.reservePerRequestUsd,policy.maxPricePerMillion]);
export function validateAdviserPolicy(raw,baseDir){
  const allowed=new Set(['version','enabled','mode','keyEnv','model','responseModel','stateRoot','timeoutMs','maxRequests','maxSpendUsd','reservePerRequestUsd','maxPricePerMillion']);
  if(!raw||raw.version!==1||typeof raw.enabled!=='boolean'||Object.keys(raw).some(k=>!allowed.has(k)))fail();
  if(!raw.enabled)return {version:1,enabled:false};
  if(!['shadow','assist'].includes(raw.mode)||typeof raw.keyEnv!=='string'||!/^[A-Z][A-Z0-9_]{2,63}$/.test(raw.keyEnv)||typeof raw.model!=='string'||!/^typesafe\/jev-\d+\.\d+(?:-\d{8})?$/.test(raw.model)||typeof raw.responseModel!=='string'||!/^typesafe\/jev-\d+\.\d+-\d{8}$/.test(raw.responseModel)||(raw.responseModel!==raw.model&&!raw.responseModel.startsWith(raw.model+'-'))||typeof raw.stateRoot!=='string'||!raw.stateRoot)fail();
  const maxRequests=bound(raw.maxRequests,1,100000);if(!Number.isInteger(maxRequests))fail();
  const maxSpendUsd=bound(raw.maxSpendUsd,0.000001,100),reservePerRequestUsd=bound(raw.reservePerRequestUsd,0.000001,maxSpendUsd);
  if(!raw.maxPricePerMillion||Object.keys(raw.maxPricePerMillion).sort().join(',')!=='completion,prompt')fail();
  return {version:1,enabled:true,mode:raw.mode,keyEnv:raw.keyEnv,model:raw.model,responseModel:raw.responseModel,stateRoot:path.resolve(baseDir,raw.stateRoot),timeoutMs:bound(raw.timeoutMs,25,5000),maxRequests,maxSpendUsd,reservePerRequestUsd,maxPricePerMillion:{prompt:bound(raw.maxPricePerMillion.prompt,0,100),completion:bound(raw.maxPricePerMillion.completion,0,100)}};
}
export function adviserPolicy(args){
  const file=args['advice-policy']??setting('ORCH_ADVICE_POLICY','advicePolicy',null,{isPath:true});
  if(!file)return null;
  try{const stat=fs.statSync(file);if(!stat.isFile()||stat.size>MAX_BYTES)fail();return validateAdviserPolicy(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')),path.dirname(path.resolve(file)));}catch(e){if(e instanceof OrchError)throw e;fail();}
}
function budgetRead(file,policy){
  if(path.resolve(file)!==resolvedPath(file))throw new Error('unsafe');
  let state;
  try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_BYTES)throw new Error('unsafe');state=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {version:1,contract:contract(policy),requests:0,spentUsd:0,reservedUsd:0,uncertain:false,last:null};throw e;}
  if(state.version!==1||state.contract!==contract(policy)||!Number.isInteger(state.requests)||state.requests<0||state.requests>100000||!finite(state.spentUsd)||!finite(state.reservedUsd)||typeof state.uncertain!=='boolean'||Object.keys(state).sort().join(',')!=='contract,last,requests,reservedUsd,spentUsd,uncertain,version')throw new Error('invalid');
  return state;
}
function budgetWrite(file,policy,previous,next){
  if(JSON.stringify(budgetRead(file,policy))!==JSON.stringify(previous)||Buffer.byteLength(JSON.stringify(next))>MAX_BYTES)throw new Error('changed');
  writeJsonAtomic(file,next);
}
function abortable(promise,signal){
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new Error('adviser-aborted'));
    if(signal.aborted)return abort();
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
async function jsonResponse(url,options,fetchImpl,signal){
  if(signal.aborted)throw new Error('adviser-aborted');
  const response=await abortable(fetchImpl(url,{...options,redirect:'error',signal}),signal);
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new Error('provider-failure');}
  const reader=response.body?.getReader();if(!reader)throw new Error('invalid-response');
  const chunks=[];let size=0;
  try{while(true){const item=await abortable(reader.read(),signal);if(item.done)break;size+=item.value.byteLength;if(size>MAX_BYTES)throw new Error('response-too-large');chunks.push(Buffer.from(item.value));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch(e){void reader.cancel().catch(()=>{});if(e.message==='response-too-large')throw e;throw new Error('invalid-response');}
}
export function buildAdviceRequest(policy,decision,profiles){
  const criteria=Object.fromEntries(profiles.map((p,i)=>['c'+(i+1),{classes:p.supports.classes,risks:p.supports.risks,contextTokens:p.supports.contextTokens,toolCount:p.supports.tools.length,modalities:p.supports.modalities,costRank:p.costRank,latencyRank:p.latencyRank}]));
  criteria.abstain='Use deterministic selection if these declared descriptors do not support a useful distinction.';
  const task=decision.task;
  const body={model:policy.model,provider:{only:['TypeSafe'],allow_fallbacks:false,max_price:policy.maxPricePerMillion},state:{type:task.type,class:decision.requiredClass,size:task.size,risk:task.risk,contextTokens:task.contextTokens,requiredToolCount:task.tools.length,modalities:task.modalities},questions:{route:{type:'choice',instructions:'Choose one of the permitted execution profiles for this task using only the declared capability descriptors. All candidates already satisfy mandatory eligibility, review independence, quota pacing and preference rules. Abstain when no useful distinction is available.',criteria}}};
  if(profiles.length<2||profiles.length>32||Buffer.byteLength(JSON.stringify(body))>16384)throw new Error('request-too-large');
  return body;
}
function usage(raw){const u=raw?.usage;return u&&finite(u.cost)&&Number.isInteger(u.input_tokens)&&u.input_tokens>=0&&u.input_tokens<=1000000&&Number.isInteger(u.output_tokens)&&u.output_tokens>=0&&u.output_tokens<=1000000?{cost:u.cost,inputTokens:u.input_tokens,outputTokens:u.output_tokens}:null;}
export function parseAdviceResponse(raw,policy,profiles){
  if(raw?.model!==policy.responseModel||raw.provider!=='TypeSafe'||raw.answers?.route?.type!=='choice'||!usage(raw))throw new Error('invalid-response');
  const choice=raw.answers.route.choice;
  if(choice==='abstain')return null;
  const index=profiles.findIndex((p,i)=>choice==='c'+(i+1));if(index<0)throw new Error('invalid-response');return profiles[index].id;
}
/** @param {any} input Trusted imported-function fetch/env seams are for offline tests only. */
export async function adviseRouting({policy,decision,routingContext,fetchImpl=fetch,env=process.env}){
  const receipt={status:'fallback',reason:'not-configured',mode:policy?.mode??null,provider:'OpenRouter',model:null,deterministicProfile:decision.profile?.id??null,selectedProfile:null,applied:false,paidAttempt:false};
  const finish=(reason,status='fallback',advice={})=>({decision,advice:{...receipt,...advice,status,reason}});
  if(!policy)return finish('not-configured');
  if(!policy.enabled)return finish('disabled','disabled');
  if(decision.status!=='selected'||decision.mode!=='qualified')return finish('no-qualified-selection');
  const profiles=adviceShortlist(decision,routingContext.policy);if(profiles.length<2)return finish('single-choice');
  const key=env[policy.keyEnv];if(typeof key!=='string'||!/^[A-Za-z0-9_-]{16,256}$/.test(key))return finish('missing-key');
  let body;try{body=buildAdviceRequest(policy,decision,profiles);}catch{return finish('request-too-large');}
  const text=JSON.stringify(body);if(text.includes(key))return finish('unsafe-request');
  const fingerprint=hash(['OpenRouter',key]),file=path.join(policy.stateRoot,'adviser',fingerprint+'.json');
  const requestId=crypto.randomUUID(),requestSha256=hash(body),headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
  try{return await withOperationLock({stateRoot:policy.stateRoot},'adviser:'+fingerprint,async()=>{
    let state=budgetRead(file,policy);
    const budget=()=>({requests:state.requests,spentUsd:state.spentUsd,reservedUsd:state.reservedUsd,uncertain:state.uncertain});
    if(state.uncertain)return finish('budget-uncertain','fallback',{budget:budget()});
    if(state.requests>=policy.maxRequests)return finish('request-limit','fallback',{budget:budget()});
    if(state.spentUsd+state.reservedUsd+policy.reservePerRequestUsd>policy.maxSpendUsd+1e-12)return finish('spend-limit','fallback',{budget:budget()});
    const save=next=>{budgetWrite(file,policy,state,next);state=next;};
    save({...state,reservedUsd:state.reservedUsd+policy.reservePerRequestUsd});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),policy.timeoutMs);let paid=false;
    /** @type {any} */ let out;
    try{
      const keyInfo=await jsonResponse(KEY_URL,{method:'GET',headers},fetchImpl,controller.signal),data=keyInfo?.data;
      if(!finite(data?.limit)||data.limit<=0||data.limit>policy.maxSpendUsd||data.limit_reset!==null||!finite(data.limit_remaining)||data.limit_remaining<policy.reservePerRequestUsd)out=finish('key-budget-unavailable');
      else{
        save({...state,requests:state.requests+1});paid=true;
        const raw=await jsonResponse(DECISIONS_URL,{method:'POST',headers,body:text},fetchImpl,controller.signal),u=usage(raw);
        if(!u){save({...state,uncertain:true});out=finish('invalid-response');}
        else{
          save({...state,spentUsd:state.spentUsd+u.cost,reservedUsd:Math.max(0,state.reservedUsd-policy.reservePerRequestUsd),uncertain:u.cost>policy.reservePerRequestUsd});
          if(state.uncertain)out=finish('cost-overrun');
          else{
            const selected=parseAdviceResponse(raw,policy,profiles);
            if(!selected)out=finish('abstained');
            else{
              const applied=applyRoutingAdvice(routingContext,selected);
              if(!applied.accepted){decision=applied.decision;out=finish('selection-changed');}
              else out={decision:policy.mode==='assist'?applied.decision:selectRouting(routingContext),advice:{...receipt,status:'suggested',reason:policy.mode==='assist'?'validated-tie-break':'shadow-only',model:policy.responseModel,selectedProfile:selected,applied:policy.mode==='assist',usage:u}};
            }
          }
        }
      }
    }catch(e){out=finish(controller.signal.aborted?'timeout':['invalid-response','response-too-large'].includes(e.message)?e.message:'provider-failure');}
    finally{clearTimeout(timer);}
    if(!paid)save({...state,reservedUsd:Math.max(0,state.reservedUsd-policy.reservePerRequestUsd)});
    // A failed or shadow response must not return an expired deterministic proposal.
    if(!out.advice.applied)out.decision=selectRouting(routingContext);
    out.advice={...out.advice,paidAttempt:paid,...(paid?{requestId,requestSha256}:{}),budget:budget()};
    save({...state,last:out.advice});return out;
  });}catch{decision=selectRouting(routingContext);return finish('budget-unavailable','fallback',{paidAttempt:null});}
}
