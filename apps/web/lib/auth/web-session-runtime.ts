import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { SignJWT } from "jose";
import {
  createSessionCredentialService,
  createSessionCredentialVerifier,
  openIdentitySessionRegistry,
  requireSecurityId,
  type IdentitySessionRegistry,
} from "@titan-zero/titan-platform/security-boundary";
import { openExistingSqliteStorage } from "../../../../packages/storage/src/index";
import {
  createCurrentWebSessionAdapter,
  createCurrentWebSessionIngress,
} from "./current-session";

const WEB_LOGIN_AUDIENCE = "titan-web-login";
const WEB_SESSION_AUDIENCE = "titan-web";
// The assertion is one-use and never leaves this server call; keep it within
// the canonical credential owner’s five-minute maximum so the resulting web
// session is not accidentally shortened below the configured session window.
const WEB_LOGIN_LIFETIME_SECONDS = 300;
const WEB_SESSION_LIFETIME_SECONDS = 300;

export type WebLoginIdentityBinding = Readonly<{
  legacy_user_id: string;
  legacy_account_id: string;
  company_id: string;
  actor_id: string;
  device_id: string;
}>;

export class WebAuthSetupRequiredError extends Error {
  readonly code = "WEB_AUTH_SETUP_REQUIRED";
  readonly missing_or_invalid: readonly string[];

  constructor(missingOrInvalid: readonly string[]) {
    super(`web-auth-setup-required:${[...new Set(missingOrInvalid)].join(",")}`);
    this.name = "WebAuthSetupRequiredError";
    this.missing_or_invalid = Object.freeze([...new Set(missingOrInvalid)]);
  }
}

export class WebIdentityBindingRequiredError extends Error {
  readonly code = "WEB_IDENTITY_BINDING_REQUIRED";

  constructor() {
    super("web-identity-binding-required");
    this.name = "WebIdentityBindingRequiredError";
  }
}

export function isWebAuthSetupRequiredError(error: unknown): error is WebAuthSetupRequiredError {
  return error instanceof WebAuthSetupRequiredError;
}

export interface WebSessionRuntimeOptions {
  readonly registry: IdentitySessionRegistry;
  /** Configured public origin only. Request Host and forwarded headers are never consulted. */
  readonly public_origin: string;
  readonly login_key_id: string;
  readonly login_signing_secret: Uint8Array;
  readonly session_key_id: string;
  readonly session_signing_secret: Uint8Array;
  /** Approved compatibility and login-context rows, provisioned outside requests. */
  readonly bindings: readonly WebLoginIdentityBinding[];
  readonly now?: () => Date;
  readonly close_storage?: () => Promise<void>;
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("web-auth-origin-invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || value !== url.origin) throw new Error("web-auth-origin-invalid");
  return url.origin;
}

function validateBindings(input: readonly WebLoginIdentityBinding[]): readonly WebLoginIdentityBinding[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("web-identity-bindings-required");
  const byUserAccount = new Set<string>();
  const accountCompanies = new Map<string, string>();
  const companyAccounts = new Map<string, string>();
  const deviceActors = new Map<string, string>();
  const actorCompanyUsers = new Map<string, string>();
  const bindings = input.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("web-identity-bindings-invalid");
    const keys = Object.keys(row).sort();
    const expectedKeys = ["actor_id", "company_id", "device_id", "legacy_account_id", "legacy_user_id"];
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      throw new Error("web-identity-bindings-invalid");
    }
    const binding = { ...row };
    for (const [field, value] of Object.entries(binding)) {
      if (typeof value !== "string") throw new Error("web-identity-bindings-invalid");
      try { requireSecurityId(value, field); } catch { throw new Error("web-identity-bindings-invalid"); }
    }
    const userAccount = JSON.stringify([binding.legacy_user_id, binding.legacy_account_id]);
    if (byUserAccount.has(userAccount)) throw new Error("web-identity-bindings-ambiguous");
    byUserAccount.add(userAccount);
    const existingCompany = accountCompanies.get(binding.legacy_account_id);
    const existingAccount = companyAccounts.get(binding.company_id);
    if ((existingCompany !== undefined && existingCompany !== binding.company_id)
      || (existingAccount !== undefined && existingAccount !== binding.legacy_account_id)) {
      throw new Error("web-company-account-mapping-ambiguous");
    }
    accountCompanies.set(binding.legacy_account_id, binding.company_id);
    companyAccounts.set(binding.company_id, binding.legacy_account_id);
    const existingActor = deviceActors.get(binding.device_id);
    if (existingActor !== undefined && existingActor !== binding.actor_id) throw new Error("web-device-mapping-ambiguous");
    deviceActors.set(binding.device_id, binding.actor_id);
    const actorCompany = JSON.stringify([binding.actor_id, binding.company_id]);
    const existingUser = actorCompanyUsers.get(actorCompany);
    if (existingUser !== undefined && existingUser !== binding.legacy_user_id) throw new Error("web-user-mapping-ambiguous");
    actorCompanyUsers.set(actorCompany, binding.legacy_user_id);
    return Object.freeze(binding);
  });
  return Object.freeze(bindings);
}

