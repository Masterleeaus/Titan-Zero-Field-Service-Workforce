"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { expiredSessionLoginRedirectForPath } from "@/lib/auth/post-login-destination";

const MAX_WEB_SESSION_MS = 5 * 60 * 1000;
const EXPIRY_WARNING_MS = 30 * 1000;

/**
 * This is a user-experience timer over an already verified server session.
 * Every server request still verifies the signed credential and current
 * registry state; this component neither reads a token nor grants authority.
 */
export function WebSessionExpiryBoundary({
  expiresAt,
  remainingMs,
  children,
}: {
  expiresAt: string;
  remainingMs: number;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const [warning, setWarning] = useState(false);
  pathnameRef.current = pathname;

  useEffect(() => {
    setWarning(false);
    const boundedRemaining = Number.isFinite(remainingMs)
      ? Math.max(0, Math.min(remainingMs, MAX_WEB_SESSION_MS))
      : 0;
    const warningDelay = Math.max(0, boundedRemaining - EXPIRY_WARNING_MS);
    const warningTimer = window.setTimeout(() => setWarning(true), warningDelay);
    const expiryTimer = window.setTimeout(() => {
      window.location.replace(expiredSessionLoginRedirectForPath(pathnameRef.current));
    }, boundedRemaining);

    return () => {
      window.clearTimeout(warningTimer);
      window.clearTimeout(expiryTimer);
    };
  }, [expiresAt, remainingMs]);

  return (
    <>
      {warning && (
        <p className="web-session-expiry-warning" role="status">
          Your secure sign-in ends in less than 30 seconds. Save unfinished work. You’ll return to sign in when it ends.
        </p>
      )}
      {children}
    </>
  );
}
