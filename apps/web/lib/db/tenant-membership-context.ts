import type { SessionPayload } from "@/lib/auth/session";

type MembershipQueryClient = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

/** A stale or revoked company membership must never reach tenant-scoped route logic. */
export class TenantMembershipContextError extends Error {
  readonly code = "TENANT_MEMBERSHIP_CONTEXT_STALE";

  constructor() {
    super("tenant-membership-context-stale");
    this.name = "TenantMembershipContextError";
  }
}

/** Cross-check the authenticated role against the selected compatibility-company membership. */
export async function assertTenantMembershipContext(
  client: MembershipQueryClient,
  session: SessionPayload,
  accountId: string,
): Promise<void> {
  const membership = await client.query<{ role: string; status: string }>(
    `SELECT role, status FROM business_memberships
      WHERE account_id = $1 AND user_id = $2`,
    [accountId, session.userId],
  );
  const current = membership.rows[0];
  if (membership.rows.length !== 1 || current?.status !== "active" || current.role !== session.role) {
    throw new TenantMembershipContextError();
  }
}
