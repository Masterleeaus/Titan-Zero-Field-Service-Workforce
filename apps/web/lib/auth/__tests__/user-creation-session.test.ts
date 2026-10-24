/** Legacy user CRUD may maintain its own data, but it cannot provision canonical
 * actors, devices, bindings, memberships or session credentials implicitly. */
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rewriteSqliteParams } from "@/lib/db/sqlite-params";

const state = vi.hoisted(() => ({
  token: "",
  query: null as null | ((sql: string, params?: unknown[]) => { rows: unknown[]; rowCount: number }),
  rejectMembership: false,
  rejectRoleUpdate: false,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: () => ({ value: state.token }),
  set: (_name: string, token: string) => { state.token = token; },
  delete: () => { state.token = ""; },
}) }));
vi.mock("@/lib/db/dialect", () => ({ getDatabaseDialect: () => "postgres" }));
vi.mock("@/lib/db", () => ({
  query: async (sql: string, params: unknown[]) => state.query!(sql, params).rows,
  queryOne: async (sql: string, params: unknown[]) => state.query!(sql, params).rows[0] ?? null,
  getPool: () => ({ connect: async () => ({
    query: async (sql: string, params?: unknown[]) => state.query!(sql, params),
    release: () => {},
  }) }),
}));
vi.mock("@/lib/db/portable", () => ({
  portableQueryOne: async (sql: string, params: unknown[]) => state.query!(sql, params).rows[0] ?? null,
  portableQuery: async (sql: string, params: unknown[]) => state.query!(sql, params).rows,
}));
vi.mock("@/lib/db/audit", () => ({ appendAuditLog: async () => {} }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { createIdentitySessionRegistry } from "@titan-zero/titan-platform/security-boundary";
import { createSqliteStorage } from "../../../../../packages/storage/src/index";
import { createSession } from "../session";
import { CURRENT_WEB_SESSION_COOKIE_NAME } from "../current-session";
import { _resetWebSessionRuntimeForTests, getWebSessionRuntime } from "../web-session-runtime";
import { POST as createUser } from "@/app/api/v1/users/route";
import { PATCH as updateUser, GET as readUser } from "@/app/api/v1/users/[id]/route";

const loginIssuer = "titan:web-login:https://example.test";
let db: Database.Database;
let directory: string;
let identityStorage: ReturnType<typeof createSqliteStorage>;
let identityRegistry: Awaited<ReturnType<typeof createIdentitySessionRegistry>>;
let oldEnvironment: Record<string, string | undefined>;
const envNames = [
  "TITAN_WEB_PUBLIC_ORIGIN", "TITAN_WEB_IDENTITY_REGISTRY_PATH", "TITAN_WEB_LOGIN_KEY_ID",
  "TITAN_WEB_LOGIN_SIGNING_SECRET", "TITAN_WEB_SESSION_KEY_ID", "TITAN_WEB_SESSION_SIGNING_SECRET",
  "TITAN_WEB_IDENTITY_BINDINGS_JSON",
];

function request(email = "new@example.test", role = "tech") {
  return new NextRequest("https://example.test/api/v1/users", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, full_name: "New User", role, password: "test-password-only" }),
  });
}

