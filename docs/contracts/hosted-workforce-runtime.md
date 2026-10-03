# Hosted Workforce composition (#811)

The launched `services/workforce/src/server.ts` composes the existing native
`createFieldServiceRuntime`, which calls `createProductionRuntimeBootstrap`.
There is one canonical dispatcher, run store, Workforce store, authority gateway
and native work-order completion owner. `apps/web` remains the full native FSM;
Frappe is not required by this slice.

For the clean-host preflight, one-company acceptance workflow, artifact/hash
record, reboot/update/rollback checks and the #1182 incremental-streaming
handoff, follow [the Workforce clean-host acceptance procedure](../operations/workforce-clean-host-acceptance.md).

## Commissioning contract

Set `WORKFORCE_DEPENDENCIES_MODULE` to an absolute operator-owned module path.
The module exports async `createWorkforceDependencies()` returning the
`HostedWorkforceDependencies` contract in `hosted-runtime.ts`:

- `identityStoragePath`: the separately provisioned GLOBAL_REGISTRY SQLite file;
- `credentialVerifier.verify(authorization)`: authenticate the credential
  cryptographically and return its bound issuer/subject/session/device/revision,
  `audience: workforce`, and `surface: zero`; the bounded native manager host
  rejects Go/Hub until their authority-aware dispatch contracts are implemented;
- `workOrders.complete/read`: resolve current registered physical company storage
  and call the existing native business owner / independent observed-state read;
- `readiness`: actual authentication, authority, provider and evidence observations;
- optional `adapterTimeoutMs` (1–120000ms, default30000) bounds external calls;
- optional `close({signal})`: dispose provider resources after accepted requests drain.
Credential verification and readiness receive `{signal}`; native provider input
also carries `signal` and an ephemeral `authorityFence.assertCurrent()` guard.
Adapters must invoke that guard immediately before the actual mutation, as the
canonical native completion owner does. An adapter that ignores abort can still cause a late effect;
Titan records uncertainty and never treats its deadline as proof of non-execution.

The factory is trusted commissioning code, never an HTTP-selectable module or a
credential issuer. No default verifier, sample credential, business fixture,
authority grant or successful provider fallback ships. Missing configuration
prevents launcher startup. Library callers without dependencies can inspect
liveness/storage, but readiness stays 503 and conversation ingress stays disabled.

The production dependency factory optionally loads the absolute
`WORKFORCE_DIRECTADMIN_DEPENDENCIES_MODULE`. That operator-owned module exports
`createWorkforceDirectAdminDependencies()` and returns the existing
`{ publicOrigin, createGateway(owners, bootstrapNonceFlow?), bootstrapNonceFlow? }`
mount seam. It must compose the canonical #1049 gateway with the #302
identity/credential producer. When configured, `bootstrapNonceFlow` is the same
canonical #302 flow instance passed as the second `createGateway` argument and
used by its assertion provider; it exposes
`issueNonceForUniqueCurrentContext({ origin, cookie, authorization: null })`.
The Workforce server mounts `/v1/directadmin/bootstrap-nonce` around that
operator gateway. If the flow is omitted, that path remains mounted as a
sanitized 503 and fails closed. If the module is omitted, DirectAdmin routes
remain disabled; if configured but invalid, startup fails.
The module must be included in the reviewed image or mounted read-only through
an operator Compose override; the base Compose file does not mount this optional
file. The Workforce host does not supply an assertion issuer, nonce store, or
identity mapping.

Use `createWorkforceSessionCredentialVerifier` from
`services/workforce/src/session-credential-verifier.ts` for canonical #302 signed
sessions. It wraps `createSessionCredentialVerifier` with fixed audience
`workforce` and surface `zero`, accepts strict Bearer JWTs, and exposes only the
host verification port. Supply the canonical registry and trusted issuer/key
configuration; asymmetric verification needs only public keys. It authenticates
cryptographically and resolves current registry state before projecting identity.
It creates no keys, credentials, sessions or provisioning routes. DirectAdmin
audience credentials cannot be relabelled for Workforce; a commissioned
Workforce-audience authentication handoff remains with #302/#1049.

## DirectAdmin Workforce composition handoff

`HostedWorkforceDependencies.directAdmin` is an optional operator-owned seam:
it supplies a fixed HTTPS `publicOrigin` and a `createGateway(owners)` factory.
That factory must compose #1049's canonical `DirectAdminSessionBridge` and
`createDirectAdminGateway` with #302's canonical DirectAdmin-to-Workforce
exchange/lineage owner. A standalone Workforce credential is insufficient:
revalidating the derived session must observe source DirectAdmin company switch
and revocation. Those exchange semantics are not implemented by this host.
The launched server only translates and mounts the resulting Fetch handler at
`/v1/directadmin/*`; it does not copy the browser cookie, CSRF, context-switch,
logout or transport implementation. It pins the Fetch URL to `publicOrigin`,
checks the incoming Host against that origin, forwards only the headers the
shared SDK consumes, and never forwards the Workforce `Authorization` token.
Without the separate bridge composition, DirectAdmin paths return read-only
503. No audience or issuer is synthesized by the Workforce host.
The first-session nonce route validates exact same-origin POST transport,
`Sec-Fetch-Site: same-origin`, an empty body and only the DirectAdmin `session`
and `key` cookies before it calls `issueNonceForUniqueCurrentContext`. That
canonical flow authenticates the cookies with the configured DirectAdmin
`/api/session`, requires exactly one current company/device binding and returns
an opaque nonce to the caller; the tuple is not included in the browser
response. At redemption the role handler sends the nonce, filtered DirectAdmin
cookies and any existing `__Host-titan-da-session` cookie to
`/v1/directadmin/bootstrap`. The canonical gateway authenticates the prior
Titan cookie, strips it from the proof, consumes the nonce once, signs the
assertion, and passes that assertion with the same company/device expectation
to `sessions.issue`.

