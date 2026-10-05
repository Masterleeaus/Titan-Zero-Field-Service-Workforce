import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filenamesFromDir, validateMigrationManifest } from "./check-migration-prefixes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDir = path.join(repoRoot, "db", "migrations");
const manifest = JSON.parse(fs.readFileSync(path.join(migrationDir, "MANIFEST.json"), "utf8"));
const filenames = filenamesFromDir(migrationDir);
const readMigration = (filename) => fs.readFileSync(path.join(migrationDir, filename));

test("the checked-in manifest freezes the full ordered file set and exact bytes", () => {
  const result = validateMigrationManifest(manifest, filenames, readMigration);
  assert.equal(result.ok, true, result.errors.join("; "));
  const registeredMigrations = filenames.filter((filename) => filename.endsWith(".sql") && !filename.includes("seed"));
  assert.equal(manifest.entries.length, registeredMigrations.length);
  const workforceRls = manifest.entries.find(
    (entry) => entry.filename === "190_workforce_six_table_rls_parent_integrity.sql",
  );
  assert.ok(workforceRls, "the registered Workforce RLS migration must remain in the immutable manifest");
  assert.equal(workforceRls.sequence, 205);
  assert.equal(result.unverifiedHistoryPrefixes.length, 16);
  assert.ok(manifest.entries.every((entry, index) => entry.sequence === index + 1));
});

test("existing duplicate prefixes resolve only through explicit filename identity and order", () => {
  for (const collision of manifest.prefix_collisions) {
    assert.equal(collision.resolution, "immutable-filename-identity-and-explicit-sequence");
    assert.equal(collision.applied_history, "unverified-no-installation-ledger-snapshot-available");
  }
  assert.match(manifest.history_note, /deployed schema_migrations snapshots/);
});

test("an unregistered file, including a new prefix collision, fails closed", () => {
  const result = validateMigrationManifest(
    manifest,
    [...filenames, "151_new_migration.sql"],
    readMigration,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /exactly match/.test(error)));
});

test("edited migration bytes fail checksum validation", () => {
  const entry = manifest.entries[0];
  const result = validateMigrationManifest(
    manifest,
    filenames,
    (filename) => filename === entry.filename ? Buffer.from("changed") : readMigration(filename),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes(`content changed without a manifest update: ${entry.filename}`)));
});

test("reordering a collision group or changing its classification fails", () => {
  const reordered = structuredClone(manifest);
  const pair = reordered.prefix_collisions[0];
  pair.files.reverse();
  const result = validateMigrationManifest(reordered, filenames, readMigration);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /classifications do not exactly match/.test(error)));

  const falseHistory = structuredClone(manifest);
  falseHistory.prefix_collisions[0].applied_history = "historically-applied-pair";
  const falseResult = validateMigrationManifest(falseHistory, filenames, readMigration);
  assert.equal(falseResult.ok, false);
  assert.ok(falseResult.errors.some((error) => /unsupported applied-history claim/.test(error)));
});

test("migration checksums are SHA-256 over the exact SQL bytes", () => {
  const entry = manifest.entries[0];
  const actual = createHash("sha256").update(readMigration(entry.filename)).digest("hex");
  assert.equal(entry.sha256, actual);
});
