// Exact-preview setup publication. Multi-file changes can be partial; never infer rollback.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {setupProposal,setupStatus,localPath,readSetupInput,checkedSetupPath} from './setup.mjs';
import {planAdopt,cmdAdopt} from './adopt.mjs';
import {withOperationLock} from './resources.mjs';
import {samePath,isInside} from './git.mjs';
import {publishExclusive} from './exclusive.mjs';
import {OrchError} from './errors.mjs';

const MAX=1048576,BOUND=64,HEX=/^[a-f0-9]{64}$/;
const encode=x=>JSON.stringify(x,null,2)+'\n';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const fail=message=>{throw new OrchError(message,'setup-apply-refused');};
function exact(x,keys){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join(',')!==[...keys].sort().join(','))fail('Unexpected setup apply fields');}
const token=x=>hash(JSON.stringify(x));
function optional(file){checkedSetupPath(path.dirname(file),true);try{const input=readSetupInput(file,{max:MAX});if(!input.raw||typeof input.raw!=='object'||Array.isArray(input.raw))fail('Setup config must be a JSON object');return {...input,exists:true};}catch(e){if(!fs.existsSync(file)){checkedSetupPath(file,true);return {raw:{},hash:null,exists:false};}throw e;}}
function merge(input,desired,file){const next={...input.raw},conflicts=[],changes=[];for(const [key,value] of Object.entries(desired)){if(Object.hasOwn(next,key)&&JSON.stringify(next[key])!==JSON.stringify(value))conflicts.push({file,key,reason:'existing-setting-differs'});else if(!Object.hasOwn(next,key)){next[key]=value;changes.push({file,key,action:'add',value});}}return {next,changes,conflicts};}
function reference(value,repo,session){const file=path.resolve(localPath(value,repo));if(isInside(file,session)||samePath(file,session))fail('Keep apply targets outside setup evidence');return file;}
function roleReadiness(p,discovery){return ['controller','workers','reviewers'].flatMap(role=>(role==='controller'?[p.answers.routes.controller]:p.answers.routes[role]).map(r=>{
    const matches=discovery.models.filter(m=>m.source==='owner-roster'&&m.harness===r.harness&&m.model===r.model);
    const disabled=matches.some(m=>m.enabled===false),permission=matches.some(m=>m.requiresPermission);
    const installed=discovery.harnesses.find(h=>h.harness===r.harness)?.installed===true;
    return {role,harness:r.harness,model:r.model,billing:r.billing,permissionPreference:r.permission,status:disabled||permission||!installed?'blocked':'installed-but-unqualified',reason:disabled?'owner-route-disabled':permission?'owner-model-permission-required':!installed?'cli-not-installed':'authentication-access-qualification-not-checked',qualification:'unqualified',launchAllowed:false};
}));}
async function build(session,options){
    exact(options,['configFile','adopt','update']);if(typeof options.adopt!=='boolean'||typeof options.update!=='boolean'||options.update&&!options.adopt)fail('Update requires explicit adoption');
    const p=setupProposal(session),s=setupStatus(session),a=p.answers;
    const stateRoot=reference(a.resources.stateRoot,p.repo,session),reviewRoot=reference(a.resources.reviewRoot,p.repo,session),file=reference(options.configFile,p.repo,session);
    if(isInside(stateRoot,reviewRoot)||isInside(reviewRoot,stateRoot)||isInside(stateRoot,session)||isInside(session,stateRoot)||isInside(reviewRoot,session)||isInside(session,reviewRoot))fail('State, review and setup directories must not overlap');
    const stateFile=path.join(stateRoot,'config.json');if(isInside(file,stateRoot)||isInside(file,reviewRoot))fail('Choose a private runtime configuration file outside managed state/review directories');
    if(a.usage.enabled&&[file,stateFile].some(f=>samePath(f,path.resolve(a.usage.configFile))))fail('Usage input must be separate from setup output files');
    const input=optional(file),stateInput=optional(stateFile);
    const desired={stateRoot,reviewRoot,usageConfig:a.usage.enabled?reference(a.usage.configFile,p.repo,session):null,setupPreferences:{version:1,repo:p.repo,controller:p.harness,routes:a.routes,router:a.router,cleanup:a.resources.cleanup}};
    const retention=a.retention.enabled?{mode:a.retention.mode,successDays:a.retention.transcriptDays,otherDays:a.retention.transcriptDays,metadata:{enabled:true,successDays:a.retention.runDays,otherDays:a.retention.runDays}}:{mode:'disabled',successDays:30,otherDays:90,metadata:{enabled:false}};
    const configMerge=merge(input,desired,file),stateMerge=merge(stateInput,{retention},stateFile);
    for(const x of [configMerge.next,stateMerge.next])if(Buffer.byteLength(encode(x))>MAX)fail('Resulting setup config exceeds size limit');
    const adoption=options.adopt?await planAdopt(p.repo,{harness:[p.harness],update:options.update}):null;
    const adoptionTargets=adoption?.items.map(it=>{const target=path.join(p.repo,it.path);checkedSetupPath(path.dirname(target),true);const exists=fs.existsSync(target);if(exists)checkedSetupPath(target);return {file:target,beforeHash:exists?hash(fs.readFileSync(target)):null,afterHash:['create','update'].includes(it.action)?hash(Buffer.from(it.content)):exists?hash(fs.readFileSync(target)):null,action:it.action};})??[];
    const conflicts=[...configMerge.conflicts,...stateMerge.conflicts,...(adoption?.items.filter(i=>['refused','conflict','stale'].includes(i.action)).map(i=>({file:path.join(p.repo,i.path),reason:i.action}))??[])];
    const configTargets=[{file,beforeHash:input.hash,afterHash:hash(encode(configMerge.next)),content:configMerge.next,changed:configMerge.changes.length>0},{file:stateFile,beforeHash:stateInput.hash,afterHash:hash(encode(stateMerge.next)),content:stateMerge.next,changed:stateMerge.changes.length>0}];
    // Existing equivalent configs stay byte-identical, including formatting.
    for(const x of configTargets)if(!x.changed)x.afterHash=x.beforeHash;
    const binding={sessionHash:p.sessionHash,repo:p.repo,harness:p.harness,options,configTargets:configTargets.map(({content,...rest})=>rest),adoptionTargets,adoptionDiscovery:adoption?.discoverySignature??null};
    return {p,options,planHash:token(binding),configTargets,adoptionTargets,conflicts,configChanges:configMerge.changes,stateChanges:stateMerge.changes,adoption,readiness:roleReadiness(p,s.discovery),deferred:['Route capability profiles, authentication, model access and role qualification need explicit verification','Jev needs a complete pinned adviser policy, request/price reserves and finite provider-key checks; preferences do not enable advice'],environmentPrecedence:['ORCH_CONFIG selects this private config explicitly','Environment overrides take precedence; setup does not change them']};
}
function area(session,name){const root=path.join(path.resolve(session),'apply');checkedSetupPath(root,true);const dir=path.join(root,name);checkedSetupPath(dir,true);return dir;}
function evidence(session,name,id){if(!HEX.test(id))fail('Invalid preview hash');return path.join(area(session,name),id+'.json');}
function exclusive(file,value){checkedSetupPath(path.dirname(file),true);if(!publishExclusive(file,encode(value)).created)fail('Setup evidence already exists');}
function bounded(session,names=['previews','attempts','receipts']){for(const name of names){const dir=area(session,name);if(fs.existsSync(dir)&&fs.readdirSync(dir).length>=BOUND)fail('Setup apply history is full; use a new session');}}
function readPreview(session,id){const r=readSetupInput(evidence(session,'previews',id),{max:MAX,journal:true}).raw;exact(r,['version','nonce','sessionHash','options','planHash','outputs']);if(r.version!==1||!HEX.test(r.sessionHash)||!HEX.test(r.planHash)||token(r)!==id||!Array.isArray(r.outputs)||r.outputs.length>64)fail('Preview evidence changed');return r;}
export async function previewSetup(session,{configFile,adopt=false,update=false}){
    setupProposal(session);
    return withOperationLock({stateRoot:path.resolve(session)},'setup',async()=>{
        const b=await build(session,{configFile,adopt,update});bounded(session);
        const outputs=[...b.adoptionTargets,...b.configTargets].filter(x=>x.afterHash!==null).map(x=>({file:x.file,hash:x.afterHash}));
        const record={version:1,nonce:crypto.randomBytes(16).toString('hex'),sessionHash:b.p.sessionHash,options:b.options,planHash:b.planHash,outputs},previewHash=token(record);
        exclusive(evidence(session,'previews',previewHash),record);
        return {mode:'setup-preview',previewHash,repo:b.p.repo,sessionHash:b.p.sessionHash,configFile:b.options.configFile,applyReady:b.conflicts.length===0,conflicts:b.conflicts,configChanges:b.configChanges,stateChanges:b.stateChanges,adoption:b.adoption?.items.map(({path,action,detail})=>({path,action,detail}))??[],readiness:b.readiness,deferred:b.deferred,environmentPrecedence:b.environmentPrecedence,activation:false,providerCalls:0,globalChanges:false,schedulerInstalled:false};
    });
}
function outputHash(file){checkedSetupPath(file);const s=fs.statSync(file);if(s.size>MAX)fail('Applied setup file exceeds size limit');return hash(fs.readFileSync(file));}
function completed(session,id,preview){const file=evidence(session,'receipts',id);if(!fs.existsSync(file))return null;const r=readSetupInput(file,{max:MAX,journal:true}).raw;
    exact(r,['version','mode','previewHash','sessionHash','status','written','verifiedOutputs','readiness','deferred','failure','launchChanges','providerCalls','globalChanges','schedulerInstalled']);
    if(r.version!==1||r.previewHash!==id||r.sessionHash!==preview.sessionHash||setupProposal(session).sessionHash!==r.sessionHash||r.status!=='applied'||JSON.stringify(r.verifiedOutputs)!==JSON.stringify(preview.outputs)||!r.verifiedOutputs.length||r.launchChanges!==false||r.providerCalls!==0||r.globalChanges!==false||r.schedulerInstalled!==false)fail('Attempt is partial or invalid; inspect receipt and make a fresh preview');
    for(const x of r.verifiedOutputs){exact(x,['file','hash']);if(!HEX.test(x.hash)||outputHash(x.file)!==x.hash)fail('Applied output changed; make a fresh preview');}return {...r,replayed:true};
}
export function setupReceipt(session,id){setupProposal(session);readPreview(session,id);const file=evidence(session,'receipts',id);if(fs.existsSync(file))return readSetupInput(file,{max:MAX,journal:true}).raw;if(fs.existsSync(evidence(session,'attempts',id)))return {mode:'setup-receipt',previewHash:id,status:'interrupted',nextStep:'Inspect target files, then create and approve a fresh preview; no automatic rollback'};fail('No apply attempt for this preview');}
function writeConfig(x){const current=optional(x.file);if(current.hash!==x.beforeHash)fail('Config changed immediately before write');checkedSetupPath(path.dirname(x.file),true);fs.mkdirSync(path.dirname(x.file),{recursive:true,mode:0o700});checkedSetupPath(path.dirname(x.file),true);const content=encode(x.content);
    if(x.beforeHash===null){if(!publishExclusive(x.file,content).created)fail('Config appeared concurrently');}
    else{const tmp=x.file+'.orch-setup-'+crypto.randomBytes(8).toString('hex')+'.tmp';try{fs.writeFileSync(tmp,content,{flag:'wx',mode:0o600});if(optional(x.file).hash!==x.beforeHash)fail('Config changed before publication');fs.renameSync(tmp,x.file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
    if(outputHash(x.file)!==x.afterHash)fail('Config publication is uncertain');
}
/** @param {any} seams Imported-function interruption seam for owned offline fixtures only. */
export async function applySetup(session,request,seams={}){
    request=structuredClone(request);exact(request,['previewHash','approve']);if(request.approve!==true||!HEX.test(request.previewHash))fail('Explicit exact-preview approval required');
    const id=request.previewHash;setupProposal(session);readPreview(session,id);
    return withOperationLock({stateRoot:path.resolve(session)},'setup',async()=>{
        const preview=readPreview(session,id),prior=completed(session,id,preview);if(prior)return prior;
        if(fs.existsSync(evidence(session,'attempts',id)))fail('Interrupted attempt; make a fresh preview');
        const b=await build(session,preview.options);if(b.p.sessionHash!==preview.sessionHash||b.planHash!==preview.planHash||b.conflicts.length)fail('Preview is stale or conflicting; preview again');
        bounded(session,['attempts','receipts']);exclusive(evidence(session,'attempts',id),{version:1,previewHash:id,sessionHash:preview.sessionHash,planHash:b.planHash});
        const written=[],receipt={version:1,mode:'setup-receipt',previewHash:id,sessionHash:preview.sessionHash,status:'partial',written,verifiedOutputs:[],readiness:b.readiness,deferred:b.deferred,failure:null,launchChanges:false,providerCalls:0,globalChanges:false,schedulerInstalled:false};
        try{
            seams.beforeAdoption?.();
            if(b.adoption){const result=await cmdAdopt({repo:b.p.repo,harness:[b.p.harness],update:preview.options.update,json:true},{log(){}},{beforeWrite:plan=>{
                // cmdAdopt independently checks instruction discovery and each write.
                if(setupProposal(session).sessionHash!==preview.sessionHash||b.configTargets.some(x=>optional(x.file).hash!==x.beforeHash)||plan.discoverySignature!==b.adoption.discoverySignature||token(plan.items)!==token(b.adoption.items)||b.adoptionTargets.some(x=>(fs.existsSync(x.file)?outputHash(x.file):null)!==x.beforeHash))fail('Config/session/adoption changed before adoption');
            }});written.push(...result.written.map(f=>path.join(b.p.repo,f)));if(result.blocked.length||result.items.some(i=>i.action==='stale'))fail('Adoption incomplete; inspect receipt and preview current files');}
            for(const x of b.configTargets){seams.beforeConfigWrite?.(x.file);if(setupProposal(session).sessionHash!==preview.sessionHash)fail('Session changed during apply');if(optional(x.file).hash!==x.beforeHash)fail('Config changed during apply');if(x.changed){writeConfig(x);written.push(x.file);}}
            const targets=[...b.adoptionTargets,...b.configTargets];for(const x of targets)if(x.afterHash!==null){if(outputHash(x.file)!==x.afterHash)fail('Installed setup changed during apply');receipt.verifiedOutputs.push({file:x.file,hash:x.afterHash});}
            receipt.status='applied';
        }catch(e){receipt.failure={reason:e instanceof OrchError?e.code:'write-failed',nextStep:'Inspect completed writes and current files; create and approve a fresh preview'};}
        exclusive(evidence(session,'receipts',id),receipt);return receipt;
    });
}
export async function cmdSetupApply(args,io){const [action,...extra]=args._??[];const allowed=['_','json','session','state-root',...(action==='preview'?['config','adopt','update']:action==='apply'?['approval']:['preview'])];if(extra.length||typeof args.session!=='string'||Object.keys(args).some(k=>!allowed.includes(k)))fail('Use setup preview/apply/receipt with explicit private session and exact approval');
    const out=action==='preview'?await previewSetup(args.session,{configFile:args.config,adopt:args.adopt===true,update:args.update===true}):action==='apply'?await applySetup(args.session,readSetupInput(args.approval).raw):setupReceipt(args.session,args.preview);
    io.log(args.json?JSON.stringify(out,null,2):`setup ${out.mode}: ${out.status??(out.applyReady?'approval required':'conflicts require attention')}`);return {...out,exitCode:out.status==='partial'||out.status==='interrupted'?2:0};
}
