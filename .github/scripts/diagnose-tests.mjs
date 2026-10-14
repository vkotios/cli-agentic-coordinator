// Observation only: preserve child output and exit status. No environment values or command lines are sampled.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const [program, ...args] = process.argv.slice(2);
if (!program) throw new Error('Expected an executable and optional arguments');
const output = path.resolve(process.env.DIAGNOSTIC_OUTPUT_DIR || path.join(os.tmpdir(), 'orch-ci-diagnostics'));
const intervalMs = Number(process.env.DIAGNOSTIC_INTERVAL_MS || 30000);
if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) throw new Error('Invalid sampling interval');
fs.mkdirSync(output, { recursive: true });
const append = (name, text) => fs.appendFileSync(path.join(output, name), text);
const started = Date.now();
let lastOutputAt = null;
let previousCpu = os.cpus();
let pending = null;
let telemetryComplete = true;
const processQuery = `
$all = @(Get-Process -ErrorAction SilentlyContinue)
[pscustomobject]@{
  total = $all.Count
  node = @($all | Where-Object ProcessName -eq 'node').Count
  powershell = @($all | Where-Object ProcessName -in @('pwsh', 'powershell')).Count
  runner = @($all | Where-Object ProcessName -like 'Runner.*').Count
  topMemory = @($all | Sort-Object WorkingSet64 -Descending | Select-Object -First 8 | ForEach-Object {
    [pscustomobject]@{name=$_.ProcessName;pid=$_.Id;workingSetBytes=$_.WorkingSet64;handles=$_.Handles}
  })
} | ConvertTo-Json -Depth 4 -Compress
`;

function sample() {
  if (pending) return pending;
  pending = (async () => {
    const current = os.cpus();
    let idle = 0;
    let total = 0;
    for (let i = 0; i < current.length; i++) {
      if (!previousCpu[i]) continue;
      for (const key of Object.keys(current[i].times)) total += current[i].times[key] - previousCpu[i].times[key];
      idle += current[i].times.idle - previousCpu[i].times.idle;
    }
    previousCpu = current;
    const record = {
      at: new Date().toISOString(), elapsedMs: Date.now() - started,
      lastOutputAgeMs: lastOutputAt === null ? null : Date.now() - lastOutputAt,
      cpuPercent: total > 0 ? Number((100 * (1 - idle / total)).toFixed(2)) : null,
      totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(),
    };
    try {
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', processQuery], {
        timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024,
      });
      record.processes = JSON.parse(stdout.trim());
      if (!(record.processes.total > 0)) throw new Error('No process counters returned');
    } catch (error) {
      record.samplingError = error.message;
      telemetryComplete = false;
    }
    append('resources.jsonl', JSON.stringify(record) + '\n');
    process.stdout.write('CI_RESOURCE ' + JSON.stringify(record) + '\n');
  })().finally(() => { pending = null; });
  return pending;
}

await sample();
const childStarted = Date.now();
let spawnError = null;
const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.on('data', chunk => {
    lastOutputAt = Date.now();
    append('tests.log', chunk);
    target.write(chunk);
  });
}
child.on('error', error => { spawnError = error.message; });
const timer = setInterval(() => { sample().catch(error => { telemetryComplete = false; console.error('CI_SAMPLING_ERROR', error.message); }); }, intervalMs);
const result = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
const childEnded = Date.now();
clearInterval(timer);
if (pending) await pending;
await sample();
const exitCode = spawnError || result.signal || result.code === null || result.code < 0 ? 1 : result.code;
const receipt = {
  started: new Date(childStarted).toISOString(), ended: new Date(childEnded).toISOString(),
  elapsedMs: childEnded - childStarted, exitCode, signal: result.signal, spawnError,
  telemetryComplete, intervalMs,
};
fs.writeFileSync(path.join(output, 'test-exit.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log('CI_TEST_EXIT', JSON.stringify(receipt));
process.exitCode = exitCode;
