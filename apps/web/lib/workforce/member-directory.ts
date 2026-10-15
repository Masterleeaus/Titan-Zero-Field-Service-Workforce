import { getDatabaseDialect } from "@/lib/db/dialect";
import type { DbClient } from "@/lib/db-contract";

/** Profile projection for people who have an active membership in the selected
 * company. The membership role is the only role returned as authorization
 * context; users.role is a legacy primary-company projection. */
export interface CompanyMemberDirectoryEntry {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: "owner" | "admin" | "tech";
  status: "active";
  created_at: string | Date;
}

/**
 * Read the minimal human roster fields required by settings, dispatch, and
 * visit assignment. PostgreSQL derives scope only from the transaction-local
 * account installed by withTenantTransaction and a matching active membership.
 * No request-supplied account is sent to the directory function.
 */
export async function loadCompanyMemberDirectory(
  client: DbClient,
  accountId: string,
): Promise<CompanyMemberDirectoryEntry[]> {
  const dialect = client.dialect ?? getDatabaseDialect();
  if (dialect === "postgres") {
    const { rows } = await client.query<CompanyMemberDirectoryEntry>(
      `SELECT id, full_name, email, phone, role, status, created_at
         FROM public.app_company_member_directory()`,
    );
    return rows;
  }

  if (dialect === "sqlite") {
    const { rows } = await client.query<CompanyMemberDirectoryEntry>(
      `SELECT u.id, u.full_name, u.email, u.phone, bm.role, bm.status, u.created_at
         FROM business_memberships bm
         JOIN users u ON u.id = bm.user_id
        WHERE bm.account_id = $1 AND bm.status = 'active'
        ORDER BY bm.role, u.full_name, u.email`,
      [accountId],
    );
    return rows;
  }

  const { rows } = await client.query<CompanyMemberDirectoryEntry>(
    `SELECT u.id, u.full_name, u.email, u.phone, bm.role, bm.status, u.created_at
       FROM business_memberships bm
       JOIN users u ON u.id = bm.user_id
      WHERE bm.account_id = $1 AND bm.status = 'active'
      ORDER BY bm.role, u.full_name, u.email`,
    [accountId],
  );
  return rows;
}
