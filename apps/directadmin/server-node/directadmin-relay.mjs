import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns/promises";
import { fileURLToPath } from "node:url";

export const DIRECTADMIN_SESSION_COOKIE = "__Host-titan-da-session";
export const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
export const BODY_TIMEOUT_MS = 5000;
export const UPSTREAM_TIMEOUT_MS = 10000;

export const ROUTES = Object.freeze({
  bootstrap: Object.freeze({ method: "POST", path: "/v1/directadmin/bootstrap", body: "bootstrap" }),
  context: Object.freeze({ method: "GET", path: "/v1/directadmin/context", body: "none" }),
  logout: Object.freeze({ method: "POST", path: "/v1/directadmin/logout", body: "empty" }),
  company: Object.freeze({ method: "POST", path: "/v1/directadmin/company", body: "company" }),
  "titan-zero-projection": Object.freeze({ method: "GET", path: "/v1/directadmin/titan_zero/projection", body: "none" }),
  "titan-zero-intents": Object.freeze({ method: "POST", path: "/v1/directadmin/titan_zero/intents", body: "intent" }),
  "titan-operations-projection": Object.freeze({ method: "GET", path: "/v1/directadmin/titan_operations/projection", body: "none" }),
  "titan-operations-intents": Object.freeze({ method: "POST", path: "/v1/directadmin/titan_operations/intents", body: "intent" }),
  "titan-web-projection": Object.freeze({ method: "GET", path: "/v1/directadmin/titan_web/projection", body: "none" }),
  "titan-web-intents": Object.freeze({ method: "POST", path: "/v1/directadmin/titan_web/intents", body: "intent" }),
  "workforce-projection": Object.freeze({ method: "GET", path: "/v1/directadmin/titan_workforce/projection", body: "none" }),
  "workforce-intents": Object.freeze({ method: "POST", path: "/v1/directadmin/titan_workforce/intents", body: "intent" }),
  "titan-channels-projection": Object.freeze({ method: "GET", path: "/v1/directadmin/titan_channels/projection", body: "none" }),
});

const responseHeaders = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "SAMEORIGIN",
});
const IDENTIFIER = /^[A-Za-z0-9:._-]{1,200}$/;
const TOKEN = /^[A-Za-z0-9._~-]{1,16384}$/;
const BOOTSTRAP_IDENTITY_HEADERS = new Set([
  "directadmin-uid", "directadmin-user", "directadmin-role",
  "x-directadmin-uid", "x-directadmin-user", "x-directadmin-role",
]);

function relayError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function invalidRequest(code = "invalid_request") {
  return relayError(400, code);
}

function parseStrictJson(text) {
  let offset = 0;
  const skip = () => { while (offset < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[offset])) offset++; };
  const string = () => {
    if (text[offset] !== '"') throw invalidRequest("invalid_json");
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset];
      if (char === '"') {
        offset++;
        try { return JSON.parse(text.slice(start, offset)); }
        catch { throw invalidRequest("invalid_json"); }
      }
      if (char === "\\") {
        offset += 2;
        continue;
      }
      if (char.charCodeAt(0) < 0x20) throw invalidRequest("invalid_json");
      offset++;
    }
    throw invalidRequest("invalid_json");
  };
  const value = (depth = 0) => {
    if (depth > 32) throw invalidRequest("json_depth_exceeded");
    skip();
    const char = text[offset];
    if (char === '"') return string();
    if (char === "{") {
      offset++;
      skip();
      const result = Object.create(null);
      const seen = new Set();
      if (text[offset] === "}") { offset++; return result; }
      while (offset < text.length) {
        skip();
        const key = string();
        if (seen.has(key)) throw invalidRequest("duplicate_json_key");
        seen.add(key);
        skip();
        if (text[offset++] !== ":") throw invalidRequest("invalid_json");
        result[key] = value(depth + 1);
        skip();
        const next = text[offset++];
        if (next === "}") return result;
        if (next !== ",") throw invalidRequest("invalid_json");
      }
      throw invalidRequest("invalid_json");
    }
    if (char === "[") {
      offset++;
      skip();
      const result = [];
      if (text[offset] === "]") { offset++; return result; }
      while (offset < text.length) {
        result.push(value(depth + 1));
        skip();
        const next = text[offset++];
        if (next === "]") return result;
        if (next !== ",") throw invalidRequest("invalid_json");
      }
      throw invalidRequest("invalid_json");
    }
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return parsed; }
    }
    const number = text.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (number) { offset += number[0].length; return Number(number[0]); }
    throw invalidRequest("invalid_json");
  };
  const result = value();
  skip();
  if (offset !== text.length) throw invalidRequest("invalid_json");
  return result;
}

