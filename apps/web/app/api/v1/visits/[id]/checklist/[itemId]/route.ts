/** PATCH /api/v1/visits/[id]/checklist/[itemId] — update visit-local state. */
import { NextRequest, NextResponse } from "next/server";
import { updateChecklistItemSchema } from "@titan-zero/domain";
import { CompanyStorageResolutionError } from "../../../../../../../../../packages/storage/src/company-storage-resolver";
import { companyNativeVisitChecklistManifest } from "../../../../../../../../../packages/storage/src/company-native-schema-manifest";
import { isWebAuthSetupRequiredError } from "../../../../../../../lib/auth/web-session-runtime";
import { withWebNativeCompanyStore } from "../../../../../../../lib/company-storage/request-runtime";
import { logger } from "../../../../../../../lib/logger";
import { updateNativeVisitChecklistItem } from "../../../../../../../lib/visits/native-checklist";
import { getTraceId } from "../../../../../../../lib/tracing";

export const dynamic = "force-dynamic";

function idsFromRequest(request: NextRequest): { visitId: string; itemId: string } | null {
  const match = request.nextUrl.pathname.match(/\/visits\/([^/]+)\/checklist\/([^/]+)\/?$/);
  if (!match) return null;
  try { return { visitId: decodeURIComponent(match[1]), itemId: decodeURIComponent(match[2]) }; }
  catch { return null; }
}

function unavailable(error: unknown): boolean {
  return error instanceof CompanyStorageResolutionError
    || isWebAuthSetupRequiredError(error)
    || (error instanceof Error && (error.message === "identity-registry-unavailable"
      || error.message === "native-company-schema-version-unsupported"
      || error.message === "company-placement-registry-schema-unavailable"
      || error.message.startsWith("native-company-runtime-config-required:")));
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const traceId = getTraceId(request);
  const ids = idsFromRequest(request);
  if (!ids) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Checklist item not found", traceId } }, { status: 404 });

  const body = await request.json().catch(() => null);
  const parsed = updateChecklistItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: {
      code: "VALIDATION_ERROR",
      message: "Invalid request body",
      details: parsed.error.flatten().fieldErrors,
      traceId,
    } }, { status: 422 });
  }

  try {
    const result = await withWebNativeCompanyStore({
      request,
      requiredSchemaVersion: companyNativeVisitChecklistManifest.schema_version,
      operation: (client, session) => updateNativeVisitChecklistItem(client, session, ids.visitId, ids.itemId, parsed.data),
    });
    if (!result.authenticated) {
      return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Authentication required", traceId } }, { status: 401 });
    }
    if (!result.value) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Checklist item not found", traceId } }, { status: 404 });
    }
    return NextResponse.json({ data: result.value });
  } catch (error) {
    if (unavailable(error)) {
      return NextResponse.json({
        error: { code: "NATIVE_COMPANY_STORAGE_UNAVAILABLE", message: "Native company storage is unavailable.", traceId },
      }, { status: 503 });
    }
    logger.error("[native checklist PATCH]", error, { traceId });
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "Failed to update checklist item", traceId } }, { status: 500 });
  }
}
