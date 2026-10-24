// orch supports Windows, Linux and macOS. Platform-specific supervision details live in the
// lane-pipe, process-table, executable-resolver and viewer adapters.
import { OrchError } from './errors.mjs';

export const SUPPORTED_PLATFORMS = ['win32', 'linux', 'darwin'];

/** @param {string} [platform] defaults to process.platform (a parameter so it can be tested) */
export function assertSupportedPlatform(platform = process.platform) {
  if (SUPPORTED_PLATFORMS.includes(platform)) return;
  throw new OrchError(
    `orch supports Windows, Linux and macOS (this platform: ${platform}); this platform is not supported.`,
    'unsupported-platform',
  );
}
