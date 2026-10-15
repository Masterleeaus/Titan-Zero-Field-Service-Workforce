import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIdentitySessionRegistry,
  openIdentitySessionRegistry,
} from "@titan-zero/titan-platform/security-boundary";
import { createSqliteStorage, openExistingSqliteStorage } from "../../../../../packages/storage/src/index";
import {
  createConfiguredWebSessionRuntime,
  type WebLoginIdentityBinding,
} from "../web-session-runtime";
import { CURRENT_WEB_SESSION_COOKIE_NAME } from "../current-session";

const ORIGIN = "https://field.example.test";
const LOGIN_ISSUER = `titan:web-login:${ORIGIN}`;
const SESSION_ISSUER = `titan:web-session:${ORIGIN}`;
const legacyUserId = "legacy-user-17";
const legacyAccountId = "legacy-account-17";
const actorId = "stable-actor-17";
const companyId = "canonical-company-17";
const companyB = "canonical-company-29";
const companyUnmapped = "canonical-company-35";
const accountB = "legacy-account-29";
const deviceId = "web-device-17";
const targetLegacyUserId = "legacy-user-44";
const targetActorId = "stable-actor-44";
const targetDeviceId = "web-device-44";

let directory: string;
let seedStorage: ReturnType<typeof createSqliteStorage> | undefined;
let seedRegistry: Awaited<ReturnType<typeof createIdentitySessionRegistry>> | undefined;
let runtime: Awaited<ReturnType<typeof createConfiguredWebSessionRuntime>> | undefined;

function testSecret(): string {
  return randomBytes(32).toString("base64url");
}

function bindings(): WebLoginIdentityBinding[] {
  return [companyId, companyB].map((company, index) => ({
    legacy_user_id: legacyUserId,
    legacy_account_id: index === 0 ? legacyAccountId : accountB,
    company_id: company,
    actor_id: actorId,
    device_id: deviceId,
  }));
}

function environment(registryPath: string, patch: Record<string, string> = {}) {
  return {
    TITAN_WEB_PUBLIC_ORIGIN: ORIGIN,
    TITAN_WEB_IDENTITY_REGISTRY_PATH: registryPath,
    TITAN_WEB_LOGIN_KEY_ID: "web-login-test-key",
    TITAN_WEB_LOGIN_SIGNING_SECRET: testSecret(),
    TITAN_WEB_SESSION_KEY_ID: "web-session-test-key",
    TITAN_WEB_SESSION_SIGNING_SECRET: testSecret(),
    TITAN_WEB_IDENTITY_BINDINGS_JSON: JSON.stringify(bindings()),
    ...patch,
  };
}

