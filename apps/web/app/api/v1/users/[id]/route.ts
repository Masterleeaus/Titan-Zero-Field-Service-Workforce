import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/middleware";
import type { AuthSession } from "@/lib/auth/middleware";
import { withTenantTransaction } from "@/lib/db/portable";
import { getDatabaseDialect } from "@/lib/db/dialect";
import { appendAuditLog } from "@/lib/db/audit";
import { lockOwnerMembershipChanges } from "@/lib/db/owner-membership-lock";
import { loadCompanyMemberDirectory } from "@/lib/workforce/member-directory";
import { logger } from "@/lib/logger";
import { getPathId } from "@/lib/route-utils";
import { getWebSessionRuntime, WebMembershipReconciliationError } from "@/lib/auth/web-session-runtime";

export const dynamic = "force-dynamic";

const patchUserBody = z
  .object({
    full_name: z.string().min(1).max(255).optional(),
    email: z.string().email().max(255).optional(),
    phone: z.string().max(50).optional().or(z.literal("")),
    role: z.enum(["owner", "admin", "tech"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

async function membershipRuntime() {
  try {
    return await getWebSessionRuntime();
  } catch {
    throw new WebMembershipReconciliationError();
  }
}

// Any authenticated user can view/edit — permissions enforced inside handler.
export const GET = withAuth(async (request: NextRequest, session: AuthSession) => {
  const id = getPathId(request.nextUrl.pathname);
  const isSelf = id === session.userId;
  if (!isSelf && session.role !== "owner" && session.role !== "admin") {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Access denied", traceId: session.traceId } },
      { status: 403 }
    );
  }
  const row = await withTenantTransaction(session, async (client, accountId) =>
    (await loadCompanyMemberDirectory(client, accountId)).find((member) => member.id === id) ?? null,
  );
  if (!row) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "User not found", traceId: session.traceId } },
      { status: 404 }
    );
  }
  return NextResponse.json({ data: {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    created_at: row.created_at,
  } });
});

