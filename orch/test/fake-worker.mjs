// Deterministic stand-in for a worker CLI, used by the automated tests so the job
// core can be exercised without calling a model.
//
// SAFETY: every fake process carries a SELF-DESTRUCT timer (default 120 s). Nothing
// this suite starts can outlive the suite by more than that, whatever goes wrong.
//
// Options (passed through `orch run --flag <x>`):
//   --emit N            emit N stdout lines, one every --interval ms
//   --interval MS       gap between emitted lines (default 200)
//   --hold S            stay alive S seconds after the work is done
//   --silent            produce no output at all after the banner line
//   --empty             produce NO stdout at all (exit-0-with-empty-output case)
//   --exit N            exit with code N (default 0)
//   --grandchild        spawn a NON-detached child which spawns a grandchild
//   --detached-helper   spawn a `detached:true` descendant (escapes containment)
//   --alive-marker      create `<cwd>/alive-<pid>` at start, remove it at exit
//   --session-dir D     emit a synthetic opencode `--print-logs` session line naming D
//   --session-split N   write that line in N-byte chunks (byte-boundary framing test)
//   --write-file NAME   create NAME in cwd (worktree activity signal)
//   --stderr TEXT       write TEXT to stderr once
//   --echo TEXT         write TEXT verbatim to stdout (proves free worker output can
//                       never reclassify a run)
//   --wait-for-file P   before doing anything else, wait until file P exists (bounded: 60 s,
//                       then carry on) - lets a test order the worker after another event
//   --no-stdin          do not wait for stdin (used for the spawned descendants)
//   --spawn-child       spawn one further descendant (internal)
//   --self-destruct S   backstop timer (default 120)
//   slice 2 (review containment):
//   --git-commit        make an (empty) commit in cwd - a reviewer that commits
//   --write-abs PATH    create PATH (absolute) - a reviewer that writes outside its worktree
//   --ls                print `LS <relpath>` for every file under cwd (not .git) - blinding check
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
function opt(name, def = null) {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : true) : def;
}
const has = (name) => argv.includes(name);

const emit = Number(opt('--emit', 0)) || 0;
const interval = Number(opt('--interval', 200)) || 200;
const hold = Number(opt('--hold', 0)) || 0;
const exitCode = Number(opt('--exit', 0)) || 0;
const silent = has('--silent');
const empty = has('--empty');
const writeFile = opt('--write-file', null);
const stderrText = opt('--stderr', null);
const echoText = opt('--echo', null);
const sessionDir = opt('--session-dir', null);
const sessionSplit = Number(opt('--session-split', 0)) || 0;
const selfDestructS = Number(opt('--self-destruct', 120)) || 120;

// SELF-DESTRUCT: non-negotiable for every fake process this suite starts.
// `unref()`: the timer must not itself hold the process open - it only has to fire if
// something else is keeping the worker alive past its welcome.
setTimeout(() => {
  try {
    process.stderr.write(`FAKE-WORKER SELF-DESTRUCT after ${selfDestructS}s\n`);
  } catch {
    /* ignore */
  }
  process.exit(97);
}, selfDestructS * 1000).unref();

let markerFile = null;
if (has('--alive-marker')) {
  markerFile = path.join(process.cwd(), `alive-${process.pid}`);
  try {
    fs.writeFileSync(markerFile, String(Date.now()));
  } catch {
    /* ignore */
  }
  const clear = () => {
    try {
      if (markerFile) fs.unlinkSync(markerFile);
    } catch {
      /* ignore */
    }
  };
  process.on('exit', clear);
}

if (has('--grandchild')) {
  const child = spawn(process.execPath, [SELF, '--no-stdin', '--hold', '600', '--spawn-child', '--self-destruct', '120'], {
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  });
  child.unref?.();
}
if (has('--spawn-child')) {
  const child = spawn(process.execPath, [SELF, '--no-stdin', '--hold', '600', '--self-destruct', '120'], {
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  });
  child.unref?.();
}
if (has('--detached-helper')) {
  const child = spawn(process.execPath, [SELF, '--no-stdin', '--hold', '600', '--self-destruct', '120'], {
    stdio: 'ignore',
    shell: false,
    detached: true,
    windowsHide: true,
  });
  child.unref?.();
  try {
    fs.writeFileSync(path.join(process.cwd(), 'detached-helper.pid'), String(child.pid));
  } catch {
    /* ignore */
  }
}

