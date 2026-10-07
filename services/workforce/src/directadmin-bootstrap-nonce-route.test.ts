import test from "node:test";
import assert from "node:assert/strict";
import { withDirectAdminBootstrapNonceRoute } from "./directadmin-bootstrap-nonce-route.js";

const origin = "https://panel.example.test:2222";
const cookie = "session=disposable-session; key=disposable-key";
const nonce = "N".repeat(43);

function request(path = "/v1/directadmin/bootstrap-nonce", changes: {
  method?: string; headers?: Record<string, string>; body?: BodyInit | null;
} = {}): Request {
  const headers = new Headers({ origin, "sec-fetch-site": "same-origin", cookie, accept: "application/json" });
  for (const [name, value] of Object.entries(changes.headers ?? {})) headers.set(name, value);
  return new Request(`${origin}${path}`, {
    method: changes.method ?? "POST", headers,
    ...(changes.body === undefined ? {} : { body: changes.body, duplex: "half" } as RequestInit & { duplex: "half" }),
  });
}

test("nonce route passes only exact DA session proof to canonical unique selector and returns only nonce", async () => {
  const calls: unknown[] = [];
  const gatewayCalls: string[] = [];
  const handler = withDirectAdminBootstrapNonceRoute(async input => {
    gatewayCalls.push(new URL(input.url).pathname);
    return new Response("gateway");
  }, {
    publicOrigin: origin,
    flow: { issueNonceForUniqueCurrentContext: async proof => {
      calls.push(proof);
      return { csrf_nonce: nonce, expires_at: "2026-10-02T15:32:00.000Z", company_id: "company-a", device_id: "device-a" };
    } },
  });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { csrf_nonce: nonce });
  assert.deepEqual(calls, [{ origin, cookie, authorization: null }]);
  assert.deepEqual(gatewayCalls, []);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const ordinary = await handler(request("/v1/directadmin/context", { method: "GET" }));
  assert.equal(ordinary.status, 200);
  assert.deepEqual(gatewayCalls, ["/v1/directadmin/context"]);
});

test("nonce route rejects caller identity, Titan auth, wrong origin, query, method, body and foreign cookies before selector", async () => {
  let calls = 0;
  const handler = withDirectAdminBootstrapNonceRoute(async () => new Response("unused"), {
    publicOrigin: origin,
    flow: { issueNonceForUniqueCurrentContext: async () => {
      calls += 1;
      return { csrf_nonce: nonce, expires_at: "2026-10-02T15:32:00.000Z", company_id: "company-a", device_id: "device-a" };
    } },
  });
  const invalid: Array<[Request, number]> = [
    [request("/v1/directadmin/bootstrap-nonce?company_id=forged"), 400],
    [request("/v1/directadmin/bootstrap-nonce", { method: "GET" }), 400],
    [request("/v1/directadmin/bootstrap-nonce", { headers: { origin: "https://attacker.example" } }), 400],
    [request("/v1/directadmin/bootstrap-nonce", { headers: { authorization: "Bearer caller" } }), 400],
    [request("/v1/directadmin/bootstrap-nonce", { headers: { "x-titan-csrf": "X" } }), 400],
    [request("/v1/directadmin/bootstrap-nonce", { headers: { "x-titan-da-bootstrap-csrf": nonce } }), 400],
    [request("/v1/directadmin/bootstrap-nonce", { headers: { cookie: `${cookie}; analytics=secret` } }), 401],
    [request("/v1/directadmin/bootstrap-nonce", { headers: { cookie: `${cookie}; session=duplicate` } }), 401],
    [request("/v1/directadmin/bootstrap-nonce", { headers: { cookie: "session=only" } }), 401],
    [request("/v1/directadmin/bootstrap-nonce", { body: "{}" }), 400],
    [{ url: `https://caller@${new URL(origin).host}/v1/directadmin/bootstrap-nonce`, method: "POST",
      headers: new Headers({ origin, "sec-fetch-site": "same-origin", cookie }), body: null } as unknown as Request, 400],
  ];
  for (const [input, status] of invalid) {
    const response = await handler(input);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(calls, 0);
});

test("nonce route turns canonical authentication denial into a sanitized 401", async () => {
  const handler = withDirectAdminBootstrapNonceRoute(async () => new Response("unused"), {
    publicOrigin: origin,
    flow: { issueNonceForUniqueCurrentContext: async () => { throw new Error("authentication-denied"); } },
  });
  const response = await handler(request());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "directadmin-session-rejected", read_only: true });
});

test("an uncommissioned nonce flow remains mounted as a sanitized 503", async () => {
  let gatewayCalls = 0;
  const handler = withDirectAdminBootstrapNonceRoute(async () => {
    gatewayCalls += 1;
    return new Response("must not handle the first-session route");
  }, { publicOrigin: origin });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "directadmin-bootstrap-unavailable", read_only: true });
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(gatewayCalls, 0);
});
