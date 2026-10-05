# Issue #1300 nonce handoff checkpoint

Date: 2026-10-02

## Reconciled source

The local `agent/issue-1300` branch was fast-forwarded from `999408ac3d891fc86b2e890376a2119e7e0d65c2` to current `origin/main` `ad850422704cb4c305b1c1abd1e81631746fc720`. There were no intervening edits to the Workforce composition or DirectAdmin Workforce browser paths.

## Verified bounded behavior

The prototype in local-only commit `8eac5500` on `checkpoint/issue-1300-existing-session-prototype` exercises nonce issuance only when an already-authenticated Titan DirectAdmin session is present. It derives company/device from that authenticated session, reauthenticates the DirectAdmin session through the canonical #1292 flow, and returns only the opaque nonce and expiry. It does not select company/device for a first session and is not part of this draft PR.

On the reconciled base:

- Focused composition tests: 5/5 pass.
- Workforce suite: 60/60 pass.
- DirectAdmin RAW relay suite: 20/20 pass.
- Workforce TypeScript typecheck: pass.
- `git diff --check`: pass.

The local composition/test SHA-256 values are `a42bda9778fc1e7c3a2973258c49a5cd7942587ca45d0b602a68bca8adf3783e` and `9a447868ff3545c6291381d3eaeb9d893df0a75427d175d6ac0143d8f3f80d8a`.

## Production handoff blocker

Do not mount or publish the local helper as a production route yet. It expects the incoming request to contain both `__Host-titan-da-session` and the DirectAdmin `session`/`key` cookie pair, then supplies that pair to `flow.issueNonce` for `/api/session` reauthentication.

The current #812 RAW allowlist has no `/v1/directadmin/bootstrap/nonce` route. Its existing bootstrap route rejects incoming cookies and forwards no cookie to the private Workforce gateway; the RAW tests verify this boundary. Adding this helper behind that relay would either fail because the DirectAdmin cookie pair is absent, or require forwarding those cookies to Workforce, which violates the established boundary. The passing composition tests invoke the helper directly and do not prove the extracted RAW/browser-to-private-host path.

Two host primitives are absent:

1. A DirectAdmin-side authenticated server handler that can read the ambient session/key cookies inside that boundary, call `/api/session`, obtain exactly one current company/device from the #302 resolver, and invoke the #1292 nonce issuer without sending raw cookies through the generic relay.
2. A private server-side handoff from that adapter to the existing #1049/#302 session issuer that accepts the verified `titan-login+jwt` assertion and the same canonical company/device tuple, then calls `sessions.issue(assertion, { company_id, device_id })`. The current browser `/v1/directadmin/bootstrap` route receives no DirectAdmin cookie through #812 and has no assertion-input path for this separate trusted adapter.

The first-session resolver/API response remains pending with #302. The #1050-owned browser files were not changed. Until these primitives exist, keep this composition unmounted. Once the resolver source and the private handoff contract arrive, wire the host adapter within #1300, coordinate any shared RAW entrypoint change with its owner, and test the real route through the extracted package without forwarding raw DirectAdmin cookies.

No production config, live host, credentials, key, DNS, firewall, or migration was changed. The local prototype is preserved separately and remains unmerged pending the handoff review.
