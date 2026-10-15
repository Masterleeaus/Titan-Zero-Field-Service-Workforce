import type { DbClient } from "@/lib/db-contract";
import { getDatabaseDialect } from "@/lib/db";

/** Serialize owner role/removal checks within one account transaction. */
export async function lockOwnerMembershipChanges(
  client: Pick<DbClient, "query" | "dialect">,
  accountId: string,
): Promise<void> {
  const dialect = client.dialect ?? getDatabaseDialect();
  if (dialect === "sqlite") {
    // withSqliteTransaction uses BEGIN IMMEDIATE, which serializes writers
    // before this callback starts; no extra row or advisory lock is needed.
    return;
  }
  if (dialect === "mysql") {
    // InnoDB holds this account row until transaction completion.
    await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [accountId]);
    return;
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `workforce-owner-memberships:${accountId}`,
  ]);
}
