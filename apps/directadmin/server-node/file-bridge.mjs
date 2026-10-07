import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

export const FILE_ROOT_DOMAIN = "titanzero.io";
export const FILE_CAPABILITIES = Object.freeze([
  "files.roots", "files.list", "files.stat", "files.read", "files.download",
  "files.downloadArchive", "files.upload", "files.mkdir",
]);
export const APP_ROOTS = Object.freeze([
  Object.freeze({ id: "desk", domain: "desk.titanzero.io", path: "/home/admin/apps/desk" }),
  Object.freeze({ id: "field", domain: "field.titanzero.io", path: "/home/admin/apps/field" }),
  Object.freeze({ id: "build", domain: "build.titanzero.io", path: "/home/admin/apps/build" }),
  Object.freeze({ id: "pay", domain: "pay.titanzero.io", path: "/home/admin/apps/pay" }),
]);
export const FILE_LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  readBytes: 2 * 1024 * 1024,
  archiveInputBytes: 16 * 1024 * 1024,
  archiveOutputBytes: 10 * 1024 * 1024,
  archiveEntries: 2000,
  directoryEntries: 10000,
  inventoryAgeMs: 5 * 60 * 1000,
});
const O_NOFOLLOW = constants.O_NOFOLLOW;
const O_DIRECTORY = constants.O_DIRECTORY;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const READ = new Set(["files.roots", "files.list", "files.stat", "files.read", "files.download", "files.downloadArchive"]);
const WRITE = new Set(["files.upload", "files.mkdir"]);
const SECRET = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.pypirc|\.htpasswd|\.my\.cnf|\.pgpass|pg_service\.conf|database\.(?:ya?ml|json)|db\.(?:ya?ml|json)|id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|known_hosts|wp-config\.php|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|.*\.(?:key|pem|p12|pfx|jks|keystore)|.*(?:webhook|credential|token|secret|login[_-]?key|directadmin[_-]?(?:key|login)).*)$/i;
const OMIT_ARCHIVE = new Set([".git", "node_modules", ".cache", "cache", "logs", "log", "dist", "build", ".next", "coverage", "tmp", "temp"]);

