import { DirectAdminSessionBridge, DIRECTADMIN_RESPONSE_HEADERS, DIRECTADMIN_CLEAR_SESSION_COOKIE,
  directAdminBridgeFailureKind, matchesDirectAdminContextRevision,
  type DirectAdminBridgeContext, type WithWorkforceZeroSession } from './directadmin-session-bridge.js';
import type { GovernedIntentRequest } from './directadmin-plugin.js';
import type { DirectAdminLoginAssertionProvider } from './security-boundary.js';

export type DirectAdminPluginId = 'titan_zero' | 'titan_workforce' | 'titan_operations' | 'titan_web';
export type DirectAdminProjection = Readonly<{
  company_id: string; source: string; freshness: string | null;
  evidence_refs: readonly string[]; data: unknown;
}>;

/** Read-only Workforce receipt backed by the canonical accepted-evidence owner.
 * An SDK receipt is provenance for a result already verified by Workforce; it
 * does not authorize or execute an action. */
export type DirectAdminWorkforceReceipt = Readonly<{
  schema: 'titan.directadmin.workforce-receipt.v1';
  company_id: string;
  receipt_id: string;
  operation_id: string;
  correlation_id: string;
  work_id: string;
  run_id?: string;
  state: 'VERIFIED';
  verification_status: 'verified';
  verification_method: 'company-scoped-workforce-reread-and-reassignment-event';
  evidence_refs: readonly string[];
}>;

const DIRECTADMIN_RECEIPT_ID = /^[A-Za-z0-9:._-]{1,200}$/;
const DIRECTADMIN_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export function isDirectAdminWorkforceReceiptId(value: unknown): value is string {
  return typeof value === 'string' && value !== '.' && value !== '..' &&
    DIRECTADMIN_RECEIPT_ID.test(value) && !DIRECTADMIN_JWT.test(value);
}

/** Validate the typed, owner-backed receipt at both host and browser seams. */
export function assertDirectAdminWorkforceReceipt(
  value: unknown,
  receipt_id: string,
  company_id: string,
): asserts value is DirectAdminWorkforceReceipt {
  try {
    if (!isDirectAdminWorkforceReceiptId(receipt_id) ||
        !value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const required = ['schema', 'company_id', 'receipt_id', 'operation_id', 'correlation_id', 'work_id',
      'state', 'verification_status', 'verification_method', 'evidence_refs'] as const;
    const allowed = new Set<string>([...required, 'run_id']);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !allowed.has(key)) ||
        required.some(key => !Object.hasOwn(value, key))) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const read = (key: string): unknown => {
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) throw new Error();
      return descriptor.value;
    };
    if (read('schema') !== 'titan.directadmin.workforce-receipt.v1' ||
        read('company_id') !== company_id || read('receipt_id') !== receipt_id ||
        read('state') !== 'VERIFIED' || read('verification_status') !== 'verified' ||
        read('verification_method') !== 'company-scoped-workforce-reread-and-reassignment-event') throw new Error();
    for (const key of ['operation_id', 'correlation_id', 'work_id'] as const) {
      const item = read(key);
      if (typeof item !== 'string' || !DIRECTADMIN_RECEIPT_ID.test(item)) throw new Error();
    }
    if (Object.hasOwn(value, 'run_id')) {
      const run_id = read('run_id');
      if (typeof run_id !== 'string' || !DIRECTADMIN_RECEIPT_ID.test(run_id)) throw new Error();
    }
    const evidence_refs = read('evidence_refs');
    if (!Array.isArray(evidence_refs) || evidence_refs.length !== 1 || evidence_refs[0] !== receipt_id) throw new Error();
  } catch {
    throw new Error('directadmin-invalid-workforce-receipt');
  }
}

/** Validate the transport envelope at both ingress and browser boundaries. A
 * correctly stamped outer envelope cannot relabel another company's projection. */
