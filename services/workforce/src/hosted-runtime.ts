import { AsyncLocalStorage } from "node:async_hooks";
import type { StorageClient } from "../../../packages/storage/src/index.js";
import type { CompanyPlacementRegistry, CompanyStoreOpener } from "../../../packages/storage/src/company-storage-resolver.js";
import { IdentitySessionRegistry, type CurrentSessionContext, type ExpectedSessionContext, type SessionSourceReference, type VerifiedSessionIdentity } from "../../../packages/titan-platform/src/security-boundary.js";
// Existing native composition owns authority, provider verification and evidence.
// @ts-expect-error Native runtime owner is JavaScript.
import { createFieldServiceRuntime } from "./field-service-runtime.mjs";
// @ts-expect-error Canonical execution boundary is JavaScript.
import { boundedAdapterCall } from "../../../packages/tools/execution-gateway.mjs";
import type { ConversationAuth, ConversationRequest, ConversationSurface } from "./conversation-api.js";
import type { WorkforceZeroBridgeContext } from "../../../packages/titan-platform/src/directadmin-session-bridge.js";
import type { DirectAdminGatewayFactory } from "./directadmin-workforce-owners.js";
import type { DirectAdminBootstrapNonceFlow } from "./directadmin-bootstrap-nonce-route.js";
import { AUTHENTICATED_SESSION_PROOF_TYPE, type AuthenticatedWorkIdentity } from "./index.js";
import { createCompanyScopedWorkOrders, type HostedCompanyWorkOrderOperations } from "./company-scoped-work-orders.js";

const derivedWorkforceSessionPrefix = "workforce-zero-";

export type HostedWorkforceDependencies = {
  identityStoragePath: string;
  /** Operator-configured adapter deadline; timeout never proves non-execution. */
  adapterTimeoutMs?: number;
  /** Authenticate cryptographically before returning these bound claims. */
  credentialVerifier: {
    verify(authorization: string, options?: { signal: AbortSignal }): Promise<VerifiedSessionIdentity & { audience: string; surface: ConversationSurface }>;
  };
  /** Canonical #1233 registry and physical opener; no request-provided paths or placements. */
  companyPlacementRegistry: CompanyPlacementRegistry;
  companyStoreOpener: CompanyStoreOpener<StorageClient>;
  /** Existing native work-order owner, called only with the current leased company store. */
  workOrders: HostedCompanyWorkOrderOperations;
  /** Actual observations of credential, authority, provider and evidence dependencies. */
  readiness(options?: { signal: AbortSignal }): Promise<{ authentication: boolean; authority: boolean; provider: boolean; evidence: boolean }>;
  /** Optional, separately commissioned #1049/#302 audience-bound session bridge.
   * Production composition constructs the canonical SDK gateway from the
   * operator module's session-service and bootstrap-provider ports; it must not
   * reuse the Workforce conversation credential or carry DirectAdmin authority. */
  directAdmin?: {
    publicOrigin: string;
    createGateway: DirectAdminGatewayFactory;
    /** Same canonical #302 flow as bootstrapProvider; absence leaves nonce
     * issuance mounted fail-closed while existing-session routes remain usable. */
    bootstrapNonceFlow?: DirectAdminBootstrapNonceFlow;
  };
  close?(options?: { signal: AbortSignal }): Promise<void>;
};

type SessionAdmissionInput = Readonly<{
  company_id: string; actor_id: string; run_id: string; work_id: string; signal?: AbortSignal;
}>;
type RunIdentityInput = Pick<SessionAdmissionInput, "company_id" | "actor_id" | "run_id">;
type SessionAdmissionContext = Readonly<{
  current: CurrentSessionContext;
  proof: VerifiedSessionIdentity;
  authenticated_identity: AuthenticatedWorkIdentity;
  source_fenced: boolean;
  signal?: AbortSignal;
  acquire_deadline_ms?: number;
}>;
type SessionAdmission = <T>(input: SessionAdmissionInput, effect: (context: SessionAdmissionContext) => Promise<T> | T) => Promise<T>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function authBoundaryFailure(error: unknown): Error {
  if (error instanceof Error && error.message === "identity-registry-unavailable") {
    return new Error("identity-registry-unavailable");
  }
  return new Error("conversation-authentication-failed");
}

