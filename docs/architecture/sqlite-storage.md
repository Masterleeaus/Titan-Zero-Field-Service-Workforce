# Titan native storage — company-isolated SQLite profile

## Status

This document supersedes the former one-shared-`titan-zero.db` "SQLite-first" wording.

Titan's mature native AI-FSM remains the default field-service implementation. Frappe/ERPNext is optional extension infrastructure. `company_id` remains the canonical logical identity, while **company-owned native operational persistence defaults to one physical database per Titan company** behind a fail-closed company storage resolver/registry.

SQLite is the preferred initial native company-database profile where the existing domain can be made portable. It is not a requirement that every Titan store or future company placement use SQLite.

## Storage roles

Do not collapse these roles into one file merely because historical migrations did:

- **GLOBAL_REGISTRY** — company identity -> approved storage placement/configuration; no other company's operational rows.
- **COMPANY_NATIVE_FSM** — mature native customers, properties, jobs, visits, work orders, estimates, invoices, payments, materials, scheduling, field workflows and other Titan-owned business state for exactly one company.
- **RUNTIME / WORKFORCE / AUTHORITY / EVIDENCE** — owner-specific canonical stores. They may be shared infrastructure only where their canonical contract preserves explicit company_id isolation; they are not the company business database.
- **COMPATIBILITY** — historical mixed/shared stores retained only for migration/cutover.
- **OPTIONAL PROVIDER** — Frappe or another provider owns only explicitly delegated facets and keeps its own provider isolation.

## Company database boundary

A business operation resolves:

```
authenticated actor/session
  -> canonical CompanyContext/company_id
  -> fail-closed Company Storage Resolver
  -> registered physical placement
  -> company-native repository/transaction
```

The resolver must never derive arbitrary filesystem/database locations directly from untrusted company identifiers. Missing, conflicting, stale or ambiguous mappings fail closed. Storage placement does not grant execution authority.

Physical isolation is defense in depth, not a reason to remove `company_id` from records/envelopes. Canonical contracts, evidence, queues and correlations continue carrying `company_id`.

## SQLite company profile

A small/ordinary company may initially resolve to an isolated SQLite database beneath an approved data root such as `TITAN_COMPANY_DATA_ROOT`. Exact paths are registry-owned implementation details, not API input.

Connections should enable foreign keys, WAL, bounded busy timeout and appropriate synchronous durability. Transactions must preserve the existing native FSM's idempotency/conflict semantics.

Future certified placement may use PostgreSQL or a dedicated node without changing Titan domain/capability contracts.

## Mature FSM migration source

The full native FSM schema is **not** represented by `db/sqlite/001_canonical.sql`. The mature product evolved through the large historical `db/migrations/**` PostgreSQL stream and partial MySQL portability work. Those migrations contain extensive field-service behavior and schema for estimates, invoices/payments, expenses, mileage/vehicles, documents, checklists, portal, price book, maintenance, booking, change orders, communications, time, work orders/tasks, field evidence, materials and more.

Therefore do not create a reduced per-company schema by copying the current four SQLite migrations. First classify the mature migration history and preserve its active semantics in an owner-specific portable COMPANY_NATIVE_FSM migration family.

The currently implemented `packages/storage` native manifest remains an explicitly
bounded bootstrap profile, not that complete mature migration family. Its immutable
`company-native-work-orders-v1` profile stays available to verify existing stores
and backups; the additive `company-native-work-orders-visits-v2` profile adds only
the canonical visit-to-`work_order_tasks` plan relation. The additive
`company-native-visit-checklist-v3` profile adds visit-local disposition and note
fields to that relation; it does not alter work-order task lifecycle state or add
an evidence table. The current default placement provisioner still selects v2.
The fresh-only initializer accepts registered versions only for a genuinely empty
store; selecting a version never upgrades or changes an existing store. Existing
v1/v2 stores need a maintenance-gated migration coordinator before using v3. A consumer
must declare the schema version its operation needs and verify the matching
company/placement/revision marker, manifest digest, migration ledger and live
schema before invoking business work. A registry `READY` row alone is not a
company-store schema attestation. This bounded slice does not certify the full
native FSM schema or its feature parity.

## Migration ownership

Every migration must declare one primary storage owner:

`GLOBAL_REGISTRY | COMPANY_NATIVE_FSM | RUNTIME | WORKFORCE | AUTHORITY | EVIDENCE | COMPATIBILITY`.

The historical `scripts/sqlite-migrate.mjs` stream is compatibility-only because it mixes owners. New company provisioning must apply only the COMPANY_NATIVE_FSM migration manifest plus explicitly justified local projections.

The immutable manifest at `db/migrations/MANIFEST.json` covers only the legacy
PostgreSQL compatibility stream. It freezes existing filenames, bytes and
explicit ordering without renumbering duplicates. No deployed application
history snapshot is present, so legacy filename-only rows remain checksum-
unverified and historical duplicate-pair application status is not certified.
This manifest is not the owner-classified COMPANY_NATIVE_FSM manifest and must
not be used to provision a company database.

Existing shared PostgreSQL/SQLite installations require an explicit, restartable export/transform/import/cutover with backup, checksums, row-count/reconciliation evidence and rollback. Never silently reinterpret a shared database as one company's isolated database.

## Isolation acceptance

Provision at least company A and B into different physical databases. Prove:

- each resolver mapping is deterministic and registered;
- A cannot open B's placement through IDs, path manipulation or stale context;
- an accidental native query lacking a company predicate still cannot expose B because the connection itself is physically bound to A;
- logical `company_id` mismatches are still rejected;
- backup/restore cannot restore A under B identity;
- company switch closes/rebinds storage context and does not reuse a previous company's connection/cache/transaction.

## Backup and recovery

Back up company databases individually with metadata containing company_id, storage placement/version, schema version, Titan release/build, timestamp and checksum. Runtime/control/evidence stores have their own owner-defined recovery requirements. A backup helper that captures only the historical shared `titan-zero.db` is not a complete Titan backup once isolated company databases exist.

## Optional Frappe

When enabled, Frappe uses its own per-company site/database for explicitly delegated capabilities. Avoid uncontrolled dual writes. Every delegated facet defines owner, mapping, sync direction/no-sync rule, conflicts, idempotency, authority, observed verification, evidence, cutover and rollback.
