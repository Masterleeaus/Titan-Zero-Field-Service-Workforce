import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../tools/package.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'workforce-bootstrap-raw-'));
const sdkPath = join(scratch, 'compiled-sdk.mjs');
const packageDir = join(scratch, 'package');
const archiveDir = join(scratch, 'archive');
await mkdir(archiveDir, { recursive: true });
await readFile(join(pluginRoot, 'tools/package.mjs'));
await import('node:fs/promises').then(({ writeFile }) => writeFile(sdkPath,
  'export class DirectAdminCockpitSession {}\nexport const validateDirectAdminPluginPackage = () => ({valid:true});\nexport const assertPluginCanBeInstalled = () => true;\n'));
const packaged = await buildPackage({ sourceDir: pluginRoot, outputDir: archiveDir, sdkModulePath: sdkPath });
await mkdir(packageDir, { recursive: true });
execFileSync('tar', ['--same-permissions', '-xzf', packaged.archivePath, '-C', packageDir]);
await mkdir(join(packageDir, 'conf'), { mode: 0o700 });
const cleanup = () => rm(scratch, { recursive: true, force: true });

const origin = 'https://panel.example.test:2222';
const nonce = 'N'.repeat(43);
const csrf = 'C'.repeat(43);
const sessionCookie = '__Host-titan-da-session=a.b.c; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300';
const daCookie = 'session=synthetic+session; key=synthetic+key';
let mode = 'success';
let responseSessionCookie = sessionCookie;
const observations = [];
const upstream = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  observations.push({ method: request.method, path: request.url, host: request.headers.host,
    origin: request.headers.origin, fetchSite: request.headers['sec-fetch-site'], cookie: request.headers.cookie,
    auth: request.headers.authorization ?? null, csrf: request.headers['x-titan-da-bootstrap-csrf'] ?? null,
    headers: Object.keys(request.headers).sort(), bodyLength: body.length });
  const payload = request.url.endsWith('bootstrap-nonce') ? { csrf_nonce: nonce } : { csrf_token: csrf };
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...(request.url.endsWith('bootstrap') ? { 'set-cookie': responseSessionCookie } : {}) });
  if (mode === 'stall') return;
  if (mode === 'slow-drip') {
    response.write('{"csrf_nonce":"');
    const interval = setInterval(() => response.write('N'), 1000);
    response.once('close', () => clearInterval(interval));
    return;
  }
  if (mode === 'malformed') response.end(JSON.stringify({ ...payload, company_id: 'must-not-leak' }));
  else response.end(JSON.stringify(payload));
});
await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
const port = upstream.address().port;
const portConfig = join(scratch, 'workforce-private-port');
await writeFile(portConfig, `${port}\n`, { mode: 0o400 });
await chmod(portConfig, 0o400);

function headers(lines) { return encodeURIComponent(lines.join('\r\n')); }
function formHeaders(lines) { return headers(lines).replace(/%20/g, '+'); }
function env(action, overrides = {}) {
  const { cookieHeader = action === 'bootstrap' ? `${daCookie}; __Host-titan-da-session=a.b.c` : daCookie, ...environmentOverrides } = overrides;
  const base = {
    REQUEST_METHOD: 'POST',
    QUERY_STRING: 'headers_to_env=yes&pipe_post=yes',
    HEADERS: headers([
      'Host: panel.example.test:2222',
      `Origin: ${origin}`,
      'Sec-Fetch-Site: same-origin',
      `Cookie: ${cookieHeader}`,
      ...(action === 'bootstrap' ? [`X-Titan-DA-Bootstrap-CSRF: ${nonce}`] : []),
      'X-Caller-Company-ID: should-never-forward',
      'User-Agent: fixture',
    ]),
    POST: 'stdin=true',
    CONTENT_LENGTH: '0',
    ...environmentOverrides,
  };
  return base;
}

