import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Canonical authority stores are JavaScript.
import { SqliteAuthorityStore, SqliteWorkerAccessStore } from "../../../packages/runtime/authority/index.mjs";
import { SqliteWorkforceStore } from "./sqlite-store.js";
import { createDirectAdminWorkforceOwners, DirectAdminWorkforceActionDenied, DirectAdminWorkforceAuthorityDenied, DirectAdminWorkforceOutcomeUncertain, type DirectAdminBridgeContext } from "./directadmin-workforce-owners.js";
import type { WorkforceZeroBridgeContext } from "../../../packages/titan-platform/src/directadmin-session-bridge.js";
// @ts-expect-error Canonical run storage owner is JavaScript.
import { SqliteRunStore } from "../../../packages/runtime/agent-runtime/sqlite-run-store.mjs";
// @ts-expect-error Reuse the native production composition and its owned migrations.
import { createFieldServiceRuntime } from "./field-service-runtime.mjs";
import { createDirectAdminGateway } from "../../../packages/titan-platform/src/directadmin-gateway.js";
import { directAdminContextRevisionAssertion } from "../../../packages/titan-platform/src/directadmin-session-bridge.js";
// @ts-expect-error The test fixture issues actual signed DirectAdmin and Workforce credentials into a disposable SQLite registry.
import { fixture as directAdminSessionFixture } from "../../../packages/titan-platform/tests/fixtures/directadmin-bridge-fixture.mjs";