async function setup() {
  directory = "";
  seedStorage = undefined;
  seedRegistry = undefined;
  directory = await mkdtemp(join(tmpdir(), "titan-web-runtime-"));
  const registryPath = join(directory, "global-registry.sqlite");
  seedStorage = createSqliteStorage(registryPath);
  seedRegistry = await createIdentitySessionRegistry({ storage: seedStorage, storage_role: "GLOBAL_REGISTRY" });
  await seedRegistry.putActor({ actor_id: actorId, status: "active" }, null);
  await seedRegistry.putCompany({ company_id: companyId, status: "active" }, null);
  await seedRegistry.putCompany({ company_id: companyB, status: "active" }, null);
  await seedRegistry.putCompany({ company_id: companyUnmapped, status: "active" }, null);
  await seedRegistry.putMembership({ actor_id: actorId, company_id: companyId, role: "owner", status: "active" }, null);
  await seedRegistry.putMembership({ actor_id: actorId, company_id: companyB, role: "tech", status: "active" }, null);
  await seedRegistry.putMembership({ actor_id: actorId, company_id: companyUnmapped, role: "admin", status: "active" }, null);
  await seedRegistry.putDevice({ device_id: deviceId, actor_id: actorId, status: "active" }, null);
  await seedRegistry.putExternalBinding({
    binding_id: "web-login-binding-17",
    provider: LOGIN_ISSUER,
    subject: legacyUserId,
    actor_id: actorId,
    company_id: companyId,
    status: "active",
  }, null);
  await seedRegistry.putExternalBinding({
    binding_id: "web-login-binding-unmapped",
    provider: LOGIN_ISSUER,
    subject: legacyUserId,
    actor_id: actorId,
    company_id: companyUnmapped,
    status: "active",
  }, null);
  await seedRegistry.putExternalBinding({
    binding_id: "web-login-binding-29",
    provider: LOGIN_ISSUER,
    subject: legacyUserId,
    actor_id: actorId,
    company_id: companyB,
    status: "active",
  }, null);
  return { registryPath, environment: environment(registryPath) };
}

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await seedStorage?.close();
  seedStorage = undefined;
  seedRegistry = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("configured web authentication runtime", () => {
  it("reports every absent operator setting without opening or creating a registry", async () => {
    await expect(createConfiguredWebSessionRuntime({})).rejects.toMatchObject({
      code: "WEB_AUTH_SETUP_REQUIRED",
      missing_or_invalid: [
        "TITAN_WEB_PUBLIC_ORIGIN",
        "TITAN_WEB_IDENTITY_REGISTRY_PATH",
        "TITAN_WEB_LOGIN_KEY_ID",
        "TITAN_WEB_LOGIN_SIGNING_SECRET",
        "TITAN_WEB_SESSION_KEY_ID",
        "TITAN_WEB_SESSION_SIGNING_SECRET",
        "TITAN_WEB_IDENTITY_BINDINGS_JSON",
      ],
    });
  });

  it("opens an existing GLOBAL_REGISTRY, issues a host-namespaced canonical session, and survives restart", async () => {
    const { registryPath, environment: env } = await setup();
    const before = (await seedStorage!.query<{ version: number }>("SELECT version FROM titan_security_migrations")).rows;
    runtime = await createConfiguredWebSessionRuntime(env);

    const issued = await runtime.issueForAuthenticatedWebUser(legacyUserId, legacyAccountId);
    const header = decodeProtectedHeader(issued.credential);
    const claims = decodeJwt(issued.credential);
    expect(header).toEqual({ alg: "HS256", kid: "web-session-test-key", typ: "titan-session+jwt" });
    expect(claims).toMatchObject({
      iss: SESSION_ISSUER,
      aud: "titan-web",
      sub: legacyUserId,
      actor_id: actorId,
      company_id: companyId,
      device_id: deviceId,
      session_revision: 1,
      identity_provider: LOGIN_ISSUER,
    });
    expect(issued.session).toEqual({ userId: legacyUserId, accountId: legacyAccountId, role: "owner" });
    expect(issued.operationCompanyIds).toEqual([companyId]);
    expect(issued.context.session_id).toMatch(/^auth-[a-f0-9]{64}$/);
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(300);
    expect(await runtime.resolveCredential(issued.credential)).toMatchObject({
      session: issued.session,
      context: { actor_id: actorId, company_id: companyId, device_id: deviceId, session_id: issued.context.session_id },
    });
    expect((await seedStorage!.query<{ version: number }>("SELECT version FROM titan_security_migrations")).rows).toEqual(before);

    await runtime.close();
    runtime = await createConfiguredWebSessionRuntime(env);
    expect(await runtime.resolveCredential(issued.credential)).not.toBeNull();
    await runtime.revokeCredential(issued.credential);
    expect(await runtime.resolveCredential(issued.credential)).toBeNull();

    await runtime.close();
    runtime = await createConfiguredWebSessionRuntime(env);
    expect(await runtime.resolveCredential(issued.credential)).toBeNull();
    const restartedStorage = openExistingSqliteStorage(registryPath);
    try {
      const registry = await openIdentitySessionRegistry({ storage: restartedStorage, storage_role: "GLOBAL_REGISTRY" });
      const rows = await restartedStorage.query<{ revoked: number }>("SELECT revoked FROM titan_security_sessions");
      expect(rows.rows).toEqual([{ revoked: 1 }]);
      await registry.resolveCurrentSession(
        { provider: LOGIN_ISSUER, subject: legacyUserId, session_id: issued.context.session_id, device_id: deviceId, session_revision: 1 },
        { audience: "titan-web", company_id: companyId, actor_id: actorId, context_revision: issued.context.context_revision },
        new Date().toISOString(),
      ).then(() => { throw new Error("revoked session unexpectedly resolved"); }, () => undefined);
    } finally {
      await restartedStorage.close();
    }
  });

  it("rejects wrong issuer, audience, algorithm, key ID, signing key, tampered claims, and tampered signature", async () => {
    const { environment: env } = await setup();
    runtime = await createConfiguredWebSessionRuntime(env);
    const issued = await runtime.issueForAuthenticatedWebUser(legacyUserId, legacyAccountId);
    const claims = decodeJwt(issued.credential);
    const secret = Buffer.from(env.TITAN_WEB_SESSION_SIGNING_SECRET, "base64url");
    const wrongKey = randomBytes(32);

    async function signed(patch: {
      issuer?: string;
      audience?: string;
      algorithm?: "HS256" | "HS384";
      keyId?: string;
      key?: Uint8Array;
      claim?: Record<string, unknown>;
    } = {}) {
      const token = new SignJWT({ ...claims, ...patch.claim })
        .setProtectedHeader({
          alg: patch.algorithm ?? "HS256",
          kid: patch.keyId ?? "web-session-test-key",
          typ: "titan-session+jwt",
        })
        .setIssuer(patch.issuer ?? SESSION_ISSUER)
        .setSubject(String(claims.sub))
        .setAudience(patch.audience ?? "titan-web")
        .setIssuedAt(Number(claims.iat))
        .setExpirationTime(Number(claims.exp))
        .sign(patch.key ?? secret);
      return token;
    }

    const rejected = await Promise.all([
      signed({ issuer: "titan:web-session:https://attacker.example.test" }),
      signed({ audience: "titan-directadmin" }),
      signed({ algorithm: "HS384" }),
      signed({ keyId: "attacker-key" }),
      signed({ key: wrongKey }),
      signed({ claim: { actor_id: "attacker-actor" } }),
      signed({ claim: { company_id: "another-company" } }),
    ]);
    for (const token of rejected) expect(await runtime.resolveCredential(token)).toBeNull();
    const [header, payload, signature] = issued.credential.split(".");
    const tamperedSignature = `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect(await runtime.resolveCredential(tamperedSignature)).toBeNull();
  });

  it("switches only from a verified current credential and scopes to the selected company", async () => {
    const { environment: env } = await setup();
    runtime = await createConfiguredWebSessionRuntime(env);
    const issued = await runtime.issueForAuthenticatedWebUser(legacyUserId, legacyAccountId);
    const switched = await runtime.switchCompanyCredential(issued.credential, companyB);
    expect(switched.session).toEqual({ userId: legacyUserId, accountId: accountB, role: "tech" });
    expect(switched.context.company_id).toBe(companyB);
    expect(switched.operationCompanyIds).toEqual([companyB]);
    expect(await runtime.resolveCredential(issued.credential)).toBeNull();
    expect(await runtime.resolveCredential(switched.credential)).toMatchObject({
      session: switched.session,
      operationCompanyIds: [companyB],
    });
    await expect(runtime.switchCompanyCredential(issued.context.session_id, companyId)).rejects.toThrow();
    const stillCurrent = await runtime.resolveCredential(switched.credential);
    expect(stillCurrent?.operationCompanyIds).toEqual([companyB]);
  });

  it("invalidates the exact company cookie on role reduction and revocation while preserving another company", async () => {
    const { environment: env } = await setup();
    const targetBindings: WebLoginIdentityBinding[] = [companyId, companyB].map((company, index) => ({
      legacy_user_id: targetLegacyUserId,
      legacy_account_id: index === 0 ? legacyAccountId : accountB,
      company_id: company,
      actor_id: targetActorId,
      device_id: targetDeviceId,
    }));
    env.TITAN_WEB_IDENTITY_BINDINGS_JSON = JSON.stringify([...bindings(), ...targetBindings]);
    await seedRegistry!.putActor({ actor_id: targetActorId, status: "active" }, null);
    await seedRegistry!.putMembership({ actor_id: targetActorId, company_id: companyId, role: "admin", status: "active" }, null);
    await seedRegistry!.putMembership({ actor_id: targetActorId, company_id: companyB, role: "owner", status: "active" }, null);
    await seedRegistry!.putDevice({ device_id: targetDeviceId, actor_id: targetActorId, status: "active" }, null);
    for (const [index, company] of [companyId, companyB].entries()) {
      await seedRegistry!.putExternalBinding({
        binding_id: "target-web-login-binding-" + index,
        provider: LOGIN_ISSUER,
        subject: targetLegacyUserId,
        actor_id: targetActorId,
        company_id: company,
        status: "active",
      }, null);
    }
    runtime = await createConfiguredWebSessionRuntime(env);
    const owner = await runtime.issueForAuthenticatedWebUser(legacyUserId, legacyAccountId);
    const targetA = await runtime.issueForAuthenticatedWebUser(targetLegacyUserId, legacyAccountId);
    const targetB = await runtime.issueForAuthenticatedWebUser(targetLegacyUserId, accountB);
    const ownerRequest = new Request(ORIGIN + "/api/v1/users/" + targetLegacyUserId, {
      headers: { cookie: CURRENT_WEB_SESSION_COOKIE_NAME + "=" + owner.credential },
    });
    const nonOwnerRequest = new Request(ORIGIN + "/api/v1/users/" + targetLegacyUserId, {
      headers: { cookie: CURRENT_WEB_SESSION_COOKIE_NAME + "=" + targetA.credential },
    });
    const sessionIdRequest = new Request(ORIGIN + "/api/v1/users/" + targetLegacyUserId, {
      headers: { cookie: CURRENT_WEB_SESSION_COOKIE_NAME + "=" + targetA.context.session_id },
    });

    await expect(runtime.restrictMembershipForLegacyChangeRequest(
      nonOwnerRequest, targetLegacyUserId, "admin", "active", "tech", "active",
    )).rejects.toMatchObject({ code: "WEB_MEMBERSHIP_RECONCILIATION_UNAVAILABLE" });
    await expect(runtime.restrictMembershipForLegacyChangeRequest(
      sessionIdRequest, targetLegacyUserId, "admin", "active", "tech", "active",
    )).rejects.toMatchObject({ code: "WEB_MEMBERSHIP_RECONCILIATION_UNAVAILABLE" });
    expect(await seedRegistry!.getMembership(targetActorId, companyId)).toMatchObject({
      role: "admin", status: "active", revision: 1,
    });

    const demotionNeedsFinish = await runtime.restrictMembershipForLegacyChangeRequest(
      ownerRequest, targetLegacyUserId, "admin", "active", "tech", "active",
    );
    expect(demotionNeedsFinish).toBe(false);
    expect(await runtime.resolveCredential(targetA.credential)).toBeNull();
    expect(await runtime.resolveCredential(targetB.credential)).toMatchObject({
      session: { userId: targetLegacyUserId, accountId: accountB, role: "owner" },
      operationCompanyIds: [companyB],
    });
    expect(await seedRegistry!.getMembership(targetActorId, companyId)).toMatchObject({
      role: "tech", status: "active", revision: 2,
    });
    expect(await seedRegistry!.getMembership(targetActorId, companyB)).toMatchObject({
      role: "owner", status: "active", revision: 1,
    });

    const targetAfterDemotion = await runtime.issueForAuthenticatedWebUser(targetLegacyUserId, legacyAccountId);
    await runtime.restrictMembershipForLegacyChangeRequest(
      ownerRequest, targetLegacyUserId, "tech", "active", "tech", "revoked",
    );
    expect(await runtime.resolveCredential(targetAfterDemotion.credential)).toBeNull();
    expect(await runtime.resolveCredential(targetB.credential)).not.toBeNull();
    expect(await seedRegistry!.getMembership(targetActorId, companyId)).toMatchObject({
      role: "tech", status: "revoked", revision: 3,
    });
    expect(await seedRegistry!.getMembership(targetActorId, companyB)).toMatchObject({
      role: "owner", status: "active", revision: 1,
    });
    expect(await runtime.resolveCredential(owner.credential)).not.toBeNull();
  });

  it("stages promotions at the lower role, then finishes after commit without reactivating", async () => {
    const { environment: env } = await setup();
    env.TITAN_WEB_IDENTITY_BINDINGS_JSON = JSON.stringify([...bindings(), {
      legacy_user_id: targetLegacyUserId,
      legacy_account_id: legacyAccountId,
      company_id: companyId,
      actor_id: targetActorId,
      device_id: targetDeviceId,
    }]);
    await seedRegistry!.putActor({ actor_id: targetActorId, status: "active" }, null);
    await seedRegistry!.putMembership({ actor_id: targetActorId, company_id: companyId, role: "tech", status: "active" }, null);
    await seedRegistry!.putDevice({ device_id: targetDeviceId, actor_id: targetActorId, status: "active" }, null);
    await seedRegistry!.putExternalBinding({
      binding_id: "target-promotion-web-login",
      provider: LOGIN_ISSUER,
      subject: targetLegacyUserId,
      actor_id: targetActorId,
      company_id: companyId,
      status: "active",
    }, null);
    runtime = await createConfiguredWebSessionRuntime(env);
    const owner = await runtime.issueForAuthenticatedWebUser(legacyUserId, legacyAccountId);
    const target = await runtime.issueForAuthenticatedWebUser(targetLegacyUserId, legacyAccountId);
    const ownerRequest = new Request(ORIGIN + "/api/v1/users/" + targetLegacyUserId, {
      headers: { cookie: CURRENT_WEB_SESSION_COOKIE_NAME + "=" + owner.credential },
    });

    const promotionNeedsFinish = await runtime.restrictMembershipForLegacyChangeRequest(
      ownerRequest, targetLegacyUserId, "tech", "active", "admin", "active",
    );
    expect(promotionNeedsFinish).toBe(true);
    expect(await runtime.resolveCredential(target.credential)).toBeNull();
    expect(await seedRegistry!.getMembership(targetActorId, companyId)).toMatchObject({
      role: "tech", status: "active", revision: 2,
    });
    await runtime.finishMembershipRoleChangeRequest(ownerRequest, targetLegacyUserId, "admin");
    expect(await seedRegistry!.getMembership(targetActorId, companyId)).toMatchObject({
      role: "admin", status: "active", revision: 3,
    });

    await seedRegistry!.putMembership({ actor_id: targetActorId, company_id: companyId, role: "tech", status: "revoked" }, 3);
    await runtime.finishMembershipRoleChangeRequest(ownerRequest, targetLegacyUserId, "owner");
    expect(await seedRegistry!.getMembership(targetActorId, companyId)).toMatchObject({
      role: "owner", status: "revoked", revision: 5,
    });
    await expect(runtime.issueForAuthenticatedWebUser(targetLegacyUserId, legacyAccountId)).rejects.toThrow();
  });

  it("rejects registry switch choices without an approved web projection before changing the current session", async () => {
    const { environment: env } = await setup();
    runtime = await createConfiguredWebSessionRuntime(env);
    const issued = await runtime.issueForAuthenticatedWebUser(legacyUserId, legacyAccountId);
    expect(issued.context.allowed_company_ids).toContain(companyUnmapped);
    await expect(runtime.switchCompanyCredential(issued.credential, companyUnmapped)).rejects.toMatchObject({
      code: "WEB_IDENTITY_BINDING_REQUIRED",
    });
    expect(await runtime.resolveCredential(issued.credential)).not.toBeNull();
    expect((await seedStorage!.query<{ session_id: string }>("SELECT session_id FROM titan_security_sessions")).rows).toHaveLength(1);
  });

  it("rejects a target legacy-user mapping for another subject before changing the current session", async () => {
    const { environment: env } = await setup();
    const configuredBindings = bindings().map(binding => binding.company_id === companyB
      ? { ...binding, legacy_user_id: "different-legacy-user" }
      : binding);
    runtime = await createConfiguredWebSessionRuntime({ ...env, TITAN_WEB_IDENTITY_BINDINGS_JSON: JSON.stringify(configuredBindings) });
    const issued = await runtime.issueForAuthenticatedWebUser(legacyUserId, legacyAccountId);

    await expect(runtime.switchCompanyCredential(issued.credential, companyB)).rejects.toMatchObject({
      code: "WEB_IDENTITY_BINDING_REQUIRED",
    });
    expect(await runtime.resolveCredential(issued.credential)).not.toBeNull();
    expect((await seedStorage!.query<{ session_id: string }>("SELECT session_id FROM titan_security_sessions")).rows)
      .toEqual([{ session_id: issued.context.session_id }]);
  });

  it.each([
    ["membership", () => seedRegistry!.putMembership({ actor_id: actorId, company_id: companyId, role: "owner", status: "revoked" }, 1)],
    ["actor", () => seedRegistry!.putActor({ actor_id: actorId, status: "suspended" }, 1)],
    ["company", () => seedRegistry!.putCompany({ company_id: companyId, status: "suspended" }, 1)],
    ["device", () => seedRegistry!.putDevice({ device_id: deviceId, actor_id: actorId, status: "revoked" }, 1)],
    ["external binding", () => seedRegistry!.putExternalBinding({
      binding_id: "web-login-binding-17", provider: LOGIN_ISSUER, subject: legacyUserId,
      actor_id: actorId, company_id: companyId, status: "revoked",
    }, 1)],
  ] as const)("rejects unapproved login mapping and current %s state", async (_label, change) => {
    const { environment: env } = await setup();
    runtime = await createConfiguredWebSessionRuntime(env);
    await expect(runtime.issueForAuthenticatedWebUser("caller-chosen-user", legacyAccountId)).rejects.toMatchObject({
      code: "WEB_IDENTITY_BINDING_REQUIRED",
    });
    expect((await seedStorage.query("SELECT session_id FROM titan_security_sessions")).rows).toEqual([]);
    const issued = await runtime.issueForAuthenticatedWebUser(legacyUserId, legacyAccountId);
    await change();
    expect(await runtime.resolveCredential(issued.credential), _label).toBeNull();
  });

  it("does not migrate a missing registry schema on startup", async () => {
    directory = await mkdtemp(join(tmpdir(), "titan-web-empty-registry-"));
    const registryPath = join(directory, "empty.sqlite");
    const empty = createSqliteStorage(registryPath);
    await empty.close();
    await expect(createConfiguredWebSessionRuntime(environment(registryPath))).rejects.toMatchObject({
      code: "WEB_AUTH_SETUP_REQUIRED",
      missing_or_invalid: [expect.stringContaining("TITAN_WEB_IDENTITY_REGISTRY_PATH")],
    });
    const reopened = openExistingSqliteStorage(registryPath);
    try {
      expect((await reopened.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")).rows).toEqual([]);
    } finally {
      await reopened.close();
    }
  });
});
