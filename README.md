![Titan Zero Field Service Workforce — FIELD + HOME SERVICES · CANONICAL PRODUCT](docs/images/workforce-banner.svg)

<p align="center">
  <img src="docs/images/CB4FE4C8-1FF9-4228-8DAC-98FED23D43A3.png" alt="Titan Zero Field Service Workforce" width="520" />
</p>

# Titan Zero Field Service Workforce

**Governed AI workforce for field-service operations**

Titan Zero Field Service Workforce is a TypeScript operating platform for companies that coordinate office teams, field workers, customers, and connected systems. It combines scheduling, dispatch, work execution, customer care, authority controls, and evidence into one company-scoped workflow.

The platform is designed for operations teams that need intelligent assistance to move work forward while keeping every consequential action attributable, reviewable, and reversible.

<p align="center">
  <img src="docs/images/F2BED790-8EF0-473B-988E-F42E9488B1AE.png" alt="Titan Zero field service workforce operating model" width="100%" />
</p>

## What the workforce coordinates

- **Six native agent roles:** Reception, Sales, Booking, Scheduling, Jobs, and Customer Care are explicit maps in `packages/titan-platform/src/workforce-native/contracts.ts`, each with named operations, handoff targets, and canonical Business Ops ownership.
- **Company-scoped business truth:** Every native agent map declares `company_id` as its boundary and `identityGrantsAuthority: false`; identity can provide context, but it does not authorize an action by itself.
- **Operational execution:** The maps point to existing client, booking-request, estimate, property, job, visit, work-order, and user APIs instead of creating a parallel source of truth.
- **Hosted workforce runtime:** `services/workforce/src/server.ts` provides readiness probes, conversation handling, bounded adapters, DirectAdmin forwarding controls, recovery paths, and separate runtime/identity storage checks.

## Architecture that keeps intelligence governable

The central design choice is to keep understanding, decision, authority, execution, and evidence as separate states. A recommendation can be useful without becoming permission to act, and an approved action can be rechecked immediately before execution.

<p align="center">
  <img src="docs/images/workforce-architecture.svg" alt="Titan Zero Field Service Workforce dataflow from interaction and signal through decision, authority, Nexus workforce orchestration, operations, and evidence" width="100%" />
</p>

The runtime authority gateway in `packages/runtime/authority/runtime-authority-gateway.mjs` re-evaluates current authority at the consequential execution boundary. It binds the operation to company, capability, actor, and idempotency context, records the refreshed decision, and only then calls the execution gateway.

## Engineering map

| Area | Responsibility |
| --- | --- |
| `apps/web/` | Next.js operational web surfaces and authenticated workflows. |
| `services/workforce/` | Hosted HTTP runtime, conversations, readiness, recovery, storage checks, and DirectAdmin composition. |
| `packages/titan-platform/` | Native agent maps, platform contracts, workforce evidence, and the focused verification lane. |
| `packages/runtime/` | Authority and execution boundaries, including revalidation and idempotency. |
| `packages/storage/`, `db/` | SQLite/native storage and migration history. |
| `packages/tools/` | Bounded execution adapters and gateway calls. |
| `ai/`, `docs/`, `tests/` | Canonical rules, contracts, evidence records, and focused test suites. |

## Evidence and verification

The focused native workforce evaluator is runnable without provider credentials or live authority:

```bash
pnpm --filter @titan-zero/titan-platform test:workforce-native
```

It compiles the native Workforce source and exercises the selected contract, six-agent, workflow, and parity checks. The same lane is published in the [Workforce Verification workflow](.github/workflows/workforce-verification.yml); the merged exact-head run is the public evidence for this bounded slice.

The repository also retains broader local evidence for route/session, DirectAdmin owner, and communications checks. Those results are scoped observations, not a combined security score, coverage claim, or production certification.

## Quickstart

For a clean checkout, Node.js `>=20.9.0` and pnpm `9.12.0` are required:

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev:web
```

The default local path is SQLite. `pnpm db:migrate:server` is a separate compatibility path for shared PostgreSQL and requires `MIGRATION_DATABASE_URL` or `DATABASE_URL`. On Windows, run Bash-based gates and migrations from Git Bash or WSL.

## Portfolio scope

Titan Zero Field Service Workforce is active development rather than a blanket production-readiness claim. Live DirectAdmin commissioning, upstream credentials, provider delivery, deployment evidence, and the full repository gate remain environment-dependent.

The `archive/` tree and release candidates are retained for provenance and integration review. The relationship between this canonical field-service product and the separate TitanPro/Titan-Zero repositories should be described through their actual boundaries, not assumed from shared naming.

For the detailed code map and evidence boundaries, see [docs/PORTFOLIO.md](docs/PORTFOLIO.md).