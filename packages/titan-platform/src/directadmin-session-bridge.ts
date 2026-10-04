import type { AuthenticatedSessionCredential, createSessionCredentialService,
  DirectAdminBootstrapProofEnvelope, DirectAdminLoginAssertionInput, DirectAdminLoginAssertionProvider } from './security-boundary.js';
import type { DirectAdminRole } from './directadmin-plugin.js';

/** Trusted host composition supplies the canonical #302 credential service.
 * The SDK owns no signature parser, issuer, keys, identity store or provisioning.
 * It adds DirectAdmin browser protections around that authenticated boundary. */
export type DirectAdminBridgeConfig = Readonly<{
  origin: string; audience: string; node_id: string;
  sessions: Pick<ReturnType<typeof createSessionCredentialService>, 'issue' | 'authenticate' | 'switchCompany' | 'revoke' | 'exchangeWorkforceZero'>;
}>;
type WorkforceZeroIssuance = Awaited<ReturnType<DirectAdminBridgeConfig['sessions']['exchangeWorkforceZero']>>;
type CompanySessionIssuance = Awaited<ReturnType<DirectAdminBridgeConfig['sessions']['switchCompany']>>;
export type DirectAdminBridgeContext = Readonly<{
  schema: 'titan.directadmin.session/v1'; actor_id: string; company_id: string;
  company_ids: readonly string[]; context_revision: string; session_revision: number;
  expires_at: number; da_role: DirectAdminRole; authority: 'not-carried';
}>;
/** Selected-company identity for the fixed #302 Workforce/Zero child. The
 * credential itself is supplied only inside a trusted server-side callback. */
export type WorkforceZeroBridgeContext = Readonly<{
  schema: 'titan.workforce-zero.session/v1'; audience: 'workforce'; surface: 'zero';
  actor_id: string; company_id: string; company_ids: readonly string[]; device_id: string;
  session_id: string; context_revision: string; session_revision: number; expires_at: number;
}>;
export type WithWorkforceZeroSession = <T>(
  consume: (credential: string, context: WorkforceZeroBridgeContext) => Promise<T>,
) => Promise<T>;
const COOKIE = '__Host-titan-da-session';
type DirectAdminBridgeFailureKind = 'request-rejected' | 'session-rejected' | 'unavailable' |
  'session-rejected-clear-cookie' | 'unavailable-clear-cookie' | 'session-binding-mismatch';
