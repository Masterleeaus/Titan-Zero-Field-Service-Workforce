import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { setSessionCookie } from "@/lib/auth/session";
import {
  getWebSessionRuntime,
  isWebAuthSetupRequiredError,
  WebIdentityBindingRequiredError,
} from "@/lib/auth/web-session-runtime";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const switchSchema = z.object({
  company_id: z.string().trim().min(1).max(255),
}).strict();

function errorResponse(code: string, message: string, status: number, traceId: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: { code, message, traceId, ...(extra ?? {}) } }, { status });
}

export async function POST(request: NextRequest) {
  const traceId = randomUUID();
  if (!process.env.TITAN_WEB_PUBLIC_ORIGIN || request.headers.get("origin") !== process.env.TITAN_WEB_PUBLIC_ORIGIN) {
    return errorResponse("ORIGIN_REJECTED", "Request origin is not allowed.", 403, traceId);
  }

  const body = await request.json().catch(() => null);
  const parsed = switchSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("VALIDATION_ERROR", "Invalid request body.", 400, traceId, {
      details: parsed.error.flatten().fieldErrors,
    });
  }

  try {
    const switched = await (await getWebSessionRuntime()).switchCompanyRequest(request, parsed.data.company_id);
    await setSessionCookie(switched);
    return NextResponse.json({
      company_id: switched.context.company_id,
      role: switched.session.role,
    });
  } catch (error) {
    if (isWebAuthSetupRequiredError(error)) {
      return errorResponse("WEB_AUTH_SETUP_REQUIRED", "Web authentication needs operator configuration.", 503, traceId, {
        missing_configuration: error.missing_or_invalid,
      });
    }
    if (error instanceof WebIdentityBindingRequiredError) {
      return errorResponse("WEB_IDENTITY_SETUP_REQUIRED", "This company is not available for this web identity.", 403, traceId);
    }
    if (error instanceof Error && error.message === "identity-registry-unavailable") {
      return errorResponse("IDENTITY_REGISTRY_UNAVAILABLE", "Identity services are temporarily unavailable.", 503, traceId);
    }
    if (error instanceof Error && ["authentication-denied", "web-session-credential-expired"].includes(error.message)) {
      return errorResponse("UNAUTHORIZED", "A current web session is required.", 401, traceId);
    }
    logger.error("Company switch error", error, { traceId });
    return errorResponse("INTERNAL_ERROR", "An unexpected error occurred.", 500, traceId);
  }
}
