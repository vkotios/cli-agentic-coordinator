// Explicit private catalogue transactions. No network, launches or owner policy writes.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {REPO_ROOT} from './config.mjs';import {OrchError} from './errors.mjs';
import {validateCatalog,previewCatalogUpdate} from './catalog.mjs';
import {resolvedPath,withOperationLock} from './resources.mjs';import {samePath,pathKey} from './git.mjs';import {sleep} from './util.mjs';
const MAX_BYTES=1048576,MAX_TRANSACTIONS=64,HEX=/^[a-f0-9]{64}$/,SNAPSHOT=/^[a-f0-9]{32}$/;
// Windows refuses to replace a file another process holds open (even a brief read).
// Retry the one publishing rename for about 1.6 s, then abort with the catalogue unchanged.
const SHARING_CODES=new Set(['EPERM','EACCES','EBUSY']),PUBLISH_RETRY_MS=[25,50,100,200,400,800];
const authority={rosterChanges:false,policyChanges:false,launchChanges:false};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const token=values=>hash(JSON.stringify(values));
const fail=message=>{throw new OrchError(message,'catalog-transaction-refused');};
const fileKey=file=>hash(pathKey(path.resolve(file)));
const historyRoot=file=>path.resolve(file)+'.orch-history';
const stamp=s=>`${s.dev}:${s.ino}:${s.birthtimeMs}`;
function exact(raw,keys){if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!==[...keys].sort().join(','))fail('Invalid catalogue transaction record');}
function safePath(file,directory=false){
  if(typeof file!=='string'||!file||file.length>4096||file.startsWith('\\\\')||path.basename(file).includes(':'))fail('Catalogue path traverses a link or is not local');
  try{if(!samePath(path.resolve(file),resolvedPath(file)))fail('Catalogue path traverses a link or is not local');const s=fs.lstatSync(file);if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile()||s.nlink!==1))fail('Catalogue path must be an unlinked directory or single-link file');return s;}
  catch(e){if(e.code==='ENOENT'&&directory)return null;if(e instanceof OrchError)throw e;fail('Catalogue path is unavailable');}
}
function input(file,{protectedFile=false,max=MAX_BYTES}={}){
  let fd;
  try{
    const leaf=protectedFile?safePath(file):null;fd=fs.openSync(file,'r');const before=fs.fstatSync(fd);
    if(!before.isFile()||before.size>max||leaf&&stamp(leaf)!==stamp(before))fail('Catalogue input must be a stable bounded regular file');
    const buffer=Buffer.alloc(max+1);let size=0;while(size<buffer.length){const n=fs.readSync(fd,buffer,size,buffer.length-size,null);if(!n)break;size+=n;}
    const after=fs.fstatSync(fd);if(size>max||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('Catalogue input changed during read');
    const bytes=buffer.subarray(0,size),raw=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
    return {bytes,raw,sha:hash(bytes),identity:stamp(after),revision:`${after.mtimeMs}:${after.ctimeMs}`,mode:after.mode&0o777};
  }catch(e){if(e instanceof OrchError)throw e;fail('Catalogue input or transaction evidence is unavailable');}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
function active(file,protectedFile=false){const value=input(file,{protectedFile});return {...value,catalog:validateCatalog(value.raw)};}
export function previewCatalogFiles(file,proposalFile,owner={}){
  const base=active(file),proposal=input(proposalFile),preview=previewCatalogUpdate(base.raw,proposal.raw,owner);
  return {...preview,approvalHash:token(['update',fileKey(file),base.sha,base.identity,base.revision,proposal.sha,proposal.identity,proposal.revision,preview.resultHash])};
}
function target(file){
  safePath(path.dirname(path.resolve(file)),true);safePath(file);
  if(samePath(resolvedPath(file),resolvedPath(path.join(REPO_ROOT,'model-catalog.json'))))fail('The bundled catalogue is immutable; select an explicit private copy');
  safePath(historyRoot(file),true);
}
function jsonBytes(raw){return Buffer.from(JSON.stringify(raw,null,2)+'\n');}
function exclusive(file,bytes,mode=0o600){
  safePath(path.dirname(file),true);let fd;
  try{fd=fs.openSync(file,'wx',mode);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
function time(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value||Date.parse(value)>Date.now()+300000)fail('Invalid catalogue transaction date');}
function optionalInput(file,max=MAX_BYTES){try{fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}return input(file,{protectedFile:true,max});}
function entry(file,id){
  if(!SNAPSHOT.test(id))fail('Invalid snapshot identifier');
  const dir=path.join(historyRoot(file),'transactions',id);safePath(dir,true);
  const record=input(path.join(dir,'record.json'),{protectedFile:true,max:4096}),r=record.raw;
  exact(r,['version','id','target','kind','beforeHash','afterHash','beforeVersion','afterVersion','at','origin','approvalHash']);
  if(r.version!==1||r.id!==id||r.target!==fileKey(file)||!['update','rollback'].includes(r.kind)||![r.beforeHash,r.afterHash,r.approvalHash].every(x=>typeof x==='string'&&HEX.test(x))||r.beforeHash===r.afterHash||typeof r.beforeVersion!=='string'||typeof r.afterVersion!=='string'||r.kind==='update'&&r.origin!==null||r.kind==='rollback'&&!SNAPSHOT.test(r.origin))fail('Invalid catalogue snapshot binding');time(r.at);
  const before=optionalInput(path.join(dir,'before.json')),after=optionalInput(path.join(dir,'after.json'));
  for(const [value,digest,version] of [[before,r.beforeHash,r.beforeVersion],[after,r.afterHash,r.afterVersion]])if(value&&(value.sha!==digest||validateCatalog(value.raw).catalogVersion!==version))fail('Catalogue snapshot bytes changed');
  const outcome=optionalInput(path.join(dir,'outcome.json'),4096);
  if(outcome){const o=outcome.raw;exact(o,['version','id','recordHash','status','at']);if(o.version!==1||o.id!==id||o.recordHash!==record.sha||!['committed','aborted'].includes(o.status))fail('Invalid catalogue publication outcome');time(o.at);if(o.status==='committed'&&(!before||!after))fail('Committed catalogue snapshots are missing');}
  return {id,dir,record,before,after,status:outcome?.raw.status??'prepared'};
}
function entries(file){
  const root=historyRoot(file);if(!safePath(root,true))return [];
  const dir=path.join(root,'transactions');if(!safePath(dir,true))return [];
  const names=fs.readdirSync(dir);if(names.length>MAX_TRANSACTIONS)fail('Catalogue history exceeds its transaction bound');
  return names.map(id=>entry(file,id)).sort((a,b)=>a.record.raw.at.localeCompare(b.record.raw.at)||a.id.localeCompare(b.id));
}
export function catalogHistory(file){
  const current=active(file,true),rows=entries(file);
  return {mode:'history',currentHash:current.sha,catalogVersion:current.catalog.catalogVersion,maxTransactions:MAX_TRANSACTIONS,
    entries:rows.map(e=>({snapshot:e.id,kind:e.record.raw.kind,beforeVersion:e.record.raw.beforeVersion,afterVersion:e.record.raw.afterVersion,status:e.status,currentMatch:current.sha===e.record.raw.afterHash?'after':current.sha===e.record.raw.beforeHash?'before':'neither',rollbackAvailable:e.status==='committed'&&current.sha===e.record.raw.afterHash})),authority};
}
function ready(file,kind='update'){const rows=entries(file);if(rows.some(e=>e.status==='prepared'))fail('An interrupted catalogue transaction needs explicit recovery');if(rows.length>=MAX_TRANSACTIONS-(kind==='update'?1:0))fail('Catalogue history is full for this operation; the last slot is reserved for rollback');}
function approval(expected,actual){if(typeof expected!=='string'||!HEX.test(expected)||expected!==actual)fail('Catalogue approval is missing or stale; preview again');}
function outcome(e,status){exclusive(path.join(e.dir,'outcome.json'),jsonBytes({version:1,id:e.id,recordHash:e.record.sha,status,at:new Date().toISOString()}));}
async function publish(file,current,next,kind,origin,approvalHash,recheck=()=>{}){
  target(file);ready(file,kind);if(next.length>MAX_BYTES)fail('Resulting catalogue exceeds byte limit');const nextCatalog=validateCatalog(JSON.parse(next.toString('utf8').replace(/^\uFEFF/,'')));
  const id=crypto.randomBytes(16).toString('hex'),root=historyRoot(file),transactions=path.join(root,'transactions');safePath(transactions,true);fs.mkdirSync(transactions,{recursive:true,mode:0o700});safePath(transactions,true);
  const dir=path.join(transactions,id);fs.mkdirSync(dir,{mode:0o700});const directoryStamp=stamp(safePath(dir,true));
  const record={version:1,id,target:fileKey(file),kind,beforeHash:current.sha,afterHash:hash(next),beforeVersion:current.catalog.catalogVersion,afterVersion:nextCatalog.catalogVersion,at:new Date().toISOString(),origin,approvalHash};
  exclusive(path.join(dir,'record.json'),jsonBytes(record));exclusive(path.join(dir,'before.json'),current.bytes);exclusive(path.join(dir,'after.json'),next);exclusive(path.join(dir,'stage.json'),next,current.mode);
  const prepared=entry(file,id),stage=input(path.join(dir,'stage.json'),{protectedFile:true});
  const unchanged=()=>{recheck();const fresh=active(file,true);target(file);if(fresh.sha!==current.sha||fresh.identity!==current.identity||fresh.revision!==current.revision||stage.sha!==record.afterHash||stamp(safePath(dir,true))!==directoryStamp)fail('Catalogue or transaction changed before publication');};
  // A refused rename leaves the old catalogue in place. Every attempt rechecks first, so a
  // retry never overwrites an edit made while it waited.
  for(let attempt=0;;attempt++){
    unchanged();
    try{fs.renameSync(path.join(dir,'stage.json'),path.resolve(file));break;}
    catch(e){
      if(!SHARING_CODES.has(e?.code))throw e;
      if(attempt<PUBLISH_RETRY_MS.length){await sleep(PUBLISH_RETRY_MS[attempt]);continue;}
      if(active(file,true).sha!==record.beforeHash)fail('Catalogue publication is uncertain; inspect history and recover explicitly');
      outcome(prepared,'aborted');
      fail('The catalogue file is in use by another process, so nothing was changed; close it and apply again');
    }
  }
  if(active(file,true).sha!==record.afterHash)fail('Catalogue publication is uncertain; inspect history and recover explicitly');
  outcome(prepared,'committed');return {mode:kind==='update'?'applied':'rolled-back',snapshot:id,origin,beforeVersion:record.beforeVersion,catalogVersion:record.afterVersion,currentHash:record.afterHash,authority};
}
export async function applyCatalogUpdate(file,proposalFile,expected,owner={}){
  target(file);const preview=previewCatalogFiles(file,proposalFile,owner);approval(expected,preview.approvalHash);if(!preview.applyReady)fail('A conflicting catalogue preview cannot be applied');ready(file);
  return withOperationLock({stateRoot:historyRoot(file)},'catalog:'+fileKey(file),async()=>{
    target(file);const fresh=previewCatalogFiles(file,proposalFile,owner);approval(expected,fresh.approvalHash);if(!fresh.applyReady)fail('A conflicting catalogue preview cannot be applied');
    const current=active(file,true);if(previewCatalogFiles(file,proposalFile,owner).approvalHash!==expected)fail('Catalogue inputs changed before transaction');
    return publish(file,current,jsonBytes(fresh.proposedCatalog),'update',null,expected,()=>approval(expected,previewCatalogFiles(file,proposalFile,owner).approvalHash));
  });
}
function rollbackPlan(file,snapshot){
  target(file);const current=active(file,true),rows=entries(file),selected=rows.find(e=>e.id===snapshot);
  if(!selected||selected.status!=='committed'||rows.some(e=>e.status==='prepared')||current.sha!==selected.record.raw.afterHash)fail('Rollback requires a committed snapshot matching the current catalogue');
  const approvalHash=token(['rollback',fileKey(file),current.sha,current.identity,current.revision,selected.record.sha,selected.before.sha]);
  return {current,selected,out:{mode:'rollback-preview',snapshot,catalogVersion:current.catalog.catalogVersion,restoreVersion:selected.record.raw.beforeVersion,currentHash:current.sha,restoreHash:selected.before.sha,approvalHash,authority}};
}
export async function rollbackCatalog(file,snapshot,expected){
  const plan=rollbackPlan(file,snapshot);if(expected===undefined)return plan.out;approval(expected,plan.out.approvalHash);ready(file,'rollback');
  return withOperationLock({stateRoot:historyRoot(file)},'catalog:'+fileKey(file),async()=>{const fresh=rollbackPlan(file,snapshot);approval(expected,fresh.out.approvalHash);return publish(file,fresh.current,fresh.selected.before.bytes,'rollback',snapshot,expected);});
}
function recoveryPlan(file,snapshot){
  target(file);const current=active(file,true),selected=entries(file).find(e=>e.id===snapshot);if(!selected)fail('Unknown catalogue transaction');
  const r=selected.record.raw,status=selected.status!=='prepared'?selected.status:current.sha===r.beforeHash?'aborted':current.sha===r.afterHash&&selected.before&&selected.after?'committed':null;
  if(!status)fail('Interrupted transaction does not match the visible catalogue; inspect without overwriting');
  return {selected,out:{mode:'recovery-preview',snapshot,status,alreadyResolved:selected.status!=='prepared',currentHash:current.sha,approvalHash:token(['recover',fileKey(file),current.sha,current.identity,current.revision,selected.record.sha,selected.status,status]),authority}};
}
export async function recoverCatalog(file,snapshot,expected){
  const plan=recoveryPlan(file,snapshot);if(expected===undefined)return plan.out;approval(expected,plan.out.approvalHash);
  return withOperationLock({stateRoot:historyRoot(file)},'catalog:'+fileKey(file),async()=>{const fresh=recoveryPlan(file,snapshot);approval(expected,fresh.out.approvalHash);if(!fresh.out.alreadyResolved)outcome(fresh.selected,fresh.out.status);return {...fresh.out,mode:'recovered'};});
}
