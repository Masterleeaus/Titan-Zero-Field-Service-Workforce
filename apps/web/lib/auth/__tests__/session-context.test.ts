/** Password login -> canonical credential -> cookie -> protected route.
 * Auth state uses a file-backed GLOBAL_REGISTRY; business rows are isolated. */
import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import { SignJWT } from "jose";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rewriteSqliteParams } from "@/lib/db/sqlite-params";

type CookieValue = { value: string; options?: Record<string, unknown> };
const state = vi.hoisted(() => ({
  cookies: new Map<string, CookieValue>(),
  setCalls: [] as Array<{ name: string; value: string; options?: Record<string, unknown> }>,
  dialect: "sqlite",
  read: null as null | ((sql: string, params: unknown[]) => unknown[]),
  businessReads: 0,
  loginCandidateQueries: 0,
  lastLoginCandidateSql: "",
  failSessionRevocation: false,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (name: string) => {
    const cookie = state.cookies.get(name);
    return cookie ? { value: cookie.value } : undefined;
  },
  set: (name: string, value: string, options?: Record<string, unknown>) => {
    state.setCalls.push({ name, value, options });
    if (options?.maxAge === 0) state.cookies.delete(name);
    else state.cookies.set(name, { value, options });
  },
  delete: (name: string) => state.cookies.delete(name),
}) }));
vi.mock("@/lib/db/dialect", () => ({ getDatabaseDialect: () => state.dialect }));
vi.mock("@/lib/db/portable", () => ({
  portableQueryOne: async (sql: string, params: unknown[] = []) => state.read!(sql, params)[0] ?? null,
  portableQuery: async (sql: string, params: unknown[] = []) => {
    if (/\bFROM\s+app_login_candidates\s*\(/i.test(sql)) {
      state.loginCandidateQueries++;
      state.lastLoginCandidateSql = sql;
      return state.read!(
        `SELECT id, email, full_name, role, account_id, password_hash FROM users WHERE lower(email) = lower($1) ORDER BY created_at ASC, id ASC LIMIT 2`,
        params,
      );
    }
    if (/\bFROM\s+clients\b/i.test(sql)) state.businessReads++;
    return state.read!(sql, params);
  },
  withPortableTransaction: () => { throw new Error("Read-only route test must not mutate"); },
}));
vi.mock("@/lib/db/audit", () => ({ appendAuditLog: () => { throw new Error("Unexpected audit write"); } }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/auth/web-session-runtime", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/web-session-runtime")>();
  return {
    ...actual,
    getWebSessionRuntime: async () => {
      const runtime = await actual.getWebSessionRuntime();
      if (!state.failSessionRevocation) return runtime;
      return {
        ...runtime,
        async revokeCredential() { throw new Error("test-session-revocation-unavailable"); },
      };
    },
  };
});

import { createIdentitySessionRegistry } from "@titan-zero/titan-platform/security-boundary";
import {
  createSqliteStorage,
  initializeSqliteCompanyPlacementRegistry,
  provisionSqliteCompanyPlacement,
} from "../../../../../packages/storage/src/index";
import {
  companyNativeVisitChecklistManifest,
  companyNativeWorkOrdersVisitsManifest,
} from "../../../../../packages/storage/src/company-native-schema-manifest";
import { CURRENT_WEB_SESSION_COOKIE_NAME } from "../current-session";
import { _resetWebSessionRuntimeForTests, getWebSessionRuntime } from "../web-session-runtime";
import { getSession, verifySession } from "../session";
import { POST as login } from "@/app/api/v1/auth/login/route";
import { POST as logout } from "@/app/api/v1/auth/logout/route";
import { GET as listClients } from "@/app/api/v1/clients/route";
import { GET as getChecklist } from "@/app/api/v1/visits/[id]/checklist/route";
import { expiredSessionLoginRedirectForPath, resolvePostLoginHref } from "../post-login-destination";

