import { describe, expect, it, vi } from "vitest";
import {
  CompanyStorageResolutionError,
  createCompanyStorageResolver,
  type CompanyPlacementRecord,
  type VerifiedCompanyScope,
} from "../../../../packages/storage/src/company-storage-resolver";
import type { StorageClient } from "../../../../packages/storage/src/index";
import { NativeCompanyStoreCloseAfterOperationError, withNativeCompanyStore } from "./consumer";
import { createSqliteStorage } from "../../../../packages/storage/src/sqlite-client";
import { initializeFreshCompanyNativeStore } from "../../../../packages/storage/src/company-native-store-initializer";
import { companyNativeVisitChecklistManifest, companyNativeWorkOrdersVisitsManifest } from "../../../../packages/storage/src/company-native-schema-manifest";
import type { CurrentWebSession } from "../auth/current-session";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSqliteCompanyPlacementRegistry, createSqliteCompanyPlacementRegistry } from "../../../../packages/storage/src/company-placement-registry";
import { provisionSqliteCompanyPlacement } from "../../../../packages/storage/src/company-placement-provisioner";
import { createSqliteCompanyStoreOpener } from "../../../../packages/storage/src/company-store-opener";
import { companyNativeWorkOrdersManifest } from "../../../../packages/storage/src/company-native-schema-manifest";
import { computeCompanyNativeSchemaManifestDigest, fingerprintCompanyNativeSchema, verifyCompanyNativeSchemaAttestation } from "../../../../packages/storage/src/company-native-schema-attestation";

const scope: VerifiedCompanyScope = {
  kind: "authenticated",
  current: {
    company_id: "company-a", actor_id: "actor-a", session_id: "session-a",
    session_revision: 2, context_revision: "membership-2", audience: "titan-web",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), authority_neutral: true,
  },
};
// Same identity projection returned by #302's createCurrentWebSessionIngress:
// scope and company come from one credential-derived, revalidated context.
const currentSession: CurrentWebSession = Object.freeze({
  session: Object.freeze({ userId: "actor-a", accountId: "legacy-account-a", role: "owner" as const }),
  context: Object.freeze({
    company_id: "company-a", actor_id: "actor-a", device_id: "device-a", session_id: "session-a",
    session_revision: 2, context_revision: "membership-2", audience: "titan-web",
    expires_at: scope.current.expires_at, authority_neutral: true as const,
  }),
  scope,
  operationCompanyIds: Object.freeze(["company-a"] as const),
});

async function setup(options: {
  status?: CompanyPlacementRecord["status"];
  company_id?: string;
  revision?: number;
  assertPhysicalPath?: () => Promise<void>;
  close?: () => Promise<void>;
  attested?: boolean;
  attestedCompanyId?: string;
  schemaVersion?: string;
  attestedSchemaVersion?: string;
} = {}) {
  let revision = options.revision ?? 4;
  const physical = createSqliteStorage(":memory:");
  const placement = {
      company_id: options.attestedCompanyId ?? "company-a",
    placement_id: "opaque-company-a",
    placement_revision: options.revision ?? 4,
    provider: "sqlite" as const,
    schema_version: options.attestedSchemaVersion ?? companyNativeWorkOrdersVisitsManifest.schema_version,
  };
  if (options.attested !== false) {
    if (placement.schema_version === companyNativeWorkOrdersVisitsManifest.schema_version) {
      await initializeFreshCompanyNativeStore({ storage: physical, placement, company_profile: { name: "Company A" } });
    } else {
      await physical.query(`CREATE TABLE titan_company_native_schema_migrations (
        sequence INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL)`);
      await physical.query(`CREATE TABLE titan_company_native_schema_attestation (
        singleton_id TEXT PRIMARY KEY CHECK(singleton_id='COMPANY_NATIVE_FSM'), company_id TEXT NOT NULL,
        placement_id TEXT NOT NULL, placement_revision INTEGER NOT NULL CHECK(placement_revision > 0),
        schema_version TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, schema_fingerprint_sha256 TEXT NOT NULL)`);
      const migration = companyNativeWorkOrdersManifest.migrations[0]!;
      const sql = await readFile(new URL(`../../../../${migration.path}`, import.meta.url), "utf8");
      for (const statement of sql.split(";").map(value => value.trim()).filter(Boolean)) await physical.query(statement);
      await physical.query("INSERT INTO companies(id,name) VALUES($1,$2)", [placement.company_id, "Company A"]);
      const fingerprint = await fingerprintCompanyNativeSchema(physical);
      const digest = computeCompanyNativeSchemaManifestDigest(companyNativeWorkOrdersManifest);
      await physical.query("INSERT INTO titan_company_native_schema_migrations(sequence,migration_id,sha256) VALUES($1,$2,$3)",
        [migration.sequence, migration.migration_id, migration.sha256]);
      await physical.query(`INSERT INTO titan_company_native_schema_attestation
        (singleton_id,company_id,placement_id,placement_revision,schema_version,manifest_sha256,schema_fingerprint_sha256)
        VALUES('COMPANY_NATIVE_FSM',$1,$2,$3,$4,$5,$6)`,
      [placement.company_id, placement.placement_id, placement.placement_revision, placement.schema_version, digest, fingerprint]);
      await verifyCompanyNativeSchemaAttestation({ storage: physical, placement, manifest: companyNativeWorkOrdersManifest });
    }
  }
  const close = vi.fn(options.close ?? (async () => physical.close()));
  const client: StorageClient = {
    dialect: "sqlite",
    query: <T>(sql: string, params?: readonly unknown[]) => physical.query<T>(sql, params),
    transaction: <T>(fn: (tx: StorageClient) => Promise<T>) => physical.transaction(fn),
    close,
  };
  const registry = {
    findByCompanyId: vi.fn(async (companyId: string) => ({
      company_id: options.company_id ?? companyId,
      placement_id: "opaque-company-a", placement_revision: revision,
      provider: "sqlite" as const, schema_version: options.schemaVersion ?? companyNativeWorkOrdersVisitsManifest.schema_version,
      status: options.status ?? "READY",
    })),
  };
  const opener = {
    open: vi.fn(async (placement: { company_id: string; placement_id: string; placement_revision: number;
      provider: "sqlite"; schema_version: string }) => ({
      ...placement, client,
      assertPlacementBound: options.assertPhysicalPath ?? (async () => undefined),
    })),
  };
  const resolver = createCompanyStorageResolver({
    registry,
    opener,
    scopeRevalidator: { assertCurrent: async () => undefined },
  });
  return { client, registry, opener, resolver, close, setRevision(value: number) { revision = value; } };
}