function secretKey(value: Uint8Array, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 32) throw new WebAuthSetupRequiredError([name]);
  return new Uint8Array(value);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < a.byteLength; index++) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

function expectedFor(binding: WebLoginIdentityBinding) {
  return Object.freeze({ company_id: binding.company_id, device_id: binding.device_id, actor_id: binding.actor_id });
}

/** Compose the actual web login/session path over the canonical #302 registry.
 * This factory creates no identity, membership, device, binding, schema or key. */
export function createWebSessionRuntime(options: WebSessionRuntimeOptions) {
  const origin = canonicalOrigin(options.public_origin);
  const loginIssuer = `titan:web-login:${origin}`;
  const sessionIssuer = `titan:web-session:${origin}`;
  const loginKey = secretKey(options.login_signing_secret, "TITAN_WEB_LOGIN_SIGNING_SECRET");
  const sessionKey = secretKey(options.session_signing_secret, "TITAN_WEB_SESSION_SIGNING_SECRET");
  if (sameBytes(loginKey, sessionKey)) {
    throw new WebAuthSetupRequiredError(["TITAN_WEB_LOGIN_SIGNING_SECRET and TITAN_WEB_SESSION_SIGNING_SECRET must be distinct"]);
  }
  try {
    requireSecurityId(options.login_key_id, "login_key_id");
    requireSecurityId(options.session_key_id, "session_key_id");
  } catch {
    throw new WebAuthSetupRequiredError(["TITAN_WEB_LOGIN_KEY_ID", "TITAN_WEB_SESSION_KEY_ID"]);
  }
  if (options.login_key_id === options.session_key_id) {
    throw new WebAuthSetupRequiredError(["TITAN_WEB_LOGIN_KEY_ID and TITAN_WEB_SESSION_KEY_ID must be distinct"]);
  }
  const bindings = validateBindings(options.bindings);
  const companiesToAccounts = new Map(bindings.map(binding => [binding.company_id, binding.legacy_account_id]));
  const usersByActorCompany = new Map(bindings.map(binding => [
    JSON.stringify([binding.actor_id, binding.company_id]), binding.legacy_user_id,
  ]));
  const loginBindings = new Map(bindings.map(binding => [
    JSON.stringify([binding.legacy_user_id, binding.legacy_account_id]), binding,
  ]));
  const now = options.now ?? (() => new Date());
  const verifierConfig = {
    registry: options.registry,
    issuer: sessionIssuer,
    audience: WEB_SESSION_AUDIENCE,
    key_id: options.session_key_id,
    algorithm: "HS256" as const,
    verification_key: sessionKey,
    upstream: {
      issuer: loginIssuer,
      audience: WEB_LOGIN_AUDIENCE,
      key_id: options.login_key_id,
      algorithm: "HS256" as const,
      verification_key: loginKey,
    },
    now,
    lifetime_seconds: WEB_SESSION_LIFETIME_SECONDS,
  };
  const credentialService = createSessionCredentialService({ ...verifierConfig, signing_key: sessionKey });
  const verifier = createSessionCredentialVerifier(verifierConfig);
  const projection = Object.freeze({
    async resolveLegacyAccountId(companyId: string): Promise<string | null> {
      return companiesToAccounts.get(companyId) ?? null;
    },
    async resolveLegacyUserId(actorId: string, companyId: string, subject: string): Promise<string | null> {
      const mapped = usersByActorCompany.get(JSON.stringify([actorId, companyId]));
      return mapped === subject ? mapped : null;
    },
  });
  const adapter = createCurrentWebSessionAdapter(credentialService, projection);
  const ingress = createCurrentWebSessionIngress(verifier, projection);

  return Object.freeze({
    async issueForAuthenticatedWebUser(legacyUserId: string, legacyAccountId: string) {
      try { requireSecurityId(legacyUserId, "user_id"); requireSecurityId(legacyAccountId, "account_id"); }
      catch { throw new WebIdentityBindingRequiredError(); }
      const binding = loginBindings.get(JSON.stringify([legacyUserId, legacyAccountId]));
      if (!binding) throw new WebIdentityBindingRequiredError();
      const at = now();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Error("credential-clock-invalid");
      const seconds = Math.floor(at.getTime() / 1000);
      const assertion = await new SignJWT({ company_id: binding.company_id, device_id: binding.device_id })
        .setProtectedHeader({ alg: "HS256", kid: options.login_key_id, typ: "titan-login+jwt" })
        .setIssuer(loginIssuer).setSubject(binding.legacy_user_id).setAudience(WEB_LOGIN_AUDIENCE)
        .setJti(randomUUID()).setIssuedAt(seconds).setExpirationTime(seconds + WEB_LOGIN_LIFETIME_SECONDS)
        .sign(loginKey);
      return adapter.issue(assertion, expectedFor(binding));
    },
    resolveCredential: ingress.resolveCredential,
    resolveRequest: ingress.resolveRequest,
    async switchCompanyCredential(credential: string, targetCompanyId: string) {
      // Authenticate first with the fixed verifier. The caller supplies only a
      // selected destination; source company, actor, device and generations are
      // derived from the verified current session and checked atomically again
      // by the canonical switch operation.
      const authenticated = await verifier.authenticate(credential);
      const context = authenticated.context;
      // The registry's switch choices may include canonical memberships with
      // no web compatibility projection. Reject those before the atomic switch
      // so a missing legacy account/user mapping cannot strand the browser on
      // a context for which the web surface cannot issue its response cookie.
      const targetLegacyUserId = usersByActorCompany.get(JSON.stringify([context.actor_id, targetCompanyId]));
      if (!companiesToAccounts.has(targetCompanyId) || targetLegacyUserId !== authenticated.subject) {
        throw new WebIdentityBindingRequiredError();
      }
      return adapter.switchCompany(credential, {
        company_id: context.company_id,
        device_id: context.device_id,
        actor_id: context.actor_id,
        context_revision: context.context_revision,
      }, targetCompanyId);
    },
    async revokeCredential(credential: string): Promise<void> {
      const authenticated = await verifier.authenticate(credential);
      const context = authenticated.context;
      await credentialService.revoke(credential, {
        company_id: context.company_id,
        device_id: context.device_id,
        actor_id: context.actor_id,
        context_revision: context.context_revision,
      });
    },
    async close(): Promise<void> {
      await options.close_storage?.();
    },
  });
}

