import type { CurrentWebSession } from "../auth/current-session";
import { getWebSessionRuntime } from "../auth/web-session-runtime";
import {
  companyNativeVisitChecklistManifest,
  companyNativeWorkOrdersManifest,
  companyNativeWorkOrdersVisitsManifest,
} from "../../../../packages/storage/src/company-native-schema-manifest";
import { ensureCleaningFirstRunProfile } from "./cleaning-profile-entry";
import {
  withVerifiedWebNativeCompanyStore,
  type VerifiedNativeCompanyStorePorts,
} from "./request-runtime";

export interface IssuedCleaningWebSession extends CurrentWebSession {
  readonly credential: string;
}

export class CleaningProfileStoreSetupRequiredError extends Error {
  readonly code = "CLEANING_PROFILE_STORE_SETUP_REQUIRED";
  readonly missing_or_invalid: readonly string[];

  constructor(missingOrInvalid: readonly string[]) {
    super("cleaning-profile-store-setup-required");
    this.name = "CleaningProfileStoreSetupRequiredError";
    this.missing_or_invalid = Object.freeze([...new Set(missingOrInvalid)]);
  }
}

export class CleaningProfileStoreUnavailableError extends Error {
  readonly code = "CLEANING_PROFILE_STORE_UNAVAILABLE";

  constructor() {
    super("cleaning-profile-store-unavailable");
    this.name = "CleaningProfileStoreUnavailableError";
  }
}

export interface CleaningProfileLoginOptions {
  readonly issued: IssuedCleaningWebSession;
  /** Isolated disposable fixtures only; production composition uses #1404 runtime. */
  readonly resolveCurrentSession?: (credential: string) => Promise<CurrentWebSession | null>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly test_ports?: VerifiedNativeCompanyStorePorts;
}

/**
 * Initialize the Cleaning default before login publishes its cookie. Storage
 * resolution and lease validation reuse #1409's shared native-store owner API.
 * Existing v1/v2 company settings are supported without in-place migration.
 */
export async function initializeCleaningProfileForLogin(options: CleaningProfileLoginOptions) {
  const runtime = options.resolveCurrentSession ? undefined : await getWebSessionRuntime();
  try {
    return await withVerifiedWebNativeCompanyStore({
      currentSession: options.issued,
      revalidateSession: () => options.resolveCurrentSession
        ? options.resolveCurrentSession(options.issued.credential)
        : runtime!.resolveCredential(options.issued.credential),
      requiredSchemaVersions: Object.freeze([
        companyNativeWorkOrdersManifest.schema_version,
        companyNativeWorkOrdersVisitsManifest.schema_version,
        companyNativeVisitChecklistManifest.schema_version,
      ]),
      operation: storage => ensureCleaningFirstRunProfile({ scope: options.issued.scope, storage }),
      environment: options.environment,
      testPorts: options.test_ports,
    });
  } catch (error) {
    if (error instanceof CleaningProfileStoreSetupRequiredError) throw error;
    if (error instanceof Error && error.message.startsWith("native-company-runtime-config-required:")) {
      throw new CleaningProfileStoreSetupRequiredError([error.message.slice("native-company-runtime-config-required:".length)]);
    }
    throw new CleaningProfileStoreUnavailableError();
  }
}
