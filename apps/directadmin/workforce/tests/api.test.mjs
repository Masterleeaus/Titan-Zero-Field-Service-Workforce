import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkforceApi } from '../images/api.mjs';
const context = { company_id: 'company-a', actor_id: 'actor-a', session_revision: 1, context_revision: '[5,2]' };
function fixture(controls = [{ action: 'pause', capability_id: 'canonical.pause' }], workers = [], work = []) {
  const calls = []; return { calls,
    connect: async () => context,
    projection: async plugin => { calls.push(['projection', plugin]); return { company_id: context.company_id, source: 'controlled-test-owner', freshness: '2026-10-02T00:00:00.000Z', evidence_refs: [], data: { schema: 'titan.workforce-cockpit.v1', company_id: context.company_id,
      discovery: { company_id: context.company_id, workers, controls },
      status: { company_id: context.company_id, work } } }; },
    intent: async (plugin, intent) => { calls.push(['intent', plugin, intent]); return { status: 'REQUESTED', receipt_id: 'receipt1', correlation_id: intent.correlation_id }; },
  };
}
test('consumer uses actual shared session routes and preserves REQUESTED acknowledgement', async () => {
  const session = fixture(); const api = new WorkforceApi(session, () => 'fixture-id'); const ctx = await api.context();
  await Promise.all([api.discover(ctx), api.status(ctx)]); assert.equal(session.calls.length, 1);
  const receipt = await api.control(ctx, { action: 'pause', work_id: 'work1', reason: 'Operator request', authority: 'root' });
  assert.equal(receipt.state, 'REQUESTED'); assert.deepEqual(receipt.evidence_refs, []);
  assert.deepEqual(session.calls[1], ['intent', 'titan_workforce', { company_id: 'company-a', actor_id: 'actor-a', capability_id: 'canonical.pause', operation_id: 'fixture-id', correlation_id: 'fixture-id', input: { action: 'pause', work_id: 'work1', reason: 'Operator request' } }]);
  await api.status(ctx); assert.equal(session.calls.length, 3); // post-effect refresh, not cached work truth
});
test('unsupported control and undiscovered capability never reach intent transport', async () => {
  for (const action of ['shell', 'resume', 'revoke']) {
    const session = fixture(); const api = new WorkforceApi(session); await assert.rejects(api.control(context, { action, work_id: 'work1', reason: 'test' }), /denied/);
    assert.equal(session.calls.filter(([kind]) => kind === 'intent').length, 0);
  }
});
test('published read-only projection is displayed but cannot submit a lifecycle intent', async () => {
  const session = fixture([]); const api = new WorkforceApi(session, () => 'fixture-id');
  const [discovery, status, metadata] = await Promise.all([api.discover(context), api.status(context), api.metadata(context)]);
  assert.deepEqual(discovery.controls, []);
  assert.deepEqual(status, { company_id: 'company-a', work: [] });
  assert.deepEqual(metadata, { source: 'controlled-test-owner', freshness: '2026-10-02T00:00:00.000Z', evidence_refs: [] });
  await assert.rejects(api.control(context, { action: 'cancel', work_id: 'work1', reason: 'must remain read-only' }), /denied/);
  assert.equal(session.calls.filter(([kind]) => kind === 'intent').length, 0);
});
test('skills accessor preserves typed host proofs, supports older hosts and reloads after company context changes', async () => {
  const session = fixture();
  const companyA = { schema: 'titan.directadmin.workforce-skills.v1', company_id: 'company-a', context_revision: context.context_revision,
    status: 'available', read_only: true, grants_authority: false, projection: { schema: 'titan.workforce.evidence-backed-skill-proof.v1' } };
  const companyBContext = { ...context, company_id: 'company-b', actor_id: 'actor-a', context_revision: 'ctx2' };
  const companyB = { ...companyA, company_id: 'company-b', context_revision: 'ctx2' };
  let current = context;
  let includeSkills = true;
  let projectionCalls = 0;
  session.connect = async () => current;
  session.projection = async () => {
    projectionCalls++;
    const projected = fixture().projection;
    const value = await projected('titan_workforce');
    value.company_id = current.company_id;
    value.data.company_id = current.company_id;
    value.data.discovery.company_id = current.company_id;
    value.data.status.company_id = current.company_id;
    if (includeSkills) value.data.discovery.skills = current.company_id === 'company-a' ? companyA : companyB;
    return value;
  };
  const api = new WorkforceApi(session);
  const ctxA = await api.context();
  assert.deepEqual(await api.skills(ctxA), companyA);
  includeSkills = false;
  await api.context();
  assert.equal(await api.skills(context), null, 'older hosts may omit the additive skills field');
  current = companyBContext;
  includeSkills = true;
  const ctxB = await api.context();
  assert.deepEqual(await api.skills(ctxB), companyB);
  assert.equal(projectionCalls, 3, 'each new context uses a fresh projection snapshot');
  assert.equal(JSON.stringify(await api.discover(ctxB)).includes('company-a'), false);
});
test('skills accessor fails closed on stale context or cross-company proof envelopes', async () => {
  for (const skills of [
    { schema: 'titan.directadmin.workforce-skills.v1', company_id: 'company-a', context_revision: 'old', status: 'available', read_only: true, grants_authority: false },
    { schema: 'titan.directadmin.workforce-skills.v1', company_id: 'company-b', context_revision: 'ctx1', status: 'available', read_only: true, grants_authority: false },
  ]) {
    const session = fixture();
    session.projection = async () => {
      const value = fixture().projection;
      const result = await value('titan_workforce');
      result.data.discovery.skills = skills;
      return result;
    };
    await assert.rejects(new WorkforceApi(session).skills(context), /skills-projection-invalid/);
  }
});
test('reassignment consumes the published READY descriptor and sends an assignee compare-and-set', async () => {
  const controls = [{ action: 'reassign', capability_id: 'titan.workforce.reassign',
    requires_fresh_approval: true, grants_authority: false }];
  const workers = [
    { company_id: 'company-a', worker_id: 'worker-old', kind: 'digital', active: true, capabilities: [] },
    { company_id: 'company-a', worker_id: 'worker-target', kind: 'digital', active: true, capabilities: ['work.site.schedule'] },
    { company_id: 'company-a', worker_id: 'worker-inactive', kind: 'human', active: false, capabilities: [] },
  ];
  const work = [
    { company_id: 'company-a', work_id: 'ready-work', state: 'READY', assignee: 'worker-old',
      required_capabilities: ['work.site.schedule'], context_refs: [], evidence_refs: [] },
    { company_id: 'company-a', work_id: 'active-work', state: 'IN_PROGRESS', assignee: 'worker-old', context_refs: [], evidence_refs: [] },
  ];
  const session = fixture(controls, workers, work); const api = new WorkforceApi(session, () => 'operation-a');
  const receipt = await api.control(context, { action: 'reassign', work_id: 'ready-work',
    target_worker_id: 'worker-target', reason: 'Balance the ready workload' });
  const intent = session.calls.find(([kind]) => kind === 'intent');
  assert.deepEqual(intent, ['intent', 'titan_workforce', {
    company_id: 'company-a', actor_id: 'actor-a', capability_id: 'titan.workforce.reassign',
    operation_id: 'operation-a', correlation_id: 'operation-a',
    input: { action: 'reassign', work_id: 'ready-work', expected_assignee_id: 'worker-old',
      target_worker_id: 'worker-target', reason: 'Balance the ready workload' },
  }]);
  assert.equal(receipt.state, 'REQUESTED');
  assert.deepEqual(receipt.evidence_refs, []);
});
test('reassignment is withheld for absent, malformed, non-READY or ineligible projected controls', async () => {
  const descriptor = { action: 'reassign', capability_id: 'titan.workforce.reassign',
    requires_fresh_approval: true, grants_authority: false };
  const goodWorkers = [
    { company_id: 'company-a', worker_id: 'worker-old', kind: 'digital', active: true, capabilities: [] },
    { company_id: 'company-a', worker_id: 'worker-target', kind: 'human', active: true, capabilities: [] },
  ];
  const readyWork = [{ company_id: 'company-a', work_id: 'ready-work', state: 'READY', assignee: 'worker-old', context_refs: [], evidence_refs: [] }];
  const cases = [
    { controls: [], workers: goodWorkers, work: readyWork },
    { controls: [{ ...descriptor, grants_authority: true }], workers: goodWorkers, work: readyWork },
    { controls: [{ ...descriptor, requires_fresh_approval: false }], workers: goodWorkers, work: readyWork },
    { controls: [{ ...descriptor, capability_id: 'titan.workforce.cancel' }], workers: goodWorkers, work: readyWork },
    { controls: [descriptor], workers: goodWorkers, work: [{ ...readyWork[0], state: 'IN_PROGRESS' }] },
    { controls: [descriptor], workers: [{ ...goodWorkers[1], active: false }], work: readyWork },
    { controls: [descriptor], workers: goodWorkers, work: [{ ...readyWork[0], required_capabilities: ['work.restricted'] }] },
    { controls: [descriptor], workers: goodWorkers, work: [{ ...readyWork[0], required_capabilities: 'work.restricted' }] },
    { controls: [descriptor], workers: [{ ...goodWorkers[1], company_id: 'company-b' }], work: readyWork },
    { controls: [descriptor], workers: goodWorkers, work: readyWork },
  ];
  const targetIds = ['worker-target', 'worker-target', 'worker-target', 'worker-target', 'worker-target',
    'worker-target', 'worker-target', 'worker-target', 'worker-target', 'worker-old'];
  for (let index = 0; index < cases.length; index++) {
    const input = cases[index];
    const session = fixture(input.controls, input.workers, input.work);
    const api = new WorkforceApi(session, () => 'operation-a');
    await assert.rejects(api.control(context, { action: 'reassign', work_id: 'ready-work',
      target_worker_id: targetIds[index], reason: 'test' }), /denied/);
    assert.equal(session.calls.some(([kind]) => kind === 'intent'), false);
  }
});
test('unassigned READY work binds expected_assignee_id to null', async () => {
  const session = fixture([{ action: 'reassign', capability_id: 'titan.workforce.reassign',
    requires_fresh_approval: true, grants_authority: false }],
  [{ company_id: 'company-a', worker_id: 'target', kind: 'human', active: true, capabilities: [] }],
  [{ company_id: 'company-a', work_id: 'ready-work', state: 'READY', context_refs: [], evidence_refs: [] }]);
  const api = new WorkforceApi(session, () => 'operation-unassigned');
  await api.control(context, { action: 'reassign', work_id: 'ready-work', target_worker_id: 'target', reason: 'Assign the ready item' });
  const intent = session.calls.find(([kind]) => kind === 'intent');
  assert.equal(intent[2].input.expected_assignee_id, null);
});
test('gateway response cannot promote request acknowledgement to verified or mismatch correlation', async () => {
  for (const response of [
    { status: 'VERIFIED', receipt_id: 'r', correlation_id: 'fixture-id' },
    { status: 'REQUESTED', receipt_id: 'r', correlation_id: 'other' },
    { status: 'REQUESTED', receipt_id: '../unsafe', correlation_id: 'fixture-id' },
    { status: 'REQUESTED', receipt_id: 'header.payload.signature', correlation_id: 'fixture-id' },
    { status: 'REQUESTED', receipt_id: `r${'x'.repeat(200)}`, correlation_id: 'fixture-id' },
  ]) {
    const session = fixture(); session.intent = async () => response; const api = new WorkforceApi(session, () => 'fixture-id');
    await assert.rejects(api.control(context, { action: 'pause', work_id: 'w', reason: 'test' }), /receipt-invalid/);
  }
});
test('receipt consumer reads a company-bound typed owner receipt and reports only persisted verification', async () => {
  const receipt = { schema: 'titan.directadmin.workforce-receipt.v1', company_id: 'company-a', receipt_id: 'receipt1',
    operation_id: 'operation1', correlation_id: 'correlation1', work_id: 'work1', state: 'VERIFIED',
    verification_status: 'verified', verification_method: 'company-scoped-workforce-reread-and-reassignment-event',
    evidence_refs: ['receipt1'] };
  const displayedReceipt = { schema: receipt.schema, company_id: receipt.company_id, receipt_id: receipt.receipt_id,
    operation_id: receipt.operation_id, correlation_id: receipt.correlation_id, work_id: receipt.work_id,
    state: receipt.state, verification: { status: 'VERIFIED',
      method: 'company-scoped-workforce-reread-and-reassignment-event' }, evidence_refs: receipt.evidence_refs };
  const session = fixture(); let reads = 0;
  session.receipt = async (plugin, receiptId) => { reads++; assert.equal(plugin, 'titan_workforce'); assert.equal(receiptId, 'receipt1'); return receipt; };
  const api = new WorkforceApi(session);
  assert.deepEqual(await api.receipt(context, 'receipt1', { operation_id: 'operation1', correlation_id: 'correlation1', work_id: 'work1' }), displayedReceipt);
  assert.equal(reads, 1);
  assert.deepEqual(await api.receipt(context, 'receipt1'), displayedReceipt);
  assert.equal(reads, 2, 'replay reads the same canonical receipt without a local receipt store');
});
test('receipt route ID stays path-safe while canonical receipt fields accept bounded Unicode IDs', async () => {
  const receiptId = 'receipt-safe_123';
  const operationId = 'operation/東京 "quoted"';
  const correlationId = 'correlation:東京';
  const workId = `work / 東京 "quoted" ${'x'.repeat(220)}`;
  const receipt = { schema: 'titan.directadmin.workforce-receipt.v1', company_id: 'company-a', receipt_id: receiptId,
    operation_id: operationId, correlation_id: correlationId, work_id: workId, state: 'VERIFIED',
    verification_status: 'verified', verification_method: 'company-scoped-workforce-reread-and-reassignment-event',
    evidence_refs: [receiptId] };
  const session = fixture(); let reads = 0;
  session.receipt = async (plugin, id) => { reads++; assert.equal(plugin, 'titan_workforce'); assert.equal(id, receiptId); return receipt; };
  const api = new WorkforceApi(session);
  const detail = await api.receipt(context, receiptId, { operation_id: operationId, correlation_id: correlationId, work_id: workId });
  assert.ok(workId.length > 200);
  assert.equal(detail.work_id, workId);
  assert.equal(detail.operation_id, operationId);
  assert.equal(detail.correlation_id, correlationId);
  assert.equal(reads, 1);

  for (const invalidReceiptId of ['../unsafe', '/receipt', 'receipt?query', 'receipt#fragment']) {
    await assert.rejects(api.receipt(context, invalidReceiptId), /receipt-invalid/);
  }
  assert.equal(reads, 1, 'invalid route IDs are rejected before calling the shared SDK');
});
test('receipt lookup never infers verification from a reference and rejects stale or cross-company receipt data', async () => {
  const good = { schema: 'titan.directadmin.workforce-receipt.v1', company_id: 'company-a', receipt_id: 'receipt1',
    operation_id: 'operation1', correlation_id: 'correlation1', work_id: 'work1', state: 'VERIFIED',
    verification_status: 'verified', verification_method: 'company-scoped-workforce-reread-and-reassignment-event',
    evidence_refs: ['receipt1'] };
  for (const value of [
    { ...good, company_id: 'company-b' },
    { ...good, state: 'REQUESTED' },
    { ...good, verification_status: 'unverified' },
    { ...good, verification_method: 'provider-ack' },
    { ...good, evidence_refs: ['unrelated-work-reference'] },
    { ...good, correlation_id: 'other' },
    { receipt: good },
    { context, receipt: good }, // The SDK owns the envelope and returns only its validated typed receipt.
  ]) {
    const session = fixture(); session.receipt = async () => value;
    await assert.rejects(new WorkforceApi(session).receipt(context, 'receipt1', {
      operation_id: 'operation1', correlation_id: 'correlation1', work_id: 'work1' }), /receipt|context-changed/);
  }
  const session = fixture(); let reads = 0; session.receipt = async () => { reads++; return good; };
  session.connect = async () => ({ ...context, context_revision: 'changed' });
  await assert.rejects(new WorkforceApi(session).receipt(context, 'receipt1'), /context-changed/);
  assert.equal(reads, 0, 'stale context stops before the receipt endpoint');
  const switched = fixture(); let connects = 0; switched.receipt = async () => good;
  switched.connect = async () => ++connects === 1 ? context : { ...context, context_revision: 'changed-after-read' };
  await assert.rejects(new WorkforceApi(switched).receipt(context, 'receipt1'), /context-changed/);
  assert.equal(connects, 2, 'the consumer discards a receipt when context changes during the read');
  const oldHostSession = fixture(); let oldHostContextReads = 0;
  oldHostSession.connect = async () => { oldHostContextReads++; return context; };
  const oldHost = new WorkforceApi(oldHostSession);
  assert.equal(await oldHost.receipt(context, 'receipt1'), null, 'an older SDK cannot fabricate receipt details');
  assert.equal(oldHostContextReads, 0, 'an unsupported receipt route does not make an unnecessary host request');
  const largeContext = { ...context, context_revision: `[5,"${'x'.repeat(1024)}"]` };
  const longRevisionHost = fixture(); longRevisionHost.connect = async () => largeContext;
  longRevisionHost.receipt = async () => good;
  assert.deepEqual(await new WorkforceApi(longRevisionHost).receipt(largeContext, 'receipt1'), {
    schema: good.schema, company_id: good.company_id, receipt_id: good.receipt_id,
    operation_id: good.operation_id, correlation_id: good.correlation_id, work_id: good.work_id,
    state: good.state, verification: { status: 'VERIFIED', method: good.verification_method },
    evidence_refs: good.evidence_refs,
  },
    'opaque canonical context revisions may use the shared SDK 4096-character bound');
});
test('cross-company or unversioned projection rejected', async () => {
  for (const projection of [{ company_id: 'company-b', data: { schema: 'titan.workforce-cockpit.v1' } }, { company_id: 'company-a', data: {} }]) {
    const session = fixture(); session.projection = async () => projection;
    await assert.rejects(new WorkforceApi(session).discover(context), /projection-invalid/);
  }
});
