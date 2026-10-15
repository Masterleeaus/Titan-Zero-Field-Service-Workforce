import type { PoolClient } from "pg";
import type { ExecuteValues, PoolConnection } from "mysql2/promise";
import { getDatabaseDialect, getPool } from "@/lib/db";
import { getMysqlPool } from "./mysql";
import { getSqliteClient, withSqliteTransaction } from "./sqlite";
import { rewriteNumberedParamsForMysql, type DbClient, type DbQueryResult } from "@/lib/db-contract";
import type { SessionPayload } from "@/lib/auth/session";
import { requireTenantAccountId } from "./contracts";
import { assertTenantMembershipContext } from "./tenant-membership-context";

// Keep the portable unknown[] contract at this driver boundary. mysql2 validates
// parameter values at execution; do not detach execute/query from their receivers.
function mysqlClient(connection: PoolConnection): DbClient {
  return {
    dialect: "mysql",
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<DbQueryResult<T>> {
      const rewritten = rewriteNumberedParamsForMysql(text, params);
      const [result] = await connection.execute(rewritten.sql, rewritten.params as ExecuteValues[]);
      if (Array.isArray(result)) return { rows: result as T[], rowCount: result.length };
      const packet = result as { affectedRows?: number; insertId?: number };
      return { rows: [], rowCount: packet.affectedRows ?? 0 };
    },
  };
}

export async function portableQuery<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const dialect = getDatabaseDialect();
  if (dialect === "sqlite") return (await getSqliteClient().query<T>(text, params)).rows;
  if (dialect === "mysql") {
    const rewritten = rewriteNumberedParamsForMysql(text, params);
    const [rows] = await getMysqlPool().execute(rewritten.sql, rewritten.params as ExecuteValues[]);
    return rows as T[];
  }
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

export async function portableQueryOne<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await portableQuery<T>(text, params);
  return rows[0] ?? null;
}

export async function withPortableTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const dialect = getDatabaseDialect();
  if (dialect === "sqlite") return withSqliteTransaction(fn);
  if (dialect === "mysql") {
    const connection = await getMysqlPool().getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn(mysqlClient(connection));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function withTenantTransaction<T>(session: SessionPayload, fn: (client: DbClient, accountId: string) => Promise<T>): Promise<T> {
  const accountId = requireTenantAccountId(session);
  return withPortableTransaction(async (client) => {
    if (getDatabaseDialect() === "postgres") {
      await client.query(
        `SELECT set_config('app.current_user_id', $1, true), set_config('app.current_account_id', $2, true), set_config('app.current_role', $3, true)`,
        [session.userId, accountId, session.role],
      );

      // After request authentication, check the selected compatibility-company
      // membership inside the same RLS transaction.
      // This is a request-time backstop while the canonical registry owner
      // reconciles role/status changes. Keep it a plain SELECT: migration 190's
      // UPDATE policies intentionally prevent non-manager sessions from
      // acquiring row locks on membership records.
      await assertTenantMembershipContext(client, session, accountId);
    }
    return fn(client, accountId);
  });
}
