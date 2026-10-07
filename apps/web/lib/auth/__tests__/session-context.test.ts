/** Password login -> canonical credential -> cookie -> protected route.
 * Auth state uses a file-backed GLOBAL_REGISTRY; business rows are isolated. */
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
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

import { createIdentitySessionRegistry } from "@titan-zero/titan-platform/security-boundary";
import { createSqliteStorage } from "../../../../../packages/storage/src/index";
import { CURRENT_WEB_SESSION_COOKIE_NAME } from "../current-session";
import { _resetWebSessionRuntimeForTests, getWebSessionRuntime } from "../web-session-runtime";
import { getSession, verifySession } from "../session";
import { POST as login } from "@/app/api/v1/auth/login/route";
import { POST as logout } from "@/app/api/v1/auth/logout/route";
import { GET as listClients } from "@/app/api/v1/clients/route";

const userId = "web-user-1";
const actorId = "stable-actor-1";
const companyA = "canonical-company-a";
const companyB = "canonical-company-b";
const accountA = "legacy-account-a";
const accountB = "legacy-account-b";
const deviceId = "web-device-1";
const origin = "https://example.test";
const loginIssuer = `titan:web-login:${origin}`;
const bindingRows = [
  { legacy_user_id: userId, legacy_account_id: accountA, company_id: companyA, actor_id: actorId, device_id: deviceId },
  { legacy_user_id: userId, legacy_account_id: accountB, company_id: companyB, actor_id: actorId, device_id: deviceId },
];

let directory: string;
let identityStorage: ReturnType<typeof createSqliteStorage>;
let identityRegistry: Awaited<ReturnType<typeof createIdentitySessionRegistry>>;
let db: Database.Database;
let oldEnvironment: Record<string, string | undefined>;
const envNames = [
  "TITAN_WEB_PUBLIC_ORIGIN", "TITAN_WEB_IDENTITY_REGISTRY_PATH", "TITAN_WEB_LOGIN_KEY_ID",
  "TITAN_WEB_LOGIN_SIGNING_SECRET", "TITAN_WEB_SESSION_KEY_ID", "TITAN_WEB_SESSION_SIGNING_SECRET",
  "TITAN_WEB_IDENTITY_BINDINGS_JSON", "E2E_DISABLE_LOGIN_RATE_LIMIT",
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
  oldEnvironment = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  directory = await mkdtemp(join(tmpdir(), "titan-auth-runtime-route-"));
  const registryPath = join(directory, "global-registry.sqlite");
  installRuntimeEnvironment(registryPath);

  identityStorage = createSqliteStorage(registryPath);
  identityRegistry = await createIdentitySessionRegistry({ storage: identityStorage, storage_role: "GLOBAL_REGISTRY" });
  await identityRegistry.putActor({ actor_id: actorId, status: "active" }, null);
  for (const [company, role] of [[companyA, "owner"], [companyB, "tech"]]) {
    await identityRegistry.putCompany({ company_id: company, status: "active" }, null);
    await identityRegistry.putMembership({ actor_id: actorId, company_id: company, role, status: "active" }, null);
    await identityRegistry.putExternalBinding({ binding_id: `login-binding-${company}`, provider: loginIssuer,
      subject: userId, actor_id: actorId, company_id: company, status: "active" }, null);
  }
  await identityRegistry.putDevice({ device_id: deviceId, actor_id: actorId, status: "active" }, null);

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
  state.read = (sql, params) => {
    const bound = rewriteSqliteParams(sql, params);
    return db.prepare(bound.sql).all(...bound.params);
  };
});

afterEach(async () => {
  await getWebSessionRuntime().then(runtime => runtime.close()).catch(() => undefined);
  _resetWebSessionRuntimeForTests();
  await identityStorage?.close();
  db?.close();
  await rm(directory, { recursive: true, force: true });
  for (const name of envNames) {
    const previous = oldEnvironment[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

function loginRequest(password = "password-correct") {
  return new NextRequest(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `runtime-${Math.random()}` },
    body: JSON.stringify({ email: "worker@example.test", password }),
  });
}

describe("production web authentication composition", () => {
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
