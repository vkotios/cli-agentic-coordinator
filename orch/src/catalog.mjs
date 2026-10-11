// Generic source-backed metadata. Preview only: no fetching, execution or writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {REPO_ROOT,setting} from './config.mjs';
import {OrchError} from './errors.mjs';

const LIMIT=1048576,MAX_MODELS=512,MAX_SOURCES=512;
const ID=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SELECTOR=/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$/;
const FIELDS=['name','model','status','aliases','contextTokens','inputModalities','outputModalities','toolCalling','pricing','routes'];
const MODALITIES=['text','image','audio','video','file','document','speech','transcription','embeddings','rerank','decisions'];
export const SOURCE_POLICY_VERSION=1;
export const SOURCE_ALLOWLIST={
  aggregator:{'openrouter.ai':['/api/v1/models','/api/v1/model/','/docs/']},
  provider:{'developers.openai.com':['/'],'platform.openai.com':['/docs/'],'openai.com':['/index/'],
    'platform.claude.com':['/docs/'],'docs.anthropic.com':['/'],'www.anthropic.com':['/news/'],
    'ai.google.dev':['/'],'cloud.google.com':['/vertex-ai/'],'docs.mistral.ai':['/'],
    'docs.z.ai':['/'],'api-docs.deepseek.com':['/'],'platform.moonshot.ai':['/docs/'],
    'www.llama.com':['/'],'ollama.com':['/library/']},
  harness:{'developers.openai.com':['/codex/'],'code.claude.com':['/docs/'],'docs.mistral.ai':['/vibe/'],
    'opencode.ai':['/docs/'],'docs.github.com':['/en/copilot/'],'cursor.com':['/docs/'],
    'docs.cursor.com':['/'],'docs.ollama.com':['/'],'github.com':['/ggml-org/llama.cpp/','/mistralai/mistral-vibe/']},
};
const fail=message=>{throw new OrchError(message,'bad-model-catalog');};
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
function exact(raw,keys){if(!object(raw)||Object.keys(raw).some(k=>!keys.includes(k)))fail('Unexpected catalogue fields; execution authority and credentials do not belong in metadata');}
function id(x){if(typeof x!=='string'||!ID.test(x))fail('Invalid bounded catalogue identifier');return x;}
function text(x,max=200){if(typeof x!=='string'||!x.trim()||x.length>max||/[\u0000-\u001f\u007f]/.test(x))fail('Invalid bounded catalogue text');return x;}
function selector(x){if(x===null)return null;if(typeof x!=='string'||!SELECTOR.test(x)||x.includes('..'))fail('Invalid model selector');return x;}
function date(x){if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)||!Number.isFinite(Date.parse(x))||new Date(x).toISOString()!==x||Date.parse(x)>Date.now()+300000)fail('Evidence needs a valid nonfuture UTC retrieval date');return x;}
function list(x,fn,max=32){if(!Array.isArray(x)||x.length>max)fail('Catalogue array exceeds bounds');const out=x.map(fn);if(new Set(out).size!==out.length)fail('Duplicate catalogue values');return out;}
function number(x,max){if(x===null)return null;if(typeof x!=='number'||!Number.isFinite(x)||x<0||x>max)fail('Invalid bounded catalogue number');return x;}
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function comparable(value){
  if(Array.isArray(value))return value.map(comparable);
  if(object(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,comparable(value[key])]));
  return value;
}
const equal=(a,b)=>JSON.stringify(comparable(a))===JSON.stringify(comparable(b));

