import { tsImport } from 'tsx/esm/api';
const security = await tsImport('../../src/security-boundary.ts', { parentURL: import.meta.url, tsconfig: false });
const bridgeApi = await tsImport('../../src/directadmin-session-bridge.ts', { parentURL: import.meta.url, tsconfig: false });
const zeroCockpit = await tsImport('../../src/zero-cockpit.ts', { parentURL: import.meta.url, tsconfig: false });
const operationsHealth = await tsImport('../../src/operations-health.ts', { parentURL: import.meta.url, tsconfig: false });
const brandPublication = await tsImport('../../src/brand-publication.ts', { parentURL: import.meta.url, tsconfig: false });
const { createIdentitySessionRegistry, createSessionCredentialService, createSessionCredentialVerifier } = security;
const { DirectAdminSessionBridge } = bridgeApi;
const { projectZeroCockpit } = zeroCockpit;
const { createOperationsHealth } = operationsHealth;
const { createBrandPublication, createBrandStudioProjection } = brandPublication;
const { createSqliteStorage } = await tsImport('@titan-zero/storage', { parentURL: import.meta.url, tsconfig: false });
export const ORIGIN = 'https://panel.example.test';
export const b64 = value => Buffer.from(value).toString('base64url');
export const encode = value => b64(JSON.stringify(value));
export const external = { provider: 'directadmin:https://panel.example.test', subject: 'host-human-17' };
const nonce = 'fixture-login-nonce';
const sessionId = 'auth-' + Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(JSON.stringify([external.provider, nonce])))).toString('hex');
export const proof = { ...external, session_id: sessionId, device_id: 'device-1', session_revision: 1 };
export const expected = { company_id: 'company-a', audience: 'titan-directadmin:node-1' };
export const csrf = b64(crypto.getRandomValues(new Uint8Array(32)));

