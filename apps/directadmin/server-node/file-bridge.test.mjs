import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { DirectAdminDomainInventoryProvider, TitanFileBridgeProvider, APP_ROOTS, FILE_LIMITS, registerTitanFileBridge } from "./file-bridge.mjs";
import { ExecutionGateway, EXECUTION_CLASSES } from "../../../packages/tools/execution-gateway.mjs";

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "titan-file-bridge-"));
  const base = path.join(temp, "domains", "titanzero.io");
  const docroot = path.join(base, "public_html");
  const appRoot = path.join(temp, "apps", "desk");
  await Promise.all([docroot, appRoot, path.join(base, "desk"), path.join(base, "future")].map((p) => fs.mkdir(p, { recursive: true })));
  await fs.writeFile(path.join(docroot, "index.html"), "<h1>Titan</h1>");
  await fs.writeFile(path.join(docroot, ".env"), "secret");
  await fs.writeFile(path.join(docroot, "visible.txt"), "safe");
  const domains = [
    { domain: "titanzero.io", root_domain: "titanzero.io", company_id: "company-a", registered: true, canonical_document_root: docroot, writable: true },
    { domain: "desk.titanzero.io", root_domain: "titanzero.io", company_id: "company-a", registered: true, canonical_document_root: path.join(base, "desk"), writable: true },
    { domain: "future.titanzero.io", root_domain: "titanzero.io", company_id: "company-a", registered: true, canonical_document_root: path.join(base, "future"), writable: false },
    { domain: "other.example", root_domain: "example", company_id: "company-a", registered: true, canonical_document_root: "/etc" },
    { domain: "titanzero.pro", root_domain: "titanzero.pro", company_id: "company-a", registered: true, canonical_document_root: "/etc" },
  ];
  const audit = [];
  let revoked = false, observedAt = new Date().toISOString();
  const provider = new TitanFileBridgeProvider({
    domainsRoot: path.join(temp, "domains"),
    applicationRoots: APP_ROOTS.map((x) => x.id === "desk" ? { ...x, path: appRoot } : x),
    domainProvider: { async listRegisteredDomains() { return { domains, observed_at: observedAt }; } },
    auditSink: async (event) => { audit.push(event); },
    revocationStore: { async isRevoked() { return revoked; }, async revoke() { revoked = true; } },
    commissionedApplications: [{ id: "desk", writable: true }],
  });
  const context = { company_id: "company-a", actor_id: "owner-1", session_ref: "session-1", correlation_id: "corr-1" };
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  return { provider, context, audit, domains, docroot, setRevoked(x) { revoked = x; }, setObservedAt(x) { observedAt = x; } };
}
const call = (f, capability, input = {}, context = f.context) => f.provider.call({ ...context, capability, input });
const rootFor = (roots, domain = "titanzero.io", kind = "domain") => roots.find((x) => x.domain === domain && x.kind === kind);
const execute = (f, capability, input, context = f.context) => f.provider.execute({ ...context, capability, input });

test("DirectAdmin inventory uses the fixed admin API, filters to its configured owner, and redacts credentials", async () => {
  let calls = 0;
  const provider = new DirectAdminDomainInventoryProvider({
    origin: "https://panel.example.test:2222",
    apiUsername: "admin",
    ownerUser: "admin",
    companyId: "company-a",
    credentialProvider: { async get({ service, username, purpose }) { assert.deepEqual({ service, username, purpose }, { service: "directadmin", username: "admin", purpose: "domain-inventory" }); return { login_key: "server-only-login-key" }; } },
    writableDomains: ["titanzero.io"],
    now: () => Date.parse("2026-10-07T12:00:00.000Z"),
    async requestJson(url, authorization, timeoutMs) {
      calls += 1;
      assert.equal(url.origin, "https://panel.example.test:2222");
      assert.equal(url.pathname, "/CMD_API_DOMAIN");
      assert.equal(url.searchParams.get("json"), "yes");
      assert.equal(url.searchParams.get("action"), "document_root_all");
      assert.equal(Buffer.from(authorization.slice("Basic ".length), "base64").toString(), "admin:server-only-login-key");
      assert.equal(timeoutMs, 5000);
      return { users: {
        admin: { domains: { "titanzero.io": { public_html: "/home/admin/domains/titanzero.io/public_html", subdomains: { desk: { public_html: "/home/admin/domains/titanzero.io/public_html/desk" }, future: { public_html: "/home/admin/domains/titanzero.io/public_html/future" } } }, "titanzero.pro": { public_html: "/etc" } } },
        another: { domains: { "fake.titanzero.io": { public_html: "/etc" } } },
      } };
    },
  });
  const inventory = await provider.listRegisteredDomains({ company_id: "company-a", root_domain: "titanzero.io" });
  assert.deepEqual(inventory.domains.map(row => row.domain), ["desk.titanzero.io", "future.titanzero.io", "titanzero.io"]);
  assert.equal(inventory.domains.find(row => row.domain === "titanzero.io").writable, true);
  assert.equal(inventory.domains.find(row => row.domain === "future.titanzero.io").writable, false);
  assert.equal(JSON.stringify(inventory).includes("server-only-login-key"), false);
  await assert.rejects(provider.listRegisteredDomains({ company_id: "company-b", root_domain: "titanzero.io" }), /file_company_scope_denied/);
  assert.equal(calls, 1);
});

