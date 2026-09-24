// codex adapter (slice 2). CLI facts: docs/CLI_GUIDE.md "codex" + `codex exec --help`
// (v0.154.0, read not run).
//
//  - `codex exec`, the real codex.exe spawned directly (no shell, no .cmd shim).
//  - The model is REQUIRED and always passed with `-m` (owner rule 2026-09-19: an
//    unpinned launch silently uses ~/.codex/config.toml's model). A model the roster marks
//    `requires_permission` only with `--owner-approved-model`.
//  - Reasoning effort is always passed explicitly with `-c model_reasoning_effort=<e>`
//    (the user config has conflicting values; explicit flags on every launch).
//  - `--sandbox read-only` for a review, `workspace-write` for implementation.
//  - Prompt on stdin through the `-` argument; the keeper hands it the prompt FILE as fd 0.
//  - Heartbeat: `--json` JSONL events on stdout, incremental (spike Q7).
//  - Model used, in order: the `model:` line of the stderr header (printed only WITHOUT
//    --json - measured, see codexModelFromRollout); a `model` field in the JSONL events;
//    this run's own session rollout file, bound unambiguously; else UNKNOWN - never the
//    requested model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrchError } from '../errors.mjs';
import { canonicalId, assertModelPermitted } from '../models.mjs';
import { setting } from '../config.mjs';
import { resolveCliExe } from '../exe.mjs';
import { protocolErrorText } from '../statusrules.mjs';
import { QUOTA_RE } from './vibe.mjs';

export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

/** Flags orch sets itself or forbids; a `--flag` may not smuggle a second value in. */
const FORBIDDEN_FLAGS = /^(-m|--model|-s|--sandbox|--cd|-C|--json|-c|--config|--output-last-message|-o|--dangerously-bypass-approvals-and-sandbox|--full-auto|--oss|-p|--profile)(=|$)/;

export function resolveCodexExe() {
  return resolveCliExe('codex');
}

/**
 * The model codex reports it used, from its stderr header and/or its JSONL events.
 * @returns {{model:string|null, source:string, effort:string|null, sandbox:string|null, workdir:string|null}}
 */
export function extractCodexModel(stderrText, events = []) {
  const text = String(stderrText || '');
  const h = /^\s*model:\s*(\S+)\s*$/m.exec(text);
  const eff = /^\s*reasoning effort:\s*(\S+)\s*$/m.exec(text);
  const sb = /^\s*sandbox:\s*(.+?)\s*$/m.exec(text);
  const wd = /^\s*workdir:\s*(.+?)\s*$/m.exec(text);
  const base = { effort: eff ? eff[1] : null, sandbox: sb ? sb[1] : null, workdir: wd ? wd[1] : null };
  if (h) return { model: h[1], source: 'stderr-header', ...base };
  for (const e of events || []) {
    const m = e && (e.model || (e.item && e.item.model) || (e.msg && e.msg.model) || (e.session && e.session.model));
    if (typeof m === 'string' && m) return { model: m, source: `jsonl-event:${e.type || '?'}`, ...base };
  }
  return { model: null, source: 'none', ...base };
}

/** Where codex keeps its session rollouts: $CODEX_HOME/sessions, else ~/.codex/sessions. */
export function codexSessionsDir() {
  const explicit = setting('ORCH_CODEX_SESSIONS', 'codexSessionsDir', null, { isPath: true });
  if (explicit) return explicit;
  const home = process.env.CODEX_HOME || path.join(os.userInfo().homedir, '.codex');
  return path.join(home, 'sessions');
}

function sameDir(a, b) {
  if (!a || !b) return false;
  const n = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
}

