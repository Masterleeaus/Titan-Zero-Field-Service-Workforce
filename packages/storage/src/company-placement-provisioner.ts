import { mkdir, open, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createSqliteCompanyPlacementRegistryWriter, type GlobalRegistryStorageInput } from "./company-placement-registry.js";
import { initializeFreshCompanyNativeStore } from "./company-native-store-initializer.js";
import { companyNativeWorkOrdersVisitsManifest, getCompanyNativeSchemaManifest } from "./company-native-schema-manifest.js";
import { createSqliteCompanyStoreOpener } from "./company-store-opener.js";
import { openExistingSqliteStorage } from "./sqlite-client.js";
import type { StorageClient } from "./index.js";

export interface SqliteCompanyPlacementProvisionerOptions extends GlobalRegistryStorageInput {
  readonly companyStoreRoot: string;
  readonly companyFileStoreRoot: string;
}

function safeRoot(path: string): string {
  if (!path || !isAbsolute(path)) throw new Error("company-placement-root-invalid");
  return resolve(path);
}

async function verifyDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o022) !== 0 || await realpath(path) !== path) {
    throw new Error("company-placement-root-invalid");
  }
}

/** Creates a fresh disposable native-work-orders placement and promotes it only
 * after the database migration witness, SQLite health checks, and file namespace
 * identity have all been checked against the exact reserved registry rows. */
export async function provisionSqliteCompanyPlacement(input: {
  registry: SqliteCompanyPlacementProvisionerOptions;
  company_id: string;
  company_name: string;
  /** Select a registered fresh-store profile. Omitted for the historical v2 default. */
  schema_version?: string;
}): Promise<{ company_id: string; placement_id: string; placement_revision: number; file_placement_id: string }> {
  const dbRoot = safeRoot(input.registry.companyStoreRoot);
  const fileRoot = safeRoot(input.registry.companyFileStoreRoot);
  await verifyDirectory(dbRoot);
  await verifyDirectory(fileRoot);
  const schemaVersion = input.schema_version ?? companyNativeWorkOrdersVisitsManifest.schema_version;
  if (!getCompanyNativeSchemaManifest(schemaVersion)) throw new Error("company-placement-schema-profile-unknown");
  const writer = await createSqliteCompanyPlacementRegistryWriter(input.registry);
  const reserved = await writer.beginProvisioning({
    company_id: input.company_id,
    schema_version: schemaVersion,
  });
  const dbPath = join(dbRoot, `${reserved.database.placement_id}.sqlite`);
  const filePath = join(fileRoot, reserved.files.file_placement_id);
  let storage: StorageClient | undefined;
  try {
    const dbFile = await open(dbPath, "wx", 0o600);
    await dbFile.close();
    await mkdir(filePath, { mode: 0o700 });
    storage = openExistingSqliteStorage(dbPath);
    const witness = await initializeFreshCompanyNativeStore({
      storage,
      placement: reserved.database,
      company_profile: { name: input.company_name },
    });
    const integrity = (await storage.query<{ integrity_check: string }>("PRAGMA integrity_check")).rows;
    const foreignKeys = (await storage.query("PRAGMA foreign_key_check")).rows;
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" || foreignKeys.length !== 0) {
      throw new Error("company-placement-health-check-failed");
    }
    const physical = await createSqliteCompanyStoreOpener({ companyStoreRoot: dbRoot }).open(reserved.database);
    try { await physical.assertPlacementBound(); }
    finally { await physical.client.close(); }
    const namespace = await lstat(filePath);
    if (namespace.isSymbolicLink() || !namespace.isDirectory() || (namespace.mode & 0o022) !== 0
      || await realpath(filePath) !== filePath) throw new Error("company-placement-file-namespace-invalid");
    if (witness.company_id !== reserved.database.company_id
      || witness.placement_id !== reserved.database.placement_id
      || witness.placement_revision !== reserved.database.placement_revision
      || witness.schema_version !== reserved.database.schema_version) {
      throw new Error("company-placement-attestation-mismatch");
    }
    await storage.close();
    storage = undefined;
    await input.registry.storage.transaction(async tx => {
      const db = await tx.query(
        `UPDATE titan_company_storage_placements SET status='READY'
          WHERE company_id=$1 AND placement_id=$2 AND placement_revision=$3 AND status='PROVISIONING'`,
        [reserved.database.company_id, reserved.database.placement_id, reserved.database.placement_revision],
      );
      const files = await tx.query(
        `UPDATE titan_company_file_placements SET status='READY'
          WHERE company_id=$1 AND file_placement_id=$2 AND file_placement_revision=$3 AND status='PROVISIONING'`,
        [reserved.files.company_id, reserved.files.file_placement_id, reserved.files.file_placement_revision],
      );
      if (db.rowCount !== 1 || files.rowCount !== 1) throw new Error("company-placement-stale");
    });
    return Object.freeze({ company_id: reserved.database.company_id, placement_id: reserved.database.placement_id,
      placement_revision: reserved.database.placement_revision, file_placement_id: reserved.files.file_placement_id });
  } catch (error) {
    await storage?.close().catch(() => undefined);
    await writer.setUnavailable({ company_id: reserved.database.company_id,
      placement_id: reserved.database.placement_id, placement_revision: reserved.database.placement_revision,
      expected_status: "PROVISIONING", status: "FAILED" }).catch(() => undefined);
    throw error;
  }
}
