import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Native SQLite driver is used only by this disposable fixture.
import Database from "better-sqlite3";
import {
  createSqliteStorage,
  initializeSqliteCompanyPlacementRegistry,
} from "../../../packages/storage/src/index.js";
import { createIdentitySessionRegistry } from "../../../packages/titan-platform/src/security-boundary.js";
import { createHostedRuntime } from "./hosted-runtime.js";
import { createWorkforceDependencies } from "./production-dependencies.js";
import { createWorkforceServer } from "./server.js";

function requestHttp(url: string, options: {
  method?: string; headers?: Record<string, string>; body?: string;
} = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: options.method ?? "GET", headers: options.headers }, response => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
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
    workforceKeys,
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

function createNativeCompanyFile(filename: string, companyId: string): void {
  const company = new Database(filename);
  company.exec(`CREATE TABLE companies(id TEXT PRIMARY KEY); INSERT INTO companies(id) VALUES('${companyId}');
    CREATE TABLE work_orders(id TEXT,status TEXT,completed_at TEXT,company_id TEXT,assigned_user_id TEXT,completion_criteria TEXT);
    CREATE TABLE visits(work_order_id TEXT,account_id TEXT,status TEXT);`);
  company.close();
}

test("production dependency factory composes only existing identity, placement and isolated native stores", async () => {
  const root = mkdtempSync(join(tmpdir(), "titan-workforce-production-composition-"));
  const identityPath = join(root, "identity.sqlite");
  const runtimePath = join(root, "workforce.sqlite");
  const webPath = join(root, "titan-zero.db");
  const companyRoot = join(root, "company-stores");
  const companyPath = join(companyRoot, "placement-a.sqlite");
  const keyRoot = join(root, "verification-keys");
  mkdirSync(companyRoot, { mode: 0o700 });
  mkdirSync(keyRoot, { mode: 0o700 });
  chmodSync(companyRoot, 0o700);
  chmodSync(keyRoot, 0o700);
  const workforceKeys = generateKeyPairSync("ed25519");
  const upstreamKeys = generateKeyPairSync("ed25519");
  const workforceKeyPath = join(keyRoot, "workforce.pem");
  const upstreamKeyPath = join(keyRoot, "upstream.pem");
  writeFileSync(workforceKeyPath, workforceKeys.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o644 });
  writeFileSync(upstreamKeyPath, upstreamKeys.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o644 });

  const identity = createSqliteStorage(identityPath);
  new Database(webPath).close();
  let runtime: ReturnType<typeof createSqliteStorage> | undefined;
  let hostedIdentity: ReturnType<typeof createSqliteStorage> | undefined;
  let dependencies: Awaited<ReturnType<typeof createWorkforceDependencies>> | undefined;
  try {
    const registry = await createIdentitySessionRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    const now = new Date();
    const provider = "directadmin:https://panel.test.invalid";
    await registry.putActor({ actor_id: "lead", status: "active" }, null);
    await registry.putCompany({ company_id: "a", status: "active" }, null);
    await registry.putDevice({ device_id: "device", actor_id: "lead", status: "active" }, null);
    await registry.putMembership({ company_id: "a", actor_id: "lead", role: "owner", status: "active" }, null);
    await registry.putExternalBinding({ binding_id: "binding-a", company_id: "a", actor_id: "lead", provider, subject: "subject", status: "active" }, null);
    const session = await registry.issueSession({ provider, subject: "subject", session_id: "session-a", device_id: "device",
      company_id: "a", audience: "workforce", issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 600_000).toISOString() }, now.toISOString());
    await initializeSqliteCompanyPlacementRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await identity.query(
      "INSERT INTO titan_company_storage_placements (company_id,placement_id,placement_revision,provider,schema_version,status) VALUES ('a','placement-a',1,'sqlite','native-v1','READY')",
    );
    const company = new Database(companyPath);
    company.exec(`CREATE TABLE companies(id TEXT PRIMARY KEY); INSERT INTO companies(id) VALUES('a');
      CREATE TABLE work_orders(id TEXT,status TEXT,completed_at TEXT,company_id TEXT,assigned_user_id TEXT,completion_criteria TEXT);
      CREATE TABLE visits(work_order_id TEXT,account_id TEXT,status TEXT);`);
    company.close();
    await identity.close();

    dependencies = await createWorkforceDependencies({
      WORKFORCE_SQLITE_PATH: runtimePath,
      WORKFORCE_WEB_SQLITE_PATH: webPath,
      WORKFORCE_IDENTITY_SQLITE_PATH: identityPath,
      WORKFORCE_COMPANY_STORE_ROOT: companyRoot,
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
    });
    assert.equal(typeof dependencies.credentialVerifier.verify, "function");
    assert.equal(typeof dependencies.workOrders.complete, "function");
    assert.equal(dependencies.directAdmin, undefined, "no provider module leaves DirectAdmin ingress unmounted");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "workforce-test-key", typ: "titan-session+jwt" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({
      identity_provider: provider, session_id: session.session_id, device_id: session.device_id,
      company_id: session.company_id, actor_id: session.actor_id, session_revision: session.session_revision,
      context_revision: session.context_revision, iss: "titan:workforce-auth", aud: "workforce",
      sub: "subject", node_id: "node-test", csrf_sha256: "c".repeat(43), da_role: "admin",
      iat: nowSeconds, exp: nowSeconds + 300,
    })).toString("base64url");
    const signingInput = header + "." + claims;
    const token = signingInput + "." + sign(null, Buffer.from(signingInput), workforceKeys.privateKey).toString("base64url");
    const verified = await dependencies.credentialVerifier.verify("Bearer " + token, { signal: new AbortController().signal });
    assert.equal(verified.session_id, "session-a", "the configured public KeyObject verifies a real signed session credential");
    assert.deepEqual(await dependencies.readiness({ signal: new AbortController().signal }), {
      authentication: true, authority: false, provider: false, evidence: false,
    }, "readiness reports absent authority/evidence and owner schema attestation as degraded");
    const placement = await dependencies.companyPlacementRegistry.findByCompanyId("a");
    assert.ok(placement);
    await assert.rejects(dependencies.companyStoreOpener.open(placement), /company-native-schema-marker-missing/);

    runtime = createSqliteStorage(runtimePath);
    hostedIdentity = createSqliteStorage(identityPath);
    await createHostedRuntime(runtime, hostedIdentity, dependencies);
    assert.deepEqual(await dependencies.readiness({ signal: new AbortController().signal }), {
      authentication: true, authority: true, provider: false, evidence: true,
    }, "runtime/evidence are durable but provider readiness stays closed until owner attestation exists");
    const identityProbe = createSqliteStorage(identityPath);
    try {
      const placements = await identityProbe.query("SELECT company_id FROM titan_company_storage_placements");
      assert.equal(placements.rowCount, 1, "the composition and readiness probe do not create or rewrite placements");
    } finally { await identityProbe.close(); }
  } finally {
    await dependencies?.close?.({ signal: new AbortController().signal });
    await hostedIdentity?.close();
    await runtime?.close();
    if (identity) await identity.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("production dependency factory mounts the operator DirectAdmin gateway and keeps bootstrap forwarding narrow", async () => {
  const root = mkdtempSync(join(tmpdir(), "titan-workforce-directadmin-mount-"));
  const identityPath = join(root, "identity.sqlite");
  const runtimePath = join(root, "workforce.sqlite");
  const webPath = join(root, "titan-zero.db");
  const companyRoot = join(root, "company-stores");
  const observationPath = join(root, "gateway-request.json");
  const nonceObservationPath = join(root, "nonce-flow-request.json");
  const modulePath = join(root, "directadmin-dependencies.mjs");
  const invalidModulePath = join(root, "invalid-directadmin-dependencies.mjs");
  const { environment } = productionEnvironment({ root, identityPath, runtimePath, webPath, companyRoot });
  const identity = createSqliteStorage(identityPath);
  let dependencies: Awaited<ReturnType<typeof createWorkforceDependencies>> | undefined;
  let host: Awaited<ReturnType<typeof createWorkforceServer>> | undefined;
  try {
    await createIdentitySessionRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await initializeSqliteCompanyPlacementRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await identity.close();

    await assert.rejects(createWorkforceDependencies({
      ...environment,
      WORKFORCE_DIRECTADMIN_DEPENDENCIES_MODULE: "relative/directadmin-dependencies.mjs",
    }), /workforce-production-path-invalid:WORKFORCE_DIRECTADMIN_DEPENDENCIES_MODULE/,
      "an invalid configured provider path fails startup rather than silently disabling the mount");

    writeFileSync(invalidModulePath, `
      export async function createWorkforceDirectAdminDependencies() {
        return { publicOrigin: "https://panel.test.invalid", createGateway() { return async () => new Response(); },
          bootstrapNonceFlow: {} };
      }
    `, { mode: 0o600 });
    await assert.rejects(createWorkforceDependencies({
      ...environment,
      WORKFORCE_DIRECTADMIN_DEPENDENCIES_MODULE: invalidModulePath,
    }), /workforce-directadmin-dependencies-invalid/,
      "a configured malformed bootstrap flow is rejected during operator module loading");

    writeFileSync(modulePath, `
      import { writeFileSync } from "node:fs";
      export async function createWorkforceDirectAdminDependencies() {
        const bootstrapNonceFlow = {
          async issueNonceForUniqueCurrentContext(proof) {
            writeFileSync(${JSON.stringify(nonceObservationPath)}, JSON.stringify(proof));
            return { csrf_nonce: "N".repeat(43), expires_at: "2026-10-02T15:32:00.000Z",
              company_id: "cleaning-company-1", device_id: "cleaning-device-1" };
          },
        };
        return {
          publicOrigin: "https://panel.test.invalid",
          bootstrapNonceFlow,
          createGateway(owners, suppliedNonceFlow) {
            if (typeof owners?.projection !== "function" || typeof owners?.requestIntent !== "function") {
              throw new Error("canonical-workforce-owners-required");
            }
            if (suppliedNonceFlow !== bootstrapNonceFlow) throw new Error("canonical-bootstrap-flow-required");
            return async request => {
              writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({
                method: request.method,
                url: request.url,
                path: new URL(request.url).pathname,
                origin: request.headers.get("origin"),
                nonce: request.headers.get("x-titan-da-bootstrap-csrf"),
                authorization: request.headers.get("authorization"),
                cookie: request.headers.get("cookie"),
              }));
              return new Response(JSON.stringify({ error: "directadmin-service-unavailable" }), {
                status: 503, headers: { "content-type": "application/json" },
              });
            };
          },
        };
      }
    `, { mode: 0o600 });

    dependencies = await createWorkforceDependencies({
      ...environment,
      WORKFORCE_DIRECTADMIN_DEPENDENCIES_MODULE: modulePath,
    });
    assert.equal(dependencies.directAdmin?.publicOrigin, "https://panel.test.invalid");
    assert.equal(typeof dependencies.directAdmin?.createGateway, "function");
    assert.equal(typeof dependencies.directAdmin?.bootstrapNonceFlow?.issueNonceForUniqueCurrentContext, "function");
    host = await createWorkforceServer({ storagePath: runtimePath, dependencies });
    await new Promise<void>((resolve, reject) => {
      host!.server.once("error", reject);
      host!.server.listen(0, "127.0.0.1", resolve);
    });
    const address = host.server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const nonce = "N".repeat(43);
    const directAdminCookie = "session=disposable-browser-session";

    const nonceResponse = await requestHttp(`${baseUrl}/v1/directadmin/bootstrap-nonce`, {
      method: "POST",
      headers: {
        host: "panel.test.invalid",
        origin: "https://panel.test.invalid",
        "sec-fetch-site": "same-origin",
        cookie: "session=disposable-browser-session; key=disposable-browser-key",
        authorization: "Bearer caller-controlled-token",
        "x-titan-company-id": "caller-selected-company",
      },
      body: "",
    });
    assert.equal(nonceResponse.status, 200, nonceResponse.body);
    assert.deepEqual(JSON.parse(nonceResponse.body), { csrf_nonce: nonce },
      "the mounted private nonce route returns only its opaque value, not the canonical cleaning tuple");
    assert.deepEqual(JSON.parse(readFileSync(nonceObservationPath, "utf8")), {
      origin: "https://panel.test.invalid",
      cookie: "session=disposable-browser-session; key=disposable-browser-key",
      authorization: null,
    }, "the actual Workforce listener passes only the filtered DA session proof to the configured #302 flow");

    const bootstrap = await requestHttp(`${baseUrl}/v1/directadmin/bootstrap`, {
      method: "POST",
      headers: {
        host: "panel.test.invalid",
        origin: "https://panel.test.invalid",
        "sec-fetch-site": "same-origin",
        "x-titan-da-bootstrap-csrf": nonce,
        cookie: directAdminCookie,
        authorization: "Bearer caller-controlled-token",
      },
      body: "",
    });
    assert.equal(bootstrap.status, 503, `the mount cannot fabricate a successful bootstrap without the owner provider: ${bootstrap.body}`);
    assert.deepEqual(JSON.parse(bootstrap.body), { error: "directadmin-service-unavailable" });
    assert.deepEqual(JSON.parse(readFileSync(observationPath, "utf8")), {
      method: "POST", url: "https://panel.test.invalid/v1/directadmin/bootstrap",
      path: "/v1/directadmin/bootstrap", origin: "https://panel.test.invalid",
      nonce, authorization: null, cookie: directAdminCookie,
    }, "the production host mounts the operator gateway, pins its URL, preserves the DirectAdmin proof cookie and strips Authorization");

    const context = await requestHttp(`${baseUrl}/v1/directadmin/context`, {
      headers: {
        host: "panel.test.invalid",
        origin: "https://panel.test.invalid",
        "sec-fetch-site": "same-origin",
        "x-titan-da-bootstrap-csrf": nonce,
      },
    });
    assert.equal(context.status, 503);
    assert.deepEqual(JSON.parse(context.body), { error: "directadmin-service-unavailable" });
    const contextObservation = JSON.parse(readFileSync(observationPath, "utf8"));
    assert.equal(contextObservation.url, "https://panel.test.invalid/v1/directadmin/context");
    assert.equal(contextObservation.nonce, null,
      "the one-time bootstrap nonce is forwarded only for the exact bootstrap POST target");

    const bootstrapWithQuery = await requestHttp(`${baseUrl}/v1/directadmin/bootstrap?unexpected=1`, {
      method: "POST",
      headers: {
        host: "panel.test.invalid",
        origin: "https://panel.test.invalid",
        "sec-fetch-site": "same-origin",
        "x-titan-da-bootstrap-csrf": nonce,
      },
      body: "",
    });
    assert.equal(bootstrapWithQuery.status, 503);
    assert.deepEqual(JSON.parse(bootstrapWithQuery.body), { error: "directadmin-service-unavailable" });
    const queryObservation = JSON.parse(readFileSync(observationPath, "utf8"));
    assert.equal(queryObservation.url, "https://panel.test.invalid/v1/directadmin/bootstrap?unexpected=1");
    assert.equal(queryObservation.nonce, null,
      "query-bearing bootstrap near misses do not receive the one-time bootstrap nonce");
  } finally {
    if (host) await host.close();
    else await dependencies?.close?.({ signal: new AbortController().signal });
    await identity.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("production factory fails on an empty identity file without migrating it", async () => {
  const root = mkdtempSync(join(tmpdir(), "titan-workforce-empty-identity-"));
  const identityPath = join(root, "identity.sqlite");
  const runtimePath = join(root, "workforce.sqlite");
  const webPath = join(root, "titan-zero.db");
  const companyRoot = join(root, "company-stores");
  new Database(identityPath).close();
  const { environment } = productionEnvironment({ root, identityPath, runtimePath, webPath, companyRoot });
  try {
    await assert.rejects(createWorkforceDependencies(environment), /workforce-identity-schema-unavailable/);
    const check = new Database(identityPath, { readonly: true });
    try {
      const rows = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'titan_security_%'").all();
      assert.equal(rows.length, 0, "production startup did not create identity schema or provisioning tables");
    } finally { check.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production dependency close releases owned stores even when its signal is already aborted", async () => {
  const root = mkdtempSync(join(tmpdir(), "titan-workforce-aborted-close-"));
  const identityPath = join(root, "identity.sqlite");
  const runtimePath = join(root, "workforce.sqlite");
  const webPath = join(root, "titan-zero.db");
  const companyRoot = join(root, "company-stores");
  const identity = createSqliteStorage(identityPath);
  let dependencies: Awaited<ReturnType<typeof createWorkforceDependencies>> | undefined;
  try {
    await createIdentitySessionRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await initializeSqliteCompanyPlacementRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await identity.close();
    const { environment } = productionEnvironment({ root, identityPath, runtimePath, webPath, companyRoot });
    const composed = await createWorkforceDependencies(environment);
    dependencies = composed;
    assert.ok(composed.close, "production dependencies own a close hook");
    const close = composed.close;
    const shutdown = new AbortController();
    shutdown.abort();
    await assert.rejects(close({ signal: shutdown.signal }), { name: "AbortError" });
    assert.deepEqual(await composed.readiness({ signal: new AbortController().signal }), {
      authentication: false, authority: false, provider: false, evidence: false,
    }, "an aborted shutdown signal does not skip closing owned storage connections");
  } finally {
    await dependencies?.close?.({ signal: new AbortController().signal }).catch(() => undefined);
    await identity.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("production readiness rejects a company store that aliases the read-only web database", async () => {
  const root = mkdtempSync(join(tmpdir(), "titan-workforce-web-alias-"));
  const identityPath = join(root, "identity.sqlite");
  const runtimePath = join(root, "workforce.sqlite");
  const webPath = join(root, "titan-zero.db");
  const companyRoot = join(root, "company-stores");
  const companyStorePath = join(companyRoot, "placement-a.sqlite");
  const identity = createSqliteStorage(identityPath);
  let dependencies: Awaited<ReturnType<typeof createWorkforceDependencies>> | undefined;
  try {
    await createIdentitySessionRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await initializeSqliteCompanyPlacementRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await identity.query("INSERT INTO titan_company_storage_placements (company_id,placement_id,placement_revision,provider,schema_version,status) VALUES ('a','placement-a',1,'sqlite','native-v1','READY')");
    await identity.close();
    const { environment } = productionEnvironment({ root, identityPath, runtimePath, webPath, companyRoot });
    createNativeCompanyFile(webPath, "a");
    linkSync(webPath, companyStorePath);

    dependencies = await createWorkforceDependencies(environment);
    assert.deepEqual(await dependencies.readiness({ signal: new AbortController().signal }), {
      authentication: true, authority: false, provider: false, evidence: false,
    }, "an aliased company database cannot make provider readiness green");
    const placement = await dependencies.companyPlacementRegistry.findByCompanyId("a");
    assert.ok(placement);
    await assert.rejects(dependencies.companyStoreOpener.open(placement), /workforce-company-store-physical-isolation-required/);
  } finally {
    await dependencies?.close?.({ signal: new AbortController().signal });
    await identity.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("production readiness rejects swapped physical company databases", async () => {
  const root = mkdtempSync(join(tmpdir(), "titan-workforce-swapped-stores-"));
  const identityPath = join(root, "identity.sqlite");
  const runtimePath = join(root, "workforce.sqlite");
  const webPath = join(root, "titan-zero.db");
  const companyRoot = join(root, "company-stores");
  const identity = createSqliteStorage(identityPath);
  let dependencies: Awaited<ReturnType<typeof createWorkforceDependencies>> | undefined;
  try {
    await createIdentitySessionRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await initializeSqliteCompanyPlacementRegistry({ storage: identity, storage_role: "GLOBAL_REGISTRY" });
    await identity.query("INSERT INTO titan_company_storage_placements (company_id,placement_id,placement_revision,provider,schema_version,status) VALUES ('a','placement-a',1,'sqlite','native-v1','READY'),('b','placement-b',1,'sqlite','native-v1','READY')");
    await identity.close();
    const { environment } = productionEnvironment({ root, identityPath, runtimePath, webPath, companyRoot });
    createNativeCompanyFile(join(companyRoot, "placement-a.sqlite"), "b");
    createNativeCompanyFile(join(companyRoot, "placement-b.sqlite"), "a");

    dependencies = await createWorkforceDependencies(environment);
    assert.deepEqual(await dependencies.readiness({ signal: new AbortController().signal }), {
      authentication: true, authority: false, provider: false, evidence: false,
    }, "the registered company is checked against the actual physical database contents");
    const placement = await dependencies.companyPlacementRegistry.findByCompanyId("a");
    assert.ok(placement);
    await assert.rejects(dependencies.companyStoreOpener.open(placement), /workforce-company-store-identity-mismatch/);
  } finally {
    await dependencies?.close?.({ signal: new AbortController().signal });
    await identity.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
