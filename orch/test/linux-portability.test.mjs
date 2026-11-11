import {cmdAdopt,KIT_ROOT,GUARD_COMMAND} from '../src/adopt.mjs';
import {makeRepo} from './wf-helpers.mjs';
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {samePath,isInside} from '../src/git.mjs';import {validateNativeArgv} from '../src/adapters/subscription-cli.mjs';import {discoverExecutables} from '../src/setup-health.mjs';
import {keeperFacts} from '../src/store.mjs';
test('platform path identity preserves Linux case and backslash names',()=>{
 assert.equal(samePath('/tmp/Owner','/tmp/owner'),process.platform==='win32');
 assert.equal(isInside('/tmp/Owner/file','/tmp/owner'),process.platform==='win32');
 assert.equal(samePath('/tmp/a'+String.fromCharCode(92)+'b','/tmp/a/b'),process.platform==='win32');
 assert.equal(isInside('/tmp/owner-other/file','/tmp/owner'),false);
});
test('keeper facts retain native exit-clock evidence without inventing it for old records',()=>{
 const stamp='linux:00000000-0000-4000-8000-000000000001:123:400';
 const event={event:'worker-exit',code:0,signal:null,at:'2026-01-01T00:00:00Z',process_clock:stamp};
 assert.equal(keeperFacts([JSON.stringify(event)]).workerExit.process_clock,stamp);
 delete event.process_clock;
 assert.equal(keeperFacts([JSON.stringify(event)]).workerExit.process_clock,undefined);
});
test('direct native subscription argv follows the platform without permitting shell wrappers',()=>{
 assert.doesNotThrow(()=>validateNativeArgv(process.execPath,['--fixture']));
 for(const suffix of ['cmd','bat','ps1'])assert.throws(()=>validateNativeArgv('/tmp/wrapper.'+suffix,[]));
 assert.throws(()=>validateNativeArgv(process.execPath,['nul\0argument']));
 assert.throws(()=>validateNativeArgv(process.execPath,['x'.repeat(40000)]));
});
test('setup discovery checks native executable permission without invoking a harness',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-native-discovery-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const names=['claude','codex','opencode','vibe','agy','copilot','muse'],before=Object.fromEntries(names.map(h=>['ORCH_'+h.toUpperCase()+'_EXE',process.env['ORCH_'+h.toUpperCase()+'_EXE']]));
 for(const key of Object.keys(before))delete process.env[key];t.after(()=>{for(const[key,value]of Object.entries(before))if(value===undefined)delete process.env[key];else process.env[key]=value;});
 const file=path.join(dir,process.platform==='win32'?'native.exe':'native');fs.writeFileSync(file,'synthetic executable: never run');fs.chmodSync(file,0o755);
 const config={exe:Object.fromEntries(names.map(h=>[h,file]))};assert.ok(Object.values(discoverExecutables(config,dir)).every(Boolean));
 if(process.platform!=='win32'){fs.chmodSync(file,0o644);assert.ok(Object.values(discoverExecutables(config,dir)).every(v=>v===false));}
 const wrapper=path.join(dir,'wrapper.cmd');fs.writeFileSync(wrapper,'synthetic');fs.chmodSync(wrapper,0o755);config.exe=Object.fromEntries(names.map(h=>[h,wrapper]));assert.ok(Object.values(discoverExecutables(config,dir)).every(v=>v===false));
});
test('Linux adoption retains a case-distinct owner hook and installs the actual guard',{skip:process.platform!=='linux'},async t=>{
 const repo=fs.mkdtempSync(path.join(os.tmpdir(),'orch-guard-case-'));t.after(()=>fs.rmSync(repo,{recursive:true,force:true}));makeRepo(repo,{'README.md':'fixture'});
 const settings=path.join(repo,'.claude/settings.json');fs.mkdirSync(path.dirname(settings));const owner={type:'command',command:'node "'+KIT_ROOT.toUpperCase()+'/hooks/guard.mjs"'};
 fs.writeFileSync(settings,JSON.stringify({hooks:{PreToolUse:[{matcher:'',hooks:[owner]}]}}));
 const result=await cmdAdopt({repo,harness:['claude'],json:true},{log(){}});assert.equal(result.exitCode,0);
 const hooks=JSON.parse(fs.readFileSync(settings,'utf8')).hooks.PreToolUse.flatMap(g=>g.hooks);
 assert.ok(hooks.some(h=>h.command===owner.command),'retain the case-distinct owner handler');
 assert.ok(hooks.some(h=>h.command===GUARD_COMMAND),'install the actual kit guard instead of accepting a case-distinct path');
});
