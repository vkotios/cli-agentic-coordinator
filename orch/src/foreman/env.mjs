// Worker-written code runs inside acceptance commands (that is what a test is), so the process
// gets a reduced environment: no API keys, no gateway keys, nothing the Foreman itself holds.
const SAFE_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'LANG', 'LC_ALL', 'TZ', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'CI']);

// A setup command (`npm ci`, `pip install`, `uv sync`) also needs to reach a package index and trust its certificates.
// These are the settings that say where and how, never a credential: a token a private registry needs belongs in the
// tool's own config file (a user-level .npmrc, pip.conf), which the process can read through HOME / APPDATA.
const SETUP_EXACT = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']);
const SETUP_PREFIXES = ['NPM_CONFIG_', 'PIP_', 'UV_', 'PNPM_', 'YARN_'];
// Variable names that would carry a secret even under an allowed prefix.
const SECRETISH = /(TOKEN|SECRET|PASSWORD|PASSWD|AUTH|API_?KEY|_KEY$|CREDENTIAL)/i;

/** The acceptance environment plus package-manager settings, for a project's setup command. */
export function setupEnv(env = process.env) {
  const out = safeEnv(env);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (SECRETISH.test(upper)) continue;
    if (SETUP_EXACT.has(upper) || SETUP_PREFIXES.some((p) => upper.startsWith(p))) out[key] = value;
  }
  return out;
}

export function safeEnv(env = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (SAFE_ENV.has(key.toUpperCase()) || key.toUpperCase().startsWith('LC_'))) out[key] = value;
  }
  return out;
}

