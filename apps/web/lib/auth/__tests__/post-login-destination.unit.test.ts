import { describe, expect, it } from "vitest";
import {
  expiredSessionLoginRedirectForPath,
  loginRedirectForPath,
  readWorkspaceModeCookie,
  resolvePostLoginHref,
} from "../post-login-destination";

describe("resolvePostLoginHref", () => {
  it("sends tech to My Work", () => {
    expect(resolvePostLoginHref("tech", { isPhone: false })).toBe("/app/my-work");
    expect(resolvePostLoginHref("tech", { isPhone: true })).toBe("/app/my-work");
  });

  it("sends admin to Overview", () => {
    expect(resolvePostLoginHref("admin", { isPhone: true })).toBe("/app");
  });

  it("sends desktop owner (auto) to Overview", () => {
    expect(resolvePostLoginHref("owner", { isPhone: false })).toBe("/app");
  });

  it("sends phone owner (auto) to My Work", () => {
    expect(resolvePostLoginHref("owner", { isPhone: true })).toBe("/app/my-work");
  });

  it("honors dv_ws_mode=field cookie for owner on desktop", () => {
    expect(
      resolvePostLoginHref("owner", {
        isPhone: false,
        cookieHeader: "other=1; dv_ws_mode=field",
      }),
    ).toBe("/app/my-work");
  });

  it("honors dv_ws_mode=office cookie for owner on phone", () => {
    expect(
      resolvePostLoginHref("owner", {
        isPhone: true,
        cookieHeader: "dv_ws_mode=office",
      }),
    ).toBe("/app");
  });
});

describe("readWorkspaceModeCookie", () => {
  it("returns null for missing or invalid values", () => {
    expect(readWorkspaceModeCookie(null)).toBeNull();
    expect(readWorkspaceModeCookie("foo=bar")).toBeNull();
    expect(readWorkspaceModeCookie("dv_ws_mode=auto")).toBeNull();
  });
});

describe("Business Ops post-login deep links", () => {
  it.each(["//evil.example/app", "/app/../login", "/app/%2f%2fevil.example", "/app\\evil", "javascript:alert(1)", "https://evil.example/app/invoices"]) (
    "rejects unsafe navigation target %s", (next) => {
      expect(resolvePostLoginHref("owner", { next })).toBe("/app");
    },
  );

  it("ignores malformed workspace cookies without crashing login", () => {
    expect(readWorkspaceModeCookie("dv_ws_mode=%E0%A4%A")).toBeNull();
  });

  it("preserves safe standalone app destinations", () => {
    expect(
      resolvePostLoginHref("owner", {
        isPhone: false,
        next: "/app/invoices/inv-123?tab=payments",
      }),
    ).toBe("/app/invoices/inv-123?tab=payments");
  });

  it("canonicalises retained standalone aliases after login", () => {
    expect(
      resolvePostLoginHref("owner", {
        isPhone: false,
        next: "/app/my-day?from=shortcut",
      }),
    ).toBe("/app/my-work?from=shortcut");
  });

  it("rejects dead /app paths instead of landing on a standalone 404", () => {
    expect(
      resolvePostLoginHref("owner", {
        isPhone: false,
        next: "/app/this-route-does-not-exist",
      }),
    ).toBe("/app");
  });

  it("rejects external and non-Business-Ops destinations", () => {
    expect(
      resolvePostLoginHref("owner", {
        isPhone: false,
        next: "https://evil.example/app",
      }),
    ).toBe("/app");
    expect(
      resolvePostLoginHref("owner", {
        isPhone: false,
        next: "/portal/client",
      }),
    ).toBe("/app");
  });
});

describe("bounded session reauthentication navigation", () => {
  it("preserves only an allowlisted path after the verified session expires", () => {
    const href = expiredSessionLoginRedirectForPath("/app/jobs/job-123");
    const parsed = new URL(href, "https://titan-zero.invalid");
    expect(parsed.pathname).toBe("/login");
    expect(parsed.searchParams.get("reason")).toBe("session-expired");
    expect(parsed.searchParams.get("next")).toBe("/app/jobs/job-123");
  });

  it("does not carry unapproved paths or query strings into login redirects", () => {
    expect(expiredSessionLoginRedirectForPath("/app/no-such-route?secret=1")).toBe(
      "/login?reason=session-expired",
    );
  });

  it("labels an unauthenticated protected-route redirect without claiming expiry", () => {
    const href = loginRedirectForPath("/app/capture");
    const parsed = new URL(href, "https://titan-zero.invalid");
    expect(parsed.searchParams.get("reason")).toBe("signin-required");
    expect(parsed.searchParams.get("next")).toBe("/app/capture");
  });
});