function run(binary, requestEnv, { keepInputOpen = false, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary], { env: { ...process.env, NODE_ENV: 'test',
      TITAN_WORKFORCE_DIRECTADMIN_RAW_TEST_CONFIG: portConfig, ...requestEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const errors = [];
    child.stdout.on('data', chunk => out.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', code => resolve({ code, raw: Buffer.concat(out), stderr: Buffer.concat(errors).toString('utf8') }));
    if (input) child.stdin.write(input);
    if (!keepInputOpen) child.stdin.end();
    else setTimeout(() => child.stdin.end(), 1500).unref();
  });
}

function parseRaw(raw) {
  const marker = raw.indexOf(Buffer.from('\r\n\r\n'));
  assert.notEqual(marker, -1, 'role RAW handler emits a complete protocol response');
  const lines = raw.subarray(0, marker).toString('latin1').split('\r\n');
  const status = Number(lines.shift().split(' ')[1]);
  const headers = new Map();
  for (const line of lines) {
    const offset = line.indexOf(':');
    if (offset < 1) continue;
    const name = line.slice(0, offset).toLowerCase();
    const values = headers.get(name) ?? [];
    values.push(line.slice(offset + 1).trim());
    headers.set(name, values);
  }
  const body = raw.subarray(marker + 4);
  assert.equal(Number(headers.get('content-length')?.[0]), body.length);
  return { status, headers, body: JSON.parse(body.toString('utf8')) };
}

test.after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await cleanup();
});

test('all packaged role RAW entrypoints perform the fixed loopback nonce and session routes', async () => {
  for (const role of ['admin', 'reseller', 'user']) {
    for (const action of ['bootstrap-nonce', 'bootstrap']) {
      const file = join(packageDir, role, `${action}.raw`);
      const stats = await import('node:fs/promises').then(({ stat }) => stat(file));
      assert.equal(stats.mode & 0o777, 0o755);
    }
  }
  const nonceFile = join(packageDir, 'user/bootstrap-nonce.raw');
  const issueRun = await run(nonceFile, env('nonce'));
  assert.equal(issueRun.stderr, '', 'role RAW handler does not log request cookies or nonce material');
  const issue = parseRaw(issueRun.raw);
  assert.equal(issue.status, 200);
  assert.deepEqual(issue.body, { csrf_nonce: nonce });
  assert.equal(issue.headers.has('set-cookie'), false);
  assert.deepEqual(observations.at(-1), {
    method: 'POST', path: '/v1/directadmin/bootstrap-nonce', host: 'panel.example.test:2222', origin,
    fetchSite: 'same-origin', cookie: daCookie, auth: null, csrf: null,
    headers: ['accept', 'connection', 'content-length', 'cookie', 'host', 'origin', 'sec-fetch-site'], bodyLength: 0,
  });

  const formLines = decodeURIComponent(env('nonce').HEADERS).split('\r\n');
  const formEnv = env('nonce', { HEADERS: formHeaders(formLines) });
  const formIssue = parseRaw((await run(nonceFile, formEnv)).raw);
  assert.equal(formIssue.status, 200, 'form-style URL encoding converts spaces to plus while preserving escaped literal plus signs');
  assert.deepEqual(formIssue.body, { csrf_nonce: nonce });
  assert.equal(observations.at(-1).cookie, daCookie);

  const bootstrapRun = await run(join(packageDir, 'admin/bootstrap.raw'), env('bootstrap'));
  assert.equal(bootstrapRun.stderr, '', 'role RAW handler does not log request cookies or nonce material');
  const bootstrap = parseRaw(bootstrapRun.raw);
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(bootstrap.body, { csrf_token: csrf });
  assert.deepEqual(bootstrap.headers.get('set-cookie'), [sessionCookie]);
  assert.equal(observations.at(-1).path, '/v1/directadmin/bootstrap');
  assert.equal(observations.at(-1).cookie, `${daCookie}; __Host-titan-da-session=a.b.c`);
  assert.equal(observations.at(-1).csrf, nonce);
  assert.equal(observations.at(-1).headers.includes('x-caller-company-id'), false);
  assert.equal(observations.at(-1).headers.includes('user-agent'), false);
});

