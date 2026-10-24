# Authenticated session credentials — #302

Owner: #302 / PR #1183. This additive server-side contract extends the existing
`@titan-zero/titan-platform/security-boundary` owner and its durable registry.
It does not commission a DirectAdmin issuer, migrate historical users, activate
web cutover, or authorize a deployment. All keys used by tests are disposable.

## Configuration and trust

`createSessionCredentialService` receives the canonical `IdentitySessionRegistry`,
a fixed `issuer`, `audience`, `key_id`, `algorithm`, `verification_key`, optional
`signing_key`, and an `upstream` trust configuration with its own issuer, audience,
key ID, algorithm and verification key. Configured algorithms are EdDSA (Ed25519),
ES256, RS256 or HS256. HS256 needs at least 32 secret bytes; asymmetric consumers
should receive verification-only CryptoKeys. Production keys come from configured
existing server secret references/owners, never request fields or committed keys.
The service neither creates keys nor stores credential material. No remote key
URL/JWK discovery is supported. Header parameters other than alg/kid/typ fail.
Changing keys requires explicit trusted composition; no automatic rotation exists.

For DirectAdmin use `directAdminIssuer('https://host.example:2222')`. It returns
`directadmin:https://host.example:2222`; each independent host must have a distinct
namespace. HTTP, userinfo, paths, query and fragment identifiers fail. Generic
`directadmin` and malformed/noncanonical `directadmin:` identifiers fail configuration.
Never derive this configuration from Host or forwarded headers. Other issuers
must also be stable, explicitly configured identity-provider namespaces.

`now` is an optional trusted server clock for testing/composition, not a request
parameter. `lifetime_seconds` defaults to 300 and cannot exceed 900. Issued
sessions and tokens expire no later than their upstream assertion (itself at most
300 seconds). There is deliberately no refresh or extension on company switch.
An expired session needs a fresh authenticated upstream assertion. This bounded
five-minute authentication slice is not a long-lived browser session rollout.

A DirectAdmin session service may additionally configure `workforce_zero_exchange`
with a target issuer/key and lifetime. That configuration has no audience or
surface field: the owner fixes these to `workforce` and `zero`. The source is the
service's configured DirectAdmin session trust plus its exact
`directadmin:<https-origin>` provider and `directadmin.node_id`; the method accepts
only a verified `titan-session+jwt`, never a `titan-login+jwt` assertion or a
request-selected target.

The signing/verification pair is checked before issuance or switch mutates state.
Post-commit delivery/signing failure still fails closed: do not roll back a session
revision or consume the same assertion again. Reauthenticate with a new assertion.

## Signed credential wire contract

All NumericDates are safe integer Unix seconds. Future issuance, missing claims,
expiry, fractional values and overlong lifetimes fail. Audience is exactly one
configured string, not an array. Signature/key/issuer/algorithm/audience/type/time
verification precedes any registry lookup. Caller roles and extra authority claims
cannot create identity or business authority. Invalid credentials and stale or
ineligible identity state fail as `authentication-denied`. A GLOBAL_REGISTRY
storage/transaction failure is the distinct sanitized `identity-registry-unavailable`;
it never returns an authenticated context or permits stale-cache fallback. Consumers
may report service unavailable, then must reverify the credential and current
registry state after recovery. Neither error includes credentials or backend details.

| Credential | Protected header | Required signed claims |
| --- | --- | --- |
| Upstream login assertion | `typ: titan-login+jwt`, configured `alg`, `kid` | `iss`, `sub`, `aud`, `jti`, `company_id`, `device_id`, `iat`, `exp` |
| Canonical session | `typ: titan-session+jwt`, configured `alg`, `kid` | `iss`, `sub`, `aud`, `identity_provider`, `session_id`, `device_id`, `actor_id`, `company_id`, `session_revision`, `context_revision`, `iat`, `exp` |
| Workforce/Zero child | `typ: titan-session+jwt`, fixed Workforce target `alg`, `kid` | canonical-session claims plus `surface: zero` and signed `source_session` reference |

