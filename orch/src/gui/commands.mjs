// `orch gui serve` and `orch gui set-password`.
import fs from 'node:fs';
import { OrchError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { setPassword, hasPassword, MIN_PASSWORD } from './auth.mjs';
import { startGui } from './server.mjs';
import { runForeman } from '../foreman/daemon.mjs';

export async function cmdGui(args, io = console) {
  const [sub] = args._;
  const cfg = loadConfig(args['state-root']);
  if (sub === 'set-password') {
    // Never from the command line: it would sit in shell history and the process list.
    let password;
    if (typeof args.env === 'string') password = process.env[args.env];
    else if (typeof args.file === 'string') password = fs.readFileSync(args.file, 'utf8').replace(/\r?\n$/, '');
    else throw new OrchError(`usage: orch gui set-password --env <VARIABLE> | --file <path>  (at least ${MIN_PASSWORD} characters; never on the command line)`, 'missing-arg');
    if (!password) throw new OrchError('the password source is empty or the variable is not set', 'missing-arg');
    await setPassword(cfg.stateRoot, password);
    io.log('password set');
    return { exitCode: 0 };
  }
  if (sub === 'serve') {
    const host = typeof args.host === 'string' ? args.host : '127.0.0.1';
    const port = args.port != null ? Number(args.port) : 7842;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new OrchError('--port must be a whole number from 0 to 65535', 'bad-port');
    const allowedHosts = typeof args['allowed-hosts'] === 'string' ? args['allowed-hosts'].split(',').map((h) => h.trim()).filter(Boolean) : [];
    const stopSignal = { stopped: false };
    const stop = () => { stopSignal.stopped = true; };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const gui = await startGui({ stateRoot: cfg.stateRoot, host, port, allowedHosts, log: (s) => io.log(s), inProcessForeman: !args['no-foreman'] });
    io.log(`orch control plane on http://${host}:${gui.port}/ ${hasPassword(cfg.stateRoot) ? '(password sign-in)' : '(loopback only, no password set)'}`);
    let foreman = Promise.resolve();
    if (!args['no-foreman']) {
      foreman = runForeman({ stateRoot: cfg.stateRoot, log: (s) => io.log(`[foreman] ${s}`), stopSignal }).catch((error) => {
        io.log(`[foreman] not started in this process: ${error.message}`);
        return waitFor(stopSignal);
      });
    } else await waitFor(stopSignal);
    await foreman;
    await gui.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    return { exitCode: 0 };
  }
  throw new OrchError('usage: orch gui serve [--host <address>] [--port <n>] [--allowed-hosts a,b] [--no-foreman] | set-password --env <VAR>', 'missing-arg');
}

function waitFor(signal) {
  return new Promise((resolve) => { const t = setInterval(() => { if (signal.stopped) { clearInterval(t); resolve(undefined); } }, 250); });
}
