# Workforce cockpit continuation evidence — #1050

This is implementation evidence and a dependency handoff, not mission completion.
PR #1143 was merged to main as `468d42b1a93401a2357f2da253f639694cb4a937` after
its last recorded draft update; its remote branch was deleted by that merge. The
accepted #1145 history is preserved in main. A Jason-directed bounded follow-up
now owns the same canonical `agent/issue-1050` ref, initially recreated at
`c46774cc007a324ec618ecdfdfe5a04acd44780f` and normally fast-forwarded to current
main `d508a2695fccc36e039f18e60cb96adfbe318813` after #1243. The branch merged
main `8c1161f291d07ecf344ae062b2349c2a13280410` at
`a1d364828991289254b04cdc1e16e0f92a5c1458` for #1242/#1244, then incorporated
the #1241/#1245 main advance at `faab3c5c9bdfd90179d5d3bfee21c479dceb3613`,
the upstream merge of PR #1246 at `bfbb06a5a22591100e2c0101e6598bee9c6f4589`,
and #1247 at current main `64561e4d077ec07a3cb40dfb43284b0e7dff4dbf`. Jason's
updates `a7491161` and `87deeb75` on the same canonical claim are preserved by
normal merges. Issue
#1050 remains open. Earlier records below are
historical snapshots; the latest current-main test and package evidence is
recorded at the end. The latest record supersedes the pre-merge fail-open status
and synthetic v2-marker test description with the merged #1245 disabled-loader
contract and exact #1242 host-composition fixture.

## Sources inspected

- Historical initial run: main `ccf8010a35292caa17bac393214b43b1a8209e2a`, including #812 commit
  `89ff2427339a6f216281c970376be4634ee9fb9f`; that first extracted relay integration was
  intentionally pinned to pre-change #812 head `8cae7034f6d2ec7c9063ac0c3aba40c6f41b3d89`. Earlier tested-main
  and synthetic v2 marker runs remain historical; the latest in-process loader-injection result is recorded at the end. Root/apps/packages AGENTS, ai/INVARIANTS,
  Blueprint v3, Canonical Rules, phase map and DirectAdmin development guide.
  That snapshot also includes #1048/#1209 Developer Portal hardening; it does not
  replace Workforce's canonical owner or relay contracts.
- #1050 current issue and claim comments, #1143 and accepted #1145.
- #1049 remains an open SDK mission; PR #1204 merged to main at `75cc7f02` from head `5b1275df`. The tested SDK implementation source `e428b67b34779e49f4dbc8d3e80b193e8737eb13` supplies the package bundle and contribution-version compatibility handling.
- #811 / PR #1201 merged at exact head `25005f4f4d860e2ec1dddb9f0a2c4aa152fd0488`, including the optional DirectAdmin gateway mount. #1242 later merged the production dependency composition at main `8c1161f2`; it remains present at current main `64561e4d`. #812 / PR #1211 introduced the experimental v2 config and Apache `:443` filter. PR #1245 (head `eb568f20ccc5403b968eaacbb97c3dbb3cab9b08`) merged at `faab3c5c`; it removes that filter and leaves the production RAW loader disabled with sanitized 503 `cookie_boundary_unverified`. The latest integration supplies #1242's required placement ports through canonical storage adapters in a disposable fixture, uses no relay config file or environment-selected forwarding, and injects a fake relay loader only in-process.
- #1182 owns conversation transport; PR #1188's hosted conversation lifecycle is merged, but the Workforce panel does not integrate the transport. #302 remains the shared identity owner.
- #1179 prerequisite ad43d010d50ba262c02beaf0ed892b656174ff58 merged with provenance.
- No repository `.agents/skills` directory exists; executor `.agents` is empty.

## What this continuation implements

`apps/directadmin/workforce` owns an executable Node shell for all DA roles,
company-bound ephemeral consumer state, roster/hierarchy/work/control/receipt/
evidence/health presentation, explicit unavailable states, native-theme fallbacks,
fixed Operations deep links, SDK-compatible summary shape and real archive/
staging install/update/uninstall contracts. It introduces no business store,
identity/auth resolver, authority engine, agent runtime or provider execution.

The browser calls the shared #1049 `DirectAdminCockpitSession` through #812's published
`createDirectAdminRelayFetch` module. The only direct SDK changes add `titan_workforce`
to existing plugin type/gateway/browser allowlists. No identity, issuance, CSRF,
authority or revalidation behavior is forked. The consumer validates and presents the
published #811 projection source, freshness and evidence references. Lifecycle
proposals remain gated by host-published controls and shared intent ingress; an
acknowledgement is never upgraded to a verified outcome.

The #811 projection data schema `titan.workforce-cockpit.v1` merged to main at
`14163faa` and remains present in current main `64561e4d`. The earlier record
was checked at `ccf8010a`; the main-snapshot `468d42b1` rerun is recorded below.
The schema contains
`discovery: {company_id, workers, controls: []}` and `status: {company_id, work}`.
Its owner reads canonical company-filtered Workforce/run records. The contract is
merged to main, but is not live-certified. Controls are explicitly
empty and do not confer execution authority. Production never uses fixture data
or grants authority from a control descriptor.

## Concrete integration blockers

