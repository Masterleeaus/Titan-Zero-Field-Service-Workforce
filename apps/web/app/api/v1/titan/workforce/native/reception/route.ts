import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withRole } from "@/lib/auth/middleware";
import {
  buildNativeReceptionPlan,
  executeNativeReceptionAction,
} from "@/lib/titan/workforce-native/reception";

export const dynamic = "force-dynamic";

const actionSchema = z.intersection(z.discriminatedUnion("action", [
  z.object({ action: z.literal("search_customer"), query: z.string().max(255).optional(), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("capture_customer"), payload: z.record(z.unknown()), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("list_service_requests"), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("capture_service_request"), payload: z.record(z.unknown()), dryRun: z.boolean().optional() }),
  z.object({
    action: z.literal("handoff"),
    interactionId: z.string().min(1).max(180),
    target: z.enum(["sales", "booking", "customer_care"]),
    payload: z.record(z.unknown()).optional(),
    correlationId: z.string().max(180).optional(),
    causationId: z.string().max(180).optional(),
    dryRun: z.boolean().optional(),
  }),
]), z.object({ cleaningProfileId: z.string().min(1).max(180).optional() }));

export const GET = withRole(["owner", "admin"], async (_request, session) => {
  const plan = buildNativeReceptionPlan(session, { action: "list_service_requests", dryRun: true });
  return NextResponse.json({
    agent: "reception",
    companyBoundary: session.accountId,
    identityGrantsAuthority: false,
    browserExtensionRequired: false,
    supportedActions: [
      "search_customer",
      "capture_customer",
      "list_service_requests",
      "capture_service_request",
      "handoff",
    ],
    examplePlan: plan,
  });
});

export const POST = withRole(["owner", "admin"], async (request: NextRequest, session) => {
  const body = await request.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid Reception Agent request", details: parsed.error.issues, traceId: session.traceId } },
      { status: 422 },
    );
  }

  try {
    const result = await executeNativeReceptionAction(request, session, parsed.data);
    const status = result.upstream?.status ?? 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reception Agent request failed";
    const forbidden = message === "ROLE_NOT_AUTHORIZED";
    return NextResponse.json(
      { error: { code: forbidden ? "FORBIDDEN" : "RECEPTION_AGENT_ERROR", message, traceId: session.traceId } },
      { status: forbidden ? 403 : 400 },
    );
  }
});
