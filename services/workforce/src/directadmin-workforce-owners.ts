import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { StorageClient } from "../../../packages/storage/src/index.js";
import type { WorkItem, WorkforceStore, WorkforceWorker, WorkforceWorkerStore } from "./index.js";
import type { SqliteWorkforceStore } from "./sqlite-store.js";
import type { WorkforceZeroBridgeContext, WithWorkforceZeroSession } from "../../../packages/titan-platform/src/directadmin-session-bridge.js";
import type { DirectAdminBootstrapNonceFlow } from "./directadmin-bootstrap-nonce-route.js";
import { projectDirectAdminWorkforceSkills, type CanonicalWorkforceSkillSource } from "./directadmin-workforce-skills.js";
// @ts-expect-error Canonical authority owner is JavaScript.
import { AuthorityContextResolver, RuntimeAuthorityGateway, SqliteAuthorityStore, SqliteWorkerAccessStore, WorkerAccessResolver, CapabilityRequirementResolver, assertAuthorityDecisionAllowsExecution } from "../../../packages/runtime/authority/index.mjs";
// @ts-expect-error Execution and accepted-evidence owners are JavaScript.
import { ExecutionGateway, executionRequestFingerprint } from "../../../packages/tools/execution-gateway.mjs";
// @ts-expect-error Accepted-evidence owner is JavaScript.
import { AcceptedEvidenceLedger } from "../../../packages/tools/accepted-evidence-ledger.mjs";

const REASSIGN_CAPABILITY = "titan.workforce.reassign";
const PROPOSED_ACTIONS = new Set(["pause", "resume", "cancel", "reassign", "escalate", "revoke"]);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const stringRefs = (value: unknown): value is string[] => Array.isArray(value) && value.every(ref => id(ref));
const one = async (storage: any, sql: string, params: unknown[] = []) => (await storage.query(sql, params)).rows[0] ?? null;

let registryPromise: Promise<any> | undefined;
function loadCapabilityRegistry() {
  registryPromise ??= readFile(new URL("../../../packages/tools/TOOL-REGISTRY.json", import.meta.url), "utf8").then(JSON.parse);
  return registryPromise;
}

export type DirectAdminBridgeContext = Readonly<{
  actor_id: string;
  company_id: string;
  context_revision: string;
  authority: "not-carried";
}>;

export type DirectAdminProjection = Readonly<{
  company_id: string;
  source: string;
  freshness: string | null;
  evidence_refs: readonly string[];
  data: Readonly<Record<string, unknown>>;
}>;

export type DirectAdminWorkforceIntent = Readonly<{
  company_id: string;
  actor_id: string;
  capability_id: string;
  operation_id: string;
  correlation_id: string;
  input: Readonly<Record<string, unknown>>;
}>;

export type DirectAdminGatewayOwners = Readonly<{
  projection(plugin: "titan_workforce" | string, context: DirectAdminBridgeContext): Promise<DirectAdminProjection>;
  requestIntent(
    plugin: "titan_workforce" | string,
    intent: DirectAdminWorkforceIntent,
    context: DirectAdminBridgeContext,
    revalidate: () => Promise<DirectAdminBridgeContext>,
    withWorkforceZeroSession: WithWorkforceZeroSession,
    control?: { signal?: AbortSignal },
  ): Promise<{ receipt_id: string }>;
}>;

export type DirectAdminFetchHandler = (request: Request) => Promise<Response>;
export type DirectAdminGatewayFactory = (owners: DirectAdminGatewayOwners,
  bootstrapNonceFlow?: DirectAdminBootstrapNonceFlow) => DirectAdminFetchHandler;

export type DirectAdminWorkforceRuntime = Readonly<{
  storage: StorageClient;
  verifyWorkforceZeroSession(credential: string, context: WorkforceZeroBridgeContext): Promise<void>;
  withWorkforceZeroSessionFence<T>(credential: string, context: WorkforceZeroBridgeContext,
    options: { signal?: AbortSignal } | undefined, effect: (signal: AbortSignal) => Promise<T> | T): Promise<T>;
  workforceStore: WorkforceStore & WorkforceWorkerStore & Pick<SqliteWorkforceStore,
    "findHumanByIdentityRef" | "reassignReady" | "appendAcceptedEvidenceRef">;
  runStore: { findByWork(company_id: string, work_id: string): Promise<unknown> };
  /** Optional server-owned access to the existing canonical skill projection.
   * Missing wiring is published as an explicit unavailable status. */
  skillCapabilitySource?: CanonicalWorkforceSkillSource;
}>;

