#!/usr/bin/env node
// Release scan: run before every release. Walks the whole repository (except node_modules,
// the git-ignored runtime directories orch/.state*, orch/.lane, and RELEASE_CHECK.md) and
// reports every line that looks like personal data, a machine-specific path, a private
// project name, a private run/session id or a secret.
//
//   node orch/tools/release-scan.mjs [<repo root>]
//
// Positive controls (the scan is worthless if it cannot find anything):
//  1. every pattern is first tested against a built-in sample it MUST match;
//  2. the copyright line in LICENSE names the copyright holder and MUST be found by the
//     `owner-name` pattern. That line is the only expected hit in the tree.
// Exit code: 0 = clean (controls passed, no other hit), 1 = hits, 2 = a control failed.
// Pure Node (no grep, no locale dependence). The patterns are built from fragments so this
// file never matches itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = String.fromCharCode(92); // backslash
const SEP = `[${B}${B}/]+`; // one or more path separators, as written in any file format
const j = (...p) => p.join('');

/** name -> { re, sample }  (sample: a string the pattern must match - control 1) */
export const PATTERNS = {
  // personal and machine-specific
  'owner-name': { re: new RegExp(j('va', 'sil'), 'i'), sample: j('Va', 'silis') },
  'owner-domain': { re: new RegExp(j('kot', 'ios', B, '.xyz'), 'i'), sample: j('user@kot', 'ios.xyz') },
  'webmail-address': { re: new RegExp(j('gm', 'ail'), 'i'), sample: j('x@gm', 'ail.com') },
  'lan-ip-192.168': { re: new RegExp(j('19', '2', B, '.168', B, '.')), sample: j('http://19', '2.168.1.2') },
  'dev-drive-path': { re: new RegExp(j('[Cc]:', SEP, 'dev', SEP)), sample: j('C:', B, 'dev', B, 'x') },
  'user-profile-path (non-example)': { re: new RegExp(j('[Cc]:', SEP, 'Users', SEP, '(?![', B, B, '/])(?!example', B, 'b)')), sample: j('C:/Us', 'ers/bob/x') },
  'private-drive-path': { re: new RegExp(j('[Dd]:', SEP, 'PTA'), 'i'), sample: j('D:', B, 'PTA', B, 'x') },
  'windows-hostname': { re: new RegExp(j('DESK', 'TOP-[A-Z0-9]')), sample: j('DESK', 'TOP-AB12CD') },
  // private project and folder names
  'private-repo-1': { re: new RegExp(j('swift-net', 'work'), 'i'), sample: j('swift-net', 'work-storage') },
  'private-repo-2': { re: new RegExp(j('PTA[ -]', 'agent'), 'i'), sample: j('PTA ', 'agent') },
  'private-kit-name': { re: new RegExp(j('agent-', 'orchestra'), 'i'), sample: j('agent-', 'orchestra') },
  'private-sandbox-dir': { re: new RegExp(j('orch-', 'sandbox'), 'i'), sample: j('orch-', 'sandbox') },
  'remember-plugin-dir': { re: new RegExp(j(B, '.remem', 'ber', B, 'b')), sample: j('.remem', 'ber/x') },
  // private run / session ids (neutral placeholders are allowed: 00000000-0000-... uuids and
  // run ids with a round time part such as 20260101-000000-xxxxxx)
  'run-id': { re: new RegExp(j(B, 'b20', B, 'd{6}-(?!000000|1[23]0000)', B, 'd{6}-[0-9a-f]{6}', B, 'b')), sample: j('20260918-18', '5134-13a2ba') },
  'uuid (session/thread id)': { re: new RegExp(j(B, 'b(?!00000000-0000-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', B, 'b'), 'i'), sample: j('9b9e7ee7-8603-44df-', 'aebb-7fb3274f09ee') },
  // secrets
  'aws-access-key': { re: new RegExp(j(B, 'b(AK', 'IA|AS', 'IA)[0-9A-Z]{16}', B, 'b')), sample: j('AK', 'IAABCDEFGHIJKLMNOP') },
  'openai/anthropic-key': { re: new RegExp(j(B, 'bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}')), sample: j('s', 'k-proj-', 'a'.repeat(24)) },
  'github-token': { re: new RegExp(j(B, 'b(gh', 'p|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_', 'pat_[A-Za-z0-9_]{20,}')), sample: j('gh', 'p_', 'a'.repeat(36)) },
  'gitlab-token': { re: new RegExp(j(B, 'bgl', 'pat-[A-Za-z0-9_-]{20,}')), sample: j('gl', 'pat-', 'a'.repeat(20)) },
  'slack-token': { re: new RegExp(j(B, 'bxo', 'x[abprs]-[A-Za-z0-9-]{10,}|hooks', B, '.slack', B, '.com/services/')), sample: j('xo', 'xb-1234567890-abc') },
  'google-api-key': { re: new RegExp(j(B, 'bAI', 'za[0-9A-Za-z_-]{35}', B, 'b')), sample: j('AI', 'za', 'a'.repeat(35)) },
  'huggingface-token': { re: new RegExp(j(B, 'bh', 'f_[A-Za-z0-9]{30,}', B, 'b')), sample: j('h', 'f_', 'a'.repeat(34)) },
  'npm-token': { re: new RegExp(j(B, 'bnp', 'm_[A-Za-z0-9]{36}', B, 'b')), sample: j('np', 'm_', 'a'.repeat(36)) },
  'context7-key': { re: new RegExp(j(B, 'bctx', '7sk[-_][A-Za-z0-9-]{10,}')), sample: j('ctx', '7sk-', 'a'.repeat(12)) },
  'private-key-block': { re: new RegExp(j('-----BEGIN [A-Z ]*PRI', 'VATE KEY-----')), sample: j('-----BEGIN RSA PRI', 'VATE KEY-----') },
  'jwt': { re: new RegExp(j(B, 'bey', 'J[A-Za-z0-9_-]{10,}', B, '.eyJ[A-Za-z0-9_-]{10,}', B, '.')), sample: j('ey', 'JhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.') },
  'assigned-secret': { re: new RegExp(j(B, 'b(api[_-]?key|sec', 'ret|tok', 'en|passw(or)?d)', B, 'b["\']?', B, 's*[:=]', B, 's*["\'][^"\'', B, 's]{12,}["\']'), 'i'), sample: j('api_', 'key = "', 'a'.repeat(16), '"') },
  'bearer-token': { re: new RegExp(j(B, 'bBea', 'rer', B, 's+[A-Za-z0-9._~+/-]{20,}')), sample: j('Bea', 'rer ', 'a'.repeat(24)) },
};

