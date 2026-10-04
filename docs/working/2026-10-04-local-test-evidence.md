# Developer-local test evidence · 4 October 2026

## Scope and publication status

This record documents focused tests executed locally for **Titan Zero Field Service Workforce**. The useful evidence is the behaviour observed at company, session, authority, execution and evidence boundaries.

**Status: developer-local execution recorded; publication of the tested implementation and clean-checkout reproduction are pending.** Publishing this report does not publish the implementation commits or establish a passing CI run for them.

All suites below belong to `Masterleeaus/Titan-Zero-Field-Service-Workforce`. They are not test results for the separate Decision Engine, Authority or Trust Engine repositories. The profile's separately documented Decision Engine evaluation has its own source, method and scope.

## Behavioural evidence

| Scope | Recorded local result | What the tests exercised | Important boundary |
| --- | --- | --- | --- |
| User route and session lifecycle | **14/14 passed** | Actual PATCH/DELETE route handlers invoked with authenticated `NextRequest` objects and a real canonical SQLite session registry. Checks covered demotion/revocation of a company-A target's bound cookie, preservation of company B, sanitized 401 responses for stale context, and retention of revoked status through a promotion retry. | Legacy database access and Next.js headers were mocked. This is handler-level execution, not a live HTTP-server or PostgreSQL test. |
| DirectAdmin workforce owners | **12/12 passed** | Reassignment, denial/revocation/expiry, durable replay, cross-company boundaries, cancellation uncertainty, Finance composition, and the Communications read-only/store boundary. | A focused local owner/integration suite. These results do not establish live-provider acceptance or production commissioning. |
| Communications reader | **5/5 passed** | Company-filtered reads, isolation from malformed or null foreign-company rows, and preservation of provider acknowledgement as unverified. | A provider acknowledgement is not a verified business outcome. Live delivery and customer-visible outcomes were not established by this suite. |

Counts identify the recorded suites. They are not a combined security score, a coverage percentage, or proof that every execution path is safe. The previously reported 22 consumer regressions are excluded from the headline results here; no combined total is calculated across those reports.

## Execution details

### User route and session lifecycle

- Source path: `apps/web/lib/auth/__tests__/user-creation-session.test.ts`.
- Recorded environment: Node.js **24.21.0**, pnpm **9.12.0**, Vitest **3.2.4**.
- Recorded command, from the repository root:

```sh
corepack pnpm --filter @titan-zero/web exec vitest run lib/auth/__tests__/user-creation-session.test.ts --config vitest.config.ts
```

- Recorded local revisions: `16455757e559ab3725008266e7f722a1c842ad14` and `0f3bade38f00e1527d55043af3155d3f2b62ece8`, based on `2ee58dc671d6c9fe1034b32868c2e13355ec7502`.
- The run used temporary overlays that were restored afterward. It does not certify an untouched checkout, a live PostgreSQL database, or an HTTP server.

### DirectAdmin workforce owners

- Source path: `services/workforce/src/directadmin-workforce-owners.test.ts`.
- Recorded local head: `f009320ec5d1a9211348b3dd3b189cd403c0b2d5`.
- Recorded environment/tooling: Node.js **24.21.0**, tsx **4.21.0**, Vitest **3.2.4**; the execution setup included temporary `jose@6.1.3` without manifest or lockfile changes.
- Successful recorded command, from the repository root:

```sh
node --test .test-dist/services/workforce/src/directadmin-workforce-owners.test.js
```

- Result: **12 passed, 12 total**.
- `.test-dist` was temporary emitted output. Dependency/runtime overlays were used; no tracked source was modified for the execution setup. The command records the successful run, but it is not a complete clean-checkout reproduction recipe.
- Reported local integration chain:
  - `bc7e7f2c101dd3092043bcd0f1ee97286966f3bc`
  - `d03a61828a9c986eb9d4e9961a671d657ffc1a48`
  - `235983d764f17cbbf2bfb3340eb9bc5567756a27`
  - `f009320ec5d1a9211348b3dd3b189cd403c0b2d5`