export class FileBridgeError extends Error {
  constructor(code, status = 400) { super(code); this.name = "FileBridgeError"; this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new FileBridgeError(code, status); };
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const ref = (x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/_-]{0,159}$/.test(x) && !x.includes("..");
const hash = (x) => createHash("sha256").update(x).digest("hex");
const within = (base, target) => target === base || target.startsWith(base + path.sep);
const fdPath = (handle) => "/proc/self/fd/" + handle.fd;
const childPath = (handle, name) => fdPath(handle) + "/" + name;
const checkAbort = (signal) => { if (signal?.aborted) fail("file_operation_aborted", 499); };

function domainName(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  const name = value.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(name)) return null;
  return name === FILE_ROOT_DOMAIN || name.endsWith("." + FILE_ROOT_DOMAIN) ? name : null;
}
function relativePath(value, allowRoot = false) {
  if (value === "" && allowRoot) return [];
  if (typeof value !== "string" || value.length > 4096 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) fail("file_path_invalid");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.length > 255)) fail("file_path_invalid");
  if (parts.some((part) => SECRET.test(part))) fail("file_secret_denied", 403);
  return parts;
}
function mime(name) {
  const ext = path.extname(name).toLowerCase();
  return ({ ".html":"text/html", ".css":"text/css", ".js":"text/javascript", ".mjs":"text/javascript", ".json":"application/json", ".txt":"text/plain", ".md":"text/markdown", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".pdf":"application/pdf", ".zip":"application/zip", ".gz":"application/gzip" })[ext] ?? "application/octet-stream";
}
function safeError(error) {
  if (error instanceof FileBridgeError) return error;
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : "FILE_PROVIDER_FAILURE";
  return new FileBridgeError(code, code === "ENOENT" ? 404 : code === "EEXIST" ? 409 : 503);
}
function checkContext(request) {
  if (!object(request) || !ref(request.company_id) || !ref(request.actor_id) || !ref(request.session_ref) || !ref(request.correlation_id) || !object(request.input)) fail("file_context_required", 403);
}
function operationAudit(request, provider, result, extra = {}) {
  const input = object(request?.input) ? request.input : {};
  const secretPath = typeof input.path === "string" && input.path.split("/").some((p) => SECRET.test(p));
  return {
    company_id: ref(request?.company_id) ? request.company_id : "unknown",
    actor_id: ref(request?.actor_id) ? request.actor_id : null,
    session_ref: ref(request?.session_ref) ? request.session_ref : null,
    correlation_id: ref(request?.correlation_id) ? request.correlation_id : null,
    provider_id: provider, operation: request?.capability ?? "unknown",
    root_id: ref(input.root_id) ? input.root_id : null,
    target_path: secretPath ? "[REDACTED]" : (typeof input.path === "string" ? input.path : null),
    occurred_at: new Date().toISOString(), result, ...extra,
  };
}
function rootKey(kind, domain, company, canonicalPath, app = "") {
  return kind + ":" + hash([kind, domain, company, canonicalPath, app].join("\n")).slice(0, 20);
}
async function openAbsoluteDirectory(value) {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value === "/") fail("file_root_invalid", 403);
  let current = await fs.open("/", constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    for (const part of value.split("/").filter(Boolean)) {
      if (part === "." || part === "..") fail("file_root_invalid", 403);
      const next = await fs.open(childPath(current, part), constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) { await current.close().catch(() => {}); throw error; }
}
async function walkDirectory(root, parts, run) {
  let current = root;
  const opened = [];
  try {
    for (const part of parts) {
      const next = await fs.open(childPath(current, part), constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW).catch(() => null);
      if (!next) fail("file_directory_unavailable", 404);
      opened.push(next);
      current = next;
    }
    return await run(current);
  } finally { for (const handle of opened.reverse()) await handle.close(); }
}
async function withParent(root, parts, run) {
  if (!parts.length) fail("file_path_invalid");
  return walkDirectory(root, parts.slice(0, -1), (parent) => run(parent, parts.at(-1)));
}
async function readBounded(handle, maxBytes, signal) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    checkAbort(signal);
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) fail("file_size_limit", 413);
  return buffer.subarray(0, total);
}
async function regularFile(parent, name, maxBytes, signal) {
  checkAbort(signal);
  const handle = await fs.open(childPath(parent, name), constants.O_RDONLY | O_NONBLOCK | O_NOFOLLOW).catch(() => null);
  if (!handle) fail("file_unavailable", 404);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail("file_type_denied", 403);
    if (stat.size > maxBytes) fail("file_size_limit", 413);
    const bytes = await readBounded(handle, maxBytes, signal);
    return { bytes, stat, sha256: hash(bytes) };
  } finally { await handle.close(); }
}
function tarEntry(entry) {
  const header = Buffer.alloc(512);
  let name = entry.name, prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const split = name.lastIndexOf("/");
    if (split > 0) { prefix = name.slice(0, split); name = name.slice(split + 1); }
  }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) fail("file_archive_path_limit", 413);
  const octal = (n, width) => n.toString(8).padStart(width - 1, "0") + "\0";
  header.write(name, 0, 100, "utf8");
  header.write(octal(entry.directory ? 0o755 : 0o644, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(entry.bytes.length, 12), 124, 12, "ascii");
  header.write(octal(Math.floor(entry.mtime / 1000), 12), 136, 12, "ascii");
  header.fill(32, 148, 156);
  header[156] = entry.directory ? 53 : 48;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Buffer.concat([header, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512)]);
}

export class TitanFileBridgeProvider {
  constructor({ domainProvider, auditSink, revocationStore, commissionedApplications = [], applicationRoots = APP_ROOTS, domainsRoot = "/home/admin/domains", now = () => Date.now() } = {}) {
    if (process.platform !== "linux" || typeof O_DIRECTORY !== "number" || typeof O_NOFOLLOW !== "number") throw new TypeError("safe-file-provider-unavailable");
    if (typeof domainProvider?.listRegisteredDomains !== "function" || typeof auditSink !== "function" || typeof revocationStore?.isRevoked !== "function" || typeof revocationStore?.revoke !== "function") throw new TypeError("file-bridge-owner-ports-required");
    this.id = "directadmin:titan-file-bridge";
    this.executionClass = "operated";
    this.capabilities = Object.freeze(["files.upload", "files.mkdir"]);
    this.readCapabilities = Object.freeze(["files.roots", "files.list", "files.stat", "files.read", "files.download", "files.downloadArchive"]);
    this.domainProvider = domainProvider;
    this.auditSink = auditSink;
    this.revocationStore = revocationStore;
    this.domainsRoot = path.resolve(domainsRoot);
    this.now = now;
    this.revoked = false;
    this.apps = new Map();
    const knownApps = new Map(APP_ROOTS.map((x) => [x.id, x]));
    for (const mapping of applicationRoots) {
      const known = knownApps.get(mapping?.id);
      if (!known || known.domain !== mapping.domain || !path.isAbsolute(mapping.path) || path.resolve(mapping.path) !== mapping.path) throw new TypeError("invalid-application-root");
      this.apps.set(mapping.id, { ...known, path: mapping.path });
    }
    this.commissioned = new Map();
    for (const app of commissionedApplications) {
      if (!knownApps.has(app?.id) || typeof app.writable !== "boolean" || this.commissioned.has(app.id)) throw new TypeError("invalid-commissioned-application");
      this.commissioned.set(app.id, { writable: app.writable });
    }
  }

