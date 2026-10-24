import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdentitySessionRegistry,
  type IdentitySessionRegistry,
} from "@titan-zero/titan-platform/security-boundary";
import {
  createSqliteStorage,
  initializeSqliteCompanyPlacementRegistry,
  provisionSqliteCompanyPlacement,
  type StorageClient,
} from "../../../../../packages/storage/src/index";
import { companyNativeVisitChecklistManifest } from "../../../../../packages/storage/src/company-native-schema-manifest";
import { CURRENT_WEB_SESSION_COOKIE_NAME } from "../../auth/current-session";
import { _resetWebSessionRuntimeForTests, getWebSessionRuntime } from "../../auth/web-session-runtime";
import { withVerifiedWebNativeCompanyStore } from "../../company-storage/request-runtime";
import { initializeCleaningProfileForLogin } from "../../company-storage/cleaning-profile-login";
import { expiredSessionLoginRedirectForPath, resolvePostLoginHref } from "../../auth/post-login-destination";
import { GET as getChecklist } from "@/app/api/v1/visits/[id]/checklist/route";
import { PATCH as patchChecklist } from "@/app/api/v1/visits/[id]/checklist/[itemId]/route";
// @ts-expect-error Workforce producer hooks are JavaScript production modules.
import { assertReplayTaskLineage, verifiedTaskLineageFromProducerEvent } from "../../../../../services/workforce/src/field-service-runtime.mjs";
// @ts-expect-error Workforce accepted-reference resolver is a JavaScript production module.
import { resolveAcceptedEvidenceReferencesInTransaction } from "../../../../../services/workforce/src/accepted-evidence-reference-resolver.mjs";
// @ts-expect-error Workforce native work-order adapter is a JavaScript production module.
import { createNativeWorkOrders } from "../../../../../services/workforce/src/native-work-orders.mjs";
// @ts-expect-error Canonical accepted evidence ledger is a JavaScript production module.
import { AcceptedEvidenceLedger } from "../../../../../packages/tools/accepted-evidence-ledger.mjs";

const origin = "https://field.example.test";
const loginIssuer = `titan:web-login:${origin}`;
const companies = [
  { companyId: "cleaning-company-a", accountId: "legacy-account-a", actorId: "cleaner-actor-a", userId: "legacy-user-a", deviceId: "web-device-a", role: "owner" },
  { companyId: "cleaning-company-b", accountId: "legacy-account-b", actorId: "cleaner-actor-b", userId: "legacy-user-b", deviceId: "web-device-b", role: "tech" },
] as const;
const commonIds = {
  client: "20000000-0000-4000-8000-000000000001",
  property: "20000000-0000-4000-8000-000000000002",
  job: "20000000-0000-4000-8000-000000000003",
  workOrder: "20000000-0000-4000-8000-000000000004",
  visit: "20000000-0000-4000-8000-000000000005",
  task: "20000000-0000-4000-8000-000000000006",
  isolatedVisit: "20000000-0000-4000-8000-000000000007",
  isolatedTask: "20000000-0000-4000-8000-000000000008",
};

let directory: string;
let storeRoot: string;
let fileRoot: string;
let identityStorage: StorageClient;
let evidenceStorage: StorageClient | undefined;
let identityRegistry: IdentitySessionRegistry;
let oldEnvironment: Record<string, string | undefined>;
const envNames = [
  "TITAN_WEB_PUBLIC_ORIGIN", "TITAN_WEB_IDENTITY_REGISTRY_PATH", "TITAN_WEB_LOGIN_KEY_ID",
  "TITAN_WEB_LOGIN_SIGNING_SECRET", "TITAN_WEB_SESSION_KEY_ID", "TITAN_WEB_SESSION_SIGNING_SECRET",
  "TITAN_WEB_IDENTITY_BINDINGS_JSON", "TITAN_COMPANY_DATA_ROOT",
];

