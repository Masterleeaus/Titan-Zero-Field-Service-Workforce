import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withRole } from "@/lib/auth/middleware";
import {
  buildNativeSalesPlan,
  executeNativeSalesAction,
} from "@/lib/titan/workforce-native/sales";

export const dynamic = "force-dynamic";

const record = z.record(z.unknown());
const actionSchema = z.intersection(z.discriminatedUnion("action", [
  z.object({ action: z.literal("list_leads"), status: z.string().max(64).optional(), limit: z.number().int().min(1).max(200).optional(), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("qualify_lead"), qualification: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("next_best_action"), qualification: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("progress_lead"), requestId: z.string().min(1).max(128), payload: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("prepare_quote_handoff"), handoff: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("create_quote"), payload: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("plan_follow_up"), payload: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("handle_objection"), payload: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("escalate"), requestId: z.string().min(1).max(128), payload: record, dryRun: z.boolean().optional() }),
]), z.object({ cleaningProfileId: z.string().min(1).max(180).optional() }));

export const GET = withRole(["owner", "admin"], async (_request, session) => {
  const plan = buildNativeSalesPlan(session, { action: "list_leads", dryRun: true });
  return NextResponse.json({
    agent: "sales",
    companyBoundary: session.accountId,
    identityGrantsAuthority: false,
    browserExtensionRequired: false,
    supportedActions: [
      "list_leads", "qualify_lead", "next_best_action", "progress_lead",
      "prepare_quote_handoff", "create_quote", "plan_follow_up", "handle_objection", "escalate",
    ],
    examplePlan: plan,
  });
});

export const POST = withRole(["owner", "admin"], async (request: NextRequest, session) => {
  const body = await request.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid Sales Agent request", details: parsed.error.issues, traceId: session.traceId } },
      { status: 422 },
    );
  }

  try {
    const result = await executeNativeSalesAction(request, session, parsed.data);
    const status = result.upstream?.status ?? 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sales Agent request failed";
    const forbidden = message === "ROLE_NOT_AUTHORIZED";
    return NextResponse.json(
      { error: { code: forbidden ? "FORBIDDEN" : "SALES_AGENT_ERROR", message, traceId: session.traceId } },
      { status: forbidden ? 403 : 400 },
    );
  }
});