export const PATCH = withAuth(async (request: NextRequest, session: AuthSession) => {
  const id = getPathId(request.nextUrl.pathname);
  const isSelf = id === session.userId;

  if (!isSelf && session.role !== "owner" && session.role !== "admin") {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Access denied", traceId: session.traceId } },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = patchUserBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid request body", details: parsed.error.flatten().fieldErrors, traceId: session.traceId } },
      { status: 422 }
    );
  }

  const { full_name, email, phone, role } = parsed.data;

  // Role changes: owner only, and can't orphan the last owner.
  if (role !== undefined) {
    if (session.role !== "owner") {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Only owners can change roles", traceId: session.traceId } },
        { status: 403 }
      );
    }
  }

  // Non-admin techs can only edit their own name/phone (not email, not role)
  if (isSelf && session.role === "tech") {
    if (email !== undefined || role !== undefined) {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Techs can only update their name and phone", traceId: session.traceId } },
        { status: 403 }
      );
    }
  }

  let roleToFinishAfterCommit: string | null = null;
  try {
    const response = await withTenantTransaction(session, async (client, accountId) => {
      if (role !== undefined) {
        await lockOwnerMembershipChanges(client, accountId);
        const actorMembership = await client.query<{ role: string }>(
          `SELECT role FROM business_memberships
            WHERE account_id = $1 AND user_id = $2 AND status = 'active'`,
          [accountId, session.userId],
        );
        if (actorMembership.rows[0]?.role !== "owner") {
          return NextResponse.json(
            { error: { code: "FORBIDDEN", message: "Only current company owners can change roles", traceId: session.traceId } },
            { status: 403 },
          );
        }
      }

      const profileFieldsRequested = full_name !== undefined || email !== undefined || phone !== undefined;
      const before = (await loadCompanyMemberDirectory(client, accountId)).find((member) => member.id === id);
      if (!before) {
        // Owners may change the dormant membership role without reactivating
        // a revoked or suspended member. The selected company status remains
        // untouched, so this cannot restore login/session or dispatch access.
        if (role !== undefined && !profileFieldsRequested) {
          const dormant = await client.query<{ id: string; role: string; status: string }>(
            `SELECT id, role, status FROM business_memberships
              WHERE account_id = $1 AND user_id = $2 AND status IN ('revoked', 'suspended')`,
            [accountId, id],
          );
          if (dormant.rows[0]) {
            const dormantStatus = dormant.rows[0].status as "revoked" | "suspended";
            const runtime = await membershipRuntime();
            const needsRoleFinish = await runtime.restrictMembershipForLegacyChangeRequest(
              request, id, dormant.rows[0].role, dormantStatus, role, dormantStatus,
            );
            const updated = await client.query<{ id: string; role: string; status: string }>(
              `UPDATE business_memberships SET role = $1, updated_at = now()
                WHERE account_id = $2 AND user_id = $3 AND status = $4
                RETURNING id, role, status`,
              [role, accountId, id, dormant.rows[0].status],
            );
            if (updated.rows[0]) {
              if (needsRoleFinish) roleToFinishAfterCommit = role;
              await appendAuditLog(client, {
                account_id: accountId,
                entity_type: "business_membership",
                entity_id: updated.rows[0].id,
                action: "update",
                actor_id: session.userId,
                trace_id: session.traceId,
                old_value: dormant.rows[0] as unknown as Record<string, unknown>,
                new_value: updated.rows[0] as unknown as Record<string, unknown>,
              });
              return NextResponse.json({ data: { id, role: updated.rows[0].role, status: updated.rows[0].status } });
            }
          } else {
            const dialect = client.dialect ?? getDatabaseDialect();
            let updated = false;
            if (dialect === "postgres") {
              const result = await client.query<{ updated: boolean }>(
                `SELECT public.app_update_legacy_user_role($1::uuid, $2) AS updated`,
                [id, role],
              );
              updated = result.rows[0]?.updated === true;
            } else {
              const legacyUser = await client.query<{ id: string }>(
                `SELECT id FROM users WHERE id = $1 AND account_id = $2`, [id, accountId],
              );
              const existingMembership = await client.query(
                `SELECT id FROM business_memberships WHERE account_id = $1 AND user_id = $2`,
                [accountId, id],
              );
              if (legacyUser.rows[0] && !existingMembership.rows[0]) {
                const result = await client.query(
                  `UPDATE users SET role = $1, updated_at = now() WHERE id = $2 AND account_id = $3`,
                  [role, id, accountId],
                );
                updated = (result.rowCount ?? 0) === 1;
              }
            }
            if (updated) return NextResponse.json({ data: { id, role } });
          }
        }
        return NextResponse.json({ error: { code: "NOT_FOUND", message: "User not found", traceId: session.traceId } }, { status: 404 });
      }

      const previousRole = before.role;
      if (role !== undefined && previousRole === "owner" && role !== "owner") {
        const { rows: ownerRows } = await client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM business_memberships
            WHERE account_id = $1 AND status = 'active' AND role = 'owner'`,
          [accountId],
        );
        if ((ownerRows[0]?.cnt ?? 0) <= 1) {
          return NextResponse.json(
            { error: { code: "FORBIDDEN", message: "Cannot remove the last owner", traceId: session.traceId } },
            { status: 422 },
          );
        }
      }

      const primaryProfile = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE id = $1 AND account_id = $2`,
        [id, accountId],
      );
      if (profileFieldsRequested && !primaryProfile.rows[0]) {
        return NextResponse.json({ error: {
          code: "PRIMARY_COMPANY_PROFILE_REQUIRED",
          message: "Profile fields can only be changed through the user's primary company",
          traceId: session.traceId,
        } }, { status: 403 });
      }

      if (role !== undefined) {
        const runtime = await membershipRuntime();
        const needsRoleFinish = await runtime.restrictMembershipForLegacyChangeRequest(
          request, id, previousRole, before.status, role, "active",
        );
        if (needsRoleFinish) roleToFinishAfterCommit = role;
      }

      if (profileFieldsRequested || (role !== undefined && primaryProfile.rows[0])) {
        const dialect = client.dialect ?? getDatabaseDialect();
        const profile = {
          full_name: full_name ?? before.full_name,
          email: email === undefined ? before.email : email.toLowerCase().trim(),
          phone: phone === undefined ? before.phone : phone || null,
          role: role ?? (await client.query<{ role: string }>(
            `SELECT role FROM users WHERE id = $1 AND account_id = $2`, [id, accountId],
          )).rows[0]?.role ?? before.role,
        };
        if (dialect === "postgres") {
          const updated = await client.query<{ updated: boolean }>(
            `SELECT public.app_update_company_member_profile($1::uuid, $2, $3, $4, $5) AS updated`,
            [id, profile.full_name, profile.email, profile.phone, profile.role],
          );
          if (updated.rows[0]?.updated !== true) {
            return NextResponse.json({ error: {
              code: "FORBIDDEN",
              message: "Company member profile update is not authorized",
              traceId: session.traceId,
            } }, { status: 403 });
          }
        } else {
          const setClauses: string[] = ["updated_at = now()"];
          const params: unknown[] = [];
          let idx = 1;
          if (full_name !== undefined) { setClauses.push(`full_name = $${idx++}`); params.push(full_name); }
          if (email !== undefined) { setClauses.push(`email = $${idx++}`); params.push(email.toLowerCase().trim()); }
          if (phone !== undefined) { setClauses.push(`phone = $${idx++}`); params.push(phone || null); }
          if (role !== undefined) { setClauses.push(`role = $${idx++}`); params.push(role); }
          params.push(id, accountId);
          await client.query(
            `UPDATE users SET ${setClauses.join(", ")} WHERE id = $${idx} AND account_id = $${idx + 1}`,
            params,
          );
        }
      }

      if (role !== undefined) {
        // Roles belong to the selected company membership, not the global principal.
        const membershipUpdate = await client.query(
          `UPDATE business_memberships SET role = $1, updated_at = now()
            WHERE user_id = $2 AND account_id = $3 AND status = 'active'`,
          [role, id, accountId],
        );
        if (membershipUpdate.rowCount !== 1) throw new Error("Active membership disappeared during role update");
      }

      const updated = {
        id: before.id,
        full_name: full_name ?? before.full_name,
        email: email === undefined ? before.email : email.toLowerCase().trim(),
        phone: phone === undefined ? before.phone : phone || null,
        role: role ?? before.role,
      };

      await appendAuditLog(client, {
        account_id: accountId,
        entity_type: "user",
        entity_id: id,
        action: "update",
        actor_id: session.userId,
        trace_id: session.traceId,
        old_value: before as unknown as Record<string, unknown>,
        new_value: updated,
      });
      return NextResponse.json({ data: updated });
    });
    if (roleToFinishAfterCommit !== null) {
      const runtime = await membershipRuntime();
      await runtime.finishMembershipRoleChangeRequest(request, id, roleToFinishAfterCommit);
    }
    return response;
  } catch (error) {
    if (error instanceof WebMembershipReconciliationError) {
      return NextResponse.json({ error: {
        code: "AUTHORITY_RECONCILIATION_UNAVAILABLE",
        message: "Membership authority update is temporarily unavailable; retry the requested change",
        traceId: session.traceId,
      } }, { status: 503, headers: { "Retry-After": "1" } });
    }
    logger.error("PATCH /api/v1/users/[id] error", error, { traceId: session.traceId });
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Failed to update user", traceId: session.traceId } },
      { status: 500 }
    );
  }
});

