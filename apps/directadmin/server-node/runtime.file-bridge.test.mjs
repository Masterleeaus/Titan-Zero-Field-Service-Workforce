import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionGateway } from "../../../packages/tools/execution-gateway.mjs";
import { APP_ROOTS, registerTitanFileBridge, TitanFileBridgeProvider } from "./file-bridge.mjs";
import { createServerNodeRuntime } from "./runtime.mjs";

const future = () => new Date(Date.now() + 60_000).toISOString();
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");

async function fixture(t, overrides = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "titan-file-api-"));
  const domainsRoot = path.join(temp, "domains");
  const domainRoot = path.join(domainsRoot, "titanzero.io", "public_html");
  await fs.mkdir(domainRoot, { recursive: true });
  await fs.writeFile(path.join(domainRoot, "index.html"), "site-home");
  const audit = [], evidence = [], authorized = [], executed = [];
  const registeredDomains = [{ domain: "titanzero.io", root_domain: "titanzero.io", company_id: "company-a", registered: true, canonical_document_root: domainRoot, writable: true }];
  const provider = new TitanFileBridgeProvider({
    domainsRoot,
    applicationRoots: APP_ROOTS,
    domainProvider: { async listRegisteredDomains() { return { domains: registeredDomains, observed_at: new Date().toISOString() }; } },
    auditSink: async event => audit.push(event),
    revocationStore: { async isRevoked() { return false; }, async revoke() {} },
    commissionedApplications: [],
  });
  const gateway = new ExecutionGateway({ evidenceSink: async event => evidence.push(event) });
  const integration = registerTitanFileBridge({ provider, executionGateway: gateway });
  const canonicalAdapter = {
    async authenticate({ bearerToken }) { return bearerToken === "canonical-session" ? { caller_id: "codex-client", actor_id: "actor-a", session_ref: "session-a", company_ids: ["company-a"] } : null; },
    async authorize(request) {
      authorized.push(structuredClone(request.intent));
      return { allowed: true, node_id: request.node_id, caller_id: request.caller_id, company_id: request.intent.company_id, capability_id: request.intent.capability_id, intent_digest: request.intent_digest, authority_decision_ref: request.intent.authority_decision_ref, expires_at: request.intent.expires_at };
    },
    async execute(request) {
      executed.push(structuredClone(request.intent));
      const intent = request.intent;
      const input = { ...intent.input, ...(request.secret_file_content_base64 !== undefined ? { secret_content_base64: request.secret_file_content_base64 } : {}) };
      const result = await gateway.execute({
        execution_id: `execution-${intent.idempotency_key}`,
        company_id: intent.company_id,
        actor_id: request.canonical_actor_id,
        session_ref: request.canonical_session_ref,
        correlation_id: request.correlation_id,
        capability: intent.capability_id,
        idempotency_key: intent.idempotency_key,
        authority: { status: "approved", expires_at: request.decision.expires_at },
        input,
      });
      return { ...result, verified: result.state === "VERIFIED", verification_ref: result.evidence?.verification?.verification_ref ?? null, provider_acknowledged: result.state === "PROVIDER_ACKNOWLEDGED" };
    },
    async recordEvidence(event) { evidence.push(structuredClone(event)); return { accepted: true, evidence_ref: event.evidence_ref }; },
    ...overrides,
  };
  const runtime = createServerNodeRuntime({ authToken: "legacy-node-token", storePath: path.join(temp, "control.json"), canonicalAdapter, fileBridge: integration });
  const address = await runtime.start();
  t.after(async () => { await runtime.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (route, body, token = "canonical-session") => {
    const response = await fetch(base + route, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-titan-schema-version": "1", "x-titan-caller-id": "codex-client", "x-titan-company-id": "company-a", "x-titan-correlation-id": "corr-file-1" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { runtime, provider, integration, canonicalAdapter, gateway, audit, evidence, authorized, executed, call, base, domainRoot };
}

const readRequest = (capability = "files.roots", input = {}) => ({ company_id: "company-a", capability_id: capability, authority_decision_ref: "authority-file-1", expires_at: future(), input });
const uploadRequest = async (f, content, { path: target = "new.txt", idempotency_key = "upload-1" } = {}) => {
  const roots = await f.call("/v1/files/roots", readRequest());
  return {
    company_id: "company-a", capability_id: "files.upload", authority_decision_ref: "authority-file-1", expires_at: future(), idempotency_key,
    input: { root_id: roots.body.roots[0].root_id, path: target, sha256: sha256(content), byte_count: content.length }, content_base64: content.toString("base64"),
  };
};

test("Server Node advertises and authorizes the file API through the canonical identity and evidence owners", async t => {
  const f = await fixture(t);
  const bootstrapResponse = await fetch(f.base + "/v1/bootstrap", { headers: { authorization: "Bearer legacy-node-token", "x-titan-schema-version": "1", "x-titan-caller-id": "codex-client", "x-titan-correlation-id": "corr-file-1" } });
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.file_bridge, "configured");
  assert.ok(bootstrap.capabilities.includes("files.roots"));
  assert.ok(bootstrap.capabilities.includes("files.upload"));

  const roots = await f.call("/v1/files/roots", readRequest());
  assert.equal(roots.status, 200);
  assert.equal(roots.body.roots.length, 1);
  assert.equal(roots.body.roots[0].domain, "titanzero.io");
  assert.ok(f.authorized.some(intent => intent.capability_id === "files.roots"));
  assert.ok(f.audit.some(event => event.operation === "files.roots" && event.result === "succeeded"));
  const event = f.evidence.find(row => row.kind === "server-node.file.read");
  assert.equal(event.result.root_count, 1);
  assert.equal(Object.hasOwn(event.result, "content_base64"), false);
});

test("download returns bounded file bytes only to the authorized caller and records metadata without bytes", async t => {
  const f = await fixture(t);
  const roots = await f.call("/v1/files/roots", readRequest());
  const downloaded = await f.call("/v1/files/download", readRequest("files.download", { root_id: roots.body.roots[0].root_id, path: "index.html" }));
  assert.equal(downloaded.status, 200);
  assert.equal(Buffer.from(downloaded.body.download_base64, "base64").toString(), "site-home");
  assert.equal(downloaded.body.sha256, sha256(Buffer.from("site-home")));
  const event = f.evidence.find(row => row.kind === "server-node.file.read" && row.result.capability === "files.download");
  assert.equal(event.result.byte_count, 9);
  assert.equal(Object.hasOwn(event.result, "download_base64"), false);
  assert.equal(JSON.stringify(event).includes(downloaded.body.download_base64), false);
});

test("upload bytes stay out of authority intent, accepted evidence and durable control metadata", async t => {
  const f = await fixture(t), content = Buffer.from("new governed file");
  const request = await uploadRequest(f, content);
  const response = await f.call("/v1/files/upload", request);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.verified, true);
  assert.equal(response.body.file.sha256, sha256(content));
  assert.equal(await fs.readFile(path.join(f.domainRoot, "new.txt"), "utf8"), content.toString());
  assert.ok(f.authorized.every(intent => !Object.hasOwn(intent, "content_base64")));
  assert.ok(f.executed.every(intent => !Object.hasOwn(intent, "content_base64")));
  const stored = JSON.stringify(f.runtime.store.state);
  assert.equal(stored.includes(content.toString("base64")), false);
  assert.equal(stored.includes(content.toString()), false);
  assert.equal(JSON.stringify(f.evidence).includes(content.toString("base64")), false);
  assert.equal(JSON.stringify(f.evidence).includes("[REDACTED]"), true);

  const replay = await f.call("/v1/files/upload", request);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(f.executed.length, 1);
});

test("upload API denies caller company mismatch and payload digest mismatch before dispatch", async t => {
  const f = await fixture(t), bytes = Buffer.from("bound content"), request = await uploadRequest(f, bytes);
  const mismatch = await f.call("/v1/files/upload", { ...request, content_base64: Buffer.from("different").toString("base64") });
  assert.equal(mismatch.status, 403);
  assert.equal(f.executed.length, 0);
  const otherCompany = await f.call("/v1/files/upload", { ...request, company_id: "company-b" });
  assert.equal(otherCompany.status, 403);
  assert.equal(f.executed.length, 0);
});

test("unsafe upload paths are rejected before authority or durable reservation", async t => {
  const f = await fixture(t), body = await uploadRequest(f, Buffer.from("blocked"), { path: "../outside.txt", idempotency_key: "unsafe-path" });
  const response = await f.call("/v1/files/upload", body);
  assert.equal(response.status, 400);
  assert.equal(f.authorized.some(intent => intent.capability_id === "files.upload"), false);
  assert.equal(Object.keys(f.runtime.store.state.intents).length, 0);
  assert.equal(f.executed.length, 0);
});

test("file API caps concurrent requests before provider or authority work", async t => {
  let release, signalReached;
  const hold = new Promise(resolve => { release = resolve; });
  const fourAuthorized = new Promise(resolve => { signalReached = resolve; });
  let reached = 0;
  const f = await fixture(t, {
    async authorize(request) {
      if (request.intent.capability_id === "files.roots") {
        reached += 1;
        if (reached === 4) signalReached();
        await hold;
      }
      return { allowed: true, node_id: request.node_id, caller_id: request.caller_id, company_id: request.intent.company_id, capability_id: request.intent.capability_id, intent_digest: request.intent_digest, authority_decision_ref: request.intent.authority_decision_ref, expires_at: request.intent.expires_at };
    },
  });
  const requests = Array.from({ length: 4 }, () => f.call("/v1/files/roots", readRequest()));
  await fourAuthorized;
  const refused = await f.call("/v1/files/roots", readRequest());
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error, "file_service_busy");
  release();
  const accepted = await Promise.all(requests);
  assert.ok(accepted.every(result => result.status === 200));
  assert.equal(reached, 4);
});

test("write outcome uncertainty is durable and never re-dispatched on replay", async t => {
  let dispatches = 0;
  const f = await fixture(t, { async execute() { dispatches += 1; throw new Error("lost response after dispatch"); } });
  const request = await uploadRequest(f, Buffer.from("maybe written"));
  const first = await f.call("/v1/files/upload", request);
  assert.equal(first.status, 503);
  assert.equal(first.body.state, "UNCERTAIN");
  const replay = await f.call("/v1/files/upload", request);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.state, "UNCERTAIN");
  assert.equal(replay.body.replay, true);
  assert.equal(dispatches, 1);
});

test("bridge revocation is canonically authorized, audited and enforced for that company", async t => {
  const f = await fixture(t);
  const revoked = await f.call("/v1/files/revoke", { company_id: "company-a", capability_id: "files.bridge.revoke", authority_decision_ref: "authority-revoke-1", expires_at: future() });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, true);
  assert.ok(f.audit.some(event => event.operation === "files.revoke" && event.company_id === "company-a"));
  assert.ok(f.evidence.some(event => event.kind === "server-node.file.revoked"));
  const refused = await f.call("/v1/files/roots", readRequest());
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "file_bridge_revoked");
});
