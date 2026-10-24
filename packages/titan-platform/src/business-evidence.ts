export type BusinessEvidenceClassification = "factual" | "simulated" | "counterfactual";
export type BusinessEvidenceAcceptance = "accepted" | "rejected";

export type BusinessEvidence = Readonly<{
  evidence_id: string;
  evidence_version: 1;
  company_id: string;
  event_type: string;
  subject_type: string;
  subject_id: string;
  classification: BusinessEvidenceClassification;
  acceptance_state: BusinessEvidenceAcceptance;
  source_type: string;
  source_id: string;
  actor_id?: string | null;
  agent_id?: string | null;
  correlation_id: string;
  causation_id?: string | null;
  decision_id?: string | null;
  authority_decision_id?: string | null;
  execution_id?: string | null;
  verification_id?: string | null;
  projection_version: string;
  supersedes_evidence_id?: string | null;
  provenance: Readonly<Record<string, unknown>>;
  payload: Readonly<Record<string, unknown>>;
  occurred_at: string;
  accepted_at: string;
}>;

const required = (value: unknown, name: string) => {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`business-evidence-${name}-required`);
  return text;
};

const optionalReference = (value: unknown, name: string): string | null | undefined => {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new Error(`business-evidence-${name}-invalid`);
  const text = value.trim();
  if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`business-evidence-${name}-invalid`);
  }
  return text;
};

const iso = (value: unknown, name: string) => {
  const text = required(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`business-evidence-${name}-invalid`);
  return new Date(text).toISOString();
};

export function acceptBusinessEvidence(input: Omit<BusinessEvidence, "evidence_version"> & { evidence_version?: 1 }): BusinessEvidence {
  for (const legacy of ["tenant_id", "tenant_company_id", "business_id", "account_id", "workspace_id"]) {
    if (Object.prototype.hasOwnProperty.call(input, legacy)) throw new Error(`business-evidence-legacy-boundary-forbidden:${legacy}`);
  }
  const classification = input.classification ?? "factual";
  if (!["factual", "simulated", "counterfactual"].includes(classification)) throw new Error("business-evidence-classification-invalid");
  const acceptance_state = input.acceptance_state ?? "accepted";
  if (!["accepted", "rejected"].includes(acceptance_state)) throw new Error("business-evidence-acceptance-invalid");
  if (classification !== "factual" && acceptance_state === "accepted") {
    throw new Error("business-evidence-simulated-cannot-enter-factual-ledger");
  }
  const event_type = required(input.event_type, "event-type");
  const verification_id = optionalReference(input.verification_id, "verification-id");
  const supersedes_evidence_id = optionalReference(input.supersedes_evidence_id, "supersedes-evidence-id");
  if (event_type === "job.status.verified" && !verification_id) {
    throw new Error("business-evidence-verification-required");
  }
  if (event_type === "execution.provider_acknowledged" && verification_id) {
    throw new Error("business-evidence-provider-ack-cannot-carry-verification");
  }
  if (event_type === "job.status.corrected" && !supersedes_evidence_id) {
    throw new Error("business-evidence-supersedes-required");
  }
  return Object.freeze({
    ...input,
    evidence_id: required(input.evidence_id, "evidence-id"),
    evidence_version: 1 as const,
    company_id: required(input.company_id, "company-id"),
    event_type,
    subject_type: required(input.subject_type, "subject-type"),
    subject_id: required(input.subject_id, "subject-id"),
    classification,
    acceptance_state,
    source_type: required(input.source_type, "source-type"),
    source_id: required(input.source_id, "source-id"),
    correlation_id: required(input.correlation_id, "correlation-id"),
    actor_id: optionalReference(input.actor_id, "actor-id"),
    agent_id: optionalReference(input.agent_id, "agent-id"),
    causation_id: optionalReference(input.causation_id, "causation-id"),
    decision_id: optionalReference(input.decision_id, "decision-id"),
    authority_decision_id: optionalReference(input.authority_decision_id, "authority-decision-id"),
    execution_id: optionalReference(input.execution_id, "execution-id"),
    verification_id,
    supersedes_evidence_id,
    projection_version: required(input.projection_version, "projection-version"),
    occurred_at: iso(input.occurred_at, "occurred-at"),
    accepted_at: iso(input.accepted_at, "accepted-at"),
    provenance: Object.freeze({ ...(input.provenance ?? {}) }),
    payload: Object.freeze({ ...(input.payload ?? {}) }),
  });
}

export type JobRealityProjection = Readonly<{
  schema: "titan.business-reality.job.v1";
  projection_version: string;
  company_id: string;
  job_id: string;
  status: string | null;
  source_evidence_ids: readonly string[];
  last_evidence_id: string | null;
}>;

export function foldJobReality(
  company_id: string,
  job_id: string,
  evidence: readonly BusinessEvidence[],
  projection_version = "job-reality.v1",
): JobRealityProjection {
  const cid = required(company_id, "company-id");
  const jid = required(job_id, "job-id");
  const factual = evidence
    .filter((entry) => {
      if (entry.company_id !== cid) throw new Error("business-evidence-company-mismatch");
      return entry.acceptance_state === "accepted" && entry.classification === "factual" &&
        entry.subject_type === "job" && entry.subject_id === jid;
    })
    .sort((a, b) => a.accepted_at.localeCompare(b.accepted_at) || a.evidence_id.localeCompare(b.evidence_id));

  let status: string | null = null;
  const sources: string[] = [];
  for (const entry of factual) {
    // Provider acknowledgement is execution evidence, not verified business reality.
    if (entry.event_type === "execution.provider_acknowledged") continue;
    if (entry.event_type === "job.status.verified") {
      if (!optionalReference(entry.verification_id, "verification-id")) throw new Error("business-evidence-verification-required");
      status = required(entry.payload.status, "job-status");
      sources.push(entry.evidence_id);
    }
    if (entry.event_type === "job.status.corrected") {
      if (!entry.supersedes_evidence_id) throw new Error("business-evidence-supersedes-required");
      status = required(entry.payload.status, "job-status");
      sources.push(entry.evidence_id);
    }
  }
  return Object.freeze({
    schema: "titan.business-reality.job.v1",
    projection_version,
    company_id: cid,
    job_id: jid,
    status,
    source_evidence_ids: Object.freeze(sources),
    last_evidence_id: sources.at(-1) ?? null,
  });
}