test('browser cookie jar can renew the session across a second nonce/bootstrap cycle', async () => {
  const cookieJar = new Map([['session', 'synthetic+session'], ['key', 'synthetic+key']]);
  const cookieHeader = () => [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');
  const storeSetCookie = value => {
    const [pair] = value.split(';', 1);
    const offset = pair.indexOf('=');
    assert.ok(offset > 0, 'browser stores a well-formed Set-Cookie pair');
    cookieJar.set(pair.slice(0, offset), pair.slice(offset + 1));
  };

  const nonceFile = join(packageDir, 'user/bootstrap-nonce.raw');
  const bootstrapFile = join(packageDir, 'user/bootstrap.raw');
  const firstNonce = parseRaw((await run(nonceFile, env('nonce', { cookieHeader: cookieHeader() }))).raw);
  assert.equal(firstNonce.status, 200);
  const firstBootstrap = parseRaw((await run(bootstrapFile, env('bootstrap', {
    cookieHeader: cookieHeader(),
    HEADERS: headers(['Host: panel.example.test:2222', `Origin: ${origin}`, 'Sec-Fetch-Site: same-origin',
      `Cookie: ${cookieHeader()}`, `X-Titan-DA-Bootstrap-CSRF: ${firstNonce.body.csrf_nonce}`]),
  }))).raw);
  assert.equal(firstBootstrap.status, 200);
  storeSetCookie(firstBootstrap.headers.get('set-cookie')[0]);
  assert.equal(cookieJar.get('__Host-titan-da-session'), 'a.b.c');

  const secondNonce = parseRaw((await run(nonceFile, env('nonce', { cookieHeader: cookieHeader() }))).raw);
  assert.equal(secondNonce.status, 200, 'the browser automatically sends its HttpOnly Titan session cookie on the next nonce request');
  assert.equal(observations.at(-1).cookie, daCookie, 'nonce forwarding strips Titan session material before Workforce');

  const previous = responseSessionCookie;
  responseSessionCookie = '__Host-titan-da-session=d.e.f; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300';
  try {
    const renewal = parseRaw((await run(bootstrapFile, env('bootstrap', {
      cookieHeader: cookieHeader(),
      HEADERS: headers(['Host: panel.example.test:2222', `Origin: ${origin}`, 'Sec-Fetch-Site: same-origin',
        `Cookie: ${cookieHeader()}`, `X-Titan-DA-Bootstrap-CSRF: ${secondNonce.body.csrf_nonce}`]),
    }))).raw);
    assert.equal(renewal.status, 200);
    assert.equal(observations.at(-1).cookie, `${daCookie}; __Host-titan-da-session=a.b.c`,
      'bootstrap alone forwards the existing Titan session for renewal');
    storeSetCookie(renewal.headers.get('set-cookie')[0]);
    assert.equal(cookieJar.get('__Host-titan-da-session'), 'd.e.f', 'the browser replaces its old HttpOnly cookie with the renewed value');
  } finally {
    responseSessionCookie = previous;
  }
});

test('role RAW rejects malformed/duplicate headers, identity additions, foreign cookies, route flags and origins before loopback', async () => {
  const binary = join(packageDir, 'user/bootstrap-nonce.raw');
  const count = observations.length;
  const attacks = [
    env('nonce', { QUERY_STRING: 'headers_to_env=yes&pipe_post=yes&target=http://evil' }),
    env('nonce', { HEADERS: headers(['Host: panel.example.test:2222', `Origin: ${origin}`, 'Sec-Fetch-Site: cross-site', `Cookie: ${daCookie}`]) }),
    env('nonce', { HEADERS: headers(['Host: panel.example.test:2222', `Origin: ${origin}`, 'Sec-Fetch-Site: same-origin', `Cookie: ${daCookie}`, `Cookie: ${daCookie}`]) }),
    env('nonce', { HEADERS: headers(['Host: attacker.example', `Origin: ${origin}`, 'Sec-Fetch-Site: same-origin', `Cookie: ${daCookie}`]) }),
    env('nonce', { HEADERS: headers(['Host: panel.example.test:2222', 'Origin: https://attacker.example', 'Sec-Fetch-Site: same-origin', `Cookie: ${daCookie}`]) }),
    env('nonce', { HEADERS: headers(['Host: panel.example.test:2222', `Origin: ${origin}`, 'Sec-Fetch-Site: same-origin', `Cookie: ${daCookie}; analytics=private-value`]) }),
    env('nonce', { HEADERS: headers(['Host: panel.example.test:2222', `Origin: ${origin}`, 'Sec-Fetch-Site: same-origin', `Cookie: ${daCookie}; __Host-titan-da-session=a.b.c; __Host-titan-da-session=d.e.f`]) }),
    env('nonce', { HEADERS: headers(['Host: panel.example.test:2222', `Origin: ${origin}`, 'Sec-Fetch-Site: same-origin', `Cookie: ${daCookie}; __Host-titan-da-session=malformed`]) }),
    env('nonce', { HEADERS: headers(['Host: panel.example.test:2222', `Origin: ${origin}`, 'Sec-Fetch-Site: same-origin', `Cookie: ${daCookie}`, 'X-Titan-Company-ID: forged']) }),
    env('nonce', { HEADERS: '%zz' }),
    env('nonce', { REQUEST_METHOD: 'GET' }),
    env('nonce', { CONTENT_LENGTH: '1' }),
  ];
  for (const requestEnv of attacks) {
    const rawResult = await run(binary, requestEnv);
    assert.equal(rawResult.stderr, '', 'rejections do not log caller cookies or identity data');
    const result = parseRaw(rawResult.raw);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'invalid_request', read_only: true });
  }
  assert.equal(observations.length, count, 'invalid caller-controlled fields never reach the private Workforce listener');
});