function source(raw){
  exact(raw,['id','kind','url','retrievedAt','status','harnessVersion','contentHash']);
  id(raw.id);date(raw.retrievedAt);
  if(!['ok','cached','failed','partial','offline'].includes(raw.status))fail('Invalid source observation status');
  if(raw.kind==='local-cli'){
    if(typeof raw.url!=='string'||!/^cli:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/models$/.test(raw.url))fail('Invalid local CLI provenance');text(raw.harnessVersion,64);
  }else if(raw.kind==='research'){
    if(typeof raw.url!=='string'||!/^research:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?:#[A-Za-z0-9_.-]{1,64})?$/.test(raw.url))fail('Invalid research provenance');
  }else{
    let url;try{url=new URL(raw.url);}catch{fail('Invalid official source URL');}
    const paths=SOURCE_ALLOWLIST[raw.kind]?.[url.hostname];
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||!paths?.some(p=>p.endsWith('/')?url.pathname.startsWith(p):url.pathname===p)||url.href!==raw.url)fail('Source is outside the versioned official allowlist');
  }
  if(raw.harnessVersion!=null)text(raw.harnessVersion,64);
  if(raw.contentHash!=null&&(typeof raw.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(raw.contentHash)))fail('Invalid source content digest');
  return {...raw};
}
const unknown=x=>x===null||(Array.isArray(x)&&!x.length);
function model(raw,sources){
  exact(raw,['id','provider',...FIELDS,'evidence']);id(raw.id);id(raw.provider);text(raw.name);
  selector(raw.model);
  if(!['active','deprecated','unresolved'].includes(raw.status)||raw.model===null&&raw.status==='active')fail('Unknown model identity must remain unresolved');
  list(raw.aliases,x=>{if(x===null)fail('Null alias');return selector(x);});
  if(raw.aliases.includes(raw.model))fail('Canonical model must not be repeated as an alias');
  number(raw.contextTokens,100000000);if(raw.contextTokens!==null&&!Number.isInteger(raw.contextTokens))fail('Context allowance must be an integer');
  for(const k of ['inputModalities','outputModalities'])list(raw[k],x=>{if(!MODALITIES.includes(x))fail('Unknown modality');return x;});
  if(raw.toolCalling!==null&&typeof raw.toolCalling!=='boolean')fail('Tool support must be true, false or unknown');
  if(raw.pricing!==null){exact(raw.pricing,['inputUsdPerMillion','outputUsdPerMillion']);for(const k of ['inputUsdPerMillion','outputUsdPerMillion'])if(number(raw.pricing[k],1000000)===null)fail('Unknown price must use null pricing');}
  if(!Array.isArray(raw.routes)||raw.routes.length>32)fail('Invalid bounded catalogue routes');
  const routes=raw.routes.map(r=>{
    exact(r,['harness','selector','billing','resolution']);id(r.harness);selector(r.selector);
    if(!['unknown','local','subscription','api'].includes(r.billing)||!['unresolved','documented','listed'].includes(r.resolution)||r.selector===null&&r.resolution!=='unresolved')fail('Unknown harness selectors cannot claim resolution');return {...r};
  });
  if(new Set(routes.map(r=>JSON.stringify([r.harness,r.selector,r.billing]))).size!==routes.length)fail('Duplicate catalogue routes');
  exact(raw.evidence,FIELDS);
  for(const field of FIELDS){
    const refs=raw.evidence[field];
    if(refs===undefined&&unknown(raw[field]))continue;
    if(!refs||!refs.length)fail('Each known metadata field needs evidence');
    list(refs,x=>{id(x);if(!sources.has(x))fail('Unknown evidence source');return x;},16);
  }
  if(raw.status!=='unresolved'&&!(raw.evidence.model??[]).some(ref=>sources.get(ref).kind!=='research'))fail('Research-only model identity must remain unresolved');
  if(routes.some(r=>r.resolution!=='unresolved'&&r.billing!=='api')&&!(raw.evidence.routes??[]).some(ref=>['harness','local-cli'].includes(sources.get(ref).kind)))fail('Provider/API metadata does not establish a harness selector');
  return structuredClone(raw);
}
function document(raw,proposal=false){
  exact(raw,['version','sourcePolicyVersion','catalogVersion','asOf','sources','models',...(proposal?['baseCatalogVersion']:[])]);
  if(raw.version!==1||raw.sourcePolicyVersion!==SOURCE_POLICY_VERSION)fail('Unsupported catalogue or source-policy version');
  id(raw.catalogVersion);date(raw.asOf);if(proposal)id(raw.baseCatalogVersion);
  if(!Array.isArray(raw.sources)||raw.sources.length>MAX_SOURCES||!Array.isArray(raw.models)||raw.models.length>MAX_MODELS)fail('Catalogue exceeds source/model bounds');
  const sources=raw.sources.map(source),map=new Map(sources.map(s=>[s.id,s]));
  if(map.size!==sources.length)fail('Duplicate evidence source IDs');
  const models=raw.models.map(m=>model(m,map));
  if(!proposal){
    if(new Set(models.map(m=>m.id)).size!==models.length)fail('Duplicate catalogue model IDs');
    const identities=new Set();for(const m of models)for(const x of [m.model,...m.aliases].filter(Boolean)){if(identities.has(x))fail('Model/alias belongs to multiple entries');identities.add(x);}
  }
  return {...raw,sources,models};
}
export const validateCatalog=raw=>document(raw);
export const validateCatalogProposal=raw=>document(raw,true);

