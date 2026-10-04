import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair } from 'jose';
import { tsImport } from 'tsx/esm/api';

const security = await tsImport('../.test-dist/security-boundary.js', { parentURL: import.meta.url, tsconfig: false });
const bridgeApi = await tsImport('../.test-dist/directadmin-session-bridge.js', { parentURL: import.meta.url, tsconfig: false });
const gatewayApi = await tsImport('../.test-dist/directadmin-gateway.js', { parentURL: import.meta.url, tsconfig: false });
const cockpitApi = await tsImport('../.test-dist/directadmin-cockpit.js', { parentURL: import.meta.url, tsconfig: false });
const { createSqliteStorage } = await tsImport('@titan-zero/storage', { parentURL: import.meta.url, tsconfig: false });

const ORIGIN = 'https://panel.example.test:2222';
const ISSUER = security.directAdminIssuer(ORIGIN);
const NODE_ID = 'business-node-a';
const AUDIENCE = `titan-directadmin:${NODE_ID}`;
const DA_COOKIE = 'session=fixture-da-session; key=fixture-da-key';
const apiSession = Object.freeze({ effectiveRole: 'user', effectiveUsername: 'effective-account', realUsername: 'operator-admin' });

test('canonical #302 bootstrap authenticates DirectAdmin, issues selected-company session, and rotates the shared SDK context', async t => {
  const now = () => new Date();
  const storage = createSqliteStorage(':memory:');
  t.after(() => storage.close());
  const registry = await security.createIdentitySessionRegistry({ storage, storage_role: 'GLOBAL_REGISTRY', now });
  await security.initializeDirectAdminBootstrapNonceStore({ storage, storage_role: 'GLOBAL_REGISTRY' });

  await registry.putActor({ actor_id: 'actor-canonical-1', status: 'active' }, null);
  for (const company_id of ['company-selected', 'company-other']) {
    await registry.putCompany({ company_id, status: 'active' }, null);
    await registry.putMembership({ actor_id: 'actor-canonical-1', company_id, role: 'member', status: 'active' }, null);
    await registry.putExternalBinding({ binding_id: `binding-${company_id}`, provider: ISSUER,
      subject: 'effective-account', actor_id: 'actor-canonical-1', company_id, status: 'active' }, null);
  }
  await registry.putDevice({ actor_id: 'actor-canonical-1', device_id: 'device-a', status: 'active' }, null);

  const loginKeys = await generateKeyPair('EdDSA');
  const sessionKeys = await generateKeyPair('EdDSA');
  const upstream = { issuer: ISSUER, audience: 'titan-login', key_id: 'directadmin-login-a',
    algorithm: 'EdDSA', verification_key: loginKeys.publicKey };
  const sessions = security.createSessionCredentialService({
    registry,
    issuer: 'titan:directadmin-node-a',
    audience: AUDIENCE,
    key_id: 'directadmin-session-a',
    algorithm: 'EdDSA',
    verification_key: sessionKeys.publicKey,
    signing_key: sessionKeys.privateKey,
    upstream,
    directadmin: { node_id: NODE_ID },
    lifetime_seconds: 300,
    now,
  });

  const apiCalls = [];
  const directAdminFetcher = async (url, init) => {
    apiCalls.push({ url: String(url), init });
    assert.equal(String(url), `${ORIGIN}/api/session`);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.cookie, DA_COOKIE);
    assert.equal(init.headers.authorization, undefined);
    const body = JSON.stringify(apiSession);
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)) } });
  };
  const flow = security.createDirectAdminBootstrapFlow({ origin: ORIGIN, node_id: NODE_ID, upstream,
    signing_key: loginKeys.privateKey, registry, fetcher: directAdminFetcher, now });

  // Trusted page composition selects one already-canonical company/device.
  // The browser receives only this opaque, one-time challenge.
  const nonce = await flow.issueNonce({ origin: ORIGIN, cookie: DA_COOKIE, authorization: null,
    company_id: 'company-selected', device_id: 'device-a' });
  assert.deepEqual(Object.keys(nonce).sort(), ['csrf_nonce', 'expires_at']);
  assert.match(nonce.csrf_nonce, /^[A-Za-z0-9_-]{43}$/);
  const nonceRows = (await storage.query('SELECT * FROM titan_security_directadmin_bootstrap_nonces')).rows;
  assert.equal(nonceRows.length, 1);
  assert.equal(JSON.stringify(nonceRows).includes(DA_COOKIE), false);
  assert.equal(nonceRows[0].company_id, 'company-selected');
  assert.equal(nonceRows[0].device_id, 'device-a');

  const bridge = new bridgeApi.DirectAdminSessionBridge({ origin: ORIGIN, audience: AUDIENCE, node_id: NODE_ID, sessions });
  const projectedCompanies = [];
  const receiptReads = [];
  const gateway = gatewayApi.createDirectAdminGateway(bridge, {
    projection: async (plugin, context) => {
      projectedCompanies.push({ plugin, company_id: context.company_id });
      return { company_id: context.company_id, source: `canonical-${plugin}`, freshness: new Date().toISOString(),
        evidence_refs: [], data: { schema: 'titan.directadmin.integration-projection/v1', company_id: context.company_id } };
    },
    receipt: async (plugin, receipt_id, context) => {
      receiptReads.push({ plugin, receipt_id, actor_id: context.actor_id, company_id: context.company_id,
        company_ids: [...context.company_ids] });
      return Object.freeze({ schema: 'titan.directadmin.workforce-receipt.v1', company_id: context.company_id,
        receipt_id, operation_id: 'operation-receipt-1', correlation_id: 'correlation-receipt-1', work_id: 'work-1',
        state: 'VERIFIED', verification_status: 'verified',
        verification_method: 'company-scoped-workforce-reread-and-reassignment-event', evidence_refs: [receipt_id] });
    },
    requestIntent: async () => { throw new Error('intent-not-used-in-read-only-integration'); },
  }, flow);

  // Browser-provided identity headers/body cannot change the server-bound nonce selection.
  const malicious = await gateway(new Request(`${ORIGIN}/v1/directadmin/bootstrap`, { method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-titan-da-bootstrap-csrf': nonce.csrf_nonce,
      cookie: DA_COOKIE, 'x-titan-company-id': 'company-other', 'x-titan-actor-id': 'caller-root', caller_id: 'root',
      'content-type': 'application/json' }, body: JSON.stringify({ company_id: 'company-other', actor_id: 'root' }) }));
  assert.equal(malicious.status, 401);
  assert.equal(malicious.headers.has('set-cookie'), false);
  assert.equal(apiCalls.length, 1, 'request body is rejected before the DA session provider runs');
  assert.equal((await malicious.text()).includes(DA_COOKIE), false);

  let browserCookie = DA_COOKIE;
  let browserCsrf = null;
  const invalidations = [];
  const fetcher = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('origin', ORIGIN);
    headers.set('sec-fetch-site', 'same-origin');
    headers.set('cookie', browserCookie);
    const request = new Request(new URL(String(input), ORIGIN), { method: init.method ?? 'GET', headers,
      ...(init.body === undefined ? {} : { body: init.body }) });
    const response = await gateway(request);
    if (new URL(String(input), ORIGIN).pathname === '/v1/directadmin/bootstrap' && response.ok) {
      browserCsrf = (await response.clone().json()).csrf_token;
    }
    const setCookie = response.headers.get('set-cookie');
    const issued = setCookie?.match(/^__Host-titan-da-session=([^;]*)/)?.[1];
    if (issued !== undefined) {
      browserCookie = issued ? `${DA_COOKIE}; __Host-titan-da-session=${issued}` : DA_COOKIE;
    }
    return response;
  };
  const session = new cockpitApi.DirectAdminCockpitSession(() => nonce.csrf_nonce, fetcher, undefined);
  t.after(() => session.dispose());
  session.subscribe(() => invalidations.push(true));

  const firstContext = await session.connect();
  assert.equal(firstContext.actor_id, 'actor-canonical-1');
  assert.equal(firstContext.company_id, 'company-selected');
  assert.deepEqual(firstContext.company_ids, ['company-selected']);
  assert.equal(firstContext.da_role, 'user');
  assert.equal(firstContext.authority, 'not-carried');
  assert.equal(firstContext.allowed_company_ids, undefined);
  assert.equal(apiCalls.length, 2, 'both nonce issuance and redemption reauthenticate the DirectAdmin cookies');

  const projections = await Promise.all(['titan_zero', 'titan_operations', 'titan_web']
    .map(plugin => session.projection(plugin)));
  assert.deepEqual(projections.map(value => value.company_id), ['company-selected', 'company-selected', 'company-selected']);
  assert.deepEqual(projectedCompanies.map(value => value.company_id), ['company-selected', 'company-selected', 'company-selected']);
  const selectedReceipt = await session.receipt('titan_workforce', 'accepted-evidence-selected');
  assert.equal(selectedReceipt.company_id, 'company-selected');
  assert.equal(selectedReceipt.state, 'VERIFIED');
  assert.deepEqual(receiptReads, [{ plugin: 'titan_workforce', receipt_id: 'accepted-evidence-selected',
    actor_id: 'actor-canonical-1', company_id: 'company-selected', company_ids: ['company-selected'] }]);

  // A real company switch changes the canonical session revision and purges every consumer.
  await session.switchCompany('company-other');
  assert.equal(invalidations.length, 2);
  const switched = await session.connect();
  assert.equal(switched.actor_id, 'actor-canonical-1');
  assert.equal(switched.company_id, 'company-other');
  assert.deepEqual(switched.company_ids, ['company-other']);
  const switchedProjection = await session.projection('titan_zero');
  assert.equal(switchedProjection.company_id, 'company-other');
  assert.deepEqual(projectedCompanies.at(-1), { plugin: 'titan_zero', company_id: 'company-other' });
  const switchedReceipt = await session.receipt('titan_workforce', 'accepted-evidence-other');
  assert.equal(switchedReceipt.company_id, 'company-other');
  assert.deepEqual(receiptReads.at(-1), { plugin: 'titan_workforce', receipt_id: 'accepted-evidence-other',
    actor_id: 'actor-canonical-1', company_id: 'company-other', company_ids: ['company-other'] });

  // Reusing the consumed page nonce cannot mint a second Titan identity.
  const replay = await gateway(new Request(`${ORIGIN}/v1/directadmin/bootstrap`, { method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-titan-da-bootstrap-csrf': nonce.csrf_nonce,
      cookie: DA_COOKIE, 'content-length': '0' }, body: '' }));
  assert.equal(replay.status, 401);
  assert.equal(replay.headers.has('set-cookie'), false);
  assert.equal((await replay.text()).includes(nonce.csrf_nonce), false);

  // Revocation/context revision changes are checked by the canonical resolver before reads.
  await registry.putMembership({ actor_id: 'actor-canonical-1', company_id: 'company-other',
    role: 'member', status: 'revoked' }, 1);
  const revoked = await gateway(new Request(`${ORIGIN}/v1/directadmin/context`, { headers: {
    origin: ORIGIN, 'sec-fetch-site': 'same-origin', cookie: browserCookie,
    'x-titan-csrf': browserCsrf,
  } }));
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.text()).includes(browserCookie), false);
});