type RuntimeEnvironment = Record<string, string | undefined>;

function requiredEnvironment(environment: RuntimeEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new WebAuthSetupRequiredError([name]);
  return value;
}

function decodeSecret(environment: RuntimeEnvironment, name: string): Uint8Array {
  const encoded = requiredEnvironment(environment, name);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new WebAuthSetupRequiredError([name]);
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength < 32 || key.toString("base64url") !== encoded) throw new WebAuthSetupRequiredError([name]);
  return new Uint8Array(key);
}

function bindingsFromEnvironment(environment: RuntimeEnvironment): readonly WebLoginIdentityBinding[] {
  const value = requiredEnvironment(environment, "TITAN_WEB_IDENTITY_BINDINGS_JSON");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new WebAuthSetupRequiredError(["TITAN_WEB_IDENTITY_BINDINGS_JSON"]); }
  try {
    if (!Array.isArray(parsed)) throw new Error();
    return validateBindings(parsed as WebLoginIdentityBinding[]);
  } catch {
    throw new WebAuthSetupRequiredError(["TITAN_WEB_IDENTITY_BINDINGS_JSON"]);
  }
}

/** Environment-backed production composition. It opens only an existing
 * absolute GLOBAL_REGISTRY SQLite file and validates schema v1 read-only. */
