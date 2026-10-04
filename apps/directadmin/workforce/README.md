# Titan Workforce — DirectAdmin consumer

Mission [#1050](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/issues/1050).
This package is the operator cockpit for the canonical hosted Workforce. It has
no database, queue, agent executor, identity mapping, credentials or authority engine.
Native Titan FSM remains the default; Frappe is optional.

The first-release presentation is cleaning-first: it opens company-scoped cleaner
teams and hosted work. It does not add non-cleaning workflows or populate live
workers from the cleaning bundle catalogue.

**Packaging candidate only — not live-install-ready.** This archive has only been
validated in disposable test/staging environments; its upstream host contracts and
real DirectAdmin/Apache behavior remain uncommissioned.

## Integration status

The executable role routes render the same company-scoped cockpit. The browser
uses the actual shared #1049 `DirectAdminCockpitSession`, with its fetcher supplied
by the published #812 Server Node adapter.
PR #1201 is merged to main and contains the #811 canonical company-filtered
projection owner and optional `/v1/directadmin/*` Fetch-handler mount. A host with
no current manager grant publishes `controls: []` and stays read-only; the owner can
publish only its typed `titan.workforce.reassign` control after resolving current
company manager authority. All other lifecycle proposals remain unsupported. The API
is not live-certified. Missing commissioned session/bootstrap routes, denied
identity, invalid company data or unavailable host fail closed. The current
implementation is **not certified complete or ready for production**. The browser
uses the #1300 role-local `bootstrap-nonce.raw` and `bootstrap.raw` contract; it
never creates the nonce or an identity from DirectAdmin environment/role, and it
never reads or forwards DirectAdmin cookies. The shared SDK retains the resulting
credential only in its HttpOnly cookie. A fixture-based passing test does not
prove a commissioned host or identity bridge.
DirectAdmin role executables emit the HTML document only. They do not consume CGI
POST stdin, PHP superglobals, query parameters, or host environment variables as
identity/CSRF inputs. The browser SDK makes same-origin API requests; the direct
DirectAdmin POST/environment bridge is not assumed to work. Installed Dev Access
1.1.3 has a reported CSRF failure and #1048 is repairing and verifying that bridge.
The #1300 host adapter draft PR #1395 owns the role RAW entrypoints and
package/install allowlist. Its current head `914c0e1b` is integrated on this
continuation branch by a normal merge; its source-owned files remain unchanged.
The 26-file v0.1.6 candidate packages all three role nonce/bootstrap handlers and
their shared adapter. The browser test extracts that package, invokes the User
RAW scripts, and verifies nonce-cookie stripping plus prior-session forwarding
and cookie rotation on reconnect/company change. The host endpoint remains a
controlled loopback fixture: it does not prove the #302/#811 production identity
chain, protected upstream provisioning, OS CGI/shebang execution, or live
DirectAdmin/Apache cookie isolation. PR #1395 remains draft and its hosted CI
checks are evidence for source regressions, not publication or commissioning.
DirectAdmin documents role entrypoints as executable scripts receiving request data
through process environment; `pipe_post=yes` sets `POST=stdin=true` and delivers the
POST body on stdin. The Workforce test now launches the packaged role executable as
a real CLI child process with that transport and hostile identity/CSRF fields; it
confirms the renderer ignores them. This checks the executable boundary, not a live
DirectAdmin server or a functioning API route.

The #1049 SDK keeps its canonical `/v1/directadmin/...` requests. The cockpit loads
the exact #812 helper at
`/CMD_PLUGINS/titan-server-node/images/directadmin-relay-client.mjs` and injects
`createDirectAdminRelayFetch()` as the SDK fetcher. That helper maps only the SDK's
fixed path/method set to
`/CMD_PLUGINS/titan-server-node/directadmin-gateway.raw`; #812 owns CGI `HEADERS`,
stdin, parsing, filtering and proxying. Workforce adds no parallel parser or proxy.
If the Server Node helper is missing, the page shows an explicit unavailable state;
if its operator config is missing, the relay returns a sanitized 503. The #811 host's
optional Fetch mount accepts a configured HTTPS public origin and checks the forwarded
Host and browser protections. Do not inject caller identity or CSRF from CGI, put a
private token in a URL, or assume Apache 443 can install a handler on DirectAdmin's
port 2222. See the install-readiness checklist in
`docs/directadmin/WORKFORCE-PACKAGE-VERIFICATION.md`.

The current extracted relay-to-host run used Server Node 0.3.0 and the hosted
owner from main `64561e4d077ec07a3cb40dfb43284b0e7dff4dbf`, including #811's
merged production dependency composition and #1245's disabled RAW default. The
disposable host fixture supplies the required company-placement registry/opener
through canonical SQLite storage adapters; those temporary placements are
test-only, and no company business store is opened because the published
controls remain empty. The production default returns sanitized 503
`cookie_boundary_unverified` without an upstream request; the test then injects
a fake config loader directly into the extracted module in-process for fixture
forwarding. It uses no relay config file or CGI environment variable and does
not spawn the production RAW executable. It does not exercise Apache, DirectAdmin
CGI, or a live cookie boundary.

**Commissioning blocker:** merged #812 follow-up PR #1245 removed the experimental
Apache `:443` cookie filter and makes the production RAW entrypoint return
sanitized 503 `cookie_boundary_unverified` before forwarding. There is no
production relay contract to commission yet. DirectAdmin `:2222` RAW parsing,
private transport and cookie behavior remain unverified. Do not install or enable
forwarding until the replacement boundary is independently verified on an
authorized disposable Apache/DirectAdmin host using cookie-name-only evidence.
See the exact run limits and remaining host inputs in
`docs/directadmin/WORKFORCE-COCKPIT-INTEGRATION.md`.

The UI defaults to company-scoped cleaner-team groups, with a hosted work queue,
canonical skill-proof view, roster, governed action form and receipt/evidence view.
The team and queue rows still come only from current hosted company projections;
cleaning role/job catalogue entries are never imported as live workers. When the
host exposes the exact reassign descriptor, operators can open an explicit READY-work
reassignment review from the team/queue view. The browser binds the current projected
assignee, filters out inactive or capability-mismatched target members, then submits
through the shared #1049 intent path. The canonical owner rechecks management authority,
approval, company context and assignee compare-and-set; controls are hidden when the
host publishes no descriptor. A `REQUESTED` acknowledgement is never reported as a
verified outcome, and accepted evidence is shown only after a canonical reread.

The hosted projection does not carry cleaning service, site, area checklist, supply or
visit-time fields. The work queue labels those details unavailable and does not infer a
cleaning visit from objectives, capability strings or evidence references. Skills use
the owner-provided proof projection when available; proof state and contextual
performance never decide assignment or grant authority. The 16 cleaning specialist
definitions and seven job-type templates in the bundle remain declarative metadata,
not active agents or visits. Open draft #1393 binds six profile responsibilities to
the existing native adapters for suggest-only plans and marks ten profiles unavailable.
It does not bind profiles to current-company worker or skill records and its profile
route uses the legacy web session/database; this DirectAdmin consumer does not import
it as hosted truth. #1384 still owns company-worker mapping, and #1372 owns canonical
proof-source composition.

The UI displays canonical roster/worker identity, hierarchy relationships, work
states, owner-provided source/freshness/evidence and receipt references. It preserves
human versus digital identity and never promotes model/provider identity or
DirectAdmin role to execution authority.
A provider acknowledgement or completed agent run is not a verified business outcome.

The Cleaner teams view groups only workers returned for the current `company_id`,
using their canonical `team_id` fields; unassigned workers remain visible. The host
does not provide a named team registry or company-worker cleaning profile binding, so
those facets remain unavailable instead of being synthesized. Projected active status
and capabilities are descriptive inputs, not execution authority.

Unsupported host facets are labelled unavailable, including detailed trust,
autonomy, knowledge, capacity/value, Mission and staffing projections. No sample
roster or fabricated metrics appear in production. Company changes/revocation
clear view state; in-flight responses are discarded. Work persists solely on the
host when the browser closes. The client does not automatically retry mutations.

## Package

Node 22 or later is required on the DirectAdmin host. Compile the canonical #1049
browser SDK to a self-contained ESM module; do not substitute a fixture.

```sh
node apps/directadmin/workforce/tools/package.mjs \
  --sdk-module /path/to/canonical-sdk.mjs \
  --output-dir /tmp/titan-workforce-dist
```

The builder requires the current canonical browser session and package-validator exports,
and runs the shared validator on the extracted final package. It produces a flat `titan_workforce.tar.gz` and SHA256 sidecar, applies
executable modes, extracts the final tarball, compares contents/modes and runs
staging-location preflight. The manifest controls the artifact version (currently
0.1.6). Tests and development fixtures are excluded. The package requires the
separately installed Titan Server Node plugin for its published relay module; it
does not vendor or shadow that owner.

Install/update only checks package/runtime prerequisites. It does not provision
users, secrets, server processes, reverse proxies, permissions or databases.
Uninstall never deletes Workforce/business data. DirectAdmin Plugin Manager owns
code activation/removal. Production installation requires separately approved
commissioning and live certification; no deployment is performed by this work.
For a future approved update, retain the currently installed verified archive and
its SHA256, verify the candidate sidecar, and use DirectAdmin Plugin Manager to
update. Smoke-test the role pages in read-only/uncommissioned state. Roll back by
restoring that retained archive through the manager; plugin rollback must never
restore or delete canonical runtime state, company storage, credentials, revocations,
or evidence. This repository has not performed those host operations.

Role routes: `/CMD_PLUGINS_ADMIN/titan_workforce`,
`/CMD_PLUGINS_RESELLER/titan_workforce`, `/CMD_PLUGINS/titan_workforce`.
Evolution wrappers must preserve the shared gateway's session/origin checks and
allow packaged modules under the host CSP; verify this on a disposable host.

## Verification

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
  node --test apps/directadmin/workforce/tests/*.test.mjs
pnpm gate:fast
pnpm gate
```

The integration checks also use the compiled canonical SDK and real signed bridge/SQLite
identity registry with explicitly fixture projection/intent owners. See
`docs/directadmin/WORKFORCE-COCKPIT-INTEGRATION.md` for exact commands and remaining dependencies.

The browser executable override is optional when Playwright's matching browser
is installed. Controller and browser tests use explicitly marked fixtures,
including malicious cross-company payloads, expired/revoked sessions,
out-of-order responses, duplicate clicks, false verification and hostile text.

## Ownership and reuse

- #1049: shared SDK, authenticated DA session bridge, current company, CSRF,
  handoff/revocation, navigation and contribution infrastructure.
- #811: independently hosted Workforce, canonical registry/work/runs, company-
  filtered DirectAdmin projection and governed intent owner. The default projection
  stays read-only with `controls: []`; only the typed READY reassignment path can
  appear after current manager authority/evidence checks pass. #1182 owns conversation
  transport.
- #1364/#1372: typed canonical skill-proof projection and hosted source composition;
  this package displays the versioned projection without rebuilding its rules.
- #1384 / #1393: native cleaning profile bindings and company-worker mapping. #1393 is
  still a suggest-only draft; neither profile metadata nor adapter plans populate this
  live roster, publish skill proof or grant capabilities, tools or autonomy.
- #302 / #1183: the shared resolver, signed-credential verification and durable
  current-company session path are published in current main; #1240 adds the company
  placement/storage contract. Regression coverage is code evidence only. Verified
  upstream credentials and protected provisioning remain uncommissioned requirements.
- #14/#640: execution/authority; #913: evidence and verified outcome provenance.
- #1045: infrastructure health (linked by role route); #1046: Zero summary.
- #1084/#1179: shared build/index/lock repair is owned centrally and #1179 is merged.
  This package consumes the shared source without implementing a competing repair.

Useful donor semantics are retained at canonical owners: WorkforceService and
SqliteWorkforceStore provide identity/work, runtime dispatcher preserves run and
conversation continuity, native workforce command routes preserve native FSM.
The existing `apps/web/app/workforce/page.tsx` is a marketing page, not a cockpit
runtime donor. Browser Codee Workforce tooling is development infrastructure,
not a production registry. Neither is copied into this package. The earlier
agent/team projection contract was accepted through #1145, and the #1143
consumer/package slice is merged to main. The company-scoped roster/team consumer
slice continues in #1279 under #1050; #1050 remains open for its wider acceptance.

## Remaining mission acceptance

Keep #1050 open. Its complete criteria still require actual hosted integration,
all six native agents certified end-to-end, governed conversation/handoff,
verified provider rebinding continuity, full hierarchy/team/Mission/approval and
trust/autonomy projections, bounded knowledge, attributable value/capacity and
staffing evidence, external competency/credential revocation, Zero SDK summary,
and real DirectAdmin install/update/uninstall/reinstall/theme/session certification.
The issue's later Time Attendance delta (clock entry lifecycle, review, policies,
QR/IP/geofence/device evidence, offline replay, overlap, corrections/void and
accepted-entry payroll export), reusable department packs including Supply & Asset
Continuity, and evidence-backed earned tier/autonomy progression with all required
company authorization gates also remain in #1050. This bounded cockpit continuation
does not declare those outcomes delivered or close the issue.
