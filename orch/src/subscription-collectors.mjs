// Explicit account-level subscription reads. No credential discovery, login, or inference.
import crypto from 'node:crypto';
export const SUBSCRIPTION_COLLECTOR_VERSION='1.0.0';
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const fail=()=>{throw new Error('subscription-collector');};
const object=v=>{if(!v || typeof v!=='object' || Array.isArray(v))fail();return v;};
function amount(v){if(v==null)return null;if(typeof v==='string' && /^\d+(?:\.\d+)?$/.test(v))v=Number(v);if(typeof v!=='number' || !Number.isFinite(v) || v<0)fail();return v;}
function date(v){if(v==null)return null;if(typeof v!=='string' || !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))?$/.test(v) || !Number.isFinite(Date.parse(v)))fail();return new Date(v).toISOString();}
function epoch(v){const n=amount(v);if(n==null || n===0)return null;if(n>64092211200)fail();return new Date(n*1000).toISOString();}
function quota(id,unit='percent',values={}){return {id,kind:'quota',unit,used:null,remaining:null,limit:null,resetsAt:null,durationMinutes:null,models:[],...values};}
function percentage(id,v,resetsAt,durationMinutes=null){const used=amount(v);return quota(id,'percent',{used,remaining:used==null?null:Math.max(0,100-used),limit:used==null?null:100,resetsAt,durationMinutes});}
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function binding(req,value){if(typeof value!=='string' || !value.trim() || hash(value.trim().toLowerCase())!==req.accountFingerprint)fail();}

