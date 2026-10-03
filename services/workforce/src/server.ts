import { createServer, type Server, type ServerResponse } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { createSqliteStorage, type StorageClient } from "../../../packages/storage/src/index.js";
import { SqliteWorkforceStore } from "./sqlite-store.js";
import { createHostedRuntime, type HostedWorkforceDependencies } from "./hosted-runtime.js";
import { createDirectAdminWorkforceOwners, type DirectAdminFetchHandler } from "./directadmin-workforce-owners.js";
import { withDirectAdminBootstrapNonceRoute } from "./directadmin-bootstrap-nonce-route.js";
import { handleConversationRequest, readConversationBody, writeConversationResponse, conversationHttpStatus } from "./conversation-api.js";

// @ts-expect-error Canonical execution boundary is JavaScript.
import { boundedAdapterCall } from "../../../packages/tools/execution-gateway.mjs";

export interface WorkforceServer { server: Server; close(): Promise<void>; }
export type WorkforceServerOptions = { storagePath?: string; dependencies?: HostedWorkforceDependencies; shutdownTimeoutMs?: number };
const conversationPath = "/v1/workforce/conversations";
async function assertSeparateFiles(runtimePath: string, identityPath: string) {
  const inspect = (path: string) => stat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const [runtimeFile, identityFile] = await Promise.all([inspect(runtimePath), inspect(identityPath)]);
  if (runtimeFile && identityFile && runtimeFile.dev === identityFile.dev && runtimeFile.ino === identityFile.ino) {
    throw new Error("workforce-separate-identity-storage-required");
  }
}

/** Keep one underlying set of SQLite readiness reads active across HTTP timeouts.
 * The canonical storage client serializes queries behind its async transaction;
 * retrying a timed-out request must not enqueue more reads behind that fence. */
export function createReadinessStorageProbe(storage: StorageClient, identityStorage?: StorageClient, hosted = false) {
  let pending: Promise<void> | undefined;
  return (): Promise<void> => {
    if (pending) return pending;
    const checking = (async () => {
      await storage.query("SELECT 1 FROM workforce_work_items LIMIT 1");
      if (hosted) await storage.query("SELECT 1 FROM agent_runs LIMIT 1");
      if (hosted && identityStorage) await identityStorage.query("SELECT 1 FROM titan_security_sessions LIMIT 1");
    })();
    let coalesced: Promise<void>;
    coalesced = checking.finally(() => { if (pending === coalesced) pending = undefined; });
    pending = coalesced;
    return coalesced;
  };
}