export class DirectAdminWorkforceActionDenied extends Error {
  readonly code = "directadmin-workforce-action-unsupported";
  readonly status = 403;
  constructor(action: string) {
    super(`DirectAdmin Workforce action is not supported: ${action}`);
    this.name = "DirectAdminWorkforceActionDenied";
  }
}

export class DirectAdminWorkforceAuthorityDenied extends Error {
  readonly code = "directadmin-workforce-authority-denied";
  readonly status = 403;
  constructor(action: string, message?: string) {
    super(message ?? `Current Workforce authority does not permit: ${action}`);
    this.name = "DirectAdminWorkforceAuthorityDenied";
  }
}

export class DirectAdminWorkforceOutcomeUncertain extends Error {
  readonly code = "directadmin-workforce-outcome-uncertain";
  readonly status = 503;
  constructor() {
    super("Workforce reassignment outcome is uncertain; recovery is required");
    this.name = "DirectAdminWorkforceOutcomeUncertain";
  }
}

function requireContext(context: DirectAdminBridgeContext): void {
  if (!id(context?.company_id) || !id(context?.actor_id) || !id(context?.context_revision) || context.authority !== "not-carried") {
    throw new Error("directadmin-workforce-context-invalid");
  }
}

function projectWorker(company_id: string, worker: WorkforceWorker) {
  if (worker.company_id !== company_id || !id(worker.worker_id) || !["digital", "human"].includes(worker.kind) ||
      typeof worker.active !== "boolean" || !Array.isArray(worker.capabilities) || worker.capabilities.some(value => !id(value))) {
    throw new Error("directadmin-workforce-record-invalid");
  }
  return Object.freeze({ company_id, worker_id: worker.worker_id, kind: worker.kind,
    active: worker.active, capabilities: Object.freeze([...worker.capabilities]),
    ...(id(worker.manager_id) ? { manager_id: worker.manager_id } : {}),
    ...(id(worker.team_id) ? { team_id: worker.team_id } : {}),
  });
}

function projectWork(company_id: string, work: WorkItem, run_id?: string) {
  if (work.company_id !== company_id || !id(work.work_id) || !id(work.state) ||
      !stringRefs(work.required_capabilities) || !stringRefs(work.context_refs) || !stringRefs(work.evidence_refs)) {
    throw new Error("directadmin-workforce-record-invalid");
  }
  return Object.freeze({ company_id, work_id: work.work_id, state: work.state,
    required_capabilities: Object.freeze([...work.required_capabilities]),
    context_refs: Object.freeze([...work.context_refs]), evidence_refs: Object.freeze([...work.evidence_refs]),
    ...(id(work.assignee) ? { assignee: work.assignee } : {}),
    ...(id(run_id) ? { run_id } : {}),
  });
}

function nextEvaluationTime(previous: any): string {
  const now = Date.now();
  const prior = Date.parse(String(previous?.evaluated_at ?? ""));
  return new Date(Number.isFinite(prior) && prior >= now ? prior + 1 : now).toISOString();
}

async function loadCurrentManagementGrant(storage: any, input: { company_id: string; actor_id: string; worker_id: string; now: string }) {
  try {
    const subject_id = `${input.worker_id}/${REASSIGN_CAPABILITY}`;
    const row = await one(storage,
      "SELECT id,level,envelope FROM authority_state WHERE company_id=$1 AND subject_type='worker_capability' AND subject_id=$2",
      [input.company_id, subject_id]);
    if (!row || row.level !== "scoped") return null;
    const grant = JSON.parse(row.envelope);
    const expires = Date.parse(String(grant.expires_at ?? ""));
    if (grant.company_id !== input.company_id || grant.worker_id !== input.worker_id || grant.actor_id !== input.actor_id ||
        grant.capability !== REASSIGN_CAPABILITY || grant.status !== "active" || grant.revoked === true ||
        grant.policy_allows !== true || grant.governance_allows !== true || grant.assurance_allows !== true ||
        !Number.isFinite(expires) || expires <= Date.parse(input.now) ||
        !["none", "low", "medium", "high", "critical"].includes(grant.risk) ||
        !Array.isArray(grant.evidence_refs) || grant.evidence_refs.length === 0) return null;

    const proofIds: string[] = [];
    for (const ref of grant.evidence_refs) {
      if (!id(ref)) return null;
      const proof = await one(storage,
        "SELECT id FROM evidence WHERE company_id=$1 AND id=$2 AND subject_type='worker_capability' AND subject_id=$3 AND evidence_type='management_authority'",
        [input.company_id, ref, subject_id]);
      if (!proof) return null;
      proofIds.push(String(proof.id));
    }
    return Object.freeze({ ...grant, grant_id: String(row.id), evidence_refs: Object.freeze(proofIds) });
  } catch {
    return null;
  }
}

