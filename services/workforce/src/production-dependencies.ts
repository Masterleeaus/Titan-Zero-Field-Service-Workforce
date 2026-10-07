import { createPublicKey, webcrypto, type KeyObject } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createSqliteCompanyPlacementRegistry,
  createSqliteCompanyStoreOpener,
  createSqliteStorage,
  openExistingSqliteStorage,
  type StorageClient,
} from "../../../packages/storage/src/index.js";
import { verifyCompanyNativeSchemaAttestation } from "../../../packages/storage/src/company-native-schema-attestation.js";
import { companyNativeWorkOrdersManifest } from "../../../packages/storage/src/company-native-schema-manifest.js";
import { IdentitySessionRegistry } from "../../../packages/titan-platform/src/security-boundary.js";
import type { createSessionCredentialService } from "../../../packages/titan-platform/src/security-boundary.js";
import { DirectAdminSessionBridge } from "../../../packages/titan-platform/src/directadmin-session-bridge.js";
import { createDirectAdminGateway, type DirectAdminBootstrapAssertionProvider,
  type DirectAdminGatewayOwners } from "../../../packages/titan-platform/src/directadmin-gateway.js";
import { createWorkforceSessionCredentialVerifier } from "./session-credential-verifier.js";
import type { DirectAdminBootstrapNonceFlow } from "./directadmin-bootstrap-nonce-route.js";
import type { HostedWorkforceDependencies } from "./hosted-runtime.js";
// @ts-expect-error The native FSM owner is TypeScript and runs through the configured tsx loader.
import { createNativeWorkOrders } from "./native-work-orders.mjs";

type WorkforceEnvironment = Readonly<Record<string, string | undefined>>;
type DirectAdminDependencies = NonNullable<HostedWorkforceDependencies["directAdmin"]>;
type DirectAdminSessions = Pick<ReturnType<typeof createSessionCredentialService>,
  "issue" | "authenticate" | "switchCompany" | "revoke" | "exchangeWorkforceZero">;
type PublicAlgorithm = "EdDSA" | "ES256" | "RS256";

function required(environment: WorkforceEnvironment, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error("workforce-production-config-required:" + name);
  }
  return value;
}

function absolutePath(environment: WorkforceEnvironment, name: string): string {
  const value = required(environment, name);
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error("workforce-production-path-invalid:" + name);
  return value;
}

/**
 * Load only the operator-owned #302 session service and trusted #302/#1049
 * bootstrap flow. Workforce constructs the canonical #1049 bridge and
 * gateway itself; the operator module cannot substitute a request handler.
 * No module means the route remains disabled; a configured invalid module
 * fails startup. The provider must own authenticated DirectAdmin proof and an
 * atomic pre-auth nonce consumer; never replace them with local replay state.
 */