const userId = "web-user-1";
const userBId = "web-user-2";
const actorId = "stable-actor-1";
const companyA = "canonical-company-a";
const companyB = "canonical-company-b";
const accountA = "legacy-account-a";
const accountB = "legacy-account-b";
const emailA = "worker@example.test";
const emailB = "technician@example.test";
const deviceId = "web-device-1";
const origin = "https://example.test";
const loginIssuer = `titan:web-login:${origin}`;
const bindingRows = [
  { legacy_user_id: userId, legacy_account_id: accountA, company_id: companyA, actor_id: actorId, device_id: deviceId },
  { legacy_user_id: userBId, legacy_account_id: accountB, company_id: companyB, actor_id: actorId, device_id: deviceId },
];
const journeyIds = {
  client: "30000000-0000-4000-8000-000000000001",
  property: "30000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  workOrder: "30000000-0000-4000-8000-000000000004",
  visit: "30000000-0000-4000-8000-000000000005",
  task: "30000000-0000-4000-8000-000000000006",
};

let directory: string;
let identityStorage: ReturnType<typeof createSqliteStorage>;
let identityRegistry: Awaited<ReturnType<typeof createIdentitySessionRegistry>>;
let db: Database.Database;
let companyStoreRoot: string;
let companyFileRoot: string;
let oldEnvironment: Record<string, string | undefined>;
const envNames = [
  "TITAN_WEB_PUBLIC_ORIGIN", "TITAN_WEB_IDENTITY_REGISTRY_PATH", "TITAN_WEB_LOGIN_KEY_ID",
  "TITAN_WEB_LOGIN_SIGNING_SECRET", "TITAN_WEB_SESSION_KEY_ID", "TITAN_WEB_SESSION_SIGNING_SECRET",
  "TITAN_WEB_IDENTITY_BINDINGS_JSON", "TITAN_COMPANY_DATA_ROOT", "E2E_DISABLE_LOGIN_RATE_LIMIT",
];

function installRuntimeEnvironment(registryPath: string, bindings = bindingRows) {
  process.env.TITAN_WEB_PUBLIC_ORIGIN = origin;
  process.env.TITAN_WEB_IDENTITY_REGISTRY_PATH = registryPath;
  process.env.TITAN_WEB_LOGIN_KEY_ID = "web-login-test-key";
  process.env.TITAN_WEB_LOGIN_SIGNING_SECRET = randomBytes(32).toString("base64url");
  process.env.TITAN_WEB_SESSION_KEY_ID = "web-session-test-key";
  process.env.TITAN_WEB_SESSION_SIGNING_SECRET = randomBytes(32).toString("base64url");
  process.env.TITAN_WEB_IDENTITY_BINDINGS_JSON = JSON.stringify(bindings);
  process.env.E2E_DISABLE_LOGIN_RATE_LIMIT = "1";
}