function createCurrentAuthority(storage: any) {
  const authorityStore = new SqliteAuthorityStore(storage);
  const accessResolver = new WorkerAccessResolver({ store: new SqliteWorkerAccessStore(storage) });
  const canonicalRequirements = new CapabilityRequirementResolver({ registryProvider: { load: loadCapabilityRegistry } });
  const requirementResolver = {
    async resolve(input: any) {
      const requirement = await canonicalRequirements.resolve(input);
      if (!requirement || input?.input?.authority_phase !== "exposure") return requirement;
      // Showing an authenticated manager a control is a read check. The effect
      // still uses the canonical write requirement and per-operation approval.
      return { ...requirement, operation: "expose-reassign-control", effect: "read", protected_action: false, approval_policy: null };
    },
  };
  const grantFor = async (input: any) => {
    const source = input.input ?? {};
    const value = { company_id: input.company_id,
      actor_id: String(source.actor_id ?? source.input?.actor_id ?? ""),
      worker_id: input.worker_id, now: String(input.now ?? new Date().toISOString()) };
    return loadCurrentManagementGrant(storage, value);
  };
  const contextResolver = new AuthorityContextResolver({
    authorityStore,
    requirementResolver,
    accessResolver,
    governanceResolver: { async resolve(input: any) {
      const grant = await grantFor(input);
      return Object.freeze({
        policy_allows: grant?.policy_allows === true,
        governance_allows: grant?.governance_allows === true,
        assurance_allows: grant?.assurance_allows === true,
      });
    } },
    evidenceResolver: { async resolve(input: any) {
      const grant = await grantFor(input);
      return grant ? Object.freeze({ status: "satisfied", refs: grant.evidence_refs }) : Object.freeze({ status: "missing", refs: [] });
    } },
    riskResolver: { async resolve(input: any) {
      const grant = await grantFor(input);
      return Object.freeze({ level: grant?.risk ?? "critical", source: "authority_state", ref: grant?.grant_id ?? null });
    } },
    connectivityResolver: { async resolve() { return Object.freeze({ state: "online" }); } },
  });
  return { authorityStore, contextResolver, accessResolver };
}

function authorityInput(input: { company_id: string; actor_id: string; worker_id: string; operation_id: string; now?: string; phase?: "exposure" | "execute"; decision_id?: string; parent_decision_id?: string }) {
  const now = input.now ?? new Date().toISOString();
  return {
    company_id: input.company_id,
    actor_id: input.actor_id,
    agent_id: input.worker_id,
    worker_type: "human",
    surface: "directadmin",
    capability: REASSIGN_CAPABILITY,
    operation_id: input.operation_id,
    action_id: input.operation_id,
    idempotency_key: input.operation_id,
    authority_phase: input.phase ?? "execute",
    authority_decision_id: input.decision_id,
    supersedes_authority_decision_id: input.parent_decision_id,
    now,
  };
}

function requireCurrentContext(expected: DirectAdminBridgeContext, actual: DirectAdminBridgeContext): void {
  requireContext(actual);
  if (actual.company_id !== expected.company_id || actual.actor_id !== expected.actor_id ||
      actual.context_revision !== expected.context_revision) {
    throw new DirectAdminWorkforceAuthorityDenied("reassign", "directadmin-workforce-context-changed");
  }
}