export const DELETE = withAuth(async (request: NextRequest, session: AuthSession) => {
  const id = getPathId(request.nextUrl.pathname);

  if (session.role !== "owner") {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Only owners can remove team members", traceId: session.traceId } },
      { status: 403 }
    );
  }
  if (id === session.userId) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "You cannot remove your own account", traceId: session.traceId } },
      { status: 422 }
    );
  }

  try {
    return await withTenantTransaction(session, async (client, accountId) => {
      await lockOwnerMembershipChanges(client, accountId);
      const actorMembership = await client.query<{ role: string }>(
        `SELECT role FROM business_memberships
          WHERE account_id = $1 AND user_id = $2 AND status = 'active'`,
        [accountId, session.userId],
      );
      if (actorMembership.rows[0]?.role !== "owner") {
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: "Only current company owners can remove team members", traceId: session.traceId } },
          { status: 403 },
        );
      }

      const before = await client.query(
        `SELECT user_id AS id, role, status, id AS membership_id
           FROM business_memberships
          WHERE user_id = $1 AND account_id = $2 AND status <> 'revoked'`,
        [id, accountId],
      );
      if (!before.rowCount) {
        return NextResponse.json({ error: { code: "NOT_FOUND", message: "User not found", traceId: session.traceId } }, { status: 404 });
      }

      const target = before.rows[0] as { role: string; status: string; membership_id: string };
      if (target.role === "owner" && target.status === "active") {
        const { rows } = await client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM business_memberships
            WHERE account_id = $1 AND status = 'active' AND role = 'owner'`,
          [accountId],
        );
        if ((rows[0]?.cnt ?? 0) <= 1) {
          return NextResponse.json(
            { error: { code: "FORBIDDEN", message: "Cannot remove the last owner", traceId: session.traceId } },
            { status: 422 },
          );
        }
      }

      const runtime = await membershipRuntime();
      await runtime.restrictMembershipForLegacyChangeRequest(
        request, id, target.role, target.status, target.role, "revoked",
      );

      // Keep account_id-scoped legacy consumers from seeing a removed owner.
      // This is constrained to the user's primary account; other memberships
      // and their role authority are untouched.
      if (target.status === "active") {
        const primaryProfile = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE id = $1 AND account_id = $2`, [id, accountId],
        );
        if (primaryProfile.rowCount === 1) {
          const profile = (await loadCompanyMemberDirectory(client, accountId)).find((member) => member.id === id);
          if (profile) {
            const dialect = client.dialect ?? getDatabaseDialect();
            if (dialect === "postgres") {
              const updated = await client.query<{ updated: boolean }>(
                `SELECT public.app_update_company_member_profile($1::uuid, $2, $3, $4, 'tech') AS updated`,
                [id, profile.full_name, profile.email, profile.phone],
              );
              if (updated.rows[0]?.updated !== true) throw new Error("Could not update primary-company role projection");
            } else {
              await client.query(
                `UPDATE users SET role = 'tech', updated_at = now() WHERE id = $1 AND account_id = $2`,
                [id, accountId],
              );
            }
          }
        }
      }
      await client.query(
        `UPDATE business_memberships SET status = 'revoked', updated_at = now()
          WHERE account_id = $1 AND user_id = $2 AND status <> 'revoked'`,
        [accountId, id],
      );

      await appendAuditLog(client, {
        account_id: accountId,
        entity_type: "business_membership",
        entity_id: target.membership_id,
        action: "delete",
        actor_id: session.userId,
        trace_id: session.traceId,
        old_value: before.rows[0] as Record<string, unknown>,
        new_value: null,
      });
      return NextResponse.json({ deleted: true, membership_revoked: true });
    });
  } catch (error: unknown) {
    if (error instanceof WebMembershipReconciliationError) {
      return NextResponse.json({ error: {
        code: "AUTHORITY_RECONCILIATION_UNAVAILABLE",
        message: "Membership authority update is temporarily unavailable; retry the requested change",
        traceId: session.traceId,
      } }, { status: 503, headers: { "Retry-After": "1" } });
    }
    logger.error("DELETE /api/v1/users/[id] error", error, { traceId: session.traceId });
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Failed to remove user", traceId: session.traceId } },
      { status: 500 }
    );
  }
});
