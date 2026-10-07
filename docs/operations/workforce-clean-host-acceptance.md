# Hosted Workforce clean-host acceptance procedure

This is the release and commissioning checklist for the bounded hosted Zero
work-order workflow in #811. It complements the [hosted runtime contract](../contracts/hosted-workforce-runtime.md)
and the [SQLite VPS installer guide](../deployment/README-VPS.md). It is not
evidence that a host has been installed or commissioned. It records what the
current repository can verify and the gaps that must be closed first.

## Current stop gates

The procedure is **not executable as a production acceptance today**. These are
observed properties of the current repository and deployment files:

| Boundary | Current implementation | Required before acceptance |
| --- | --- | --- |
| Runtime composition | The VPS Compose file selects the in-repository `production-dependencies.ts` factory. That factory composes the native runtime, credential verifier, durable identity/control storage and company-placement owners. The optional `WORKFORCE_DIRECTADMIN_DEPENDENCIES_MODULE` is unset by default, so the DirectAdmin gateway remains disabled. The VPS CI smoke injects a separate test-only factory with disposable SQLite files, rejects authentication and all provider calls, and intentionally stays unready. | Package and review the operator-owned DirectAdmin bridge module only after #1049/#302 publish compatible contracts. Record its source and hash. The CI smoke fixture is not commissioning evidence. |
| Runtime configuration | Compose declares separate container paths for identity, runtime, web and company stores plus read-only public-key mounts. Host path, issuer, key and protected-store references must still come from a reviewed deployment environment; `infra/vps.env.example` does not contain commissioned values. | A reviewed Compose configuration must bind durable, physically separate identity, control/evidence and registered per-company business stores. Do not choose paths from request data. |
| Identity handoff | The host uses the canonical #302 exchange/effect-fence API (source 4398dcf8, native-storage verification 9bfc15f6). It persists the signed source reference and credential expiry with the run, reloads the proof before admission, compares the exact proof inside the Workforce transaction, and rejects source revoke/company switch before admission. No commissioned DirectAdmin browser bridge or public route is configured. | #1049 must consume the exchange through the shared bridge. Commission and test the real DirectAdmin-to-Workforce route, including revocation/company-switch before admission and the documented “admission wins” case; verify restart/recovery and accepted evidence. A DirectAdmin credential cannot be relabelled as a Workforce credential. |
| Trust references | The verification adapter needs fixed issuer, key ID, algorithm and verification-key configuration. No Workforce secret-manager reference/mount contract is wired by the VPS Compose file. | Approve a secret-reference mechanism and rotation/revocation runbook. The Workforce verifier needs public verification material; signing keys stay with the issuer. Never put credentials or private keys in the image, Git, command history or acceptance log. |
| Provider and authority | `createWorkforceDependencies()` is operator-owned. There is no real company resolver/provider or protected identity/authority provisioning in the default image. The host performs a short identity-registry → Workforce-control admission and releases both writer locks before the provider call; the provider keeps an abort and authority-expiry guard at mutation. A source revoke/switch or cancellation after admission cannot undo that operation. | Commission fail-closed `company_id` to physical-store mappings; native `read` and `complete` adapters; current authority/access/evidence; and protected, audited identity provisioning. Do not reenter the registry under the Workforce transaction or hold a five-second registry writer lock across a 30–120 second provider call. Adapters must call `authorityFence.assertCurrent()` immediately before mutation, honor `signal`, and retain `UNCERTAIN` for timeout or unverified outcomes. |
| Network path | Compose binds Workforce to host loopback port 3010. This branch mounts `POST /v1/workforce/conversations` and the #1049 DirectAdmin Fetch handler paths, but DirectAdmin composition is optional and the default image has no commissioned gateway. The receipt owner projection exists, but the read route is still pending the active #1049 SDK change. The generic VPS installer does not route authenticated requests to Workforce. | Review and commission the private reverse-proxy route for the Zero conversation API and `/v1/directadmin/{bootstrap,context,company,logout,titan_workforce/projection,titan_workforce/intents}`; add `/titan_workforce/receipts/{receipt_id}` after the shared SDK exposes `session.receipt()`. Pin the external HTTPS origin in the operator module. Keep port 3010 private and test the exact route. |
| DirectAdmin session boundary | The host constructs the #1049 shared SDK gateway from canonical session and bootstrap-provider ports. It forwards only the exact bootstrap nonce on the bootstrap POST, strips bootstrap cookies and Authorization, and forwards only the canonical Titan DirectAdmin session cookie on established-session routes. PR #1292 now supplies the durable one-time nonce flow, but its issuer and provider both require authenticated DirectAdmin session/key cookies. The #812 RAW relay and Workforce bootstrap route strip those cookies, so this path correctly fails closed until #1300 supplies the trusted same-origin page/session composition. No production module is configured. | Preserve cookie stripping in the generic relay. Integrate the #1300 trusted route so nonce issuance/redemption remains inside the DirectAdmin trust boundary, then prove source-session revocation and company-switch invalidate later admissions, including after restart. A revoke after admission does not cancel an already-started provider action. Never forward or relabel the Workforce conversation bearer credential. |
| Workforce cockpit controls | The authenticated projection conditionally exposes `reassign` only under the canonical human binding and current management checks. `POST /v1/directadmin/titan_workforce/intents` returns a `202 REQUESTED` acknowledgement with a durable accepted-evidence ID after the READY/assignee compare-and-set, fresh approval and evidence verification. Exact-operation replay after store restart returns the same receipt; pause, resume, cancel, escalate and revoke remain denied. A narrow accepted-evidence receipt projection exists in the Workforce owner, but the authenticated GET route remains an #1049 shared-SDK dependency. These disposable-store tests do not commission the optional host module or network route. | Commission the authenticated intent and receipt routes and verify current session, actor/company binding, authority, idempotency and accepted evidence on the approved host. Keep unsupported lifecycle actions disabled; do not treat a `REQUESTED` transport acknowledgement as a client-verified business outcome. |
| Least privilege | The Workforce Dockerfile does not set a non-root user or container security profile. | The deployment owner must provide a reviewed runtime UID, writable-volume ownership, read-only code/config mounts, dropped capabilities, `no-new-privileges`, resource limits and network egress policy. Verify these on the candidate host. |
| Artifact identity | The Dockerfile uses `node:20-alpine`; Compose uses mutable image tags (`latest` by default) and builds from source. There is no signed image provenance contract here. | Pin base and service images by digest in a reviewed release manifest. Publish and verify the builder’s signature/attestation and SBOM. Record archive SHA-256, full source commit/tree, each OCI digest and the Compose/override hash. A SHA-256 by itself does not prove who built an artifact. |
| Backup coverage | `scripts/vps/backup-vps.sh` snapshots the web SQLite file and `runtime/workforce.db`; it does not snapshot the identity registry, per-company databases, Redis, uploads or environment/secret references. | Establish a quiesced, encrypted, access-controlled backup/restore set for every commissioned store, Redis and uploads, with secret *references and versions* recorded separately. Test restoration on a disposable host. |
| Reboot and updates | Local tests cover SIGKILL/restart of runtime execution. The VPS smoke proves process health while deliberately uncommissioned `/ready` remains 503; this is not production readiness or host restart acceptance. | Test actual host reboot, release update, failed update and restoration of the matching data snapshot after commissioning. |

