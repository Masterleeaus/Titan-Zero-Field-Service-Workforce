import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { createProductionRuntimeBootstrap } from './production-runtime-bootstrap.ts';
import { SqliteWorkforceStore } from './sqlite-store.ts';
import { assertAuthorityDecisionAllowsExecution } from '../../../packages/runtime/authority/authority-evaluator.mjs';
import { SqliteAuthorityStore, AuthorityContextResolver, WorkerAccessResolver, SqliteWorkerAccessStore } from '../../../packages/runtime/authority/index.mjs';
import { ExecutionGateway, boundedAdapterCall, executionRequestFingerprint } from '../../../packages/tools/execution-gateway.mjs';
import { GovernedExecutionRecovery, SqliteExecutionLifecycleStore } from '../../../packages/tools/governed-execution-recovery.mjs';
import { AcceptedEvidenceLedger, rebuildJobProjection } from '../../../packages/tools/accepted-evidence-ledger.mjs';
import { resolveAcceptedEvidenceReferencesInTransaction } from './accepted-evidence-reference-resolver.mjs';

const CAPABILITY = 'crm.work_order.complete';
const command = text => /^complete work order ([a-zA-Z0-9_-]+)$/i.exec(String(text).trim())?.[1] ?? null;
const one = async (storage, sql, params) => (await storage.query(sql, params)).rows[0] ?? null;
const TASK_DISPOSITIONS = new Set(['ok', 'fix_now', 'monitor', 'optional', 'refer']);
export function verifiedTaskLineageFromProducerEvent(evidence) {
  const observed = evidence.observed_result;
  const verification = evidence.verification;
  const observedContext = observed?.evidence_context;
  const verifiedContext = verification?.evidence_context;
  if (verification?.verified !== true || !observedContext || !verifiedContext
    || !isDeepStrictEqual(observedContext, verifiedContext)) return null;
  const { company_id, work_order_id, visit_id, task_id, disposition } = verifiedContext;
  if (company_id !== evidence.company_id || work_order_id !== evidence.request_summary?.input?.work_order_id
    || ![visit_id, task_id].every(value => typeof value === 'string' && value.trim())
    || !TASK_DISPOSITIONS.has(disposition)) return null;
  return Object.freeze({ company_id, work_order_id, visit_id, task_id, disposition });
}
export function assertReplayTaskLineage(priorPayload, currentBusiness) {
  const priorContext = priorPayload?.accepted_evidence?.request_summary?.canonical_operation_context;
  if (priorContext && !isDeepStrictEqual(priorContext, currentBusiness?.evidence_context)) {
    throw new Error('zero-replay-task-context-no-longer-verified');
  }
}

/** Bounded production composition, using the existing business completion owner.
 * Authority material is read, never issued here. The explicit command adapter is
 * deliberately limited; it is not a general language planner or another engine.
 */
