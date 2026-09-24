import opencode from './opencode.mjs';
import vibe from './vibe.mjs';
import codex from './codex.mjs';
import agy from './agy.mjs';
import fake from './fake.mjs';
import { OrchError } from '../errors.mjs';

export const ADAPTERS = { opencode, vibe, codex, agy, fake };

/** Adapters a real dispatch may name. `fake` exists only for the test suite. */
export const PUBLIC_ADAPTERS = ['opencode', 'vibe', 'codex', 'agy'];

export function getAdapter(name) {
  const a = ADAPTERS[name];
  if (!a) {
    throw new OrchError(`unknown --cli "${name}" (supported: ${PUBLIC_ADAPTERS.join(', ')})`, 'unknown-cli');
  }
  return a;
}
