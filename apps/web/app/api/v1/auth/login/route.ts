import { NextRequest, NextResponse } from "next/server";
import { compare } from "bcryptjs";
import { z } from "zod";
import { getDatabaseDialect } from "@/lib/db/dialect";
import { portableQuery } from "@/lib/db/portable";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { getWebSessionRuntime } from "@/lib/auth/web-session-runtime";
import {
  CleaningProfileStoreSetupRequiredError,
  CleaningProfileStoreUnavailableError,
  initializeCleaningProfileForLogin,
} from "@/lib/company-storage/cleaning-profile-login";
import { randomUUID } from "crypto";
import {
  checkRateLimit,
  getClientIp,
  LOGIN_RATE_LIMIT,
} from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import {
  isWebAuthSetupRequiredError,
  WebIdentityBindingRequiredError,
} from "@/lib/auth/web-session-runtime";

export const dynamic = "force-dynamic";

const loginSchema = z.object({
  email: z.string().email(),
  // Enforce a minimum length here (display-only — real enforcement is bcrypt)
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type UserRow = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  account_id: string;
  password_hash: string;
  [key: string]: unknown;
};

export async function POST(request: NextRequest) {
  const traceId = randomUUID();
  let issuedForCleanup: Awaited<ReturnType<typeof createSession>> | undefined;

  // Rate-limit by IP: 5 attempts per 15 minutes. Browser e2e performs many
  // real logins from localhost; unit tests cover exact limiter behavior.
  if (process.env.E2E_DISABLE_LOGIN_RATE_LIMIT !== "1") {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`login:${ip}`, LOGIN_RATE_LIMIT);
    if (!rl.allowed) {
      return NextResponse.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many login attempts. Please try again later.",
            traceId,
          },
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(rl.resetAt - Math.floor(Date.now() / 1000)),
            "X-RateLimit-Limit": String(LOGIN_RATE_LIMIT.limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(rl.resetAt),
          },
        }
      );
    }
  }

  try {
    const body = await request.json();
    const parseResult = loginSchema.safeParse(body);
    
    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request body",
            details: { issues: parseResult.error.issues },
            traceId,
          },
        },
        { status: 400 }
      );
    }

    const { email, password } = parseResult.data;

    // PostgreSQL runs the web role with RLS. Its only pre-session user lookup
    // is the bounded SECURITY DEFINER migration-178 function; SQLite/MySQL
    // retain the local compatibility query. Never read users directly before
    // establishing tenant context on the restricted PostgreSQL pool.
    const normalizedEmail = email.toLowerCase().trim();
    const matches = getDatabaseDialect() === "postgres"
      ? await portableQuery<UserRow>(
        `SELECT id, email, full_name, role, account_id, password_hash
         FROM app_login_candidates($1)`,
        [normalizedEmail],
      )
      : await portableQuery<UserRow>(
        `SELECT id, email, full_name, role, ${getDatabaseDialect() === "sqlite" ? "company_id AS account_id" : "account_id"}, password_hash
         FROM users
         WHERE lower(email) = lower($1)
         ORDER BY created_at ASC, id ASC
         LIMIT 2`,
        [normalizedEmail],
      );
    const user = matches[0];

    if (!user) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email or password",
            traceId,
          },
        },
        { status: 401 }
      );
    }

    if (matches.length > 1) {
      return NextResponse.json(
        {
          error: {
            code: "AMBIGUOUS_LOGIN",
            message: "This email is connected to more than one account. Ask an owner to make the login email unique.",
            traceId,
          },
        },
        { status: 409 }
      );
    }

    // Verify password
    const passwordValid = await compare(password, user.password_hash);
    if (!passwordValid) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email or password",
            traceId,
          },
        },
        { status: 401 }
      );
    }

    // The existing password check authenticates the web subject. The canonical
    // runtime still requires its explicit subject/account binding and current
    // registry actor/company/device/membership before it issues a session.
    const issued = await createSession({
      userId: user.id,
      accountId: user.account_id,
    });
    issuedForCleanup = issued;

    const profile = await initializeCleaningProfileForLogin({
      issued,
    });
    if (profile.status === "unavailable") {
      throw new CleaningProfileStoreSetupRequiredError(["canonical Cleaning workforce bundle is unavailable"]);
    }

    await setSessionCookie(issued);

    return NextResponse.json({
      user: {
        id: issued.session.userId,
        email: user.email,
        full_name: user.full_name,
        role: issued.session.role,
        account_id: issued.session.accountId,
      },
    });
  } catch (error) {
    if (issuedForCleanup) {
      try {
        await (await getWebSessionRuntime()).revokeCredential(issuedForCleanup.credential);
      } catch (revokeError) {
        logger.error("Login session cleanup failed", revokeError, { traceId });
      }
    }
    if (error instanceof CleaningProfileStoreSetupRequiredError) {
      return NextResponse.json({ error: {
        code: "CLEANING_PROFILE_SETUP_REQUIRED",
        message: "The company profile store needs operator configuration.",
        missing_configuration: error.missing_or_invalid,
        traceId,
      } }, { status: 503 });
    }
    if (error instanceof CleaningProfileStoreUnavailableError) {
      return NextResponse.json({ error: {
        code: "COMPANY_PROFILE_STORE_UNAVAILABLE",
        message: "The company profile store is temporarily unavailable.",
        traceId,
      } }, { status: 503 });
    }
    if (isWebAuthSetupRequiredError(error)) {
      return NextResponse.json({ error: {
        code: "WEB_AUTH_SETUP_REQUIRED",
        message: "Web authentication needs operator configuration.",
        missing_configuration: error.missing_or_invalid,
        traceId,
      } }, { status: 503 });
    }
    if (error instanceof WebIdentityBindingRequiredError) {
      return NextResponse.json({ error: {
        code: "WEB_IDENTITY_SETUP_REQUIRED",
        message: "This account is not linked to an active Titan identity.",
        traceId,
      } }, { status: 403 });
    }
    if (error instanceof Error && error.message === "identity-registry-unavailable") {
      return NextResponse.json({ error: {
        code: "IDENTITY_REGISTRY_UNAVAILABLE",
        message: "Identity services are temporarily unavailable.",
        traceId,
      } }, { status: 503 });
    }
    if (error instanceof Error && error.message === "authentication-denied") {
      return NextResponse.json({ error: {
        code: "IDENTITY_NOT_ACTIVE",
        message: "This account is not linked to an active Titan identity.",
        traceId,
      } }, { status: 403 });
    }
    if (error instanceof Error && error.message.includes("web-session-") && error.message.includes("mapping-unavailable")) {
      return NextResponse.json({ error: {
        code: "WEB_AUTH_SETUP_REQUIRED",
        message: "Web identity compatibility bindings need operator review.",
        traceId,
      } }, { status: 503 });
    }
    logger.error("Login error", error, { traceId });
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
          traceId,
        },
      },
      { status: 500 }
    );
  }
}
