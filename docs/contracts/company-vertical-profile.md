# Company vertical profile selection

## Ownership

- The selected-profile contract and writer live beside the existing `VerticalPackStore` in `packages/titan-platform/src/vertical-pack.ts`.
- Available Cleaning module IDs and versions come from `packages/modules/bundles/cleaning-workforce.bundle.json`; the stored value does not copy bundle content, capabilities, job types, workers, or pack lifecycle records.
- Persistence reuses `companies.settings` in the company-native database from `db/sqlite/company-native/0001_work_orders.sql`. The company database is selected through the existing company placement resolver and physical store lease. No table, registry, settings ledger, or onboarding store is added.
- The generic `packages/settings/control-plane` registry remains the owner of policy preferences. Vertical profile identity and pack selection are module configuration, so this contract does not add a duplicate policy setting.

## Persisted value

The company settings object contains one `vertical_profile` value:

```json
{
  "schema": "titan.company.vertical-profile.v1",
  "company_id": "company-id",
  "revision": 1,
  "profile": {
    "pack_id": "titan.cleaning-workforce-pack",
    "pack_version": "1.0.0",
    "module_id": "titan.workforce.cleaning",
    "module_version": "1.0.0"
  }
}
```

The writer merges this key with existing company settings in one SQLite transaction. It only supplies a default when no profile is saved. A saved profile is retained across reads and logins; a saved Cleaning profile whose bundle/module is stale is reported as stale and left intact. If the Cleaning bundle is unavailable, the writer does not create a default. Malformed profile state fails closed without being overwritten.

Explicit profile changes require the host's authorization callback, the canonical pack owner's availability resolver, and the expected settings revision. A profile setting does not create staff, activate tools, or grant business authority.

## Route composition status

The login route calls `initializeCleaningProfileForLogin` after canonical session issuance and before publishing the session cookie. It passes the issued verified session to `withVerifiedWebNativeCompanyStore`, the shared #1409 request-runtime composition used by native requests. That owner API selects and attests the registered native schema version and revalidates the same credential during lease checks. Login accepts no request-provided company or placement. Profile initialization supports existing native schema versions v1, v2, and v3 without migrating them.

Production composition reads the existing `TITAN_WEB_IDENTITY_REGISTRY_PATH` and `TITAN_COMPANY_DATA_ROOT` settings. They must identify an existing commissioned GLOBAL_REGISTRY and trusted company-store root; the app only opens them and does not create, migrate, or provision either one. Missing configuration, an unavailable placement, or an unsupported native schema fails login with a safe 503 before the cookie is set. A credential issued before this check is revoked on failure. Checklist-capable fresh provisioning can explicitly select native schema v3; the provisioner's compatibility default remains v2. Tests use disposable registry/company files or injected ports; they do not change production identity, placement, or store configuration.