| Owner | Observed published behavior | Needed for functioning cockpit |
|---|---|---|
| #1049 / #1204 | PR #1204 merged to main at `75cc7f02` from head `5b1275df`; the tested SDK implementation source remains `e428b67b`. It consumes the canonical #302 session issuer/registry, publishes trusted browser session context and a separate server-only Workforce/Zero exchange. The browser SDK hashes the opaque context revision to the relay's bounded `ctx1_` assertion; the gateway checks it against current #302 state. Typed unsupported Workforce actions map to a sanitized 403. The SDK preserves valid sibling session state on 403 and invalidates on authentication/context failure; bridge failures distinguish rejected request/session from owner outages. The host contribution registry supports SDK compatibility `1.0.0` and degrades an incompatible major independently. The plugin reads trusted host CSRF metadata and never creates identity/CSRF from CGI, environment, query or form data. | Workforce tags a 403 only when the shared SDK's governed-intent route rejects, then revalidates before restoring data. A stale response cannot recover a cleared company view. A 403 during post-acceptance projection refresh clears the view and tells the operator to inspect canonical history. Submit stays disabled after a denial until manual refresh. Production issuer/identity provisioning, trusted DirectAdmin HTML CSRF bootstrap, source credential verification and host/cookie-port commissioning remain unverified. |
| #811 / #1201 / #1242 | PR #1201 merged to main at `14163faa` and #1242 merged production dependency composition at `8c1161f291d07ecf344ae062b2349c2a13280410`, still present at current main `64561e4d`. It contains `services/workforce/src/directadmin-workforce-owners.ts`, the optional `/v1/directadmin/*` Fetch mount, and operator-owned company placement/store ports. The owner reads company-filtered canonical `SqliteWorkforceStore` workers/work plus `SqliteRunStore.findByWork`. Outer projection is `{company_id,source,freshness,evidence_refs,data}`; `data` is `{schema:'titan.workforce-cockpit.v1',company_id,discovery,status}`. Worker/work records are company-bound; `discovery.controls` is explicitly `[]`. `requestIntent` validates/revalidates context then denies with a typed 403; it writes no state/event/evidence and fabricates no receipt. | The composition is in main, but not live-certified. Its production factory still needs commissioned operator dependencies, verified identity provisioning and pinned HTTPS `publicOrigin`; native company stores require owner attestation. The original extracted host run used pre-composition snapshot `c883304a`, #812 `8cae7034` and #1049 SDK `e428b67b`. The latest extracted integration packages exact current-main `64561e4d` host/runtime/storage code and supplies the required company-placement registry/opener through canonical SQLite adapters over disposable test records; the empty-controls read-only route does not open a business store. The consumer revalidates after an intent-route 403; a denied refresh after accepted ingress is never called an action denial. The host exposes no authorized lifecycle control or successful action receipt, so the cockpit honestly renders read-only. |
| #1182 / #1188 | PR #1188 merged the hosted conversation retry-identity fix at `ae6db36d`; the owner contract preserves company/actor/device/session/context/conversation/operation/correlation/trace/idempotency and events. | The Workforce panel still does not integrate conversation transport. Add it through the shared gateway consumer when #1182 publishes its usable contract; preserve canonical conversation context and route consequential requests through governance. Do not create a plugin-local conversation ledger. |
| #302 / #1183 / #1240 | Live main `64561e4d` includes credential verification and durable current-company session work (`ae0d2c8e`), company-placement/storage contracts, #1243 session replacement/outage distinctions, and #1242's hosted runtime composition. The shared resolver head `68e4804f594503f3a205d2caefdb2f9f75701ee4` has 61 security and 63 web regression tests recorded by its owner. | This is implementation and regression evidence, not proof that upstream credentials are verified or protected provisioning is commissioned. Production issuer credentials, protected provisioning, trusted DirectAdmin CSRF bootstrap, approved audience-bound Workforce handoff, and real host/session commissioning remain upstream. |
| #812 / #1211 / #1245 | The RAW endpoint and published fetch adapter remain the #812 routes consumed by #1050; no parser/proxy is duplicated. Current main `64561e4d` includes merged PR #1245, which removed the experimental Apache `:443` filter and makes the production RAW loader return sanitized `503 cookie_boundary_unverified` on every origin. No supported production config or working relay exists. The latest disposable integration passes the in-process fake-loader contract against exact main and does not test Apache, DirectAdmin CGI, or a real cookie boundary. | Verify an approved cookie boundary and private transport on a real disposable Apache/DirectAdmin host before enabling a production path. Exact CGI `HEADERS`, port-2222 session/cookie isolation, protected relay config, actual host and #811 operator dependencies remain uncommissioned. Never place credentials in URLs or assume a `:443` rule affects DirectAdmin `:2222`. |
| #648 / current reproducibility | Live main `64561e4d` includes #1201, #812, #1183/#1240, portfolio packaging, #1048/#1209 Developer Portal work, #1241 environment alignment, #1243 session recovery, #1244 DirectAdmin request transport, #1242 hosted runtime composition, #1245's disabled production relay, and #1247 authority regression hardening. | `gate:fast` and full `gate` results recorded below were run on code baseline `14163faa316ac6236e88167b7c8d8a5e95007c7e`, before this main advance. The known TASK-128 duplicate migration prefixes 151, 152 and 177–183 belong to #648's convergence scope; verify them on current main before using that as a current gate result. #1084 / #1179 owns shared web/index/CI repairs, not migration ownership. No migrations were renumbered here. |

Coordination requests are recorded on #1204 and #1201. The current bounded
request and candidate file path are recorded on #1201. They are real missing
upstream connections, not permission requests to recreate their owners.

## Verification