function sourceWarnings(sources,now){
  /** @type {Array<{source?:string,id?:string,harness?:string,reason:string}>} */
  const warnings=[];for(const s of sources){
    if(s.status!=='ok')warnings.push({source:s.id,reason:'source-'+s.status});
    if(s.kind==='research')warnings.push({source:s.id,reason:'research-unverified'});
    if(now-Date.parse(s.retrievedAt)>30*86400000)warnings.push({source:s.id,reason:'stale-source'});
  }return warnings;
}
function ownerImpact(models,owner){
  if(!object(owner))fail('Invalid owner link documents');
  if(owner.roster!==undefined&&(!object(owner.roster)||!Array.isArray(owner.roster.models)))fail('Owner roster links need a models array');
  if(owner.routingPolicy!==undefined&&(!object(owner.routingPolicy)||!Array.isArray(owner.routingPolicy.profiles)))fail('Owner routing links need a profiles array');
  const lookup=value=>models.find(m=>m.model===value||m.aliases.includes(value))?.id??null;
  const roster=owner.roster?.models??[],profiles=owner.routingPolicy?.profiles??[];
  if(!Array.isArray(roster)||roster.length>512||!Array.isArray(profiles)||profiles.length>128)fail('Owner links exceed bounds');
  for(const r of roster){if(!object(r)||typeof r.model!=='string')fail('Invalid owner roster link');id(r.cli);selector(r.model);}
  for(const p of profiles){if(!object(p)||typeof p.model!=='string')fail('Invalid owner routing link');id(p.id);selector(p.model);}
  return {rosterLinks:roster.map(r=>({cli:r.cli,model:r.model,catalogId:lookup(r.model),enabled:r.enabled!==false,requiresPermission:r.requires_permission===true})),
    routingLinks:profiles.map(p=>({profile:p.id,model:p.model,catalogId:lookup(p.model),enabled:p.enabled===true,qualification:p.qualification?.status??'unknown'})),
    preserved:['enabled','permission requirements','owner prices/budgets','execution selectors','qualification/evidence','roster and ledger history']};
}
export function previewCatalogUpdate(baseRaw,proposalRaw,owner={},now=Date.now()){
  const base=validateCatalog(baseRaw),proposal=validateCatalogProposal(proposalRaw);
  if(proposal.baseCatalogVersion!==base.catalogVersion||proposal.catalogVersion===base.catalogVersion)fail('Update requires the exact base version and a new catalogue version');
  if(Date.parse(proposal.asOf)<Date.parse(base.asOf))fail('Catalogue observation date cannot regress');
  const sourceMap=new Map(base.sources.map(s=>[s.id,s])),blocked=new Set(),conflicts=[],changes=[];
  for(const s of proposal.sources){
    if(sourceMap.has(s.id)&&!equal(sourceMap.get(s.id),s)){conflicts.push({source:s.id,reason:'source-id-reused'});blocked.add(s.id);}else sourceMap.set(s.id,s);
  }
  if(sourceMap.size>MAX_SOURCES)fail('Combined source count exceeds catalogue bound');
  const proposed=new Map(base.models.map(m=>[m.id,m])),groups=new Map();
  for(const m of proposal.models){if(!groups.has(m.id))groups.set(m.id,[]);groups.get(m.id).push(m);}
  const claims=new Map(),colliding=new Set();
  for(const m of proposal.models)for(const identity of [m.model,...m.aliases].filter(Boolean)){
    if(!claims.has(identity))claims.set(identity,new Set());claims.get(identity).add(m.id);
  }
  for(const owners of claims.values())if(owners.size>1)for(const owner of owners)colliding.add(owner);
  const allSources=new Map([...sourceMap,...proposal.sources.map(s=>[s.id,s])]);
  for(const [key,group] of groups){
    if(group.length!==1){conflicts.push({id:key,reason:'duplicate-proposal-id'});continue;}
    const m=group[0],old=proposed.get(key),changed=old?FIELDS.filter(f=>!equal(m[f],old[f])):[...FIELDS];
    let reason=null;
    if(colliding.has(key))reason='model-alias-collision';
    else if(old&&m.provider!==old.provider)reason='provider-identity-changed';
    else if(old&&old.model!==m.model&&old.model&&!m.aliases.includes(old.model))reason='rename-needs-old-alias';
    else if(old&&old.aliases.some(alias=>alias!==m.model&&!m.aliases.includes(alias)))reason='alias-removal';
    const checked=old?[...new Set([...changed,...FIELDS.filter(f=>!equal(m.evidence[f],old.evidence[f]))])]:FIELDS;
    for(const field of checked){
      if(reason)break;
      const refs=m.evidence[field]??[];
      if(refs.some(ref=>blocked.has(ref)||!['ok','cached'].includes(allSources.get(ref).status)))reason='unusable-evidence';
      else if(old&&!unknown(old[field])&&unknown(m[field]))reason='known-fact-to-unknown';
      else if(old&&refs.length&&Math.max(...refs.map(ref=>Date.parse(allSources.get(ref).retrievedAt)))<Math.max(...(old.evidence[field]??[]).map(ref=>Date.parse(sourceMap.get(ref).retrievedAt))))reason='older-evidence';
    }
    if(!reason){
      const identities=new Set([m.model,...m.aliases].filter(Boolean));
      if([...proposed.values()].some(p=>p.id!==key&&[p.model,...p.aliases].some(x=>x&&identities.has(x))))reason='model-alias-collision';
      if(!old&&proposed.size>=MAX_MODELS)reason='model-count-limit';
    }
    if(reason){conflicts.push({id:key,reason});continue;}
    proposed.set(key,m);
    const evidenceChanged=old&&!equal(m.evidence,old.evidence);
    if(!old||changed.length||evidenceChanged)changes.push({id:key,kind:!old?'added':m.status==='deprecated'&&old.status!=='deprecated'?'deprecated':m.model!==old.model?'renamed':changed.length?'modified':'evidence-refreshed',fields:changed,evidenceRefreshed:!!evidenceChanged});
  }
  const proposedCatalog=validateCatalog({version:1,sourcePolicyVersion:SOURCE_POLICY_VERSION,catalogVersion:proposal.catalogVersion,asOf:proposal.asOf,sources:[...sourceMap.values()],models:[...proposed.values()]});
  const warnings=sourceWarnings(proposedCatalog.sources,now);
  for(const m of proposedCatalog.models)for(const r of m.routes)if(r.resolution==='unresolved')warnings.push({id:m.id,harness:r.harness,reason:'unresolved-selector'});
  return {mode:'preview',baseVersion:base.catalogVersion,proposedVersion:proposal.catalogVersion,baseHash:hash(base),proposalHash:hash(proposal),resultHash:hash(proposedCatalog),changes,conflicts,warnings,applyReady:conflicts.length===0,proposedCatalog,ownerImpact:ownerImpact(proposedCatalog.models,owner),authority:{rosterChanges:false,policyChanges:false,launchChanges:false}};
}