function sessionBoundaryFailure(error: unknown): Error {
  if (error instanceof Error && error.message === "identity-registry-unavailable") {
    return new Error("identity-registry-unavailable");
  }
  if (error instanceof Error && error.message === "session-fence-timeout") {
    return new Error("identity-registry-unavailable");
  }
  if (error instanceof Error && /^(identity-|session-|derived-session-|runtime-authentication-|runtime-credential-)/.test(error.message)
    && !/aborted|cancelled/.test(error.message)) {
    return new Error("conversation-authentication-failed");
  }
  return error instanceof Error ? error : new Error("conversation-authentication-failed");
}

function isSessionSourceReference(value: unknown): value is SessionSourceReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  const stringFields = ["provider", "subject", "issuer", "audience", "session_id", "context_revision", "company_id", "actor_id", "device_id", "expires_at", "node_id"] as const;
  return source.schema === "titan.session-source/v1"
    && stringFields.every(field => typeof source[field] === "string" && (source[field] as string).length > 0)
    && Number.isSafeInteger(source.session_revision) && (source.session_revision as number) > 0
    && Number.isFinite(Date.parse(source.expires_at as string))
    && typeof source.csrf_sha256 === "string" && /^[A-Za-z0-9_-]{43}$/.test(source.csrf_sha256);
}

function requireConsistentSessionProof(identity: AuthenticatedWorkIdentity): boolean {
  const hasSourceField = Object.prototype.hasOwnProperty.call(identity, "source_session");
  const hasSource = isSessionSourceReference(identity.source_session);
  const derivedId = identity.session_id.startsWith(derivedWorkforceSessionPrefix);
  const required = identity.source_session_required;
  const proofType = identity.session_proof_type;

  if (required !== undefined && typeof required !== "boolean") throw new Error("runtime-authentication-required");
  if (hasSourceField && !hasSource) throw new Error("runtime-authentication-required");
  if (proofType !== undefined && proofType !== AUTHENTICATED_SESSION_PROOF_TYPE.direct
    && proofType !== AUTHENTICATED_SESSION_PROOF_TYPE.sourceDerived) throw new Error("runtime-authentication-required");
  if ((proofType === AUTHENTICATED_SESSION_PROOF_TYPE.sourceDerived && required === false)
    || (proofType === AUTHENTICATED_SESSION_PROOF_TYPE.direct && required === true)) {
    throw new Error("runtime-authentication-required");
  }

  const requiresSource = proofType === AUTHENTICATED_SESSION_PROOF_TYPE.sourceDerived || required === true;
  if (requiresSource) {
    if (!hasSource) throw new Error("runtime-authentication-required");
    return true;
  }
  if (proofType === AUTHENTICATED_SESSION_PROOF_TYPE.direct && (hasSource || derivedId)) {
    throw new Error("runtime-authentication-required");
  }
  // Legacy source-derived identities predate the explicit proof type. Retain
  // their valid lineage, but never turn a deterministic child ID with missing
  // lineage into an ordinary, unfenced session.
  if (hasSource) return true;
  if (derivedId) throw new Error("runtime-authentication-required");
  return false;
}

