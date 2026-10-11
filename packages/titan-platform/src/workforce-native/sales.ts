import { evaluateSalesQualificationReadiness } from "../ported/titan-workforce/starter-agents/sales/runtime/sales-qualification-readiness.js";
import { scoreSalesLeadPriority } from "../ported/titan-workforce/starter-agents/sales/runtime/sales-explainable-priority.js";
import { selectSalesNextBestAction } from "../ported/titan-workforce/starter-agents/sales/runtime/sales-next-best-action.js";
import { planSalesFollowUp } from "../ported/titan-workforce/starter-agents/sales/runtime/sales-follow-up-policy.js";
import { handleSalesObjection } from "../ported/titan-workforce/starter-agents/sales/runtime/sales-objection-handler.js";
import { createSalesStructuredHandoff } from "../ported/titan-workforce/starter-agents/sales/runtime/sales-structured-handoff.js";
import {
  assertTitanNativeWorkforceBoundary,
  getTitanNativeWorkforceAgentMap,
  resolveTitanNativeCleaningProfileBinding,
  type TitanNativeCleaningProfileBinding,
  type TitanNativeWorkforceOperation,
} from "./contracts.js";

export type TitanSalesAction =
  | "list_leads"
  | "qualify_lead"
  | "next_best_action"
  | "progress_lead"
  | "prepare_quote_handoff"
  | "create_quote"
  | "plan_follow_up"
  | "handle_objection"
  | "escalate";

export type TitanSalesPlanInput = Readonly<{
  companyId: string;
  actorId: string;
  action: TitanSalesAction;
  requestId?: string;
  status?: string;
  limit?: number;
  payload?: Record<string, unknown>;
  qualification?: Record<string, unknown>;
  handoff?: Record<string, unknown>;
  traceId?: string;
  cleaningProfileId?: string;
}>;

export type TitanSalesExecutionPlan = Readonly<{
  schema: "titan.zero.workforce-native.sales-plan/v1";
  agentKey: "sales";
  company_id: string;
  actor_id: string;
  action: TitanSalesAction;
  operation: TitanNativeWorkforceOperation | null;
  cleaning_profile_binding: TitanNativeCleaningProfileBinding | null;
  entity_id: string | null;
  query: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>> | null;
  qualification: unknown | null;
  priority: unknown | null;
  recommendation: unknown | null;
  handoff: unknown | null;
  follow_up: unknown | null;
  objection: unknown | null;
  escalation: Readonly<{ required: boolean; reason: string | null; human_review: boolean }>;
  authority: Readonly<{
    identity_grants_authority: false;
    execution_permitted: false;
    native_route_authoritative: true;
    requires_authenticated_actor: true;
    pricing_authority_assumed: false;
    availability_authority_assumed: false;
  }>;
  browser_extension_required: false;
}>;

const LEGACY_COMPANY_KEYS = new Set([
  "tenant_id",
  "tenant_company_id",
  "tenant_company",
  "tenant",
  "tenantCompanyId",
  "organisation_id",
  "organization_id",
  "workspace_tenant_id",
]);

function clean(value: unknown, max = 5000): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function rejectLegacyCompanyBoundary(value: unknown, path = "input"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectLegacyCompanyBoundary(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (LEGACY_COMPANY_KEYS.has(key)) throw new Error(`legacy-company-boundary:${path}.${key}`);
    rejectLegacyCompanyBoundary(nested, `${path}.${key}`);
  }
}

function salesOperation(id: string): TitanNativeWorkforceOperation {
  const sales = getTitanNativeWorkforceAgentMap("sales");
  const operation = sales?.operations.find((candidate) => candidate.id === id);
  if (!operation) throw new Error(`sales-operation-unavailable:${id}`);
  return operation;
}

function normalizeEntityId(value: unknown): string {
  const id = clean(value, 128);
  if (!id || !/^[0-9A-Za-z_-]{1,128}$/.test(id)) throw new Error("sales-request-id-required");
  return id;
}

function payload(value: Record<string, unknown> | undefined): Readonly<Record<string, unknown>> {
  rejectLegacyCompanyBoundary(value);
  return Object.freeze({ ...(value ?? {}) });
}

function salesProjectionInput(company_id: string, source: Record<string, unknown> | undefined): Record<string, unknown> {
  const safe = payload(source);
  return { ...safe, company_id };
}

