import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth/session";
import { randomUUID } from "crypto";
import { logger } from "@/lib/logger";
import { isWebAuthSetupRequiredError } from "@/lib/auth/web-session-runtime";

export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest) {
  const traceId = randomUUID();

  try {
    await clearSessionCookie();

    return NextResponse.json({ message: "ok" });
  } catch (error) {
    if (isWebAuthSetupRequiredError(error)) {
      return NextResponse.json({ error: {
        code: "WEB_AUTH_SETUP_REQUIRED",
        message: "Web authentication needs operator configuration.",
        missing_configuration: error.missing_or_invalid,
        traceId,
      } }, { status: 503 });
    }
    if (error instanceof Error && error.message === "identity-registry-unavailable") {
      return NextResponse.json({ error: {
        code: "IDENTITY_REGISTRY_UNAVAILABLE",
        message: "Identity services are temporarily unavailable.",
        traceId,
      } }, { status: 503 });
    }
    logger.error("Logout error", error, { traceId });
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
          traceId,
        },
      },
      { status: 500 }
    );
  }
}
