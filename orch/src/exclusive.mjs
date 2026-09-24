// Exclusive publication of a small record file (slice 2).
//
// The record is written COMPLETE to a private temp file, then hard-linked to its final
// name. `link` fails with EEXIST if the name is taken, and it is atomic: a reader sees
// either no file or the whole record, never a half-written one (plain `wx` creates the
// name first and fills it afterwards). If the filesystem cannot hard-link, `wx` is the
// fallback and a reader may then briefly see an empty file - callers treat an
// unreadable record as `unknown`, never as absent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** @returns {{created:boolean, how:string}} created=false means the name was already taken */
export function publishExclusive(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-x${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, text);
  try {
    fs.linkSync(tmp, file);
    return { created: true, how: 'link' };
  } catch (/** @type {any} */ e) {
    if (e && e.code === 'EEXIST') return { created: false, how: 'link' };
    if (e && ['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EINVAL'].includes(e.code)) {
      try {
        fs.writeFileSync(file, text, { flag: 'wx' });
        return { created: true, how: 'wx' };
      } catch (/** @type {any} */ e2) {
        if (e2 && e2.code === 'EEXIST') return { created: false, how: 'wx' };
        throw e2;
      }
    }
    throw e;
  } finally {
    try {
      fs.unlinkSync(tmp); // our own temp file only
    } catch {
      /* already gone */
    }
  }
}

/** Read a JSON record: `{state:'absent'}` | `{state:'ok', value}` | `{state:'unreadable', error}`. */
export function readRecord(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (/** @type {any} */ e) {
    if (e && e.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', error: String((e && e.code) || e) };
  }
  try {
    return { state: 'ok', value: JSON.parse(text) };
  } catch (e) {
    return { state: 'unreadable', error: `malformed: ${(e && e.message) || e}` };
  }
}