function patchRequest(id: string, role: string) {
  return new NextRequest(`https://example.test/api/v1/users/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }),
  });
}

beforeEach(async () => {
  _resetWebSessionRuntimeForTests();
  state.token = "";
  state.rejectMembership = false;
  state.rejectRoleUpdate = false;
  oldEnvironment = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  directory = await mkdtemp(join(tmpdir(), "titan-user-crud-auth-"));
  const registryPath = join(directory, "global-registry.sqlite");
  process.env.TITAN_WEB_PUBLIC_ORIGIN = "https://example.test";
  process.env.TITAN_WEB_IDENTITY_REGISTRY_PATH = registryPath;
  process.env.TITAN_WEB_LOGIN_KEY_ID = "web-login-test-key";
  process.env.TITAN_WEB_LOGIN_SIGNING_SECRET = randomBytes(32).toString("base64url");
  process.env.TITAN_WEB_SESSION_KEY_ID = "web-session-test-key";
  process.env.TITAN_WEB_SESSION_SIGNING_SECRET = randomBytes(32).toString("base64url");
  process.env.TITAN_WEB_IDENTITY_BINDINGS_JSON = JSON.stringify([{
    legacy_user_id: "owner-1", legacy_account_id: "company-a", company_id: "company-a",
    actor_id: "owner-1", device_id: "web-device-owner-1",
  }]);

  identityStorage = createSqliteStorage(registryPath);
  identityRegistry = await createIdentitySessionRegistry({ storage: identityStorage, storage_role: "GLOBAL_REGISTRY" });
  await identityRegistry.putActor({ actor_id: "owner-1", status: "active" }, null);
  await identityRegistry.putCompany({ company_id: "company-a", status: "active" }, null);
  await identityRegistry.putMembership({ actor_id: "owner-1", company_id: "company-a", role: "owner", status: "active" }, null);
  await identityRegistry.putDevice({ device_id: "web-device-owner-1", actor_id: "owner-1", status: "active" }, null);
  await identityRegistry.putExternalBinding({ binding_id: "owner-web-login", provider: loginIssuer,
    subject: "owner-1", actor_id: "owner-1", company_id: "company-a", status: "active" }, null);

  db = new Database(":memory:");
  db.function("now", () => new Date().toISOString());
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), account_id TEXT NOT NULL,
    email TEXT, full_name TEXT, phone TEXT, role TEXT, password_hash TEXT,
    updated_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE business_memberships (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), user_id TEXT, account_id TEXT, role TEXT,
    status TEXT DEFAULT 'active', UNIQUE(user_id,account_id)
  );
  INSERT INTO users (id,account_id,email,full_name,role) VALUES ('owner-1','company-a','owner@example.test','Owner','owner');
  INSERT INTO business_memberships (user_id,account_id,role,status) VALUES ('owner-1','company-a','owner','active');`);
  state.query = (sql, params = []) => {
    if (sql.includes("set_config(")) return { rows: [], rowCount: 0 };
    if (state.rejectMembership && /INSERT INTO business_memberships/i.test(sql)) throw new Error("simulated membership persistence failure");
    if (state.rejectRoleUpdate && /UPDATE business_memberships/i.test(sql)) throw new Error("simulated membership role update failure");
    const bound = rewriteSqliteParams(sql, params);
    const statement = db.prepare(bound.sql);
    if (statement.reader) { const rows = statement.all(...bound.params); return { rows, rowCount: rows.length }; }
    const result = statement.run(...bound.params);
    return { rows: [], rowCount: result.changes };
  };
  const ownerSession = await createSession({ userId: "owner-1", accountId: "company-a" });
  state.token = ownerSession.credential;
  expect(ownerSession.session.role).toBe("owner");
  expect(ownerSession.session.userId).toBe("owner-1");
  expect(state.token).toBeTruthy();
  expect(CURRENT_WEB_SESSION_COOKIE_NAME).toBe("__Host-titan-web-session");
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

describe("user creation establishes a legacy membership without provisioning canonical identity", () => {
  it("creates the default business membership, but login issuance remains blocked until explicit identity binding", async () => {
    const response = await createUser(request());
    expect(response.status).toBe(201);
    const created = (await response.json()).data;
    expect(db.prepare("SELECT user_id,account_id,role,status FROM business_memberships WHERE user_id=?").get(created.id))
      .toEqual({ user_id: created.id, account_id: "company-a", role: "tech", status: "active" });
    await expect(createSession({ userId: created.id, accountId: "company-a" })).rejects.toMatchObject({
      code: "WEB_IDENTITY_BINDING_REQUIRED",
    });
    expect((await identityStorage.query("SELECT session_id FROM titan_security_sessions")).rows).toHaveLength(1);
    expect((await identityStorage.query("SELECT actor_id FROM titan_security_actors WHERE actor_id=$1", [created.id])).rows).toEqual([]);
  });

  it("rolls back the user if legacy membership creation fails", async () => {
    state.rejectMembership = true;
    const response = await createUser(request());
    expect(response.status).toBe(500);
    expect(db.prepare("SELECT id FROM users WHERE email='new@example.test'").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM business_memberships").get()).toEqual({ count: 1 });
  });

  it("keeps duplicate-user conflict non-mutating", async () => {
    expect((await createUser(request())).status).toBe(201);
    expect((await createUser(request())).status).toBe(409);
    expect(db.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM business_memberships").get()).toEqual({ count: 2 });
  });
});

describe("legacy role and membership edits remain separate from canonical identity", () => {
  it("updates the legacy role, but does not mint a session for the unbound new identity", async () => {
    const created = (await (await createUser(request("admin2@example.test", "admin"))).json()).data;
    expect((await updateUser(patchRequest(created.id, "tech"))).status).toBe(200);
    expect(db.prepare("SELECT role FROM business_memberships WHERE user_id=?").get(created.id)).toEqual({ role: "tech" });
    await expect(createSession({ userId: created.id, accountId: "company-a" })).rejects.toMatchObject({
      code: "WEB_IDENTITY_BINDING_REQUIRED",
    });
    expect((await readUser(new NextRequest("https://example.test/api/v1/users/owner-1"))).status).toBe(200);
  });

  it("rolls back both legacy role records when membership update fails", async () => {
    const created = (await (await createUser(request("admin2@example.test", "admin"))).json()).data;
    state.rejectRoleUpdate = true;
    expect((await updateUser(patchRequest(created.id, "tech"))).status).toBe(500);
    expect(db.prepare("SELECT role FROM users WHERE id=?").get(created.id)).toEqual({ role: "admin" });
    expect(db.prepare("SELECT role FROM business_memberships WHERE user_id=?").get(created.id)).toEqual({ role: "admin" });
  });

  it.each(["revoked", "suspended"])("preserves %s membership state while synchronizing legacy role", async status => {
    const created = (await (await createUser(request("admin2@example.test", "admin"))).json()).data;
    db.prepare("UPDATE business_memberships SET status=? WHERE user_id=?").run(status, created.id);
    expect((await updateUser(patchRequest(created.id, "tech"))).status).toBe(200);
    expect(db.prepare("SELECT role,status FROM business_memberships WHERE user_id=?").get(created.id)).toEqual({ role: "tech", status });
    await expect(createSession({ userId: created.id, accountId: "company-a" })).rejects.toMatchObject({
      code: "WEB_IDENTITY_BINDING_REQUIRED",
    });
  });

  it("leaves other company memberships unchanged", async () => {
    const created = (await (await createUser(request("admin2@example.test", "admin"))).json()).data;
    db.prepare("INSERT INTO business_memberships (user_id,account_id,role,status) VALUES (?, 'company-b','owner','active')").run(created.id);
    expect((await updateUser(patchRequest(created.id, "tech"))).status).toBe(200);
    expect(db.prepare("SELECT role,status FROM business_memberships WHERE user_id=? AND account_id='company-b'").get(created.id)).toEqual({ role: "owner", status: "active" });
  });

  it("cannot update a user belonging to another default company", async () => {
    db.exec("INSERT INTO users (id,account_id,role) VALUES ('user-b','company-b','admin'); INSERT INTO business_memberships (user_id,account_id,role,status) VALUES ('user-b','company-b','admin','active');");
    expect((await updateUser(patchRequest("user-b", "tech"))).status).toBe(404);
    expect(db.prepare("SELECT role FROM business_memberships WHERE user_id='user-b'").get()).toEqual({ role: "admin" });
  });

  it("does not recreate a missing legacy membership or mint identity while editing an unbound user", async () => {
    db.exec("INSERT INTO users (id,account_id,role) VALUES ('legacy','company-a','admin');");
    expect((await updateUser(patchRequest("legacy", "tech"))).status).toBe(200);
    expect(db.prepare("SELECT * FROM business_memberships WHERE user_id='legacy'").all()).toEqual([]);
    await expect(createSession({ userId: "legacy", accountId: "company-a" })).rejects.toMatchObject({
      code: "WEB_IDENTITY_BINDING_REQUIRED",
    });
  });
});
