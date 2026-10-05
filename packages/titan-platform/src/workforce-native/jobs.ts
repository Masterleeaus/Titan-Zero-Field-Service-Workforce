import { createJobsAgentRuntime } from "../ported/titan-workforce/starter-agents/jobs/jobs-agent-runtime.js";
import {
  assertTitanNativeWorkforceBoundary,
  getTitanNativeWorkforceAgentMap,
  resolveTitanNativeCleaningProfileBinding,
  type TitanNativeCleaningProfileBinding,
  type TitanNativeWorkforceOperation,
} from "./contracts.js";

export type TitanJobsAction =
  | "list_projects"
  | "get_project"
  | "list_work_orders"
  | "get_visit"
  | "evaluate_transition"
  | "transition_project"
  | "start_visit"
  | "transition_visit"
  | "evaluate_evidence"
  | "evaluate_completion"
  | "complete_work_order"
  | "classify_exception"
  | "plan_exception_resolution"
  | "build_offline_mutation"
  | "detect_revision_conflict"
  | "build_completion_handoffs";

export type TitanJobsPlanInput = Readonly<{
  companyId: string;
  actorId?: string | null;
  action: TitanJobsAction;
  projectId?: string | null;
  workOrderId?: string | null;
  visitId?: string | null;
  payload?: Readonly<Record<string, unknown>>;
  traceId?: string | null;
  cleaningProfileId?: string;
}>;

