/** GET /api/v1/visits/[id]/checklist — read the registered company's checklist. */
import { NextRequest, NextResponse } from "next/server";
import { CompanyStorageResolutionError } from "../../../../../../../../packages/storage/src/company-storage-resolver";
import { companyNativeVisitChecklistManifest } from "../../../../../../../../packages/storage/src/company-native-schema-manifest";
import { isWebAuthSetupRequiredError } from "../../../../../../lib/auth/web-session-runtime";
import { logger } from "../../../../../../lib/logger";
import { withWebNativeCompanyStore } from "../../../../../../lib/company-storage/request-runtime";
import { listNativeVisitChecklist } from "../../../../../../lib/visits/native-checklist";
import { getTraceId } from "../../../../../../lib/tracing";

export const dynamic = "force-dynamic";

function visitIdFromRequest(request: NextRequest): string | null {
  const match = request.nextUrl.pathname.match(/\/visits\/([^/]+)\/checklist\/?$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function unavailable(error: unknown): boolean {
  return error instanceof CompanyStorageResolutionError
    || isWebAuthSetupRequiredError(error)
    || (error instanceof Error && (error.message === "identity-registry-unavailable"
      || error.message === "native-company-schema-version-unsupported"
      || error.message === "company-placement-registry-schema-unavailable"
      || error.message.startsWith("native-company-runtime-config-required:")));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const traceId = getTraceId(request);
  const visitId = visitIdFromRequest(request);
  if (!visitId) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Visit not found", traceId } }, { status: 404 });
  try {
    const result = await withWebNativeCompanyStore({
      request,
      requiredSchemaVersion: companyNativeVisitChecklistManifest.schema_version,
      operation: (client, session) => listNativeVisitChecklist(client, session, visitId),
    });
    if (!result.authenticated) {
      return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Authentication required", traceId } }, { status: 401 });
    }
    if (result.value === null) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Visit not found", traceId } }, { status: 404 });
    }
    return NextResponse.json({ data: result.value.items, visit: result.value.visit });
  } catch (error) {
    if (unavailable(error)) {
      return NextResponse.json({
        error: { code: "NATIVE_COMPANY_STORAGE_UNAVAILABLE", message: "Native company storage is unavailable.", traceId },
      }, { status: 503 });
    }
    logger.error("[native checklist GET]", error, { traceId });
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "Failed to load checklist", traceId } }, { status: 500 });
  }
}
