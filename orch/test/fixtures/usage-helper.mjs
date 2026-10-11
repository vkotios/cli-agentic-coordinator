// Deterministic JSON telemetry helper; never launches an inference provider.
import fs from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('codexbar')) {
  const marker=args[0];
  fs.appendFileSync(marker,JSON.stringify({version:args.includes('--version'),usage:args.includes('usage')})+'\n');
  if(args.includes('--version')) process.stdout.write('CodexBar '+(args.includes('wrong-version')?'0.75.0':'0.74.0')+'\n');
  else process.stdout.write(JSON.stringify([{provider:'codex',source:'oauth',usage:{updatedAt:args[1],identity:{accountEmail:'member@example.org'},primary:{usedPercent:20}}}]));
  process.exit(0);
}
const request=JSON.parse(fs.readFileSync(0,'utf8'));
const delay=args.find(a=>a.startsWith('delay='));
if(delay) await new Promise(resolve=>setTimeout(resolve,Number(delay.slice(6))));
if(args.includes('hang')) {setTimeout(()=>process.exit(0),8000);await new Promise(()=>{});}
if(args.includes('oversize')) { process.stdout.write('x'.repeat(1100000)); }
else if(args.includes('fail') || (args[0] && fs.existsSync(args[0]+'.fail'))) { process.stderr.write('secret-from-provider-error');process.exitCode=1; }
else {
  const marker=args[0];
  if(marker) fs.appendFileSync(marker,JSON.stringify({pid:process.pid,keyPresent:!!process.env.MISTRAL_API_KEY,nodeOptionsPresent:!!process.env.NODE_OPTIONS})+'\n');
  const o={provider:request.provider,pool:request.pool,account:request.account,workspace:request.workspace,billing:'subscription',accountFingerprint:request.accountFingerprint,sourceVersion:'0.74.0',observedAt:args[1]==='live'?new Date().toISOString():args[1]??new Date().toISOString(),windows:[{id:'monthly',kind:'quota',unit:'percent',used:25,remaining:75,limit:100,resetsAt:'2026-01-11T12:00:00Z'}],token:'canary'};
  process.stdout.write(JSON.stringify({version:1,observations:[o],email:'private-identity'}));
}
