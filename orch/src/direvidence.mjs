// Directory evidence — DETECTION ONLY (N3: nothing here ever kills anything).
//
// Channel (v3 §5): with `--print-logs`, opencode writes its structured log to stderr,
// and the keeper wires stderr to THIS RUN'S OWN `stderr.log` (K1). There is no shared
// log folder, no `run=` tag matching and no "sole new session" heuristic, so review
// r2-6 and r3-1 have no subject here.
//
// The decision line is ONLY the session-creation line:
//     message=created id=ses_<id> ... directory="<d>"
// `bootstrapping directory=` lines are informational (O3 showed one run can emit
// several naming different directories) and NEVER decide.
import fs from 'node:fs';
import path from 'node:path';

/** `--print-logs` interleaves ANSI-coloured human lines with the structured ones (K1). */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function unescapeLogValue(v) {
  return String(v).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
}

/** The session-creation line's directory, or null if this is not that line. */
export function parseSessionLine(line) {
  const text = stripAnsi(line);
  if (!/\bmessage=created\b/.test(text)) return null;
  if (!/\bid=ses_[A-Za-z0-9]+/.test(text)) return null;
  const m = /\bdirectory="((?:[^"\\]|\\.)*)"/.exec(text);
  if (!m) return null;
  const id = /\bid=(ses_[A-Za-z0-9]+)/.exec(text);
  return { sessionId: id ? id[1] : null, directory: unescapeLogValue(m[1]) };
}

/** Informational only; never decides (O3). */
export function parseBootstrapLine(line) {
  const text = stripAnsi(line);
  if (!/\bmessage=bootstrapping\b/.test(text)) return null;
  const m = /\bdirectory="((?:[^"\\]|\\.)*)"/.exec(text);
  return m ? unescapeLogValue(m[1]) : null;
}

/**
 * Path identity: `fs.realpathSync.native()` on both sides, trailing separator
 * stripped, compared with `===`. **No `toLowerCase`** (round-1 M4). If realpath
 * throws on either side the evidence is `unresolved`, never `mismatch`.
 *
 * ASSUMPTION, marked: that `realpathSync.native()` normalises casing and 8.3 aliases
 * on this filesystem. Measured behaviour is recorded by the test, not assumed here.
 */
export function realpathOrNull(p) {
  try {
    return String(fs.realpathSync.native(String(p))).replace(/[\\/]+$/, '');
  } catch {
    return null;
  }
}

export function compareDirs(loggedDir, expectedReal) {
  const a = realpathOrNull(loggedDir);
  if (a === null || !expectedReal) return 'unresolved';
  const b = String(expectedReal).replace(/[\\/]+$/, '');
  return a === b ? 'match' : 'mismatch';
}

/**
 * Accumulating aggregator with a latch (v3 §5):
 *   any line `mismatch`   -> `mismatch`, and it LATCHES; no later evidence undoes it
 *   else any `unresolved` -> `none` (unresolved evidence prevents completion)
 *   else >=1 `match`      -> `match`
 *   no lines at all       -> `none`
 */
export class DirectoryEvidence {
  constructor(expectedReal, { latched = false } = {}) {
    this.expectedReal = expectedReal ? String(expectedReal).replace(/[\\/]+$/, '') : null;
    this.mismatchLatched = !!latched;
    this.sawMatch = false;
    this.sawUnresolved = false;
    this.sessions = [];
    this.bootstrapDirectories = [];
  }

  feed(lines) {
    for (const line of lines || []) {
      const boot = parseBootstrapLine(line);
      if (boot && !this.bootstrapDirectories.includes(boot)) this.bootstrapDirectories.push(boot);
      const s = parseSessionLine(line);
      if (!s) continue;
      const verdict = compareDirs(s.directory, this.expectedReal);
      this.sessions.push({ ...s, verdict });
      if (verdict === 'mismatch') this.mismatchLatched = true;
      else if (verdict === 'unresolved') this.sawUnresolved = true;
      else this.sawMatch = true;
    }
    return this.verdict();
  }

  verdict() {
    if (this.mismatchLatched) return 'mismatch';
    if (this.sawUnresolved) return 'none';
    if (this.sawMatch) return 'match';
    return 'none';
  }

  snapshot() {
    return {
      evidence: this.verdict(),
      latched: this.mismatchLatched,
      sessions: this.sessions,
      bootstrap_directories: this.bootstrapDirectories,
      expected_real: this.expectedReal,
    };
  }
}

/** Convenience for tests and replay: one call, one verdict. */
export function evaluate(lines, expectedDir) {
  const e = new DirectoryEvidence(realpathOrNull(expectedDir) ?? path.resolve(String(expectedDir)));
  e.feed(lines);
  return e.snapshot();
}
