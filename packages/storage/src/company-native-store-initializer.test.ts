import { afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyCompanyNativeSchemaAttestation } from "./company-native-schema-attestation.js";
import { companyNativeVisitChecklistManifest, companyNativeWorkOrdersManifest, companyNativeWorkOrdersVisitsManifest } from "./company-native-schema-manifest.js";
import { initializeFreshCompanyNativeStore } from "./company-native-store-initializer.js";
import { computeCompanyNativeSchemaManifestDigest, fingerprintCompanyNativeSchema } from "./company-native-schema-attestation.js";
import { createSqliteStorage } from "./sqlite-client.js";
import { createSqliteCompanyStoreOpener } from "./company-store-opener.js";
import type { StorageClient } from "./index.js";

const stores: StorageClient[] = [];
const tempDirs: string[] = [];
const companyId = "fresh-native-a";
const placement = Object.freeze({
  company_id: companyId,
  placement_id: "fresh-native-placement-a",
  placement_revision: 4,
  provider: "sqlite" as const,
  schema_version: companyNativeWorkOrdersVisitsManifest.schema_version,
});
const companyProfile = Object.freeze({ name: "Fresh Native A" });

function memoryStore(): StorageClient {
  const storage = createSqliteStorage(":memory:");
  stores.push(storage);
  return storage;
}

async function seedAttestedV1Store(storage: StorageClient): Promise<void> {
  await storage.query(`CREATE TABLE titan_company_native_schema_migrations (
    sequence INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL)`);
  await storage.query(`CREATE TABLE titan_company_native_schema_attestation (
    singleton_id TEXT PRIMARY KEY CHECK(singleton_id='COMPANY_NATIVE_FSM'), company_id TEXT NOT NULL,
    placement_id TEXT NOT NULL, placement_revision INTEGER NOT NULL CHECK(placement_revision > 0),
    schema_version TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, schema_fingerprint_sha256 TEXT NOT NULL)`);
  const migration = companyNativeWorkOrdersManifest.migrations[0]!;
  const sql = await readFile(new URL(`../../../${migration.path}`, import.meta.url), "utf8");
  for (const statement of sql.split(";").map(value => value.trim()).filter(Boolean)) await storage.query(statement);
  await storage.query("INSERT INTO companies(id,name) VALUES($1,$2)", [companyId, companyProfile.name]);
  const fingerprint = await fingerprintCompanyNativeSchema(storage);
  const digest = computeCompanyNativeSchemaManifestDigest(companyNativeWorkOrdersManifest);
  await storage.query("INSERT INTO titan_company_native_schema_migrations(sequence,migration_id,sha256) VALUES($1,$2,$3)",
    [migration.sequence, migration.migration_id, migration.sha256]);
  await storage.query(`INSERT INTO titan_company_native_schema_attestation
    (singleton_id,company_id,placement_id,placement_revision,schema_version,manifest_sha256,schema_fingerprint_sha256)
    VALUES('COMPANY_NATIVE_FSM',$1,$2,$3,$4,$5,$6)`,
  [companyId, placement.placement_id, placement.placement_revision, companyNativeWorkOrdersManifest.schema_version, digest, fingerprint]);
}

