import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, readFile, readdir, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';

const OWNER_HEAD = '0599ef2c2217a1fba0839cea4afd2304a8e53f43';
const OWNER_TREE_SHA256 = '60f101d5ff91b7e772f56bdce85e86398c3fe2cd397c34caf1f173d43cc5fe62';
const SDK_HEAD = '9a7a39470fae1173cab14653db7e2fe472322ffb';
const SDK_BUNDLE_SHA256 = '95e3c1df84f624d0c404ddbf6fc666ae44c161a7e358d391358077888a7c0727';
const PACKAGE_SOURCE_HEAD = '48d1c57c457e2da5d84fe343bb95af53f684eb87';
const PACKAGE_TREE_SHA256 = '00bb692d5ea605dbee50c64833a4f202dd41ac7978ed1d17e929f65c77775c21';
const ownerRoot = requiredPath('TITAN_WORKFORCE_OWNER_ROOT');
const packageRoot = requiredPath('TITAN_WORKFORCE_PACKAGE_ROOT');
const ownerRequire = createRequire(pathToFileURL(join(ownerRoot, 'packages/titan-platform/package.json')));
const storageRequire = createRequire(pathToFileURL(join(ownerRoot, 'packages/storage/package.json')));
const { SignJWT } = ownerRequire('jose');
const { tsImport } = ownerRequire('tsx/esm/api');
assert.equal(process.env.TITAN_WORKFORCE_OWNER_COMMIT, OWNER_HEAD,
  'this integration must use the live #1253 owner source head recorded in its evidence');
assert.equal(await sourceTreeSha256(ownerRoot), OWNER_TREE_SHA256,
  'the extracted owner source tree must match the recorded #1253 archive contents');
assert.equal(process.env.TITAN_COCKPIT_SDK_COMMIT, SDK_HEAD,
  'this integration must use the live #1252 shared SDK head recorded in its evidence');
assert.equal(process.env.TITAN_WORKFORCE_PACKAGE_SOURCE_COMMIT, PACKAGE_SOURCE_HEAD,
  'this integration must use the recorded #1260 package source commit');
assert.equal(await sourceTreeSha256(packageRoot), PACKAGE_TREE_SHA256,
  'the extracted plugin package must match the recorded package candidate contents');
const sdkPath = join(packageRoot, 'images/sdk.mjs');
assert.equal(createHash('sha256').update(await readFile(sdkPath)).digest('hex'), SDK_BUNDLE_SHA256,
  'the packaged SDK must match the byte-pinned artifact from the recorded #1252 head');
const SDK = await import(pathToFileURL(sdkPath).href);
const { WorkforceApi } = await import(pathToFileURL(join(packageRoot, 'images/api.mjs')).href);
const controllerSource = (await readFile(join(packageRoot, 'images/controller.mjs'), 'utf8'))
  .replace("'workforce-presentation'", JSON.stringify(pathToFileURL(join(packageRoot, 'images/presentation.mjs')).href));
const { WorkforceController } = await import(`data:text/javascript;base64,${Buffer.from(controllerSource).toString('base64')}`);