export async function createHostedRuntime(storage: StorageClient, identityStorage: StorageClient, dependencies: HostedWorkforceDependencies, signal?: AbortSignal) {
  const timeoutMs = dependencies.adapterTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("workforce-adapter-timeout-invalid");
  if (typeof dependencies.companyPlacementRegistry?.findByCompanyId !== "function"
    || typeof dependencies.companyStoreOpener?.open !== "function") {
    throw new Error("production-runtime-port-required:companyPlacementPorts");
  }
  const registry = new IdentitySessionRegistry(identityStorage);
  const requestIdentityFailure = new AsyncLocalStorage<{ failure?: string; effectAdmitted?: boolean }>();
  const captureIdentityFailure = (error: unknown): Error => {
    const mapped = sessionBoundaryFailure(error);
    if (mapped.message === "identity-registry-unavailable" || mapped.message === "conversation-authentication-failed") {
      const scope = requestIdentityFailure.getStore();
      if (scope && !scope.effectAdmitted) scope.failure = mapped.message;
    }
    return mapped;
  };
  const captureAdmissionUnavailable = (): Error => {
    const failure = new Error("zero-execution-admission-unavailable");
    const scope = requestIdentityFailure.getStore();
    if (scope && !scope.effectAdmitted) scope.failure = failure.message;
    return failure;
  };
  async function loadRunIdentity(input: RunIdentityInput, callSignal?: AbortSignal) {
    callSignal?.throwIfAborted();
    const row = (await storage.query<{ payload: string }>("SELECT payload FROM agent_runs WHERE company_id=$1 AND run_id=$2", [input.company_id, input.run_id])).rows[0];
    callSignal?.throwIfAborted();
    const now = new Date().toISOString();
    const run = row ? JSON.parse(row.payload) : null;
    const stored = run?.authenticated_identity as AuthenticatedWorkIdentity | undefined;
    if (!stored || stored.actor_id !== input.actor_id || stored.company_id !== input.company_id
      || stored.audience !== "workforce" || stored.surface !== "zero"
      || !Number.isSafeInteger(stored.session_revision) || typeof stored.provider !== "string"
      || typeof stored.subject !== "string" || typeof stored.session_id !== "string"
      || typeof stored.device_id !== "string" || typeof stored.context_revision !== "string"
      ) {
      throw new Error("runtime-authentication-required");
    }
    const sourceFenced = requireConsistentSessionProof(stored);
    if (typeof stored.credential_expires_at !== "string") {
      throw new Error("runtime-authentication-required");
    }
    const expiresAt = Date.parse(stored.credential_expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(now)) throw new Error("runtime-credential-expired");
    const authenticated_identity = deepFreeze(structuredClone(stored));
    const proof: VerifiedSessionIdentity = deepFreeze({
      provider: authenticated_identity.provider,
      subject: authenticated_identity.subject,
      session_id: authenticated_identity.session_id,
      device_id: authenticated_identity.device_id,
      session_revision: authenticated_identity.session_revision,
      ...(authenticated_identity.credential_expires_at ? { credential_expires_at: authenticated_identity.credential_expires_at } : {}),
      ...(sourceFenced ? { source_session: structuredClone(authenticated_identity.source_session!) } : {}),
    });
    return { run, authenticated_identity, proof, now };
  }
  const expected = (input: RunIdentityInput, identity: AuthenticatedWorkIdentity) => ({
    audience: "workforce", company_id: input.company_id, actor_id: input.actor_id,
    context_revision: identity.context_revision,
  });
  const companyWorkOrders = createCompanyScopedWorkOrders({
    placementRegistry: dependencies.companyPlacementRegistry,
    storeOpener: dependencies.companyStoreOpener,
    async resolveCurrentSession(input) {
      const loaded = await loadRunIdentity(input, input.signal);
      input.signal?.throwIfAborted();
      let current: CurrentSessionContext;
      try {
        current = await registry.resolveCurrentSession(loaded.proof, expected(input, loaded.authenticated_identity), new Date().toISOString());
      } catch (error) { throw captureIdentityFailure(error); }
      input.signal?.throwIfAborted();
      return { current, proof: loaded.proof };
    },
    async revalidateCurrentSession(proof, current, callSignal, input) {
      callSignal?.throwIfAborted();
      let fresh: CurrentSessionContext;
      try {
        fresh = await registry.resolveCurrentSession(proof, {
          audience: "workforce", company_id: current.company_id, actor_id: current.actor_id,
          context_revision: current.context_revision,
        }, new Date().toISOString());
      } catch (error) { throw captureIdentityFailure(error); }
      callSignal?.throwIfAborted();
      return fresh;
    },
    operations: dependencies.workOrders,
  });
  const sessionAdmission: SessionAdmission = async (input, effect) => {
    let loaded: Awaited<ReturnType<typeof loadRunIdentity>>;
    try { loaded = await loadRunIdentity(input, input.signal); }
    catch (error) { throw captureIdentityFailure(error); }
    const context = expected(input, loaded.authenticated_identity);
    if (loaded.proof.source_session !== undefined) {
      let admissionCompleted = false;
      try {
        return await registry.withCurrentSessionFence(loaded.proof, context, { signal: input.signal },
          async (current, signal, acquireDeadlineMs) => {
            const result = await effect({ current, proof: loaded.proof, authenticated_identity: loaded.authenticated_identity, source_fenced: true, signal, acquire_deadline_ms: acquireDeadlineMs });
            // `effect` is the control-store admission transaction. Its promise
            // resolves only after the durable EXECUTING transition commits, so
            // callback entry alone must not suppress timeout classification.
            admissionCompleted = true;
            const scope = requestIdentityFailure.getStore();
            if (scope) scope.effectAdmitted = true;
            return result;
          });
      } catch (error) {
        if (!admissionCompleted && error instanceof Error && error.message === "storage-transaction-acquire-timeout") {
          throw captureAdmissionUnavailable();
        }
        if (!admissionCompleted) throw captureIdentityFailure(error);
        throw error;
      }
    }
    // Ordinary Workforce sessions retain their existing current-identity check;
    // lineage is never synthesized for credentials that have no signed source.
    let current: CurrentSessionContext;
    try { current = await registry.resolveCurrentSession(loaded.proof, context, loaded.now); }
    catch (error) { throw captureIdentityFailure(error); }
    input.signal?.throwIfAborted();
    try {
      const result = await effect({ current, proof: loaded.proof, authenticated_identity: loaded.authenticated_identity, source_fenced: false, signal: input.signal });
      const scope = requestIdentityFailure.getStore();
      if (scope) scope.effectAdmitted = true;
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === "storage-transaction-acquire-timeout") {
        throw captureAdmissionUnavailable();
      }
      throw error;
    }
  };
  const auth: ConversationAuth = {
    async resolve({ request, authorization }) {
      try {
        if (!authorization || authorization.length > 8192) throw new Error("credential-required");
        const verified = await boundedAdapterCall((adapterSignal: AbortSignal) => dependencies.credentialVerifier.verify(authorization, { signal: adapterSignal }), { timeoutMs, signal });
        signal?.throwIfAborted();
        // This native manager composition currently has only the Zero authority
        // contract. Do not silently translate Go/Hub credentials into Zero work.
        if (verified.surface !== "zero" || verified.audience !== "workforce") throw new Error("credential-audience-invalid");
        const hasSourceField = Object.prototype.hasOwnProperty.call(verified, "source_session");
        const hasSource = isSessionSourceReference(verified.source_session);
        if (hasSourceField && !hasSource) throw new Error("credential-source-invalid");
        if (typeof verified.session_id !== "string" || !verified.session_id
          || (!hasSource && verified.session_id.startsWith(derivedWorkforceSessionPrefix))) throw new Error("credential-source-invalid");
        // Copy only verified identity fields, never credentials or arbitrary claims.
        const proof: VerifiedSessionIdentity = { provider: verified.provider, subject: verified.subject, session_id: verified.session_id,
          device_id: verified.device_id, session_revision: verified.session_revision,
          ...(verified.credential_expires_at ? { credential_expires_at: verified.credential_expires_at } : {}),
          ...(hasSource ? { source_session: verified.source_session } : {}) };
        const current = await registry.resolveCurrentSession(proof, {
          audience: "workforce", company_id: request.company_id!, actor_id: request.actor_id,
          context_revision: request.context_revision,
        }, new Date().toISOString());
        return { company_id: current.company_id, actor_id: current.actor_id, device_id: current.device_id,
          session_id: current.session_id, context_revision: current.context_revision, surface: verified.surface,
          authenticated_identity: { ...proof, audience: "workforce", company_id: current.company_id,
            actor_id: current.actor_id, context_revision: current.context_revision, surface: verified.surface,
            session_proof_type: hasSource ? AUTHENTICATED_SESSION_PROOF_TYPE.sourceDerived : AUTHENTICATED_SESSION_PROOF_TYPE.direct,
            ...(hasSource ? { source_session_required: true } : {}) } };
      } catch (error) { throw authBoundaryFailure(error); }
    },
  };
  async function resolveWorkforceZeroIdentity(credential: string, child: WorkforceZeroBridgeContext) {
    if (typeof credential !== "string" || credential.length < 1 || credential.length > 16_384 ||
        child?.schema !== "titan.workforce-zero.session/v1" || child.audience !== "workforce" || child.surface !== "zero" ||
        !child.company_id || !child.actor_id || !child.device_id || !child.session_id || !child.context_revision ||
        !Array.isArray(child.company_ids) || child.company_ids.length !== 1 || child.company_ids[0] !== child.company_id ||
        !Number.isSafeInteger(child.session_revision) || !Number.isFinite(child.expires_at)) {
      throw new Error("runtime-authentication-required");
    }
    const request = {
      company_id: child.company_id, actor_id: child.actor_id, device_id: child.device_id,
      surface: child.surface, session_id: child.session_id, context_revision: child.context_revision,
    } as ConversationRequest;
    const authenticated = await auth.resolve({ request, authorization: `Bearer ${credential}` });
    const identity = authenticated.authenticated_identity as AuthenticatedWorkIdentity | undefined;
    const credentialExpiresAt = Date.parse(String(identity?.credential_expires_at ?? ""));
    if (authenticated.company_id !== child.company_id || authenticated.actor_id !== child.actor_id ||
        authenticated.device_id !== child.device_id || authenticated.surface !== "zero" ||
        authenticated.session_id !== child.session_id || authenticated.context_revision !== child.context_revision ||
        identity?.session_revision !== child.session_revision || identity?.source_session_required !== true ||
        !identity.source_session || !Number.isFinite(credentialExpiresAt) || credentialExpiresAt > child.expires_at) {
      throw new Error("runtime-authentication-required");
    }
    const proof: VerifiedSessionIdentity = {
      provider: identity.provider, subject: identity.subject, session_id: identity.session_id,
      device_id: identity.device_id, session_revision: identity.session_revision,
      credential_expires_at: identity.credential_expires_at, source_session: identity.source_session,
    };
    return proof;
  }
  // Only these public provider ports cross the hosted boundary. In particular,
  // never forward the legacy same-store transaction port from an adapter object.
  const runtime = await createFieldServiceRuntime({ storage, workOrders: companyWorkOrders, timeoutMs, signal, sessionAdmission,
    async revalidateIdentity(input: { company_id: string; actor_id: string; run_id: string }) {
      signal?.throwIfAborted();
      let loaded: Awaited<ReturnType<typeof loadRunIdentity>>;
      try { loaded = await loadRunIdentity(input, signal); }
      catch (error) { throw captureIdentityFailure(error); }
      try {
        await registry.resolveCurrentSession(loaded.proof, expected(input, loaded.authenticated_identity), loaded.now);
      } catch (error) { throw captureIdentityFailure(error); }
    },
  });
  const dispatch = runtime.dispatch;
  const recover = runtime.recover;
  const surfacedRuntime = Object.freeze({
    ...runtime,
    async verifyWorkforceZeroSession(credential: string, child: WorkforceZeroBridgeContext): Promise<void> {
      await resolveWorkforceZeroIdentity(credential, child);
    },
    async withWorkforceZeroSessionFence<T>(
      credential: string,
      child: WorkforceZeroBridgeContext,
      options: { signal?: AbortSignal } | undefined,
      effect: (signal: AbortSignal) => Promise<T> | T,
    ): Promise<T> {
      const proof = await resolveWorkforceZeroIdentity(credential, child);
      const expected: ExpectedSessionContext = {
        audience: "workforce", company_id: child.company_id, actor_id: child.actor_id,
        context_revision: child.context_revision,
      };
      return registry.withCurrentSessionFence(proof, expected, { signal: options?.signal }, async (current, signal) => {
        if (current.session_id !== child.session_id || current.session_revision !== child.session_revision ||
            current.context_revision !== child.context_revision || current.company_id !== child.company_id ||
            current.actor_id !== child.actor_id || current.device_id !== child.device_id ||
            Date.parse(current.expires_at) !== child.expires_at || current.allowed_company_ids.length !== 1 ||
            current.allowed_company_ids[0] !== child.company_id) {
          throw new Error("runtime-authentication-required");
        }
        return effect(signal);
      });
    },
    async dispatch(input: Parameters<typeof dispatch>[0]) {
      const scope: { failure?: string; effectAdmitted?: boolean } = {};
      const result = await requestIdentityFailure.run(scope, () => dispatch(input));
      if (scope.failure) throw new Error(scope.failure);
      return result;
    },
    async recover(input: Parameters<typeof recover>[0]) {
      const scope: { failure?: string; effectAdmitted?: boolean } = {};
      const result = await requestIdentityFailure.run(scope, () => recover(input));
      if (scope.failure) throw new Error(scope.failure);
      return result;
    },
  });
  return { auth, runtime: surfacedRuntime, registry, sessionAdmission };
}
