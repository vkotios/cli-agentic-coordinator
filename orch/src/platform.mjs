// orch supports Windows and Linux. Platform-specific supervision details live in the
// lane-pipe, process-table, executable-resolver and viewer adapters.
import { OrchError } from './errors.mjs';

export const SUPPORTED_PLATFORMS = ['win32', 'linux'];

/** @param {string} [platform] defaults to process.platform (a parameter so it can be tested) */
export function assertSupportedPlatform(platform = process.platform) {
  if (SUPPORTED_PLATFORMS.includes(platform)) return;
  throw new OrchError(
    `orch supports Windows and Linux (this platform: ${platform}); macOS and other platforms are not supported yet.`,
    'unsupported-platform',
  );
}
