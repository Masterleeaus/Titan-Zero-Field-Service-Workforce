import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hash } from "bcryptjs";
import { withRole } from "@/lib/auth/middleware";
import type { AuthSession } from "@/lib/auth/middleware";
import { withTenantTransaction } from "@/lib/db/portable";
import { loadCompanyMemberDirectory } from "@/lib/workforce/member-directory";
import { appendAuditLog } from "@/lib/db/audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const createUserBody = z.object({
  full_name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  phone: z.string().max(50).optional().or(z.literal("")),
  role: z.enum(["owner", "admin", "tech"]),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const GET = withRole(["owner", "admin"], async (_request: NextRequest, session: AuthSession) => {
  const rows = await withTenantTransaction(session, async (client, accountId) => {
    return (await loadCompanyMemberDirectory(client, accountId)).map(({ id, full_name, email, phone, role, created_at }) => ({
      id, full_name, email, phone, role, created_at,
    }));
  });
  return NextResponse.json({ data: rows });
});

export const POST = withRole(["owner", "admin"], async (request: NextRequest, session: AuthSession) => {
  const body = await request.json().catch(() => null);
  const parsed = createUserBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid request body", details: parsed.error.flatten().fieldErrors, traceId: session.traceId } },
      { status: 422 }
    );
  }

  // Only owners can create other owners or admins
  if (parsed.data.role !== "tech" && session.role !== "owner") {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Only owners can create admin or owner accounts", traceId: session.traceId } },
      { status: 403 }
    );
  }

  const { full_name, email, phone, role, password } = parsed.data;
  const password_hash = await hash(password, 12);

  try {
    const result = await withTenantTransaction(session, async (client, accountId) => {
      // Check for duplicate email within the verified tenant transaction.
      const existing = await client.query(
        `SELECT id FROM users WHERE account_id = $1 AND email = $2`,
        [accountId, email.toLowerCase().trim()],
      );
      if (existing.rowCount && existing.rowCount > 0) return { conflict: true as const };

      const userId = randomUUID();
      await client.query(
        `INSERT INTO users (id, account_id, full_name, email, phone, role, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, accountId, full_name, email.toLowerCase().trim(), phone || null, role, password_hash],
      );

      // Session resolution requires an explicit active membership. Keep creation
      // atomic so a membership failure cannot leave an unusable principal behind.
      await client.query(
        `INSERT INTO business_memberships (account_id, user_id, role, status)
         VALUES ($1, $2, $3, 'active')`,
        [accountId, userId, role],
      );
      // The users SELECT policy requires an active company membership. Read
      // RETURNING fields only after the membership row exists.
      const newUserResult = await client.query(
        `SELECT id, full_name, email, phone, role, created_at
           FROM users WHERE id = $1 AND account_id = $2`,
        [userId, accountId],
      );
      const newUser = newUserResult.rows[0];
      if (!newUser) throw new Error("CREATED_USER_NOT_VISIBLE_AFTER_MEMBERSHIP");

      await appendAuditLog(client, {
        account_id: accountId,
        entity_type: "user",
        entity_id: newUser.id as string,
        action: "insert",
        actor_id: session.userId,
        trace_id: session.traceId,
        old_value: null,
        new_value: { full_name, email, phone: phone || null, role },
      });
      return { conflict: false as const, user: newUser };
    });
    if (result.conflict) {
      return NextResponse.json(
        { error: { code: "CONFLICT", message: "A user with that email already exists", traceId: session.traceId } },
        { status: 409 },
      );
    }
    return NextResponse.json({ data: result.user }, { status: 201 });
  } catch (error) {
    logger.error("POST /api/v1/users error", error, { traceId: session.traceId });
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Failed to create user", traceId: session.traceId } },
      { status: 500 }
    );
  }
});
