import type { CompanyNativeSchemaManifest } from "./company-native-schema-attestation.js";

/**
 * Fresh-only bounded profile derived from the native work-order slice already
 * present in db/sqlite/001 and 005. It is deliberately not a complete FSM
 * manifest and it does not certify or migrate an existing mixed store.
 */
export const companyNativeWorkOrdersManifest: CompanyNativeSchemaManifest = Object.freeze({
  format: "titan-company-native-fsm-manifest/v1",
  owner: "COMPANY_NATIVE_FSM",
  profile_id: "native-work-orders-v1",
  schema_version: "company-native-work-orders-v1",
  schema_scope: Object.freeze([
    "companies",
    "clients",
    "properties",
    "jobs",
    "visits",
    "work_orders",
    "work_order_tasks",
  ]),
  source_provenance: Object.freeze([
    Object.freeze({
      path: "db/sqlite/001_canonical.sql",
      sha256: "fde73791fc94d10bb2a5758cb006428cf6ee9d8dca571a65dd30e32e8bdbede9",
      included_objects: Object.freeze(["companies", "clients", "properties", "jobs", "visits"]),
      excluded_objects: Object.freeze([
        "schema_migrations", "users", "decisions", "authority_state", "evidence",
        "operational_events", "communications", "money_entries", "local_queue",
      ]),
      adaptations: Object.freeze([
        "companies is a company-local id/name profile with empty default settings; GLOBAL_REGISTRY placement and verified session remain authoritative",
        "user ids remain opaque references; identity and access are verified by the canonical session boundary",
        "company-scoped composite foreign keys replace references that depended on a shared database",
      ]),
    }),
    Object.freeze({
      path: "db/sqlite/005_work_order_completion.sql",
      sha256: "a295984f85fcdb169a0e2ab91d90abaab4b7eac53e868d829a2f97f440b094ee",
      included_objects: Object.freeze(["work_orders", "work_order_tasks", "visits"]),
      excluded_objects: Object.freeze(["users_company_id", "clients_company_id", "jobs_company_id"]),
      adaptations: Object.freeze([
        "user foreign keys are omitted because identity records are not copied into company stores",
        "visit work-order/job binding uses a company-scoped composite foreign key instead of legacy triggers",
      ]),
    }),
  ]),
  // Filled from the deterministic fresh SQLite initialization fixture; excludes
  // the marker and its applied-migration ledger to avoid a self-referential hash.
  schema_fingerprint_sha256: "fac6361bf74f6d4ebaebe9fd584ee8a05736e125d8b80a723a142d855842e9d2",
  migrations: Object.freeze([
    Object.freeze({
      sequence: 1,
      migration_id: "company-native-fsm/0001-work-orders",
      path: "db/sqlite/company-native/0001_work_orders.sql",
      sha256: "9efd5eafd9af06d0aa0b67b22c064859166956efd9b4d217af611c0e755b3013",
    }),
  ]),
});

/** Additive COMPANY_NATIVE_FSM profile that gives every visit its own set of
 * links to existing work_order_tasks rows. Version 1 above remains immutable
 * for old attestations and backups. */