export function assertDirectAdminProjection(value: unknown, company_id: string): asserts value is DirectAdminProjection {
  if (!value || typeof value !== 'object') throw new Error('directadmin-invalid-projection');
  const projection = value as DirectAdminProjection;
  const data = projection.data as Record<string, unknown> | null;
  if (projection.company_id !== company_id || !data || typeof data !== 'object' || Array.isArray(data) ||
      data.company_id !== company_id || typeof data.schema !== 'string' || !data.schema ||
      typeof projection.source !== 'string' || !projection.source.trim() || projection.source.length > 1024 ||
      (projection.freshness !== null && (typeof projection.freshness !== 'string' || !Number.isFinite(Date.parse(projection.freshness)))) ||
      !Array.isArray(projection.evidence_refs) || projection.evidence_refs.length > 256 ||
      projection.evidence_refs.some(ref => typeof ref !== 'string' || !ref.trim() || ref.length > 2048)) {
    throw new Error('directadmin-invalid-projection');
  }
}
/** Composition supplies canonical projection owners and governed intent ingress.
 * revalidate MUST be called again by the execution owner at authorization/effect,
 * including queued work. A successful ingress response is only REQUESTED. */
export type DirectAdminGatewayOwners = Readonly<{
  projection: (plugin: DirectAdminPluginId, context: DirectAdminBridgeContext) => Promise<DirectAdminProjection>;
  /** Current-company/actor-scoped accepted-evidence lookup. Null means unknown
   * or out of scope and must have the same sanitized not-found response. */
  receipt?: (plugin: 'titan_workforce', receipt_id: string,
    context: DirectAdminBridgeContext) => Promise<DirectAdminWorkforceReceipt | null>;
  requestIntent: (plugin: DirectAdminPluginId, intent: GovernedIntentRequest,
    context: DirectAdminBridgeContext, revalidate: () => Promise<DirectAdminBridgeContext>,
    withWorkforceZeroSession: WithWorkforceZeroSession,
    control?: Readonly<{ signal?: AbortSignal }>) => Promise<{ receipt_id: string }>;
}>;
/** The canonical #302 assertion provider. Production composition should pass
 * `createDirectAdminBootstrapFlow(...).provide`; the flow authenticates the
 * DirectAdmin session and consumes the durable, identity-bound nonce. */
export type DirectAdminBootstrapAssertionProvider = DirectAdminLoginAssertionProvider;
const json = (status: number, body: unknown, sessionCookie?: string) => new Response(JSON.stringify(body), {
  status, headers: { ...DIRECTADMIN_RESPONSE_HEADERS, ...(sessionCookie ? { 'set-cookie': sessionCookie } : {}) },
});
/** #811 publishes this exact, non-mutating denial for unsupported Workforce
 * lifecycle proposals. Translate only its fixed typed contract; never echo an
 * exception's message, status, code, or attached diagnostics to the caller. */
