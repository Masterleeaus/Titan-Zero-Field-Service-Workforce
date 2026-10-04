import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { WorkforceApi } from '../images/api.mjs';
import { workState, verifiedOutcome } from '../images/presentation.mjs';
import { readFile } from 'node:fs/promises';
const sdkPath = process.env.TITAN_COCKPIT_SDK_MODULE ??
  new URL('../../../../packages/titan-platform/.test-dist/directadmin-plugin.js', import.meta.url).pathname;
const { DirectAdminCockpitSession, createDirectAdminGateway } = await import(pathToFileURL(resolve(sdkPath)).href);
const bridgeFixturePath = process.env.TITAN_BRIDGE_FIXTURE_MODULE ??
  new URL('../../../../packages/titan-platform/tests/fixtures/directadmin-bridge-fixture.mjs', import.meta.url).pathname;
const { csrf, fixture, proof } = await import(pathToFileURL(resolve(bridgeFixturePath)).href);
const bootstrapNonce = 'N'.repeat(43);
const bootstrapProviderFor = (auth, label, { csrf_token = csrf } = {}) => {
  let sequence = 0;
  return { provide: async proof => {
    assert.equal(proof.origin, 'https://panel.example.test');
    assert.equal(proof.csrf_nonce, bootstrapNonce);
    assert.equal(proof.cookie, 'da_session=fixture-authenticated');
    return { login_assertion: await auth.loginFor('directadmin:https://panel.example.test', `browser-${label}-${++sequence}`),
      company_id: 'company-a', device_id: 'device-1', csrf_token };
  } };
};
const controllerSource = (await readFile(new URL('../images/controller.mjs', import.meta.url), 'utf8')).replace("'workforce-presentation'", JSON.stringify(new URL('../images/presentation.mjs', import.meta.url).href));
const { WorkforceController } = await import(`data:text/javascript;base64,${Buffer.from(controllerSource).toString('base64')}`);