Do not run `scripts/vps/install-vps.sh` on an existing DirectAdmin host for this
acceptance: it requires root, installs packages, enables Docker/Caddy/UFW and
opens firewall ports. Use a newly provisioned disposable Ubuntu/Debian VM with
no other service first. The DirectAdmin Dev Access and Server Node health bridge
are not Workforce authentication, authorization or an execution proxy.

## Release inputs and evidence record

The release owner prepares these items before any host change:

1. An approved full Git commit and tree, the exact source archive and its
   SHA-256, an SBOM, vulnerability report, build provenance/attestation, and
   immutable image digests for web, worker, Workforce and Redis. Pin the Node
   base image digest as well. Record the exact signer identity and verification
   command supplied by the release owner; the repository does not yet define it.
2. The exact `infra/compose.vps.yml`, reviewed commissioning override, and
   non-secret configuration manifest, each identified by commit and SHA-256.
   `docker compose ... config --quiet` may validate the rendered configuration;
   never save or paste rendered config because it can contain expanded secrets.
3. Secret-manager **reference names and version IDs**, not values: web secrets;
   Workforce access-token verification key; any upstream trust keys required by
   the issuer; and protected registry/provider references. The issuer retains
   signing keys. Workforce receives only the approved read access it needs.
4. A signed deployment record naming the host, release ID, operator, UTC window,
   rollback contact, approved listener/proxy route, retention period and
   authorization for the one staged work-order completion.

