import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  CompanyNativeSchemaAttestationError,
  computeCompanyNativeSchemaManifestDigest,
  fingerprintCompanyNativeSchema,
  verifyCompanyNativeSchemaAttestation,
  type CompanyNativeSchemaAttestationErrorCode,
  type CompanyNativeSchemaManifest,
  type VerifiedCompanyNativeSchemaAttestation,
} from "./company-native-schema-attestation.js";
import { getCompanyNativeSchemaManifest } from "./company-native-schema-manifest.js";
import type { CompanyDatabasePlacementDescriptor } from "./company-storage-resolver.js";
import type { StorageClient } from "./index.js";

const markerTable = "titan_company_native_schema_attestation";
const migrationTable = "titan_company_native_schema_migrations";

function fail(code: CompanyNativeSchemaAttestationErrorCode): never {
  throw new CompanyNativeSchemaAttestationError(code);
}

function splitMigration(sql: string): string[] {
  // This fresh profile source is intentionally one-statement-per-semicolon and
  // contains no trigger bodies or semicolons embedded in literals.
  return sql.replace(/^\s*--[^\n]*;[^\n]*$/gm, "").split(";")
    .map(statement => statement.trim())
    .filter(statement => statement.replace(/^\s*--.*$/gm, "").trim().length > 0);
}

function sourceSha256(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

async function assertFresh(storage: StorageClient): Promise<void> {
  const objects = (await storage.query<{ name: string; type: string }>(
    `SELECT name,type FROM sqlite_master
      WHERE name NOT GLOB 'sqlite_*' AND type IN ('table','view','index','trigger')`,
  )).rows;
  if (objects.length !== 0) fail("company-native-schema-store-not-fresh");
}

async function loadProfileMigration(path: string): Promise<string> {
  const sources: Readonly<Record<string, URL>> = {
    "db/sqlite/company-native/0001_work_orders.sql": new URL("../../../db/sqlite/company-native/0001_work_orders.sql", import.meta.url),
    "db/sqlite/company-native/0002_visit_tasks.sql": new URL("../../../db/sqlite/company-native/0002_visit_tasks.sql", import.meta.url),
    "db/sqlite/company-native/0003_visit_checklist_state.sql": new URL("../../../db/sqlite/company-native/0003_visit_checklist_state.sql", import.meta.url),
  };
  const source = sources[path];
  if (!source) {
    fail("company-native-schema-manifest-invalid");
  }
  return readFile(source, "utf8");
}

/**
 * Initialize only a genuinely empty SQLite file for a known bounded native
 * profile explicitly selected by the placement schema version. This function
 * is a COMPANY_NATIVE_FSM owner operation: it creates DB-local schema, ledger
 * and marker atomically, returns a fresh witness, and never writes GLOBAL_REGISTRY
 * or promotes READY. New provisioners select v2; explicit v1 placements remain
 * supported for existing native consumers and compatibility tests.
 *
 * Existing files, including the historical mixed compatibility schema, fail
 * closed. The new migration id is independent of db/sqlite/001 and 005.
 */
export async function initializeFreshCompanyNativeStore(input: {
  storage: StorageClient;
  placement: CompanyDatabasePlacementDescriptor;
  company_profile: Readonly<{ name: string }>;
}): Promise<VerifiedCompanyNativeSchemaAttestation> {
  const { storage, placement, company_profile: companyProfile } = input;
  const manifest: CompanyNativeSchemaManifest | null = getCompanyNativeSchemaManifest(placement.schema_version);
  if (!manifest) fail("company-native-schema-placement-mismatch");
  if (storage.dialect !== "sqlite" || placement.provider !== "sqlite") {
    fail("company-native-schema-provider-unsupported");
  }
  const foreignKeys = (await storage.query<{ foreign_keys: number }>("PRAGMA foreign_keys")).rows[0];
  if (!foreignKeys || foreignKeys.foreign_keys !== 1) {
    fail("company-native-schema-provider-unsupported");
  }
  if (!placement.company_id || !placement.placement_id || !Number.isSafeInteger(placement.placement_revision)
    || placement.placement_revision < 1) {
    fail("company-native-schema-placement-mismatch");
  }
  if (typeof companyProfile?.name !== "string" || companyProfile.name.trim().length === 0) {
    fail("company-native-schema-company-mismatch");
  }
  const migrations = await Promise.all(manifest.migrations.map(async migration => {
    const sql = await loadProfileMigration(migration.path);
    if (sourceSha256(sql) !== migration.sha256) fail("company-native-schema-migration-source-mismatch");
    return { migration, sql };
  }));
  if (migrations.length !== manifest.migrations.length || migrations.some(({ migration }, index) =>
    migration !== manifest.migrations[index])) {
    fail("company-native-schema-manifest-invalid");
  }
  await assertFresh(storage);

  return storage.transaction(async tx => {
    await assertFresh(tx);
    await tx.query(`CREATE TABLE ${migrationTable} (
      sequence INTEGER PRIMARY KEY,
      migration_id TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL
    )`);
    await tx.query(`CREATE TABLE ${markerTable} (
      singleton_id TEXT PRIMARY KEY CHECK(singleton_id='COMPANY_NATIVE_FSM'),
      company_id TEXT NOT NULL,
      placement_id TEXT NOT NULL,
      placement_revision INTEGER NOT NULL CHECK(placement_revision > 0),
      schema_version TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      schema_fingerprint_sha256 TEXT NOT NULL
    )`);
    for (const { sql } of migrations) {
      for (const statement of splitMigration(sql)) await tx.query(statement);
    }
    await tx.query("INSERT INTO companies(id,name) VALUES($1,$2)",
      [placement.company_id, companyProfile.name.trim()]);

    const schemaFingerprint = await fingerprintCompanyNativeSchema(tx);
    if (schemaFingerprint !== manifest.schema_fingerprint_sha256) {
      fail("company-native-schema-fingerprint-mismatch");
    }
    const manifestDigest = computeCompanyNativeSchemaManifestDigest(manifest);
    for (const { migration } of migrations) {
      await tx.query(
        `INSERT INTO ${migrationTable}(sequence,migration_id,sha256) VALUES($1,$2,$3)`,
        [migration.sequence, migration.migration_id, migration.sha256],
      );
    }
    await tx.query(
      `INSERT INTO ${markerTable}
       (singleton_id,company_id,placement_id,placement_revision,schema_version,manifest_sha256,schema_fingerprint_sha256)
       VALUES('COMPANY_NATIVE_FSM',$1,$2,$3,$4,$5,$6)`,
      [placement.company_id, placement.placement_id, placement.placement_revision,
        manifest.schema_version, manifestDigest, schemaFingerprint],
    );
    return verifyCompanyNativeSchemaAttestation({ storage: tx, placement, manifest });
  });
}
