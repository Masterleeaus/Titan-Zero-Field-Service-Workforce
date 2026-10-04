import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, webcrypto, type KeyObject } from "node:crypto";
import { request as httpRequest } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error Native SQLite driver is used only by this disposable fixture.
import Database from "better-sqlite3";
import { createSqliteStorage, initializeSqliteCompanyPlacementRegistry } from "../../../packages/storage/src/index.js";
import { createDirectAdminBootstrapFlow, createIdentitySessionRegistry, createSessionCredentialService,
  initializeDirectAdminBootstrapNonceStore } from "../../../packages/titan-platform/src/security-boundary.js";
import { createWorkforceDependencies } from "./production-dependencies.js";
import { createWorkforceServer } from "./server.js";

function requestHttp(url: string, headers: Record<string, string>, method = "GET", body?: string): Promise<{
  status: number; body: string; setCookie?: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, response => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        const setCookie = response.headers["set-cookie"]?.[0];
        resolve({ status: response.statusCode ?? 0, body, ...(setCookie ? { setCookie } : {}) });
      });
    });
    request.on("error", reject);
    if (body !== undefined) request.end(body);
    else request.end();
  });
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function productionEnvironment(input: {
  root: string; identityPath: string; runtimePath: string; webPath: string; companyRoot: string;
}) {
  const keyRoot = join(input.root, "verification-keys");
  mkdirSync(input.companyRoot, { mode: 0o700 });
  mkdirSync(keyRoot, { mode: 0o700 });
  chmodSync(input.companyRoot, 0o700);
  chmodSync(keyRoot, 0o700);
  const workforceKeys = generateKeyPairSync("ed25519");
  const upstreamKeys = generateKeyPairSync("ed25519");
  const workforceKeyPath = join(keyRoot, "workforce.pem");
  const upstreamKeyPath = join(keyRoot, "upstream.pem");
  writeFileSync(workforceKeyPath, workforceKeys.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o644 });
  writeFileSync(upstreamKeyPath, upstreamKeys.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o644 });
  new Database(input.webPath).close();
  return {
    upstreamKeys,
    environment: {
      WORKFORCE_SQLITE_PATH: input.runtimePath,
      WORKFORCE_WEB_SQLITE_PATH: input.webPath,
      WORKFORCE_IDENTITY_SQLITE_PATH: input.identityPath,
      WORKFORCE_COMPANY_STORE_ROOT: input.companyRoot,
      WORKFORCE_DIRECTADMIN_NODE_ID: "node-test",
      WORKFORCE_SESSION_ISSUER: "titan:workforce-auth",
      WORKFORCE_SESSION_KEY_ID: "workforce-test-key",
      WORKFORCE_SESSION_ALGORITHM: "EdDSA",
      WORKFORCE_SESSION_PUBLIC_KEY_PATH: workforceKeyPath,
      WORKFORCE_UPSTREAM_SESSION_ISSUER: "directadmin:https://panel.test.invalid",
      WORKFORCE_UPSTREAM_SESSION_AUDIENCE: "da-login",
      WORKFORCE_UPSTREAM_SESSION_KEY_ID: "upstream-test-key",
      WORKFORCE_UPSTREAM_SESSION_ALGORITHM: "EdDSA",
      WORKFORCE_UPSTREAM_SESSION_PUBLIC_KEY_PATH: upstreamKeyPath,
    },
  };
}

