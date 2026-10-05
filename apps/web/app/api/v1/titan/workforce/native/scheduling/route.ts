import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withRole } from "@/lib/auth/middleware";
import {
  buildNativeSchedulingPlan,
  executeNativeSchedulingAction,
} from "@/lib/titan/workforce-native/scheduling";

export const dynamic = "force-dynamic";

const record = z.record(z.unknown());
const candidate = z.record(z.unknown());
const actionSchema = z.intersection(z.discriminatedUnion("action", [
  z.object({ action: z.literal("list_jobs"), clientId: z.string().max(128).optional(), limit: z.number().int().min(1).max(200).optional(), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("list_visits"), jobId: z.string().min(1).max(128), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("list_work_orders"), status: z.string().max(64).optional(), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("list_workers"), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("propose_assignment"), jobId: z.string().max(128).optional(), job: record.optional(), payload: record.optional(), candidates: z.array(candidate).max(200).default([]), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("propose_schedule"), jobId: z.string().min(1).max(128), payload: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("schedule_visits"), jobId: z.string().min(1).max(128), payload: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("reschedule_visit"), visitId: z.string().min(1).max(128), payload: record, dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("handoff_jobs"), jobId: z.string().min(1).max(128), payload: record.optional(), candidates: z.array(candidate).max(200).optional(), dryRun: z.boolean().optional() }),
]), z.object({ cleaningProfileId: z.string().min(1).max(180).optional() }));

export const GET = withRole(["owner", "admin"], async (_request, session) => {
  const plan = buildNativeSchedulingPlan(session, { action: "list_jobs", dryRun: true });
  return NextResponse.json({
    agent: "scheduling",
    companyBoundary: session.accountId,
    identityGrantsAuthority: false,
    browserExtensionRequired: false,
    conflictPolicy: "canonical-visit-conflicts",
    supportedActions: [
      "list_jobs", "list_visits", "list_work_orders", "list_workers", "propose_assignment",
      "propose_schedule", "schedule_visits", "reschedule_visit", "handoff_jobs",
    ],
    examplePlan: plan,
  });
});

export const POST = withRole(["owner", "admin"], async (request: NextRequest, session) => {
  const body = await request.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid Scheduling Agent request", details: parsed.error.issues, traceId: session.traceId } },
      { status: 422 },
    );
  }

  try {
    const result = await executeNativeSchedulingAction(request, session, parsed.data);
    const status = result.upstream?.status ?? 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduling Agent request failed";
    const forbidden = message === "ROLE_NOT_AUTHORIZED";
    return NextResponse.json(
      { error: { code: forbidden ? "FORBIDDEN" : "SCHEDULING_AGENT_ERROR", message, traceId: session.traceId } },
      { status: forbidden ? 403 : 400 },
    );
  }
});
