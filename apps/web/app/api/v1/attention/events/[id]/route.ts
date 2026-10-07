import { NextResponse } from "next/server";
import { withRole } from "@/lib/auth/middleware";
import { withInvoiceContext } from "@/lib/invoices/db";
import { deleteAttentionEvent } from "@/lib/attention";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const DELETE = withRole(["owner", "admin"], async (request, session) => {
  const parts = request.nextUrl.pathname.split("/").filter(Boolean);
  const eventId = parts[parts.length - 1] ?? "";
  if (!eventId) {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "Event ID is required", traceId: session.traceId } },
      { status: 400 },
    );
  }

  try {
    const deleted = await withInvoiceContext(session, (client) =>
      deleteAttentionEvent(client, session.accountId, eventId),
    );
    if (!deleted) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Event not found", traceId: session.traceId } },
        { status: 404 },
      );
    }
    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    logger.error("DELETE /api/v1/attention/events/[id]", error, { traceId: session.traceId });
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Failed to delete event", traceId: session.traceId } },
      { status: 500 },
    );
  }
});
