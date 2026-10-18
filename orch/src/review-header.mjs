// Ownership projection only. Selected records must still pass the full evidence
// reader; an unrelated package's historical snapshot body is not interpreted.
export function projectReviewHeader(text) {
  let at = 0;
  const out = {};
  const space = () => { while (/[\t\n\r ]/.test(text[at] || '\0')) at++; };
  const stringEnd = () => {
    if (text[at++] !== '"') throw new Error('review key is not a string');
    while (at < text.length) {
      const c = text[at++];
      if (c === '"') return;
      if (c === '\\') { if (at === text.length) break; at++; }
      else if (c.charCodeAt(0) < 32) throw new Error('invalid review string');
    }
    throw new Error('unterminated review string');
  };
  const valueEnd = () => {
    const closing = [];
    while (at < text.length) {
      const c = text[at];
      if (c === '"') { stringEnd(); continue; }
      if (c === '{' || c === '[') {
        if (closing.length >= 4096) throw new Error('review nesting exceeds ownership scan limit');
        closing.push(c === '{' ? '}' : ']');
      }
      else if (c === '}' || c === ']') {
        if (!closing.length) { if (c === '}') return; throw new Error('invalid review delimiter'); }
        if (closing.pop() !== c) throw new Error('mismatched review delimiter');
      } else if (c === ',' && !closing.length) return;
      at++;
    }
    throw new Error('incomplete review object');
  };
  space();
  if (text[at++] !== '{') throw new Error('review is not an object');
  space();
  if (text[at] !== '}') while (true) {
    const keyAt = at;
    stringEnd();
    const key = JSON.parse(text.slice(keyAt, at));
    space();
    if (text[at++] !== ':') throw new Error('review key lacks a value');
    space();
    const start = at;
    valueEnd();
    if (at === start) throw new Error('empty review value');
    if (key === 'id' || key === 'wp') {
      if (Object.hasOwn(out, key)) throw new Error('ambiguous review ownership');
      out[key] = JSON.parse(text.slice(start, at));
    }
    space();
    if (text[at] === '}') break;
    if (text[at++] !== ',') throw new Error('review members are not separated');
    space();
  }
  at++; space();
  if (at !== text.length) throw new Error('trailing review data');
  return out;
}
