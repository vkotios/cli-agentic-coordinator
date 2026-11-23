// Worker-written code runs inside acceptance commands (that is what a test is), so the process
// gets a reduced environment: no API keys, no gateway keys, nothing the Foreman itself holds.
const SAFE_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'LANG', 'LC_ALL', 'TZ', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'CI']);

export function safeEnv(env = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (SAFE_ENV.has(key.toUpperCase()) || key.toUpperCase().startsWith('LC_'))) out[key] = value;
  }
  return out;
}

