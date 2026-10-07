import { NextRequest, NextResponse } from "next/server";
import { withRole } from "@/lib/auth/middleware";
import { loadFieldSidebarMetrics } from "@/lib/field/sidebar-metrics";
import type { FieldWorkspace } from "@/lib/navigation/field-workspaces";

export const dynamic = "force-dynamic";

const WORKSPACES = new Set<FieldWorkspace>(["activity", "locations", "work", "operations"]);

export const GET = withRole(["owner", "admin"], async (request: NextRequest, session) => {
  const requested = request.nextUrl.searchParams.get("workspace") ?? "";
  if (!WORKSPACES.has(requested as FieldWorkspace)) {
    return NextResponse.json({ error: "A valid Field workspace is required" }, { status: 400 });
  }

  const metrics = await loadFieldSidebarMetrics(session, requested as FieldWorkspace);
  return NextResponse.json(
    { data: metrics },
    { headers: { "Cache-Control": "private, no-store" } },
  );
});
