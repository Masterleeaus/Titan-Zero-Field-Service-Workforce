import { describe, expect, it, vi } from "vitest";

const { getDatabaseDialect } = vi.hoisted(() => ({
  getDatabaseDialect: vi.fn(() => "postgres" as const),
}));
vi.mock("@/lib/db", () => ({ getDatabaseDialect }));

import { lockOwnerMembershipChanges } from "../owner-membership-lock";

describe("company owner membership lock", () => {
  it("uses a transaction-scoped advisory lock for PostgreSQL clients", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    await lockOwnerMembershipChanges({ query }, "account-a");
    expect(query).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["workforce-owner-memberships:account-a"],
    );
  });

  it("uses the account row lock for MySQL clients", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "account-a" }], rowCount: 1 }));
    await lockOwnerMembershipChanges({ dialect: "mysql", query }, "account-a");
    expect(query).toHaveBeenCalledWith("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", ["account-a"]);
  });

  it("relies on BEGIN IMMEDIATE for SQLite transactions", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await lockOwnerMembershipChanges({ dialect: "sqlite", query }, "account-a");
    expect(query).not.toHaveBeenCalled();
  });
});
