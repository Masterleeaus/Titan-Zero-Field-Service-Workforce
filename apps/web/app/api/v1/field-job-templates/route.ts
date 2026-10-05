import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, type AuthSession } from "@/lib/auth/middleware";
import { withTenantTransaction } from "@/lib/db/portable";
import { createFieldJobTemplate, loadFieldJobTemplates } from "@/lib/work-orders/field-job-templates";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(1000).nullable().optional(),
  category: z.string().max(80).nullable().optional(),
  tasks: z.array(z.object({ label: z.string().min(1).max(300), required: z.boolean().optional() })).min(1).max(100),
});

function manager(session: AuthSession) { return session.role === "owner" || session.role === "admin"; }

export const GET = withAuth(async (_request: NextRequest, session: AuthSession) => {
  try {
    const data = await withTenantTransaction(session, (client, accountId) => loadFieldJobTemplates(client, accountId));
    return NextResponse.json({ data });
  } catch (error) {
    logger.error("GET field job templates", error, { traceId: session.traceId });
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "Could not load field job templates", traceId: session.traceId } }, { status: 500 });
  }
});

export const POST = withAuth(async (request: NextRequest, session: AuthSession) => {
  if (!manager(session)) return NextResponse.json({ error: { code: "FORBIDDEN", message: "Owner or admin role required" } }, { status: 403 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "Invalid template", details: parsed.error.flatten().fieldErrors } }, { status: 422 });
  try {
    const result = await withTenantTransaction(session, async (client, accountId) => {
      const duplicate = await client.query<{ id: string }>(
        `SELECT id FROM field_job_templates WHERE account_id = $1 AND name = $2 AND active = true LIMIT 1`,
        [accountId, parsed.data.name.trim()],
      );
      if (duplicate.rows[0]) return { conflict: true as const };
      const id = await createFieldJobTemplate(client, { accountId, ...parsed.data });
      return { conflict: false as const, id };
    });
    if (result.conflict) return NextResponse.json({ error: { code: "CONFLICT", message: "A field job template with that name already exists" } }, { status: 409 });
    const id = result.id;
    return NextResponse.json({ data: { id } }, { status: 201 });
  } catch (error) {
    logger.error("POST field job templates", error, { traceId: session.traceId });
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "Could not create field job template", traceId: session.traceId } }, { status: 500 });
  }
});
