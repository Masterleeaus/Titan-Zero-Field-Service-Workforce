import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withRole } from "@/lib/auth/middleware";
import {
  buildNativeBookingPlan,
  executeNativeBookingAction,
} from "@/lib/titan/workforce-native/booking";

export const dynamic = "force-dynamic";

const record = z.record(z.unknown());
const actionSchema = z.intersection(z.discriminatedUnion("action", [
  z.object({ action: z.literal("list_requests"), status: z.string().max(64).optional(), query: z.string().max(500).optional(), limit: z.number().int().min(1).max(200).optional(), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("get_request"), requestId: z.string().min(1).max(128), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("list_properties"), clientId: z.string().max(128).optional(), query: z.string().max(500).optional(), limit: z.number().int().min(1).max(200).optional(), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("prepare_booking"), requestId: z.string().min(1).max(128).optional(), source: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("check_availability"), payload: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("prepare_confirmation"), requestId: z.string().min(1).max(128).optional(), payload: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("confirm_request"), requestId: z.string().min(1).max(128), payload: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("reconcile_calendar"), calendarEvent: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("handoff_scheduling"), handoff: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("handoff_jobs"), handoff: record, dryRun: z.boolean().optional() }),
]), z.object({ cleaningProfileId: z.string().min(1).max(180).optional() }));

export const GET = withRole(["owner", "admin"], async (_request, session) => {
  const plan = buildNativeBookingPlan(session, { action: "list_requests", dryRun: true });
  return NextResponse.json({
    agent: "booking",
    companyBoundary: session.accountId,
    identityGrantsAuthority: false,
    browserExtensionRequired: false,
    supportedActions: [
      "list_requests", "get_request", "list_properties", "prepare_booking", "check_availability",
      "prepare_confirmation", "confirm_request", "reconcile_calendar", "handoff_scheduling", "handoff_jobs",
    ],
    examplePlan: plan,
  });
});

export const POST = withRole(["owner", "admin"], async (request: NextRequest, session) => {
  const body = await request.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid Booking Agent request", details: parsed.error.issues, traceId: session.traceId } },
      { status: 422 },
    );
  }

  try {
    const result = await executeNativeBookingAction(request, session, parsed.data);
    const status = result.upstream?.status ?? 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Booking Agent request failed";
    const forbidden = message === "ROLE_NOT_AUTHORIZED";
    return NextResponse.json(
      { error: { code: forbidden ? "FORBIDDEN" : "BOOKING_AGENT_ERROR", message, traceId: session.traceId } },
      { status: forbidden ? 403 : 400 },
    );
  }
});