  async revoke(context) {
    if (!object(context) || !ref(context.actor_id) || !ref(context.session_ref) || !ref(context.correlation_id)) fail("file_revoke_context_required", 403);
    await this.revocationStore.revoke({ ...context, provider_id: this.id, revoked_at: new Date(this.now()).toISOString() });
    this.revoked = true;
    await this.auditSink(operationAudit({ ...context, capability: "files.revoke", input: {} }, this.id, "revoked"));
    return { revoked: true };
  }

  async enabled(company) {
    if (this.revoked) fail("file_bridge_revoked", 403);
    let state;
    try { state = await this.revocationStore.isRevoked({ provider_id: this.id, company_id: company }); }
    catch { fail("file_bridge_revocation_unavailable", 503); }
    if (state !== false) fail("file_bridge_revoked", 403);
  }

  async roots(company) {
    let inventory;
    try { inventory = await this.domainProvider.listRegisteredDomains({ company_id: company, root_domain: FILE_ROOT_DOMAIN }); }
    catch { fail("directadmin_domain_inventory_unavailable", 503); }
    if (!object(inventory) || !Array.isArray(inventory.domains) || inventory.domains.length > 500) fail("directadmin_domain_inventory_invalid", 503);
    const time = Date.parse(inventory.observed_at);
    if (!Number.isFinite(time) || time > this.now() + 60000 || this.now() - time > FILE_LIMITS.inventoryAgeMs) fail("directadmin_domain_inventory_stale", 503);
    const domainBase = path.join(this.domainsRoot, FILE_ROOT_DOMAIN);
    const canonicalBase = await fs.realpath(domainBase).catch(() => null);
    if (canonicalBase !== domainBase) fail("file_domain_root_unavailable", 503);
    const byDomain = new Map();
    for (const item of inventory.domains) {
      const domain = domainName(item?.domain);
      if (!domain || item.root_domain !== FILE_ROOT_DOMAIN || item.company_id !== company || item.registered !== true || byDomain.has(domain)) continue;
      const candidate = item.canonical_document_root;
      if (typeof candidate !== "string" || path.resolve(candidate) !== candidate) continue;
      const canonical = await fs.realpath(candidate).catch(() => null);
      if (!canonical || canonical === canonicalBase || !within(canonicalBase, canonical)) continue;
      const stat = await fs.stat(canonical).catch(() => null);
      if (!stat?.isDirectory()) continue;
      byDomain.set(domain, { root_id: rootKey("domain", domain, company, canonical), domain, company_id: company, canonical_path: canonical, kind: "domain", application_id: null, writable: item.writable === true, device: stat.dev, inode: stat.ino });
    }
    if (!byDomain.has(FILE_ROOT_DOMAIN)) fail("file_domain_estate_unavailable", 503);
    const roots = [...byDomain.values()];
    for (const mapping of this.apps.values()) {
      const config = this.commissioned.get(mapping.id);
      if (!config || !byDomain.has(mapping.domain)) continue;
      const canonical = await fs.realpath(mapping.path).catch(() => null);
      if (canonical !== mapping.path) continue;
      const stat = await fs.stat(canonical).catch(() => null);
      if (!stat?.isDirectory()) continue;
      roots.push({ root_id: rootKey("application", mapping.domain, company, canonical, mapping.id), domain: mapping.domain, company_id: company, canonical_path: canonical, kind: "application", application_id: mapping.id, writable: config.writable, device: stat.dev, inode: stat.ino });
    }
    return roots.sort((a, b) => a.kind.localeCompare(b.kind) || a.domain.localeCompare(b.domain) || String(a.application_id ?? "").localeCompare(String(b.application_id ?? "")));
  }

