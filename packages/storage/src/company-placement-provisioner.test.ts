import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./sqlite-client.js";
import { initializeSqliteCompanyPlacementRegistry, createSqliteCompanyPlacementRegistry } from "./company-placement-registry.js";
import { provisionSqliteCompanyPlacement } from "./company-placement-provisioner.js";

const paths: string[] = [];
const closers: Array<() => Promise<void>> = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "titan-placement-provisioner-")); paths.push(root);
  const dbRoot = join(root, "db"); const fileRoot = join(root, "files");
  await mkdir(dbRoot, { mode: 0o700 }); await mkdir(fileRoot, { mode: 0o700 });
  const storage = createSqliteStorage(join(root, "registry.sqlite")); closers.push(() => storage.close());
  const registry = { storage, storage_role: "GLOBAL_REGISTRY" as const, companyStoreRoot: dbRoot, companyFileStoreRoot: fileRoot };
  await initializeSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
  return { root, registry, storage };
}
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close().catch(() => undefined)));
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("registered company placement lifecycle", () => {
  it("creates physical DB and file placements, verifies migrations and persists READY for restart lookup", async () => {
    const f = await fixture();
    const created = await provisionSqliteCompanyPlacement({ registry: f.registry, company_id: "company-a", company_name: "Company A" });
    expect(created.company_id).toBe("company-a");
    const database = await createSqliteCompanyPlacementRegistry({ storage: f.storage, storage_role: "GLOBAL_REGISTRY" });
    expect(await database.findByCompanyId("company-a")).toMatchObject({ status: "READY", placement_id: created.placement_id });
    const files = await f.storage.query<{ status: string; file_placement_id: string }>(
      "SELECT status,file_placement_id FROM titan_company_file_placements WHERE company_id=$1", ["company-a"]);
    expect(files.rows).toEqual([{ status: "READY", file_placement_id: created.file_placement_id }]);
    const business = await createSqliteStorage(join(f.registry.companyStoreRoot, `${created.placement_id}.sqlite`));
    expect((await business.query<{ id: string; name: string }>("SELECT id,name FROM companies" )).rows)
      .toEqual([{ id: "company-a", name: "Company A" }]);
    await business.close();
  });

  it("provisions an explicitly selected registered checklist profile with matching attestation", async () => {
    const f = await fixture();
    const created = await provisionSqliteCompanyPlacement({
      registry: f.registry, company_id: "company-checklist", company_name: "Checklist Company",
      schema_version: "company-native-visit-checklist-v3",
    });
    const database = await createSqliteCompanyPlacementRegistry({ storage: f.storage, storage_role: "GLOBAL_REGISTRY" });
    const placement = await database.findByCompanyId("company-checklist");
    expect(placement).toMatchObject({ status: "READY", placement_id: created.placement_id,
      schema_version: "company-native-visit-checklist-v3" });
    const company = await createSqliteStorage(join(f.registry.companyStoreRoot, `${created.placement_id}.sqlite`));
    expect((await company.query<{ schema_version: string; placement_revision: number }>(
      "SELECT schema_version,placement_revision FROM titan_company_native_schema_attestation WHERE company_id=$1",
      ["company-checklist"],
    )).rows).toEqual([{ schema_version: "company-native-visit-checklist-v3", placement_revision: 1 }]);
    await company.close();
  });

  it("rejects an unknown schema profile before reserving placement rows", async () => {
    const f = await fixture();
    await expect(provisionSqliteCompanyPlacement({ registry: f.registry, company_id: "company-unknown",
      company_name: "Unknown", schema_version: "company-native-made-up-v9" }))
      .rejects.toThrow("company-placement-schema-profile-unknown");
    expect((await f.storage.query("SELECT company_id FROM titan_company_storage_placements")).rowCount).toBe(0);
  });

  it("leaves failed provisioning non-ready and retries with a fresh physical identity", async () => {
    const f = await fixture();
    await expect(provisionSqliteCompanyPlacement({ registry: f.registry, company_id: "company-b", company_name: " " }))
      .rejects.toThrow();
    const row = await f.storage.query<{ status: string }>(
      "SELECT status FROM titan_company_storage_placements WHERE company_id=$1", ["company-b"]);
    expect(row.rows).toEqual([{ status: "FAILED" }]);
    const retry = await provisionSqliteCompanyPlacement({ registry: f.registry, company_id: "company-b", company_name: "Company B" });
    expect(retry.placement_id).not.toBeUndefined();
    expect((await f.storage.query<{ status: string; placement_revision: number }>(
      "SELECT status,placement_revision FROM titan_company_storage_placements WHERE company_id=$1", ["company-b"]
    )).rows).toEqual([{ status: "READY", placement_revision: 2 }]);
    const retriedDb = await createSqliteStorage(join(f.registry.companyStoreRoot, `${retry.placement_id}.sqlite`));
    expect((await retriedDb.query("SELECT id FROM companies")).rowCount).toBe(1);
    await retriedDb.close();
  });
  it("rejects replay of a completed provisioning request without duplicating company state", async () => {
    const f = await fixture();
    const created = await provisionSqliteCompanyPlacement({
      registry: f.registry, company_id: "company-replay", company_name: "Replay Company",
    });
    await expect(provisionSqliteCompanyPlacement({
      registry: f.registry, company_id: "company-replay", company_name: "Replay Company",
    })).rejects.toThrow("company-placement-already-registered");

    const databaseRows = await f.storage.query<{ placement_id: string; status: string }>(
      "SELECT placement_id,status FROM titan_company_storage_placements WHERE company_id=$1", ["company-replay"],
    );
    expect(databaseRows.rows).toEqual([{ placement_id: created.placement_id, status: "READY" }]);
    const fileRows = await f.storage.query<{ file_placement_id: string; status: string }>(
      "SELECT file_placement_id,status FROM titan_company_file_placements WHERE company_id=$1", ["company-replay"],
    );
    expect(fileRows.rows).toEqual([{ file_placement_id: created.file_placement_id, status: "READY" }]);
    expect((await readdir(f.registry.companyStoreRoot)).filter(name => name.endsWith(".sqlite"))).toHaveLength(1);
    expect(await readdir(f.registry.companyFileStoreRoot)).toEqual([created.file_placement_id]);
    const company = await createSqliteStorage(join(f.registry.companyStoreRoot, `${created.placement_id}.sqlite`));
    expect((await company.query("SELECT id FROM companies")).rowCount).toBe(1);
    await company.close();
  });

});