The upstream provider must authenticate the actual human/session, bind the device
and selected company, and emit a fresh unguessable `jti` for one exchange. A DA
role, username, caller principal, bare session ID or headers are not this proof.
`sub` is the stable external subject; `identity_provider` is the configured
upstream issuer. Both remain cryptographically bound in the canonical credential.
The actor is resolved through existing approved external bindings and active
memberships, never supplied by the caller as an identity grant.

Issuance derives a session ID from SHA-256 of the unambiguous issuer/jti tuple.
The existing durable session primary key atomically consumes that assertion:
concurrent exchange, replay after company switch, revocation and process restart
cannot issue it again. No second replay/identity database or authority is added.
The separate #302 DirectAdmin pre-auth nonce add-on is a short-lived page
challenge in the same `GLOBAL_REGISTRY` database and owner; it prevents replay
before a login assertion exists and does not replace session-key assertion
consumption. Its version-2 nonce binds effective subject, authenticated real
operator, DirectAdmin role and impersonation context in addition to the canonical
actor/company/device generation; role and operator provenance grant no Titan
authority, and no exact DirectAdmin session binding is claimed without a stable
upstream session identifier. Retain session
rows/revocations and protect backups against rollback; deleting them destroys
this guarantee. Signed session credentials remain reusable authentication until
expiry/revocation/generation change. They are **not one-use execution grants**;
consequential operations still require canonical authority and idempotency.

## API and current-state checks

```ts
const sessions = createSessionCredentialService(config);
const expected = { company_id, device_id }; // independent request/channel assertions
const issued = await sessions.issue(upstreamCredential, expected);
const current = await sessions.resolve(issued.credential, expected);
const authenticated = await sessions.authenticate(issued.credential, expected);
const switched = await sessions.switchCompany(issued.credential, expected, targetCompany);
await sessions.revoke(switched.credential, {
  company_id: targetCompany, device_id,
});
```

`issue`/`switchCompany` return `{ credential, context }`. `resolve` returns
`CurrentSessionContext`. `authenticate` returns `{ context, provider, subject,
directadmin? }`; its optional expectation may be omitted when the consumer needs
the signed selected company/device discovered by verification. Optional expected
`actor_id`/`context_revision` can only narrow acceptance. Never decode an unsigned
payload to create an authenticated principal.

Every resolution checks current actor/company/membership/device/external binding,
exact session/context revision, audience, expiry and revocation in the existing
registry transaction. Switch uses its atomic compare-and-update and returns a
credential for the new generation; old A and B tokens remain invalid after A→B→A.
An invalid destination cannot partially switch state. Revoke requires verified
current authentication and compare-and-update; it never treats an ID as bearer proof.
The exact selected operation scope is `[context.company_id]`.
`allowed_company_ids` remains only switch choices, never operation scope.

## Web request ingress adapter

`apps/web/lib/auth/current-session.ts` exposes the existing-owner
`createCurrentWebSessionIngress(verifier, projection)` composition. The verifier
is the verification-only `createSessionCredentialVerifier` configured at trusted
server startup with pinned session issuer/audience/key/algorithm, trusted upstream
metadata, and the existing `GLOBAL_REGISTRY`; the approved projection separately
maps canonical `company_id` to a legacy `account_id` when a compatibility caller
needs that field. This adapter does not create a registry, keys, identities, or
credentials.

`resolveRequest(request)` reads one canonical `__Host-titan-web-session` cookie.
The cookie issuer must set it `HttpOnly; Secure; SameSite=Lax; Path=/` without a
`Domain` attribute. The ingress rejects duplicate or malformed canonical cookie
values; `fsm_session`, Authorization, query/body/header company IDs and raw
session IDs do not authenticate. It calls `authenticate(credential)` without a
request expectation, so the configured verifier checks signature, issuer,
audience, type, key, expiry and the durable session identity before resolving the
current actor/company/device/session/context revisions from GLOBAL_REGISTRY. After
the approved legacy-account mapping completes, it resolves that exact verified
company/device/actor/context revision again to reject a stale projection.

