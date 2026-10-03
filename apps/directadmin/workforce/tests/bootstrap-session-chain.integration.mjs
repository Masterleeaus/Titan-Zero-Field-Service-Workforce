import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { buildPackage } from '../tools/package.mjs';
import { fixture, ORIGIN, external } from '../../../../packages/titan-platform/tests/fixtures/directadmin-bridge-fixture.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const serviceRequire = createRequire(join(repo, 'services/workforce/package.json'));
const { tsImport } = await import(pathToFileURL(serviceRequire.resolve('tsx/esm/api')).href);
const scratch = await mkdtemp(join(tmpdir(), 'workforce-bootstrap-chain-'));
const sdkPath = join(scratch, 'compiled-sdk.mjs');
const archiveDir = join(scratch, 'archive');
const packageDir = join(scratch, 'plugin');
await mkdir(archiveDir, { recursive: true });
await writeFile(sdkPath,
  'export class DirectAdminCockpitSession {}\nexport const validateDirectAdminPluginPackage = () => ({valid:true});\nexport const assertPluginCanBeInstalled = () => true;\n');
const built = await buildPackage({ sourceDir: join(repo, 'apps/directadmin/workforce'), outputDir: archiveDir, sdkModulePath: sdkPath });
await mkdir(packageDir, { recursive: true });
execFileSync('tar', ['--same-permissions', '-xzf', built.archivePath, '-C', packageDir]);

const security = await tsImport(join(repo, 'packages/titan-platform/src/security-boundary.ts'), { parentURL: import.meta.url, tsconfig: false });
const sdk = await tsImport(join(repo, 'packages/titan-platform/src/directadmin-plugin.ts'), { parentURL: import.meta.url, tsconfig: false });
const nonceRoute = await tsImport(join(repo, 'services/workforce/src/directadmin-bootstrap-nonce-route.ts'), { parentURL: import.meta.url, tsconfig: false });
const { DirectAdminSessionBridge, createDirectAdminGateway } = sdk;
const { withDirectAdminBootstrapNonceRoute } = nonceRoute;

const DA_COOKIE = 'session=synthetic-session; key=synthetic-key';
const NONCE = /^[A-Za-z0-9_-]{43,128}$/;
let selectedIdentity = { effectiveRole: 'admin', effectiveUsername: external.subject, realUsername: 'operator-a' };
let handler;

async function provisionCleaningCompany(registry) {
  await registry.putExternalBinding({ provider: external.provider, subject: external.subject, binding_id: 'mapping-company-a',
    actor_id: 'actor-1', company_id: 'company-a', status: 'revoked' }, 1);
  await registry.putExternalBinding({ provider: external.provider, subject: external.subject, binding_id: 'mapping-company-b',
    actor_id: 'actor-1', company_id: 'company-b', status: 'revoked' }, 1);
  await registry.putActor({ actor_id: 'cleaning-owner-1', status: 'active' }, null);
  await registry.putCompany({ company_id: 'cleaning-company-1', status: 'active' }, null);
  await registry.putMembership({ actor_id: 'cleaning-owner-1', company_id: 'cleaning-company-1', role: 'owner', status: 'active' }, null);
  await registry.putDevice({ actor_id: 'cleaning-owner-1', device_id: 'cleaning-device-1', status: 'active' }, null);
  await registry.putExternalBinding({ provider: external.provider, subject: external.subject, binding_id: 'cleaning-binding-1',
    actor_id: 'cleaning-owner-1', company_id: 'cleaning-company-1', status: 'active' }, null);
}

