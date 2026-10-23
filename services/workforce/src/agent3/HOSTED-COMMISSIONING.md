# Agent 3 Pass 12 — hosted commissioning (draft)
The actual hosted entrypoint is hosted-runtime.ts → field-service-runtime.mjs → production-runtime-bootstrap.ts. The two upstream modules now forward **operator-owned, preflight-validated** Agent 3 ports to the existing bootstrap.
Absent operator configuration, all previous native behavior is unchanged.
Explicit commissioning requires strict company allowlist, independent owner attestation, and pre-existing three Agent 3 transport/ownership SQLite tables. Startup fails closed if any are missing. No automatic migration or HTTP activation exists.
This is NOT live Hatchet certification. Verify Tier-3 repo tests, full native entrypoint inventory, tenant-bound credentials, identity/evidence review, staging worker recovery and rollback before enabling or merging.