- The real Chromium package test boots the extracted role entrypoint and actual bundled SDK against a controlled localhost host. Its body matches the #811 projection record fields but the server responses, context, cookie, session and CSRF nonce are test-only fixtures. It checks source/freshness display, an empty controls list causing explicit read-only rendering with no intent POST, company isolation, logout/denial, REQUESTED-only receipt display, a late response across actual page navigation, full reload, synthetic lifecycle events, and local expiry clearing a visible receipt without an HTTP 401. This is consumer acceptance, not a live #811 route or production-session certification.
- Hosted SDK integration now uses the actual #302 signed issuance service, registry, DirectAdmin session bridge and context switch cookie rotation. It asserts and forwards the exact SDK `X-Titan-CSRF` nonce. Only projection/intent owners remain explicit fixtures; no actual hosted endpoint is claimed. It tests company A to B isolation, duplicate in-flight intent suppression, cancellation ingress, revoked credential rejection and `COMPLETED` remaining unverified.
- `node --test apps/directadmin/workforce/tests/sdk-contract.integration.mjs`: 4 tests verify shared package/contribution acceptance, fail-closed executable roles without commissioned CSRF, and packaged UI lifecycle behavior in Chromium.
- `node --test packages/titan-platform/tests/directadmin-bridge.test.mjs packages/titan-platform/tests/directadmin-plugin.test.mjs packages/titan-platform/tests/security-boundary.test.mjs packages/titan-platform/tests/security-session-registry.test.mjs packages/titan-platform/tests/security-session-credentials.test.mjs`: 194 shared bridge/SDK/security tests passed.
- `PLAYWRIGHT_BROWSERS_PATH=/tmp/1050-playwright node --test packages/titan-platform/tests/directadmin-browser.browser.mjs`: 1 browser suite passed in system Chromium via a temporary Playwright executable path. The temporary browser path did not change system trust or server settings.
- Independent review verified malformed `run_id` coercion and CSRF header forwarding; it passed the focused controller/browser suite and independently reran the canonical hosted integration 1/1. Earlier fixes cover false VERIFIED fallback, stale refresh after revocation and malformed evidence refs.
- The independent consumer review found and the current diff fixes two recovery hazards: stale 403 responses could have restored invalidated company state, and post-acceptance read denial could have been mislabeled as action denial. #811's typed denial maps to 403 in the exact extracted relay-to-host run and writes no business state or events.
- `node_modules/.bin/tsc -p packages/titan-platform/tsconfig.json --noEmit false --outDir packages/titan-platform/.test-dist --module NodeNext --moduleResolution NodeNext --isolatedModules false`: passed after a temporary local normalization of the two malformed trailing literal `\\n` sequences in the current-main `src/index.ts` and `tsconfig.json`; both original files were restored byte-for-byte and `.test-dist` was removed. The typecheck used locked `jose@6.1.3` unpacked under `/tmp` and an ignored local node_modules link because that exact version was absent from this workspace cache; the already-declared storage/tsx workspace links were also restored locally. No package/lock/compiler repair was made.
- Package builder produces flat `titan_workforce.tar.gz`, SHA256 sidecar and verifies extracted modes/content/shared SDK validation/staging preflight. Extracted role entrypoints execute.
- Complete consumer/browser/hosted SDK suite, using the SDK source from #1049 implementation head `e428b67b` (current PR head `2e41044` only merges the main README; bundle SHA256 `c45d611fbdee263cd248e4c7f9736bbe64fa80d1b7cadb19c022e27fa970db95`): `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium TITAN_COCKPIT_SDK_MODULE=/tmp/1050-sdk-e428.mjs TITAN_BRIDGE_FIXTURE_MODULE=/tmp/1050-sdk-e428/packages/titan-platform/tests/fixtures/directadmin-bridge-fixture.mjs node --test apps/directadmin/workforce/tests/*.test.mjs apps/directadmin/workforce/tests/sdk-contract.integration.mjs apps/directadmin/workforce/tests/hosted-sdk.integration.mjs`: **39/39 passed**.
- The exact #1049 e428 DirectAdmin and Workforce-exchange focused suites passed **112/112**; the current #812 Server Node suite passed **101/101**. SDK compatibility-major degradation/recovery passes for Workforce's declared `sdk_compatibility: 1.0.0`.
- On host/identity source snapshot `c883304a662738fe480ec1e5d044fdeb0c4c879e`, the #302 credential/registry/Workforce-exchange suites passed **125/125** under Node 22.23.3; current-company web session regressions passed **27/27**; #1240 company-placement and storage resolver tests passed **21/21**. The package test TypeScript compile passed. These focused checks complement, but do not replace, the repository gate or upstream credential/provisioning commissioning. Main later advanced to `ccf8010a`; these counts are recorded against the archived snapshot, not claimed as rerun on that newer head.
- The extracted relay-to-host integration passed against #811 host/runtime/storage sources archived from main `c883304a662738fe480ec1e5d044fdeb0c4c879e`, #812 tested head `8cae7034f6d2ec7c9063ac0c3aba40c6f41b3d89`, and #1049 SDK source `e428b67b34779e49f4dbc8d3e80b193e8737eb13`. It covered missing-config 503, company-filtered read/evidence, read-only controls, isolated invalid-CSRF 401/cookie clearing, typed action 403/preserved valid session, company switch, and upstream expiry. No work/event writes occurred; 14 RAW requests and 15 hosted routes were observed. The signed identity/nonce and injected HTML meta remain the #1049 disposable fixture; this is not production credential/provisioning commissioning. Main later advanced to `ccf8010a` through `ae6db36d`, #1197 portfolio packaging, and #1048/#1209 Developer Portal hardening; these commits do not alter the tested host/Workforce route paths. This run predates #812's current `89ff2427` config-v2/Apache-cookie-boundary change; it proves nothing about that configuration or real Apache cookie isolation.
- Exact runtime recovery for the composed host test: official Node v22.23.3 tarball SHA256 `df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`; official `better-sqlite3@12.11.1` Node ABI 127 prebuild installed with `prebuild-install@7.1.3`; targeted `npm rebuild` succeeded using the existing prebuild under Node 22/npm 10.9.9. No node-gyp compilation, PNPM security setting or repository dependency was changed.
- Independent security review at #1049 head `6289e084` found no concrete consumer recovery regression and passed 28/28 focused tests. That review preceded the later SDK compatibility-major addition in `e428b67b`; the exact e428 source's 112 focused tests and the consumer/relay suites pass as recorded here.
- On code baseline main `14163faa`, `PATH=/tmp/1050-pnpm-bin:$PATH PNPM_HOME=/tmp/1050-pnpm-home XDG_DATA_HOME=/tmp/1050-xdg-data bash scripts/gate.sh --fast` and full `bash scripts/gate.sh` passed lint then stopped at the recorded TASK-128 duplicate migration prefixes 151, 152 and 177–183. Current main advanced to `ccf8010a` with #812, distribution-gateway, #1197 portfolio packaging, #1183 credential/session, #1240 company-placement, and #1048/#1209 Developer Portal changes after that run; the historical gate has not been rerun on current main. Migration convergence remains with #648; #1084/#1179 owns shared web/index/CI repairs. No migrations were changed here.
- On main snapshot `ccf8010a` after the merge, DirectAdmin portfolio packaging tests passed **7/7**, Developer Portal owner tests passed **7/7**, the Server Node package manifest validator passed, and lifecycle shell scripts passed `bash -n`. These checks do not change or certify the separate Workforce package contract.