export async function createConfiguredWebSessionRuntime(environment: RuntimeEnvironment = process.env) {
  const requiredNames = [
    "TITAN_WEB_PUBLIC_ORIGIN",
    "TITAN_WEB_IDENTITY_REGISTRY_PATH",
    "TITAN_WEB_LOGIN_KEY_ID",
    "TITAN_WEB_LOGIN_SIGNING_SECRET",
    "TITAN_WEB_SESSION_KEY_ID",
    "TITAN_WEB_SESSION_SIGNING_SECRET",
    "TITAN_WEB_IDENTITY_BINDINGS_JSON",
  ];
  const absent = requiredNames.filter(name => !environment[name]?.trim());
  if (absent.length) throw new WebAuthSetupRequiredError(absent);
  const publicOrigin = requiredEnvironment(environment, "TITAN_WEB_PUBLIC_ORIGIN");
  const registryPath = requiredEnvironment(environment, "TITAN_WEB_IDENTITY_REGISTRY_PATH");
  if (!isAbsolute(registryPath)) throw new WebAuthSetupRequiredError(["TITAN_WEB_IDENTITY_REGISTRY_PATH must be absolute"]);
  const loginKeyId = requiredEnvironment(environment, "TITAN_WEB_LOGIN_KEY_ID");
  const sessionKeyId = requiredEnvironment(environment, "TITAN_WEB_SESSION_KEY_ID");
  const loginKey = decodeSecret(environment, "TITAN_WEB_LOGIN_SIGNING_SECRET");
  const sessionKey = decodeSecret(environment, "TITAN_WEB_SESSION_SIGNING_SECRET");
  const bindings = bindingsFromEnvironment(environment);
  try {
    canonicalOrigin(publicOrigin);
  } catch {
    throw new WebAuthSetupRequiredError(["TITAN_WEB_PUBLIC_ORIGIN"]);
  }
  try {
    requireSecurityId(loginKeyId, "login_key_id");
    requireSecurityId(sessionKeyId, "session_key_id");
  } catch {
    throw new WebAuthSetupRequiredError(["TITAN_WEB_LOGIN_KEY_ID", "TITAN_WEB_SESSION_KEY_ID"]);
  }
  if (loginKeyId === sessionKeyId) throw new WebAuthSetupRequiredError(["TITAN_WEB_LOGIN_KEY_ID and TITAN_WEB_SESSION_KEY_ID must be distinct"]);
  if (sameBytes(loginKey, sessionKey)) {
    throw new WebAuthSetupRequiredError(["TITAN_WEB_LOGIN_SIGNING_SECRET and TITAN_WEB_SESSION_SIGNING_SECRET must be distinct"]);
  }
  let storage: ReturnType<typeof openExistingSqliteStorage>;
  try {
    storage = openExistingSqliteStorage(registryPath);
  } catch {
    throw new WebAuthSetupRequiredError(["TITAN_WEB_IDENTITY_REGISTRY_PATH must point to a commissioned GLOBAL_REGISTRY SQLite file"]);
  }
  let registry: IdentitySessionRegistry;
  try {
    registry = await openIdentitySessionRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
  } catch (error) {
    await storage.close().catch(() => undefined);
    if (error instanceof Error && ["identity-schema-version-required", "identity-schema-version-unsupported", "identity-schema-incomplete"].includes(error.message)) {
      throw new WebAuthSetupRequiredError(["TITAN_WEB_IDENTITY_REGISTRY_PATH must point to a commissioned GLOBAL_REGISTRY schema v1"]);
    }
    throw new Error("identity-registry-unavailable");
  }
  try {
    return createWebSessionRuntime({
      registry,
      public_origin: publicOrigin,
      login_key_id: loginKeyId,
      login_signing_secret: loginKey,
      session_key_id: sessionKeyId,
      session_signing_secret: sessionKey,
      bindings,
      close_storage: () => storage.close(),
    });
  } catch (error) {
    await storage.close().catch(() => undefined);
    if (error instanceof WebAuthSetupRequiredError) throw error;
    throw new WebAuthSetupRequiredError(["TITAN_WEB_AUTH_CONFIGURATION"]);
  }
}

let productionRuntime: Promise<ReturnType<typeof createWebSessionRuntime>> | undefined;

export function getWebSessionRuntime(): Promise<Awaited<ReturnType<typeof createWebSessionRuntime>>> {
  if (!productionRuntime) {
    productionRuntime = createConfiguredWebSessionRuntime().catch(error => {
      productionRuntime = undefined;
      throw error;
    });
  }
  return productionRuntime;
}

export function _resetWebSessionRuntimeForTests(): void {
  productionRuntime = undefined;
}
