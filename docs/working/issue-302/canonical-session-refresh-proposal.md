# Canonical session continuation — deferred design proposal

**Status:** proposal only. This document does not change the active #302
credential contract, add an issuer or endpoint, create credentials or registry
records, change a five-minute limit, or authorize rollout.

## Current behavior remains authoritative

The current contract in
[`authenticated-session-credentials.md`](../../contracts/authenticated-session-credentials.md)
keeps both the upstream authentication assertion and the resulting web session
at no more than 300 seconds. Company switching does not extend expiry. After
expiry, the user authenticates again. That remains the implemented and selected
policy for this work.

## Future design, only if the owner later changes the policy

If product later decides that a five-minute re-login cadence is unacceptable,
design one canonical continuation operation inside the existing identity/session
owner. Do not add an issuer to DirectAdmin, the web app, an SDK, or a second
identity store. A continuation credential would be a security-sensitive
persistent access mechanism; it must not be built or commissioned under the
current decision.

The later design should require all of the following before implementation:

1. **Explicit lifetime policy.** Decide maximum authentication age, idle
   lifetime, and whether the hard five-minute ceiling changes. The source
   contract must state numeric limits. Until then, no refresh operation exists.
2. **Canonical ownership.** The existing credential service alone owns
   continuation issuance, verification, rotation and revocation. It accepts no
   caller-supplied actor, company, device, session ID, revision, issuer, key or
   audience as proof.
3. **Cryptographic binding.** A continuation proof is bound to the configured
   issuer namespace (including the exact DirectAdmin host where applicable),
   stable subject, actor, session family, selected company, device, audience,
   context/session revisions, and the approved absolute expiry. Algorithm and
   key are pinned by existing server configuration; no request-controlled key
   lookup or algorithm negotiation is allowed.
4. **One-use rotation in the existing registry.** If a future approved design
   uses a continuation handle, store only a verifier/hash in the existing
   GLOBAL_REGISTRY. Consume it atomically with rotation and session-state
   revalidation. Reuse, stale generation, changed company/device/membership,
   revocation, or registry uncertainty fails closed. Replay must not mint a new
   access credential.
5. **No sliding authority.** A rotated handle cannot move the approved absolute
   authentication deadline. Every renewal checks current actor, company,
   membership, device and context/session revisions before issuing a new short
   access credential. A company switch cannot renew or extend the session.
6. **Browser handling.** Only after policy approval, keep any handle in a
   Secure, HttpOnly, SameSite cookie; require a CSRF-protected same-origin POST
   for renewal. Never put it in local storage, URLs, logs, analytics, or
   ordinary evidence.
7. **No identity repair by renewal.** Continuation cannot backfill missing
   memberships or restore revoked access. Historical users without authoritative
   current membership evidence remain denied.

This proposal deliberately leaves the maximum session age, idle timeout and
continuation credential lifetime unspecified. Selecting those values would
change the current five-minute security policy and requires a separate owner
decision. Until that decision and an independently reviewed implementation are
complete, callers must present fresh authentication after expiry.
