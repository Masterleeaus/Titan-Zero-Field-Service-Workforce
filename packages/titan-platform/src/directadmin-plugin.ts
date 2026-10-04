/** DirectAdmin is an adapter shell. This module defines the shared, authority-neutral
 * contracts used by DirectAdmin plugins; it never grants Titan business authority. */
export * from './directadmin-session-bridge.js';
export * from './directadmin-gateway.js';
export * from './directadmin-cockpit.js';
export * from './directadmin-workforce-skills.js';
export * from './directadmin-channels.js';
export type DirectAdminRole = "admin" | "reseller" | "user";
export type DirectAdminPluginPackage = Readonly<{
  plugin_id: string;
  version: string;
  archive_filename: string;
  manifest_content: string;
  files: readonly string[];
  executable_files: readonly string[];
  role_entrypoints: Readonly<Record<DirectAdminRole, string>>;
  hooks: readonly string[];
}>;
export type PluginValidation = Readonly<{ valid: boolean; errors: readonly string[]; plugin_id: string; version: string }>;

const ID = /^[a-z][a-z0-9_-]{1,62}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** Contribution API version; independent of the package release version. */
export const DIRECTADMIN_SDK_COMPATIBILITY_VERSION = "1.0.0";
const ROLE_PATH: Readonly<Record<DirectAdminRole, string>> = {
  admin: "admin/index.html", reseller: "reseller/index.html", user: "user/index.html",
};
const REQUIRED_FILES = ["plugin.conf", "README.md", "AGENTS.md", "scripts/install.sh", "scripts/uninstall.sh"] as const;

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

export function validateDirectAdminPluginPackage(input: DirectAdminPluginPackage): PluginValidation {
  const errors: string[] = [];
  const plugin_id = String(input?.plugin_id ?? "").trim();
  const version = String(input?.version ?? "").trim();
  if (!ID.test(plugin_id)) errors.push("invalid-plugin-id");
  if (!VERSION.test(version)) errors.push("invalid-plugin-version");
  if (input?.archive_filename !== `${plugin_id}.tar.gz`) errors.push("archive-filename-must-match-plugin-id");
  const manifest = Object.fromEntries((input?.manifest_content ?? "").split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return separator > 0 ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] : ["", ""];
  }));
  if (!manifest.version || manifest.version !== version) errors.push("manifest-version-mismatch");
  const files = new Set(input?.files ?? []);
  for (const required of REQUIRED_FILES) if (!files.has(required)) errors.push(`missing-file:${required}`);
  for (const [role, expected] of Object.entries(ROLE_PATH) as [DirectAdminRole, string][]) {
    const path = input?.role_entrypoints?.[role];
    if (!path || !files.has(path)) errors.push(`missing-role-entrypoint:${role}`);
    else if (path !== expected) errors.push(`noncanonical-role-entrypoint:${role}`);
    if (path && !(input?.executable_files ?? []).includes(path)) errors.push(`role-entrypoint-not-executable:${role}`);
  }
  for (const file of ["scripts/install.sh", "scripts/uninstall.sh"]) {
    if (files.has(file) && !(input?.executable_files ?? []).includes(file)) errors.push(`lifecycle-script-not-executable:${file}`);
  }
  for (const path of files) if (!safeRelativePath(path)) errors.push(`unsafe-file-path:${path}`);
  for (const hook of input?.hooks ?? []) {
    if (!safeRelativePath(hook) || !hook.startsWith("hooks/")) errors.push(`unsafe-hook-path:${hook}`);
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze([...new Set(errors)]), plugin_id, version });
}

export function assertPluginCanBeInstalled(result: PluginValidation): true {
  if (!result.valid) throw new Error(`plugin-validation-failed:${result.errors.join(",")}`);
  return true;
}

/** DirectAdmin session facts are descriptive host context, never Titan actor/company authority. */
export type DirectAdminSession = Readonly<{
  authenticated: boolean;
  session_id: string;
  account_id: string;
  role: DirectAdminRole;
}>;
export type TitanIdentityResolution = Readonly<{
  actor_id: string;
  allowed_company_ids: readonly string[];
  active_company_id: string;
  entitlements: readonly string[];
  session_revision: string;
  authority_revision?: string;
  expires_at: number;
}>;
export type DirectAdminTitanContext = Readonly<{
  schema: "titan.directadmin.context/v1";
  actor_id: string;
  company_id: string;
  allowed_company_ids: readonly string[];
  entitlements: readonly string[];
  session_revision: string;
  authority_revision: string | null;
  expires_at: number;
  da_role: DirectAdminRole;
  authority: "not-carried";
}>;
export type IdentityResolver = (session: DirectAdminSession) => Promise<TitanIdentityResolution | null>;

export type ContextResolution = Readonly<
  | { status: "resolved"; context: DirectAdminTitanContext }
  | { status: "read-only"; reason: "unauthenticated" | "invalid-session" | "unresolved-identity" | "invalid-company-context" | "expired-context" | "identity-service-unavailable" }
