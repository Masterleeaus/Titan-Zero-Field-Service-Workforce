const endpoint = "/CMD_PLUGINS/titan-server-node/directadmin-gateway.raw";
const plugins = ["titan_zero", "titan_operations", "titan_web", "titan_workforce", "titan_channels"];
const routes = new Map([
  ["/v1/directadmin/bootstrap", { route: "bootstrap", method: "POST", bootstrap: true }],
  ["/v1/directadmin/context", { route: "context", method: "GET" }],
  ["/v1/directadmin/logout", { route: "logout", method: "POST" }],
  ["/v1/directadmin/company", { route: "company", method: "POST" }],
]);

for (const plugin of plugins) {
  const routePlugin = plugin === "titan_workforce" ? "workforce" : plugin.replaceAll("_", "-");
  routes.set("/v1/directadmin/" + plugin + "/projection", {
    route: routePlugin + "-projection", method: "GET",
  });
  routes.set("/v1/directadmin/" + plugin + "/intents", {
    route: routePlugin + "-intents", method: "POST",
  });
}

function failure(status, error) {
  return new Response(JSON.stringify({ error, read_only: true }), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

function requestPath(input) {
  if (typeof input === "string") {
    if (input.startsWith("/") && !input.startsWith("//")) return input;
    return null;
  }
  if (!(input instanceof URL) || typeof globalThis.location?.origin !== "string" ||
      input.origin !== globalThis.location.origin || input.username || input.password) return null;
  return input.pathname + input.search + input.hash;
}

/**
 * Inject as the fetcher for DirectAdminCockpitSession. It only translates the
 * shared SDK's fixed /v1/directadmin routes into this plugin's RAW endpoint.
 * Browser cookies and Fetch Metadata remain browser-generated same-origin data.
 */
export function createDirectAdminRelayFetch(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("directadmin-relay-fetch-unavailable");
  return async (input, init = {}) => {
    const path = requestPath(input);
    if (!path || path.includes("?") || path.includes("#")) return failure(400, "invalid_directadmin_route");
    const route = routes.get(path);
    if (!route) return failure(404, "unknown_directadmin_route");
    const method = String(init.method ?? "GET").toUpperCase();
    if (method !== route.method) return failure(405, "method_not_allowed");
    if ((method === "GET" && init.body !== undefined) ||
        (method === "POST" && (route.bootstrap ? init.body !== undefined && init.body !== "" : typeof init.body !== "string"))) {
      return failure(400, "request_body_invalid");
    }
    const headers = new Headers(init.headers);
    if (route.bootstrap && !headers.has("accept")) headers.set("accept", "application/json");
    const allowedHeaders = route.bootstrap
      ? ["accept", "x-titan-da-bootstrap-csrf"]
      : ["accept", "content-type", "x-titan-csrf"];
    for (const name of headers.keys()) {
      if (!allowedHeaders.includes(name.toLowerCase())) {
        return failure(400, "request_header_forbidden");
      }
    }
    if (route.bootstrap && !/^[A-Za-z0-9_-]{43,128}$/.test(headers.get("x-titan-da-bootstrap-csrf") ?? "")) {
      return failure(400, "bootstrap_nonce_invalid");
    }
    const query = new URLSearchParams({ route: route.route, headers_to_env: "yes" });
    if (route.method === "POST") query.set("pipe_post", "yes");
    const requestInit = {
      ...init,
      method: route.method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "same-origin",
      headers,
    };
    if (route.bootstrap) delete requestInit.body;
    return fetchImpl(endpoint + "?" + query.toString(), requestInit);
  };
}