type JsonRecord = Readonly<Record<string, unknown>>;
const runtime = createJobsAgentRuntime();
function clean(value: unknown, max = 500): string { return String(value ?? "").trim().slice(0, max); }
function freezePayload(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  const copy = { ...(value as Record<string, unknown>) };
  for (const key of ["tenant_id", "tenantId", "tenant_company_id", "account_id"]) if (key in copy) throw new Error(`legacy-company-boundary:${key}`);
  return Object.freeze(copy);
}
function entityId(value: unknown, code: string): string {
  const id = clean(value, 128);
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\")) throw new Error(code);
  return id;
}
function operation(id: string): TitanNativeWorkforceOperation {
  const found = getTitanNativeWorkforceAgentMap("jobs")?.operations.find((item) => item.id === id);
  if (!found) throw new Error(`jobs-operation-unavailable:${id}`);
  return found;
}
export function buildTitanJobsPlan(input: TitanJobsPlanInput) {
  const company_id = assertTitanNativeWorkforceBoundary(input.companyId);
  const actor_id = clean(input.actorId, 128) || null;
  const payload = freezePayload(input.payload);
  let op: TitanNativeWorkforceOperation | null = null;
  let entity_id: string | null = null;
  let query: JsonRecord = Object.freeze({});
  let body: JsonRecord | null = null;
  let evaluation: unknown = null;
  let exception: unknown = null;
  let resolution: unknown = null;
  let offline: unknown = null;
  let handoffs: unknown = null;

  if (input.action === "list_projects") op = operation("projects.list");
  else if (input.action === "get_project") { op = operation("projects.get"); entity_id = entityId(input.projectId, "jobs-project-id-required"); }
  else if (input.action === "list_work_orders") { op = operation("work_orders.list"); if (input.projectId) query = Object.freeze({ job_id: entityId(input.projectId, "jobs-project-id-required") }); }
  else if (input.action === "get_visit") { op = operation("visits.get"); entity_id = entityId(input.visitId, "jobs-visit-id-required"); }
  else if (input.action === "evaluate_transition") {
    evaluation = runtime.evaluateTransition({ ...payload, company_id, job_id: entityId(input.projectId ?? payload.job_id, "jobs-project-id-required"), job_company_id: company_id, authority_verified: false });
  } else if (input.action === "transition_project") {
    op = operation("projects.transition"); entity_id = entityId(input.projectId, "jobs-project-id-required");
    const to = clean(payload.to_status ?? payload.to_state, 64); if (!to) throw new Error("jobs-target-status-required");
    body = Object.freeze({ status: to, ...(clean(payload.reason, 500) ? { reason: clean(payload.reason, 500) } : {}) });
  } else if (input.action === "start_visit") {
    op = operation("work_orders.start_visit"); entity_id = entityId(input.workOrderId, "jobs-work-order-id-required"); body = payload;
  } else if (input.action === "transition_visit") {
    op = operation("visits.transition"); entity_id = entityId(input.visitId, "jobs-visit-id-required");
    const to = clean(payload.to_status ?? payload.status, 64); if (!to) throw new Error("jobs-visit-target-status-required"); body = Object.freeze({ status: to, ...(clean(payload.reason, 500) ? { reason: clean(payload.reason, 500) } : {}) });
  } else if (input.action === "evaluate_evidence") {
    evaluation = runtime.evaluateEvidence({ ...payload, company_id, job_id: entityId(input.projectId ?? payload.job_id, "jobs-project-id-required"), job_company_id: company_id }, payload.policy ?? {});
  } else if (input.action === "evaluate_completion") {
    evaluation = runtime.evaluateCompletion({ ...payload, company_id, job_id: entityId(input.projectId ?? payload.job_id, "jobs-project-id-required") }, payload.settings ?? {});
  } else if (input.action === "complete_work_order") {
    op = operation("work_orders.complete"); entity_id = entityId(input.workOrderId, "jobs-work-order-id-required"); body = payload;
  } else if (input.action === "classify_exception") {
    exception = runtime.classifyException({ ...payload, company_id, job_id: entityId(input.projectId ?? payload.job_id, "jobs-project-id-required") });
  } else if (input.action === "plan_exception_resolution") {
    const source = payload.exception && typeof payload.exception === "object" ? payload.exception as Record<string, unknown> : {};
    exception = runtime.classifyException({ ...source, company_id, job_id: entityId(input.projectId ?? source.job_id, "jobs-project-id-required") });
    resolution = runtime.planExceptionResolution(exception, { ...payload, company_id, authority_verified: false });
  } else if (input.action === "build_offline_mutation") {
    offline = runtime.buildOfflineMutation({ ...payload, company_id, job_id: entityId(input.projectId ?? payload.job_id, "jobs-project-id-required"), operation_id: clean(payload.operation_id, 128) || clean(input.traceId, 128) || "jobs-offline" });
  } else if (input.action === "detect_revision_conflict") {
    offline = runtime.detectRevisionConflict({ ...payload, company_id, job_id: entityId(input.projectId ?? payload.job_id, "jobs-project-id-required"), operation_id: clean(payload.operation_id, 128) || clean(input.traceId, 128) || "jobs-revision" });
  } else if (input.action === "build_completion_handoffs") {
    const readiness = runtime.evaluateCompletion({ ...payload, company_id, job_id: entityId(input.projectId ?? payload.job_id, "jobs-project-id-required") }, payload.settings ?? {});
    if (!(readiness as {ready?: boolean}).ready) throw new Error("jobs-completion-not-ready");
    handoffs = runtime.buildCompletionHandoffs(readiness, { ...payload, company_id });
  } else { const exhaustive: never = input.action; throw new Error(`unsupported-jobs-action:${String(exhaustive)}`); }

  const cleaning_profile_binding = resolveTitanNativeCleaningProfileBinding("jobs", input.cleaningProfileId, op?.id ?? null);

  return Object.freeze({ schema: "titan.zero.workforce-native.jobs-plan/v1", agentKey: "jobs" as const, company_id, actor_id, action: input.action, operation: op, cleaning_profile_binding, entity_id, query, body, evaluation, exception, resolution, offline, handoffs,
    authority: Object.freeze({ identity_grants_authority:false, execution_permitted:false, native_route_authoritative:true, requires_authenticated_actor:true, transition_authority_assumed:false, completion_authority_assumed:false }),
    browser_extension_required:false });
}