beforeEach(async () => {
  _resetWebSessionRuntimeForTests();
  state.cookies.clear();
  state.setCalls.length = 0;
  state.dialect = "sqlite";
  state.businessReads = 0;
  state.loginCandidateQueries = 0;
  state.lastLoginCandidateSql = "";
  state.failSessionRevocation = false;
  oldEnvironment = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  directory = await mkdtemp(join(tmpdir(), "titan-auth-runtime-route-"));
  const registryPath = join(directory, "global-registry.sqlite");
  installRuntimeEnvironment(registryPath);
  companyStoreRoot = join(directory, "company-stores");
  companyFileRoot = join(directory, "company-files");
  await mkdir(companyStoreRoot, { mode: 0o700 });
  await mkdir(companyFileRoot, { mode: 0o700 });
  process.env.TITAN_COMPANY_DATA_ROOT = companyStoreRoot;

  identityStorage = createSqliteStorage(registryPath);
  identityRegistry = await createIdentitySessionRegistry({ storage: identityStorage, storage_role: "GLOBAL_REGISTRY" });
  await initializeSqliteCompanyPlacementRegistry({ storage: identityStorage, storage_role: "GLOBAL_REGISTRY" });
  await identityRegistry.putActor({ actor_id: actorId, status: "active" }, null);
  for (const [company, role] of [[companyA, "owner"], [companyB, "tech"]]) {
    await identityRegistry.putCompany({ company_id: company, status: "active" }, null);
    await identityRegistry.putMembership({ actor_id: actorId, company_id: company, role, status: "active" }, null);
    await identityRegistry.putExternalBinding({ binding_id: `login-binding-${company}`, provider: loginIssuer,
      subject: company === companyA ? userId : userBId, actor_id: actorId, company_id: company, status: "active" }, null);
  }
  await identityRegistry.putDevice({ device_id: deviceId, actor_id: actorId, status: "active" }, null);

  for (const companyId of [companyA, companyB]) {
    const schemaVersion = companyId === companyA
      ? companyNativeWorkOrdersVisitsManifest.schema_version
      : companyNativeVisitChecklistManifest.schema_version;
    const placement = await provisionSqliteCompanyPlacement({
      registry: { storage: identityStorage, storage_role: "GLOBAL_REGISTRY", companyStoreRoot, companyFileStoreRoot: companyFileRoot },
      company_id: companyId,
      company_name: companyId,
      schema_version: schemaVersion,
    });
    if (companyId === companyA) {
      const store = createSqliteStorage(join(companyStoreRoot, `${placement.placement_id}.sqlite`));
      await store.query("UPDATE companies SET settings=$1 WHERE id=$2", [JSON.stringify({
        retained_setting: "preserve-company-a",
        vertical_profile: {
          schema: "titan.company.vertical-profile.v1", company_id: companyA, revision: 5,
          profile: { pack_id: "saved-company-pack", pack_version: "2.0.0", module_id: "saved.vertical", module_version: "2.0.0" },
        },
      }), companyA]);
      await store.close();
    } else {
      const store = createSqliteStorage(join(companyStoreRoot, `${placement.placement_id}.sqlite`));
      await store.query("INSERT INTO clients(id,company_id,name) VALUES($1,$2,$3)", [journeyIds.client, companyB, "Company B client"]);
      await store.query("INSERT INTO properties(id,company_id,client_id,address) VALUES($1,$2,$3,$4)", [journeyIds.property, companyB, journeyIds.client, "Company B address"]);
      await store.query("INSERT INTO jobs(id,company_id,client_id,property_id,title,created_by) VALUES($1,$2,$3,$4,$5,$6)", [journeyIds.job, companyB, journeyIds.client, journeyIds.property, "Company B cleaning job", actorId]);
      await store.query("INSERT INTO work_orders(id,company_id,job_id,client_id,title,created_by) VALUES($1,$2,$3,$4,$5,$6)", [journeyIds.workOrder, companyB, journeyIds.job, journeyIds.client, "Company B work order", actorId]);
      await store.query("INSERT INTO work_order_tasks(id,company_id,work_order_id,label) VALUES($1,$2,$3,$4)", [journeyIds.task, companyB, journeyIds.workOrder, "Company B checklist task"]);
      await store.query("INSERT INTO visits(id,company_id,job_id,assigned_user_id,scheduled_start,scheduled_end,work_order_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [journeyIds.visit, companyB, journeyIds.job, actorId, "2026-10-03T10:00:00.000Z", "2026-10-03T11:00:00.000Z", journeyIds.workOrder]);
      await store.query("INSERT INTO visit_tasks(company_id,visit_id,work_order_id,task_id,item_key,section) VALUES($1,$2,$3,$4,$5,$6)", [companyB, journeyIds.visit, journeyIds.workOrder, journeyIds.task, "cleaning_surface_wipe", "Kitchen"]);
      await store.close();
    }
  }

  db = new Database(":memory:");
  db.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT, full_name TEXT, role TEXT, account_id TEXT, company_id TEXT,
      password_hash TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE clients (id TEXT, account_id TEXT, name TEXT, email TEXT, phone TEXT);
    CREATE TABLE properties (id TEXT, client_id TEXT, account_id TEXT);
    CREATE TABLE jobs (id TEXT, client_id TEXT, account_id TEXT);
    INSERT INTO clients (id,account_id,name) VALUES
      ('client-a', '${accountA}', 'Company A client'),
      ('client-b', '${accountB}', 'Company B client');`);
  db.prepare("INSERT INTO users (id,email,full_name,role,account_id,company_id,password_hash) VALUES (?,?,?,?,?,?,?)")
    .run(userId, "worker@example.test", "Worker", "admin", accountA, accountA, await hash("password-correct", 4));
  db.prepare("INSERT INTO users (id,email,full_name,role,account_id,company_id,password_hash) VALUES (?,?,?,?,?,?,?)")
    .run(userBId, emailB, "Technician", "tech", accountB, accountB, await hash("password-correct", 4));
  state.read = (sql, params) => {
    const bound = rewriteSqliteParams(sql, params);
    return db.prepare(bound.sql).all(...bound.params);
  };
});

afterEach(async () => {
  await getWebSessionRuntime().then(runtime => runtime.close()).catch(() => undefined);
  _resetWebSessionRuntimeForTests();
  vi.useRealTimers();
  await identityStorage?.close();
  db?.close();
  await rm(directory, { recursive: true, force: true });
  for (const name of envNames) {
    const previous = oldEnvironment[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

function loginRequest(password = "password-correct", email = emailA) {
  return new NextRequest(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `runtime-${Math.random()}` },
    body: JSON.stringify({ email, password }),
  });
}

function checklistRequest(credential: string) {
  return new NextRequest(`${origin}/api/v1/visits/${journeyIds.visit}/checklist`, {
    headers: { cookie: `${CURRENT_WEB_SESSION_COOKIE_NAME}=${credential}` },
  });
}

describe("production web authentication composition", () => {
  it("runs password login, cookie expiry, re-login, and checklist access over two isolated companies", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const initialResponse = await login(loginRequest());
    expect(initialResponse.status).toBe(200);
    const firstCookie = state.cookies.get(CURRENT_WEB_SESSION_COOKIE_NAME);
    expect(firstCookie?.value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(firstCookie?.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(firstCookie?.options?.maxAge).toBeGreaterThan(0);
    expect(firstCookie?.options?.maxAge).toBeLessThanOrEqual(300);
    const firstCredential = firstCookie!.value;

    const protectedPath = `/app/visits/${journeyIds.visit}`;
    const expiryUrl = new URL(expiredSessionLoginRedirectForPath(protectedPath), origin);
    expect(expiryUrl.searchParams.get("reason")).toBe("session-expired");
    const next = expiryUrl.searchParams.get("next");
    expect(resolvePostLoginHref("owner", { next })).toBe(protectedPath);

    const aPlacement = (await identityStorage.query<{ placement_id: string }>(
      "SELECT placement_id FROM titan_company_storage_placements WHERE company_id=$1", [companyA],
    )).rows[0]!;
    const aStore = createSqliteStorage(join(companyStoreRoot, `${aPlacement.placement_id}.sqlite`));
    try {
      const settings = JSON.parse((await aStore.query<{ settings: string }>(
        "SELECT settings FROM companies WHERE id=$1", [companyA],
      )).rows[0]!.settings);
      expect(settings).toMatchObject({
        retained_setting: "preserve-company-a",
        vertical_profile: { company_id: companyA, revision: 5, profile: { module_id: "saved.vertical" } },
      });
    } finally { await aStore.close(); }

    // Login/profile initialization is permitted on v2, but checklist routes
    // remain v3-only and must communicate storage unavailability explicitly.
    expect((await getChecklist(checklistRequest(firstCredential))).status).toBe(503);

    const expiresAt = firstCookie?.options?.expires as Date;
    vi.setSystemTime(new Date(expiresAt.getTime() + 1_000));
    expect((await getChecklist(checklistRequest(firstCredential))).status).toBe(401);

    const reloginResponse = await login(loginRequest());
    expect(reloginResponse.status).toBe(200);
    const reloginCookie = state.cookies.get(CURRENT_WEB_SESSION_COOKIE_NAME);
    expect(reloginCookie?.value).toBeTruthy();
    expect(reloginCookie?.value).not.toBe(firstCredential);
    expect(resolvePostLoginHref("owner", { next })).toBe(protectedPath);

    const bLoginResponse = await login(loginRequest("password-correct", emailB));
    expect(bLoginResponse.status).toBe(200);
    expect((await bLoginResponse.json()).user).toMatchObject({ id: userBId, role: "tech", account_id: accountB });
    const bCredential = state.cookies.get(CURRENT_WEB_SESSION_COOKIE_NAME)!.value;
    const bPlacement = (await identityStorage.query<{ placement_id: string }>(
      "SELECT placement_id FROM titan_company_storage_placements WHERE company_id=$1", [companyB],
    )).rows[0]!;
    const bStore = createSqliteStorage(join(companyStoreRoot, `${bPlacement.placement_id}.sqlite`));
    try {
      const settings = JSON.parse((await bStore.query<{ settings: string }>(
        "SELECT settings FROM companies WHERE id=$1", [companyB],
      )).rows[0]!.settings);
      expect(settings.vertical_profile).toMatchObject({ company_id: companyB, revision: 1, profile: { module_id: "titan.workforce.cleaning" } });
    } finally { await bStore.close(); }

    const checklistResponse = await getChecklist(checklistRequest(bCredential));
    expect(checklistResponse.status).toBe(200);
    expect((await checklistResponse.json()).visit).toMatchObject({ company_id: companyB, work_order_id: journeyIds.workOrder });
  });

  it("returns setup-required without a cookie and durably revokes the issued session", async () => {
    delete process.env.TITAN_COMPANY_DATA_ROOT;
    const response = await login(loginRequest());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("CLEANING_PROFILE_SETUP_REQUIRED");
    expect(state.cookies.has(CURRENT_WEB_SESSION_COOKIE_NAME)).toBe(false);
    expect(state.setCalls.some(call => call.name === CURRENT_WEB_SESSION_COOKIE_NAME)).toBe(false);
    expect((await identityStorage.query<{ revoked: number }>(
      "SELECT revoked FROM titan_security_sessions",
    )).rows).toEqual([{ revoked: 1 }]);
  });

  it("reports profile setup failure without claiming revocation when cleanup itself fails", async () => {
    state.failSessionRevocation = true;
    delete process.env.TITAN_COMPANY_DATA_ROOT;
    const response = await login(loginRequest());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("CLEANING_PROFILE_SETUP_REQUIRED");
    expect(state.cookies.has(CURRENT_WEB_SESSION_COOKIE_NAME)).toBe(false);
    expect(state.setCalls.some(call => call.name === CURRENT_WEB_SESSION_COOKIE_NAME)).toBe(false);
    expect((await identityStorage.query<{ revoked: number }>(
      "SELECT revoked FROM titan_security_sessions",
    )).rows).toEqual([{ revoked: 0 }]);
  });

  it("authenticates the actual login route and uses registry role and an HttpOnly canonical cookie", async () => {
    const response = await login(loginRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user).toMatchObject({ id: userId, role: "owner", account_id: accountA });
    const cookie = state.cookies.get(CURRENT_WEB_SESSION_COOKIE_NAME);
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cookie?.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(state.cookies.has("fsm_session")).toBe(false);
    expect(await getSession()).toEqual({ userId, accountId: accountA, role: "owner" });
  });

  it("uses only the migration-178 login-candidate function on PostgreSQL before a session exists", async () => {
    state.dialect = "postgres";
    const response = await login(loginRequest());
    expect(response.status).toBe(200);
    expect(state.loginCandidateQueries).toBe(1);
    expect(state.lastLoginCandidateSql).toMatch(/FROM\s+app_login_candidates\(\$1\)/i);
    expect(state.lastLoginCandidateSql).not.toMatch(/FROM\s+users\b/i);
    expect(await getSession()).toEqual({ userId, accountId: accountA, role: "owner" });
  });

  it("uses the approved mapping and current registry membership for the protected business route", async () => {
    const loginResponse = await login(loginRequest());
    expect(loginResponse.status).toBe(200);
    const allowed = await listClients(new NextRequest(`${origin}/api/v1/clients`));
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).data.map((row: { id: string }) => row.id)).toEqual(["client-a"]);

    state.businessReads = 0;
    await identityRegistry.putMembership({ actor_id: actorId, company_id: companyA, role: "tech", status: "active" }, 1);
    expect(await getSession()).toBeNull();
    const stale = await listClients(new NextRequest(`${origin}/api/v1/clients`));
    expect(stale.status).toBe(401);
    expect(state.businessReads).toBe(0);

    const fresh = await login(loginRequest());
    expect(fresh.status).toBe(200);
    expect((await fresh.json()).user.role).toBe("tech");
    const forbidden = await listClients(new NextRequest(`${origin}/api/v1/clients`));
    expect(forbidden.status).toBe(403);
    expect(state.businessReads).toBe(0);
  });

  it("does not accept a signed legacy fsm_session token or caller-supplied identity fields", async () => {
    const response = await login(loginRequest());
    expect(response.status).toBe(200);
    const secret = Buffer.from(process.env.TITAN_WEB_SESSION_SIGNING_SECRET!, "base64url");
    const legacy = await new SignJWT({ userId, accountId: accountA, role: "owner" })
      .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("7d").sign(secret);
    state.cookies.delete(CURRENT_WEB_SESSION_COOKIE_NAME);
    state.cookies.set("fsm_session", { value: legacy });
    expect(await getSession()).toBeNull();
    expect(await verifySession(legacy)).toBeNull();

    const current = await getWebSessionRuntime();
    await expect(current.issueForAuthenticatedWebUser("caller-selected-user", accountA)).rejects.toMatchObject({
      code: "WEB_IDENTITY_BINDING_REQUIRED",
    });
  });

  it("returns clear setup-required diagnostics and creates no session if production configuration is absent", async () => {
    await getWebSessionRuntime().then(runtime => runtime.close());
    _resetWebSessionRuntimeForTests();
    for (const name of envNames.slice(0, 7)) delete process.env[name];
    const response = await login(loginRequest());
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatchObject({
      code: "WEB_AUTH_SETUP_REQUIRED",
      missing_configuration: expect.arrayContaining(["TITAN_WEB_PUBLIC_ORIGIN", "TITAN_WEB_IDENTITY_REGISTRY_PATH"]),
    });
    expect((await identityStorage.query("SELECT session_id FROM titan_security_sessions")).rows).toEqual([]);

    state.cookies.set(CURRENT_WEB_SESSION_COOKIE_NAME, { value: "a.b.c" });
    const protectedResponse = await listClients(new NextRequest(`${origin}/api/v1/clients`));
    expect(protectedResponse.status).toBe(503);
    expect((await protectedResponse.json()).error.code).toBe("WEB_AUTH_SETUP_REQUIRED");
    const logoutResponse = await logout(new NextRequest(`${origin}/api/v1/auth/logout`, { method: "POST" }));
    expect(logoutResponse.status).toBe(503);
    expect(state.cookies.has(CURRENT_WEB_SESSION_COOKIE_NAME)).toBe(true);
  });

  it("revokes the durable registry session on logout", async () => {
    expect((await login(loginRequest())).status).toBe(200);
    const credential = state.cookies.get(CURRENT_WEB_SESSION_COOKIE_NAME)!.value;
    const response = await logout(new NextRequest(`${origin}/api/v1/auth/logout`, { method: "POST" }));
    expect(response.status).toBe(200);
    expect(state.cookies.has(CURRENT_WEB_SESSION_COOKIE_NAME)).toBe(false);
    expect(state.cookies.has("fsm_session")).toBe(false);
    const clearedHostCookie = state.setCalls.find(call => call.name === CURRENT_WEB_SESSION_COOKIE_NAME && call.options?.maxAge === 0);
    expect(clearedHostCookie).toMatchObject({
      value: "",
      options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0, expires: new Date(0) },
    });
    const responseCookie = new NextResponse(null);
    responseCookie.cookies.set(
      CURRENT_WEB_SESSION_COOKIE_NAME,
      clearedHostCookie!.value,
      clearedHostCookie!.options as Parameters<typeof responseCookie.cookies.set>[2],
    );
    const setCookie = responseCookie.headers.get("set-cookie");
    expect(setCookie).toMatch(/(?:^|;\s*)Secure(?:;|$)/i);
    expect(setCookie).toMatch(/(?:^|;\s*)HttpOnly(?:;|$)/i);
    expect(setCookie).toMatch(/Path=\//i);
    expect(setCookie).not.toMatch(/Domain=/i);
    expect((await identityStorage.query<{ revoked: number }>("SELECT revoked FROM titan_security_sessions")).rows).toEqual([{ revoked: 1 }]);
    expect(await verifySession(credential)).toBeNull();
  });

  it("rejects bad passwords before issuance and requires an explicit identity binding", async () => {
    expect((await login(loginRequest("wrong-password"))).status).toBe(401);
    expect((await identityStorage.query("SELECT session_id FROM titan_security_sessions")).rows).toEqual([]);
    await getWebSessionRuntime().then(runtime => runtime.close());
    _resetWebSessionRuntimeForTests();
    process.env.TITAN_WEB_IDENTITY_BINDINGS_JSON = JSON.stringify([{
      ...bindingRows[0], legacy_user_id: "another-explicit-user",
    }]);
    const response = await login(loginRequest());
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("WEB_IDENTITY_SETUP_REQUIRED");
    expect((await identityStorage.query("SELECT session_id FROM titan_security_sessions")).rows).toEqual([]);
  });
});
