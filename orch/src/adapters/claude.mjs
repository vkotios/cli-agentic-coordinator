// Claude Code headless print mode (`claude -p`, stream-json). Lets a controller that is not Claude
// (Codex, Vibe, Muse ...) launch Claude as an implementer or a read-only reviewer.
// CLI facts below were read from `claude --help` and from the `system/init` event of offline probes
// (Claude Code 2.1.x on Windows); re-check them after an upgrade and record quirks in docs/CLI_GUIDE.md.
//
//  - Prompt: `-p` reads the handoff from STDIN (`stdinFile`), so nothing of it lands on argv.
//  - Isolation: `--setting-sources ""` loads no user/project/local settings, so none of their hooks,
//    permission rules, env or plugins run; `--strict-mcp-config` with an empty `--mcp-config` removes every
//    MCP server (the orch and gateway tools included); `--disable-slash-commands` drops skills.
//    `--bare` is NOT used: it ignores the saved login and would force API-key auth.
//  - Roles: an implementer gets `Read,Grep,Glob,Edit,Write,Bash` under `bypassPermissions` (print mode cannot
//    answer a permission prompt, and the run is already confined to its own worktree by orch). A reviewer gets
//    `Read,Grep,Glob` only: the other tools do not exist for it. This is a tool restriction, not an OS sandbox.
//  - Billing: subscription login only. ANTHROPIC_* / Bedrock / Vertex / Foundry variables are stripped from the
//    child so a stray key cannot switch the run to API billing or another endpoint.
//  - Failure shape: a failed run (e.g. an expired login) still prints a `result` event with `subtype:"success"`;
//    `is_error:true` is what marks it. Only a non-error `result` is a final message.
//  - Model used: the `model` of the main agent's assistant messages. `<synthetic>` (CLI-generated errors) and
//    sub-agent messages (`parent_tool_use_id`) do not count; with no assistant evidence, a `modelUsage` that
//    lists exactly one model is the fallback. The `init` event and the request are never proof.
import {resolveCliExe} from '../exe.mjs';
import {canonicalId,assertModelPermitted} from '../models.mjs';
import {OrchError} from '../errors.mjs';
import {protocolErrorText} from '../statusrules.mjs';
import {validateRequest as validateCommon,readBounded,parseJsonl,modelResult,deletedEnvironment,subscriptionStatusRules,validateNativeArgv} from './subscription-cli.mjs';

/** Claude's own wording for a spent plan or a missing/expired login (an expired login reads "Failed to authenticate: OAuth session expired ..."). */
const claudeStatusRules=[
  {name:'claude-quota',test:o=>o.exitCode!==0&&/usage limit (?:reached|exceeded)|hit your (?:\w+ )?limit|limit reached/i.test(o.stderr+'\n'+protocolErrorText(o.events)),status:'blocked-quota',reason:'provider-quota'},
  {name:'claude-auth',test:o=>o.exitCode!==0&&/failed to authenticate|oauth (?:session|token) (?:expired|revoked)|not logged in|please run \/login|invalid api key/i.test(o.stderr+'\n'+protocolErrorText(o.events)),status:'blocked-auth',reason:'provider-auth'},
];

export const ALLOWED_EFFORTS=['low','medium','high','xhigh','max'];
const IMPLEMENT_TOOLS='Read,Grep,Glob,Edit,Write,Bash';
const REVIEW_TOOLS='Read,Grep,Glob';

export function resolveClaudeExe(){
  return resolveCliExe('claude',{fallbacks:env=>[`${env.USERPROFILE||env.HOME||''}/.local/bin/claude${process.platform==='win32'?'.exe':''}`]});
}

function validateRequest(ctx){
  validateCommon({...ctx,effort:null});
  if(ctx.effort!=null&&!ALLOWED_EFFORTS.includes(ctx.effort))throw new OrchError(`Invalid reasoning effort for Claude (supported: ${ALLOWED_EFFORTS.join(', ')})`,'bad-effort');
  if(ctx.maxTurns!=null)throw new OrchError('--max-turns is not supported by the Claude adapter','unsupported-limit');
}

/** The served model id without a context-window suffix such as `[1m]`, lower-cased. */
const servedId=m=>{const id=canonicalId(String(m??'').replace(/\[[^\]]*\]$/,''));return id&&id!=='<synthetic>'?id:null;};
const isError=e=>e.type==='result'&&e.is_error===true;

export default {
  name:'claude',lane:'cloud',needsModel:true,heartbeatStream:'stdout',directoryEvidence:false,
  canonicalModel:canonicalId,validateRequest,
  preLaunch(ctx){
    validateRequest(ctx);assertModelPermitted(ctx.model,!!ctx.ownerApprovedModel);
    this.build({...ctx,promptPath:ctx.launchPromptPath||ctx.promptPath});
    return {notes:['Saved subscription login; no automatic API fallback (ANTHROPIC_*, Bedrock and Vertex variables are stripped)'],extra:{}};
  },
  build(ctx){
    validateRequest(ctx);
    const review=ctx.role==='review';
    const args=['-p','--model',ctx.model,...(ctx.effort?['--effort',ctx.effort]:[]),'--output-format','stream-json','--verbose','--no-session-persistence','--setting-sources','','--strict-mcp-config','--mcp-config',JSON.stringify({mcpServers:{}}),'--disable-slash-commands','--tools',review?REVIEW_TOOLS:IMPLEMENT_TOOLS,'--permission-mode',review?'default':'bypassPermissions'];
    const file=resolveClaudeExe();validateNativeArgv(file,args);
    return {
      file,args,cwd:ctx.dir,envSet:{PWD:ctx.dir},
      envDelete:deletedEnvironment(['ANTHROPIC_','CLAUDE_CODE_USE_'],['AWS_BEARER_TOKEN_BEDROCK','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_SSE_PORT','NODE_OPTIONS']),
      stdinFile:ctx.promptPath,
      notes:['Direct native Claude executable; handoff on stdin, nothing of it on argv','No settings, hooks, MCP servers or skills are loaded; --bare is not used so the saved login works',review?'Reviewer tools: Read, Grep, Glob only (a tool restriction, not an OS sandbox)':'Implementer tools: Read, Grep, Glob, Edit, Write, Bash under bypassPermissions, confined to the run worktree by orch'],
    };
  },
  parseProtocol(stdout){
    return parseJsonl(stdout).map(e=>isError(e)?{type:'error',message:String(e.result??''),native:e}:{type:'native-event',native:e});
  },
  extractFinalMessage(stdout){
    const results=parseJsonl(stdout).filter(e=>e.type==='result'&&e.is_error!==true&&typeof e.result==='string');
    return results.at(-1)?.result.trim()||'';
  },
  postExit(ctx){
    const events=parseJsonl(readBounded(ctx.stdoutPath));
    const served=[...new Set(events.filter(e=>e.type==='assistant'&&!e.parent_tool_use_id).map(e=>servedId(e.message?.model)).filter(Boolean))];
    let models=served;
    if(!models.length){
      const usage=events.filter(e=>e.type==='result'&&e.modelUsage&&typeof e.modelUsage==='object').at(-1)?.modelUsage;
      const keys=usage?[...new Set(Object.keys(usage).map(servedId).filter(Boolean))]:[];
      if(keys.length===1)models=keys;
    }
    return modelResult(models,servedId(ctx.requestedCanonical),'claude-assistant-message');
  },
  statusRules:[...subscriptionStatusRules,...claudeStatusRules],
};