const host = createServer(async (incoming, outgoing) => {
  try {
    const hostHeader = incoming.headers.host;
    if (hostHeader !== new URL(ORIGIN).host || incoming.headers.origin !== ORIGIN) {
      outgoing.writeHead(400, { 'content-type': 'application/json' });
      outgoing.end('{"error":"host-boundary-rejected"}');
      return;
    }
    const target = new URL(incoming.url ?? '/', ORIGIN);
    const headers = new Headers();
    for (const name of ['cookie', 'origin', 'sec-fetch-site', 'x-titan-da-bootstrap-csrf', 'authorization', 'x-titan-csrf', 'content-length', 'accept']) {
      const value = incoming.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const request = new Request(target, { method: incoming.method, headers,
      body: incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : Readable.toWeb(incoming),
      ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { duplex: 'half' }) });
    const result = await handler(request);
    const responseHeaders = Object.fromEntries(result.headers.entries());
    const setCookies = result.headers.getSetCookie?.() ?? [];
    if (setCookies.length === 1) responseHeaders['set-cookie'] = setCookies[0];
    outgoing.writeHead(result.status, responseHeaders);
    if (!result.body) { outgoing.end(); return; }
    Readable.fromWeb(result.body).pipe(outgoing);
  } catch {
    if (!outgoing.headersSent) { outgoing.writeHead(503, { 'content-type': 'application/json' }); outgoing.end('{"error":"host-failed"}'); }
    else outgoing.destroy();
  }
});
await new Promise((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve); });
const port = host.address().port;
const portConfig = join(scratch, 'workforce-private-port');
await writeFile(portConfig, `${port}\n`, { mode: 0o400 });

function parseRaw(raw) {
  const marker = raw.indexOf(Buffer.from('\r\n\r\n'));
  assert.notEqual(marker, -1, 'role RAW entrypoint emitted HTTP response');
  const lines = raw.subarray(0, marker).toString('latin1').split('\r\n');
  const status = Number(lines.shift().split(' ')[1]);
  const headers = new Map();
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).toLowerCase();
    const values = headers.get(key) ?? [];
    values.push(line.slice(separator + 1).trim());
    headers.set(key, values);
  }
  const body = raw.subarray(marker + 4);
  assert.equal(Number(headers.get('content-length')?.[0]), body.length);
  return { status, headers, body: JSON.parse(body.toString('utf8')) };
}

function cgi(action, { cookie = DA_COOKIE, nonce, origin = ORIGIN, host = new URL(ORIGIN).host,
  extraHeaders = [], query = 'headers_to_env=yes&pipe_post=yes', body = '' } = {}) {
  const lines = [`Host: ${host}`, `Origin: ${origin}`, 'Sec-Fetch-Site: same-origin', `Cookie: ${cookie}`,
    ...(nonce === undefined ? [] : [`X-Titan-DA-Bootstrap-CSRF: ${nonce}`]), ...extraHeaders];
  return { REQUEST_METHOD: 'POST', QUERY_STRING: query, HEADERS: encodeURIComponent(lines.join('\r\n')),
    POST: 'stdin=true', CONTENT_LENGTH: String(Buffer.byteLength(body)) };
}

function runRaw(action, options = {}) {
  const role = options.role ?? 'user';
  const binary = join(packageDir, role, `${action === 'nonce' ? 'bootstrap-nonce' : 'bootstrap'}.raw`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary], { env: { ...process.env, NODE_ENV: 'test',
      TITAN_WORKFORCE_DIRECTADMIN_RAW_TEST_CONFIG: portConfig, ...cgi(action, options) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const stderr = [];
    child.stdout.on('data', value => chunks.push(Buffer.from(value)));
    child.stderr.on('data', value => stderr.push(Buffer.from(value)));
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr: Buffer.concat(stderr).toString('utf8'), ...parseRaw(Buffer.concat(chunks)) }));
    child.stdin.end(options.body ?? '');
  });
}

function gatewayFor(f, sessions, flow, { substituteCompany } = {}) {
  const bridge = new DirectAdminSessionBridge({ origin: ORIGIN, audience: 'titan-directadmin:node-1', node_id: 'node-1', sessions });
  const provider = substituteCompany ? { provide: async proof => {
    const input = await flow.provide(proof);
    return { ...input, company_id: substituteCompany };
  } } : flow;
  const gateway = createDirectAdminGateway(bridge, f.owners, provider);
  return withDirectAdminBootstrapNonceRoute(gateway, { publicOrigin: ORIGIN, flow });
}