The consumer validates the outer source/freshness/evidence contract and shows those fields under Health. The host's current `controls: []` is rendered as read-only. It does not inject its own caller/CSRF bootstrap. Company-switch, logout, real navigation with a late acknowledgement, full reload and BFCache handler tests clear receipts. Intent-route 403 revalidation restores current data only while the same action remains current and fresh session resolution succeeds; 401/revocation clears it. A 403 after accepted ingress keeps the view cleared and requires history inspection. The local SDK expiry test clears a populated receipt at/after `expires_at` without HTTP 401. The earlier version 0.1.4 archive is historical; the current version 0.1.5 candidate and checksum are recorded in [WORKFORCE-PACKAGE-VERIFICATION.md](WORKFORCE-PACKAGE-VERIFICATION.md). No server install occurred.

No production/server deployment or credentials/security-setting changes occurred.
No live DirectAdmin/VPS certification has run. Package test fixtures are excluded
from the install archive; native runtime/server tests belong to their owners.

## Mission scope retained

All 28 numbered acceptance criteria, implementation checklist and subsequent
Time Attendance/credential deltas remain in open #1050. Consumer safety tests
partially support company isolation, identity/authority separation, evidence
labelling and truthful reconnect; they do not certify current canonical roster,
persistent runtime independence, six native-agent journeys, governed conversations,
provider rebinding, hierarchy/teams/Missions/approvals, trust/autonomy/credentials,
capacity/value/staffing, knowledge scopes, Zero contribution or live installation.
The later attendance lifecycle/offline/overlap/correction/payroll requirements are
not implemented by this cockpit slice and have not been administratively closed.

Rollback is a revert of the cockpit commits. No customer/business state or
migration exists in the plugin. Shared prerequisite history remains owned by
its original missions.

## Previous main-snapshot continuation run — 468d42b1

The exact main snapshot used for these checks is
`468d42b1a93401a2357f2da253f639694cb4a937`; it merged PR #1143 from branch head
`f2f750e434f9f82d964920351ebc80245bd680f3`. Live main has since advanced to
`23300c79185f6dc7f8c4b6ab3ae11ac8aa114906` through #1196. The intervening diff
touches mobile and `.github/workflows/titan-ci.yml`, not the tested DirectAdmin
Workforce, Server Node, host or SDK source paths. The old #1143 head remains an
ancestor of live main, but the `agent/issue-1050` remote ref was deleted after
merge. This local verification does not recreate the branch, push, or open a
replacement PR; #1050 remains open.

The #1049 SDK was compiled from the exact main snapshot above; bundled
module SHA256 is
`57d4776fdaee9359aa669d0b756392614772051cb023cce71d05c9bafc269077`. The new
Workforce package candidate is version **0.1.5**, with 19 files and archive
SHA256
`0e7cdf5fae1bcb0b459c0aab2c557b442cbf6eb14ff6e9b1edbf70529e09ce31`.
The staged install/update/uninstall scripts and role executables passed local
preflight only; nothing was installed into DirectAdmin.

On the current SDK candidate, the Workforce consumer, browser, hosted-session,
and package suite passed **39/39**. The hosted-session regression drives the
actual #302 fixture issuer/registry and current #1049 SDK: an owner-unavailable
503 clears the company projection but does not invalidate the still-valid
DirectAdmin session, retry recovers the same company, and a revoked-session 401
invalidates the session and leaves the cockpit denied. The browser test for
canonical `controls: []` confirms the exact read-only explanation and no intent
submission. Company-switch, revocation, stale response, denial, evidence and
receipt checks remain in the suite.