Capture, without bearer tokens or customer data:

```text
UTC timestamp and operator/change reference
Git commit SHA and tree SHA
source archive SHA-256
SBOM and build-attestation references plus verification result
web / worker / Workforce / Redis OCI digests
Compose and reviewed override hashes
OS, architecture, Docker Engine and Compose versions
secret reference names and versions (never values)
identity, control/evidence and company-store identifiers (never their contents)
readiness, one workflow result, reboot, update and rollback outcomes
```

Do not claim a reproducible artifact while the image/base tags are mutable or
attestation verification is unavailable. Do not copy production credentials or
production records to the disposable host.

On the approved release checkout, the operator can create a source identity
record without including uncommitted files:

```bash
test -z "$(git status --porcelain)"
RELEASE_COMMIT="$(git rev-parse HEAD)"
RELEASE_TREE="$(git show -s --format=%T "$RELEASE_COMMIT")"
git archive --format=tar.gz --prefix=titan-zero/ "$RELEASE_COMMIT" > /tmp/titan-zero-release.tar.gz
sha256sum /tmp/titan-zero-release.tar.gz
printf 'commit=%s\ntree=%s\n' "$RELEASE_COMMIT" "$RELEASE_TREE"
```

The release signer still needs to define the artifact-signature verification
command and key distribution. Do not treat the archive hash above as signature
verification. Record image identity from the approved immutable references, for
example:

```bash
docker image inspect --format='{{.Id}} {{json .RepoDigests}}' "$APPROVED_IMAGE"
```

## Configuration and secret-reference inventory

The deployment record should contain one row per reference below, with its
owner, secret/config manager, version/rotation policy, consumer and access scope.
Use actual names allocated by the deployment owner; the labels here are
categories, not environment variable names or secret values.

| Reference category | Consumer | Minimum access |
| --- | --- | --- |
| Workforce session verification key and issuer metadata | Workforce credential adapter | Read current and staged public verification material only. |
| Canonical identity registry file and its backup reference | Identity/session registry owner | Workforce read access needed for current-session checks; only the protected identity owner may provision/revoke. |
| Runtime/control/evidence database | Workforce process | Read/write only to the dedicated Workforce UID. |
| Per-company business database map and files | Company resolver/native provider | Allowlisted registered companies only; each file owned by the corresponding storage service account. |
| Native provider handles or credentials, if any | Provider adapter | Reference handles scoped by company/capability; never shared through user-controlled paths. |
| TLS certificate/private-key reference and proxy policy | Existing HTTPS/DirectAdmin or approved reverse proxy owner | No Workforce access unless the selected TLS termination requires it. |
| DirectAdmin session lineage, node and credential-service binding | #1049 bridge composed with #302's canonical DirectAdmin-to-Workforce exchange/lineage owner | Fixed audience/node/origin; derived Workforce sessions must be invalidated by source DirectAdmin company switch/revocation; no bearer reuse or relabelling. |
| Backup encryption key and backup destination reference | Backup owner | Write-only backup path for service; restore access restricted to a named recovery operator. |

The current operator module contract exposes `identityStoragePath` and provider
ports but does not define a secret-store protocol, credentials mount, or Compose
volume for that module. A commissioning change must specify those exact paths
and permissions before filling this inventory.

## Host preparation and configuration

After the stop gates are met and the deployment owner explicitly authorizes work
on a **disposable clean host**, prepare it from the exact approved release. Keep
the DirectAdmin host untouched. Use an isolated acceptance company and a real,
authorized staging work order created through its canonical provisioning path;
do not seed fake grants, identities, field evidence or successful outcomes.

