import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import os from 'node:os';
import {cmdAdopt} from '../src/adopt.mjs';
import {makeCase} from './helpers.mjs';import {makeRepo} from './wf-helpers.mjs';
import {startSetup,answerSetup} from '../src/setup.mjs';
import {previewSetup,applySetup} from '../src/setup-apply.mjs';
import {setupHealth} from '../src/setup-health.mjs';
const json=f=>JSON.parse(fs.readFileSync(f,'utf8')),write=(f,x)=>fs.writeFileSync(f,JSON.stringify(x,null,2)+'\n');
function fixture(t,name){const c=makeCase('p04h-'+name);t.after(()=>c.cleanup());const repo=path.join(c.base,'repo');makeRepo(repo,{'README.md':'Example\n'});return {...c,repo,adopt:(args={},seams={})=>cmdAdopt({repo,harness:['copilot','muse'],json:true,...args},{log(){}},seams)};}
function snapshot(dir){const out={};function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name==='.git')continue;const f=path.join(d,e.name);if(e.isDirectory())walk(f);else out[path.relative(dir,f)]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');}}walk(dir);return out;}
function assertHomePreview(items){const detail=items.find(i=>i.path==='.mcp.json').detail,home=os.homedir(),expected={HOME:home,...(process.platform==='win32'?{USERPROFILE:home}:{}),VIBE_HOME:process.env.VIBE_HOME||path.join(home,'.vibe'),XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME||path.join(home,'.config')};for(const [key,value] of Object.entries(expected)){assert.ok(detail.includes(key),'preview omits '+key);assert.ok(detail.includes(JSON.stringify(value)),'preview omits resolved '+key);}}
for(const harness of ['copilot','muse'])test(`P04h: ${harness} previews and installs owned wiring while preserving owner bytes`,async t=>{
 const f=fixture(t,harness),owner=Buffer.from('\ufeffOwner rules\r\nNo final newline'),file=path.join(f.repo,'AGENTS.md');fs.writeFileSync(file,owner);write(path.join(f.repo,'.mcp.json'),{$schema:'https://example.invalid/mcp',mcpServers:{owner:{command:'owner-tool',args:['read-only']}}});
 const before=snapshot(f.repo),dry=await f.adopt({harness:[harness],'dry-run':true});assert.equal(dry.exitCode,0);assert.deepEqual(snapshot(f.repo),before);assert.equal(dry.register_globally.length,0);
 if(harness==='muse')assertHomePreview(dry.items);
 const applied=await f.adopt({harness:[harness]});assert.equal(applied.exitCode,0);assert.deepEqual(fs.readFileSync(file).subarray(0,owner.length),owner);const mcp=json(path.join(f.repo,'.mcp.json'));assert.deepEqual(mcp.mcpServers.owner,{command:'owner-tool',args:['read-only']});assert.equal(mcp.mcpServers.orch.args.at(-1),'mcp');assert.equal(applied.readiness[0].hooks,'not-installed');assert.equal(applied.readiness[0].mcp,'configured-unqualified');
 const after=snapshot(f.repo),mtime=fs.statSync(file).mtimeMs;assert.equal((await f.adopt({harness:[harness]})).written.length,0);assert.deepEqual(snapshot(f.repo),after);assert.equal(fs.statSync(file).mtimeMs,mtime);for(const rel of ['.claude/settings.json','.codex/hooks.json','.github/hooks'])assert.equal(fs.existsSync(path.join(f.repo,rel)),false);if(harness==='muse'){assert.ok(mcp.mcpServers.orch.env.HOME);assertHomePreview((await f.adopt({harness:[harness],'dry-run':true})).items);}
});
test('P04h: simultaneous and later adoption do not hide Muse fallback owner instructions',async t=>{
 for(const fallback of ['CLAUDE.md','.agents/AGENTS.md','.claude/CLAUDE.md'])for(const later of [false,true]){const f=fixture(t,'fallback-'+fallback.replaceAll('/','-')+'-'+later),file=path.join(f.repo,fallback);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'Owner fallback\r\n');
  if(later)assert.equal((await f.adopt({harness:['muse']})).exitCode,0);const original=fs.readFileSync(file);const r=await f.adopt({harness:later?['copilot']:['copilot','muse']});assert.equal(r.exitCode,0);assert.deepEqual(fs.readFileSync(file),original);assert.ok(fs.readFileSync(path.join(f.repo,'AGENTS.md'),'utf8').includes('`'+fallback+'`'));assert.equal((await f.adopt({harness:later?['copilot']:['copilot','muse']})).written.length,0);await f.adopt();assert.equal((await f.adopt()).written.length,0);
 }
});
test('P04h: Muse records nested discovery and explicit non-native targets stay partial',async t=>{
 const f=fixture(t,'nested');fs.writeFileSync(path.join(f.repo,'AGENTS.md'),'Root owner\n');fs.mkdirSync(path.join(f.repo,'sub'));fs.writeFileSync(path.join(f.repo,'sub','CLAUDE.md'),'Nested owner\n');const r=await f.adopt({repo:path.join(f.repo,'sub'),harness:['muse'],'dry-run':true});assert.deepEqual(r.readiness[0].discovery,['AGENTS.md','sub/CLAUDE.md']);assert.equal(fs.existsSync(path.join(f.repo,'.mcp.json')),false);
 const explicit=await f.adopt({harness:['copilot'],'instruction-file':['copilot=policy.md'],'dry-run':true});assert.equal(explicit.readiness[0].path,'policy.md');assert.equal(explicit.readiness[0].instructions,'partial');
});
test('P04h: foreign, flat and Muse-invalid MCP documents refuse all writes',async t=>{
 for(const doc of [{mcpServers:{orch:{command:'owner-orch'}}},{owner:{command:'owner-tool'}},{mcp_servers:{}},{mcpServers:{owner:null}},{mcpServers:{owner:[]}},{mcpServers:{owner:{command:'owner',transport:'stdio'}}},{mcpServers:{owner:{command:'owner',mode:'optional'}}}]){const f=fixture(t,'conflict'),file=path.join(f.repo,'.mcp.json');write(file,doc);const before=snapshot(f.repo),r=await f.adopt();assert.equal(r.exitCode,3);assert.deepEqual(snapshot(f.repo),before);}
});
test('P04h: shared MCP ownership keeps Muse home metadata across later Claude adoption',async t=>{
 const f=fixture(t,'shared');assert.equal((await f.adopt({harness:['muse']})).exitCode,0);const before=json(path.join(f.repo,'.mcp.json')).mcpServers.orch;assert.ok(before.env.HOME);assert.equal((await f.adopt({harness:['claude']})).exitCode,0);assert.deepEqual(json(path.join(f.repo,'.mcp.json')).mcpServers.orch,before);assert.deepEqual(json(path.join(f.repo,'.orch-adopt.json')).mcp_harnesses,['claude','muse']);
});
test('P04h: an MCP edit after preview aborts before any adoption writes',async t=>{
 const f=fixture(t,'race'),file=path.join(f.repo,'.mcp.json');write(file,{mcpServers:{owner:{command:'owner'}}});const r=await f.adopt({}, {beforeWrite(){write(file,{mcpServers:{owner:{command:'changed'}}});}});assert.equal(r.exitCode,3);assert.equal(r.written.length,0);assert.equal(json(file).mcpServers.owner.command,'changed');assert.equal(fs.existsSync(path.join(f.repo,'AGENTS.md')),false);
});
for(const harness of ['copilot','muse'])test(`P04h: ${harness} setup adoption is approved, replayable, and health keeps repository qualification separate`,async t=>{
 const f=fixture(t,'setup-'+harness),session=path.join(f.base,'session'),config=path.join(f.base,'private.json'),roster=path.join(f.base,'roster.json'),profile={version:4,commandPolicy:'fixed-owned-step-tool',tools:['controller_step']},route={harness,model:harness==='copilot'?'auto':'muse-spark-1.3',billing:'subscription',permission:'allowed'};write(roster,{models:[{cli:harness,model:route.model,enabled:true,requires_permission:false,workloads:['implement','review'],lane:'cloud'}]});let s=await startSetup({repo:f.repo,harness,session,roster,catalog:undefined});for(const answer of [{controller:route,workers:[],reviewers:[]},{mode:'deterministic'},{enabled:false},{stateRoot:f.stateRoot,reviewRoot:path.join(f.base,'packages'),cleanup:'retain-unmerged'},{enabled:false}])s=await answerSetup(session,{expectedRevision:s.revision,questionId:s.nextQuestion.id,answer});
 const preview=await previewSetup(session,{configFile:config,adopt:true,update:false});assert.equal(preview.applyReady,true);assert.equal(fs.existsSync(path.join(f.repo,'.mcp.json')),false);const applied=await applySetup(session,{previewHash:preview.previewHash,approve:true});assert.equal(applied.status,'applied');assert.equal((await applySetup(session,{previewHash:preview.previewHash,approve:true})).replayed,true);
 if(harness==='muse')assertHomePreview(preview.adoption);
 write(config,{...json(config),roster,controllerProfile:profile});const saved=Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('ORCH_')));for(const k of Object.keys(saved))delete process.env[k];process.env.ORCH_CONFIG=config;try{const before=snapshot(f.base),out=await setupHealth(session,{configFile:config},{discover:()=>({[harness]:true}),controllerQualification:async()=>({routes:[{...route,status:'controller-observed',profile,offerHash:'a'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString(),scope:'Fixed owned-step tool only'}],childRoutes:[]})});assert.ok(out.checks.some(c=>c.id==='adoption'&&c.status==='ok'));assert.ok(out.roles[0].missing.includes('repository-controller-profile-unqualified'));assert.equal(out.roles[0].qualification.status,'controller-observed');assert.notEqual(out.roles[0].status,'runtime-ready');assert.equal(out.roles[0].launchAllowed,false);assert.equal(out.providerCalls,0);assert.deepEqual(snapshot(f.base),before);}finally{for(const k of Object.keys(process.env))if(k.startsWith('ORCH_'))delete process.env[k];Object.assign(process.env,saved);}
});


