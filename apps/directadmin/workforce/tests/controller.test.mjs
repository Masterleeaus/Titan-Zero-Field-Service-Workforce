import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { identityType, receiptState, teamMemberships, workState, verifiedOutcome } from '../images/presentation.mjs';
const source = (await readFile(new URL('../images/controller.mjs', import.meta.url), 'utf8')).replace("'workforce-presentation'", JSON.stringify(new URL('../images/presentation.mjs', import.meta.url).href));
const { WorkforceController } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const context = () => ({ company_id: 'company-a', actor_id: 'actor-a', session_revision: '1', context_revision: 'context-a' });
function fixture() {
  const calls = [];
  return { calls, context: async () => context(), discover: async () => ({ company_id: 'company-a', workers: [] }), status: async () => ({ company_id: 'company-a', work: [] }), metadata: async () => ({ source: 'fixture-owner', freshness: null, evidence_refs: [] }), control: async (ctx, action) => { calls.push(action); return { company_id: ctx.company_id,
    state: 'REQUESTED', receipt_id: 'receipt-fixture', operation_id: 'operation-fixture',
    correlation_id: 'correlation-fixture', work_id: action.work_id ?? 'work-fixture', evidence_refs: [] }; } };
}
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key) };
}
test('loads actual transport projections and submits once without optimistic success', async () => {
  const api = fixture(); const model = new WorkforceController(api); await model.connect();
  assert.equal(model.state.phase, 'ready');
  await Promise.all([model.submit({ action: 'pause', work_id: 'w1' }), model.submit({ action: 'pause', work_id: 'w1' })]);
  assert.equal(api.calls.length, 1); assert.equal(model.state.receipt.state, 'REQUESTED');
  assert.equal(verifiedOutcome(model.state.receipt), false);
});
test('loads verified receipt detail only from the shared receipt reader', async () => {
  const api = fixture(); const model = new WorkforceController(api); await model.connect();
  const acknowledgement = { company_id: 'company-a', state: 'REQUESTED', receipt_id: 'receipt-1',
    operation_id: 'operation-1', correlation_id: 'correlation-1', work_id: 'work-1', evidence_refs: [] };
  const verified = { schema: 'titan.directadmin.workforce-receipt.v1', company_id: 'company-a', receipt_id: 'receipt-1',
    operation_id: 'operation-1', correlation_id: 'correlation-1', work_id: 'work-1', state: 'VERIFIED',
    verification: { status: 'VERIFIED', method: 'company-scoped-workforce-reread' }, evidence_refs: ['receipt-1'] };
  api.control = async () => acknowledgement;
  api.receipt = async (_context, receiptId, expected) => {
    assert.equal(receiptId, 'receipt-1'); assert.equal(expected.operation_id, 'operation-1'); return verified;
  };
  await model.submit({ action: 'reassign', work_id: 'work-1', target_worker_id: 'worker-2', reason: 'Move ready work' });
  assert.equal(model.state.phase, 'ready');
  assert.equal(model.state.receiptLookupStatus, 'available');
  assert.equal(model.state.receipt.state, 'VERIFIED');
  assert.equal(verifiedOutcome(model.state.receipt), true);
  assert.equal(receiptState(model.state.receipt), 'Verified outcome with evidence');
});
test('missing shared receipt route preserves REQUESTED and never upgrades it from work references', async () => {
  const api = fixture(); const model = new WorkforceController(api); await model.connect();
  api.control = async () => ({ company_id: 'company-a', state: 'REQUESTED', receipt_id: 'receipt-1',
    operation_id: 'operation-1', correlation_id: 'correlation-1', work_id: 'work-1', evidence_refs: [] });
  api.receipt = async () => null;
  api.status = async () => ({ company_id: 'company-a', work: [{ company_id: 'company-a', work_id: 'work-1', state: 'READY',
    assignee: 'worker-2', context_refs: [], evidence_refs: ['receipt-1'] }] });
  await model.submit({ action: 'reassign', work_id: 'work-1', target_worker_id: 'worker-2', reason: 'Move ready work' });
  assert.equal(model.state.receiptLookupStatus, 'unsupported');
  assert.equal(model.state.receipt.state, 'REQUESTED');
  assert.deepEqual(model.state.receipt.evidence_refs, []);
  assert.equal(verifiedOutcome(model.state.receipt), false, 'a work reference alone is not a verified receipt projection');
});
test('receipt refresh and reload keep correlation in a tab-scoped pointer and re-read under current company context', async () => {
  const api = fixture(); const storage = memoryStorage(); let receiptReads = 0;
  let available = false;
  let controlCalls = 0;
  const acknowledgement = { company_id: 'company-a', state: 'REQUESTED', receipt_id: 'receipt-tab',
    operation_id: 'operation-tab', correlation_id: 'correlation-tab', work_id: 'work-tab', evidence_refs: [] };
  const verified = { schema: 'titan.directadmin.workforce-receipt.v1', company_id: 'company-a', receipt_id: 'receipt-tab',
    operation_id: 'operation-tab', correlation_id: 'correlation-tab', work_id: 'work-tab', state: 'VERIFIED',
    verification: { status: 'VERIFIED', method: 'company-scoped-workforce-reread' }, evidence_refs: ['accepted-evidence-tab'] };
  api.control = async () => { controlCalls++; return acknowledgement; };
  api.receipt = async (_context, id, expected) => {
    receiptReads++; assert.equal(id, 'receipt-tab');
    assert.equal(expected.operation_id, 'operation-tab'); assert.equal(expected.correlation_id, 'correlation-tab');
    return available ? verified : null;
  };
  const first = new WorkforceController(api, () => {}, storage); await first.connect();
  await first.submit({ action: 'pause', work_id: 'work-tab', reason: 'Wait for verification' });
  assert.equal(first.state.receipt.state, 'REQUESTED');
  assert.equal(first.state.receiptLookupStatus, 'unsupported');
  const saved = JSON.parse(storage.getItem('titan.directadmin.workforce.receipt.v1'));
  assert.deepEqual(Object.keys(saved).sort(), ['actor_id', 'company_id', 'correlation_id', 'operation_id', 'receipt_id', 'schema', 'work_id']);
  assert.doesNotMatch(JSON.stringify(saved), /evidence|token|credential|authority|reason/i);

  await first.refreshReceipt();
  assert.equal(first.state.receipt.state, 'REQUESTED');
  assert.equal(first.state.receiptLookupStatus, 'unsupported');
  let releaseRead; let markReadEntered;
  const readEntered = new Promise(resolve => { markReadEntered = resolve; });
  api.receipt = async (_context, id, expected) => {
    receiptReads++; assert.equal(id, 'receipt-tab');
    assert.equal(expected.operation_id, 'operation-tab'); assert.equal(expected.correlation_id, 'correlation-tab');
    markReadEntered(); return new Promise(resolve => { releaseRead = resolve; });
  };
  const activeRead = first.refreshReceipt();
  await readEntered;
  const readsDuringActiveRefresh = receiptReads;
  await first.refreshReceipt();
  assert.equal(receiptReads, readsDuringActiveRefresh, 'concurrent receipt refresh clicks do not start overlapping reads');
  releaseRead(verified);
  await activeRead;
  assert.equal(first.state.receipt.state, 'VERIFIED');
  assert.equal(first.state.receiptLookupStatus, 'available');
  assert.equal(controlCalls, 1, 'receipt refresh never resubmits the governed action');

  api.receipt = async () => { receiptReads++; throw new Error('directadmin-http-503'); };
  await first.refreshReceipt();
  assert.equal(first.state.receipt.state, 'REQUESTED', 'a failed refresh does not present a previously verified detail as current');
  assert.equal(first.state.receiptLookupStatus, 'unavailable');
  assert.equal(verifiedOutcome(first.state.receipt), false);
  available = true;
  api.receipt = async () => { receiptReads++; return verified; };

  first.invalidate({ preserveReceiptBookmark: true });
  assert.equal(first.state.receipt, null, 'pagehide clears rendered receipt details');
  assert.equal(first.state.context, null, 'pagehide clears the in-memory company context');
  assert.notEqual(storage.getItem('titan.directadmin.workforce.receipt.v1'), null,
    'pagehide retains only the tab-scoped receipt pointer for a fresh-context reread');

  const reopened = new WorkforceController(api, () => {}, storage);
  await reopened.connect();
  assert.equal(reopened.state.phase, 'ready');
  assert.equal(reopened.state.receipt.state, 'VERIFIED');
  assert.equal(reopened.state.receipt.correlation_id, 'correlation-tab');

  const companyB = { ...context(), company_id: 'company-b', context_revision: 'context-b' };
  api.context = async () => companyB;
  api.discover = async () => ({ company_id: 'company-b', workers: [] });
  api.status = async () => ({ company_id: 'company-b', work: [] });
  api.metadata = async () => ({ source: 'fixture-owner', freshness: null, evidence_refs: [] });
  const switched = new WorkforceController(api, () => {}, storage);
  await switched.connect();
  assert.equal(switched.state.phase, 'ready');
  assert.equal(switched.state.receipt, null);
  assert.equal(storage.getItem('titan.directadmin.workforce.receipt.v1'), null,
    'company switch clears the tab-scoped pointer before reading the prior company receipt');
  assert.equal(controlCalls, 1);
  assert.equal(receiptReads, 5, 'only the original action, explicit refreshes, and same-company reload read the receipt');
});
test('temporary reconnect failure preserves only the receipt pointer; authority failure clears it', async () => {
  const api = fixture(); const storage = memoryStorage();
  const model = new WorkforceController(api, () => {}, storage);
  await model.connect();
  await model.submit({ action: 'pause', work_id: 'work-fixture' });
  assert.equal(model.state.receipt.state, 'REQUESTED');
  assert.equal(model.hasReceiptBookmark(), true);

  const currentContext = api.context;
  api.context = async () => { throw new Error('directadmin-http-503'); };
  await model.connect();
  assert.equal(model.state.phase, 'unavailable');
  assert.equal(model.state.context, null);
  assert.equal(model.state.receipt, null);
  assert.equal(model.hasReceiptBookmark(), true, 'an outage clears rendered state but keeps retry correlation');

  api.context = currentContext;
  let receiptReads = 0;
  api.receipt = async (ctx, receiptId, expected) => {
    receiptReads++;
    assert.equal(ctx.company_id, 'company-a');
    assert.equal(receiptId, 'receipt-fixture');
    assert.equal(expected.operation_id, 'operation-fixture');
    return { company_id: 'company-a', receipt_id: 'receipt-fixture', operation_id: 'operation-fixture',
      correlation_id: 'correlation-fixture', work_id: 'work-fixture', state: 'VERIFIED',
      verification: { status: 'VERIFIED', method: 'company-scoped-workforce-reread' }, evidence_refs: ['receipt-fixture'] };
  };
  await model.connect();
  assert.equal(receiptReads, 1, 'reconnect rereads the pointer only after fresh company context');
  assert.equal(model.state.phase, 'ready');
  assert.equal(model.state.receipt.state, 'VERIFIED');

  api.context = async () => { throw new Error('directadmin-http-401'); };
  await model.connect();
  assert.equal(model.state.phase, 'denied');
  assert.equal(model.state.receipt, null);
  assert.equal(model.hasReceiptBookmark(), false, 'revocation clears correlation from tab storage');
});
test('receipt bookmark accepts canonical owner IDs while keeping receipt path IDs route-safe', async () => {
  const companyId = 'company 東京 @service';
  const actorId = 'operator@example.test';
  const operationId = `operation-${'x'.repeat(1000)}`;
  const correlationId = 'correlation/東京 "quoted"';
  const workId = `work ${'y'.repeat(990)}`;
  const api = fixture(); const storage = memoryStorage();
  api.context = async () => ({ ...context(), company_id: companyId, actor_id: actorId });
  api.discover = async () => ({ company_id: companyId, workers: [] });
  api.status = async () => ({ company_id: companyId, work: [] });
  api.control = async () => ({ company_id: companyId, state: 'REQUESTED', receipt_id: 'receipt-route-safe',
    operation_id: operationId, correlation_id: correlationId, work_id: workId, evidence_refs: [] });
  const model = new WorkforceController(api, () => {}, storage);
  await model.connect();
  await model.submit({ action: 'pause', work_id: workId });
  const rawBookmark = storage.getItem('titan.directadmin.workforce.receipt.v1');
  assert.ok(rawBookmark, 'canonical IDs with printable Unicode and punctuation remain resumable');
  assert.ok(rawBookmark.length < 16384);
  const saved = JSON.parse(rawBookmark);
  assert.equal(saved.company_id, companyId);
  assert.equal(saved.actor_id, actorId);
  assert.equal(saved.operation_id, operationId);
  assert.equal(saved.correlation_id, correlationId);
  assert.equal(saved.work_id, workId);

  const priorControl = api.control;
  api.control = async () => ({ ...await priorControl(), receipt_id: '../unsafe' });
  await model.submit({ action: 'pause', work_id: workId });
  assert.equal(storage.getItem('titan.directadmin.workforce.receipt.v1'), null,
    'receipt IDs rejected by the fixed route contract are never persisted as lookup paths');
});
test('rejects cross-company root and nested data and clears prior projections', async () => {
  for (const payload of [{ company_id: 'company-b' }, { company_id: 'company-a', workers: [{ company_id: 'company-b', worker_id: 'private-b' }] }]) {
    const api = fixture(); api.discover = async () => payload; const model = new WorkforceController(api); await model.connect();
    assert.equal(model.state.phase, 'denied'); assert.equal(model.state.discovery, null); assert.doesNotMatch(JSON.stringify(model.state), /private-b/);
  }
});
test('revocation before submit prevents any action request', async () => {
  const api = fixture(); const model = new WorkforceController(api); await model.connect();
  api.context = async () => ({ ...context(), session_revision: '2' }); await model.submit({ action: 'resume' });
  assert.equal(api.calls.length, 0); assert.equal(model.state.phase, 'denied'); assert.equal(model.state.context, null);
});
test('company switch discards in-flight prior company response', async () => {
  const api = fixture(); let release;
  api.discover = () => new Promise(resolve => { release = resolve; });
  const model = new WorkforceController(api); const pending = model.connect(); await new Promise(resolve => setImmediate(resolve));
  model.invalidate(); release({ company_id: 'company-a', workers: [{ company_id: 'company-a', worker_id: 'old-private' }] }); await pending;
  assert.equal(model.state.discovery, null); assert.equal(model.state.phase, 'denied');
});
test('revocation while action in flight discards receipt', async () => {
  const api = fixture(); let release; api.control = () => new Promise(resolve => { release = resolve; });
  const model = new WorkforceController(api); await model.connect(); const pending = model.submit({ action: 'pause' });
  await new Promise(resolve => setImmediate(resolve)); model.invalidate(); release({ company_id: 'company-a', state: 'VERIFIED' }); await pending;
  assert.equal(model.state.receipt, null);
});
test('denied and unavailable responses erase data and redact errors', async () => {
  for (const error of ['titan-api-http-403 secret=do-not-render', 'ECONNRESET internal-host=private']) {
    const api = fixture(); const model = new WorkforceController(api); await model.connect(); api.control = async () => { throw Error(error); }; await model.submit({ action: 'pause' });
    assert.equal(model.state.discovery, null); assert.equal(model.state.context, null); assert.doesNotMatch(JSON.stringify(model.state), /do-not-render|internal-host/);
    assert.equal(model.state.phase, error.includes('403') ? 'denied' : 'unavailable');
  }
});
test('hosted action denial revalidates the same company, while revoked context stays cleared', async () => {
  for (const revoked of [false, true]) {
    const api = fixture();
    const canonicalContext = api.context;
    let contextReads = 0;
    api.context = async () => {
      contextReads++;
      if (revoked && contextReads === 3) throw Error('directadmin-http-401');
      return canonicalContext();
    };
    api.control = async () => { throw Error('directadmin-workforce-action-denied'); };
    const model = new WorkforceController(api);
    await model.connect();
    await model.submit({ action: 'cancel', work_id: 'company-a-work', reason: 'owner denial fixture' });
    assert.equal(contextReads, 3, '403 recovery makes one fresh canonical-context read');
    assert.equal(model.state.phase, revoked ? 'denied' : 'ready');
    assert.equal(model.state.context?.company_id ?? null, revoked ? null : 'company-a');
    assert.equal(model.state.discovery === null, revoked, 'revoked identity cannot retain the prior projection');
    assert.equal(model.state.receipt, null, 'a denied request never fabricates or preserves a receipt');
    if (!revoked) assert.match(model.state.error, /denial without a receipt.*outcome is unverified/i);
  }
});
test('reassignment denial, unknown outcome and stale response remain distinct and fail closed', async () => {
  const action = { action: 'reassign', work_id: 'ready-work', target_worker_id: 'worker-target', reason: 'Move the ready item' };
  const deniedApi = fixture(); const deniedModel = new WorkforceController(deniedApi); await deniedModel.connect();
  deniedApi.control = async () => { throw Error('directadmin-workforce-action-denied'); };
  await deniedModel.submit(action);
  assert.equal(deniedModel.state.phase, 'ready');
  assert.equal(deniedModel.state.context?.company_id, 'company-a');
  assert.equal(deniedModel.state.receipt, null);
  assert.match(deniedModel.state.error, /denial without a receipt.*outcome is unverified/i);

  const uncertainApi = fixture(); const uncertainModel = new WorkforceController(uncertainApi); await uncertainModel.connect();
  uncertainApi.control = async () => { throw Error('directadmin-http-503'); };
  await uncertainModel.submit(action);
  assert.equal(uncertainModel.state.phase, 'unavailable');
  assert.equal(uncertainModel.state.context, null);
  assert.equal(uncertainModel.state.discovery, null);
  assert.equal(uncertainModel.state.receipt, null);
  assert.match(uncertainModel.state.error, /outcome is unknown/i);

  const staleApi = fixture(); const staleModel = new WorkforceController(staleApi); await staleModel.connect();
  let controlCalls = 0; staleApi.control = async () => { controlCalls++; return { company_id: 'company-a', state: 'REQUESTED', receipt_id: 'stale' }; };
  staleApi.context = async () => ({ ...context(), context_revision: '2' });
  await staleModel.submit(action);
  assert.equal(controlCalls, 0, 'stale company/session context prevents the governed request');
  assert.equal(staleModel.state.phase, 'denied');
  assert.equal(staleModel.state.context, null);
  assert.equal(staleModel.state.receipt, null);

  const lateApi = fixture(); let release; let entered;
  const reachedOwner = new Promise(resolve => { entered = resolve; });
  lateApi.control = () => new Promise(resolve => { release = resolve; entered(); });
  const lateModel = new WorkforceController(lateApi); await lateModel.connect();
  const pending = lateModel.submit(action); await reachedOwner; lateModel.invalidate();
  release({ company_id: 'company-a', state: 'REQUESTED', receipt_id: 'late-reassignment-receipt', evidence_refs: ['late-evidence'] });
  await pending;
  assert.equal(lateModel.state.phase, 'denied');
  assert.equal(lateModel.state.context, null);
  assert.equal(lateModel.state.receipt, null, 'a late prior-company acknowledgement cannot restore receipt/evidence');
});
test('a denial without a receipt is not called denied when canonical work changed during the request', async () => {
  const api = fixture(); let statusReads = 0;
  const before = { company_id: 'company-a', work: [{ company_id: 'company-a', work_id: 'ready-work', state: 'READY',
    assignee: 'worker-old', context_refs: [], evidence_refs: [] }] };
  const after = { company_id: 'company-a', work: [{ company_id: 'company-a', work_id: 'ready-work', state: 'READY',
    assignee: 'worker-target', context_refs: [], evidence_refs: [] }] };
  api.status = async () => ++statusReads === 1 ? before : after;
  api.control = async () => { throw Error('directadmin-workforce-action-denied'); };
  const model = new WorkforceController(api); await model.connect();
  await model.submit({ action: 'reassign', work_id: 'ready-work', target_worker_id: 'worker-target', reason: 'Move ready work' });
  assert.equal(model.state.phase, 'ready');
  assert.equal(model.state.status.work[0].assignee, 'worker-target');
  assert.equal(model.state.receipt, null);
  assert.match(model.state.error, /denial without a receipt.*outcome is unverified/i);
});
test('receipt details arriving after context invalidation are discarded', async () => {
  const api = fixture(); let release; let entered;
  const reachedReceipt = new Promise(resolve => { entered = resolve; });
  api.control = async ctx => ({ company_id: ctx.company_id, state: 'REQUESTED', receipt_id: 'receipt-late',
    operation_id: 'operation-late', correlation_id: 'correlation-late', work_id: 'work-late', evidence_refs: [] });
  api.receipt = () => new Promise(resolve => { release = resolve; entered(); });
  const model = new WorkforceController(api); await model.connect();
  const submission = model.submit({ action: 'reassign', work_id: 'work-late', target_worker_id: 'worker-b', reason: 'stale detail' });
  await reachedReceipt; model.invalidate();
  release({ schema: 'titan.directadmin.workforce-receipt.v1', company_id: 'company-a', receipt_id: 'receipt-late',
    operation_id: 'operation-late', correlation_id: 'correlation-late', work_id: 'work-late', state: 'VERIFIED',
    verification: { status: 'VERIFIED', method: 'company-scoped-workforce-reread' }, evidence_refs: ['receipt-late'] });
  await submission;
  assert.equal(model.state.phase, 'denied');
  assert.equal(model.state.context, null);
  assert.equal(model.state.receipt, null);
  assert.equal(model.state.receiptLookupStatus, null);
});
test('late 403 after invalidation cannot reconnect or restore company data', async () => {
  for (const error of ['directadmin-http-403', 'directadmin-workforce-action-denied']) {
    const api = fixture();
    const originalContext = api.context;
    let contextReads = 0;
    api.context = async () => { contextReads++; return originalContext(); };
    let rejectControl;
    let enteredControl;
    const entered = new Promise(resolve => { enteredControl = resolve; });
    api.control = () => new Promise((_, reject) => { rejectControl = reject; enteredControl(); });
    const model = new WorkforceController(api);
    await model.connect();
    const submission = model.submit({ action: 'cancel', work_id: 'company-a-work' });
    await entered;
    model.invalidate();
    rejectControl(Error(error));
    await submission;
    assert.equal(contextReads, 2, `${error}: stale response does not trigger a second context read`);
    assert.equal(model.state.phase, 'denied');
    assert.equal(model.state.context, null);
    assert.equal(model.state.discovery, null);
    assert.equal(model.state.receipt, null);
  }
});
test('403 during post-submit refresh never claims the governed action was denied', async () => {
  const api = fixture();
  let model;
  let statusReads = 0;
  api.status = async () => {
    statusReads++;
    if (statusReads === 2) throw Error('directadmin-http-403');
    return { company_id: 'company-a', work: [] };
  };
  model = new WorkforceController(api);
  await model.connect();
  await model.submit({ action: 'cancel', work_id: 'company-a-work' });
  assert.equal(api.calls.length, 1, 'the governed ingress completed before refresh failed');
  assert.equal(model.state.phase, 'denied');
  assert.equal(model.state.context, null);
  assert.equal(model.state.receipt, null, 'session invalidation clears the local receipt');
  assert.match(model.state.error, /request was submitted.*could not be refreshed/i);
  assert.doesNotMatch(model.state.error, /host denied/i);
});
test('completion/ACK/self-report cannot claim verified outcome', () => {
  for (const state of ['COMPLETED', 'SUCCEEDED', 'PROVIDER_ACKNOWLEDGED']) {
    assert.equal(verifiedOutcome({ state, verified: true, evidence_refs: ['e1'] }), false);
    assert.notEqual(workState(state), 'Verified');
  }
  assert.equal(receiptState({ state: 'REQUESTED' }), 'Request accepted — verified outcome not yet available');
  assert.equal(verifiedOutcome({ state: 'VERIFIED', verification: { status: 'VERIFIED' }, evidence_refs: ['e1'] }), true);
  assert.equal(verifiedOutcome({ state: 'VERIFIED', verification: { status: 'VERIFIED' }, evidence_refs: [] }), false);
});
test('controls stay serialized until canonical refresh finishes', async () => {
  const api = fixture(); const model = new WorkforceController(api); await model.connect(); let release;
  api.status = () => new Promise(resolve => { release = resolve; });
  const pending = model.submit({ action: 'pause' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(model.state.phase, 'submitting'); await model.submit({ action: 'resume' }); assert.equal(api.calls.length, 1);
  release({ company_id: 'company-a', work: [] }); await pending; assert.equal(model.state.phase, 'ready');
});
test('unsupported VERIFIED receipt never renders verified outcome', async () => {
  const { receiptState } = await import('../images/presentation.mjs');
  assert.match(receiptState({ state: 'VERIFIED' }), /unproven/);
  assert.match(receiptState({ state: 'VERIFIED', verification: { status: 'VERIFIED' }, evidence_refs: [] }), /unproven/);
});
test('SDK summary is authority-neutral and clears evidence after denial', async () => {
  const { workforceContribution } = await import('../images/presentation.mjs');
  const ready = workforceContribution({ phase: 'ready', status: { work: [{ evidence_refs: ['fixture-evidence'] }] } }, 'reseller');
  assert.deepEqual(ready.widgets[0].permitted_actions, []);
  assert.deepEqual(ready.widgets[0].evidence_refs, ['fixture-evidence']);
  assert.equal(ready.navigation[0].route, '/CMD_PLUGINS_RESELLER/titan_workforce');
  const denied = workforceContribution({ phase: 'denied', status: { work: [{ evidence_refs: ['stale-evidence'] }] } });
  assert.deepEqual(denied.widgets[0].evidence_refs, []);
  assert.equal(denied.widgets[0].status, 'permission-denied');
});
test('malformed projection cannot masquerade as empty authorised roster', async () => {
  for (const discovery of [{ company_id: 'company-a' }, { company_id: 'company-a', workers: [{ worker_id: 'unscoped', kind: 'digital' }] }, { company_id: 'company-a', workers: [{ company_id: 'company-a', worker_id: 'ambiguous', kind: 'provider' }] }]) {
    const api = fixture(); api.discover = async () => discovery;
    const model = new WorkforceController(api); await model.connect();
    assert.notEqual(model.state.phase, 'ready'); assert.equal(model.state.discovery, null);
  }
});
test('context without a session revision is denied', async () => {
  const api = fixture(); api.context = async () => ({ company_id: 'company-a', actor_id: 'actor-a' });
  const model = new WorkforceController(api); await model.connect(); assert.equal(model.state.phase, 'denied');
});
test('malformed evidence references cannot label an outcome verified', () => {
  for (const evidence_refs of [[null], [''], ['   '], [{}], ['valid', null]]) {
    assert.equal(verifiedOutcome({ state: 'VERIFIED', verification: { status: 'VERIFIED' }, evidence_refs }), false);
  }
});
test('malformed optional collections fail closed before any view consumes them', async () => {
  const worker = { company_id: 'company-a', worker_id: 'w1', kind: 'digital' };
  const work = { company_id: 'company-a', work_id: 'job1', state: 'RUNNING' };
  for (const invalid of [null, {}, 'not-an-array', [null], [''], [{}]]) {
    for (const field of ['capabilities', 'context_refs', 'evidence_refs', 'required_capabilities', 'controls']) {
      const api = fixture();
      api.discover = async () => ({ company_id: 'company-a', workers: [{ ...worker, ...(field === 'capabilities' ? { capabilities: invalid } : {}) }], ...(field === 'controls' ? { controls: invalid } : {}) });
      api.status = async () => ({ company_id: 'company-a', work: [{ ...work, ...(['context_refs', 'evidence_refs', 'required_capabilities'].includes(field) ? { [field]: invalid } : {}) }] });
      const observed = [];
      const model = new WorkforceController(api, state => observed.push(state.phase));
      await model.connect();
      assert.equal(model.state.phase, 'unavailable', `${field}: ${JSON.stringify(invalid)}`);
      assert.equal(model.state.context, null);
      assert.equal(observed.includes('ready'), false);
    }
  }
});
test('malformed canonical refresh clears the prior receipt and company data', async () => {
  const api = fixture(); const model = new WorkforceController(api); await model.connect();
  api.status = async () => ({ company_id: 'company-a', work: [{ company_id: 'company-a', work_id: 'job1', state: 'RUNNING', evidence_refs: {} }] });
  await model.submit({ action: 'pause' });
  assert.equal(model.state.phase, 'unavailable');
  assert.equal(model.state.receipt, null);
  assert.equal(model.state.discovery, null);
  assert.match(model.state.error, /outcome is unknown/);
});
test('malformed optional display scalars are rejected before later tab rendering', async () => {
  for (const invalid of [{ toString: null }, {}, [], 123, false]) {
    for (const field of ['run_id', 'role', 'tier']) {
      const api = fixture();
      api.discover = async () => ({ company_id: 'company-a', workers: [{ company_id: 'company-a', worker_id: 'w1', kind: 'digital', ...(field === 'run_id' ? {} : { [field]: invalid }) }] });
      api.status = async () => ({ company_id: 'company-a', work: [{ company_id: 'company-a', work_id: 'job1', state: 'RUNNING', ...(field === 'run_id' ? { run_id: invalid } : {}) }] });
      const model = new WorkforceController(api); await model.connect();
      assert.equal(model.state.phase, 'unavailable');
      assert.equal(model.state.context, null);
    }
  }
});
test('roster requires explicit availability and rejects malformed team and manager IDs', async () => {
  const base = { company_id: 'company-a', worker_id: 'worker-a', kind: 'digital', active: true, capabilities: [] };
  for (const worker of [
    { ...base, active: undefined }, { ...base, active: 'active' },
    { ...base, team_id: '' }, { ...base, team_id: '   ' }, { ...base, team_id: {} },
    { ...base, manager_id: [] }, { ...base, manager_id: '' },
  ]) {
    const api = fixture(); api.discover = async () => ({ company_id: 'company-a', workers: [worker] });
    const model = new WorkforceController(api); await model.connect();
    assert.equal(model.state.phase, 'unavailable');
    assert.equal(model.state.context, null);
    assert.equal(model.state.discovery, null);
  }
});
test('team view is only a company roster projection and keeps human and AI identity types distinct', () => {
  const workers = [
    { company_id: 'company-a', worker_id: 'human-a', kind: 'human', active: true, team_id: 'crew-a' },
    { company_id: 'company-a', worker_id: 'digital-a', kind: 'digital', active: false, team_id: 'crew-a' },
    { company_id: 'company-a', worker_id: 'human-unassigned', kind: 'human', active: true },
  ];
  assert.equal(identityType(workers[0]), 'Human');
  assert.equal(identityType(workers[1]), 'AI / digital');
  assert.deepEqual(teamMemberships(workers), [
    { team_id: 'crew-a', members: workers.slice(0, 2) },
    { team_id: null, members: [workers[2]] },
  ]);
  assert.deepEqual(teamMemberships([]), []);
  assert.equal(workers.length, 3, 'projection grouping does not edit or duplicate the canonical roster');
});
test('evidence-backed cleaning skills stay company/context scoped and clear on invalidation', async () => {
  const api = fixture();
  const worker = { company_id: 'company-a', worker_id: 'cleaner-a', kind: 'human', active: true, team_id: 'crew-a', capabilities: ['general_cleaning'] };
  api.discover = async () => ({ company_id: 'company-a', workers: [worker], controls: [] });
  const skill = { worker_id: 'cleaner-a', capability_id: 'general_cleaning', proficiency: 4, proficiency_level: 'PROFICIENT',
    verification_state: 'VERIFIED', proof_state: 'verified', evidence_refs: ['cleaning-proof-a'], meets_registry_requirement: true,
    capability_presence_confers_authority: false, verification_confers_authority: false,
    performance_confers_authority: false, grants_authority: false };
  const projection = { schema: 'titan.workforce.evidence-backed-skill-proof.v1', company_id: 'company-a',
    workers: [{ worker_id: 'cleaner-a', skills: [skill], summary: { skill_count: 1, verified: 1, evidenced: 0,
      unverified: 0, expired_or_revoked: 0, requirement_gaps: 0 },
    worker_identity_confers_authority: false, grants_authority: false }], skill_proofs: [skill],
    summary: { worker_count: 1, skill_proof_count: 1, verified_skill_proofs: 1, evidenced_skill_proofs: 0,
      unverified_skill_proofs: 0, invalid_skill_proofs: 0, requirement_gaps: 0, workers_with_contextual_performance: 0 },
    read_only: true, derived: true, performance_is_context_only: true, grants_authority: false,
    execution_permitted: false, automatic_execution: false, assignment_decision: false, routing_decision: false, entitlement_decision: false };
  api.skills = async () => ({ schema: 'titan.directadmin.workforce-skills.v1', status: 'available',
    company_id: 'company-a', context_revision: 'context-a', read_only: true, capability_presence_confers_authority: false,
    verification_confers_authority: false, assignment_decision: false, routing_decision: false, entitlement_decision: false,
    execution_permitted: false, grants_authority: false,
    source: 'canonical-workforce-skill-capability-registry', freshness: null, source_revision: null,
    evidence_refs: ['cleaning-proof-a'],
    projection });
  const model = new WorkforceController(api);
  await model.connect();
  assert.equal(model.state.phase, 'ready');
  assert.equal(model.state.skills.evidence_refs[0], 'cleaning-proof-a');
  assert.equal(model.state.discovery.workers[0].worker_id, 'cleaner-a');
  model.invalidate();
  assert.equal(model.state.skills, null, 'session revocation clears skill proof/evidence with the roster');
  assert.equal(model.state.discovery, null);
});
test('malformed nested skill proofs and display summaries fail closed before rendering', async () => {
  const skill = { worker_id: 'cleaner-a', capability_id: 'general_cleaning', proficiency: 4, proficiency_level: 'PROFICIENT',
    verification_state: 'VERIFIED', proof_state: 'verified', evidence_refs: ['cleaning-proof-a'], meets_registry_requirement: true,
    capability_presence_confers_authority: false, verification_confers_authority: false,
    performance_confers_authority: false, grants_authority: false };
  const goodProjection = () => ({ schema: 'titan.workforce.evidence-backed-skill-proof.v1', company_id: 'company-a',
    workers: [{ worker_id: 'cleaner-a', skills: [structuredClone(skill)], summary: { skill_count: 1, verified: 1,
      evidenced: 0, unverified: 0, expired_or_revoked: 0, requirement_gaps: 0 },
    worker_identity_confers_authority: false, grants_authority: false }], skill_proofs: [structuredClone(skill)],
    summary: { worker_count: 1, skill_proof_count: 1, verified_skill_proofs: 1, evidenced_skill_proofs: 0,
      unverified_skill_proofs: 0, invalid_skill_proofs: 0, requirement_gaps: 0, workers_with_contextual_performance: 0 },
    read_only: true, derived: true, performance_is_context_only: true, grants_authority: false,
    execution_permitted: false, automatic_execution: false, assignment_decision: false, routing_decision: false, entitlement_decision: false });
  const mutations = [
    projection => { delete projection.summary; },
    projection => { projection.summary.verified_skill_proofs = 9; },
    projection => { projection.workers[0].skills[0] = null; },
    projection => { projection.workers[0].skills[0].worker_id = 'outside-roster'; },
    projection => { projection.workers[0].skills[0].grants_authority = true; },
    projection => { projection.workers[0].skills[0].evidence_refs = 'not-an-array'; },
    projection => { projection.workers[0].skills[0].proof_state = 'revoked'; },
    projection => { projection.skill_proofs[0].capability_presence_confers_authority = true; },
  ];
  for (const mutate of mutations) {
    const api = fixture();
    api.discover = async () => ({ company_id: 'company-a', workers: [
      { company_id: 'company-a', worker_id: 'cleaner-a', kind: 'human', active: true, capabilities: ['general_cleaning'] },
    ], controls: [] });
    const projection = goodProjection(); mutate(projection);
    api.skills = async () => ({ schema: 'titan.directadmin.workforce-skills.v1', company_id: 'company-a',
      context_revision: 'context-a', read_only: true, capability_presence_confers_authority: false,
      verification_confers_authority: false, assignment_decision: false, routing_decision: false, entitlement_decision: false,
      execution_permitted: false, grants_authority: false, status: 'available',
      source: 'canonical-workforce-skill-capability-registry', freshness: null, source_revision: null,
      evidence_refs: ['cleaning-proof-a'], projection });
    const model = new WorkforceController(api); await model.connect();
    assert.equal(model.state.phase, 'unavailable');
    assert.equal(model.state.context, null);
    assert.equal(model.state.skills, null);
    assert.equal(model.state.discovery, null);
    assert.equal(api.calls.length, 0);
  }
});
test('cross-company and stale skill proof projections are denied and cleared', async () => {
  for (const invalidSkills of [
    { schema: 'titan.directadmin.workforce-skills.v1', company_id: 'company-b', context_revision: 'context-a', read_only: true, grants_authority: false, status: 'unavailable', source: null, evidence_refs: [] },
    { schema: 'titan.directadmin.workforce-skills.v1', company_id: 'company-a', context_revision: 'stale-context', read_only: true, grants_authority: false, status: 'unavailable', source: null, evidence_refs: [] },
  ]) {
    const api = fixture(); api.skills = async () => invalidSkills;
    const model = new WorkforceController(api); await model.connect();
    assert.equal(model.state.phase, 'denied');
    assert.equal(model.state.context, null);
    assert.equal(model.state.discovery, null);
    assert.equal(model.state.skills, null);
    assert.doesNotMatch(JSON.stringify(model.state), /company-b|stale-context/);
  }
});
