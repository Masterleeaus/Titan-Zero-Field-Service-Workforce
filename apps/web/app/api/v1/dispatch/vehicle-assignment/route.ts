import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withRole } from "@/lib/auth/middleware";
import { withTenantTransaction } from "@/lib/db/portable";
import { logger } from "@/lib/logger";
import { assignTechnicianVehicle, loadCurrentVehicleAssignments } from "@/lib/workforce/vehicle-assignment";

export const dynamic = "force-dynamic";
const schema = z.object({ user_id: z.string().uuid(), vehicle_id: z.string().uuid().nullable(), note: z.string().max(500).nullish() });

export const GET = withRole(["owner", "admin"], async (_req: NextRequest, session) => {
  try {
    const data = await withTenantTransaction(session, (client, accountId) => loadCurrentVehicleAssignments(client, accountId));
    return NextResponse.json({ data });
  } catch (error) {
    logger.error("GET /api/v1/dispatch/vehicle-assignment", error as Error, { traceId: session.traceId });
    return NextResponse.json({ error: { message: "Failed to load vehicle assignments" } }, { status: 500 });
  }
});

export const POST = withRole(["owner", "admin"], async (req: NextRequest, session) => {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: { message: "Invalid input", details: parsed.error.issues } }, { status: 400 });
  try {
    const data = await withTenantTransaction(session, (client, accountId) => assignTechnicianVehicle(client, {
      accountId, userId: parsed.data.user_id, vehicleId: parsed.data.vehicle_id,
      assignedBy: session.userId, note: parsed.data.note,
    }));
    return NextResponse.json({ data });
  } catch (error) {
    const message = (error as Error).message;
    if (message === "MEMBER_NOT_FOUND") return NextResponse.json({ error: { message: "Active workforce member not found" } }, { status: 404 });
    if (message === "VEHICLE_NOT_FOUND") return NextResponse.json({ error: { message: "Active vehicle not found" } }, { status: 404 });
    if (message === "TRAILER_NOT_PRIMARY_VEHICLE") return NextResponse.json({ error: { message: "A trailer cannot be assigned as a technician's primary field vehicle" } }, { status: 400 });
    logger.error("POST /api/v1/dispatch/vehicle-assignment", error as Error, { traceId: session.traceId });
    return NextResponse.json({ error: { message: "Failed to update vehicle assignment" } }, { status: 500 });
  }
});