export function buildTitanSalesPlan(input: TitanSalesPlanInput): TitanSalesExecutionPlan {
  rejectLegacyCompanyBoundary(input);
  const company_id = assertTitanNativeWorkforceBoundary(input.companyId);
  const actor_id = clean(input.actorId, 180);
  if (!actor_id) throw new Error("actor_id-required");

  let operation: TitanNativeWorkforceOperation | null = null;
  let entity_id: string | null = null;
  let query: Readonly<Record<string, string>> = Object.freeze({});
  let body: Readonly<Record<string, unknown>> | null = null;
  let qualification: unknown | null = null;
  let priority: unknown | null = null;
  let recommendation: unknown | null = null;
  let handoff: unknown | null = null;
  let follow_up: unknown | null = null;
  let objection: unknown | null = null;
  let escalationRequired = false;
  let escalationReason: string | null = null;

  if (input.action === "list_leads") {
    operation = salesOperation("booking_requests.list");
    const q: Record<string, string> = {};
    if (clean(input.status, 64)) q.status = clean(input.status, 64);
    if (Number.isInteger(input.limit) && Number(input.limit) > 0) q.limit = String(Math.min(Number(input.limit), 200));
    query = Object.freeze(q);
  } else if (input.action === "qualify_lead" || input.action === "next_best_action") {
    const projectionInput = salesProjectionInput(company_id, input.qualification ?? input.payload);
    qualification = evaluateSalesQualificationReadiness(projectionInput);
    priority = scoreSalesLeadPriority({ ...projectionInput, readiness_projection: qualification });
    if (input.action === "next_best_action") {
      recommendation = selectSalesNextBestAction({ ...projectionInput, readiness_projection: qualification, priority_projection: priority });
    }
  } else if (input.action === "progress_lead") {
    operation = salesOperation("booking_requests.update");
    entity_id = normalizeEntityId(input.requestId);
    body = payload(input.payload);
    const allowed = new Set(["status", "review_notes", "pricing_mode", "routing_path", "closed_reason"]);
    for (const key of Object.keys(body)) if (!allowed.has(key)) throw new Error(`sales-progress-field-not-allowed:${key}`);
    if (!Object.keys(body).length) throw new Error("sales-progress-body-required");
  } else if (input.action === "prepare_quote_handoff") {
    const handoffInput = salesProjectionInput(company_id, input.handoff ?? input.payload);
    handoff = createSalesStructuredHandoff({ ...handoffInput, target: "quote" });
  } else if (input.action === "create_quote") {
    operation = salesOperation("estimates.create");
    body = payload(input.payload);
    if (!clean(body.client_id, 128)) throw new Error("sales-quote-client-id-required");
  } else if (input.action === "plan_follow_up") {
    const source = salesProjectionInput(company_id, input.payload);
    const nextBest = (source.next_best_action as Record<string, unknown> | undefined)
      ?? selectSalesNextBestAction(source);
    follow_up = planSalesFollowUp({ ...source, next_best_action: nextBest });
  } else if (input.action === "handle_objection") {
    objection = handleSalesObjection(salesProjectionInput(company_id, input.payload));
    const objectionRecord = objection as Record<string, unknown>;
    escalationRequired = Array.isArray(objectionRecord.blockers) && objectionRecord.blockers.length > 0;
    escalationReason = escalationRequired ? "sales-objection-requires-human-review" : null;
  } else if (input.action === "escalate") {
    operation = salesOperation("booking_requests.update");
    entity_id = normalizeEntityId(input.requestId);
    const source = payload(input.payload);
    const reason = clean(source.reason ?? source.review_notes, 2000);
    if (!reason) throw new Error("sales-escalation-reason-required");
    body = Object.freeze({ status: "reviewed", routing_path: "pending", review_notes: reason });
    escalationRequired = true;
    escalationReason = reason;
  } else {
    const exhaustive: never = input.action;
    throw new Error(`unsupported-sales-action:${String(exhaustive)}`);
  }

  const cleaning_profile_binding = resolveTitanNativeCleaningProfileBinding("sales", input.cleaningProfileId, operation?.id ?? null);

  return Object.freeze({
    schema: "titan.zero.workforce-native.sales-plan/v1",
    agentKey: "sales",
    company_id,
    actor_id,
    action: input.action,
    operation,
    cleaning_profile_binding,
    entity_id,
    query,
    body,
    qualification,
    priority,
    recommendation,
    handoff,
    follow_up,
    objection,
    escalation: Object.freeze({ required: escalationRequired, reason: escalationReason, human_review: escalationRequired }),
    authority: Object.freeze({
      identity_grants_authority: false,
      execution_permitted: false,
      native_route_authoritative: true,
      requires_authenticated_actor: true,
      pricing_authority_assumed: false,
      availability_authority_assumed: false,
    }),
    browser_extension_required: false,
  });
}
