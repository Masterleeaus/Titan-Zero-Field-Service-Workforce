![Titan Zero Field Service Workforce — FIELD + HOME SERVICES · CANONICAL PRODUCT](docs/images/portfolio-banner.svg)

<p align="center">
  <img src="docs/images/CB4FE4C8-1FF9-4228-8DAC-98FED23D43A3.png" alt="Titan Zero Field Service Workforce" width="520" />
</p>

# Titan Zero Field Service Workforce

> **A governed Advanced Intelligence workforce that operates field-service businesses across office, field, customer, and system workflows.**

Titan Zero Field Service Workforce is a full-stack business operating platform built around a coordinated workforce of intelligent managers, supervisors, specialist agents, and atomic workers.

Instead of adding a chatbot to conventional field-service software, Titan Zero is designed around a different model: the intelligence layer participates directly in the operating system of the business. It can understand interactions, assemble context, recommend decisions, coordinate work, generate interfaces, route tasks, operate through connected systems, and progressively automate approved workflows — while authority remains explicit, bounded, auditable, and reversible.

The platform combines field-service operations, multi-agent orchestration, decision intelligence, adaptive interfaces, local and edge intelligence, connectors, evidence, governance, and execution controls in a TypeScript monorepo.

<p align="center">
  <img src="docs/images/F2BED790-8EF0-473B-988E-F42E9488B1AE.png" alt="Titan Zero field service workforce operating model" width="100%" />
</p>

---

## Product architecture and engineering highlights

A field-service operating platform in which a TypeScript business application coordinates scheduling, dispatch, field work, customer operations, and a governed AI workforce.

- **Architecture:** The architecture keeps the full web application distinct from a single three-mode PWA and a separate native mobile app; company_id is the tenant boundary. The TypeScript core owns native field-service workflows, while Frappe/ERPNext remains an optional provider for capabilities deliberately delegated to it.
- **Distinctive engineering:** Standout systems include the Interaction and Decision Engines, Nexus workforce orchestration, Evidence Ledger, offline execution, DirectAdmin Business Node, and reversible authority-gated actions. Titan Zero, Titan Go, and Titan Hub are coordinated operating modes across owner, field, and customer workflows.

## The operating model

```text
Customers / Staff / Owners / Systems
                 |
                 v
        Interaction + Interface Layer
                 |
                 v
        Signal + Context + Knowledge
                 |
                 v
       Intelligence / Model Council
                 |
                 v
             Decision Engine
                 |
                 v
       Authority + Risk + Governance
                 |
                 v
      Workforce / Nexus Orchestration
                 |
                 v
       Tools / Connectors / Operations
                 |
                 v
        Evidence + State + Outcomes
```

Titan Zero separates **understanding**, **decision-making**, **authority**, and **execution**. A model producing a recommendation does not automatically gain permission to act.

That separation is fundamental to the architecture.

## Autonomous Lifecycle Example

### PR #1201 · authenticated Workforce execution and durable recovery

**[Open the merged pull request](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/pull/1201)** · **2 October 2026** · GitHub PR metadata: **+7,573 / −383 lines · 29 conversation comments**

This is a reviewable record of issue-driven, coordinated engineering—not a claim that one PR completed the whole Workforce mission.

1. **Mission and ownership were bounded.** The thread starts from issue #811 and assigns the hosted runtime and recovery seam. It records adjacent ownership for the conversation transport (#1188), registry/session identity (#302 and #1049), streaming (#1182), and DirectAdmin consumer (#1050), with explicit instructions to reuse existing contracts rather than duplicate owners’ code.
2. **Independent review challenged the first implementation.** The discussion recorded reproducible risks around authority revocation at the effect boundary, action coercion, surface identity, hung operations, and SQLite lock deadlines. Findings were tied to exact heads and disposable tests.
3. **The implementation iterated against evidence.** The thread documents fixes, exact-head reruns, and corrections when an earlier test report used an incomplete dependency overlay. This preserves both the failure and the corrected result instead of hiding the discrepancy.
4. **Verification was scoped and reported.** The merged PR records focused test suites and CI evidence for hosted runtime, storage deadlines, session fencing, recovery, and typechecks. It distinguishes automated checks from live-host commissioning.
5. **The merge claim stayed limited.** GitHub records 29 conversation comments and the final approval for a bounded runtime slice. The full #811 mission remained open; the thread explicitly does not claim production deployment, live provider acceptance, or host commissioning.

The value of this example is the trace: mission boundary → named integration owners → adversarial review → exact-head correction and verification → bounded approval. The linked discussion is the source for the detailed evidence and limitations.

<p align="center">
  <img src="docs/images/4FE3482C-D943-4405-86CF-143AAFEF52C5.png" alt="Titan Zero Field Service Workforce system architecture" width="100%" />
</p>

## Product portfolio

Titan is packaged as one platform rather than six independent business systems.

- **Titan Zero** — owner/manager experience.
- **Titan Go** — field/worker experience.
- **Titan Hub** — customer self-service.
- **Titan in external AI hosts** — authenticated access from ChatGPT, Claude and future assistants.
- **Titan for WordPress / Web Presence** — websites become operational front doors backed by Titan capabilities.
- **Titan Omni** — shared messaging, voice and channel interactions.