function out(line) {
  if (empty) return;
  try {
    process.stdout.write(line + '\n');
  } catch {
    /* pipe closed */
  }
}

/** A byte-exact stand-in for opencode's `--print-logs` session-creation line (K1). */
function sessionLine(dir) {
  const esc = String(dir).replace(/\\/g, '\\\\');
  return (
    `timestamp=${new Date().toISOString()} level=INFO run=deadbeef ` +
    `message=created id=ses_faketest0001 slug=fake-worker version=0.0.0 directory="${esc}"\n`
  );
}

async function work(stdinBuf) {
  const waitFile = opt('--wait-for-file', null);
  if (waitFile && waitFile !== true) {
    const until = Date.now() + 60000;
    while (!fs.existsSync(String(waitFile)) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  }
  if (sessionDir) {
    const line = sessionLine(sessionDir === true ? process.cwd() : sessionDir);
    if (sessionSplit > 0) {
      const buf = Buffer.from(line, 'utf8');
      for (let i = 0; i < buf.length; i += sessionSplit) {
        try {
          process.stderr.write(buf.subarray(i, Math.min(i + sessionSplit, buf.length)));
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    } else {
      try {
        process.stderr.write(line);
      } catch {
        /* ignore */
      }
    }
  }
  if (writeFile) {
    try {
      fs.writeFileSync(path.join(process.cwd(), String(writeFile)), `written by fake worker ${process.pid}\n`);
    } catch {
      /* ignore */
    }
  }
  if (stderrText) {
    try {
      process.stderr.write(String(stderrText) + '\n');
    } catch {
      /* ignore */
    }
  }
  const writeAbs = opt('--write-abs', null);
  if (writeAbs && writeAbs !== true) {
    try {
      fs.writeFileSync(String(writeAbs), `written outside the worktree by fake worker ${process.pid}\n`);
    } catch {
      /* ignore */
    }
  }
  const gitConfig = opt('--git-config', null);
  if (gitConfig && gitConfig !== true) {
    // A reviewer changing the SHARED repository config from its detached worktree.
    const [k, ...v] = String(gitConfig).split('=');
    try {
      execFileSync('git', ['config', '--local', k, v.join('=')], { cwd: process.cwd(), stdio: 'ignore', timeout: 30000, windowsHide: true });
      out('GIT-CONFIG done');
    } catch (e) {
      out(`GIT-CONFIG failed ${String((e && e.message) || e).slice(0, 200)}`);
    }
  }
  if (has('--git-commit')) {
    try {
      execFileSync('git', ['-c', 'user.name=fake-reviewer', '-c', 'user.email=fake@example.invalid', 'commit', '--allow-empty', '-m', 'a reviewer must never commit'], {
        cwd: process.cwd(),
        stdio: 'ignore',
        timeout: 30000,
        windowsHide: true,
      });
      out('GIT-COMMIT done');
    } catch (e) {
      out(`GIT-COMMIT failed ${String((e && e.message) || e).slice(0, 200)}`);
    }
  }
  if (has('--ls')) {
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else out(`LS ${r}`);
      }
    };
    try {
      walk(process.cwd(), '');
    } catch {
      /* ignore */
    }
  }
  if (echoText) out(String(echoText));
  if (!silent) {
    const sha = crypto.createHash('sha256').update(stdinBuf).digest('hex');
    out(`STDIN-BYTES ${stdinBuf.length}`);
    out(`STDIN-SHA256 ${sha}`);
    out(`ARGV ${JSON.stringify(argv)}`);
    out(`IS-TTY ${process.stdin.isTTY === true}`);
    out(`PWD-ENV ${process.env.PWD === undefined ? '(unset)' : process.env.PWD}`);
    out(`CWD ${process.cwd()}`);
    for (let i = 1; i <= emit; i++) {
      await new Promise((r) => setTimeout(r, interval));
      out(`TICK ${i}/${emit}`);
    }
  } else {
    for (let i = 1; i <= emit; i++) await new Promise((r) => setTimeout(r, interval));
  }
  if (hold > 0) await new Promise((r) => setTimeout(r, hold * 1000));
  process.exit(exitCode);
}

if (has('--no-stdin')) {
  work(Buffer.alloc(0));
} else {
  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('end', () => work(Buffer.concat(chunks)));
  process.stdin.on('error', () => work(Buffer.concat(chunks)));
}