export async function fixture(t, { origin = ORIGIN, provider = external.provider, sessionOverrides = {}, storagePath = ':memory:' } = {}) {
  const externalIdentity = { provider, subject: external.subject };
  const now = Math.floor(Date.now() / 1000) * 1000;
  let clock = now;
  const storage = createSqliteStorage(storagePath);
  t.after(() => storage.close());
  const registry = await createIdentitySessionRegistry({ storage, storage_role: 'GLOBAL_REGISTRY' });
  await registry.putActor({ actor_id: 'actor-1', status: 'active' }, null);
  await registry.putDevice({ actor_id: 'actor-1', device_id: 'device-1', status: 'active' }, null);
  for (const company_id of ['company-a', 'company-b']) {
    await registry.putCompany({ company_id, status: 'active' }, null);
    await registry.putMembership({ actor_id: 'actor-1', company_id, role: 'member', status: 'active' }, null);
    await registry.putExternalBinding({ ...externalIdentity, binding_id: `mapping-${company_id}`, company_id, actor_id: 'actor-1', status: 'active' }, null);
  }
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const upstreamKeys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const workforceKeys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const policy = { issuer: 'titan:node-1', audience: expected.audience, key_id: 'key-1', algorithm: 'EdDSA',
    verification_key: keys.publicKey, signing_key: keys.privateKey, registry, lifetime_seconds: 300,
    upstream: { issuer: externalIdentity.provider, audience: 'titan-login:node-1', key_id: 'upstream-1', algorithm: 'EdDSA', verification_key: upstreamKeys.publicKey },
    directadmin: { node_id: 'node-1' },
    workforce_zero_exchange: { issuer: 'titan:workforce', key_id: 'workforce-1', algorithm: 'EdDSA',
      verification_key: workforceKeys.publicKey, signing_key: workforceKeys.privateKey, lifetime_seconds: 120 },
    now: () => new Date(clock) };
  const sessions = createSessionCredentialService(policy);
  const workforceVerifier = createSessionCredentialVerifier({
    registry, upstream: policy.upstream, issuer: 'titan:workforce', audience: 'workforce', key_id: 'workforce-1',
    algorithm: 'EdDSA', verification_key: workforceKeys.publicKey, lifetime_seconds: 120,
    directadmin: { node_id: 'node-1' }, now: () => new Date(clock),
  });
  const loginClaims = { iss: externalIdentity.provider, sub: externalIdentity.subject, aud: policy.upstream.audience,
    jti: nonce, company_id: 'company-a', device_id: 'device-1', node_id: 'node-1',
    csrf_sha256: b64(await crypto.subtle.digest('SHA-256', Buffer.from(csrf))), da_role: 'admin', iat: now / 1000, exp: now / 1000 + 120 };
  const loginPayload = `${encode({ alg: 'EdDSA', typ: 'titan-login+jwt', kid: 'upstream-1' })}.${encode(loginClaims)}`;
  const upstreamToken = `${loginPayload}.${b64(await crypto.subtle.sign('Ed25519', upstreamKeys.privateKey, Buffer.from(loginPayload)))}`;
  const issued = await sessions.issue(upstreamToken, { company_id: 'company-a', device_id: 'device-1' });
  const token = issued.credential;
  const loginFor = async (provider, jti, changes = {}) => {
    const payload = `${encode({ alg: 'EdDSA', typ: 'titan-login+jwt', kid: 'upstream-1' })}.${encode({ ...loginClaims, ...changes, iss: provider, jti })}`;
    return `${payload}.${b64(await crypto.subtle.sign('Ed25519', upstreamKeys.privateKey, Buffer.from(payload)))}`;
  };
  // Fixture-only inspection of a credential just issued through the canonical service.
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const sign = async (patch = {}, header = {}, privateKey = keys.privateKey) => {
    const payload = `${encode({ alg: 'EdDSA', typ: 'titan-session+jwt', kid: 'key-1', ...header })}.${encode({ ...claims, ...patch })}`;
    return `${payload}.${b64(await crypto.subtle.sign('Ed25519', privateKey, Buffer.from(payload)))}`;
  };
  const bridgeSessions = { ...sessions, ...sessionOverrides };
  const bridge = new DirectAdminSessionBridge({ origin, audience: expected.audience, node_id: 'node-1', sessions: bridgeSessions });
  const request = (path = '/v1/directadmin/context', options = {}) => {
    const headers = new Headers({ origin, 'sec-fetch-site': 'same-origin', 'x-titan-csrf': csrf,
      cookie: `__Host-titan-da-session=${token}` });
    for (const [k, v] of Object.entries(options.headers ?? {})) {
      if (v === null) headers.delete(k); else headers.set(k, v);
    }
    return new Request(options.url ?? `${origin}${path}`, { method: options.method ?? 'GET', headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.signal === undefined ? {} : { signal: options.signal }) });
  };
  const effects = [];
  const owners = {
    projection: async (plugin, context) => {
      const company_id = context.company_id;
      const time = new Date(clock).toISOString();
      const data = plugin === 'titan_zero' ? projectZeroCockpit({ company_id, generated_at: time, attention: [] })
        : plugin === 'titan_operations' ? createOperationsHealth({ company_id, observed_at: time, nodes: [] })
        : createBrandStudioProjection({ company_id, generated_at: time, surfaces: [], publications: [
          createBrandPublication({ company_id, publication_id: 'publication-1', site_id: 'site-1', version: 1,
            source_snapshot_hash: 'hash-1', route_manifest: ['/'], created_at: time }),
        ] });
      return { company_id, source: plugin, freshness: time, evidence_refs: [], data };
    },
    requestIntent: async (_plugin, intent, context, revalidate) => {
      const latest = await revalidate(); effects.push({ intent, context: latest }); return { receipt_id: 'receipt-1' };
    },
    receipt: async () => null,
  };
  return { storage, registry, sessions, bridgeSessions, workforceVerifier, workforceKeys, policy, upstreamToken, upstreamKeys,
    loginFor, bridge, request, token, claims, sign, owners, effects, now, setClock: value => { clock = value; } };
}