function read(file){
  let fd;
  try{
    fd=fs.openSync(file,'r');const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>LIMIT)fail('Catalogue input must be a bounded regular file');
    const buffer=Buffer.alloc(LIMIT+1);let size=0;
    while(size<buffer.length){const n=fs.readSync(fd,buffer,size,buffer.length-size,null);if(!n)break;size+=n;}
    if(size>LIMIT)fail('Catalogue input exceeds byte limit');
    return JSON.parse(buffer.subarray(0,size).toString('utf8').replace(/^\uFEFF/,''));
  }
  catch(e){if(e instanceof OrchError)throw e;fail('Cannot read catalogue input JSON');}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
export async function cmdModelrouter(args,io){
  const allowed=['_','json','catalog','proposal','dry-run','roster','routing-policy','state-root'];
  if(Object.keys(args).some(k=>!allowed.includes(k))||args['dry-run']===false)fail('P06a supports read-only catalogue/preview options only; apply is unavailable');
  const [action,...extra]=args._??[];
  if(extra.length||!['catalog','update'].includes(action))fail('Use modelrouter catalog or modelrouter update --proposal <JSON>');
  const file=args.catalog??setting('ORCH_MODEL_CATALOG','modelCatalog',path.join(REPO_ROOT,'model-catalog.json'),{isPath:true});
  const catalog=validateCatalog(read(file));
  let out;
  if(action==='catalog'){
    if(args.proposal||args.roster||args['routing-policy']||args['dry-run']!==undefined)fail('Update options require modelrouter update');
    out={catalog,warnings:sourceWarnings(catalog.sources,Date.now()),authority:{rosterChanges:false,policyChanges:false,launchChanges:false}};
  }else{
    if(typeof args.proposal!=='string'||!args.proposal)fail('Update preview requires --proposal <JSON>');
    out=previewCatalogUpdate(catalog,read(args.proposal),{roster:args.roster?read(args.roster):undefined,routingPolicy:args['routing-policy']?read(args['routing-policy']):undefined});
  }
  io.log(args.json?JSON.stringify(out,null,2):action==='catalog'?`catalogue ${catalog.catalogVersion}: ${catalog.models.length} models; generic metadata only`:`catalogue preview: ${out.changes.length} changes, ${out.conflicts.length} conflicts; no files changed`);
  return {...out,exitCode:action==='update'&&!out.applyReady?3:0};
}
