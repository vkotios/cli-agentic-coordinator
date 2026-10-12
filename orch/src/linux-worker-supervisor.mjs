// Linux-only launcher: keep the actual worker in a private session and tie its
// lifetime to the keeper. If the keeper disappears, this wrapper kills the
// session so neither the CLI nor its same-session descendants are orphaned.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function procStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    return {
      state: fields[0],
      ppid: Number(fields[1]),
      pgrp: Number(fields[2]),
      session: Number(fields[3]),
      start: fields[19],
    };
  } catch {
    return null;
  }
}

function ownPipe(pathname, deviceText, inodeText) {
  if (!pathname) return null;
  const uid = process.getuid?.();
  const expectedDir = path.join(os.tmpdir(), `.orch-${uid}`);
  if (!Number.isInteger(uid) || path.dirname(pathname) !== expectedDir || !path.isAbsolute(pathname) || !/^lane-[A-Za-z0-9_-]+\.sock$/.test(path.basename(pathname))) {
    throw new Error('unsafe Linux lane socket path');
  }
  const dir = fs.lstatSync(expectedDir);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o077) !== 0) {
    throw new Error('unsafe Linux lane socket directory');
  }
  const socket = fs.lstatSync(pathname);
  if (!socket.isSocket() || socket.uid !== uid || String(socket.dev) !== deviceText || String(socket.ino) !== inodeText) {
    throw new Error('lane socket ownership could not be established');
  }
  return { pathname, dev: socket.dev, ino: socket.ino, uid };
}

function removeOwnPipe(identity) {
  if (!identity) return;
  try {
    const current = fs.lstatSync(identity.pathname);
    if (current.isSocket() && current.uid === identity.uid && current.dev === identity.dev && current.ino === identity.ino) {
      fs.unlinkSync(identity.pathname);
    }
  } catch {
    /* already absent or replaced; never remove an unverified path */
  }
}

let statusSent = false;
function reportStatus(line) {
  if (statusSent) return;
  statusSent = true;
  try { fs.writeSync(3, `${line}\n`); } catch { /* keeper may already have exited */ }
  try { fs.closeSync(3); } catch { /* no status pipe in direct invocations */ }
}

function fail(message, code = 125, statusCode = 'SUPERVISOR') {
  reportStatus(`ERROR ${statusCode}`);
  try { process.stderr.write(`orch Linux worker supervisor: ${message}\n`); } catch { /* inherited output may be closed */ }
  process.exit(code);
}

if (process.platform !== 'linux') fail('this launcher is Linux-only');
const [exe, encodedArgs, keeperPidText, keeperStart, pipeName, pipeDevice, pipeInode] = process.argv.slice(2);
let args;
try { args = JSON.parse(encodedArgs); } catch { fail('invalid worker arguments'); }
const keeperPid = Number(keeperPidText);
if (!exe || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string') || !Number.isInteger(keeperPid) || keeperPid <= 1 || !/^\d+$/.test(keeperStart || '')) {
  fail('invalid worker launch request');
}

// Claim the exact socket before admission. If the keeper died after spawning us but
// before this module started, it cannot close its listener or remove the stale path.
let pipeIdentity;
if (pipeName) {
  try { pipeIdentity = ownPipe(pipeName, pipeDevice, pipeInode); } catch (error) { fail(`lane socket identity could not be established: ${error?.message || error}`); }
} else if (pipeDevice || pipeInode) {
  fail('unexpected lane socket identity for a non-exclusive lane');
}
const keeper = procStat(keeperPid);
if (!keeper || keeper.start !== keeperStart || keeper.state === 'Z' || keeper.state === 'X') {
  removeOwnPipe(pipeIdentity);
  fail('keeper identity could not be established');
}
const self = procStat(process.pid);
if (!self || self.pgrp !== process.pid || self.session !== process.pid) {
  fail('worker supervisor is not an isolated session leader');
}

let worker;
try {
  worker = spawn(exe, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    detached: false,
    stdio: 'inherit',
  });
} catch (error) {
  fail(`worker spawn failed: ${error?.code || error?.message || error}`, 127, error?.code || 'SPAWN-THREW');
}
worker.once('spawn', () => reportStatus('READY'));

let complete = false;
let timer;
function terminateSession() {
  if (complete) return;
  complete = true;
  if (timer) clearInterval(timer);
  removeOwnPipe(pipeIdentity);
  // The wrapper is the verified session leader; its worker and ordinary
  // descendants share this group. Detached descendants are outside this scope.
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    try { worker.kill('SIGKILL'); } catch { /* no safer action remains */ }
    process.exit(137);
  }
}

function checkKeeper() {
  const current = procStat(keeperPid);
  if (!current || current.start !== keeperStart || current.state === 'Z' || current.state === 'X') {
    terminateSession();
  }
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, terminateSession);
timer = setInterval(checkKeeper, 50);
checkKeeper();
worker.on('error', (/** @type {any} */ error) => {
  if (!statusSent) reportStatus(`ERROR ${error?.code || 'SPAWN-ERROR'}`);
  try { process.stderr.write(`worker spawn failed: ${error?.message || error}\n`); } catch { /* best effort */ }
});
worker.on('close', (code, signal) => {
  if (complete) return;
  complete = true;
  clearInterval(timer);
  process.exitCode = code ?? (signal ? 128 + (signal === 'SIGTERM' ? 15 : signal === 'SIGINT' ? 2 : 9) : 1);
});