async function loadDirectAdminDependencies(environment: WorkforceEnvironment, nodeId: string): Promise<DirectAdminDependencies | undefined> {
  const name = "WORKFORCE_DIRECTADMIN_DEPENDENCIES_MODULE";
  const modulePath = environment[name];
  if (modulePath === undefined || modulePath === "") return undefined;
  if (!isAbsolute(modulePath) || resolve(modulePath) !== modulePath) {
    throw new Error("workforce-production-path-invalid:" + name);
  }

  let module: Record<string, unknown>;
  try { module = await import(pathToFileURL(modulePath).href); }
  catch { throw new Error("workforce-directadmin-dependencies-unavailable"); }
  const create = module.createWorkforceDirectAdminHostServices;
  if (typeof create !== "function") throw new Error("workforce-directadmin-dependencies-factory-required");

  let value: unknown;
  try { value = await create(); }
  catch { throw new Error("workforce-directadmin-dependencies-unavailable"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workforce-directadmin-dependencies-invalid");
  }
  const candidate = value as Record<string, unknown>;
  const sessions = candidate.sessions;
  const bootstrapProvider = candidate.bootstrapProvider;
  const bootstrapNonceFlow = candidate.bootstrapNonceFlow;
  if (typeof candidate.publicOrigin !== "string" || !sessions || typeof sessions !== "object" || Array.isArray(sessions) ||
      !["issue", "authenticate", "switchCompany", "revoke", "exchangeWorkforceZero"]
        .every(method => typeof (sessions as Record<string, unknown>)[method] === "function") ||
      !bootstrapProvider || typeof bootstrapProvider !== "object" || Array.isArray(bootstrapProvider) ||
      typeof (bootstrapProvider as Record<string, unknown>).provide !== "function" ||
      (bootstrapNonceFlow !== undefined && (bootstrapNonceFlow !== bootstrapProvider ||
        typeof (bootstrapNonceFlow as Record<string, unknown>).issueNonceForUniqueCurrentContext !== "function"))) {
    throw new Error("workforce-directadmin-dependencies-invalid");
  }
  let bridge: DirectAdminSessionBridge;
  try {
    bridge = new DirectAdminSessionBridge({
      origin: candidate.publicOrigin,
      audience: `titan-directadmin:${nodeId}`,
      node_id: nodeId,
      sessions: sessions as DirectAdminSessions,
    });
  } catch { throw new Error("workforce-directadmin-dependencies-invalid"); }
  const provider = bootstrapProvider as DirectAdminBootstrapAssertionProvider;
  return Object.freeze({
    publicOrigin: candidate.publicOrigin,
    createGateway: (owners: Parameters<DirectAdminDependencies["createGateway"]>[0]) =>
      createDirectAdminGateway(bridge, owners as DirectAdminGatewayOwners, provider),
    ...(bootstrapNonceFlow === undefined ? {} : { bootstrapNonceFlow: bootstrapNonceFlow as DirectAdminBootstrapNonceFlow }),
  });
}

function algorithm(environment: WorkforceEnvironment, name: string): PublicAlgorithm {
  const value = required(environment, name);
  if (value !== "EdDSA" && value !== "ES256" && value !== "RS256") {
    throw new Error("workforce-production-algorithm-invalid:" + name);
  }
  return value;
}

async function loadPublicKey(environment: WorkforceEnvironment, pathName: string, algorithmName: string): Promise<CryptoKey> {
  const filename = absolutePath(environment, pathName);
  const [info, canonical, pem] = await Promise.all([lstat(filename), realpath(filename), readFile(filename, "utf8")]);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o022) !== 0 || canonical !== filename
    || !pem.startsWith("-----BEGIN PUBLIC KEY-----") || pem.includes("PRIVATE KEY-----")) {
    throw new Error("workforce-production-public-key-invalid:" + pathName);
  }
  let key: KeyObject;
  try { key = createPublicKey(pem); }
  catch { throw new Error("workforce-production-public-key-invalid:" + pathName); }
  const configured = algorithm(environment, algorithmName);
  const keyType = key.asymmetricKeyType;
  const compatible = configured === "EdDSA" ? keyType === "ed25519"
    : configured === "ES256" ? keyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      : keyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048;
  if (!compatible) throw new Error("workforce-production-public-key-algorithm-mismatch:" + pathName);
  const importAlgorithm = configured === "EdDSA" ? { name: "Ed25519" }
    : configured === "ES256" ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const spki = key.export({ format: "der", type: "spki" });
  try { return await webcrypto.subtle.importKey("spki", spki, importAlgorithm, false, ["verify"]); }
  catch { throw new Error("workforce-production-public-key-invalid:" + pathName); }
}

