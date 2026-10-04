# DirectAdmin authenticated session bridge — #1049

Status: PR #1204 merged into main at `75cc7f020353063aba129e5238b35e78de62291c`; #1049 remains open and partial/non-closing. This continuation binds the SDK bootstrap boundary directly to #302's canonical assertion provider and adds an end-to-end disposable composition test. No DirectAdmin host is commissioned. Its current-main ancestry includes the merged #1183 identity owner, #1201 Workforce HTTP server, #1211 DirectAdmin RAW relay, and #1240 company-placement resolver. The SDK composes the canonical #302 DirectAdmin-to-Workforce/Zero exchange with the server and relay in disposable fixtures. Unsupported lifecycle actions remain denied without effects.

## Canonical identity and browser boundary

`DirectAdminSessionBridge` delegates authentication, company switching, revocation and Workforce/Zero exchange to the canonical #302 `createSessionCredentialService`. It does not implement signature verification, issue keys, provision identities or create another registry. The verified provider must equal the configured DirectAdmin HTTPS issuer. The request origin, commissioned node and audience are fixed by trusted startup configuration.

The browser projection exposes only `company_ids: [current.company_id]`; switchable companies never become operation scope. Actor, company, device, session and revisions come from current canonical registry state. Caller IDs, company headers, a node token, DirectAdmin role and a session ID alone supply no Titan business authority.

`DirectAdminSessionBridge.bootstrapBrowserSession` accepts the canonical #302 `DirectAdminLoginAssertionProvider` type exported through `security-boundary.ts`. Trusted composition passes `createDirectAdminBootstrapFlow(...).provide`; the SDK no longer accepts an arbitrary per-request resolver callback or declares a second assertion-provider contract. The bridge still validates its same-origin, Fetch Metadata, empty-body and one-time nonce boundary first, then forwards only its allowlisted origin/cookie/authorization/nonce proof to that server-only provider. An absent provider fails closed. The SDK verifies the returned assertion through the canonical session credential service and projects only the selected company.

The canonical context revision is an opaque registry snapshot string. The browser SDK sends a versioned `ctx1_` SHA-256 assertion over that value to fit the RAW relay's bounded URL-safe intent contract. It carries no authority: the SDK gateway compares it against the freshly authenticated canonical revision before accepting the intent. The authenticated revision remains unchanged in server-side owner context.

The host issues `__Host-titan-da-session` as Secure, HttpOnly, SameSite=Strict, Path=/ with no Domain. The browser keeps its session CSRF token only in cockpit-object memory and sends it on context and plugin requests; it is compared with the verified canonical binding. The HTML bootstrap nonce is a different, one-time proof and is sent only as `X-Titan-DA-Bootstrap-CSRF`. POST requires exact Origin; Fetch Metadata, cookie and CSRF checks fail closed. Responses are no-store and redact owner/provider errors. Switch uses canonical revision rotation, gives the replacement only as an HttpOnly cookie, and invalidates all mounted plugin contexts. Logout revokes the durable session before clearing the cookie.

### Reload restoration and renewal

A fresh document has no in-memory session CSRF token. It calls the same empty-body, same-origin `POST /v1/directadmin/bootstrap` used for first login, carrying the HTML nonce only in `X-Titan-DA-Bootstrap-CSRF`. It does not try `GET /context` with the HTML nonce as `X-Titan-CSRF`.

The bridge accepts zero or one `__Host-titan-da-session` cookie on bootstrap. If present, it first authenticates the opaque credential through #302 so a registry outage cannot be mistaken for expiry. It removes that Titan cookie before passing the remaining DirectAdmin cookie proof to the trusted host provider and never forwards browser `Authorization`. The host provider authenticates its configured HTTPS DirectAdmin session endpoint, atomically consumes the one-time nonce in its durable host-supplied consumer, resolves exactly the currently selected canonical company and device, and returns a short-lived signed login assertion plus a fresh CSRF token. The SDK adds no nonce store or persistent token storage.

The bridge issues and reads the replacement through #302, checking issuer, audience, node, signed selected company/device, CSRF digest, actor, context revision and session revision. When a prior session was current, the replacement must retain its verified provider, subject, actor and device; a mismatched replacement is revoked and returns a sanitized 409 without replacing the prior cookie. The selected company may follow the provider's newly resolved current selection and is projected alone as `company_ids: [company_id]`. Only after successful replacement verification does the bridge revoke the prior credential and return the replacement as HttpOnly cookie plus the CSRF token in JSON. The credential is never returned to JavaScript.