The packaged role RAW handlers expose these same-origin POST URLs to #1050's
browser client:

| DirectAdmin role | Nonce route | Session redemption route |
| --- | --- | --- |
| Admin | `/CMD_PLUGINS_ADMIN/titan_workforce/bootstrap-nonce.raw` | `/CMD_PLUGINS_ADMIN/titan_workforce/bootstrap.raw` |
| Reseller | `/CMD_PLUGINS_RESELLER/titan_workforce/bootstrap-nonce.raw` | `/CMD_PLUGINS_RESELLER/titan_workforce/bootstrap.raw` |
| User | `/CMD_PLUGINS/titan_workforce/bootstrap-nonce.raw` | `/CMD_PLUGINS/titan_workforce/bootstrap.raw` |

Append `?headers_to_env=yes&pipe_post=yes` exactly to each RAW URL; no extra
query parameters are accepted.

The browser sends POST requests with same-origin credentials and an empty body;
redemption includes `X-Titan-DA-Bootstrap-CSRF` with the opaque nonce. The role
RAW handlers call the fixed `127.0.0.1:3010` Workforce listener directly for
`/v1/directadmin/bootstrap-nonce` and `/v1/directadmin/bootstrap`; they do not
widen the generic #812 relay cookie allowlist. Both paths require DirectAdmin's `headers_to_env=yes` and
`pipe_post=yes` RAW transport and fail closed on malformed, duplicated or
uncommissioned requests. The deployed DirectAdmin panel must still verify the
official URL-encoded `HEADERS` transport behavior before release. Keep the
operator module disabled until its durable nonce consumer, same-flow gateway
composition, protected private listener and production identity mappings are
commissioned. No live panel or production store is certified by disposable
tests.

The Workforce gateway owner builds
`GET /v1/directadmin/titan_workforce/projection` from company-filtered canonical
`SqliteWorkforceStore` worker/work records and `SqliteRunStore` run references.
Its payload uses `data.schema = "titan.workforce-cockpit.v1"` and repeats the
selected `company_id` in the envelope, discovery and status. Evidence references
are the stored canonical work references; they are not a claim that every row
is an accepted terminal outcome. The projection returns `controls: []` until
canonical DirectAdmin management authorization and accepted-evidence owners are
available.

The consumer's current pause, resume, cancel, reassign, escalate and revoke
intent names are proposals only. The owner validates the bound company, actor,
operation/correlation IDs and bounded input, revalidates the current session,
then rejects each proposal without calling unauthorised `WorkforceService`
lifecycle methods, changing state, appending an event, or creating a receipt.
Unknown actions are invalid. The owner raises a typed 403 unsupported-action
denial. The merged #1049 gateway maps typed owner denials to sanitized status
codes. Its `titan_workforce` route allowlist is still an integration dependency;
#1260 contains the consumer-side work and remains open. The host mount and these
contracts are not commissioned behavior.

The old VPS smoke assumes an unconfigured host is ready; this is no longer a valid
production acceptance claim and must be commissioned by the deployment owner.

`WORKFORCE_SQLITE_PATH` selects runtime/control/evidence storage. It is not a
company business database. Do not configure it to the identity file. Native
business providers must resolve distinct physical company databases; request
fields never select a filesystem path. Startup creates only the existing
owner-specific runtime/control schemas; it does not migrate native business tables
or issue actors, sessions, permissions, grants, field proofs or approvals.

## Authentication and authority

`POST /v1/workforce/conversations` reuses #1182 / PR #1188 transport source at
`3ec9100ac0f8b44fafd4a4a80bc09e96279e08af`. The verified credential is resolved
through #302's current registry on every request, including replay, resume and
cancel. Payload identity assertions must match; headers/session IDs alone never
authenticate. Only whitelisted credential-free identity bindings enter durable
work/run metadata. The response excludes external principal proof metadata.

The native authority path rereads the durable run identity and current registry
before authorization, execution reauthorization, and provider mutation. Revoked
membership/session, switched company/context, expired session or mismatched
actor fail closed. Identity never grants execution authority: the existing
worker access, policy, risk, assurance, evidence and approval owners still decide.

