import test from "node:test";
import assert from "node:assert/strict";
import { acceptBusinessEvidence, foldJobReality } from "../.test-dist/business-evidence.js";

const base = {
  evidence_version: 1,
  company_id: "company-a",
  subject_type: "job",
  subject_id: "job-1",
  classification: "factual",
  acceptance_state: "accepted",
  source_type: "execution-gateway",
  source_id: "gateway-1",
  correlation_id: "corr-1",
  projection_version: "job-reality.v1",
  provenance: { provider: "native" },
  occurred_at: "2026-09-28T00:00:00.000Z",
  accepted_at: "2026-09-28T00:00:01.000Z",
};

test("verified factual evidence deterministically rebuilds job reality with reverse provenance", () => {
  const ack = acceptBusinessEvidence({ ...base, evidence_id: "ev-ack", event_type: "execution.provider_acknowledged", execution_id: "exec-1", payload: { status: "completed" } });
  const verified = acceptBusinessEvidence({ ...base, evidence_id: "ev-verified", event_type: "job.status.verified", execution_id: "exec-1", verification_id: "verify-1", accepted_at: "2026-09-28T00:00:02.000Z", payload: { status: "completed" } });
  const a = foldJobReality("company-a", "job-1", [verified, ack]);
  const b = foldJobReality("company-a", "job-1", [ack, verified]);
  assert.deepEqual(a, b);
  assert.equal(a.status, "completed");
  assert.deepEqual(a.source_evidence_ids, ["ev-verified"]);
});

test("provider acknowledgement alone cannot create verified job reality", () => {
  const ack = acceptBusinessEvidence({ ...base, evidence_id: "ev-ack", event_type: "execution.provider_acknowledged", execution_id: "exec-1", payload: { status: "completed" } });
  assert.equal(foldJobReality("company-a", "job-1", [ack]).status, null);
});

test("correction is new linked evidence and deterministically supersedes prior fact", () => {
  const verified = acceptBusinessEvidence({ ...base, evidence_id: "ev-1", event_type: "job.status.verified", verification_id: "verify-1", payload: { status: "completed" } });
  const corrected = acceptBusinessEvidence({ ...base, evidence_id: "ev-2", event_type: "job.status.corrected", supersedes_evidence_id: "ev-1", accepted_at: "2026-09-28T00:00:03.000Z", payload: { status: "in_progress" } });
  const reality = foldJobReality("company-a", "job-1", [corrected, verified]);
  assert.equal(reality.status, "in_progress");
  assert.deepEqual(reality.source_evidence_ids, ["ev-1", "ev-2"]);
});

test("simulated evidence cannot enter accepted factual history", () => {
  assert.throws(() => acceptBusinessEvidence({ ...base, evidence_id: "sim-1", event_type: "job.status.verified", classification: "simulated", payload: { status: "completed" } }), /simulated-cannot-enter-factual-ledger/);
});

test("cross-company evidence fails closed", () => {
  const verified = acceptBusinessEvidence({ ...base, evidence_id: "ev-1", event_type: "job.status.verified", verification_id: "verify-1", payload: { status: "completed" } });
  assert.throws(() => foldJobReality("company-b", "job-1", [verified]), /company-mismatch/);
});

test("verified event requires verification reference and provider ACK cannot masquerade as verified", () => {
  assert.throws(() => acceptBusinessEvidence({ ...base, evidence_id: "bad-v", event_type: "job.status.verified", payload: { status: "completed" } }), /verification-required/);
  assert.throws(() => acceptBusinessEvidence({ ...base, evidence_id: "bad-ack", event_type: "execution.provider_acknowledged", verification_id: "verify-impossible", payload: {} }), /provider-ack-cannot-carry-verification/);
});