test('P04h: adding Muse to existing Claude wiring requires an explicit owned update', async t => {
  const f = fixture(t, 'add-muse');
  assert.equal((await f.adopt({harness:['claude']})).exitCode, 0);
  const file = path.join(f.repo, '.mcp.json'), original = fs.readFileSync(file);
  const stale = await f.adopt({harness:['muse']});
  assertHomePreview(stale.items);
  assert.equal(stale.readiness[0].mcp, 'not-confirmed');
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(json(path.join(f.repo, '.orch-adopt.json')).mcp_harnesses, ['claude']);
  assertHomePreview((await f.adopt({harness:['muse'], update:true, 'dry-run':true})).items);
  assert.equal((await f.adopt({harness:['muse'], update:true})).exitCode, 0);
  assert.deepEqual(json(path.join(f.repo, '.orch-adopt.json')).mcp_harnesses, ['claude','muse']);
  assert.ok(json(file).mcpServers.orch.env.HOME);
  assert.equal((await f.adopt({harness:['muse']})).written.length, 0);
});

test('P04h: partial MCP failure records no uninstalled harness and resumes safely', async t => {
  const f = fixture(t, 'partial');
  const out = await f.adopt({}, {beforeItemWrite(item){if(item.path === '.mcp.json') throw Error('fixture publication failure');}});
  assert.equal(out.exitCode, 3);
  assert.ok(out.readiness.every(r => r.mcp === 'not-confirmed'));
  const manifest = json(path.join(f.repo, '.orch-adopt.json'));
  assert.equal(manifest.mcp_entry, null);
  assert.equal(manifest.mcp_harnesses, undefined);
  assert.equal(fs.existsSync(path.join(f.repo, '.mcp.json')), false);
  assert.equal((await f.adopt()).exitCode, 0);
  assert.equal((await f.adopt()).written.length, 0);
});

test('P04h: a later shared-server adoption still respects Muse schema and limits copied environment', async t => {
  const f = fixture(t, 'schema-env'), saved = process.env.ORCH_TEST_PRIVATE_VALUE;
  process.env.ORCH_TEST_PRIVATE_VALUE = 'must-not-copy';
  try {
    assert.equal((await f.adopt({harness:['muse']})).exitCode, 0);
    const file = path.join(f.repo, '.mcp.json'), doc = json(file);
    assert.deepEqual(Object.keys(doc.mcpServers.orch.env).sort(),
      ['HOME', ...(process.platform === 'win32' ? ['USERPROFILE'] : []), 'VIBE_HOME', 'XDG_CONFIG_HOME'].sort());
    doc.mcpServers.owner = {command:'owner', transport:'stdio'};write(file, doc);
    const before = snapshot(f.repo);
    assert.equal((await f.adopt({harness:['claude']})).exitCode, 3);
    assert.deepEqual(snapshot(f.repo), before);
  } finally {if(saved === undefined) delete process.env.ORCH_TEST_PRIVATE_VALUE;else process.env.ORCH_TEST_PRIVATE_VALUE = saved;}
});