const SKIP_DIRS = new Set(['node_modules', '.state', '.state-test', '.lane', '.git']);
const SKIP_ROOT_FILES = new Set(['RELEASE_CHECK.md']);
/** The one expected hit: the copyright holder in LICENSE. */
const EXPECTED = { file: 'LICENSE', pattern: 'owner-name', line: /^Copyright \(c\) \d{4} \S+ \S+$/ };

export function scan(root) {
  const controls = [];
  for (const [name, { re, sample }] of Object.entries(PATTERNS)) {
    controls.push({ control: `pattern self-test: ${name}`, ok: re.test(sample) });
  }
  const hits = [];
  let files = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
        continue;
      }
      if (dir === root && SKIP_ROOT_FILES.has(e.name)) continue;
      files++;
      const rel = path.relative(root, p).replace(/\\/g, '/');
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((text, i) => {
        for (const [name, { re }] of Object.entries(PATTERNS)) if (re.test(text)) hits.push({ file: rel, line: i + 1, pattern: name, text });
      });
    }
  };
  walk(root);
  const isExpected = (h) => h.file === EXPECTED.file && h.pattern === EXPECTED.pattern && EXPECTED.line.test(h.text);
  controls.push({ control: 'LICENSE copyright line found by owner-name', ok: hits.some(isExpected) });
  return { files, controls, expected: hits.filter(isExpected), unexpected: hits.filter((h) => !isExpected(h)) };
}

function main() {
  const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../../', import.meta.url)));
  const r = scan(root);
  const out = [`release-scan: ${r.files} files, ${Object.keys(PATTERNS).length} patterns (root: ${path.basename(root)})`];
  for (const c of r.controls) out.push(`CONTROL ${c.ok ? 'hit ' : 'MISS'}  ${c.control}`);
  for (const h of r.expected) out.push(`EXPECTED ${h.file}:${h.line}  [${h.pattern}]  (copyright holder)`);
  // The matched text is never printed: a hit could be a secret. File, line and pattern only.
  for (const h of r.unexpected) out.push(`HIT      ${h.file}:${h.line}  [${h.pattern}]`);
  const controlsOk = r.controls.every((c) => c.ok);
  out.push(`unexpected hits: ${r.unexpected.length}; controls: ${controlsOk ? 'all hit' : 'FAILED'}`);
  process.stdout.write(out.join('\n') + '\n');
  process.exitCode = !controlsOk ? 2 : r.unexpected.length ? 1 : 0;
}

const invokedDirectly = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