Commercial packaging follows **Titan Solo → Titan Team → Titan Business → Titan Sovereign**. Higher tiers expose additional capabilities such as Foundry, Missions, stronger compliance/policy controls, Private/Sovereign Intelligence and Server Node infrastructure controls.

These are entitlements over the same canonical platform. The only canonical business surfaces remain `zero`, `go` and `hub`; channels, plugins, hosts and pricing tiers never create business authority or a second source of truth. See `docs/architecture/TITAN-ZERO-BLUEPRINT-V3.md`.

## Advanced Intelligence Workforce

The workforce is structured more like an organisation than a collection of disconnected bots.

It supports:

- managers with objectives, policies, and responsibility boundaries;
- supervisors coordinating specialist work;
- standalone specialist agents;
- atomic workers for narrow deterministic tasks;
- role and capability routing;
- task planning and delegation;
- authority ceilings;
- approval gates;
- escalation chains;
- workforce state snapshots;
- audit events and evidence;
- knowledge-authority checks.

Workers can be registered, discovered, coordinated, and activated without silently receiving execution authority. Authority is handled independently through explicit runtime controls.

## Interaction Engine

Titan Zero treats an interaction as more than a chat message.

The interaction layer is designed to connect conversations, generated interfaces, business state, workforce activity, device context, and operational actions into a continuous interaction lifecycle.

Current platform primitives include interface discovery, interface registries, interaction handoff, local interface state, integrity controls, runtime contracts, capability negotiation, fallback behaviour, and company-scoped execution.

This creates the foundation for experiences where a user can begin with natural language and move into dynamically generated operational UI without losing context or authority boundaries.

The objective is a business system that can choose the most useful interaction surface for the task rather than forcing every workflow through static dashboards and forms.

## Decision Engine

The Decision Engine provides a boundary between intelligence and consequential action.

Rather than allowing model output to flow directly into execution, decisions can be represented through structured envelopes containing context, evidence, risk, recommendation, authority requirements, and execution state.

The wider decision architecture integrates with:

- deterministic risk classification;
- evidence-aware recommendations;
- Signal prioritisation;
- Model Council outputs;
- Nexus orchestration;
- authority policy;
- approval and escalation paths;
- execution controls;
- audit and recovery evidence.

This allows the system to reason broadly while keeping business actions constrained by explicit policy.

## Signal

Signal provides a normalisation and prioritisation layer between raw events and higher-level intelligence.

Operational events, observations, user interactions, system changes, and other inputs can be transformed into structured signals that downstream intelligence can evaluate consistently.

This helps separate **what happened** from **what the system thinks should happen next**.

## Model Council

Titan Zero is not architected around the assumption that one model should make every decision.

The Model Council provides a foundation for combining recommendations from multiple reasoning sources while preserving the distinction between consensus and authority.

Council output can contribute evidence to a decision, but consensus itself does not grant execution permission.

This allows multiple models, local intelligence, specialist reasoning systems, or future providers to contribute without turning any individual model into an uncontrolled authority.

## Nexus orchestration

Nexus coordinates work across the intelligence and workforce layers.

Its role is to help translate recognised needs and approved decisions into coordinated work across managers, agents, workers, tools, and business capabilities.

The orchestration architecture is deliberately separated from authority: knowing how to execute a workflow is different from being permitted to execute it.

## Adaptive Interface Runtime

Titan Zero includes a substantial interface-runtime layer rather than relying exclusively on fixed application screens.

Platform capabilities include:

- interface discovery;
- interface catalogs and registries;
- interaction handoff;
- local interface state;
- integrity and boundary hardening;
- runtime compatibility checks;
- capability negotiation;
- fallback planning;
- resource integrity;
- offline caching.

This architecture supports generated and adaptive UI while retaining predictable contracts between the intelligence layer and application surfaces.

## Intelligence Runtime

The intelligence runtime provides infrastructure for executing intelligence workloads across different environments.

The current implementation includes device-runtime support, edge capability advertisement, intelligence execution contracts, and resource reporting. This allows the platform to reason about where capabilities exist rather than assuming every workload belongs in a remote cloud service.

## Local, edge and cost-sovereign intelligence

Titan Zero is designed to support multiple intelligence providers and execution locations.

Inference-routing policy can consider capability and cost rather than binding the platform to one model vendor. The architecture provides foundations for:

- local models;
- device intelligence;
- edge capabilities;
- customer-controlled providers;
- external model services;
- capability-aware routing;
- graceful degradation and fallback.

This makes intelligence infrastructure replaceable rather than embedding provider lock-in into the business operating model.

## Titan Builder

Titan Builder provides platform capabilities for constructing and extending Titan experiences and operational capabilities from reusable contracts.

It sits alongside the runtime, workforce, connector, and interface layers so new functionality can participate in the same authority, capability, and execution model instead of becoming an isolated application.

## Connectors and MCP

External systems participate through explicit connector contracts.

