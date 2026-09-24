// Headless stand-in for the viewer tab (test-only). Behaves like tail-view.ps1 where
// it matters: it writes its OWN pid to -PidFile and stays alive until it is closed by
// that pid. It also appends its pid to $ORCH_FAKE_VIEWER_LOG so a test can check that
// EVERY viewer ever opened for a run was closed. Optional $ORCH_FAKE_VIEWER_DELAY_MS
// delays the pid report (a slow-starting tab). At start-up, before that delay, it creates
// `$ORCH_FAKE_VIEWER_LOG.started`, so a test can know a viewer has been launched.
// SAFETY: self-destructs after 120 s whatever happens.
import fs from 'node:fs';

const argv = process.argv.slice(2);
const pidFile = argv[argv.indexOf('-PidFile') + 1];
const delay = Number(process.env.ORCH_FAKE_VIEWER_DELAY_MS || 0);

setTimeout(() => process.exit(97), 120000); // referenced on purpose: it IS the keep-alive
try {
  if (process.env.ORCH_FAKE_VIEWER_LOG) fs.appendFileSync(`${process.env.ORCH_FAKE_VIEWER_LOG}.started`, `${process.pid}\n`);
} catch {
  /* ignore */
}
setTimeout(() => {
  try {
    if (process.env.ORCH_FAKE_VIEWER_LOG) fs.appendFileSync(process.env.ORCH_FAKE_VIEWER_LOG, `${process.pid}\n`);
    fs.writeFileSync(pidFile, String(process.pid));
  } catch {
    /* the monitor will report no pid */
  }
}, delay);