test("DirectAdmin inventory refuses unpinned or non-TLS panel origins", () => {
  const common = { apiUsername: "admin", ownerUser: "admin", companyId: "company-a", credentialProvider: { async get() { return { login_key: "test" }; } } };
  for (const origin of ["http://panel.example.test:2222", "https://panel.example.test:443", "https://user:pass@panel.example.test:2222", "https://panel.example.test:2222/path"]) {
    assert.throws(() => new DirectAdminDomainInventoryProvider({ ...common, origin }), /directadmin_origin/);
  }
});

test("enumerates only registered Titan domains and explicitly commissioned app roots", async (t) => {
  const f = await fixture(t), roots = (await call(f, "files.roots")).roots;
  assert.deepEqual(roots.map((x) => [x.kind, x.domain, x.application_id]), [
    ["application", "desk.titanzero.io", "desk"],
    ["domain", "desk.titanzero.io", null],
    ["domain", "future.titanzero.io", null],
    ["domain", "titanzero.io", null],
  ]);
  assert.ok(roots.every((x) => x.company_id === "company-a"));
  assert.ok(!roots.some((x) => x.domain.endsWith("titanzero.pro")));
  assert.equal(APP_ROOTS.length, 4);
});

test("lists, stats, and reads files while protecting secrets", async (t) => {
  const f = await fixture(t), root = rootFor((await call(f, "files.roots")).roots);
  const list = await call(f, "files.list", { root_id: root.root_id, path: "" });
  assert.ok(list.entries.some((x) => x.name === "index.html"));
  assert.ok(!list.entries.some((x) => x.name === ".env"));
  assert.equal((await call(f, "files.stat", { root_id: root.root_id, path: "visible.txt" })).size_bytes, 4);
  const read = await call(f, "files.read", { root_id: root.root_id, path: "index.html" });
  assert.equal(read.content_base64, Buffer.from("<h1>Titan</h1>").toString("base64"));
  await assert.rejects(call(f, "files.read", { root_id: root.root_id, path: ".env" }), /file_secret_denied/);
});

test("rejects traversal, foreign-company roots, unrelated domains, and symlink escapes", async (t) => {
  const f = await fixture(t), root = rootFor((await call(f, "files.roots")).roots);
  for (const input of ["../secret", "/etc/passwd", "x/../../y", "a\\b"]) {
    await assert.rejects(call(f, "files.stat", { root_id: root.root_id, path: input }), /file_path_invalid/);
  }
  await assert.rejects(call(f, "files.list", { root_id: root.root_id }, { ...f.context, company_id: "company-b" }), /file_company_scope_denied/);
  await assert.rejects(call(f, "files.list", { root_id: "domain:fake", domain: "titanzero.pro" }), /file_root_not_registered/);
  await fs.symlink("/etc/passwd", path.join(f.docroot, "escape"));
  await assert.rejects(call(f, "files.read", { root_id: root.root_id, path: "escape" }), /file_unavailable/);
});

test("rejects stale DirectAdmin domain inventories", async (t) => {
  const f = await fixture(t);
  f.setObservedAt(new Date(Date.now() - FILE_LIMITS.inventoryAgeMs - 1000).toISOString());
  await assert.rejects(call(f, "files.roots"), /directadmin_domain_inventory_stale/);
});

test("downloads bounded files with checksum metadata", async (t) => {
  const f = await fixture(t), root = rootFor((await call(f, "files.roots")).roots);
  const result = await call(f, "files.download", { root_id: root.root_id, path: "visible.txt" });
  assert.equal(result.download_base64, Buffer.from("safe").toString("base64"));
  assert.equal(result.sha256, crypto.createHash("sha256").update("safe").digest("hex"));
});

test("uploads new files only, refuses overwrite, and verifies the result", async (t) => {
  const f = await fixture(t), root = rootFor((await call(f, "files.roots")).roots);
  const content = Buffer.from("new data");
  const input = { root_id: root.root_id, path: "new.txt", sha256: crypto.createHash("sha256").update(content).digest("hex"), byte_count: content.length, secret_content_base64: content.toString("base64") };
  const request = { ...f.context, capability: "files.upload", input };
  const result = await f.provider.execute(request);
  assert.equal(result.result.created, true);
  assert.equal(result.result.overwritten, false);
  assert.equal((await f.provider.verify(result, request)).verified, true);
  const replacement = Buffer.from("replacement");
  await assert.rejects(execute(f, "files.upload", { ...input, sha256: crypto.createHash("sha256").update(replacement).digest("hex"), byte_count: replacement.length, secret_content_base64: replacement.toString("base64") }), /file_exists/);
  assert.equal(await fs.readFile(path.join(f.docroot, "new.txt"), "utf8"), "new data");
  await assert.rejects(execute(f, "files.upload", { ...input, path: "large.txt", secret_content_base64: Buffer.alloc(FILE_LIMITS.fileBytes + 1).toString("base64") }), /file_upload_size_or_encoding_invalid/);
  await assert.rejects(execute(f, "files.upload", { ...input, path: "mismatch.txt", sha256: "0".repeat(64) }), /file_upload_authorization_digest_mismatch/);
});

