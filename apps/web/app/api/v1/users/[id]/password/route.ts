import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hash, compare } from "bcryptjs";
import { withAuth } from "@/lib/auth/middleware";
import type { AuthSession } from "@/lib/auth/middleware";
import { getDatabaseDialect } from "@/lib/db/dialect";
import { withTenantTransaction } from "@/lib/db/portable";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const changePasswordBody = z.object({
  current_password: z.string().optional(),
  new_password: z.string().min(8, "Password must be at least 8 characters"),
});

export const POST = withAuth(async (request: NextRequest, session: AuthSession) => {
  const id = request.nextUrl.pathname.split("/").at(-2) ?? "";
  const isSelf = id === session.userId;

  if (!isSelf && session.role !== "owner") {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Access denied", traceId: session.traceId } },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = changePasswordBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid request body", details: parsed.error.flatten().fieldErrors, traceId: session.traceId } },
      { status: 422 }
    );
  }

  const { current_password, new_password } = parsed.data;

  // Changing own password requires current_password
  if (isSelf && !current_password) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Current password is required", traceId: session.traceId } },
      { status: 422 }
    );
  }

  const user = await withTenantTransaction(session, async (client, accountId) => {
    const dialect = client.dialect ?? getDatabaseDialect();
    const result = dialect === "postgres"
      ? await client.query<{ password_hash: string | null }>(
          `SELECT public.app_user_password_hash($1::uuid) AS password_hash`,
          [id],
        )
      : await client.query<{ id: string; password_hash: string }>(
          `SELECT id, password_hash FROM users
            WHERE id = $1 AND ${dialect === "sqlite" ? "company_id" : "account_id"} = $2`,
          [id, accountId],
        );
    const passwordHash = result.rows[0]?.password_hash;
    return typeof passwordHash === "string" ? { id, password_hash: passwordHash } : null;
  });
  if (!user) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "User not found", traceId: session.traceId } },
      { status: 404 }
    );
  }

  if (isSelf && current_password) {
    const valid = await compare(current_password, user.password_hash);
    if (!valid) {
      return NextResponse.json(
        { error: { code: "INVALID_CREDENTIALS", message: "Current password is incorrect", traceId: session.traceId } },
        { status: 401 }
      );
    }
  }

  const new_hash = await hash(new_password, 12);

  try {
    const changed = await withTenantTransaction(session, async (client, accountId) => {
      const dialect = client.dialect ?? getDatabaseDialect();
      if (dialect === "postgres") {
        const result = await client.query<{ changed: boolean }>(
          `SELECT public.app_update_user_password($1::uuid, $2, $3) AS changed`,
          [id, user.password_hash, new_hash],
        );
        return result.rows[0]?.changed === true;
      }
      const result = await client.query(
        `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND ${dialect === "sqlite" ? "company_id" : "account_id"} = $3`,
        [new_hash, id, accountId],
      );
      return (result.rowCount ?? 0) === 1;
    });
    if (!changed) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "User not found", traceId: session.traceId } },
        { status: 404 },
      );
    }
    return NextResponse.json({ updated: true });
  } catch (error) {
    logger.error("POST /api/v1/users/[id]/password error", error, { traceId: session.traceId });
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Failed to update password", traceId: session.traceId } },
      { status: 500 }
    );
  }
});
