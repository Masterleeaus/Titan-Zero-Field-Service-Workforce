import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
// @ts-expect-error The production accepted-evidence owner is JavaScript.
import { AcceptedEvidenceLedger } from "../../../packages/tools/accepted-evidence-ledger.mjs";
// @ts-expect-error The production field-service composition is JavaScript.
import { createFieldServiceRuntime } from "./field-service-runtime.mjs";
// @ts-expect-error The canonical runtime's producer hook is JavaScript.
import { assertReplayTaskLineage, verifiedTaskLineageFromProducerEvent } from "./field-service-runtime.mjs";
// @ts-expect-error The native business operation is JavaScript.
import { createNativeWorkOrders } from "./native-work-orders.mjs";
// @ts-expect-error Canonical authority persistence owners are JavaScript.
import { SqliteAuthorityStore, SqliteWorkerAccessStore } from "../../../packages/runtime/authority/index.mjs";

const at = "2026-10-03T09:00:00.000Z";
type Criteria = Readonly<{ company_id: string; work_id: string; visit_id: string; work_order_id: string;
  task_id: string; disposition: "ok" | "fix_now" | "monitor" | "optional" | "refer" }>;
const target: Criteria = Object.freeze({ company_id: "company-a", work_id: "work-a", visit_id: "visit-a",
  work_order_id: "order-a", task_id: "task-a", disposition: "fix_now" });