function parseQuery(raw, requestMethod) {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 1024 || /[\u0000-\u0020\u007f#]/.test(raw) ||
      raw.includes("%")) throw invalidRequest("invalid_query");
  const params = new URLSearchParams(raw);
  const values = new Map();
  for (const [key, value] of params) {
    if (values.has(key)) throw invalidRequest("duplicate_query_parameter");
    values.set(key, value);
  }
  const routeId = values.get("route");
  if (!Object.hasOwn(ROUTES, routeId)) throw invalidRequest("unknown_route");
  const route = ROUTES[routeId];
  if (values.get("headers_to_env") !== "yes") throw invalidRequest("headers_to_env_required");
  const requiredCount = route.method === "POST" ? 3 : 2;
  if (values.size !== requiredCount || (route.method === "POST" && values.get("pipe_post") !== "yes") ||
      (route.method === "GET" && values.has("pipe_post"))) throw invalidRequest("invalid_transport_flags");
  if (requestMethod !== route.method) throw relayError(405, "method_not_allowed");
  return { routeId, route };
}

export function parseDirectAdminHeaders(encoded, routeId) {
  if (typeof encoded !== "string" || encoded.length < 1 || Buffer.byteLength(encoded, "utf8") > MAX_HEADER_BYTES) {
    throw invalidRequest("headers_missing_or_too_large");
  }
  let decoded;
  try { decoded = decodeURIComponent(encoded.replace(/\+/g, " ")); }
  catch { throw invalidRequest("headers_encoding_invalid"); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded)) throw invalidRequest("headers_encoding_invalid");
  const usesCrLf = decoded.includes("\r\n");
  if ((usesCrLf && /[\r\n]/.test(decoded.replace(/\r\n/g, ""))) || (!usesCrLf && decoded.includes("\r"))) {
    throw invalidRequest("headers_encoding_invalid");
  }
  const separator = usesCrLf ? "\r\n" : "\n";
  const lines = decoded.split(separator);
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length) throw invalidRequest("headers_empty");
  const headers = new Map();
  for (const line of lines) {
    const match = /^([A-Za-z0-9!#$%&'*+.^_|~-]+):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!match || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(match[2])) throw invalidRequest("header_line_invalid");
    const name = match[1].toLowerCase();
    if (headers.has(name)) throw invalidRequest("duplicate_header");
    headers.set(name, match[2]);
  }
  const allowedTitanHeader = routeId === "bootstrap" ? "x-titan-da-bootstrap-csrf" : "x-titan-csrf";
  for (const name of headers.keys()) {
    if (name.startsWith("x-titan-") && name !== allowedTitanHeader) throw invalidRequest("identity_header_forbidden");
    if (name === "authorization" || name === "proxy-authorization" || name.startsWith("x-forwarded-")) {
      throw invalidRequest("forwarding_header_forbidden");
    }
    if (routeId === "bootstrap" && BOOTSTRAP_IDENTITY_HEADERS.has(name)) throw invalidRequest("identity_header_forbidden");
  }
  return headers;
}

function cookieForTitan(value) {
  if (value === undefined) throw relayError(401, "session_required");
  if (typeof value !== "string" || value.length > 24 * 1024) throw invalidRequest("cookie_invalid");
  const names = new Set();
  let session = null;
  for (const entry of value.split(";")) {
    const part = entry.trim();
    const equals = part.indexOf("=");
    if (equals <= 0) throw invalidRequest("cookie_invalid");
    const name = part.slice(0, equals).trim();
    const cookieValue = part.slice(equals + 1).trim();
    if (!/^[!#$%&'*+.^_|~0-9A-Za-z-]+$/.test(name) || names.has(name)) throw invalidRequest("duplicate_cookie");
    names.add(name);
    if (name === DIRECTADMIN_SESSION_COOKIE) {
      if (!cookieValue || !TOKEN.test(cookieValue)) throw invalidRequest("session_cookie_invalid");
      session = cookieValue;
    }
  }
  if (!session) throw relayError(401, "session_required");
  return DIRECTADMIN_SESSION_COOKIE + "=" + session;
}

function rejectTitanCookieDuringBootstrap(value) {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > 24 * 1024) throw invalidRequest("cookie_invalid");
  const names = new Set();
  for (const entry of value.split(";")) {
    const part = entry.trim();
    const equals = part.indexOf("=");
    if (equals <= 0) throw invalidRequest("cookie_invalid");
    const name = part.slice(0, equals).trim();
    if (!/^[!#$%&'*+.^_|~0-9A-Za-z-]+$/.test(name) || names.has(name)) throw invalidRequest("duplicate_cookie");
    names.add(name);
    if (name === DIRECTADMIN_SESSION_COOKIE) throw relayError(401, "directadmin-session-rejected");
  }
}

function parseDeclaredLength(value, code) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,5})$/.test(value)) throw invalidRequest(code);
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > MAX_REQUEST_BODY_BYTES) throw relayError(413, "request_body_too_large");
  return length;
}

