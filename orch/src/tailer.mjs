// Byte-offset file tailer with a persistent UTF-8 decoder and complete-line framing.
//
// This is required, not cosmetic (v3 §5, review finding 7): a session line split
// across a read boundary, or a UTF-8 sequence split mid-character, would otherwise
// turn a healthy run into `directory-unverified` or hide a later mismatch. The
// decoder and the partial-line buffer therefore persist across polls, and the final
// drain after `worker-exit` flushes whatever is left.
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export class Tailer {
  constructor(file, { startOffset = 0 } = {}) {
    this.file = file;
    this.offset = startOffset;
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
    this.bytesRead = 0;
    this.truncations = 0;
  }

  /** @returns {{lines:string[], bytes:number, size:number}} complete lines only */
  poll() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return { lines: [], bytes: 0, size: 0 };
    }
    if (st.size < this.offset) {
      // truncated or rotated under us: restart, and say so rather than silently skew
      this.truncations++;
      this.offset = 0;
      this.decoder = new StringDecoder('utf8');
      this.partial = '';
    }
    if (st.size === this.offset) return { lines: [], bytes: 0, size: st.size };

    const len = st.size - this.offset;
    const buf = Buffer.alloc(len);
    let fd = null;
    try {
      fd = fs.openSync(this.file, 'r');
      fs.readSync(fd, buf, 0, len, this.offset);
    } catch {
      return { lines: [], bytes: 0, size: st.size };
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
    this.offset = st.size;
    this.bytesRead += len;

    this.partial += this.decoder.write(buf);
    const parts = this.partial.split(/\r?\n/);
    this.partial = parts.pop() ?? ''; // keep the incomplete tail for the next poll
    return { lines: parts, bytes: len, size: st.size };
  }

  /**
   * Final drain: everything still buffered, including a last line with no trailing
   * newline. Called once after the worker's exit has been observed.
   */
  drain() {
    const { lines } = this.poll();
    const rest = this.partial + this.decoder.end();
    this.partial = '';
    this.decoder = new StringDecoder('utf8');
    const tail = rest.split(/\r?\n/).filter((l) => l.length > 0);
    return lines.concat(tail);
  }
}
