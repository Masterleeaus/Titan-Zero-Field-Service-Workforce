import {
  createCustomerCareCase,
  assessCustomerCareEscalation,
  assessReviewEligibility as assessLegacyReviewEligibility,
} from "../ported/titan-workforce/customer-care/customer-care-contract.js";
import {
  createComplaintIntake,
  buildCustomerCareCaseFromComplaintIntake,
} from "../ported/titan-workforce/customer-care/complaint-intake.js";
import { triageCustomerCareCase } from "../ported/titan-workforce/customer-care/customer-care-triage.js";
import {
  createCustomerCareHumanReview,
  decideCustomerCareHumanReview,
  buildCustomerCareApprovalHandoff,
} from "../ported/titan-workforce/customer-care/customer-care-human-review.js";
import { buildGroundedResponseProposal } from "../ported/titan-workforce/customer-care/grounded-response.js";
import { assessPublicReviewRequestEligibility, MemoryReviewRequestLedger } from "../ported/titan-workforce/customer-care/review-request-eligibility.js";
import { buildResolvedServiceHandoff } from "../ported/titan-workforce/customer-care/resolved-service-handoff.js";
import {
  normalizeCustomerCareSettings,
  evaluateCustomerCareSettingsForCase,
} from "../ported/titan-workforce/customer-care/customer-care-settings.js";
import {
  assertTitanNativeWorkforceBoundary,
  getTitanNativeWorkforceAgentMap,
  resolveTitanNativeCleaningProfileBinding,
  type TitanNativeCleaningProfileBinding,
  type TitanNativeWorkforceOperation,
} from "./contracts.js";

export type TitanCustomerCareAction =
  | "get_customer"
  | "get_project"
  | "get_invoice"
  | "list_property_issues"
  | "record_property_issue"
  | "resolve_property_issue"
  | "create_case_projection"
  | "intake_complaint"
  | "triage_case"
  | "assess_escalation"
  | "build_grounded_response"
  | "create_human_review"
  | "decide_human_review"
  | "assess_review_eligibility"
  | "normalize_settings"
  | "evaluate_settings"
  | "build_resolved_handoff";

export type TitanCustomerCarePlanInput = Readonly<{
  companyId: string;
  actorId?: string | null;
  action: TitanCustomerCareAction;
  customerId?: string | null;
  projectId?: string | null;
  invoiceId?: string | null;
  propertyId?: string | null;
  issueId?: string | null;
  traceId?: string | null;
  payload?: Readonly<Record<string, unknown>> | null;
  cleaningProfileId?: string;
}>;