async function assertSeparateStores(runtimePath: string, identityPath: string, webPath: string): Promise<void> {
  if (runtimePath === identityPath || runtimePath === webPath || identityPath === webPath) {
    throw new Error("workforce-separate-control-storage-required");
  }
  const identityInfo = await lstat(identityPath).catch(() => undefined);
  if (!identityInfo || identityInfo.isSymbolicLink() || !identityInfo.isFile()) {
    throw new Error("workforce-identity-storage-existing-file-required");
  }
  const webInfo = await lstat(webPath).catch(() => undefined);
  if (!webInfo || webInfo.isSymbolicLink() || !webInfo.isFile()) {
    throw new Error("workforce-web-storage-existing-file-required");
  }
  const runtimeInfo = await lstat(runtimePath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (runtimeInfo?.isSymbolicLink()) throw new Error("workforce-runtime-storage-path-invalid");
  const [runtimeStat, identityStat, webStat] = await Promise.all([
    runtimeInfo ? stat(runtimePath) : Promise.resolve(undefined), stat(identityPath), stat(webPath),
  ]);
  if (identityStat.dev === webStat.dev && identityStat.ino === webStat.ino) {
    throw new Error("workforce-separate-control-storage-required");
  }
  if (runtimeStat && [identityStat, webStat].some(other => runtimeStat.dev === other.dev && runtimeStat.ino === other.ino)) {
    throw new Error("workforce-separate-control-storage-required");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function sqliteFileIdentity(storage: StorageClient): Promise<Readonly<{ device: number; inode: number }>> {
  const files = (await storage.query<{ name: string; file: string }>("PRAGMA database_list")).rows;
  const main = files.filter(row => row.name === "main");
  if (main.length !== 1 || !isAbsolute(main[0].file)) throw new Error("workforce-sqlite-file-identity-unavailable");
  const canonical = await realpath(main[0].file);
  const info = await stat(canonical);
  return Object.freeze({ device: info.dev, inode: info.ino });
}

function sameFile(a: Readonly<{ device: number; inode: number }>, b: Readonly<{ device: number; inode: number }>): boolean {
  return a.device === b.device && a.inode === b.inode;
}

/**
 * Operator-configured production composition. It only opens existing identity,
 * placement and company stores; it never provisions identities, creates
 * placement rows, grants authority, or marks a company store READY.
 */
export async function createWorkforceDependencies(
  environment: WorkforceEnvironment = process.env,
): Promise<HostedWorkforceDependencies> {
  const identityStoragePath = absolutePath(environment, "WORKFORCE_IDENTITY_SQLITE_PATH");
  const webStoragePath = absolutePath(environment, "WORKFORCE_WEB_SQLITE_PATH");
  const runtimeStoragePath = environment.WORKFORCE_SQLITE_PATH ?? "/app/runtime/workforce.db";
  if (!isAbsolute(runtimeStoragePath) || resolve(runtimeStoragePath) !== runtimeStoragePath) {
    throw new Error("workforce-production-path-invalid:WORKFORCE_SQLITE_PATH");
  }
  await assertSeparateStores(runtimeStoragePath, identityStoragePath, webStoragePath);

  const companyStoreRoot = absolutePath(environment, "WORKFORCE_COMPANY_STORE_ROOT");
  const workforceAlgorithm = algorithm(environment, "WORKFORCE_SESSION_ALGORITHM");
  const upstreamAlgorithm = algorithm(environment, "WORKFORCE_UPSTREAM_SESSION_ALGORITHM");
  const workforceVerificationKey = await loadPublicKey(environment, "WORKFORCE_SESSION_PUBLIC_KEY_PATH", "WORKFORCE_SESSION_ALGORITHM");
  const upstreamVerificationKey = await loadPublicKey(environment, "WORKFORCE_UPSTREAM_SESSION_PUBLIC_KEY_PATH", "WORKFORCE_UPSTREAM_SESSION_ALGORITHM");
  const directAdminNodeId = required(environment, "WORKFORCE_DIRECTADMIN_NODE_ID");
  const directAdmin = await loadDirectAdminDependencies(environment, directAdminNodeId);

  // These files and registry records are commissioned outside this module. The
  // placement owner reads an already migrated registry; it does not initialize it.
  const identityStorage = openExistingSqliteStorage(identityStoragePath);
  let runtimeProbeStorage: StorageClient | undefined;
  try {
    let identityVersions: Array<{ version: number }>;
    try {
      identityVersions = (await identityStorage.query<{ version: number }>(
        "SELECT version FROM titan_security_migrations ORDER BY version",
      )).rows;
    } catch { throw new Error("workforce-identity-schema-unavailable"); }
    if (identityVersions.length !== 1 || identityVersions[0].version !== 1) {
      throw new Error("workforce-identity-schema-unavailable");
    }
    const identityRegistry = new IdentitySessionRegistry(identityStorage);
    const companyPlacementRegistry = await createSqliteCompanyPlacementRegistry({ storage: identityStorage, storage_role: "GLOBAL_REGISTRY" });
    const physicalCompanyStoreOpener = createSqliteCompanyStoreOpener({ companyStoreRoot });
    const credentialVerifier = createWorkforceSessionCredentialVerifier({
      registry: identityRegistry,
      directadmin: { node_id: directAdminNodeId },
      issuer: required(environment, "WORKFORCE_SESSION_ISSUER"),
      key_id: required(environment, "WORKFORCE_SESSION_KEY_ID"),
      algorithm: workforceAlgorithm,
      verification_key: workforceVerificationKey,
      upstream: {
        issuer: required(environment, "WORKFORCE_UPSTREAM_SESSION_ISSUER"),
        audience: required(environment, "WORKFORCE_UPSTREAM_SESSION_AUDIENCE"),
        key_id: required(environment, "WORKFORCE_UPSTREAM_SESSION_KEY_ID"),
        algorithm: upstreamAlgorithm,
        verification_key: upstreamVerificationKey,
      },
    });

    // The production runtime owns this control database. Creating the empty
    // control file here is equivalent to the server's own createSqliteStorage;
    // all lifecycle, authority and accepted-evidence rows are written by owners.
    runtimeProbeStorage = createSqliteStorage(runtimeStoragePath);
    const registryFile = await sqliteFileIdentity(identityStorage);
    const runtimeFile = await sqliteFileIdentity(runtimeProbeStorage);
    const webInfo = await stat(webStoragePath);
    const webFile = Object.freeze({ device: webInfo.dev, inode: webInfo.ino });
    if (sameFile(registryFile, runtimeFile) || sameFile(registryFile, webFile)
      || sameFile(runtimeFile, webFile)) throw new Error("workforce-separate-control-storage-required");
    // The #809 native consumer verifies the pinned company-local witness. This
    // observes physical schema only; placement provisioning and READY remain
    // with the placement owner.
    let validatedPlacementVersion: number | undefined;
    let validatedCompanyStores = new Map<string, Readonly<{
      placement_id: string; placement_revision: number; file: Readonly<{ device: number; inode: number }>;
    }>>();
    let validatingCompanyStores: Promise<void> | undefined;
    const placementDataVersion = async (): Promise<number> => {
      const row = (await identityStorage.query<{ data_version: number }>("PRAGMA data_version")).rows[0];
      if (!row || !Number.isSafeInteger(row.data_version)) throw new Error("workforce-placement-registry-version-unavailable");
      return row.data_version;
    };
    const scanReadyCompanyStores = async (signal?: AbortSignal) => {
      const rows = await identityStorage.query<{
        company_id: string; placement_id: string; placement_revision: number;
        provider: string; schema_version: string; status: string;
      }>("SELECT company_id,placement_id,placement_revision,provider,schema_version,status FROM titan_company_storage_placements WHERE status='READY' ORDER BY company_id");
      const seenFiles = new Set<string>();
      const next = new Map<string, Readonly<{
        placement_id: string; placement_revision: number; file: Readonly<{ device: number; inode: number }>;
      }>>();
      for (const row of rows.rows) {
        throwIfAborted(signal);
        const placement = await companyPlacementRegistry.findByCompanyId(row.company_id, { signal });
        if (!placement || placement.status !== "READY" || placement.placement_id !== row.placement_id
          || placement.placement_revision !== row.placement_revision || placement.provider !== row.provider
          || placement.schema_version !== row.schema_version) {
          throw new Error("workforce-company-placement-registry-changed");
        }
        const opened = await physicalCompanyStoreOpener.open(placement, { signal });
        try {
          const file = await sqliteFileIdentity(opened.client);
          if (sameFile(file, registryFile) || sameFile(file, runtimeFile) || sameFile(file, webFile)) {
            throw new Error("workforce-company-store-physical-isolation-required");
          }
          const fileKey = `${file.device}:${file.inode}`;
          if (seenFiles.has(fileKey)) throw new Error("workforce-company-store-physical-isolation-required");
          seenFiles.add(fileKey);
          const companies = await opened.client.query<{ id: string }>("SELECT id FROM companies ORDER BY id");
          if (companies.rowCount !== 1 || companies.rows[0]?.id !== row.company_id) {
            throw new Error("workforce-company-store-identity-mismatch");
          }
          await opened.client.query(
            "SELECT id,status,completed_at,company_id,assigned_user_id,completion_criteria FROM work_orders LIMIT 0",
          );
          await opened.client.query("SELECT work_order_id,account_id,status FROM visits LIMIT 0");
          await verifyCompanyNativeSchemaAttestation({
            storage: opened.client, placement, manifest: companyNativeWorkOrdersManifest,
          });
          await opened.assertPlacementBound();
          next.set(row.company_id, Object.freeze({
            placement_id: placement.placement_id, placement_revision: placement.placement_revision, file,
          }));
        } finally { await opened.client.close(); }
      }
      return next;
    };
    const ensureCompanyStoreIsolation = async (signal?: AbortSignal): Promise<number> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        throwIfAborted(signal);
        const before = await placementDataVersion();
        if (validatedPlacementVersion === before) return validatedCompanyStores.size;
        if (validatingCompanyStores) {
          await validatingCompanyStores;
          continue;
        }
        const validation = (async () => {
          const next = await scanReadyCompanyStores(signal);
          const after = await placementDataVersion();
          if (after !== before) return;
          validatedCompanyStores = next;
          validatedPlacementVersion = before;
        })();
        validatingCompanyStores = validation;
        try { await validation; }
        finally { if (validatingCompanyStores === validation) validatingCompanyStores = undefined; }
        if (validatedPlacementVersion === before) return validatedCompanyStores.size;
      }
      throw new Error("workforce-company-placement-registry-unstable");
    };
    const companyStoreOpener = Object.freeze({
      async open(placement: Parameters<typeof physicalCompanyStoreOpener.open>[0], options?: Parameters<typeof physicalCompanyStoreOpener.open>[1]) {
        await ensureCompanyStoreIsolation(options?.signal);
        const validated = validatedCompanyStores.get(placement.company_id);
        if (!validated || validated.placement_id !== placement.placement_id
          || validated.placement_revision !== placement.placement_revision) {
          throw new Error("workforce-company-store-physical-isolation-required");
        }
        const opened = await physicalCompanyStoreOpener.open(placement, options);
        try {
          const companyFile = await sqliteFileIdentity(opened.client);
          if (sameFile(companyFile, registryFile) || sameFile(companyFile, runtimeFile) || sameFile(companyFile, webFile)
            || !sameFile(companyFile, validated.file)) {
            throw new Error("workforce-company-store-physical-isolation-required");
          }
          await verifyCompanyNativeSchemaAttestation({
            storage: opened.client, placement, manifest: companyNativeWorkOrdersManifest,
          });
          return opened;
        } catch (error) {
          await opened.client.close().catch(() => undefined);
          throw error;
        }
      },
    });
    const workOrders = createNativeWorkOrders();

    const dependencies: HostedWorkforceDependencies = {
      identityStoragePath,
      ...(directAdmin ? { directAdmin } : {}),
      credentialVerifier,
      companyPlacementRegistry,
      companyStoreOpener,
      workOrders,
      async readiness(options) {
        const signal = options?.signal;
        const result = { authentication: false, authority: false, provider: false, evidence: false };
        throwIfAborted(signal);
        try {
          await identityStorage.query("SELECT session_id FROM titan_security_sessions LIMIT 0");
          result.authentication = true;
        } catch { /* observed below as degraded */ }
        throwIfAborted(signal);
        try {
          await runtimeProbeStorage!.query("SELECT id FROM authority_state LIMIT 0");
          await runtimeProbeStorage!.query("SELECT assignment_id FROM worker_access_assignments LIMIT 0");
          result.authority = true;
        } catch { /* observed below as degraded */ }
        throwIfAborted(signal);
        try {
          const rows = await identityStorage.query<{ company_id: string }>(
            "SELECT company_id FROM titan_company_storage_placements WHERE status='READY' ORDER BY company_id LIMIT 1",
          );
          const companyId = rows.rows[0]?.company_id;
          if (companyId) {
            const placement = await companyPlacementRegistry.findByCompanyId(companyId, { signal });
            if (placement?.status === "READY") {
              const opened = await companyStoreOpener.open(placement, { signal });
              try {
                throwIfAborted(signal);
                const physical = await opened.client.query<{ id: string }>("SELECT id FROM companies WHERE id=$1", [companyId]);
                await opened.assertPlacementBound();
                result.provider = physical.rowCount === 1 && physical.rows[0]?.id === companyId;
              } finally { await opened.client.close(); }
            }
          }
        } catch { /* observed below as degraded */ }
        throwIfAborted(signal);
        try {
          await runtimeProbeStorage!.query("SELECT id FROM evidence WHERE evidence_type='gateway_execution' LIMIT 0");
          result.evidence = true;
        } catch { /* observed below as degraded */ }
        return result;
      },
      async close(options) {
        const signal = options?.signal;
        try { throwIfAborted(signal); }
        finally {
          try { await runtimeProbeStorage?.close(); }
          finally { await identityStorage.close(); }
        }
      },
    };
    return dependencies;
  } catch (error) {
    try { await runtimeProbeStorage?.close(); }
    finally { await identityStorage.close(); }
    throw error;
  }
}