const now = "2026-10-02T00:00:00.000Z";
const REASSIGN_CAPABILITY = "titan.workforce.reassign";
function createTestSqliteStorage(filename = ":memory:") {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys=ON");
  let pending: Promise<unknown> = Promise.resolve();
  const directQuery = async (sql: string, params: readonly unknown[] = []) => {
    const values: any[] = [];
    const normalized = sql.replace(/\$(\d+)/g, (_match, raw: string) => {
      const index = Number(raw) - 1;
      if (index < 0 || index >= params.length) throw new Error(`sqlite parameter $${raw} is not bound`);
      values.push(params[index] as any);
      return "?";
    });
    const statement = db.prepare(normalized);
    const columns = statement.columns();
    if (columns.length) {
      const rows = statement.all(...values) as unknown[];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: statement.run(...values).changes };
  };
  const serialize = <T>(operation: () => Promise<T>) => {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  const storage: any = {
    dialect: "sqlite",
    query: (sql: string, params: readonly unknown[] = []) => serialize(() => directQuery(sql, params)),
    transaction: <T>(action: (tx: any) => Promise<T>) => serialize(async () => {
      db.exec("BEGIN IMMEDIATE");
      let active = true;
      const tx = { dialect: "sqlite", query: (sql: string, params: readonly unknown[] = []) => {
        if (!active) return Promise.reject(new Error("sqlite-transaction-closed"));
        return directQuery(sql, params);
      }, transaction: async () => { throw new Error("sqlite-nested-transaction-unsupported"); }, close: async () => {} };
      try { const result = await action(tx); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
      finally { active = false; }
    }),
    close: () => serialize(async () => { db.close(); }),
  };
  return storage;
}

const context: DirectAdminBridgeContext = Object.freeze({
  actor_id: "manager-a", company_id: "company-a", context_revision: "session-revision-a", authority: "not-carried",
});

function work(company_id: string, work_id: string, evidence_refs: string[], state: "READY" | "IN_PROGRESS" = "IN_PROGRESS") {
  return {
    company_id, work_id, objective: `Objective ${work_id}`, creator: "manager-a", priority: 1,
    state, dependencies: [], required_capabilities: [],
    context_refs: [`context-${work_id}`], evidence_refs, created_at: now, updated_at: now,
  };
}

async function hostedFixture(path = ":memory:") {
  const storage = createTestSqliteStorage(path);
  const runtime = await createFieldServiceRuntime({ storage, workOrders: {
    async complete() { throw new Error("unexpected-work-order-completion-during-reassignment-test"); },
    async read() { throw new Error("unexpected-work-order-read-during-reassignment-test"); },
  } });
  const verifiedRuntime = { ...runtime, verifyWorkforceZeroSession: verifyDisposableWorkforceZeroSession,
    async withWorkforceZeroSessionFence(_credential: string, _child: WorkforceZeroBridgeContext,
      options: { signal?: AbortSignal } | undefined, effect: (signal: AbortSignal) => Promise<unknown> | unknown) {
      const signal = options?.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      return effect(signal);
    } };
  return { storage, runtime: verifiedRuntime, owners: createDirectAdminWorkforceOwners(verifiedRuntime) };
}

async function verifyDisposableWorkforceZeroSession(credential: string, child: WorkforceZeroBridgeContext) {
  if (credential !== "disposable-workforce-zero-credential" || child.schema !== "titan.workforce-zero.session/v1" ||
      child.audience !== "workforce" || child.surface !== "zero" || child.company_ids.length !== 1 ||
      child.company_ids[0] !== child.company_id || !Number.isFinite(child.expires_at) || child.expires_at <= Date.now()) {
    throw new Error("runtime-authentication-required");
  }
}

async function withDisposableWorkforceFence<T>(_credential: string, _child: WorkforceZeroBridgeContext,
  options: { signal?: AbortSignal } | undefined, effect: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
  const signal = options?.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  return effect(signal);
}

function withDisposableWorkforceSession(context: DirectAdminBridgeContext,
  options: { credential?: string; child?: Partial<WorkforceZeroBridgeContext> } = {}) {
  const child: WorkforceZeroBridgeContext = Object.freeze({ schema: "titan.workforce-zero.session/v1", audience: "workforce", surface: "zero",
    actor_id: context.actor_id, company_id: context.company_id, company_ids: Object.freeze([context.company_id]),
    device_id: "disposable-device", session_id: `workforce-session-${context.company_id}-${context.actor_id}`,
    context_revision: `workforce-${context.context_revision}`, session_revision: 1, expires_at: Date.now() + 60 * 60_000,
    ...options.child });
  return async <T>(consume: (credential: string, context: WorkforceZeroBridgeContext) => Promise<T>) =>
    consume(options.credential ?? "disposable-workforce-zero-credential", child);
}

function requestIntent(owners: ReturnType<typeof createDirectAdminWorkforceOwners>, intent: any,
  context: DirectAdminBridgeContext, revalidate: () => Promise<DirectAdminBridgeContext>, signal?: AbortSignal,
  childSession = withDisposableWorkforceSession(context)) {
  return owners.requestIntent("titan_workforce", intent, context, revalidate,
    childSession, signal ? { signal } : undefined);
}

async function seedManager(runtime: any, company_id = "company-a", actorOverride?: string) {
  const actor_id = actorOverride ?? (company_id === "company-a" ? "manager-a" : "manager-b");
  const worker_id = company_id === "company-a" ? "manager-worker-a" : "manager-worker-b";
  await runtime.workforceStore.putWorker({ company_id, worker_id, kind: "human", active: true,
    capabilities: [], human_identity_ref: actor_id });
  await runtime.workforceStore.putWorker({ company_id, worker_id: "worker-old", kind: "digital", active: true, capabilities: [] });
  await runtime.workforceStore.putWorker({ company_id, worker_id: "worker-target", kind: "digital", active: true, capabilities: [] });
  return { actor_id, worker_id };
}

async function grantReassignment(runtime: any, operation_id: string, company_id = "company-a", actorOverride?: string) {
  const actor_id = actorOverride ?? (company_id === "company-a" ? "manager-a" : "manager-b");
  const worker_id = company_id === "company-a" ? "manager-worker-a" : "manager-worker-b";
  const granted_at = new Date().toISOString();
  const expires_at = new Date(Date.now() + 60 * 60_000).toISOString();
  const subject_id = `${worker_id}/${REASSIGN_CAPABILITY}`;
  const proof_id = `management-proof-${company_id}`;
  const grant = { company_id, worker_id, actor_id, capability: REASSIGN_CAPABILITY, status: "active",
    policy_allows: true, governance_allows: true, assurance_allows: true, risk: "low",
    expires_at, evidence_refs: [proof_id] };
  await runtime.storage.query(
    "INSERT INTO evidence(id,company_id,subject_type,subject_id,evidence_type,provenance,payload) VALUES($1,$2,'worker_capability',$3,'management_authority',$4,$5)",
    [proof_id, company_id, subject_id, JSON.stringify({ source: "disposable-test-binding", grants_authority: false }), JSON.stringify({ verified: true })],
  );
  await runtime.storage.query(
    "INSERT INTO authority_state(id,company_id,subject_type,subject_id,level,envelope) VALUES($1,$2,'worker_capability',$3,'scoped',$4)",
    [`management-grant-${company_id}`, company_id, subject_id, JSON.stringify(grant)],
  );
  await new SqliteWorkerAccessStore(runtime.storage).append({ company_id, assignment_id: `access-${company_id}`,
    worker_id, permissions: [REASSIGN_CAPABILITY], status: "active", granted_by: "independent-owner",
    granted_at, expires_at });
  const authority = new SqliteAuthorityStore(runtime.storage);
  await authority.appendAutonomySnapshot({ company_id, decision_id: `autonomy-${company_id}`, capability: REASSIGN_CAPABILITY,
    effective_score: 60, status: "verified", source: "titan-autonomy", verified_at: granted_at, expires_at,
    trusted_auto_handshake: { platform: false, user: false, assurance: false }, predictive_ready: false }, { worker_id });
  await authority.appendApproval({ company_id, approval_id: `approval-${operation_id}`, approval_scope: operation_id,
    status: "approved", approver_id: "independent-human-approver", granted_at, expires_at });
}

function reassignIntent(operation_id: string, company_id = "company-a", actor_id = company_id === "company-a" ? "manager-a" : "manager-b") {
  return { company_id, actor_id, capability_id: REASSIGN_CAPABILITY, operation_id,
    correlation_id: `correlation-${operation_id}`,
    input: { action: "reassign", work_id: "work-a", expected_assignee_id: "worker-old",
      target_worker_id: "worker-target", reason: "Balance the ready workload" } };
}

test("DirectAdmin projection reads canonical company-filtered workers, work, runs and evidence references", async () => {
  const dir = mkdtempSync(join(tmpdir(), "titan-directadmin-workforce-"));
  const storage = createTestSqliteStorage(join(dir, "workforce.db"));
  try {
    const workforce = new SqliteWorkforceStore(storage);
    const runs = new SqliteRunStore(storage);
    await workforce.migrate(); await runs.migrate();
    await workforce.putWorker({ company_id: "company-a", worker_id: "worker-a", kind: "digital", active: true, capabilities: ["crm.work_order.complete"] });
    await workforce.putWorker({ company_id: "company-b", worker_id: "worker-b", kind: "human", active: true, capabilities: ["work.delegate"] });
    await workforce.put({ ...work("company-a", "work-a", ["evidence-ref-a"]),
      required_capabilities: ["crm.work_order.complete"], assignee: "worker-a" });
    await workforce.put(work("company-b", "work-b", ["evidence-ref-b"]));
    await runs.create({ company_id: "company-a", run_id: "run-a", state: "COMPLETED", conversation_id: "conversation-a", agent_id: "worker-a", work_id: "work-a", updated_at: now });
    await runs.create({ company_id: "company-b", run_id: "run-b", state: "COMPLETED", conversation_id: "conversation-b", agent_id: "worker-b", work_id: "work-b", updated_at: now });

    const owners = createDirectAdminWorkforceOwners({ storage, verifyWorkforceZeroSession: verifyDisposableWorkforceZeroSession,
      withWorkforceZeroSessionFence: withDisposableWorkforceFence,
      workforceStore: workforce, runStore: runs });
    const projection = await owners.projection("titan_workforce", context);
    const data = projection.data as any;
    assert.equal(projection.company_id, "company-a");
    assert.equal(data.company_id, "company-a");
    assert.equal(data.schema, "titan.workforce-cockpit.v1");
    assert.deepEqual(data.discovery.company_id, "company-a");
    assert.deepEqual(data.discovery.workers.map((worker: any) => worker.worker_id), ["worker-a"]);
    assert.deepEqual(data.discovery.skills, {
      schema: "titan.directadmin.workforce-skills.v1", status: "unavailable", company_id: "company-a",
      context_revision: context.context_revision, reason: "canonical-skill-projection-unavailable",
      source: null, freshness: null, source_revision: null, evidence_refs: [],
      read_only: true, capability_presence_confers_authority: false, verification_confers_authority: false,
      assignment_decision: false, routing_decision: false, entitlement_decision: false,
      execution_permitted: false, grants_authority: false,
    });
    assert.deepEqual(data.discovery.controls, []);
    assert.deepEqual(data.status.company_id, "company-a");
    assert.deepEqual(data.status.work, [{ company_id: "company-a", work_id: "work-a", state: "IN_PROGRESS",
      required_capabilities: ["crm.work_order.complete"],
      context_refs: ["context-work-a"], evidence_refs: ["evidence-ref-a"], assignee: "worker-a", run_id: "run-a" }]);
    assert.deepEqual(projection.evidence_refs, ["evidence-ref-a"]);
    assert.equal(JSON.stringify(projection).includes("company-b"), false);
    assert.ok(projection.freshness && Number.isFinite(Date.parse(projection.freshness)));
    await workforce.put({ ...work("company-a", "work-a", ["evidence-ref-a"]), required_capabilities: [" "] });
    await assert.rejects(() => owners.projection("titan_workforce", context), /directadmin-workforce-record-invalid/);
  } finally { await storage.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("DirectAdmin skill projection reuses canonical evidence proof and filters to the current company roster", async () => {
  const fixture = await hostedFixture();
  try {
    const { workforceStore } = fixture.runtime as any;
    await workforceStore.putWorker({ company_id: "company-a", worker_id: "worker-a", kind: "digital", active: false, capabilities: [] });
    await workforceStore.putWorker({ company_id: "company-b", worker_id: "worker-b", kind: "human", active: true, capabilities: [] });
    const seenCompanies: string[] = [];
    const registryFor = (company_id: string) => ({
      schema: "titan.workforce.skill-capability-registry.v1", company_id,
      graph_revision: 7, updated_at: Date.parse(now), grants_authority: false, execution_permitted: false,
      worker_capabilities: [
        { worker_id: "worker-a", capability_id: "work.site.schedule", proficiency: 4,
          proficiency_level: "PROFICIENT", verification_state: "VERIFIED", evidence: [{ evidence_id: "proof-a", verified: true }] },
        { worker_id: "worker-b", capability_id: "work.site.schedule", proficiency: 3,
          proficiency_level: "WORKING", verification_state: "EVIDENCED", evidence: [{ evidence_id: "proof-b" }] },
      ],
    });
    const owners = createDirectAdminWorkforceOwners({
      ...fixture.runtime,
      skillCapabilitySource: async company_id => { seenCompanies.push(company_id); return { registry: registryFor(company_id) }; },
    });
    const first = await owners.projection("titan_workforce", context);
    const firstSkills = (first.data as any).discovery.skills;
    assert.equal(firstSkills.status, "available");
    assert.equal(firstSkills.company_id, "company-a");
    assert.equal(firstSkills.context_revision, context.context_revision);
    assert.equal(firstSkills.source, "canonical-workforce-skill-capability-registry");
    assert.equal(firstSkills.source_revision, 7);
    assert.deepEqual(firstSkills.evidence_refs, ["proof-a"]);
    assert.deepEqual(firstSkills.projection.workers.map((worker: any) => worker.worker_id), ["worker-a"]);
    assert.equal(firstSkills.projection.skill_proofs[0].proof_state, "verified");
    assert.equal(firstSkills.projection.skill_proofs[0].grants_authority, false);
    assert.equal(firstSkills.projection.skill_proofs[0].performance_confers_authority, false);

    const secondContext = Object.freeze({ ...context, company_id: "company-b", context_revision: "session-revision-b" });
    const second = await owners.projection("titan_workforce", secondContext);
    const secondSkills = (second.data as any).discovery.skills;
    assert.equal(secondSkills.company_id, "company-b");
    assert.equal(secondSkills.context_revision, secondContext.context_revision);
    assert.deepEqual(secondSkills.projection.workers.map((worker: any) => worker.worker_id), ["worker-b"]);
    assert.deepEqual(secondSkills.evidence_refs, ["proof-b"]);
    assert.deepEqual(seenCompanies, ["company-a", "company-b"]);
    assert.equal(JSON.stringify(firstSkills).includes("worker-b"), false);
    // `active` is roster status only; the proof projection does not infer runtime availability from it.
    assert.equal((first.data as any).discovery.workers.find((worker: any) => worker.worker_id === "worker-a").active, false);
    assert.equal(firstSkills.projection.skill_proofs.length, 1);
  } finally { await fixture.storage.close(); }
});

test("DirectAdmin lifecycle proposals are denied without writes, events, receipts or stale-session acceptance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "titan-directadmin-denial-"));
  const storage = createTestSqliteStorage(join(dir, "workforce.db"));
  try {
    const workforce = new SqliteWorkforceStore(storage);
    const runs = new SqliteRunStore(storage);
    await workforce.migrate(); await runs.migrate();
    await workforce.put(work("company-a", "work-a", []));
    const owners = createDirectAdminWorkforceOwners({ storage, verifyWorkforceZeroSession: verifyDisposableWorkforceZeroSession,
      withWorkforceZeroSessionFence: withDisposableWorkforceFence, workforceStore: workforce, runStore: runs });
    const before = await workforce.get("company-a", "work-a");
    const beforeEvents = await storage.query("SELECT event_seq FROM workforce_events");
    for (const action of ["pause", "resume", "cancel", "reassign", "escalate", "revoke"]) {
      const intent = {
        company_id: "company-a", actor_id: "manager-a", capability_id: `titan.workforce.${action}`,
        operation_id: `operation-${action}`, correlation_id: `correlation-${action}`,
        input: { action, work_id: "work-a", reason: "bounded test denial", ...(action === "reassign" ? { target_worker_id: "worker-target", expected_assignee_id: null } : {}) },
      };
      if (action === "reassign") {
        await assert.rejects(() => requestIntent(owners, intent, context, async () => context),
          (error: unknown) => error instanceof DirectAdminWorkforceAuthorityDenied && error.code === "directadmin-workforce-authority-denied" && error.status === 403);
      } else {
        await assert.rejects(() => requestIntent(owners, intent, context, async () => context),
          (error: unknown) => error instanceof DirectAdminWorkforceActionDenied && error.code === "directadmin-workforce-action-unsupported" && error.status === 403);
      }
    }
    await assert.rejects(() => requestIntent(owners, {
      company_id: "company-a", actor_id: "manager-a", capability_id: "titan.workforce.delete",
      operation_id: "operation-unknown", correlation_id: "correlation-unknown",
      input: { action: "delete", work_id: "work-a", reason: "must reject" },
    }, context, async () => context), /directadmin-workforce-intent-invalid/);
    await assert.rejects(() => requestIntent(owners, {
      company_id: "company-a", actor_id: "manager-a", capability_id: "titan.workforce.cancel",
      operation_id: "operation-switch", correlation_id: "correlation-switch",
      input: { action: "cancel", work_id: "work-a", reason: "session changed" },
    }, context, async () => ({ ...context, company_id: "company-b" })), /directadmin-workforce-context-changed/);
    assert.deepEqual(await workforce.get("company-a", "work-a"), before);
    assert.equal((await storage.query("SELECT event_seq FROM workforce_events")).rowCount, beforeEvents.rowCount);
    assert.equal((await workforce.list("company-b")).length, 0);
  } finally { await storage.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("reassignment requires a bound human and a current explicit grant, then records observed accepted evidence and replays durably", async () => {
  const dir = mkdtempSync(join(tmpdir(), "titan-directadmin-reassign-"));
  const file = join(dir, "workforce.db");
  let storage: any;
  try {
    let fixture = await hostedFixture(file);
    storage = fixture.storage;
    const { runtime } = fixture;
    await seedManager(runtime);
    const item = { ...work("company-a", "work-a", [], "READY"), assignee: "worker-old",
      origin: { actor_id: "worker-old", conversation_id: "conversation-work-a", request_id: "request-work-a",
        operation_id: "create-work-a", trace_id: "trace-work-a", correlation_id: "origin-correlation",
        idempotency_key: "create-work-a" } };
    await runtime.workforceStore.put(item);
    const intent = reassignIntent("reassign-operation-a");
    const beforeGrant = await fixture.owners.projection("titan_workforce", context);
    assert.deepEqual((beforeGrant.data as any).discovery.controls, []);
    await grantReassignment(runtime, intent.operation_id);
    const exposed = await fixture.owners.projection("titan_workforce", context);
    assert.deepEqual((exposed.data as any).discovery.controls, [{ capability_id: REASSIGN_CAPABILITY,
      action: "reassign", requires_fresh_approval: true, grants_authority: false }]);

    const receipt = await requestIntent(fixture.owners, intent, context, async () => context);
    const observed = await runtime.workforceStore.get("company-a", "work-a");
    assert.equal(observed?.state, "READY");
    assert.equal(observed?.assignee, "worker-target");
    assert.ok(observed?.evidence_refs.includes(receipt.receipt_id));
    const event = await storage.query(
      "SELECT actor,payload FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'",
      ["company-a", "work-a"]);
    assert.equal(event.rowCount, 1);
    assert.equal(event.rows[0]?.actor, "manager-a");
    assert.deepEqual(JSON.parse(event.rows[0]!.payload), {
      actor_id: "manager-a", manager_worker_id: "manager-worker-a", from_assignee: "worker-old",
      target_worker_id: "worker-target", reason: "Balance the ready workload", operation_id: intent.operation_id,
    });
    const evidence = await storage.query(
      "SELECT payload,provenance FROM evidence WHERE company_id=$1 AND id=$2 AND evidence_type='gateway_execution'",
      ["company-a", receipt.receipt_id]);
    assert.equal(evidence.rowCount, 1);
    const persisted = JSON.parse(evidence.rows[0]!.payload);
    assert.equal(persisted.state, "VERIFIED");
    assert.equal(persisted.accepted_evidence.schema, "titan.business.accepted-evidence/v1");
    assert.equal(persisted.verification.method, "company-scoped-workforce-reread-and-reassignment-event");
    assert.equal(persisted.verification.observed_assignee_id, "worker-target");
    assert.deepEqual(JSON.parse(evidence.rows[0]!.provenance), {
      company_id: "company-a", actor_id: "manager-a", context_revision: context.context_revision,
      workforce_session_id: `workforce-session-company-a-manager-a`, workforce_context_revision: `workforce-${context.context_revision}`,
      manager_worker_id: "manager-worker-a", request_id: "request-work-a", operation_id: intent.operation_id,
      trace_id: "trace-work-a", conversation_id: "conversation-work-a", work_id: "work-a", run_id: null,
      correlation_id: intent.correlation_id, idempotency_key: `${REASSIGN_CAPABILITY}:${intent.operation_id}`,
      authority_decision_id: persisted.decision_id, authority_evidence_refs: ["management-proof-company-a"],
      accepted_evidence_id: receipt.receipt_id,
    });

    await storage.close();
    storage = undefined;
    fixture = await hostedFixture(file);
    storage = fixture.storage;
    const replay = await requestIntent(fixture.owners, intent, context, async () => context);
    assert.equal(replay.receipt_id, receipt.receipt_id);
    assert.equal((await fixture.runtime.workforceStore.get("company-a", "work-a"))?.assignee, "worker-target");
    assert.equal((await storage.query("SELECT event_seq FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'", ["company-a", "work-a"])).rowCount, 1);
    assert.equal((await storage.query("SELECT id FROM evidence WHERE company_id=$1 AND evidence_type='gateway_execution' AND json_extract(payload,'$.state')='VERIFIED'", ["company-a"])).rowCount, 1);
  } finally {
    await storage?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authenticated hosted intent endpoint exposes and replays one durable reassignment receipt across restart", async t => {
  const dir = mkdtempSync(join(tmpdir(), "titan-directadmin-hosted-intent-"));
  const workforcePath = join(dir, "workforce.db");
  let hosted = await hostedFixture(workforcePath);
  const directAdmin = await directAdminSessionFixture(t);
  let gateway: ReturnType<typeof createDirectAdminGateway>;
  let workRuntime: any;
  const authenticatedRuntime = (runtime: any) => {
    const resolveChild = async (credential: string, child: WorkforceZeroBridgeContext) => {
      const verified = await directAdmin.workforceVerifier.authenticate(credential, {
        company_id: child.company_id, actor_id: child.actor_id, device_id: child.device_id,
        context_revision: child.context_revision,
      });
      const current = verified.context;
      if (verified.surface !== "zero" || !verified.source_session || current.audience !== "workforce" ||
          current.company_id !== child.company_id || current.actor_id !== child.actor_id ||
          current.device_id !== child.device_id || current.session_id !== child.session_id ||
          current.session_revision !== child.session_revision || current.context_revision !== child.context_revision ||
          current.allowed_company_ids.length !== 1 || current.allowed_company_ids[0] !== child.company_id ||
          Date.parse(current.expires_at) !== child.expires_at) throw new Error("runtime-authentication-required");
      const proof = Object.freeze({ provider: verified.provider, subject: verified.subject,
        session_id: current.session_id, device_id: current.device_id, session_revision: current.session_revision,
        credential_expires_at: verified.credential_expires_at, source_session: verified.source_session });
      return { current, proof };
    };
    return Object.freeze({ ...runtime,
      async verifyWorkforceZeroSession(credential: string, child: WorkforceZeroBridgeContext) {
        await resolveChild(credential, child);
      },
      async withWorkforceZeroSessionFence<T>(credential: string, child: WorkforceZeroBridgeContext,
        options: { signal?: AbortSignal } | undefined, effect: (signal: AbortSignal) => Promise<T> | T) {
        const { proof } = await resolveChild(credential, child);
        return directAdmin.registry.withCurrentSessionFence(proof, {
          audience: "workforce", company_id: child.company_id, actor_id: child.actor_id,
          context_revision: child.context_revision,
        }, { signal: options?.signal }, async (current: any, signal: AbortSignal) => {
          if (current.company_id !== child.company_id || current.actor_id !== child.actor_id ||
              current.device_id !== child.device_id || current.session_id !== child.session_id ||
              current.session_revision !== child.session_revision || current.context_revision !== child.context_revision ||
              current.allowed_company_ids.length !== 1 || current.allowed_company_ids[0] !== child.company_id ||
              Date.parse(current.expires_at) !== child.expires_at) throw new Error("runtime-authentication-required");
          return effect(signal);
        });
      },
    });
  };
  const createGateway = (runtime: any) => createDirectAdminGateway(directAdmin.bridge,
    createDirectAdminWorkforceOwners(authenticatedRuntime(runtime)));
  const authenticatedRequest = async (path: string, method: "GET" | "POST" = "GET", body?: unknown) => directAdmin.request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  const requestThroughGateway = async (handler: ReturnType<typeof createDirectAdminGateway>, path: string,
    method: "GET" | "POST" = "GET", body?: unknown) => handler(await authenticatedRequest(path, method, body));
  try {
    workRuntime = hosted.runtime;
    const workers = workRuntime.workforceStore;
    await seedManager(workRuntime, "company-a", "actor-1");
    const item = { ...work("company-a", "work-a", [], "READY"), assignee: "worker-old",
      origin: { actor_id: "worker-old", conversation_id: "conversation-work-a", request_id: "request-work-a",
        operation_id: "create-work-a", trace_id: "trace-work-a", correlation_id: "origin-correlation", idempotency_key: "create-work-a" } };
    await workers.put(item);
    gateway = createGateway(workRuntime);
    const currentResponse = await requestThroughGateway(gateway, "/v1/directadmin/context");
    assert.equal(currentResponse.status, 200);
    const current = await currentResponse.json() as any;
    assert.equal(current.actor_id, "actor-1");
    assert.equal(current.company_id, "company-a");
    assert.equal(current.authority, "not-carried");
    const path = "/v1/directadmin/titan_workforce/projection";
    const beforeProjection = await requestThroughGateway(gateway, path);
    assert.equal(beforeProjection.status, 200);
    const before = await beforeProjection.json() as any;
    assert.equal(before.context.company_id, "company-a");
    assert.equal(before.projection.data.company_id, "company-a");
    assert.deepEqual(before.projection.data.discovery.controls, []);

    const deniedIntent = { company_id: current.company_id, actor_id: current.actor_id,
      context_revision: await directAdminContextRevisionAssertion(current.context_revision),
      capability_id: REASSIGN_CAPABILITY, operation_id: "hosted-denied-operation", correlation_id: "hosted-denied-correlation",
      input: { action: "reassign", work_id: "work-a", expected_assignee_id: "worker-old",
        target_worker_id: "worker-target", reason: "No current management grant" } };
    const denied = await requestThroughGateway(gateway, "/v1/directadmin/titan_workforce/intents", "POST", deniedIntent);
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "directadmin-workforce-authority-denied", read_only: true });
    assert.equal((await workers.get("company-a", "work-a"))?.assignee, "worker-old");
    assert.equal((await hosted.storage.query("SELECT event_seq FROM workforce_events WHERE company_id=$1 AND type='work.reassigned'", ["company-a"])).rowCount, 0);
    const unsupported = await requestThroughGateway(gateway, "/v1/directadmin/titan_workforce/intents", "POST", {
      ...deniedIntent, capability_id: "titan.workforce.pause", operation_id: "hosted-unsupported-operation",
      correlation_id: "hosted-unsupported-correlation",
      input: { action: "pause", work_id: "work-a", reason: "Pause is not an implemented control" },
    });
    assert.equal(unsupported.status, 403);
    assert.deepEqual(await unsupported.json(), { error: "directadmin-workforce-action-unsupported", read_only: true });
    assert.equal((await workers.get("company-a", "work-a"))?.state, "READY");

    const operation_id = "hosted-reassign-operation";
    await grantReassignment(workRuntime, operation_id, "company-a", "actor-1");
    const exposedResponse = await requestThroughGateway(gateway, path);
    assert.equal(exposedResponse.status, 200);
    const exposed = await exposedResponse.json() as any;
    assert.deepEqual(exposed.projection.data.discovery.controls, [{ capability_id: REASSIGN_CAPABILITY,
      action: "reassign", requires_fresh_approval: true, grants_authority: false }]);
    const intent = { ...deniedIntent, operation_id, correlation_id: "hosted-reassign-correlation" };
    const accepted = await requestThroughGateway(gateway, "/v1/directadmin/titan_workforce/intents", "POST", intent);
    assert.equal(accepted.status, 202);
    const acceptedBody = await accepted.json() as any;
    assert.deepEqual(Object.keys(acceptedBody).sort(), ["correlation_id", "receipt_id", "status"]);
    assert.equal(acceptedBody.status, "REQUESTED");
    assert.equal(acceptedBody.correlation_id, intent.correlation_id);
    assert.match(acceptedBody.receipt_id, /^[A-Za-z0-9:._-]{1,200}$/);
    const completedProjection = await requestThroughGateway(gateway, path);
    const projectedWork = ((await completedProjection.json() as any).projection.data.status.work as any[])
      .find(row => row.work_id === "work-a");
    assert.equal(projectedWork.assignee, "worker-target");
    assert.ok(projectedWork.evidence_refs.includes(acceptedBody.receipt_id));
    const persisted = await hosted.storage.query("SELECT payload,provenance FROM evidence WHERE company_id=$1 AND id=$2 AND evidence_type='gateway_execution'",
      ["company-a", acceptedBody.receipt_id]);
    assert.equal(persisted.rowCount, 1);
    const executionEvidence = JSON.parse(persisted.rows[0]!.payload);
    assert.equal(executionEvidence.actor_id, "actor-1");
    assert.equal(executionEvidence.correlation_id, intent.correlation_id);
    assert.equal(executionEvidence.request_summary.input.actor_id, "actor-1");
    assert.equal(executionEvidence.request_summary.input.correlation_id, intent.correlation_id);
    assert.equal(executionEvidence.request_summary.input.operation_id, operation_id);
    const receiptOwner = createDirectAdminWorkforceOwners(hosted.runtime);
    const receiptProjection = await receiptOwner.receipt("titan_workforce", acceptedBody.receipt_id, current);
    assert.deepEqual(receiptProjection, {
      schema: "titan.directadmin.workforce-receipt.v1",
      company_id: "company-a",
      receipt_id: acceptedBody.receipt_id,
      operation_id,
      correlation_id: intent.correlation_id,
      work_id: "work-a",
      state: "VERIFIED",
      verification_status: "verified",
      verification_method: "company-scoped-workforce-reread-and-reassignment-event",
      evidence_refs: [acceptedBody.receipt_id],
    });
    assert.equal(await receiptOwner.receipt("titan_workforce", acceptedBody.receipt_id,
      { ...current, company_id: "company-b" }), null);
    assert.equal(await receiptOwner.receipt("titan_workforce", acceptedBody.receipt_id,
      { ...current, actor_id: "other-actor" }), null);
    assert.equal(await receiptOwner.receipt("titan_workforce", "unknown-receipt", current), null);
    const provenance = JSON.parse(persisted.rows[0]!.provenance);
    assert.deepEqual({ company_id: provenance.company_id, actor_id: provenance.actor_id,
      request_id: provenance.request_id, operation_id: provenance.operation_id, trace_id: provenance.trace_id,
      conversation_id: provenance.conversation_id, work_id: provenance.work_id,
      correlation_id: provenance.correlation_id, idempotency_key: provenance.idempotency_key,
      accepted_evidence_id: provenance.accepted_evidence_id }, {
      company_id: "company-a", actor_id: "actor-1", request_id: "request-work-a",
      operation_id, trace_id: "trace-work-a", conversation_id: "conversation-work-a", work_id: "work-a",
      correlation_id: intent.correlation_id, idempotency_key: `${REASSIGN_CAPABILITY}:${operation_id}`,
      accepted_evidence_id: acceptedBody.receipt_id,
    });

    await hosted.storage.close();
    hosted = await hostedFixture(workforcePath);
    gateway = createGateway(hosted.runtime);
    const replayedReceipt = await hosted.owners.receipt("titan_workforce", acceptedBody.receipt_id, current);
    assert.deepEqual(replayedReceipt, receiptProjection);
    const replay = await requestThroughGateway(gateway, "/v1/directadmin/titan_workforce/intents", "POST", intent);
    assert.equal(replay.status, 202);
    const replayBody = await replay.json() as any;
    assert.equal(replayBody.receipt_id, acceptedBody.receipt_id);
    assert.equal(replayBody.correlation_id, intent.correlation_id);
    assert.equal((await hosted.runtime.workforceStore.get("company-a", "work-a"))?.assignee, "worker-target");
    assert.equal((await hosted.storage.query("SELECT event_seq FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'", ["company-a", "work-a"])).rowCount, 1);
    assert.equal((await hosted.storage.query("SELECT id FROM evidence WHERE company_id=$1 AND evidence_type='gateway_execution' AND json_extract(payload,'$.state')='VERIFIED'", ["company-a"])).rowCount, 1);
    await hosted.storage.query("UPDATE evidence SET payload=json_set(payload,'$.state','PROVIDER_ACKNOWLEDGED') WHERE company_id=$1 AND id=$2",
      ["company-a", acceptedBody.receipt_id]);
    await assert.rejects(() => hosted.owners.receipt("titan_workforce", acceptedBody.receipt_id, current),
      /directadmin-workforce-receipt-invalid/);
  } finally {
    await hosted.storage.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revoked access, expired authority and a company switch all fail closed before reassignment", async () => {
  for (const mode of ["revoked-access", "expired-authority", "company-switch"] as const) {
    const fixture = await hostedFixture();
    try {
      const { runtime, storage } = fixture;
      await seedManager(runtime);
      await runtime.workforceStore.put({ ...work("company-a", "work-a", [], "READY"), assignee: "worker-old" });
      const intent = reassignIntent(`reassign-${mode}`);
      await grantReassignment(runtime, intent.operation_id);
      let revalidate = async () => context;
      if (mode === "revoked-access") {
        await new SqliteWorkerAccessStore(storage).append({ company_id: "company-a", assignment_id: "access-revoked",
          worker_id: "manager-worker-a", permissions: [REASSIGN_CAPABILITY], status: "revoked",
          granted_by: "independent-owner", granted_at: new Date(Date.now() + 1000).toISOString(),
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(), supersedes_assignment_id: "access-company-a" });
        assert.deepEqual((await fixture.owners.projection("titan_workforce", context).then(x => (x.data as any).discovery.controls)), []);
      } else if (mode === "expired-authority") {
        const row = await storage.query("SELECT envelope FROM authority_state WHERE company_id=$1 AND id=$2", ["company-a", "management-grant-company-a"]);
        const expired = { ...JSON.parse(row.rows[0]!.envelope), expires_at: new Date(Date.now() - 1000).toISOString() };
        await storage.query("UPDATE authority_state SET envelope=$1 WHERE company_id=$2 AND id=$3", [JSON.stringify(expired), "company-a", "management-grant-company-a"]);
        assert.deepEqual((await fixture.owners.projection("titan_workforce", context).then(x => (x.data as any).discovery.controls)), []);
      } else {
        let calls = 0;
        revalidate = async () => ++calls === 1 ? context : Object.freeze({ ...context, company_id: "company-b" });
      }
      await assert.rejects(() => requestIntent(fixture.owners, intent, context, revalidate),
        (error: unknown) => error instanceof DirectAdminWorkforceAuthorityDenied && error.status === 403);
      assert.equal((await runtime.workforceStore.get("company-a", "work-a"))?.assignee, "worker-old");
      assert.equal((await storage.query("SELECT event_seq FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'", ["company-a", "work-a"])).rowCount, 0);
    } finally { await fixture.storage.close(); }
  }
});

test("cancellation at the provider boundary stops the transaction and leaves a durable uncertain attempt", async () => {
  const fixture = await hostedFixture();
  try {
    const { runtime, storage } = fixture;
    await seedManager(runtime);
    await runtime.workforceStore.put({ ...work("company-a", "work-a", [], "READY"), assignee: "worker-old" });
    const intent = reassignIntent("reassign-cancelled");
    await grantReassignment(runtime, intent.operation_id);
    const controller = new AbortController();
    let revalidations = 0;
    await assert.rejects(() => requestIntent(fixture.owners, intent, context, async () => {
      if (++revalidations === 2) controller.abort();
      return context;
    }, controller.signal),
      (error: unknown) => error instanceof DirectAdminWorkforceOutcomeUncertain && error.status === 503);
    assert.equal((await runtime.workforceStore.get("company-a", "work-a"))?.assignee, "worker-old");
    assert.equal((await storage.query("SELECT event_seq FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'", ["company-a", "work-a"])).rowCount, 0);
    const uncertain = await storage.query(
      "SELECT payload FROM evidence WHERE company_id=$1 AND evidence_type='gateway_execution' AND json_extract(payload,'$.state')='UNCERTAIN'",
      ["company-a"]);
    assert.equal(uncertain.rowCount, 1);
    assert.equal(JSON.parse(uncertain.rows[0]!.payload).final_outcome, null);
    await assert.rejects(() => requestIntent(fixture.owners, intent, context, async () => context),
      /workforce-reassignment-recovery-required/);
  } finally { await fixture.storage.close(); }
});

test("cancellation after reassignment commit reports uncertainty without claiming rollback or retrying the effect", async () => {
  const fixture = await hostedFixture();
  try {
    const { runtime, storage } = fixture;
    await seedManager(runtime);
    await runtime.workforceStore.put({ ...work("company-a", "work-a", [], "READY"), assignee: "worker-old" });
    const intent = reassignIntent("reassign-cancelled-after-commit");
    await grantReassignment(runtime, intent.operation_id);
    const controller = new AbortController();
    const reassignReady = runtime.workforceStore.reassignReady.bind(runtime.workforceStore);
    (runtime.workforceStore as any).reassignReady = async (input: any) => {
      const result = await reassignReady(input);
      controller.abort(new Error("disposable caller cancellation after commit"));
      return result;
    };

    await assert.rejects(() => requestIntent(fixture.owners, intent, context, async () => context, controller.signal),
      (error: unknown) => error instanceof DirectAdminWorkforceOutcomeUncertain && error.status === 503);

    const observed = await runtime.workforceStore.get("company-a", "work-a");
    assert.equal(observed?.assignee, "worker-target", "the committed mutation is preserved; cancellation does not imply rollback");
    const events = await storage.query("SELECT event_seq,type,payload FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'",
      ["company-a", "work-a"]);
    assert.equal(events.rowCount, 1, JSON.stringify(events.rows));
    const uncertain = await storage.query(
      "SELECT id,payload FROM evidence WHERE company_id=$1 AND evidence_type='gateway_execution' AND json_extract(payload,'$.idempotency_key')=$2 AND json_extract(payload,'$.state')='UNCERTAIN'",
      ["company-a", `${REASSIGN_CAPABILITY}:${intent.operation_id}`]);
    assert.equal(uncertain.rowCount, 1);
    assert.equal(JSON.parse(uncertain.rows[0]!.payload).state, "UNCERTAIN");
    assert.equal(JSON.parse(uncertain.rows[0]!.payload).final_outcome, null, "no verified final outcome is recorded after cancellation");
    assert.equal(observed?.evidence_refs.includes(uncertain.rows[0]!.id), false,
      "uncertain execution evidence is not projected as accepted work evidence");

    await assert.rejects(() => requestIntent(fixture.owners, intent, context, async () => context),
      /workforce-reassignment-recovery-required/);
    assert.equal((await storage.query("SELECT event_seq FROM workforce_events WHERE company_id=$1 AND work_id=$2 AND type='work.reassigned'",
      ["company-a", "work-a"])).rowCount, 1, "same-operation replay cannot duplicate the committed event");
    assert.equal((await runtime.workforceStore.get("company-a", "work-a"))?.assignee, "worker-target");
  } finally { await fixture.storage.close(); }
});

test("a human binding from another company cannot authorize a company-scoped reassignment", async () => {
  const fixture = await hostedFixture();
  try {
    const { runtime, storage } = fixture;
    await seedManager(runtime, "company-b");
    await runtime.workforceStore.putWorker({ company_id: "company-a", worker_id: "worker-old", kind: "digital", active: true, capabilities: [] });
    await runtime.workforceStore.putWorker({ company_id: "company-a", worker_id: "worker-target", kind: "digital", active: true, capabilities: [] });
    await runtime.workforceStore.put({ ...work("company-a", "work-a", [], "READY"), assignee: "worker-old" });
    const switched = Object.freeze({ ...context, actor_id: "manager-b" });
    const intent = reassignIntent("reassign-cross-company", "company-a", "manager-b");
    await assert.rejects(() => requestIntent(fixture.owners, intent, switched, async () => switched),
      (error: unknown) => error instanceof DirectAdminWorkforceAuthorityDenied && error.status === 403);
    assert.equal((await runtime.workforceStore.get("company-a", "work-a"))?.assignee, "worker-old");
    assert.equal((await storage.query("SELECT event_seq FROM workforce_events WHERE company_id=$1 AND type='work.reassigned'", ["company-a"])).rowCount, 0);
  } finally { await fixture.storage.close(); }
});

test("a forged or mismatched Workforce child session is rejected before any reassignment write", async () => {
  for (const mode of ["invalid-credential", "actor-switch"] as const) {
    const fixture = await hostedFixture();
    try {
      const { runtime, storage } = fixture;
      await runtime.workforceStore.put({ ...work("company-a", "work-a", [], "READY"), assignee: "worker-old" });
      const intent = reassignIntent(`reassign-child-${mode}`);
      const child = mode === "actor-switch" ? withDisposableWorkforceSession(context, { child: { actor_id: "manager-b" } })
        : withDisposableWorkforceSession(context, { credential: "forged-child-credential" });
      await assert.rejects(() => requestIntent(fixture.owners, intent, context, async () => context, undefined, child),
        mode === "actor-switch"
          ? (error: unknown) => error instanceof DirectAdminWorkforceAuthorityDenied && error.status === 403
          : /runtime-authentication-required/);
      assert.equal((await runtime.workforceStore.get("company-a", "work-a"))?.assignee, "worker-old");
      assert.equal((await storage.query("SELECT event_seq FROM workforce_events WHERE company_id=$1 AND type='work.reassigned'", ["company-a"])).rowCount, 0);
    } finally { await fixture.storage.close(); }
  }
});