export const companyNativeWorkOrdersVisitsManifest: CompanyNativeSchemaManifest = Object.freeze({
  format: "titan-company-native-fsm-manifest/v1",
  owner: "COMPANY_NATIVE_FSM",
  profile_id: "native-work-orders-visits-v2",
  schema_version: "company-native-work-orders-visits-v2",
  schema_scope: Object.freeze([
    "companies",
    "clients",
    "properties",
    "jobs",
    "visits",
    "work_orders",
    "work_order_tasks",
    "visit_tasks",
  ]),
  source_provenance: Object.freeze([
    ...companyNativeWorkOrdersManifest.source_provenance,
    Object.freeze({
      path: "db/sqlite/company-native/0002_visit_tasks.sql",
      sha256: "def828afc351554735fdc38615d6b67ad1d90c6195ca0b714ed4194b2db5906c",
      included_objects: Object.freeze([
        "visit_tasks",
        "work_order_tasks_company_task_work_order",
        "visits_company_visit_work_order",
        "visit_tasks_company_task_lookup",
      ]),
      excluded_objects: Object.freeze(["checklist_items", "accepted_evidence", "company_registry"]),
      adaptations: Object.freeze([
        "visit checklist instances link to existing work_order_tasks rows through the canonical visit_tasks relation",
        "composite company and work-order foreign keys prevent a visit from linking another company or work order task",
        "no checklist, evidence, identity, authority, or placement tables are copied into the company profile",
      ]),
    }),
  ]),
  // Filled from the deterministic fresh SQLite initialization fixture; excludes
  // the marker and its applied-migration ledger to avoid a self-referential hash.
  schema_fingerprint_sha256: "8480925ebd63b859dd9061895585fed2a7fa44d221d3433a4f0244a9f64b0b6a",
  migrations: Object.freeze([
    ...companyNativeWorkOrdersManifest.migrations,
    Object.freeze({
      sequence: 2,
      migration_id: "company-native-fsm/0002-visit-tasks",
      path: "db/sqlite/company-native/0002_visit_tasks.sql",
      sha256: "def828afc351554735fdc38615d6b67ad1d90c6195ca0b714ed4194b2db5906c",
    }),
  ]),
});

/** Additive visit-local checklist state. The task row retains work-order
 * lifecycle state; disposition and note belong to this visit's task link. */
export const companyNativeVisitChecklistManifest: CompanyNativeSchemaManifest = Object.freeze({
  format: "titan-company-native-fsm-manifest/v1",
  owner: "COMPANY_NATIVE_FSM",
  profile_id: "native-visit-checklist-v3",
  schema_version: "company-native-visit-checklist-v3",
  schema_scope: companyNativeWorkOrdersVisitsManifest.schema_scope,
  source_provenance: Object.freeze([
    ...companyNativeWorkOrdersVisitsManifest.source_provenance,
    Object.freeze({
      path: "db/sqlite/company-native/0003_visit_checklist_state.sql",
      sha256: "e067b641056a93a1b3096d8df28a69f76756a84b7d006b4594c8df4e347cd206",
      included_objects: Object.freeze(["visit_tasks.disposition", "visit_tasks.note", "visit_tasks.updated_at"]),
      excluded_objects: Object.freeze(["accepted_evidence", "company_registry"]),
      adaptations: Object.freeze([
        "visit-local inspection disposition and note do not overwrite work-order task lifecycle status",
        "no evidence ledger or identity/placement tables are copied into the company profile",
      ]),
    }),
  ]),
  schema_fingerprint_sha256: "96a055ace01a768ecc74c9b7931e844d8fa4ef82f3963573099c08612d971b13",
  migrations: Object.freeze([
    ...companyNativeWorkOrdersVisitsManifest.migrations,
    Object.freeze({
      sequence: 3,
      migration_id: "company-native-fsm/0003-visit-checklist-state",
      path: "db/sqlite/company-native/0003_visit_checklist_state.sql",
      sha256: "e067b641056a93a1b3096d8df28a69f76756a84b7d006b4594c8df4e347cd206",
    }),
  ]),
});

const manifestsByVersion = new Map<string, CompanyNativeSchemaManifest>([
  [companyNativeWorkOrdersManifest.schema_version, companyNativeWorkOrdersManifest],
  [companyNativeWorkOrdersVisitsManifest.schema_version, companyNativeWorkOrdersVisitsManifest],
  [companyNativeVisitChecklistManifest.schema_version, companyNativeVisitChecklistManifest],
]);

export function getCompanyNativeSchemaManifest(schemaVersion: string): CompanyNativeSchemaManifest | null {
  return manifestsByVersion.get(schemaVersion) ?? null;
}
