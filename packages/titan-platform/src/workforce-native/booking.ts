import {
  bookingSourceToIntent,
  buildBookingExecutionPlan,
  createBookingIntent,
  buildJobsHandoff,
  buildSchedulingHandoff,
  lookupAvailability,
  normalizeBookingSource,
  normalizeCalendarEvent,
  reconcileCalendarEvent,
  transitionBooking,
} from "../ported/titan-workforce/starter-agents/booking/index.js";
import {
  assertTitanNativeWorkforceBoundary,
  getTitanNativeWorkforceAgentMap,
  resolveTitanNativeCleaningProfileBinding,
  type TitanNativeCleaningProfileBinding,
  type TitanNativeWorkforceOperation,
} from "./contracts.js";

export type TitanBookingAction =
  | "list_requests"
  | "get_request"
  | "list_properties"
  | "prepare_booking"
  | "check_availability"
  | "prepare_confirmation"
  | "confirm_request"
  | "reconcile_calendar"
  | "handoff_scheduling"
  | "handoff_jobs";

export type TitanBookingPlanInput = Readonly<{
  companyId: string;
  actorId: string;
  action: TitanBookingAction;
  requestId?: string;
  clientId?: string;
  query?: string;
  status?: string;
  limit?: number;
  payload?: Record<string, unknown>;
  source?: Record<string, unknown>;
  intent?: Record<string, unknown>;
  calendarEvent?: Record<string, unknown>;
  handoff?: Record<string, unknown>;
  traceId?: string;
  cleaningProfileId?: string;
}>;

export type TitanBookingExecutionPlan = Readonly<{
  schema: "titan.zero.workforce-native.booking-plan/v1";
  agentKey: "booking";
  company_id: string;
  actor_id: string;
  action: TitanBookingAction;
  operation: TitanNativeWorkforceOperation | null;
  cleaning_profile_binding: TitanNativeCleaningProfileBinding | null;
  entity_id: string | null;
  query: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>> | null;
  booking_source: unknown | null;
  booking_intent: unknown | null;
  availability_request: Readonly<Record<string, unknown>> | null;
  confirmation_plan: unknown | null;
  reconciliation: unknown | null;
  handoff: unknown | null;
  authority: Readonly<{
    identity_grants_authority: false;
    execution_permitted: false;
    native_route_authoritative: true;
    requires_authenticated_actor: true;
    pricing_authority_assumed: false;
    availability_authority_assumed: false;
    scheduling_authority_assumed: false;
  }>;
  browser_extension_required: false;
}>;

