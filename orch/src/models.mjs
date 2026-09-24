// Model identity and the roster (slice 2).
//
// Reviewer != implementer is compared by CANONICAL model id, never by CLI: the same
// model behind two CLIs is the same model (ORCHESTRATOR §6). The canonical id drops a
// provider prefix and letter case: `localai/qwen3-coder-30b` == `QWEN3-coder-30b`.
import fs from 'node:fs';
import path from 'node:path';
import { KIT_ROOT, setting } from './config.mjs';
import { readJson } from './util.mjs';
import { OrchError } from './errors.mjs';

export function canonicalId(model) {
  if (model === null || model === undefined) return null;
  // Code-review fix a3: a backslash is a provider separator too (`localai\qwen3-coder-30b`).
  let s = String(model).trim().replace(/\\/g, '/');
  if (!s) return null;
  if (s.includes('/')) s = s.split('/').pop();
  return s.toLowerCase();
}

export const ROSTER_FILE = path.join(KIT_ROOT, 'roster.json');
export const ROSTER_EXAMPLE_FILE = path.join(KIT_ROOT, 'roster.example.json');

/** The roster in effect: --roster, else ORCH_ROSTER, else `roster` in orch.config.json, else orch/roster.json. */
export function rosterPath(file) {
  return path.resolve(file || setting('ORCH_ROSTER', 'roster', ROSTER_FILE, { isPath: true }));
}

/** @returns {{models: any[], file: string}} */
export function loadRoster(file) {
  const f = rosterPath(file);
  if (!fs.existsSync(f)) {
    throw new OrchError(
      `no roster at ${f}. The roster lists the models YOU can launch and is not shipped: copy ` +
        `${ROSTER_EXAMPLE_FILE} to ${ROSTER_FILE} and edit it (docs/MODELS.md), or point --roster / ORCH_ROSTER / "roster" in orch.config.json at your file.`,
      'no-roster',
    );
  }
  const doc = readJson(f, null);
  if (!doc || !Array.isArray(doc.models)) throw new OrchError(`roster not readable or has no "models" array: ${f}`, 'bad-roster');
  return { models: doc.models, file: f };
}

/**
 * Model family: the roster's `family` when the model is listed, else the leading
 * letters of the canonical id (`gemini-3.8-flash-high` -> `gemini`, `gpt-5.6-terra` ->
 * `gpt`, `qwen3-coder-30b` -> `qwen`). Only ever used to WARN or to PREFER, never to refuse.
 */
export function familyOf(model, roster = null) {
  const c = canonicalId(model);
  if (!c) return null;
  const hit = roster && roster.find((r) => canonicalId(r.model) === c);
  if (hit && hit.family) return String(hit.family).toLowerCase();
  const m = /^[a-z]+/.exec(c);
  return m ? m[0] : c;
}

/**
 * Does the roster mark this model `requires_permission`? Such a model is never proposed by
 * `orch pick` and `orch run` refuses it without --owner-approved-model. No readable roster
 * means no model is marked (a missing roster never blocks a run).
 * @returns {{required:boolean, file:string|null}}
 */
export function permissionRequired(model, file) {
  let r;
  try {
    r = loadRoster(file);
  } catch {
    return { required: false, file: null };
  }
  const c = canonicalId(model);
  return { required: r.models.some((m) => m && m.requires_permission === true && canonicalId(m.model) === c), file: r.file };
}

/** Throws unless the model is allowed without, or given, the owner's permission. */
export function assertModelPermitted(model, ownerApproved) {
  if (ownerApproved) return;
  const p = permissionRequired(model);
  if (p.required) {
    throw new OrchError(
      `${model} is used only with the owner's permission for that run (requires_permission in ${p.file}): pass --owner-approved-model`,
      'model-needs-permission',
    );
  }
}