function isTypedWorkforceDenial(error: unknown, expectedName: string, expectedCode: string): boolean {
  try {
    if (!(error instanceof Error)) return false;
    const prototype = Object.getPrototypeOf(error);
    const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    const name = Object.getOwnPropertyDescriptor(error, 'name');
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    const status = Object.getOwnPropertyDescriptor(error, 'status');
    return Boolean(constructor?.name === expectedName &&
      Object.getPrototypeOf(prototype) === Error.prototype &&
      name && 'value' in name && name.value === expectedName &&
      code && 'value' in code && code.value === expectedCode &&
      status && 'value' in status && status.value === 403);
  } catch {
    // Proxies or hostile accessor-backed exceptions are ordinary owner failures.
    return false;
  }
}
function isUnsupportedWorkforceActionDenial(error: unknown): boolean {
  return isTypedWorkforceDenial(error, 'DirectAdminWorkforceActionDenied', 'directadmin-workforce-action-unsupported');
}
function isWorkforceAuthorityDenial(error: unknown): boolean {
  return isTypedWorkforceDenial(error, 'DirectAdminWorkforceAuthorityDenied', 'directadmin-workforce-authority-denied');
}
function bridgeFailure(error: unknown): Response {
  const kind = directAdminBridgeFailureKind(error);
  if (kind === 'request-rejected') {
    return json(401, { error: 'directadmin-session-rejected', read_only: true });
  }
  if (kind === 'session-rejected') {
    return json(401, { error: 'directadmin-session-rejected', read_only: true }, DIRECTADMIN_CLEAR_SESSION_COOKIE);
  }
  if (kind === 'session-rejected-clear-cookie') {
    return json(401, { error: 'directadmin-session-rejected', read_only: true }, DIRECTADMIN_CLEAR_SESSION_COOKIE);
  }
  if (kind === 'session-binding-mismatch') {
    return json(409, { error: 'directadmin-session-binding-mismatch', read_only: true });
  }
  return json(503, { error: 'directadmin-context-or-owner-unavailable', read_only: true });
}
function bootstrapFailure(error: unknown): Response {
  const kind = directAdminBridgeFailureKind(error);
  if (kind === 'request-rejected' || kind === 'session-rejected') {
    return json(401, { error: 'directadmin-session-rejected', read_only: true });
  }
  if (kind === 'session-rejected-clear-cookie') {
    return json(401, { error: 'directadmin-session-rejected', read_only: true }, DIRECTADMIN_CLEAR_SESSION_COOKIE);
  }
  if (kind === 'unavailable-clear-cookie') {
    return json(503, { error: 'directadmin-bootstrap-unavailable', read_only: true }, DIRECTADMIN_CLEAR_SESSION_COOKIE);
  }
  if (kind === 'session-binding-mismatch') {
    return json(409, { error: 'directadmin-session-binding-mismatch', read_only: true });
  }
  return json(503, { error: 'directadmin-bootstrap-unavailable', read_only: true });
}
function sameBridgeContext(left: DirectAdminBridgeContext, right: DirectAdminBridgeContext): boolean {
  return left.schema === right.schema && left.actor_id === right.actor_id && left.company_id === right.company_id &&
    left.context_revision === right.context_revision && left.session_revision === right.session_revision;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json' || request.headers.has('content-encoding')) throw new Error('invalid-body');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('missing-body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 5000);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 65536) throw new Error('body-too-large');
      chunks.push(next.value);
    }
    if (timedOut) throw new Error('body-timeout');
  } finally { clearTimeout(deadline); await reader.cancel(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid-body');
  return parsed;
}

/** Request handler only: launched Workforce/#812 retain server/bootstrap ownership. */
export function createDirectAdminGateway(
  bridge: DirectAdminSessionBridge,
  owners: DirectAdminGatewayOwners,
  bootstrapProvider?: DirectAdminBootstrapAssertionProvider,
) {
  let active = 0;
  const handle = async (request: Request): Promise<Response> => {
    let url: URL;
    try { url = new URL(request.url); } catch { return json(400, { error: 'invalid-route' }); }
    if (url.search || url.hash) return json(400, { error: 'invalid-route' });
    const path = url.pathname;
    // First-session route deliberately bypasses authenticate(): a Titan cookie
    // does not exist yet. The bridge validates origin/Fetch Metadata and the
    // one-time nonce before invoking this server-only assertion provider.
    if (path === '/v1/directadmin/bootstrap') {
      if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' });
      try {
        // The bridge's allowlisted proof envelope excludes caller identity,
        // company, role and session headers, and request bodies. The provider
        // type is the one exported by #302, not a second local contract.
        const bootstrap = await bridge.bootstrapBrowserSession(request, bootstrapProvider);
        return json(200, { csrf_token: bootstrap.csrf_token }, bootstrap.set_cookie);
      } catch (error) { return bootstrapFailure(error); }
    }
    let session;
    try { session = await bridge.authenticate(request); }
    catch (error) { return bridgeFailure(error); }
    try {
      if (request.method === 'GET' && path === '/v1/directadmin/context') return json(200, session.context);
      if (request.method === 'POST' && path === '/v1/directadmin/logout') {
        await session.logout();
        return json(200, { status: 'reauthentication-required' }, DIRECTADMIN_CLEAR_SESSION_COOKIE);
      }
      if (request.method === 'POST' && path === '/v1/directadmin/company') {
        const input = await body(request);
        if (typeof input.company_id !== 'string' || Object.keys(input).length !== 1) return json(400, { error: 'invalid-company-selection' });
        const switched = await session.switchCompany(input.company_id);
        return json(200, { status: 'context-changed' }, switched.set_cookie);
      }
      const receiptRoute = /^\/v1\/directadmin\/titan_workforce\/receipts\/([A-Za-z0-9:._-]{1,200})$/.exec(path);
      if (receiptRoute) {
        if (request.method !== 'GET' || request.body !== null) return json(405, { error: 'method-not-allowed' });
        const receipt_id = receiptRoute[1];
        if (!isDirectAdminWorkforceReceiptId(receipt_id)) {
          return json(404, { error: 'directadmin-workforce-receipt-not-found', read_only: true });
        }
        if (typeof owners.receipt !== 'function') throw new Error('directadmin-workforce-receipt-owner-unavailable');
        const context = await session.revalidate();
        const receipt = await owners.receipt('titan_workforce', receipt_id, context);
        const current = await session.revalidate();
        if (!sameBridgeContext(context, current)) throw new Error('directadmin-session-binding-mismatch');
        if (receipt === null) return json(404, { error: 'directadmin-workforce-receipt-not-found', read_only: true });
        assertDirectAdminWorkforceReceipt(receipt, receipt_id, context.company_id);
        return json(200, { context, receipt });
      }
      const route = /^\/v1\/directadmin\/(titan_zero|titan_workforce|titan_operations|titan_web)\/(projection|intents)$/.exec(path);
      if (!route) return json(404, { error: 'unknown-plugin-route' });
      const plugin = route[1] as DirectAdminPluginId;
      if (request.method === 'GET' && route[2] === 'projection') {
        const context = await session.revalidate();
        const projection = await owners.projection(plugin, context);
        assertDirectAdminProjection(projection, context.company_id);
        await session.revalidate(); // suppress an in-flight response after a switch/revocation
        return json(200, { context, projection });
      }
      if (request.method === 'POST' && route[2] === 'intents') {
        const input = await body(request);
        const context = await session.revalidate();
        const contextRevisionMatches = typeof input.context_revision === 'string' &&
          await matchesDirectAdminContextRevision(input.context_revision, context.context_revision);
        if (input.company_id !== context.company_id || input.actor_id !== context.actor_id ||
            !contextRevisionMatches ||
            !['capability_id', 'operation_id', 'correlation_id'].every(k => typeof input[k] === 'string' && /^[A-Za-z0-9:._-]{1,200}$/.test(input[k] as string)) ||
            !input.input || typeof input.input !== 'object' || Array.isArray(input.input) ||
            Object.keys(input).some(k => !['company_id','actor_id','context_revision','capability_id','operation_id','correlation_id','input'].includes(k))) {
          return json(409, { error: 'intent-context-mismatch' });
        }
        const intent: GovernedIntentRequest = Object.freeze({ company_id: context.company_id, actor_id: context.actor_id,
          capability_id: input.capability_id as string, operation_id: input.operation_id as string,
          correlation_id: input.correlation_id as string, input: input.input as Record<string, unknown> });
        // Only the trusted Zero Core and Workforce owners compose with the
        // fixed Workforce/Zero identity. Other plugins do not receive a
        // Workforce child-credential capability.
        const withWorkforceZeroSession: WithWorkforceZeroSession = plugin === 'titan_zero' || plugin === 'titan_workforce'
          ? session.withWorkforceZeroSession
          : async () => { throw new Error('directadmin-workforce-zero-unavailable'); };
        // Forward the browser/server transport cancellation signal into the
        // canonical owner. The owner decides whether it can stop safely; this
        // gateway never fabricates a receipt or rewrites a completed outcome.
        const receipt = await owners.requestIntent(plugin, intent, context, session.revalidate, withWorkforceZeroSession,
          { signal: request.signal });
        if (!receipt || typeof receipt.receipt_id !== 'string' || receipt.receipt_id.length > 200 ||
            !/^[A-Za-z0-9:._-]+$/.test(receipt.receipt_id) ||
            /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(receipt.receipt_id)) {
          throw new Error('directadmin-owner-receipt-invalid');
        }
        return json(202, { status: 'REQUESTED', receipt_id: receipt.receipt_id, correlation_id: intent.correlation_id });
      }
      return json(405, { error: 'method-not-allowed' });
    } catch (error) {
      // Never return exception messages, cookies, credentials or arbitrary provider diagnostics.
      if (isUnsupportedWorkforceActionDenial(error)) {
        return json(403, { error: 'directadmin-workforce-action-unsupported', read_only: true });
      }
      if (isWorkforceAuthorityDenial(error)) {
        // This is an authoritative denial, not an owner outage. Keep the live
        // session and suppress the service's action-bearing diagnostic text.
        return json(403, { error: 'directadmin-workforce-authority-denied', read_only: true });
      }
      return bridgeFailure(error);
    }
  };
  return async (request: Request): Promise<Response> => {
    if (active >= 32) return json(503, { error: 'directadmin-busy', read_only: true });
    active++;
    try { return await handle(request); } finally { active--; }
  };
}
