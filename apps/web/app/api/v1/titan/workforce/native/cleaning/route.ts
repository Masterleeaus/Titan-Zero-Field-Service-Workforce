import { NextResponse } from "next/server";
import { withRole } from "@/lib/auth/middleware";
import { buildNativeCleaningWorkforceProjection } from "@/lib/titan/workforce-native/cleaning-projection";

export const dynamic = "force-dynamic";

export const GET = withRole(["owner", "admin"], async (_request, session) =>
  NextResponse.json(buildNativeCleaningWorkforceProjection(session.accountId)),
);
