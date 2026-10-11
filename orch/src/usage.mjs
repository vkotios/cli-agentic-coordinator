// One subscription telemetry service for CLI and MCP, independent of the controlling harness.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeCodexBar, normalizeExternal, validateUsageConfig } from './usage-contract.mjs';
import { invokeCollector } from './usage-collector.mjs';
import { setting, loadConfig } from './config.mjs';
import { writeJsonAtomic } from './util.mjs';
import { OrchError } from './errors.mjs';
export { normalizeCodexBar, normalizeExternal, validateUsageConfig };

const ERRORS=new Set(['collector-start','collector-exit','collector-json','collector-invalid','collector-version','collector-timeout','collector-output-limit']);
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function safeJson(file) {
  const s=fs.lstatSync(file);
  if(!s.isFile() || s.isSymbolicLink() || s.nlink!==1 || s.size>65536) throw new Error('unsafe file');
  return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
function cachePaths(stateRoot,pool) {
  const dir=path.join(stateRoot,'usage');
  if(fs.existsSync(dir)) {const s=fs.lstatSync(dir);if(!s.isDirectory() || s.isSymbolicLink()) throw new OrchError('Usage cache directory must be an ordinary directory','usage-cache-unsafe');}
  const key=hash([pool.provider,pool.collector.accountFingerprint,pool.collector.kind==='codexbar'?null:pool.workspace]);
  return {dir,file:path.join(dir,key+'.json'),lock:path.join(dir,key+'.lock')};
}
/** @returns {any} */
function readCache(p,pool) {
  try {
    const raw=safeJson(p.file);
    if(raw.version!==1 || typeof raw.configFingerprint!=='string' || !Number.isFinite(Date.parse(raw.lastAttemptAt))) throw new Error('invalid cache');
    let observation=null;
    if(raw.configFingerprint===hash(pool) && raw.observation) {
      if(raw.observation.source?.version!==pool.collector.version || raw.observation.source?.kind!==pool.collector.kind) throw new Error('invalid cache source');
      observation=normalizeExternal({version:1,observations:[{...raw.observation,accountFingerprint:pool.collector.accountFingerprint,sourceVersion:pool.collector.version}]},pool);
      observation.source={kind:pool.collector.kind,version:pool.collector.version,mode:pool.collector.source};
    }
    const error=raw.error==null?null:ERRORS.has(raw.error.code)?{code:raw.error.code,cleanupPending:raw.error.cleanupPending===true,...(Number.isInteger(raw.error.collectorPid)?{collectorPid:raw.error.collectorPid}:{})}:null;
    return {version:1,configFingerprint:hash(pool),lastAttemptAt:raw.lastAttemptAt,observation,error};
  } catch(e) {
    if(e.code==='ENOENT') return {version:1,configFingerprint:hash(pool),lastAttemptAt:null,observation:null,error:null};
    return {version:1,configFingerprint:hash(pool),lastAttemptAt:null,observation:null,error:{code:'cache-unreadable'},protected:true};
  }
}
function render(pool,cache,config,now,refreshState) {
  const observation=cache.observation?structuredClone(cache.observation):null;
  const age=observation?now-Date.parse(observation.observedAt):null;
  const freshness=age==null || age<0?'unknown':age>config.staleAfterSeconds*1000?'stale':'fresh';
  if(observation) for(const w of observation.windows) w.freshness=w.resetsAt && Date.parse(w.resetsAt)<=now?'reset-stale':(w.used==null && w.remaining==null)?'unknown':freshness;
  return {id:pool.id,provider:pool.provider,account:pool.account,workspace:pool.workspace,billing:'subscription',freshness,observation,lastAttemptAt:cache.lastAttemptAt,nextRefreshAt:cache.lastAttemptAt?new Date(Date.parse(cache.lastAttemptAt)+config.minRefreshSeconds*1000).toISOString():null,error:cache.error,refreshState};
}
async function onePool(stateRoot,pool,config,refresh,now,clock) {
  const p=cachePaths(stateRoot,pool);
  let cache=readCache(p,pool);
  const cooling=()=>cache.lastAttemptAt && now-Date.parse(cache.lastAttemptAt)<config.minRefreshSeconds*1000;
  if(!refresh || cache.protected || cache.error?.cleanupPending || cooling()) return render(pool,cache,config,now,cache.protected?'cache-protected':cache.error?.cleanupPending?'cleanup-pending':!refresh?'cached':'cooldown');
  fs.mkdirSync(p.dir,{recursive:true});
  const token=crypto.randomUUID();
  let fd,releaseLock=true;
  try {fd=fs.openSync(p.lock,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({token,pid:process.pid}));}
  catch(e) {if(e.code==='EEXIST')return render(pool,readCache(p,pool),config,now,'refresh-busy');throw new OrchError('Cannot acquire the usage refresh lock','usage-cache-unwritable');}
  try {
    cache=readCache(p,pool);
    if(cache.protected || cache.error?.cleanupPending || cooling()) return render(pool,cache,config,now,cache.protected?'cache-protected':cache.error?.cleanupPending?'cleanup-pending':'cooldown');
    cache.lastAttemptAt=new Date(now).toISOString();
    // Durable cooldown precedes the request; a crash never means retry immediately.
    writeJsonAtomic(p.file,cache);
    // If publishing the outcome fails, keep the lock: an uncertain helper cleanup
    // must not be lost and followed by a new launch once the cooldown expires.
    releaseLock=false;
    const result=await invokeCollector(pool);
    const finishedNow=clock();
    if(result.error) cache.error=result.error;
    else {
      try {
        const o=pool.collector.kind==='codexbar'?normalizeCodexBar(result.data,pool,result.verifiedVersion):normalizeExternal(result.data,pool);
        if(Date.parse(o.observedAt)>finishedNow+5000) throw new Error('future observation');
        cache.observation=o;cache.error=null;
      } catch {cache.error={code:'collector-invalid'};}
    }
    writeJsonAtomic(p.file,cache);
    releaseLock=true;
    return render(pool,cache,config,finishedNow,'refreshed');
  } finally {
    fs.closeSync(fd);
    try {if(releaseLock && safeJson(p.lock).token===token)fs.unlinkSync(p.lock);}catch { /* Uncertain/changed locks stay protected. */ }
  }
}

/** @param {{stateRoot:string,configFile?:string,refresh?:boolean,pool?:string,role?:string,now?:number}} options */
export async function getUsage({stateRoot,configFile,refresh=false,pool:poolId,role,now}) {
  const started=performance.now();
  const wallClock=now===undefined;
  now??=Date.now();
  // Real refreshes sample the actual wall clock; injected test time advances monotonically.
  // Include config/cache/lock I/O, not just time spent inside the collector process.
  const clock=()=>wallClock?Date.now():now+(performance.now()-started);
  const file=configFile??setting('ORCH_USAGE_CONFIG','usageConfig',null,{isPath:true});
  if(!file) return {version:1,enabled:false,checkedAt:new Date(now).toISOString(),pools:[],bindings:[]};
  let raw;
  try {
    const resolved=path.resolve(file),s=fs.statSync(resolved);
    if(!s.isFile() || s.size>1048576)throw new Error('invalid config file');
    raw=JSON.parse(fs.readFileSync(resolved,'utf8').replace(/^\uFEFF/,''));
  } catch {throw new OrchError('Cannot read a regular usage configuration (maximum 1 MiB)','bad-usage-config');}
  const config=validateUsageConfig(raw,path.dirname(path.resolve(file)));
  if(role && !['controller','worker','reviewer'].includes(role)) throw new OrchError('Usage role must be controller, worker or reviewer','bad-usage-selection');
  if(poolId && !config.pools.some(p=>p.id===poolId)) throw new OrchError('Unknown configured usage pool','bad-usage-selection');
  const bindings=config.bindings.filter(b=>(!role || b.role===role) && (!poolId || b.pool===poolId));
  const pools=config.pools.filter(p=>(!poolId || p.id===poolId) && (!role || bindings.some(b=>b.pool===p.id)));
  const results=Array(pools.length);
  let next=0;
  // At most two waves of four 30-second helpers; MCP bounds the whole call at 90 seconds.
  await Promise.all(Array.from({length:Math.min(4,pools.length)},async()=>{
    for(;;) {
      const i=next++;if(i>=pools.length)return;
      try {results[i]=await onePool(stateRoot,pools[i],config,refresh,refresh?clock():now,clock);}
      catch {results[i]=render(pools[i],{observation:null,lastAttemptAt:null,error:{code:'cache-unavailable'}},config,now,'cache-protected');}
    }
  }));
  return {version:1,enabled:true,checkedAt:new Date(refresh?clock():now).toISOString(),pools:results,bindings};
}

export async function cmdUsage(args,io) {
  if(args._.length || Object.keys(args).some(k=>!['_','json','state-root','config','refresh','pool','role'].includes(k))) throw new OrchError('Usage: orch usage [--refresh] [--pool <id>] [--role controller|worker|reviewer] [--config <file>] [--json]','bad-usage');
  const cfg=loadConfig(args['state-root']);
  const result=await getUsage({stateRoot:cfg.stateRoot,configFile:args.config,refresh:args.refresh===true,pool:args.pool,role:args.role});
  if(args.json) io.log(JSON.stringify(result));
  else if(!result.enabled) io.log('Subscription usage is disabled; configure usageConfig to enable it.');
  else for(const p of result.pools) io.log(`${p.id}: ${p.freshness} (${p.refreshState})${p.error?' ['+p.error.code+']':''}\n${(p.observation?.windows??[]).map(w=>`  ${w.id}: used ${w.used??'unknown'}, remaining ${w.remaining??'unknown'} ${w.unit}; reset ${w.resetsAt??'unknown'}; ${w.freshness}`).join('\n')}`);
  return result;
}