function json(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

const directAdminForwardHeaders = ["cookie", "sec-fetch-site", "origin", "referer", "x-titan-csrf", "content-type", "content-encoding", "accept"] as const;
const directAdminBootstrapForwardHeaders = ["x-titan-da-bootstrap-csrf"] as const;
function assertDirectAdminOrigin(value: string): void {
  try {
    const origin = new URL(value);
    if (origin.protocol !== "https:" || origin.origin !== value) throw new Error();
  } catch { throw new Error("workforce-directadmin-origin-invalid"); }
}

function directAdminRequest(request: import("node:http").IncomingMessage, publicOrigin: string, signal?: AbortSignal): Request {
  const origin = new URL(publicOrigin);
  const suppliedHost = request.headers.host;
  let host: URL;
  try { host = new URL(`https://${suppliedHost ?? ""}`); }
  catch { throw new Error("directadmin-origin-mismatch"); }
  if (origin.protocol !== "https:" || origin.origin !== publicOrigin || host.host !== origin.host || host.username || host.password ||
      host.pathname !== "/" || host.search || host.hash) throw new Error("directadmin-origin-mismatch");
  const target = request.url ?? "/";
  if (!target.startsWith("/") || target.startsWith("//")) throw new Error("directadmin-request-target-invalid");
  const url = new URL(target, origin);
  if (url.origin !== publicOrigin) throw new Error("directadmin-origin-mismatch");
  const method = request.method ?? "GET";
  const bootstrapRequest = method === "POST" && target === "/v1/directadmin/bootstrap";
  const headers = new Headers();
  for (const name of [...directAdminForwardHeaders, ...(bootstrapRequest ? directAdminBootstrapForwardHeaders : [])]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, name === "cookie" ? value.join("; ") : value.join(", "));
  }
  const init: RequestInit & { duplex?: "half" } = { method, headers, redirect: "error", signal };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeFetchResponse(response: ServerResponse, result: Response): Promise<void> {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  if (!result.body) { response.end(); return; }
  const body = Readable.fromWeb(result.body as never);
  await new Promise<void>((resolve, reject) => {
    const done = () => resolve();
    const failed = (error: Error) => reject(error);
    response.once("finish", done);
    response.once("close", done);
    response.once("error", failed);
    body.once("error", failed);
    response.once("close", () => body.destroy());
    body.pipe(response);
  });
}

export async function createWorkforceServer(options: WorkforceServerOptions = {}): Promise<WorkforceServer> {
  const storagePath = options.storagePath ?? process.env.WORKFORCE_SQLITE_PATH ?? "/app/runtime/workforce.db";
  const dependencies = options.dependencies;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 120_000) throw new Error("workforce-shutdown-timeout-invalid");
  if (dependencies?.directAdmin) assertDirectAdminOrigin(dependencies.directAdmin.publicOrigin);
  const lifecycle = new AbortController();
  if (dependencies && (!dependencies.identityStoragePath || resolve(dependencies.identityStoragePath) === resolve(storagePath))) {
    throw new Error("workforce-separate-identity-storage-required");
  }
  if (dependencies) await assertSeparateFiles(storagePath, dependencies.identityStoragePath);
  const storage = createSqliteStorage(storagePath);
  let identityStorage: ReturnType<typeof createSqliteStorage> | undefined;
  let hosted: Awaited<ReturnType<typeof createHostedRuntime>> | undefined;
  let directAdmin: DirectAdminFetchHandler | undefined;
  try {
    if (dependencies) {
      // Opening runtime storage materializes its file before the comparison, so
      // aliases through symlinked directories and previously dangling links are
      // resolved by stat. Device/inode also catches distinct hard-link names.
      await assertSeparateFiles(storagePath, dependencies.identityStoragePath);
    }
    await new SqliteWorkforceStore(storage).migrate();
    if (dependencies) {
      // Provisioning belongs to #302. Startup never creates actors, sessions or grants.
      identityStorage = createSqliteStorage(dependencies.identityStoragePath);
      hosted = await createHostedRuntime(storage, identityStorage, dependencies, lifecycle.signal);
      if (dependencies.directAdmin) {
        const owners = createDirectAdminWorkforceOwners(hosted.runtime);
        const gateway = dependencies.directAdmin.createGateway(owners, dependencies.directAdmin.bootstrapNonceFlow);
        if (typeof gateway !== "function") throw new Error("workforce-directadmin-gateway-invalid");
        directAdmin = withDirectAdminBootstrapNonceRoute(gateway, {
          publicOrigin: dependencies.directAdmin.publicOrigin,
          flow: dependencies.directAdmin.bootstrapNonceFlow,
        });
      }
    }
  } catch (error) {
    try { await identityStorage?.close(); } catch { /* preserve the original startup error */ }
    try { await storage.close(); } catch { /* preserve the original startup error */ }
    try { await dependencies?.close?.({ signal: AbortSignal.timeout(1000) }); }
    catch { /* preserve the original startup error */ }
    throw error;
  }
  let running = true;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<void>>();
  let probe: Promise<Record<string, string>> | undefined;
  const checkStorage = createReadinessStorageProbe(storage, identityStorage, Boolean(hosted));
  async function checks(): Promise<Record<string, string>> {
    if (probe) return probe;
    const checking = boundedAdapterCall(async (signal: AbortSignal) => {
      const result: Record<string, string> = { storage: "fail", runtime: hosted ? "ok" : "unconfigured", authentication: "fail", authority: "fail", provider: "fail", evidence: "fail" };
      try {
        signal.throwIfAborted();
        await checkStorage();
        signal.throwIfAborted();
        result.storage = "ok";
        if (hosted && identityStorage && dependencies) {
          const observed = await dependencies.readiness({ signal });
          signal.throwIfAborted();
          for (const key of ["authentication", "authority", "provider", "evidence"] as const) result[key] = observed[key] === true ? "ok" : "fail";
        }
      } catch { result.runtime = "fail"; }
      return result;
    }, { timeoutMs: 1000, signal: lifecycle.signal }).catch(() => ({
      storage: "fail", runtime: hosted ? "fail" : "unconfigured", authentication: "fail",
      authority: "fail", provider: "fail", evidence: "fail",
    }));
    let coalesced: Promise<Record<string, string>>;
    coalesced = checking.finally(() => { if (probe === coalesced) probe = undefined; });
    probe = coalesced;
    return coalesced;
  }
  const server = createServer((request, response) => {
    const task = (async () => {
      let pathname: string;
      try { pathname = new URL(request.url ?? "/", "http://workforce.internal").pathname; }
      catch { json(response, 400, { error: "invalid_request_target" }); return; }
      if (!running) { json(response, 503, { error: "workforce-stopping" }); return; }
      if (pathname.startsWith("/v1/directadmin/")) {
        if (!directAdmin || !dependencies?.directAdmin) {
          json(response, 503, { error: "directadmin-gateway-not-configured", read_only: true }); return;
        }
        try {
          const gatewayResponse = await boundedAdapterCall((signal: AbortSignal) =>
            directAdmin(directAdminRequest(request, dependencies.directAdmin!.publicOrigin, signal)), {
              timeoutMs: dependencies.adapterTimeoutMs ?? 30_000, signal: lifecycle.signal,
            });
          await writeFetchResponse(response, gatewayResponse);
        } catch (error) {
          const invalidTarget = error instanceof Error && error.message === "directadmin-request-target-invalid";
          const invalidOrigin = error instanceof Error && error.message === "directadmin-origin-mismatch";
          json(response, invalidTarget || invalidOrigin ? 400 : 503, {
            error: invalidTarget ? "directadmin-request-target-invalid" : invalidOrigin ? "directadmin-origin-mismatch" : "directadmin-gateway-unavailable",
            read_only: true,
          });
        }
        return;
      }
      if (pathname === conversationPath) {
        if (request.method !== "POST") { response.setHeader("allow", "POST"); json(response, 405, { error: "method_not_allowed" }); return; }
        if (!hosted) { json(response, 503, { error: "conversation-host-not-configured" }); return; }
        const body = await readConversationBody(request);
        const value = await handleConversationRequest(body, hosted.auth, {
          dispatch: hosted.runtime.dispatch,
          recover: hosted.runtime.recover,
          cancel: input => hosted!.runtime.zeroDispatcher.cancel(input),
        }, request.headers.authorization);
        if (!response.destroyed) writeConversationResponse(response, value, request.headers.accept?.includes("text/event-stream") === true,
          typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined);
        return;
      }
      if (pathname !== "/health" && pathname !== "/ready") { json(response, 404, { error: "not_found" }); return; }
      if (request.method !== "GET") { response.setHeader("allow", "GET"); json(response, 405, { error: "method_not_allowed" }); return; }
      if (pathname === "/health") { json(response, 200, { status: "ok", service: "workforce", checks: { process: "ok" } }); return; }
      const status = await checks();
      const ready = running && Object.values(status).every(value => value === "ok");
      json(response, ready ? 200 : 503, { status: ready ? "ok" : "degraded", service: "workforce", checks: status });
    })().catch(error => {
      // Internal provider/database errors may contain credentials. Only bounded protocol codes leave the host.
      const code = error instanceof Error && (/^(conversation|zero)-[a-z-]+$/.test(error.message)
        || error.message === "identity-registry-unavailable") ? error.message : "conversation-failed";
      json(response, conversationHttpStatus(code), { error: code });
    }).finally(() => { active.delete(task); });
    active.add(task);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return { server, close() {
    if (closing) return closing;
    running = false;
    closing = (async () => {
      // Graceful first: disconnected clients do not cancel delegated work. After
      // the drain deadline abort adapters and mark interrupted execution uncertain.
      // Storage stays open until bounded handlers persist their recovery state.
      const timer = setTimeout(() => {
        lifecycle.abort(new Error("workforce-shutdown"));
        server.closeAllConnections();
      }, shutdownTimeoutMs);
      try {
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await Promise.allSettled([...active]);
        lifecycle.abort(new Error("workforce-shutdown"));
        if (probe) await probe;
        if (dependencies?.close) await boundedAdapterCall((signal: AbortSignal) => dependencies.close!({ signal }), { timeoutMs: 1000 });
      } finally {
        clearTimeout(timer);
        try { await identityStorage?.close(); } finally { await storage.close(); }
      }
    })();
    return closing;
  } };
}

/** Operator-owned module; never selectable by HTTP input. Missing configuration fails closed. */
export async function loadWorkforceDependencies(modulePath = process.env.WORKFORCE_DEPENDENCIES_MODULE): Promise<HostedWorkforceDependencies> {
  if (!modulePath || !isAbsolute(modulePath)) throw new Error("workforce-dependencies-module-required");
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.createWorkforceDependencies !== "function") throw new Error("workforce-dependencies-factory-required");
  const dependencies = await module.createWorkforceDependencies();
  if (!dependencies || typeof dependencies.credentialVerifier?.verify !== "function"
    || typeof dependencies.companyPlacementRegistry?.findByCompanyId !== "function"
    || typeof dependencies.companyStoreOpener?.open !== "function"
    || typeof dependencies.workOrders?.read !== "function" ||
    typeof dependencies.workOrders?.complete !== "function" || typeof dependencies.readiness !== "function" ||
    (dependencies.directAdmin !== undefined && (typeof dependencies.directAdmin.publicOrigin !== "string" ||
      typeof dependencies.directAdmin.createGateway !== "function"))) throw new Error("workforce-dependencies-invalid");
  if (dependencies.directAdmin) {
    assertDirectAdminOrigin(dependencies.directAdmin.publicOrigin);
  }
  return dependencies;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dependencies = await loadWorkforceDependencies();
  const workforce = await createWorkforceServer({ dependencies });
  workforce.server.listen(Number(process.env.WORKFORCE_PORT ?? "3010"), "0.0.0.0", () => console.log("[workforce] listening"));
  const shutdown = () => { void workforce.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
