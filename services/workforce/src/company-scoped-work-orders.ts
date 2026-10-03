import type { StorageClient } from "../../../packages/storage/src/index.js";
import { verifyCompanyNativeSchemaAttestation } from "../../../packages/storage/src/company-native-schema-attestation.js";
import { getCompanyNativeSchemaManifest } from "../../../packages/storage/src/company-native-schema-manifest.js";
import type {
  AuthenticatedCompanyContext,
  CompanyPlacementRegistry,
  CompanyStoreOpener,
  CompanyStorageResolver,
  RegisteredCompanyPlacement,
} from "../../../packages/storage/src/company-storage-resolver.js";
import { createCompanyStorageResolver } from "../../../packages/storage/src/company-storage-resolver.js";
import type { CurrentSessionContext, VerifiedSessionIdentity } from "../../../packages/titan-platform/src/security-boundary.js";

export type CompanyWorkOrderInput = Readonly<{
  company_id: string;
  actor_id: string;
  run_id: string;
  work_id: string;
  work_order_id: string;
  signal?: AbortSignal;
}>;

export type CompanyWorkOrderEffectInput = CompanyWorkOrderInput & Readonly<{
  companyStorage: StorageClient;
  currentSession: CurrentSessionContext;
}>;

export type HostedCompanyWorkOrderOperations = Readonly<{
  read(input: CompanyWorkOrderEffectInput): Promise<unknown>;
  complete(input: CompanyWorkOrderEffectInput & { authorityFence?: { assertCurrent(): void } }): Promise<unknown>;
}>;

type CompanyStorageLeaseResolver = Pick<CompanyStorageResolver<StorageClient>, "resolve" | "open">;

function companyAttestedOpener(opener: CompanyStoreOpener<StorageClient>): CompanyStoreOpener<StorageClient> {
  return Object.freeze({
    async open(
      placement: Parameters<CompanyStoreOpener<StorageClient>["open"]>[0],
      options?: Parameters<CompanyStoreOpener<StorageClient>["open"]>[1],
    ) {
      const opened = await opener.open(placement, options);
      const assertCompanyBinding = async () => {
        const manifest = getCompanyNativeSchemaManifest(placement.schema_version);
        if (!manifest || !["native-work-orders-v1", "native-work-orders-visits-v2", "native-visit-checklist-v3"].includes(manifest.profile_id)) {
          throw new Error("native-company-schema-version-unsupported");
        }
        await opened.assertPlacementBound();
        await verifyCompanyNativeSchemaAttestation({
          storage: opened.client,
          placement,
          manifest,
        });
        const rows = await opened.client.query<{ id: string }>("SELECT id FROM companies WHERE id=$1", [placement.company_id]);
        if (rows.rowCount !== 1 || rows.rows[0]?.id !== placement.company_id) {
          throw new Error("workforce-company-store-identity-mismatch");
        }
        // Keep the base opener's filesystem identity check on both sides of the
        // database attestation; the open SQLite handle must still match the
        // registered opaque placement after the query completes.
        await opened.assertPlacementBound();
      };
      try {
        options?.signal?.throwIfAborted();
        await assertCompanyBinding();
        options?.signal?.throwIfAborted();
      } catch (error) {
        await opened.client.close().catch(() => undefined);
        throw error;
      }
      return Object.freeze({
        ...opened,
        async assertPlacementBound() {
          await assertCompanyBinding();
        },
      });
    },
  });
}

function authenticatedScope(current: CurrentSessionContext): AuthenticatedCompanyContext {
  return Object.freeze({
    company_id: current.company_id,
    actor_id: current.actor_id,
    session_id: current.session_id,
    session_revision: current.session_revision,
    context_revision: current.context_revision,
    audience: current.audience,
    expires_at: current.expires_at,
    authority_neutral: true,
  });
}

function assertCurrentBinding(input: CompanyWorkOrderInput, current: CurrentSessionContext): void {
  input.signal?.throwIfAborted();
  if (current.authority_neutral !== true || current.audience !== "workforce"
    || current.company_id !== input.company_id || current.actor_id !== input.actor_id
    || current.session_id.length === 0 || current.context_revision.length === 0
    || !Number.isSafeInteger(current.session_revision) || current.session_revision < 1
    || !Number.isFinite(Date.parse(current.expires_at)) || Date.parse(current.expires_at) <= Date.now()) {
    throw new Error("workforce-company-session-binding-invalid");
  }
}

function assertPlacementBinding(input: CompanyWorkOrderInput, placement: RegisteredCompanyPlacement): void {
  if (placement.company_id !== input.company_id) throw new Error("workforce-company-placement-mismatch");
}

