// Bounded telemetry helpers, never worker/model inference launches.
import { spawn } from 'node:child_process';
import { ownChildCreationTime, treeKillChecked } from './procs.mjs';

// Runtime/profile paths only. Arbitrary provider credentials and credential pointers
// never cross this boundary, including names not anticipated by a blacklist.
const RUNTIME_ENV=new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','COMPUTERNAME','USERNAME','HOME','LANG','LC_ALL','LC_CTYPE','TZ','SSL_CERT_FILE','SSL_CERT_DIR','XDG_RUNTIME_DIR','XDG_CONFIG_HOME']);

export function collectorEnvironment(profile={}) {
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>RUNTIME_ENV.has(key.toUpperCase())));
  return {...env,...profile};
}

/** @param {any} pool @returns {Promise<any>} */
export async function invokeCollector(pool, {spawnHelper=spawn}={}) {
  const c=pool.collector;
  if(c.kind==='json') return invokeOne(pool,c.args,'json',spawnHelper);
  const started=performance.now();
  const version=await invokeOne(pool,[...c.args,'--version'],'text',spawnHelper);
  if(version.error)return version;
  if(version.data.trim()!==`CodexBar ${c.version}`)return {error:{code:'collector-version'}};
  const remaining=Math.floor(c.timeoutMs-(performance.now()-started));
  if(remaining<=0)return {error:{code:'collector-timeout',cleanupPending:false}};
  const result=await invokeOne({...pool,collector:{...c,timeoutMs:remaining}},[...c.args,'usage','--provider',pool.provider,'--source',c.source,'--format','json','--json-only'],'json',spawnHelper);
  return {...result,verifiedVersion:c.version};
}

/** @param {any} pool @param {string[]} args @param {string} format @returns {Promise<any>} */
function invokeOne(pool,args,format,spawnHelper) {
  return new Promise(resolve=>{
    const c=pool.collector;
    let child;
    try {child=spawnHelper(c.command,args,{shell:false,windowsHide:true,env:collectorEnvironment(c.env),stdio:['pipe','pipe','pipe']});}
    catch {resolve({error:{code:'collector-start'}});return;}
    let output='',bytes=0,settled=false,timer,closed=false;
    const closeWaiters=[];
    child.on('close',()=>{closed=true;for(const resolve of closeWaiters)resolve();});
    const waitForClose=()=>closed?Promise.resolve():new Promise(resolve=>{const timer=setTimeout(resolve,250);closeWaiters.push(()=>{clearTimeout(timer);resolve();});});
    const identity=process.platform==='win32' && child.pid?ownChildCreationTime(child.pid,{deadlineMs:4000}):Promise.resolve(null);
    const finish=result=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();child.unref();
      resolve(result);
    };
    const stop=async code=>{
      if(settled)return;
      // Capture the bound before any asynchronous identity query. Never adopt an unrelated PID.
      settled=true;clearTimeout(timer);
      let cleanupPending=false;
      if(child.exitCode===null && child.signalCode===null) {
        if(process.platform==='win32') {
          const createdAt=await identity;
          if(createdAt) {const r=await treeKillChecked(child.pid,createdAt,{deadlineMs:2000});cleanupPending=!r.killed && (r.verdict!=='gone' || !closed);}
          else cleanupPending=true;
        } else {try {child.kill('SIGKILL');}catch {cleanupPending=true;}}
      } else if(!closed) cleanupPending=true;
      if(cleanupPending && (child.exitCode!==null || child.signalCode!==null)) {await waitForClose();cleanupPending=!closed;}
      child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();child.unref();
      resolve({error:{code,cleanupPending,...(cleanupPending?{collectorPid:child.pid}: {})}});
    };
    timer=setTimeout(()=>void stop('collector-timeout'),c.timeoutMs);
    const count=data=>{bytes+=data.length;if(bytes>1048576)void stop('collector-output-limit');};
    child.stdout.on('data',data=>{count(data);if(!settled)output+=data.toString('utf8');});
    child.stderr.on('data',count); // Never keep or print provider error text.
    child.on('error',()=>finish({error:{code:'collector-start'}}));
    child.stdin.on('error',()=>{});
    child.on('close',code=>{
      if(code!==0) {finish({error:{code:'collector-exit'}});return;}
      try {finish({data:format==='text'?output:JSON.parse(output)});}catch {finish({error:{code:'collector-json'}});}
    });
    if(c.kind==='json') child.stdin.end(JSON.stringify({version:1,pool:pool.id,provider:pool.provider,account:pool.account,workspace:pool.workspace,billing:'subscription',accountFingerprint:c.accountFingerprint,sourceVersion:c.version}));
    else child.stdin.end();
  });
}