describe("native company-store consumer", () => {
  it("consumes a real READY registry placement and its attested company file", async () => {
    const root = await mkdtemp(join(tmpdir(), "titan-native-consumer-"));
    const dbRoot = join(root, "db");
    const fileRoot = join(root, "files");
    await mkdir(dbRoot, { mode: 0o700 });
    await mkdir(fileRoot, { mode: 0o700 });
    const registryStorage = createSqliteStorage(join(root, "registry.sqlite"));
    try {
      const registryInput = {
        storage: registryStorage, storage_role: "GLOBAL_REGISTRY" as const,
        companyStoreRoot: dbRoot, companyFileStoreRoot: fileRoot,
      };
      await initializeSqliteCompanyPlacementRegistry({ storage: registryStorage, storage_role: "GLOBAL_REGISTRY" });
      const provisioned = await provisionSqliteCompanyPlacement({
        registry: registryInput,
        company_id: "company-a",
        company_name: "Company A",
        schema_version: companyNativeVisitChecklistManifest.schema_version,
      });
      const registry = await createSqliteCompanyPlacementRegistry({ storage: registryStorage, storage_role: "GLOBAL_REGISTRY" });
      const resolver = createCompanyStorageResolver({
        registry,
        opener: createSqliteCompanyStoreOpener({ companyStoreRoot: dbRoot }),
        scopeRevalidator: { assertCurrent: async () => undefined },
      });
      const result = await withNativeCompanyStore({
        resolver, current_session: currentSession,
        required_schema_version: companyNativeVisitChecklistManifest.schema_version,
        operation: async client => ({
          file: (await client.query<{ file: string }>("PRAGMA database_list")).rows.find(row => row.file)?.file,
          companies: (await client.query<{ id: string }>("SELECT id FROM companies")).rows,
        }),
      });
      expect(result).toEqual({
        file: join(dbRoot, `${provisioned.placement_id}.sqlite`),
        companies: [{ id: "company-a" }],
      });
    } finally {
      await registryStorage.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the resolved company and uses only its ready physical store", async () => {
    const f = await setup();
    const operation = vi.fn(async (client: StorageClient) => client.dialect);

    await expect(withNativeCompanyStore({
      resolver: f.resolver, current_session: currentSession,
      required_schema_version: companyNativeWorkOrdersVisitsManifest.schema_version, operation,
    })).resolves.toBe("sqlite");

    expect(f.registry.findByCompanyId).toHaveBeenCalledWith("company-a", { signal: undefined });
    expect(f.opener.open).toHaveBeenCalledWith(expect.objectContaining({
      company_id: "company-a", placement_id: "opaque-company-a", placement_revision: 4,
      provider: "sqlite", schema_version: companyNativeWorkOrdersVisitsManifest.schema_version,
    }), expect.objectContaining({ assertCurrent: expect.any(Function), signal: undefined }));
    expect(operation).toHaveBeenCalledWith(f.client);
    expect(f.client.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a company mismatch before any physical open", async () => {
    const f = await setup();
    const operation = vi.fn();
    await expect(withNativeCompanyStore({
      resolver: f.resolver, current_session: { ...currentSession, context: { ...currentSession.context, company_id: "company-b" } },
      required_schema_version: companyNativeWorkOrdersVisitsManifest.schema_version, operation,
    })).rejects.toThrow("native-company-session-scope-mismatch");
    expect(f.opener.open).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects a public-capability scope for an authenticated native session consumer", async () => {
    const f = await setup();
    const operation = vi.fn();
    const publicScope: VerifiedCompanyScope = {
      kind: "public-capability",
      capability: {
        resource_type: "visit", resource_id: "visit-a", action: "read",
        company_id: "company-a", capability_id: "capability-a", expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      requested: { resource_type: "visit", resource_id: "visit-a", action: "read" },
    };
    await expect(withNativeCompanyStore({
      resolver: f.resolver, current_session: { ...currentSession, scope: publicScope },
      required_schema_version: companyNativeWorkOrdersVisitsManifest.schema_version, operation,
    })).rejects.toThrow("native-company-session-scope-mismatch");
    expect(f.registry.findByCompanyId).not.toHaveBeenCalled();
    expect(f.opener.open).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });

  it("fails closed without a real READY marker", async () => {
    const f = await setup({ status: "PROVISIONING" });
    const operation = vi.fn();
    await expect(withNativeCompanyStore({
      resolver: f.resolver, current_session: currentSession,
      required_schema_version: companyNativeWorkOrdersVisitsManifest.schema_version, operation,
    })).rejects.toMatchObject({ code: "placement-not-ready" } satisfies Partial<CompanyStorageResolutionError>);
    expect(f.opener.open).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });

  it("fails closed when the registry says READY but the opened database has no canonical attestation marker", async () => {
    const f = await setup({ attested: false });
    const operation = vi.fn();
    await expect(withNativeCompanyStore({ resolver: f.resolver, current_session: currentSession,
      required_schema_version: companyNativeWorkOrdersVisitsManifest.schema_version, operation }))
      .rejects.toMatchObject({ code: "company-native-schema-marker-missing" });
    expect(f.client.close).toHaveBeenCalledTimes(1);
    expect(operation).not.toHaveBeenCalled();
  });

  it("denies a v1 placement to the v2 visit-checklist consumer before invoking its callback", async () => {
    const v1 = companyNativeWorkOrdersManifest.schema_version;
    const f = await setup({ schemaVersion: v1, attestedSchemaVersion: v1 });
    const operation = vi.fn();
    await expect(withNativeCompanyStore({
      resolver: f.resolver, current_session: currentSession,
      required_schema_version: companyNativeWorkOrdersVisitsManifest.schema_version, operation,
    })).rejects.toThrow("native-company-schema-version-unsupported");
    expect(f.client.close).toHaveBeenCalledTimes(1);
    expect(operation).not.toHaveBeenCalled();
  });

  it("closes the store and rejects a physical path or restore identity mismatch", async () => {
    const f = await setup({ assertPhysicalPath: async () => { throw new Error("store-path-identity-mismatch"); } });
    const operation = vi.fn();
    await expect(withNativeCompanyStore({
      resolver: f.resolver, current_session: currentSession,
      required_schema_version: companyNativeWorkOrdersVisitsManifest.schema_version, operation,
    })).rejects.toMatchObject({ code: "company-store-binding-mismatch" });
    expect(f.client.close).toHaveBeenCalledTimes(1);
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects a stale placement revision after the operation before accepting its result", async () => {
    const f = await setup();
    const operation = vi.fn(async () => {
      f.setRevision(5);
      return "unverified";
    });
    await expect(withNativeCompanyStore({
      resolver: f.resolver, current_session: currentSession,
      required_schema_version: companyNativeWorkOrdersVisitsManifest.schema_version, operation,
    })).rejects.toMatchObject({ code: "placement-stale" });
    expect(f.client.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a restored database attested to another company before the operation", async () => {
    const f = await setup({ attestedCompanyId: "company-b" });
    const operation = vi.fn();
    await expect(withNativeCompanyStore({ resolver: f.resolver, current_session: currentSession,
      required_schema_version: companyNativeWorkOrdersVisitsManifest.schema_version, operation }))
      .rejects.toMatchObject({ code: "company-native-schema-company-mismatch" });
    expect(f.client.close).toHaveBeenCalledTimes(1);
    expect(operation).not.toHaveBeenCalled();
  });

  it("marks close failure after a successful callback as unsafe to retry", async () => {
    const closeError = new Error("sqlite-close-failed");
    const f = await setup({ close: async () => { throw closeError; } });
    const operation = vi.fn(async () => "write-returned");

    await expect(withNativeCompanyStore({
      resolver: f.resolver, current_session: currentSession,
      required_schema_version: companyNativeWorkOrdersVisitsManifest.schema_version, operation,
    })).rejects.toMatchObject({
      name: "NativeCompanyStoreCloseAfterOperationError",
      message: "native-company-store-close-after-operation",
      operation_returned_successfully: true,
      automatic_retry_allowed: false,
      cause: closeError,
    } satisfies Partial<NativeCompanyStoreCloseAfterOperationError>);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(f.client.close).toHaveBeenCalledTimes(1);
  });
});