function validateBody(route, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalidRequest("request_body_invalid");
  const keys = Object.keys(payload);
  if (route.body === "empty" && keys.length !== 0) throw invalidRequest("request_body_invalid");
  if (route.body === "company" &&
      (keys.length !== 1 || keys[0] !== "company_id" || typeof payload.company_id !== "string" || !payload.company_id.trim() ||
       payload.company_id.length > 1024 || /[\u0000-\u001f\u007f]/.test(payload.company_id))) throw invalidRequest("request_body_invalid");
  if (route.body === "intent") {
    const expected = ["company_id", "actor_id", "context_revision", "capability_id", "operation_id", "correlation_id", "input"];
    if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(payload, key)) ||
        expected.slice(0, 6).some((key) => typeof payload[key] !== "string" || !IDENTIFIER.test(payload[key])) ||
        !payload.input || typeof payload.input !== "object" || Array.isArray(payload.input)) {
      throw invalidRequest("request_body_invalid");
    }
  }
}

function parseRequestEnvelope(env) {
  const { routeId, route } = parseQuery(env.QUERY_STRING, env.REQUEST_METHOD);
  if (env.POST !== undefined && env.POST !== "" && env.POST !== "stdin=true") throw invalidRequest("form_data_forbidden");
  const bootstrap = routeId === "bootstrap";
  const headers = parseDirectAdminHeaders(env.HEADERS, routeId);
  const headerLength = parseDeclaredLength(headers.get("content-length"), "content_length_invalid");
  const envLength = parseDeclaredLength(env.CONTENT_LENGTH, "content_length_invalid");
  if (headerLength !== undefined && envLength !== undefined && headerLength !== envLength) throw invalidRequest("content_length_mismatch");
  if (env.CONTENT_TYPE !== undefined && typeof env.CONTENT_TYPE !== "string") throw invalidRequest("content_type_invalid");
  const envContentType = typeof env.CONTENT_TYPE === "string" ? env.CONTENT_TYPE.trim() : "";
  if (envContentType && headers.has("content-type") &&
      envContentType.split(";", 1)[0].toLowerCase() !== headers.get("content-type").trim().split(";", 1)[0].toLowerCase()) {
    throw invalidRequest("content_type_mismatch");
  }
  if (bootstrap && envContentType && envContentType.split(";", 1)[0].toLowerCase() !== "application/json") {
    throw invalidRequest("content_type_invalid");
  }
  const declaredLength = headerLength ?? envLength;
  if (headers.has("transfer-encoding") || headers.has("content-encoding")) throw invalidRequest("content_encoding_forbidden");
  const host = headers.get("host");
  const origin = headers.get("origin");
  const referer = headers.get("referer");
  const fetchSite = headers.get("sec-fetch-site");
  const csrf = bootstrap ? undefined : headers.get("x-titan-csrf");
  const csrfNonce = bootstrap ? headers.get("x-titan-da-bootstrap-csrf") : undefined;
  if (bootstrap) rejectTitanCookieDuringBootstrap(headers.get("cookie"));
  const cookie = bootstrap ? undefined : cookieForTitan(headers.get("cookie"));
  const accept = headers.get("accept") ?? "application/json";
  if (accept.length > 1024 || !/application\/json/i.test(accept) || fetchSite !== "same-origin" ||
      (!bootstrap && (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(csrf))) ||
      (bootstrap && (typeof csrfNonce !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(csrfNonce))) ||
      typeof host !== "string" || host.length > 255 ||
      (origin !== undefined && origin.length > 512) || (referer !== undefined && referer.length > 2048)) {
    throw invalidRequest("browser_context_invalid");
  }
  if (route.method === "POST") {
    const contentType = headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (env.POST !== "stdin=true" ||
        (bootstrap
          ? (declaredLength !== undefined && declaredLength !== 0) || (contentType !== undefined && contentType !== "application/json")
          : declaredLength === 0 || contentType !== "application/json")) {
      throw invalidRequest("post_transport_invalid");
    }
    if (origin === undefined) throw invalidRequest("origin_required");
  } else if (env.POST === "stdin=true" || (declaredLength !== undefined && declaredLength !== 0)) {
    throw invalidRequest("get_body_forbidden");
  }
  return { routeId, route, headers, declaredLength, cookie, origin, referer, csrf, csrfNonce, accept, host };
}

