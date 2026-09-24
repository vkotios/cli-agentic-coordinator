#!/usr/bin/env node
// Local gateway benchmark: one model at a time, the same prompt, sequential requests only.
//
//   node orch/tools/bench-gateway.mjs --gateway <url> --models <a,b,...> [--out <file>]
//        [--max-tokens <n>] [--timeout-s <s>]
//
// The gateway URL and the model list are REQUIRED - from the flags, else ORCH_GATEWAY_URL /
// `gatewayUrl` and `bench.models` in orch.config.json. There is no default gateway.
// Per model: request 1 is cold (includes the model load), request 2 is warm. Uses llama.cpp's
// `timings` block when the gateway returns one; otherwise wall-clock time and `usage`.
// Never sends two requests at once, so the gateway never has to hold two models.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setting, userConfig } from '../src/config.mjs';
import { OrchError } from '../src/errors.mjs';

export const USAGE = `bench-gateway - benchmark the models of an OpenAI-compatible gateway, one at a time

  node orch/tools/bench-gateway.mjs --gateway <url> --models <id,id,...>
       [--out bench-results.json] [--max-tokens 400] [--timeout-s 900]

  --gateway   base URL ending in /v1, e.g. http://10.0.0.2:8080/v1
              (else ORCH_GATEWAY_URL, else "gatewayUrl" in orch.config.json)
  --models    comma-separated model ids as the gateway names them
              (else "bench": {"models": [...]} in orch.config.json)
`;

export const PROMPT = [
  'You are reviewing a small TypeScript helper. Answer concisely.',
  '',
  'function parseDuration(s: string): number {',
  '  const m = /^(\\d+)(ms|s|m|h)$/.exec(s.trim());',
  '  if (!m) throw new Error(`bad duration: ${s}`);',
  '  const n = Number(m[1]);',
  "  return m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60000 : n * 3600000;",
  '}',
  '',
  'Task: (1) list two edge cases this function mishandles, (2) write a corrected version',
  'that also accepts fractional values like "1.5h", (3) write three test cases as a table.',
].join('\n');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--help' || t === '-h') {
      out.help = true;
      continue;
    }
    if (!t.startsWith('--')) throw new OrchError(`unexpected argument: ${t}`, 'usage');
    const eq = t.indexOf('=');
    const name = eq >= 0 ? t.slice(2, eq) : t.slice(2);
    const value = eq >= 0 ? t.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new OrchError(`--${name} needs a value`, 'usage');
    out[name] = value;
  }
  return out;
}

/**
 * Resolve the benchmark options. Flags first, then environment, then orch.config.json.
 * @returns {{help?:boolean, gateway:string, models:string[], out:string, maxTokens:number, timeoutS:number}}
 */