  async call(request) {
    try {
      checkContext(request);
      if (!READ.has(request.capability)) fail("file_read_capability_required", 403);
      await this.enabled(request.company_id);
      let result;
      if (request.capability === "files.roots") result = { roots: await this.roots(request.company_id) };
      else {
        const available = await this.roots(request.company_id);
        const scope = available.find((x) => x.root_id === request.input.root_id);
        if (!scope) fail("file_root_not_registered", 404);
        result = await this.read(scope, request.capability, request.input, request.signal);
      }
      await this.auditSink(operationAudit(request, this.id, "succeeded", {
        domain: result.domain ?? FILE_ROOT_DOMAIN, canonical_path: result.canonical_path ?? null,
        canonical_roots: result.roots?.map((x) => ({ domain: x.domain, kind: x.kind, application_id: x.application_id, canonical_path: x.canonical_path })) ?? undefined,
        byte_count: result.byte_count ?? 0, checksum: result.sha256 ?? null,
      }));
      return result;
    } catch (error) {
      const safe = safeError(error);
      await this.auditDenied(request, safe.code);
      throw safe;
    }
  }

  async execute(request) {
    let created = false;
    try {
      checkContext(request);
      if (!WRITE.has(request.capability)) fail("file_write_capability_required", 403);
      await this.enabled(request.company_id);
      await this.auditSink(operationAudit(request, this.id, "requested"));
      const available = await this.roots(request.company_id);
      const scope = available.find((x) => x.root_id === request.input.root_id);
      if (!scope) fail("file_root_not_registered", 404);
      if (!scope.writable) fail("file_root_read_only", 403);
      const output = request.capability === "files.upload"
        ? await this.upload(scope, request.input, request.signal)
        : await this.makeDirectory(scope, request.input, request.signal);
      created = true;
      await this.auditSink(operationAudit(request, this.id, "created", {
        domain: scope.domain, canonical_path: output.canonical_path, byte_count: output.byte_count ?? 0, checksum: output.sha256 ?? null, created: true,
      }));
      return { external_ref: output.file_ref, result: output };
    } catch (error) {
      const safe = safeError(error);
      await this.auditDenied(request, created ? "file_effect_audit_uncertain" : safe.code, created ? "uncertain" : "denied");
      throw safe;
    }
  }

  async verify(raw, request) {
    try {
      checkContext(request);
      await this.enabled(request.company_id);
      const scope = (await this.roots(request.company_id)).find((x) => x.root_id === request.input.root_id);
      if (!scope || !object(raw?.result)) return { verified: false };
      const parts = relativePath(request.input.path, false);
      const observed = request.capability === "files.upload"
        ? await this.inspectFile(scope, parts, FILE_LIMITS.fileBytes)
        : await this.inspectDirectory(scope, parts);
      const expected = raw.result;
      const verified = request.capability === "files.upload"
        ? observed.sha256 === expected.sha256 && observed.size === expected.byte_count
        : observed.type === "directory";
      return { verified, verification_ref: verified ? "file-observation:" + hash([scope.root_id, request.input.path, expected.sha256 ?? ""].join("\n")).slice(0, 24) : null };
    } catch { return { verified: false }; }
  }

  async auditDenied(request, reason, result = "denied") {
    try { await this.auditSink(operationAudit(request, this.id, result, { denial_reason: reason, byte_count: 0 })); } catch {}
  }

  async withRoot(scope, work) {
    const resolved = await fs.realpath(scope.canonical_path).catch(() => null);
    if (resolved !== scope.canonical_path) fail("file_root_changed", 409);
    const root = await openAbsoluteDirectory(resolved).catch(() => null);
    if (!root) fail("file_root_unavailable", 503);
    try {
      const stat = await root.stat();
      if (stat.dev !== scope.device || stat.ino !== scope.inode) fail("file_root_changed", 409);
      return await work(root);
    } finally { await root.close(); }
  }