function exactOrigin(value, expectedOrigin, code) {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== expectedOrigin || parsed.username || parsed.password) throw new Error();
    return parsed;
  } catch { throw invalidRequest(code); }
}

function isRemotePrivateAddress(address) {
  if (net.isIPv4(address)) {
    const octets = address.split(".").map(Number);
    return octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168);
  }
  if (!net.isIPv6(address)) return false;
  const normalized = address.toLowerCase().split("%", 1)[0];
  const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00;
}

async function loadProductionConfig() {
  throw relayError(503, "cookie_boundary_unverified");
}

export async function readBoundedBody(stream, { declaredLength, maxBytes = MAX_REQUEST_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        try { stream.destroy?.(); } catch {}
        finish(relayError(413, "request_body_too_large"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => {
      if (declaredLength !== undefined && size !== declaredLength) finish(invalidRequest("content_length_mismatch"));
      else finish(null, Buffer.concat(chunks, size));
    };
    const onError = () => finish(relayError(408, "request_body_timeout"));
    const timer = setTimeout(() => {
      try { stream.destroy?.(); } catch {}
      finish(relayError(408, "request_body_timeout"));
    }, timeoutMs);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

async function pinnedLookup(url, resolveAddresses = dns.lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return undefined;
  let addresses;
  try {
    // The production path uses Resolver queries instead of dns.lookup's
    // uncancellable getaddrinfo work. The RAW process can therefore finish
    // promptly when its overall deadline expires, without terminating the
    // process from this reusable module.
    if (resolveAddresses instanceof dns.Resolver) {
      const query = (method, family) => resolveAddresses[method](host).then(
        (values) => values.map((address) => ({ address, family })),
        (error) => {
          if (error?.code === "ENODATA" || error?.code === "ENOTFOUND") return [];
          throw error;
        },
      );
      const [ipv4, ipv6] = await Promise.all([query("resolve4", 4), query("resolve6", 6)]);
      addresses = [...ipv4, ...ipv6];
    } else {
      addresses = await resolveAddresses(host, { all: true, verbatim: true });
    }
  }
  catch { throw relayError(502, "workforce_unreachable"); }
  if (!addresses.length || addresses.some((entry) => !isRemotePrivateAddress(entry.address))) {
    throw relayError(502, "workforce_target_not_private");
  }
  return (hostname, options, callback) => {
    if (hostname.toLowerCase() !== host.toLowerCase()) return callback(new Error("upstream_host_mismatch"));
    if (options?.all) return callback(null, addresses);
    const first = addresses[0];
    return callback(null, first.address, first.family);
  };
}

function validateSessionSetCookie(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\r\n\u0000-\u001f\u007f]/.test(value)) {
    throw relayError(502, "workforce_response_invalid");
  }
  const parts = value.split(";").map((part) => part.trim());
  const equals = parts[0].indexOf("=");
  if (equals <= 0 || parts[0].slice(0, equals) !== DIRECTADMIN_SESSION_COOKIE) {
    throw relayError(502, "workforce_response_invalid");
  }
  const cookieValue = parts[0].slice(equals + 1);
  if (cookieValue && !TOKEN.test(cookieValue)) throw relayError(502, "workforce_response_invalid");
  const attrs = new Map();
  for (const part of parts.slice(1)) {
    const index = part.indexOf("=");
    const name = (index < 0 ? part : part.slice(0, index)).toLowerCase();
    if (attrs.has(name)) throw relayError(502, "workforce_response_invalid");
    attrs.set(name, index < 0 ? "" : part.slice(index + 1));
  }
  if (attrs.has("domain") || attrs.get("path") !== "/" || !attrs.has("secure") || !attrs.has("httponly") ||
      attrs.get("samesite")?.toLowerCase() !== "strict" || !/^(0|[1-9][0-9]{0,5})$/.test(attrs.get("max-age") ?? "") ||
      Number(attrs.get("max-age")) > 300) {
    throw relayError(502, "workforce_response_invalid");
  }
  if (!cookieValue && attrs.get("max-age") !== "0") throw relayError(502, "workforce_response_invalid");
}

function collectUpstreamHeaders(response) {
  const permitted = new Set(Object.keys(responseHeaders));
  const seen = new Map();
  const cookies = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index].toLowerCase();
    const value = response.rawHeaders[index + 1];
    if (name === "set-cookie") { cookies.push(value); continue; }
    if (!permitted.has(name)) continue;
    if (seen.has(name)) throw relayError(502, "workforce_response_invalid");
    seen.set(name, value);
  }
  for (const [name, expected] of Object.entries(responseHeaders)) {
    const actual = seen.get(name);
    if (actual !== undefined && actual.toLowerCase() !== expected.toLowerCase()) {
      throw relayError(502, "workforce_response_invalid");
    }
  }
  if (cookies.length > 1) throw relayError(502, "workforce_response_invalid");
  const result = { ...responseHeaders };
  if (cookies.length === 1) {
    validateSessionSetCookie(cookies[0]);
    result["set-cookie"] = cookies[0];
  }
  return result;
}

