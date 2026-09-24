// vibe adapter.
//
// Verified mechanics (from the original spike runs; see docs/CLI_GUIDE.md "vibe"):
//  - bare `-p` plus the handoff on stdin; --max-turns/--max-price/--output exist
//    only in -p mode (Q1b, card note 5).
//  - vibe decodes stdin as cp1252: non-ASCII is silently mojibaked (Q1b). We refuse
//    non-ASCII handoffs unless --allow-non-ascii.
//  - turn cap = exit 1 + empty stdout + `<vibe_stop_event>Turn limit of N reached</vibe_stop_event>`
//    on stderr (Q6).
//  - `--output streaming` NDJSON is a first-class heartbeat (Q7).
//  - there is no --model flag: the worktree's .vibe/config.toml must declare and
//    select the model, top-level `active_model` first (card).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OrchError } from '../errors.mjs';
import { setting } from '../config.mjs';
import { resolveCliExe } from '../exe.mjs';
import { isAscii, nonAsciiSamples, readJson } from '../util.mjs';
import { protocolErrorText } from '../statusrules.mjs';

export const DEFAULT_VIBE_LOG_DIR = path.join(os.homedir(), '.vibe', 'logs');

/** Overridable so session binding can be tested against fixtures. */
export function vibeLogDir() {
  return setting('ORCH_VIBE_LOG_DIR', 'vibeLogDir', DEFAULT_VIBE_LOG_DIR, { isPath: true });
}

/** The text of a vibe `message` event, whose content may be a string or a content array. */
export function messageText(e) {
  if (!e) return '';
  const c = e.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  if (typeof e.text === 'string') return e.text.trim();
  return '';
}

function resolveExe() {
  // PATH first (bounded where.exe, see exe.mjs); then the current user's ~/.local/bin,
  // where `uv tool install` puts it.
  return resolveCliExe('vibe', { fallbacks: (env) => [path.join(env.USERPROFILE || os.homedir(), '.local', 'bin', 'vibe.exe')] });
}

export function aliasFor(model) {
  const a = String(model).split('/').pop().replace(/[^A-Za-z0-9]/g, '');
  return a || 'orchmodel';
}

export function providerFor(model) {
  if (process.env.ORCH_VIBE_PROVIDER) return process.env.ORCH_VIBE_PROVIDER;
  const s = String(model);
  return s.includes('/') ? s.split('/')[0] : 'mistral';
}

/**
 * Merge our model declaration into an existing .vibe/config.toml without losing
 * anything else in it. Top-level `active_model` must precede any table, and any
 * previous [[models]] block for the same alias/name is replaced, not duplicated.
 */