For source-derived Workforce/Zero sessions, the #302 canonical fence revalidates
the signed DirectAdmin source and derived child under the GLOBAL_REGISTRY writer
transaction. The host loads the trusted proof from the durable run before this
fence, then opens a short Workforce control transaction in the prescribed order
(identity registry -> Workforce control DB). It compares the exact stored proof,
rechecks the run/cancellation state and current Workforce authority, and records
the execution admission. Neither store is reopened while the other transaction
is active. The 500 ms fence callback ends before the slow company-scoped provider
call; the provider runs after both writers release and receives the bounded
AbortSignal plus the current authority/expiry guard immediately before mutation.
Ordinary direct Workforce sessions retain current registry revalidation and do
not receive fabricated DirectAdmin lineage.

This is an admission boundary, not a transaction spanning identity, Workforce,
and company databases. If a source revoke/company switch or cancellation wins
before admission, no provider call starts. If admission wins, a later revoke,
switch, or cancellation cannot undo or reliably stop that already-admitted
provider call; it blocks later admissions and can make post-action verification
fail. A timed-out or unverified action remains `UNCERTAIN`, and a non-cooperative
adapter may mutate late. Never claim that revocation or cancellation stopped an
in-flight external effect. The 5-second identity-registry busy timeout and
30-120 second provider bound make it essential to release the identity writer
before provider work. The host never accepts lineage from request fields.

Work/run identity preserves company, actor, conversation, interaction, request,
operation, trace, correlation and idempotency values. Conflicting start replay
is rejected; continuation receipts live in the canonical run payload and are
claimed atomically. Cancellation is cooperative: it prevents later execution
steps and stale completion writes, but cannot undo an already invoked provider.
Provider effects still require observed verification and factual evidence.

## Lifecycle and evidence

Readiness requires actual runtime tables, current identity storage and all
required dependency observations. Each HTTP readiness request has a one-second
response deadline, while storage-table checks share one underlying probe until
that read sequence settles. A timed-out response therefore cannot enqueue new
SQLite reads behind the same serialized store queue on every retry. The external
`readiness({signal})` adapter must honor abort; JavaScript cannot forcibly stop a
non-cooperative adapter promise. Liveness remains independent. Shutdown stops
ingress and grants accepted work a bounded drain interval (default5000ms). At
the deadline it aborts adapter signals and closes connections, waits for bounded
handlers to persist recovery state, then closes dependencies and stores.
Dependency cleanup itself is bounded.

Canonical ExecutionGateway now distinguishes UNCERTAIN from FAILED/VERIFIED.
Timeout, abort, exception after dispatch, missing verifier and an unverified
acknowledgement never prove non-execution. The canonical governed-execution
lifecycle has atomic SQLite records/events, stable company/operation binding,
and compare-and-swap claims. An interrupted RUNNING or UNCERTAIN operation can
only reconcile by observed verification; it cannot invoke the provider again.
An explicitly proven non-executed failure is a different recovery case.

`action` must be a primitive string. `continue`, `resume`, and `cancel` require
a continuation token; `start` forbids one. Authenticated `resume` is the explicit
verification-only recovery route, distinct from normal user continuation. It
preserves the work/run/session binding and revalidates current session and
authority. No startup scan automatically takes ownership of another live run.
A locally active driver rejects recovery. Shared-store multi-process ownership
still requires commissioning discipline: recovery does not establish that another
host is dead, and compare-and-swap conflicts never authorize another effect.

Real process tests interrupt the native provider before mutation and after a
committed mutation but before acknowledgement. Both remain uncertain across
SIGKILL/restart until explicit verification; the first never retries and the
second verifies without a second mutation. These are process-interruption tests,
not VPS power-loss or backup anti-rollback certification.

Native execution persists gateway receipts with canonical AcceptedEvidenceLedger
normalization in the existing evidence table. Projection rebuilds from accepted
history and independently reads the business outcome. Provider acknowledgement
alone is not verified completion. Existing accepted rows are append-only through
this path; the change introduces no alternate evidence ledger class or business
state store.

The inherited SSE response is a bounded completed-event projection with
Last-Event-ID filtering, **not live incremental streaming**. #1182 remains owner
of real incremental streaming and broader surface lifecycle. Host/VPS reboot,
backup anti-rollback, live credentials/providers, DirectAdmin installation and
second-surface acceptance remain commissioning evidence, not unit-test claims.

## Dependency provenance and rollback

Preserved #1179 prerequisite `eea8d6cc1eff2b49ae8e64f04687736612a99b16`,
including #811 readiness, malformed URL protection, restored exports and compiler
coverage, reviewed worker repairs and VPS setup fixes; integrated #302 resolver
and credential owner `bd3075ef91222e32a23a1f09111a84b3c01af515` and main
`ee1a3ee3709b9201fc728fc162067d9a5ab78e45`. The Docker launcher uses the
package-local `tsx` command preserved from #1179. DirectAdmin transport remains
with active shared owner #1049; this change adds only an injected mount and a
read-only projection/denial adapter, not a competing bridge or management API.

Rollback stops ingress and restores the prior service artifact. Retain durable
runtime, identity/revocation and evidence files; never erase or replay them to
make an older host appear ready. The unconfigured health-only artifact cannot
be described as a production replacement. Keep #811 and draft #1201 open until
full acceptance or explicitly approved administrative handoff.
