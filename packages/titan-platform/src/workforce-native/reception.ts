import {
  applyReceptionHandoffEvent,
  buildReceptionHandoffDispatchCommand,
  buildReceptionWorkerHandoffPacket,
  createReceptionPendingHandoff,
  recoverReceptionHandoff,
} from "../ported/titan-agent/starter-workforce/reception/runtime/reception-handoffs.js";
import {
  assertTitanNativeWorkforceBoundary,
  getTitanNativeWorkforceAgentMap,
  resolveTitanNativeCleaningProfileBinding,
  type TitanNativeCleaningProfileBinding,
  type TitanNativeWorkforceOperation,
} from "./contracts.js";

export type TitanReceptionAction =
  | "search_customer"
  | "capture_customer"
  | "list_service_requests"
  | "capture_service_request"
  | "handoff";

export type TitanReceptionHandoffTarget = "sales" | "booking" | "customer_care";

export type TitanReceptionPlanInput = Readonly<{
  companyId: string;
  actorId: string;
  action: TitanReceptionAction;
  interactionId?: string;
  query?: string;
  target?: TitanReceptionHandoffTarget;
  payload?: Record<string, unknown>;
  traceId?: string;
  correlationId?: string;
  causationId?: string;
  cleaningProfileId?: string;
}>;

export type TitanReceptionExecutionPlan = Readonly<{
  schema: "titan.zero.workforce-native.reception-plan/v1";
  agentKey: "reception";
  company_id: string;
  actor_id: string;
  action: TitanReceptionAction;
  operation: TitanNativeWorkforceOperation | null;
  cleaning_profile_binding: TitanNativeCleaningProfileBinding | null;
  query: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>> | null;
  handoff: unknown | null;
  pendingHandoff: unknown | null;
  authority: Readonly<{
    identity_grants_authority: false;
    execution_permitted: false;
    native_route_authoritative: true;
    requires_authenticated_actor: true;
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

function receptionOperation(id: string): TitanNativeWorkforceOperation {
  const reception = getTitanNativeWorkforceAgentMap("reception");
  const operation = reception?.operations.find((candidate) => candidate.id === id);
  if (!operation) throw new Error(`reception-operation-unavailable:${id}`);
  return operation;
}

function normalizedPayload(payload: Record<string, unknown> | undefined): Readonly<Record<string, unknown>> {
  rejectLegacyCompanyBoundary(payload);
  return Object.freeze({ ...(payload ?? {}) });
}

export function buildTitanReceptionPlan(input: TitanReceptionPlanInput): TitanReceptionExecutionPlan {
  rejectLegacyCompanyBoundary(input);
  const company_id = assertTitanNativeWorkforceBoundary(input.companyId);
  const actor_id = clean(input.actorId, 180);
  if (!actor_id) throw new Error("actor_id-required");

  let operation: TitanNativeWorkforceOperation | null = null;
  let query: Readonly<Record<string, string>> = Object.freeze({});
  let body: Readonly<Record<string, unknown>> | null = null;
  let handoff: unknown | null = null;
  let pendingHandoff: unknown | null = null;

  if (input.action === "search_customer") {
    operation = receptionOperation("clients.list");
    const q = clean(input.query, 255);
    query = q ? Object.freeze({ q }) : Object.freeze({} as Record<string, string>);
  } else if (input.action === "capture_customer") {
    operation = receptionOperation("clients.create");
    body = normalizedPayload(input.payload);
    if (!clean(body.name, 255)) throw new Error("reception-customer-name-required");
  } else if (input.action === "list_service_requests") {
    operation = receptionOperation("booking_requests.list");
  } else if (input.action === "capture_service_request") {
    operation = receptionOperation("booking_requests.create");
    body = normalizedPayload(input.payload);
    if (!clean(body.name, 200)) throw new Error("reception-request-name-required");
    if (!clean(body.phone, 50) && !clean(body.email, 320)) throw new Error("reception-request-contact-required");
  } else if (input.action === "handoff") {
    const interaction_id = clean(input.interactionId, 180);
    if (!interaction_id) throw new Error("interaction_id-required");
    if (!input.target) throw new Error("reception-handoff-target-required");
    handoff = buildReceptionWorkerHandoffPacket({
      company_id,
      target_worker: input.target,
      interaction_id,
      qualification: normalizedPayload(input.payload),
      trace_id: clean(input.traceId, 180) || undefined,
      correlation_id: clean(input.correlationId, 180) || undefined,
      causation_id: clean(input.causationId, 180) || undefined,
    });
    pendingHandoff = createReceptionPendingHandoff(handoff);
  } else {
    const exhaustive: never = input.action;
    throw new Error(`unsupported-reception-action:${String(exhaustive)}`);
  }

  const cleaning_profile_binding = resolveTitanNativeCleaningProfileBinding("reception", input.cleaningProfileId, operation?.id ?? null);

  return Object.freeze({
    schema: "titan.zero.workforce-native.reception-plan/v1",
    agentKey: "reception",
    company_id,
    actor_id,
    action: input.action,
    operation,
    cleaning_profile_binding,
    query,
    body,
    handoff,
    pendingHandoff,
    authority: Object.freeze({
      identity_grants_authority: false,
      execution_permitted: false,
      native_route_authoritative: true,
      requires_authenticated_actor: true,
    }),
    browser_extension_required: false,
  });
}

export function applyTitanReceptionHandoffEvent(state: unknown, event: Record<string, unknown>): unknown {
  rejectLegacyCompanyBoundary(event);
  return applyReceptionHandoffEvent(state, event);
}

export function recoverTitanReceptionHandoff(state: unknown): unknown {
  const recovery = recoverReceptionHandoff(state as Record<string, unknown>) as Record<string, unknown>;
  return Object.freeze({ ...recovery, execution_permitted: false });
}

export function buildTitanReceptionHandoffDispatchCommand(state: unknown): unknown {
  const command = buildReceptionHandoffDispatchCommand(state as Record<string, unknown>) as Record<string, unknown>;
  return Object.freeze({
    ...command,
    idempotency_key: command.dedupe_key,
    execution_permitted: false,
    authority_granted: false,
    grants_authority: false,
  });
}
