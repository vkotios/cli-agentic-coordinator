// Table-driven status derivation: the v3 §5 precedence table with the M7 corrections
// and amendment A3.
//
// THE RULE ABOUT RULES (learned the hard way; kept verbatim in intent)
// -------------------------------------------------------------------
// A status rule may look at, and only at:
//   - `exitCode` / `signal`          the process result
//   - `stderr`                       the CLI's own diagnostic channel
//   - `events`                       ERROR records of the CLI's own protocol, reached
//                                    through `protocolErrorText()` - never the content
//                                    of a tool/effect/message event
//   - `failure` / `cancelRequested`  flags this tool set itself
//
// A rule must NEVER match `stdout` as text. Worker output is attacker-shaped data: it
// contains whatever files the worker happened to read. In one recorded run a
// reviewer read this very kit, its `read_file` effect echoed the words "usage limit"
// onto stdout, and an exit-0 run carrying a complete review was recorded `blocked-quota`.
//
// `stdout` stays on the Outcome because the table must know whether it is EMPTY - a
// length check, not a content match.
//
// Reclassifying rules additionally require a non-zero exit: exit 0 with non-empty
// output is `completed`, full stop.

/**
 * The text of protocol-level ERROR records only.
 *
 * An event qualifies when its own `type` says it is an error/failure, or when it
 * carries a structured `error` object with a message. A `type:"effect"` tool record
 * never qualifies, whatever its `detail` contains - that is exactly the free worker
 * text rules must not see.
 */
export function protocolErrorText(events) {
  const parts = [];
  for (const e of events || []) {
    if (!e || typeof e !== 'object') continue;
    const type = String(e.type ?? '');
    if (/(^|[._-])(error|failed|failure)([._-]|$)/i.test(type)) {
      const msg = e.message ?? (e.error && (e.error.message ?? e.error)) ?? '';
      parts.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } else if (e.error && typeof e.error === 'object' && typeof e.error.message === 'string') {
      parts.push(e.error.message);
    }
  }
  return parts.join('\n');
}

/**
 * @typedef {Object} Outcome
 * @property {boolean} cancelRequested        `cancel.json` exists
 * @property {string|null} [cancelRequestedAt] when the cancel was requested (cancel.json)
 * @property {string|null} [workerExitAt]      when the keeper recorded the worker exit
 * @property {boolean} workerConfirmedGone    a `worker-exit` line, or identity `gone`.
 *   NOT `mismatch`: a mismatch says the recorded identity is not the live process, which
 *   is not positive evidence that OUR worker ended. Promoting a mismatch would let a
 *   stale or corrupted record turn a live worker into `cancelled` - the exact hole
 *   codex H3 described. Certainty over inference.
 * @property {{reason:string}|null} blocked   a Phase-A `blocked:*` line
 * @property {boolean} workerExitSeen         a `worker-exit` line exists
 * @property {string} keeperVerdict   one of match | gone | mismatch | unknown | exited
 * @property {number|null} exitCode
 * @property {string|null} signal
 * @property {string} stdout                  length may be tested; content may NOT
 * @property {string} stderr
 * @property {object[]} [events]
 * @property {string} dirEvidence     one of match | mismatch | none
 * @property {boolean} directoryRelevant      only opencode-shaped adapters
 */

/**
 * The precedence table, in strict order.
 *
 *  1  cancel requested AND the worker is CONFIRMED gone      -> cancelled
 *     (A3 / codex H3: a cancel request alone may never terminalize a live worker.)
 *  2  a Phase-A `blocked:*` line                             -> blocked: <reason>
 *     (M7: rule 3 precedes rule 2 - a blocked keeper is also "gone without an exit
 *      line", so `interrupted` would otherwise mask the real reason.)
 *  3  no worker-exit line AND the keeper verifies `gone`     -> interrupted
 *  4  dirEvidence === 'mismatch' (latched)                   -> failed: wrong-directory
 *  5  adapter reclassification, requires exitCode !== 0      -> turn-cap / blocked-quota / ...
 *  6  exitCode !== 0                                         -> failed: exit-<n>
 *  7  worker output empty                                    -> failed: empty-output
 *  8  dirEvidence === 'none' and the adapter has one         -> failed: directory-unverified
 *  9  exit 0, non-empty output, evidence satisfied           -> completed
 *
 * @param {object[]} adapterRules
 * @param {Outcome} outcome
 * @returns {{status:string, reason:string, rule:string, terminal:boolean, note?:string}}
 */
export function deriveStatus(adapterRules, outcome) {
  const o = { events: [], dirEvidence: 'none', directoryRelevant: false, ...outcome };

  // CODE-REVIEW FIX (agy g6): a cancel request that arrived AFTER the recorded worker exit
  // cannot have ended the worker, so it may not relabel a finished run `cancelled`.
  const lateCancel =
    o.cancelRequested && o.workerExitSeen && o.cancelRequestedAt && o.workerExitAt &&
    Date.parse(o.cancelRequestedAt) > Date.parse(o.workerExitAt);
  if (o.cancelRequested && o.workerConfirmedGone && !lateCancel) {
    return term('cancelled', 'cancel-requested', 'cancel-confirmed-gone');
  }
  if (o.blocked) {
    return term('blocked', String(o.blocked.reason), 'phase-a-blocked');
  }
  if (!o.workerExitSeen) {
    if (o.keeperVerdict === 'gone' || o.keeperVerdict === 'mismatch') {
      return term('interrupted', 'keeper-gone-without-exit', 'keeper-gone');
    }
    // Still running (or unknown): not terminal. A cancel request is annotated, never
    // promoted to a status (A3).
    return {
      status: 'running',
      reason: o.cancelRequested ? 'cancel-requested-worker-not-confirmed-gone' : 'worker-alive',
      rule: 'not-terminal',
      terminal: false,
    };
  }

  if (o.directoryRelevant && o.dirEvidence === 'mismatch') {
    return term('failed', 'wrong-directory', 'dir-mismatch', WRONG_DIRECTORY_NOTE);
  }

  for (const rule of adapterRules || []) {
    if (rule.test(o)) {
      return term(val(rule.status, o), val(rule.reason, o), rule.name);
    }
  }

  if (o.exitCode !== 0) {
    return term('failed', `exit-${o.exitCode === null ? `signal-${o.signal}` : o.exitCode}`, 'exit-nonzero');
  }
  if (String(o.stdout || '').trim().length === 0) {
    return term('failed', 'empty-output', 'empty-output');
  }
  if (o.directoryRelevant && o.dirEvidence !== 'match') {
    return term('failed', 'directory-unverified', 'dir-unverified', DIRECTORY_UNVERIFIED_NOTE);
  }
  return term('completed', 'exit-0-with-output', 'ok');
}

/**
 * Mandated wording (v3 §5). Rule 4 must NOT claim the worktree is untouched:
 * detection only means the worker kept running and may have written in both places.
 */
export const WRONG_DIRECTORY_NOTE =
  "the session was positively created in a directory that is not --dir. Detection only: nothing was killed, the worker " +
  'kept running, and it may have written files in BOTH places. Inspect both directories.';

/** Rule 8 must state that this is missing evidence, not proof of a wrong directory (round-1 M4). */
export const DIRECTORY_UNVERIFIED_NOTE =
  'no session-creation line proving the worktree was used reached this run\'s stderr.log. This is MISSING EVIDENCE, ' +
  'not proof of a wrong directory.';

function term(status, reason, rule, note) {
  return note ? { status, reason, rule, terminal: true, note } : { status, reason, rule, terminal: true };
}

const val = (v, o) => (typeof v === 'function' ? v(o) : v);