The platform includes connector descriptors, permission and health concepts, credential references, and MCP host negotiation. Connected capabilities can therefore be discovered and reasoned about through contracts rather than hidden integration assumptions.

This supports Titan Zero's broader principle:

> **Keep what works. Connect what can be connected. Improve what is inadequate. Build what is missing.**

## Field-service operating system

The intelligence platform is connected to a working field-service domain rather than existing only as an orchestration framework.

Operational capabilities include:

- customer and account management;
- property and service history;
- estimates and job workflows;
- scheduling and operational coordination;
- inventory;
- money and financial-domain primitives;
- onboarding;
- notifications;
- revenue journeys;
- background processing;
- service operations;
- operational web interfaces.

This gives the workforce real business state and workflows to operate against.

## Authority, governance and trust

A core invariant of Titan Zero is:

> **Intelligence is not authority.**

Prediction, recommendation, consensus, registration, activation, orchestration, and execution are separate concepts.

The architecture supports constrained delegation, authority ceilings, approvals, escalation, risk classification, evidence, audit events, state recovery, and knowledge-authority checks.

This makes progressive automation possible without treating autonomy as an all-or-nothing switch.

## Canonical company boundary

`company_id` is the canonical business boundary throughout the platform.

Legacy or compatibility identifiers may be normalised at system boundaries, but authorisation, storage, projections, decisions, and execution operate on the canonical company identifier.

## Architecture

```text
Titan Zero Field Service Workforce
|
+-- apps/
|   +-- web                  Operational Next.js application
|
+-- services/
|   +-- worker               Background processing and automation
|
+-- packages/
|   +-- titan-platform       Workforce, intelligence and platform contracts
|   +-- titan-runtime        Runtime capabilities
|   +-- domain               Shared business domain
|   +-- business-services    Business capabilities
|   +-- offline              Offline operation
|   +-- observability        Runtime visibility
|   +-- inventory            Inventory domain
|   +-- money                Financial primitives
|   +-- onboarding           Onboarding capabilities
|   +-- provenance           Evidence and provenance
|   +-- revenue-journey      Revenue lifecycle
|   +-- tools                Shared tooling
|   +-- ...                  Additional bounded capabilities
|
+-- db/migrations            Database schema and migration history
+-- infra                    Docker and deployment infrastructure
+-- docs                     Architecture and system documentation
+-- ai                       Compact machine-readable project context
```

## Technology

Titan Zero is primarily a TypeScript system built with a modern full-stack stack:

- **TypeScript**
- **Next.js / React**
- **Node.js**
- **PostgreSQL**
- **Redis**
- SQL migrations and row-level security patterns
- **Docker Compose**
- background worker services
- **Zod** runtime schemas
- **Vitest**
- **Playwright**
- **GitHub Actions**

## Development

### Prerequisites

- Node.js
- pnpm
- Docker / Docker Compose

### Start locally

```bash
cp .env.example .env
pnpm install
docker compose -f infra/compose.dev.yml up -d postgres redis
pnpm db:migrate
pnpm dev:web
```

## Recorded test evidence · 4 October 2026

Focused developer-local execution exercised the platform's authority and company boundaries:

- **User route/session lifecycle: 14/14 passed.** Actual PATCH/DELETE handlers and the canonical SQLite session registry covered demotion/revocation, preservation of company B, sanitized stale-context rejection and revoked-status retention.
- **DirectAdmin workforce owners: 12/12 passed.** Checks covered reassignment, current authority, denial/revocation/expiry, replay, cross-company isolation, cancellation uncertainty, Finance composition and Communications boundaries.
- **Communications reader: 5/5 passed.** Checks covered company-filtered reads, malformed/foreign-row isolation and provider acknowledgement remaining unverified.

**These are developer-local results.** The tested implementation commits remain unpublished and the runs used temporary execution overlays. Clean-checkout reproduction, CI for those revisions and live-host verification remain pending.

The [detailed evidence record](docs/working/2026-10-04-local-test-evidence.md) includes commands, environment versions, local revision identifiers, older public source references, the separately reported 116-test hierarchy/lifecycle/roadmap batch, and verification limits. Results are not combined into a security score or a product-readiness claim.

## Quality gates

Run the complete repository gate:

```bash
pnpm gate
```

For faster static and unit feedback:

```bash
pnpm gate:fast
```

The repository includes automated checks across the web application, worker, platform packages, integration boundaries, and development workflow.

## Documentation authority

The repository contains active implementation, architectural documentation, and historical convergence evidence.

Current authority follows this order:

1. Code and database migrations define implemented behaviour.
2. `docs/canonical/` defines current product, domain, workflow, and architecture intent.
3. `docs/contracts/` and `docs/working/` provide supporting implementation material.
4. `ai/` provides compact machine/agent-facing context.
5. `docs/archive/` and `docs/generated/` preserve historical and generated evidence.

## Status

**Active development.**

Titan Zero Field Service Workforce is being developed as a managed Advanced Intelligence workforce for field-service businesses, with progressive automation, device and provider flexibility, explicit authority boundaries, and continuously extensible operational capabilities.