The extracted host integration was rerun from exact archives at the tested main
snapshot for #811 Workforce/storage, #812 Server Node and the #1049 SDK. It extracted the
Workforce 0.1.5 and Server Node 0.3.0 packages, exercised the actual host routes,
and passed 14 RAW requests / 15 hosted routes, including company A/B isolation,
missing-config 503, CSRF denial, typed lifecycle denial with no work/event
writes, and expiry clearing. The relay config used the v2 shape only as a
temporary `NODE_ENV=test` fixture; its `cookie_boundary` marker was synthetic.
This is not Apache, DirectAdmin CGI, cookie-port isolation, production issuer, or
host commissioning evidence. `controls: []` still means the host publishes no
authorized lifecycle action or successful governed receipt.

**Known commissioning blocker:** the parent confirmed that #812's experimental
Apache `:443` cookie filter fails open when the Titan cookie is split across
duplicate physical `Cookie` headers. The v2 marker cannot prove the filter is
installed or correct, and a duplicate-header check in the `:2222` RAW parser
does not test or close the separate `:443` boundary. Do not commission or install
until #812 closes that failure and the filter is independently verified on an
authorized disposable Apache/DirectAdmin host using cookie-name-only evidence.

Other exact host inputs still missing are verified #302 production issuer
credentials and protected provisioning; a trusted HTML CSRF bootstrap and
approved audience-bound DirectAdmin-to-Workforce handoff; configured #811
operator dependencies and private `publicOrigin` reachability; actual DirectAdmin
`HEADERS`, POST-stdin and separate `Set-Cookie` behavior; and a host runtime that
meets the Server Node prerequisite. The prior operator-supplied host report
listed Node 16.20.2, below the required version, and is not independently verified.
No credential, host, service, firewall, DNS, package or security setting was
changed. Full roster/detail, conversations, hierarchy/Missions, trust/autonomy,
capacity/value, and evidence journeys remain outside this bounded consumer
slice, so #1050 stays open.

## Hosted CI coverage audit

The merged PR #1143 head `f2f750e434f9f82d964920351ebc80245bd680f3` has three
relevant build/test workflow runs: DirectAdmin plugin portfolio `36997716622`,
Titan Zero CI `36997716686`, and source evidence index `36997716733`. The
separate Agent Claim Gate had four attempts on that head: final run
`36997847921` succeeded, one earlier run failed, and two were cancelled. The
build/test job steps cover portfolio packaging, Dev Access, Server Node
package/lifecycle checks, general type/build/regression gates and source
indexing. None executes
`apps/directadmin/workforce/tests/*.test.mjs`,
`sdk-contract.integration.mjs`, `hosted-sdk.integration.mjs`, or
`relay-host.integration.mjs`. `workforce-verification.yml` is scoped to
`services/workforce/**` and `packages/workforce/**`; it does not trigger on the
DirectAdmin plugin. The live-main workflows were inspected after #1196 and
refreshed against `d508a269` after #1243; the DirectAdmin portfolio workflow
still has no Workforce consumer test step, and the generic Workforce workflow
still filters out
`apps/directadmin/workforce/**`. Therefore the 39/39 consumer result and the
extracted host run above are local verification evidence, not hosted CI coverage.

Ownership check: #1084 is closed and its #1179 CI convergence PR is merged. The
open DirectAdmin portfolio certification issue #1157 has an active
`agent/issue-1157` branch at `b7882d66019c94084a0324a8e1a8ce44290ff50f`; its
acceptance requires a CI/live-host verification record, although its current
diff does not change workflows. The bounded CI follow-up belongs with #1157:
  add a secretless Node 22 job that builds the canonical SDK bundle from the
  checked-out source, runs the Workforce consumer/browser/hosted-session/package
  suite, and runs the extracted relay-to-host fixture by injecting a fake config
  loader into the extracted module in-process. Do not use a config file, legacy
  environment setting, or production RAW process to enable fixture forwarding.
  Keep Apache boundary and production commissioning explicitly outside that
  fixture. No workflow or separate claim was added here; until the #1157-owned job
  actually executes these paths, do not report hosted cockpit test coverage.

## Pre-#1245-merge continuation run — main 8c1161f2 (2026-10-02)

Current main is `8c1161f291d07ecf344ae062b2349c2a13280410` after #1242/#1244.
The existing claim branch normally merged it at
`a1d364828991289254b04cdc1e16e0f92a5c1458`; the branch still contains the merged
#1143/#1145 history and no second claim was created. The DirectAdmin SDK source
tree is unchanged from `d508a269`; #1242 added required company-placement and
store-opener ports to production hosted-runtime composition. No shared owner or
workflow was edited by this continuation.

The #1049 browser SDK bundle was compiled from exact main `8c1161f2` source with
Node v22.23.3. The official Node archive SHA256 is
`df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`; the
bundle SHA256 is `9d94cb80dbb0e7df15388efb1de2262e6c26af041f66a1c5d4944045fc491c9a`.
The bridge owner regression passed **83/83**, and the Workforce
consumer/browser/hosted-session/package command passed **39/39** against this
bundle. Those tests cover company switching and isolation, owner outage versus
session revocation, denied authority, and truthful evidence/receipt behavior.

