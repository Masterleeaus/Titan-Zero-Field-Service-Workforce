export type SessionBinding = Readonly<{
  session_id: string; company_id: string; actor_id: string; device_id: string;
  issued_at: string; expires_at: string; revoked: boolean; revision: number;
}>;
export type SecureEnvelope = Readonly<{
  company_id: string; session_id: string; actor_id: string;
  role: "user" | "system"; payload: Readonly<Record<string, unknown>>;
}>;
const secret = /access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|private[_-]?key|authorization/i;

export function requireSecurityId(value: string, name: string): void {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name}-required`);
  }
}

export function requireSecurityRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("session-revision-invalid");
}

export function securityTimestamp(value: string): number {
  const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error("session-timestamp-invalid");
  const [, y, m, d, h, min, sec] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(h) > 23 || Number(min) > 59 || Number(sec) > 59) throw new Error("session-timestamp-invalid");
  return parsed;
}

function validateBinding(binding: SessionBinding): void {
  for (const key of ["session_id", "company_id", "actor_id", "device_id"] as const) requireSecurityId(binding[key], key);
  requireSecurityRevision(binding.revision);
  if (typeof binding.revoked !== "boolean") throw new Error("session-revocation-invalid");
  if (securityTimestamp(binding.expires_at) <= securityTimestamp(binding.issued_at)) throw new Error("session-lifetime-invalid");
}

export function createSessionBinding(input: Omit<SessionBinding, "revision">): SessionBinding {
  const binding = { ...input, revision: 1 };
  validateBinding(binding);
  return Object.freeze(binding);
}

/** Pure validation only. Hosted requests must also resolve the durable current session. */
export function validateSession(binding: SessionBinding, company_id: string, now: string): void {
  validateBinding(binding);
  requireSecurityId(company_id, "company_id");
  const at = securityTimestamp(now);
  if (binding.company_id !== company_id) throw new Error("session-company-mismatch");
  if (binding.revoked) throw new Error("session-revoked");
  if (at < securityTimestamp(binding.issued_at)) throw new Error("session-not-yet-valid");
  if (at >= securityTimestamp(binding.expires_at)) throw new Error("session-expired");
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, secret.test(key) ? "[REDACTED]" : redactSecrets(v)]));
  return value;
}

export function createSecureEnvelope(binding: SessionBinding, company_id: string, payload: Record<string, unknown>, requestedRole: string, now: string): SecureEnvelope {
  validateSession(binding, company_id, now);
  if (requestedRole !== "user") throw new Error("untrusted-role-rejected");
  return Object.freeze({ company_id, session_id: binding.session_id, actor_id: binding.actor_id, role: "user", payload: redactSecrets(payload) as Record<string, unknown> });
}

export { createIdentitySessionRegistry, openIdentitySessionRegistry, initializeDirectAdminBootstrapNonceStore, IdentitySessionRegistry } from './security-session-registry.js';
export type { VerifiedSessionIdentity, SessionSourceReference, ExpectedSessionContext, CurrentSessionContext, IssueSessionInput,
  DirectAdminBootstrapNonceIssue, DirectAdminBootstrapNonceIdentityIssue, DirectAdminBootstrapNonceIssued,
  DirectAdminBootstrapNonceIssuedSelection, DirectAdminBootstrapNonceConsume, DirectAdminBootstrapNonceSelection,
  CurrentCompanyMembership, IdentityStatus } from './security-session-registry.js';
export { createSessionCredentialService, createSessionCredentialVerifier, directAdminIssuer, parseDirectAdminSessionInfo,
  projectDirectAdminSessionIdentity, createDirectAdminBootstrapAssertionProvider } from './security-session-credentials.js';
export type { CredentialExpectation, SessionCredentialOptions, IssuedSessionCredential, AuthenticatedSessionCredential,
  MembershipMutation,
  DirectAdminAssertionTrust, DirectAdminCredentialBinding, DirectAdminSessionRole, DirectAdminSessionInfo,
  DirectAdminExternalSessionIdentity, DirectAdminBootstrapProofEnvelope, DirectAdminBootstrapContextRequest,
  DirectAdminBootstrapSelection, DirectAdminBootstrapNonceConsumer, DirectAdminLoginAssertionInput,
  DirectAdminSessionApiFetch, DirectAdminBootstrapAssertionProviderOptions, DirectAdminLoginAssertionProvider,
  WorkforceZeroExchangeOptions } from './security-session-credentials.js';
export { createDirectAdminBootstrapNonceIssuer, createDirectAdminBootstrapNonceConsumer,
  createDirectAdminBootstrapFlow } from './security-directadmin-bootstrap-nonces.js';
export type { DirectAdminBootstrapNonceIssuerProof, DirectAdminBootstrapNonceIssuerOptions,
  DirectAdminBootstrapNonceIssuerIdentityProof, DirectAdminBootstrapFlowOptions,
  DirectAdminBootstrapFlow } from './security-directadmin-bootstrap-nonces.js';