test('packaged RAW nonce to #302 assertion to #1049 session issuance preserves the selected tuple', async t => {
  const f = await fixture(t);
  await provisionCleaningCompany(f.registry);
  await security.initializeDirectAdminBootstrapNonceStore({ storage: f.storage, storage_role: 'GLOBAL_REGISTRY' });
  const upstream = { issuer: external.provider, audience: 'titan-login', key_id: 'upstream-1', algorithm: 'EdDSA',
    verification_key: f.upstreamKeys.publicKey };
  const issueInputs = [];
  const baseSessions = security.createSessionCredentialService({ issuer: f.policy.issuer, audience: f.policy.audience,
    key_id: f.policy.key_id, algorithm: 'EdDSA', verification_key: f.policy.verification_key,
    signing_key: f.policy.signing_key, registry: f.registry, lifetime_seconds: 300, upstream,
    directadmin: { node_id: 'node-1' }, now: () => new Date(f.now) });
  const sessions = { ...baseSessions, issue: async (assertion, expected) => {
    issueInputs.push(expected);
    return baseSessions.issue(assertion, expected);
  } };
  const flow = security.createDirectAdminBootstrapFlow({ origin: ORIGIN, registry: f.registry, node_id: 'node-1', upstream,
    signing_key: f.upstreamKeys.privateKey, now: () => new Date(f.now),
    fetcher: async (url, init) => {
      apiCalls.push({ url: String(url), cookie: init?.headers?.cookie, authorization: init?.headers?.authorization ?? null });
      assert.equal(String(url), `${ORIGIN}/api/session`);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      return new Response(JSON.stringify(selectedIdentity), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  handler = gatewayFor(f, sessions, flow);

  const apiCalls = [];
  const issuedNonce = await runRaw('nonce', { role: 'reseller' });
  assert.equal(issuedNonce.status, 200);
  assert.deepEqual(Object.keys(issuedNonce.body), ['csrf_nonce']);
  assert.match(issuedNonce.body.csrf_nonce, NONCE);
  assert.equal(issuedNonce.headers.has('set-cookie'), false);
  assert.deepEqual(apiCalls.at(-1), { url: `${ORIGIN}/api/session`, cookie: DA_COOKIE, authorization: null });

  const result = await runRaw('bootstrap', { role: 'admin', nonce: issuedNonce.body.csrf_nonce });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, { csrf_token: result.body.csrf_token });
  assert.match(result.body.csrf_token, NONCE);
  assert.equal(result.headers.get('set-cookie')?.length, 1, 'one HttpOnly session cookie survives the trusted RAW response');
  assert.match(result.headers.get('set-cookie')[0], /^__Host-titan-da-session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=[1-9]\d*$/);
  assert.deepEqual(issueInputs, [{ company_id: 'cleaning-company-1', device_id: 'cleaning-device-1' }]);
  const issuedCredential = result.headers.get('set-cookie')[0].split(';', 1)[0].slice('__Host-titan-da-session='.length);
  const authenticated = await baseSessions.authenticate(issuedCredential, { company_id: 'cleaning-company-1', device_id: 'cleaning-device-1' });
  assert.deepEqual({ company_id: authenticated.context.company_id, device_id: authenticated.context.device_id },
    { company_id: 'cleaning-company-1', device_id: 'cleaning-device-1' });

  // Exercise each packaged role route through the same #302 selection and
  // #1049 session issuer. Carry the browser's HttpOnly cookie across routes;
  // the selected company/device must remain the canonical tuple each time.
  const browserCookies = new Map([['session', 'synthetic-session'], ['key', 'synthetic-key']]);
  const initialTitanCookie = result.headers.get('set-cookie')[0].split(';', 1)[0];
  let previousTitanCookie = initialTitanCookie;
  browserCookies.set('__Host-titan-da-session', initialTitanCookie.slice(initialTitanCookie.indexOf('=') + 1));
  const cookieHeader = () => [...browserCookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const expectedTuple = { company_id: 'cleaning-company-1', device_id: 'cleaning-device-1' };
  for (const role of ['admin', 'reseller', 'user']) {
    const requestCookies = cookieHeader();
    const previousCredential = previousTitanCookie.slice('__Host-titan-da-session='.length);
    const previousSession = await baseSessions.authenticate(previousCredential, expectedTuple);
    const roleNonce = await runRaw('nonce', { role, cookie: requestCookies });
    assert.equal(roleNonce.status, 200, `${role} nonce route: ${JSON.stringify(roleNonce.body)}`);
    assert.equal(roleNonce.headers.has('set-cookie'), false);
    assert.deepEqual(apiCalls.at(-1), { url: `${ORIGIN}/api/session`, cookie: DA_COOKIE, authorization: null },
      `${role} nonce strips the Titan cookie before the canonical #302 lookup`);

    const roleBootstrap = await runRaw('bootstrap', { role, cookie: requestCookies, nonce: roleNonce.body.csrf_nonce });
    assert.equal(roleBootstrap.status, 200, `${role} bootstrap route: ${JSON.stringify(roleBootstrap.body)}`);
    const rotatedCookie = roleBootstrap.headers.get('set-cookie')?.[0];
    assert.match(rotatedCookie ?? '', /^__Host-titan-da-session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=[1-9]\d*$/,
      `${role} bootstrap returns only the canonical HttpOnly session cookie`);
    const nextTitanCookie = rotatedCookie.split(';', 1)[0];
    assert.notEqual(nextTitanCookie, previousTitanCookie, `${role} route rotates the browser session`);
    previousTitanCookie = nextTitanCookie;
    browserCookies.set('__Host-titan-da-session', nextTitanCookie.slice(nextTitanCookie.indexOf('=') + 1));
    const roleCredential = nextTitanCookie.slice('__Host-titan-da-session='.length);
    const roleSession = await baseSessions.authenticate(roleCredential, expectedTuple);
    assert.deepEqual({ company_id: roleSession.context.company_id, device_id: roleSession.context.device_id }, expectedTuple,
      `${role} route preserves the selected company/device tuple`);
    const revokedRow = await f.storage.query('SELECT revoked FROM titan_security_sessions WHERE session_id=$1',
      [previousSession.context.session_id]);
    assert.equal(revokedRow.rows[0]?.revoked, 1, `${role} repeat login revokes the superseded canonical session`);
    await assert.rejects(baseSessions.authenticate(previousCredential, expectedTuple), /authentication-denied/,
      `${role} repeat login rejects the superseded browser credential`);
  }
  assert.deepEqual(issueInputs, Array.from({ length: 4 }, () => expectedTuple),
    'each role route pair passes only the same canonical selected tuple to sessions.issue');

  const replay = await runRaw('bootstrap', { nonce: issuedNonce.body.csrf_nonce });
  assert.equal(replay.status, 401);
  assert.deepEqual(replay.body, { error: 'directadmin-session-rejected', read_only: true });
  assert.equal(replay.headers.has('set-cookie'), false);
  assert.equal(issueInputs.length, 4, 'replay never calls canonical sessions.issue');
});

test('nonce is bound to the authenticated DA operator and signed assertion tuple mismatches fail before cookie issuance', async t => {
  const f = await fixture(t);
  await provisionCleaningCompany(f.registry);
  await security.initializeDirectAdminBootstrapNonceStore({ storage: f.storage, storage_role: 'GLOBAL_REGISTRY' });
  const upstream = { issuer: external.provider, audience: 'titan-login', key_id: 'upstream-1', algorithm: 'EdDSA',
    verification_key: f.upstreamKeys.publicKey };
  const baseSessions = security.createSessionCredentialService({ issuer: f.policy.issuer, audience: f.policy.audience,
    key_id: f.policy.key_id, algorithm: 'EdDSA', verification_key: f.policy.verification_key,
    signing_key: f.policy.signing_key, registry: f.registry, lifetime_seconds: 300, upstream,
    directadmin: { node_id: 'node-1' }, now: () => new Date(f.now) });
  const calls = [];
  const sessions = { ...baseSessions, issue: async (assertion, expected) => {
    calls.push(expected);
    return baseSessions.issue(assertion, expected);
  } };
  const flow = security.createDirectAdminBootstrapFlow({ origin: ORIGIN, registry: f.registry, node_id: 'node-1', upstream,
    signing_key: f.upstreamKeys.privateKey, now: () => new Date(f.now),
    fetcher: async () => new Response(JSON.stringify(selectedIdentity), { status: 200, headers: { 'content-type': 'application/json' } }) });
  handler = gatewayFor(f, sessions, flow);
  const selected = await runRaw('nonce');
  assert.equal(selected.status, 200);
  selectedIdentity = { ...selectedIdentity, realUsername: 'operator-substitute' };
  const substituted = await runRaw('bootstrap', { nonce: selected.body.csrf_nonce });
  assert.equal(substituted.status, 401);
  assert.deepEqual(substituted.body, { error: 'directadmin-session-rejected', read_only: true });
  assert.equal(substituted.headers.has('set-cookie'), false);
  assert.equal(calls.length, 0, 'operator substitution is denied before session issuance');

  selectedIdentity = { effectiveRole: 'admin', effectiveUsername: external.subject, realUsername: 'operator-a' };
  const mismatchNonce = await runRaw('nonce');
  assert.equal(mismatchNonce.status, 200);
  handler = gatewayFor(f, sessions, flow, { substituteCompany: 'company-b' });
  const mismatch = await runRaw('bootstrap', { nonce: mismatchNonce.body.csrf_nonce });
  assert.equal(mismatch.status, 401);
  assert.deepEqual(mismatch.body, { error: 'directadmin-session-rejected', read_only: true });
  assert.equal(mismatch.headers.has('set-cookie'), false);
  assert.deepEqual(calls, [{ company_id: 'company-b', device_id: 'cleaning-device-1' }]);
});

test('RAW wrong Host, Origin, role identity headers and injected context do not reach #302', async t => {
  const f = await fixture(t);
  await provisionCleaningCompany(f.registry);
  await security.initializeDirectAdminBootstrapNonceStore({ storage: f.storage, storage_role: 'GLOBAL_REGISTRY' });
  const upstream = { issuer: external.provider, audience: 'titan-login', key_id: 'upstream-1', algorithm: 'EdDSA',
    verification_key: f.upstreamKeys.publicKey };
  let fetchCalls = 0;
  const flow = security.createDirectAdminBootstrapFlow({ origin: ORIGIN, registry: f.registry, node_id: 'node-1', upstream,
    signing_key: f.upstreamKeys.privateKey, now: () => new Date(f.now),
    fetcher: async () => { fetchCalls += 1; return new Response(JSON.stringify(selectedIdentity), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  const gateway = createDirectAdminGateway(new DirectAdminSessionBridge({ origin: ORIGIN, audience: 'titan-directadmin:node-1',
    node_id: 'node-1', sessions: security.createSessionCredentialService({ issuer: f.policy.issuer, audience: f.policy.audience,
      key_id: f.policy.key_id, algorithm: 'EdDSA', verification_key: f.policy.verification_key, signing_key: f.policy.signing_key,
      registry: f.registry, lifetime_seconds: 300, upstream, directadmin: { node_id: 'node-1' }, now: () => new Date(f.now) }) }), f.owners, flow);
  handler = withDirectAdminBootstrapNonceRoute(gateway, { publicOrigin: ORIGIN, flow });
  const badHost = await runRaw('nonce', { host: 'attacker.example' });
  const badOrigin = await runRaw('nonce', { origin: 'https://attacker.example' });
  const forged = await runRaw('nonce', { extraHeaders: ['X-DirectAdmin-Role: admin', 'X-Titan-Company-ID: company-a'] });
  assert.equal(badHost.status, 400);
  assert.equal(badOrigin.status, 400);
  assert.equal(forged.status, 400);
  assert.equal(fetchCalls, 0);
});

test.after(async () => {
  host.closeAllConnections();
  if (host.listening) await new Promise(resolve => host.close(resolve));
  await rm(scratch, { recursive: true, force: true });
});