>;

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** @deprecated Presentation-only compatibility adapter. Hosted requests must use
 * DirectAdminSessionBridge; authenticated:true is not proof of authentication. */
export async function resolveDirectAdminTitanContext(
  session: DirectAdminSession,
  resolveIdentity: IdentityResolver,
  now = Date.now(),
): Promise<ContextResolution> {
  if (!session?.authenticated) return { status: "read-only", reason: "unauthenticated" };
  if (![session.session_id, session.account_id].every(nonEmpty) || !["admin", "reseller", "user"].includes(session.role)) {
    return { status: "read-only", reason: "invalid-session" };
  }
  let identity: TitanIdentityResolution | null;
  try { identity = await resolveIdentity(session); }
  catch { return { status: "read-only", reason: "identity-service-unavailable" }; }
  if (!identity || ![identity.actor_id, identity.active_company_id, identity.session_revision].every(nonEmpty)) {
    return { status: "read-only", reason: "unresolved-identity" };
  }
  const companies = [...new Set(identity.allowed_company_ids ?? [])];
  if (!companies.length || !companies.includes(identity.active_company_id) || companies.some((id) => !nonEmpty(id)) ||
      !Number.isFinite(identity.expires_at)) return { status: "read-only", reason: "invalid-company-context" };
  if (identity.expires_at <= now) return { status: "read-only", reason: "expired-context" };
  return {
    status: "resolved",
    context: Object.freeze({
      schema: "titan.directadmin.context/v1", actor_id: identity.actor_id,
      company_id: identity.active_company_id, allowed_company_ids: Object.freeze([identity.active_company_id]),
      entitlements: Object.freeze([...(identity.entitlements ?? [])]),
      session_revision: identity.session_revision,
      authority_revision: nonEmpty(identity.authority_revision) ? identity.authority_revision : null,
      expires_at: identity.expires_at, da_role: session.role, authority: "not-carried",
    }),
  };
}

export function validateDirectAdminCompanyContext(
  context: DirectAdminTitanContext,
  requestedCompanyId: string,
  sessionRevision: string,
  now = Date.now(),
): boolean {
  return context.schema === "titan.directadmin.context/v1" && context.authority === "not-carried" &&
    context.company_id === requestedCompanyId && context.allowed_company_ids.includes(requestedCompanyId) &&
    context.session_revision === sessionRevision && context.expires_at > now;
}

export type GovernedIntentRequest = Readonly<{
  company_id: string;
  actor_id: string;
  capability_id: string;
  operation_id: string;
  correlation_id: string;
  input: Readonly<Record<string, unknown>>;
}>;
export type DirectAdminApiFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Thin same-origin transport. It carries resolved context as assertions; the Server Node
 * must authenticate and re-resolve membership/authority for every call. */
export class DirectAdminTitanApiClient {
  constructor(
    private readonly context: DirectAdminTitanContext,
    private readonly fetcher: DirectAdminApiFetch = (input, init) => fetch(input, init),
    private readonly requestId: () => string = () => crypto.randomUUID(),
  ) {}

  async projection<T>(path: string, now = Date.now()): Promise<T> {
    return this.send<T>("GET", path, undefined, now);
  }

  async submitIntent<T>(path: string, intent: GovernedIntentRequest, now = Date.now()): Promise<T> {
    if (intent.company_id !== this.context.company_id || intent.actor_id !== this.context.actor_id ||
        !nonEmpty(intent.capability_id) || !nonEmpty(intent.operation_id) || !nonEmpty(intent.correlation_id)) {
      throw new Error("directadmin-intent-context-mismatch");
    }
    return this.send<T>("POST", path, intent, now);
  }

