import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createIdentitySessionRegistry,
} from "@titan-zero/titan-platform/security-boundary";
import {
  type CompanyPlacementRecord,
  type StorageClient,
} from "../../../../packages/storage/src/index";
import { initializeFreshCompanyNativeStore } from "../../../../packages/storage/src/company-native-store-initializer";
import {
  companyNativeVisitChecklistManifest,
  companyNativeWorkOrdersVisitsManifest,
} from "../../../../packages/storage/src/company-native-schema-manifest";
import { createWebSessionRuntime, type WebLoginIdentityBinding } from "../auth/web-session-runtime";
import { initializeCleaningProfileForLogin } from "./cleaning-profile-login";

const origin = "https://field.example.test";
const issuer = `titan:web-login:${origin}`;
const legacyUser = "legacy-cleaning-user";
const actor = "cleaning-actor";
const companyA = "cleaning-company-a";
const companyB = "cleaning-company-b";
const device = "cleaning-device";

let directory: string | undefined;
let seedStorage: StorageClient | undefined;
let runtime: ReturnType<typeof createWebSessionRuntime> | undefined;

const secret = () => new Uint8Array(randomBytes(32));

function nodeSqliteStorage(path: string): StorageClient {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  const direct = async <T>(sql: string, params: readonly unknown[] = []) => {
    const ordered: unknown[] = [];
    const text = sql.replace(/\$(\d+)/g, (_match, rawIndex: string) => {
      const index = Number(rawIndex) - 1;
      if (index < 0 || index >= params.length) throw new Error(`sqlite parameter $${rawIndex} is not bound`);
      ordered.push(params[index]);
      return "?";
    });
    const statement = db.prepare(text);
    if (statement.columns().length > 0) {
      const rows = statement.all(...ordered) as T[];
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...ordered);
    return { rows: [], rowCount: Number(result.changes) };
  };
  const client: StorageClient = {
    dialect: "sqlite",
    query: (sql, params = []) => direct(sql, params),
    async transaction<T>(fn: (tx: StorageClient) => Promise<T>) {
      db.exec("BEGIN IMMEDIATE");
      const tx: StorageClient = {
        dialect: "sqlite",
        query: (sql, params = []) => direct(sql, params),
        transaction: async () => { throw new Error("nested transaction unsupported"); },
        close: async () => { throw new Error("transaction does not own database"); },
      };
      try { const result = await fn(tx); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async close() { db.close(); },
  };
  return client;
}

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await seedStorage?.close();
  seedStorage = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("authenticated cleaning first-run profile", () => {
  it("writes before login completion, retains on reload, and isolates a switched company", async () => {
    directory = await mkdtemp(join(tmpdir(), "titan-cleaning-login-"));
    const registryPath = join(directory, "global-registry.sqlite");
    seedStorage = nodeSqliteStorage(registryPath);
    const identity = await createIdentitySessionRegistry({ storage: seedStorage, storage_role: "GLOBAL_REGISTRY" });
    await identity.putActor({ actor_id: actor, status: "active" }, null);
    for (const [company, account, role] of [[companyA, "legacy-account-a", "owner"], [companyB, "legacy-account-b", "tech"]] as const) {
      await identity.putCompany({ company_id: company, status: "active" }, null);
      await identity.putMembership({ actor_id: actor, company_id: company, role, status: "active" }, null);
      await identity.putExternalBinding({
        binding_id: `login-${company}`, provider: issuer, subject: legacyUser,
        actor_id: actor, company_id: company, status: "active",
      }, null);
    }
    await identity.putDevice({ device_id: device, actor_id: actor, status: "active" }, null);

    const bindings: WebLoginIdentityBinding[] = [
      { legacy_user_id: legacyUser, legacy_account_id: "legacy-account-a", company_id: companyA, actor_id: actor, device_id: device },
      { legacy_user_id: legacyUser, legacy_account_id: "legacy-account-b", company_id: companyB, actor_id: actor, device_id: device },
    ];
    runtime = createWebSessionRuntime({
      registry: identity,
      public_origin: origin,
      login_key_id: "login-test-key",
      login_signing_secret: secret(),
      session_key_id: "session-test-key",
      session_signing_secret: secret(),
      bindings,
    });

    const paths = new Map<string, string>();
    const placements = new Map<string, CompanyPlacementRecord>();
    for (const company_id of [companyA, companyB]) {
      const placement_id = `placement-${company_id}`;
      const schema_version = company_id === companyA
        ? companyNativeWorkOrdersVisitsManifest.schema_version
        : companyNativeVisitChecklistManifest.schema_version;
      const placement: CompanyPlacementRecord = {
        company_id, placement_id, placement_revision: 1, provider: "sqlite", schema_version, status: "READY",
      };
      const path = join(directory, `${placement_id}.sqlite`);
      const storage = nodeSqliteStorage(path);
      await initializeFreshCompanyNativeStore({ storage, placement, company_profile: { name: company_id } });
      if (company_id === companyA) {
        await storage.query("UPDATE companies SET settings=$1 WHERE id=$2", [JSON.stringify({
          retained_setting: "keep",
          vertical_profile: {
            schema: "titan.company.vertical-profile.v1",
            company_id,
            revision: 4,
            profile: { pack_id: "existing-company-pack", pack_version: "2.0.0", module_id: "existing.vertical", module_version: "2.0.0" },
          },
        }), company_id]);
      }
      await storage.close();
      placements.set(company_id, placement);
      paths.set(placement_id, path);
    }
    const test_ports = {
      registry: { findByCompanyId: async (company_id: string) => placements.get(company_id) ?? null },
      opener: { async open(placement: { company_id: string; placement_id: string; placement_revision: number; provider: "sqlite"; schema_version: string }) {
        const path = paths.get(placement.placement_id);
        if (!path) throw new Error("test-placement-not-found");
        const client = nodeSqliteStorage(path);
        return { ...placement, client, assertPlacementBound: async () => {
          const main = (await client.query<{ file: string }>("PRAGMA database_list")).rows.find(row => row.file);
          if (main?.file !== path) throw new Error("test-placement-binding-mismatch");
        } };
      } },
    };
    const initialize = (issued: Awaited<ReturnType<typeof runtime.issueForAuthenticatedWebUser>>) => {
      return initializeCleaningProfileForLogin({
        issued,
        resolveCurrentSession: credential => runtime!.resolveCredential(credential),
        test_ports,
      });
    };

    const firstLogin = await runtime.issueForAuthenticatedWebUser(legacyUser, "legacy-account-a");
    const first = await initialize(firstLogin);
    const savedProfile = { pack_id: "existing-company-pack", pack_version: "2.0.0", module_id: "existing.vertical", module_version: "2.0.0" };
    expect(first).toMatchObject({ status: "retained", revision: 4, profile: savedProfile });

    const reloadLogin = await runtime.issueForAuthenticatedWebUser(legacyUser, "legacy-account-a");
    const reloaded = await initialize(reloadLogin);
    expect(reloaded).toMatchObject({ status: "retained", revision: 4, profile: savedProfile });

    const switched = await runtime.switchCompanyCredential(reloadLogin.credential, companyB);
    expect(switched.context.company_id).toBe(companyB);
    const switchedProfile = await initialize(switched);
    expect(switchedProfile).toMatchObject({ status: "selected", revision: 1, profile: { module_id: "titan.workforce.cleaning" } });

    for (const company_id of [companyA, companyB]) {
      const storage = nodeSqliteStorage(paths.get(`placement-${company_id}`)!);
      try {
        const settings = (await storage.query<{ settings: string }>("SELECT settings FROM companies WHERE id=$1", [company_id])).rows[0]!.settings;
        const parsed = JSON.parse(settings);
        if (company_id === companyA) {
          expect(parsed).toMatchObject({ retained_setting: "keep", vertical_profile: { company_id, revision: 4, profile: savedProfile } });
        } else {
          expect(parsed).toMatchObject({ vertical_profile: { company_id, revision: 1, profile: { module_id: "titan.workforce.cleaning" } } });
        }
      } finally { await storage.close(); }
    }
  });

  it("requires explicit existing registry and company-store configuration", async () => {
    const dummy = {
      credential: "unused",
      context: {} as never,
      scope: {} as never,
      session: {} as never,
      operationCompanyIds: [] as never,
    };
    await expect(initializeCleaningProfileForLogin({
      issued: dummy,
      resolveCurrentSession: async () => null,
      environment: {},
    })).rejects.toMatchObject({ code: "CLEANING_PROFILE_STORE_SETUP_REQUIRED", missing_or_invalid: ["TITAN_WEB_IDENTITY_REGISTRY_PATH"] });
  });
});
