import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "../storage/src/index.js";
import { SqliteBusinessEvidenceStore } from "../runtime/evidence/sqlite-business-evidence-store.mjs";
import { foldJobReality } from "../titan-platform/src/business-evidence.ts";
import { EXECUTION_CLASSES } from "./execution-gateway.mjs";
import { createBusinessEvidenceExecutionGateway, createBusinessEvidenceExecutionSink } from "./business-evidence-execution-sink.mjs";

function memoryStore({ failOnceFor } = {}) {
  const rows = new Map();
  let failed = false;
  return {
    rows,
    async get(company_id, evidence_id) { return rows.get(`${company_id}:${evidence_id}`) ?? null; },
    async append(entry) {
      if (entry.evidence_id === failOnceFor && !failed) { failed = true; throw new Error("simulated-append-interruption"); }
      const key = `${entry.company_id}:${entry.evidence_id}`;
      if (rows.has(key)) throw new Error("duplicate-primary-key");
      const row = structuredClone(entry);
      row.id = row.evidence_id;
      delete row.evidence_id;
      row.evidence_type = row.event_type;
      row.created_at = row.accepted_at;
      rows.set(key, row);
      return rows.get(key);
    },
    async acceptedForSubject(company_id, subject_type, subject_id) {
      return [...rows.values()].filter(row => row.company_id === company_id && row.subject_type === subject_type && row.subject_id === subject_id);
    },
  };
}

const request = {
  execution_id: "exec-1", company_id: "company-a", actor_id: "actor-1", agent_id: "agent-1",
  authority_decision_id: "authority-1", decision_id: "decision-1", work_id: "job-1",
  capability: "job.complete", idempotency_key: "job-1-complete",
  authority: { status: "approved" }, risk: { status: "approved" },
};

test("ExecutionGateway routes ACK and verified outcomes into company-scoped canonical evidence", async () => {
  const store = memoryStore();
  const sink = createBusinessEvidenceExecutionSink({ store });
  const gateway = createBusinessEvidenceExecutionGateway({
    store,
    providers: [{
      id: "native-field-service", executionClass: EXECUTION_CLASSES.NATIVE, capabilities: ["job.complete"],
      execute: async () => ({ external_ref: "work-order-1", result: { status: "completed" } }),
      verify: async () => ({ verified: true, verification_id: "verify-1", method: "canonical-reread" }),
    }],
  });
  const result = await gateway.execute(request);
  const records = [...store.rows.values()];
  const ack = records.find(row => row.event_type === "execution.provider_acknowledged");
  const verified = records.find(row => row.event_type === "execution.verified");
  const jobFact = records.find(row => row.event_type === "job.status.verified");
  assert.equal(result.state, "VERIFIED");
  assert.equal(ack.verification_id, null);
  assert.equal(jobFact.payload.status, "completed");
  assert.equal(jobFact.verification_id, "verify-1");
  assert.equal(jobFact.company_id, "company-a");
  assert.equal(jobFact.execution_id, verified.execution_id);
  assert.equal(jobFact.actor_id, "actor-1");
  assert.equal(jobFact.agent_id, "agent-1");
  assert.equal(jobFact.correlation_id, "job-1");
  assert.equal(jobFact.causation_id, verified.id);
  assert.equal(jobFact.decision_id, verified.decision_id);
  assert.equal(jobFact.authority_decision_id, "authority-1");
  const rowCount = store.rows.size;
  await sink(result.evidence);
  assert.equal(store.rows.size, rowCount);
});

test("verified producer without a reference cannot persist a verified job fact", async () => {
  const store = memoryStore();
  const gateway = createBusinessEvidenceExecutionGateway({
    store,
    providers: [{
      id: "native-field-service", executionClass: EXECUTION_CLASSES.NATIVE, capabilities: ["job.complete"],
      execute: async () => ({ external_ref: "work-order-2", result: { status: "completed" } }),
      verify: async () => ({ verified: true, method: "canonical-reread" }),
    }],
  });
  const result = await gateway.execute({ ...request, idempotency_key: "job-1-complete-no-verification-reference" });
  assert.equal(result.state, "UNCERTAIN");
  assert.equal([...store.rows.values()].some(row => row.event_type === "job.status.verified"), false);
  assert.equal([...store.rows.values()].some(row => row.event_type === "execution.verified"), false);
});

test("stable evidence identities repair a partial append and make sink replay idempotent", async () => {
  const source = {
    evidence_id: "event-1", execution_id: "exec-2", company_id: "company-a", work_id: "job-2",
    capability: "job.complete", provider: "native", execution_class: "native", state: "VERIFIED",
    finished_at: "2026-10-02T00:00:00Z", accepted_at: "2026-10-02T00:00:01Z",
    verification: { verified: true, verification_id: "verify-2" }, observed_result: { status: "completed" },
    final_outcome: "verified", idempotency_key: "idempotency-2", decision_id: "decision-2",
  };
  const store = memoryStore({ failOnceFor: "event-1:job-reality" });
  const sink = createBusinessEvidenceExecutionSink({ store });
  await assert.rejects(sink(source), /simulated-append-interruption/);
  assert.equal(store.rows.size, 1);
  await sink(source);
  await sink(source);
  assert.equal(store.rows.size, 2);
  assert.equal((await store.get("company-a", "event-1:job-reality")).payload.status, "completed");
});