function requiredPath(name) {
  const value = process.env[name];
  assert.ok(value, `${name} must point to the exact extracted owner source or compiled SDK`);
  return resolve(value);
}
async function sourceTreeSha256(root) {
  const hash = createHash('sha256');
  async function visit(directory, relative = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const pathFromRoot = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      hash.update(`${pathFromRoot}\0`);
      if (entry.isDirectory()) {
        hash.update('directory\0');
        await visit(absolute, pathFromRoot);
      } else if (entry.isSymbolicLink()) {
        hash.update('symlink\0');
        hash.update(await readlink(absolute));
        hash.update('\0');
      } else if (entry.isFile()) {
        hash.update('file\0');
        hash.update(await readFile(absolute));
        hash.update('\0');
      } else {
        throw new Error(`unsupported owner archive entry: ${pathFromRoot}`);
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}
function ownerFile(relative) { return pathToFileURL(join(ownerRoot, relative)).href; }
async function ownerTs(relative) {
  return tsImport(ownerFile(relative), { parentURL: import.meta.url, tsconfig: false });
}
function b64(value) { return Buffer.from(value).toString('base64url'); }
function count(result) { return Number(result.rows[0]?.total ?? 0); }
function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
function submitWithSdkIntentSignal(controller, action, signal) {
  const originalTimeout = AbortSignal.timeout;
  let timeoutCalls = 0;
  let injected = false;
  const replacement = function (milliseconds) {
    timeoutCalls++;
    // WorkforceApi submit performs context and projection preflight before it
    // sends the intent. Replace only the third SDK request's timeout signal.
    if (timeoutCalls === 3) {
      injected = true;
      AbortSignal.timeout = originalTimeout;
      return signal;
    }
    return originalTimeout.call(AbortSignal, milliseconds);
  };
  AbortSignal.timeout = replacement;
  const promise = controller.submit(action).finally(() => {
    if (AbortSignal.timeout === replacement) AbortSignal.timeout = originalTimeout;
  });
  return { promise, wasInjected: () => injected, timeoutCalls: () => timeoutCalls };
}
async function settlesWithin(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
function queryLocal(address, pathname, init) {
  return new Promise((resolvePromise, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: address.port, path: pathname,
      method: init.method, headers: init.headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) headers.set(name, value.join(', '));
          else if (typeof value === 'string') headers.set(name, value);
        }
        resolvePromise(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500, headers }));
      });
    });
    request.once('error', reject);
    if (init.body !== undefined) request.end(init.body);
    else request.end();
  });
}
async function makeIdentityBridge(storage, origin) {
  const security = await ownerTs('packages/titan-platform/src/security-boundary.ts');
  const { DirectAdminSessionBridge } = await ownerTs('packages/titan-platform/src/directadmin-session-bridge.ts');
  const { createIdentitySessionRegistry, createSessionCredentialService,
    createSessionCredentialVerifier, directAdminIssuer } = security;
  const registry = await createIdentitySessionRegistry({ storage, storage_role: 'GLOBAL_REGISTRY' });
  const provider = directAdminIssuer(origin);
  const node_id = 'node-1050-owner-e2e';
  const device_id = 'device-1050-owner-e2e';
  const actor_id = 'actor-1050-owner-e2e';
  const audience = 'titan-login:node-1050-owner-e2e';
  const upstream = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const directadmin = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const workforce = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const upstreamTrust = { issuer: provider, audience, key_id: 'upstream-e2e', algorithm: 'EdDSA', verification_key: upstream.publicKey };
  const daAudience = 'titan-directadmin:node-1050-owner-e2e';
  const csrf = b64(randomBytes(32));
  const csrf_sha256 = b64(createHash('sha256').update(csrf).digest());
  const now = Math.floor(Date.now() / 1000);
  const currentTime = () => new Date();

  await registry.putActor({ actor_id, status: 'active' }, null);
  await registry.putDevice({ actor_id, device_id, status: 'active' }, null);
  for (const company_id of ['company-a', 'company-b']) {
    await registry.putCompany({ company_id, status: 'active' }, null);
    await registry.putMembership({ actor_id, company_id, role: 'owner', status: 'active' }, null);
    await registry.putExternalBinding({ provider, subject: 'human-1050-e2e', binding_id: `binding-${company_id}`,
      actor_id, company_id, status: 'active' }, null);
  }

  const directadminService = createSessionCredentialService({ registry, upstream: upstreamTrust,
    issuer: 'titan:node-1050-owner-e2e', audience: daAudience, key_id: 'da-e2e', algorithm: 'EdDSA',
    verification_key: directadmin.publicKey, signing_key: directadmin.privateKey,
    directadmin: { node_id }, lifetime_seconds: 300,
    workforce_zero_exchange: { issuer: 'titan:workforce', key_id: 'workforce-e2e', algorithm: 'EdDSA',
      verification_key: workforce.publicKey, signing_key: workforce.privateKey, lifetime_seconds: 120 },
    now: currentTime });
  const workforceVerifier = createSessionCredentialVerifier({ registry, upstream: upstreamTrust,
    issuer: 'titan:workforce', audience: 'workforce', key_id: 'workforce-e2e', algorithm: 'EdDSA',
    verification_key: workforce.publicKey, lifetime_seconds: 120, directadmin: { node_id }, now: currentTime });
  const login = await new SignJWT({ company_id: 'company-a', device_id, jti: `login-${randomBytes(12).toString('hex')}`,
    node_id, da_role: 'user', csrf_sha256 })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'upstream-e2e', typ: 'titan-login+jwt' })
    .setIssuer(provider).setAudience(audience).setSubject('human-1050-e2e')
    .setIssuedAt(now).setExpirationTime(now + 120).sign(upstream.privateKey);
  const issued = await directadminService.issue(login, { company_id: 'company-a', device_id });
  const bridge = new DirectAdminSessionBridge({ origin, audience: daAudience, node_id, sessions: directadminService });
  const consumedBootstrapNonces = new Set();
  const bootstrapProvider = Object.freeze({ provide: async proof => {
    assert.equal(proof.origin, origin);
    assert.equal(proof.cookie, 'session=fixture-da-session; key=fixture-da-key',
      'the host bootstrap provider receives only canonical DirectAdmin cookies, never the Titan cookie');
    assert.equal(proof.authorization, null);
    assert.equal(typeof proof.csrf_nonce, 'string');
    assert.equal(consumedBootstrapNonces.has(proof.csrf_nonce), false, 'a bootstrap nonce is consumed once');
    consumedBootstrapNonces.add(proof.csrf_nonce);
    const csrf_token = b64(randomBytes(32));
    const nextCsrfHash = b64(createHash('sha256').update(csrf_token).digest());
    const issuedAt = Math.floor(Date.now() / 1000);
    const login_assertion = await new SignJWT({ company_id: 'company-a', device_id,
      jti: `browser-bootstrap-${proof.csrf_nonce}`, node_id, da_role: 'user', csrf_sha256: nextCsrfHash })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'upstream-e2e', typ: 'titan-login+jwt' })
      .setIssuer(provider).setAudience(audience).setSubject('human-1050-e2e')
      .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 120).sign(upstream.privateKey);
    return Object.freeze({ login_assertion, company_id: 'company-a', device_id, csrf_token });
  } });
  return { registry, bridge, bootstrapProvider, workforceVerifier, csrf, token: issued.credential, actor_id, device_id };
}

