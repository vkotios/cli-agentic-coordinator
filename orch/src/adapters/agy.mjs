// agy (Gemini) adapter (slice 2). CLI facts: docs/CLI_GUIDE.md "agy" + `agy --help`
// (v1.2.5, read not run).
//
//  - `agy.exe` spawned directly: `--model <m> --mode plan --dangerously-skip-permissions
//    --print-timeout <t> --log-file <run dir>/agy.log -p <prompt>`.
//  - NEVER `--sandbox` (it hangs on the first shell command, and combined with the
//    skip-permissions flag it is bypassed anyway). A `--flag --sandbox...` is refused.
//  - The prompt goes on ARGV to the real exe (card: direct .exe argv survives multi-line
//    prompts >= 32 000 chars). Windows caps a whole command line at 32 767 chars, so a
//    prompt that cannot fit is refused rather than truncated. Stdin is an EMPTY file
//    (the card's launch is `$null | agy ...`), so the prompt is never delivered twice.
//  - Heartbeat: the per-run `--log-file`, minus keepalive lines (card).
//  - "exit 0 with empty output" is a failure: precedence rule 7 (`failed: empty-output`)
//    already says so for every adapter, and nothing here overrides it.
//  - Model used: agy logs `Model resolved via <how>` and `Resolving model <id>` /
//    `Print mode: starting (... model="<id>")` in the per-run log (fixtures: scratch
//    codereview-agy.log, agy-test.log).
import fs from 'node:fs';
import path from 'node:path';
import { OrchError } from '../errors.mjs';
import { resolveCliExe } from '../exe.mjs';
import { canonicalId } from '../models.mjs';

/** Leave room for the exe path and the other arguments inside the 32 767-char limit. */
export const MAX_PROMPT_CHARS = 30000;

const FORBIDDEN_FLAGS = /^(--sandbox|--model|--mode|--log-file|--print-timeout|-p|--print|--prompt|--prompt-interactive|-i)(=|$)/;

/** Keepalive lines are not activity (card: model-list pings, token refresh, quota manager). */
// Refined in the fix round: `http_helpers.go` also logs the real model calls
// (`streamGenerateContent`), which ARE activity; only its model-list / assist pings are
// keepalives (fixture agy-defaulting.log.txt).
export const KEEPALIVE_RE = /http_helpers\.go.*(fetchAvailableModels|loadCodeAssist)|browser\.go|quota_manager/;

export function resolveAgyExe() {
  return resolveCliExe('agy');
}

/**
 * The model agy says it used, from its per-run log.
 * @returns {{model:string|null, claimed:string|null, resolvedVia:string|null, defaulted:boolean, defaultTarget:string|null, label:string|null, source:string, evidence:string[]}}
 */
export function extractAgyModel(logText) {
  const text = String(logText || '');
  const evidence = [];
  let resolvedVia = null;
  let model = null;
  let source = 'none';
  let label = null;
  let notInLocalConfig = null;
  let defaultTarget = null;
  for (const line of text.split(/\r?\n/)) {
    let m = /Model resolved via (\S+)/.exec(line);
    if (m) {
      resolvedVia = m[1];
      evidence.push(line.trim());
      continue;
    }
    m = /Model ID (\S+) not in local config(?:, defaulting to (\S+))?/.exec(line);
    if (m) {
      notInLocalConfig = m[1];
      defaultTarget = m[2] || null;
      evidence.push(line.trim());
      continue;
    }
    m = /Resolving model (\S+)/.exec(line);
    if (m) {
      model = m[1];
      source = 'log:Resolving model';
      continue;
    }
    m = /Print mode: starting \(.*?model="([^"]+)"/.exec(line);
    if (m && source !== 'log:Resolving model') {
      model = m[1];
      source = 'log:Print mode';
      evidence.push(line.trim());
      continue;
    }
    m = /label="([^"]+)"/.exec(line);
    if (m && /Propagating selected model/.test(line)) label = m[1];
  }
  // Follow-up 2 (slice-2 smoke): when agy says the requested id is NOT in its local
  // config and it resolved "via default", the later `Resolving model <requested id>`
  // lines only echo the request - they are not evidence of what served it. The model
  // used is then UNKNOWN. The default target it names (`CCPA`) is a routing backend,
  // not a model id, so it is recorded separately and never reported as the model.
  const defaulted = !!notInLocalConfig || resolvedVia === 'default';
  if (defaulted) {
    return { model: null, claimed: model, resolvedVia, defaulted, defaultTarget, label, source: 'unknown:resolved-via-default', evidence: evidence.slice(0, 6) };
  }
  return { model, claimed: model, resolvedVia, defaulted, defaultTarget, label, source, evidence: evidence.slice(0, 6) };
}