The extracted relay-to-host integration uses exact #811 Workforce/storage/runtime
and #812 Server Node source from main `8c1161f2`, plus the #1049 bridge fixture.
Because #1242 requires company-placement ports, the fixture initializes the
canonical SQLite registry schema and inserts disposable test-only placement
records for `company-a` and `company-b`; it supplies the canonical SQLite
registry and opener adapters. The test proves a missing placement fails closed.
The empty-controls projection does not open a company business store. The
integration passed **14 relay-module requests / 15 hosted routes**. With no relay
configuration, current main's production default returned sanitized 503
`relay_not_configured`. Fixture forwarding injects a fake config loader into the
extracted module in-process; it uses no config file or CGI environment variable
and does not spawn the production RAW executable. The same harness passed against
unmerged #812 draft PR #1245 at exact head
`589658ef10cf4c66af5ebb574799f281b126ced5`; that draft returned sanitized 503
`cookie_boundary_unverified` by default. These are candidate compatibility
checks, not Apache/DirectAdmin, production identity, or commissioning evidence.
The hosted owner still publishes `controls: []`, so no authorized lifecycle
control or successful action receipt is available.

At the time of this run, main still contained the experimental Apache `:443`
filter, which failed open when the Titan cookie was split across duplicate
physical `Cookie` headers. PR #1245 subsequently merged to main as
`faab3c5c9bdfd90179d5d3bfee21c479dceb3613` and removed that filter while
disabling production RAW forwarding. The current main no longer has that filter,
but it still has no working production relay. The `:2222` RAW parser and
in-process test seam do not verify a live cookie boundary.

Other missing inputs remain verified #302 production issuer credentials and
protected provisioning; trusted DirectAdmin HTML CSRF bootstrap and an approved
audience-bound Workforce handoff; configured #811 operator dependencies and
private `publicOrigin`; actual DirectAdmin CGI `HEADERS`, POST-stdin and separate
`Set-Cookie` behavior; and a supported host Node runtime. Full #1050 roster/detail,
conversations, hierarchy/Missions, trust/autonomy, capacity/value, attendance,
department pack, earned autonomy, and evidence journeys are not proved by this
bounded consumer/package work. #1050 remains open.

## Current-source continuation run — main bfbb06a5 (2026-10-02)

Current main is `bfbb06a5a22591100e2c0101e6598bee9c6f4589`, merging #1246 head
`87deeb75ae8341eb88c7b870bd965075f0347e2a`; it includes #1245 merge
`faab3c5c9bdfd90179d5d3bfee21c479dceb3613` and #1241. The remote
canonical claim advanced through Jason's commits `a7491161` and `87deeb75`; this
continuation preserves both histories with a normal merge. The current integration
uses exact #811/runtime/storage and #812 source archived from this main commit.

The #1049 browser SDK source tree is unchanged across this main advance. It was
bundled with Node v22.23.3 from exact `bfbb06a5` source; the SDK module used here has
SHA256 `540f2cef873dd51bcdf7bea75c3ac519630cdc3345128f38f0f396957d31a448`.
The Workforce consumer/browser/hosted-session/package suite passed **39/39**;
the shared DirectAdmin session bridge suite passed **83/83**; and the portfolio
package script suite passed **3/3**.

The relay-to-host fixture passed **14 requests / 15 hosted routes** against this
exact main's hosted owner, storage, SDK and relay source. The production RAW
default returns sanitized `503 cookie_boundary_unverified` and makes no upstream
request. The fixture then
injects its fake loader in-process into the extracted relay module; no file,
environment variable, production RAW process, Apache boundary or real DirectAdmin
CGI is used to enable traffic. The #1242 host dependencies are supplied through
the canonical SQLite placement-registry/opener adapters with only disposable
test placement rows; unknown company placement fails closed, and empty controls
do not open a company business store. Company switch, evidence projection, CSRF
denial, typed governed-action denial without DB/event writes, and expiry clearing
all passed. The host publishes `controls: []`, so there is no authorized
lifecycle control or successful receipt to demonstrate.

The two deterministic 19-file v0.1.5 package builds, checksum, SDK hash,
extraction, modes and staged install/update/uninstall preflight are recorded in
`docs/directadmin/WORKFORCE-PACKAGE-VERIFICATION.md`. An independent read-only
security review found no issue in the fixture seam or package provenance. No
hosted Workforce CI job ran these tests; that integration remains with #1157.
Live identity commissioning, trusted CSRF bootstrap, private relay transport,
DirectAdmin CGI behavior and the wider roster, conversations, lifecycle,
trust/autonomy, attendance, department and evidence journeys remain open. #1050
is partial and stays open.

## Latest-main continuation run — main 64561e4d (2026-10-02)

Current main is `64561e4d077ec07a3cb40dfb43284b0e7dff4dbf`, which merges #1247.
That change updates separate authority implementation and regression files; it
does not touch the DirectAdmin SDK, hosted Workforce owner, RAW relay, Workforce
consumer, package contract, or their tests. The exact-main archive and SDK bundle
were refreshed and the bounded suites below were rerun after synchronization.
The company-placement fixture remains canonical SQLite registry/opener adapters
with disposable placement rows, and the production RAW default remains a sanitized
503 without upstream traffic. The fake forwarding loader is injected only inside
the extracted module in-process.