The result contains the full `CurrentSessionContext` (including `device_id`,
`session_id`, `session_revision` and `context_revision`), a
`VerifiedCompanyScope` projection of that current context for the company-storage
resolver, and operation scope `[context.company_id]`. The request cannot choose
the company. This authenticates identity and current membership; it does not
grant business authority or replace CSRF/origin checks on mutating routes.
Malformed, missing, legacy, invalid and stale credentials return `null`. A
sanitized `identity-registry-unavailable` error is preserved so route handlers
can report temporary server unavailability instead of turning a registry outage
into an authentication redirect; no backend details or credential data escape.

The injectable ingress above is now composed by
`apps/web/lib/auth/web-session-runtime.ts` for the real password-login and cookie
session path. The production factory is configuration-gated and requires:

- `TITAN_WEB_PUBLIC_ORIGIN`: one canonical HTTPS origin, never request `Host` or
  forwarded headers. It derives separate issuers
  `titan:web-login:<origin>` and `titan:web-session:<origin>`.
- `TITAN_WEB_IDENTITY_REGISTRY_PATH`: an absolute path to an already existing
  `GLOBAL_REGISTRY` SQLite file with the commissioned security schema v1. Startup
  calls the read-only schema opener; it does not run migrations or backfill.
- `TITAN_WEB_LOGIN_KEY_ID` / `TITAN_WEB_LOGIN_SIGNING_SECRET` and
  `TITAN_WEB_SESSION_KEY_ID` / `TITAN_WEB_SESSION_SIGNING_SECRET`: distinct key
  IDs and distinct base64url secrets of at least 32 bytes, supplied by existing
  server secret configuration. Login assertions use audience `titan-web-login`;
  canonical web sessions use `titan-web`. These issuer, audience and key
  namespaces are independent of DirectAdmin.
- `TITAN_WEB_IDENTITY_BINDINGS_JSON`: an explicit array of rows with exactly
  `legacy_user_id`, `legacy_account_id`, `company_id`, `actor_id`, and `device_id`.
  Each row is an approved web compatibility mapping. Matching active actor,
  company, membership, device, and external-binding records must already exist
  in GLOBAL_REGISTRY; web startup/login creates none of them. A user who lacks a
  mapping is denied until the identity owner provisions one from authoritative
  evidence. Historical users are never blanket backfilled.

After bcrypt verifies the password, the server signs a one-use login assertion
for the configured web-login issuer and immediately exchanges it through the
canonical service. The assertion binds the mapped stable subject, selected
company, device, audience and expiry; the registry binds its issuer-scoped nonce
to the durable session ID. The assertion never comes from the browser. The
resulting session is signed by the separately configured web-session key and
lasts at most five minutes. Login never trusts the legacy stored role; the role
is projected from the current canonical membership. `getSession` reads only the
canonical cookie and `GLOBAL_REGISTRY`; it no longer queries `business_memberships`
before PostgreSQL tenant context or falls back to `fsm_session`. Logout revokes
the current durable session before deleting the canonical and legacy cookies.

`switchCompanyCredential(credential, targetCompanyId)` verifies the current
credential first, derives source actor/company/device/revisions from that
verified context, then delegates to the canonical atomic switch operation. The
registry must already authorize the selected destination. The returned
operation scope remains exactly `[targetCompanyId]`; the full company-choice
list is not a business-operation scope. The destination must also have an
explicit web account/user projection row for the same verified stable subject;
a registry membership without that exact row is rejected before the switch
mutates session state. Provisioning and user
management routes remain behind this current verified session and
registry-derived role. Legacy user CRUD and `business_memberships` edits do not
automatically create or alter canonical identity/access records.

When required configuration is absent or the registry schema is not already
commissioned, login and authenticated routes fail with a safe
`WEB_AUTH_SETUP_REQUIRED` 503 and the relevant setting names. Registry failures
return a sanitized 503. Source implementation is separate from operator
commissioning: no live key, identity, device, membership, migration, or access
change was performed here.

## DirectAdmin → Workforce/Zero exchange

```ts
const child = await directAdminSessions.exchangeWorkforceZero(daSessionCredential, {
  company_id: expectedCompany,
  device_id: expectedDevice,
});
```

