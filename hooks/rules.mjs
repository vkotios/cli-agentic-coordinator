// Guard rules for cli-agentic-coordinator: one source of truth for the Claude Code
// PreToolUse hook (hooks/guard.mjs) and the equivalent Codex hook.
//
// Two rule families:
//  1. WORKER LAUNCH: a worker CLI started directly (opencode run, vibe -p, agy -p/--print,
//     codex exec/review, copilot -p) bypasses orch (no worktree, no record, no lane, no
//     monitor). Denied, with the `orch run` command to use instead. Help/version/list use
//     of the same CLIs and anything launched by orch itself stay allowed.
//  2. DESTRUCTIVE: ported from a guard hook in the author's earlier project (MIT, same
//     author; see orch/THIRD_PARTY.md), keeping the rules that are not repository-specific.
//
// Every check returns { block: boolean, reason?: string, rule?: string }.
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const ok = { block: false };
const deny = (reason, rule) => ({ block: true, reason, rule });

/* ========================================================================
 * 1. WORKER LAUNCH
 * ===================================================================== */

export const WORKERS = ['opencode', 'vibe', 'agy', 'codex', 'copilot'];

/** npm / PyPI package names that install a worker CLI. */
const PACKAGE_ALIASES = {
  'opencode-ai': 'opencode',
  '@openai/codex': 'codex',
  '@github/copilot': 'copilot',
  'mistral-vibe': 'vibe',
};

const HELP_FLAGS = new Set(['--help', '-h', '--version', '-v', '-V', '/?']);

/** codex global options that take a value (codex --help, 0.154.0). */
const CODEX_VALUE_OPTS = new Set([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image', '-m', '--model',
  '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval',
]);

const orchHint = (cli) =>
  `Use orch instead: \`orch run --cli ${cli} --model <id> --dir <worktree> --handoff <file>\` ` +
  '(MCP tool `run`; `orch` = node <kit>/orch/bin/orch.mjs). It creates the record, holds the lane and monitors the run.';

/**
 * Normalise a program token to a bare lowercase name: path, quotes and a Windows
 * executable/script extension removed.
 */
export function programName(token) {
  let t = String(token || '').trim().replace(/^['"]|['"]$/g, '');
  t = t.split(/[\\/]/).pop() || '';
  t = t.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com|js|mjs|cjs|py)$/, '');
  return t;
}

/**
 * Quote-aware split of a command line into segments (on ; newline | || & && ( ) { } and
 * a bash backtick), plus the bodies of command substitutions `$( ... )` / `...` found
 * INSIDE double-quoted strings (both bash and PowerShell execute those).
 * @returns {{segments:string[], nested:string[]}}
 */
