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
const DIRECTADMIN_ROLES = ['admin', 'reseller', 'user'];
let handler;

function hostSessionInfo(role) {
  return { effectiveRole: role, effectiveUsername: external.subject, realUsername: `operator-${role}` };
}

function bootstrapTrust(f) {
  // The DirectAdmin bootstrap contract mints the narrowly scoped titan-login
  // assertion consumed by the canonical session service.
  const upstream = { ...f.policy.upstream, audience: 'titan-login' };
  const sessions = security.createSessionCredentialService({ ...f.policy, upstream });
  return { upstream, sessions };
}

function flowFor(f, sessionInfo, apiCalls = []) {
  const { upstream } = bootstrapTrust(f);
  return security.createDirectAdminBootstrapFlow({ origin: ORIGIN, registry: f.registry, node_id: 'node-1',
    upstream, signing_key: f.upstreamKeys.privateKey, now: () => new Date(f.now),
    fetcher: async (url, init) => {
      const identity = typeof sessionInfo === 'function' ? sessionInfo() : sessionInfo;
      apiCalls.push({ url: String(url), method: init?.method, cookie: init?.headers?.cookie,
        authorization: init?.headers?.authorization ?? null, redirect: init?.redirect, cache: init?.cache,
        credentials: init?.credentials, identity });
      return new Response(JSON.stringify(identity), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
}

function contextRequest(credential, csrfToken) {
  return new Request(`${ORIGIN}/v1/directadmin/context`, { method: 'GET', headers: {
    origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-titan-csrf': csrfToken,
    cookie: `__Host-titan-da-session=${credential}`,
  } });
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

test('all packaged role RAW routes bind one canonical company and reject stale or revoked membership', async t => {
  const f = await fixture(t);
  await security.initializeDirectAdminBootstrapNonceStore({ storage: f.storage, storage_role: 'GLOBAL_REGISTRY' });
  const { sessions: canonicalSessions } = bootstrapTrust(f);
  const issueInputs = [];
  const sessions = { ...canonicalSessions, issue: async (assertion, expected) => {
    issueInputs.push(expected);
    return canonicalSessions.issue(assertion, expected);
  } };
  const apiCalls = [];
  const flowByRole = role => flowFor(f, () => hostSessionInfo(role), apiCalls);

  // The canonical fixture starts with active company-A and company-B bindings.
  // The first-session path must not guess which company to use from role/order.
  for (const role of DIRECTADMIN_ROLES) {
    handler = gatewayFor(f, sessions, flowByRole(role));
    const ambiguous = await runRaw('nonce', { role });
    assert.equal(ambiguous.status, 401, `${role} nonce route rejects ambiguous current company membership`);
    assert.deepEqual(ambiguous.body, { error: 'directadmin-session-rejected', read_only: true });
    assert.equal(ambiguous.headers.has('set-cookie'), false);
  }

  // Revoke only company B in #302's SQLite identity store. Company A is now the
  // one unique canonical context for the same authenticated external subject.
  await f.registry.putMembership({ actor_id: 'actor-1', company_id: 'company-b', role: 'member', status: 'revoked' }, 1);
  let companyARevision = 1;
  const setCompanyAMembership = async status => {
    companyARevision = await f.registry.putMembership({ actor_id: 'actor-1', company_id: 'company-a', role: 'member', status }, companyARevision);
  };

  for (const role of DIRECTADMIN_ROLES) {
    handler = gatewayFor(f, sessions, flowByRole(role));
    const staleNonce = await runRaw('nonce', { role });
    assert.equal(staleNonce.status, 200, `${role} route gets an opaque nonce for the unique canonical company`);
    assert.deepEqual(Object.keys(staleNonce.body), ['csrf_nonce'], 'company and device remain private in the canonical registry');
    assert.match(staleNonce.body.csrf_nonce, NONCE);
    assert.equal(staleNonce.headers.has('set-cookie'), false);

    const issueCount = issueInputs.length;
    await setCompanyAMembership('revoked');
    const staleBootstrap = await runRaw('bootstrap', { role, nonce: staleNonce.body.csrf_nonce });
    assert.equal(staleBootstrap.status, 401, `${role} bootstrap rejects membership revoked after nonce issuance`);
    assert.deepEqual(staleBootstrap.body, { error: 'directadmin-session-rejected', read_only: true });
    assert.equal(staleBootstrap.headers.has('set-cookie'), false);
    assert.equal(issueInputs.length, issueCount, 'stale membership never reaches canonical session issuance');
    await setCompanyAMembership('active');
    const restoredReplay = await runRaw('bootstrap', { role, nonce: staleNonce.body.csrf_nonce });
    assert.equal(restoredReplay.status, 401, `${role} nonce stays burned after the stale membership rejection`);
    assert.equal(restoredReplay.headers.has('set-cookie'), false);
    assert.equal(issueInputs.length, issueCount, 'restoring membership cannot revive a consumed nonce');

    const nonce = await runRaw('nonce', { role });
    assert.equal(nonce.status, 200);
    const result = await runRaw('bootstrap', { role, nonce: nonce.body.csrf_nonce });
    assert.equal(result.status, 200, `${role} RAW pair issues only after fresh registry validation: ${JSON.stringify(result.body)}`);
    assert.match(result.body.csrf_token, NONCE);
    assert.equal(result.headers.get('set-cookie')?.length, 1, 'one HttpOnly session cookie survives the trusted RAW response');
    assert.match(result.headers.get('set-cookie')[0], /^__Host-titan-da-session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=[1-9]\d*$/);
    assert.deepEqual(issueInputs.at(-1), { company_id: 'company-a', device_id: 'device-1' },
      'the selected tuple comes from the canonical identity store, not the role route or host projection');
    const issuedCredential = result.headers.get('set-cookie')[0].split(';', 1)[0].slice('__Host-titan-da-session='.length);
    const authenticated = await sessions.authenticate(issuedCredential, { company_id: 'company-a', device_id: 'device-1' });
    assert.deepEqual({ company_id: authenticated.context.company_id, device_id: authenticated.context.device_id,
      allowed_company_ids: authenticated.context.allowed_company_ids },
    { company_id: 'company-a', device_id: 'device-1', allowed_company_ids: ['company-a'] });
    await assert.rejects(() => sessions.authenticate(issuedCredential, { company_id: 'company-b', device_id: 'device-1' }),
      undefined, 'issued session is not portable to another company');

    const contextResponse = await handler(contextRequest(issuedCredential, result.body.csrf_token));
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json();
    assert.equal(context.company_id, 'company-a');
    assert.deepEqual(context.company_ids, ['company-a']);
    assert.equal(context.authority, 'not-carried', 'session identity does not imply Workforce authority');

    // A later membership revocation invalidates the existing #1049 credential
    // and prevents another nonce on each packaged role route.
    await setCompanyAMembership('revoked');
    const revokedContext = await handler(contextRequest(issuedCredential, result.body.csrf_token));
    assert.equal(revokedContext.status, 401, `${role} bridge revalidates membership on each context request`);
    const revokedNonce = await runRaw('nonce', { role });
    assert.equal(revokedNonce.status, 401, `${role} nonce route refuses a currently revoked membership`);
    await setCompanyAMembership('active');
  }

  for (const call of apiCalls) {
    assert.equal(call.url, `${ORIGIN}/api/session`);
    assert.equal(call.method, 'GET');
    assert.equal(call.cookie, DA_COOKIE, 'only DirectAdmin cookies reach the #302 session API');
    assert.equal(call.authorization, null);
    assert.equal(call.redirect, 'error');
    assert.equal(call.cache, 'no-store');
    assert.equal(call.credentials, 'omit');
    assert.equal(Object.hasOwn(call.identity, 'company_id'), false, 'the host session projection is not the company selector');
  }
  assert.equal(issueInputs.length, DIRECTADMIN_ROLES.length, 'only three fresh current contexts reach session issuance');
});

test('Admin, Reseller, and User packaged RAW renewal rotates one canonical browser session', async t => {
  const f = await fixture(t);
  await security.initializeDirectAdminBootstrapNonceStore({ storage: f.storage, storage_role: 'GLOBAL_REGISTRY' });
  // Start from one canonical company so the first login is unambiguous. This
  // uses the #302 registry fixture, not a plugin-selected company value.
  await f.registry.putMembership({ actor_id: 'actor-1', company_id: 'company-b', role: 'member', status: 'revoked' }, 1);

  const { sessions: canonicalSessions } = bootstrapTrust(f);
  const issueInputs = [];
  const sessions = { ...canonicalSessions, issue: async (assertion, expected) => {
    issueInputs.push(expected);
    return canonicalSessions.issue(assertion, expected);
  } };
  const apiCalls = [];
  handler = gatewayFor(f, sessions, flowFor(f, () => hostSessionInfo('user'), apiCalls));

  const cookies = new Map([['session', 'synthetic-session'], ['key', 'synthetic-key']]);
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  let previous = null;
  for (const role of DIRECTADMIN_ROLES) {
    const requestCookie = cookieHeader();
    const previousCredential = cookies.get('__Host-titan-da-session');
    const previousSession = previousCredential
      ? await canonicalSessions.authenticate(previousCredential, { company_id: 'company-a', device_id: 'device-1' })
      : null;
    const nonce = await runRaw('nonce', { role, cookie: requestCookie });
    assert.equal(nonce.status, 200, `${role} renewal nonce resolves only the canonical unique context`);
    assert.deepEqual(Object.keys(nonce.body), ['csrf_nonce']);
    assert.equal(nonce.headers.has('set-cookie'), false, 'nonce issuance never rotates or clears the session');

    const redeemed = await runRaw('bootstrap', { role, cookie: requestCookie, nonce: nonce.body.csrf_nonce });
    assert.equal(redeemed.status, 200, `${role} renewal redeems its nonce through the canonical bridge`);
    const setCookie = redeemed.headers.get('set-cookie')?.[0] ?? '';
    assert.match(setCookie, /^__Host-titan-da-session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=[1-9]\d*$/);
    const nextCredential = setCookie.split(';', 1)[0].slice('__Host-titan-da-session='.length);
    assert.notEqual(nextCredential, previousCredential, `${role} renewal rotates the opaque browser credential`);
    cookies.set('__Host-titan-da-session', nextCredential);
    const current = await canonicalSessions.authenticate(nextCredential, { company_id: 'company-a', device_id: 'device-1' });
    assert.deepEqual({ company_id: current.context.company_id, device_id: current.context.device_id },
      { company_id: 'company-a', device_id: 'device-1' });

    if (previousSession) {
      const revokedRow = await f.storage.query('SELECT revoked FROM titan_security_sessions WHERE session_id=$1',
        [previousSession.context.session_id]);
      assert.equal(revokedRow.rows[0]?.revoked, 1, `${role} renewal revokes the superseded canonical session`);
      await assert.rejects(canonicalSessions.authenticate(previousCredential, { company_id: 'company-a', device_id: 'device-1' }),
        /authentication-denied/, `${role} renewal cannot reuse the superseded credential`);
    }
    previous = nextCredential;
  }

  assert.equal(issueInputs.length, DIRECTADMIN_ROLES.length);
  assert.ok(issueInputs.every(value => value.company_id === 'company-a' && value.device_id === 'device-1'));
  assert.equal(apiCalls.length, DIRECTADMIN_ROLES.length * 2, 'each packaged nonce and redeem call reauthenticates DirectAdmin');
  for (const call of apiCalls) {
    assert.equal(call.url, `${ORIGIN}/api/session`);
    assert.equal(call.cookie, DA_COOKIE, 'the Titan HttpOnly cookie never reaches DirectAdmin /api/session');
    assert.equal(call.authorization, null);
    assert.equal(call.redirect, 'error');
    assert.equal(call.cache, 'no-store');
    assert.equal(call.credentials, 'omit');
  }
});

test('nonce is bound to the authenticated DA operator and signed assertion tuple mismatches fail before cookie issuance', async t => {
  const f = await fixture(t);
  await security.initializeDirectAdminBootstrapNonceStore({ storage: f.storage, storage_role: 'GLOBAL_REGISTRY' });
  await f.registry.putMembership({ actor_id: 'actor-1', company_id: 'company-b', role: 'member', status: 'revoked' }, 1);
  const { sessions: canonicalSessions } = bootstrapTrust(f);
  const calls = [];
  const sessions = { ...canonicalSessions, issue: async (assertion, expected) => {
    calls.push(expected);
    return canonicalSessions.issue(assertion, expected);
  } };
  let selectedIdentity = hostSessionInfo('admin');
  const flow = flowFor(f, () => selectedIdentity);
  handler = gatewayFor(f, sessions, flow);
  const selected = await runRaw('nonce', { role: 'admin' });
  assert.equal(selected.status, 200);
  selectedIdentity = { ...selectedIdentity, realUsername: 'operator-substitute' };
  const substituted = await runRaw('bootstrap', { role: 'admin', nonce: selected.body.csrf_nonce });
  assert.equal(substituted.status, 401);
  assert.deepEqual(substituted.body, { error: 'directadmin-session-rejected', read_only: true });
  assert.equal(substituted.headers.has('set-cookie'), false);
  assert.equal(calls.length, 0, 'operator substitution is denied before session issuance');

  selectedIdentity = hostSessionInfo('admin');
  const roleNonce = await runRaw('nonce', { role: 'admin' });
  assert.equal(roleNonce.status, 200);
  selectedIdentity = { ...selectedIdentity, effectiveRole: 'reseller' };
  const roleChanged = await runRaw('bootstrap', { role: 'admin', nonce: roleNonce.body.csrf_nonce });
  assert.equal(roleChanged.status, 401, 'changing the authenticated DA role invalidates the issued nonce');
  assert.deepEqual(roleChanged.body, { error: 'directadmin-session-rejected', read_only: true });
  assert.equal(roleChanged.headers.has('set-cookie'), false);
  assert.equal(calls.length, 0, 'role substitution is denied before session issuance');

  selectedIdentity = hostSessionInfo('admin');
  const mismatchNonce = await runRaw('nonce', { role: 'admin' });
  assert.equal(mismatchNonce.status, 200);
  handler = gatewayFor(f, sessions, flow, { substituteCompany: 'company-b' });
  const mismatch = await runRaw('bootstrap', { role: 'admin', nonce: mismatchNonce.body.csrf_nonce });
  assert.equal(mismatch.status, 401);
  assert.deepEqual(mismatch.body, { error: 'directadmin-session-rejected', read_only: true });
  assert.equal(mismatch.headers.has('set-cookie'), false);
  assert.deepEqual(calls, [{ company_id: 'company-b', device_id: 'device-1' }]);
});

test('RAW wrong Host, Origin, role identity headers and injected context do not reach #302', async t => {
  const f = await fixture(t);
  await security.initializeDirectAdminBootstrapNonceStore({ storage: f.storage, storage_role: 'GLOBAL_REGISTRY' });
  const { sessions } = bootstrapTrust(f);
  let fetchCalls = 0;
  const flow = flowFor(f, hostSessionInfo('admin'), { push(value) { fetchCalls += 1; return value; } });
  const gateway = createDirectAdminGateway(new DirectAdminSessionBridge({ origin: ORIGIN, audience: 'titan-directadmin:node-1',
    node_id: 'node-1', sessions }), f.owners, flow);
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