The optional expectation only narrows the already authenticated source context.
The caller cannot choose audience, surface, actor, subject or company mapping.
The service verifies the configured DirectAdmin session signature, issuer,
audience, algorithm, key ID, type, node and signed channel binding; resolves its
current provider/subject/session revision through GLOBAL_REGISTRY; then derives
the Workforce/Zero target from that resolved context. The child carries a signed
`source_session` reference binding provider, subject, source issuer/audience,
session ID/revision/context revision, actor, company, device, source-token expiry,
DirectAdmin node and CSRF hash. It contains no bearer token.

The child expiry is capped by the source token expiry, current source registry
session expiry and configured child lifetime. Its `titan_security_sessions`
primary key is a deterministic hash of the stable source reference and fixed
`workforce/zero` target. Repeating exchange for one source revision reuses the
same child; source re-signing cannot create another child, a revoked/expired child
is never reactivated, and changing a source reference cannot be swapped onto a
different child. A retry may only tighten child expiry; that advances its session
revision and invalidates credentials signed against the longer expiry. No schema,
table or second identity store is added. Source
switch/revoke, actor/company/membership/device changes and expiry make the child
fail current resolution, including after registry restart. The child exposes only
its selected company in `allowed_company_ids`; it cannot switch company itself.
A signing service configured for a DirectAdmin upstream and Workforce audience
must configure this fixed exchange; generic `issue()` cannot mint a separate
Workforce session that survives the source. A public-key-only Workforce verifier
remains valid for consumers.

## Effect-time source fence

`IdentitySessionRegistry.withCurrentSessionFence(proof, expected, { signal },
callback)` is the reusable owner API for consumers. The proof includes the signed
source reference and verified child bearer expiry. At entry, the registry creates
one 500 ms monotonic deadline before queueing for its SQLite
`BEGIN IMMEDIATE` transaction. Storage includes same-connection queue time and
native writer-lock acquisition by setting a temporary connection-local
`busy_timeout` to the remaining budget; ordinary transactions keep the
configured five-second timeout. If acquisition expires, the storage error is
normalized to `session-fence-timeout` and the transaction callback does not run.
After acquisition, the registry samples its trusted clock and re-resolves child
and source, then passes the same absolute deadline and an AbortSignal for the
remaining budget to the effect boundary. Workforce passes that unchanged deadline
to its control-store transaction. Keep the callback to short local admission work:
no provider/network wait, readiness probe, or registry re-entry. Lock order is
GLOBAL_REGISTRY → Workforce control store. Company-native reads and provider work
run outside both locks.

The fence covers admission/immediate bounded effect work only, never a 120-second
adapter lifecycle. On timeout it releases the registry lock and rejects as
`session-fence-timeout`. The callback may still be running if it ignores abort;
consumers must preserve `UNCERTAIN`, avoid replay and wait for observed outcome.
A source switch or revoke that commits first denies admission. If the fence admits
first, a later switch/revoke does not undo that in-flight work.

This service exposes no principal/company/membership/device provisioning methods.
Those existing registry primitives remain protected commissioning/governance
operations, not HTTP endpoints. Ordinary authenticated sessions cannot mint new
actors or restore memberships. A host must not expose raw registry methods to
request handlers. Initial administrative provisioning and upstream authentication
commissioning remain independent trusted dependencies; identity alone never grants
permission to provision. No automatic historical mapping/backfill is authorized.

## #1049 DirectAdmin adapter reconciliation

PR #1204 remains the #1049-owned DirectAdmin bridge/plugin/gateway. Its current
draft consumes the canonical credential service; it does not create a second
identity store. Do not accept the older hand-written `titan-da-session+jwt` token
type or relabel a DirectAdmin-audience credential as Workforce. The #1049 owner
retains its CSRF, Origin, gateway and UI response policy and owns consumer review
and commissioning; this slice does not edit those files. A signing service with
a DirectAdmin upstream and Workforce audience must configure the fixed exchange;
generic `issue()` cannot mint a separate Workforce session. Verification-only
Workforce hosts remain public-key-only consumers.

Configure `directadmin: { node_id }` to require signed `node_id`, `csrf_sha256`
(base64url SHA-256, 43 characters), and `da_role` (`admin`/`reseller`/`user`) in the
upstream assertion. The service validates and carries these through issuance and
switching. `authenticate` returns them under `directadmin`. They are not accepted
at all when this channel is unconfigured. The DA role is presentation only.