async function makeHarness() {
  const scratch = await mkdtemp(join(tmpdir(), '1050-actual-owner-'));
  let host;
  let server;
  let seedStorage;
  let identityStorage;
  let placementStorage;
  let session;
  let unsubscribe;
  let directGateway;
  let nextDirectIntent = false;
  let afterSqliteCommit = null;
  let restoreSqliteExec;
  const intentResponses = [];
  const receiptResponses = [];
  const close = async () => {
    afterSqliteCommit = null;
    session?.dispose();
    unsubscribe?.();
    try { server?.closeAllConnections(); } catch { /* already closed */ }
    await host?.close().catch(() => {});
    restoreSqliteExec?.();
    await seedStorage?.close().catch(() => {});
    await placementStorage?.close().catch(() => {});
    await identityStorage?.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  };
  try {
    const { createSqliteStorage, initializeSqliteCompanyPlacementRegistry,
      createSqliteCompanyPlacementRegistry, createSqliteCompanyStoreOpener } = await ownerTs('packages/storage/src/index.ts');
    const { createWorkforceServer } = await ownerTs('services/workforce/src/server.ts');
    const { SqliteWorkforceStore } = await ownerTs('services/workforce/src/sqlite-store.ts');
    const Database = storageRequire('better-sqlite3');
    const originalSqliteExec = Database.prototype.exec;
    Database.prototype.exec = function (sql, ...args) {
      const result = originalSqliteExec.call(this, sql, ...args);
      const gate = afterSqliteCommit;
      if (gate && /^\s*COMMIT\s*;?\s*$/i.test(String(sql))) {
        let committed;
        try {
          committed = this.prepare(`SELECT event_seq FROM workforce_events WHERE company_id=? AND work_id=?
            AND type='work.reassigned' AND json_extract(payload,'$.operation_id')=?`).get(
            gate.companyId, gate.workId, gate.operationId);
        } catch { /* other isolated SQLite files do not own Workforce events */ }
        if (committed) {
          afterSqliteCommit = null;
          gate.entered.resolve(committed);
          gate.abort();
        }
      }
      return result;
    };
    restoreSqliteExec = () => { Database.prototype.exec = originalSqliteExec; };
    const { SqliteWorkerAccessStore, SqliteAuthorityStore } = await import(ownerFile('packages/runtime/authority/index.mjs'));
    const identityPath = join(scratch, 'identity.sqlite');
    const workforcePath = join(scratch, 'workforce.sqlite');
    identityStorage = createSqliteStorage(identityPath);
    const auth = await makeIdentityBridge(identityStorage, 'https://panel.example.test');
    await initializeSqliteCompanyPlacementRegistry({ storage: identityStorage, storage_role: 'GLOBAL_REGISTRY' });
    for (const [company_id, placement_id] of [['company-a', 'fixture-company-a'], ['company-b', 'fixture-company-b']]) {
      await identityStorage.query(`INSERT INTO titan_company_storage_placements
        (company_id,placement_id,placement_revision,provider,schema_version,status)
        VALUES ($1,$2,1,'sqlite','native-fsm/1','READY')`, [company_id, placement_id]);
    }
    placementStorage = createSqliteStorage(identityPath);
    const companyPlacementRegistry = await createSqliteCompanyPlacementRegistry({ storage: placementStorage, storage_role: 'GLOBAL_REGISTRY' });
    const companyStoreRoot = join(scratch, 'company-stores');
    await mkdir(companyStoreRoot, { mode: 0o700 });
    const companyStoreOpener = createSqliteCompanyStoreOpener({ companyStoreRoot });

    const credentialVerifier = {
      async verify(authorization, options = {}) {
        options.signal?.throwIfAborted();
        const match = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/.exec(authorization ?? '');
        if (!match) throw new Error('authentication-denied');
        const value = await auth.workforceVerifier.authenticate(match[1]);
        options.signal?.throwIfAborted();
        return { provider: value.provider, subject: value.subject, session_id: value.context.session_id,
          device_id: value.context.device_id, session_revision: value.context.session_revision,
          credential_expires_at: value.credential_expires_at, source_session: value.source_session,
          audience: value.context.audience, surface: value.surface };
      },
    };
    host = await createWorkforceServer({ storagePath: workforcePath, dependencies: {
      identityStoragePath: identityPath, credentialVerifier, companyPlacementRegistry, companyStoreOpener,
      workOrders: { async read() { throw new Error('unexpected-owner-e2e-work-order-read'); },
        async complete() { throw new Error('unexpected-owner-e2e-work-order-complete'); } },
      readiness: async () => ({ authentication: true, authority: true, provider: true, evidence: true }),
      directAdmin: { publicOrigin: 'https://panel.example.test',
        createGateway: owners => {
          directGateway = SDK.createDirectAdminGateway(auth.bridge, owners, auth.bootstrapProvider);
          return directGateway;
        } },
    } });
    server = host.server;
    const address = await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolvePromise(server.address()));
    });

    seedStorage = createSqliteStorage(workforcePath);
    const workforceStore = new SqliteWorkforceStore(seedStorage);
    await workforceStore.migrate();
    const at = new Date().toISOString();
    const managerWorker = 'manager-worker-a';
    const workers = [
      { company_id: 'company-a', worker_id: managerWorker, kind: 'human', active: true, capabilities: [], human_identity_ref: auth.actor_id },
      { company_id: 'company-a', worker_id: 'worker-old', kind: 'digital', active: true, capabilities: ['work.assign'] },
      { company_id: 'company-a', worker_id: 'worker-target', kind: 'digital', active: true, capabilities: ['work.assign'] },
      { company_id: 'company-a', worker_id: 'worker-other', kind: 'digital', active: true, capabilities: ['work.assign'] },
      { company_id: 'company-a', worker_id: 'worker-race', kind: 'digital', active: true, capabilities: ['work.assign'] },
      { company_id: 'company-b', worker_id: 'worker-b', kind: 'digital', active: true, capabilities: ['work.assign'] },
    ];
    for (const worker of workers) await workforceStore.putWorker(worker);
    const item = (company_id, work_id, assignee, evidence_refs = []) => ({ company_id, work_id,
      objective: `Disposable ${company_id} ${work_id}`, creator: auth.actor_id, assignee, priority: 1, state: 'READY',
      dependencies: [], required_capabilities: ['work.assign'], context_refs: [`context-${work_id}`], evidence_refs,
      created_at: at, updated_at: at });
    await workforceStore.put(item('company-a', 'work-a', 'worker-old'));
    await workforceStore.put(item('company-b', 'work-b', 'worker-b', ['company-b-private-evidence']));

    const accessStore = new SqliteWorkerAccessStore(seedStorage);
    const authority = new SqliteAuthorityStore(seedStorage);
    async function grantOperation(operationId) {
      const granted_at = new Date().toISOString();
      const expires_at = new Date(Date.now() + 60 * 60_000).toISOString();
      const subject_id = `${managerWorker}/titan.workforce.reassign`;
      const proofId = 'explicit-e2e-management-proof';
      const grant = { company_id: 'company-a', worker_id: managerWorker, actor_id: auth.actor_id,
        capability: 'titan.workforce.reassign', status: 'active', policy_allows: true,
        governance_allows: true, assurance_allows: true, risk: 'low', expires_at, evidence_refs: [proofId] };
      const existingProof = await seedStorage.query('SELECT id FROM evidence WHERE company_id=$1 AND id=$2', ['company-a', proofId]);
      if (existingProof.rowCount === 0) await seedStorage.query(
        `INSERT INTO evidence(id,company_id,subject_type,subject_id,evidence_type,provenance,payload)
         VALUES($1,$2,'worker_capability',$3,'management_authority',$4,$5)`,
        [proofId, 'company-a', subject_id, JSON.stringify({ source: 'isolated-owner-e2e', grants_authority: false }), JSON.stringify({ verified: true })]);
      const existingGrant = await seedStorage.query('SELECT id FROM authority_state WHERE company_id=$1 AND subject_type=$2 AND subject_id=$3',
        ['company-a', 'worker_capability', subject_id]);
      if (existingGrant.rowCount === 0) await seedStorage.query(
        `INSERT INTO authority_state(id,company_id,subject_type,subject_id,level,envelope)
         VALUES($1,$2,'worker_capability',$3,'scoped',$4)`,
        ['explicit-e2e-management-grant', 'company-a', subject_id, JSON.stringify(grant)]);
      const existingAccess = await accessStore.latest({ company_id: 'company-a', worker_id: managerWorker });
      if (!existingAccess) await accessStore.append({ company_id: 'company-a', assignment_id: 'e2e-manager-access',
        worker_id: managerWorker, permissions: ['titan.workforce.reassign'], status: 'active', granted_by: 'test-owner-fixture',
        granted_at, expires_at });
      const autonomy = await authority.latestAutonomySnapshot({ company_id: 'company-a', worker_id: managerWorker,
        capability: 'titan.workforce.reassign' });
      if (!autonomy) await authority.appendAutonomySnapshot({ company_id: 'company-a', decision_id: 'e2e-manager-autonomy',
        capability: 'titan.workforce.reassign', effective_score: 60, status: 'verified', source: 'titan-autonomy',
        verified_at: granted_at, expires_at, trusted_auto_handshake: { platform: false, user: false, assurance: false },
        predictive_ready: false }, { worker_id: managerWorker });
      await authority.appendApproval({ company_id: 'company-a', approval_id: `e2e-approval-${operationId}`,
        approval_scope: operationId, status: 'approved', approver_id: 'test-human-approver', granted_at, expires_at });
    }
    await grantOperation('operation-success');

    let cookie = auth.token;
    let nextIntentHook = null;
    const fetcher = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, 'https://panel.example.test');
      const headers = new Headers(init.headers);
      const outgoing = Object.fromEntries(headers.entries());
      Object.assign(outgoing, { host: 'panel.example.test', origin: 'https://panel.example.test',
        referer: 'https://panel.example.test/', 'sec-fetch-site': 'same-origin',
        'x-titan-csrf': headers.get('x-titan-csrf') ?? auth.csrf,
        cookie: `session=fixture-da-session; key=fixture-da-key; __Host-titan-da-session=${cookie}`,
        accept: 'application/json' });
      if (url.pathname.endsWith('/intents') && nextIntentHook) {
        const hook = nextIntentHook;
        nextIntentHook = null;
        await hook();
      }
      let response;
      if (url.pathname.endsWith('/intents') && nextDirectIntent) {
        nextDirectIntent = false;
        assert.equal(typeof directGateway, 'function', 'the actual SDK gateway is composed from #1253 owners');
        const gatewayHeaders = new Headers(outgoing);
        gatewayHeaders.delete('host');
        const request = new Request(url, { method: init.method ?? 'GET', headers: gatewayHeaders,
          body: init.body, signal: init.signal });
        response = await directGateway(request);
      } else {
        response = await queryLocal(address, `${url.pathname}${url.search}`, {
          method: init.method ?? 'GET', headers: outgoing, body: init.body,
        });
      }
      if (url.pathname.endsWith('/intents')) {
        intentResponses.push({ status: response.status, body: await response.clone().text() });
      }
      if (/\/v1\/directadmin\/titan_workforce\/receipts\/[^/]+$/.test(url.pathname)) {
        receiptResponses.push({ status: response.status, path: url.pathname, body: await response.clone().text() });
      }
      const setCookie = response.headers.get('set-cookie');
      const updatedCookie = setCookie?.match(/(?:^|,\s*)__Host-titan-da-session=([^;]+)/)?.[1];
      if (updatedCookie) cookie = updatedCookie;
      return response;
    };
    session = new SDK.DirectAdminCockpitSession(() => auth.csrf, fetcher);
    const requestIds = [];
    let fallbackId = 0;
    const api = new WorkforceApi(session, () => requestIds.shift() ?? `unexpected-id-${++fallbackId}`);
    const controller = new WorkforceController(api);
    unsubscribe = session.subscribe(() => controller.invalidate());

    return { scratch, host, server, address, auth, seedStorage, identityStorage, placementStorage,
      workforceStore, accessStore, authority, grantOperation, session, controller, requestIds, intentResponses, receiptResponses,
      setBeforeNextIntent(hook) { nextIntentHook = hook; },
      useDirectGatewayForNextIntent() { nextDirectIntent = true; },
      abortAfterReassignmentCommit(gate) { afterSqliteCommit = gate; }, async close() {
        await close();
      } };
  } catch (error) {
    await close();
    throw error;
  }
}

