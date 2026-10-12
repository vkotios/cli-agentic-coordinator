// Native-unit subscription telemetry fixture. No inference, login or secrets.
import fs from 'node:fs';
const request=JSON.parse(fs.readFileSync(0,'utf8'));
const raw=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
process.stdout.write(JSON.stringify({version:1,observations:[{...request,sourceVersion:'1',observedAt:new Date().toISOString(),windows:[{id:'session',kind:'quota',unit:'percent',used:100-raw.remaining,remaining:raw.remaining,limit:100,resetsAt:new Date(Date.now()+3600000).toISOString(),durationMinutes:300}]}]}));