The latest deterministic 19-file package candidate, SDK bundle hash, consumer and
bridge test results, package tests, and extracted relay result are recorded in
`docs/directadmin/WORKFORCE-PACKAGE-VERIFICATION.md`. The new main merge does not
change the security limitations or acceptance scope: there is still no live
DirectAdmin/Apache cookie proof, hosted production identity/provisioning, positive
governed control or receipt, or shared conversation integration. #1050 remains
partial and open.

## Relay fixture review follow-up — source commit 29f01078 (2026-10-02)

After the independent #1248 workflow review, the #1050 fixture now executes the
identity fixture's registered `t.after` cleanup callback before removing its
temporary workspace. It also requires the exact current #812 production default
`503 cookie_boundary_unverified`; it no longer accepts the older generic
`relay_not_configured` response. The fixture source commit is
`29f010786843ff529de2f9974fcb2e8e740df234`; file SHA256 is
`e66aee498fb4ba43a42c5f9c4267ab71debbafc3f8dee5b45eb1deaf3b7dafab`.

The focused Node v22.23.3 extracted relay test passed **14 requests / 15 hosted
routes** against exact main `64561e4d077ec07a3cb40dfb43284b0e7dff4dbf`. It
observed the exact disabled production response with no upstream request, then
used only the in-process fixture loader for local company, denial, and expiry
scenarios. It does not prove an Apache/DirectAdmin CGI or live cookie boundary.
The #1157 workflow still owns updating its pin to this fixture commit and hash.

Exact focused command:

```sh
TITAN_WORKFORCE_HOST_ROOT=/tmp/1050-extracted-main645/host \
TITAN_SERVER_NODE_SOURCE_ROOT=/tmp/1050-extracted-main645/host \
TITAN_COCKPIT_SDK_MODULE=/tmp/1050-sdk-main645.mjs \
TITAN_HOST_SDK_MODULE=/tmp/1050-sdk-main645.mjs \
TITAN_BRIDGE_FIXTURE_MODULE=/tmp/1050-extracted-main645/host/packages/titan-platform/tests/fixtures/directadmin-bridge-fixture.mjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
/tmp/1050-node22-dist/bin/node \
--import /workspace/Titan-Zero-Field-Service-Workforce/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs \
apps/directadmin/workforce/tests/relay-host.integration.mjs
```

## Cleaning-first continuation — current main 9fd2e4e8 (2026-10-02)

This continuation stays on the existing `agent/issue-1050` claim. It normally
merged current main through branch merge `732832e0`; no second claim, force push,
owner change or production action was made. The consumer package source is
`6b4658457973f2260b22c77f1f6e365966920802`, version 0.1.6. The upstream
ownership history above remains intact.

The default page is now cleaner-team-first. It groups only the current
company-filtered Workforce roster, shows canonical hosted work, and opens the
existing governed action form only for the exact host-published reassignment
descriptor. The form remains explicit review; the owner rechecks company,
authority, fresh approval, READY state, target capabilities and assignee CAS.
Receipts remain `REQUESTED`; accepted evidence appears only from canonical
refresh. The skills view consumes the SDK's versioned company/context-bound
canonical proof projection and never makes an assignment or authority decision.
The controller additionally fails closed if displayed nested rows, summaries or
evidence do not match canonical flat rows and current roster members. There is
no plugin-local roster, proof, worker profile, persistence, identity, runtime or
authority state.

Generic hosted WorkItems still lack cleaning service, site, area checklist,
supplies and visit time; the view labels these unavailable rather than calling
a generic item a cleaning visit. The open draft #1393 binds six cleaning profile
responsibilities to existing adapters for suggest-only plans and lists ten as
unavailable. It does not publish current-company worker/skill/team bindings and
uses the legacy web session/database, so this consumer does not use it as
DirectAdmin-hosted truth. #1384, #1372 and the #811 runtime composition remain
the respective worker/profile, proof-source and hosted-owner dependencies.

Independent read-only review found two malformed-skill projection gaps: a nested
proof could diverge from the canonical flat proof and malformed summary/evidence
fields could crash the Skills view. The controller now validates all rendered
rows, exact worker/capability identity agreement, company roster membership,
authority-neutral flags, evidence list types and displayed summary consistency;
adversarial controller cases cover each condition. Follow-up review found no
remaining actionable security finding.

Verification on Node v22.23.3:

- `node --test apps/directadmin/workforce/tests/*.test.mjs`: **50/50 passed**.
- With the current-main SDK bundle SHA256
  `29a69a397692d142f25e47ba41e8c97de7eb193d6ea1ace0c24ca970cfb6d5db`, the
  hosted-SDK and package-contract integration command passed **6/6**, including
  real #302 signed fixture issuance, company switching/revocation and Chromium
  package lifecycle behavior.
- The actual SQLite owner E2E passed **8/8** using the exact older compatible
  #1252/#1253 source pair `aff11521` / `f6710e9d` with this consumer package
  source. It verifies authority denial, assignee CAS, evidence lineage,
  idempotent replay, pre-submit abort and company isolation. It also
  characterizes the existing post-commit cancellation defect: state/event
  committed, ledger evidence is `UNCERTAIN`, but the owner returns 403 and replay
  returns 503 without a second effect. This is not accepted behavior.
- Current published #1252 head `31e57e11` requires #302's
  `DirectAdminSessionBridge.bootstrapBrowserSession`; current #1253 head
  `b969acfe` does not contain that method. The direct owner run remains pinned to
  the older compatible pair until the owner branch is reconciled with the new
  bootstrap route.
