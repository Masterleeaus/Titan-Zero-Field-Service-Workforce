import { isAbsolute, resolve } from "node:path";
import {
  createCompanyStorageResolver,
  createSqliteCompanyPlacementRegistry,
  createSqliteCompanyStoreOpener,
  openExistingSqliteStorage,
  type CompanyPlacementRegistry,
  type CompanyStoreOpener,
  type CompanyStorageResolver,
  type StorageClient,
} from "../../../../packages/storage/src/index";
import type { CurrentWebSession } from "../auth/current-session";
import { getWebSessionRuntime } from "../auth/web-session-runtime";
import { withNativeCompanyStore } from "./consumer";

function sameAuthenticatedScope(a: CurrentWebSession["scope"], b: CurrentWebSession["scope"]): boolean {
  if (a.kind !== "authenticated" || b.kind !== "authenticated") return false;
  return a.current.company_id === b.current.company_id
    && a.current.actor_id === b.current.actor_id
    && a.current.session_id === b.current.session_id
    && a.current.session_revision === b.current.session_revision
    && a.current.context_revision === b.current.context_revision
    && a.current.audience === b.current.audience
    && a.current.expires_at === b.current.expires_at
    && a.current.authority_neutral === b.current.authority_neutral;
}

export interface VerifiedNativeCompanyStorePorts {
  readonly registry: CompanyPlacementRegistry;
  readonly opener: CompanyStoreOpener<StorageClient>;
}

/**
 * Open the attested native company store for an already verified #302 session.
 * Both request ingress and post-authentication login setup use this same
 * registry/opener/resolver path; callers cannot provide company or placement
 * IDs. The exact session scope is revalidated before and after each operation.
 */
export async function withVerifiedWebNativeCompanyStore<T>(input: {
  currentSession: CurrentWebSession;
  revalidateSession(): Promise<CurrentWebSession | null>;
  requiredSchemaVersions: string | readonly string[];
  operation(client: StorageClient, currentSession: CurrentWebSession): Promise<T>;
  environment?: Readonly<Record<string, string | undefined>>;
  /** Inject canonical storage ports in tests; production always composes them here. */
  testPorts?: VerifiedNativeCompanyStorePorts;
}): Promise<T> {
  const environment = input.environment ?? process.env;
  let registryStorage: ReturnType<typeof openExistingSqliteStorage> | undefined;
  try {
    let registry: CompanyPlacementRegistry;
    let opener: CompanyStoreOpener<StorageClient>;
    if (input.testPorts) {
      registry = input.testPorts.registry;
      opener = input.testPorts.opener;
    } else {
      const registryPath = environment.TITAN_WEB_IDENTITY_REGISTRY_PATH?.trim();
      const companyStoreRoot = environment.TITAN_COMPANY_DATA_ROOT?.trim();
      if (!registryPath) throw new Error("native-company-runtime-config-required:TITAN_WEB_IDENTITY_REGISTRY_PATH");
      if (!companyStoreRoot) throw new Error("native-company-runtime-config-required:TITAN_COMPANY_DATA_ROOT");
      if (!isAbsolute(registryPath)) throw new Error("native-company-runtime-config-required:TITAN_WEB_IDENTITY_REGISTRY_PATH must be absolute");
      registryStorage = openExistingSqliteStorage(registryPath);
      registry = await createSqliteCompanyPlacementRegistry({ storage: registryStorage, storage_role: "GLOBAL_REGISTRY" });
      opener = createSqliteCompanyStoreOpener({
        companyStoreRoot: isAbsolute(companyStoreRoot) ? companyStoreRoot : resolve(process.cwd(), companyStoreRoot),
      });
    }

    const resolver: CompanyStorageResolver<StorageClient> = createCompanyStorageResolver({
      registry,
      opener,
      scopeRevalidator: {
        async assertCurrent(scope) {
          const fresh = await input.revalidateSession();
          if (!fresh || !sameAuthenticatedScope(input.currentSession.scope, fresh.scope)
            || !sameAuthenticatedScope(fresh.scope, scope)) {
            throw new Error("native-company-session-not-current");
          }
        },
      },
    });
    const allowed = typeof input.requiredSchemaVersions === "string"
      ? [input.requiredSchemaVersions]
      : [...input.requiredSchemaVersions];
    if (allowed.length === 0 || allowed.some(version => typeof version !== "string" || version.length === 0)) {
      throw new Error("native-company-schema-version-unsupported");
    }
    const placement = await resolver.resolve(input.currentSession.scope);
    if (!allowed.includes(placement.schema_version)) throw new Error("native-company-schema-version-unsupported");
    return await withNativeCompanyStore({
      resolver,
      current_session: input.currentSession,
      required_schema_version: placement.schema_version,
      operation: client => input.operation(client, input.currentSession),
    });
  } finally {
    await registryStorage?.close();
  }
}

/**
 * Resolve the #302 cookie on this request, then compose the existing read-only
 * #1233 GLOBAL_REGISTRY adapter and root-bounded SQLite opener. Each placement
 * lease re-resolves the same request credential so revocation or a company
 * switch invalidates an in-flight checklist operation. This creates no schema,
 * placement, READY state, identity binding, or business row.
 */
export async function withWebNativeCompanyStore<T>(input: {
  request: Pick<Request, "headers">;
  requiredSchemaVersion: string;
  operation(client: StorageClient, currentSession: CurrentWebSession): Promise<T>;
}): Promise<{ authenticated: false } | { authenticated: true; value: T; currentSession: CurrentWebSession }> {
  const sessionRuntime = await getWebSessionRuntime();
  const currentSession = await sessionRuntime.resolveRequest(input.request);
  if (!currentSession) return { authenticated: false };
  const value = await withVerifiedWebNativeCompanyStore({
    currentSession,
    revalidateSession: () => sessionRuntime.resolveRequest(input.request),
    requiredSchemaVersions: input.requiredSchemaVersion,
    operation: input.operation,
  });
  return { authenticated: true, value, currentSession };
}
