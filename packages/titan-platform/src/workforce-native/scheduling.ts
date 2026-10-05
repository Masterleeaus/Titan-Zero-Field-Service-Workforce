import {
  buildSchedulingHandoff,
  buildSchedulingRecommendation,
} from "../ported/titan-workforce/starter-agents/scheduling/scheduling-agent.js";
import {
  buildDispatchHandoff,
  buildDispatchProposal,
} from "../ported/titan-workforce/starter-agents/dispatch/dispatch-agent.js";
import {
  assertTitanNativeWorkforceBoundary,
  getTitanNativeWorkforceAgentMap,
  resolveTitanNativeCleaningProfileBinding,
  type TitanNativeCleaningProfileBinding,
  type TitanNativeWorkforceOperation,
} from "./contracts.js";

export type TitanSchedulingAction =
  | "list_jobs"
  | "list_visits"
  | "list_work_orders"
  | "list_workers"
  | "propose_assignment"
  | "propose_schedule"
  | "schedule_visits"
  | "reschedule_visit"
  | "handoff_jobs";

export type TitanSchedulingPlanInput = Readonly<{
  companyId: string;
  actorId: string;
  action: TitanSchedulingAction;
  jobId?: string;
  visitId?: string;
  status?: string;
  clientId?: string;
  limit?: number;
  payload?: Record<string, unknown>;
  candidates?: Array<Record<string, unknown>>;
  job?: Record<string, unknown>;
  traceId?: string;
  cleaningProfileId?: string;
}>;

export type TitanSchedulingExecutionPlan = Readonly<{
  schema: "titan.zero.workforce-native.scheduling-plan/v1";
  agentKey: "scheduling";
  company_id: string;
  actor_id: string;
  action: TitanSchedulingAction;
  operation: TitanNativeWorkforceOperation | null;
  cleaning_profile_binding: TitanNativeCleaningProfileBinding | null;
  entity_id: string | null;
  query: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>> | null;
  assignment_proposal: unknown | null;
  schedule_recommendation: unknown | null;
  handoff: unknown | null;
  conflict_policy: Readonly<{
    canonical_guard: "visit-conflicts";
    job_overlap_rejected: true;
    technician_overlap_rejected: true;
    field_active_guard_preserved: true;
  }>;
  authority: Readonly<{
    identity_grants_authority: false;
    execution_permitted: false;
    native_route_authoritative: true;
    requires_authenticated_actor: true;
    assignment_is_proposal_only: boolean;
    schedule_write_requires_owner_or_admin: true;
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

function schedulingOperation(id: string): TitanNativeWorkforceOperation {
  const scheduling = getTitanNativeWorkforceAgentMap("scheduling");
  const operation = scheduling?.operations.find((candidate) => candidate.id === id);
  if (!operation) throw new Error(`scheduling-operation-unavailable:${id}`);
  return operation;
}

function normalizeEntityId(value: unknown, label: string): string {
  const id = clean(value, 128);
  if (!id || !/^[0-9A-Za-z_-]{1,128}$/.test(id)) throw new Error(`${label}-required`);
  return id;
}

function freezePayload(value: Record<string, unknown> | undefined): Readonly<Record<string, unknown>> {
  rejectLegacyCompanyBoundary(value);
  return Object.freeze({ ...(value ?? {}) });
}

function requireIso(value: unknown, label: string): string {
  const raw = clean(value, 64);
  if (!raw || Number.isNaN(new Date(raw).getTime())) throw new Error(`${label}-required`);
  return raw;
}

function validateWindow(start: unknown, end: unknown): { scheduled_start: string; scheduled_end: string } {
  const scheduled_start = requireIso(start, "scheduled_start");
  const scheduled_end = requireIso(end, "scheduled_end");
  if (new Date(scheduled_end).getTime() <= new Date(scheduled_start).getTime()) {
    throw new Error("scheduled_end-must-follow-scheduled_start");
  }
  return { scheduled_start, scheduled_end };
}

function normalizeDays(value: unknown): Array<{ scheduled_start: string; scheduled_end: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 31) throw new Error("scheduling-days-required");
  const days = value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("scheduling-day-invalid");
    const row = entry as Record<string, unknown>;
    return validateWindow(row.scheduled_start, row.scheduled_end);
  }).sort((a, b) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime());
  for (let i = 1; i < days.length; i += 1) {
    if (new Date(days[i].scheduled_start).getTime() < new Date(days[i - 1].scheduled_end).getTime()) {
      throw new Error("scheduling-days-overlap");
    }
  }
  return days;
}