/**
 * Follow-up 1 (slice-2 smoke). MEASURED: `codex exec --json` writes NOTHING on stderr
 * (a recorded --json review run and a spike run: 0 bytes), while the human-output mode prints
 * the `model:` header (the orchestrator's review launches without --json: 10:24 and 17:18,
 * both with the header). orch always uses --json, so the header is normally absent.
 *
 * The rollout file codex writes for the session is the source instead, bound to THIS run
 * without ambiguity:
 *  - the thread id comes from the run's own stdout (`{"type":"thread.started","thread_id":X}`),
 *    exactly one;
 *  - exactly one file `rollout-*-<X>.jsonl` in the date folders around the run's start;
 *  - its `session_meta` payload has `id === X` and `cwd` === the run's --dir;
 *  - every `turn_context` names ONE model (and that cwd).
 * Anything else is `unknown` with the reason. Read-only; the file is never modified.
 * @returns {{model:string|null, effort:string|null, source:string, reason:string, file:string|null}}
 */
export function codexModelFromRollout({ events, dir, startedAtMs, sessionsDir = codexSessionsDir() }) {
  const none = (reason, file = null) => ({ model: null, effort: null, source: 'none', reason, file });
  const ids = [...new Set((events || []).filter((e) => e && e.type === 'thread.started' && e.thread_id).map((e) => String(e.thread_id)))];
  if (ids.length !== 1) return none(ids.length ? `several thread ids in stdout: ${ids.join(', ')}` : 'no thread.started event in stdout');
  const id = ids[0];
  if (!/^[0-9a-f-]{16,64}$/i.test(id)) return none(`unexpected thread id ${id}`);
  const t = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();
  const folders = new Set();
  for (const off of [-1, 0, 1]) {
    const d = new Date(t + off * 86400000);
    const p2 = (n) => String(n).padStart(2, '0');
    folders.add(path.join(sessionsDir, String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate())));
    folders.add(path.join(sessionsDir, String(d.getUTCFullYear()), p2(d.getUTCMonth() + 1), p2(d.getUTCDate())));
  }
  const hits = [];
  for (const f of folders) {
    let names = [];
    try {
      names = fs.readdirSync(f);
    } catch {
      continue;
    }
    for (const n of names) if (n.startsWith('rollout-') && n.endsWith(`-${id}.jsonl`)) hits.push(path.join(f, n));
  }
  if (hits.length !== 1) return none(hits.length ? `${hits.length} rollout files for thread ${id}` : `no rollout file for thread ${id} under ${sessionsDir}`);
  const file = hits[0];
  let text = '';
  try {
    const st = fs.statSync(file);
    if (st.size > 64 * 1024 * 1024) return none('rollout file larger than 64 MB; not read', file);
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return none(`rollout unreadable: ${(e && e.message) || e}`, file);
  }
  let meta = null;
  const models = new Set();
  const efforts = new Set();
  let cwdMismatch = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o && o.type === 'session_meta' && !meta) meta = o.payload || null;
    if (o && o.type === 'turn_context' && o.payload) {
      if (o.payload.model) models.add(String(o.payload.model));
      if (o.payload.effort) efforts.add(String(o.payload.effort));
      if (o.payload.cwd && dir && !sameDir(o.payload.cwd, dir)) cwdMismatch = o.payload.cwd;
    }
  }
  if (!meta || String(meta.id) !== id) return none(`rollout session_meta id does not match thread ${id}`, file);
  if (!dir || !sameDir(meta.cwd, dir)) return none(`rollout cwd ${meta.cwd} is not this run's --dir ${dir}`, file);
  if (cwdMismatch) return none(`a turn_context ran in ${cwdMismatch}, not this run's --dir`, file);
  if (models.size !== 1) return none(models.size ? `several models in one session: ${[...models].join(', ')}` : 'no turn_context names a model', file);
  return { model: [...models][0], effort: efforts.size === 1 ? [...efforts][0] : null, source: 'codex-rollout', reason: 'bound by thread id, session id and cwd', file };
}

function parseJsonl(text) {
  const events = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* partial or non-JSON line */
    }
  }
  return events;
}

