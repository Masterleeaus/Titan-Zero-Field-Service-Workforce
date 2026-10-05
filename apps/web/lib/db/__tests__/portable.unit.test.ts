import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "@/lib/auth/session";
import { countUnreadAttentionEvents } from "@/lib/attention/counts";
import { portableQuery, withPortableTransaction, withTenantTransaction } from "../portable";

const state = vi.hoisted(() => ({ dialect: "mysql", result: [{ id: "row-1" }],
  membershipRows: [{ role: "owner", status: "active" }], fail: false,
  sql: [] as Array<[string, unknown[] | undefined]>, events: [] as string[] }));
vi.mock("../mysql", () => {
  const connection = {
    async execute(sql: string, params: unknown[]) {
      if (this !== connection) throw new Error("lost mysql connection receiver");
      state.sql.push([sql, params]);
      if (state.fail) throw new Error("driver failure");
      return [state.result, []];
    },
    async beginTransaction() { state.events.push("begin"); },
    async commit() { state.events.push("commit"); },
    async rollback() { state.events.push("rollback"); },
    release() { state.events.push("release"); },
  };
  const pool = {
    async execute(sql: string, params: unknown[]) {
      if (this !== pool) throw new Error("lost mysql pool receiver");
      state.sql.push([sql, params]);
      return [state.result, []];
    },
    async getConnection() { state.events.push("connect"); return connection; },
  };
  return { getMysqlPool: () => pool };
});
vi.mock("@/lib/db", () => {
  const client = {
    async query(sql: string, params?: unknown[]) {
      if (this !== client) throw new Error("lost postgres client receiver");
      state.sql.push([sql, params]);
      const rows = sql.includes("FROM business_memberships") ? state.membershipRows : state.result;
      return { rows, rowCount: rows.length };
    },
    release() { state.events.push("release"); },
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (this !== pool) throw new Error("lost postgres pool receiver");
      state.sql.push([sql, params]);
      return { rows: state.result };
    },
    async connect() { state.events.push("connect"); return client; },
  };
  return { getDatabaseDialect: () => state.dialect, getPool: () => pool };
});
vi.mock("../sqlite", () => ({ getSqliteClient: vi.fn(), withSqliteTransaction: vi.fn() }));
beforeEach(() => { state.dialect = "mysql"; state.result = [{ id: "row-1" }];
  state.membershipRows = [{ role: "owner", status: "active" }]; state.fail = false; state.sql = []; state.events = []; });
describe("existing portable driver boundaries", () => {
  it("keeps MySQL pool receiver and repeated/reordered bindings", async () => {
    expect(await portableQuery("SELECT $2, $1, $2", ["row-1", "company-a"])).toEqual(state.result);
    expect(state.sql).toEqual([["SELECT ?, ?, ?", ["company-a", "row-1", "company-a"]]]);
  });
  it("exposes the MySQL dialect and commits/releases with its receiver intact", async () => {
    await withPortableTransaction(async client => {
      expect(client.dialect).toBe("mysql");
      expect(await client.query("SELECT $1", ["company-a"])).toEqual({ rows: state.result, rowCount: 1 });
    });
    expect(state.events).toEqual(["connect", "begin", "commit", "release"]);
  });
  it("binds company and retention days for MySQL attention reads", async () => {
    await withPortableTransaction(client => countUnreadAttentionEvents(client, "company-a"));
    expect(state.sql).toHaveLength(1);
    expect(state.sql[0][0]).toContain("account_id = ?");
    expect(state.sql[0][0]).toContain("INTERVAL ? DAY");
    expect(state.sql[0][1]).toEqual(["company-a", 90]);
  });
  it("rolls back and releases on provider failure", async () => {
    state.fail = true;
    await expect(withPortableTransaction(client => client.query("SELECT $1", ["company-a"]))).rejects.toThrow("driver failure");
    expect(state.events).toEqual(["connect", "begin", "rollback", "release"]);
  });
  it("keeps PostgreSQL receiver and typed result rows", async () => {
    state.dialect = "postgres";
    expect(await portableQuery<{ id: string }>("SELECT $1", ["company-a"])).toEqual(state.result);
    expect(state.sql).toEqual([["SELECT $1", ["company-a"]]]);
  });
  it("requires company context before acquiring a transaction", async () => {
    await expect(withTenantTransaction({ userId: "user", accountId: "", role: "owner" } as SessionPayload, async () => undefined)).rejects.toThrow("company_id context is required");
    expect(state.events).toEqual([]);
  });
  it("preserves PostgreSQL company/user/role scope inside the transaction", async () => {
    state.dialect = "postgres";
    const result = await withTenantTransaction({ userId: "user", accountId: "company-a", role: "owner" } as SessionPayload, async (_client, accountId) => accountId);
    expect(result).toBe("company-a");
    expect(state.sql[0][0]).toBe("BEGIN");
    expect(state.sql[1][0]).toContain("app.current_account_id");
    expect(state.sql[1][1]).toEqual(["user", "company-a", "owner"]);
    expect(state.sql[2][0]).toContain("FROM business_memberships");
    expect(state.sql[2][0]).toContain("WHERE account_id = $1 AND user_id = $2");
    expect(state.sql[2][1]).toEqual(["company-a", "user"]);
    expect(state.sql[3][0]).toBe("COMMIT");
    expect(state.events).toEqual(["connect", "release"]);
  });

  it.each([
    ["demoted", [{ role: "tech", status: "active" }]],
    ["revoked", [{ role: "owner", status: "revoked" }]],
    ["missing", []],
  ])("rejects a %s membership before running tenant route logic", async (_case, membershipRows) => {
    state.dialect = "postgres";
    state.membershipRows = membershipRows;
    let invoked = false;
    await expect(withTenantTransaction(
      { userId: "user", accountId: "company-a", role: "owner" } as SessionPayload,
      async () => { invoked = true; },
    )).rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_CONTEXT_STALE" });
    expect(invoked).toBe(false);
    expect(state.sql[state.sql.length - 1][0]).toBe("ROLLBACK");
  });
});
