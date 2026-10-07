import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { FILE_CAPABILITIES, FILE_LIMITS, FILE_REVOCATION_CAPABILITY, validateTitanFileRelativePath } from "./file-bridge.mjs";

export const CONTROL_PLANE_SCHEMA = "titan.server-node/v1";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FILE_BODY_BYTES = Math.ceil(FILE_LIMITS.fileBytes / 3) * 4 + MAX_BODY_BYTES;
const MAX_CONCURRENT_FILE_OPERATIONS = 4;
const DEFAULT_CAPABILITIES = new Set(["node.health.read", "node.dependencies.read", "node.lifecycle.request", "node.recovery.checkpoint", "node.recovery.restore"]);
const DEFAULT_DEPENDENCIES = ["web", "workforce", "redis", "database", "directadmin", "evidence_ledger", "backups"];
const INTENT_KINDS = new Set(["service.start", "service.stop", "service.restart", "application.install", "application.update", "application.rollback", "domain.configure", "credential.rotate", "node.recovery.checkpoint", "node.recovery.restore"]);
const SECRET_KEYS = /secret|token|password|private_key|credential(?!_ref$)|authorization|cookie/i;
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const strictDate = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const hash = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
const intentKey = record => hash([record.company_id, record.idempotency_key]);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}
function containsSecretMaterial(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => SECRET_KEYS.test(key) || ["__proto__", "constructor", "prototype"].includes(key) || (typeof item === "string" && /-----BEGIN|\b(password|token|secret)=/i.test(item)) || containsSecretMaterial(item));
}
function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? "")); const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw failure("request body too large", 413); chunks.push(chunk); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("request body must be valid JSON"); }
  if (!object(body)) throw failure("request body must be an object");
  return body;
}