test("creates new directories and verifies them", async (t) => {
  const f = await fixture(t), root = rootFor((await call(f, "files.roots")).roots);
  await fs.mkdir(path.join(f.docroot, "parent"));
  const input = { root_id: root.root_id, path: "parent/new-dir" };
  const request = { ...f.context, capability: "files.mkdir", input };
  const result = await f.provider.execute(request);
  assert.equal(result.result.created, true);
  assert.equal((await f.provider.verify(result, request)).verified, true);
  await assert.rejects(f.provider.execute(request), /file_exists/);
});

test("archives omit secrets, generated trees, and symlinks", async (t) => {
  const f = await fixture(t), root = rootFor((await call(f, "files.roots")).roots);
  await fs.mkdir(path.join(f.docroot, "node_modules"));
  await fs.writeFile(path.join(f.docroot, "node_modules", "hidden.js"), "excluded");
  await fs.writeFile(path.join(f.docroot, "token-store.json"), "secret");
  await fs.symlink("/etc/passwd", path.join(f.docroot, "escape"));
  const result = await call(f, "files.downloadArchive", { root_id: root.root_id, path: "" });
  const tar = gunzipSync(Buffer.from(result.archive_base64, "base64")).toString("utf8");
  assert.ok(tar.includes("index.html"));
  assert.ok(!tar.includes("token-store.json"));
  assert.ok(!tar.includes("hidden.js"));
  assert.ok(!tar.includes("escape"));
  assert.ok(result.archive_bytes <= FILE_LIMITS.archiveOutputBytes);
});

test("revocation blocks access and operations are audited without file contents", async (t) => {
  const f = await fixture(t), root = rootFor((await call(f, "files.roots")).roots);
  await call(f, "files.download", { root_id: root.root_id, path: "visible.txt" });
  const bytes = Buffer.from("never audit bytes");
  await execute(f, "files.upload", { root_id: root.root_id, path: "audit.txt", sha256: crypto.createHash("sha256").update(bytes).digest("hex"), byte_count: bytes.length, secret_content_base64: bytes.toString("base64") });
  await f.provider.revoke(f.context);
  assert.ok(f.audit.some((x) => x.result === "succeeded" && x.operation === "files.download"));
  assert.ok(f.audit.some((x) => x.result === "requested" && x.operation === "files.upload"));
  assert.ok(f.audit.some((x) => x.result === "revoked" && x.operation === "files.revoke"));
  assert.ok(!JSON.stringify(f.audit).includes("never audit bytes"));
  await assert.rejects(call(f, "files.roots"), /file_bridge_revoked/);
});

test("registers create-only writes with the real ExecutionGateway and returns guarded read handlers", async (t) => {
  const f = await fixture(t), evidence = [];
  const gateway = new ExecutionGateway({ evidenceSink: async event => evidence.push(event) });
  const integration = registerTitanFileBridge({
    provider: f.provider,
    executionGateway: gateway,
  });
  assert.equal(gateway.listProviders()[0].id, f.provider.id);
  assert.deepEqual(integration.write_capabilities, ["files.upload", "files.mkdir"]);
  assert.deepEqual(Object.keys(integration.read).sort(), ["files.download", "files.downloadArchive", "files.list", "files.read", "files.roots", "files.stat"]);
  assert.ok(Array.isArray((await integration.read["files.roots"]({ ...f.context, input: {} })).roots));
  const bytes = Buffer.from("gateway upload");
  const request = { execution_id: "exec-file-1", company_id: f.context.company_id, actor_id: f.context.actor_id, session_ref: f.context.session_ref, correlation_id: f.context.correlation_id, capability: "files.upload", idempotency_key: "file-create-1", authority: { status: "approved" }, input: { root_id: rootFor((await integration.read["files.roots"]({ ...f.context, input: {} })).roots).root_id, path: "gateway.txt", sha256: crypto.createHash("sha256").update(bytes).digest("hex"), byte_count: bytes.length, secret_content_base64: bytes.toString("base64") } };
  const result = await gateway.execute(request);
  assert.equal(result.state, "VERIFIED");
  assert.ok(!JSON.stringify(evidence).includes(bytes.toString("base64")));
  assert.ok(JSON.stringify(evidence).includes("[REDACTED]"));
  assert.equal(typeof integration.revoke, "function");
});
