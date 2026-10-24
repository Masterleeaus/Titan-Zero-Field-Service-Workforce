import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteCompanyPlacementRegistry,
  createSqliteCompanyStoreOpener,
  createSqliteStorage,
  initializeSqliteCompanyPlacementRegistry,
} from "../../../packages/storage/src/index.js";
import { companyNativeWorkOrdersManifest } from "../../../packages/storage/src/company-native-schema-manifest.js";
import { initializeFreshCompanyNativeStore } from "../../../packages/storage/src/company-native-store-initializer.js";
import { createIdentitySessionRegistry } from "../../../packages/titan-platform/src/security-boundary.js";
import { createWorkforceSessionCredentialVerifier } from "./session-credential-verifier.js";
import { createCompanyScopedWorkOrders } from "./company-scoped-work-orders.js";
// @ts-expect-error This production adapter is JavaScript and runs through tsx.
import { createNativeWorkOrders } from "./native-work-orders.mjs";
// @ts-expect-error The authority evaluator is the canonical JavaScript runtime owner.
import { assertAuthorityDecisionAllowsExecution } from "../../../packages/runtime/authority/authority-evaluator.mjs";

test("company-scoped consumer verifies the physical schema and applies the required authority fence", async () => {
  const root = mkdtempSync(join(tmpdir(), "titan-native-work-orders-composition-"));
  const companyRoot = join(root, "companies");
  mkdirSync(companyRoot, { mode: 0o700 });
  const globalStore = createSqliteStorage(join(root, "global-registry.sqlite"));
  const companyId = "native-company-a";
  const actorId = "verified-actor-a";
  const placement = Object.freeze({ company_id: companyId, placement_id: "native-placement-a",
    placement_revision: 1, provider: "sqlite" as const, schema_version: companyNativeWorkOrdersManifest.schema_version });
  try {
    const identity = await createIdentitySessionRegistry({ storage: globalStore, storage_role: "GLOBAL_REGISTRY" });
    await initializeSqliteCompanyPlacementRegistry({ storage: globalStore, storage_role: "GLOBAL_REGISTRY" });
    const provider = "directadmin:https://panel.test.invalid";
    const at = new Date();
    const session = {
      session_id: "session-native-a", device_id: "device-native-a", company_id: companyId,
      audience: "workforce", issued_at: at.toISOString(), expires_at: new Date(at.getTime() + 600_000).toISOString(),
    };
    await identity.putActor({ actor_id: actorId, status: "active" }, null);
    await identity.putCompany({ company_id: companyId, status: "active" }, null);
    await identity.putDevice({ device_id: session.device_id, actor_id: actorId, status: "active" }, null);
    await identity.putMembership({ company_id: companyId, actor_id: actorId, role: "owner", status: "active" }, null);
    await identity.putExternalBinding({ binding_id: "binding-native-a", company_id: companyId, actor_id: actorId,
      provider, subject: "subject-native-a", status: "active" }, null);
    const issued = await identity.issueSession({ ...session, provider, subject: "subject-native-a" }, at.toISOString());

    const keys = generateKeyPairSync("ed25519");
    const credentialVerifier = createWorkforceSessionCredentialVerifier({
      issuer: "titan:workforce-auth", key_id: "native-test-key", algorithm: "EdDSA",
      verification_key: keys.publicKey as unknown as CryptoKey, registry: identity,
      upstream: { issuer: provider, audience: "da-login", key_id: "upstream-test-key",
        algorithm: "EdDSA", verification_key: keys.publicKey as unknown as CryptoKey },
      directadmin: { node_id: "node-test" }, now: () => at,
    });
    const nowSeconds = Math.floor(at.getTime() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "native-test-key", typ: "titan-session+jwt" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ identity_provider: provider,
      session_id: issued.session_id, device_id: issued.device_id, company_id: issued.company_id,
      actor_id: issued.actor_id, session_revision: issued.session_revision,
      context_revision: issued.context_revision, iss: "titan:workforce-auth", aud: "workforce",
      sub: "subject-native-a", node_id: "node-test", csrf_sha256: "c".repeat(43), da_role: "admin",
      iat: nowSeconds, exp: nowSeconds + 300 })).toString("base64url");
    const signingInput = `${header}.${claims}`;
    const token = `${signingInput}.${sign(null, Buffer.from(signingInput), keys.privateKey).toString("base64url")}`;
    const proof = await credentialVerifier.verify(`Bearer ${token}`, { signal: new AbortController().signal });
    const expected = { audience: "workforce", company_id: companyId, actor_id: actorId };
    const current = await identity.resolveCurrentSession(proof, expected, at.toISOString());
    assert.equal(current.company_id, companyId);
    assert.equal(current.actor_id, actorId);
    assert.equal(current.authority_neutral, true);

    // This disposable registry row models a placement that the placement owner
    // has made READY; the native consumer only observes it and its physical
    // attestation. No production registry or readiness state is changed.
    await globalStore.query(
      `INSERT INTO titan_company_storage_placements
       (company_id,placement_id,placement_revision,provider,schema_version,status)
       VALUES($1,$2,$3,'sqlite',$4,'READY')`,
      [placement.company_id, placement.placement_id, placement.placement_revision, placement.schema_version],
    );
    const companyPath = join(companyRoot, `${placement.placement_id}.sqlite`);
    const provisioned = createSqliteStorage(companyPath);
    await initializeFreshCompanyNativeStore({ storage: provisioned, placement, company_profile: { name: "Native A" } });
    await provisioned.query("INSERT INTO clients(id,company_id,name) VALUES('client-a',$1,'Client A')", [companyId]);
    await provisioned.query("INSERT INTO jobs(id,company_id,client_id,title,created_by) VALUES('job-a',$1,'client-a','Job A',$2)", [companyId, actorId]);
    await provisioned.query(`INSERT INTO work_orders(id,company_id,job_id,client_id,title,status,created_by,assigned_user_id)
      VALUES('work-a',$1,'job-a','client-a','Work A','in_progress',$2,$2)`, [companyId, actorId]);
    await provisioned.query(`INSERT INTO visits(id,company_id,job_id,work_order_id,assigned_user_id,status,scheduled_start,scheduled_end)
      VALUES('visit-a',$1,'job-a','work-a',$2,'completed','2026-01-01T09:00:00Z','2026-01-01T10:00:00Z')`, [companyId, actorId]);
    await provisioned.close();

    const placementRegistry = await createSqliteCompanyPlacementRegistry({ storage: globalStore, storage_role: "GLOBAL_REGISTRY" });
    const operations = createNativeWorkOrders();
    const consumer = createCompanyScopedWorkOrders({
      placementRegistry,
      storeOpener: createSqliteCompanyStoreOpener({ companyStoreRoot: companyRoot }),
      async resolveCurrentSession() { return { current, proof }; },
      async revalidateCurrentSession(sessionProof, _expected, _signal, input) {
        return identity.resolveCurrentSession(sessionProof, {
          audience: "workforce", company_id: input!.company_id, actor_id: input!.actor_id,
          context_revision: current.context_revision,
        }, new Date().toISOString());
      },
      operations,
    });
    // Untrusted URL/path fields must not influence the registered placement lookup or opener.
    const input = { company_id: companyId, actor_id: actorId, run_id: "run-native-a", work_id: "work-item-a",
      work_order_id: "work-a", DATABASE_URL: "sqlite:///attacker-company.sqlite",
      database_url: "postgres://attacker/company-b", path: "/tmp/company-b.sqlite",
      signal: new AbortController().signal };
    const read = await consumer.read(input);
    assert.deepEqual(read, { id: "work-a", status: "in_progress", completed_at: null, evidence_context: null });

    // A valid current session for A cannot be used to ask this consumer to open B.
    await assert.rejects(
      consumer.read({ ...input, company_id: "native-company-b" }),
      /workforce-company-session-binding-invalid/,
    );

    await globalStore.query(
      "UPDATE titan_company_storage_placements SET placement_revision=2 WHERE company_id=$1", [companyId],
    );
    await assert.rejects(consumer.read(input), /company-native-schema-placement-mismatch/);
    await globalStore.query(
      "UPDATE titan_company_storage_placements SET placement_revision=1 WHERE company_id=$1", [companyId],
    );

    // Use the real authority evaluator as the completion fence. A denied,
    // correctly bound decision must prevent mutation all the way through the
    // registry resolver, attested physical opener and native completion owner.
    const deniedDecision = { company_id: companyId, capability: "crm.work_order.complete",
      operation_id: input.work_id, action_id: input.work_order_id, worker_id: actorId,
      decision: "DENY", evaluated_at: new Date().toISOString() };
    const authorityFence = { assertCurrent() {
      assertAuthorityDecisionAllowsExecution(deniedDecision, {
        company_id: companyId, capability: "crm.work_order.complete", operation_id: input.work_id,
        action_id: input.work_order_id, worker_id: actorId, now: new Date().toISOString(),
      });
    } };
    await assert.rejects(consumer.complete({ ...input, authorityFence }), /authority-not-allowed:DENY/);
    const afterDenied = await consumer.read(input);
    assert.deepEqual(afterDenied, { id: "work-a", status: "in_progress", completed_at: null, evidence_context: null });

    const drifted = createSqliteStorage(companyPath);
    await drifted.query("CREATE TABLE unapproved_native_object(id TEXT PRIMARY KEY)");
    await drifted.close();
    await assert.rejects(consumer.read(input), /company-native-schema-fingerprint-mismatch/);

    // Placement alone is insufficient: the current membership is re-resolved on
    // every operation, so revocation after queue admission denies access.
    await identity.putMembership({ company_id: companyId, actor_id: actorId, role: "owner", status: "revoked" }, 1);
    await assert.rejects(consumer.read(input), /scope-not-current/);
  } finally {
    await globalStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});