function readSafe(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

export default {
  name: 'codex',
  lane: 'cloud',
  needsModel: true,
  heartbeatStream: 'stdout',
  directoryEvidence: false,

  canonicalModel(model) {
    return canonicalId(model);
  },

  preLaunch(ctx) {
    if (!ctx.model || !String(ctx.model).trim()) throw new OrchError('codex needs --model (it is never left to ~/.codex/config.toml)', 'missing-arg');
    // Models the roster marks `requires_permission` need --owner-approved-model.
    assertModelPermitted(ctx.model, !!ctx.ownerApprovedModel);
    return { notes: [], extra: {} };
  },

  build(ctx) {
    const exe = resolveCodexExe();
    const sandbox = ctx.role === 'review' ? 'read-only' : 'workspace-write';
    const effort = ctx.effort || 'medium';
    if (!EFFORTS.includes(String(effort))) throw new OrchError(`--effort must be one of ${EFFORTS.join(', ')}`, 'bad-effort');
    for (const f of ctx.flags || []) {
      if (FORBIDDEN_FLAGS.test(String(f))) throw new OrchError(`--flag ${f} is set by orch for codex and may not be overridden`, 'forbidden-flag');
    }
    const lastMessage = path.join(ctx.runDir || path.dirname(ctx.promptPath), 'last-message.txt');
    const args = [
      'exec',
      '--cd', String(ctx.dir),
      '--sandbox', sandbox,
      '--json',
      '--color', 'never',
      '-m', String(ctx.model),
      '-c', `model_reasoning_effort=${effort}`,
      '--output-last-message', lastMessage,
      ...(ctx.flags || []).map(String),
      '-', // prompt on stdin (the keeper's fd 0 is the prompt file)
    ];
    return {
      file: exe,
      args,
      cwd: ctx.dir,
      envSet: { PWD: ctx.dir },
      envDelete: [],
      notes: [`codex exe: ${exe}`, `sandbox ${sandbox} (${ctx.role || 'implement'})`, `effort ${effort}`, 'prompt on stdin via "-"'],
    };
  },

  parseProtocol(stdout) {
    return parseJsonl(stdout);
  },

  /** The last agent message of the JSONL stream (`item.completed` / agent_message). */
  extractFinalMessage(stdout) {
    const events = parseJsonl(stdout);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const item = e && e.item;
      if (item && (item.type === 'agent_message' || item.item_type === 'agent_message') && typeof item.text === 'string' && item.text.trim()) {
        return item.text.trim();
      }
    }
    return String(stdout).trim();
  },

  postExit(ctx) {
    const stderr = ctx.stderrPath ? readSafe(ctx.stderrPath) : '';
    const events = ctx.stdoutPath ? parseJsonl(readSafe(ctx.stdoutPath)) : [];
    let got = extractCodexModel(stderr, events);
    const warnings = [];
    let rollout = null;
    if (!got.model) {
      // --json suppresses the header (measured): read this run's own session rollout.
      rollout = codexModelFromRollout({ events, dir: ctx.dir, startedAtMs: ctx.startedAtMs });
      if (rollout.model) got = { ...got, model: rollout.model, source: rollout.source, effort: got.effort || rollout.effort };
    }
    if (!got.model) warnings.push(`codex did not report the model it used (no \`model:\` header on stderr, no model field in the JSONL events, rollout: ${rollout ? rollout.reason : 'not consulted'}); model actually used is UNKNOWN`);
    const mismatch = got.model ? canonicalId(got.model) !== canonicalId(ctx.requestedCanonical) : undefined;
    if (mismatch) warnings.push(`MODEL MISMATCH: requested "${ctx.requestedCanonical}" but codex reported "${got.model}"`);
    return {
      actual_model: got.model,
      actual_model_source: got.source,
      codex_effort_reported: got.effort,
      codex_sandbox_reported: got.sandbox,
      codex_rollout: rollout ? { file: rollout.file, reason: rollout.reason } : undefined,
      model_mismatch: mismatch,
      warnings,
    };
  },

  // Exit code + stderr + protocol ERROR records only (the rule about rules).
  statusRules: [
    {
      name: 'codex-quota',
      test: (o) => o.exitCode !== 0 && QUOTA_RE.test(o.stderr + '\n' + protocolErrorText(o.events)),
      status: 'blocked-quota',
      reason: 'provider-quota',
    },
  ],
};
