// Built locally for the host architecture; no downloaded or checked-in executable.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../native/darwin-processes.c', import.meta.url));
const target = fileURLToPath(new URL('../native/darwin-processes', import.meta.url));
if (process.platform === 'darwin') {
  const temporary = `${target}.${process.pid}`;
  try {
    await new Promise((resolve, reject) => execFile('/usr/bin/xcrun', ['clang', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', temporary],
      { timeout: 60000 }, error => error ? reject(error) : resolve(null)));
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw new Error('Cannot build macOS process helper. Install Apple Command Line Tools with xcode-select --install, then rerun npm ci.', { cause: error });
  }
}
