// Public-release portability: platform guard, configuration precedence, the user-created
// roster, run-time CLI discovery, requires_permission, the review-root default and the
// gateway benchmark tool. Nothing here needs a real worker CLI or a real gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { KIT, ORCH_BIN, TEST_ROSTER, makeCase, orch } from './helpers.mjs';
import { assertSupportedPlatform } from '../src/platform.mjs';
import { setting, resolveStateRoot, userConfig, KIT_ROOT } from '../src/config.mjs';
import { laneHome, DEFAULT_LANE_HOME } from '../src/lanescope.mjs';
import { loadRoster, rosterPath, assertModelPermitted, ROSTER_EXAMPLE_FILE, ROSTER_FILE } from '../src/models.mjs';
import { computePick } from '../src/ledger.mjs';
import { PUBLIC_ADAPTERS } from '../src/adapters/index.mjs';
import { resolveOpencodeExe } from '../src/adapters/opencode.mjs';
import { resolveCliExe } from '../src/exe.mjs';
import { defaultReviewRoot, resolveReviewRoot, assertNeutralRoot } from '../src/review.mjs';
import { parseBenchArgs, runBench, rosterLines, summaryTable } from '../tools/bench-gateway.mjs';

const FAKE_PLATFORM = path.join(KIT, 'test', 'fixtures', 'fake-platform.mjs');
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

/** Run `fn` with some environment variables set (undefined = deleted), then restore them. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function tmpDir(t, name) {
  // long form: the temp dir can be an 8.3 short path (CI runners), resolvers return the long one
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `orch-portable-${name}-`)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true })); // only what this test created
  return d;
}

function runNode(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env, encoding: 'utf8', windowsHide: true, timeout: 60000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

/* ------------------------------------------------------------ platform -- */

test('P1: the platform guard refuses every non-Windows platform with a clear message', () => {
  assert.doesNotThrow(() => assertSupportedPlatform('win32'));
  for (const p of ['linux', 'darwin', 'freebsd']) {
    assert.throws(() => assertSupportedPlatform(p), (/** @type {any} */ e) => e.code === 'unsupported-platform' && /Windows only for now/.test(e.message) && e.message.includes(p));
  }
});

