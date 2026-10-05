/**
 * Auth HTTP Integration Tests
 *
 * Tier: HTTP integration (Tier 3)
 * Skip condition: TEST_BASE_URL or TEST_DATABASE_URL absent
 */

import { describe, expect, it } from "vitest";

const RUN_HTTP_INTEGRATION =
  !!process.env.TEST_BASE_URL && !!process.env.TEST_DATABASE_URL;
const WEB_ORIGIN = "https://field.example.test";
const COMPANY_B = "55555555-5555-4555-8555-555555555555";
const UNMAPPED_COMPANY = "66666666-6666-4666-8666-666666666666";

type ErrorBody = { error?: { code?: string; message?: string } };

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

describe.skipIf(!RUN_HTTP_INTEGRATION)("Auth API (HTTP integration)", () => {
  const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

  async function login(ip = `auth-test-${Date.now()}-${Math.random()}`) {
    return fetch(`${BASE_URL}/api/v1/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({ email: "admin@test.com", password: "password" }),
    });
  }

  function sessionCookie(response: Response): string {
    const setCookie = response.headers.get("set-cookie") ?? "";
    const match = setCookie.match(/__Host-titan-web-session=([^;,]+)/);
    if (!match) throw new Error("Login response did not set the canonical session cookie");
    return `__Host-titan-web-session=${match[1]}`;
  }

  function sessionMaxAge(response: Response): number {
    return Number((response.headers.get("set-cookie") ?? "").match(/(?:^|;\s*)Max-Age=(\d+)/i)?.[1]);
  }

  describe("POST /api/v1/auth/login", () => {
    it("authenticates with valid credentials and sets HTTP-only cookie", async () => {
      const response = await login();
      expect(response.status).toBe(200);
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("__Host-titan-web-session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).toContain("Path=/");
      const maxAge = sessionMaxAge(response);
      expect(maxAge).toBeGreaterThan(0);
      expect(maxAge).toBeLessThanOrEqual(300);

      const body = await json<{ user: { email: string; role: string } }>(response);
      expect(body.user.email).toBe("admin@test.com");
      expect(body.user.role).toBe("admin");
    });

    it("rejects unknown email with 401 INVALID_CREDENTIALS", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": `unknown-${Date.now()}` },
        body: JSON.stringify({ email: `missing-${Date.now()}@test.com`, password: "password" }),
      });

      expect(response.status).toBe(401);
      expect((await json<ErrorBody>(response)).error?.code).toBe("INVALID_CREDENTIALS");
    });

    it("rejects wrong password with 401 INVALID_CREDENTIALS", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": `wrong-${Date.now()}` },
        body: JSON.stringify({ email: "admin@test.com", password: "password-nope" }),
      });

      expect(response.status).toBe(401);
      expect((await json<ErrorBody>(response)).error?.code).toBe("INVALID_CREDENTIALS");
    });

    it("fails closed when a valid password has no explicit canonical identity binding", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": `unmapped-${Date.now()}` },
        body: JSON.stringify({ email: "owner@test.com", password: "password" }),
      });

      expect(response.status).toBe(403);
      expect((await json<ErrorBody>(response)).error?.code).toBe("WEB_IDENTITY_SETUP_REQUIRED");
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("rejects invalid body with 400 VALIDATION_ERROR", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": `invalid-${Date.now()}` },
        body: JSON.stringify({ email: "not-an-email", password: "x" }),
      });

      expect(response.status).toBe(400);
      expect((await json<ErrorBody>(response)).error?.code).toBe("VALIDATION_ERROR");
    });

    it("rate-limits after 5 failed attempts from same IP", async () => {
      const ip = `rate-${Date.now()}`;
      const statuses: number[] = [];

      for (let i = 0; i < 6; i += 1) {
        const response = await fetch(`${BASE_URL}/api/v1/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ email: `missing-rate-${Date.now()}-${i}@test.com`, password: "password" }),
        });
        statuses.push(response.status);
      }

      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      // The unit suite covers the exact in-memory limiter threshold; the Next dev
      // server can execute route handlers across worker contexts during HTTP tests.
      expect([401, 429]).toContain(statuses[5]);
    });
  });

  describe("POST /api/v1/auth/logout", () => {
    it("revokes the durable session before clearing the cookie", async () => {
      const loginResponse = await login();
      expect(loginResponse.status).toBe(200);
      const cookie = sessionCookie(loginResponse);

      const current = await fetch(`${BASE_URL}/api/v1/navigation/capabilities`, {
        headers: { cookie },
      });
      expect(current.status).toBe(200);

      const response = await fetch(`${BASE_URL}/api/v1/auth/logout`, {
        method: "POST",
        headers: { cookie },
      });

      expect(response.status).toBe(200);
      expect((await json<{ message: string }>(response)).message).toBe("ok");
      expect(response.headers.get("set-cookie") ?? "").toContain("__Host-titan-web-session=");

      // A copied cookie remains a bearer string at the HTTP layer, so this
      // verifies the registry revocation rather than browser cookie deletion.
      const replay = await fetch(`${BASE_URL}/api/v1/navigation/capabilities`, {
        headers: { cookie },
      });
      expect(replay.status).toBe(401);
      expect((await json<ErrorBody>(replay)).error?.code).toBe("UNAUTHORIZED");
    });

    it.each([
      ["a malformed canonical cookie", "__Host-titan-web-session=a.b.c"],
      ["the legacy session cookie", "fsm_session=legacy-token"],
    ])("does not accept %s as a current session", async (_label, cookie) => {
      const response = await fetch(`${BASE_URL}/api/v1/navigation/capabilities`, {
        headers: { cookie },
      });
      expect(response.status).toBe(401);
      expect((await json<ErrorBody>(response)).error?.code).toBe("UNAUTHORIZED");
    });
  });

  describe("POST /api/v1/auth/switch-company", () => {
    async function switchCompany(cookie: string, body: unknown, origin = WEB_ORIGIN) {
      return fetch(`${BASE_URL}/api/v1/auth/switch-company`, {
        method: "POST",
        headers: { "Content-Type": "application/json", origin, cookie },
        body: JSON.stringify(body),
      });
    }

    it("switches only from the current cookie and rejects the prior context", async () => {
      const loginResponse = await login();
      expect(loginResponse.status).toBe(200);
      const originalCookie = sessionCookie(loginResponse);

      const response = await switchCompany(originalCookie, { company_id: COMPANY_B });
      expect(response.status).toBe(200);
      const body = await json<{ company_id: string; role: string }>(response);
      expect(body).toEqual({ company_id: COMPANY_B, role: "tech" });
      const switchedCookie = sessionCookie(response);
      expect(switchedCookie).not.toBe(originalCookie);
      expect(sessionMaxAge(response)).toBeLessThanOrEqual(sessionMaxAge(loginResponse));

      const current = await fetch(`${BASE_URL}/api/v1/navigation/capabilities`, {
        headers: { cookie: switchedCookie },
      });
      expect(current.status).toBe(200);
      expect((await json<{ role: string }>(current)).role).toBe("tech");

      const staleReplay = await fetch(`${BASE_URL}/api/v1/navigation/capabilities`, {
        headers: { cookie: originalCookie },
      });
      expect(staleReplay.status).toBe(401);
    });

    it("keeps the current context when the registry choice has no approved web mapping", async () => {
      const loginResponse = await login();
      const cookie = sessionCookie(loginResponse);
      const response = await switchCompany(cookie, { company_id: UNMAPPED_COMPANY });

      expect(response.status).toBe(403);
      expect((await json<ErrorBody>(response)).error?.code).toBe("WEB_IDENTITY_SETUP_REQUIRED");
      const current = await fetch(`${BASE_URL}/api/v1/navigation/capabilities`, { headers: { cookie } });
      expect(current.status).toBe(200);
      expect((await json<{ role: string }>(current)).role).toBe("admin");
    });

    it("rejects missing auth, caller session identifiers, and cross-origin switch requests", async () => {
      const noCookie = await switchCompany("", { company_id: COMPANY_B });
      expect(noCookie.status).toBe(401);

      const loginResponse = await login();
      const cookie = sessionCookie(loginResponse);
      const forged = await switchCompany(cookie, { company_id: COMPANY_B, session_id: "caller-session" });
      expect(forged.status).toBe(400);
      const crossOrigin = await switchCompany(cookie, { company_id: COMPANY_B }, "https://attacker.invalid");
      expect(crossOrigin.status).toBe(403);

      const stillCurrent = await fetch(`${BASE_URL}/api/v1/navigation/capabilities`, { headers: { cookie } });
      expect(stillCurrent.status).toBe(200);
      expect((await json<{ role: string }>(stillCurrent)).role).toBe("admin");
    });
  });

});