function validateBootstrapResponse(result) {
  const invalid = () => { throw relayError(502, "workforce_response_invalid"); };
  if (result.body.length > 8192) invalid();
  let payload;
  try {
    payload = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(result.body));
  } catch { invalid(); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalid();
  const keys = Object.keys(payload).sort();
  if (result.status === 200) {
    if (keys.length !== 1 || keys[0] !== "csrf_token" || typeof payload.csrf_token !== "string" ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(payload.csrf_token)) invalid();
    const cookie = result.headers["set-cookie"];
    if (typeof cookie !== "string" || cookie.length > 4096) invalid();
    const pair = cookie.split(";", 1)[0];
    const equals = pair.indexOf("=");
    if (equals <= 0 || pair.slice(0, equals) !== DIRECTADMIN_SESSION_COOKIE || !TOKEN.test(pair.slice(equals + 1))) invalid();
    const maxAge = /(?:^|;)\s*max-age=([0-9]+)\s*(?:;|$)/i.exec(cookie);
    if (!maxAge || Number(maxAge[1]) < 1 || Number(maxAge[1]) > 300) invalid();
    return result;
  }
  const error = result.status === 401 ? "directadmin-session-rejected" :
    result.status === 503 ? "directadmin-bootstrap-unavailable" : undefined;
  if (!error || keys.length !== 2 || keys[0] !== "error" || keys[1] !== "read_only" ||
      payload.error !== error || payload.read_only !== true || result.headers["set-cookie"] !== undefined) invalid();
  return result;
}

