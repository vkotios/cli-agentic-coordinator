// Runs one orch command in this process, exactly as the CLI and the MCP server do
// (`parseArgs` + `runCommand` from cli.mjs), and returns its parsed JSON answer. The Foreman
// and the GUI never re-implement a command; they call it through here.
import { parseArgs, runCommand } from '../cli.mjs';
import { OrchError } from '../errors.mjs';

/**
 * @param {string|null} stateRoot
 * @returns {(argv: string[]) => Promise<{ok: boolean, exitCode: number, out: any, text: string, error: string|null, code: string|null}>}
 */
export function makeCall(stateRoot) {
  return async function call(argv) {
    const lines = [];
    const io = { log: (s) => lines.push(String(s)) };
    try {
      const [cmd, ...rest] = argv;
      const args = parseArgs(rest);
      args.json = true;
      if (stateRoot && !args['state-root']) args['state-root'] = stateRoot;
      const value = await runCommand(cmd, args, io);
      const text = lines.join('\n');
      let out = null;
      try { out = JSON.parse(text); } catch { out = null; }
      const exitCode = value && typeof value.exitCode === 'number' ? value.exitCode : 0;
      return { ok: exitCode === 0, exitCode, out, text, error: null, code: null };
    } catch (error) {
      const code = error instanceof OrchError ? error.code || 'orch-error' : 'unexpected';
      return { ok: false, exitCode: 2, out: null, text: lines.join('\n'), error: String(error && error.message ? error.message : error), code };
    }
  };
}
