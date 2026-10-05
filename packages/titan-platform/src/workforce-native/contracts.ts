export type TitanNativeWorkforceAgentKey =
  | "reception"
  | "sales"
  | "booking"
  | "scheduling"
  | "jobs"
  | "customer_care";

export type TitanNativeWorkforceOperation = Readonly<{
  id: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  purpose: string;
  mutating: boolean;
}>;

export type TitanNativeCleaningProfileBinding = Readonly<{
  moduleId: "titan.workforce.cleaning";
  profileId: string;
  agentKey: TitanNativeWorkforceAgentKey;
  responsibility: string;
  allowedOperationIds: readonly string[];
  autonomy: "suggest";
  authorityGranted: false;
  executionPermitted: false;
}>;

export type TitanNativeWorkforceAgentMap = Readonly<{
  agentKey: TitanNativeWorkforceAgentKey;
  displayName: string;
  companyBoundary: "company_id";
  identityGrantsAuthority: false;
  canonicalBusinessTruth: "business_ops";
  donorModules: readonly string[];
  operations: readonly TitanNativeWorkforceOperation[];
  cleaningProfileBinding: TitanNativeCleaningProfileBinding;
  handoffTargets: readonly TitanNativeWorkforceAgentKey[];
}>;

const keys = (...values: TitanNativeWorkforceAgentKey[]): readonly TitanNativeWorkforceAgentKey[] => Object.freeze(values);

const op = (
  id: string,
  method: TitanNativeWorkforceOperation["method"],
  path: string,
  purpose: string,
  mutating: boolean,
): TitanNativeWorkforceOperation => Object.freeze({ id, method, path, purpose, mutating });

const cleaningBinding = (
  agentKey: TitanNativeWorkforceAgentKey,
  profileId: string,
  responsibility: string,
  allowedOperationIds: readonly string[],
): TitanNativeCleaningProfileBinding => Object.freeze({
  moduleId: "titan.workforce.cleaning",
  profileId,
  agentKey,
  responsibility,
  allowedOperationIds: Object.freeze([...allowedOperationIds]),
  autonomy: "suggest",
  authorityGranted: false,
  executionPermitted: false,
});