Failure disposition depends on what #302 and the provider could verify. An unavailable registry/provider returns a redacted 503; a canonically current prior cookie is not cleared or revoked, while a cookie that #302 already rejected may be cleared. An explicit authentication denial returns a redacted 401; an already rejected cookie is cleared, while a current cookie remains untouched because provider denial can also represent a consumed/replayed bootstrap nonce. Same-origin, Fetch Metadata, empty-body, nonce-format and duplicate-cookie failures are rejected before calling the provider. A failed network attempt never retries the same nonce; another document bootstrap must supply a fresh nonce.

Failure status is separate from identity authority. A canonical `authentication-denied` (treated as session rejection) returns a generic 401 and clears its session cookie; a request rejected by the Origin/CSRF boundary returns the same generic 401 body without clearing a cookie. After a source has authenticated, exchange, company-switch and revocation failures trigger a fresh source-session read: a rejected source returns 401, while an operation failure with a still-current source returns a redacted 503 without a `Set-Cookie` header. A typed Workforce action-denial 403 preserves the shared browser context and its subscribers; 401 and context-conflict 409 still invalidate them. No exception details are included in responses.

#1183 now classifies durable identity-registry failures as sanitized `identity-registry-unavailable`, distinct from credential rejection. The bridge treats explicit canonical `authentication-denied` as a rejected session and maps registry or other service failures to a redacted unavailable response; it still fails closed on unknown boundary errors.
After a company switch issues a replacement credential, explicit rejection of that replacement returns 401 and clears the stale browser cookie. If canonical registry verification of the replacement is unavailable, the bridge returns a redacted 503 without clearing the cookie; it does not claim the replacement is valid or expose its credential.

## Workforce/Zero exchange and consumers

Only trusted Zero Core and Workforce intent owners receive the server-only `withWorkforceZeroSession(consume)` capability; Operations Hub and Brand Studio cannot exchange a Workforce/Zero child. The capability revalidates the DirectAdmin cookie, calls the canonical fixed-target exchange, checks child audience, selected company, actor, device, revisions and source-capped expiry, and supplies the child bearer only to the trusted server callback. The browser never receives it. The gateway returns only a bounded receipt ID and rejects JWT-shaped IDs. This callback is a request capability, not a queue credential; the downstream owner must retain the signed source proof and use current-session fencing at consequential effects.

Zero Core, Operations Hub and Brand Studio share one session, renderer and gateway. The same browser session now also consumes the additive Workforce projection and intent routes. Projections validate nested company identity, source, freshness and evidence shape; render untrusted values as text; isolate plugin failures; and show stale, unknown and incompatible data as read-only. These source consumers are not certified installed DirectAdmin role packages.

The SDK integration tests use the actual #302 service and registry. They reject the raw DirectAdmin credential as a Workforce credential, exercise only the configured fixed Workforce/Zero exchange, verify the signed source-session reference, and prove that source company switch and revocation invalidate the child. Caller/company headers cannot switch the selected company; bearer and CSRF values do not reach the response.

## Current owner handoffs

#1183 merged into main at `ae0d2c8e8355cd17bbffbe7df7074039823bbe7c` and remains the sole credential verifier, identity registry and exchange owner. Its `exchangeWorkforceZero` fixes the child target to `workforce`/`zero`, binds the verified DirectAdmin source and selected identity, reuses deterministic child sessions idempotently, only tightens expiry, and does not recreate revoked children. A DirectAdmin-trusted signing service for the Workforce audience requires that fixed exchange; generic `issue()` cannot create an unlinked Workforce session. Public-key-only Workforce verifiers remain allowed. `withCurrentSessionFence` rechecks the child and source under the identity-registry writer lock before a bounded effect callback. The merged owner classifies registry outages separately from rejected credentials.

PR #1201, at head `25005f4f4d860e2ec1dddb9f0a2c4aa152fd0488`, is merged into main at `14163faa316ac6236e88167b7c8d8a5e95007c7e`. The merged Workforce verifier retains `source_session` and `credential_expires_at`; the identity registry starts its native SQLite acquisition deadline before queueing for the writer lock and propagates the same deadline into the bounded effect callback. The merged server rejects revoked source lineage before conversation input validation. No #811 server/bootstrap files or #1182/#1188 conversation transport files were edited here.