export function parseBenchArgs(argv) {
  const f = flags(argv);
  if (f.help) return { help: true, gateway: '', models: [], out: '', maxTokens: 0, timeoutS: 0 };
  for (const k of Object.keys(f)) {
    if (!['gateway', 'models', 'out', 'max-tokens', 'timeout-s'].includes(k)) throw new OrchError(`unknown option --${k}`, 'usage');
  }
  const gateway = String(f.gateway || setting('ORCH_GATEWAY_URL', 'gatewayUrl', '') || '').trim().replace(/\/+$/, '');
  if (!gateway) throw new OrchError('a gateway URL is required: --gateway <url> (or ORCH_GATEWAY_URL, or "gatewayUrl" in orch.config.json)', 'usage');
  if (!/^https?:\/\//i.test(gateway)) throw new OrchError(`--gateway must be an http(s) URL, got: ${gateway}`, 'usage');
  let models = [];
  if (f.models) models = String(f.models).split(',');
  else {
    const cfg = userConfig().values;
    const list = cfg && cfg.bench && cfg.bench.models;
    if (Array.isArray(list)) models = list.map(String);
  }
  models = models.map((m) => m.trim()).filter(Boolean);
  if (!models.length) throw new OrchError('a model list is required: --models <id,id,...> (or "bench": {"models": [...]} in orch.config.json)', 'usage');
  const maxTokens = f['max-tokens'] === undefined ? 400 : Number(f['max-tokens']);
  const timeoutS = f['timeout-s'] === undefined ? 900 : Number(f['timeout-s']);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new OrchError('--max-tokens must be a positive integer', 'usage');
  if (!(timeoutS > 0)) throw new OrchError('--timeout-s must be a positive number', 'usage');
  return { gateway, models, out: path.resolve(String(f.out || 'bench-results.json')), maxTokens, timeoutS };
}

const round = (n, d = 1) => (typeof n === 'number' && Number.isFinite(n) ? +n.toFixed(d) : null);

/** One chat completion; never throws for an HTTP error (it is recorded). */
export async function oneRequest({ gateway, model, maxTokens, timeoutS, fetchImpl = fetch }) {
  const t0 = performance.now();
  const res = await fetchImpl(`${gateway}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }], max_tokens: maxTokens, temperature: 0, stream: false }),
    signal: AbortSignal.timeout(timeoutS * 1000),
  });
  const wall = (performance.now() - t0) / 1000;
  let j = {};
  try {
    j = await res.json();
  } catch {
    j = {};
  }
  const u = j.usage || {};
  const t = j.timings || {};
  const completion = u.completion_tokens ?? t.predicted_n ?? null;
  return {
    http: res.status,
    wall_s: round(wall, 2),
    prompt_tokens: u.prompt_tokens ?? t.prompt_n ?? null,
    completion_tokens: completion,
    prompt_tps: round(t.prompt_per_second),
    gen_tps: t.predicted_per_second != null ? round(t.predicted_per_second) : completion ? round(completion / wall) : null,
    finish: (j.choices && j.choices[0] && j.choices[0].finish_reason) || null,
    error: j.error ? String(j.error.message || j.error) : res.ok ? null : `HTTP ${res.status}`,
  };
}

/** Benchmark every model in turn; writes the results file after each model. */
export async function runBench({ gateway, models, out, maxTokens, timeoutS, fetchImpl = fetch, log = (s) => console.log(s) }) {
  const results = [];
  for (const model of models) {
    const row = { model, at: new Date().toISOString(), gateway };
    try {
      row.cold = await oneRequest({ gateway, model, maxTokens, timeoutS, fetchImpl });
      row.warm = await oneRequest({ gateway, model, maxTokens, timeoutS, fetchImpl });
      row.load_s_estimate = row.cold.wall_s != null && row.warm.wall_s != null ? round(row.cold.wall_s - row.warm.wall_s) : null;
    } catch (e) {
      row.error = String((e && e.message) || e);
    }
    results.push(row);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    log(JSON.stringify(row));
  }
  return results;
}

/** A human summary table (Markdown). */
export function summaryTable(results) {
  const lines = ['| model | load (s) | warm gen tok/s | warm wall (s) | finished within the cap? |', '|---|---|---|---|---|'];
  for (const r of results) {
    if (r.error || !r.warm) {
      lines.push(`| ${r.model} | error: ${r.error || 'no warm result'} | | | |`);
      continue;
    }
    const w = r.warm;
    const fin = w.error ? `error: ${w.error}` : w.finish === 'length' ? `no (length, ${w.completion_tokens ?? '?'} tokens)` : `yes (${w.completion_tokens ?? '?'} tokens)`;
    lines.push(`| ${r.model} | ${r.load_s_estimate ?? '?'} | ${w.gen_tps ?? '?'} | ${w.wall_s ?? '?'} | ${fin} |`);
  }
  return lines.join('\n');
}

/**
 * Roster entries to paste into orch/roster.json and then edit: every model that answered is
 * listed as a `local` opencode model, proposed for nothing until you decide (`workloads: []`).
 * The measured numbers go into `playbook_note`.
 */
export function rosterLines(results, provider = 'localai') {
  return results
    .filter((r) => !r.error && r.warm && !r.warm.error)
    .map((r) =>
      JSON.stringify({
        cli: 'opencode',
        model: `${provider}/${r.model}`,
        lane: 'local',
        workloads: [],
        cost_class: 'local-free',
        playbook_note: `bench ${r.at.slice(0, 10)}: load ~${r.load_s_estimate ?? '?'} s, warm ${r.warm.gen_tps ?? '?'} tok/s, finish ${r.warm.finish ?? '?'}`,
      }),
    );
}

async function main() {
  const opts = parseBenchArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  console.log(`benchmarking ${opts.models.length} model(s) on ${opts.gateway}, one at a time; results -> ${opts.out}`);
  const results = await runBench(opts);
  console.log('');
  console.log(summaryTable(results));
  console.log('');
  console.log('Roster entries (paste into orch/roster.json, set "family" and "workloads", edit the provider prefix to match your opencode config):');
  for (const l of rosterLines(results)) console.log(`  ${l},`);
}

const invokedDirectly = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    process.stderr.write(e instanceof OrchError ? `bench-gateway: ${e.message}\n\n${USAGE}` : `bench-gateway: ${(e && e.stack) || e}\n`);
    process.exitCode = 2;
  });
}