// tsx fixtures and separately bundled gateway/bridge modules can load through
// distinct module instances, so use a private, non-enumerable symbol marker.
const bridgeFailureMarker = Symbol.for('titan.directadmin.bridge.failure.v1');
function bridgeError(kind: DirectAdminBridgeFailureKind, message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, bridgeFailureMarker, { value: kind });
  return error;
}
export function directAdminBridgeFailureKind(error: unknown): DirectAdminBridgeFailureKind | undefined {
  try {
    if (!(error instanceof Error)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, bridgeFailureMarker);
    return descriptor && 'value' in descriptor && ['request-rejected', 'session-rejected', 'unavailable',
      'session-rejected-clear-cookie', 'unavailable-clear-cookie', 'session-binding-mismatch'].includes(descriptor.value)
      ? descriptor.value as DirectAdminBridgeFailureKind : undefined;
  } catch { return undefined; }
}
const fail = (): never => { throw bridgeError('session-rejected', 'directadmin-session-rejected'); };
const failAndClear = (): never => { throw bridgeError('session-rejected-clear-cookie', 'directadmin-session-rejected'); };
const rejectRequest = (): never => { throw bridgeError('request-rejected', 'directadmin-session-rejected-request'); };
const unavailable = (): never => { throw bridgeError('unavailable', 'directadmin-service-unavailable'); };
const unavailableAndClear = (): never => { throw bridgeError('unavailable-clear-cookie', 'directadmin-service-unavailable'); };
const bindingMismatch = (): never => { throw bridgeError('session-binding-mismatch', 'directadmin-session-binding-mismatch'); };
function safeErrorMessage(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error)) return undefined;
    const message = Object.getOwnPropertyDescriptor(error, 'message');
    return message && 'value' in message && typeof message.value === 'string' ? message.value : undefined;
  } catch { return undefined; }
}
function normalizeAuthenticationFailure(error: unknown): never {
  const message = safeErrorMessage(error);
  if (message === 'directadmin-session-rejected-request') return rejectRequest();
  if (message === 'directadmin-session-rejected' || message === 'authentication-denied') return fail();
  if (message === 'identity-registry-unavailable' || message === 'directadmin-service-unavailable') return unavailable();
  return unavailable();
}
async function normalizePostAuthenticationFailure(_error: unknown, verifyCurrent: () => Promise<unknown>): Promise<never> {
  // A fresh canonical read distinguishes an explicitly rejected/revoked source
  // (401) from the registry's sanitized availability failure (503). Hide the
  // original operation failure in either case.
  try { await verifyCurrent(); } catch (verificationError) { return normalizeAuthenticationFailure(verificationError); }
  return unavailable();
}
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\u0000-\u0020\u007f]/u.test(v);
function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
async function csrfDigest(value: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
/** Identity contract aliases come from canonical #302; the SDK adds only its
 * browser/session boundary and never creates a second bootstrap assertion. */
export type DirectAdminBootstrapInput = DirectAdminLoginAssertionInput;
export type DirectAdminBootstrapRequestProof = DirectAdminBootstrapProofEnvelope;
function validBootstrapInput(value: unknown): value is DirectAdminBootstrapInput {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 4 || keys.some(key => typeof key !== 'string' ||
        !['login_assertion', 'company_id', 'device_id', 'csrf_token'].includes(key))) return false;
    const fields = Object.getOwnPropertyDescriptors(value);
    const values = Object.fromEntries(keys.map(key => {
      const descriptor = fields[key as string];
      return [key as string, descriptor && 'value' in descriptor ? descriptor.value : undefined];
    }));
    return typeof values.login_assertion === 'string' && values.login_assertion.length > 0 &&
      values.login_assertion.length <= 16384 && id(values.company_id) && id(values.device_id) &&
      typeof values.csrf_token === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(values.csrf_token);
  } catch { return false; }
}
/** Short, versioned transport assertion for the canonical revision. #302's
 * revision is an opaque JSON snapshot string; the DirectAdmin relay accepts
 * bounded URL-safe identifiers only. This digest carries no authority and is
 * compared with the freshly authenticated canonical revision at the gateway. */