The focused native identity/exchange suite exercises lock acquisition, source revocation, cancellation and timeout behavior in the merged owner. The composed HTTP probe described below demonstrates authentication and revocation rejection only; it does not establish acceptance of a consequential Workforce action.

#812 / #1211 merged its fail-closed DirectAdmin RAW relay at merge commit `8199494eeacc3513b293311d88a469a654ee4dea`. The relay routes the browser session to the existing #811 gateway and bounds DNS plus full upstream response time. Its intent validator accepts bounded URL-safe context assertions; it rejects the raw JSON snapshot form returned by #302. The SDK's `ctx1_` transport assertion closes that format mismatch while preserving canonical comparison in the SDK gateway. #1240's company-placement resolver is also merged in current main; #1049 adds no storage resolver or identity authority.

A disposable composed HTTP probe used the #812 browser helper and actual `.raw` entrypoint at PR head `9ffef58d`, forwarded through the #811 server now merged in main at `14163faa`, and used the canonical identity/session code present in that tree. The shared browser session loaded the current-company Workforce projection. A real child credential reached `/v1/workforce/conversations`, which returned `400 conversation-input-required` because the probe intentionally omitted message text; the Workforce owner then returned its typed `403 directadmin-workforce-action-unsupported`. In a second request, the source was revoked after child verification and before hosted identity resolution: the conversation route returned `401 conversation-authentication-failed`, and the relay returned a sanitized `401 directadmin-session-rejected`. Work-order completion remained zero. This verifies cross-plugin authentication and source-revocation rejection only; no Workforce lifecycle action or business effect was accepted.

## Routes and diagnostics

- GET `/v1/directadmin/context`
- GET `/v1/directadmin/{titan_zero,titan_workforce,titan_operations,titan_web}/projection`
- GET `/v1/directadmin/titan_workforce/receipts/{receipt_id}`
- POST `/v1/directadmin/{titan_zero,titan_workforce,titan_operations,titan_web}/intents`
- POST `/v1/directadmin/company` with `{ "company_id": "..." }`
- POST `/v1/directadmin/logout`

The receipt route is a read-only Workforce consumer. It accepts one bounded receipt ID path segment, with no query string or request body, and uses the same authenticated cookie, in-memory CSRF token, Origin and Fetch Metadata checks as other SDK routes. The bridge revalidates the current canonical session before and after the owner read and passes only the selected company/actor context. The owner must look up accepted evidence using that context; unknown and out-of-scope IDs return the same sanitized not-found response. The SDK validates the receipt schema, requested ID, selected company, verification marker and evidence reference before returning it to a plugin. A `REQUESTED` submission response is never promoted by this read path; only the canonical Workforce accepted-evidence owner can report `VERIFIED`.

The #811 receipt projection exists in its current draft, but its HTTP route is not yet mounted. The #812/#1050 fixed relay selector also still needs this exact GET path before a deployed browser can reach the SDK consumer. This SDK contract does not edit or certify those host/Workforce seams.

The Fetch gateway is not a listener, CLI or deployment. The launched #811/#812 host owns transport deadlines, rate limits and actual projection/intent owners. A successful SDK response reports `REQUESTED` only; the SDK does not authorize or execute business effects.

The exported support-diagnostics sanitizer removes sensitive object fields and inline Bearer, Basic-authorization, `X-Titan-CSRF`/`csrf` values, JWT-shaped values and PEM private keys. Adversarial tests cover CSRF and Basic credentials embedded in free-form diagnostic messages.

Contribution SDK compatibility is a separately versioned API contract (currently `1.0.0`, independent of the package release version). The registry accepts compatible minor/patch versions and exposes a stable degraded reason when a plugin requires another major. This only isolates incompatible plugin UI/contributions; it does not change or grant downstream authority.

## Historical verification (merged PR #1204)

The following evidence records the earlier merged SDK slice and is retained as provenance. It does not describe the follow-up candidate documented below.

The current disposable integration fixture used PR head `1f57f03c209199f2e724e70629fa71a496f0eb1b` plus merged main `c883304a662738fe480ec1e5d044fdeb0c4c879e`, before this documentation-only refresh:

- Titan Platform typecheck and test compilation passed.
- Combined canonical credential, identity registry, fixed exchange and DirectAdmin bridge/consumer suite — **221/221 passed**, zero skips.
- #1240 company-storage resolver and placement persistence tests — **21/21 passed** on the exact merged storage sources; these are current-main owner files and were not authored by #1049.
- Distribution catalog, contract compiler, gateway and package conformance regressions — **16/16 passed**.
- Chromium consumer flow — **1/1 passed**, including cookie flags, CSRF headers, safe rendering and cross-tab selected-company invalidation.
- A disposable relay/SDK/#811 HTTP probe at main `14163faa` and then-candidate #812 relay `9ffef58d` returned the selected-company projection, a sanitized typed 403, and 401 after source revocation; work-order completion remained zero. #812/#1211 later merged at `8199494eeacc3513b293311d88a469a654ee4dea`; the HTTP probe has not been rerun against the merged relay.
- GitHub comparison confirmed current main `c883304a662738fe480ec1e5d044fdeb0c4c879e` was an ancestor of that fixture head. The published PR diff scan found no added-line trailing whitespace or conflict markers.
- Independent review confirmed the DirectAdmin bridge, gateway, cockpit and plugin-auth files remain unchanged from reviewed source `e428b67b`; canonical identity files match merged main. No collision or must-fix authentication/authority issue was found. The extra merge only imports non-overlapping #1240-owned storage files.
- Hosted exact-head checks for the documentation refresh were recorded on PR #1204.
- A prior full Titan Platform suite at source `e428b67b` with main `14163faa` recorded **1,054 passed / 72 failed / 2 skipped** out of 1,128. It was not rerun on the merged candidate; this remains historical evidence. Exact-head Titan CI's platform regression gate passed on the preceding code-only merge candidate.

## Current verification (2026-10-02 continuation)

This continuation was based on current main `64244edefb93a07c9ba55fb15276bbf91b7414ea` and keeps identity ownership in #302. It changes only the SDK bootstrap bridge/gateway, the Workforce consumer contract test, the SDK bridge tests, and this document.

- Titan Platform typecheck passed: `tsc -p tsconfig.json --noEmit`.
- Titan Platform test compilation passed, followed by the focused canonical credential, nonce/provider, bridge/gateway, plugin-consumer and new end-to-end composition suite: **176/176 passed**, zero skips.
- The new disposable integration uses SQLite `GLOBAL_REGISTRY`, `createDirectAdminBootstrapFlow`, a fixed HTTPS `/api/session` fixture, generated signing keys, `createSessionCredentialService`, the real SDK gateway and cockpit session. It verifies nonce replay denial, caller/company spoof rejection, selected-company-only projection, three SDK plugin routes, company-switch invalidation, membership revocation and that bootstrap errors omit the DirectAdmin cookie and nonce. Companion plugin tests cover diagnostic-field and free-form secret redaction.
- `node --test apps/directadmin/workforce/tests/*.test.mjs` with the existing temporary Playwright browser cache: **45/45 passed**, including the SDK contract consumer and browser lifecycle suite.
- These checks establish the SDK/provider composition in disposable fixtures only. They do not certify the #1300 host bootstrap routes, a commissioned DirectAdmin installation, OS/browser access, production proxy headers, real identity mappings or a hosted server smoke.
## Remaining acceptance work

Keep the continuation PR draft and #1049 open. Workforce intent owners still deny unsupported lifecycle controls with a typed 403, so this composition has no accepted action or business-effect evidence. Duplicate-request, cancellation and timeout/UNCERTAIN behavior remain downstream acceptance work. An independent review of the provider-contract change found no must-fix authentication or authority issue. Maintainer approval and passing exact-head hosted gates remain prerequisites for any merge.

The earlier disposable HTTP composition predates the #812/#1211 merge; rerun the combined relay/Workforce probe against current main before relying on that evidence for commissioning. Real DirectAdmin assertion issuance, approved actor/company/device mappings, secured browser and OS access, Evolution role-package installation, production proxy/header checks, registry commissioning and a real-host smoke remain external prerequisites. No persistent credential, security setting, migration, server deployment or merge was performed.
Rollback withdraws the SDK bridge and consumers. It introduces no SDK identity store or persistence migration. Retain #302's separately owned session/revocation data and do not restore a weaker credential fallback.