test('P1: on a simulated non-win32 platform, orch --help / adopt / mcp stop before doing anything (exit 2)', { timeout: 120000 }, async () => {
  const pre = pathToFileURL(FAKE_PLATFORM).href;
  for (const [platform, args] of /** @type {[string, string[]][]} */ ([['linux', ['--help']], ['darwin', ['adopt', '--repo', '.', '--dry-run']], ['linux', ['mcp']], ['darwin', ['status', '--all']]])) {
    const r = await runNode(['--import', pre, ORCH_BIN, ...args], { ...process.env, ORCH_FAKE_PLATFORM: platform });
    assert.equal(r.code, 2, `${platform} ${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /Windows only for now/);
    assert.ok(r.stderr.includes(`this platform: ${platform}`), r.stderr);
    assert.equal(r.stdout, '', 'nothing is printed on stdout');
  }
  // and on this (Windows) machine the same entry point works
  const ok = await runNode([ORCH_BIN, '--help'], process.env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /orch run --cli/);
});

/* -------------------------------------------------------- configuration -- */

test('P2: settings resolve flag > environment > orch.config.json > default; config paths are relative to the file', async (t) => {
  const d = tmpDir(t, 'config');
  const file = path.join(d, 'orch.config.json');
  fs.writeFileSync(file, JSON.stringify({ stateRoot: 'st', laneRoot: 'ln', reviewRoot: 'rv', roster: 'my-roster.json', exe: { codex: 'bin/codex.exe' }, gatewayUrl: 'http://10.0.0.2:8080/v1' }));
  await withEnv({ ORCH_CONFIG: file, ORCH_STATE_ROOT: undefined, ORCH_LANE_HOME: undefined, ORCH_REVIEW_ROOT: undefined, ORCH_ROSTER: undefined, ORCH_CODEX_EXE: undefined, ORCH_GATEWAY_URL: undefined }, async () => {
    assert.equal(userConfig().file, file);
    assert.equal(resolveStateRoot(), path.join(d, 'st'), 'config');
    assert.equal(resolveStateRoot(path.join(d, 'flag')), path.join(d, 'flag'), 'flag wins');
    assert.equal(laneHome(), path.join(d, 'ln'));
    assert.equal(resolveReviewRoot(), path.join(d, 'rv'));
    assert.equal(resolveReviewRoot(path.join(d, 'x')), path.join(d, 'x'));
    assert.equal(rosterPath(), path.join(d, 'my-roster.json'));
    assert.equal(setting('ORCH_CODEX_EXE', 'exe.codex', null, { isPath: true }), path.join(d, 'bin', 'codex.exe'));
    assert.equal(setting('ORCH_GATEWAY_URL', 'gatewayUrl', ''), 'http://10.0.0.2:8080/v1');
    await withEnv({ ORCH_STATE_ROOT: path.join(d, 'env-st'), ORCH_LANE_HOME: path.join(d, 'env-ln'), ORCH_REVIEW_ROOT: path.join(d, 'env-rv'), ORCH_GATEWAY_URL: 'http://10.0.0.3:9/v1' }, async () => {
      assert.equal(resolveStateRoot(), path.join(d, 'env-st'), 'environment beats the config file');
      assert.equal(laneHome(), path.join(d, 'env-ln'));
      assert.equal(resolveReviewRoot(), path.join(d, 'env-rv'));
      assert.equal(setting('ORCH_GATEWAY_URL', 'gatewayUrl', ''), 'http://10.0.0.3:9/v1');
    });
  });
  // defaults (the suite's empty config file): kit-relative / per-user, never a fixed drive path
  await withEnv({ ORCH_STATE_ROOT: undefined, ORCH_LANE_HOME: undefined, ORCH_REVIEW_ROOT: undefined }, async () => {
    assert.equal(resolveStateRoot(), path.join(KIT_ROOT, '.state'));
    assert.equal(laneHome(), DEFAULT_LANE_HOME);
    assert.equal(resolveReviewRoot(), defaultReviewRoot());
  });
});

test('P2: a bad config file is an error, never silently ignored', async (t) => {
  const d = tmpDir(t, 'badconfig');
  const bad = path.join(d, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  await withEnv({ ORCH_CONFIG: bad, ORCH_STATE_ROOT: undefined }, () => {
    assert.throws(() => resolveStateRoot(), (/** @type {any} */ e) => e.code === 'bad-config' && /not valid JSON/.test(e.message));
  });
  await withEnv({ ORCH_CONFIG: path.join(d, 'missing.json'), ORCH_STATE_ROOT: undefined }, () => {
    assert.throws(() => resolveStateRoot(), (/** @type {any} */ e) => e.code === 'bad-config' && /cannot read/.test(e.message));
  });
  const arr = path.join(d, 'array.json');
  fs.writeFileSync(arr, '[1]');
  await withEnv({ ORCH_CONFIG: arr, ORCH_STATE_ROOT: undefined }, () => {
    assert.throws(() => resolveStateRoot(), /must hold a JSON object/);
  });
  const typed = path.join(d, 'typed.json');
  fs.writeFileSync(typed, JSON.stringify({ stateRoot: 5 }));
  await withEnv({ ORCH_CONFIG: typed, ORCH_STATE_ROOT: undefined }, () => {
    assert.throws(() => resolveStateRoot(), /"stateRoot" must be a string/);
  });
});

test('P2: the default review root is per-user and neutral (not temp, not a repo)', async () => {
  const root = defaultReviewRoot();
  assert.ok(root.toLowerCase().startsWith(path.resolve(process.env.LOCALAPPDATA || '').toLowerCase()) || !process.env.LOCALAPPDATA, root);
  assert.match(root, /cli-agentic-coordinator[\\/]reviews$/);
  assert.doesNotThrow(() => assertNeutralRoot(root, [KIT]));
  await withEnv({ LOCALAPPDATA: undefined }, () => {
    assert.equal(defaultReviewRoot(), path.join(os.userInfo().homedir, 'AppData', 'Local', 'cli-agentic-coordinator', 'reviews'));
  });
});

/* -------------------------------------------------------------- roster -- */

test('P3: a missing roster is a clear error telling the user to create it, from the API and from `orch pick`', async (t) => {
  const d = tmpDir(t, 'roster');
  const missing = path.join(d, 'roster.json');
  assert.throws(() => loadRoster(missing), (/** @type {any} */ e) => e.code === 'no-roster' && e.message.includes(missing) && e.message.includes('roster.example.json') && /docs\/MODELS\.md/.test(e.message));
  const c = makeCase('p3-pick');
  t.after(() => c.cleanup());
  const r = await orch(['pick', '--workload', 'implement', '--size', 'XS'], { ...c.env, ORCH_ROSTER: missing });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /no roster at .*copy .*roster\.example\.json/);
  // the shipped default location is orch/roster.json, which is git-ignored
  assert.equal(ROSTER_FILE, path.join(KIT, 'roster.json'));
  const ignore = fs.readFileSync(path.join(KIT, '..', '.gitignore'), 'utf8');
  assert.match(ignore, /^orch\/roster\.json$/m);
  assert.match(ignore, /^orch\.config\.json$/m);
});

test('P3: the example roster is generic, complete and usable by pick', () => {
  const { models } = loadRoster(ROSTER_EXAMPLE_FILE);
  assert.ok(models.length >= 5);
  for (const m of models) {
    assert.ok(PUBLIC_ADAPTERS.includes(m.cli), `${m.model}: cli ${m.cli}`);
    assert.ok(/example/.test(m.model), `${m.model}: example ids only`);
    assert.ok(['local', 'cloud'].includes(m.lane));
    assert.ok(Array.isArray(m.workloads));
    for (const w of m.workloads) assert.ok(['implement', 'review'].includes(w));
  }
  assert.ok(models.some((m) => m.requires_permission === true), 'shows the requires_permission rule');
  assert.ok(models.some((m) => m.workloads.length === 0), 'shows a listed-but-never-proposed model');
  const p = computePick({ roster: models, rows: [], workload: 'implement', size: 'XS' });
  assert.ok(p.pick);
  const big = computePick({ roster: models, rows: [], workload: 'implement', size: 'M' });
  assert.equal(big.pick.lane, 'cloud', 'local models only for XS/S');
  assert.ok(big.excluded.some((e) => /permission/.test(e.why)));
});

test('P3: requires_permission comes from the roster, for every CLI; no roster blocks nothing', async (t) => {
  // the suite roster marks gpt-6-astra
  assert.throws(() => assertModelPermitted('openai/GPT-6-astra', false), (/** @type {any} */ e) => e.code === 'model-needs-permission' && e.message.includes(TEST_ROSTER));
  assert.doesNotThrow(() => assertModelPermitted('gpt-6-astra', true));
  assert.doesNotThrow(() => assertModelPermitted('gpt-5.6-terra', false));
  const d = tmpDir(t, 'perm');
  await withEnv({ ORCH_ROSTER: path.join(d, 'none.json') }, () => {
    assert.doesNotThrow(() => assertModelPermitted('gpt-6-astra', false), 'without a roster nothing is marked');
  });
  // through `orch run` with the test-only fake worker: refused before anything exists
  const c = makeCase('p3-perm');
  t.after(() => c.cleanup());
  const r = await orch(['run', '--cli', 'fake', '--model', 'gpt-6-astra', '--dir', c.work, '--handoff', c.handoffPath, '--no-window'], c.env);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /owner's permission/);
  assert.equal(fs.existsSync(path.join(c.stateRoot, 'runs')) ? fs.readdirSync(path.join(c.stateRoot, 'runs')).length : 0, 0, 'no run record');
});

/* ------------------------------------------------------- CLI discovery -- */

test('P4: opencode.exe is found behind the npm shim on PATH and in the npm prefix, never as the .cmd shim', async (t) => {
  const d = tmpDir(t, 'exe');
  const prefix = path.join(d, 'npm prefix');
  const real = path.join(prefix, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '');
  fs.writeFileSync(path.join(prefix, 'opencode.cmd'), '@echo off\r\n');
  const empty = path.join(d, 'empty appdata');
  fs.mkdirSync(empty);
  await withEnv({ ORCH_OPENCODE_EXE: undefined }, () => {
    // 1. the shim's directory on PATH is the prefix
    const viaPath = /** @type {NodeJS.ProcessEnv} */ ({ ...process.env, PATH: `${prefix};${SYSTEM32}`, APPDATA: empty });
    delete viaPath.npm_config_prefix;
    assert.equal(resolveOpencodeExe(viaPath), real);
    // 2. npm_config_prefix, nothing on PATH
    const viaPrefix = /** @type {NodeJS.ProcessEnv} */ ({ ...process.env, PATH: SYSTEM32, APPDATA: empty, npm_config_prefix: prefix });
    assert.equal(resolveOpencodeExe(viaPrefix), real);
    // 3. the CURRENT user's %APPDATA%\npm
    const appData = path.join(d, 'appdata');
    const real2 = path.join(appData, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    fs.mkdirSync(path.dirname(real2), { recursive: true });
    fs.writeFileSync(real2, '');
    const viaAppData = /** @type {NodeJS.ProcessEnv} */ ({ ...process.env, PATH: SYSTEM32, APPDATA: appData });
    delete viaAppData.npm_config_prefix;
    assert.equal(resolveOpencodeExe(viaAppData), real2);
    // 4. not installed: a clear error naming the override
    const none = /** @type {NodeJS.ProcessEnv} */ ({ ...process.env, PATH: SYSTEM32, APPDATA: empty });
    delete none.npm_config_prefix;
    assert.throws(() => resolveOpencodeExe(none), (/** @type {any} */ e) => e.code === 'cli-not-found' && /ORCH_OPENCODE_EXE/.test(e.message) && /not installed/.test(e.message) && /shim is deliberately not accepted/.test(e.message));
  });
  // an explicit override always wins and is not second-guessed
  await withEnv({ ORCH_OPENCODE_EXE: path.join(d, 'custom', 'opencode.exe') }, () => {
    assert.equal(resolveOpencodeExe({ ...process.env, PATH: SYSTEM32 }), path.join(d, 'custom', 'opencode.exe'));
  });
});

test('P4: codex / agy / vibe are found on PATH at run time; a missing CLI is a clear error', async (t) => {
  const d = tmpDir(t, 'exe2');
  const bin = path.join(d, 'bin dir');
  fs.mkdirSync(bin);
  for (const n of ['codex', 'agy', 'vibe']) fs.writeFileSync(path.join(bin, `${n}.exe`), '');
  await withEnv({ ORCH_CODEX_EXE: undefined, ORCH_AGY_EXE: undefined, ORCH_VIBE_EXE: undefined }, () => {
    for (const n of ['codex', 'agy', 'vibe']) {
      assert.equal(resolveCliExe(n, { env: { ...process.env, PATH: `${bin};${SYSTEM32}` } }).toLowerCase(), path.join(bin, `${n}.exe`).toLowerCase());
      assert.throws(() => resolveCliExe(n, { env: { ...process.env, PATH: SYSTEM32, USERPROFILE: d }, fallbacks: n === 'vibe' ? (e) => [path.join(e.USERPROFILE, '.local', 'bin', 'vibe.exe')] : undefined }), (/** @type {any} */ e) => e.code === 'cli-not-found' && e.message.includes(`ORCH_${n.toUpperCase()}_EXE`));
    }
  });
});

/* ----------------------------------------------------------- benchmark -- */

test('P5: bench-gateway needs a gateway URL and a model list - there is no default', async () => {
  await withEnv({ ORCH_GATEWAY_URL: undefined }, () => {
    assert.throws(() => parseBenchArgs(['--models', 'a']), /gateway URL is required/);
    assert.throws(() => parseBenchArgs(['--gateway', 'http://10.0.0.2:8080/v1']), /model list is required/);
    assert.throws(() => parseBenchArgs(['--gateway', '10.0.0.2:8080', '--models', 'a']), /http\(s\) URL/);
    assert.throws(() => parseBenchArgs(['--gateway', 'http://h/v1', '--models', 'a', '--bogus', '1']), /unknown option/);
    const o = parseBenchArgs(['--gateway', 'http://h:1/v1/', '--models', 'a, b,,', '--max-tokens', '50']);
    assert.equal(o.gateway, 'http://h:1/v1');
    assert.deepEqual(o.models, ['a', 'b']);
    assert.equal(o.maxTokens, 50);
  });
  await withEnv({ ORCH_GATEWAY_URL: 'http://10.0.0.9:1/v1' }, () => {
    assert.equal(parseBenchArgs(['--models', 'a']).gateway, 'http://10.0.0.9:1/v1');
  });
  const r = await runNode([path.join(KIT, 'tools', 'bench-gateway.mjs')], { ...process.env, ORCH_GATEWAY_URL: '' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /gateway URL is required/);
});

test('P5: bench-gateway runs models one at a time against a local fake gateway and prints roster lines', { timeout: 60000 }, async (t) => {
  const d = tmpDir(t, 'bench');
  let inFlight = 0;
  let maxInFlight = 0;
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const j = JSON.parse(body);
      seen.push(j.model);
      setTimeout(() => {
        inFlight--;
        if (j.model === 'broken') {
          res.writeHead(404, { 'content-type': 'application/json', connection: 'close' });
          res.end(JSON.stringify({ error: { message: 'model not found' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 }, timings: { predicted_per_second: 42.42, prompt_per_second: 100 } }));
      }, 20);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  // The global fetch (undici) keeps internal handles alive after the test; with
  // --test-force-exit the process then exits while they are closing and libuv aborts on
  // Windows (`UV_HANDLE_CLOSING`, src\win\async.c) - measured: P5 alone + force-exit failed
  // 20/20 once connections were forced closed, and intermittently before. The test therefore
  // drives runBench through a minimal node:http client (no pool, no undici) and awaits a full
  // server close.
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(() => r(undefined)));
  });
  const port = /** @type {any} */ (server.address()).port;
  const out = path.join(d, 'results.json');
  const logs = [];
  /** fetch-compatible subset (status, ok, json) over node:http, one connection per request */
  const fetchNoKeepAlive = (url, init) =>
    new Promise((resolve, reject) => {
      const req = http.request(url, { method: init.method, headers: init.headers, agent: false, signal: init.signal }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json: async () => JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end(init.body);
    });
  const results = await runBench({ gateway: `http://127.0.0.1:${port}/v1`, models: ['m-one', 'broken'], out, maxTokens: 10, timeoutS: 10, log: (s) => logs.push(s), fetchImpl: fetchNoKeepAlive });
  assert.equal(maxInFlight, 1, 'never two requests at once');
  assert.deepEqual(seen, ['m-one', 'm-one', 'broken', 'broken'], 'cold then warm, model by model');
  assert.equal(results[0].warm.gen_tps, 42.4);
  assert.equal(results[1].warm.error, 'model not found');
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).length, 2);
  const lines = rosterLines(results);
  assert.equal(lines.length, 1, 'only models that answered');
  const entry = JSON.parse(lines[0]);
  assert.deepEqual([entry.cli, entry.model, entry.lane, entry.workloads], ['opencode', 'localai/m-one', 'local', []]);
  assert.match(summaryTable(results), /\| m-one \|/);
  assert.equal(logs.length, 2);
});
