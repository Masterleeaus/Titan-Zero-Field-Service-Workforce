import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { buildPackage, packageFiles } from '../tools/package.mjs';
import { workforceContribution, verifiedOutcome } from '../images/presentation.mjs';
import { WorkforceApi } from '../images/api.mjs';

// Explicit published canonical SDK build, not an emulated identity or transport.
assert.ok(process.env.TITAN_COCKPIT_SDK_MODULE, 'TITAN_COCKPIT_SDK_MODULE must reference the compiled canonical SDK');
const sdkPath = resolve(process.env.TITAN_COCKPIT_SDK_MODULE);
const SDK = await import(pathToFileURL(sdkPath));
const controllerSource = (await readFile(new URL('../images/controller.mjs', import.meta.url), 'utf8'))
  .replace("'workforce-presentation'", JSON.stringify(new URL('../images/presentation.mjs', import.meta.url).href));
const { WorkforceController } = await import(`data:text/javascript;base64,${Buffer.from(controllerSource).toString('base64')}`);
test('real package satisfies the canonical shared SDK archive contract', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'workforce-sdk-integration-'));
  try {
    const result = await buildPackage({ outputDir, sdkModulePath: sdkPath });
    const manifest = await readFile(new URL('../plugin.conf', import.meta.url), 'utf8');
    const version = manifest.match(/^version=(\d+\.\d+\.\d+)$/m)?.[1];
    assert.ok(version, 'plugin manifest declares a semantic version');
    const validation = SDK.validateDirectAdminPluginPackage({
      plugin_id: 'titan_workforce', version, archive_filename: 'titan_workforce.tar.gz', manifest_content: manifest,
      files: packageFiles, executable_files: packageFiles.filter(file => /^(admin|reseller|user)\//.test(file) || file.startsWith('scripts/')),
      role_entrypoints: { admin: 'admin/index.html', reseller: 'reseller/index.html', user: 'user/index.html' },
      hooks: ['hooks/admin_txt.html', 'hooks/reseller_txt.html', 'hooks/user_txt.html'],
    });
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    assert.equal(SDK.assertPluginCanBeInstalled(validation), true);
    assert.ok(result.sha256.length === 64);
  } finally { await rm(outputDir, { recursive: true, force: true }); }
});
test('canonical SDK accepts authority-neutral Workforce contribution for all roles', () => {
  for (const role of ['admin', 'reseller', 'user']) {
    const registry = new SDK.DirectAdminContributionRegistry();
    registry.register(workforceContribution({ phase: 'denied' }, role));
    assert.equal(registry.snapshot().contributions.length, 1);
    assert.deepEqual(registry.snapshot().degraded_plugins, {});
    assert.deepEqual(registry.snapshot().contributions[0].widgets[0].permitted_actions, []);
  }
});