export async function directAdminContextRevisionAssertion(revision: string): Promise<string> {
  if (typeof revision !== 'string' || revision.length === 0 || revision.length > 4096) {
    throw new Error('directadmin-context-revision-invalid');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(revision));
  return `ctx1_${encode(new Uint8Array(digest))}`;
}
export async function matchesDirectAdminContextRevision(assertion: unknown, revision: string): Promise<boolean> {
  if (assertion === revision) return true; // compatibility for direct, non-relayed callers
  if (typeof assertion !== 'string' || !/^ctx1_[A-Za-z0-9_-]{43}$/.test(assertion)) return false;
  return assertion === await directAdminContextRevisionAssertion(revision);
}
function cookie(request: Request): string {
  const values = (request.headers.get('cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return fail();
  const credential = values[0].slice(COOKIE.length + 1);
  if (!credential || credential.length > 16384) return fail();
  return credential;
}

type BootstrapCookies = Readonly<{ titanCredential?: string; directAdminCookie: string | null }>;
/** Remove Titan's HttpOnly bearer before the remaining DirectAdmin cookies are
 * passed to the trusted host provider. Cookie headers are untrusted input. */
function bootstrapCookies(request: Request): BootstrapCookies {
  const header = request.headers.get('cookie');
  if (header === null || header === '') return Object.freeze({ directAdminCookie: null });
  if (header.length > 16384 || /[\r\n\u0000]/.test(header)) return rejectRequest();
  const passThrough: string[] = [];
  let titanCredential: string | undefined;
  for (const raw of header.split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const separator = part.indexOf('=');
    if (separator <= 0) return rejectRequest();
    const name = part.slice(0, separator).trim();
    if (name === COOKIE) {
      if (titanCredential !== undefined) return rejectRequest();
      titanCredential = part.slice(separator + 1);
      if (!titanCredential || titanCredential.length > 16384) return rejectRequest();
    } else passThrough.push(part);
  }
  const directAdminCookie = passThrough.length ? passThrough.join('; ') : null;
  if (directAdminCookie && directAdminCookie.length > 8192) return rejectRequest();
  return Object.freeze({ ...(titanCredential === undefined ? {} : { titanCredential }), directAdminCookie });
}
function usableDirectAdminSession(authenticated: AuthenticatedSessionCredential, provider: string, audience: string, nodeId: string): boolean {
  const binding = authenticated.directadmin;
  return authenticated.provider === provider && id(authenticated.subject) && authenticated.context.audience === audience &&
    binding?.node_id === nodeId && /^[A-Za-z0-9_-]{43}$/.test(binding.csrf_sha256) &&
    ['admin', 'reseller', 'user'].includes(binding.da_role) &&
    id(authenticated.context.session_id) && id(authenticated.context.actor_id) &&
    id(authenticated.context.company_id) && id(authenticated.context.device_id) &&
    typeof authenticated.context.context_revision === 'string' && authenticated.context.context_revision.length > 0 &&
    authenticated.context.context_revision.length <= 4096 &&
    Number.isSafeInteger(authenticated.context.session_revision) && authenticated.context.session_revision > 0 &&
    Number.isFinite(Date.parse(authenticated.context.expires_at));
}
function bootstrapFailureFor(error: unknown, staleCookie: boolean): never {
  const message = safeErrorMessage(error);
  if (message === 'directadmin-session-rejected-request') return rejectRequest();
  if (message === 'directadmin-session-rejected' || message === 'authentication-denied') {
    return staleCookie ? failAndClear() : fail();
  }
  return staleCookie ? unavailableAndClear() : unavailable();
}
async function hasEmptyBody(request: Request): Promise<boolean> {
  const reader = request.body?.getReader();
  if (!reader) return true;
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 5000);
  let empty = false;
  try {
    const first = await reader.read();
    empty = first.done && !timedOut;
  } catch { /* malformed or aborted bodies fail closed */ }
  finally {
    clearTimeout(deadline);
    if (!empty) void reader.cancel().catch(() => {});
  }
  return empty;
}

/** Retains the opaque credential and calls #302 again on every revalidation.
 * Caller IDs, company headers, DA roles and session IDs never grant authority. */
export class DirectAdminSessionBridge {
  readonly #config: DirectAdminBridgeConfig;
  readonly #provider: string;
  constructor(config: DirectAdminBridgeConfig) {
    const origin = new URL(config.origin);
    if (origin.protocol !== 'https:' || origin.origin !== config.origin || !id(config.audience) || !id(config.node_id) ||
        !['issue', 'authenticate', 'switchCompany', 'revoke', 'exchangeWorkforceZero'].every(method => typeof config.sessions?.[method as keyof typeof config.sessions] === 'function')) fail();
    // This is only the expected namespace check; #302 remains the sole
    // credential authenticator. Keep the browser-shared SDK free of the
    // server-only security-boundary barrel and its storage/Node dependencies.
    const provider = `directadmin:${origin.origin}`;
    this.#provider = provider;
    this.#config = Object.freeze({ ...config });
  }
  /**
   * Exchange a trusted DirectAdmin login assertion for a browser session
   * cookie. On document reload the same flow renews a canonically current
   * session after the host reauthenticates its DirectAdmin cookie. The assertion,
   * selected company/device expectations and CSRF nonce must come from the
   * authenticated DirectAdmin adapter, never from caller identity headers or
   * a browser-supplied role/session ID. #302 verifies the assertion and resolves
   * the existing actor, company membership, device and current revisions.
   *
   * The trusted provider consumes the one-time pre-authentication CSRF nonce,
   * authenticates the DirectAdmin session proof and returns a signed assertion,
   * canonical selected company/device and a fresh CSRF token bound into that
   * assertion. The browser supplies no identity fields. The returned credential
   * is only in the Secure HttpOnly cookie; the CSRF token is returned separately
   * for the browser client. No identity store or assertion signer lives here.
   * A reload nonce is never treated as the prior session's CSRF token. The
   * prior Titan cookie is authenticated only by #302, then stripped before the
   * remaining DirectAdmin cookies reach the host provider. Outages preserve a
   * still-current prior session; successful renewal rotates it only after the
   * replacement is reauthenticated and bound to the same provider, subject,
   * actor and device.
   */
  async bootstrapBrowserSession(
    request: Request,
    bootstrapProvider: DirectAdminLoginAssertionProvider | undefined,
  ): Promise<Readonly<{ set_cookie: string; csrf_token: string }>> {
    let url: URL;
    try { url = new URL(request.url); } catch { return rejectRequest(); }
    const csrfNonce = request.headers.get('x-titan-da-bootstrap-csrf') ?? '';
    const contentLength = request.headers.get('content-length');
    if (request.method !== 'POST' || url.origin !== this.#config.origin || url.pathname !== '/v1/directadmin/bootstrap' ||
        url.search || url.hash || request.headers.get('origin') !== this.#config.origin ||
        request.headers.get('sec-fetch-site') !== 'same-origin' || request.headers.has('content-encoding') ||
        (contentLength !== null && !/^0+$/.test(contentLength)) ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(csrfNonce)) {
      return rejectRequest();
    }
    if (!await hasEmptyBody(request)) return rejectRequest();
    if (!bootstrapProvider || typeof bootstrapProvider.provide !== 'function') return unavailable();

    // Origin, Fetch Metadata, the empty request body and nonce syntax are
    // checked before canonical identity reads or the trusted provider run.
    const cookies = bootstrapCookies(request);
    let previous: AuthenticatedSessionCredential | undefined;
    let staleCookie = false;
    if (cookies.titanCredential !== undefined) {
      let current: AuthenticatedSessionCredential;
      try {
        current = await this.#config.sessions.authenticate(cookies.titanCredential);
      } catch (error) {
        const message = safeErrorMessage(error);
        if (message === 'identity-registry-unavailable' || message === 'directadmin-service-unavailable') return unavailable();
        if (message === 'authentication-denied' || message === 'directadmin-session-rejected') staleCookie = true;
        else return unavailable();
      }
      if (!staleCookie) {
        // Canonical authentication succeeded, so this is not an expired or
        // rejected credential. A binding mismatch must stop renewal and keep
        // the cookie intact; otherwise a provider response could replace a
        // verified identity with an unrelated session.
        if (!usableDirectAdminSession(current!, this.#provider, this.#config.audience, this.#config.node_id)) return bindingMismatch();
        previous = current!;
      }
    }

    // Authorization is not part of the DirectAdmin browser-session proof. The
    // host provider authenticates filtered cookies against its configured HTTPS
    // /api/session endpoint; browser bearer headers are never forwarded.
    const proof: DirectAdminBootstrapRequestProof = Object.freeze({
      origin: request.headers.get('origin')!,
      cookie: cookies.directAdminCookie,
      authorization: null,
      csrf_nonce: csrfNonce,
    });
    let input: unknown;
    try { input = await bootstrapProvider.provide(proof); }
    catch (error) { return bootstrapFailureFor(error, staleCookie); }
    if (!validBootstrapInput(input)) return rejectRequest();

    // These expectations must be obtained by the trusted DirectAdmin adapter;
    // #302 additionally matches them to signed assertion claims and registry truth.
    const expected = Object.freeze({ company_id: input.company_id, device_id: input.device_id });
    let csrfHash: string;
    try { csrfHash = await csrfDigest(input.csrf_token); }
    catch { return staleCookie ? unavailableAndClear() : unavailable(); }
    let issued: Awaited<ReturnType<DirectAdminBridgeConfig['sessions']['issue']>>;
    try { issued = await this.#config.sessions.issue(input.login_assertion, expected); }
    catch (error) { return bootstrapFailureFor(error, staleCookie); }

    // Read the freshly issued credential back through #302 before setting a
    // browser cookie. This proves issuer, audience, node, nonce and current state.
    let authenticated: AuthenticatedSessionCredential;
    try { authenticated = await this.#config.sessions.authenticate(issued.credential, expected); }
    catch (error) { return bootstrapFailureFor(error, staleCookie); }
    const context = authenticated.context;
    const issuedContext = issued.context;
    const binding = authenticated.directadmin;
    if (authenticated.provider !== this.#provider || !id(authenticated.subject) || context.audience !== this.#config.audience ||
        !id(context.session_id) || !id(context.actor_id) || !id(context.company_id) || !id(context.device_id) ||
        typeof context.context_revision !== 'string' || !context.context_revision || context.context_revision.length > 4096 ||
        !Number.isSafeInteger(context.session_revision) || context.session_revision < 1 ||
        context.company_id !== input.company_id || context.device_id !== input.device_id ||
        !binding || binding.node_id !== this.#config.node_id || binding.csrf_sha256 !== csrfHash ||
        !['admin', 'reseller', 'user'].includes(binding.da_role) ||
        context.session_id !== issuedContext.session_id || context.actor_id !== issuedContext.actor_id ||
        context.company_id !== issuedContext.company_id || context.device_id !== issuedContext.device_id ||
        context.session_revision !== issuedContext.session_revision || context.context_revision !== issuedContext.context_revision) {
      try { await this.#config.sessions.revoke(issued.credential, expected); }
      catch { return staleCookie ? unavailableAndClear() : unavailable(); }
      return staleCookie ? failAndClear() : fail();
    }
    if (previous && (authenticated.provider !== previous.provider || authenticated.subject !== previous.subject ||
        context.actor_id !== previous.context.actor_id || context.device_id !== previous.context.device_id ||
        context.session_id === previous.context.session_id)) {
      try { await this.#config.sessions.revoke(issued.credential, expected); }
      catch { return unavailable(); }
      return bindingMismatch();
    }
    const expiresAt = Math.min(Date.parse(context.expires_at), Date.parse(authenticated.credential_expires_at));
    const seconds = Math.min(300, Math.floor((expiresAt - Date.now()) / 1000));
    if (!Number.isFinite(seconds) || seconds <= 0 || /[;\r\n]/.test(issued.credential)) {
      try { await this.#config.sessions.revoke(issued.credential, expected); }
      catch { return staleCookie ? unavailableAndClear() : unavailable(); }
      return staleCookie ? failAndClear() : fail();
    }
    if (previous && cookies.titanCredential !== undefined) {
      try {
        await this.#config.sessions.revoke(cookies.titanCredential, {
          company_id: previous.context.company_id, device_id: previous.context.device_id,
          actor_id: previous.context.actor_id, context_revision: previous.context.context_revision,
        });
      } catch (error) {
        // A concurrent expiry/revoke already removed the old session; all other
        // failures are sanitized outages and do not deliver the new cookie.
        const message = safeErrorMessage(error);
        if (message !== 'authentication-denied' && message !== 'directadmin-session-rejected') return unavailable();
      }
    }
    return Object.freeze({
      set_cookie: `${COOKIE}=${issued.credential}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`,
      csrf_token: input.csrf_token,
    });
  }
  async authenticate(request: Request): Promise<{
    context: DirectAdminBridgeContext;
    revalidate: () => Promise<DirectAdminBridgeContext>;
    withWorkforceZeroSession: WithWorkforceZeroSession;
    switchCompany: (company_id: string) => Promise<Readonly<{ set_cookie: string }>>;
    logout: () => Promise<void>;
  }> {
    try {
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      let refererSameOrigin = false;
      if (origin === null && request.method === 'GET') {
        try { refererSameOrigin = new URL(request.headers.get('referer') ?? '').origin === this.#config.origin; } catch { /* reject below */ }
      }
      const sameOrigin = origin === this.#config.origin || refererSameOrigin;
      if (url.origin !== this.#config.origin || request.headers.get('sec-fetch-site') !== 'same-origin' ||
          !sameOrigin || !['GET', 'POST'].includes(request.method)) return rejectRequest();
      const credential = cookie(request);
      const csrf = request.headers.get('x-titan-csrf') ?? '';
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(csrf)) return rejectRequest();
      const csrfHash = await csrfDigest(csrf);
      const check = (authenticated: AuthenticatedSessionCredential): AuthenticatedSessionCredential => {
        // Also reject a miswired canonical service for a different host/audience.
        if (authenticated.provider !== this.#provider || authenticated.context.audience !== this.#config.audience ||
            authenticated.directadmin?.node_id !== this.#config.node_id ||
            authenticated.directadmin.csrf_sha256 !== csrfHash) return fail();
        return authenticated;
      };
      const initial = check(await this.#config.sessions.authenticate(credential));
      const expected = Object.freeze({ company_id: initial.context.company_id, device_id: initial.context.device_id,
        actor_id: initial.context.actor_id, context_revision: initial.context.context_revision });
      const authenticateCurrent = async () => check(await this.#config.sessions.authenticate(credential, expected));
      const project = ({ context: current, directadmin }: AuthenticatedSessionCredential): DirectAdminBridgeContext => Object.freeze({
        schema: 'titan.directadmin.session/v1', actor_id: current.actor_id, company_id: current.company_id,
        company_ids: Object.freeze([current.company_id]), context_revision: current.context_revision,
        session_revision: current.session_revision, expires_at: Date.parse(current.expires_at),
        da_role: directadmin!.da_role, authority: 'not-carried',
      });
      const revalidate = async () => {
        try { return project(await authenticateCurrent()); }
        catch (error) { return normalizeAuthenticationFailure(error); }
      };
      const withWorkforceZeroSession: WithWorkforceZeroSession = async consume => {
        if (request.method !== 'POST' || typeof consume !== 'function') return fail();
        let source: AuthenticatedSessionCredential;
        let exchanged: Readonly<{ credential: string; context: WorkforceZeroBridgeContext }>;
        try {
          source = await authenticateCurrent();
        } catch (error) { return normalizeAuthenticationFailure(error); }
        let issued: WorkforceZeroIssuance;
        try { issued = await this.#config.sessions.exchangeWorkforceZero(credential, expected); }
        catch (error) { return normalizePostAuthenticationFailure(error, authenticateCurrent); }
        try {
          // Recheck the browser session after exchange and before handing the
          // child to a trusted server owner. The downstream Workforce verifier
          // and effect fence still revalidate the signed source lineage.
          await authenticateCurrent();
          const child = issued.context;
          const credentialExpiry = Date.parse(issued.credential_expires_at);
          const sourceExpiry = Date.parse(source.credential_expires_at);
          const childSessionExpiry = Date.parse(child.expires_at);
          if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(issued.credential) ||
              issued.credential.length > 16384 || child.audience !== 'workforce' ||
              child.session_id === source.context.session_id || child.company_id !== source.context.company_id ||
              child.actor_id !== source.context.actor_id || child.device_id !== source.context.device_id ||
              !Array.isArray(child.allowed_company_ids) || child.allowed_company_ids.length !== 1 ||
              child.allowed_company_ids[0] !== child.company_id || !id(child.context_revision) ||
              !Number.isSafeInteger(child.session_revision) || child.session_revision < 1 ||
              !Number.isFinite(credentialExpiry) || !Number.isFinite(sourceExpiry) || !Number.isFinite(childSessionExpiry) ||
              credentialExpiry > sourceExpiry || credentialExpiry > childSessionExpiry) return unavailable();
          const context: WorkforceZeroBridgeContext = Object.freeze({
            schema: 'titan.workforce-zero.session/v1', audience: 'workforce', surface: 'zero',
            actor_id: child.actor_id, company_id: child.company_id, company_ids: Object.freeze([child.company_id]),
            device_id: child.device_id, session_id: child.session_id, context_revision: child.context_revision,
            session_revision: child.session_revision, expires_at: childSessionExpiry,
          });
          exchanged = Object.freeze({ credential: issued.credential, context });
        } catch (error) {
          if (safeErrorMessage(error) === 'directadmin-session-rejected' || safeErrorMessage(error) === 'authentication-denied') {
            return normalizeAuthenticationFailure(error);
          }
          return unavailable();
        }
        // The owner may return a typed, read-only denial (for example when
        // Workforce intentionally does not support an action). Preserve that
        // contract only while the originating DirectAdmin session is current.
        // If the source was revoked/switched during the callback, the session
        // failure takes precedence and the owner's error remains redacted.
        let result: unknown;
        try { result = await consume(exchanged.credential, exchanged.context); }
        catch (error) {
          try { await authenticateCurrent(); } catch (verificationError) { return normalizeAuthenticationFailure(verificationError); }
          throw error;
        }
        try { await authenticateCurrent(); } catch (error) { return normalizeAuthenticationFailure(error); }
        return result as Awaited<ReturnType<typeof consume>>;
      };
      return Object.freeze({ context: project(initial), revalidate, withWorkforceZeroSession,
        switchCompany: async (company_id: string) => {
          if (request.method !== 'POST' || !id(company_id)) return fail();
          await revalidate();
          let issued: CompanySessionIssuance;
          try { issued = await this.#config.sessions.switchCompany(credential, expected, company_id); }
          catch (error) { return normalizePostAuthenticationFailure(error, authenticateCurrent); }
          try {
            const current = check(await this.#config.sessions.authenticate(issued.credential, {
              company_id, device_id: expected.device_id, actor_id: expected.actor_id,
              context_revision: issued.context.context_revision,
            }));
            const seconds = Math.min(300, Math.floor((Date.parse(current.context.expires_at) - Date.now()) / 1000));
            if (!Number.isFinite(seconds) || seconds <= 0 || /[;\r\n]/.test(issued.credential)) return unavailable();
            // Server-only result: the gateway writes this header, never JSON.
            // #302 owns issuance; switching does not extend canonical expiry.
            return Object.freeze({ set_cookie: `${COOKIE}=${issued.credential}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}` });
          } catch (error) {
            const message = safeErrorMessage(error);
            if (message === 'authentication-denied' || message === 'directadmin-session-rejected') {
              return normalizeAuthenticationFailure(error);
            }
            if (message === 'identity-registry-unavailable' || message === 'directadmin-service-unavailable') return unavailable();
            return normalizePostAuthenticationFailure(error, authenticateCurrent);
          }
        },
        logout: async () => {
          if (request.method !== 'POST') return fail();
          await revalidate();
          try { await this.#config.sessions.revoke(credential, expected); }
          catch (error) { return normalizePostAuthenticationFailure(error, authenticateCurrent); }
        },
      });
    } catch (error) { return normalizeAuthenticationFailure(error); }
  }
}

export const DIRECTADMIN_RESPONSE_HEADERS = Object.freeze({
  'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  'x-frame-options': 'SAMEORIGIN',
});
export const DIRECTADMIN_CLEAR_SESSION_COOKIE = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
