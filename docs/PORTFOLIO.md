# Portfolio engineering guide

This guide is a code-oriented companion to the root README. It describes the implementation visible on current `main` at `e0fc40f4f788d8af963baa44a4339627d2a5a680`; it does not promote unpublished local work or open draft PRs into the public product.

## Problem and architecture

Titan Zero Field Service Workforce is a TypeScript monorepo for operating field-service businesses across office, field, customer, and system workflows. The engineering problem is not merely answering a chat prompt: an intelligent worker must use company-scoped business state, make a bounded recommendation, re-check authority before a consequential action, and leave recoverable evidence.

The main runtime is split into:

- `apps/web/` — Next.js web application and authenticated operational surfaces.
- `services/workforce/` — hosted workforce HTTP runtime, readiness checks, conversations, recovery, and DirectAdmin composition.
- `packages/titan-platform/` — platform contracts, native workforce agent maps, session/authority boundaries, and business evidence.
- `packages/runtime/` — runtime and authority execution boundaries.
- `packages/storage/` and `db/` — SQLite/native company storage and migration history.
- `packages/tools/` — bounded execution adapters.
- `ai/` and `docs/` — compact machine context, canonical rules, contracts, and evidence records.

The native workforce contract maps Reception, Sales, Booking, Scheduling, Jobs, and Customer Care to existing business APIs. Each map declares `company_id` as its boundary and `identityGrantsAuthority: false`; the authority gateway re-evaluates the current decision at execution time so a revoked or expired decision cannot silently become an action.

## Implemented intelligence and agent capabilities

The checked-in implementation supports a governed workforce shape rather than an unbounded chatbot:

- structured agent keys, operation descriptions, handoff targets, and canonical business-operation ownership in `packages/titan-platform/src/workforce-native/contracts.ts`;
- a hosted runtime with health/readiness, bounded adapter calls, cancellation, recovery, and separate runtime/identity storage checks in `services/workforce/src/server.ts`;
- execution-boundary revalidation and idempotency in `packages/runtime/authority/runtime-authority-gateway.mjs`;
- company-scoped native operations, evidence sinks, and DirectAdmin adapters under `packages/titan-platform/`, `packages/tools/`, and `apps/directadmin/`;
- interaction and decision architecture described in the root README, with implementation work continuing across active branches and draft PRs.

The key trade-off is deliberate separation: model output, a proposed decision, authority, execution, and evidence are different states. That adds contracts and integration seams, but it makes revocation, replay protection, offline/recovery behaviour, and auditability explicit.

## Quickstart

Pre## Quickstart

For a clean checkout, use the repository's default SQLite path. Node.js `>=20.9.0` and pnpm `9.12.0` are required. Docker/Compose and Bash are only needed for the full gate or the optional legacy PostgreSQL path.

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev:web
```

The commands map directly to checked-in implementation:

- `pnpm db:migrate` → `scripts/sqlite-migrate.mjs` → `db/sqlite/` and the `SQLITE_PATH` from `.env` (default `./data/titan-zero.db`).
- `pnpm db:migrate:server` → `scripts/db-migrate.sh` → `db/migrations/`; this is the legacy shared-PostgreSQL compatibility path and requires `MIGRATION_DATABASE_URL` or `DATABASE_URL`.
- `pnpm gate:fast` runs `scripts/gate.sh --fast`; it invokes Bash and covers lint, migration-manifest/RLS checks, typecheck, build, and unit tests. The full `pnpm gate` additionally starts an ephemeral PostgreSQL container and runs integration/E2E phases.

The checked-in `infra/compose.dev.yml` defines `postgres` only; it has no Redis service, so a clean-checkout bootstrap should not request `redis` from that file. Start it only for an intentional compatibility/PostgreSQL run:

```bash
docker compose -f infra/compose.dev.yml up -d postgres
```

Then provide a PostgreSQL `DATABASE_URL` or `MIGRATION_DATABASE_URL` before invoking `pnpm db:migrate:server`. On Windows, run the Bash-based gate/migration scripts from Git Bash or WSL. The default local quickstart above remains SQLite-backed.

The commands are checked-in contracts; this portfolio pass did not run them from a clean checkout.

## Evidence and tests

The tracked evidence record, [2026-10-04-local-test-evidence.md](working/2026-10-04-local-test-evidence.md), records focused developer-local results:

- User route/session lifecycle: 14/14 passed.
- DirectAdmin workforce owners: 12/12 passed.
- Communications reader: 5/5 passed.
- A separate supporting report records 116 tests across 17 files, but the complete batch invocation is not retained and is not presented as a public benchmark.

Those numbers are scoped observations, not a combined security score, coverage percentage, clean-checkout result, or production certification. The evidence record explicitly says the tested implementation revisions were not published at the time of that run, and that live PostgreSQL, provider acceptance, host commissioning, and the full repository gates remain unverified.

## Limitations and next proof

- The repository is active development; open draft PRs remain independently owned and were not modified here.
- The local evidence uses temporary overlays and unpublished revisions. Reproduce it from a clean checkout before using it as a release claim.
- Live DirectAdmin/host commissioning, upstream credentials, provider delivery, and deployment evidence are not established.
- The `archive/` tree and release candidates were preserved. They contain provenance and integration material; no deletion was justified without a complete reachability and attribution review.

For architectural authority, use current code/tests/migrations first, then the canonical and contract documents described in `AGENTS.md`.