export const TITAN_NATIVE_WORKFORCE_AGENT_MAP: Readonly<Record<TitanNativeWorkforceAgentKey, TitanNativeWorkforceAgentMap>> = Object.freeze({
  reception: Object.freeze({
    agentKey: "reception",
    displayName: "Reception Agent",
    companyBoundary: "company_id",
    identityGrantsAuthority: false,
    canonicalBusinessTruth: "business_ops",
    donorModules: Object.freeze([
      "ported/titan-agent/starter-workforce/reception/runtime/reception-handoffs.ts",
    ]),
    operations: Object.freeze([
      op("clients.list", "GET", "/api/v1/clients", "Find an existing customer before creating or routing work", false),
      op("clients.create", "POST", "/api/v1/clients", "Create a customer through the existing Business Ops client lifecycle", true),
      op("booking_requests.list", "GET", "/api/v1/booking-requests", "Inspect inbound service requests", false),
      op("booking_requests.create", "POST", "/api/v1/booking-requests", "Capture a new service request without creating a parallel lead store", true),
    ]),
    cleaningProfileBinding: cleaningBinding("reception", "titan.cleaning.scope_assessor", "Capture cleaning scope and intake facts", ["clients.list", "booking_requests.list", "booking_requests.create"]),
    handoffTargets: keys("sales", "booking", "customer_care"),
  }),
  sales: Object.freeze({
    agentKey: "sales",
    displayName: "Sales Agent",
    companyBoundary: "company_id",
    identityGrantsAuthority: false,
    canonicalBusinessTruth: "business_ops",
    donorModules: Object.freeze([
      "ported/titan-workforce/starter-agents/sales/runtime/sales-agent-contract.ts",
      "ported/titan-workforce/starter-agents/sales/runtime/sales-lead-response-adapter.ts",
      "ported/titan-workforce/starter-agents/sales/runtime/sales-qualification-readiness.ts",
      "ported/titan-workforce/starter-agents/sales/runtime/sales-explainable-priority.ts",
      "ported/titan-workforce/starter-agents/sales/runtime/sales-next-best-action.ts",
      "ported/titan-workforce/starter-agents/sales/runtime/sales-follow-up-policy.ts",
      "ported/titan-workforce/starter-agents/sales/runtime/sales-objection-handler.ts",
      "ported/titan-workforce/starter-agents/sales/runtime/sales-structured-handoff.ts",
    ]),
    operations: Object.freeze([
      op("clients.list", "GET", "/api/v1/clients", "Resolve customer context", false),
      op("booking_requests.list", "GET", "/api/v1/booking-requests", "Use the existing request funnel as sales intake truth", false),
      op("booking_requests.update", "PATCH", "/api/v1/booking-requests/:id", "Progress qualification metadata through the existing request record", true),
      op("estimates.list", "GET", "/api/v1/estimates", "Inspect quote state before recommending a quote handoff", false),
      op("estimates.create", "POST", "/api/v1/estimates", "Create an estimate only through the canonical estimate API", true),
    ]),
    cleaningProfileBinding: cleaningBinding("sales", "titan.cleaning.quote_specialist", "Prepare a scoped cleaning estimate from supplied company pricing", ["booking_requests.list", "booking_requests.update", "estimates.list", "estimates.create"]),
    handoffTargets: keys("reception", "booking", "customer_care"),
  }),
  booking: Object.freeze({
    agentKey: "booking",
    displayName: "Booking Agent",
    companyBoundary: "company_id",
    identityGrantsAuthority: false,
    canonicalBusinessTruth: "business_ops",
    donorModules: Object.freeze([
      "ported/titan-workforce/starter-agents/booking/index.ts",
      "ported/titan-workforce/starter-agents/booking/booking-orchestrator.ts",
      "ported/titan-workforce/starter-agents/booking/availability-service.ts",
      "ported/titan-workforce/starter-agents/booking/calendar-reconciliation.ts",
    ]),
    operations: Object.freeze([
      op("booking_requests.list", "GET", "/api/v1/booking-requests", "Load booking candidates from canonical request records", false),
      op("booking_requests.get", "GET", "/api/v1/booking-requests/:id", "Load one booking request", false),
      op("booking_requests.update", "PATCH", "/api/v1/booking-requests/:id", "Persist validated booking state", true),
      op("booking_requests.convert", "POST", "/api/v1/booking-requests/:id/convert", "Convert through the existing booking conversion workflow", true),
      op("properties.list", "GET", "/api/v1/properties", "Resolve service location context", false),
    ]),
    cleaningProfileBinding: cleaningBinding("booking", "titan.cleaning.keys_access", "Prepare cleaning bookings with property and access context", ["booking_requests.list", "booking_requests.get", "booking_requests.update", "booking_requests.convert", "properties.list"]),
    handoffTargets: keys("scheduling", "jobs", "customer_care"),
  }),
  scheduling: Object.freeze({
    agentKey: "scheduling",
    displayName: "Scheduling Agent",
    companyBoundary: "company_id",
    identityGrantsAuthority: false,
    canonicalBusinessTruth: "business_ops",
    donorModules: Object.freeze([
      "ported/titan-workforce/starter-agents/scheduling/scheduling-agent.ts",
    ]),
    operations: Object.freeze([
      op("projects.list", "GET", "/api/v1/jobs", "Load schedulable project demand", false),
      op("project_visits.list", "GET", "/api/v1/jobs/:id/visits", "Inspect current visit schedule", false),
      op("project_visits.bulk", "POST", "/api/v1/jobs/:id/visits/bulk", "Create or revise visit plans through the canonical job visit surface", true),
      op("visits.update", "PATCH", "/api/v1/visits/:id", "Reschedule or reassign an existing visit through canonical conflict guards", true),
      op("work_orders.list", "GET", "/api/v1/work-orders", "Resolve assignment/work packet context", false),
      op("users.list", "GET", "/api/v1/users", "Load company-scoped workers for assignment recommendations", false),
    ]),
    cleaningProfileBinding: cleaningBinding("scheduling", "titan.cleaning.crew_planner", "Recommend cleaning crew and one-off visit plans", ["projects.list", "project_visits.list", "project_visits.bulk", "visits.update", "work_orders.list", "users.list"]),
    handoffTargets: keys("jobs", "customer_care"),
  }),
  jobs: Object.freeze({
    agentKey: "jobs",
    displayName: "Jobs Agent",
    companyBoundary: "company_id",
    identityGrantsAuthority: false,
    canonicalBusinessTruth: "business_ops",
    donorModules: Object.freeze([
      "ported/titan-workforce/starter-agents/jobs/jobs-agent-runtime.ts",
      "ported/titan-workforce/starter-agents/jobs/jobs-lifecycle-contract.ts",
      "ported/titan-workforce/starter-agents/jobs/jobs-offline-sync.ts",
      "ported/titan-workforce/starter-agents/jobs/jobs-completion-readiness.ts",
    ]),
    operations: Object.freeze([
      op("projects.list", "GET", "/api/v1/jobs", "Load projects", false),
      op("projects.get", "GET", "/api/v1/jobs/:id", "Load project truth", false),
      op("projects.transition", "POST", "/api/v1/jobs/:id/transition", "Transition project lifecycle through Business Ops guards", true),
      op("work_orders.list", "GET", "/api/v1/work-orders", "Load operational work packets", false),
      op("work_orders.complete", "POST", "/api/v1/work-orders/:id/complete", "Complete work through canonical completion guards", true),
      op("work_orders.start_visit", "POST", "/api/v1/work-orders/:id/start-visit", "Start field execution through the existing work-order flow", true),
      op("visits.get", "GET", "/api/v1/visits/:id", "Load execution state", false),
      op("visits.transition", "POST", "/api/v1/visits/:id/transition", "Transition visit state through canonical guards", true),
    ]),
    cleaningProfileBinding: cleaningBinding("jobs", "titan.cleaning.quality_inspector", "Review cleaning completion readiness and exceptions", ["projects.list", "projects.get", "projects.transition", "work_orders.list", "work_orders.complete", "work_orders.start_visit", "visits.get", "visits.transition"]),
    handoffTargets: keys("customer_care", "scheduling"),
  }),
  customer_care: Object.freeze({
    agentKey: "customer_care",
    displayName: "Customer Care Agent",
    companyBoundary: "company_id",
    identityGrantsAuthority: false,
    canonicalBusinessTruth: "business_ops",
    donorModules: Object.freeze([
      "ported/titan-workforce/customer-care/customer-care-contract.ts",
      "ported/titan-workforce/customer-care/resolved-service-handoff.ts",
    ]),
    operations: Object.freeze([
      op("clients.list", "GET", "/api/v1/clients", "Resolve customer context", false),
      op("clients.get", "GET", "/api/v1/clients/:id", "Load customer truth before follow-up", false),
      op("projects.get", "GET", "/api/v1/jobs/:id", "Load related service history", false),
      op("invoices.get", "GET", "/api/v1/invoices/:id", "Load billing context without self-authorizing credits or refunds", false),
      op("property_issues.list", "GET", "/api/v1/properties/:id/issues", "Read canonical service/property issues for customer recovery context", false),
      op("property_issues.create", "POST", "/api/v1/properties/:id/issues", "Record a service issue through the existing property issue lifecycle", true),
      op("property_issues.update", "PATCH", "/api/v1/properties/:id/issues/:issueId", "Resolve, monitor or refer an existing service issue through canonical guards", true),
    ]),
    cleaningProfileBinding: cleaningBinding("customer_care", "titan.cleaning.service_recovery", "Prepare cleaning service recovery from customer and property issue history", ["clients.list", "clients.get", "projects.get", "invoices.get", "property_issues.list", "property_issues.create", "property_issues.update"]),
    handoffTargets: keys("jobs", "sales"),
  }),
});