Set a private environment file and data roots using the deployment owner’s
secret-reference mechanism. The current installer uses
`/opt/titan-zero/shared/env/.env` (mode `0600`),
`/opt/titan-zero/shared/data/sqlite`, and
`/opt/titan-zero/shared/data/runtime`. Preserve those owners only if the reviewed
commissioning override mounts identity and every company database separately.
Use restrictive directory/file modes and a dedicated container UID. Public
verification keys and the operator factory/configuration are read-only. Each
store is writable only by its designated owner: the Workforce process owns the
runtime/control store, the protected identity owner provisions and revokes
identity records, and each company store follows its registered storage owner.
Give Workforce only the identity-read and company-provider access its adapters
need. Validate that identity/control files have different device/inode and that
each company resolves to its registered physical database.

The operator module’s `createWorkforceDependencies()` must:

- open the existing `GLOBAL_REGISTRY` and fixed runtime/control stores;
- use `createWorkforceSessionCredentialVerifier` with a fixed issuer, key ID,
  algorithm and trusted verification key; its verifier fixes the audience to
  `workforce`;
- resolve each allowlisted `company_id` to its provisioned physical database,
  never to a request-derived path;
- bind provider reads to company, actor and work order; invoke the canonical
  native completion owner with the supplied abort signal and authority fence;
- report actual authentication, registry, authority, provider and evidence
  probes from `readiness()`; and
- close its provider resources in `close()` without erasing durable evidence.

For optional DirectAdmin composition, the operator module exports
`createWorkforceDirectAdminHostServices()` returning a fixed HTTPS
`publicOrigin`, the canonical #302 session-service methods and a trusted #1049
bootstrap provider. Workforce constructs `DirectAdminSessionBridge` and
`createDirectAdminGateway` with its own owner ports; the module cannot inject a
request handler. The host validates Host before pinning the Fetch URL. It
forwards only the exact bootstrap nonce for the exact POST and no bootstrap
cookie or Authorization; existing-session routes receive only the canonical
`__Host-titan-da-session` cookie. Client disconnect cancellation reaches the
SDK `Request.signal` and owner control signal. The #1292 provider requires
authenticated DirectAdmin session/key cookies, which the #812 RAW relay
strips; #1300 owns the compatible trusted page/session route. Until that path
is available, the production provider remains fail-closed. The mount regression
proves request plumbing and sanitized unavailable behavior only, not SDK
cryptographic authentication, production identity provisioning or a real
business operation. Missing composition leaves `/v1/directadmin/*` read-only
with 503; it does not fall back to an unauthenticated or Workforce-audience
route.

Provision the Workforce worker, scoped `work.delegate` and
`crm.work_order.complete` access, active company-scoped field evidence, policy,
verified autonomy and work-order approval through the existing protected owners.
Session identity grants none of those permissions. Confirm the test work order is
assigned to the authenticated lead, its required visit/tasks are complete, and
completing it will not send customer messages, invoice or trigger unrelated
external effects. Record these setup references in the protected change record.

Render and hash the reviewed Compose files, then validate without printing
expanded values. Do not publish port 3010 publicly. The approved proxy must
forward the exact `POST /v1/workforce/conversations` path and authorization
header over a private hop, preserve request company/session assertions, and
avoid logging credentials, bodies, or event content. If DirectAdmin cockpit is
commissioned, test `GET /v1/directadmin/titan_workforce/projection` and
`POST /v1/directadmin/titan_workforce/intents` through the same origin with the
separate #1049 cookie/CSRF bridge and verified #302 session lineage. Also test
`GET /v1/directadmin/context`,
`POST /v1/directadmin/company` and `POST /v1/directadmin/logout`; company switch
and revocation must suppress stale projection/intent responses. DirectAdmin
credentials are never relabelled as Workforce conversation credentials.
Browser-origin, CSRF and session delivery rules remain with #1049 and the
chosen DirectAdmin adapter.

## Clean-host acceptance sequence

Run these checks in order, retaining redacted output and UTC timestamps.
Commands that install packages, create/restore data, change firewall/proxy
configuration or restart services belong to the authorized operator on the
disposable host; this document update did not run them.