function loginAssertion(privateKey: KeyObject, csrfHash: string): string {
  const now = Math.floor(Date.now() / 1000);
  const head = base64url({ alg: "EdDSA", kid: "upstream-test-key", typ: "titan-login+jwt" });
  const payload = base64url({
    iss: "directadmin:https://panel.test.invalid",
    aud: "da-login",
    sub: "operator-a",
    jti: "disposable-assertion-1",
    iat: now,
    exp: now + 180,
    company_id: "company-a",
    device_id: "device-a",
    node_id: "node-test",
    csrf_sha256: csrfHash,
    da_role: "admin",
    real_sub: "operator-a",
    da_impersonating: false,
  });
  const signingInput = `${head}.${payload}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

test("production loader constructs the canonical DirectAdmin bridge and gateway for a current session", async () => {
  const root = mkdtempSync(join(tmpdir(), "titan-workforce-loader-session-"));
  const identityPath = join(root, "identity.sqlite");
  const runtimePath = join(root, "workforce.sqlite");
  const webPath = join(root, "titan-zero.db");
  const companyRoot = join(root, "company-stores");
  const modulePath = join(root, "directadmin-host-services.mjs");
  const { upstreamKeys, environment } = productionEnvironment({ root, identityPath, runtimePath, webPath, companyRoot });
  const identity = createSqliteStorage(identityPath);
  let dependencies: Awaited<ReturnType<typeof createWorkforceDependencies>> | undefined;
  let host: Awaited<ReturnType<typeof createWorkforceServer>> | undefined;
  try {
    const registry = await createIdentitySessionRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await registry.putActor({ actor_id: "actor-a", status: "active" }, null);
    await registry.putCompany({ company_id: "company-a", status: "active" }, null);
    await registry.putDevice({ device_id: "device-a", actor_id: "actor-a", status: "active" }, null);
    await registry.putMembership({ company_id: "company-a", actor_id: "actor-a", role: "owner", status: "active" }, null);
    await registry.putExternalBinding({ binding_id: "binding-a", company_id: "company-a", actor_id: "actor-a",
      provider: "directadmin:https://panel.test.invalid", subject: "operator-a", status: "active" }, null);
    await initializeSqliteCompanyPlacementRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });

    const directAdminSessionKeys = generateKeyPairSync("ed25519");
    const directAdminSigningKey = await webcrypto.subtle.importKey("pkcs8",
      directAdminSessionKeys.privateKey.export({ format: "der", type: "pkcs8" }),
      { name: "Ed25519" }, false, ["sign"]);
    const directAdminVerificationKey = await webcrypto.subtle.importKey("spki",
      directAdminSessionKeys.publicKey.export({ format: "der", type: "spki" }),
      { name: "Ed25519" }, false, ["verify"]);
    const upstreamVerificationKey = await webcrypto.subtle.importKey("spki",
      upstreamKeys.publicKey.export({ format: "der", type: "spki" }),
      { name: "Ed25519" }, false, ["verify"]);
    const sessions = createSessionCredentialService({
      issuer: "titan:directadmin-session",
      audience: "titan-directadmin:node-test",
      key_id: "directadmin-session-key",
      algorithm: "EdDSA",
      signing_key: directAdminSigningKey,
      verification_key: directAdminVerificationKey,
      registry,
      directadmin: { node_id: "node-test" },
      upstream: {
        issuer: "directadmin:https://panel.test.invalid",
        audience: "da-login",
        key_id: "upstream-test-key",
        algorithm: "EdDSA",
        verification_key: upstreamVerificationKey,
      },
    });
    const csrfToken = "current-session-csrf-token-0123456789abcdef";
    const csrfHash = createHash("sha256").update(csrfToken).digest("base64url");
    const issued = await sessions.issue(loginAssertion(upstreamKeys.privateKey, csrfHash), {
      company_id: "company-a", device_id: "device-a",
    });

    writeFileSync(modulePath, `
      let services;
      export function configure(value) { services = value; }
      export async function createWorkforceDirectAdminHostServices() { return services; }
    `, { mode: 0o600 });
    const hostModule = await import(pathToFileURL(modulePath).href) as { configure(value: unknown): void };
    hostModule.configure({
      publicOrigin: "https://panel.test.invalid",
      sessions,
      // The route under test is a read-only current-session request. Bootstrap
      // remains disabled unless the actual trusted #302 flow is configured.
      bootstrapProvider: { async provide() { throw new Error("directadmin-service-unavailable"); } },
    });

    dependencies = await createWorkforceDependencies({
      ...environment,
      WORKFORCE_DIRECTADMIN_DEPENDENCIES_MODULE: modulePath,
    });
    assert.equal(typeof dependencies.directAdmin?.createGateway, "function");
    host = await createWorkforceServer({ storagePath: runtimePath, dependencies });
    await new Promise<void>((resolve, reject) => {
      host!.server.once("error", reject);
      host!.server.listen(0, "127.0.0.1", resolve);
    });
    const address = host.server.address();
    assert.ok(address && typeof address !== "string");
    const request = () => requestHttp(`http://127.0.0.1:${address.port}/v1/directadmin/context`, {
      host: "panel.test.invalid",
      origin: "https://panel.test.invalid",
      "sec-fetch-site": "same-origin",
      "x-titan-csrf": csrfToken,
      cookie: `__Host-titan-da-session=${issued.credential}`,
    });
    const current = await request();
    assert.equal(current.status, 200);
    const currentContext = JSON.parse(current.body) as Record<string, unknown>;
    assert.equal(currentContext.company_id, "company-a");
    assert.equal(currentContext.actor_id, "actor-a");
    assert.equal(currentContext.da_role, "admin");
    assert.equal(currentContext.authority, "not-carried");

    await registry.revokeSession(issued.context.session_id, issued.context.session_revision);
    const revoked = await request();
    assert.equal(revoked.status, 401, "the constructed gateway revalidates the current canonical session after revocation");
  } finally {
    if (host) await host.close();
    else await dependencies?.close?.({ signal: new AbortController().signal });
    await identity.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("launched host forwards only the Titan session cookie on established-session routes", async () => {
  const root = mkdtempSync(join(tmpdir(), "titan-workforce-session-cookie-boundary-"));
  const identityPath = join(root, "identity.sqlite");
  const runtimePath = join(root, "workforce.sqlite");
  const webPath = join(root, "titan-zero.db");
  const companyRoot = join(root, "company-stores");
  const { environment } = productionEnvironment({ root, identityPath, runtimePath, webPath, companyRoot });
  const identity = createSqliteStorage(identityPath);
  let dependencies: Awaited<ReturnType<typeof createWorkforceDependencies>> | undefined;
  let host: Awaited<ReturnType<typeof createWorkforceServer>> | undefined;
  try {
    await createIdentitySessionRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await initializeSqliteCompanyPlacementRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await identity.close();
    dependencies = await createWorkforceDependencies(environment);
    const mountedDependencies = {
      ...dependencies,
      directAdmin: {
        publicOrigin: "https://panel.test.invalid",
        createGateway: () => async (request: Request) => new Response(JSON.stringify({
          cookie: request.headers.get("cookie"),
          authorization: request.headers.get("authorization"),
        }), { status: 200, headers: { "content-type": "application/json" } }),
      },
    };
    host = await createWorkforceServer({ storagePath: runtimePath, dependencies: mountedDependencies });
    await new Promise<void>((resolve, reject) => {
      host!.server.once("error", reject);
      host!.server.listen(0, "127.0.0.1", resolve);
    });
    const address = host.server.address();
    assert.ok(address && typeof address !== "string");
    const response = await requestHttp(`http://127.0.0.1:${address.port}/v1/directadmin/context`, {
      host: "panel.test.invalid",
      origin: "https://panel.test.invalid",
      "sec-fetch-site": "same-origin",
      authorization: "Bearer must-not-forward",
      cookie: "session=da-session; key=da-key; __Host-titan-da-session=opaque-token; analytics=private",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), {
      cookie: "__Host-titan-da-session=opaque-token",
      authorization: null,
    });
  } finally {
    if (host) await host.close();
    else await dependencies?.close?.({ signal: new AbortController().signal });
    await identity.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("production RAW nonce/bootstrap reaches the canonical #302 flow without widening cookie forwarding", async () => {
  const root = mkdtempSync(join(tmpdir(), "titan-workforce-bootstrap-host-"));
  const identityPath = join(root, "identity.sqlite");
  const runtimePath = join(root, "workforce.sqlite");
  const webPath = join(root, "titan-zero.db");
  const companyRoot = join(root, "company-stores");
  const modulePath = join(root, "directadmin-host-services.mjs");
  const { upstreamKeys, environment } = productionEnvironment({ root, identityPath, runtimePath, webPath, companyRoot });
  const identity = createSqliteStorage(identityPath);
  let dependencies: Awaited<ReturnType<typeof createWorkforceDependencies>> | undefined;
  let host: Awaited<ReturnType<typeof createWorkforceServer>> | undefined;
  try {
    const registry = await createIdentitySessionRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await registry.putActor({ actor_id: "actor-a", status: "active" }, null);
    await registry.putCompany({ company_id: "company-a", status: "active" }, null);
    await registry.putDevice({ device_id: "device-a", actor_id: "actor-a", status: "active" }, null);
    await registry.putMembership({ company_id: "company-a", actor_id: "actor-a", role: "owner", status: "active" }, null);
    await registry.putExternalBinding({ binding_id: "binding-a", company_id: "company-a", actor_id: "actor-a",
      provider: "directadmin:https://panel.test.invalid", subject: "operator-a", status: "active" }, null);
    await initializeDirectAdminBootstrapNonceStore({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await initializeSqliteCompanyPlacementRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });

    const upstreamSigningKey = await webcrypto.subtle.importKey("pkcs8",
      upstreamKeys.privateKey.export({ format: "der", type: "pkcs8" }),
      { name: "Ed25519" }, false, ["sign"]);
    const upstreamVerificationKey = await webcrypto.subtle.importKey("spki",
      upstreamKeys.publicKey.export({ format: "der", type: "spki" }),
      { name: "Ed25519" }, false, ["verify"]);
    const csrfSessionKeys = generateKeyPairSync("ed25519");
    const sessions = createSessionCredentialService({
      issuer: "titan:directadmin-session",
      audience: "titan-directadmin:node-test",
      key_id: "directadmin-session-key",
      algorithm: "EdDSA",
      signing_key: await webcrypto.subtle.importKey("pkcs8",
        csrfSessionKeys.privateKey.export({ format: "der", type: "pkcs8" }),
        { name: "Ed25519" }, false, ["sign"]),
      verification_key: await webcrypto.subtle.importKey("spki",
        csrfSessionKeys.publicKey.export({ format: "der", type: "spki" }),
        { name: "Ed25519" }, false, ["verify"]),
      registry,
      directadmin: { node_id: "node-test" },
      upstream: {
        issuer: "directadmin:https://panel.test.invalid",
        audience: "titan-login",
        key_id: "upstream-test-key",
        algorithm: "EdDSA",
        verification_key: upstreamVerificationKey,
      },
    });
    const upstreamCookieObservations: Array<string | null> = [];
    const flow = createDirectAdminBootstrapFlow({
      origin: "https://panel.test.invalid",
      node_id: "node-test",
      upstream: {
        issuer: "directadmin:https://panel.test.invalid",
        audience: "titan-login",
        key_id: "upstream-test-key",
        algorithm: "EdDSA",
        verification_key: upstreamVerificationKey,
      },
      signing_key: upstreamSigningKey,
      registry,
      fetcher: async (input, init) => {
        assert.equal(String(input), "https://panel.test.invalid/api/session");
        upstreamCookieObservations.push(new Headers(init?.headers).get("cookie"));
        return new Response(JSON.stringify({ effectiveRole: "admin", effectiveUsername: "operator-a", realUsername: "operator-a" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    });
    writeFileSync(modulePath, `
      let services;
      export function configure(value) { services = value; }
      export async function createWorkforceDirectAdminHostServices() { return services; }
    `, { mode: 0o600 });
    const hostModule = await import(pathToFileURL(modulePath).href) as { configure(value: unknown): void };
    hostModule.configure({ publicOrigin: "https://panel.test.invalid", sessions,
      bootstrapProvider: flow, bootstrapNonceFlow: flow });

    dependencies = await createWorkforceDependencies({
      ...environment,
      WORKFORCE_DIRECTADMIN_DEPENDENCIES_MODULE: modulePath,
    });
    assert.equal(typeof dependencies.directAdmin?.bootstrapNonceFlow?.issueNonceForUniqueCurrentContext, "function");
    host = await createWorkforceServer({ storagePath: runtimePath, dependencies });
    await new Promise<void>((resolve, reject) => {
      host!.server.once("error", reject);
      host!.server.listen(0, "127.0.0.1", resolve);
    });
    const address = host.server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const directAdminCookie = "session=disposable-session; key=disposable-key";
    const requestHeaders = {
      host: "panel.test.invalid",
      origin: "https://panel.test.invalid",
      "sec-fetch-site": "same-origin",
      accept: "application/json",
      "content-length": "0",
    };

    const nonceResponse = await requestHttp(`${baseUrl}/v1/directadmin/bootstrap-nonce`, {
      ...requestHeaders,
      cookie: directAdminCookie,
      authorization: "Bearer must-not-forward",
      "x-titan-company-id": "caller-selected-company",
    }, "POST", "");
    assert.equal(nonceResponse.status, 200, nonceResponse.body);
    const nonceResult = JSON.parse(nonceResponse.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(nonceResult), ["csrf_nonce"]);
    assert.equal(typeof nonceResult.csrf_nonce, "string");
    assert.equal(upstreamCookieObservations[0], directAdminCookie,
      "the exact nonce route forwards only the #1300 filtered DirectAdmin cookie pair to the configured session authenticator");

    const csrfNonce = nonceResult.csrf_nonce as string;
    const bootstrap = await requestHttp(`${baseUrl}/v1/directadmin/bootstrap`, {
      ...requestHeaders,
      cookie: directAdminCookie,
      "x-titan-da-bootstrap-csrf": csrfNonce,
      authorization: "Bearer must-not-forward",
    }, "POST", "");
    assert.equal(bootstrap.status, 200, bootstrap.body);
    assert.ok(bootstrap.setCookie?.startsWith("__Host-titan-da-session="));
    assert.match(bootstrap.setCookie ?? "", /; Path=\/; Secure; HttpOnly; SameSite=Strict;/);
    const bootstrapResult = JSON.parse(bootstrap.body) as Record<string, unknown>;
    assert.equal(typeof bootstrapResult.csrf_token, "string");
    assert.equal(upstreamCookieObservations[1], directAdminCookie,
      "bootstrap redemption authenticates the same DirectAdmin proof after the server strips Authorization");

    const titanCookie = bootstrap.setCookie!.split(";", 1)[0];
    const contextHeaders = {
      host: "panel.test.invalid",
      origin: "https://panel.test.invalid",
      "sec-fetch-site": "same-origin",
      "x-titan-csrf": bootstrapResult.csrf_token as string,
      cookie: titanCookie,
    };
    const context = await requestHttp(`${baseUrl}/v1/directadmin/context`, contextHeaders);
    assert.equal(context.status, 200, context.body);
    const contextValue = JSON.parse(context.body) as Record<string, unknown>;
    assert.equal(contextValue.company_id, "company-a");
    assert.equal(contextValue.actor_id, "actor-a");
    assert.equal(contextValue.authority, "not-carried");

    const replay = await requestHttp(`${baseUrl}/v1/directadmin/bootstrap`, {
      ...requestHeaders,
      cookie: directAdminCookie,
      "x-titan-da-bootstrap-csrf": csrfNonce,
    }, "POST", "");
    assert.equal(replay.status, 401, "a consumed durable first-session nonce cannot mint a second browser credential");
    assert.equal(bootstrap.setCookie?.startsWith("__Host-titan-da-session="), true);
    const mintedSession = (bootstrap.setCookie!.split(";", 1)[0].split("=", 2)[1]);
    const identitySession = await sessions.authenticate(mintedSession);
    await registry.revokeSession(identitySession.context.session_id, identitySession.context.session_revision);
    const revokedContext = await requestHttp(`${baseUrl}/v1/directadmin/context`, contextHeaders);
    assert.equal(revokedContext.status, 401, "the first-session result is rejected after canonical session revocation");
  } finally {
    if (host) await host.close();
    else await dependencies?.close?.({ signal: new AbortController().signal });
    await identity.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
