import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {makeCase,orch} from './helpers.mjs';
import {loadConfig} from '../src/config.mjs';
import {readDocument,readEvidence,readEvidenceAsync,listReviewEvidence} from '../src/archive.mjs';
import {beginReviewMetadata,confirmReviewMetadata} from '../src/metadata.mjs';
import {projectReviewHeader} from '../src/review-header.mjs';

function fixture(t,name){const c=makeCase(name);t.after(()=>c.cleanup());const cfg=loadConfig(c.stateRoot);fs.mkdirSync(path.join(c.stateRoot,'reviews'),{recursive:true});return {c,cfg};}
function review(c,id,wp,extra={}){const row={id,wp,status:'finished',finished_at:'2026-01-01T00:00:00.000Z',outcome:'reviewed',containment:'clean',worktree_removed:true,...extra};const file=path.join(c.stateRoot,'reviews',`${id}.json`);fs.writeFileSync(file,JSON.stringify(row));return {file,row,before:fs.readFileSync(file)};}

test('legacy review compatibility: full sync and async reads retain multi-megabyte snapshot values without rewriting evidence',async t=>{
  const {c,cfg}=fixture(t,'large-review-read');
  const r=review(c,'rv-20260101-000000-abc123','WP-large',{pre:{source:{status:'!! ignored/entry\0'.repeat(245000),impl_status:'?? worker/entry\0'.repeat(245000)}}});
  assert.ok(r.before.length>7*1024*1024);
  assert.throws(()=>readDocument(r.file),{code:'archive-oversized'},'ordinary document bound stays small');
  assert.deepEqual(readEvidence(cfg,'review',r.row.id).record,r.row);
  assert.deepEqual((await readEvidenceAsync(cfg,'review',r.row.id)).record,r.row);
  assert.deepEqual(fs.readFileSync(r.file),r.before);
});

test('package review inventory: skips another package body before archive validation and preserves its evidence',t=>{
  const {c,cfg}=fixture(t,'review-inventory-scope');
  const foreign=review(c,'rv-20260101-000000-abc123','WP-old',{pre:{source:{status:'x'.repeat(3*1024*1024)}}});
  // A clearly foreign retained body is structurally delimited but not valid JSON.
  // Scope comes from top-level id/wp; selected records still require full parsing.
  fs.writeFileSync(foreign.file,`{"pre":{"ignored":[1,,2]},"nested":{"wp":"WP-target"},"id":"${foreign.row.id}","wp":"WP-old"}`);
  const before=fs.readFileSync(foreign.file);
  const own=review(c,'rv-20260101-000000-def456','WP-target');
  assert.deepEqual(listReviewEvidence(cfg,{wp:'wp-TARGET'}).map(r=>r.id),[own.row.id]);
  assert.deepEqual(fs.readFileSync(foreign.file),before);
  assert.throws(()=>listReviewEvidence(cfg),{code:'archive-unreadable'},'global evidence reads remain strict');
});

test('package review inventory: duplicate or unreadable ownership cannot hide a selected review',t=>{
  const {c,cfg}=fixture(t,'review-ambiguous-scope');
  const r=review(c,'rv-20260101-000000-abc123','WP-old');
  fs.writeFileSync(r.file,`{"id":"${r.row.id}","wp":"WP-old","\\u0077p":"WP-target"}`);
  assert.throws(()=>listReviewEvidence(cfg,{wp:'WP-target'}),{code:'archive-unreadable'});
});

test('cleanup dry-run: foreign large review cannot block the requested package and both records stay unchanged',async t=>{
  const {c}=fixture(t,'cleanup-review-scope');
  const foreign=review(c,'rv-20260101-000000-abc123','WP-old',{pre:{source:{status:'x'.repeat(3*1024*1024)}}});
  const own=review(c,'rv-20260101-000000-def456','WP-target',{worktree_removed:false});
  const r=await orch(['cleanup','--wp','WP-target','--dry-run','--json'],c.env);
  assert.equal(r.code,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout).resources.map(x=>x.id),[own.row.id]);
  assert.deepEqual(fs.readFileSync(foreign.file),foreign.before);assert.deepEqual(fs.readFileSync(own.file),own.before);
});