### Communications reader

- Source path: `packages/titan-platform/tests/directadmin-communications.test.ts`.
- Recorded result: **5 passed, 5 total**, using Vitest **3.2.4** in the local integrated workspace.
- The local installed Windows Vitest executable was invoked with:

```text
vitest.cmd run packages/titan-platform/tests/directadmin-communications.test.ts --run
```

- The executable's private machine path is intentionally omitted. This is the recorded invocation, not a claim that the test file or execution setup is currently available on public `main`.

## Supporting hierarchy, lifecycle and roadmap results

A separate developer-local report recorded **116 passed tests across 17 files**: 28 hierarchy tests, 76 lifecycle tests (including four UI tests), and 12 roadmap tests. These are supporting results, not an additional aggregate of the suites above.

- Recorded environment: Windows PowerShell, Node.js **24.21.0**, pnpm **9.12.0**.
- Reported local changes associated with generated-output and UI-assertion corrections: `1cc7c2bd22bf214c4482bafbef2daab57c60b3eb` and `d3b5d2a713b024d99d7948572c7faee07b25680f`. Both were unavailable on GitHub at the publication check.
- Recorded compilation commands:

```sh
tsc -p packages/titan-platform/tsconfig.workforce-hierarchy-test.json
tsc -p packages/titan-platform/tsconfig.lifecycle-test.json
tsc -p packages/titan-platform/tsconfig.lifecycle-test.json --outDir .test-dist
```

- Recorded UI-subset command:

```sh
node --test ./packages/titan-platform/tests/workforce-lifecycle-ui-integration.test.mjs
```

**The UI command does not run all 116 tests.** The complete 17-file batch invocation was not retained in this publication record. Generated outputs were temporary and removed afterward, and the direct package test script uses Unix `rm`; this is not a clean-Windows-checkout reproduction claim. The four UI cases are already included in the 76 lifecycle cases.

## Public source versus locally tested source

At the publication check on **4 October 2026 UTC**, public `main` was [`9568f80b2aa436bed337d3662bfbcdbe2bd9ea7c`](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/commit/9568f80b2aa436bed337d3662bfbcdbe2bd9ea7c).

The following earlier public files were verified at that exact snapshot:

- [User creation/session tests](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/blob/9568f80b2aa436bed337d3662bfbcdbe2bd9ea7c/apps/web/lib/auth/__tests__/user-creation-session.test.ts)
- [DirectAdmin workforce-owner tests](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/blob/9568f80b2aa436bed337d3662bfbcdbe2bd9ea7c/services/workforce/src/directadmin-workforce-owners.test.ts)

These links establish repository ownership and earlier public context. **They are not the locally tested revisions described above.** GitHub could not resolve the listed local route and integration commits, including the route base. The Communications reader test path was not present on public `main`. Unpublished hashes and paths are therefore recorded as plain identifiers rather than broken source links.

## Limits and remaining evidence

- No clean-checkout run or CI run for the unpublished implementation is established by this report.
- Temporary emitted output and dependency/runtime overlays need a documented, reproducible build/setup path.
- Live HTTP-server behaviour, PostgreSQL execution, live provider acceptance, deployment and host commissioning remain outside the evidence above.
- The full repository gates, `pnpm gate:fast` and `pnpm gate`, are not claimed to have passed for this recorded scope.
- No latency measurements, baseline false-block comparison, or general security-effectiveness percentage was measured by these suites.
- The supporting 116-test result lacks a complete batch invocation in this publication record and is not presented as a public reproducible benchmark.

To establish public reproducibility, publish the intended implementation revisions, preserve their exact source identities, document the required setup without temporary undocumented overlays, and rerun the same focused suites from a clean checkout. Broader product or release claims require their own relevant integration and live-environment evidence.
