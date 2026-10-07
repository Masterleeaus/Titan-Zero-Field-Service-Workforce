import { directAdminSessionCookieHeader } from "../../../packages/titan-platform/src/security-session-credentials.js";

export type DirectAdminBootstrapNonceIssue = Readonly<{
  csrf_nonce: string;
  expires_at: string;
  company_id: string;
  device_id: string;
}>;

export type DirectAdminBootstrapNonceFlow = Readonly<{
  issueNonceForUniqueCurrentContext(input: Readonly<{
    origin: string;
    cookie: string;
    authorization: null;
  }>): Promise<DirectAdminBootstrapNonceIssue>;
}>;

export type DirectAdminBootstrapGateway = (request: Request) => Promise<Response>;

const noncePath = "/v1/directadmin/bootstrap-nonce";
const safeHeaders = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: safeHeaders });
}

async function hasEmptyBody(request: Request): Promise<boolean> {
  if (request.headers.has("content-encoding")) return false;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && !/^0+$/.test(declaredLength)) return false;
  const reader = request.body?.getReader();
  if (!reader) return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("body-timeout")), { once: true })),
    ]);
    return first.done === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

function validNonceResult(value: unknown): value is DirectAdminBootstrapNonceIssue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = ["csrf_nonce", "expires_at", "company_id", "device_id"];
  if (Reflect.ownKeys(value).length !== expected.length || Reflect.ownKeys(value).some(key => typeof key !== "string" || !expected.includes(key))) return false;
  if (expected.some(key => !descriptors[key] || !("value" in descriptors[key]!))) return false;
  const result = value as Record<string, unknown>;
  return typeof result.csrf_nonce === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(result.csrf_nonce)
    && typeof result.expires_at === "string" && Number.isFinite(Date.parse(result.expires_at))
    && typeof result.company_id === "string" && result.company_id.length > 0
    && typeof result.device_id === "string" && result.device_id.length > 0;
}

/**
 * Add the role RAW first-session nonce path around the already composed #1049
 * gateway. The caller must only expose Workforce on the established private
 * loopback listener. This route accepts no target, role, actor, company,
 * device, authorization, or body from the request; #302 authenticates the
 * filtered DA cookies and resolves its unique current tuple.
 */
export function withDirectAdminBootstrapNonceRoute(
  gateway: DirectAdminBootstrapGateway,
  options: Readonly<{ publicOrigin: string; flow?: DirectAdminBootstrapNonceFlow }>,
): DirectAdminBootstrapGateway {
  let publicOrigin: string;
  try {
    const parsed = new URL(options.publicOrigin);
    if (parsed.protocol !== "https:" || parsed.origin !== options.publicOrigin || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error();
    publicOrigin = parsed.origin;
  } catch { throw new Error("directadmin-bootstrap-origin-invalid"); }
  if (typeof gateway !== "function" || (options.flow !== undefined
    && typeof options.flow.issueNonceForUniqueCurrentContext !== "function")) {
    throw new Error("directadmin-bootstrap-flow-required");
  }

  return async request => {
    let url: URL;
    try { url = new URL(request.url); } catch { return json(400, { error: "invalid_request", read_only: true }); }
    if (url.pathname !== noncePath) return gateway(request);
    if (!options.flow) return json(503, { error: "directadmin-bootstrap-unavailable", read_only: true });
    if (request.method !== "POST" || url.origin !== publicOrigin || url.search || url.hash
      || url.username || url.password
      || request.headers.get("origin") !== publicOrigin
      || request.headers.get("sec-fetch-site") !== "same-origin"
      || request.headers.has("authorization") || request.headers.has("x-titan-csrf")
      || request.headers.has("x-titan-da-bootstrap-csrf")
      || request.headers.has("content-type") || !(await hasEmptyBody(request))) {
      return json(400, { error: "invalid_request", read_only: true });
    }
    const referer = request.headers.get("referer");
    if (referer !== null) {
      try { if (new URL(referer).origin !== publicOrigin) return json(400, { error: "invalid_request", read_only: true }); }
      catch { return json(400, { error: "invalid_request", read_only: true }); }
    }

    let cookie: string;
    try { cookie = directAdminSessionCookieHeader(request.headers.get("cookie")); }
    catch { return json(401, { error: "directadmin-session-rejected", read_only: true }); }
    try {
      const issued = await options.flow.issueNonceForUniqueCurrentContext(Object.freeze({
        origin: publicOrigin,
        cookie,
        authorization: null,
      }));
      if (!validNonceResult(issued)) return json(503, { error: "directadmin-bootstrap-unavailable", read_only: true });
      // company_id/device_id are held in the durable nonce and assertion path;
      // the browser receives only the opaque nonce.
      return json(200, { csrf_nonce: issued.csrf_nonce });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "authentication-denied") return json(401, { error: "directadmin-session-rejected", read_only: true });
      return json(503, { error: "directadmin-bootstrap-unavailable", read_only: true });
    }
  };
}