function request(path: string, credential: string, init?: RequestInit): NextRequest {
  const headers = new Headers(init?.headers);
  headers.set("cookie", `${CURRENT_WEB_SESSION_COOKIE_NAME}=${credential}`);
  return new NextRequest(`${origin}${path}`, {
    ...init,
    headers,
  });
}

async function createReadyCompanyStore(company: (typeof companies)[number]): Promise<void> {
  const placement = await provisionSqliteCompanyPlacement({
    registry: { storage: identityStorage, storage_role: "GLOBAL_REGISTRY", companyStoreRoot: storeRoot, companyFileStoreRoot: fileRoot },
    company_id: company.companyId,
    company_name: company.companyId,
    schema_version: companyNativeVisitChecklistManifest.schema_version,
  });
  const placementId = placement.placement_id;
  const storage = createSqliteStorage(join(storeRoot, `${placementId}.sqlite`));
  try {
    const id = commonIds;
    await storage.query("INSERT INTO clients(id,company_id,name) VALUES($1,$2,$3)", [id.client, company.companyId, `${company.companyId} client`]);
    await storage.query("INSERT INTO properties(id,company_id,client_id,address) VALUES($1,$2,$3,$4)", [id.property, company.companyId, id.client, `${company.companyId} address`]);
    await storage.query("INSERT INTO jobs(id,company_id,client_id,property_id,title,created_by) VALUES($1,$2,$3,$4,$5,$6)", [id.job, company.companyId, id.client, id.property, `${company.companyId} cleaning job`, company.actorId]);
    await storage.query("INSERT INTO work_orders(id,company_id,job_id,client_id,title,created_by) VALUES($1,$2,$3,$4,$5,$6)", [id.workOrder, company.companyId, id.job, id.client, `${company.companyId} work order`, company.actorId]);
    await storage.query("INSERT INTO work_order_tasks(id,company_id,work_order_id,label,note) VALUES($1,$2,$3,$4,$5)", [id.task, company.companyId, id.workOrder, `${company.companyId} checklist task`, `work-order-${company.companyId}`]);
    await storage.query("INSERT INTO visits(id,company_id,job_id,assigned_user_id,scheduled_start,scheduled_end,work_order_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [id.visit, company.companyId, id.job, company.actorId, "2026-10-03T10:00:00.000Z", "2026-10-03T11:00:00.000Z", id.workOrder]);
    await storage.query("INSERT INTO visit_tasks(company_id,visit_id,work_order_id,task_id,item_key,section,disposition,note) VALUES($1,$2,$3,$4,$5,$6,NULL,$7)", [company.companyId, id.visit, id.workOrder, id.task, "cleaning_surface_wipe", "Kitchen", `original-${company.companyId}`]);

    if (company === companies[0]) {
      await storage.query("UPDATE companies SET settings=$1 WHERE id=$2", [JSON.stringify({
        retained_setting: "keep-company-a",
        vertical_profile: {
          schema: "titan.company.vertical-profile.v1",
          company_id: company.companyId,
          revision: 4,
          profile: { pack_id: "existing-company-pack", pack_version: "2.0.0", module_id: "existing.vertical", module_version: "2.0.0" },
        },
      }), company.companyId]);
    }

    if (company === companies[0]) {
      await storage.query("INSERT INTO visits(id,company_id,job_id,assigned_user_id,scheduled_start,scheduled_end,work_order_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [id.isolatedVisit, company.companyId, id.job, company.actorId, "2026-10-03T12:00:00.000Z", "2026-10-03T13:00:00.000Z", id.workOrder]);
      await storage.query("INSERT INTO work_order_tasks(id,company_id,work_order_id,label) VALUES($1,$2,$3,$4)", [id.isolatedTask, company.companyId, id.workOrder, "A-only secret task"]);
      await storage.query("INSERT INTO visit_tasks(company_id,visit_id,work_order_id,task_id,item_key,section) VALUES($1,$2,$3,$4,$5,$6)", [company.companyId, id.isolatedVisit, id.workOrder, id.isolatedTask, "a_only", "Private"]);
    }
  } finally {
    await storage.close();
  }
}

beforeEach(async () => {
  _resetWebSessionRuntimeForTests();
  oldEnvironment = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  directory = await mkdtemp(join(tmpdir(), "titan-native-checklist-route-"));
  storeRoot = join(directory, "companies");
  fileRoot = join(directory, "company-files");
  await mkdir(storeRoot, { mode: 0o700 });
  await mkdir(fileRoot, { mode: 0o700 });
  const registryPath = join(directory, "global-registry.sqlite");
  const bindings = companies.map(company => ({
    legacy_user_id: company.userId,
    legacy_account_id: company.accountId,
    company_id: company.companyId,
    actor_id: company.actorId,
    device_id: company.deviceId,
  }));
  Object.assign(process.env, {
    TITAN_WEB_PUBLIC_ORIGIN: origin,
    TITAN_WEB_IDENTITY_REGISTRY_PATH: registryPath,
    TITAN_WEB_LOGIN_KEY_ID: "web-login-test-key",
    TITAN_WEB_LOGIN_SIGNING_SECRET: randomBytes(32).toString("base64url"),
    TITAN_WEB_SESSION_KEY_ID: "web-session-test-key",
    TITAN_WEB_SESSION_SIGNING_SECRET: randomBytes(32).toString("base64url"),
    TITAN_WEB_IDENTITY_BINDINGS_JSON: JSON.stringify(bindings),
    TITAN_COMPANY_DATA_ROOT: storeRoot,
  });

  identityStorage = createSqliteStorage(registryPath);
  identityRegistry = await createIdentitySessionRegistry({ storage: identityStorage, storage_role: "GLOBAL_REGISTRY" });
  await initializeSqliteCompanyPlacementRegistry({ storage: identityStorage, storage_role: "GLOBAL_REGISTRY" });
  for (const company of companies) {
    await identityRegistry.putActor({ actor_id: company.actorId, status: "active" }, null);
    await identityRegistry.putCompany({ company_id: company.companyId, status: "active" }, null);
    await identityRegistry.putMembership({ actor_id: company.actorId, company_id: company.companyId, role: company.role, status: "active" }, null);
    await identityRegistry.putDevice({ device_id: company.deviceId, actor_id: company.actorId, status: "active" }, null);
    await identityRegistry.putExternalBinding({ binding_id: `web-login-${company.companyId}`, provider: loginIssuer, subject: company.userId, actor_id: company.actorId, company_id: company.companyId, status: "active" }, null);
  }
  await createReadyCompanyStore(companies[0]);
  await createReadyCompanyStore(companies[1]);
});

afterEach(async () => {
  await getWebSessionRuntime().then(runtime => runtime.close()).catch(() => undefined);
  _resetWebSessionRuntimeForTests();
  await evidenceStorage?.close();
  evidenceStorage = undefined;
  await identityStorage?.close();
  await rm(directory, { recursive: true, force: true });
  for (const name of envNames) {
    const previous = oldEnvironment[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  vi.useRealTimers();
});

describe("native visit checklist routes", () => {
  it("carries a real v3 checklist task through verified production, accepted reference resolution, and replay checks", async () => {
    const runtime = await getWebSessionRuntime();
    const session = await runtime.issueForAuthenticatedWebUser(companies[0].userId, companies[0].accountId);
    const patched = await patchChecklist(request(`/api/v1/visits/${commonIds.visit}/checklist/${commonIds.task}`, session.credential, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disposition: "fix_now", note: "verified against the completed visit" }),
    }));
    expect(patched.status).toBe(200);

    const nativeWorkOrders = createNativeWorkOrders();
    const observed = await withVerifiedWebNativeCompanyStore({
      currentSession: session,
      revalidateSession: () => runtime.resolveCredential(session.credential),
      requiredSchemaVersions: [companyNativeVisitChecklistManifest.schema_version],
      operation: async storage => {
        await storage.query("UPDATE work_orders SET assigned_user_id=$1 WHERE company_id=$2 AND id=$3",
          [companies[0].actorId, companies[0].companyId, commonIds.workOrder]);
        await storage.query("UPDATE work_order_tasks SET completed=1,status='done',completed_at=CURRENT_TIMESTAMP WHERE company_id=$1 AND id=$2",
          [companies[0].companyId, commonIds.task]);
        await storage.query("UPDATE visits SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE company_id=$1 AND id=$2",
          [companies[0].companyId, commonIds.visit]);
        return nativeWorkOrders.read({ company_id: companies[0].companyId, actor_id: companies[0].actorId,
          work_order_id: commonIds.workOrder, companyStorage: storage });
      },
    });
    expect(observed?.evidence_context).toEqual({ company_id: companies[0].companyId,
      work_order_id: commonIds.workOrder, visit_id: commonIds.visit, task_id: commonIds.task, disposition: "fix_now" });

    const workId = "work-v3-checklist";
    const decisionId = "decision-v3-checklist";
    const verification = { verified: true, verification_id: "verification-v3-checklist",
      method: "independent-company-store-reread", evidence_context: observed?.evidence_context };
    const producerEvent: any = {
      evidence_id: "evidence-v3-checklist", company_id: companies[0].companyId,
      execution_id: "execution-v3-checklist", decision_id: decisionId, authority_decision_id: decisionId,
      work_id: workId, run_id: "run-v3-checklist", correlation_id: "correlation-v3-checklist",
      state: "VERIFIED", final_outcome: "verified",
      request_summary: { capability: "crm.work_order.complete", input: { company_id: companies[0].companyId,
        work_id: workId, work_order_id: commonIds.workOrder } },
      observed_result: { status: "completed", evidence_context: observed?.evidence_context },
      verification,
    };
    const lineage = verifiedTaskLineageFromProducerEvent(producerEvent);
    expect(lineage).toEqual(observed?.evidence_context);
    expect(verifiedTaskLineageFromProducerEvent({ ...producerEvent, verification: {
      ...verification, evidence_context: { ...observed?.evidence_context, company_id: companies[1].companyId },
    } })).toBeNull();
    expect(() => assertReplayTaskLineage({ accepted_evidence: { request_summary: {
      canonical_operation_context: lineage,
    } } }, { evidence_context: { ...lineage, task_id: "forged-task" } }))
      .toThrow("zero-replay-task-context-no-longer-verified");

    const persisted = {
      ...producerEvent,
      request_summary: { ...producerEvent.request_summary, canonical_operation_context: lineage },
      observed_result: { ...producerEvent.observed_result, ...lineage },
      verification: { ...producerEvent.verification, ...lineage },
    };
    const ledger = new AcceptedEvidenceLedger({ now: () => "2026-10-03T09:00:00.000Z" });
    const accepted_evidence = ledger.append(persisted);
    const provenance = { company_id: companies[0].companyId, work_id: workId, run_id: producerEvent.run_id,
      decision_id: decisionId, correlation_id: producerEvent.correlation_id,
      execution_idempotency_key: "idempotency-v3-checklist", source_evidence_refs: ["source-proof-v3"], ...lineage };
    evidenceStorage = createSqliteStorage(join(directory, "accepted-evidence.sqlite"));
    await evidenceStorage.query(`CREATE TABLE evidence(id TEXT PRIMARY KEY,company_id TEXT,subject_type TEXT,
      subject_id TEXT,evidence_type TEXT,provenance TEXT,payload TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await evidenceStorage.query("INSERT INTO evidence(id,company_id,subject_type,subject_id,evidence_type,provenance,payload) VALUES($1,$2,'work',$3,'gateway_execution',$4,$5)",
      [producerEvent.evidence_id, companies[0].companyId, workId, JSON.stringify(provenance),
        JSON.stringify({ ...persisted, provenance, accepted_evidence })]);
    const criteria = { company_id: companies[0].companyId, work_id: workId, visit_id: commonIds.visit,
      work_order_id: commonIds.workOrder, task_id: commonIds.task, disposition: "fix_now" };
    const references = await evidenceStorage.transaction(tx => resolveAcceptedEvidenceReferencesInTransaction(tx, criteria));
    expect(references).toMatchObject([{ evidence_id: producerEvent.evidence_id, ...criteria,
      verification_id: verification.verification_id }]);
    expect(await evidenceStorage.transaction(tx => resolveAcceptedEvidenceReferencesInTransaction(tx,
      { ...criteria, company_id: companies[1].companyId }))).toEqual([]);

    const checklist = await getChecklist(request(`/api/v1/visits/${commonIds.visit}/checklist`, session.credential));
    expect(checklist.status).toBe(200);
    expect((await checklist.json()).data).toContainEqual(expect.objectContaining({
      id: commonIds.task, company_id: companies[0].companyId, disposition: references[0].disposition,
    }));
  });

  it("expires, returns through re-login, preserves company A profile, and opens fresh-v3 company B checklist", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const runtime = await getWebSessionRuntime();
    const initial = await runtime.issueForAuthenticatedWebUser(companies[0].userId, companies[0].accountId);
    const initialProfile = await initializeCleaningProfileForLogin({ issued: initial });
    expect(initialProfile).toMatchObject({
      status: "retained",
      revision: 4,
      profile: { pack_id: "existing-company-pack", module_id: "existing.vertical" },
    });

    const protectedPath = `/app/visits/${commonIds.visit}`;
    const expiryHref = expiredSessionLoginRedirectForPath(protectedPath);
    const expiryUrl = new URL(expiryHref, origin);
    expect(expiryUrl.pathname).toBe("/login");
    expect(expiryUrl.searchParams.get("reason")).toBe("session-expired");
    expect(resolvePostLoginHref("owner", { next: expiryUrl.searchParams.get("next") })).toBe(protectedPath);

    // Expire the signed five-minute session in this disposable test clock; the
    // request must reject it before a subsequent fresh password-backed issue.
    vi.setSystemTime(new Date(Date.parse(initial.context.expires_at) + 1_000));
    expect(Date.parse(initial.context.expires_at) - Date.now()).toBeLessThan(0);
    const expiredChecklist = await getChecklist(request(`/api/v1/visits/${commonIds.visit}/checklist`, initial.credential));
    expect(expiredChecklist.status).toBe(401);

    const reLogin = await runtime.issueForAuthenticatedWebUser(companies[0].userId, companies[0].accountId);
    const retainedAfterReLogin = await initializeCleaningProfileForLogin({ issued: reLogin });
    expect(retainedAfterReLogin).toMatchObject({ status: "retained", revision: 4, profile: { module_id: "existing.vertical" } });
    const companyASettings = await withVerifiedWebNativeCompanyStore({
      currentSession: reLogin,
      revalidateSession: () => runtime.resolveCredential(reLogin.credential),
      requiredSchemaVersions: companyNativeVisitChecklistManifest.schema_version,
      operation: async storage => (await storage.query<{ settings: string }>(
        "SELECT settings FROM companies WHERE id=$1", [companies[0].companyId],
      )).rows[0]?.settings,
    });
    expect(JSON.parse(companyASettings!)).toMatchObject({
      retained_setting: "keep-company-a",
      vertical_profile: { company_id: companies[0].companyId, revision: 4, profile: { module_id: "existing.vertical" } },
    });

    const companyBLogin = await runtime.issueForAuthenticatedWebUser(companies[1].userId, companies[1].accountId);
    const companyBProfile = await initializeCleaningProfileForLogin({ issued: companyBLogin });
    expect(companyBProfile).toMatchObject({ status: "selected", revision: 1, profile: { module_id: "titan.workforce.cleaning" } });

    const checklist = await getChecklist(request(`/api/v1/visits/${commonIds.visit}/checklist`, companyBLogin.credential));
    expect(checklist.status).toBe(200);
    expect((await checklist.json()).visit).toMatchObject({ company_id: companies[1].companyId, work_order_id: commonIds.workOrder });
  });

  it("uses the verified current session and each READY physical company store for list and update", async () => {
    const runtime = await getWebSessionRuntime();
    const a = await runtime.issueForAuthenticatedWebUser(companies[0].userId, companies[0].accountId);
    const b = await runtime.issueForAuthenticatedWebUser(companies[1].userId, companies[1].accountId);

    const justIssuedCompany = await withVerifiedWebNativeCompanyStore({
      currentSession: a,
      revalidateSession: () => runtime.resolveCredential(a.credential),
      requiredSchemaVersions: [companyNativeVisitChecklistManifest.schema_version],
      operation: async storage => (await storage.query<{ id: string }>(
        "SELECT id FROM companies WHERE id=$1", [companies[0].companyId],
      )).rows[0]?.id,
    });
    expect(justIssuedCompany).toBe(companies[0].companyId);

    const aResponse = await getChecklist(request(`/api/v1/visits/${commonIds.visit}/checklist`, a.credential));
    expect(aResponse.status).toBe(200);
    const aBody = await aResponse.json();
    expect(aBody.visit).toMatchObject({ company_id: companies[0].companyId, property_id: commonIds.property, job_id: commonIds.job, work_order_id: commonIds.workOrder });
    expect(aBody.data).toHaveLength(1);
    expect(aBody.data[0]).toMatchObject({ company_id: companies[0].companyId, account_id: companies[0].companyId, label: `${companies[0].companyId} checklist task`, note: `original-${companies[0].companyId}`, disposition: null });

    const bResponse = await getChecklist(request(`/api/v1/visits/${commonIds.visit}/checklist`, b.credential));
    expect(bResponse.status).toBe(200);
    const bBody = await bResponse.json();
    expect(bBody.visit.company_id).toBe(companies[1].companyId);
    expect(bBody.data[0]).toMatchObject({ company_id: companies[1].companyId, label: `${companies[1].companyId} checklist task`, note: `original-${companies[1].companyId}`, disposition: null });

    const update = await patchChecklist(request(`/api/v1/visits/${commonIds.visit}/checklist/${commonIds.task}`, a.credential, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disposition: "ok", note: "completed for A", company_id: companies[1].companyId }),
    }));
    expect(update.status).toBe(200);
    expect((await update.json()).data).toMatchObject({ company_id: companies[0].companyId, disposition: "ok", note: "completed for A" });

    const bAfterUpdate = await getChecklist(request(`/api/v1/visits/${commonIds.visit}/checklist`, b.credential));
    expect((await bAfterUpdate.json()).data[0]).toMatchObject({ disposition: null, note: `original-${companies[1].companyId}` });

    const crossCompany = await getChecklist(request(`/api/v1/visits/${commonIds.isolatedVisit}/checklist`, b.credential));
    expect(crossCompany.status).toBe(404);
  });

  it("denies revoked and missing credentials before opening checklist business state", async () => {
    const runtime = await getWebSessionRuntime();
    const a = await runtime.issueForAuthenticatedWebUser(companies[0].userId, companies[0].accountId);
    const missing = await getChecklist(new NextRequest(`${origin}/api/v1/visits/${commonIds.visit}/checklist`));
    expect(missing.status).toBe(401);

    await runtime.revokeCredential(a.credential);
    const revoked = await getChecklist(request(`/api/v1/visits/${commonIds.visit}/checklist`, a.credential));
    expect(revoked.status).toBe(401);
  });

  it("fails closed for a placement whose native manifest does not meet the checklist operation", async () => {
    const runtime = await getWebSessionRuntime();
    const a = await runtime.issueForAuthenticatedWebUser(companies[0].userId, companies[0].accountId);
    await identityStorage.query("UPDATE titan_company_storage_placements SET schema_version='company-native-work-orders-visits-v2' WHERE company_id=$1", [companies[0].companyId]);
    const response = await getChecklist(request(`/api/v1/visits/${commonIds.visit}/checklist`, a.credential));
    expect(response.status).toBe(503);
  });
});