export async function createFieldServiceRuntime({ storage, workOrders, revalidateIdentity, sessionAdmission, timeoutMs = 30_000, signal } = {}) {
  if (!storage || storage.dialect !== 'sqlite') throw new Error('zero-sqlite-storage-required');
  for (const method of ['complete', 'read']) if (typeof workOrders?.[method] !== 'function') throw new Error(`production-runtime-port-required:workOrders.${method}`);
  if (revalidateIdentity !== undefined && typeof revalidateIdentity !== 'function') throw new Error('production-runtime-port-required:revalidateIdentity');
  if (sessionAdmission !== undefined && typeof sessionAdmission !== 'function') throw new Error('production-runtime-port-required:sessionAdmission');
  // Same canonical control-state tables used by db/sqlite/001_canonical.sql.
  // A standalone control store has no business companies table: company_id is
  // resolved by authenticated ingress and the protected company storage map.
  // Existing installations (including their foreign keys) are left intact.
  await storage.query("CREATE TABLE IF NOT EXISTS authority_state (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, level TEXT NOT NULL, envelope TEXT NOT NULL DEFAULT '{}', granted_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(company_id,subject_type,subject_id))");
  await storage.query("CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, evidence_type TEXT NOT NULL, provenance TEXT NOT NULL DEFAULT '{}', payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await storage.query('CREATE INDEX IF NOT EXISTS idx_authority_company_subject ON authority_state(company_id,subject_type,subject_id)');
  await storage.query('CREATE INDEX IF NOT EXISTS idx_evidence_company_subject ON evidence(company_id,subject_type,subject_id)');
  // Apply only the existing authority/access owners' fixed, versioned SQL.
  // Their complete statements end at line boundaries (trigger bodies included).
  // This initializes schemas, never grants, approvals, autonomy or field proofs.
  for (const migration of ['003_authority_persistence.sql', '004_worker_access.sql']) {
    const sql = await readFile(new URL(`../../../db/sqlite/${migration}`, import.meta.url), 'utf8');
    await storage.transaction(async tx => {
      let statement = '';
      for (const line of sql.split(/\r?\n/)) {
        if (!line.trim() || line.trimStart().startsWith('--')) continue;
        statement += line + '\n';
        if (line.trimEnd().endsWith(';')) { await tx.query(statement); statement = ''; }
      }
      if (statement.trim()) throw new Error(`incomplete-owner-migration:${migration}`);
    });
  }
  const lifecycleStore = new SqliteExecutionLifecycleStore(storage);
  await lifecycleStore.migrate();
  const executionId = (company_id, work_order_id) => `native:${createHash('sha256').update(JSON.stringify([company_id, CAPABILITY, work_order_id])).digest('hex')}`;
  const callAdapter = async (operation, input, callSignal = signal) => {
    const result = await boundedAdapterCall(childSignal => operation({ ...input, signal: childSignal }), { timeoutMs, signal: callSignal });
    callSignal?.throwIfAborted();
    return result;
  };
  const currentIdentity = async (input, callSignal = signal) => {
    if (revalidateIdentity) await callAdapter(revalidateIdentity, input, callSignal);
    callSignal?.throwIfAborted();
  };
  const readBusiness = (input, callSignal = signal) => callAdapter(value => workOrders.read(value), input, callSignal);
  const authorityStore = new SqliteAuthorityStore(storage);
  const accessResolver = new WorkerAccessResolver({ store: new SqliteWorkerAccessStore(storage) });
  const workers = new SqliteWorkforceStore(storage);
  await workers.migrate();

  async function authorize(input, options = {}) {
    const { company_id, actor_id, agent_id, work_id, run_id } = input;
    if (!options.skipIdentity) await currentIdentity({ company_id, actor_id, run_id, work_id });
    const control = options.control ?? storage;
    const decisions = control === storage ? authorityStore : new SqliteAuthorityStore(control);
    const access = control === storage ? accessResolver : new WorkerAccessResolver({ store: new SqliteWorkerAccessStore(control) });
    const roster = control === storage ? workers : new SqliteWorkforceStore(control);
    const work_order_id = input.input?.work_order_id;
    const row = await one(control, 'SELECT envelope FROM authority_state WHERE company_id=$1 AND subject_type=$2 AND subject_id=$3', [company_id, 'worker_capability', `${agent_id}/${CAPABILITY}`]);
    const grant = row ? JSON.parse(row.envelope) : {};
    const worker = await roster.getWorker(company_id, agent_id);
    const business = Object.hasOwn(options, 'business') ? options.business : await readBusiness({ company_id, actor_id, run_id, work_id, work_order_id });
    const refs = [];
    for (const id of Array.isArray(grant.evidence_refs) ? grant.evidence_refs : []) {
      const proof = await one(control, `SELECT id FROM evidence WHERE company_id=$1 AND id=$2 AND subject_type=$3 AND subject_id=$4 AND evidence_type='field_completion'`, [company_id, id, 'work_order', work_order_id]);
      if (proof) refs.push(proof.id);
    }
    const scoped = grant.actor_id === actor_id && grant.work_order_id === work_order_id && !!business && worker?.active && worker.capabilities.includes(CAPABILITY);
    const resolver = new AuthorityContextResolver({
      authorityStore: decisions,
      requirementResolver: { async resolve() { return { company_id, capability: CAPABILITY, operation: 'complete', effect: 'write', required_permissions: [CAPABILITY], required_evidence: ['field_completion'], minimum_autonomy_score: 51 }; } },
      accessResolver: access,
      governanceResolver: { async resolve() { return {
        policy_allows: scoped && grant.policy_allows === true,
        governance_allows: scoped && grant.governance_allows === true,
        assurance_allows: scoped && grant.assurance_allows === true,
      }; } },
      evidenceResolver: { async resolve() { return { status: refs.length ? 'satisfied' : 'missing', refs }; } },
      riskResolver: { async resolve() { return { level: grant.risk ?? 'critical', source: 'authority_state' }; } },
      connectivityResolver: { async resolve() { return { state: 'online' }; } },
    });
    const authority = await resolver.evaluate({
      company_id, agent_id, capability: CAPABILITY, authority_decision_id: randomUUID(),
      operation_id: work_id, action_id: work_order_id, surface: 'zero',
    });
    const decision = { ...authority, decision_id: authority.authority_decision_id, actor_id, run_id, work_id, work_order_id, risk: grant.risk ?? "critical",
      status: authority.decision === 'ALLOW' ? 'allowed' : authority.decision === 'APPROVAL_REQUIRED' ? 'approval_required' : 'denied' };
    await decisions.appendDecision(decision);
    return decision;
  }

  async function execute(input) {
    const { company_id, work_id, run_id, agent_id } = input;
    // Re-read durable authority and reevaluate its current grant at execution time.
    // Runtime/model supplied booleans are never accepted as an execution grant.
    const decision = await authorityStore.getDecision(company_id, input.decision?.decision_id);
    if (!decision) throw new Error('zero-decision-not-found');
    if (decision.run_id !== run_id || decision.work_id !== work_id || decision.worker_id !== agent_id || decision.work_order_id !== input.input?.work_order_id) throw new Error('zero-decision-binding-conflict');
    const current = await authorize({ company_id, actor_id: decision.actor_id, agent_id, run_id, work_id, input: input.input });
    if (current.status !== 'allowed') return { state: current.status === 'approval_required' ? 'WAITING_APPROVAL' : 'DENIED', failure: { code: current.decision }, decision: current };
    assertAuthorityDecisionAllowsExecution(current, { company_id, capability: CAPABILITY, operation_id: work_id, action_id: current.work_order_id, worker_id: agent_id, now: new Date().toISOString() });
    const businessInput = { company_id, actor_id: current.actor_id, run_id, work_id, work_order_id: current.work_order_id };
    const idempotency_key = JSON.stringify([CAPABILITY, current.work_order_id]);
    const toResult = evidence => ({ request_fingerprint: executionRequestFingerprint({ company_id: evidence.company_id, capability: evidence.capability, input: evidence.request_summary?.input, idempotency_key: evidence.idempotency_key }), execution_id: evidence.execution_id, company_id, state: evidence.state, capability: CAPABILITY, evidence });
    let effectDecision;
    let fencedDecision;
    let executionSignal = signal;
    const persistEvidence = async (tx, evidence) => {
      // Rebuild through the canonical ledger inside the append transaction. The
      // existing evidence table remains the durable owner; no parallel ledger.
      const history = await tx.query("SELECT payload FROM evidence WHERE company_id=$1 AND subject_type='work' AND subject_id=$2 AND evidence_type='gateway_execution' ORDER BY rowid", [company_id, work_id]);
      // The ExecutionGateway's immutable terminal evidence_id is the canonical
      // persisted reference for this independent verification when the provider
      // has no separate verification record ID. Never derive an ID from execution
      // input or a caller-supplied label.
      const verificationId = evidence.state === 'VERIFIED' && evidence.verification?.verified === true
        ? (evidence.verification.verification_id === undefined
          ? evidence.evidence_id
          : typeof evidence.verification.verification_id === 'string' && evidence.verification.verification_id.trim()
            ? evidence.verification.verification_id.trim()
            : null)
        : null;
      if (evidence.state === 'VERIFIED' && evidence.verification?.verified === true && !verificationId) {
        throw new Error('zero-verification-reference-invalid');
      }
      const verifiedEvidence = verificationId && evidence.verification?.verification_id !== verificationId
        ? { ...evidence, verification: { ...evidence.verification, verification_id: verificationId } }
        : evidence;
      const taskLineage = verifiedEvidence.state === 'VERIFIED' ? verifiedTaskLineageFromProducerEvent(verifiedEvidence) : null;
      // The work order and actor originate from the current authority decision;
      // visit/task/disposition only come from equal execution and independent
      // reread contexts returned by the native company-store owner.
      const persistedEvidence = taskLineage ? {
        ...verifiedEvidence,
        request_summary: { ...verifiedEvidence.request_summary,
          canonical_operation_context: taskLineage },
        observed_result: { ...verifiedEvidence.observed_result, ...taskLineage },
        verification: { ...verifiedEvidence.verification, ...taskLineage },
      } : verifiedEvidence;
      const ledger = new AcceptedEvidenceLedger();
      for (const row of history.rows) {
        const prior = JSON.parse(row.payload);
        ledger.now = () => prior.accepted_evidence?.recorded_at ?? prior.finished_at;
        ledger.append({ ...prior, ...prior.accepted_evidence });
      }
      ledger.now = () => persistedEvidence.finished_at;
      const accepted_evidence = ledger.append(persistedEvidence);
      const run = await one(tx, 'SELECT payload FROM agent_runs WHERE company_id=$1 AND run_id=$2', [company_id, run_id]);
      const identity = run ? JSON.parse(run.payload) : {};
      const provenance = { decision_id: current.decision_id, company_id, actor_id: current.actor_id,
        run_id, work_id, conversation_id: identity.conversation_id ?? null,
        request_id: identity.request_id ?? null, operation_id: identity.operation_id ?? null,
        trace_id: identity.trace_id ?? null, correlation_id: identity.correlation_id ?? null,
        interaction_id: identity.interaction_id ?? null,
        idempotency_key: identity.idempotency_key ?? idempotency_key, execution_idempotency_key: idempotency_key,
        source_evidence_refs: current.evidence_refs, effect_authority_decision_id: effectDecision?.decision_id ?? null,
        ...(taskLineage ?? {}) };
      await tx.query('INSERT INTO evidence(id,company_id,subject_type,subject_id,evidence_type,provenance,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [persistedEvidence.evidence_id, company_id, 'work', work_id, 'gateway_execution', JSON.stringify(provenance), JSON.stringify({ ...persistedEvidence, provenance, accepted_evidence })]);
    };
    const admitExecution = async (evidence, business) => {
      const admit = async ({ proof, authenticated_identity, signal: fenceSignal, acquire_deadline_ms } = {}) => storage.transaction(async tx => {
        const assertAdmissionLive = () => { executionSignal?.throwIfAborted(); fenceSignal?.throwIfAborted(); };
        assertAdmissionLive();
        const row = await one(tx, 'SELECT payload FROM agent_runs WHERE company_id=$1 AND run_id=$2', [company_id, run_id]);
        assertAdmissionLive();
        const run = row ? JSON.parse(row.payload) : null;
        if (authenticated_identity && !isDeepStrictEqual(run?.authenticated_identity, authenticated_identity)) {
          throw new Error('zero-run-session-proof-changed');
        }
        if (authenticated_identity && !authenticated_identity.source_session) {
          const expiresAt = Date.parse(authenticated_identity.credential_expires_at ?? '');
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('runtime-credential-expired');
        }
        if (run?.state === 'CANCELLED') throw new Error('zero-run-cancelled');
        if (!run || run.work_id !== work_id || !['RUNNING', 'WAITING_TOOL'].includes(run.state)) throw new Error('zero-run-not-executing');
        fencedDecision = await authorize({ company_id, actor_id: current.actor_id, agent_id, run_id, work_id, input: input.input }, { control: tx, skipIdentity: true, business });
        assertAdmissionLive();
        if (fencedDecision.status !== 'allowed') throw new Error('zero-effect-authority-revoked');
        assertAuthorityDecisionAllowsExecution(fencedDecision, { company_id, capability: CAPABILITY, operation_id: work_id, action_id: current.work_order_id, worker_id: agent_id, now: new Date().toISOString() });
        // Admission and the durable EXECUTING transition share this exact
        // control transaction. No provider work runs until both fences release.
        effectDecision = fencedDecision;
        await persistEvidence(tx, evidence);
        assertAdmissionLive();
        if (authenticated_identity) {
          const admissionCheckedAt = Date.parse(new Date().toISOString());
          const expiresAt = Date.parse(authenticated_identity.credential_expires_at ?? '');
          if (!Number.isFinite(expiresAt) || expiresAt <= admissionCheckedAt) throw new Error('runtime-credential-expired');
        }
        return { decision: fencedDecision, proof };
      }, acquire_deadline_ms === undefined ? undefined : { acquireDeadlineMs: acquire_deadline_ms });
      if (sessionAdmission) {
        return sessionAdmission({ company_id, actor_id: current.actor_id, run_id, work_id, signal: executionSignal }, admit);
      }
      // Standalone runtime tests have no hosted identity owner. Hosted
      // production always supplies sessionAdmission.
      await currentIdentity({ company_id, actor_id: current.actor_id, run_id, work_id }, executionSignal);
      return admit();
    };
    const evidenceSink = async evidence => {
      if (evidence.state === 'EXECUTING') {
        // This possibly slow company read occurs before either admission lock.
        const business = await readBusiness(businessInput, executionSignal);
        await admitExecution(evidence, business);
        return;
      }
      return storage.transaction(tx => persistEvidence(tx, evidence));
    };
    const gateway = new ExecutionGateway({
      timeoutMs, evidenceSink,
      idempotencyStore: {
        async get() {
          const row = await one(storage, "SELECT payload FROM evidence WHERE company_id=$1 AND evidence_type='gateway_execution' AND json_extract(payload,'$.idempotency_key')=$2 AND json_extract(payload,'$.state')='VERIFIED' ORDER BY created_at DESC LIMIT 1", [company_id, idempotency_key]);
          if (!row) return null;
          const business = await readBusiness(businessInput);
          if (business?.status !== 'completed' || !business.completed_at) throw new Error('zero-replay-outcome-no-longer-verified');
          const prior = JSON.parse(row.payload);
          assertReplayTaskLineage(prior, business);
          return toResult(prior);
        },
        // VERIFIED evidence is the durable replay record, already committed by record().
        async set(_key, result) {
          const row = await one(storage, 'SELECT id FROM evidence WHERE company_id=$1 AND id=$2', [company_id, result.evidence.evidence_id]);
          if (!row) throw new Error('zero-execution-evidence-not-durable');
        },
      },
      providers: [{
        id: 'native-assigned-work-order', executionClass: 'native', company_id, capabilities: [CAPABILITY],
        async execute(request) {
          if (!fencedDecision) throw new Error('zero-effect-admission-missing');
          request.signal?.throwIfAborted();
          const assertCurrent = childSignal => {
            childSignal?.throwIfAborted();
            request.signal?.throwIfAborted();
            assertAuthorityDecisionAllowsExecution(fencedDecision, { company_id, capability: CAPABILITY, operation_id: work_id, action_id: current.work_order_id, worker_id: agent_id, now: new Date().toISOString() });
          };
          const completed = await boundedAdapterCall(childSignal => {
            assertCurrent(childSignal);
            const operation = { ...businessInput, signal: childSignal, authorityFence: { assertCurrent: () => assertCurrent(childSignal) } };
            return workOrders.complete(operation);
          }, { timeoutMs, signal: request.signal });
          assertCurrent(request.signal);
          if (completed.kind !== 'ok') throw new Error(`work-order-${completed.kind}:${completed.message ?? 'completion rejected'}`);
          return { external_ref: current.work_order_id, result: completed };
        },
        async verify(_raw, request) {
          await currentIdentity({ company_id, actor_id: current.actor_id, run_id, work_id }, request.signal);
          const business = await readBusiness(businessInput, request.signal);
          const observedContext = _raw?.result?.evidence_context;
          const currentContext = business?.evidence_context;
          const evidence_context = observedContext && currentContext && isDeepStrictEqual(observedContext, currentContext)
            ? currentContext : null;
          return { verified: business?.status === 'completed' && !!business.completed_at,
            method: 'independent-company-scoped-business-reread', work_order_id: current.work_order_id,
            observed_status: business?.status ?? null,
            ...(evidence_context ? { evidence_context, ...evidence_context } : {}) };
        },
      }],
    });
    const run = await bootstrap.runStore.get(company_id, run_id);
    const request = { execution_id: executionId(company_id, current.work_order_id), company_id, decision_id: current.decision_id,
      actor_id: current.actor_id, work_id, run_id, agent_id, capability: CAPABILITY, idempotency_key,
      conversation_id: run?.conversation_id, request_id: run?.request_id, operation_id: run?.operation_id,
      trace_id: run?.trace_id, correlation_id: run?.correlation_id, interaction_id: run?.interaction_id,
      input: { work_order_id: current.work_order_id }, signal, timeoutMs,
      authority: { status: 'approved', expires_at: current.authority_lease?.lease_expires_at }, risk: { status: 'approved' } };
    executionSignal = request.signal;
    const recovery = new GovernedExecutionRecovery({ gateway, store: lifecycleStore });
    const previous = await recovery.start(request);
    if (input.recovery && previous.status === 'READY') throw new Error('zero-execution-not-started');
    if (previous.status === 'VERIFIED') {
      const observed = await readBusiness(businessInput);
      if (observed?.status !== 'completed' || !observed.completed_at) throw new Error('zero-replay-outcome-no-longer-verified');
    }
    return recovery.resume(request.execution_id, request);
  }

  async function prepareRecovery(input) {
    const work_order_id = input.tool_call?.arguments?.work_order_id;
    if (input.tool_call?.name !== CAPABILITY || !work_order_id) throw new Error('zero-execution-recovery-unavailable');
    const execution_id = executionId(input.company_id, work_order_id);
    const record = await lifecycleStore.get(input.company_id, execution_id);
    if (!record || record.status === 'READY' || record.request?.run_id !== input.run_id || record.request?.work_id !== input.work_id || record.request?.actor_id !== input.actor_id) throw new Error('zero-execution-recovery-binding-conflict');
    const decision = await authorize({ ...input, input: { work_order_id } });
    if (decision.status !== 'allowed') throw new Error('zero-recovery-authority-required');
    return { tool_call: input.tool_call, decision, execution: { state: 'UNCERTAIN', execution_id, company_id: input.company_id } };
  }

  async function resume(input) {
    const work_order_id = input.tool_input?.work_order_id;
    if (input.execution?.execution_id !== executionId(input.company_id, work_order_id)) throw new Error('zero-execution-recovery-binding-conflict');
    const decision = await authorize({ ...input, input: { work_order_id } });
    if (decision.status !== 'allowed') return { state: decision.status === 'approval_required' ? 'WAITING_APPROVAL' : 'DENIED' };
    return execute({ ...input, decision, input: { work_order_id }, recovery: true });
  }

  const bootstrap = await createProductionRuntimeBootstrap({ storage, ports: {
    modelRouter: { async next({ identity, messages }) {
      const lastTool = messages.findLast(m => m.role === 'tool');
      if (lastTool?.error) throw new Error(lastTool.error);
      if (lastTool) return { final: 'Work-order completion independently verified. See the persisted outcome and evidence.' };
      const id = command(messages.findLast(m => m.role === 'user')?.content);
      if (!id) return { wait: { state: 'WAITING_USER', reason: 'Use: complete work order <id>' } };
      return { tool_calls: [{ id: `${identity.run_id}:complete`, name: CAPABILITY, arguments: { work_order_id: id } }] };
    } },
    capabilities: { async resolve({ company_id, name, agent_id }) {
      const worker = await workers.getWorker(company_id, agent_id);
      return name === CAPABILITY && worker?.active && worker.capabilities.includes(name) ? { name } : null;
    } },
    contextProvider: { async load({ company_id }) { return { company_id }; } },
    authorityGateway: { authorize, execute, resume, prepareRecovery },
  } });

  async function project({ company_id, actor_id, work_id }) {
    const work = await bootstrap.zeroDispatcher.reconcilePersistedWork({ company_id, actor_id, work_id });
    if (!work || work.origin?.actor_id !== actor_id) return null;
    const run = await bootstrap.runStore.findByWork(company_id, work_id);
    const id = run?.messages.filter(m => m.role === 'user').map(m => command(m.content)).find(Boolean);
    const business = id && run?.run_id ? await readBusiness({ company_id, actor_id, run_id: run.run_id, work_id, work_order_id: id }) : null;
    const rows = await storage.query("SELECT payload FROM evidence WHERE company_id=$1 AND evidence_type='gateway_execution' AND (subject_id=$2 OR id IN (SELECT value FROM json_each($3))) ORDER BY rowid", [company_id, work_id, JSON.stringify(work.evidence_refs)]);
    const evidence = rows.rows.map(row => JSON.parse(row.payload));
    // Legacy gateway rows are normalized on read, preserving existing history.
    // New rows retain their accepted timestamp and sequence across restart.
    const ledgers = new Map();
    const accepted_evidence = evidence.map(event => {
      let ledger = ledgers.get(event.work_id);
      if (!ledger) { ledger = new AcceptedEvidenceLedger(); ledgers.set(event.work_id, ledger); }
      ledger.now = () => event.accepted_evidence?.recorded_at ?? event.finished_at;
      const normalized = ledger.append({ ...event, ...event.accepted_evidence });
      return event.accepted_evidence ?? normalized;
    });
    const accepted_projections = [...new Set(accepted_evidence.map(e => e.work_id))].map(acceptedWorkId => rebuildJobProjection(accepted_evidence, { company_id, job_id: acceptedWorkId }));
    const verified = accepted_projections.some(projection => projection.status === 'VERIFIED' && accepted_evidence.some(e => e.evidence_id === projection.provenance.terminal_evidence_id && e.verification?.verified === true && e.verification.work_order_id === id));
    const outcome = verified && business?.status === 'completed' ? 'verified' : run?.state === 'FAILED' ? 'failed' : work.state.startsWith('WAITING') ? 'waiting' : 'unverified';
    const context = business?.evidence_context;
    const accepted_evidence_references = outcome === 'verified'
      && context?.company_id === company_id && context?.work_order_id === id
      ? await resolveAcceptedEvidenceReferences({ company_id, work_id,
        visit_id: context.visit_id, work_order_id: context.work_order_id,
        task_id: context.task_id, disposition: context.disposition })
      : [];
    return { work, run, business, evidence, accepted_evidence, accepted_projections,
      accepted_evidence_references, outcome };
  }
  async function resolveAcceptedEvidenceReferences(criteria) {
    return storage.transaction(tx => resolveAcceptedEvidenceReferencesInTransaction(tx, criteria));
  }
  return Object.freeze({ ...bootstrap, project, resolveAcceptedEvidenceReferences, lifecycleStore,
    recover: input => bootstrap.zeroDispatcher.recoverInterrupted(input) });
}