export function splitSegments(text) {
  const segments = [];
  const nested = [];
  let cur = '';
  let q = null;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (q === '"' && ch === '$' && s[i + 1] === '(') {
        let depth = 0;
        let j = i + 1;
        for (; j < s.length; j++) {
          if (s[j] === '(') depth++;
          else if (s[j] === ')' && --depth === 0) break;
        }
        nested.push(s.slice(i + 2, j));
      } else if (q === '"' && ch === '`') {
        const j = s.indexOf('`', i + 1);
        if (j > i) nested.push(s.slice(i + 1, j));
      }
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    // FIX c1: a PowerShell array subexpression `@( ... )` stays in its segment (it is an
    // argument list, e.g. `Start-Process x -ArgumentList @('run')`); it is ALSO scanned on
    // its own, because PowerShell executes what is inside it.
    if (ch === '@' && s[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      let iq = null;
      for (; j < s.length; j++) {
        const c = s[j];
        if (iq) {
          if (c === iq) iq = null;
        } else if (c === '"' || c === "'") iq = c;
        else if (c === '(') depth++;
        else if (c === ')' && --depth === 0) break;
      }
      nested.push(s.slice(i + 2, j));
      cur += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (';\n\r|&(){}`'.includes(ch)) {
      if (cur.trim()) segments.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) segments.push(cur.trim());
  return { segments, nested };
}

/**
 * Whitespace tokenizer that respects quotes. Each token keeps its unquoted value and
 * the offset where it ends in the segment (for "the rest of the line" wrappers).
 * @returns {{value:string, start:number, end:number}[]}
 */
export function tokenize(seg) {
  const out = [];
  let i = 0;
  const s = String(seg);
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    let value = '';
    let q = null;
    while (i < s.length) {
      const ch = s[i];
      if (q) {
        if (ch === q) q = null;
        else value += ch;
      } else if (ch === '"' || ch === "'") q = ch;
      else if (/\s/.test(ch)) break;
      else value += ch;
      i++;
    }
    out.push({ value, start, end: i });
  }
  return out;
}

const restOf = (seg, tok) => (tok ? seg.slice(tok.end).trim() : '');
const unquoteWhole = (s) => {
  const t = s.trim();
  return /^(['"])[\s\S]*\1$/.test(t) ? t.slice(1, -1) : t;
};

/** Decode a PowerShell -EncodedCommand payload (base64 of UTF-16LE), or null. */
function decodeEncoded(b64) {
  try {
    const txt = Buffer.from(String(b64), 'base64').toString('utf16le');
    return /[\x00-\x08\x0e-\x1f]/.test(txt) ? null : txt;
  } catch {
    return null;
  }
}

/**
 * Is this token list (one command segment) a direct worker launch? Wrappers (cmd /c,
 * powershell -Command/-EncodedCommand, bash -c, Invoke-Expression) are unwrapped and
 * scanned recursively; runners (npx, node <script>, uvx, ...) are looked through.
 * @returns {{block:boolean, reason?:string, rule?:string, cli?:string}}
 */
function checkSegment(seg, depth, vars) {
  const toks = tokenize(seg);
  let i = 0;
  // FIX c1: a `$name` / `${name}` token is read through the variables assigned earlier in
  // the same command text (see collectVars).
  const val = (k) => (toks[k] ? resolveVar(toks[k].value, vars) : '');
  if ((toks[1] && toks[1].value === '=') || (toks[0] && /^\$[\w:]+=/.test(toks[0].value))) return ok; // an assignment, not a call
  // leading noise: PowerShell call/dot operators, env assignments, prefix commands
  for (;;) {
    const v = val(i);
    const low = v.toLowerCase();
    if (!v) return ok;
    if (v === '&' || v === '.' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(v) || ['call', 'exec', 'nohup', 'time', 'command', 'builtin', 'sudo', 'env'].includes(low)) {
      i++;
      continue;
    }
    if (low === 'start') {
      // cmd `start ["title"] [/b /wait ...] program ...`
      i++;
      if (toks[i] && /^['"]/.test(seg.slice(toks[i].start, toks[i].start + 1)) && !WORKERS.includes(programName(val(i)))) i++;
      while (/^\/[a-z]+$/i.test(val(i))) i++;
      continue;
    }
    break;
  }
  const prog = programOf(val(i));
  const args = toks.slice(i + 1).map((t, k) => val(i + 1 + k));

  // orch itself: always allowed (it is the sanctioned launcher).
  if (prog === 'orch') return ok;

  // wrappers -> recurse into the wrapped command text
  if (prog === 'cmd') {
    const k = toks.findIndex((t, idx) => idx > i && /^\/[ck]$/i.test(t.value));
    return k > 0 ? checkText(unquoteWhole(restOf(seg, toks[k])), depth + 1, vars) : ok;
  }
  if (prog === 'powershell' || prog === 'pwsh') {
    for (let k = i + 1; k < toks.length; k++) {
      const v = toks[k].value.toLowerCase();
      if (/^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)$/.test(v)) {
        const decoded = decodeEncoded(val(k + 1));
        return decoded ? checkText(decoded, depth + 1, vars) : ok;
      }
      if (/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/.test(v)) return checkText(unquoteWhole(restOf(seg, toks[k])), depth + 1, vars);
      if (/^-f(i(le?)?)?$/.test(v)) return ok;
    }
    return ok;
  }
  if (['bash', 'sh', 'zsh', 'dash', 'wsl'].includes(prog)) {
    const k = toks.findIndex((t, idx) => idx > i && t.value === '-c');
    return k > 0 ? checkText(val(k + 1), depth + 1, vars) : ok;
  }
  if (prog === 'invoke-expression' || prog === 'iex') return checkText(unquoteWhole(restOf(seg, toks[i])), depth + 1, vars);
  if (prog === 'start-process' || prog === 'saps') {
    let file = null;
    let inArgs = false;
    const rest = [];
    const PARAM = /^-(filepath|argumentlist|args|workingdirectory|redirectstandard\w*|windowstyle|verb|credential|wait|nonewwindow|passthru|loaduserprofile|usenewenvironment|environment)$/;
    for (let k = i + 1; k < toks.length; k++) {
      const v = toks[k].value;
      const low = v.toLowerCase();
      if (/^-(filepath|fi\w*)$/.test(low)) {
        file = val(++k);
        inArgs = false;
      } else if (/^-(argumentlist|args|ar\w*)$/.test(low)) inArgs = true;
      else if (/^-(workingdirectory|redirectstandard\w*|windowstyle|verb|credential)$/.test(low)) {
        k++;
        inArgs = false;
      } else if (PARAM.test(low)) inArgs = false;
      else if (inArgs || file) rest.push(...resolveVar(v, vars).split(/[\s,()@]+/).filter(Boolean));
      else file = resolveVar(v, vars);
    }
    return file ? judgeWorker(programOf(file), rest) : ok;
  }

  // runners that execute a package or a script
  let worker = WORKERS.includes(prog) ? prog : null;
  let wargs = args;
  const SCRIPT_RUNNERS = ['node', 'bun', 'deno', 'python', 'python3', 'py'];
  const findPackage = (from) => {
    for (let k = from; k < args.length; k++) {
      const a = args[k];
      if (a === '--') continue;
      if (/^-/.test(a)) {
        if (['-p', '--package', '-r', '--require', '--import', '--from', '--with'].includes(a)) k++;
        continue;
      }
      // FIX c5: for a script runner, a script is the worker only when it lives in the
      // worker's INSTALLED package - never a local file that merely shares the name.
      const name = SCRIPT_RUNNERS.includes(prog) ? installedWorkerScript(a) : PACKAGE_ALIASES[a.replace(/@[^/@]*$/, '')] || PACKAGE_ALIASES[a] || programName(a);
      return WORKERS.includes(name) ? { name, at: k } : { name: null, at: k };
    }
    return { name: null, at: -1 };
  };
  if (!worker) {
    let from = -1;
    if (['npx', 'bunx', 'pnpx', 'uvx', ...SCRIPT_RUNNERS].includes(prog)) from = 0;
    else if (['pnpm', 'yarn', 'npm'].includes(prog) && ['dlx', 'exec', 'x'].includes(args[0])) from = 1;
    else if (prog === 'pipx' && args[0] === 'run') from = 1;
    else if (prog === 'uv' && (args[0] === 'run' || (args[0] === 'tool' && args[1] === 'run'))) from = args[0] === 'tool' ? 2 : 1;
    if (from >= 0) {
      const p = findPackage(from);
      if (p.at >= 0 && programName(args[p.at]) === 'orch') return ok; // node <kit>/orch/bin/orch.mjs ...
      if (p.name) {
        worker = p.name;
        wargs = args.slice(p.at + 1);
      }
    }
  }
  return worker ? judgeWorker(worker, wargs) : ok;
}

/** Given a worker CLI and its arguments, is this a headless model launch? */
export function judgeWorker(cli, args) {
  const a = args.map((x) => String(x));
  if (a.some((x) => HELP_FLAGS.has(x) || x === 'help')) return ok;
  const hasFlag = (...names) => a.some((x) => names.includes(x) || names.some((n) => n.startsWith('-') && x.startsWith(`${n}=`)));
  let launch = null;
  if (cli === 'opencode') {
    if (a.includes('run')) launch = 'opencode run';
  } else if (cli === 'codex') {
    // the subcommand is the first positional after the global options
    for (let k = 0; k < a.length; k++) {
      const x = a[k];
      if (x.startsWith('-')) {
        if (CODEX_VALUE_OPTS.has(x)) k++;
        continue;
      }
      if (x === 'exec' || x === 'e') launch = 'codex exec';
      else if (x === 'review') launch = 'codex review';
      break;
    }
  } else if (cli === 'vibe') {
    if (hasFlag('-p', '--prompt')) launch = 'vibe -p';
  } else if (cli === 'agy') {
    if (hasFlag('-p', '--print', '--prompt')) launch = 'agy -p';
  } else if (cli === 'copilot') {
    if (hasFlag('-p', '--prompt')) launch = 'copilot -p';
  }
  if (!launch) return ok;
  return { ...deny(`Blocked: a direct \`${launch}\` launch bypasses orch. ${orchHint(cli)}`, 'worker-launch'), cli };
}

/** Is this script path inside an installed worker package (node_modules / site-packages)? */
function installedWorkerScript(p) {
  const s = '/' + String(p).replace(/\\/g, '/').toLowerCase();
  for (const [pkg, w] of Object.entries(PACKAGE_ALIASES)) {
    if (s.includes(`/node_modules/${pkg}/`) || s.includes(`/site-packages/${pkg.replace(/-/g, '_')}/`)) return w;
  }
  const name = programName(p);
  if (WORKERS.includes(name) && /\/(node_modules|site-packages)\//.test(s)) return name;
  return null;
}

/**
 * FIX c1: variables assigned in the command text itself, PowerShell (`$exe = 'opencode'`,
 * `$exe = (Get-Command codex).Source`) and POSIX (`exe=opencode`), stored unquoted. In the
 * program position an expression value is read by `programOf` (the worker it names, if any).
 * A variable set in an EARLIER command, a script or a profile is not visible to a text guard.
 */
export function collectVars(text, outer = {}) {
  const vars = { ...outer };
  const s = String(text || '');
  const put = (name, raw) => {
    vars[name.toLowerCase()] = String(raw || '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  };
  for (const m of s.matchAll(/\$(?:env:)?([A-Za-z_]\w*)\s*=\s*([^;\n|&]+)/g)) put(m[1], m[2]);
  for (const m of s.matchAll(/(?:^|[;&|\n]\s*)([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;|&)]+)/g)) put(m[1], m[2]);
  return vars;
}

const WORKER_WORD = /(?:^|[\\/\s'"(])(opencode|vibe|agy|codex|copilot)(?:\.(?:exe|cmd|bat|ps1))?(?=$|[\s'")])/i;

/** Program name of a (resolved) token; an expression such as `(Get-Command codex).Source` names its worker. */
function programOf(v) {
  const n = programName(v);
  if (!/[\s(]/.test(String(v))) return n;
  const w = WORKER_WORD.exec(String(v));
  return w ? w[1].toLowerCase() : n;
}

function resolveVar(token, vars) {
  const m = /^\$(?:env:)?\{?([A-Za-z_]\w*)\}?$/.exec(String(token));
  if (!m || !vars) return token;
  const v = vars[m[1].toLowerCase()];
  return v === undefined ? token : v;
}

/** Wrapper nesting deeper than this is refused rather than half-inspected (FIX c1). */
export const MAX_NESTING = 8;

function checkText(text, depth, outerVars = {}) {
  if (depth > MAX_NESTING) {
    return deny(`Blocked: the command nests shells/wrappers more than ${MAX_NESTING} levels deep, too deep for the guard to inspect. Run it without the extra wrapping.`, 'nesting-too-deep');
  }
  const vars = collectVars(text, outerVars);
  const { segments, nested } = splitSegments(text);
  for (const seg of segments) {
    const r = checkSegment(seg, depth, vars);
    if (r.block) return r;
  }
  for (const n of nested) {
    const r = checkText(n, depth + 1, vars);
    if (r.block) return r;
  }
  return ok;
}

/**
 * Worker-launch check for a whole Bash/PowerShell command string.
 * LIMITATION (stated, not hidden): this reads command TEXT. It catches the direct forms and
 * the common wrappers; it cannot see a launch from a script file, an alias or function, or
 * a variable set in an earlier command. It prevents accidents; it is not a sandbox.
 */
export function checkWorkerLaunch(command) {
  return checkText(String(command || ''), 0);
}

/* ========================================================================
 * 2. DESTRUCTIVE (ported; see orch/THIRD_PARTY.md)
 * ===================================================================== */

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function destructiveSegments(command) {
  return command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function argsAfter(segment, re) {
  const m = segment.match(re);
  if (!m) return null;
  return m[1]
    .trim()
    .split(/\s+/)
    .map((a) => a.replace(/^['"]|['"]$/g, ''))
    .filter((a) => a && !a.startsWith('-'));
}

// Fails closed: if git cannot answer, the paths are treated as dirty.
function dirtyPaths(paths, cwd) {
  if (paths.length === 0 || paths.some((p) => p === '.' || p.includes('*'))) return true;
  const out = git(['status', '--porcelain', '--', ...paths], cwd);
  return out === null || out.length > 0;
}

// Also catches globs (.env*, .env.?) that would expand to secret files.
const ENV_FILE = /(^|[\s"'=/\\(<@])\.env(\.(?!example\b)[\w.*?-]+|[*?][\w.*?-]*)?(?=$|[\s"'/\\;|&)])/;

// Windows recursive deletes: Remove-Item or an alias with any abbreviation of -Recurse,
// and cmd rmdir/rd/del/erase with /s.
const PS_RECURSIVE_DELETE = /\b(Remove-Item|ri|rm|rmdir|rd|del|erase)\b.*\s-r(e(c(u(r(se?)?)?)?)?)?\b/i;
const CMD_RECURSIVE_DELETE = /\b(rmdir|rd|del|erase)\b.*\s\/s\b/i;

// A delete is exempt only when every target in that segment is inside the Claude
// scratch/temp area (flags such as -rf or /s /q are ignored).
const SCRATCH_PATH = /[/\\]Temp[/\\]claude[/\\]/i;
function onlyScratchTargets(seg) {
  const targets = seg
    .split(' ')
    .slice(1)
    .map((a) => a.replace(/^['"]|['"]$/g, ''))
    .filter((a) => a && !a.startsWith('-') && !/^\/[A-Za-z]{1,2}$/.test(a));
  return targets.length > 0 && targets.every((t) => SCRATCH_PATH.test(t));
}

/** git global options that take a separate value (`git -C <dir> ...`, `git -c k=v ...`). */
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix', '--list-cmds', '--attr-source']);

/**
 * FIX c2: bring every git invocation in a segment to the canonical `git <subcommand> ...`
 * form: a `git.exe` / full-path executable becomes `git`, and the global options between
 * the executable and the subcommand (-C, -c, --git-dir, --work-tree, --no-pager, -p, ...)
 * are removed, so every git rule sees the subcommand directly after `git`. A `-C <dir>`
 * also moves the working directory used by the dirty-path checks.
 * @returns {{seg:string, cwd:string}}
 */
export function normalizeGit(seg, cwd) {
  const toks = tokenize(seg);
  const k0 = toks.findIndex((t) => programName(t.value) === 'git');
  if (k0 < 0) return { seg, cwd };
  let dir = cwd;
  let k = k0 + 1;
  while (k < toks.length) {
    const v = toks[k].value;
    if (!v.startsWith('-')) break;
    const name = v.includes('=') ? v.slice(0, v.indexOf('=')) : v;
    if (name === '-C' && !v.includes('=')) {
      const d = toks[k + 1] ? toks[k + 1].value : '';
      dir = d ? (/^([A-Za-z]:|[\\/])/.test(d) ? d : `${dir || '.'}/${d}`) : dir;
      k += 2;
    } else if (GIT_VALUE_OPTS.has(name) && !v.includes('=')) k += 2;
    else k += 1; // --no-pager, -p, -P, --bare, --no-optional-locks, --git-dir=x, ...
  }
  const before = seg.slice(0, toks[k0].start);
  const after = k < toks.length ? seg.slice(toks[k].start) : '';
  return { seg: `${before}git ${after}`.trim(), cwd: dir };
}

export function checkDestructive(rawCommand, cwd) {
  const command = String(rawCommand || '').replace(/\s+/g, ' ');
  for (const rawSeg of destructiveSegments(command)) {
    const scratchOnly = onlyScratchTargets(rawSeg);
    const { seg, cwd: gitCwd } = normalizeGit(rawSeg, cwd);
    if (/\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b/.test(seg) && !scratchOnly)
      return deny(
        "Blocked: recursive forced delete (rm -rf). Deleting files needs the owner's explicit consent; stop and explain what would be removed. An orch worktree is removed with `orch worktree remove <id>`.",
        'rm-rf',
      );
    if ((PS_RECURSIVE_DELETE.test(seg) || CMD_RECURSIVE_DELETE.test(seg)) && !scratchOnly)
      return deny("Blocked: recursive delete. Deleting files needs the owner's explicit consent. An orch worktree is removed with `orch worktree remove <id>`.", 'recursive-delete');
    if (/\bgit\s+push\b/.test(seg) && /(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+[\w/.-]+)/.test(seg))
      return deny('Blocked: force push rewrites shared history.', 'force-push');
    if (/\bgit\s+reset\b.*--hard\b/.test(seg)) return deny('Blocked: git reset --hard discards work irrecoverably.', 'reset-hard');
    if (/\bgit\s+clean\b.*\s-\w*f/.test(seg)) return deny('Blocked: git clean -f deletes untracked files irrecoverably.', 'git-clean');
    if (/\bgit\s+branch\b.*(\s-D\b|--delete\s+--force|--force\s+--delete)/.test(seg))
      return deny('Blocked: force-deleting a branch. For an orch slice branch use `orch worktree remove <id> --delete-branch` (refuses unmerged work).', 'branch-force-delete');
    if (/\bgit\s+stash\s+(drop|clear)\b/.test(seg)) return deny('Blocked: dropping stashes loses work.', 'stash-drop');

    const checkoutPaths = argsAfter(seg, /\bgit\s+checkout\b[^]*?\s--\s+(.*)$/);
    if (checkoutPaths && dirtyPaths(checkoutPaths, gitCwd))
      return deny(
        'Blocked: git checkout -- over uncommitted changes destroys them. Use `git show <ref>:<path>` to inspect, or commit/stash first.',
        'checkout-dirty',
      );
    if ((/\bgit\s+restore\b/.test(seg) && !/--staged\b/.test(seg)) || /\bgit\s+restore\b.*--worktree\b/.test(seg)) {
      const restorePaths = argsAfter(seg, /\bgit\s+restore\b(.*)$/) || [];
      if (dirtyPaths(restorePaths, gitCwd)) return deny('Blocked: git restore over uncommitted changes destroys them. Commit or stash first.', 'restore-dirty');
    }

    if (/\bdrop\s+(database|schema|table)\b/i.test(seg))
      return deny('Blocked: DROP statement. Schema changes go through a migration with the owner\'s approval.', 'sql-drop');
    if (ENV_FILE.test(seg)) return deny('Blocked: .env files hold secrets. Do not read, print or modify them.', 'env-file');

    if (/\bgit\s+(commit|push)\b/.test(seg) && /(\s--no-verify\b|\bcommit\b.*\s-\w*n\w*\b)/.test(seg))
      return deny("Blocked: --no-verify skips the repository's git hooks.", 'no-verify');
  }
  return ok;
}

/** .env paths for the file tools (Read / Edit / Write / MultiEdit / NotebookEdit). */
export function checkPath(filePath) {
  if (!filePath) return ok;
  const name = basename(String(filePath));
  if (/^\.env(\..+)?$/i.test(name) && name.toLowerCase() !== '.env.example')
    return deny('Blocked: .env files hold secrets. Do not read or modify them.', 'env-file');
  return ok;
}

/** Both families, worker launch first (its reason names the orch command). */
export function checkCommand(command, cwd) {
  const w = checkWorkerLaunch(command);
  if (w.block) return w;
  return checkDestructive(command, cwd);
}
