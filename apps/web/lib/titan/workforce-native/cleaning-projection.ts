import cleaningWorkforceBundle from "../../../../../packages/modules/bundles/cleaning-workforce.bundle.json";
import {
  assertTitanNativeWorkforceBoundary,
  getTitanNativeWorkforceAgentMap,
  projectTitanNativeCleaningProfile,
} from "@titan-zero/titan-platform/workforce-native";

type JsonRecord = Readonly<Record<string, unknown>>;
type CleaningBundle = Readonly<{
  modules?: readonly Readonly<{
    id?: unknown;
    contributes?: Readonly<{ workers?: unknown }>;
  }>[];
}>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`cleaning-profile-${label}-required`);
  return normalized;
}

function canonicalCleaningWorkers(): readonly JsonRecord[] {
  const bundle = cleaningWorkforceBundle as CleaningBundle;
  const module = bundle.modules?.find((candidate) => candidate.id === "titan.workforce.cleaning");
  const workers = module?.contributes?.workers;
  if (!Array.isArray(workers) || workers.length === 0) throw new Error("cleaning-workforce-profiles-unavailable");
  const seen = new Set<string>();
  return Object.freeze(workers.map((raw) => {
    const worker = record(raw);
    if (!worker) throw new Error("cleaning-workforce-profile-invalid");
    const id = text(worker.id, "id");
    if (seen.has(id)) throw new Error(`cleaning-workforce-profile-duplicate:${id}`);
    seen.add(id);
    return worker;
  }));
}

/** Read-only projection of the canonical cleaning module onto registered native adapters. */
export function buildNativeCleaningWorkforceProjection(companyId: string) {
  const company_id = assertTitanNativeWorkforceBoundary(companyId);
  const profiles = canonicalCleaningWorkers().map((worker) => {
    const profile_id = text(worker.id, "id");
    const binding = projectTitanNativeCleaningProfile(profile_id);
    const agent = binding.agent_key ? getTitanNativeWorkforceAgentMap(binding.agent_key) : null;
    const operation_bindings = binding.allowed_operation_ids.map((id) => {
      const operation = agent?.operations.find((candidate) => candidate.id === id);
      if (!operation) throw new Error(`cleaning-workforce-operation-binding-invalid:${profile_id}:${id}`);
      return Object.freeze({
        id: operation.id,
        method: operation.method,
        path: operation.path,
        mutating: operation.mutating,
        disposition: operation.mutating ? "suggest_only" as const : "authenticated_read" as const,
      });
    });
    return Object.freeze({
      record_kind: "profile_metadata" as const,
      profile_id,
      company_worker_id: null,
      name: text(worker.name, "name"),
      source_role: text(worker.role, "role"),
      description: text(worker.description, "description"),
      binding_status: binding.binding_status,
      native_agent_key: binding.agent_key,
      responsibility: binding.responsibility,
      allowed_operations: Object.freeze(operation_bindings),
      autonomy: binding.autonomy,
      execution_mode: "suggest_only" as const,
      authority_granted: binding.authority_granted,
      execution_permitted: binding.execution_permitted,
      team_eligibility: Object.freeze({
        status: "unavailable" as const,
        reason: "No company-scoped cleaning worker or team identity is published by this profile binding",
      }),
      ...(binding.binding_status === "unavailable"
        ? { unavailable_reason: "No registered native Workforce adapter binding; profile remains metadata only" }
        : {}),
    });
  });

  return Object.freeze({
    schema: "titan.zero.workforce-native.cleaning-profile-projection/v1" as const,
    company_id,
    source_module: "titan.workforce.cleaning" as const,
    profile_count: profiles.length,
    bound_suggest_only_count: profiles.filter((profile) => profile.binding_status === "bound_suggest_only").length,
    unavailable_count: profiles.filter((profile) => profile.binding_status === "unavailable").length,
    identity_grants_authority: false as const,
    profiles: Object.freeze(profiles),
  });
}