async function resolveHumanManager(workforceStore: DirectAdminWorkforceRuntime["workforceStore"], context: DirectAdminBridgeContext) {
  const worker = await workforceStore.findHumanByIdentityRef(context.company_id, context.actor_id);
  if (!worker || worker.company_id !== context.company_id || worker.kind !== "human" ||
      worker.human_identity_ref !== context.actor_id || !worker.active) return null;
  return worker;
}

function withOperationLock<T>(locks: Map<string, Promise<void>>, key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  return previous.then(action).finally(() => {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  });
}

/** DirectAdmin reads canonical Workforce state. Reassignment is enabled only
 * for an exact verified-human binding with current #640 authority, then passes
 * through the canonical RuntimeAuthorityGateway and ExecutionGateway. */
export function createDirectAdminWorkforceOwners(runtime: DirectAdminWorkforceRuntime): DirectAdminGatewayOwners {
  if (!runtime?.storage?.query || !runtime.storage.transaction ||
      typeof runtime.verifyWorkforceZeroSession !== "function" ||
      typeof runtime.withWorkforceZeroSessionFence !== "function" ||
      typeof runtime.workforceStore?.findHumanByIdentityRef !== "function" ||
      typeof runtime.workforceStore?.reassignReady !== "function" ||
      typeof runtime.workforceStore?.appendAcceptedEvidenceRef !== "function" ||
      typeof runtime.workforceStore?.listWorkers !== "function" || typeof runtime.workforceStore.list !== "function" ||
      typeof runtime.runStore?.findByWork !== "function") throw new Error("directadmin-workforce-runtime-invalid");

  const authority = createCurrentAuthority(runtime.storage);
  const inflight = new Map<string, any>();
  const operationLocks = new Map<string, Promise<void>>();
  const evidenceSink = async (evidence: any) => {
    const active = inflight.get(evidence.execution_id);
    if (!active) throw new Error("directadmin-workforce-evidence-context-missing");
    await runtime.storage.transaction(async tx => {
      const history = await tx.query<{ payload: string }>(
        "SELECT payload FROM evidence WHERE company_id=$1 AND subject_type='work' AND subject_id=$2 AND evidence_type='gateway_execution' ORDER BY rowid",
        [evidence.company_id, evidence.work_id],
      );
      const ledger = new AcceptedEvidenceLedger();
      for (const row of history.rows) {
        const prior = JSON.parse(row.payload);
        ledger.now = () => prior.accepted_evidence?.recorded_at ?? prior.finished_at;
        ledger.append({ ...prior, ...prior.accepted_evidence });
      }
      ledger.now = () => evidence.finished_at;
      const accepted_evidence = ledger.append(evidence);
      const executionAuthority = evidence.decision_id
        ? await new SqliteAuthorityStore(tx).getDecision(evidence.company_id, evidence.decision_id)
        : null;
      const origin = active.work.origin ?? {};
      const provenance = Object.freeze({
        company_id: evidence.company_id,
        actor_id: active.context.actor_id,
        context_revision: active.context.context_revision,
        workforce_session_id: active.child_context.session_id,
        workforce_context_revision: active.child_context.context_revision,
        manager_worker_id: active.manager.worker_id,
        request_id: origin.request_id ?? active.run?.request_id ?? null,
        operation_id: active.intent.operation_id,
        trace_id: origin.trace_id ?? active.run?.trace_id ?? null,
        conversation_id: origin.conversation_id ?? active.run?.conversation_id ?? null,
        work_id: evidence.work_id,
        run_id: evidence.run_id ?? active.run?.run_id ?? null,
        correlation_id: active.intent.correlation_id,
        idempotency_key: evidence.idempotency_key,
        authority_decision_id: evidence.decision_id,
        authority_evidence_refs: executionAuthority?.evidence_refs ?? [],
        accepted_evidence_id: accepted_evidence.evidence_id,
      });
      await tx.query(
        "INSERT INTO evidence(id,company_id,subject_type,subject_id,evidence_type,provenance,payload) VALUES($1,$2,'work',$3,'gateway_execution',$4,$5)",
        [evidence.evidence_id, evidence.company_id, evidence.work_id, JSON.stringify(provenance), JSON.stringify({ ...evidence, provenance, accepted_evidence })],
      );
      if (evidence.state === "VERIFIED") {
        await runtime.workforceStore.appendAcceptedEvidenceRef(
          evidence.company_id, evidence.work_id, active.target_worker_id, accepted_evidence.evidence_id, tx,
        );
      }
    });
  };

  const reassignmentWasCommitted = async (active: any): Promise<boolean> => {
    const row = await one(runtime.storage,
      "SELECT payload FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned' AND json_extract(payload,'$.operation_id')=$3 ORDER BY event_seq DESC LIMIT 1",
      [active.intent.company_id, active.work.work_id, active.intent.operation_id]);
    if (!row) return false;
    let event: any;
    try { event = JSON.parse(row.payload); }
    catch { throw new Error("directadmin-workforce-reassignment-event-invalid"); }
    if (event.actor_id !== active.context.actor_id || event.target_worker_id !== active.target_worker_id ||
        event.from_assignee !== (active.intent.input.expected_assignee_id ?? null)) {
      throw new Error("directadmin-workforce-reassignment-event-mismatch");
    }
    return true;
  };

  const idempotencyStore = {
    async get(key: string) {
      let binding: any;
      try { binding = JSON.parse(key); } catch { throw new Error("directadmin-workforce-idempotency-invalid"); }
      if (!Array.isArray(binding) || binding.length !== 2 || !id(binding[0]) || !id(binding[1])) throw new Error("directadmin-workforce-idempotency-invalid");
      const row = await one(runtime.storage,
        "SELECT payload FROM evidence WHERE company_id=$1 AND evidence_type='gateway_execution' AND json_extract(payload,'$.idempotency_key')=$2 ORDER BY rowid DESC LIMIT 1",
        [binding[0], binding[1]]);
      if (!row) return null;
      const evidence = JSON.parse(row.payload);
      if (evidence.state !== "VERIFIED" || evidence.final_outcome !== "verified") throw new Error("workforce-reassignment-recovery-required");
      return {
        request_fingerprint: executionRequestFingerprint({ company_id: evidence.company_id, capability: evidence.capability,
          input: evidence.request_summary?.input, idempotency_key: evidence.idempotency_key }),
        execution_id: evidence.execution_id,
        company_id: evidence.company_id,
        state: evidence.state,
        capability: evidence.capability,
        provider: evidence.provider,
        evidence,
      };
    },
    async set(_key: string, result: any) {
      const row = await one(runtime.storage,
        "SELECT id FROM evidence WHERE company_id=$1 AND id=$2 AND evidence_type='gateway_execution' AND json_extract(payload,'$.state')=$3",
        [result.company_id, result.evidence?.evidence_id, result.state]);
      if (!row) throw new Error("directadmin-workforce-evidence-not-durable");
    },
  };

  // This gateway is the canonical #14 effect/verifier with no external provider.
  const executionGateway = new ExecutionGateway({
    providers: [{
      id: "native-workforce-reassignment",
      executionClass: "native",
      capabilities: [REASSIGN_CAPABILITY],
      async execute(request: any) {
        request.signal?.throwIfAborted();
        const active = inflight.get(request.execution_id);
        if (!active) throw new Error("directadmin-workforce-execution-context-missing");
        const current = await active.revalidate();
        requireCurrentContext(active.context, current);
        const currentManager = await resolveHumanManager(runtime.workforceStore, current);
        if (!currentManager || currentManager.worker_id !== active.manager.worker_id) throw new Error("directadmin-workforce-human-binding-changed");
        const args = request.input;
        const expectedAssignee = args.expected_assignee_id === null ? null : args.expected_assignee_id;
        await active.withSessionFence(request.signal, (signal: AbortSignal) => runtime.workforceStore.reassignReady({
          company_id: request.company_id,
          work_id: request.work_id,
          expected_assignee: expectedAssignee,
          target_worker_id: args.target_worker_id,
          manager_worker_id: currentManager.worker_id,
          actor_id: current.actor_id,
          reason: args.reason,
          operation_id: args.operation_id,
          at: new Date().toISOString(),
          signal,
          async authorizeCurrent(tx: any) {
            signal.throwIfAborted();
            const bound = await tx.query(
              "SELECT payload FROM workforce_workers WHERE company_id=$1 AND worker_id=$2 AND kind='human' AND active=1 AND json_extract(payload,'$.human_identity_ref')=$3",
              [request.company_id, currentManager.worker_id, current.actor_id],
            );
            if (bound.rowCount !== 1) throw new Error("directadmin-workforce-human-binding-changed");
            const txAuthority = createCurrentAuthority(tx);
            const prior = await txAuthority.authorityStore.latestDecisionForBinding({
              company_id: request.company_id,
              worker_id: currentManager.worker_id,
              capability: REASSIGN_CAPABILITY,
              operation_id: args.operation_id,
              action_id: args.operation_id,
            });
            const now = nextEvaluationTime(prior);
            const live = await txAuthority.contextResolver.evaluate({
              ...authorityInput({ company_id: request.company_id, actor_id: current.actor_id,
                worker_id: currentManager.worker_id, operation_id: args.operation_id, now,
                decision_id: `authority:${randomUUID()}`, parent_decision_id: prior?.authority_decision_id }),
              input: args,
              execution_input: args,
              execution_mode: "autonomous",
            });
            await txAuthority.authorityStore.appendDecision(live);
            assertAuthorityDecisionAllowsExecution(live, {
              company_id: request.company_id,
              capability: REASSIGN_CAPABILITY,
              operation_id: args.operation_id,
              action_id: args.operation_id,
              worker_id: currentManager.worker_id,
              now,
            });
          },
        }));
        return Object.freeze({ external_ref: `work:${request.work_id}`, result: Object.freeze({
          company_id: request.company_id, work_id: request.work_id,
          from_assignee_id: expectedAssignee, target_worker_id: args.target_worker_id,
          observed_state: "READY", actor_id: current.actor_id, operation_id: args.operation_id,
        }) });
      },
      async verify(raw: any, request: any) {
        request.signal?.throwIfAborted();
        const active = inflight.get(request.execution_id);
        if (!active) throw new Error("directadmin-workforce-execution-context-missing");
        const current = await active.revalidate();
        requireCurrentContext(active.context, current);
        const item = await runtime.workforceStore.get(request.company_id, request.work_id) as WorkItem | undefined;
        if (!item || item.company_id !== request.company_id || item.assignee !== active.target_worker_id) {
          return Object.freeze({ verified: false, method: "company-scoped-workforce-reread", observed_assignee_id: item?.assignee ?? null });
        }
        const events = await runtime.storage.query<{ payload: string }>(
          "SELECT payload FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned' ORDER BY event_seq DESC",
          [request.company_id, request.work_id],
        );
        const matched = events.rows.some(row => {
          const event = JSON.parse(row.payload);
          return event.operation_id === active.intent.operation_id && event.actor_id === current.actor_id &&
            event.target_worker_id === active.target_worker_id &&
            event.from_assignee === (active.intent.input.expected_assignee_id ?? null);
        });
        return Object.freeze({ verified: matched, method: "company-scoped-workforce-reread-and-reassignment-event",
          work_id: item.work_id, observed_state: item.state, observed_assignee_id: item.assignee,
          operation_id: active.intent.operation_id });
      },
    }],
    evidenceSink,
    idempotencyStore,
  });
  const capabilityGateway = new RuntimeAuthorityGateway({
    contextResolver: authority.contextResolver,
    authorityStore: authority.authorityStore,
    executionGateway,
  });

  async function exposeReassignControl(context: DirectAdminBridgeContext, worker: WorkforceWorker | null) {
    if (!worker) return false;
    try {
      const operation_id = `exposure:${context.context_revision}:${worker.worker_id}`;
      const current = await authority.contextResolver.evaluate({
        ...authorityInput({ company_id: context.company_id, actor_id: context.actor_id, worker_id: worker.worker_id, operation_id, phase: "exposure" }),
        input: { actor_id: context.actor_id },
        execution_mode: "supervised",
      });
      return current.decision === "ALLOW";
    } catch { return false; }
  }

  return Object.freeze({
    async projection(plugin, context) {
      requireContext(context);
      if (plugin !== "titan_workforce") throw new Error("directadmin-workforce-plugin-invalid");
      const company_id = context.company_id;
      const [workers, work, manager] = await Promise.all([
        runtime.workforceStore.listWorkers(company_id), runtime.workforceStore.list(company_id),
        resolveHumanManager(runtime.workforceStore, context),
      ]);
      const projectedWorkers = workers.map(worker => projectWorker(company_id, worker));
      const skills = await projectDirectAdminWorkforceSkills({
        company_id,
        context_revision: context.context_revision,
        worker_ids: projectedWorkers.map(worker => worker.worker_id),
        source: runtime.skillCapabilitySource,
      });
      const projectedWork = await Promise.all(work.map(async item => {
        const run = await runtime.runStore.findByWork(company_id, item.work_id) as { company_id?: unknown; run_id?: unknown } | null;
        if (run && (run.company_id !== company_id || !id(run.run_id))) throw new Error("directadmin-workforce-run-invalid");
        return projectWork(company_id, item, run?.run_id as string | undefined);
      }));
      const evidence_refs = [...new Set(projectedWork.flatMap(item => item.evidence_refs))];
      if (evidence_refs.length > 256) throw new Error("directadmin-workforce-projection-too-large");
      const expose = await exposeReassignControl(context, manager);
      return Object.freeze({
        company_id,
        source: "canonical-workforce-runtime",
        freshness: new Date().toISOString(),
        evidence_refs: Object.freeze(evidence_refs),
        data: Object.freeze({
          schema: "titan.workforce-cockpit.v1",
          company_id,
          discovery: Object.freeze({ company_id, workers: Object.freeze(projectedWorkers), skills, controls: Object.freeze(expose ? [Object.freeze({
            capability_id: REASSIGN_CAPABILITY, action: "reassign", requires_fresh_approval: true, grants_authority: false,
          })] : []) }),
          status: Object.freeze({ company_id, work: Object.freeze(projectedWork) }),
        }),
      });
    },

    async requestIntent(plugin, intent, context, revalidate, withWorkforceZeroSession, control) {
      requireContext(context);
      if (plugin !== "titan_workforce" || intent.company_id !== context.company_id || intent.actor_id !== context.actor_id ||
          !id(intent.capability_id) || !id(intent.operation_id) || !id(intent.correlation_id) ||
          !intent.input || typeof intent.input !== "object" || Array.isArray(intent.input) ||
          typeof intent.input.action !== "string" ||
          Object.keys(intent.input).some(key => !["action", "work_id", "reason", "target_worker_id", "expected_assignee_id"].includes(key))) {
        throw new Error("directadmin-workforce-intent-invalid");
      }
      const action = intent.input.action;
      if (!PROPOSED_ACTIONS.has(action) || !id(intent.input.work_id) || typeof intent.input.reason !== "string" ||
          !intent.input.reason.trim() || intent.input.reason.length > 2000 ||
          (intent.input.target_worker_id !== undefined && !id(intent.input.target_worker_id))) {
        throw new Error("directadmin-workforce-intent-invalid");
      }
      if (typeof withWorkforceZeroSession !== "function") throw new DirectAdminWorkforceAuthorityDenied(action);
      control?.signal?.throwIfAborted();
      const key = JSON.stringify([intent.company_id, intent.operation_id]);
      return withWorkforceZeroSession(async (credential, childContext) => {
        control?.signal?.throwIfAborted();
        await runtime.verifyWorkforceZeroSession(credential, childContext);
        if (childContext.company_id !== context.company_id || childContext.actor_id !== context.actor_id ||
            childContext.company_ids.length !== 1 || childContext.company_ids[0] !== context.company_id) {
          throw new DirectAdminWorkforceAuthorityDenied(action);
        }
        const current = await revalidate();
        requireCurrentContext(context, current);
        if (action !== "reassign") throw new DirectAdminWorkforceActionDenied(action);
        if (intent.capability_id !== REASSIGN_CAPABILITY || !id(intent.input.target_worker_id) ||
            !Object.hasOwn(intent.input, "expected_assignee_id") ||
            (intent.input.expected_assignee_id !== null && !id(intent.input.expected_assignee_id))) {
          throw new Error("directadmin-workforce-intent-invalid");
        }
        return withOperationLock(operationLocks, key, async () => {
        control?.signal?.throwIfAborted();
        const manager = await resolveHumanManager(runtime.workforceStore, current);
        if (!manager) throw new DirectAdminWorkforceAuthorityDenied(action);
        const item = await runtime.workforceStore.get(intent.company_id, String(intent.input.work_id)) as WorkItem | undefined;
        if (!item || item.company_id !== intent.company_id) throw new Error("work-not-found-in-company");
        const target = await runtime.workforceStore.getWorker(intent.company_id, intent.input.target_worker_id as string);
        if (!target || target.company_id !== intent.company_id || !target.active ||
            (item.required_capabilities ?? []).some(capability => !target.capabilities.includes(capability))) {
          throw new DirectAdminWorkforceAuthorityDenied(action);
        }
        const run = await runtime.runStore.findByWork(intent.company_id, item.work_id) as any;
        if (run && (run.company_id !== intent.company_id || run.work_id !== item.work_id || !id(run.run_id))) throw new Error("directadmin-workforce-run-invalid");
        const idempotencyKey = `${REASSIGN_CAPABILITY}:${intent.operation_id}`;
        const executionId = `execution:${intent.company_id}:${intent.operation_id}:${idempotencyKey}`;
        const operationInput = Object.freeze({
          action: "reassign",
          work_id: item.work_id,
          expected_assignee_id: intent.input.expected_assignee_id,
          target_worker_id: target.worker_id,
          reason: (intent.input.reason as string).trim(),
          actor_id: current.actor_id,
          manager_worker_id: manager.worker_id,
          context_revision: current.context_revision,
          workforce_session_id: childContext.session_id,
          workforce_context_revision: childContext.context_revision,
          operation_id: intent.operation_id,
          correlation_id: intent.correlation_id,
        });
        const active = { context: current, child_context: childContext, revalidate, manager, target_worker_id: target.worker_id, intent, work: item, run,
          withSessionFence: (signal: AbortSignal | undefined, effect: (signal: AbortSignal) => Promise<unknown> | unknown) =>
            runtime.withWorkforceZeroSessionFence(credential, childContext, signal ? { signal } : undefined, effect) };
        inflight.set(executionId, active);
        try {
          const prior = await authority.authorityStore.latestDecisionForBinding({
            company_id: intent.company_id, worker_id: manager.worker_id, capability: REASSIGN_CAPABILITY,
            operation_id: intent.operation_id, action_id: intent.operation_id,
          });
          const now = nextEvaluationTime(prior);
          const decision = await capabilityGateway.authorize(authorityInput({
            company_id: intent.company_id, actor_id: current.actor_id, worker_id: manager.worker_id,
            operation_id: intent.operation_id, now, decision_id: `authority:${randomUUID()}`,
            parent_decision_id: prior?.authority_decision_id,
          }));
          if (decision.status !== "approved") throw new DirectAdminWorkforceAuthorityDenied(action);
          control?.signal?.throwIfAborted();
          const result = await capabilityGateway.execute({
            decision,
            capability: { name: REASSIGN_CAPABILITY },
            input: operationInput,
            idempotency_key: idempotencyKey,
            company_id: intent.company_id,
            work_id: item.work_id,
            agent_id: manager.worker_id,
            signal: control?.signal,
            ...(run?.run_id ? { run_id: run.run_id } : {}),
          });
          if (result?.state === "UNCERTAIN" || result?.evidence?.state === "UNCERTAIN") {
            let committed = false;
            try { committed = await reassignmentWasCommitted(active); }
            catch { throw new DirectAdminWorkforceOutcomeUncertain(); }
            if (!committed && result?.evidence?.failure?.code === "directadmin-workforce-authority-denied") {
              throw new DirectAdminWorkforceAuthorityDenied(action);
            }
            throw new DirectAdminWorkforceOutcomeUncertain();
          }
          if (result?.state !== "VERIFIED" || !id(result?.evidence?.evidence_id)) throw new DirectAdminWorkforceAuthorityDenied(action);
          const observed = await runtime.workforceStore.get(intent.company_id, item.work_id);
          if (!observed || observed.assignee !== target.worker_id || !observed.evidence_refs.includes(result.evidence.evidence_id)) {
            throw new DirectAdminWorkforceAuthorityDenied(action);
          }
          return Object.freeze({ receipt_id: result.evidence.evidence_id });
        } finally { inflight.delete(executionId); }
        });
      });
    },
  });
}
