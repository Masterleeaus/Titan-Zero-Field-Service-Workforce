import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, type AuthSession } from "@/lib/auth/middleware";
import { withTenantTransaction } from "@/lib/db/portable";
import { applyFieldJobTemplateToWorkOrder } from "@/lib/work-orders/field-job-templates";
import { loadWorkOrderTasks } from "@/lib/work-orders/task-time";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
const schema = z.object({ template_id: z.string().uuid(), replace: z.boolean().optional() });

export const POST = withAuth(async (request: NextRequest, session: AuthSession) => {
  if (session.role !== "owner" && session.role !== "admin") {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "Owner or admin role required" } }, { status: 403 });
  }
  const workOrderId = request.url.match(/\/work-orders\/([^/]+)\/apply-template/)?.[1];
  if (!workOrderId) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Work order not found" } }, { status: 404 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "Invalid template request" } }, { status: 422 });
  try {
    const result = await withTenantTransaction(session, async (client, accountId) => {
      const inserted = await applyFieldJobTemplateToWorkOrder(client, {
        accountId, workOrderId, templateId: parsed.data.template_id, replace: parsed.data.replace ?? false,
      });
      const tasks = await loadWorkOrderTasks(client, workOrderId, accountId);
      return { inserted, tasks };
    });
    return NextResponse.json({ data: result });
  } catch (error) {
    logger.error("POST apply field job template", error, { traceId: session.traceId });
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: error instanceof Error ? error.message : "Could not apply field job template", traceId: session.traceId } }, { status: 422 });
  }
});
