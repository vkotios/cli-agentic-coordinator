import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {makeCase,orch} from './helpers.mjs';
import {callTool} from '../src/mcp.mjs';
import {OrchError} from '../src/errors.mjs';
/** @type {any} */
const catalog=await import('../src/catalog.mjs').catch(()=>({}));
const source=(id='s1',extra={})=>({id,kind:'aggregator',url:'https://openrouter.ai/api/v1/models',retrievedAt:'2026-10-10T00:00:00.000Z',status:'ok',...extra});
const fields=['name','model','status','aliases','contextTokens','inputModalities','outputModalities','toolCalling','pricing','routes'];
const model=(id='m1',extra={})=>({id,provider:'example',name:'Example model',model:'example/model-1',status:'active',aliases:[],contextTokens:8000,inputModalities:['text'],outputModalities:['text'],toolCalling:true,pricing:{inputUsdPerMillion:1,outputUsdPerMillion:2},routes:[],evidence:Object.fromEntries(fields.map(f=>[f,['s1']])),...extra});
const base=(extra={})=>({version:1,sourcePolicyVersion:1,catalogVersion:'fixture-1',asOf:'2026-10-10T00:00:00.000Z',sources:[source()],models:[model()],...extra});
const proposal=(extra={})=>({version:1,sourcePolicyVersion:1,baseCatalogVersion:'fixture-1',catalogVersion:'fixture-2',asOf:'2026-10-11T00:00:00.000Z',sources:[source('s2',{retrievedAt:'2026-10-11T00:00:00.000Z'})],models:[model('m1',{contextTokens:16000,evidence:Object.fromEntries(fields.map(f=>[f,['s2']]))})],...extra});
const preview=(a=base(),b=proposal(),owner={})=>{assert.equal(typeof catalog.previewCatalogUpdate,'function');return catalog.previewCatalogUpdate(a,b,owner);};