export function buildTitanSchedulingPlan(input: TitanSchedulingPlanInput): TitanSchedulingExecutionPlan {
  rejectLegacyCompanyBoundary(input);
  const company_id = assertTitanNativeWorkforceBoundary(input.companyId);
  const actor_id = clean(input.actorId, 180);
  if (!actor_id) throw new Error("actor_id-required");

  let operation: TitanNativeWorkforceOperation | null = null;
  let entity_id: string | null = null;
  let query: Readonly<Record<string, string>> = Object.freeze({});
  let body: Readonly<Record<string, unknown>> | null = null;
  let assignment_proposal: unknown | null = null;
  let schedule_recommendation: unknown | null = null;
  let handoff: unknown | null = null;
  let assignmentIsProposalOnly = false;

  if (input.action === "list_jobs") {
    operation = schedulingOperation("projects.list");
    const q: Record<string, string> = {};
    if (clean(input.clientId, 128)) q.client_id = clean(input.clientId, 128);
    if (Number.isInteger(input.limit) && Number(input.limit) > 0) q.limit = String(Math.min(Number(input.limit), 200));
    query = Object.freeze(q);
  } else if (input.action === "list_visits") {
    operation = schedulingOperation("project_visits.list");
    entity_id = normalizeEntityId(input.jobId, "scheduling-job-id");
  } else if (input.action === "list_work_orders") {
    operation = schedulingOperation("work_orders.list");
    const q: Record<string, string> = {};
    if (clean(input.status, 64)) q.status = clean(input.status, 64);
    query = Object.freeze(q);
  } else if (input.action === "list_workers") {
    operation = schedulingOperation("users.list");
  } else if (input.action === "propose_assignment") {
    const job = freezePayload(input.job ?? input.payload);
    const candidates = Array.isArray(input.candidates) ? input.candidates : [];
    rejectLegacyCompanyBoundary(candidates);
    const workItemId = clean(job.job_id ?? job.id ?? input.jobId, 128);
    if (!workItemId) throw new Error("scheduling-work-item-id-required");
    schedule_recommendation = buildSchedulingRecommendation({
      company_id,
      work_item_id: workItemId,
      candidates: candidates.map((candidate) => ({ ...candidate, company_id })),
    });
    assignment_proposal = buildDispatchProposal({
      company_id,
      job: { ...job, company_id, job_id: workItemId },
      workers: candidates.map((candidate) => ({ ...candidate, company_id })),
    });
    assignmentIsProposalOnly = true;
  } else if (input.action === "propose_schedule") {
    const source = freezePayload(input.payload);
    const window = validateWindow(source.scheduled_start, source.scheduled_end);
    const workItemId = normalizeEntityId(input.jobId ?? source.job_id, "scheduling-job-id");
    schedule_recommendation = Object.freeze({
      schema: "titan.zero.workforce-native.schedule-recommendation/v1",
      company_id,
      job_id: workItemId,
      assigned_user_id: clean(source.assigned_user_id, 128) || null,
      ...window,
      state: "PROPOSED",
      conflict_check_required: true,
      requires_human_approval: true,
      execution_permitted: false,
      grants_authority: false,
    });
    assignmentIsProposalOnly = true;
  } else if (input.action === "schedule_visits") {
    operation = schedulingOperation("project_visits.bulk");
    entity_id = normalizeEntityId(input.jobId, "scheduling-job-id");
    const source = freezePayload(input.payload);
    const days = normalizeDays(source.days);
    const allowed = new Set(["assigned_user_id", "work_order_id", "visit_type", "tech_notes", "task_ids", "days"]);
    for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`scheduling-field-not-allowed:${key}`);
    body = Object.freeze({ ...source, days });
  } else if (input.action === "reschedule_visit") {
    operation = schedulingOperation("visits.update");
    entity_id = normalizeEntityId(input.visitId, "scheduling-visit-id");
    const source = freezePayload(input.payload);
    const allowed = new Set(["assigned_user_id", "scheduled_start", "scheduled_end", "tech_notes"]);
    for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`reschedule-field-not-allowed:${key}`);
    if (source.scheduled_start !== undefined || source.scheduled_end !== undefined) {
      if (source.scheduled_start === undefined || source.scheduled_end === undefined) throw new Error("reschedule-window-must-be-complete");
      validateWindow(source.scheduled_start, source.scheduled_end);
    }
    if (!Object.keys(source).length) throw new Error("reschedule-body-required");
    body = source;
  } else if (input.action === "handoff_jobs") {
    const source = freezePayload(input.payload);
    const workItemId = normalizeEntityId(input.jobId ?? source.job_id ?? source.work_item_id, "scheduling-job-id");
    const recommendation = buildSchedulingRecommendation({
      company_id,
      work_item_id: workItemId,
      candidates: Array.isArray(input.candidates) ? input.candidates.map((candidate) => ({ ...candidate, company_id })) : [],
    });
    handoff = Object.freeze({
      scheduling: buildSchedulingHandoff(recommendation),
      dispatch: buildDispatchHandoff({
        company_id,
        job_id: workItemId,
        recommended_worker_id: clean(source.assigned_user_id ?? (recommendation as Record<string, unknown>).recommended_worker_id, 128) || null,
      }),
      target: "jobs",
      direct_mutation: false,
      execution_permitted: false,
      grants_authority: false,
    });
    assignmentIsProposalOnly = true;
  } else {
    const exhaustive: never = input.action;
    throw new Error(`unsupported-scheduling-action:${String(exhaustive)}`);
  }

  const cleaning_profile_binding = resolveTitanNativeCleaningProfileBinding("scheduling", input.cleaningProfileId, operation?.id ?? null);

  return Object.freeze({
    schema: "titan.zero.workforce-native.scheduling-plan/v1",
    agentKey: "scheduling",
    company_id,
    actor_id,
    action: input.action,
    operation,
    cleaning_profile_binding,
    entity_id,
    query,
    body,
    assignment_proposal,
    schedule_recommendation,
    handoff,
    conflict_policy: Object.freeze({
      canonical_guard: "visit-conflicts",
      job_overlap_rejected: true,
      technician_overlap_rejected: true,
      field_active_guard_preserved: true,
    }),
    authority: Object.freeze({
      identity_grants_authority: false,
      execution_permitted: false,
      native_route_authoritative: true,
      requires_authenticated_actor: true,
      assignment_is_proposal_only: assignmentIsProposalOnly,
      schedule_write_requires_owner_or_admin: true,
    }),
    browser_extension_required: false,
  });
}