test('current SDK, canonical issued session and company-switch cookie scope the Workforce consumer', async t => {
  // Canonical #302-issued credential, registry and ephemeral DB are explicit test fixtures.
  const auth = await fixture(t);
  const intents = [];
  let projectionUnavailable = false;
  let pendingIntent;
  let releaseIntent;
  let markIntentEntered;
  const intentEntered = new Promise(resolve => { markIntentEntered = resolve; });
  const gateway = createDirectAdminGateway(auth.bridge, {
    projection: async (plugin, context) => {
      assert.equal(plugin, 'titan_workforce');
      if (projectionUnavailable) throw new Error('fixture-hosted-owner-temporarily-unavailable');
      const company_id = context.company_id;
      return { company_id, source: 'fixture-hosted-workforce-owner', freshness: new Date().toISOString(), evidence_refs: [],
        data: { schema: 'titan.workforce-cockpit.v1', company_id,
          discovery: { company_id, workers: [{ company_id, worker_id: `${company_id}-worker`, kind: 'digital', active: true, capabilities: ['work.pause', 'work.cancel'] }],
            controls: [{ action: 'pause', capability_id: 'fixture.pause' }, { action: 'cancel', capability_id: 'fixture.cancel' }] },
          status: { company_id, work: [{ company_id, work_id: `${company_id}-work`, state: 'COMPLETED', evidence_refs: ['fixture-run-ack'] }] } } };
    },
    requestIntent: async (plugin, intent, context, revalidate) => {
      assert.equal(plugin, 'titan_workforce');
      assert.equal((await revalidate()).company_id, context.company_id);
      if (pendingIntent) await new Promise(resolve => { releaseIntent = resolve; markIntentEntered(); });
      intents.push(intent);
      return { receipt_id: `fixture-receipt-${intents.length}` };
    },
  }, bootstrapProviderFor(auth, 'workforce-consumer', { csrf_token: csrf }));
  let credential = auth.token;
  let cookie = `da_session=fixture-authenticated; __Host-titan-da-session=${credential}`;
  const responses = [];
  const fetcher = async (path, init) => {
    const bootstrap = path === '/v1/directadmin/bootstrap';
    if (!bootstrap) assert.equal(init?.headers?.['X-Titan-CSRF'], csrf, 'SDK must send the separately bootstrapped CSRF token');
    const request = auth.request(path, { method: init?.method ?? 'GET', body: init?.body,
      headers: { cookie,
        'content-type': init?.headers?.['Content-Type'] ?? null,
        'x-titan-csrf': bootstrap ? null : (init?.headers?.['X-Titan-CSRF'] ?? null),
        'x-titan-da-bootstrap-csrf': bootstrap ? (init?.headers?.['X-Titan-DA-Bootstrap-CSRF'] ?? null) : null } });
    const response = await gateway(request);
    responses.push({ path, status: response.status });
    const rotated = response.headers.get('set-cookie')?.match(/^__Host-titan-da-session=([^;]+)/)?.[1];
    if (rotated) { credential = rotated; cookie = `da_session=fixture-authenticated; __Host-titan-da-session=${credential}`; }
    return response;
  };
  const session = new DirectAdminCockpitSession(() => bootstrapNonce, fetcher, undefined);
  t.after(() => session.dispose());
  const controller = new WorkforceController(new WorkforceApi(session));
  let sessionInvalidations = 0;
  const unsubscribe = session.subscribe(() => { sessionInvalidations++; controller.invalidate(); });
  t.after(unsubscribe);
  await controller.connect();
  assert.equal(controller.state.phase, 'ready', `${controller.state.error}; responses=${JSON.stringify(responses)}`);
  assert.equal(controller.state.context.company_id, 'company-a');
  assert.equal(controller.state.status.work[0].state, 'COMPLETED');
  assert.equal(verifiedOutcome(controller.state.status.work[0]), false);
  assert.match(workState(controller.state.status.work[0].state), /verification separate/);

  pendingIntent = true;
  const first = controller.submit({ action: 'pause', work_id: 'company-a-work', reason: 'Fixture pause' });
  await Promise.race([intentEntered, new Promise((_, reject) => setTimeout(() => reject(new Error(`intent route not reached: ${controller.state.error ?? controller.state.phase}`)), 1000))]);
  await controller.submit({ action: 'pause', work_id: 'company-a-work', reason: 'Duplicate fixture click' });
  assert.equal(intents.length, 0);
  releaseIntent(); await first; pendingIntent = false;
  assert.equal(intents.length, 1);
  assert.equal(intents[0].input.action, 'pause');
  assert.equal(intents[0].operation_id.length > 0, true);
  assert.equal(intents[0].correlation_id.length > 0, true);
  assert.equal(controller.state.receipt?.state, 'REQUESTED', JSON.stringify(controller.state));
  assert.equal(controller.state.receipt.evidence_refs.length, 0);

  await controller.submit({ action: 'cancel', work_id: 'company-a-work', reason: 'Fixture cancellation request' });
  assert.equal(intents.length, 2);
  assert.equal(intents[1].input.action, 'cancel');
  assert.equal(intents[1].company_id, 'company-a');

  await session.switchCompany('company-b');
  assert.equal(controller.state.context, null);
  assert.equal(controller.state.discovery, null);
  await controller.connect();
  assert.equal(controller.state.phase, 'ready', controller.state.error);
  assert.equal(controller.state.context.company_id, 'company-b');
  assert.equal(controller.state.discovery.workers[0].worker_id, 'company-b-worker');

  // An owner outage is a sanitized 503, not an identity revocation. The panel
  // clears its projection but keeps the current SDK session usable for retry.
  sessionInvalidations = 0;
  projectionUnavailable = true;
  await controller.connect();
  assert.equal(controller.state.phase, 'unavailable');
  assert.equal(controller.state.context, null);
  assert.equal(sessionInvalidations, 0, 'owner 503 must not invalidate the authenticated DirectAdmin session');
  projectionUnavailable = false;
  await controller.connect();
  assert.equal(controller.state.phase, 'ready', controller.state.error);
  assert.equal(controller.state.context.company_id, 'company-b');
  assert.equal(sessionInvalidations, 0, 'the current company session recovers after the owner returns');

  const currentSession = await auth.bridgeSessions.authenticate(credential);
  await auth.registry.revokeSession(currentSession.context.session_id, currentSession.context.session_revision);
  await controller.submit({ action: 'pause', work_id: 'company-b-work', reason: 'Revoked fixture request' });
  assert.equal(intents.length, 2);
  assert.ok(sessionInvalidations > 0, 'a canonical revoked-session 401 invalidates the shared SDK session');
  assert.equal(controller.state.phase, 'denied');
  assert.equal(controller.state.discovery, null);
  assert.equal(controller.state.receipt, null);
});