const LEGACY_COMPANY_KEYS = new Set([
  "tenant_id", "tenant_company_id", "tenant_company", "tenant", "tenantCompanyId",
  "organisation_id", "organization_id", "workspace_tenant_id",
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

function bookingOperation(id: string): TitanNativeWorkforceOperation {
  const booking = getTitanNativeWorkforceAgentMap("booking");
  const operation = booking?.operations.find((candidate) => candidate.id === id);
  if (!operation) throw new Error(`booking-operation-unavailable:${id}`);
  return operation;
}

function normalizeEntityId(value: unknown): string {
  const id = clean(value, 128);
  if (!id || !/^[0-9A-Za-z_-]{1,128}$/.test(id)) throw new Error("booking-request-id-required");
  return id;
}

function freezePayload(value: Record<string, unknown> | undefined): Readonly<Record<string, unknown>> {
  rejectLegacyCompanyBoundary(value);
  return Object.freeze({ ...(value ?? {}) });
}

function requireField(source: Readonly<Record<string, unknown>>, key: string, message: string): string {
  const value = clean(source[key], 256);
  if (!value) throw new Error(message);
  return value;
}

function stableId(prefix: string, companyId: string, requestId: string, traceId: string | undefined): string {
  return `${prefix}:${companyId}:${requestId}:${clean(traceId, 128) || "direct"}`;
}

export function buildTitanBookingPlan(input: TitanBookingPlanInput): TitanBookingExecutionPlan {
  rejectLegacyCompanyBoundary(input);
  const company_id = assertTitanNativeWorkforceBoundary(input.companyId);
  const actor_id = clean(input.actorId, 180);
  if (!actor_id) throw new Error("actor_id-required");

  let operation: TitanNativeWorkforceOperation | null = null;
  let entity_id: string | null = null;
  let query: Readonly<Record<string, string>> = Object.freeze({});
  let body: Readonly<Record<string, unknown>> | null = null;
  let booking_source: unknown | null = null;
  let booking_intent: unknown | null = null;
  let availability_request: Readonly<Record<string, unknown>> | null = null;
  let confirmation_plan: unknown | null = null;
  let reconciliation: unknown | null = null;
  let handoff: unknown | null = null;

  if (input.action === "list_requests") {
    operation = bookingOperation("booking_requests.list");
    const q: Record<string, string> = {};
    if (clean(input.status, 64)) q.status = clean(input.status, 64);
    if (clean(input.query, 500)) q.q = clean(input.query, 500);
    if (Number.isInteger(input.limit) && Number(input.limit) > 0) q.limit = String(Math.min(Number(input.limit), 200));
    query = Object.freeze(q);
  } else if (input.action === "get_request") {
    operation = bookingOperation("booking_requests.get");
    entity_id = normalizeEntityId(input.requestId);
  } else if (input.action === "list_properties") {
    operation = bookingOperation("properties.list");
    const q: Record<string, string> = {};
    if (clean(input.clientId, 128)) q.client_id = clean(input.clientId, 128);
    if (clean(input.query, 500)) q.q = clean(input.query, 500);
    if (Number.isInteger(input.limit) && Number(input.limit) > 0) q.limit = String(Math.min(Number(input.limit), 200));
    query = Object.freeze(q);
  } else if (input.action === "prepare_booking") {
    const sourceInput = freezePayload(input.source ?? input.payload);
    booking_source = normalizeBookingSource({ ...sourceInput, company_id });
    const requestId = normalizeEntityId(input.requestId ?? sourceInput.request_id ?? sourceInput.intent_id);
    const donorIntent = bookingSourceToIntent(booking_source, {
      idempotency_key: clean(sourceInput.idempotency_key, 256) || stableId("booking", company_id, requestId, input.traceId),
      intent_id: clean(sourceInput.intent_id, 128) || requestId,
      worker_id: "booking-agent",
      requested_window: sourceInput.requested_window ?? null,
    });
    booking_intent = createBookingIntent(donorIntent);
    booking_intent = transitionBooking(booking_intent, "qualified", { company_id });
  } else if (input.action === "check_availability") {
    const source = freezePayload(input.payload);
    availability_request = Object.freeze({
      company_id,
      provider: requireField(source, "provider", "booking-provider-required"),
      service_id: requireField(source, "service_id", "booking-service-id-required"),
      site_id: requireField(source, "site_id", "booking-site-id-required"),
      correlation_id: clean(source.correlation_id, 180) || clean(input.traceId, 180) || `booking:${company_id}`,
      window: source.window ?? null,
      timezone: source.timezone ?? null,
    });
  } else if (input.action === "prepare_confirmation") {
    const source = freezePayload(input.payload);
    const requestId = normalizeEntityId(input.requestId ?? source.intent_id);
    confirmation_plan = buildBookingExecutionPlan({
      company_id,
      intent_id: clean(source.intent_id, 128) || requestId,
      correlation_id: clean(source.correlation_id, 180) || clean(input.traceId, 180) || stableId("corr", company_id, requestId, input.traceId),
      idempotency_key: clean(source.idempotency_key, 256) || stableId("confirm", company_id, requestId, input.traceId),
      worker_id: "booking-agent",
      identity_authorized: false,
    });
  } else if (input.action === "confirm_request") {
    operation = bookingOperation("booking_requests.convert");
    entity_id = normalizeEntityId(input.requestId);
    body = freezePayload(input.payload);
    const allowed = new Set(["preferred_date", "preferred_time_slot", "assigned_user_id", "review_notes"]);
    for (const key of Object.keys(body)) if (!allowed.has(key)) throw new Error(`booking-confirm-field-not-allowed:${key}`);
    if (!clean(body.preferred_date, 32)) throw new Error("booking-preferred-date-required");
  } else if (input.action === "reconcile_calendar") {
    const event = freezePayload(input.calendarEvent ?? input.payload);
    reconciliation = normalizeCalendarEvent({ ...event, company_id });
  } else if (input.action === "handoff_scheduling" || input.action === "handoff_jobs") {
    const source = freezePayload(input.handoff ?? input.payload);
    const base = { ...source, company_id };
    handoff = input.action === "handoff_scheduling" ? buildSchedulingHandoff(base) : buildJobsHandoff(base);
  } else {
    const exhaustive: never = input.action;
    throw new Error(`unsupported-booking-action:${String(exhaustive)}`);
  }

  const cleaning_profile_binding = resolveTitanNativeCleaningProfileBinding("booking", input.cleaningProfileId, operation?.id ?? null);

  return Object.freeze({
    schema: "titan.zero.workforce-native.booking-plan/v1",
    agentKey: "booking",
    company_id,
    actor_id,
    action: input.action,
    operation,
    cleaning_profile_binding,
    entity_id,
    query,
    body,
    booking_source,
    booking_intent,
    availability_request,
    confirmation_plan,
    reconciliation,
    handoff,
    authority: Object.freeze({
      identity_grants_authority: false,
      execution_permitted: false,
      native_route_authoritative: true,
      requires_authenticated_actor: true,
      pricing_authority_assumed: false,
      availability_authority_assumed: false,
      scheduling_authority_assumed: false,
    }),
    browser_extension_required: false,
  });
}

export async function lookupTitanBookingAvailability(
  request: Readonly<Record<string, unknown>>,
  ports: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  rejectLegacyCompanyBoundary(request);
  const company_id = assertTitanNativeWorkforceBoundary(String(request.company_id ?? ""));
  return lookupAvailability({ ...request, company_id }, ports);
}

export async function reconcileTitanBookingCalendarEvent(
  event: Readonly<Record<string, unknown>>,
  ports: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  rejectLegacyCompanyBoundary(event);
  const company_id = assertTitanNativeWorkforceBoundary(String(event.company_id ?? ""));
  const normalized = normalizeCalendarEvent({ ...event, company_id });
  return reconcileCalendarEvent(normalized, ports);
}