/** Bounded ingress metadata, never the canonical execution/evidence ledger. */
export class ControlPlaneStore {
  constructor(filePath) { this.filePath = path.resolve(filePath); this.state = null; this.queue = Promise.resolve(); this.lock = null; }
  async acquire() {
    // Linux util-linux advisory lock. The helper inherits a kernel-held lock;
    // parent process death closes stdin and releases it without stale PID files.
    // Never unlink the stable lock inode while another process may be waiting.
    const lockPath = `${this.filePath}.lock`;
    const file = await fs.open(lockPath, "a", 0o600); await file.close();
    const child = spawn("flock", ["--exclusive", "--nonblock", "--no-fork", lockPath, process.execPath, "--input-type=module", "--eval", "process.stdout.write('locked\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], { stdio: ["pipe", "pipe", "pipe"] });
    this.lockExit = new Promise(resolve => child.once("exit", resolve));
    child.stdin.on("error", () => {});
    await new Promise((resolve, reject) => {
      child.once("error", () => reject(failure("control-plane store requires flock", 503)));
      child.once("exit", () => reject(failure("control-plane store locked", 503)));
      child.stdout.once("data", data => data.toString().trim() === "locked" ? resolve() : reject(failure("control-plane store owner lock failed", 503)));
    });
    this.lock = child;
    child.once("exit", () => { if (this.lock === child) this.lock = null; });
  }
  async open() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await this.acquire();
    try {
      try { this.state = JSON.parse(await fs.readFile(this.filePath, "utf8")); this.assertState(this.state); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        this.state = { schema_version: CONTROL_PLANE_SCHEMA, node_id: `node-${crypto.randomUUID()}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), intents: {}, checkpoints: {}, denials: [] };
        await this.persist();
      }
      // A restart cannot establish whether a provider received an in-flight call.
      // Preserve the reservation and demand canonical reconciliation, never retry.
      let changed = false;
      for (const record of Object.values(this.state.intents)) {
        if (["RESERVED", "EXECUTING"].includes(record.state)) { record.state = "UNCERTAIN"; record.receipt = { ...record.receipt, state: "UNCERTAIN", verified: false, reconciliation_required: true }; changed = true; }
      }
      if (changed) await this.persist();
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  assertState(state) {
    if (!object(state) || state.schema_version !== CONTROL_PLANE_SCHEMA || !validId(state.node_id) || !object(state.intents) || !object(state.checkpoints) || !Array.isArray(state.denials)) throw failure("unsupported or corrupt control-plane state");
    for (const [key, record] of Object.entries(state.intents)) if (!object(record) || !validId(record.idempotency_key) || !validId(record.company_id) || ["__proto__", "constructor", "prototype"].includes(key)) throw failure("corrupt control-plane intent metadata");
  }
  serial(operation) { const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result; }
  async persist() {
    if (!this.lock) throw failure("control-plane store owner lock required", 503);
    const temp = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    this.state.updated_at = new Date().toISOString();
    let file;
    try {
      file = await fs.open(temp, "wx", 0o600); await file.writeFile(JSON.stringify(this.state, null, 2)); await file.sync(); await file.close(); file = null;
      await fs.rename(temp, this.filePath);
      const directory = await fs.open(path.dirname(this.filePath), "r"); try { await directory.sync(); } finally { await directory.close(); }
    } finally { if (file) await file.close(); await fs.rm(temp, { force: true }); }
  }
  async mutate(operation) {
    return this.serial(async () => {
      const before = structuredClone(this.state);
      try { const result = operation(); await this.persist(); return structuredClone(result); }
      catch (error) { this.state = before; throw error; }
    });
  }
  flush() { return this.serial(() => this.persist()); }
  prior(record) { return own(this.state.intents, intentKey(record)) ?? own(this.state.intents, record.idempotency_key); }
  reserveIntent(record) { return this.mutate(() => { const prior = this.prior(record); if (prior) return { created: false, record: prior }; this.state.intents[intentKey(record)] = record; return { created: true, record }; }); }
  recordIntent(record) { return this.mutate(() => { this.state.intents[intentKey(record)] = record; return record; }); }
  recordDenial(record) { return this.mutate(() => { this.state.denials.push(record); this.state.denials = this.state.denials.slice(-500); return record; }); }
  exportSnapshot(companyId) {
    if (!validId(companyId)) throw failure("snapshot company scope required");
    const snapshot = { kind: "titan.server-node.snapshot", schema_version: CONTROL_PLANE_SCHEMA, node_id: this.state.node_id, company_id: companyId, updated_at: this.state.updated_at, intents: Object.values(this.state.intents).filter(item => item.company_id === companyId), checkpoints: Object.values(this.state.checkpoints).filter(item => item.company_id === companyId), denials: this.state.denials.filter(item => item.company_id === companyId) };
    return structuredClone({ ...snapshot, snapshot_digest: hash(snapshot) });
  }
  validateSnapshot(snapshot, { manifestDigest, companyId } = {}) {
    if (!object(snapshot) || snapshot.kind !== "titan.server-node.snapshot" || snapshot.schema_version !== CONTROL_PLANE_SCHEMA || !validId(companyId) || snapshot.company_id !== companyId || snapshot.node_id !== this.state.node_id || !strictDate(snapshot.updated_at) || !Array.isArray(snapshot.intents) || !Array.isArray(snapshot.checkpoints) || !Array.isArray(snapshot.denials)) throw failure("incompatible snapshot node/company scope", 409);
    const { snapshot_digest: supplied, ...content } = snapshot;
    if (!validDigest(manifestDigest) || !validDigest(supplied) || !safeEqual(supplied, manifestDigest) || !safeEqual(hash(content), supplied)) throw failure("snapshot integrity digest required or mismatch", 409);
    if (containsSecretMaterial(snapshot)) throw failure("invalid snapshot metadata");
    const seen = new Set();
    for (const item of snapshot.intents) {
      if (!object(item) || item.company_id !== companyId || !validId(item.idempotency_key) || !validId(item.correlation_id) || !validDigest(item.fingerprint) || !object(item.intent) || item.intent.company_id !== companyId || item.intent.idempotency_key !== item.idempotency_key || hash(item.intent) !== item.fingerprint || !object(item.receipt) || item.receipt.state !== item.state || !strictDate(item.created_at)) throw failure("invalid snapshot intent company or integrity");
      const key = intentKey(item); if (seen.has(key)) throw failure("duplicate snapshot intent"); seen.add(key);
      const prior = this.prior(item); if (prior && canonical(prior) !== canonical(item)) throw failure("snapshot conflicts with live intent; canonical reconciliation required", 409);
    }
    const checkpointIds = new Set();
    for (const item of snapshot.checkpoints) {
      if (!object(item) || item.company_id !== companyId || item.node_id !== this.state.node_id || !validId(item.checkpoint_id) || !validDigest(item.manifest_digest) || checkpointIds.has(item.checkpoint_id)) throw failure("invalid or duplicate snapshot checkpoint");
      checkpointIds.add(item.checkpoint_id);
      const prior = own(this.state.checkpoints, item.checkpoint_id); if (prior && canonical(prior) !== canonical(item)) throw failure("snapshot conflicts with live checkpoint", 409);
    }
    for (const item of snapshot.denials) if (!object(item) || item.company_id !== companyId || !validId(item.correlation_id) || !strictDate(item.created_at)) throw failure("invalid snapshot denial company");
    return snapshot;
  }
  /** Offline/canonical-provider helper only. HTTP never calls this directly.
   * Additive merge cannot erase newer reservations, receipts or another company. */
  restoreSnapshot(snapshot, scope) {
    return this.mutate(() => {
      this.validateSnapshot(snapshot, scope);
      for (const record of snapshot.intents) {
        const restored = structuredClone(record);
        if (["RESERVED", "EXECUTING"].includes(restored.state)) { restored.state = "UNCERTAIN"; restored.receipt = { ...restored.receipt, state: "UNCERTAIN", verified: false, reconciliation_required: true }; }
        this.state.intents[intentKey(record)] = restored;
      }
      for (const item of snapshot.checkpoints) this.state.checkpoints[item.checkpoint_id] = item;
      const existing = new Set(this.state.denials.map(hash));
      for (const denial of snapshot.denials) if (!existing.has(hash(denial))) this.state.denials.push(denial);
      return { merged: true, snapshot_digest: snapshot.snapshot_digest };
    });
  }
  async close() { await this.queue; if (this.lock) { const child = this.lock; this.lock = null; child.stdin.end(); await this.lockExit; } }
}

export function createServerNodeRuntime(options = {}) {
  const token = options.authToken ?? process.env.TITAN_NODE_AUTH_TOKEN;
  const store = options.store ?? new ControlPlaneStore(options.storePath ?? process.env.TITAN_NODE_STORE_PATH ?? "/var/lib/titan/server-node/control.json");
  const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
  const dependencyNames = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const configuredProbes = validateDependencies(options.healthDependencies ?? configuredDependencies());
  const dependencyProbe = options.dependencyProbe ?? (async () => {
    const measured = await Promise.all(configuredProbes.map(item => probe(item, fetchLoopbackHealth)));
    return [...measured.map(item => ({ ...item, name: item.id })), ...dependencyNames.filter(name => !measured.some(item => item.id === name)).map(name => ({ name, status: "unknown", critical: true, reason: "provider-not-configured" }))];
  });
  // A deployment composition root supplies these trusted canonical-owner ports.
  // Request booleans/references and the old raw executor seam are never authority.
  const adapter = options.canonicalAdapter;
  const commissioned = ["authenticate", "authorize", "execute", "recordEvidence"].every(method => typeof adapter?.[method] === "function");
  const fileBridge = options.fileBridge;
  const fileReadCapabilities = new Set(fileBridge?.readCapabilities ?? fileBridge?.read_capabilities ?? []);
  const fileWriteCapabilities = new Set(fileBridge?.capabilities ?? fileBridge?.write_capabilities ?? []);
  const fileBridgeAvailable = commissioned && fileBridge?.execution_gateway_registered === true && typeof fileBridge?.call === "function" && typeof fileBridge?.revoke === "function"
    && FILE_CAPABILITIES.every(capability => capability.startsWith("files.")
      && (fileReadCapabilities.has(capability) || fileWriteCapabilities.has(capability)));
  let activeFileOperations = 0;
  let opened = false;

  function authenticate(req, requiredCapability, mutation = false) {
    if (!mutation && !token) throw failure("node authentication is not configured", 503);
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ") || !auth.slice(7) || (!mutation && !safeEqual(auth.slice(7), token))) throw failure("authenticated node transport required", 401);
    if (req.headers["x-titan-schema-version"] !== "1") throw failure("unsupported control-plane schema", 426);
    const correlation_id = req.headers["x-titan-correlation-id"];
    if (!validId(correlation_id)) throw failure("correlation ID required");
    const caller_id = req.headers["x-titan-caller-id"];
    if (!validId(caller_id)) throw failure("caller identity reference required", 403);
    if (requiredCapability && !capabilities.has(requiredCapability) && !(fileBridgeAvailable && (FILE_CAPABILITIES.includes(requiredCapability) || requiredCapability === FILE_REVOCATION_CAPABILITY))) throw failure("capability unavailable", 403);
    return { correlation_id, caller_id, ...(mutation ? { credential: auth.slice(7) } : {}) };
  }
  async function health() {
    let dependencies;
    try { dependencies = await dependencyProbe(); } catch { dependencies = []; }
    if (!Array.isArray(dependencies)) dependencies = [];
    const checks = dependencyNames.map(name => dependencies.find(item => (item?.name ?? item?.id) === name) ?? { name, status: "unknown", critical: true, reason: "probe-missing" });
    for (const item of dependencies) if (!checks.includes(item)) checks.push(item);
    const healthy = checks.length > 0 && checks.every(item => item?.critical === false || item?.status === "healthy");
    return { dependencies: checks, ready: opened && Boolean(store.lock) && Boolean(token) && commissioned && healthy, status: healthy && commissioned ? "ready" : "degraded", canonical_execution: commissioned ? "configured" : "unavailable" };
  }
  async function deny(reason, body, auth, status) {
    await store.recordDenial({ reason, company_id: validId(body.company_id) ? body.company_id : "unknown", correlation_id: auth.correlation_id, created_at: new Date().toISOString() });
    throw failure(reason, status);
  }
  function claimFileOperation() {
    if (activeFileOperations >= MAX_CONCURRENT_FILE_OPERATIONS) throw failure("file_service_busy", 503);
    activeFileOperations += 1;
    let released = false;
    return () => { if (!released) { released = true; activeFileOperations -= 1; } };
  }
  async function authorize(body, auth, { includeCanonicalSession = false } = {}) {
    if (!commissioned) return deny("canonical authority/execution/evidence adapter unavailable", body, auth, 503);
    let principal;
    try { principal = await adapter.authenticate({ bearerToken: auth.credential, caller_ref: auth.caller_id }); }
    catch { return deny("canonical identity unavailable", body, auth, 503); }
    if (principal?.caller_id !== auth.caller_id || !Array.isArray(principal.company_ids) || !principal.company_ids.includes(body.company_id)) return deny("canonical identity/company membership refused", body, auth, 403);
    const request = Object.freeze({ node_id: store.state.node_id, caller_id: auth.caller_id, correlation_id: auth.correlation_id, intent: structuredClone(body), intent_digest: hash(body) });
    let decision;
    try { decision = await adapter.authorize(request); } catch { return deny("canonical authorization unavailable", body, auth, 503); }
    if (decision?.allowed !== true || decision.node_id !== request.node_id || decision.caller_id !== auth.caller_id || decision.company_id !== body.company_id || decision.capability_id !== body.capability_id || decision.intent_digest !== request.intent_digest || decision.authority_decision_ref !== body.authority_decision_ref || !strictDate(decision.expires_at) || Date.parse(decision.expires_at) <= Date.now()) return deny("canonical authority binding refused", body, auth, 403);
    return {
      ...request,
      decision,
      ...(includeCanonicalSession ? {
        canonical_actor_id: validId(principal.actor_id) ? principal.actor_id : null,
        canonical_session_ref: validId(principal.session_ref) ? principal.session_ref : null,
      } : {}),
    };
  }
  function fileEvidenceResult(capability, result) {
    return {
      capability,
      root_id: typeof result?.root_id === "string" ? result.root_id : null,
      domain: typeof result?.domain === "string" ? result.domain : null,
      path: typeof result?.path === "string" ? result.path : null,
      byte_count: Number.isSafeInteger(result?.byte_count) ? result.byte_count : 0,
      sha256: validDigest(result?.sha256) ? result.sha256 : null,
      archive_bytes: Number.isSafeInteger(result?.archive_bytes) ? result.archive_bytes : undefined,
      entry_count: Number.isSafeInteger(result?.entries) ? result.entries : undefined,
      root_count: Array.isArray(result?.roots) ? result.roots.length : undefined,
      created: result?.created === true,
      overwritten: result?.overwritten === true,
    };
  }
  async function fileOperation(capability, body, auth, req, res, id) {
    if (!fileBridgeAvailable) throw failure("file bridge unavailable", 503);
    const writable = fileWriteCapabilities.has(capability);
    const allowedTopLevel = new Set(["company_id", "capability_id", "authority_decision_ref", "expires_at", "input", ...(writable ? ["idempotency_key"] : []), ...(capability === "files.upload" ? ["content_base64"] : [])]);
    if (Object.keys(body).some(key => !allowedTopLevel.has(key)) || Object.keys(body).some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw failure("file request fields invalid");
    if (!object(body.input) || body.capability_id !== capability || !validId(body.company_id) || !validId(body.authority_decision_ref) || !strictDate(body.expires_at)) throw failure("file capability request incomplete");
    if (body.company_id !== req.headers["x-titan-company-id"]) return deny("company_context_mismatch", body, auth, 403);
    if (Date.parse(body.expires_at) <= Date.now()) return deny("stale_file_request", body, auth, 409);
    const inputFields = {
      "files.roots": [], "files.list": ["root_id", "path", "limit", "offset"], "files.stat": ["root_id", "path"],
      "files.read": ["root_id", "path"], "files.download": ["root_id", "path"], "files.downloadArchive": ["root_id", "path"],
      "files.upload": ["root_id", "path", "sha256", "byte_count"], "files.mkdir": ["root_id", "path"],
    }[capability];
    if (!inputFields || Object.keys(body.input).some(key => !inputFields.includes(key))) throw failure("file capability input fields invalid");
    if (capability !== "files.roots" && !validId(body.input.root_id)) throw failure("file root reference required");
    if (capability !== "files.roots") {
      if (typeof body.input.path !== "string") throw failure("file relative path required");
      validateTitanFileRelativePath(body.input.path, ["files.list", "files.stat", "files.downloadArchive"].includes(capability));
    }
    if (writable && !validId(body.idempotency_key)) throw failure("file write idempotency key required");
    if (capability === "files.upload") {
      if (!validDigest(body.input.sha256) || !Number.isSafeInteger(body.input.byte_count) || body.input.byte_count < 0 || body.input.byte_count > FILE_LIMITS.fileBytes) throw failure("file upload digest and size required");
      if (typeof body.content_base64 !== "string" || body.content_base64.length > Math.ceil(FILE_LIMITS.fileBytes / 3) * 4) throw failure("file upload content invalid", 413);
      const encoded = body.content_base64;
      if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw failure("file upload encoding invalid");
      const bytes = Buffer.from(encoded, "base64");
      const checksum = crypto.createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== body.input.byte_count || checksum !== body.input.sha256 || bytes.toString("base64") !== encoded) throw failure("file upload content does not match authorized digest", 403);
    }
    const intentBody = { company_id: body.company_id, capability_id: capability, authority_decision_ref: body.authority_decision_ref, expires_at: body.expires_at, input: structuredClone(body.input), ...(writable ? { idempotency_key: body.idempotency_key } : {}) };
    const authorized = await authorize(intentBody, auth, { includeCanonicalSession: true });
    if (!authorized.canonical_actor_id || !authorized.canonical_session_ref) return deny("canonical file actor/session unavailable", body, auth, 503);
    if (!writable) {
      const result = await fileBridge.call({ company_id: body.company_id, actor_id: authorized.canonical_actor_id, session_ref: authorized.canonical_session_ref, correlation_id: auth.correlation_id, capability, input: intentBody.input });
      const evidence = await adapter.recordEvidence({ kind: "server-node.file.read", node_id: store.state.node_id, company_id: body.company_id, actor_id: authorized.canonical_actor_id, correlation_id: auth.correlation_id, evidence_ref: crypto.randomUUID(), intent_digest: authorized.intent_digest, result: fileEvidenceResult(capability, result) });
      if (evidence?.accepted !== true || !validId(evidence.evidence_ref)) throw failure("canonical file evidence acceptance required", 503);
      return json(res, 200, { ...result, evidence_ref: evidence.evidence_ref, request_id: id });
    }

    const receipt = { accepted: true, state: "RESERVED", execution_boundary: "canonical-execution-gateway", provider_acknowledged: false, verified: false, correlation_id: auth.correlation_id };
    const record = { idempotency_key: body.idempotency_key, company_id: body.company_id, capability_id: capability, correlation_id: auth.correlation_id, evidence_ref: crypto.randomUUID(), fingerprint: authorized.intent_digest, intent: structuredClone(intentBody), state: "RESERVED", created_at: new Date().toISOString(), receipt };
    const reservation = await store.reserveIntent(record);
    if (!reservation.created) {
      const prior = reservation.record;
      if (prior.company_id !== body.company_id || prior.capability_id !== capability || prior.fingerprint !== record.fingerprint || !object(prior.receipt) || !object(prior.intent)) throw failure("file idempotency key reused for a different request", 409);
      return json(res, 200, { ...prior.receipt, replay: true, request_id: id });
    }
    let mayHaveExecuted = false;
    try {
      const reserved = await adapter.recordEvidence({ kind: "server-node.file.requested", node_id: store.state.node_id, company_id: body.company_id, actor_id: authorized.canonical_actor_id, correlation_id: auth.correlation_id, evidence_ref: record.evidence_ref, intent_digest: record.fingerprint, authority_decision_ref: body.authority_decision_ref, result: fileEvidenceResult(capability, intentBody.input) });
      if (reserved?.accepted !== true || !validId(reserved.evidence_ref)) throw new Error("canonical file request evidence acceptance required");
      record.state = "EXECUTING"; record.receipt = { ...receipt, state: "EXECUTING" }; await store.recordIntent(record);
      if (Date.parse(body.expires_at) <= Date.now()) throw failure("stale file request at dispatch", 409);
      const current = await authorize(intentBody, auth, { includeCanonicalSession: true });
      if (current.canonical_actor_id !== authorized.canonical_actor_id || current.canonical_session_ref !== authorized.canonical_session_ref) throw failure("canonical file session changed before dispatch", 403);
      mayHaveExecuted = true;
      const result = await adapter.execute({ ...current, ...(capability === "files.upload" ? { secret_file_content_base64: body.content_base64 } : {}) });
      const summary = fileEvidenceResult(capability, result?.result ?? result?.evidence?.observed_result ?? result);
      const finalEvidence = await adapter.recordEvidence({ kind: "server-node.file.result", node_id: store.state.node_id, company_id: body.company_id, actor_id: authorized.canonical_actor_id, correlation_id: auth.correlation_id, evidence_ref: record.evidence_ref, intent_digest: record.fingerprint, result: { ...summary, state: result?.state ?? "UNCERTAIN", verified: result?.verified === true, verification_ref: validId(result?.verification_ref) ? result.verification_ref : null } });
      if (finalEvidence?.accepted !== true || !validId(finalEvidence.evidence_ref)) throw new Error("canonical file result evidence acceptance required");
      const verified = result?.state === "VERIFIED" && result?.verified === true && validId(result.verification_ref);
      record.state = verified ? "VERIFIED" : result?.state === "DENIED" ? "DENIED" : result?.provider_acknowledged === true ? "PROVIDER_ACKNOWLEDGED" : "UNCERTAIN";
      record.receipt = { ...receipt, state: record.state, provider_acknowledged: result?.provider_acknowledged === true, verified, ...(verified ? { verification_ref: result.verification_ref } : {}), evidence_ref: finalEvidence.evidence_ref, reconciliation_required: record.state === "UNCERTAIN" };
      await store.recordIntent(record);
      if (!verified) return json(res, 503, { ...record.receipt, error: "file outcome not independently verified", request_id: id });
      return json(res, 200, { ...record.receipt, file: summary, request_id: id });
    } catch {
      record.state = mayHaveExecuted ? "UNCERTAIN" : "BLOCKED";
      record.receipt = { ...receipt, state: record.state, verified: false, reconciliation_required: true };
      try { await store.recordIntent(record); } catch { /* the reservation still blocks automatic replay */ }
      return json(res, 503, { ...record.receipt, error: "canonical file reconciliation required", request_id: id });
    }
  }
  async function submit(body, auth, req, res, id) {
    const required = ["kind", "target_ref", "company_id", "capability_id", "idempotency_key", "governed_execution_ref", "authority_decision_ref", "evidence_ref"];
    const allowedFields = new Set([...required, "expires_at", ...(body.kind?.startsWith("node.recovery.") ? ["snapshot", "manifest_digest", "checkpoint_id"] : [])]);
    if (Object.keys(body).some(key => !allowedFields.has(key))) throw failure("control metadata fields only; reference canonical action inputs");
    if (required.some(key => !validId(body[key])) || !INTENT_KINDS.has(body.kind) || !strictDate(body.expires_at)) throw failure("complete governed lifecycle intent with strict UTC expires_at required");
    if (containsSecretMaterial(body)) throw failure("secret material must be referenced, not submitted");
    if (body.company_id !== req.headers["x-titan-company-id"]) return deny("company_context_mismatch", body, auth, 403);
    const expectedCapability = body.kind.startsWith("node.recovery.") ? body.kind : "node.lifecycle.request";
    if (body.capability_id !== expectedCapability || !capabilities.has(body.capability_id)) return deny("capability unavailable", body, auth, 403);
    if (Date.parse(body.expires_at) <= Date.now()) return deny("stale_intent", body, auth, 409);
    if (body.kind.startsWith("node.recovery.")) {
      if (body.target_ref !== store.state.node_id) throw failure("governed recovery target must match current node");
      if (body.kind === "node.recovery.restore") store.validateSnapshot(body.snapshot, { manifestDigest: body.manifest_digest, companyId: body.company_id });
      else if (!validId(body.checkpoint_id) || !validDigest(body.manifest_digest)) throw failure("checkpoint_id and SHA-256 manifest_digest required");
    }
    const authorized = await authorize(body, auth);
    const receipt = { accepted: true, state: "RESERVED", execution_boundary: "canonical-execution-gateway", provider_acknowledged: false, verified: false, correlation_id: auth.correlation_id };
    const record = { idempotency_key: body.idempotency_key, company_id: body.company_id, capability_id: body.capability_id, correlation_id: auth.correlation_id, evidence_ref: body.evidence_ref, fingerprint: authorized.intent_digest, intent: structuredClone(body), state: "RESERVED", created_at: new Date().toISOString(), receipt };
    const reservation = await store.reserveIntent(record);
    if (!reservation.created) {
      const prior = reservation.record;
      if (prior.company_id !== body.company_id || prior.fingerprint !== record.fingerprint || !object(prior.receipt) || !object(prior.intent)) throw failure("idempotency key reused or legacy record requires reconciliation", 409);
      return json(res, 200, { ...prior.receipt, replay: true, request_id: id });
    }
    let mayHaveExecuted = false;
    try {
      const evidence = await adapter.recordEvidence({ kind: "server-node.intent.reserved", node_id: store.state.node_id, company_id: body.company_id, correlation_id: auth.correlation_id, evidence_ref: body.evidence_ref, intent_digest: record.fingerprint, authority_decision_ref: body.authority_decision_ref });
      if (evidence?.accepted !== true || !validId(evidence.evidence_ref)) throw new Error("canonical evidence acceptance required");
      record.state = "EXECUTING"; record.receipt = { ...receipt, state: "EXECUTING" }; await store.recordIntent(record);
      // Authority is revalidated at dispatch; the canonical adapter must also
      // revalidate immediately inside its actual provider execution boundary.
      if (Date.parse(body.expires_at) <= Date.now()) throw failure("stale intent at dispatch", 409);
      const current = await authorize(body, auth);
      mayHaveExecuted = true;
      const result = await adapter.execute(current);
      const finalEvidence = await adapter.recordEvidence({ kind: "server-node.intent.result", node_id: store.state.node_id, company_id: body.company_id, correlation_id: auth.correlation_id, evidence_ref: body.evidence_ref, intent_digest: record.fingerprint, result });
      if (finalEvidence?.accepted !== true || !validId(finalEvidence.evidence_ref)) throw new Error("canonical result evidence acceptance required");
      const verified = result?.state === "VERIFIED" && result?.verified === true && validId(result.verification_ref);
      record.state = verified ? "VERIFIED" : result?.state === "DENIED" ? "DENIED" : result?.provider_acknowledged === true ? "PROVIDER_ACKNOWLEDGED" : "UNCERTAIN";
      record.receipt = { ...receipt, state: record.state, provider_acknowledged: result?.provider_acknowledged === true, verified, ...(verified ? { verification_ref: result.verification_ref } : {}), evidence_ref: finalEvidence.evidence_ref, reconciliation_required: record.state === "UNCERTAIN" };
      await store.recordIntent(record);
      return json(res, 202, { ...record.receipt, request_id: id });
    } catch {
      record.state = mayHaveExecuted ? "UNCERTAIN" : "BLOCKED";
      record.receipt = { ...receipt, state: record.state, verified: false, reconciliation_required: true };
      // If this write also fails, the already durable reservation still prevents
      // automatic replay on restart. Never promise arbitrary external exactly-once.
      try { await store.recordIntent(record); } catch { /* original reservation is the safety boundary */ }
      return json(res, 503, { ...record.receipt, error: "canonical reconciliation required", request_id: id });
    }
  }
  async function handle(req, res) {
    const supplied = req.headers["x-titan-request-id"]; const id = validId(supplied) ? supplied : crypto.randomUUID(); res.setHeader("x-titan-request-id", id);
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/live") return json(res, 200, { ok: true, service: "titan-server-node", pid: process.pid });
      if (req.method === "GET" && url.pathname === "/ready") { const result = await health(); return json(res, result.ready ? 200 : 503, { ready: result.ready, schema: CONTROL_PLANE_SCHEMA, canonical_execution: result.canonical_execution }); }
      if (req.method === "GET" && ["/v1/health", "/v1/dependencies"].includes(url.pathname)) {
        const auth = authenticate(req, url.pathname === "/v1/health" ? "node.health.read" : "node.dependencies.read"); const result = await health();
        return json(res, 200, { schema: CONTROL_PLANE_SCHEMA, node_id: store.state.node_id, ...result, ...(url.pathname === "/v1/dependencies" ? { graph: result.dependencies.map(item => ({ ...item, depends_on: item.depends_on ?? [] })) } : {}), correlation_id: auth.correlation_id });
      }
      if (req.method === "GET" && url.pathname === "/v1/bootstrap") {
        const auth = authenticate(req); return json(res, 200, { schema: CONTROL_PLANE_SCHEMA, node_id: store.state.node_id, capabilities: [...new Set([...capabilities, ...(fileBridgeAvailable ? [...FILE_CAPABILITIES, FILE_REVOCATION_CAPABILITY] : [])])].filter(capability => commissioned || capability.endsWith(".read")), canonical_execution: commissioned ? "configured" : "unavailable", file_bridge: fileBridgeAvailable ? "configured" : "unavailable", control_metadata_only: true, company_data_owner: "company-physical-store", evidence_owner: "evidence-ledger", correlation_id: auth.correlation_id });
      }
      if (url.pathname === "/v1/files/revoke") {
        if (req.method !== "POST") throw failure("method not allowed", 405);
        const auth = authenticate(req, FILE_REVOCATION_CAPABILITY, true);
        if (!fileBridgeAvailable) throw failure("file bridge unavailable", 503);
        const release = claimFileOperation();
        try {
          const body = await readBody(req);
          if (Object.keys(body).some(key => !["company_id", "capability_id", "authority_decision_ref", "expires_at"].includes(key)) || body.capability_id !== FILE_REVOCATION_CAPABILITY || !validId(body.company_id) || !validId(body.authority_decision_ref) || !strictDate(body.expires_at)) throw failure("file revocation request incomplete");
          if (body.company_id !== req.headers["x-titan-company-id"]) return deny("company_context_mismatch", body, auth, 403);
          if (Date.parse(body.expires_at) <= Date.now()) return deny("stale_file_revocation", body, auth, 409);
          const intent = { ...body, input: { provider_id: fileBridge.provider_id } };
          const authorized = await authorize(intent, auth, { includeCanonicalSession: true });
          if (!authorized.canonical_actor_id || !authorized.canonical_session_ref) return deny("canonical file actor/session unavailable", body, auth, 503);
          const result = await fileBridge.revoke({ company_id: body.company_id, actor_id: authorized.canonical_actor_id, session_ref: authorized.canonical_session_ref, correlation_id: auth.correlation_id });
          const evidence = await adapter.recordEvidence({ kind: "server-node.file.revoked", node_id: store.state.node_id, company_id: body.company_id, actor_id: authorized.canonical_actor_id, correlation_id: auth.correlation_id, evidence_ref: crypto.randomUUID(), intent_digest: authorized.intent_digest, result: { provider_id: fileBridge.provider_id, revoked: result?.revoked === true } });
          if (evidence?.accepted !== true || !validId(evidence.evidence_ref)) throw failure("canonical file revocation evidence acceptance required", 503);
          return json(res, 200, { revoked: result.revoked === true, evidence_ref: evidence.evidence_ref, request_id: id });
        } finally { release(); }
      }
      const fileRoute = /^\/v1\/files\/([A-Za-z]+)$/.exec(url.pathname);
      if (fileRoute) {
        if (req.method !== "POST") throw failure("method not allowed", 405);
        const capability = "files." + fileRoute[1];
        if (!FILE_CAPABILITIES.includes(capability)) throw failure("file capability not found", 404);
        const auth = authenticate(req, capability, true);
        const release = claimFileOperation();
        try { return await fileOperation(capability, await readBody(req, capability === "files.upload" ? MAX_FILE_BODY_BYTES : MAX_BODY_BYTES), auth, req, res, id); }
        finally { release(); }
      }
      if (req.method === "POST" && url.pathname === "/v1/intents") {
        const auth = authenticate(req, "node.lifecycle.request", true); return await submit(await readBody(req), auth, req, res, id);
      }
      if (req.method === "POST" && ["/v1/recovery/restore", "/v1/recovery/checkpoint"].includes(url.pathname)) {
        const kind = url.pathname.endsWith("restore") ? "node.recovery.restore" : "node.recovery.checkpoint";
        const auth = authenticate(req, kind, true); const body = await readBody(req);
        if (kind === "node.recovery.restore") store.validateSnapshot(body.snapshot, { manifestDigest: body.manifest_digest, companyId: req.headers["x-titan-company-id"] });
        else if (!validId(body.checkpoint_id) || !validDigest(body.manifest_digest)) throw failure("checkpoint_id and SHA-256 manifest_digest required");
        if (body.kind !== kind || body.target_ref !== store.state.node_id) throw failure("governed recovery target must match current node");
        // Only canonical capability providers may apply a restore/checkpoint.
        // A valid checksum is integrity, never permission, and this HTTP handler
        // must not replace its own live replay/evidence metadata.
        return await submit(body, auth, req, res, id);
      }
      return json(res, 404, { error: "not found", request_id: id });
    } catch (error) { return json(res, error.status ?? 500, { error: error.status ? error.message : "control-plane operation failed", request_id: id }); }
  }
  const server = http.createServer((req, res) => void handle(req, res));
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  return { store, server, async start() {
    const host = options.host ?? "127.0.0.1"; if (!["127.0.0.1", "::1"].includes(host)) throw failure("bind host must be loopback");
    await store.open();
    try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, host, () => { server.removeListener("error", reject); resolve(); }); }); }
    catch (error) { await store.close(); throw error; }
    opened = true; return server.address();
  }, async close() { opened = false; if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await store.close(); } };
}



const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const SERVICE = "titan-server-node-health";
const MAX_DEPENDENCIES = 16;
const MAX_STATUS_REQUESTS = 32;

export function validateDependencies(dependencies) {
  if (!Array.isArray(dependencies)) throw new TypeError("dependencies_must_be_array");
  if (dependencies.length > MAX_DEPENDENCIES) throw new RangeError("dependency_count_exceeded");
  const seen = new Set();
  return dependencies.map((dependency) => {
    if (!dependency || typeof dependency !== "object") throw new TypeError("dependency_must_be_object");
    const id = String(dependency.id ?? "");
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new TypeError("dependency_id_invalid");
    if (seen.has(id)) throw new TypeError("dependency_id_duplicate");
    seen.add(id);
    let target;
    try { target = new URL(dependency.url); } catch { throw new TypeError("dependency_url_invalid"); }
    if (target.protocol !== "http:" || !LOOPBACK_HOSTS.has(target.hostname) || target.username || target.password || target.search || target.hash) {
      throw new TypeError("dependency_target_must_be_loopback_http");
    }
    const timeoutMs = dependency.timeout_ms ?? 1200;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) throw new TypeError("dependency_timeout_invalid");
    return Object.freeze({ id, url: target.href, critical: dependency.critical !== false, timeoutMs });
  });
}

function fetchLoopbackHealth(url, { signal, headers }) {
  return new Promise((resolve, reject) => {
    // A private agent connects directly. Node's environment proxy must not route
    // loopback probes through an external proxy, and redirects are never followed.
    const request = http.request(url, { method: "GET", headers, signal, agent: false }, (response) => {
      const status = response.statusCode;
      response.destroy();
      resolve({ ok: status >= 200 && status < 300, status, body: null });
    });
    request.on("error", reject);
    request.end();
  });
}

async function probe(dependency, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(dependency.url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(dependency.timeoutMs),
      redirect: "error",
    });
    return Object.freeze({
      id: dependency.id,
      critical: dependency.critical,
      status: response.ok ? "healthy" : "unhealthy",
      http_status: response.status,
    });
  } catch {
    return Object.freeze({ id: dependency.id, critical: dependency.critical, status: "unreachable", http_status: null });
  } finally {
    // Only HTTP status is observed. Never retain or consume arbitrary provider bodies.
    try { await response?.body?.cancel(); } catch { /* The probe result is already observed. */ }
  }
}

function healthJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

export function createServerNodeHealthServer({ dependencies, fetchImpl = fetchLoopbackHealth, maxStatusRequests = MAX_STATUS_REQUESTS } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch_unavailable");
  if (!Number.isInteger(maxStatusRequests) || maxStatusRequests < 1 || maxStatusRequests > MAX_STATUS_REQUESTS) throw new RangeError("status_request_limit_invalid");
  const checkedDependencies = validateDependencies(dependencies ?? []);
  let activeStatusRequests = 0;
  let pendingObservation;
  const observe = () => {
    if (!pendingObservation) {
      pendingObservation = Promise.all(checkedDependencies.map((dependency) => probe(dependency, fetchImpl)))
        .then((checks) => ({ checks, checked_at: new Date().toISOString() }))
        .finally(() => { pendingObservation = undefined; });
    }
    return pendingObservation;
  };
  const server = http.createServer(async (request, response) => {
    const method = request.method ?? "GET";
    let pathname;
    try {
      const target = request.url ?? "/";
      if (!target.startsWith("/") || target.startsWith("//") || target.includes("#")) throw new Error("invalid_request_target");
      pathname = new URL(target, "http://127.0.0.1").pathname;
    } catch {
      response.setHeader("connection", "close");
      return healthJson(response, 400, { error: "invalid_request_target" });
    }
    if (method !== "GET" || request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0) {
      response.setHeader("connection", "close");
      return healthJson(response, method !== "GET" ? 405 : 400, { error: method !== "GET" ? "method_not_allowed" : "request_body_not_allowed" });
    }
    if (pathname === "/healthz") {
      return healthJson(response, 200, { service: SERVICE, status: "alive", checked_at: new Date().toISOString() });
    }
    if (pathname !== "/v1/status") return healthJson(response, 404, { error: "not_found" });
    if (activeStatusRequests >= maxStatusRequests) return healthJson(response, 503, { error: "status_busy", ready: false });
    activeStatusRequests += 1;
    try {
      const { checks, checked_at } = await observe();
      const unconfigured = checkedDependencies.length === 0;
      const unavailableCritical = unconfigured || checks.some((check) => check.critical && check.status !== "healthy");
      const degraded = unavailableCritical || checks.some((check) => check.status !== "healthy");
      if (response.destroyed) return;
      return healthJson(response, unavailableCritical ? 503 : 200, {
        schema: "titan.server-node.health.v1",
        service: SERVICE,
        status: degraded ? "degraded" : "healthy",
        ready: !unavailableCritical,
        checked_at,
        checks,
        ...(unconfigured ? { reason: "dependencies_not_configured" } : {}),
      });
    } catch {
      if (!response.destroyed) return healthJson(response, 503, { error: "observation_unavailable", ready: false });
    } finally {
      activeStatusRequests -= 1;
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 64;
  return server;
}

function positivePort(value, fallback) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port_invalid");
  return port;
}

function defaultDependencies() {
  const appPort = positivePort(process.env.APP_PORT, 3000);
  const workforcePort = positivePort(process.env.WORKFORCE_PORT, 3010);
  return [
    { id: "web", url: `http://127.0.0.1:${appPort}/api/health`, critical: true },
    { id: "workforce", url: `http://127.0.0.1:${workforcePort}/ready`, critical: true },
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && !process.argv.includes("--serve")) {
  const configuredHost = process.env.TITAN_SERVER_NODE_BIND ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "[::1]"].includes(configuredHost)) throw new Error("bind_host_must_be_loopback");
  const host = configuredHost === "[::1]" ? "::1" : configuredHost;
  const port = positivePort(process.env.TITAN_SERVER_NODE_PORT, 3099);
  let dependencies;
  if (process.env.TITAN_SERVER_NODE_DEPENDENCIES) {
    try { dependencies = JSON.parse(process.env.TITAN_SERVER_NODE_DEPENDENCIES); } catch { throw new Error("dependencies_json_invalid"); }
  } else { dependencies = defaultDependencies(); }
  const server = createServerNodeHealthServer({ dependencies });
  server.listen(port, host, () => console.log(JSON.stringify({ service: SERVICE, listening: true, host, port })));
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

function configuredDependencies() {
  if (!process.env.TITAN_SERVER_NODE_DEPENDENCIES) return defaultDependencies();
  try { return JSON.parse(process.env.TITAN_SERVER_NODE_DEPENDENCIES); } catch { throw new Error("dependencies_json_invalid"); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes("--serve")) {
  // No production canonical adapter is commissioned here. Mutation endpoints
  // deliberately remain unavailable rather than queueing unexecutable intents.
  const runtime = createServerNodeRuntime({ port: Number(process.env.TITAN_NODE_PORT ?? 3015) });
  await runtime.start();
  process.once("SIGTERM", () => runtime.close().finally(() => process.exit(0)));
  process.once("SIGINT", () => runtime.close().finally(() => process.exit(0)));
}