test('canonical SDK/gateway reassign integration consumes child context, CAS, evidence, typed denial and scope denial', async t => {
  // This exercises the published shared SDK/gateway. The bridge context,
  // projection and owner below are controlled contract
  // fixtures, never production identity, authority or business data.
  const csrf = 'A'.repeat(43);
  const bootstrapNonce = 'N'.repeat(43);
  const companyId = 'company-a';
  const bridgeContext = { schema: 'titan.directadmin.session/v1', actor_id: 'fixture-actor', company_id: companyId,
    company_ids: [companyId], context_revision: 'fixture-context-revision', session_revision: 1,
    expires_at: Date.now() + 60_000, da_role: 'user', authority: 'not-carried' };
  const workforceChildContext = { schema: 'titan.workforce-zero.session/v1', audience: 'workforce', surface: 'zero',
    actor_id: bridgeContext.actor_id, company_id: companyId, company_ids: [companyId], device_id: 'fixture-device',
    session_id: 'fixture-workforce-session', context_revision: 'fixture-workforce-context', session_revision: 1,
    expires_at: bridgeContext.expires_at };
  const descriptor = { action: 'reassign', capability_id: 'titan.workforce.reassign',
    requires_fresh_approval: true, grants_authority: false };
  let work = { company_id: companyId, work_id: 'fixture-ready-work', state: 'READY',
    assignee: 'fixture-worker-old', context_refs: [], evidence_refs: [] };
  let raceNextIntent = false;
  let mismatchNextChildCompany = false;
  let tamperNextIntentScope = false;
  const ownerIntents = [];
  const childContextsConsumed = [];
  const fixtureAcceptedEvidence = [];
  const projection = async (_plugin, context) => {
    assert.equal(context.company_id, companyId);
    return { company_id: companyId, source: 'fixture-reassign-owner', freshness: new Date().toISOString(),
      evidence_refs: [], data: { schema: 'titan.workforce-cockpit.v1', company_id: companyId,
        discovery: { company_id: companyId, controls: [descriptor], workers: [
          { company_id: companyId, worker_id: 'fixture-worker-old', kind: 'digital', active: true, capabilities: [] },
          { company_id: companyId, worker_id: 'fixture-worker-target', kind: 'human', active: true, capabilities: [] },
        ] }, status: { company_id: companyId, work: [structuredClone(work)] } } };
  };
  class DirectAdminWorkforceAuthorityDenied extends Error {
    constructor() { super('sensitive owner detail must never reach the plugin'); this.name = 'DirectAdminWorkforceAuthorityDenied'; this.code = 'directadmin-workforce-authority-denied'; this.status = 403; }
  }
  const owners = {
    projection,
    requestIntent: async (plugin, intent, context, revalidate, withWorkforceZeroSession) => {
      assert.equal(plugin, 'titan_workforce');
      assert.equal((await revalidate()).company_id, context.company_id);
      assert.equal(typeof withWorkforceZeroSession, 'function');
      return withWorkforceZeroSession(async (credential, childContext) => {
        childContextsConsumed.push(structuredClone(childContext));
        if (credential !== 'fixture-derived-workforce-credential' || childContext.company_id !== context.company_id ||
            childContext.actor_id !== context.actor_id || childContext.company_ids.length !== 1 ||
            childContext.company_ids[0] !== context.company_id || !childContext.session_id || !childContext.context_revision) {
          throw new DirectAdminWorkforceAuthorityDenied();
        }
        ownerIntents.push(structuredClone(intent));
        if (raceNextIntent) {
          raceNextIntent = false;
          // Model a concurrent canonical update after the consumer's projection.
          work = { ...work, assignee: 'fixture-concurrent-worker' };
        }
        if (intent.input.expected_assignee_id !== work.assignee) throw new DirectAdminWorkforceAuthorityDenied();
        const acceptedEvidence = { evidence_ref: 'fixture-accepted-reassignment-evidence', company_id: context.company_id,
          workforce_session_id: childContext.session_id, workforce_context_revision: childContext.context_revision };
        fixtureAcceptedEvidence.push(acceptedEvidence);
        work = { ...work, assignee: intent.input.target_worker_id,
          evidence_refs: [...work.evidence_refs, acceptedEvidence.evidence_ref] };
        return { receipt_id: 'fixture-owner-request-receipt' };
      });
    },
  };
  const bridge = {
    bootstrapBrowserSession: async (request, bootstrapProvider) => {
      assert.equal(request.method, 'POST');
      assert.equal(new URL(request.url).origin, 'https://panel.example.test');
      assert.equal(request.headers.get('origin'), 'https://panel.example.test');
      assert.equal(request.headers.get('sec-fetch-site'), 'same-origin');
      assert.equal(request.headers.get('x-titan-da-bootstrap-csrf'), bootstrapNonce);
      assert.equal(request.headers.has('authorization'), false);
      assert.equal(await request.text(), '');
      const input = await bootstrapProvider.provide({ origin: 'https://panel.example.test', cookie: null,
        authorization: null, csrf_nonce: bootstrapNonce });
      return { csrf_token: input.csrf_token, set_cookie: '__Host-titan-da-session=fixture-session; Path=/; Secure; HttpOnly; SameSite=Strict' };
    },
    authenticate: async request => {
      assert.equal(request.headers.get('origin'), 'https://panel.example.test');
      assert.equal(request.headers.get('sec-fetch-site'), 'same-origin');
      assert.equal(request.headers.get('x-titan-csrf'), csrf);
      assert.equal(request.headers.get('cookie'), '__Host-titan-da-session=fixture-session');
      const childContext = mismatchNextChildCompany
        ? { ...workforceChildContext, company_id: 'company-b', company_ids: ['company-b'] }
        : workforceChildContext;
      return { context: bridgeContext, revalidate: async () => bridgeContext,
        withWorkforceZeroSession: async consume => consume('fixture-derived-workforce-credential', childContext),
        switchCompany: async () => { throw new Error('company switching is outside this contract fixture'); },
        logout: async () => {} };
    },
  };
  const gateway = SDK.createDirectAdminGateway(bridge, owners, {
    provide: async proof => {
      assert.deepEqual(proof, { origin: 'https://panel.example.test', cookie: null,
        authorization: null, csrf_nonce: bootstrapNonce });
      return { csrf_token: csrf };
    },
  });
  const fetcher = async (path, init = {}) => {
    if (new URL(path, 'https://panel.example.test').pathname === '/v1/directadmin/bootstrap') {
      const headers = new Headers(init.headers);
      assert.equal(init.method, 'POST');
      assert.equal(init.body, '');
      assert.equal(headers.get('x-titan-da-bootstrap-csrf'), bootstrapNonce);
      return new Response(JSON.stringify({ csrf_token: csrf }), { status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': '__Host-titan-da-session=fixture-session; Path=/; Secure; HttpOnly; SameSite=Strict' } });
    }
    let body = init.body;
    if (tamperNextIntentScope && path.endsWith('/intents')) {
      tamperNextIntentScope = false;
      body = JSON.stringify({ ...JSON.parse(body), company_id: 'company-b' });
    }
    return gateway(new Request(new URL(path, 'https://panel.example.test'), { method: init.method ?? 'GET', body,
      headers: { origin: 'https://panel.example.test', 'sec-fetch-site': 'same-origin',
        cookie: '__Host-titan-da-session=fixture-session',
        'content-type': init.headers?.['Content-Type'] ?? '',
        'x-titan-csrf': init.headers?.['X-Titan-CSRF'] ?? '',
        'x-titan-da-bootstrap-csrf': init.headers?.['X-Titan-DA-Bootstrap-CSRF'] ?? '' } }));
  };
  const session = new SDK.DirectAdminCockpitSession(() => bootstrapNonce, fetcher, undefined);
  t.after(() => session.dispose());
  const controller = new WorkforceController(new WorkforceApi(session));
  const unsubscribe = session.subscribe(() => controller.invalidate());
  t.after(unsubscribe);

  await controller.connect();
  assert.equal(controller.state.phase, 'ready', controller.state.error);
  await controller.submit({ action: 'reassign', work_id: 'fixture-ready-work',
    target_worker_id: 'fixture-worker-target', reason: 'Fixture approved assignment proposal' });
  assert.equal(controller.state.phase, 'ready', controller.state.error);
  assert.deepEqual(ownerIntents[0].input, { action: 'reassign', work_id: 'fixture-ready-work',
    reason: 'Fixture approved assignment proposal', expected_assignee_id: 'fixture-worker-old',
    target_worker_id: 'fixture-worker-target' });
  assert.equal(controller.state.receipt.state, 'REQUESTED');
  assert.deepEqual(controller.state.receipt.evidence_refs, [], 'gateway acknowledgement is not accepted evidence');
  assert.deepEqual(controller.state.status.work[0].evidence_refs, ['fixture-accepted-reassignment-evidence'],
    'only the refreshed canonical owner projection supplies accepted evidence');
  assert.equal(verifiedOutcome(controller.state.status.work[0]), false);
  assert.deepEqual(fixtureAcceptedEvidence[0], { evidence_ref: 'fixture-accepted-reassignment-evidence',
    company_id: 'company-a', workforce_session_id: 'fixture-workforce-session',
    workforce_context_revision: 'fixture-workforce-context' }, 'the owner fixture binds accepted evidence to the bridged child lineage');

  // A child token for a different company is rejected before effect. The
  // current SDK maps the exact typed authority denial to sanitized HTTP 403;
  // the consumer keeps only freshly revalidated data for the same company.
  mismatchNextChildCompany = true;
  await controller.submit({ action: 'reassign', work_id: 'fixture-ready-work',
    target_worker_id: 'fixture-worker-old', reason: 'Fixture child company mismatch' });
  assert.equal(controller.state.phase, 'ready');
  assert.equal(controller.state.context.company_id, companyId);
  assert.equal(controller.state.receipt, null);
  assert.match(controller.state.error, /denial without a receipt.*outcome is unverified/i);
  assert.equal(ownerIntents.length, 1, 'mismatched child context is denied before entering the owner effect');
  assert.equal(work.assignee, 'fixture-worker-target');
  assert.deepEqual(work.evidence_refs, ['fixture-accepted-reassignment-evidence']);
  mismatchNextChildCompany = false;
  await controller.connect();
  assert.equal(controller.state.phase, 'ready', controller.state.error);

  // A concurrent assignee change makes the expected-assignee CAS stale. The
  // owner denies before effect, but the generic HTTP denial cannot establish
  // that this operation caused the visible WorkItem change, so the consumer
  // calls the outcome unverified until richer canonical history is available.
  raceNextIntent = true;
  await controller.submit({ action: 'reassign', work_id: 'fixture-ready-work',
    target_worker_id: 'fixture-worker-old', reason: 'Fixture stale compare-and-set' });
  assert.equal(controller.state.phase, 'ready');
  assert.equal(controller.state.context.company_id, companyId);
  assert.equal(controller.state.receipt, null);
  assert.match(controller.state.error, /denial without a receipt.*outcome is unverified/i);
  assert.doesNotMatch(controller.state.error, /host denied that request/i);
  assert.equal(work.assignee, 'fixture-concurrent-worker', 'stale owner rejection causes no reassignment effect');
  assert.deepEqual(work.evidence_refs, ['fixture-accepted-reassignment-evidence']);

  // A caller scope mismatch is a 409 from the real gateway; the shared SDK
  // invalidates the session and the plugin drops all prior-company content.
  await controller.connect();
  assert.equal(controller.state.phase, 'ready', controller.state.error);
  tamperNextIntentScope = true;
  await controller.submit({ action: 'reassign', work_id: 'fixture-ready-work',
    target_worker_id: 'fixture-worker-old', reason: 'Fixture scope mismatch' });
  assert.equal(controller.state.phase, 'denied');
  assert.equal(controller.state.context, null);
  assert.equal(controller.state.status, null);
  assert.equal(controller.state.receipt, null);
  assert.equal(ownerIntents.length, 2, 'child mismatch is denied inside the owner before effect and scope mismatch is rejected before the owner');
  assert.equal(childContextsConsumed.length, 3, 'the shared gateway callback is consumed for success, child mismatch, and stale CAS');
});

test('executable role ignores hostile CGI input and fails closed without the Server Node relay', async () => {
  const { execFileSync } = await import('node:child_process');
  const { chromium } = await import('@playwright/test');
  const folder = await mkdtemp(join(tmpdir(), 'workforce-real-sdk-route-'));
  let browser;
  try {
    const result = await buildPackage({ outputDir: folder, sdkModulePath: sdkPath });
    execFileSync('tar', ['-xzf', result.archivePath, '-C', folder]);
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    for (const role of ['admin', 'reseller', 'user']) {
      const hostilePost = 'company_id=attacker-company&csrf=attacker-token&action=cancel';
      const html = execFileSync(join(folder, role, 'index.html'), [], {
        encoding: 'utf8', input: hostilePost,
        // DirectAdmin's documented pipe_post=yes convention passes POST=stdin=true
        // and the parsed form body on stdin to the executable role route.
        env: { ...process.env, POST: 'stdin=true', REQUEST_METHOD: 'POST', QUERY_STRING: 'pipe_post=yes', CONTENT_TYPE: 'application/x-www-form-urlencoded', CONTENT_LENGTH: String(Buffer.byteLength(hostilePost)), TITAN_COMPANY_ID: 'env-company', TITAN_DIRECTADMIN_CSRF: 'env-token', HTTP_COOKIE: 'session=attacker-session' },
      });
      assert.doesNotMatch(html, /attacker-company|attacker-token|query-company|env-company|env-token|attacker-session/);
      const page = await browser.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setContent(html);
      await page.getByText('DirectAdmin Workforce relay is unavailable. Install or restore the Titan Server Node plugin, then reconnect.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Submit governed request' }).count(), 0);
      assert.equal(await page.getByText('fixture-company').count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser?.close(); await rm(folder, { recursive: true, force: true }); }
});

test('packaged cleaning cockpit uses executable role RAW bootstrap through reconnect and company switch', async () => {
  const { execFileSync } = await import('node:child_process');
  const { chromium } = await import('@playwright/test');
  const folder = await mkdtemp(join(tmpdir(), 'workforce-browser-acceptance-'));
  const csrf = 'A'.repeat(43);
  const sessionCookieName = '__Host-titan-da-session';
  const daCookies = { session: 'fixture-da-session', key: 'fixture-da-key' };
  const daCookieHeader = `session=${daCookies.session}; key=${daCookies.key}`;
  // This lightweight browser fixture only lets consumer lifecycle tests keep
  // their existing same-origin host. The separate relay integration harness
  // loads #812's exact helper/RAW package and the #811 optional gateway.
  const fixtureRelayClient = 'export function createDirectAdminRelayFetch(fetchImpl = globalThis.fetch) { return async (input, init) => { globalThis.__workforceRelayCalls = (globalThis.__workforceRelayCalls || 0) + 1; return fetchImpl(input, init); }; }';
  const requests = [];
  const nonceRequests = [];
  const bootstrapRequests = [];
  const privateNonceRequests = [];
  const privateBootstrapRequests = [];
  const issuedNonces = new Set();
  const acceptedIntents = [];
  const issuedSessionCookies = [];
  let currentSessionCookie = null;
  let activeCompany = 'company-a';
  let contextLifetimeMs = 15 * 60_000;
  let ownerAvailable = false;
  let expireNextIntent = false;
  let denyNextIntent = false;
  let denyProjectionAfterAcceptedIntent = false;
  let denyNextProjection = false;
  let loggedOut = false;
  let unauthorizedResponses = 0;
  let holdNextContext = false;
  let holdNextNonce = null;
  let holdNextBootstrap = null;
  let controlCapabilitiesAvailable = true;
  let shortContextExpiresAt = null;
  let heldContext;
  let pendingIntent;
  let browser;
  let server;
  let privateServer;
  let privatePortConfig;
  let panelOrigin;
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const json = (response, status, value, headers = {}) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    response.end(JSON.stringify(value));
  };
  const readBody = async request => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
  };
  const runPackagedRaw = (script, request, url) => new Promise((resolveRaw, rejectRaw) => {
    const lines = Object.entries(request.headers).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map(entry => `${name}: ${entry}`));
    const environment = {
      ...process.env,
      NODE_ENV: 'test',
      TITAN_WORKFORCE_DIRECTADMIN_RAW_TEST_CONFIG: privatePortConfig,
      REQUEST_METHOD: request.method,
      QUERY_STRING: url.search.slice(1),
      HEADERS: encodeURIComponent(lines.join('\r\n')),
      POST: 'stdin=true',
      CONTENT_LENGTH: request.headers['content-length'] ?? '0',
    };
    const child = spawn(process.execPath, [script], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    child.stdout.on('data', chunk => output.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)));
    child.once('error', rejectRaw);
    child.once('close', code => {
      const raw = Buffer.concat(output);
      const separator = raw.indexOf(Buffer.from('\r\n\r\n'));
      if (code !== 0 || separator < 0) {
        rejectRaw(new Error(`packaged RAW process failed: exit=${code}; stderr=${Buffer.concat(errors).toString('utf8')}`));
        return;
      }
      assert.equal(Buffer.concat(errors).length, 0, 'packaged RAW handler does not log browser cookies or nonce data');
      const headerLines = raw.subarray(0, separator).toString('latin1').split('\r\n');
      const status = Number(headerLines.shift().split(' ')[1]);
      const responseHeaders = new Map();
      for (const line of headerLines) {
        const offset = line.indexOf(':');
        if (offset < 1) continue;
        const name = line.slice(0, offset).toLowerCase();
        const values = responseHeaders.get(name) ?? [];
        values.push(line.slice(offset + 1).trim());
        responseHeaders.set(name, values);
      }
      const body = raw.subarray(separator + 4);
      assert.equal(Number(responseHeaders.get('content-length')?.[0]), body.length);
      resolveRaw({ status, headers: Object.fromEntries([...responseHeaders].map(([name, values]) =>
        [name, values.length === 1 ? values[0] : values])), body });
    });
    child.stdin.end();
  });
  const contextFor = company_id => {
    const expires_at = Date.now() + contextLifetimeMs;
    if (contextLifetimeMs < 15 * 60_000) shortContextExpiresAt = expires_at;
    return { schema: 'titan.directadmin.session/v1', actor_id: 'browser-fixture-actor', company_id,
      company_ids: [company_id], context_revision: `revision-${company_id}`, session_revision: 7, da_role: 'user',
      expires_at, authority: 'not-carried' };
  };
  const projectionFor = company_id => ({ company_id, source: 'controlled-test-http-owner', freshness: new Date().toISOString(), evidence_refs: [],
    data: { company_id, schema: 'titan.workforce-cockpit.v1',
      discovery: { company_id, workers: [{ company_id, worker_id: `${company_id}-worker`, kind: 'human', role: 'cleaner', active: true, capabilities: ['cleaning.general'] }],
        controls: controlCapabilitiesAvailable ? [{ action: 'cancel', capability_id: 'test.cancel' }] : [] },
      status: { company_id,
        work: [{ company_id, work_id: `${company_id}-work`, assignee: `${company_id}-worker`, state: 'IN_PROGRESS', context_refs: [], evidence_refs: [] }] } } });

  const keyPath = join(folder, 'panel.key');
  const certPath = join(folder, 'panel.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=127.0.0.1', '-days', '1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, async (request, response) => {
    try {
      const url = new URL(request.url, `https://127.0.0.1:${server.address()?.port ?? 443}`);
      const body = request.method === 'POST' ? await readBody(request) : undefined;
      if (url.pathname === '/CMD_PLUGINS/titan-server-node/images/directadmin-relay-client.mjs' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        response.end(fixtureRelayClient); return;
      }
      const origin = `https://127.0.0.1:${server.address().port}`;
      const roleBase = role => role === 'admin' ? '/CMD_PLUGINS_ADMIN' : role === 'reseller' ? '/CMD_PLUGINS_RESELLER' : '/CMD_PLUGINS';
      const rawBase = `${roleBase('user')}/titan_workforce/`;
      if (url.pathname === `${rawBase}bootstrap-nonce.raw` || url.pathname === `${rawBase}bootstrap.raw`) {
        const isNonce = url.pathname.endsWith('bootstrap-nonce.raw');
        const raw = { method: request.method, pathname: url.pathname, search: url.search, contentType: request.headers['content-type'] ?? null,
          bodyLength: body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body)), cookie: request.headers.cookie ?? null,
          origin: request.headers.origin ?? null, secFetchSite: request.headers['sec-fetch-site'] ?? null,
          nonceHeader: request.headers['x-titan-da-bootstrap-csrf'] ?? null };
        (isNonce ? nonceRequests : bootstrapRequests).push(raw);
        const role = url.pathname.startsWith('/CMD_PLUGINS_ADMIN/') ? 'admin'
          : url.pathname.startsWith('/CMD_PLUGINS_RESELLER/') ? 'reseller' : 'user';
        const action = isNonce ? 'bootstrap-nonce' : 'bootstrap';
        const rawResponse = await runPackagedRaw(join(folder, role, `${action}.raw`), request, url);
        response.writeHead(rawResponse.status, rawResponse.headers);
        response.end(rawResponse.body);
        return;
      }
      const observation = { method: request.method, path: url.pathname, headers: request.headers, body };
      requests.push(observation);
      const protectedRequest = ['/v1/directadmin/context', '/v1/directadmin/titan_workforce/projection',
        '/v1/directadmin/titan_workforce/intents', '/v1/directadmin/logout'].includes(url.pathname);
      if (protectedRequest && (!currentSessionCookie || request.headers.cookie?.includes(currentSessionCookie) !== true || request.headers['x-titan-csrf'] !== csrf ||
          (request.method === 'POST' && request.headers.origin !== origin))) {
        json(response, 403, { error: 'fixture-request-rejected' }); return;
      }
      if (url.pathname === '/v1/directadmin/context' && request.method === 'GET') {
        if (loggedOut) { unauthorizedResponses++; observation.status = 401; observation.code = 'session-expired'; json(response, 401, { error: 'session-expired' }); return; }
        if (holdNextContext) {
          holdNextContext = false;
          heldContext.entered.resolve();
          await heldContext.release.promise;
        }
        observation.status = 200; json(response, 200, contextFor(activeCompany)); return;
      }
      if (url.pathname === '/v1/directadmin/titan_workforce/projection' && request.method === 'GET') {
        if (loggedOut) { unauthorizedResponses++; observation.status = 401; observation.code = 'session-expired'; json(response, 401, { error: 'session-expired' }); return; }
        if (denyNextProjection) { denyNextProjection = false; observation.status = 403; observation.code = 'fixture-projection-forbidden'; json(response, 403, { error: 'fixture-projection-forbidden' }); return; }
        if (!ownerAvailable) { observation.status = 503; observation.code = 'owner-not-mounted'; json(response, 503, { error: 'owner-not-mounted' }); return; }
        const company_id = activeCompany;
        observation.status = 200;
        json(response, 200, { context: contextFor(company_id), projection: projectionFor(company_id) }); return;
      }
      if (url.pathname === '/v1/directadmin/titan_workforce/intents' && request.method === 'POST') {
        if (loggedOut || expireNextIntent) { unauthorizedResponses++; expireNextIntent = false; json(response, 401, { error: 'session-expired' }); return; }
        const contextRevision = `revision-${activeCompany}`;
        const contextRevisionAssertion = typeof SDK.directAdminContextRevisionAssertion === 'function'
          ? await SDK.directAdminContextRevisionAssertion(contextRevision) : contextRevision;
        if (body?.company_id !== activeCompany || body?.input?.action !== 'cancel' || body?.input?.work_id !== `${activeCompany}-work` ||
            body?.actor_id !== 'browser-fixture-actor' || body?.capability_id !== 'test.cancel' ||
            ![contextRevision, contextRevisionAssertion].includes(body?.context_revision)) {
          json(response, 409, { error: 'fixture-intent-scope-mismatch' }); return;
        }
        if (denyNextIntent) {
          denyNextIntent = false;
          json(response, 403, { error: 'directadmin-workforce-action-unsupported', read_only: true }); return;
        }
        acceptedIntents.push(body);
        if (denyProjectionAfterAcceptedIntent) {
          denyProjectionAfterAcceptedIntent = false;
          denyNextProjection = true;
        }
        if (pendingIntent) {
          pendingIntent.entered.resolve();
          await pendingIntent.release.promise;
        }
        json(response, 202, { status: 'REQUESTED', receipt_id: `browser-fixture-receipt-${acceptedIntents.length}`, correlation_id: body.correlation_id }); return;
      }
      if (url.pathname === '/v1/directadmin/logout' && request.method === 'POST') {
        loggedOut = true;
        currentSessionCookie = null;
        json(response, 200, { status: 'reauthentication-required' }, { 'set-cookie': '__Host-titan-da-session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0' }); return;
      }
      if (url.pathname === '/' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(commissionedHtml); return;
      }
      if (url.pathname === '/logout-helper' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(logoutHelperHtml); return;
      }
      if (url.pathname === '/away' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end('<!doctype html><title>Navigation fixture</title><main>Left the Workforce cockpit.</main>'); return;
      }
      json(response, 404, { error: 'not-found' });
    } catch {
      if (!response.headersSent) json(response, 500, { error: 'fixture-error' });
      else response.destroy();
    }
  });

  let commissionedHtml = '';
  let logoutHelperHtml = '';
  try {
    const result = await buildPackage({ outputDir: folder, sdkModulePath: sdkPath });
    assert.equal(result.files, 26, 'the exact package includes all role RAW handlers and the RAW adapter');
    execFileSync('tar', ['-xzf', result.archivePath, '-C', folder]);
    const archiveEntries = execFileSync('tar', ['-tzf', result.archivePath], { encoding: 'utf8' }).trim().split('\n');
    for (const role of ['admin', 'reseller', 'user']) {
      assert.ok(archiveEntries.includes(`${role}/bootstrap-nonce.raw`));
      assert.ok(archiveEntries.includes(`${role}/bootstrap.raw`));
    }
    assert.ok(archiveEntries.includes('lib/directadmin-bootstrap-raw.mjs'));
    const rendered = execFileSync(join(folder, 'user/index.html'), [], { encoding: 'utf8' });
    commissionedHtml = rendered;
    const sdk = await readFile(join(folder, 'images/sdk.mjs'), 'utf8');
    const sdkUrl = `data:text/javascript;base64,${Buffer.from(sdk).toString('base64')}`;
    logoutHelperHtml = `<script type="importmap">${JSON.stringify({ imports: { 'titan-sdk': sdkUrl } })}</script><script type="module">
      import { DirectAdminCockpitSession } from 'titan-sdk';
      import { createDirectAdminRelayFetch } from '/CMD_PLUGINS/titan-server-node/images/directadmin-relay-client.mjs';
      const flags = '?headers_to_env=yes&pipe_post=yes';
      let nonce = null;
      const issueNonce = async () => { const response = await fetch('/CMD_PLUGINS/titan_workforce/bootstrap-nonce.raw' + flags, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'same-origin',
        headers: { Accept: 'application/json' } }); const value = await response.json(); nonce = value.csrf_nonce; };
      window.logoutSharedSession = async () => {
        await issueNonce();
        const relay = createDirectAdminRelayFetch();
        const session = new DirectAdminCockpitSession(() => nonce, async (input, init = {}) => {
          if (input === '/v1/directadmin/bootstrap') {
            const csrf_nonce = nonce; nonce = null;
            return fetch('/CMD_PLUGINS/titan_workforce/bootstrap.raw' + flags, { method: 'POST', credentials: 'same-origin',
              cache: 'no-store', redirect: 'error', referrerPolicy: 'same-origin', signal: init.signal,
              headers: { Accept: 'application/json', 'X-Titan-DA-Bootstrap-CSRF': csrf_nonce } });
          }
          return relay(input, init);
        });
        try { await session.connect(); await session.logout(); } finally { session.dispose(); }
      };
    </script>`;
    privateServer = createHttpServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const commonValid = request.method === 'POST' && body.length === 0 && request.headers['content-length'] === '0' &&
          request.headers.host === new URL(panelOrigin).host && request.headers.origin === panelOrigin &&
          request.headers['sec-fetch-site'] === 'same-origin' && request.headers.accept === 'application/json' &&
          request.headers.authorization === undefined && request.headers['x-titan-csrf'] === undefined;
        if (!commonValid) { json(response, 400, { error: 'fixture-private-request-rejected', read_only: true }); return; }
        if (url.pathname === '/v1/directadmin/bootstrap-nonce') {
          const observation = { cookie: request.headers.cookie, csrf: request.headers['x-titan-da-bootstrap-csrf'] ?? null };
          privateNonceRequests.push(observation);
          if (observation.cookie !== daCookieHeader || observation.csrf !== null) {
            json(response, 400, { error: 'fixture-private-nonce-rejected', read_only: true }); return;
          }
          const value = `N${String(nonceRequests.length).padStart(42, '0')}`;
          issuedNonces.add(value);
          if (holdNextNonce) {
            const held = holdNextNonce;
            holdNextNonce = null;
            held.entered.resolve();
            await held.release.promise;
          }
          json(response, 200, { csrf_nonce: value }); return;
        }
        if (url.pathname === '/v1/directadmin/bootstrap') {
          const observation = { cookie: request.headers.cookie, csrf: request.headers['x-titan-da-bootstrap-csrf'] ?? null };
          observation.expectedSessionCookie = currentSessionCookie;
          privateBootstrapRequests.push(observation);
          const expectedCookie = currentSessionCookie ? `${daCookieHeader}; ${currentSessionCookie}` : daCookieHeader;
          const allowedCookie = observation.cookie === expectedCookie;
          if (!allowedCookie || typeof observation.csrf !== 'string' || !issuedNonces.delete(observation.csrf)) {
            json(response, 401, { error: 'directadmin-session-rejected', read_only: true }); return;
          }
          if (holdNextBootstrap) {
            const held = holdNextBootstrap;
            holdNextBootstrap = null;
            held.entered.resolve();
            await held.release.promise;
          }
          const token = `fixture-${privateBootstrapRequests.length}.header.signature`;
          currentSessionCookie = `${sessionCookieName}=${token}`;
          observation.issuedSessionCookie = currentSessionCookie;
          issuedSessionCookies.push(currentSessionCookie);
          json(response, 200, { csrf_token: csrf }, {
            'set-cookie': `${currentSessionCookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300`,
          }); return;
        }
        json(response, 404, { error: 'not-found', read_only: true });
      } catch {
        if (!response.headersSent) json(response, 500, { error: 'fixture-private-host-failed', read_only: true });
        else response.destroy();
      }
    });
    await new Promise(resolve => privateServer.listen(0, '127.0.0.1', resolve));
    privatePortConfig = join(folder, 'workforce-private-port');
    await writeFile(privatePortConfig, `${privateServer.address().port}\n`, { mode: 0o400 });
    await chmod(privatePortConfig, 0o400);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `https://127.0.0.1:${server.address().port}`;
    panelOrigin = origin;
    browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'], ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const addDirectAdminCookies = browserContext => browserContext.addCookies([
      { name: 'session', value: daCookies.session, url: origin, secure: true, httpOnly: true, sameSite: 'Strict' },
      { name: 'key', value: daCookies.key, url: origin, secure: true, httpOnly: true, sameSite: 'Strict' },
    ]);
    await addDirectAdminCookies(context);
    const page = await context.newPage();
    const errors = [];
    const network = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => network.push(`${request.method()} ${request.url()}`));
    page.on('response', response => network.push(`RESPONSE ${response.status()} ${response.url()}`));
    page.on('requestfailed', request => network.push(`FAILED ${request.url()} ${request.failure()?.errorText ?? ''}`));
    const submitCancel = async (targetPage, companyId, reason) => {
      await targetPage.getByRole('button', { name: 'Governed actions', exact: true }).click();
      await targetPage.getByLabel('Operation').selectOption('cancel');
      await targetPage.getByLabel('Work item').selectOption(`${companyId}-work`);
      await targetPage.getByLabel('Reason', { exact: true }).fill(reason);
      const receiptId = `browser-fixture-receipt-${acceptedIntents.length + 1}`;
      await targetPage.getByRole('button', { name: 'Submit governed request' }).click();
      await targetPage.getByText('Request accepted — verified outcome not yet available', { exact: true }).waitFor();
      await targetPage.getByRole('button', { name: 'Receipts & evidence', exact: true }).click();
      await targetPage.getByText(receiptId, { exact: true }).waitFor();
      return receiptId;
    };
    await page.goto(origin);
    await page.getByText('Hosted Workforce is unavailable. Reconnect to retrieve current state.').waitFor();
    const bootstrapMeta = { nonceRequests: nonceRequests.length, bootstrapRequests: bootstrapRequests.length,
      relayRequests: requests.map(item => item.path), cookieCount: (await context.cookies(origin)).length };
    assert.equal(nonceRequests.length, 1, `first page load gets a nonce from the role-local RAW route; ${JSON.stringify(bootstrapMeta)}`);
    assert.equal(bootstrapRequests.length, 1, `first page load redeems the nonce at the role-local RAW route; ${JSON.stringify(bootstrapMeta)}`);
    const browserSessionCookie = async () => {
      const item = (await context.cookies(origin)).find(cookieItem => cookieItem.name === sessionCookieName);
      return item ? `${sessionCookieName}=${item.value}` : null;
    };
    assert.equal((await context.cookies(origin)).some(item => item.name === sessionCookieName && item.httpOnly && item.secure), true,
      'the same-origin bootstrap installs an HttpOnly Secure host cookie in the browser cookie jar');
    const initiallyIssuedCookie = await browserSessionCookie();
    assert.equal(initiallyIssuedCookie, privateBootstrapRequests[0].issuedSessionCookie,
      'the browser cookie jar contains the first synthetic host session issued through the packaged RAW handler');
    assert.equal(requests.filter(item => item.path === '/v1/directadmin/titan_workforce/projection').length, 1,
      `real shared SDK attempted the same-origin owner route; observed paths=${JSON.stringify(requests.map(item => item.path))}; page errors=${JSON.stringify(errors)}; bootstrap=${JSON.stringify(bootstrapMeta)}; network=${JSON.stringify(network)}`);
    assert.equal(await page.getByRole('navigation').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Submit governed request' }).count(), 0);
    assert.equal(await page.getByText('company-a', { exact: true }).count(), 0, 'no company is asserted when owner routes are unavailable');

    ownerAvailable = true;
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await page.getByText('company-a', { exact: true }).waitFor();
    assert.equal(await page.getByText('Current hosted projection', { exact: true }).count(), 1);

    const broadcastInvalidation = () => page.evaluate(() => {
      const channel = new BroadcastChannel('titan-directadmin-context');
      channel.postMessage('invalidate');
      channel.close();
    });
    await broadcastInvalidation();
    await page.getByText('Context changed. Reconnect to load permitted Workforce.', { exact: true }).waitFor();
    const delayedBootstrap = { entered: deferred(), release: deferred() };
    holdNextBootstrap = delayedBootstrap;
    const bootstrapBeforeInvalidationRace = bootstrapRequests.length;
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await delayedBootstrap.entered.promise;
    assert.equal(bootstrapRequests.length, bootstrapBeforeInvalidationRace + 1,
      'the first reconnect reaches bootstrap.raw before the external invalidation');
    assert.equal(privateBootstrapRequests.at(-1).cookie, `${daCookieHeader}; ${initiallyIssuedCookie}`,
      'a reconnect forwards the current Titan cookie to the private renewal endpoint');
    await broadcastInvalidation();
    await page.getByText('Context changed. Reconnect to load permitted Workforce.', { exact: true }).waitFor();
    const lateBootstrapRequest = page.waitForEvent('requestfinished', request =>
      new URL(request.url()).pathname.endsWith('/titan_workforce/bootstrap.raw'));
    delayedBootstrap.release.resolve();
    await lateBootstrapRequest;
    // The task boundary follows the downloaded body and its promise callbacks.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    assert.equal(await page.getByText('company-a', { exact: true }).count(), 0,
      'a late bootstrap response cannot restore company data after session invalidation');
    const nonceBeforeRaceRecovery = nonceRequests.length;
    const bootstrapBeforeRaceRecovery = bootstrapRequests.length;
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await page.getByText('company-a', { exact: true }).waitFor();
    assert.equal(nonceRequests.length, nonceBeforeRaceRecovery + 1,
      'recovery after late bootstrap invalidation obtains a fresh nonce');
    assert.equal(bootstrapRequests.length, bootstrapBeforeRaceRecovery + 1,
      'recovery after late bootstrap invalidation performs a new bootstrap');
    const lateIssuedCookie = privateBootstrapRequests.at(-2).issuedSessionCookie;
    assert.equal(privateBootstrapRequests.at(-1).cookie, `${daCookieHeader}; ${lateIssuedCookie}`,
      'the next renewal forwards the cookie issued by the preceding completed bootstrap');
    const recoveredCookie = await browserSessionCookie();
    assert.equal(recoveredCookie, privateBootstrapRequests.at(-1).issuedSessionCookie,
      'the browser jar advances to the newly rotated session cookie');
    assert.notEqual(recoveredCookie, lateIssuedCookie);

    const contextReadsBeforeNonceRace = requests.filter(item => item.method === 'GET' && item.path === '/v1/directadmin/context').length;
    await broadcastInvalidation();
    await page.getByText('Context changed. Reconnect to load permitted Workforce.', { exact: true }).waitFor();
    const delayedNonce = { entered: deferred(), release: deferred() };
    holdNextNonce = delayedNonce;
    const nonceBeforeInvalidationRace = nonceRequests.length;
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await delayedNonce.entered.promise;
    assert.equal(nonceRequests.length, nonceBeforeInvalidationRace + 1,
      'the reconnect is held after issuing its nonce request');
    await broadcastInvalidation();
    await page.getByText('Context changed. Reconnect to load permitted Workforce.', { exact: true }).waitFor();
    const lateNonceRequest = page.waitForEvent('requestfinished', request =>
      new URL(request.url()).pathname.endsWith('/titan_workforce/bootstrap-nonce.raw'));
    delayedNonce.release.resolve();
    await lateNonceRequest;
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    assert.equal(await page.getByText('company-a', { exact: true }).count(), 0,
      'a stale nonce completion cannot reconnect with the retained SDK CSRF token');
    assert.equal(requests.filter(item => item.method === 'GET' && item.path === '/v1/directadmin/context').length,
      contextReadsBeforeNonceRace, 'an invalidated nonce prefetch does not send a context request');
    assert.equal(bootstrapRequests.length, bootstrapBeforeRaceRecovery + 1,
      'an invalidated nonce prefetch does not redeem bootstrap');
    const nonceBeforeFreshRecovery = nonceRequests.length;
    const bootstrapBeforeFreshRecovery = bootstrapRequests.length;
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await page.getByText('company-a', { exact: true }).waitFor();
    assert.equal(nonceRequests.length, nonceBeforeFreshRecovery + 1,
      'an explicit retry after stale nonce invalidation obtains a fresh nonce');
    assert.equal(bootstrapRequests.length, bootstrapBeforeFreshRecovery + 1,
      'an explicit retry after stale nonce invalidation bootstraps before restoring company data');

    await page.getByRole('button', { name: 'Host status', exact: true }).click();
    await page.getByText('controlled-test-http-owner', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Governed actions', exact: true }).click();
    await page.getByLabel('Operation').selectOption('cancel');
    await page.getByLabel('Work item').selectOption('company-a-work');
    await page.getByLabel('Reason', { exact: true }).fill('Browser cancellation acceptance fixture');
    pendingIntent = { entered: deferred(), release: deferred() };
    await page.locator('form button[type="submit"]').evaluate(button => { button.click(); button.click(); });
    await Promise.race([pendingIntent.entered.promise, new Promise((_, reject) => setTimeout(async () => reject(new Error(
      `browser intent route was not reached; requests=${JSON.stringify(requests.map(item => ({ method: item.method, path: item.path })))}; page errors=${JSON.stringify(errors)}; browser network=${JSON.stringify(network)}; UI=${JSON.stringify(await page.locator('#titan-workforce').innerText())}`,
    )), 3000))]);
    assert.equal(acceptedIntents.length, 1, 'rapid repeated form activations submit only one hosted intent');
    assert.equal(await page.getByRole('button', { name: 'Submit governed request' }).isDisabled(), true, 'submit control is disabled while the one request is pending');
    assert.equal(acceptedIntents[0].company_id, 'company-a');
    assert.equal(acceptedIntents[0].input.action, 'cancel');
    assert.equal(acceptedIntents[0].input.reason, 'Browser cancellation acceptance fixture');
    assert.match(await page.locator('#titan-workforce').innerText(), /Submitting governed request/);
    pendingIntent.release.resolve();
    await page.getByText('Request accepted — verified outcome not yet available', { exact: true }).waitFor();
    assert.equal(await page.getByText('Verified outcome with evidence', { exact: true }).count(), 0);
    assert.doesNotMatch(await page.locator('#titan-workforce').innerText(), /\bVERIFIED\b|Verified outcome with evidence/,
      'the hosted transport acknowledgement remains REQUESTED and never becomes a verified outcome');
    await page.getByRole('button', { name: 'Receipts & evidence', exact: true }).click();
    await page.getByText('browser-fixture-receipt-1', { exact: true }).waitFor();
    assert.equal(await page.getByText('Request accepted — verified outcome not yet available', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Verified outcome with evidence', { exact: true }).count(), 0);
    pendingIntent = null;

    const contextReadsBeforeDenial = requests.filter(item => item.method === 'GET' && item.path === '/v1/directadmin/context').length;
    const projectionReadsBeforeDenial = requests.filter(item => item.method === 'GET' && item.path === '/v1/directadmin/titan_workforce/projection').length;
    denyNextIntent = true;
    await page.getByRole('button', { name: 'Governed actions', exact: true }).click();
    await page.getByLabel('Reason', { exact: true }).fill('Unsupported action denial fixture');
    await page.getByRole('button', { name: 'Submit governed request' }).click();
    try {
      await page.getByText('The host returned a denial without a receipt. Current company data was refreshed; outcome is unverified. Inspect canonical history before retrying.', { exact: true }).waitFor({ timeout: 5000 });
    } catch (error) {
      throw new Error(`${error.message}; UI=${JSON.stringify(await page.locator('#titan-workforce').innerText())}; requests=${JSON.stringify(requests.slice(-8).map(item => ({ method: item.method, path: item.path, status: item.status, code: item.code })))}`);
    }
    assert.equal(acceptedIntents.length, 1, 'unsupported action denial creates no accepted fixture intent');
    assert.equal(await page.getByText('company-a', { exact: true }).count(), 1, 'fresh current company context remains usable after a no-effect 403');
    assert.ok(requests.filter(item => item.method === 'GET' && item.path === '/v1/directadmin/context').length > contextReadsBeforeDenial,
      'the controller revalidates identity after an action denial');
    assert.ok(requests.filter(item => item.method === 'GET' && item.path === '/v1/directadmin/titan_workforce/projection').length > projectionReadsBeforeDenial,
      'the cockpit refreshes canonical projection after an action denial');
    assert.equal(await page.getByRole('button', { name: 'Submit governed request' }).isDisabled(), true,
      'a denied action stays disabled until the operator deliberately refreshes');
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await page.getByText('Current hosted projection', { exact: true }).waitFor();
    assert.equal(await page.getByText('company-a', { exact: true }).count(), 1);

    const rawCallsBeforeCompanySwitch = { nonce: nonceRequests.length, bootstrap: bootstrapRequests.length };
    const cookieBeforeCompanySwitch = await browserSessionCookie();
    activeCompany = 'company-b';
    heldContext = { entered: deferred(), release: deferred() };
    holdNextContext = true;
    await page.evaluate(() => window.dispatchEvent(new Event('titan-context-changed')));
    await Promise.race([heldContext.entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('company-switch revalidation was not reached')), 3000))]);
    assert.match(await page.locator('#titan-workforce').innerText(), /Loading current company context/);
    assert.equal(await page.getByText('company-a', { exact: true }).count(), 0, 'prior company data is cleared before new context settles');
    assert.equal(await page.getByRole('navigation').count(), 0);
    heldContext.release.resolve();
    await page.getByText('company-b', { exact: true }).waitFor();
    assert.deepEqual({ nonce: nonceRequests.length, bootstrap: bootstrapRequests.length }, {
      nonce: rawCallsBeforeCompanySwitch.nonce + 1,
      bootstrap: rawCallsBeforeCompanySwitch.bootstrap + 1,
    }, 'a company context switch performs exactly one fresh RAW bootstrap cycle');
    assert.equal(privateBootstrapRequests.at(-1).cookie, `${daCookieHeader}; ${cookieBeforeCompanySwitch}`,
      'the company switch renewal carries the current host cookie through the packaged RAW adapter');
    assert.notEqual(await browserSessionCookie(), cookieBeforeCompanySwitch,
      'the company switch stores the newly issued host cookie');
    assert.equal(await page.getByText('company-a-work', { exact: true }).count(), 0);
    assert.equal(await page.getByText('browser-fixture-receipt-1', { exact: true }).count(), 0, 'company change clears the prior receipt');

    const switchReceipt = await submitCancel(page, 'company-b', 'Company switch receipt fixture');
    assert.equal(switchReceipt, 'browser-fixture-receipt-2');
    // The actual packaged pagehide listener clears rendered state while keeping
    // only the opaque pointer for a fresh-context receipt reread.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.getByText('Context changed. Reconnect to load permitted Workforce.').waitFor();
    assert.equal(await page.getByText(switchReceipt, { exact: true }).count(), 0, 'pagehide clears a pending-view receipt');
    assert.equal(await page.getByText('company-b', { exact: true }).count(), 0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.getByText('company-b', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Receipts & evidence', exact: true }).click();
    await page.getByText(switchReceipt, { exact: true }).waitFor();
    await page.getByText('Request accepted — verified outcome not yet available').waitFor();

    const reloadReceipt = await submitCancel(page, 'company-b', 'Reload receipt fixture');
    const cyclesBeforeReload = { nonce: nonceRequests.length, bootstrap: bootstrapRequests.length };
    await page.reload();
    await page.getByText('company-b', { exact: true }).waitFor();
    assert.equal(await page.getByText(reloadReceipt, { exact: true }).count(), 0,
      'full reload clears the old DOM before revalidating and restoring the receipt pointer');
    assert.equal(nonceRequests.length, cyclesBeforeReload.nonce + 1, 'a fresh document obtains a new one-time nonce');
    assert.equal(bootstrapRequests.length, cyclesBeforeReload.bootstrap + 1, 'a fresh document renews through bootstrap.raw');
    assert.equal(nonceRequests.at(-1).cookie.includes(sessionCookieName), true,
      'reload nonce request carries the browser-managed HttpOnly Titan cookie for host-side filtering');
    await page.getByRole('button', { name: 'Receipts & evidence', exact: true }).click();
    await page.getByText(reloadReceipt, { exact: true }).waitFor();
    await page.getByText('Request accepted — verified outcome not yet available').waitFor();

    const navigationReceipt = `browser-fixture-receipt-${acceptedIntents.length + 1}`;
    await page.getByRole('button', { name: 'Governed actions', exact: true }).click();
    await page.getByLabel('Operation').selectOption('cancel');
    await page.getByLabel('Work item').selectOption('company-b-work');
    await page.getByLabel('Reason', { exact: true }).fill('Canceled navigation receipt fixture');
    pendingIntent = { entered: deferred(), release: deferred() };
    await page.getByRole('button', { name: 'Submit governed request' }).click();
    await Promise.race([pendingIntent.entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('navigation intent route was not reached')), 3000))]);
    assert.equal(acceptedIntents.length, 4);
    await page.goto(`${origin}/away`);
    await page.getByText('Left the Workforce cockpit.').waitFor();
    pendingIntent.release.resolve();
    pendingIntent = null;
    await page.goBack();
    await page.getByText('company-b', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Receipts & evidence', exact: true }).click();
    await page.getByText('Submit a permitted governed request to inspect its receipt.').waitFor();
    assert.equal(await page.getByText(navigationReceipt, { exact: true }).count(), 0, 'a late acknowledgement cannot restore a receipt after real navigation');

    denyProjectionAfterAcceptedIntent = true;
    await page.getByRole('button', { name: 'Governed actions', exact: true }).click();
    await page.getByLabel('Operation').selectOption('cancel');
    await page.getByLabel('Work item').selectOption('company-b-work');
    await page.getByLabel('Reason', { exact: true }).fill('Accepted request with denied read refresh fixture');
    await page.getByRole('button', { name: 'Submit governed request' }).click();
    try {
      await page.getByText('A request was submitted, but current state could not be refreshed. Reconnect and inspect canonical history before retrying.', { exact: true }).waitFor({ timeout: 5000 });
    } catch (error) {
      throw new Error(`${error.message}; UI=${JSON.stringify(await page.locator('#titan-workforce').innerText())}; requests=${JSON.stringify(requests.slice(-8).map(item => ({ method: item.method, path: item.path })))}; accepted=${acceptedIntents.length}; projectionFlag=${denyNextProjection}`);
    }
    assert.equal(acceptedIntents.length, 5, 'the hosted intent was accepted before the projection refresh failed');
    assert.equal(await page.getByText('company-b', { exact: true }).count(), 0, 'denied refresh clears company data');
    assert.doesNotMatch(await page.locator('#titan-workforce').innerText(), /host denied that request/i,
      'a projection 403 after accepted ingress is not reported as an action denial');
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await page.getByText('company-b', { exact: true }).waitFor();

    await page.getByRole('button', { name: 'Governed actions', exact: true }).click();
    await page.getByLabel('Operation').selectOption('cancel');
    await page.getByLabel('Work item').selectOption('company-b-work');
    await page.getByLabel('Reason', { exact: true }).fill('Expired authorization acceptance fixture');
    expireNextIntent = true;
    const noncesBeforeStale = nonceRequests.length;
    await page.getByRole('button', { name: 'Submit governed request' }).click();
    await page.getByText('Context changed. Reconnect to load permitted Workforce.').waitFor();
    assert.equal(nonceRequests.length, noncesBeforeStale + 1,
      'a stale hosted session prefetches a role-local nonce for the next explicit reconnect');
    assert.equal(nonceRequests.at(-1).cookie.includes(sessionCookieName), true,
      'stale-session nonce request keeps cookie delivery in the browser');
    assert.equal(await page.getByText('company-b', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Submit governed request' }).count(), 0);
    assert.equal(await page.getByText('session-expired', { exact: true }).count(), 0, 'transport diagnostics are not rendered');
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await page.getByText('Current hosted projection', { exact: true }).waitFor();

    const logoutReceipt = await submitCancel(page, 'company-b', 'Logout receipt fixture');
    const helper = await context.newPage();
    await helper.goto(`${origin}/logout-helper`);
    await helper.waitForFunction(() => typeof window.logoutSharedSession === 'function');
    await helper.evaluate(() => window.logoutSharedSession());
    await page.getByText('Context changed. Reconnect to load permitted Workforce.').waitFor();
    assert.equal(await page.getByText('company-b', { exact: true }).count(), 0, 'shared logout invalidation clears company data');
    assert.equal(await page.getByText(logoutReceipt, { exact: true }).count(), 0, 'shared logout invalidation clears the latest receipt');
    assert.equal(await page.getByRole('button', { name: 'Submit governed request' }).count(), 0);
    assert.equal(requests.some(item => item.method === 'POST' && item.path === '/v1/directadmin/logout'), true, 'logout uses the shared SDK route');

    loggedOut = false;
    contextLifetimeMs = 6000;
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    try { await page.getByText('company-b', { exact: true }).waitFor({ timeout: 5000 }); }
    catch { throw new Error(`post-logout reconnect failed; ui=${JSON.stringify(await page.locator('#titan-workforce').innerText())}; raw=${JSON.stringify({ nonce: nonceRequests.slice(-3), bootstrap: bootstrapRequests.slice(-3) })}; relay=${JSON.stringify(requests.slice(-5).map(item => ({ path: item.path, status: item.status, code: item.code })))}; errors=${JSON.stringify(errors)}`); }
    await page.getByText('Current hosted projection', { exact: true }).waitFor();
    const timerReceipt = await submitCancel(page, 'company-b', 'Local expiry receipt fixture');
    const localExpiresAt = shortContextExpiresAt;
    const unauthorizedBeforeTimer = unauthorizedResponses;
    assert.ok(Number.isFinite(localExpiresAt));
    await page.getByText('Context changed. Reconnect to load permitted Workforce.', { timeout: 10_000 }).waitFor();
    assert.ok(Date.now() >= localExpiresAt, 'the SDK local expiry timer fires at/after expires_at');
    assert.equal(unauthorizedResponses, unauthorizedBeforeTimer, 'local expiry does not depend on an HTTP 401 response');
    assert.equal(await page.getByText('company-b', { exact: true }).count(), 0, 'the SDK local expires_at timer invalidates the real cockpit session');
    assert.equal(await page.getByText(timerReceipt, { exact: true }).count(), 0, 'local expiry clears a previously visible receipt');
    assert.equal(await page.getByRole('button', { name: 'Submit governed request' }).count(), 0);
    const nonceBeforeLocalReconnect = nonceRequests.length;
    const bootstrapBeforeLocalReconnect = bootstrapRequests.length;
    contextLifetimeMs = 60_000;
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await page.getByText('Current hosted projection', { exact: true }).waitFor();
    assert.equal(nonceRequests.length, nonceBeforeLocalReconnect + 1,
      'local expiry recovery obtains a fresh role-local nonce before bootstrap');
    assert.equal(bootstrapRequests.length, bootstrapBeforeLocalReconnect + 1,
      'local expiry recovery renews the session through bootstrap.raw');
    assert.equal(nonceRequests.at(-1).cookie.includes(sessionCookieName), true,
      'local expiry recovery leaves Titan cookie delivery to the browser');
    contextLifetimeMs = 15 * 60_000;
    controlCapabilitiesAvailable = false;
    const readOnlyBootstrapSession = await browserSessionCookie();
    assert.ok(readOnlyBootstrapSession);
    // Release the long-running lifecycle context before the independent
    // read-only context so Chromium does not retain two active pages.
    await context.close();
    const readOnlyContext = await browser.newContext({ ignoreHTTPSErrors: true });
    await addDirectAdminCookies(readOnlyContext);
    await readOnlyContext.addCookies([{
      name: sessionCookieName,
      value: readOnlyBootstrapSession.slice(sessionCookieName.length + 1),
      url: origin,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    }]);
    const readOnlyPage = await readOnlyContext.newPage();
    readOnlyPage.on('pageerror', error => errors.push(error.message));
    await readOnlyPage.goto(origin);
    await readOnlyPage.getByText('company-b', { exact: true }).waitFor();
    const intentCountBeforeReadOnlyView = requests.filter(item => item.method === 'POST' && item.path === '/v1/directadmin/titan_workforce/intents').length;
    await readOnlyPage.getByRole('button', { name: 'Governed actions', exact: true }).click();
    await readOnlyPage.getByText('This is a read-only Workforce projection. The canonical owner has not exposed an authorized lifecycle control; no request was sent.', { exact: true }).waitFor();
    assert.equal(await readOnlyPage.getByRole('button', { name: 'Submit governed request' }).count(), 0);
    assert.equal(requests.filter(item => item.method === 'POST' && item.path === '/v1/directadmin/titan_workforce/intents').length, intentCountBeforeReadOnlyView);
    await readOnlyContext.close();
    for (const item of nonceRequests) {
      assert.equal(item.search, '?headers_to_env=yes&pipe_post=yes', 'nonce uses the exact RAW query');
      assert.equal(item.method, 'POST');
      assert.equal(item.contentType, null, 'nonce request has no Content-Type');
      assert.equal(item.bodyLength, 0, 'nonce request body is empty');
      assert.equal(item.origin, origin);
      assert.equal(item.secFetchSite, 'same-origin');
    }
    for (const item of bootstrapRequests) {
      assert.equal(item.search, '?headers_to_env=yes&pipe_post=yes', 'bootstrap uses the exact RAW query');
      assert.equal(item.method, 'POST');
      assert.equal(item.contentType, null, 'bootstrap request has no Content-Type');
      assert.equal(item.bodyLength, 0, 'bootstrap request body is empty');
      assert.equal(item.origin, origin);
      assert.equal(item.secFetchSite, 'same-origin');
      assert.match(item.nonceHeader, /^[A-Za-z0-9_-]{43,128}$/);
    }
    assert.equal(privateNonceRequests.length, nonceRequests.length, 'every browser nonce request reached the packaged RAW adapter and private route');
    assert.equal(privateBootstrapRequests.length, bootstrapRequests.length, 'every browser bootstrap request reached the packaged RAW adapter and private route');
    for (const item of privateNonceRequests) {
      assert.equal(item.cookie, daCookieHeader, 'nonce forwarding strips the browser-managed Titan session cookie');
      assert.equal(item.csrf, null, 'nonce forwarding carries no bootstrap CSRF token');
    }
    for (const item of privateBootstrapRequests) {
      const expectedCookie = item.expectedSessionCookie
        ? `${daCookieHeader}; ${item.expectedSessionCookie}` : daCookieHeader;
      assert.equal(item.cookie, expectedCookie,
        'bootstrap sends DirectAdmin cookies plus the prior Titan cookie when renewing an active session');
      assert.notEqual(item.issuedSessionCookie, item.expectedSessionCookie,
        'each successful bootstrap issues a new session cookie value');
      assert.match(item.csrf, /^[A-Za-z0-9_-]{43,128}$/);
    }
    assert.equal(new Set(issuedSessionCookies).size, issuedSessionCookies.length,
      'every bootstrap response rotates to a distinct host session value');
    for (const item of requests.filter(item => item.path.startsWith('/v1/directadmin/'))) {
      assert.equal(item.headers['x-titan-csrf'], csrf, 'shared SDK supplies its bootstrapped nonce');
      assert.equal(item.headers.cookie?.includes(sessionCookieName), true, 'same-origin requests retain the host cookie');
      assert.equal(item.headers['sec-fetch-site'], 'same-origin', 'browser marks requests as same-origin');
      if (item.method === 'POST') assert.equal(item.headers.origin, origin, 'mutations remain same-origin');
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server?.close(resolve));
    if (privateServer?.listening) {
      privateServer.closeAllConnections();
      await new Promise(resolve => privateServer.close(resolve));
    }
    await rm(folder, { recursive: true, force: true });
  }
});
