// Small shared helpers. No runtime dependencies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** ISO timestamp with milliseconds. */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Write a file atomically (temp in the same directory, then rename).
 *
 * On Windows a rename over an existing file fails with EPERM/EACCES/EBUSY while
 * another process has the destination open - a concurrent `orch status` read is
 * enough. Retry briefly rather than losing a state write.
 */
export function writeFileAtomic(file, data, { attempts = 12, waitMs = 25 } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = e && e.code;
      if (i >= attempts - 1 || !['EPERM', 'EACCES', 'EBUSY', 'ENOENT'].includes(code)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* leave the temp file rather than mask the original error */
        }
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs); // sync sleep
    }
  }
}

export function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Sortable run id: <yyyymmdd>-<hhmmss>-<6 hex>. */
export function newRunId(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when every byte of the buffer/string is ASCII (<= 0x7f). */
export function isAscii(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  for (const byte of b) if (byte > 0x7f) return false;
  return true;
}

/** Byte offsets of the first non-ASCII characters, for a helpful error. */
export function nonAsciiSamples(text, limit = 3) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    if (!isAscii(lines[i])) {
      const bad = [...lines[i]].filter((c) => c.codePointAt(0) > 0x7f).slice(0, 8).join('');
      out.push({ line: i + 1, chars: bad });
    }
  }
  return out;
}

/**
 * Newest mtime (ms) of any file under `dir`, ignoring `.git` and any name in `ignore`.
 *
 * Fix round 2, item 14: the previous version stopped after a fixed 4000 directory entries and
 * returned whatever it had, so in a large worktree the file-change signal was silently blind
 * to everything past that point - and never said so. Now there is no entry cap; the only
 * limit is a TIME budget so the supervisor's poll cannot stall; and when the budget runs out
 * the walk reports `truncated` and hands back the directories it did not reach, so the caller
 * resumes there next poll. Nothing is permanently invisible, and truncation is recorded.
 *
 * @returns {{newest:number, truncated:boolean, pending:string[], scanned:number}}
 */
export function scanNewestMtime(dir, { ignore = ['.git', 'node_modules'], budgetMs = 400, resume = null } = {}) {
  // CODE-REVIEW FIX (agy g8): a resume point is `{dir, from}` - the directory AND the
  // entry index to continue from. The previous version handed back the unfinished
  // directory by name only, so every poll re-read it from entry 0, and in a flat
  // directory larger than one budget the files past the cut were NEVER reached.
  // Every call also processes at least one batch, so a tiny budget still progresses.
  const started = Date.now();
  let newest = 0;
  let scanned = 0;
  const stack = (resume && resume.length ? [...resume] : [dir]).map((x) => (typeof x === 'string' ? { dir: x, from: 0 } : x));
  while (stack.length) {
    if (scanned > 0 && Date.now() - started >= budgetMs) return { newest, truncated: true, pending: stack, scanned };
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (let i = cur.from || 0; i < entries.length; i++) {
      // r3-6: the budget is enforced INSIDE a large flat directory as well.
      if (scanned > 0 && (scanned & 0x3f) === 0 && Date.now() - started >= budgetMs) {
        stack.push({ dir: cur.dir, from: i });
        return { newest, truncated: true, pending: stack, scanned };
      }
      const e = entries[i];
      if (ignore.includes(e.name)) continue;
      scanned++;
      const full = path.join(cur.dir, e.name);
      if (e.isDirectory()) {
        stack.push({ dir: full, from: 0 });
        continue;
      }
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  return { newest, truncated: false, pending: [], scanned };
}

/** Convenience wrapper for callers that only want the number. */
export function newestMtime(dir, opts = {}) {
  return scanNewestMtime(dir, opts).newest;
}

/** Read bytes appended to a file after `offset`. Returns { text, offset }. */
export function readSince(file, offset) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { text: '', offset };
  }
  if (st.size < offset) return { text: '', offset: st.size }; // truncated/rotated
  if (st.size === offset) return { text: '', offset };
  const fd = fs.openSync(file, 'r');
  try {
    const len = st.size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    return { text: buf.toString('utf8'), offset: st.size };
  } finally {
    fs.closeSync(fd);
  }
}

export function fileSizeOrZero(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------- deadlines ---- */

/**
 * Every deadline in the kit uses `performance.now()` (v3 L2): the wall clock is for
 * display only and never authorises anything.
 */
export function monoMs() {
  return performance.now();
}

/** One whole-command budget, with the name of the step that was running when it blew. */
export class Deadline {
  constructor(ms, label = 'command') {
    this.ms = ms;
    this.label = label;
    this.started = performance.now();
    this.step = 'start';
    /** set when a step bounded by this deadline actually timed out */
    this.forced = false;
  }
  at(step) {
    this.step = step;
    return this;
  }
  elapsed() {
    return performance.now() - this.started;
  }
  remaining() {
    return Math.max(0, this.ms - this.elapsed());
  }
  expired() {
    // `forced`: a step's timer fired. Measured in the suite: that timer can fire a hair
    // before performance.now() crosses the budget, so the clock alone could report "not
    // expired" right after a step had in fact timed out - and the `undetermined` line
    // would be silently dropped while fallback values were printed as if real.
    return this.forced || this.remaining() <= 0;
  }
  /** The exact line design v4 §0 requires when a bounded command runs out of budget. */
  text() {
    return `undetermined: ${this.step} exceeded ${this.ms}ms`;
  }
}

/**
 * Resolve to `fallback` if `work` has not settled within `ms`. The outstanding
 * operation is abandoned, not cancelled - Node has no way to cancel an in-flight fs
 * call - so the guarantee is a bounded ANSWER, never a bounded truth (v4 §0).
 */
export function withDeadline(work, ms, fallback, dl = null) {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      if (dl && !done) dl.forced = true; // the step genuinely timed out
      settle(fallback);
    }, Math.max(0, ms));
    timer.unref?.();
    Promise.resolve()
      .then(() => (typeof work === 'function' ? work() : work))
      .then(settle, () => settle(fallback));
  });
}

/** Append one NDJSON line. Never throws; returns false on failure. */
export function appendLineGuarded(file, obj) {
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** Read the last `bytes` of a file and return only COMPLETE lines. */
export function readTailLines(file, bytes = 8192) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const len = st.size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    if (start > 0) lines.shift(); // the first line may be a fragment
    if (text.length && !/\n$/.test(text)) lines.pop(); // trailing partial line
    return lines.filter((l) => l.trim());
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/* ---------------------------------------------- async, deadline-able reads -- */
// CODE-REVIEW FIX (astra M5): a deadline around a SYNCHRONOUS fs call can never fire -
// the call blocks the event loop the timer needs. Every read on a path that claims a
// deadline uses these asynchronous forms, which run on the libuv threadpool and leave
// the event loop free for `withDeadline` to answer.

/** Async twin of `readTailLines`: complete lines from the last `bytes` of a file. */
export async function readTailLinesAsync(file, bytes = 8192) {
  let fh = null;
  try {
    const st = await fs.promises.stat(file);
    const start = Math.max(0, st.size - bytes);
    const len = st.size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fh = await fs.promises.open(file, 'r');
    await fh.read(buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    if (start > 0) lines.shift();
    if (text.length && !/\n$/.test(text)) lines.pop();
    return lines.filter((l) => l.trim());
  } catch {
    return [];
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Async twin of `readJson`. */
export async function readJsonAsync(file, fallback = null) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}