  async read(scope, capability, input, signal) {
    checkAbort(signal);
    if (capability === "files.list") {
      const parts = relativePath(input.path ?? "", true);
      const limit = input.limit ?? 200, offset = input.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0 || offset > FILE_LIMITS.directoryEntries) fail("file_list_pagination_invalid");
      return this.withRoot(scope, (root) => walkDirectory(root, parts, async (dir) => {
        const raw = await fs.readdir(fdPath(dir));
        if (raw.length > FILE_LIMITS.directoryEntries) fail("file_directory_entry_limit", 413);
        const names = raw.filter((x) => !SECRET.test(x)).sort();
        const entries = [];
        for (const name of names.slice(offset, offset + limit + 1)) {
          const entry = await this.entry(dir, name);
          if (entry) entries.push(entry);
        }
        return { root_id: scope.root_id, domain: scope.domain, path: parts.join("/"), canonical_path: path.join(scope.canonical_path, ...parts), entries: entries.slice(0, limit), next_offset: offset + limit < names.length ? offset + limit : null, total_entries: names.length };
      }));
    }
    const parts = relativePath(input.path, capability === "files.stat");
    if (capability === "files.stat") {
      if (!parts.length) return { root_id: scope.root_id, domain: scope.domain, path: "", type: "directory", canonical_path: scope.canonical_path };
      return this.withRoot(scope, (root) => withParent(root, parts, async (parent, name) => {
        const entry = await this.entry(parent, name);
        if (!entry) fail("file_entry_unavailable", 404);
        return { root_id: scope.root_id, domain: scope.domain, path: parts.join("/"), canonical_path: path.join(scope.canonical_path, ...parts), ...entry };
      }));
    }
    if (capability === "files.read" || capability === "files.download") {
      const max = capability === "files.read" ? FILE_LIMITS.readBytes : FILE_LIMITS.fileBytes;
      return this.withRoot(scope, (root) => withParent(root, parts, async (parent, name) => {
        const file = await regularFile(parent, name, max, signal);
        return { root_id: scope.root_id, domain: scope.domain, path: parts.join("/"), canonical_path: path.join(scope.canonical_path, ...parts), file_name: name, content_type: mime(name), size_bytes: file.bytes.length, sha256: file.sha256, byte_count: file.bytes.length, ...(capability === "files.read" ? { content_base64: file.bytes.toString("base64") } : { download_base64: file.bytes.toString("base64") }) };
      }));
    }
    if (capability === "files.downloadArchive") {
      const parts = relativePath(input.path ?? "", true);
      return this.archive(scope, parts, signal);
    }
    fail("file_operation_unknown");
  }

  async entry(parent, name) {
    const target = childPath(parent, name);
    const first = await fs.lstat(target).catch(() => null);
    if (!first || first.isSymbolicLink()) return null;
    if (first.isDirectory()) {
      const dir = await fs.open(target, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW).catch(() => null);
      if (!dir) return null;
      try { const stat = await dir.stat(); return { name, type: "directory", size_bytes: stat.size, modified_at: stat.mtime.toISOString() }; } finally { await dir.close(); }
    }
    const file = await fs.open(target, constants.O_RDONLY | O_NONBLOCK | O_NOFOLLOW).catch(() => null);
    if (!file) return null;
    try { const stat = await file.stat(); return stat.isFile() ? { name, type: "file", size_bytes: stat.size, modified_at: stat.mtime.toISOString(), content_type: mime(name) } : null; } finally { await file.close(); }
  }

  async inspectFile(scope, parts, max) {
    return this.withRoot(scope, (root) => withParent(root, parts, async (parent, name) => {
      const file = await regularFile(parent, name, max);
      return { sha256: file.sha256, size: file.bytes.length };
    }));
  }
  async inspectDirectory(scope, parts) {
    return this.withRoot(scope, (root) => walkDirectory(root, parts, async (dir) => ({ type: (await dir.stat()).isDirectory() ? "directory" : "other" })));
  }

  async upload(scope, input, signal) {
    const parts = relativePath(input.path, false);
    const encoded = input.secret_content_base64;
    if (typeof encoded !== "string" || encoded.length > Math.ceil(FILE_LIMITS.fileBytes / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail("file_upload_encoding_invalid", 413);
    const data = Buffer.from(encoded, "base64");
    if (data.length > FILE_LIMITS.fileBytes || data.toString("base64") !== encoded) fail("file_upload_size_or_encoding_invalid", 413);
    checkAbort(signal);
    return this.withRoot(scope, (root) => withParent(root, parts, async (parent, name) => {
      let file;
      try { file = await fs.open(childPath(parent, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o640); }
      catch (error) { if (error?.code === "EEXIST") fail("file_exists", 409); throw error; }
      try { await file.writeFile(data, { signal }); await file.sync(); if ((await file.stat()).size !== data.length) fail("file_upload_incomplete", 503); }
      finally { await file.close(); }
      return { root_id: scope.root_id, domain: scope.domain, path: parts.join("/"), canonical_path: path.join(scope.canonical_path, ...parts), byte_count: data.length, sha256: hash(data), file_ref: "file:" + hash(scope.root_id + parts.join("/")).slice(0, 24), created: true, overwritten: false };
    }));
  }

  async makeDirectory(scope, input, signal) {
    const parts = relativePath(input.path, false);
    checkAbort(signal);
    return this.withRoot(scope, (root) => withParent(root, parts, async (parent, name) => {
      try { await fs.mkdir(childPath(parent, name), { mode: 0o750 }); }
      catch (error) { if (error?.code === "EEXIST") fail("file_exists", 409); throw error; }
      return { root_id: scope.root_id, domain: scope.domain, path: parts.join("/"), canonical_path: path.join(scope.canonical_path, ...parts), file_ref: "directory:" + hash(scope.root_id + parts.join("/")).slice(0, 24), created: true, overwritten: false };
    }));
  }

  async archive(scope, parts, signal) {
    const entries = [];
    let bytesTotal = 0;
    await this.withRoot(scope, (root) => walkDirectory(root, parts, async (base) => {
      const visit = async (dir, prefix) => {
        checkAbort(signal);
        const names = await fs.readdir(fdPath(dir));
        if (names.length > FILE_LIMITS.directoryEntries) fail("file_directory_entry_limit", 413);
        for (const name of names.sort()) {
          if (SECRET.test(name)) continue;
          const target = childPath(dir, name);
          const link = await fs.lstat(target).catch(() => null);
          if (!link || link.isSymbolicLink()) continue;
          const relative = prefix ? prefix + "/" + name : name;
          if (link.isDirectory()) {
            if (OMIT_ARCHIVE.has(name.toLowerCase())) continue;
            entries.push({ name: relative + "/", directory: true, mtime: link.mtimeMs, bytes: Buffer.alloc(0) });
            if (entries.length > FILE_LIMITS.archiveEntries) fail("file_archive_entry_limit", 413);
            const child = await fs.open(target, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW).catch(() => null);
            if (!child) fail("file_archive_changed", 409);
            try { await visit(child, relative); } finally { await child.close(); }
          } else {
            const file = await fs.open(target, constants.O_RDONLY | O_NONBLOCK | O_NOFOLLOW).catch(() => null);
            if (!file) continue;
            try {
              const stat = await file.stat();
              if (!stat.isFile() || stat.size > FILE_LIMITS.archiveInputBytes - bytesTotal) fail("file_archive_size_limit", 413);
              const content = await readBounded(file, FILE_LIMITS.archiveInputBytes - bytesTotal, signal);
              bytesTotal += content.length;
              entries.push({ name: relative, directory: false, mtime: stat.mtimeMs, bytes: content });
              if (entries.length > FILE_LIMITS.archiveEntries) fail("file_archive_entry_limit", 413);
            } finally { await file.close(); }
          }
        }
      };
      await visit(base, "");
    }));
    const tar = Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]);
    const archive = gzipSync(tar);
    if (archive.length > FILE_LIMITS.archiveOutputBytes) fail("file_archive_output_limit", 413);
    return { root_id: scope.root_id, domain: scope.domain, path: parts.join("/"), canonical_path: path.join(scope.canonical_path, ...parts), file_name: scope.domain.replaceAll(".", "-") + ".tar.gz", content_type: "application/gzip", byte_count: bytesTotal, archive_bytes: archive.length, sha256: hash(archive), archive_base64: archive.toString("base64"), entries: entries.length };
  }
}

export function registerTitanFileBridge({ provider, executionGateway, registerReadCapability } = {}) {
  if (!(provider instanceof TitanFileBridgeProvider)) throw new TypeError("file-bridge-provider-required");
  if (typeof executionGateway?.registerProvider !== "function" || typeof registerReadCapability !== "function") throw new TypeError("canonical-file-capability-owners-required");
  for (const capability of provider.readCapabilities) registerReadCapability(capability, (request) => provider.call({ ...request, capability }));
  executionGateway.registerProvider(provider);
  return Object.freeze({ provider_id: provider.id, read_capabilities: provider.readCapabilities, write_capabilities: provider.capabilities, revoke: (context) => provider.revoke(context) });
}
