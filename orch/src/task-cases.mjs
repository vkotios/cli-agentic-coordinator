// Representative, bounded task cases. Passing one is never blanket role competence.
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import ts from 'typescript';
export const TASK_CASE='numeric-summary-v1';
export const REVIEW_CASE='finite-number-review-v1';
export const TASK_FILES={
  'stats.mjs':'export function summarizeReadings(values) { throw new TypeError("Implement the specified contract"); }\n',
  'review-target.mjs':'export function countValidReadings(values) { return values.filter(Boolean).length; }\n'
};
export const WORKER_CONTRACT='Implement only stats.mjs. Export exactly one synchronous function summarizeReadings(values). Accept an array of finite numbers; otherwise throw TypeError, including sparse arrays with missing entries. Return exactly {count,min,max,total}. Empty input: count/total 0 and min/max null. Do not mutate input. Use a pure function with for-of or array methods, no imports, I/O, computed member access, dynamic code or external helpers. Do not edit protected files, commit or change configuration.';
export const REVIEW_CONTRACT='Read-only review. Review stats.mjs against its contract and review-target.mjs against this contract: countValidReadings(values) receives an array and counts only finite numbers, including zero. Give reproducible findings for review-target.mjs. Return only JSON: {"challenge":"the value in challenge.txt","findings":[{"file":"review-target.mjs","input":[example values],"observed":number,"expected":number,"explanation":"why this violates the contract"}]}. Witness input arrays must contain only JSON-safe scalar values: finite JSON numbers, strings, booleans or null. Never put NaN, Infinity, -Infinity, undefined, JavaScript expressions or objects in a witness. Use strict JSON syntax with double-quoted property names; emit one complete JSON object and no prose or code fences. Do not edit, commit or change configuration. Do not claim the seeded target is clean.';
const fail=()=>{throw Error('Task source exceeds the pure helper case');};
export function validateTaskSource(source){
  if(typeof source!=='string'||Buffer.byteLength(source)>16384)fail();
  /** @type {any} */ const ast=ts.createSourceFile('stats.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  if(ast.parseDiagnostics.length||ast.statements.length!==1)fail();const fn=ast.statements[0];
  if(!ts.isFunctionDeclaration(fn)||fn.name?.text!=='summarizeReadings'||!fn.body||fn.asteriskToken||fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)||!fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))fail();
  const names=new Set(['summarizeReadings','Array','Number','Math','TypeError','undefined','Infinity']),callables=new Set(['summarizeReadings','Number','TypeError']),properties=new Set(['isArray','isFinite','length','min','max','total','count','reduce','some','filter','every','map','slice','push','sort','abs','floor','ceil','round']);
  const collect=n=>{if(ts.isParameter(n)||ts.isVariableDeclaration(n)){if(!ts.isIdentifier(n.name))return fail();names.add(n.name.text);if(n.initializer&&(ts.isArrowFunction(n.initializer)||ts.isFunctionExpression(n.initializer)))callables.add(n.name.text);}if(ts.isFunctionDeclaration(n)&&n.name){names.add(n.name.text);callables.add(n.name.text);}ts.forEachChild(n,collect);};collect(fn);
  const forbidden=new Set([ts.SyntaxKind.ImportDeclaration,ts.SyntaxKind.ImportEqualsDeclaration,ts.SyntaxKind.ClassDeclaration,ts.SyntaxKind.ClassExpression,ts.SyntaxKind.ElementAccessExpression,ts.SyntaxKind.ComputedPropertyName,ts.SyntaxKind.ThisKeyword,ts.SyntaxKind.SuperKeyword,ts.SyntaxKind.WithStatement,ts.SyntaxKind.TaggedTemplateExpression,ts.SyntaxKind.AwaitExpression,ts.SyntaxKind.YieldExpression,ts.SyntaxKind.GetAccessor,ts.SyntaxKind.SetAccessor]);
  const visit=n=>{if(forbidden.has(n.kind))fail();if(ts.isIdentifier(n)){if(['constructor','prototype','__proto__','process','globalThis','eval','Function','require','fetch'].includes(n.text))fail();const key=ts.isPropertyAccessExpression(n.parent)&&n.parent.name===n||ts.isPropertyAssignment(n.parent)&&n.parent.name===n;if(key?!properties.has(n.text):!names.has(n.text))fail();}if(ts.isNewExpression(n)&&(!ts.isIdentifier(n.expression)||n.expression.text!=='TypeError'))fail();if(ts.isCallExpression(n)){const e=n.expression;if(ts.isIdentifier(e)?!callables.has(e.text):!ts.isPropertyAccessExpression(e)||!properties.has(e.name.text))fail();}ts.forEachChild(n,visit);};visit(fn);return true;
}
const inputs=[[],[0],[1],[-2],[3,0,-4],[1,1,1],[0,0,0],[-20,30,5],[0.5,-0.25],[-9,-2],[8,3],[2,4,6],[-1,0,1],[101,-100],null,{},'x',[null],[true],['1']];
export async function verifyTaskImplementation(file){
  const source=fs.readFileSync(file,'utf8');try{validateTaskSource(source);}catch{return {scope:TASK_CASE,passed:false,checks:0,reason:'source-outside-case'};}
  const sourceHash=createHash('sha256').update(source).digest('hex'),module='data:text/javascript;base64,'+Buffer.from(source).toString('base64');
  const script=`import assert from 'node:assert/strict';const {summarizeReadings:f}=await import(${JSON.stringify(module)});for(const v of ${JSON.stringify(inputs)}){if(!Array.isArray(v)||v.some(x=>typeof x!=='number'||!Number.isFinite(x))){assert.throws(()=>f(v),TypeError);continue;}const before=JSON.stringify(v),expected={count:v.length,min:v.length?Math.min(...v):null,max:v.length?Math.max(...v):null,total:v.reduce((a,b)=>a+b,0)};assert.deepEqual(f(v),expected);assert.equal(JSON.stringify(v),before);}for(const v of [[NaN],[Infinity],[-Infinity],[undefined],[{}],Array(2),[1,,3]])assert.throws(()=>f(v),TypeError);console.log('TASK_CASE_PASSED');`;
  const env=Object.fromEntries(['SystemRoot','WINDIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  const permission=process.allowedNodeEnvironmentFlags.has('--permission')?'--permission':'--experimental-permission';
  return new Promise(resolve=>execFile(process.execPath,[permission,'--max-old-space-size=64','--input-type=module','-e',script],{cwd:path.dirname(file),env,windowsHide:true,timeout:5000,maxBuffer:65536},(e,stdout)=>{const passed=!e&&stdout.trim()==='TASK_CASE_PASSED';resolve({scope:TASK_CASE,passed,checks:passed?inputs.length+7:0,checksPlanned:inputs.length+7,sourceHash,reason:e?'verification-failed':null});}));
}
export function verifyTaskReview(raw,challenge){
  const classes=new Set();if(!raw||Object.keys(raw).sort().join(',')!=='challenge,findings'||raw.challenge!==challenge||!Array.isArray(raw.findings)||!raw.findings.length||raw.findings.length>8)return {scope:REVIEW_CASE,passed:false,defects:0};
  for(const f of raw.findings){if(!f||Object.keys(f).sort().join(',')!=='expected,explanation,file,input,observed'||f.file!=='review-target.mjs'||!Array.isArray(f.input)||f.input.length>32||f.input.some(x=>!['number','string','boolean'].includes(typeof x)&&x!==null)||typeof f.explanation!=='string'||!f.explanation.trim()||f.explanation.length>2048)return {scope:REVIEW_CASE,passed:false,defects:0};const observed=f.input.filter(Boolean).length,expected=f.input.filter(x=>typeof x==='number'&&Number.isFinite(x)).length;if(f.observed!==observed||f.expected!==expected||observed===expected)return {scope:REVIEW_CASE,passed:false,defects:0};if(f.input.includes(0)&&expected>observed)classes.add('zero-excluded');if(f.input.some(x=>typeof x!=='number'&&!!x)&&observed>expected)classes.add('non-numeric-included');}
  return {scope:REVIEW_CASE,passed:classes.size===2,defects:classes.size};
}