function leaseBoundClient(client: StorageClient, lease: Awaited<ReturnType<CompanyStorageResolver<StorageClient>["open"]>>, signal?: AbortSignal): StorageClient {
  const assertLeaseCurrent = async () => {
    signal?.throwIfAborted();
    await lease.assertCurrent({ signal });
    signal?.throwIfAborted();
  };
  return Object.freeze({
    dialect: client.dialect,
    async query<T>(sql: string, params?: readonly unknown[]) {
      await assertLeaseCurrent();
      return client.query<T>(sql, params);
    },
    transaction<T>(fn: (tx: StorageClient) => Promise<T>, transactionOptions?: Parameters<StorageClient["transaction"]>[1]) {
      // The lease was asserted at provider admission. Once a consequential
      // effect is admitted, the existing execution contract lets it finish;
      // the post-effect check below blocks verification if scope/placement moved.
      return client.transaction(fn, transactionOptions);
    },
    async close() {
      throw new Error("workforce-company-store-close-owned-by-lease");
    },
  });
}

/**
 * Workforce consumer for the canonical #1233 resolver. It derives placement
 * only from a freshly verified #302 current session, passes the resolver-issued
 * lease client to the existing native work-order owner, and closes every lease.
 * Placement/lease values remain in-process and are never serialized as authority.
 */
export function createCompanyScopedWorkOrders(options: {
  placementRegistry: CompanyPlacementRegistry;
  storeOpener: CompanyStoreOpener<StorageClient>;
  resolveCurrentSession(input: CompanyWorkOrderInput): Promise<Readonly<{
    current: CurrentSessionContext;
    proof: VerifiedSessionIdentity;
  }>>;
  revalidateCurrentSession(
    proof: VerifiedSessionIdentity,
    expected: CurrentSessionContext,
    signal?: AbortSignal,
    input?: CompanyWorkOrderInput,
  ): Promise<CurrentSessionContext>;
  operations: HostedCompanyWorkOrderOperations;
}) {
  const withLease = async <T>(input: CompanyWorkOrderInput, effect: (companyStorage: StorageClient, currentSession: CurrentSessionContext) => Promise<T>): Promise<T> => {
    input.signal?.throwIfAborted();
    const { current, proof } = await options.resolveCurrentSession(input);
    assertCurrentBinding(input, current);
    const resolver = createCompanyStorageResolver<StorageClient>({
      registry: options.placementRegistry,
      opener: companyAttestedOpener(options.storeOpener),
      scopeRevalidator: {
        async assertCurrent(scope, control) {
          control?.signal?.throwIfAborted();
          if (scope.kind !== "authenticated") throw new Error("authenticated-company-scope-required");
          const expectedScope = scope.current;
          const fresh = await options.revalidateCurrentSession(proof, current, control?.signal, input);
          control?.signal?.throwIfAborted();
          if (fresh.session_id !== expectedScope.session_id || fresh.session_revision !== expectedScope.session_revision
            || fresh.context_revision !== expectedScope.context_revision || fresh.company_id !== expectedScope.company_id
            || fresh.actor_id !== expectedScope.actor_id || fresh.audience !== expectedScope.audience
            || fresh.expires_at !== expectedScope.expires_at || fresh.authority_neutral !== true) {
            throw new Error("workforce-company-session-not-current");
          }
        },
      },
    });
    const placement = await resolver.resolve({ kind: "authenticated", current: authenticatedScope(current) }, { signal: input.signal });
    assertPlacementBinding(input, placement);

    const lease = await resolver.open(placement, { signal: input.signal });
    let effectFailed = false;
    try {
      if (lease.company_id !== input.company_id || lease.placement_id !== placement.placement_id
        || lease.placement_revision !== placement.placement_revision || lease.provider !== placement.provider
        || lease.schema_version !== placement.schema_version || lease.client.dialect !== lease.provider) {
        throw new Error("workforce-company-store-binding-invalid");
      }
      await lease.assertCurrent({ signal: input.signal });
      input.signal?.throwIfAborted();
      const result = await effect(leaseBoundClient(lease.client, lease, input.signal), current);
      await lease.assertCurrent({ signal: input.signal });
      input.signal?.throwIfAborted();
      return result;
    } catch (error) {
      effectFailed = true;
      throw error;
    } finally {
      if (effectFailed) await lease.close().catch(() => undefined);
      else await lease.close();
    }
  };

  return Object.freeze({
    read(input: CompanyWorkOrderInput) {
      return withLease(input, (companyStorage, currentSession) => options.operations.read({ ...input, companyStorage, currentSession }));
    },
    complete(input: CompanyWorkOrderInput & { authorityFence?: { assertCurrent(): void } }) {
      return withLease(input, (companyStorage, currentSession) => options.operations.complete({ ...input, companyStorage, currentSession }));
    },
  });
}
