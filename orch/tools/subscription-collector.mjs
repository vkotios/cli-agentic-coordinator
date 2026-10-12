#!/usr/bin/env node
// Read-only JSON helper. Credentials must be supplied through an explicit private profile.
import fs from 'node:fs';
import path from 'node:path';
import {collectSubscription} from '../src/subscription-collectors.mjs';
function readJson(file){
  const fd=fs.openSync(file,'r');
  try {const stat=fs.fstatSync(fd);if(!stat.isFile() || stat.size>65536)throw Error();return JSON.parse(fs.readFileSync(fd,'utf8').replace(/^\uFEFF/,''));}
  finally {fs.closeSync(fd);}
}
try {
  const args=process.argv.slice(2);if(args.length!==2 || args[0]!=='--profile' || !args[1])throw Error();
  const profileFile=path.resolve(args[1]),profile=readJson(profileFile);
  if(profile.version!==1 || typeof profile.credentialFile!=='string' || !profile.credentialFile)throw Error();
  const stored=readJson(path.resolve(path.dirname(profileFile),profile.credentialFile));
  // Closed stdin and a small request envelope only; no environment credential fallback.
  let input='',bytes=0;
  const timer=setTimeout(()=>{process.stderr.write('subscription-collector\n');process.exit(1);},25000);
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>8192)throw Error();input+=chunk.toString('utf8');}
  const result=await collectSubscription(JSON.parse(input),profile,stored.credential);
  clearTimeout(timer);process.stdout.write(JSON.stringify(result));
} catch {process.stderr.write('subscription-collector\n');process.exit(1);}
