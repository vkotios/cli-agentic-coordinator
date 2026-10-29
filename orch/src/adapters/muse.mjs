// Native Muse exec (MSP JSONL). Never invoke its updater/login shell wrapper.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {whereAll,exeOverride} from '../exe.mjs';
import {canonicalId} from '../models.mjs';
import {OrchError} from '../errors.mjs';
import {setting} from '../config.mjs';
import {validateRequest as validateCommon,preflight,readBounded,parseJsonl,modelResult,deletedEnvironment,subscriptionStatusRules,validateNativeArgv} from './subscription-cli.mjs';
export function museBinaryInDirectory(dir){try{const version=readBounded(path.join(dir,'.muse-version'),128).trim();if(!/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/i.test(version))return null;const exe=path.join(dir,`muse-bin-${version}.exe`);return fs.statSync(exe).isFile()?exe:null;}catch{return null;}}
export function resolveMuseExe(){const explicit=exeOverride('muse');if(explicit)return explicit;for(const cmd of whereAll('muse.cmd')){const exe=museBinaryInDirectory(path.dirname(cmd));if(exe)return exe;}throw new OrchError('Muse native binary not found: set ORCH_MUSE_EXE / exe.muse or install the .muse-version marker beside muse.cmd; launcher shims are not selected','cli-not-found');}
function validateRequest(ctx){validateCommon(ctx);if(ctx.maxTurns!=null&&(!Number.isSafeInteger(ctx.maxTurns)||ctx.maxTurns<1))throw new OrchError('Muse --max-turns must be a positive integer','bad-max-turns');}
export function museAuthPath(){return process.env.MUSE_AUTH_PATH||path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'muse','auth.json');}
export function validateMuseSubscription(doc){const m=doc?.providers?.meta;let endpoint;try{endpoint=new URL(m?.api_base_url);}catch{/* refuse */}if(!m||typeof m.access_token!=='string'||!m.access_token.startsWith('dca:')||m.obtained_via!=='device_code'||m.mechanism!=='oauth'||endpoint?.origin!=='https://api.meta.ai')throw new OrchError('Muse needs saved device sign-in subscription provenance at the official provider; an ordinary API key is not accepted','subscription-auth-refused');}
export default {
  name:'muse',lane:'cloud',needsModel:true,heartbeatStream:'stdout',directoryEvidence:false,
  canonicalModel:canonicalId,validateRequest,
  preLaunch(ctx){validateRequest(ctx);const out=preflight(ctx);let doc;try{doc=JSON.parse(readBounded(museAuthPath(),1048576).replace(/^\uFEFF/,''));}catch{throw new OrchError('Muse saved subscription sign-in is unavailable','subscription-auth-refused');}validateMuseSubscription(doc);this.build({...ctx,promptPath:ctx.launchPromptPath||ctx.promptPath});return out;},
  build(ctx){
    validateRequest(ctx);const sandbox=setting(null,'muse.sandbox','enabled');if(!['enabled','disabled'].includes(sandbox))throw new OrchError('muse.sandbox must be enabled or disabled','bad-config');const args=['exec','--provider','meta','--json','--workspace',ctx.dir,'--prompt-file',ctx.promptPath,'--model',ctx.model,'--reasoning-effort',ctx.effort||'medium','--worktree','off','--approval-mode','never','--approval-judge','off','--disable-reminders','--disable-web-tools','--no-foreign-personal-context'];
    args.push('--trust-workspace');if(ctx.role==='review')args.push('--disable-write','--disable-shell');else if(sandbox==='disabled')args.push('--disable-sandbox');
    if(ctx.maxTurns!=null){if(!Number.isSafeInteger(ctx.maxTurns)||ctx.maxTurns<1)throw new OrchError('Muse --max-turns must be a positive integer','bad-max-turns');args.push('--max-model-steps',String(ctx.maxTurns));}
    args.push('--no-session-log');const empty=os.devNull;
    const file=resolveMuseExe();validateNativeArgv(file,args);
    return {file,args,cwd:ctx.dir,envSet:{PWD:ctx.dir},envDelete:deletedEnvironment([],['META_API_KEY','META_BASE_URL','META_API_BASE','MUSE_API_KEY','MUSE_BASE_URL','MUSE_TRANSPORT_TRACE','NODE_OPTIONS']),stdinFile:empty,notes:['Direct native Muse executable; prompt file, stdin empty','Saved device sign-in required; API overrides excluded','Reviewer disables both shell and file writes',...(ctx.role!=='review'&&sandbox==='disabled'?['Muse implementer runs without filesystem or network sandbox']:[])]};
  },
  parseProtocol(stdout){return parseJsonl(stdout).map(e=>({type:['run.terminal.failed','runtime.command.rejected'].includes(e.payload_type)?'error':'native-event',...(['run.terminal.failed','runtime.command.rejected'].includes(e.payload_type)?{message:e.payload?.reason||e.payload?.message}:{}),native:e}));},
  extractFinalMessage(stdout){const events=parseJsonl(stdout).filter(e=>e.schema_version===1&&e.payload_type==='run.terminal.completed'&&e.stream?.kind==='session'&&typeof e.payload?.text==='string');return events.at(-1)?.payload.text.trim()||'';},
  postExit(ctx){const events=parseJsonl(readBounded(ctx.stdoutPath));const terminals=events.filter(e=>e.schema_version===1&&e.payload_type==='run.terminal.completed'&&e.stream?.kind==='session');const runs=new Set(terminals.map(e=>e.payload?.run_stream?.id).filter(Boolean)),sessions=new Set(terminals.map(e=>e.stream.id));if(runs.size!==1||sessions.size!==1)return modelResult([],ctx.requestedCanonical,'none');const calls=events.filter(e=>e.schema_version===1&&e.payload_type==='run.model.configured'&&e.stream?.kind==='session'&&sessions.has(e.stream.id)&&runs.has(e.payload?.run_stream?.id)&&e.payload?.provider_id==='meta');return modelResult(calls.map(e=>e.payload?.model_id),ctx.requestedCanonical,'muse-runtime-model');},
  statusRules:subscriptionStatusRules,
};