function readSafe(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

export default {
  name: 'agy',
  lane: 'cloud',
  needsModel: true,
  heartbeatStream: 'stdout',
  directoryEvidence: false,

  canonicalModel(model) {
    return canonicalId(model);
  },

  /** The per-run log is agy's heartbeat. */
  heartbeatFile(runDir) {
    return path.join(runDir, 'agy.log');
  },
  isKeepalive(line) {
    return KEEPALIVE_RE.test(String(line));
  },

  build(ctx) {
    const exe = resolveAgyExe();
    const prompt = fs.readFileSync(ctx.promptPath, 'utf8');
    if (prompt.includes('\0')) throw new OrchError('the handoff contains a NUL byte; it cannot travel on argv', 'bad-handoff');
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new OrchError(`the handoff is ${prompt.length} chars; agy takes its prompt on argv and Windows caps a command line at 32 767 chars (limit here ${MAX_PROMPT_CHARS})`, 'handoff-too-long');
    }
    for (const f of ctx.flags || []) {
      if (FORBIDDEN_FLAGS.test(String(f))) throw new OrchError(`--flag ${f} is forbidden or set by orch for agy (never --sandbox)`, 'forbidden-flag');
    }
    const printTimeout = ctx.printTimeout || '45m';
    if (!/^\d+(\.\d+)?(ms|s|m|h)$/.test(String(printTimeout))) throw new OrchError(`--print-timeout must look like 45m / 300s (got ${printTimeout})`, 'bad-print-timeout');
    const runDir = ctx.runDir || path.dirname(ctx.promptPath);
    const logFile = path.join(runDir, 'agy.log');
    const stdinFile = path.join(runDir, 'stdin-empty.txt');
    fs.writeFileSync(stdinFile, '');
    const args = [
      '--model', String(ctx.model),
      '--mode', 'plan',
      '--dangerously-skip-permissions',
      '--print-timeout', String(printTimeout),
      '--log-file', logFile,
      ...(ctx.flags || []).map(String),
      '-p', prompt,
    ];
    return {
      file: exe,
      args,
      cwd: ctx.dir,
      envSet: { PWD: ctx.dir },
      envDelete: [],
      stdinFile,
      notes: [`agy exe: ${exe}`, 'prompt on argv (-p), stdin empty', `per-run log ${logFile}`, 'never --sandbox'],
    };
  },

  extractFinalMessage(stdout) {
    return String(stdout).trim();
  },

  postExit(ctx) {
    const log = ctx.runDir ? readSafe(path.join(ctx.runDir, 'agy.log')) : '';
    const got = extractAgyModel(log);
    const warnings = [];
    if (!log) warnings.push('agy wrote no per-run log; model actually used is UNKNOWN');
    else if (got.defaulted) {
      warnings.push(`agy logged that the requested model is not in its local config and resolved it via ${got.resolvedVia || 'a default'}${got.defaultTarget ? ` (default target ${got.defaultTarget})` : ''}; the model actually used is UNKNOWN (agy later logged "Resolving model ${got.claimed || '?'}", which only echoes the request)`);
    } else if (!got.model) warnings.push('agy log names no model; model actually used is UNKNOWN');
    else if (got.resolvedVia) warnings.push(`agy resolved the model via "${got.resolvedVia}"`);
    const mismatch = got.model ? canonicalId(got.model) !== canonicalId(ctx.requestedCanonical) : undefined;
    if (mismatch) warnings.push(`MODEL MISMATCH: requested "${ctx.requestedCanonical}" but agy logged "${got.model}"`);
    return {
      actual_model: got.model,
      actual_model_source: got.source,
      agy_model_resolved_via: got.resolvedVia,
      agy_model_label: got.label,
      agy_model_evidence: got.evidence,
      agy_model_claimed: got.claimed,
      model_mismatch: mismatch,
      warnings,
    };
  },

  statusRules: [],
};