async function newTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "titan-native-store-"));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(storage => storage.close().catch(() => undefined)));
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("fresh native-work-orders-visits-v2 schema producer", () => {
  it("pins donor migration bytes and the new native migrations independently", async () => {
    for (const source of companyNativeWorkOrdersVisitsManifest.source_provenance) {
      const bytes = await readFile(new URL(`../../../${source.path}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(source.sha256);
    }
    for (const migration of companyNativeWorkOrdersVisitsManifest.migrations) {
      const bytes = await readFile(new URL(`../../../${migration.path}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(migration.sha256);
    }
  });

  it("initializes the real fresh SQLite migration and returns the exact placement witness", async () => {
    const storage = memoryStore();
    const witness = await initializeFreshCompanyNativeStore({ storage, placement, company_profile: companyProfile });
    expect(witness).toMatchObject({
      company_id: companyId,
      placement_id: placement.placement_id,
      placement_revision: placement.placement_revision,
      provider: "sqlite",
      schema_version: placement.schema_version,
      manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      schema_fingerprint_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const objects = (await storage.query<{ name: string; type: string }>(
      "SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )).rows;
    const tables = objects.filter(object => object.type === "table").map(object => object.name).sort();
    expect(tables).toEqual([
      "clients", "companies", "jobs", "properties", "titan_company_native_schema_attestation",
      "titan_company_native_schema_migrations", "visit_tasks", "visits", "work_order_tasks", "work_orders",
    ]);
    expect(tables).not.toContain("users");
    expect(tables).not.toContain("authority_state");
    expect(tables).not.toContain("evidence");
    expect(tables).not.toContain("local_queue");
    expect(tables.filter(name => !name.startsWith("titan_company_native_schema_")))
      .toEqual([...companyNativeWorkOrdersVisitsManifest.schema_scope].sort());
    expect((await storage.query("PRAGMA foreign_key_check")).rows).toEqual([]);
    expect((await storage.query<{ integrity_check: string }>("PRAGMA integrity_check")).rows)
      .toEqual([{ integrity_check: "ok" }]);

    // Actor ids are opaque references from the verified session; no local
    // password, role, or users table participates in native work-order writes.
    await storage.query("INSERT INTO clients(id,company_id,name) VALUES('client-a',$1,'A')", [companyId]);
    await storage.query("INSERT INTO properties(id,company_id,client_id,name,address) VALUES('property-a',$1,'client-a','Property A','1 Main St')", [companyId]);
    await storage.query(
      "INSERT INTO jobs(id,company_id,client_id,property_id,title,created_by) VALUES('job-a',$1,'client-a','property-a','Job A','canonical-actor-a')",
      [companyId],
    );
    await storage.query(
      `INSERT INTO work_orders(id,company_id,job_id,client_id,title,created_by,assigned_user_id)
       VALUES('work-a',$1,'job-a','client-a','Work A','canonical-actor-a','canonical-worker-a')`,
      [companyId],
    );
    await storage.query(
      `INSERT INTO visits(id,company_id,job_id,work_order_id,assigned_user_id,scheduled_start,scheduled_end)
       VALUES('visit-a',$1,'job-a','work-a','canonical-worker-a','2026-01-01T09:00:00Z','2026-01-01T10:00:00Z')`,
      [companyId],
    );
    await storage.query(
      `INSERT INTO work_order_tasks(id,company_id,work_order_id,label,required,sort_order)
       VALUES('task-a',$1,'work-a','Clean kitchen',1,1)`, [companyId],
    );
    await storage.query(
      `INSERT INTO visit_tasks(company_id,visit_id,work_order_id,task_id,item_key,section)
       VALUES($1,'visit-a','work-a','task-a','kitchen','Interior')`, [companyId],
    );
    const visit = await storage.query<{ account_id: string; company_id: string; work_order_id: string }>(
      "SELECT account_id,company_id,work_order_id FROM visits WHERE id='visit-a'",
    );
    expect(visit.rows[0]).toEqual({ account_id: companyId, company_id: companyId, work_order_id: "work-a" });

    const property = await storage.query<{ property_id: string }>("SELECT property_id FROM jobs WHERE id='job-a'");
    expect(property.rows).toEqual([{ property_id: "property-a" }]);
    const linked = await storage.query<{ visit_id: string; task_id: string; item_key: string }>(
      "SELECT visit_id,task_id,item_key FROM visit_tasks",
    );
    expect(linked.rows).toEqual([{ visit_id: "visit-a", task_id: "task-a", item_key: "kitchen" }]);
    const ledger = await storage.query<{ migration_id: string; sha256: string }>(
      "SELECT migration_id,sha256 FROM titan_company_native_schema_migrations",
    );
    expect(ledger.rows).toEqual(companyNativeWorkOrdersVisitsManifest.migrations.map(migration => ({
      migration_id: migration.migration_id, sha256: migration.sha256,
    })));
    expect((await storage.query("SELECT name FROM sqlite_master WHERE name LIKE '%ready%'")).rows).toEqual([]);
  });

  it("rejects repeated initialization without mutating the attested store", async () => {
    const storage = memoryStore();
    await initializeFreshCompanyNativeStore({ storage, placement, company_profile: companyProfile });
    const before = (await storage.query<{ name: string; sql: string | null }>(
      "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )).rows;

    await expect(initializeFreshCompanyNativeStore({ storage, placement, company_profile: companyProfile }))
      .rejects.toMatchObject({ code: "company-native-schema-store-not-fresh" });
    const after = (await storage.query<{ name: string; sql: string | null }>(
      "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )).rows;
    expect(after).toEqual(before);
  });

  it("initializes an explicitly selected fresh v1 profile for existing native consumers", async () => {
    const storage = memoryStore();
    const legacyPlacement = { ...placement, schema_version: companyNativeWorkOrdersManifest.schema_version };
    await expect(initializeFreshCompanyNativeStore({
      storage, placement: legacyPlacement, company_profile: companyProfile,
    })).resolves.toMatchObject({ schema_version: companyNativeWorkOrdersManifest.schema_version });
    expect((await storage.query("SELECT name FROM sqlite_master WHERE name='visit_tasks'")).rows).toEqual([]);
    expect((await storage.query<{ migration_id: string }>(
      "SELECT migration_id FROM titan_company_native_schema_migrations",
    )).rows).toEqual([{ migration_id: "company-native-fsm/0001-work-orders" }]);
  });

  it("rejects an existing mixed store without changing its historical schema or ledger", async () => {
    const storage = memoryStore();
    await storage.query("CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    await storage.query("INSERT INTO schema_migrations(filename,applied_at) VALUES('001_canonical.sql','legacy')");
    await storage.query("CREATE TABLE users(id TEXT PRIMARY KEY,password_hash TEXT NOT NULL)");

    await expect(initializeFreshCompanyNativeStore({ storage, placement, company_profile: companyProfile }))
      .rejects.toMatchObject({ code: "company-native-schema-store-not-fresh" });
    expect((await storage.query("SELECT filename,applied_at FROM schema_migrations")).rows)
      .toEqual([{ filename: "001_canonical.sql", applied_at: "legacy" }]);
    expect((await storage.query("SELECT name FROM sqlite_master WHERE name='work_orders'")).rows).toEqual([]);
  });

  it("denies implicit in-place upgrade of a verified v1 store without changing it", async () => {
    const storage = memoryStore();
    await seedAttestedV1Store(storage);
    const legacyPlacement = { ...placement, schema_version: companyNativeWorkOrdersManifest.schema_version };
    const before = (await storage.query<{ name: string; sql: string | null }>(
      "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )).rows;
    await expect(initializeFreshCompanyNativeStore({ storage, placement, company_profile: companyProfile }))
      .rejects.toMatchObject({ code: "company-native-schema-store-not-fresh" });
    await expect(verifyCompanyNativeSchemaAttestation({
      storage, placement: legacyPlacement, manifest: companyNativeWorkOrdersManifest,
    })).resolves.toMatchObject({ schema_version: companyNativeWorkOrdersManifest.schema_version });
    const after = (await storage.query<{ name: string; sql: string | null }>(
      "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )).rows;
    expect(after).toEqual(before);
  });

  it("rejects a visit task that crosses company or work-order boundaries", async () => {
    const storage = memoryStore();
    await initializeFreshCompanyNativeStore({ storage, placement, company_profile: companyProfile });
    await storage.query("INSERT INTO clients(id,company_id,name) VALUES('client-a',$1,'A')", [companyId]);
    await storage.query("INSERT INTO jobs(id,company_id,client_id,title,created_by) VALUES('job-a',$1,'client-a','Job','actor')", [companyId]);
    await storage.query("INSERT INTO work_orders(id,company_id,job_id,client_id,title,created_by) VALUES('work-a',$1,'job-a','client-a','Work','actor')", [companyId]);
    await storage.query("INSERT INTO work_order_tasks(id,company_id,work_order_id,label) VALUES('task-a',$1,'work-a','Task')", [companyId]);
    await storage.query(`INSERT INTO visits(id,company_id,job_id,work_order_id,scheduled_start,scheduled_end)
      VALUES('visit-a',$1,'job-a','work-a','2026-01-01','2026-01-02')`, [companyId]);
    await expect(storage.query(`INSERT INTO visit_tasks(company_id,visit_id,work_order_id,task_id,item_key,section)
      VALUES($1,'visit-a','different-work','task-a','item','Interior')`, [companyId])).rejects.toThrow();
    await expect(storage.query(`INSERT INTO visit_tasks(company_id,visit_id,work_order_id,task_id,item_key,section)
      VALUES('another-company','visit-a','work-a','task-a','item','Interior')`)).rejects.toThrow();
  });

  it("fails verifier checks for wrong company, stale revision, schema drift, and restored placement mismatch", async () => {
    const storage = memoryStore();
    await initializeFreshCompanyNativeStore({ storage, placement, company_profile: companyProfile });
    await expect(verifyCompanyNativeSchemaAttestation({
      storage, placement: { ...placement, company_id: "fresh-native-b" }, manifest: companyNativeWorkOrdersVisitsManifest,
    })).rejects.toMatchObject({ code: "company-native-schema-company-mismatch" });
    await expect(verifyCompanyNativeSchemaAttestation({
      storage, placement: { ...placement, placement_revision: 5 }, manifest: companyNativeWorkOrdersVisitsManifest,
    })).rejects.toMatchObject({ code: "company-native-schema-placement-mismatch" });

    const dir = await newTempDir();
    // Materialize a real file-backed fresh company store, close it (checkpointing
    // WAL), then copy it as a restore into another physical placement.
    const sourcePath = join(dir, `${placement.placement_id}.sqlite`);
    const sourceStorage = createSqliteStorage(sourcePath);
    stores.push(sourceStorage);
    await initializeFreshCompanyNativeStore({ storage: sourceStorage, placement, company_profile: companyProfile });
    await sourceStorage.close();
    stores.splice(stores.indexOf(sourceStorage), 1);
    const restoredPlacement = { ...placement, company_id: "fresh-native-b", placement_id: "fresh-native-placement-b", placement_revision: 1 };
    const restoredPath = join(dir, `${restoredPlacement.placement_id}.sqlite`);
    await copyFile(sourcePath, restoredPath);
    const opener = createSqliteCompanyStoreOpener({ companyStoreRoot: dir });
    const openedA = await opener.open(placement);
    try {
      expect((await openedA.client.query<{ file: string }>("PRAGMA database_list")).rows[0]?.file).toBe(sourcePath);
      await openedA.assertPlacementBound();
      await verifyCompanyNativeSchemaAttestation({
        storage: openedA.client, placement, manifest: companyNativeWorkOrdersVisitsManifest,
      });
    } finally { await openedA.client.close(); }
    const openedRestore = await opener.open(restoredPlacement);
    try {
      await expect(verifyCompanyNativeSchemaAttestation({
        storage: openedRestore.client, placement: restoredPlacement, manifest: companyNativeWorkOrdersVisitsManifest,
      })).rejects.toMatchObject({ code: "company-native-schema-company-mismatch" });
    } finally { await openedRestore.client.close(); }

    await storage.query("CREATE TABLE unexpected_native_object(id TEXT PRIMARY KEY)");
    await expect(verifyCompanyNativeSchemaAttestation({
      storage, placement, manifest: companyNativeWorkOrdersVisitsManifest,
    })).rejects.toMatchObject({ code: "company-native-schema-fingerprint-mismatch" });
  });
});

describe("fresh native-visit-checklist-v3 schema producer", () => {
  it("pins the additive visit-local checklist migration and keeps task lifecycle fields separate", async () => {
    for (const migration of companyNativeVisitChecklistManifest.migrations) {
      const bytes = await readFile(new URL(`../../../${migration.path}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(migration.sha256);
    }
    const storage = memoryStore();
    const v3Placement = { ...placement, schema_version: companyNativeVisitChecklistManifest.schema_version };
    await initializeFreshCompanyNativeStore({ storage, placement: v3Placement, company_profile: companyProfile });
    const columns = (await storage.query<{ name: string }>("PRAGMA table_info(visit_tasks)")).rows.map(row => row.name);
    expect(columns).toContain("disposition");
    expect(columns).toContain("note");
    expect(columns).toContain("updated_at");
    const workOrderColumns = (await storage.query<{ name: string }>("PRAGMA table_info(work_order_tasks)")).rows.map(row => row.name);
    expect(workOrderColumns).toContain("status");
    expect(workOrderColumns).toContain("completed");
    expect((await storage.query("SELECT name FROM sqlite_master WHERE type='table' AND name='evidence'")).rows).toEqual([]);
    await expect(verifyCompanyNativeSchemaAttestation({
      storage,
      placement: v3Placement,
      manifest: companyNativeVisitChecklistManifest,
    })).resolves.toMatchObject({ schema_version: companyNativeVisitChecklistManifest.schema_version });
  });

  it("does not mutate an existing v2 company store to add checklist state", async () => {
    const storage = memoryStore();
    await initializeFreshCompanyNativeStore({ storage, placement, company_profile: companyProfile });
    const before = (await storage.query<{ name: string; sql: string | null }>(
      "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )).rows;
    const v3Placement = { ...placement, schema_version: companyNativeVisitChecklistManifest.schema_version };
    await expect(initializeFreshCompanyNativeStore({ storage, placement: v3Placement, company_profile: companyProfile }))
      .rejects.toMatchObject({ code: "company-native-schema-store-not-fresh" });
    await expect(verifyCompanyNativeSchemaAttestation({
      storage, placement, manifest: companyNativeWorkOrdersVisitsManifest,
    })).resolves.toMatchObject({ schema_version: companyNativeWorkOrdersVisitsManifest.schema_version });
    const after = (await storage.query<{ name: string; sql: string | null }>(
      "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )).rows;
    expect(after).toEqual(before);
  });
});