/** @param {any} req @param {any} profile @param {string} credential @param {any} options */
export async function collectSubscription(req,profile,credential,{fetchImpl=fetch,now=Date.now(),timeoutMs=20000}={}) {
  try {
    object(req);object(profile);
    if(req.version!==1 || profile.version!==1 || req.provider!==profile.provider || !['cursor','copilot','muse'].includes(req.provider) || req.billing!=='subscription' || req.workspace!=='account' || req.sourceVersion!==SUBSCRIPTION_COLLECTOR_VERSION || !/^[a-f0-9]{64}$/.test(req.accountFingerprint) || ![req.pool,req.account].every(v=>typeof v==='string' && ID.test(v)))fail();
    if(typeof credential!=='string' || !credential || credential.length>16384 || /[\r\n\0]/.test(credential) || !Number.isFinite(now) || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>20000)fail();
    if(req.provider==='muse' && !credential.startsWith('dca:'))fail();
    if(req.provider==='copilot' && !/^gh[ou]_/.test(credential))fail();
    if(req.provider==='cursor' && !/(?:^|;\s*)(?:WorkosCursorSessionToken|__Secure-next-auth.session-token|next-auth.session-token)=[^;\s]+/.test(credential))fail();
    const controller=new AbortController();
    const expired=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('subscription-collector')),{once:true}));
    // One total budget, including all bodies. No retries or redirects to another auth host.
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    const bounded=p=>Promise.race([p,expired]);
    const read=async(url,headers,method='GET')=>{
      const response=await bounded(fetchImpl(url,{method,headers,redirect:'error',signal:controller.signal,...(method==='POST'?{body:'{}'}:{})}));
      if(response.status!==200 || !response.body)fail();
      const reader=response.body.getReader();let bytes=0;const chunks=[];
      try {for(;;){const r=await bounded(reader.read());if(r.done)break;bytes+=r.value.byteLength;if(bytes>1048576)fail();chunks.push(r.value);}}
      finally {try {await bounded(reader.cancel());}catch{}reader.releaseLock();}
      return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    };
    let windows;
    try {
      if(req.provider==='cursor') {
        const headers={Cookie:credential,Accept:'application/json'};
        const me=await read('https://cursor.com/api/auth/me',headers);binding(req,me.email);
        const data=await read('https://cursor.com/api/usage-summary',headers);
        const individual=data.individualUsage==null?{}:object(data.individualUsage);
        const plan=individual.plan==null?{}:object(individual.plan);
        const reset=date(data.billingCycleEnd);
        // No team/pooled fallback: the helper has verified only the individual account.
        const used=amount(plan.used),limit=amount(plan.limit);
        windows=[quota('included','currency',{used:used==null?null:used/100,limit:limit==null?null:limit/100,currency:'USD',resetsAt:reset})];
        for(const [id,key] of [['included-percent','totalPercentUsed'],['cursor-models','autoPercentUsed'],['third-party-models','apiPercentUsed']])if(plan[key]!=null){
          const window=percentage(id,plan[key],reset);
          // Zero paid entitlement says nothing about a free account's separate allowance.
          if(limit===0){window.remaining=null;window.limit=null;}
          windows.push(window);
        }
        if(individual.onDemand!=null){const od=object(individual.onDemand),u=amount(od.used),l=amount(od.limit);windows.push({...quota('on-demand','currency',{used:u==null?null:u/100,limit:l==null?null:l/100,currency:'USD',resetsAt:reset}),kind:'spend'});}
      } else if(req.provider==='copilot') {
        const headers={Authorization:`token ${credential}`,Accept:'application/json','Editor-Version':'vscode/1.96.2','Editor-Plugin-Version':'copilot-chat/0.26.7','User-Agent':'GitHubCopilotChat/0.26.7','X-Github-Api-Version':'2025-04-01'};
        const me=await read('https://api.github.com/user',{...headers,'X-Github-Api-Version':'2022-11-28'});if(!Number.isSafeInteger(me.id) || me.id<=0)fail();binding(req,`github.com:${me.id}`);
        const data=await read('https://api.github.com/copilot_internal/user',headers);
        if(data.token_based_billing!=null && typeof data.token_based_billing!=='boolean')fail();
        const snapshots=data.quota_snapshots==null?{}:object(data.quota_snapshots),reset=date(data.quota_reset_date);
        windows=[];
        for(const [legacyId,key] of [['premium-requests','premium_interactions'],['chat','chat']]) {
          const s=snapshots[key]==null?{}:object(snapshots[key]);
          if(s.unlimited!=null && typeof s.unlimited!=='boolean')fail();
          if(s.token_based_billing!=null && typeof s.token_based_billing!=='boolean')fail();
          const creditBilling=s.token_based_billing??data.token_based_billing??false;
          const id=creditBilling?(key==='premium_interactions'?'premium-credits':'chat-credits'):legacyId;
          const limit=amount(s.entitlement),remaining=amount(s.remaining),placeholder=limit===0 && remaining===0;
          const unknown=s.unlimited===true || placeholder;
          windows.push(quota(id,creditBilling?'credits':'requests',{used:creditBilling&&key==='premium_interactions'?amount(s.credits_used):null,remaining:unknown?null:remaining,limit:unknown?null:limit,resetsAt:reset}));
          if(!unknown && s.percent_remaining!=null){const left=amount(s.percent_remaining);if(left>100)fail();windows.push(quota(id+'-percent','percent',{used:100-left,remaining:left,limit:100,resetsAt:reset}));}
        }
        // GitHub may duplicate the same account credit counter under chat; never sum them.
        const credits=amount(snapshots.premium_interactions?.credits_used??snapshots.chat?.credits_used);
        if(credits!=null && !windows.some(w=>w.unit==='credits'&&w.used!=null))windows.push(quota('seat-credits','credits',{used:credits,resetsAt:reset}));
      } else {
        const data=await read('https://api.meta.ai/muse-code/key',{Authorization:`Bearer ${credential}`,'x-api-version':'1.0.0','User-Agent':'orch-subscription-collector','Content-Type':'application/json'},'POST');
        binding(req,data.user_email);
        if(data.is_subs_active!==true || (data.require_payment!=null && typeof data.require_payment!=='boolean') || data.require_payment===true)fail();
        // Deliberately ignore minted inference keys/payment metadata and never query browser teams.
        if(data.subs_usage==null)windows=[quota('session'),quota('weekly')];
        else {
          const u=object(data.subs_usage),session=object(u.window),weekly=object(u.weekly),minutes=amount(session.window_duration_mins);
          if(minutes==null || minutes===0 || !Number.isSafeInteger(minutes))fail();
          windows=[percentage('session',session.used_percent,epoch(session.resets_at),minutes),percentage('weekly',weekly.used_percent,epoch(weekly.resets_at),10080)];
        }
      }
      return {version:1,observations:[{pool:req.pool,provider:req.provider,account:req.account,workspace:'account',billing:'subscription',accountFingerprint:req.accountFingerprint,sourceVersion:SUBSCRIPTION_COLLECTOR_VERSION,observedAt:new Date(now).toISOString(),windows}]};
    } finally {clearTimeout(timer);controller.abort();}
  } catch {fail();}
}