export function mergeVibeConfig(existing, { alias, name, provider }) {
  const lines = String(existing || '').split(/\r?\n/);
  const firstSection = lines.findIndex((l) => /^\s*\[/.test(l));
  const preambleEnd = firstSection < 0 ? lines.length : firstSection;
  const preamble = lines.slice(0, preambleEnd).filter((l) => !/^\s*active_model\s*=/.test(l));
  const body = lines.slice(preambleEnd);

  // Take over the [[models]] block that declares the same alias or name - but KEEP every
  // other key it carries (item 12: temperature, prices, thinking, auto_compact_threshold and
  // anything else the owner set were silently discarded before).
  const kept = [];
  const carried = [];
  const OURS = new Set(['name', 'provider', 'alias']);
  let i = 0;
  while (i < body.length) {
    if (/^\s*\[\[\s*models\s*\]\]/.test(body[i])) {
      let j = i + 1;
      while (j < body.length && !/^\s*\[/.test(body[j])) j++;
      const blockLines = body.slice(i + 1, j);
      const block = blockLines.join('\n');
      const sameAlias = new RegExp(`alias\\s*=\\s*"${escapeRe(alias)}"`).test(block);
      const sameName = new RegExp(`name\\s*=\\s*"${escapeRe(name)}"`).test(block);
      if (sameAlias || sameName) {
        for (const line of blockLines) {
          const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
          if (!key) {
            if (line.trim()) carried.push(line); // comments and anything else stay
            continue;
          }
          if (!OURS.has(key[1])) carried.push(line.trim());
        }
      } else {
        kept.push(...body.slice(i, j));
      }
      i = j;
    } else {
      kept.push(body[i]);
      i++;
    }
  }

  const out = [`active_model = "${alias}"`];
  const pre = preamble.join('\n').trim();
  if (pre) out.push('', pre);
  const rest = kept.join('\n').trim();
  if (rest) out.push('', rest);
  out.push('', '[[models]]', `name = "${name}"`, `provider = "${provider}"`, `alias = "${alias}"`, ...carried, '');
  return out.join('\n');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The model a vibe session actually used, from its meta.json.
 *
 * Three different things live in the top-level `config` table and they are NOT
 * interchangeable (fix round 1, item B):
 *   config.active_model             the ALIAS in force, e.g. "mistrallargelatest"
 *   config.models[<alias>].name     the model that alias RESOLVES TO, e.g. "mistral-large-latest"
 *   config.routed_default_model     vibe's ROUTING DEFAULT, e.g. "mistral-medium-3.5" - the
 *                                   model used only when nothing else is selected. Reporting
 *                                   it as the model used is simply wrong, and in one recorded
 *                                   run it mislabelled a mistral-large run.
 *
 * `config.models` is an object keyed by alias on this build; a list of {alias,name} entries is
 * also accepted. Never search the document for `active_model`: the same key appears inside
 * `experiments.features.*.defaultValue`, which is a feature-flag default for another purpose.
 */
export function modelsTableLookup(models, alias) {
  if (!models || !alias) return null;
  if (Array.isArray(models)) {
    const hit = models.find((m) => m && (m.alias === alias || m.name === alias));
    return hit && hit.name ? String(hit.name) : null;
  }
  if (typeof models === 'object') {
    const direct = models[alias];
    if (direct && direct.name) return String(direct.name);
    for (const v of Object.values(models)) {
      if (v && typeof v === 'object' && v.alias === alias && v.name) return String(v.name);
    }
  }
  return null;
}

export function pickModelFromMeta(json) {
  const cfg = json && typeof json === 'object' ? json.config : null;
  if (cfg && (cfg.active_model !== undefined || cfg.routed_default_model !== undefined)) {
    const alias = cfg.active_model ?? null;
    const resolved = modelsTableLookup(cfg.models, alias);
    return {
      alias,
      resolved, // null when the alias is not in config.models - say so, do not guess
      routedDefault: cfg.routed_default_model ?? null,
      source: resolved ? 'config.models' : 'config',
    };
  }
  const alias = deepFind(json, 'active_model');
  return {
    alias: alias ?? null,
    resolved: null,
    routedDefault: deepFind(json, 'routed_default_model') ?? null,
    source: alias === undefined ? 'none' : 'deep-search',
  };
}

/**
 * Fallback warnings from vibe.log that belong to THIS run.
 *
 * vibe.log is append-only and shared by every vibe run on the machine, so an
 * untimed grep reports warnings from hours ago as if they were ours (observed
 * 2026-09-18: three 01:20 warnings attributed to an 18:41 run). Lines are
 * `<ISO timestamp> <pid> <tid> LEVEL message`.
 */
export function fallbackWarningsSince(text, sinceMs, slackMs = 5000) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!FALLBACK_WARNING_RE.test(line)) continue;
    const ts = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2}|Z)?)/.exec(line);
    const at = ts ? Date.parse(ts[1]) : NaN;
    if (!Number.isFinite(at)) {
      out.push({ at: null, line: line.trim(), attributed: 'unknown-timestamp' });
      continue;
    }
    if (at >= sinceMs - slackMs) out.push({ at, line: line.trim(), attributed: 'this-run' });
  }
  return out;
}

/** Find a key anywhere in a parsed JSON object (last resort only - see pickModelFromMeta). */
function deepFind(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = deepFind(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Find the session meta.json that belongs to THIS run (item 11).
 *
 * `~/.vibe/logs/session/` is shared by every vibe process on the machine, and the cloud lane
 * runs in parallel, so "newest meta.json" attributed another run's model and warnings to us.
 * A session is ours only when its recorded working directory is our `--dir` AND its activity
 * falls inside our run window. If more than one session matches, the answer is UNKNOWN - we
 * report nothing rather than guess.
 *
 * @returns {{file:string|null, reason:string, candidates:number}}
 */
export function findSessionMeta(sessionsDir, { dir, startedAtMs, endedAtMs, slackMs = 5000 }) {
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return { file: null, reason: 'no-session-directory', candidates: 0 };
  }
  const from = (startedAtMs || 0) - slackMs;
  const to = (endedAtMs || Date.now()) + slackMs;
  const matches = [];
  for (const e of entries) {
    const file = path.join(sessionsDir, e.name, 'meta.json');
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < from || st.mtimeMs > to) continue; // outside our window
    const json = readJson(file, null);
    if (!json) continue;
    const wd =
      (json.environment && json.environment.working_directory) ||
      json.origin_directory ||
      (json.config && json.config.displayed_workdir) ||
      null;
    if (!wd || !sameDir(wd, dir)) continue; // a different worktree: not ours
    matches.push({ file, mtime: st.mtimeMs });
  }
  if (matches.length === 0) return { file: null, reason: 'no-session-matched-this-worktree-and-window', candidates: 0 };
  if (matches.length > 1) {
    return { file: null, reason: 'ambiguous-several-sessions-match', candidates: matches.length };
  }
  return { file: matches[0].file, reason: 'bound-by-workdir-and-window', candidates: 1 };
}

