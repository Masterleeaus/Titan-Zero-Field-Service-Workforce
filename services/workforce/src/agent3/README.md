# Agent 3 — Hatchet transport integration (draft / uncommissioned)

This folder contains a **company-scoped external workflow transport** for Titan Workforce. It does not replace Titan `WorkforceService`, the native persistent agent runtime, identity, effective authority, or the Business Evidence Ledger. Business evidence must be observed and accepted by Titan before a Smart Task is counted.

## Reachability / commissioning truth

- `production-runtime-bootstrap.ts` is the **only** existing upstream file modified by this draft integration. Its native behavior remains the default when `ports.agent3Commissioning` is absent.
- Pass 12 wires `hosted-runtime.ts → field-service-runtime.mjs → production-runtime-bootstrap.ts` through an **optional, operator-owned startup gate**. Before Pass 12, the hosted chain called the bootstrap indirectly but did not pass Agent 3 ports. Now a trusted commissioning dependency can pass preflight checks; **it is not configured or live-commissioned** by the patch.
- Do not inject user-provided `agent3Commissioning` ports: these must be bound by trusted Titan configuration, current company placement, key vault, identity, policy, approval, evidence, and Hatchet client adapters.
- `agent3.migrate(company_id)` must be invoked through authorized company provisioning **before** execution ingress and after placement resolution. Migration should not occur from a public request.
- Verify that every native start/resume/cancel/recover route and every Hatchet enqueue route shares the same `agent3_execution_owner` company-scoped CAS reservation. Unreviewed alternative entrypoints are a release blocker.
- If Hatchet submission or lookup is ambiguous, preserve the reservation and require reconciliation. Never retry based only on a lost acknowledgement or empty/incomplete run listing.

## Review / tests

From repo root (requires Node 22+):

```sh
node --test services/workforce/src/agent3/agent3.test.mjs
cd services/workforce && npm test && npm run typecheck
```

The included `.mjs` tests verify this transport slice only. Run the full canonical repository TypeScript, identity/authority, host startup, concurrency and bypass-path suites before merging. A live self-hosted Hatchet deployment and real credential/evidence verification remain mandatory before commissioning.

**Do not claim a live integration from a draft PR or local test pass.**

## Pass 12 hosted startup gate

See `HOSTED-COMMISSIONING.md`. All listed companies must have completed pre-existing Agent 3 company-storage migrations and current identity/authority/evidence/placement/transport attestations before startup. No configuration means the existing native-only path is unchanged. This draft has not performed live Hatchet commissioning.
