import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { query, queryOne } from "@/lib/db";
import { withDbSession } from "@/lib/db";
import { withTenantTransaction } from "@/lib/db/portable";
import { loadSquareSettings } from "@/lib/integrations/square-payments";
import { isEncryptionConfigured } from "@/lib/crypto";
import { PageContainer, PageHeader, SurfaceState } from "@/components/ui";
import { SettingsTabsClient } from "./SettingsTabsClient";
import type { TeamMember } from "./TeamPanel";
import type { SquareStatus } from "./SquarePanel";
import type { LocationDayValues } from "./LocationDaySettings";
import { bindNativeSurface } from "@/lib/navigation/native-service-bindings";
import { loadWorkforceLifecycleInspection } from "./workforce-lifecycle-data";
import { loadWorkforceHierarchyInspection } from "./workforce-hierarchy-data";
import { loadCompanyMemberDirectory } from "@/lib/workforce/member-directory";

export const dynamic = "force-dynamic";

interface AccountRow extends Record<string, unknown> {
  id: string;
  name: string;
  settings: {
    invoice_terms?: string;
    estimate_terms?: string;
    deposit_percent?: number;
    deposit_terms?: string;
    estimate_expiry_days?: number;
  };
  day_review_cutoff_time: string;
  min_stop_dwell_minutes: number;
  visit_confidence_threshold: number;
  suppress_weekend_start_prompt: boolean;
  close_day_followup_hours: number | null;
  tracking_start_time: string | null;
  tracking_end_time: string | null;
  location_retention_days: number;
}

interface UserRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: "owner" | "admin" | "tech";
  created_at: string;
}

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  // EPIC-006 Phase 5: techs reach Settings for their profile + sign out. The
  // admin-only sections below (Company, Team, Tools, System Health) stay gated
  // by `isAdmin`, so a tech sees only "Your profile".

  bindNativeSurface("settings", session.accountId);
  bindNativeSurface("workforce", session.accountId);
  bindNativeSurface("marketplace", session.accountId);

  const isAdmin = session.role === "owner" || session.role === "admin";

  const [account, users, me] = await Promise.all([
    isAdmin
      ? queryOne<AccountRow>(
          `SELECT id, name, settings,
                  day_review_cutoff_time::text, min_stop_dwell_minutes,
                  visit_confidence_threshold, suppress_weekend_start_prompt,
                  close_day_followup_hours, tracking_start_time::text, tracking_end_time::text,
                  location_retention_days
           FROM accounts WHERE id = $1`,
          [session.accountId]
        )
      : null,
    isAdmin
      ? withTenantTransaction(session, async (client, accountId) => {
          return (await loadCompanyMemberDirectory(client, accountId)).map(({ id, full_name, email, phone, role, created_at }) => ({
            id, full_name, email, phone, role, created_at,
          }));
        })
      : [],
    withTenantTransaction(session, async (client, accountId) => {
      const { rows } = await client.query<UserRow>(
        `SELECT u.id, u.full_name, u.email, u.phone, bm.role, u.created_at
           FROM business_memberships bm
           JOIN users u ON u.id = bm.user_id
          WHERE bm.account_id = $1 AND bm.user_id = $2 AND bm.status = 'active'`,
        [accountId, session.userId],
      );
      return rows[0] ?? null;
    }),
  ]);

  if (!me) redirect("/login");

  if (isAdmin && !account) {
    return (
      <PageContainer>
        <PageHeader title="Settings" subtitle="Business and account configuration" />
        <SurfaceState
          kind="empty"
          title="Company settings are not available yet"
          description="Your profile is intact. Company configuration will appear here when the account record is available."
          testId="settings-company-empty-state"
        />
      </PageContainer>
    );
  }

  const workforceLifecycle = isAdmin ? loadWorkforceLifecycleInspection(session.accountId) : [];
  const workforceHierarchy = isAdmin ? loadWorkforceHierarchyInspection(session.accountId) : null;

  const isOwner = session.role === "owner";
  const locationDay: LocationDayValues | undefined = isOwner && account
    ? {
        dayReviewCutoffTime: account.day_review_cutoff_time,
        minStopDwellMinutes: account.min_stop_dwell_minutes,
        visitConfidenceThreshold: account.visit_confidence_threshold,
        suppressWeekendStartPrompt: account.suppress_weekend_start_prompt,
        closeDayFollowupHours: account.close_day_followup_hours,
        trackingStartTime: account.tracking_start_time,
        trackingEndTime: account.tracking_end_time,
        locationRetentionDays: account.location_retention_days,
      }
    : undefined;

  // Square payment integration is owner-only (secrets). Load current status.
  let square: SquareStatus | null = null;
  if (isOwner) {
    const row = await withDbSession(session, (client) =>
      loadSquareSettings(client, session.accountId)
    );
    square = {
      configured: !!row,
      enabled: row?.enabled ?? false,
      environment: row?.environment ?? "sandbox",
      locationId: row?.config.locationId ?? null,
      applicationId: row?.config.applicationId ?? null,
      webhookUrl: row?.config.webhookUrl ?? null,
      hasAccessToken: !!row?.secrets.accessToken,
      hasWebhookSignatureKey: !!row?.secrets.webhookSignatureKey,
      status: row?.status ?? "disconnected",
      statusDetail: row?.statusDetail ?? null,
      lastCheckedAt: row?.lastCheckedAt ?? null,
      encryptionConfigured: isEncryptionConfigured(),
    };
  }

  return (
    <PageContainer>
      <PageHeader
        title="Settings"
        subtitle={
          isAdmin
            ? "Profile, company, team, and tools"
            : "Your profile and account"
        }
      />
      <SettingsTabsClient
        role={session.role}
        userId={session.userId}
        me={me}
        account={account}
        users={users as TeamMember[]}
        square={square}
        locationDay={locationDay}
        workforceLifecycle={workforceLifecycle}
        workforceHierarchy={workforceHierarchy}
      />
    </PageContainer>
  );
}