function sameDir(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export const FALLBACK_WARNING_RE =
  /Active model '([^']*)' is not in your configured models; falling back to default model '([^']*)'/;

/**
 * Did the session run a different model from the one requested?
 * `null` = not knowable (we never guess a mismatch from an unknown model).
 */
export function isModelMismatch(resolvedName, requestedCanonical) {
  if (!resolvedName || !requestedCanonical) return null;
  const strip = (s) => (String(s).includes('/') ? String(s).split('/').pop() : String(s));
  return strip(resolvedName) !== strip(requestedCanonical);
}

/** Provider quota phrasing. Only ever matched against stderr and protocol error records. */
export const QUOTA_RE = /usage limit|quota exceeded|insufficient credit|rate limit exceeded/i;

export default {
  name: 'vibe',
  lane: 'cloud',
  needsModel: true,
  /** vibe's NDJSON heartbeat is on stdout (K5); it writes nothing to stderr on success. */
  heartbeatStream: 'stdout',
  /** vibe has no session-creation line: its `completed` branch has no directory clause (v3 M7). */
  directoryEvidence: false,

  canonicalModel(model) {
    return String(model).includes('/') ? String(model).split('/').pop() : String(model);
  },

  /** Refuse non-ASCII handoffs (cp1252 stdin decode) and write the model config. */
  preLaunch(ctx) {
    const notes = [];
    const prompt = fs.readFileSync(ctx.promptPath);
    if (!isAscii(prompt) && !ctx.allowNonAscii) {
      const samples = nonAsciiSamples(prompt.toString('utf8'))
        .map((s) => `line ${s.line}: ${s.chars}`)
        .join('; ');
      throw new OrchError(
        'vibe decodes stdin as cp1252, so non-ASCII in the handoff is silently corrupted ' +
          `(spike 2026-09-18 Q1b). Offending: ${samples}. ` +
          'Rewrite the handoff in ASCII, or pass --allow-non-ascii to accept the corruption.',
        'non-ascii-handoff',
      );
    }
    if (!isAscii(prompt)) notes.push('non-ASCII handoff accepted under --allow-non-ascii: expect mojibake');

    const alias = aliasFor(ctx.model);
    const provider = providerFor(ctx.model);
    const name = this.canonicalModel(ctx.model);
    const cfgDir = path.join(ctx.dir, '.vibe');
    const cfgFile = path.join(cfgDir, 'config.toml');
    fs.mkdirSync(cfgDir, { recursive: true });
    const before = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '';
    const merged = mergeVibeConfig(before, { alias, name, provider });
    fs.writeFileSync(cfgFile, merged, 'utf8');
    notes.push(`.vibe/config.toml ${before ? 'merged' : 'created'}: active_model="${alias}" name="${name}" provider="${provider}"`);
    return { notes, extra: { vibe_alias: alias, vibe_provider: provider, vibe_config: cfgFile } };
  },

  build(ctx) {
    const exe = resolveExe();
    const args = ['-p', '--workdir', ctx.dir, '--auto-approve', '--trust', '--output', 'streaming'];
    if (ctx.maxTurns != null) args.push('--max-turns', String(ctx.maxTurns));
    if (ctx.maxPrice != null) args.push('--max-price', String(ctx.maxPrice));
    if (ctx.agent) args.push('--agent', ctx.agent);
    args.push(...ctx.flags);
    return {
      file: exe,
      args,
      cwd: ctx.dir,
      envSet: { PWD: ctx.dir },
      envDelete: [],
      notes: [`vibe exe: ${exe}`, 'PWD forced to --workdir in the child env'],
    };
  },

  initWatch() {
    return { events: 0, lastEventType: null, buffer: '' };
  },

  /** vibe's heartbeat is its own NDJSON on stdout; count parseable events. */
  onStdout(state, chunk) {
    state.buffer += chunk;
    const lines = state.buffer.split(/\r?\n/);
    state.buffer = lines.pop() || '';
    let events = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        events++;
        state.events++;
        state.lastEventType = obj.type || null;
      } catch {
        /* not an event line */
      }
    }
    return events > 0 ? { activity: true, signal: 'cli-event' } : { activity: false };
  },

  /** After exit: what model did vibe actually use, and did it fall back silently? */
  postExit(ctx) {
    const out = { actual_model: null, warnings: [] };
    // Item 11: bind the session to THIS worktree and window; never "the newest one".
    const found = findSessionMeta(path.join(vibeLogDir(), 'session'), {
      dir: ctx.dir,
      startedAtMs: ctx.startedAtMs,
      endedAtMs: ctx.endedAtMs,
    });
    out.vibe_meta_binding = found.reason;
    if (!found.file) {
      out.warnings.push(
        `the vibe session for this run could not be identified (${found.reason}` +
          `${found.candidates > 1 ? `, ${found.candidates} candidates` : ''}); model actually used is unknown`,
      );
    }
    {
      const meta = found.file ? { file: found.file } : null;
      if (meta) {
        const json = readJson(meta.file, null);
        const picked = pickModelFromMeta(json);
        out.actual_model_alias = picked.alias;
        out.actual_model = picked.resolved; // the resolved model NAME, or null - never the routing default
        out.routed_default_model = picked.routedDefault; // recorded separately, never as "the model used"
        out.vibe_meta = meta.file;
        out.vibe_meta_source = picked.source;
        if (picked.source === 'none' || picked.source === 'deep-search') {
          out.warnings.push(
            `vibe meta.json had no usable top-level config table; model fields are a best-effort guess (source: ${picked.source})`,
          );
        } else if (!picked.resolved) {
          out.warnings.push(
            `vibe session alias "${picked.alias}" was not found in config.models, so the model it resolves to is unknown`,
          );
        }
        if (picked.alias && ctx.alias && picked.alias !== ctx.alias) {
          out.warnings.push(
            `vibe session active_model "${picked.alias}" is not the alias we declared "${ctx.alias}" - possible silent substitution`,
          );
        }
        // Did we get the model we asked for?
        const mm = isModelMismatch(picked.resolved, ctx.requestedCanonical);
        if (mm !== null) {
          out.model_mismatch = mm;
          if (mm) {
            out.warnings.push(
              `MODEL MISMATCH: requested "${ctx.requestedCanonical}" but the session resolved to "${picked.resolved}"`,
            );
          }
        }
      }
    }
    // Fallback warnings are appended to a shared ~/.vibe/logs/vibe.log; only lines
    // timestamped inside this run's window belong to us.
    try {
      const text = fs.readFileSync(path.join(vibeLogDir(), 'vibe.log'), 'utf8').slice(-256 * 1024);
      for (const w of fallbackWarningsSince(text, ctx.startedAtMs || 0)) {
        out.warnings.push(`vibe.log fallback warning (${w.attributed}): ${w.line}`);
      }
    } catch {
      /* no vibe.log */
    }
    return out;
  },

  /**
   * vibe's final message is the last assistant `message` event in its NDJSON, not the last
   * paragraph of the raw stream (item 13).
   */
  extractFinalMessage(stdout) {
    const events = this.parseProtocol(stdout);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e || e.type !== 'message') continue;
      if (e.role && e.role !== 'assistant') continue;
      const text = messageText(e);
      if (text) return text;
    }
    return String(stdout).trim();
  },

  /**
   * vibe's own protocol: `--output streaming` writes one JSON object per line on stdout.
   * These parsed objects - and only their ERROR records - may reach a status rule.
   */
  parseProtocol(stdout) {
    const events = [];
    for (const line of String(stdout).split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      try {
        events.push(JSON.parse(t));
      } catch {
        /* partial or non-JSON line */
      }
    }
    return events;
  },

  // Every rule below reads the exit code, stderr, and protocol ERROR records only. None
  // looks at stdout text, and each requires a non-zero exit. See statusrules.mjs.
  statusRules: [
    {
      name: 'vibe-turn-cap',
      test: (o) =>
        o.exitCode !== 0 &&
        /<vibe_stop_event>\s*Turn limit of \d+ reached\s*<\/vibe_stop_event>/.test(o.stderr),
      status: 'turn-cap',
      reason: 'max-turns-reached',
    },
    {
      name: 'vibe-price-cap',
      test: (o) =>
        o.exitCode !== 0 &&
        /<vibe_stop_event>[^<]*(price|budget|cost)[^<]*<\/vibe_stop_event>/i.test(o.stderr),
      status: 'turn-cap',
      reason: 'max-price-reached',
    },
    {
      name: 'vibe-quota',
      test: (o) => o.exitCode !== 0 && QUOTA_RE.test(o.stderr + '\n' + protocolErrorText(o.events)),
      status: 'blocked-quota',
      reason: 'provider-quota',
    },
  ],
};