test('cleanup and finish: clearly foreign malformed payload does not poison scoped operations',async t=>{
  const {c}=fixture(t,'finish-review-scope');
  const r=review(c,'rv-20260101-000000-abc123','WP-old');
  fs.writeFileSync(r.file,`{"id":"${r.row.id}","wp":"WP-old","pre":{"ignored":[1,,2]}}`);
  const before=fs.readFileSync(r.file);
  let out=await orch(['cleanup','--wp','WP-target','--dry-run','--json'],c.env);assert.equal(out.code,0,out.stderr);assert.deepEqual(JSON.parse(out.stdout).resources,[]);
  assert.equal((await orch(['claim','WP-target','--by','owner'],c.env)).code,0);
  out=await orch(['finish','WP-target','--by','owner','--json'],c.env);assert.equal(out.code,0,out.stderr);assert.equal(JSON.parse(out.stdout).state,'finished');
  assert.deepEqual(fs.readFileSync(r.file),before);
});

test('cleanup: selected malformed review remains a blocker and is not rewritten',async t=>{
  const {c}=fixture(t,'cleanup-selected-malformed');const r=review(c,'rv-20260101-000000-abc123','WP-target');
  fs.writeFileSync(r.file,`{"id":"${r.row.id}","wp":"WP-target","pre":{"ignored":[1,,2]}}`);const before=fs.readFileSync(r.file);
  const out=await orch(['cleanup','--wp','WP-target','--dry-run','--json'],c.env);assert.notEqual(out.code,0);assert.match(out.stderr,/unreadable/);assert.deepEqual(fs.readFileSync(r.file),before);
});

test('large review finalization: metadata confirmation uses the same compatible reader and preserves the record',t=>{
  const {c,cfg}=fixture(t,'large-review-metadata');const id='rv-20260101-000000-abc123';
  beginReviewMetadata(cfg,id);
  const r=review(c,id,'WP-large',{pre:{source:{status:'x'.repeat(3*1024*1024)}}});
  confirmReviewMetadata(cfg,id);
  const metadata=readDocument(path.join(c.stateRoot,'retention','metadata-owned','review',id+'.json'));
  assert.equal(metadata.state,'confirmed');assert.equal(metadata.id,id);assert.match(metadata.record_sha256,/^[0-9a-f]{64}$/);
  assert.deepEqual(fs.readFileSync(r.file),r.before);
});

test('scoped compact evidence: foreign invalid proof is not evaluated but selected proof still fails closed',t=>{
  const {c,cfg}=fixture(t,'review-compact-scope');const id='rv-20260101-000000-abc123';
  const file=path.join(c.stateRoot,'retention','archive','review',id+'.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({id,kind:'review',data:{record:{id,wp:'WP-old'}},sha256:'invalid'}));const before=fs.readFileSync(file);
  const own=review(c,'rv-20260101-000000-def456','WP-target');
  assert.deepEqual(listReviewEvidence(cfg,{wp:'WP-target'}).map(r=>r.id),[own.row.id]);assert.deepEqual(fs.readFileSync(file),before);
  assert.throws(()=>listReviewEvidence(cfg,{wp:'WP-old'}),{code:'archive-unreadable'});
});

test('review compatibility stays bounded: oversized input is refused intact before allocating its declared size',async t=>{
  const {c,cfg}=fixture(t,'large-review-budget');const id='rv-20260101-000000-abc123';const r=review(c,id,'WP-large');
  const fd=fs.openSync(r.file,'r+');fs.ftruncateSync(fd,65*1024*1024);fs.closeSync(fd);const before=fs.statSync(r.file);
  assert.throws(()=>readEvidence(cfg,'review',id),{code:'archive-oversized'});
  await assert.rejects(readEvidenceAsync(cfg,'review',id),{code:'archive-oversized'});
  assert.equal(fs.statSync(r.file).size,before.size);assert.equal(fs.statSync(r.file).mtimeMs,before.mtimeMs);
});


test('ownership projection: excessive nesting is bounded, normal nested values and large strings still project',()=>{
  const header={id:'rv-20260101-000000-abc123',wp:'WP-old'};
  const nested=depth=>`{"id":"${header.id}","wp":"${header.wp}","body":${'['.repeat(depth)}0${']'.repeat(depth)}}`;
  assert.deepEqual(projectReviewHeader(nested(4096)),header);
  assert.throws(()=>projectReviewHeader(nested(4097)),/nesting/);
  assert.deepEqual(projectReviewHeader(JSON.stringify({...header,body:'x'.repeat(3*1024*1024)})),header);
  assert.throws(()=>projectReviewHeader('{"id": "rv-20260101-000000-abc123","wp": "WP-old","body":   }'),/empty/);
});