test('actual #1050 consumer and shared SDK traverse #1049 gateway into #1253 SQLite owner', async t => {
  const h = await makeHarness();
  t.after(() => h.close());

  await h.controller.connect();
  assert.equal(h.controller.state.phase, 'ready', h.controller.state.error);
  assert.equal(h.controller.state.context.company_id, 'company-a');
  assert.deepEqual(h.controller.state.discovery.controls, [{ capability_id: 'titan.workforce.reassign',
    action: 'reassign', requires_fresh_approval: true, grants_authority: false }]);
  assert.deepEqual(h.controller.state.status.work.map(work => work.work_id), ['work-a']);

  await t.test('owner projection exposes required capabilities to the consumer filter', async () => {
    assert.deepEqual(h.controller.state.status.work[0].required_capabilities, ['work.assign'],
      '#1253 projectWork must carry canonical WorkItem.required_capabilities');
  });

  h.requestIds.push('operation-success', 'correlation-success');
  await h.controller.submit({ action: 'reassign', work_id: 'work-a', target_worker_id: 'worker-target', reason: 'Balance the ready queue' });
  assert.equal(h.controller.state.phase, 'ready', h.controller.state.error);
  const ingressAck = JSON.parse(h.intentResponses.at(-1)?.body ?? 'null');
  assert.equal(h.intentResponses.at(-1)?.status, 202, 'the gateway acknowledges durable ingress with HTTP 202 only');
  assert.equal(ingressAck?.status, 'REQUESTED', 'the ingress ACK is not business verification');
  assert.equal(ingressAck?.correlation_id, 'correlation-success');
  assert.equal(h.controller.state.receipt.state, 'VERIFIED', 'the consumer displays only the later canonical receipt read as verified');
  assert.equal(h.controller.state.receiptLookupStatus, 'available');
  assert.equal(h.controller.state.receipt.verification.status, 'VERIFIED');
  assert.equal(h.controller.state.receipt.verification.method, 'company-scoped-workforce-reread-and-reassignment-event');
  assert.equal(h.controller.state.status.work[0].assignee, 'worker-target');
  const acceptedRefs = h.controller.state.status.work[0].evidence_refs;
  assert.equal(acceptedRefs.length, 1, 'only refreshed canonical projection displays the owner-persisted accepted evidence');
  const acceptedId = acceptedRefs[0];
  assert.equal(h.controller.state.receipt.receipt_id, acceptedId,
    'the consumer detail resolves the ingress ID to the persisted owner evidence');
  assert.equal(ingressAck?.receipt_id, acceptedId, 'ingress and accepted evidence use one durable receipt ID');
  assert.deepEqual(h.controller.state.receipt.evidence_refs, [acceptedId]);
  assert.deepEqual(await h.workforceStore.get('company-a', 'work-a').then(work => ({ state: work.state, assignee: work.assignee })),
    { state: 'READY', assignee: 'worker-target' });

  const acceptedRows = await h.seedStorage.query(
    `SELECT payload,provenance FROM evidence WHERE company_id=$1 AND id=$2 AND evidence_type='gateway_execution'`,
    ['company-a', acceptedId]);
  assert.equal(acceptedRows.rowCount, 1, 'accepted evidence is read from the canonical SQLite evidence ledger');
  const accepted = JSON.parse(acceptedRows.rows[0].payload);
  const provenance = JSON.parse(acceptedRows.rows[0].provenance);
  assert.equal(accepted.state, 'VERIFIED');
  assert.equal(accepted.accepted_evidence.schema, 'titan.business.accepted-evidence/v1');
  assert.equal(provenance.company_id, 'company-a');
  assert.equal(provenance.actor_id, h.auth.actor_id);
  assert.equal(provenance.work_id, 'work-a');
  assert.equal(provenance.workforce_session_id, accepted.request_summary.input.workforce_session_id);
  assert.equal(provenance.workforce_context_revision, accepted.request_summary.input.workforce_context_revision);
  assert.ok(provenance.workforce_session_id.startsWith('workforce-zero-'), 'the accepted record names the signed #302 derived child session');
  assert.ok(provenance.workforce_session_id !== h.controller.state.context.session_id,
    'the authority/evidence path records the bound child session, not the DirectAdmin parent credential');
  assert.equal((await h.seedStorage.query(
    "SELECT event_seq FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'",
    ['company-a', 'work-a'])).rowCount, 1);
  const detailResponse = h.receiptResponses.at(-1);
  assert.equal(detailResponse?.status, 200, 'receipt detail is served through the actual hosted HTTP mount');
  assert.equal(detailResponse?.path, `/v1/directadmin/titan_workforce/receipts/${acceptedId}`);
  const detailEnvelope = JSON.parse(detailResponse.body);
  assert.equal(detailEnvelope.context.company_id, 'company-a');
  assert.equal(detailEnvelope.receipt.state, 'VERIFIED');
  assert.deepEqual(detailEnvelope.receipt.evidence_refs, [acceptedId]);

  await t.test('receipt detail survives a consumer reconnect without another business effect', async () => {
    await h.controller.connect();
    assert.equal(h.controller.state.phase, 'ready', h.controller.state.error);
    assert.equal(h.controller.state.context.company_id, 'company-a');
    assert.equal(h.controller.state.receiptLookupStatus, 'available');
    assert.equal(h.controller.state.receipt.receipt_id, acceptedId);
    assert.equal(h.controller.state.receipt.state, 'VERIFIED');
    assert.deepEqual(h.controller.state.receipt.evidence_refs, [acceptedId]);
    assert.equal(h.receiptResponses.at(-1)?.status, 200);
    assert.equal((await h.seedStorage.query(
      "SELECT event_seq FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'",
      ['company-a', 'work-a'])).rowCount, 1, 'receipt reread is read-only');
  });

  await t.test('same operation replays the durable accepted result without duplicate effects', async () => {
    const context = await h.session.connect();
    const replay = await h.session.intent('titan_workforce', { company_id: context.company_id, actor_id: context.actor_id,
      capability_id: 'titan.workforce.reassign', operation_id: 'operation-success', correlation_id: 'correlation-success',
      input: { action: 'reassign', work_id: 'work-a', reason: 'Balance the ready queue',
        expected_assignee_id: 'worker-old', target_worker_id: 'worker-target' } });
    assert.equal(replay.receipt_id, acceptedId);
    assert.equal((await h.seedStorage.query(
      "SELECT event_seq FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'",
      ['company-a', 'work-a'])).rowCount, 1);
    assert.equal((await h.seedStorage.query(
      "SELECT id FROM evidence WHERE company_id=$1 AND evidence_type='gateway_execution' AND json_extract(payload,'$.state')='VERIFIED'",
      ['company-a'])).rowCount, 1);
  });

  await h.controller.connect();
  h.requestIds.push('operation-denied', 'correlation-denied');
  h.setBeforeNextIntent(async () => {
    await h.accessStore.append({ company_id: 'company-a', assignment_id: 'e2e-manager-access-revoked',
      worker_id: 'manager-worker-a', permissions: ['titan.workforce.reassign'], status: 'revoked',
      granted_by: 'test-owner-fixture', granted_at: new Date(Date.now() + 1000).toISOString(),
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(), supersedes_assignment_id: 'e2e-manager-access' });
  });
  await h.controller.submit({ action: 'reassign', work_id: 'work-a', target_worker_id: 'worker-other', reason: 'Should be denied after access revocation' });
  const denialResponse = h.intentResponses.at(-1);
  await t.test('typed owner authority denial is HTTP 403, sanitized, and distinct from an unknown outcome', async () => {
    assert.equal(denialResponse?.status, 403);
    assert.ok(denialResponse.body.length < 1024);
    assert.doesNotMatch(denialResponse.body, /SQLite|SELECT|authority_state|management-proof/i);
    assert.equal(h.controller.state.phase, 'ready');
    assert.equal(h.controller.state.context.company_id, 'company-a');
    assert.equal(h.controller.state.status.work[0].assignee, 'worker-target');
    assert.equal(h.controller.state.receipt, null);
    assert.match(h.controller.state.error, /host denied that request/i);
    assert.deepEqual(h.controller.state.discovery.controls, [], 'a refreshed projection hides the revoked control');
  });
  assert.equal((await h.workforceStore.get('company-a', 'work-a')).assignee, 'worker-target');
  assert.equal((await h.seedStorage.query(
    "SELECT event_seq FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'",
    ['company-a', 'work-a'])).rowCount, 1, 'denial adds no reassignment event');
  assert.deepEqual((await h.workforceStore.get('company-a', 'work-a')).evidence_refs, acceptedRefs,
    'denial adds no accepted evidence reference');

  await h.accessStore.append({ company_id: 'company-a', assignment_id: 'e2e-manager-access-restored',
    worker_id: 'manager-worker-a', permissions: ['titan.workforce.reassign'], status: 'active',
    granted_by: 'test-owner-fixture', granted_at: new Date(Date.now() + 2000).toISOString(),
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(), supersedes_assignment_id: 'e2e-manager-access-revoked' });
  await h.grantOperation('operation-stale');
  await h.controller.connect();
  assert.equal(h.controller.state.phase, 'ready', h.controller.state.error);
  h.requestIds.push('operation-stale', 'correlation-stale');
  h.setBeforeNextIntent(async () => {
    const current = await h.workforceStore.get('company-a', 'work-a');
    await h.workforceStore.put({ ...current, assignee: 'worker-race', updated_at: new Date(Date.now() + 3000).toISOString() });
  });
  await h.controller.submit({ action: 'reassign', work_id: 'work-a', target_worker_id: 'worker-other', reason: 'Stale assignee compare-and-set' });
  await t.test('stale assignee CAS produces no owner effect or accepted evidence', async () => {
    assert.equal((await h.workforceStore.get('company-a', 'work-a')).assignee, 'worker-race',
      'the competing fixture update remains current; the attempted assignment did not overwrite it');
    assert.equal((await h.seedStorage.query(
      "SELECT event_seq FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'",
      ['company-a', 'work-a'])).rowCount, 1, 'stale CAS creates no second reassignment event');
    assert.deepEqual((await h.workforceStore.get('company-a', 'work-a')).evidence_refs, acceptedRefs);
    assert.equal((await h.seedStorage.query(
      "SELECT id FROM evidence WHERE company_id=$1 AND evidence_type='gateway_execution' AND json_extract(payload,'$.idempotency_key')=$2 AND json_extract(payload,'$.state')='VERIFIED'",
      ['company-a', 'titan.workforce.reassign:operation-stale'])).rowCount, 0, 'stale CAS is never reported as verified');
  });

  const newCancellationWork = work_id => ({ company_id: 'company-a', work_id,
    objective: `Disposable cancellation case ${work_id}`, creator: h.auth.actor_id, assignee: 'worker-old',
    priority: 1, state: 'READY', dependencies: [], required_capabilities: ['work.assign'], context_refs: [],
    evidence_refs: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  await t.test('already-aborted packaged request becomes unknown to the operator and has no owner effect', async () => {
    const operation_id = 'operation-cancel-already-aborted';
    await h.grantOperation(operation_id);
    await h.workforceStore.put(newCancellationWork('work-cancel-already-aborted'));
    await h.controller.connect();
    h.requestIds.push(operation_id, 'correlation-cancel-already-aborted');
    h.useDirectGatewayForNextIntent();
    const submission = submitWithSdkIntentSignal(h.controller, { action: 'reassign',
      work_id: 'work-cancel-already-aborted', target_worker_id: 'worker-target', reason: 'Abort before owner admission' },
    AbortSignal.abort(new Error('fixture-already-aborted')));
    await submission.promise;

    assert.equal(submission.wasInjected(), true, 'the packaged SDK intent request received the pre-aborted signal');
    assert.equal(submission.timeoutCalls(), 3, 'only context and projection preflight precede the intent request');
    assert.equal(h.intentResponses.at(-1)?.status, 503, 'owner cancellation is surfaced as an unknown transport outcome');
    assert.equal(h.controller.state.phase, 'unavailable');
    assert.match(h.controller.state.error, /outcome is unknown/i);
    assert.equal(h.controller.state.receipt, null);
    assert.equal(h.controller.state.context, null);
    assert.equal((await h.workforceStore.get('company-a', 'work-cancel-already-aborted')).assignee, 'worker-old');
    assert.equal((await h.seedStorage.query(
      "SELECT event_seq FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'",
      ['company-a', 'work-cancel-already-aborted'])).rowCount, 0);
    assert.equal((await h.seedStorage.query(
      "SELECT id FROM evidence WHERE company_id=$1 AND evidence_type='gateway_execution' AND json_extract(payload,'$.idempotency_key')=$2",
      ['company-a', `titan.workforce.reassign:${operation_id}`])).rowCount, 0);
  });

  await t.test('in-flight post-commit cancellation persists UNCERTAIN state and reports an unknown outcome', async t => {
    const operation_id = 'operation-cancel-after-commit';
    const correlation_id = 'correlation-cancel-after-commit';
    const work_id = 'work-cancel-after-commit';
    await h.grantOperation(operation_id);
    await h.workforceStore.put(newCancellationWork(work_id));
    await h.controller.connect();
    h.requestIds.push(operation_id, correlation_id);
    const entered = deferred();
    const cancellation = new AbortController();
    const gate = { companyId: 'company-a', workId: work_id, operationId: operation_id,
      entered, abort: () => cancellation.abort(new Error('fixture-abort-after-commit')) };
    h.abortAfterReassignmentCommit(gate);
    h.useDirectGatewayForNextIntent();
    const submission = submitWithSdkIntentSignal(h.controller, { action: 'reassign', work_id,
      target_worker_id: 'worker-target', reason: 'Abort after the SQLite compare-and-set committed' }, cancellation.signal);
    let reachedCommit = false;
    let submitTimeout;
    let submitTimedOut = false;
    let effect = null;
    let evidence = null;
    let eventCount = -1;
    let response = null;
    let controllerReport = null;
    let replayError = null;
    let evidenceCountBeforeReplay = -1;
    let evidenceCountAfterReplay = -1;
    let eventCountAfterReplay = -1;
    try {
      await settlesWithin(entered.promise, 3000, 'actual SQLite connection did not observe the reassignment COMMIT');
      reachedCommit = true;
      effect = await h.workforceStore.get('company-a', work_id);
      eventCount = (await h.seedStorage.query(
        "SELECT event_seq FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'",
        ['company-a', work_id])).rowCount;
      try {
        await settlesWithin(submission.promise, 3000, 'consumer request did not settle after SDK signal abort');
      } catch (error) {
        submitTimeout = String(error?.message ?? error);
        submitTimedOut = true;
      }
      response = h.intentResponses.at(-1) ?? null;
      const rows = await h.seedStorage.query(
        "SELECT payload FROM evidence WHERE company_id=$1 AND evidence_type='gateway_execution' AND json_extract(payload,'$.idempotency_key')=$2 ORDER BY rowid",
        ['company-a', `titan.workforce.reassign:${operation_id}`]);
      evidence = rows.rows.length ? JSON.parse(rows.rows.at(-1).payload) : null;
      controllerReport = { phase: h.controller.state.phase, message: h.controller.state.error,
        assignee: h.controller.state.status?.work?.find(item => item.work_id === work_id)?.assignee,
        receipt: h.controller.state.receipt };
      evidenceCountBeforeReplay = (await h.seedStorage.query(
        "SELECT id FROM evidence WHERE company_id=$1 AND evidence_type='gateway_execution' AND json_extract(payload,'$.idempotency_key')=$2",
        ['company-a', `titan.workforce.reassign:${operation_id}`])).rowCount;

      await h.session.connect();
      h.useDirectGatewayForNextIntent();
      await assert.rejects(h.session.intent('titan_workforce', { company_id: 'company-a', actor_id: h.auth.actor_id,
        capability_id: 'titan.workforce.reassign', operation_id, correlation_id,
        input: { action: 'reassign', work_id, reason: 'Abort after the SQLite compare-and-set committed',
          expected_assignee_id: 'worker-old', target_worker_id: 'worker-target' } }), /directadmin-http-503/);
      const replay = h.intentResponses.at(-1);
      replayError = replay?.status;
      evidenceCountAfterReplay = (await h.seedStorage.query(
        "SELECT id FROM evidence WHERE company_id=$1 AND evidence_type='gateway_execution' AND json_extract(payload,'$.idempotency_key')=$2",
        ['company-a', `titan.workforce.reassign:${operation_id}`])).rowCount;
      eventCountAfterReplay = (await h.seedStorage.query(
        "SELECT event_seq FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'",
        ['company-a', work_id])).rowCount;
    } finally {
      if (!cancellation.signal.aborted) cancellation.abort(new Error('fixture-cleanup-abort'));
      await settlesWithin(submission.promise.catch(() => {}), 3000,
        'packaged submission did not settle during cancellation fixture cleanup');
    }

    t.diagnostic(JSON.stringify({ submitTimedOut, submitTimeout, httpStatus: response?.status,
      executionState: evidence?.state, finalOutcome: evidence?.final_outcome, effectAssignee: effect?.assignee,
      eventCount, acceptedRefs: effect?.evidence_refs, controllerReport, replayHttpStatus: replayError,
      evidenceCountBeforeReplay, evidenceCountAfterReplay, eventCountAfterReplay }));
    assert.equal(reachedCommit, true);
    assert.equal(submission.wasInjected(), true);
    assert.equal(submitTimedOut, false, 'the SDK request completed with an owner response after cancellation');
    assert.equal(effect?.assignee, 'worker-target', 'the operation committed before cancellation; abort is not rollback');
    assert.equal(eventCount, 1);
    assert.equal(evidence?.state, 'UNCERTAIN', 'ExecutionGateway records cancellation as uncertain');
    assert.equal(evidence?.final_outcome, null);
    assert.deepEqual(effect?.evidence_refs, [], 'uncertain execution is not accepted business evidence');
    assert.equal(response?.status, 503, 'committed work with an uncertain execution must not be reported as authority denial');
    assert.equal(controllerReport?.phase, 'unavailable');
    assert.equal(controllerReport?.assignee, undefined, 'the client clears potentially stale projections after an unknown result');
    assert.equal(controllerReport?.receipt, null);
    assert.match(controllerReport?.message ?? '', /outcome is unknown/i,
      'the UI tells the operator to inspect canonical history before retrying');
    assert.equal(replayError, 503, 'the owner requires recovery and does not execute the same operation twice');
    assert.equal(evidenceCountAfterReplay, evidenceCountBeforeReplay, 'same-operation replay adds no event or evidence');
    assert.equal(eventCountAfterReplay, eventCount, 'same-operation replay emits no second reassignment event');
  });

  await h.session.switchCompany('company-b');
  await t.test('company switch clears prior company state and refresh is company filtered', async () => {
    assert.equal(h.controller.state.context, null);
    assert.equal(h.controller.state.discovery, null);
    assert.equal(h.controller.state.status, null);
    assert.doesNotMatch(JSON.stringify(h.controller.state), /work-a|worker-target|explicit-e2e-management-proof/);
  });
  const companyBContext = await h.session.connect();
  assert.equal(companyBContext.company_id, 'company-b');
  await assert.rejects(h.session.receipt('titan_workforce', acceptedId), /directadmin-http-404/,
    'an accepted receipt from company A is indistinguishable from missing under company B');
  assert.equal(h.receiptResponses.at(-1)?.status, 404);
  assert.equal(JSON.parse(h.receiptResponses.at(-1).body).error, 'directadmin-workforce-receipt-not-found');
  await h.controller.connect();
  assert.equal(h.controller.state.phase, 'ready', h.controller.state.error);
  assert.equal(h.controller.state.context.company_id, 'company-b');
  assert.deepEqual(h.controller.state.status.work.map(work => work.work_id), ['work-b']);
  assert.deepEqual(h.controller.state.status.work[0].evidence_refs, ['company-b-private-evidence']);
  assert.deepEqual(h.controller.state.discovery.controls, [], 'company A authority/access does not follow the company switch');
  assert.doesNotMatch(JSON.stringify(h.controller.state), /work-a|worker-target|explicit-e2e-management-proof/);
});