1. **Preflight:** verify artifact signature/attestation and all digests against
   the approved release record. Check disk space, OS/architecture, Docker
   versions, time synchronization, DNS/TLS and firewall plan. Confirm the host
   is not shared with DirectAdmin or another customer. Validate Compose quietly.
   Record the read-only facts with `id`, `uname -a`, `docker version`,
   `docker compose version` and `docker compose ... config --quiet`; do not emit
   `.env` or expanded Compose settings.
2. **Least privilege and storage:** inspect the effective container user,
   capabilities, mounts, network, resource limits and egress. Fail if Workforce
   runs as root, has a Docker socket, can write its image/config, or accepts
   public traffic directly. Verify separate physical identity/control stores and
   exact allowlisted company mappings; verify no request field can select a path.
3. **Initial health:** after approved startup, require `GET /health` to return
   200 for process liveness and `GET /ready` to return 200 only when storage,
   current identity, authority, provider and evidence checks all succeed. With
   the dependency module removed in a disposable test copy, require startup to
   fail before listening and library-host `/ready` to remain 503. Hold a real
   authorized provider call across `/ready`: the probe must return by its one
   second deadline, `/health` must remain 200, and a later probe must recover
   after the write completes. Readiness timeout must not cancel or bypass the
   authority-fenced business operation.
4. **Authentication negatives:** using protected test credentials, require
   rejection of missing/tampered/wrong-audience/stale/revoked tokens, actor,
   device or selected-company mismatch, and a company A token presented with
   company B. Revoke and switch a session, then repeat after a Workforce restart.
   Confirm all failures occur before business mutation and disclose no token or
   crypto/registry detail in response or logs.
5. **One company-scoped workflow:** generate fresh conversation, interaction,
   request, operation, trace, correlation and idempotency IDs. Send the approved
   command to the private route with the short-lived credential supplied by the
   commissioned issuer. Use the selected company, actor, device, surface `zero`,
   session ID/revision, and `complete work order <approved-staging-work-id>`.
   Expect a completed public run event with the work/run/correlation IDs. Then
   independently read the same work order from that company’s canonical native
   store and confirm `status='completed'` and non-null `completed_at`.

   The request must include all `titan.workforce.conversation.v1` identity and
   correlation fields. On the host, prepare a mode-0600 JSON body in a private
   runtime directory; obtain company/actor/device/session/revision only from the
   authenticated #1049/#302 handoff, and generate fresh UUIDs for conversation,
   interaction, client message, request, operation, correlation, trace and
   idempotency IDs. Keep the approved bearer token in the issuer/secret manager;
   do not put it in the JSON body, shell history, process arguments or output.
   Send `POST /v1/workforce/conversations` to the private loopback listener using
   an ephemeral curl config file with mode 0600 for its Authorization header.
   Use `Accept: application/json` for this bounded completion check; buffered
   SSE is not a live streaming acceptance test. Delete the transient request,
   header and response files after retaining their IDs and redacted result.
6. **Accepted evidence and isolation:** inspect the scoped runtime/control
   evidence row for that company and work ID. Require gateway state `VERIFIED`,
   `accepted_evidence.schema='titan.business.accepted-evidence/v1'`,
   `accepted_evidence.final_outcome='verified'`,
   `accepted_evidence.verification.verified=true`, and matching company, actor,
   run, work and execution IDs. Confirm the evidence provenance retains the same
   request/operation/trace/conversation/interaction/correlation/idempotency IDs.
   Independently inspect company B’s same-named work order and confirm its
   state and evidence did not change. A provider response alone is not acceptance.
   For the current SQLite representation, a read-only inspection can select the
   evidence row with bound values from the runtime/control database:

   ```sql
   SELECT id, json_extract(payload,'$.state') AS gateway_state,
          json_extract(payload,'$.accepted_evidence.schema') AS evidence_schema,
          json_extract(payload,'$.accepted_evidence.final_outcome') AS final_outcome,
          json_extract(payload,'$.accepted_evidence.verification.verified') AS independently_verified,
          json_extract(payload,'$.provenance.company_id') AS company_id,
          json_extract(payload,'$.provenance.actor_id') AS actor_id,
          json_extract(payload,'$.provenance.run_id') AS run_id,
          json_extract(payload,'$.provenance.work_id') AS work_id,
          json_extract(payload,'$.provenance.request_id') AS request_id,
          json_extract(payload,'$.provenance.operation_id') AS operation_id,
          json_extract(payload,'$.provenance.trace_id') AS trace_id,
          json_extract(payload,'$.provenance.conversation_id') AS conversation_id,
          json_extract(payload,'$.provenance.interaction_id') AS interaction_id,
          json_extract(payload,'$.provenance.correlation_id') AS correlation_id,
          json_extract(payload,'$.provenance.idempotency_key') AS idempotency_key
     FROM evidence
    WHERE company_id = ? AND subject_type = 'work' AND subject_id = ?
      AND evidence_type = 'gateway_execution'
    ORDER BY rowid DESC;
   ```

   Require the terminal row to be `VERIFIED`; intermediate lifecycle rows are
   expected. Bind the authorized company/work IDs and compare the returned
   accepted evidence ID to the response/projection. Never query another
   company’s database by substituting request identifiers.