function requestHeadersForUpstream(envelope, config, body) {
  if (envelope.origin !== undefined) {
    if (envelope.origin !== config.publicOrigin) throw invalidRequest("origin_mismatch");
    exactOrigin(envelope.origin, config.publicOrigin, "origin_mismatch");
  }
  else {
    if (envelope.route.method !== "GET" || envelope.referer === undefined) throw invalidRequest("origin_required");
    exactOrigin(envelope.referer, config.publicOrigin, "referer_mismatch");
  }
  if (envelope.referer !== undefined) exactOrigin(envelope.referer, config.publicOrigin, "referer_mismatch");
  if (envelope.routeId === "bootstrap") {
    if (envelope.cookie !== undefined || envelope.csrf !== undefined ||
        typeof envelope.csrfNonce !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(envelope.csrfNonce) || body.length !== 0) {
      throw invalidRequest("bootstrap_envelope_invalid");
    }
    return {
      host: config.publicHost,
      origin: envelope.origin,
      "sec-fetch-site": "same-origin",
      "x-titan-da-bootstrap-csrf": envelope.csrfNonce,
      accept: envelope.accept,
      "content-length": "0",
    };
  }
  const headers = {
    host: config.publicHost,
    cookie: envelope.cookie,
    "sec-fetch-site": "same-origin",
    "x-titan-csrf": envelope.csrf,
    accept: envelope.accept,
  };
  if (envelope.origin !== undefined) headers.origin = envelope.origin;
  if (envelope.referer !== undefined) headers.referer = envelope.referer;
  if (envelope.route.method === "POST") {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(body.length);
  }
  return headers;
}