  private async send<T>(method: "GET" | "POST", path: string, body?: unknown, now = Date.now()): Promise<T> {
    if (!validateDirectAdminCompanyContext(this.context, this.context.company_id, this.context.session_revision, now)) {
      throw new Error("directadmin-context-expired-or-invalid");
    }
    if (!path.startsWith("/v1/") || path.startsWith("//") || path.includes("\\") || /[?#]/.test(path) ||
        path.split("/").some((part) => part === ".." || part === ".")) throw new Error("invalid-titan-api-path");
    const headers: Record<string, string> = {
      Accept: "application/json", "X-Titan-Request-ID": this.requestId(),
      "X-Titan-Correlation-ID": body && typeof body === "object" && "correlation_id" in body
        ? String((body as { correlation_id: unknown }).correlation_id) : this.requestId(),
      "X-Titan-Company-ID": this.context.company_id,
      "X-Titan-Actor-ID": this.context.actor_id,
      "X-Titan-Context-Revision": this.context.session_revision,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.fetcher(path, {
      method, credentials: "same-origin", redirect: "error", cache: "no-store", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`titan-api-http-${response.status}`);
    return await response.json() as T;
  }
}

/** Entitlement, provider reachability and effective execution authority are distinct facts. */
export type PluginAvailability = Readonly<{
  entitled: boolean | "unknown";
  capability_available: boolean | "unknown";
  effective_authority: "not-checked" | "allowed" | "denied" | "unknown";
}>;

const SENSITIVE_KEY = /(?:authorization|token|cookie|csrf|session.?id|secret|password|credential|private.?key|api.?key)/i;
const SENSITIVE_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+|\b(?:proxy-)?authorization\s*[:=]\s*Basic\s+[A-Za-z0-9._~+/=-]+|\b(?:x-titan-csrf|csrf(?:[-_]?token)?)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi;
export function redactDirectAdminDiagnostics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDirectAdminDiagnostics);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactDirectAdminDiagnostics(child)]));
  }
  return typeof value === "string" ? value.replace(SENSITIVE_VALUE, "[REDACTED]").replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]') : value;
}
export type CockpitWidget = Readonly<{
  id: string;
  title: string;
  status: "loading" | "ready" | "empty" | "stale" | "degraded" | "unavailable" | "permission-denied";
  source: string;
  freshness: string | null;
  deep_link: string | null;
  permitted_actions: readonly string[];
  evidence_refs: readonly string[];
}>;
export type CockpitContribution = Readonly<{
  plugin_id: string;
  plugin_version: string;
  sdk_compatibility: string;
  navigation: readonly Readonly<{ id: string; label: string; route: string; roles: readonly DirectAdminRole[]; entitlement?: string }>[];
  widgets: readonly CockpitWidget[];
}>;
export type ContributionRegistrySnapshot = Readonly<{
  contributions: readonly CockpitContribution[];
  degraded_plugins: Readonly<Record<string, string>>;
}>;

function validRoute(route: string): boolean {
  return route.startsWith("/") && !route.startsWith("//") && !route.includes("\\") && !/[?#]/.test(route) &&
    route.split("/").every((part) => part !== ".." && part !== ".");
}

/** Invalid extensions are isolated so one broken plugin cannot blank the shared cockpit. */
export class DirectAdminContributionRegistry {
  #items = new Map<string, CockpitContribution>();
  #degraded = new Map<string, string>();
  #supportedSdkMajor: string;

  constructor(sdkCompatibilityVersion = DIRECTADMIN_SDK_COMPATIBILITY_VERSION) {
    const version = VERSION.exec(sdkCompatibilityVersion);
    if (!version) throw new Error("invalid-sdk-compatibility-version");
    this.#supportedSdkMajor = version[1];
  }

  register(contribution: CockpitContribution): void {
    const pluginId = String(contribution?.plugin_id ?? "");
    try {
      const compatibility = VERSION.exec(contribution.sdk_compatibility);
      if (!ID.test(pluginId) || !VERSION.test(contribution.plugin_version) || !compatibility) {
        throw new Error("invalid-plugin-version-or-id");
      }
      if (compatibility[1] !== this.#supportedSdkMajor) {
        throw new Error(`sdk-compatibility-mismatch:required-major-${compatibility[1]}:supported-major-${this.#supportedSdkMajor}`);
      }
      if (this.#items.has(pluginId)) throw new Error("duplicate-plugin-contribution");
      const navIds = new Set<string>();
      for (const item of contribution.navigation) {
        if (!nonEmpty(item.id) || !nonEmpty(item.label) || !validRoute(item.route) || navIds.has(item.id) ||
            !item.roles.length || item.roles.some((role) => !["admin", "reseller", "user"].includes(role))) {
          throw new Error("invalid-navigation-contribution");
        }
        navIds.add(item.id);
      }
      const widgetIds = new Set<string>();
      for (const widget of contribution.widgets) {
        if (!nonEmpty(widget.id) || widgetIds.has(widget.id) || !nonEmpty(widget.title) || !nonEmpty(widget.source) ||
            !["loading", "ready", "empty", "stale", "degraded", "unavailable", "permission-denied"].includes(widget.status)) {
          throw new Error("invalid-widget-contribution");
        }
        if (widget.deep_link !== null && !validRoute(widget.deep_link)) throw new Error("invalid-widget-deep-link");
        widgetIds.add(widget.id);
      }
      this.#items.set(pluginId, structuredClone(contribution));
      this.#degraded.delete(pluginId);
    } catch (error) {
      this.#degraded.set(pluginId || "unknown", error instanceof Error ? error.message : "invalid-contribution");
    }
  }

  snapshot(): ContributionRegistrySnapshot {
    return Object.freeze({
      contributions: Object.freeze([...this.#items.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item)),
      degraded_plugins: Object.freeze(Object.fromEntries([...this.#degraded.entries()].sort(([a], [b]) => a.localeCompare(b)))),
    });
  }
}
