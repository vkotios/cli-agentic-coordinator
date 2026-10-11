// Subscription telemetry contracts. Only allowlisted fields leave the collector boundary.
import path from 'node:path';
import crypto from 'node:crypto';
import { OrchError } from './errors.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,119}$/;
const VERSION = /^[0-9][a-zA-Z0-9.+-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const PROFILE_ENV = new Set(['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','CODEX_HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','SSL_CERT_FILE']);
function invalid() { throw new OrchError('Invalid or unbound subscription telemetry', 'usage-collector-invalid'); }
function id(value, pattern=ID) { if(typeof value!=='string' || !pattern.test(value)) invalid(); return value; }
function number(value) { if(value==null) return null; if(typeof value!=='number' || !Number.isFinite(value) || value<0) invalid();return value; }
function time(value, required=false) {
  if(value==null && !required) return null;
  if(typeof value!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}
function window(w) {
  if(!w || !['quota','spend','credits','estimate'].includes(w.kind) || !['percent','tokens','requests','seconds','currency','credits'].includes(w.unit)) invalid();
  const models=w.models??[];
  if(!Array.isArray(models) || models.length>16) invalid();
  const duration=number(w.durationMinutes);
  if(duration===0) invalid();
  const currency=w.currency==null?null:id(w.currency,/^[A-Z]{3}$/);
  if(w.unit==='currency' && !currency) invalid();
  return {id:id(w.id),kind:w.kind,unit:w.unit,used:number(w.used),remaining:number(w.remaining),limit:number(w.limit),resetsAt:time(w.resetsAt),durationMinutes:duration,models:models.map(m=>id(m,MODEL)),currency};
}
function observation(pool, observedAt, windows, mode) {
  if(!Array.isArray(windows) || windows.length>32) invalid();
  const normalized=windows.map(window);
  if(new Set(normalized.map(w=>w.id)).size!==normalized.length) invalid();
  return {pool:pool.id,provider:pool.provider,account:pool.account,workspace:pool.workspace,billing:'subscription',bindingVerified:true,source:{kind:pool.collector.kind,version:pool.collector.version,mode},observedAt:time(observedAt,true),windows:normalized};
}
function percent(id, w) {
  const used=number(w?.usedPercent);
  return {id,kind:'quota',unit:'percent',used,remaining:used==null?null:Math.max(0,100-used),limit:100,resetsAt:time(w?.resetsAt),durationMinutes:number(w?.windowMinutes)};
}

/** Raw CodexBar data is never persisted; account-email comparison happens in memory. */
export function normalizeCodexBar(raw, pool, verifiedVersion=null) {
  const entries=Array.isArray(raw)?raw:[raw];
  if(entries.length!==1) invalid();
  const entry=entries[0];
  if(!entry || entry.error || entry.provider!==pool.provider || (entry.version??verifiedVersion)!==pool.collector.version || (verifiedVersion!=null && verifiedVersion!==pool.collector.version) || entry.source!==pool.collector.source || !entry.usage) invalid();
  const email=entry.usage.identity?.accountEmail??entry.usage.accountEmail;
  if(typeof email!=='string' || crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex')!==pool.collector.accountFingerprint) invalid();
  let windows;
  if(pool.provider==='mistral') {
    const extra=entry.usage.extraRateWindows??[];
    if(!Array.isArray(extra)) invalid();
    const vibe=extra.filter(w=>w.id==='mistral-monthly-plan');
    if(vibe.length>1) invalid();
    windows=[percent('mistral-monthly-plan',vibe[0]?.window)];
  } else {
    windows=['primary','secondary','tertiary'].map(name=>percent(name,entry.usage[name]));
    const extra=entry.usage.extraRateWindows??[];
    if(!Array.isArray(extra) || extra.length>29) invalid();
    for(const w of extra) windows.push(percent(id(w.id),w.window));
  }
  return observation(pool,entry.usage.updatedAt,windows,pool.collector.source);
}

/** Versioned JSON bridge: one configured and explicitly attested billing pool per call. */
export function normalizeExternal(raw, pool) {
  if(raw?.version!==1 || !Array.isArray(raw.observations) || raw.observations.length!==1) invalid();
  const o=raw.observations[0];
  for(const [key,value] of Object.entries({provider:pool.provider,pool:pool.id,account:pool.account,workspace:pool.workspace,billing:'subscription',accountFingerprint:pool.collector.accountFingerprint,sourceVersion:pool.collector.version})) if(o?.[key]!==value) invalid();
  return observation(pool,o.observedAt,o.windows,'json');
}

/** The owner selects helpers and credential profiles. No executable/credential discovery. */
export function validateUsageConfig(raw, baseDir) {
  try {
    if(raw?.version!==1 || !Array.isArray(raw.pools) || raw.pools.length>8 || !Array.isArray(raw.bindings??[]) || (raw.bindings??[]).length>64) invalid();
    const pools=raw.pools.map(p=>{
      if(p.billing!=='subscription') invalid();
      const c=p.collector;
      if(!c || !['codexbar','json'].includes(c.kind) || typeof c.command!=='string' || !c.command || c.command.length>1024 || /\.(cmd|bat|ps1)$/i.test(c.command)) invalid();
      if(c.kind==='codexbar' && (!['claude','codex','mistral'].includes(p.provider) || c.source!==(p.provider==='mistral'?'web':'oauth'))) invalid();
      if(!Array.isArray(c.args??[]) || (c.args??[]).length>32 || (c.args??[]).some(a=>typeof a!=='string' || a.length>2048 || /api.?key|authorization|bearer\s|cookie|access.?token|refresh.?token|--source(?:=|$)|--provider(?:=|$)/i.test(a))) invalid();
      const env=c.env??{};
      if(!env || typeof env!=='object' || Array.isArray(env)) invalid();
      for(const [key,value] of Object.entries(env)) if(!PROFILE_ENV.has(key) || typeof value!=='string' || value.length>2048) invalid();
      const timeoutMs=c.timeoutMs??15000;
      if(!Number.isInteger(timeoutMs) || timeoutMs<100 || timeoutMs>30000) invalid();
      return {id:id(p.id),provider:id(p.provider),account:id(p.account),workspace:id(p.workspace),billing:'subscription',collector:{kind:c.kind,command:path.resolve(baseDir,c.command),args:[...(c.args??[])],version:id(c.version,VERSION),source:c.kind==='codexbar'?c.source:'json',accountFingerprint:id(c.accountFingerprint,HASH),timeoutMs,env:{...env}}};
    });
    if(new Set(pools.map(p=>p.id)).size!==pools.length) invalid();
    // Identical billing identity aliases must share a single pool, even across models/harnesses.
    const identities=pools.map(p=>JSON.stringify([p.provider,p.collector.accountFingerprint,p.workspace]));
    if(new Set(identities).size!==identities.length) invalid();
    const accountPools=pools.filter(p=>p.collector.kind==='codexbar').map(p=>JSON.stringify([p.provider,p.collector.accountFingerprint]));
    if(new Set(accountPools).size!==accountPools.length)invalid();
    const bindings=(raw.bindings??[]).map(b=>{
      if(!['controller','worker','reviewer'].includes(b.role) || !pools.some(p=>p.id===b.pool)) invalid();
      return {id:id(b.id),role:b.role,harness:id(b.harness),model:b.model==null?null:id(b.model,MODEL),pool:b.pool};
    });
    if(new Set(bindings.map(b=>b.id)).size!==bindings.length) invalid();
    const minRefreshSeconds=raw.minRefreshSeconds??60,staleAfterSeconds=raw.staleAfterSeconds??300;
    if(!Number.isInteger(minRefreshSeconds) || minRefreshSeconds<10 || minRefreshSeconds>3600 || !Number.isInteger(staleAfterSeconds) || staleAfterSeconds<minRefreshSeconds || staleAfterSeconds>86400) invalid();
    return {version:1,pools,bindings,minRefreshSeconds,staleAfterSeconds};
  } catch {
    throw new OrchError('Invalid usage configuration: use explicit subscription pools, bound accounts and telemetry helpers', 'bad-usage-config');
  }
}