test('catalogue validates bounded versioned facts without accepting execution authority',()=>{
 assert.equal(typeof catalog.validateCatalog,'function');assert.equal(catalog.validateCatalog(base()).models[0].contextTokens,8000);
 for(const raw of [{...base(),enabled:true},base({models:[model('m1',{qualification:'qualified'})]}),base({models:[model('m1',{apiKey:'secret'})]}),base({version:2})])assert.throws(()=>catalog.validateCatalog(raw));
});
test('source allowlist rejects host spoofing, userinfo, query credentials, wrong kind and unknown policies',()=>{
 assert.equal(typeof catalog.validateCatalog,'function');
 for(const url of ['https://openrouter.ai.evil.test/api/v1/models','https://openrouter.ai@evil.test/api/v1/models','http://openrouter.ai/api/v1/models','https://openrouter.ai/api/v1/models?key=secret','https://openrouter.ai/api/v1/models#secret','https://openrouter.ai:444/api/v1/models','https://openrouter.ai/api/v1/models-private'])assert.throws(()=>catalog.validateCatalog(base({sources:[source('s1',{url})]})));
 assert.throws(()=>catalog.validateCatalog(base({sourcePolicyVersion:2})));
 assert.throws(()=>catalog.validateCatalog(base({sources:[source('s1',{kind:'provider'})]})));
});
test('local CLI evidence records provenance without executing a command; research remains distinguishable',()=>{
 assert.equal(typeof catalog.validateCatalog,'function');
 const a=catalog.validateCatalog(base({sources:[source('s1',{kind:'local-cli',url:'cli:codex/models',harnessVersion:'fixture-1'})]}));assert.equal(a.sources[0].kind,'local-cli');
 assert.throws(()=>catalog.validateCatalog(base({sources:[source('s1',{kind:'local-cli',url:'cli:codex/models'})]})));
 assert.equal(catalog.validateCatalog(base({sources:[source('s1',{kind:'research',url:'research:routing-matrix-v1'})],models:[model('m1',{model:null,status:'unresolved'})]})).sources[0].kind,'research');
});
test('each known fact requires dated field evidence with known source IDs',()=>{
 assert.equal(typeof catalog.validateCatalog,'function');const x=model();delete x.evidence.contextTokens;assert.throws(()=>catalog.validateCatalog(base({models:[x]})));
 assert.throws(()=>catalog.validateCatalog(base({models:[model('m1',{evidence:{...model().evidence,model:['missing']}})]})));
 assert.throws(()=>catalog.validateCatalog(base({sources:[source('s1',{retrievedAt:'2099-01-01T00:00:00.000Z'})]})));
});
test('duplicate catalogue identities and aliases are invalid; unknown selectors remain nullable',()=>{
 assert.equal(typeof catalog.validateCatalog,'function');assert.throws(()=>catalog.validateCatalog(base({models:[model(),model()]})));
 assert.throws(()=>catalog.validateCatalog(base({models:[model(),model('m2',{model:'example/model-2',aliases:['example/model-1']})]})));
 const x=model('m1',{model:null,status:'unresolved',routes:[{harness:'future-harness',selector:null,billing:'unknown',resolution:'unresolved'}]});assert.equal(catalog.validateCatalog(base({models:[x]})).models[0].routes[0].selector,null);
});
test('preview exposes source-backed changes and immutable input/output digests without altering inputs',()=>{
 const a=base(),b=proposal(),before=JSON.stringify([a,b]);const out=preview(a,b);
 assert.equal(out.changes[0].kind,'modified');assert.deepEqual(out.changes[0].fields,['contextTokens']);assert.equal(out.proposedCatalog.models[0].contextTokens,16000);
 assert.equal(out.conflicts.length,0);assert.equal(out.applyReady,true);assert.equal(JSON.stringify([a,b]),before);for(const key of ['baseHash','proposalHash','resultHash'])assert.match(out[key],/^[a-f0-9]{64}$/);
 assert.equal(out.authority.rosterChanges,false);assert.equal(out.authority.launchChanges,false);
});
test('missing entries and failed/partial/offline fetches never remove working models',()=>{
 for(const status of ['failed','partial','offline']){const out=preview(base(),proposal({sources:[source('s2',{status})],models:[]}));assert.equal(out.proposedCatalog.models.length,1);assert.equal(out.changes.length,0);assert.ok(out.warnings.some(w=>w.reason==='source-'+status));}
});
test('failed-source facts cannot overwrite existing metadata',()=>{
 for(const status of ['failed','partial','offline']){const out=preview(base(),proposal({sources:[source('s2',{status})]}));assert.equal(out.proposedCatalog.models[0].contextTokens,8000);assert.ok(out.conflicts.some(c=>c.reason==='unusable-evidence'));}
});
test('older field evidence cannot overwrite newer facts; stale evidence is labelled',()=>{
 const out=preview(base(),proposal({sources:[source('s2',{retrievedAt:'2026-01-01T00:00:00.000Z'})]}));assert.equal(out.proposedCatalog.models[0].contextTokens,8000);assert.ok(out.conflicts.some(c=>c.reason==='older-evidence'));assert.ok(out.warnings.some(w=>w.reason==='stale-source'));
});
test('cached successful evidence can propose facts without claiming a fresh fetch',()=>{
 const out=preview(base(),proposal({sources:[source('s2',{status:'cached',retrievedAt:'2026-10-11T00:00:00.000Z'})]}));assert.equal(out.proposedCatalog.models[0].contextTokens,16000);assert.ok(out.warnings.some(w=>w.reason==='source-cached'));
});
test('an evidence-only refresh cannot downgrade the age of a known fact',()=>{
 const b=proposal({sources:[source('s2',{retrievedAt:'2026-01-01T00:00:00.000Z'})],models:[model('m1',{evidence:Object.fromEntries(fields.map(f=>[f,['s2']]))})]});const out=preview(base(),b);assert.ok(out.conflicts.some(c=>c.reason==='older-evidence'));assert.deepEqual(out.proposedCatalog.models[0].evidence,model().evidence);
});
test('malformed owner link documents are refused with a catalogue error',()=>{
 for(const owner of [{roster:{}},{roster:{models:[null]}},{roster:{models:[{cli:'codex'}]}},{routingPolicy:{profiles:[null]}},{routingPolicy:{profiles:[{id:'profile',model:42}]}}])assert.throws(()=>preview(base(),proposal(),owner),e=>e instanceof OrchError&&e.code==='bad-model-catalog');
});
test('source ID reuse with altered evidence conflicts rather than silently relabelling old facts',()=>{
 const b=proposal({sources:[source('s1',{retrievedAt:'2026-10-11T00:00:00.000Z'})],models:[model('m1',{contextTokens:16000})]});const out=preview(base(),b);assert.ok(out.conflicts.some(c=>c.reason==='source-id-reused'));assert.equal(out.proposedCatalog.models[0].contextTokens,8000);
});
test('reordered object keys do not invent source conflicts or metadata changes',()=>{
 const reverse=x=>Object.fromEntries(Object.entries(x).reverse());const b=proposal({sources:[reverse(source())],models:[model('m1',{pricing:reverse(model().pricing)})]});const out=preview(base(),b);assert.deepEqual(out.conflicts,[]);assert.deepEqual(out.changes,[]);
});
test('a research-only identity cannot claim provider deprecation',()=>{
 assert.throws(()=>catalog.validateCatalog(base({sources:[source('s1',{kind:'research',url:'research:routing-matrix-v1'})],models:[model('m1',{status:'deprecated'})]})),e=>e instanceof OrchError);
});
test('the bundled update example previews against its declared seed',()=>{
 const root=new URL('../../',import.meta.url);const a=JSON.parse(fs.readFileSync(new URL('model-catalog.json',root),'utf8'));const b=JSON.parse(fs.readFileSync(new URL('catalog.update.example.json',root),'utf8'));const out=preview(a,b);assert.equal(out.applyReady,true);assert.equal(out.changes[0].kind,'added');
});
test('renames require evidenced old alias and preserve original roster links',()=>{
 const b=proposal();b.models[0].model='example/model-renamed';b.models[0].aliases=['example/model-1'];let out=preview(base(),b,{roster:{models:[{cli:'codex',model:'example/model-1',enabled:false,requires_permission:true}]}});
 assert.equal(out.changes[0].kind,'renamed');assert.equal(out.ownerImpact.rosterLinks[0].catalogId,'m1');assert.equal(out.ownerImpact.rosterLinks[0].enabled,false);assert.equal(out.ownerImpact.rosterLinks[0].requiresPermission,true);
 b.models[0].aliases=[];out=preview(base(),b);assert.ok(out.conflicts.some(c=>c.reason==='rename-needs-old-alias'));assert.equal(out.proposedCatalog.models[0].model,'example/model-1');
});
test('provider identity cannot be silently changed under a stable catalogue ID',()=>{
 const b=proposal();b.models[0].provider='other';const out=preview(base(),b);assert.ok(out.conflicts.some(c=>c.reason==='provider-identity-changed'));assert.equal(out.proposedCatalog.models[0].provider,'example');
});
test('known fields are not erased by an unknown/null refresh',()=>{
 const b=proposal();b.models[0].contextTokens=null;const out=preview(base(),b);assert.equal(out.proposedCatalog.models[0].contextTokens,8000);assert.ok(out.conflicts.some(c=>c.reason==='known-fact-to-unknown'));
});
test('conflicting proposal identities and new aliases leave current catalogue intact',()=>{
 let b=proposal();b.models.push({...b.models[0],contextTokens:24000});let out=preview(base(),b);assert.ok(out.conflicts.some(c=>c.reason==='duplicate-proposal-id'));assert.equal(out.proposedCatalog.models[0].contextTokens,8000);
 b=proposal({models:[model('m2',{model:'example/model-2',aliases:['example/model-1'],evidence:Object.fromEntries(fields.map(f=>[f,['s2']]))})]});out=preview(base(),b);assert.ok(out.conflicts.some(c=>c.reason==='model-alias-collision'));assert.equal(out.proposedCatalog.models.length,1);
});
test('deprecation is proposed only with evidence and keeps entry/history links',()=>{
 const b=proposal();b.models[0].status='deprecated';const out=preview(base(),b);assert.equal(out.changes[0].kind,'deprecated');assert.equal(out.proposedCatalog.models.length,1);assert.equal(out.proposedCatalog.models[0].status,'deprecated');
});
test('new catalogued entries remain separate from qualification and subscription access',()=>{
 const b=proposal({models:[model('m2',{model:'example/model-2',routes:[{harness:'cursor',selector:null,billing:'unknown',resolution:'unresolved'}],evidence:Object.fromEntries(fields.map(f=>[f,['s2']]))})]});const out=preview(base(),b);assert.equal(out.changes[0].kind,'added');assert.equal(out.authority.policyChanges,false);assert.equal(out.proposedCatalog.models.find(m=>m.id==='m2').routes[0].resolution,'unresolved');assert.ok(out.warnings.some(w=>w.reason==='unresolved-selector'));
});
test('mismatched base version refuses update without producing a misleading preview',()=>{
 assert.equal(typeof catalog.previewCatalogUpdate,'function');assert.throws(()=>catalog.previewCatalogUpdate(base(),proposal({baseCatalogVersion:'other'})));
});
test('competing new model/alias claims reject both entries irrespective of proposal order',()=>{
 const evidence=Object.fromEntries(fields.map(f=>[f,['s2']]));const entries=[model('m2',{model:'example/model-2',aliases:['example/shared'],evidence}),model('m3',{model:'example/model-3',aliases:['example/shared'],evidence})];
 for(const models of [entries,[...entries].reverse()]){const out=preview(base(),proposal({models}));assert.equal(out.proposedCatalog.models.length,1);assert.deepEqual(out.conflicts.filter(c=>c.reason==='model-alias-collision').map(c=>c.id).sort(),['m2','m3']);}
});
test('updates preserve historical aliases and reject a regressing catalogue observation date',()=>{
 const a=base({models:[model('m1',{aliases:['example/old-1','example/old-2']})]});const b=proposal();b.models[0].aliases=['example/old-1'];assert.ok(preview(a,b).conflicts.some(c=>c.reason==='alias-removal'));
 assert.throws(()=>preview(base(),proposal({asOf:'2026-10-09T00:00:00.000Z'})));
});
test('research-only identities cannot claim an active resolved provider model',()=>{
 assert.equal(typeof catalog.validateCatalog,'function');assert.throws(()=>catalog.validateCatalog(base({sources:[source('s1',{kind:'research',url:'research:routing-matrix-v1'})]})));
 const x=model('m1',{model:null,status:'unresolved'});assert.equal(catalog.validateCatalog(base({sources:[source('s1',{kind:'research',url:'research:routing-matrix-v1'})],models:[x]})).models[0].status,'unresolved');
});
test('CLI and MCP share a read-only preview and preserve owner files byte-for-byte',async t=>{
 const c=makeCase('catalog-preview');t.after(()=>c.cleanup());const files={catalog:base(),proposal:proposal(),roster:{models:[{cli:'codex',model:'example/model-1',enabled:false,requires_permission:true,cost_class:'owner-price'}]},'routing-policy':{version:1,profiles:[{id:'owner-profile',model:'example/model-1',qualification:{status:'qualified',evidence:'private-owner-evidence'},enabled:false}]}};
 const args={};const bytes={};for(const [key,value] of Object.entries(files)){args[key]=path.join(c.base,key+'.json');fs.writeFileSync(args[key],JSON.stringify(value));bytes[key]=fs.readFileSync(args[key]);}
 const cli=await orch(['modelrouter','update',...Object.entries(args).flatMap(([k,v])=>['--'+k,v]),'--dry-run','--json'],c.env);assert.equal(cli.code,0,cli.stderr);const out=JSON.parse(cli.stdout);
 const tool=await callTool('modelrouter_update',args,{stateRoot:c.stateRoot});assert.equal(tool.isError,false,tool.content[0].text);assert.deepEqual(JSON.parse(tool.content[0].text),out);
 assert.equal(out.ownerImpact.routingLinks[0].qualification,'qualified');assert.equal(out.ownerImpact.routingLinks[0].enabled,false);
 for(const k of Object.keys(files))assert.deepEqual(fs.readFileSync(args[k]),bytes[k]);assert.equal(fs.existsSync(path.join(c.stateRoot,'runs')),false);
});
test('apply/output/unknown options are refused before any side effect',async t=>{
 const c=makeCase('catalog-refusal');t.after(()=>c.cleanup());for(const opts of [['--apply'],['--out',path.join(c.base,'output.json')],['--refresh'],['--dry-run=false']]){const r=await orch(['modelrouter','update',...opts,'--json'],c.env);assert.equal(r.code,2);assert.equal(fs.existsSync(path.join(c.base,'output.json')),false);}
});
test('catalogue inspection rejects update-only dry-run options',async t=>{
 const c=makeCase('catalog-only-options');t.after(()=>c.cleanup());const r=await orch(['modelrouter','catalog','--dry-run','--json'],c.env);assert.equal(r.code,2);
});
test('bounded inputs and invalid JSON refuse cleanly',async t=>{
 const c=makeCase('catalog-bounds');t.after(()=>c.cleanup());const file=path.join(c.base,'catalog.json');for(const text of ['{bad','x'.repeat(1048577)]){fs.writeFileSync(file,text);const r=await orch(['modelrouter','catalog','--catalog',file,'--json'],c.env);assert.equal(r.code,2,r.stderr);}
});
test('bundled generic catalogue is source-backed and does not read or activate owner state',async t=>{
 const c=makeCase('catalog-seed');t.after(()=>c.cleanup());const r=await orch(['modelrouter','catalog','--json'],c.env);assert.equal(r.code,0,r.stderr);const out=JSON.parse(r.stdout);assert.ok(out.catalog.models.length>=8);assert.equal(out.authority.launchChanges,false);assert.equal(fs.existsSync(path.join(c.stateRoot,'runs')),false);for(const m of out.catalog.models)assert.equal('enabled' in m,false);
});