7. **Replay and uncertain execution:** replay the same start and require no
   second native mutation. Cancel a waiting run and require no subsequent effect.
   On a disposable clone, SIGKILL once before mutation and once after the company
   commit but before acknowledgement. Restart and use explicit authenticated
   `resume`; require verifier-only recovery, no blind execution, current session
   and authority revalidation, and correct `UNCERTAIN`/observed evidence.
   Do not improvise a production fault injection.
8. **Reboot:** after quiesced encrypted backups, reboot the clean host. Confirm
   containers reappear on the same approved image digests, readiness is truthful,
   identity revocation survives, and the completed workflow replays without a
   second mutation. Confirm pending uncertain operations remain uncertain until
   independently reconciled.
9. **Update:** on the disposable host, snapshot the complete data set, install a
   second signed immutable release using the reviewed upgrade method, and record
   every schema change. Re-run health, authentication, company isolation,
   workflow replay and evidence checks. Do not assume the legacy in-place
   `scripts/vps/update-vps.sh` works; it is intentionally disabled.
10. **Rollback and restore:** use the previous signed images/configuration plus
    the matching tested snapshot. Restore every store as a set: runtime/control,
    identity/revocation, all company DBs, Redis state as required, uploads and
    secret-reference versions. Verify SQLite integrity/foreign keys, then repeat
    health and read-only company/evidence checks. If an irreversible schema
    migration or external effect cannot be restored safely, stop and follow the
    deployment owner’s incident plan; changing a `current` symlink alone is not
    a data rollback. Record the previous image digests and snapshot IDs.

Acceptance is a **pass** only if every applicable step has evidence and no
unauthorized effect or cross-company read/write occurred. Record a failed or
unavailable step as blocked; never substitute CI, `/health`, fake credentials,
an unconfigured `/ready`, or a successful provider acknowledgement for host
acceptance.

## Incremental streaming and resume handoff (#1182)

Streaming remains an explicit acceptance item owned by #1182. The current
`writeConversationResponse()` receives the event array only after dispatch has
finished; `Accept: text/event-stream` is a completed-event projection.
`Last-Event-ID` filters that returned array. It does not provide live deltas,
durable cursor replay, or process-restart reconnect.

Keep #811’s server/bootstrap and readiness ownership in
`services/workforce/src/server.ts`. A file-separated #1182 delivery should own a
new `services/workforce/src/conversation-stream.ts`, its
`services/workforce/src/conversation-stream.test.ts`, and the conversation
transport adapter in `services/workforce/src/conversation-api.ts`. It must
coordinate the narrow `server.ts` integration point with #811 before editing
that file. Do not replace the canonical runtime event bus or add a parallel run
ledger; work with its owner to persist ordered, company/run-bound event IDs and
replay cursors if the existing run store cannot prove them.

#1182 acceptance must prove: events arrive before the run completes; ordering
and IDs remain stable across reconnect/restart; `Last-Event-ID` resumes without
gaps/duplicates; company/session/revision are revalidated on reconnect; cancel
stops only that authorized run; backpressure/disconnect does not create a second
provider call; and the eventual company-scoped effect still has independent
observed completion and accepted evidence. Until those tests pass, record the
stream/reconnect step as blocked and keep #1182 open.