export function getTitanNativeWorkforceAgentMap(agentKey: string): TitanNativeWorkforceAgentMap | null {
  return TITAN_NATIVE_WORKFORCE_AGENT_MAP[agentKey as TitanNativeWorkforceAgentKey] ?? null;
}

export function listTitanNativeWorkforceAgentMaps(): readonly TitanNativeWorkforceAgentMap[] {
  return Object.values(TITAN_NATIVE_WORKFORCE_AGENT_MAP);
}

export function getTitanNativeCleaningProfileBinding(profileId: string): TitanNativeCleaningProfileBinding | null {
  const normalized = String(profileId ?? "").trim();
  if (!normalized) return null;
  return listTitanNativeWorkforceAgentMaps().find((entry) => entry.cleaningProfileBinding.profileId === normalized)?.cleaningProfileBinding ?? null;
}

export function resolveTitanNativeCleaningProfileBinding(
  agentKey: TitanNativeWorkforceAgentKey,
  profileId: string | undefined,
  operationId: string | null,
): TitanNativeCleaningProfileBinding | null {
  const normalized = String(profileId ?? "").trim();
  if (!normalized) return null;
  const binding = getTitanNativeCleaningProfileBinding(normalized);
  if (!binding) throw new Error(`cleaning-profile-unavailable:${normalized}`);
  if (binding.agentKey !== agentKey) throw new Error(`cleaning-profile-agent-mismatch:${normalized}`);
  if (operationId && !binding.allowedOperationIds.includes(operationId)) {
    throw new Error(`cleaning-profile-operation-unavailable:${normalized}:${operationId}`);
  }
  return binding;
}

export function projectTitanNativeCleaningProfile(profileId: string): Readonly<{
  profile_id: string;
  binding_status: "bound_suggest_only" | "unavailable";
  agent_key: TitanNativeWorkforceAgentKey | null;
  responsibility: string | null;
  allowed_operation_ids: readonly string[];
  autonomy: "suggest";
  authority_granted: false;
  execution_permitted: false;
  team_eligibility: "unavailable";
}> {
  const normalized = String(profileId ?? "").trim();
  if (!normalized) throw new Error("cleaning-profile-id-required");
  const binding = getTitanNativeCleaningProfileBinding(normalized);
  return Object.freeze({
    profile_id: normalized,
    binding_status: binding ? "bound_suggest_only" : "unavailable",
    agent_key: binding?.agentKey ?? null,
    responsibility: binding?.responsibility ?? null,
    allowed_operation_ids: binding?.allowedOperationIds ?? Object.freeze([]),
    autonomy: "suggest",
    authority_granted: false,
    execution_permitted: false,
    team_eligibility: "unavailable",
  });
}

export function assertTitanNativeWorkforceBoundary(companyId: string): string {
  const normalized = String(companyId ?? "").trim();
  if (!normalized) throw new Error("company_id-required");
  return normalized;
}
