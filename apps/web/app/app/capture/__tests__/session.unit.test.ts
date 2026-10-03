import { describe, expect, it } from "vitest";
import {
  allowlistedPostLoginNext,
  loginRedirectForPath,
  pathnameFromHeaders,
  resolvePostLoginHref,
} from "@/lib/auth/post-login-destination";

describe("capture post-login allowlist", () => {
  it("honors capture and reachable app destinations while rejecting external URLs", () => {
    expect(allowlistedPostLoginNext("/app/capture")).toBe("/app/capture");
    expect(allowlistedPostLoginNext("/app/capture/")).toBeNull();
    expect(allowlistedPostLoginNext("/app")).toBe("/app");
    expect(allowlistedPostLoginNext("https://evil.example/app/capture")).toBeNull();
    expect(allowlistedPostLoginNext("//evil.example")).toBeNull();
  });

  it("lands on /app/capture after login when next is allowlisted", () => {
    expect(
      resolvePostLoginHref("owner", { isPhone: true, next: "/app/capture" }),
    ).toBe("/app/capture");
    expect(
      resolvePostLoginHref("admin", { next: "/app/jobs" }),
    ).toBe("/app/jobs");
  });

  it("sends unauthenticated /app/capture to login with next", () => {
    expect(loginRedirectForPath("/app/capture")).toBe("/login?reason=signin-required&next=%2Fapp%2Fcapture");
    expect(loginRedirectForPath("/app")).toBe("/login?reason=signin-required&next=%2Fapp");
  });

  it("reads /app/capture from request headers", () => {
    const headers = new Headers({
      "x-matched-path": "/app/capture",
    });
    expect(pathnameFromHeaders(headers)).toBe("/app/capture");
    expect(
      pathnameFromHeaders(new Headers({ "next-url": "http://localhost:3000/app/capture" })),
    ).toBe("/app/capture");
  });
});