- The current-main v0.1.6 package was rebuilt twice byte-identically. Its 19-file
  archive SHA256 is recorded in
  [WORKFORCE-PACKAGE-VERIFICATION.md](WORKFORCE-PACKAGE-VERIFICATION.md). The
  checksum, extraction and staged install/update/uninstall preflight passed;
  they do not certify a live DirectAdmin/Apache install.

Current-main hosted projection still defaults to `controls: []` where no
management grant is present, and the #812 production relay remains disabled
until a real cookie boundary is commissioned. Verified upstream credentials,
protected identity provisioning, trusted DirectAdmin bootstrap, the latest
#1252/#1253 source reconciliation, positive current-main governed action,
conversation transport, real-host installation and the remaining #1050 mission
criteria remain outstanding. Keep #1050 open.

## Historical browser-bootstrap continuation — main 99271ea4 (2026-10-03)

This is a continuation of the existing #1050 claim and `agent/issue-1050`
history. The branch normally merged current main `99271ea4` in merge
`91ffb77a`; no remote `agent/issue-1050` ref or active same-branch worker was
present at inspection. Earlier #1143, accepted #1145 and merged #1260 history
remains intact. #1050 stays open.

The browser now consumes the #1300 role-local nonce/bootstrap RAW contract:
same-origin POSTs use only
`?headers_to_env=yes&pipe_post=yes`, an empty body, and no content type. The
browser never reads or forwards DA or Titan cookies. Only the exact SDK
`POST /v1/directadmin/bootstrap` request maps to the role-local bootstrap RAW
route; every other SDK request continues through #812's fixed relay helper.
Nonce and session state remain in memory and in the SDK's HttpOnly cookie.

Independent review found two reconnect races and their fixes are now covered by
the browser/SDK integration: a late bootstrap response cannot clear a newer
invalidation flag, and a nonce response completing after invalidation cannot
fall through to the SDK's retained CSRF token. The tests hold each RAW response,
invalidate the shared session, verify that no old company state returns, then
verify that an explicit retry obtains a new nonce/bootstrap. Company changes,
revocation, expiry, logout, action denial, and stale receipts continue to clear
or revalidate company-scoped state. The follow-up security review found no
remaining actionable issue in this bounded browser boundary.

Verification used Node v22.23.3, the SDK source from main `99271ea4` (bundle
SHA256 `9f28ab5ea84aaa6015f8cbf0a5fe399a791924c52edb2689d7eeb824f2a2d408`),
Chromium, and disposable identity/company fixtures:

- App/browser/package, hosted SDK, and controlled #302/#1049 session contract:
  **57/57 passed**.
- Extracted Workforce package + Server Node relay + current #811 hosted source:
  **14 relay requests / 15 hosted routes**. Verified the production default
  returns `503 cookie_boundary_unverified` without upstream traffic; the
  in-process test-only loader then exercised read-only Company A and B,
  evidence, empty controls, invalid-CSRF denial, governed-action denial with no
  work/event effects, and upstream expiry.
- Two deterministic v0.1.6 builds were byte-identical. The 19-file archive
  SHA256 is `89c2e2cffa5e58a98d1e51244dbd10ea1883e551aadddb52a41b1221a0e04974`.
  Independent extraction, checksum, executable role entrypoints and staged
  install/update/uninstall preflight passed. The candidate currently excludes
  #1395 RAW handler files and is not ready to install.

At that earlier 99271ea4 checkpoint, the extracted RAW tests used a synthetic
cookie jar/upstream; they did not launch
#1395's scripts, a DirectAdmin CGI process, Apache, or a live host. PR #1395
was draft and its SQLite-backed host tests were blocked by missing
`better_sqlite3.node`. #812 production forwarding remains disabled pending a
verified real cookie boundary. Protected identity provisioning and upstream
credentials are not commissioned; #811 currently exposes no control without a
current grant, so this run proves denial and read-only projection, not a
positive governed action. The broader conversation and Workforce mission
criteria remain open.

## Coordinated packaged-browser continuation — main ee3e61da / #1395 head 914c0e1b (2026-10-03)

The existing #1050 continuation normally merged the exact current #1395 branch
head, including its workflow-only follow-up; no RAW/package owner files were
overwritten. Main then advanced to `ee3e61da` with marketing-only changes. The
current 26-file v0.1.6 artifact and checksum are recorded in
`WORKFORCE-PACKAGE-VERIFICATION.md`.

The new Chromium scenario runs the extracted package's User RAW scripts and
adapter through initial authentication, invalidation races, retry, a controlled
company-context event, reload, logout, expiry and read-only presentation. It
requires current-session forwarding and replacement-cookie rotation on renewals,
checks the browser cookie jar and verifies that private nonce forwarding removes
the Titan cookie. It does not execute the Admin/Reseller browser routes, test the
DirectAdmin shebang/OS CGI environment, or prove #302/#811 identity and authority
with production services. Company A/B, hosted endpoints and intent receipts are
controlled fixtures.

Node v22.23.3 verification on this continuation: consumer/browser/package
**60/60**, portfolio/package/RAW contracts **20/20**, packaged RAW-to-#302/#1049
session chain **3/3**. The current #1395 head's hosted package, source-index,
SQLite composition/build, Workforce, canonical-environment, mission-evidence
and slice checks pass; conditional/unrelated jobs are skipped. #1395 and #1405
remain draft. No production deployment, credentials or security configuration
changes were made. Live protected provisioning, verified upstream credentials,
commissioned cookie isolation, and a real DirectAdmin install/reload journey
remain unproved. #1050 stays open.