function createTestSqliteStorage() {
  const db = new DatabaseSync(":memory:");
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
  let transactionCalls = 0;
  const serialize = <T>(operation: () => Promise<T>) => {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  const storage: any = {
    dialect: "sqlite",
    query: (sql: string, params: readonly unknown[] = []) => serialize(() => directQuery(sql, params)),
    transaction: <T>(action: (tx: any) => Promise<T>) => serialize(async () => {
      transactionCalls += 1;
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
    get transactionCalls() { return transactionCalls; },
  };
  return storage;
}

function createNativeOperationContextStore(withDisposition = true) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE work_orders(id TEXT,company_id TEXT,assigned_user_id TEXT,status TEXT,completed_at TEXT);
    CREATE TABLE visits(id TEXT,company_id TEXT,work_order_id TEXT,assigned_user_id TEXT,status TEXT,completed_at TEXT);
    CREATE TABLE work_order_tasks(id TEXT,company_id TEXT,work_order_id TEXT,completed INTEGER,status TEXT);
    CREATE TABLE visit_tasks(company_id TEXT,visit_id TEXT,work_order_id TEXT,task_id TEXT${withDisposition ? ",disposition TEXT" : ""});
    INSERT INTO work_orders VALUES('order-a','company-a','actor-a','completed','2026-10-03T08:00:00Z');
    INSERT INTO visits VALUES('visit-a','company-a','order-a','actor-a','completed','2026-10-03T07:00:00Z');
    INSERT INTO work_order_tasks VALUES('task-a','company-a','order-a',1,'done');
    INSERT INTO visit_tasks(company_id,visit_id,work_order_id,task_id${withDisposition ? ",disposition" : ""})
      VALUES('company-a','visit-a','order-a','task-a'${withDisposition ? ",'fix_now'" : ""});`);
  return {
    dialect: "sqlite",
    async query(sql: string, params: readonly unknown[] = []) {
      const values: any[] = [];
      const normalized = sql.replace(/\$(\d+)/g, (_match, raw: string) => { values.push(params[Number(raw) - 1] as any); return "?"; });
      const statement = db.prepare(normalized);
      if (statement.columns().length) { const rows = statement.all(...values) as unknown[]; return { rows, rowCount: rows.length }; }
      return { rows: [], rowCount: statement.run(...values).changes };
    },
    close() { db.close(); },
  };
}

function createCanonicalV3NativeStore() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of ["0001_work_orders.sql", "0002_visit_tasks.sql", "0003_visit_checklist_state.sql"]) {
    db.exec(readFileSync(new URL(`../../../db/sqlite/company-native/${migration}`, import.meta.url), "utf8"));
  }
  const queryDirect = async (sql: string, params: readonly unknown[] = []) => {
    const values: any[] = [];
    const normalized = sql.replace(/\$(\d+)/g, (_match, raw: string) => {
      const index = Number(raw) - 1;
      if (index < 0 || index >= params.length) throw new Error(`sqlite parameter $${raw} is not bound`);
      values.push(params[index] as any);
      return "?";
    });
    const statement = db.prepare(normalized);
    if (statement.columns().length) {
      const rows = statement.all(...values) as unknown[];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: statement.run(...values).changes };
  };
  const storage: any = {
    dialect: "sqlite",
    query: queryDirect,
    async transaction(action: (tx: any) => Promise<unknown>) {
      db.exec("BEGIN IMMEDIATE");
      let active = true;
      const tx = { dialect: "sqlite", query: (sql: string, params: readonly unknown[] = []) => {
        if (!active) return Promise.reject(new Error("sqlite-transaction-closed"));
        return queryDirect(sql, params);
      }, transaction: async () => { throw new Error("sqlite-nested-transaction-unsupported"); }, close: async () => {} };
      try { const value = await action(tx); db.exec("COMMIT"); return value; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
      finally { active = false; }
    },
    close() { db.close(); },
  };
  db.exec(`INSERT INTO companies(id,name) VALUES('company-a','Company A');
    INSERT INTO clients(id,company_id,name) VALUES('client-a','company-a','Client A');
    INSERT INTO properties(id,company_id,client_id,address) VALUES('property-a','company-a','client-a','1 Main St');
    INSERT INTO jobs(id,company_id,client_id,property_id,title,created_by) VALUES('job-a','company-a','client-a','property-a','Job A','actor-a');
    INSERT INTO work_orders(id,company_id,job_id,client_id,title,status,assigned_user_id,created_by)
      VALUES('order-a','company-a','job-a','client-a','Order A','in_progress','actor-a','actor-a');
    INSERT INTO work_order_tasks(id,company_id,work_order_id,label,required,completed,status)
      VALUES('task-a','company-a','order-a','Inspect site',1,1,'done');
    INSERT INTO visits(id,company_id,job_id,assigned_user_id,status,scheduled_start,scheduled_end,completed_at,work_order_id)
      VALUES('visit-a','company-a','job-a','actor-a','completed','2026-10-03T08:00:00Z','2026-10-03T09:00:00Z','2026-10-03T09:00:00Z','order-a');
    INSERT INTO visit_tasks(company_id,visit_id,work_order_id,task_id,item_key,section,disposition,note)
      VALUES('company-a','visit-a','order-a','task-a','inspect-site','Field','fix_now','Observed in v3');`);
  return storage;
}

async function fixture(workOrders?: { read?(input: unknown): Promise<unknown>; complete?(input: unknown): Promise<unknown> }) {
  const storage = createTestSqliteStorage();
  const runtime = await createFieldServiceRuntime({ storage, workOrders: {
    async complete(input: unknown) {
      if (workOrders?.complete) return workOrders.complete(input);
      throw new Error("unexpected-completion-in-reference-test");
    },
    async read(input: unknown) {
      if (workOrders?.read) return workOrders.read(input);
      throw new Error("unexpected-read-in-reference-test");
    },
  } });
  return { storage, runtime };
}

function acceptedRecord(input: Criteria, options: {
  evidence_id?: string; state?: string; final_outcome?: string | null; verified?: boolean;
  request?: Partial<Criteria>; observed?: Partial<Criteria>; verification?: Partial<Criteria>;
  provenance?: Partial<Criteria>; context?: Partial<Criteria>; omit_context?: boolean;
  omit_accepted_marker?: boolean; supersedes_evidence_id?: string;
} = {}, ledger = new AcceptedEvidenceLedger({ now: () => at })) {
  const evidence_id = options.evidence_id ?? "evidence-a";
  const state = options.state ?? "VERIFIED";
  const decision_id = "decision-a";
  const execution_id = "execution-a";
  const run_id = "run-a";
  const verification = state === "VERIFIED" ? {
    verified: options.verified ?? true, verification_id: `verification-${evidence_id}`,
    method: "canonical-reread", ...input, ...options.verification,
  } : null;
  const requestInput = { company_id: input.company_id, work_id: input.work_id,
    work_order_id: input.work_order_id, ...options.request };
  const observed = { status: "verified", ...input, ...options.observed };
  const provenance = {
    company_id: input.company_id, work_id: input.work_id, visit_id: input.visit_id,
    work_order_id: input.work_order_id, task_id: input.task_id, disposition: input.disposition,
    run_id, decision_id, execution_idempotency_key: "idem-a", source_evidence_refs: ["source-proof-a"],
    ...options.provenance,
  };
  const accepted_evidence = ledger.append({
    evidence_id, company_id: input.company_id, execution_id, decision_id, authority_decision_id: decision_id,
    work_id: input.work_id, run_id, correlation_id: `correlation-${evidence_id}`,
    agent_id: "agent-a", capability: "work.visit.task.inspect", provider: "native",
    execution_class: "native", state, final_outcome: options.final_outcome ?? (state === "VERIFIED" ? "verified" : null),
    request_summary: { capability: "crm.work_order.complete", input: requestInput,
      ...(options.omit_context ? {} : { canonical_operation_context: {
        company_id: input.company_id, work_order_id: input.work_order_id, visit_id: input.visit_id,
        task_id: input.task_id, disposition: input.disposition, ...options.context,
      } }), decision_id, work_id: input.work_id, run_id },
    observed_result: observed, verification, failure: null, supersedes_evidence_id: options.supersedes_evidence_id,
  });
  const raw = {
    evidence_id, company_id: input.company_id, execution_id, decision_id, authority_decision_id: decision_id,
    work_id: input.work_id, run_id, correlation_id: `correlation-${evidence_id}`,
    state, final_outcome: options.final_outcome ?? (state === "VERIFIED" ? "verified" : null),
    request_summary: accepted_evidence.request_summary, observed_result: accepted_evidence.observed_result,
    verification: accepted_evidence.verification, provenance,
    ...(options.omit_accepted_marker ? {} : { accepted_evidence }),
  };
  return { raw, provenance };
}

async function insertRecord(storage: any, input: Criteria, options: Parameters<typeof acceptedRecord>[1] = {}, ledger?: InstanceType<typeof AcceptedEvidenceLedger>) {
  const record = acceptedRecord(input, options, ledger);
  await storage.query(
    "INSERT INTO evidence(id,company_id,subject_type,subject_id,evidence_type,provenance,payload) VALUES($1,$2,'work',$3,'gateway_execution',$4,$5)",
    [record.raw.evidence_id, input.company_id, input.work_id, JSON.stringify(record.provenance), JSON.stringify(record.raw)],
  );
  return record.raw.evidence_id;
}

test("production reference resolver reads the current base evidence table in one transaction without typed-006 columns", async () => {
  const { storage, runtime } = await fixture();
  try {
    const columns = (await storage.query("PRAGMA table_info(evidence)")).rows.map((row: any) => row.name);
    assert.deepEqual(columns.sort(), ["id", "company_id", "subject_type", "subject_id", "evidence_type", "provenance", "payload", "created_at"].sort());
    await insertRecord(storage, target);

    const transactionsBeforeRead = storage.transactionCalls;
    const references = await runtime.resolveAcceptedEvidenceReferences(target);
    assert.equal(storage.transactionCalls - transactionsBeforeRead, 1);
    assert.deepEqual(references, [{
      schema: "titan.accepted-evidence-reference/v1", evidence_id: "evidence-a", company_id: "company-a",
      work_id: "work-a", visit_id: "visit-a", work_order_id: "order-a", task_id: "task-a", disposition: "fix_now",
      execution_id: "execution-a", decision_id: "decision-a", authority_decision_id: "decision-a",
      verification_id: "verification-evidence-a", run_id: "run-a", correlation_id: "correlation-evidence-a", accepted_at: at,
    }]);
    assert.equal(JSON.stringify(references).includes("observed_result"), false);
    assert.equal(JSON.stringify(references).includes("source-proof-a"), false);
  } finally { await storage.close(); }
});

test("transaction producer persists native verified task context that the resolver exposes", async () => {
  const { storage, runtime } = await fixture();
  const companyStorage = createNativeOperationContextStore();
  try {
    const source = acceptedRecord(target);
    const { accepted_evidence: _priorAcceptance, ...base } = source.raw;
    const nativeOperation = createNativeWorkOrders();
    const canonical = await nativeOperation.read({ company_id: "company-a", actor_id: "actor-a",
      work_order_id: "order-a", companyStorage, signal: new AbortController().signal });
    const evidence_context = canonical.evidence_context;
    assert.deepEqual(evidence_context, { company_id: "company-a", work_order_id: "order-a",
      visit_id: "visit-a", task_id: "task-a", disposition: "fix_now" });
    const producerEvent = {
      ...base,
      request_summary: { capability: "crm.work_order.complete",
        input: { company_id: target.company_id, work_id: target.work_id, work_order_id: target.work_order_id },
        decision_id: "decision-a", work_id: target.work_id, run_id: "run-a" },
      observed_result: { status: "completed", evidence_context },
      verification: { verified: true, verification_id: "verification-native-task-a", method: "independent-company-store-reread", evidence_context },
    };
    const context = verifiedTaskLineageFromProducerEvent(producerEvent);
    assert.deepEqual(context, evidence_context);
    assert.equal(verifiedTaskLineageFromProducerEvent({ ...producerEvent,
      verification: { ...producerEvent.verification, evidence_context: { ...evidence_context, company_id: "company-b" } } }), null);
    assert.doesNotThrow(() => assertReplayTaskLineage({ accepted_evidence: { request_summary: { canonical_operation_context: evidence_context } } }, { evidence_context }));
    assert.throws(() => assertReplayTaskLineage({ accepted_evidence: { request_summary: { canonical_operation_context: evidence_context } } },
      { evidence_context: { ...evidence_context, task_id: "task-b" } }), /zero-replay-task-context-no-longer-verified/);
    const ledger = new AcceptedEvidenceLedger({ now: () => at });
    const persistedEvent = {
      ...producerEvent,
      request_summary: { ...producerEvent.request_summary, canonical_operation_context: context },
      observed_result: { ...producerEvent.observed_result, ...context },
      verification: { ...producerEvent.verification, ...context },
    };
    const accepted = ledger.append(persistedEvent);
    assert.equal(ledger.projectJob(target.company_id, target.work_id).status, "VERIFIED");
    const provenance = { ...source.provenance, ...context };
    await storage.query(
      "INSERT INTO evidence(id,company_id,subject_type,subject_id,evidence_type,provenance,payload) VALUES($1,$2,'work',$3,'gateway_execution',$4,$5)",
      [producerEvent.evidence_id, target.company_id, target.work_id, JSON.stringify(provenance),
        JSON.stringify({ ...persistedEvent, provenance, accepted_evidence: accepted })],
    );
    const references = await runtime.resolveAcceptedEvidenceReferences(target);
    assert.deepEqual(references.map((reference: any) => reference.evidence_id), [producerEvent.evidence_id]);
  } finally { await storage.close(); companyStorage.close(); }
});

test("Zero project projection consumes accepted references only for its current verified company task", async () => {
  const evidenceContext = { company_id: target.company_id, work_order_id: target.work_order_id,
    visit_id: target.visit_id, task_id: target.task_id, disposition: target.disposition };
  const { storage, runtime } = await fixture({
    async read() { return { status: "completed", completed_at: at, evidence_context: evidenceContext }; },
  });
  try {
    await insertRecord(storage, target);
    (runtime.zeroDispatcher as any).reconcilePersistedWork = async () => ({
      company_id: target.company_id, work_id: target.work_id, state: "COMPLETED",
      origin: { actor_id: "actor-a", conversation_id: "conversation-a", surface: "zero" }, evidence_refs: [],
    });
    (runtime.runStore as any).findByWork = async () => ({ run_id: "run-a",
      messages: [{ role: "user", content: `complete work order ${target.work_order_id}` }] });

    const view = await runtime.project({ company_id: target.company_id, actor_id: "actor-a", work_id: target.work_id });
    assert.equal(view.outcome, "verified");
    assert.deepEqual(view.accepted_evidence_references.map((reference: any) => reference.evidence_id), ["evidence-a"]);
    assert.deepEqual(view.accepted_evidence_references[0], {
      schema: "titan.accepted-evidence-reference/v1", evidence_id: "evidence-a", company_id: target.company_id,
      work_id: target.work_id, visit_id: target.visit_id, work_order_id: target.work_order_id,
      task_id: target.task_id, disposition: target.disposition, execution_id: "execution-a",
      decision_id: "decision-a", authority_decision_id: "decision-a", verification_id: "verification-evidence-a",
      run_id: "run-a", correlation_id: "correlation-evidence-a", accepted_at: at,
    });
  } finally { await storage.close(); }
});

test("governed native v3 completion atomically produces the exact accepted reference consumed by Zero", async () => {
  const companyStorage = createCanonicalV3NativeStore();
  const nativeWorkOrders = createNativeWorkOrders();
  const { storage, runtime } = await fixture({
    async read(input: any) { return nativeWorkOrders.read({ ...input, companyStorage }); },
    async complete(input: any) { return nativeWorkOrders.complete({ ...input, companyStorage }); },
  });
  const company_id = "company-a";
  const actor_id = "actor-a";
  const agent_id = "field-agent-a";
  const work_id = "work-a";
  const work_order_id = "order-a";
  const run_id = "run-a";
  const capability = "crm.work_order.complete";
  const now = new Date().toISOString();
  const expires_at = new Date(Date.now() + 60 * 60_000).toISOString();
  const identity = { company_id, actor_id, agent_id, work_id, run_id, input: { work_order_id } };
  try {
    const currentBusiness = await nativeWorkOrders.read({ ...identity, work_order_id, companyStorage });
    assert.deepEqual(currentBusiness.evidence_context, { company_id, work_order_id,
      visit_id: "visit-a", task_id: "task-a", disposition: "fix_now" });
    await runtime.workforceStore.putWorker({ company_id, worker_id: agent_id, kind: "digital", active: true,
      capabilities: [capability] });

    const proof_id = "field-completion-proof-a";
    await storage.query("INSERT INTO evidence(id,company_id,subject_type,subject_id,evidence_type,provenance,payload) VALUES($1,$2,'work_order',$3,'field_completion',$4,$5)",
      [proof_id, company_id, work_order_id, JSON.stringify({ source: "disposable-governed-test" }), JSON.stringify({ verified: true })]);
    await storage.query("INSERT INTO authority_state(id,company_id,subject_type,subject_id,level,envelope) VALUES($1,$2,'worker_capability',$3,'scoped',$4)",
      [`field-grant-${company_id}`, company_id, `${agent_id}/${capability}`, JSON.stringify({ company_id, worker_id: agent_id,
        actor_id, work_order_id, capability, status: "active", policy_allows: true, governance_allows: true,
        assurance_allows: true, risk: "low", expires_at, evidence_refs: [proof_id] })]);
    await new SqliteWorkerAccessStore(storage).append({ company_id, assignment_id: "field-access-a", worker_id: agent_id,
      permissions: [capability], status: "active", granted_by: "disposable-test-authority", granted_at: now, expires_at });
    const authorityStore = new SqliteAuthorityStore(storage);
    await authorityStore.appendAutonomySnapshot({ company_id, decision_id: "field-autonomy-a", capability,
      effective_score: 60, status: "verified", source: "titan-autonomy", verified_at: now, expires_at,
      trusted_auto_handshake: { platform: false, user: false, assurance: false }, predictive_ready: false }, { worker_id: agent_id });
    await authorityStore.appendApproval({ company_id, approval_id: "field-approval-a", approval_scope: work_order_id,
      status: "approved", approver_id: "independent-human-a", granted_at: now, expires_at });

    const conversation_id = "conversation-a";
    const run = { company_id, run_id, state: "RUNNING", conversation_id, agent_id, work_id,
      updated_at: now, messages: [{ role: "user", content: `complete work order ${work_order_id}` }],
      correlation_id: "correlation-a", idempotency_key: "idempotency-a" };
    await runtime.runStore.create(run);
    await runtime.workforceStore.put({ company_id, work_id, objective: "Complete the visit task", creator: actor_id,
      origin: { actor_id, conversation_id, surface: "zero", correlation_id: "correlation-a" }, assignee: agent_id,
      priority: 50, state: "IN_PROGRESS", dependencies: [], required_capabilities: [capability],
      context_refs: [], evidence_refs: [], created_at: now, updated_at: now });

    const decision = await runtime.authorityGateway.authorize(identity);
    assert.equal(decision.status, "allowed");
    const execution = await runtime.authorityGateway.execute({ ...identity, decision, signal: new AbortController().signal });
    assert.equal(execution.state, "VERIFIED");
    assert.deepEqual(execution.evidence.verification.evidence_context, currentBusiness.evidence_context);

    const persistedRows = (await storage.query("SELECT id,payload FROM evidence WHERE company_id=$1 AND subject_type='work' AND subject_id=$2 AND evidence_type='gateway_execution' ORDER BY rowid", [company_id, work_id])).rows;
    const terminal = persistedRows.map((row: any) => ({ id: row.id, payload: JSON.parse(row.payload) }))
      .find(({ payload }: any) => payload.state === "VERIFIED");
    assert.ok(terminal);
    assert.equal(terminal.id, execution.evidence.evidence_id);
    assert.equal(terminal.payload.accepted_evidence.factual, true);
    assert.deepEqual(terminal.payload.accepted_evidence.request_summary.canonical_operation_context,
      currentBusiness.evidence_context);
    assert.deepEqual(terminal.payload.provenance, JSON.parse((await storage.query("SELECT provenance FROM evidence WHERE id=$1", [terminal.id])).rows[0].provenance));

    const references = await runtime.resolveAcceptedEvidenceReferences({ company_id, work_id, ...currentBusiness.evidence_context });
    assert.deepEqual(references.map((reference: any) => reference.evidence_id), [terminal.id]);
    assert.deepEqual(await runtime.resolveAcceptedEvidenceReferences({ work_id,
      ...currentBusiness.evidence_context, company_id: "company-b" }), []);

    const completedRun = await runtime.runStore.get(company_id, run_id);
    await runtime.runStore.save({ ...completedRun, state: "COMPLETED", updated_at: new Date(Date.now() + 1).toISOString() });
    const view = await runtime.project({ company_id, actor_id, work_id });
    assert.equal(view.outcome, "verified");
    assert.deepEqual(view.accepted_evidence_references.map((reference: any) => reference.evidence_id), [terminal.id]);
    assert.deepEqual(view.accepted_evidence_references[0], references[0]);
  } finally { await storage.close(); companyStorage.close(); }
});

test("native context derivation denies wrong company and schemas without persisted disposition", async () => {
  const nativeOperation = createNativeWorkOrders();
  const current = createNativeOperationContextStore();
  const legacy = createNativeOperationContextStore(false);
  try {
    assert.equal(await nativeOperation.read({ company_id: "company-b", actor_id: "actor-a", work_order_id: "order-a", companyStorage: current }), null);
    assert.equal(await nativeOperation.read({ company_id: "company-a", actor_id: "actor-b", work_order_id: "order-a", companyStorage: current }), null);
    assert.equal((await nativeOperation.read({ company_id: "company-a", actor_id: "actor-a", work_order_id: "order-a", companyStorage: legacy })).evidence_context, null);
  } finally { current.close(); legacy.close(); }
});

test("raw gateway rows and provider acknowledgements never resolve as accepted references", async () => {
  const { storage, runtime } = await fixture();
  try {
    await insertRecord(storage, target, { evidence_id: "raw-only", omit_accepted_marker: true });
    await insertRecord(storage, { ...target, work_id: "work-ack" }, {
      evidence_id: "ack-only", state: "PROVIDER_ACKNOWLEDGED", final_outcome: null,
    });
    assert.deepEqual(await runtime.resolveAcceptedEvidenceReferences(target), []);
    assert.deepEqual(await runtime.resolveAcceptedEvidenceReferences({ ...target, work_id: "work-ack" }), []);
  } finally { await storage.close(); }
});

test("current generic work-order completion evidence lacks visit/task/disposition links and stays unexposed", async () => {
  const { storage, runtime } = await fixture();
  try {
    const absentTaskLink = { visit_id: undefined, task_id: undefined, disposition: undefined };
    await insertRecord(storage, target, { request: absentTaskLink, observed: absentTaskLink,
      verification: absentTaskLink, provenance: absentTaskLink, omit_context: true });
    assert.deepEqual(await runtime.resolveAcceptedEvidenceReferences(target), []);
  } finally { await storage.close(); }
});

test("references fail closed for wrong company, mismatched scope, disposition, or provenance", async () => {
  const { storage, runtime } = await fixture();
  try {
    await insertRecord(storage, target);
    assert.deepEqual(await runtime.resolveAcceptedEvidenceReferences({ ...target, company_id: "company-b" }), []);
    assert.deepEqual(await runtime.resolveAcceptedEvidenceReferences({ ...target, work_order_id: "order-b" }), []);

    const mismatchCases: Array<Parameters<typeof acceptedRecord>[1]> = [
      { evidence_id: "wrong-visit", context: { visit_id: "visit-b" } },
      { evidence_id: "wrong-task", observed: { task_id: "task-b" } },
      { evidence_id: "wrong-disposition", verification: { disposition: "ok" } },
      { evidence_id: "missing-provenance", provenance: { task_id: undefined } },
    ];
    for (const [index, options] of mismatchCases.entries()) {
      const criteria = { ...target, work_id: `mismatch-${index}` };
      await insertRecord(storage, criteria, options);
      assert.deepEqual(await runtime.resolveAcceptedEvidenceReferences(criteria), [], options?.evidence_id);
    }
    await assert.rejects(() => runtime.resolveAcceptedEvidenceReferences({ ...target, disposition: "done" as any }),
      /accepted-evidence-reference-disposition-invalid/);
  } finally { await storage.close(); }
});

test("superseded accepted evidence is not exposed as a current task reference", async () => {
  const { storage, runtime } = await fixture();
  try {
    const ledger = new AcceptedEvidenceLedger({ now: () => at });
    await insertRecord(storage, target, { evidence_id: "evidence-old" }, ledger);
    await insertRecord(storage, target, { evidence_id: "evidence-new", supersedes_evidence_id: "evidence-old" }, ledger);
    const references = await runtime.resolveAcceptedEvidenceReferences(target);
    assert.deepEqual(references.map((reference: any) => reference.evidence_id), ["evidence-new"]);
  } finally { await storage.close(); }
});