test('RAW body timeout and malformed upstream fail closed without returning private data', async () => {
  const binary = join(packageDir, 'user/bootstrap-nonce.raw');
  const before = observations.length;
  const stalledInput = parseRaw((await run(binary, env('nonce'), { keepInputOpen: true })).raw);
  assert.equal(stalledInput.status, 400);
  assert.deepEqual(stalledInput.body, { error: 'invalid_request', read_only: true });
  assert.equal(observations.length, before);

  mode = 'malformed';
  const malformed = parseRaw((await run(binary, env('nonce'))).raw);
  assert.equal(malformed.status, 503);
  assert.deepEqual(malformed.body, { error: 'directadmin-bootstrap-unavailable', read_only: true });
  assert.equal(JSON.stringify(malformed.body).includes('company-a'), false);
  mode = 'stall';
  const started = Date.now();
  const timeoutResult = parseRaw((await run(binary, env('nonce'))).raw);
  assert.ok(Date.now() - started >= 6500, 'loopback upstream timeout is bounded near the configured deadline');
  assert.equal(timeoutResult.status, 503);
  assert.deepEqual(timeoutResult.body, { error: 'directadmin-bootstrap-unavailable', read_only: true });
  mode = 'slow-drip';
  const slowStarted = Date.now();
  const slowTimeout = parseRaw((await run(binary, env('nonce'))).raw);
  assert.ok(Date.now() - slowStarted >= 6500 && Date.now() - slowStarted < 9500,
    'an upstream that keeps sending partial data still hits the total request deadline');
  assert.equal(slowTimeout.status, 503);
  assert.deepEqual(slowTimeout.body, { error: 'directadmin-bootstrap-unavailable', read_only: true });
  mode = 'success';
});