test("real SQLite store reconstructs company-scoped job reality after reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "titan-business-evidence-"));
  const filename = join(root, "evidence.sqlite");
  let storage = createSqliteStorage(filename);
  try {
    await storage.query(`CREATE TABLE evidence (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
      evidence_type TEXT NOT NULL, provenance TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
      evidence_version INTEGER NOT NULL, classification TEXT NOT NULL, acceptance_state TEXT NOT NULL,
      event_type TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL, actor_id TEXT, agent_id TEXT,
      correlation_id TEXT NOT NULL, causation_id TEXT, decision_id TEXT, authority_decision_id TEXT, execution_id TEXT,
      verification_id TEXT, projection_version TEXT NOT NULL, supersedes_evidence_id TEXT, occurred_at TEXT NOT NULL,
      accepted_at TEXT NOT NULL
    )`);
    const store = new SqliteBusinessEvidenceStore(storage);
    const gateway = createBusinessEvidenceExecutionGateway({
      store,
      providers: [{
        id: "native-field-service", executionClass: EXECUTION_CLASSES.NATIVE, capabilities: ["job.complete"],
        execute: async () => ({ external_ref: "work-order-1", result: { status: "completed" } }),
        verify: async () => ({ verified: true, verification_id: "verify-durable-1" }),
      }],
    });
    const result = await gateway.execute(request);
    assert.equal(result.state, "VERIFIED");
    const before = await store.acceptedForSubject("company-a", "job", "job-1");
    const projection = foldJobReality("company-a", "job-1", before);
    assert.equal(projection.status, "completed");
    assert.deepEqual(projection.source_evidence_ids, [`${result.evidence.evidence_id}:job-reality`]);

    await storage.close();
    storage = createSqliteStorage(filename);
    const reopened = new SqliteBusinessEvidenceStore(storage);
    const after = await reopened.acceptedForSubject("company-a", "job", "job-1");
    assert.deepEqual(foldJobReality("company-a", "job-1", after), projection);
    assert.equal((await reopened.acceptedForSubject("company-b", "job", "job-1")).length, 0);

    const originalJobFact = after.find(row => row.event_type === "job.status.verified");
    assert.ok(originalJobFact);
    const correction = {
      ...originalJobFact,
      evidence_id: "job-1:corrected",
      event_type: "job.status.corrected",
      supersedes_evidence_id: originalJobFact.evidence_id,
      causation_id: originalJobFact.evidence_id,
      accepted_at: new Date(Date.parse(originalJobFact.accepted_at) + 1000).toISOString(),
      payload: { status: "in_progress" },
    };
    await reopened.append(correction);
    const correctedHistory = await reopened.acceptedForSubject("company-a", "job", "job-1");
    const correctedProjection = foldJobReality("company-a", "job-1", correctedHistory);
    assert.equal(correctedProjection.status, "in_progress");
    assert.deepEqual(correctedProjection.source_evidence_ids, [originalJobFact.evidence_id, correction.evidence_id]);

    const count = (await storage.query("SELECT id FROM evidence")).rowCount;
    await createBusinessEvidenceExecutionSink({ store: reopened })(result.evidence);
    assert.equal((await storage.query("SELECT id FROM evidence")).rowCount, count);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native provider uncertainty is persisted without changing job reality",async()=>{
 const store=memoryStore();
 const gateway=createBusinessEvidenceExecutionGateway({
  store,
  providers:[{
   id:"native-field-service",executionClass:EXECUTION_CLASSES.NATIVE,capabilities:["job.complete"],
   execute:async()=>({external_ref:"work-order-uncertain",result:{status:"completed"}}),
   verify:async()=>({verified:false}),
  }],
 });
 const result=await gateway.execute({...request,execution_id:"exec-uncertain",idempotency_key:"job-uncertain"});
 assert.equal(result.state,"UNCERTAIN");
 const rows=[...store.rows.values()];
 const uncertainty=rows.find(row=>row.event_type==="execution.uncertain");
 assert.ok(uncertainty);
 assert.equal(uncertainty.subject_type,"execution");
 assert.equal(uncertainty.company_id,"company-a");
 assert.equal(uncertainty.verification_id,null);
 assert.equal(rows.some(row=>row.event_type==="job.status.verified"),false);
 assert.equal(foldJobReality("company-a","job-1",await store.acceptedForSubject("company-a","job","job-1")).status,null);
});