The bridge calls `authenticate(cookie)` and uses its verified `context` and
`directadmin.csrf_sha256`; it retains strict origin, CSRF nonce hashing, secure
HttpOnly cookie handling, node configuration, UI invalidation and response policy.
It must call authenticate again for each revalidation, and service switch/revoke
for those actions. Do not call a second Titan verifier or construct a principal
from request JSON. A successful switch must securely deliver the returned
credential, or clear the cookie and require fresh upstream authentication.
The SDK must never expose the credential to browser JavaScript/logs.

## #811 hosted runtime consumption

Inspected PR #1201 at `aa4345c58a00078fa4065fee0224195639dcf8c6`.
`HostedWorkforceDependencies.credentialVerifier.verify` can use
`createSessionCredentialVerifier(config)` on a public-key-only host. That wrapper
exposes only `authenticate` and `resolve`, no signing or registry mutation.
Configure its audience as `workforce`. After `authenticate(token)`, project:

```ts
const authenticated = await verifier.authenticate(token);
const { context: c, provider, subject, source_session, credential_expires_at } = authenticated;
return { provider, subject, session_id: c.session_id, device_id: c.device_id,
  session_revision: c.session_revision, audience: c.audience,
  source_session, credential_expires_at, surface: authenticated.surface };
```

For the DirectAdmin exchange path, preserve the verified `source_session` and
`credential_expires_at` in the durable authenticated-identity proof; missing
lineage is a denial for this commissioned path. Before the final
effect boundary, #811 calls `withCurrentSessionFence`; keep its independent
authority fence. Acquire locks in identity → Workforce control → business order,
and do not re-enter the registry while holding later stores. Keep slow readiness
and long adapters outside the 500 ms fence. If timeout/abort is not cooperative,
retain `UNCERTAIN`; do not report cancellation or verified completion. A
DirectAdmin-audience token itself is never relabelled or forwarded as Workforce.
Actual host wiring, queued expiry semantics and end-to-end native execution
remain with #811/#812.

## Web migration surface and limits

`apps/web/lib/auth/current-session.ts` is an opt-in server adapter over this service.
It projects current `{userId, accountId, role}` for existing web callers through
a required trusted `resolveLegacyAccountId(company_id)` compatibility mapping;
there is no assumption that canonical company ID equals a legacy account ID.
Unknown, malformed or throwing mappings fail closed with sanitized errors. The
adapter revalidates the exact credential/context after the asynchronous mapping
lookup, so a concurrent switch or revocation cannot return a stale projection.
Operation scope remains the canonical selected company even when its legacy
account ID differs. Unsupported web roles and legacy JWTs fail closed. It never
falls back to `users.account_id` or reconstructs missing membership.
Real SQLite tests exercise issue/switch/revoke/restart and legacy-token denial.

Existing login/middleware/`session.ts` remain on the preserved legacy path. Cutover
requires an explicit coordinated issuer and consumer composition, reviewed stable
actor/company mapping, verified reauthentication and short-lived secure cookies
bounded by `context.expires_at`. Do not opt in one side only or reuse the old seven-day
cookie duration. No persistence/access migration decision is made by this patch.

## Verification and remaining gates

Dedicated tests use ephemeral keys and real file-backed canonical SQLite. They
cover wrong issuer/audience/algorithm/key, tampering, legacy migration denial,
verification before queries, current revocation/generation/device/company checks,
concurrent exchange/switch, failed configuration, host namespace isolation,
restart replay, signed DA channel metadata and public-key-only composition.
The pre-existing registry suite additionally covers committed/uncommitted process
crash. This is disposable integration evidence, not real DA login, production key
commissioning, OS/power-loss durability or old-backup anti-rollback certification.

Rollback withdraws the opt-in consumer composition and this credential entry;
retain all additive registry data and revocation history. Never restore a weaker
legacy fallback automatically. Full #302 remains open, including broader secret
lifecycle/supply-chain gates and real deployed cross-surface certification.
