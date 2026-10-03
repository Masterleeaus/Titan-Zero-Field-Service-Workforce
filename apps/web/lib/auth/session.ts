import { cookies } from "next/headers";
import { roleSchema, type Role } from "@titan-zero/domain";
import { CURRENT_WEB_SESSION_COOKIE_NAME, type CurrentWebSession } from "./current-session";
import { getWebSessionRuntime } from "./web-session-runtime";

export interface SessionPayload {
  userId: string;
  accountId: string;
  role: Role;
}

type WebSessionRuntime = Awaited<ReturnType<typeof getWebSessionRuntime>>;
export type IssuedWebSession = Awaited<ReturnType<WebSessionRuntime["issueForAuthenticatedWebUser"]>>;

const LEGACY_COOKIE_NAME = "fsm_session";

/** Called only after the existing password login has authenticated a legacy
 * web user. Canonical configuration and registry membership must independently
 * resolve; the caller's role is deliberately ignored. */
export async function createSession(payload: Pick<SessionPayload, "userId" | "accountId">): Promise<IssuedWebSession> {
  return (await getWebSessionRuntime()).issueForAuthenticatedWebUser(payload.userId, payload.accountId);
}

/** Canonical token verification for server callers. Legacy fsm_session JWTs are
 * never accepted or exchanged implicitly. */
export async function verifySession(token: string): Promise<SessionPayload | null> {
  const current = await (await getWebSessionRuntime()).resolveCredential(token);
  if (!current) return null;
  const role = roleSchema.safeParse(current.session.role);
  if (!role.success) return null;
  return { ...current.session, role: role.data };
}

export async function getCurrentWebSession(): Promise<CurrentWebSession | null> {
  const cookieStore = await cookies();
  const credential = cookieStore.get(CURRENT_WEB_SESSION_COOKIE_NAME)?.value;
  if (!credential) return null;
  return (await getWebSessionRuntime()).resolveCredential(credential);
}

export async function getSession(): Promise<SessionPayload | null> {
  return (await getCurrentWebSession())?.session ?? null;
}

export async function setSessionCookie(issued: IssuedWebSession): Promise<void> {
  const expiresAt = Date.parse(issued.credential_expires_at);
  const maxAge = Math.floor((expiresAt - Date.now()) / 1000);
  if (!Number.isFinite(expiresAt) || maxAge < 1) throw new Error("web-session-credential-expired");
  const cookieStore = await cookies();
  cookieStore.set(CURRENT_WEB_SESSION_COOKIE_NAME, issued.credential, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
    maxAge,
  });
}

/** Revoke the canonical session before clearing its cookie. A registry outage
 * leaves the cookie in place and reports unavailable; logout never pretends a
 * durable revocation occurred when the identity owner could not confirm it. */
export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  const credential = cookieStore.get(CURRENT_WEB_SESSION_COOKIE_NAME)?.value;
  if (credential) {
    const runtime = await getWebSessionRuntime();
    const current = await runtime.resolveCredential(credential);
    if (current) {
      try {
        await runtime.revokeCredential(credential);
      } catch (error) {
        // A concurrent switch/revoke can make this exact generation stale
        // after resolveCredential returned. It is already unusable, so logout
        // may remove the cookie; registry outages still propagate and retain it.
        if (!(error instanceof Error) || error.message !== "authentication-denied") throw error;
      }
    }
  }
  // Preserve the __Host- cookie prefix requirements on the expiry response.
  // Next's delete(name) helper does not preserve Secure in Set-Cookie output.
  cookieStore.set(CURRENT_WEB_SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
  });
  // Clear the historic cookie for cleanup only; it is never verified or used
  // as a fallback credential.
  cookieStore.delete(LEGACY_COOKIE_NAME);
}
