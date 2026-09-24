// Platform guard. orch is Windows-only for now: the local lane is a Windows named pipe,
// cancel terminates Windows process trees, identity checks read the Windows process table,
// and the log viewer is PowerShell / Windows Terminal. On any other platform every command
// stops here, before it reads or writes anything.
import { OrchError } from './errors.mjs';

export const SUPPORTED_PLATFORMS = ['win32'];

/** @param {string} [platform] defaults to process.platform (a parameter so it can be tested) */
export function assertSupportedPlatform(platform = process.platform) {
  if (SUPPORTED_PLATFORMS.includes(platform)) return;
  throw new OrchError(
    `orch is Windows only for now (this platform: ${platform}). It relies on Windows named pipes, ` +
      'Windows process-tree termination and the Windows process table; macOS and Linux are not supported yet.',
    'unsupported-platform',
  );
}