export async function forwardRequest(config, envelope, body, {
  timeoutMs = UPSTREAM_TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BODY_BYTES,
  resolveAddresses = dns.lookup, createResolver = () => new dns.Resolver(),
} = {}) {
  const transport = config.upstreamUrl.protocol === "https:" ? https : http;
  const headers = requestHeadersForUpstream(envelope, config, body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let resolver;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(relayError(504, "workforce_timeout"));
      request?.destroy();
      try { resolver?.cancel(); } catch {}
    }, timeoutMs);
    void (async () => {
      try {
        const host = config.upstreamUrl.hostname.replace(/^\[|\]$/g, "");
        if (!net.isIP(host) && resolveAddresses === dns.lookup) {
          resolver = createResolver();
        }
        const lookup = await pinnedLookup(config.upstreamUrl, resolver ?? resolveAddresses);
        if (settled) return;
        const options = {
          hostname: host,
          port: config.upstreamUrl.port ? Number(config.upstreamUrl.port) : undefined,
          method: envelope.route.method,
          path: envelope.route.path,
          headers,
          agent: false,
          ...(lookup ? { lookup } : {}),
        };
        request = transport.request(options, (response) => {
          const status = response.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            response.destroy();
            finish(relayError(502, "workforce_redirect_refused"));
            return;
          }
          let approvedHeaders;
          try { approvedHeaders = collectUpstreamHeaders(response); }
          catch (error) { response.destroy(); finish(error); return; }
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              finish(relayError(502, "workforce_response_too_large"));
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.once("aborted", () => finish(relayError(502, "workforce_response_incomplete")));
          response.once("error", () => finish(relayError(502, "workforce_response_incomplete")));
          response.once("end", () => {
            const result = { status, headers: approvedHeaders, body: Buffer.concat(chunks, size) };
            try {
              if (envelope.routeId === "bootstrap") validateBootstrapResponse(result);
              finish(null, result);
            } catch (error) { finish(error); }
          });
        });
        request.once("error", () => finish(relayError(502, "workforce_unreachable")));
        if (body.length) request.write(body);
        request.end();
      } catch (error) {
        finish(error?.status ? error : relayError(502, "workforce_unreachable"));
      }
    })();
  });
}

function rawResponse(status, body, extraHeaders = {}) {
  const message = http.STATUS_CODES[status] ?? "Error";
  const headers = { ...responseHeaders, ...extraHeaders, "content-length": String(body.length), connection: "close" };
  let raw = "HTTP/1.1 " + status + " " + message + "\r\n";
  for (const [name, value] of Object.entries(headers)) raw += name + ": " + value + "\r\n";
  raw += "\r\n";
  return Buffer.concat([Buffer.from(raw, "latin1"), body]);
}

function jsonFailure(status, code) {
  return rawResponse(status, Buffer.from(JSON.stringify({ error: code, read_only: true }), "utf8"));
}

export async function runRawGateway({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  configLoader = loadProductionConfig,
  bodyReader = readBoundedBody,
  forward = forwardRequest,
  bodyTimeoutMs = BODY_TIMEOUT_MS,
  upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  try {
    // DirectAdmin warns that a piped POST must be consumed. Drain it with a
    // hard byte/time bound before rejecting a malformed route or missing config.
    let earlyLength;
    if (typeof env.CONTENT_LENGTH === "string" && /^(0|[1-9][0-9]{0,5})$/.test(env.CONTENT_LENGTH)) {
      earlyLength = Number(env.CONTENT_LENGTH);
    }
    const pipedBody = env.POST === "stdin=true"
      ? await bodyReader(stdin, { declaredLength: earlyLength, timeoutMs: bodyTimeoutMs })
      : Buffer.alloc(0);
    const envelope = parseRequestEnvelope(env);
    const config = await configLoader();
    if (envelope.host.toLowerCase() !== config.publicHost.toLowerCase()) throw invalidRequest("host_mismatch");
    const body = envelope.route.method === "POST" ? pipedBody : Buffer.alloc(0);
    if (envelope.route.body === "none" && body.length !== 0) throw invalidRequest("get_body_forbidden");
    if (envelope.route.body === "bootstrap" && body.length !== 0) throw invalidRequest("request_body_invalid");
    if (envelope.route.body !== "none" && envelope.route.body !== "bootstrap") {
      let parsed;
      try { parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
      catch (error) { if (error?.status) throw error; throw invalidRequest("request_body_invalid"); }
      validateBody(envelope.route, parsed);
    }
    const result = await forward(config, envelope, body, { timeoutMs: upstreamTimeoutMs });
    stdout.write(rawResponse(result.status, result.body, result.headers));
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 502;
    const code = error?.code === "directadmin-session-rejected" ? error.code :
      typeof error?.code === "string" && /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code :
      status === 503 ? "relay_not_configured" : status === 408 ? "request_body_timeout" : "gateway_unavailable";
    stdout.write(jsonFailure(status, code));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runRawGateway();
}