type JsonRecord = Readonly<Record<string, unknown>>;
const LEGACY = new Set(["tenant_id", "tenant_company_id", "tenant_company", "tenant", "tenantCompanyId", "organisation_id", "organization_id", "workspace_tenant_id"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
function clean(value: unknown, max = 4000) { return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : ""; }
function entityId(value: unknown, error: string) { const id = clean(value, 180); if (!id || !SAFE_ID.test(id) || id.includes("..")) throw new Error(error); return id; }
function rejectLegacy(value: unknown, path = "payload"): void { if (!value || typeof value !== "object") return; if (Array.isArray(value)) { value.forEach((v, i) => rejectLegacy(v, `${path}[${i}]`)); return; } for (const [k, v] of Object.entries(value as Record<string, unknown>)) { if (LEGACY.has(k)) throw new Error(`legacy-company-boundary:${path}.${k}`); rejectLegacy(v, `${path}.${k}`); } }
function freezePayload(value: TitanCustomerCarePlanInput["payload"]): JsonRecord { const payload = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}; rejectLegacy(payload); return Object.freeze(payload); }
function operation(id: string): TitanNativeWorkforceOperation { const found = getTitanNativeWorkforceAgentMap("customer_care")?.operations.find((item) => item.id === id); if (!found) throw new Error(`customer-care-operation-unavailable:${id}`); return found; }
function withCompany(payload: JsonRecord, company_id: string) {
  const declared = clean(payload.company_id, 128);
  if (declared && declared !== company_id) throw new Error("cross-company-customer-care-projection-rejected");
  return Object.freeze({ ...payload, company_id, authority_granted: false, execution_permitted: false });
}
function recordFromPayload(payload: JsonRecord, key: string) { const value = payload[key]; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export function buildTitanCustomerCarePlan(input: TitanCustomerCarePlanInput) {
  const company_id = assertTitanNativeWorkforceBoundary(input.companyId);
  const actor_id = clean(input.actorId, 128) || null;
  const payload = freezePayload(input.payload);
  let op: TitanNativeWorkforceOperation | null = null;
  let entity_id: string | null = null;
  let property_id: string | null = null;
  let issue_id: string | null = null;
  let query: JsonRecord = Object.freeze({});
  let body: JsonRecord | null = null;
  let projection: unknown = null;

  if (input.action === "get_customer") {
    op = operation("clients.get"); entity_id = entityId(input.customerId, "customer-care-customer-id-required");
  } else if (input.action === "get_project") {
    op = operation("projects.get"); entity_id = entityId(input.projectId, "customer-care-project-id-required");
  } else if (input.action === "get_invoice") {
    op = operation("invoices.get"); entity_id = entityId(input.invoiceId, "customer-care-invoice-id-required");
  } else if (input.action === "list_property_issues") {
    op = operation("property_issues.list"); property_id = entityId(input.propertyId, "customer-care-property-id-required"); entity_id = property_id;
    if (payload.status) query = Object.freeze({ status: clean(payload.status, 120) });
  } else if (input.action === "record_property_issue") {
    op = operation("property_issues.create"); property_id = entityId(input.propertyId, "customer-care-property-id-required"); entity_id = property_id;
    const severity = clean(payload.severity, 32).toLowerCase() || "minor";
    if (!new Set(["minor", "moderate", "major", "critical"]).has(severity)) throw new Error("customer-care-property-issue-severity-invalid");
    body = Object.freeze({
      area: clean(payload.area, 200) || "customer-care",
      item_key: clean(payload.item_key, 200) || `customer-care:${clean(input.traceId, 120) || "service-issue"}`,
      title: clean(payload.title, 500) || "Customer service issue",
      ...(clean(payload.description, 4000) ? { description: clean(payload.description, 4000) } : {}),
      severity,
      status: clean(payload.status, 32).toLowerCase() === "monitoring" ? "monitoring" : "open",
    });
  } else if (input.action === "resolve_property_issue") {
    op = operation("property_issues.update"); property_id = entityId(input.propertyId, "customer-care-property-id-required"); issue_id = entityId(input.issueId, "customer-care-issue-id-required"); entity_id = property_id;
    const status = clean(payload.status, 32).toLowerCase() || "resolved";
    if (!new Set(["open", "monitoring", "resolved", "referred"]).has(status)) throw new Error("customer-care-property-issue-status-invalid");
    body = Object.freeze({
      status,
      ...(clean(payload.resolved_note, 2000) ? { resolved_note: clean(payload.resolved_note, 2000) } : {}),
      ...(clean(payload.description, 4000) ? { description: clean(payload.description, 4000) } : {}),
    });
  } else if (input.action === "create_case_projection") {
    projection = createCustomerCareCase(withCompany({ ...payload, customer_id: entityId(input.customerId ?? payload.customer_id, "customer-care-customer-id-required"), job_id: input.projectId ?? payload.job_id ?? null, invoice_id: input.invoiceId ?? payload.invoice_id ?? null, location_id: input.propertyId ?? payload.location_id ?? null }, company_id));
  } else if (input.action === "intake_complaint") {
    const intake = createComplaintIntake(withCompany({ ...payload, customer_id: entityId(input.customerId ?? payload.customer_id, "customer-care-customer-id-required") }, company_id));
    projection = Object.freeze({ intake, case_projection: buildCustomerCareCaseFromComplaintIntake(intake) });
  } else if (input.action === "triage_case") {
    const caseRecord = withCompany(recordFromPayload(payload, "case_record"), company_id);
    projection = triageCustomerCareCase(caseRecord, recordFromPayload(payload, "triage"));
  } else if (input.action === "assess_escalation") {
    const caseRecord = withCompany(recordFromPayload(payload, "case_record"), company_id);
    projection = assessCustomerCareEscalation(caseRecord, (payload.proposed_remediation ?? null) as never);
  } else if (input.action === "build_grounded_response") {
    projection = buildGroundedResponseProposal(withCompany({ ...payload, customer_id: entityId(input.customerId ?? payload.customer_id, "customer-care-customer-id-required"), job_id: input.projectId ?? payload.job_id ?? null, invoice_id: input.invoiceId ?? payload.invoice_id ?? null }, company_id));
  } else if (input.action === "create_human_review") {
    const caseRecord = withCompany(recordFromPayload(payload, "case_record"), company_id);
    projection = createCustomerCareHumanReview(caseRecord, recordFromPayload(payload, "proposal"), { ...recordFromPayload(payload, "options"), proposer_worker_id: actor_id ?? undefined });
  } else if (input.action === "decide_human_review") {
    const review = withCompany(recordFromPayload(payload, "review"), company_id);
    const decision = withCompany(recordFromPayload(payload, "decision"), company_id);
    const decided = decideCustomerCareHumanReview(review, decision);
    projection = Object.freeze({ review: decided, governance_handoff: buildCustomerCareApprovalHandoff(decided) });
  } else if (input.action === "assess_review_eligibility") {
    const caseRecord = withCompany(recordFromPayload(payload, "case_record"), company_id);
    projection = Object.freeze({ internal: assessLegacyReviewEligibility(caseRecord), public: assessPublicReviewRequestEligibility(withCompany(payload, company_id), { ledger: new MemoryReviewRequestLedger() }) });
  } else if (input.action === "normalize_settings") {
    projection = normalizeCustomerCareSettings(withCompany({ settings: recordFromPayload(payload, "settings") }, company_id));
  } else if (input.action === "evaluate_settings") {
    const policy = normalizeCustomerCareSettings(withCompany({ settings: recordFromPayload(payload, "settings") }, company_id));
    projection = evaluateCustomerCareSettingsForCase(policy, withCompany(recordFromPayload(payload, "case_record"), company_id));
  } else if (input.action === "build_resolved_handoff") {
    projection = buildResolvedServiceHandoff(withCompany({ ...payload, case_record: withCompany(recordFromPayload(payload, "case_record"), company_id) }, company_id));
  } else {
    const exhaustive: never = input.action; throw new Error(`unsupported-customer-care-action:${String(exhaustive)}`);
  }

  const cleaning_profile_binding = resolveTitanNativeCleaningProfileBinding("customer_care", input.cleaningProfileId, op?.id ?? null);

  return Object.freeze({
    schema: "titan.zero.workforce-native.customer-care-plan/v1",
    agentKey: "customer_care" as const,
    company_id,
    actor_id,
    action: input.action,
    operation: op,
    cleaning_profile_binding,
    entity_id,
    property_id,
    issue_id,
    query,
    body,
    projection,
    authority: Object.freeze({
      identity_grants_authority: false,
      execution_permitted: false,
      native_route_authoritative: true,
      requires_authenticated_actor: true,
      refunds_self_authorized: false,
      credits_self_authorized: false,
      free_rework_self_authorized: false,
      legal_or_safety_commitments_self_authorized: false,
    }),
    browser_extension_required: false,
  });
}
