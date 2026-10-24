import type { Route } from "next";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getWebSessionRuntime } from "@/lib/auth/web-session-runtime";
import {
  companyNativeVisitChecklistManifest,
  companyNativeWorkOrdersManifest,
  companyNativeWorkOrdersVisitsManifest,
} from "../../../../packages/storage/src/company-native-schema-manifest";
import { withVerifiedWebNativeCompanyStore } from "@/lib/company-storage/request-runtime";
import { readCurrentCompanyVerticalProfile } from "@/lib/company-storage/cleaning-profile-entry";
import { portableQuery } from "@/lib/db/portable";
import { LinkButton, PageContainer, PageHeader, WhatNext } from "@/components/ui";
import { OwnerDashboard } from "./OwnerDashboard";
import type { CommandVisit, CountAction, MaterialJob } from "./DashboardWidgets";
import { loadFieldDayData } from "@/lib/my-work/field-day-data";
import { businessToday } from "@/lib/operations/business-day";
import {
  OPEN_OWNER_PROMISES_SQL,
  OWNER_PROMISE_ACTION_TYPE,
  customerPromiseBucket,
  toPromiseToneInput,
  type OpenOwnerPromiseRow,
} from "@/lib/captures/promise-queue";
import { AttentionCard } from "./AttentionCard";
import { bindNativeSurface } from "@/lib/navigation/native-service-bindings";
import { CleaningHome } from "./CleaningHome";

export const dynamic = "force-dynamic";

type CountRow = { count: string | number };

function parseN(row: CountRow | undefined | null): number {
  return Number(row?.count ?? 0);
}

export default async function AppPage() {
  const request = { headers: await headers() };
  const sessionRuntime = await getWebSessionRuntime();
  const currentSession = await sessionRuntime.resolveRequest(request);
  if (!currentSession) redirect("/login");
  const session = currentSession.session;
  if (session.role === "tech") redirect("/app/my-work");

  bindNativeSurface("business", session.accountId);

  const profile = await withVerifiedWebNativeCompanyStore({
    currentSession,
    revalidateSession: () => sessionRuntime.resolveRequest(request),
    requiredSchemaVersions: [
      companyNativeWorkOrdersManifest.schema_version,
      companyNativeWorkOrdersVisitsManifest.schema_version,
      companyNativeVisitChecklistManifest.schema_version,
    ],
    operation: (storage, verifiedSession) => readCurrentCompanyVerticalProfile({
      scope: verifiedSession.scope,
      storage,
    }),
  });
  if (profile.profile?.module_id === "titan.workforce.cleaning") return <CleaningHome />;

  const accountId = session.accountId;
  const businessDate = businessToday();
  const baseDate = new Date(`${businessDate}T00:00:00Z`);
  const tomorrowDate = new Date(baseDate.getTime() + 86_400_000).toISOString().slice(0, 10);
  const monthStart = `${businessDate.slice(0, 7)}-01`;
  const todayLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const [
    todayJobs,
    tomorrowJobs,
    draftInvoiceCountRows,
    scheduleApprovedCountRows,
    estimateFollowUpCountRows,
    depositCountRows,
    materialCountRows,
    materialJobs,
    outstandingInvoicesCentsRows,
    pendingDepositsCentsRows,
    paidThisMonthCentsRows,
    pendingSegmentRows,
    expenseRows,
    fieldDay,
    openPromiseRows,
  ] = await Promise.all([
    portableQuery<CommandVisit>(
      `SELECT id, title, status, client_name, property_address, visit_id, scheduled_start, visit_status, sub_status
       FROM (
         SELECT j.id, j.title, j.status,
                c.name AS client_name,
                p.address AS property_address,
                v.id AS visit_id,
                v.scheduled_start AS scheduled_start,
                v.status AS visit_status,
                v.sub_status,
                ROW_NUMBER() OVER (PARTITION BY j.id ORDER BY v.scheduled_start ASC) AS rn
         FROM jobs j
         LEFT JOIN clients c ON c.id = j.client_id AND c.account_id = j.account_id
         LEFT JOIN properties p ON p.id = j.property_id AND p.account_id = j.account_id
         JOIN visits v ON v.job_id = j.id AND v.account_id = j.account_id
         WHERE j.account_id = $1
           AND j.status IN ('draft','quoted','scheduled','in_progress')
           AND v.status IN ('scheduled','arrived','in_progress')
           AND DATE(v.scheduled_start) = $2
       ) ranked
       WHERE rn = 1
       ORDER BY scheduled_start ASC
       LIMIT 10`,
      [accountId, businessDate],
    ),

    portableQuery<CommandVisit>(
      `SELECT id, title, status, client_name, property_address, visit_id, scheduled_start, visit_status, sub_status
       FROM (
         SELECT j.id, j.title, j.status,
                c.name AS client_name,
                p.address AS property_address,
                v.id AS visit_id,
                v.scheduled_start AS scheduled_start,
                v.status AS visit_status,
                v.sub_status,
                ROW_NUMBER() OVER (PARTITION BY j.id ORDER BY v.scheduled_start ASC) AS rn
         FROM jobs j
         LEFT JOIN clients c ON c.id = j.client_id AND c.account_id = j.account_id
         LEFT JOIN properties p ON p.id = j.property_id AND p.account_id = j.account_id
         JOIN visits v ON v.job_id = j.id AND v.account_id = j.account_id
         WHERE j.account_id = $1
           AND v.status IN ('scheduled','arrived','in_progress')
           AND DATE(v.scheduled_start) = $2
       ) ranked
       WHERE rn = 1
       ORDER BY scheduled_start ASC
       LIMIT 3`,
      [accountId, tomorrowDate],
    ),

    portableQuery<CountRow>(
      `SELECT COUNT(*) AS count FROM invoices
       WHERE account_id = $1 AND status = 'draft' AND invoice_kind IN ('final', 'standard')`,
      [accountId],
    ),

    portableQuery<CountRow>(
      `SELECT COUNT(*) AS count FROM jobs
       WHERE account_id = $1
         AND status IN ('draft','quoted','scheduled','in_progress')
         AND NOT EXISTS (
           SELECT 1 FROM visits
           WHERE visits.job_id = jobs.id
             AND visits.account_id = jobs.account_id
             AND visits.status IN ('scheduled','arrived','in_progress')
             AND visits.scheduled_start >= $2
         )`,
      [accountId, businessDate],
    ),

    portableQuery<CountRow>(
      `SELECT COUNT(*) AS count FROM estimates
       WHERE account_id = $1
         AND status = 'sent'
         AND (expires_at IS NULL OR expires_at >= $2)`,
      [accountId, businessDate],
    ),

    portableQuery<CountRow>(
      `SELECT COUNT(*) AS count FROM invoices
       WHERE account_id = $1
         AND invoice_kind = 'deposit'
         AND status IN ('draft','sent','partial','overdue')`,
      [accountId],
    ),

    portableQuery<CountRow>(
      `SELECT COUNT(DISTINCT e.id) AS count
       FROM estimates e
       JOIN jobs j ON j.id = e.job_id AND j.account_id = e.account_id
       WHERE e.account_id = $1
         AND e.status = 'approved'
         AND j.status IN ('scheduled','in_progress')`,
      [accountId],
    ),

    portableQuery<MaterialJob>(
      `SELECT e.id, j.id AS job_id, j.title, c.name AS client_name
       FROM estimates e
       JOIN jobs j ON j.id = e.job_id AND j.account_id = e.account_id
       LEFT JOIN clients c ON c.id = j.client_id AND c.account_id = j.account_id
       WHERE e.account_id = $1
         AND e.status = 'approved'
         AND j.status IN ('scheduled','in_progress')
       ORDER BY e.updated_at DESC
       LIMIT 5`,
      [accountId],
    ),

    portableQuery<CountRow>(
      `SELECT COALESCE(SUM(total_cents - paid_cents), 0) AS count
       FROM invoices
       WHERE account_id = $1 AND status IN ('sent', 'partial', 'overdue')`,
      [accountId],
    ),

    portableQuery<CountRow>(
      `SELECT COALESCE(SUM(total_cents - paid_cents), 0) AS count
       FROM invoices
       WHERE account_id = $1 AND invoice_kind = 'deposit'
         AND status IN ('draft', 'sent', 'partial', 'overdue')`,
      [accountId],
    ),

    portableQuery<CountRow>(
      `SELECT COALESCE(SUM(amount_cents), 0) AS count
       FROM payments
       WHERE account_id = $1 AND status = 'paid' AND received_at >= $2`,
      [accountId, monthStart],
    ),

    portableQuery<CountRow>(
      `SELECT COUNT(*) AS count
       FROM location_segments
       WHERE account_id = $1
         AND segment_date = $2
         AND status = 'provisional'
         AND ended_at IS NOT NULL
         AND LOWER(COALESCE(zone, '')) NOT IN ('home', 'private')
         AND LOWER(COALESCE(place_label, '')) NOT IN ('home', 'private')`,
      [accountId, businessDate],
    ),

    portableQuery<{ today: string | number; month: string | number; missing: string | number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN expense_date = $2 THEN amount_cents ELSE 0 END), 0) AS today,
         COALESCE(SUM(CASE WHEN expense_date >= $3 THEN amount_cents ELSE 0 END), 0) AS month,
         SUM(CASE WHEN receipt_url IS NULL AND expense_date >= $3 THEN 1 ELSE 0 END) AS missing
       FROM expenses
       WHERE account_id = $1`,
      [accountId, businessDate, monthStart],
    ),

    loadFieldDayData(session, true),

    portableQuery<OpenOwnerPromiseRow>(
      OPEN_OWNER_PROMISES_SQL,
      [accountId, OWNER_PROMISE_ACTION_TYPE],
    ),
  ]);

  const exp = expenseRows[0];
  const todayExpensesCents = Number(exp?.today ?? 0);
  const monthExpensesCents = Number(exp?.month ?? 0);
  const receiptsMissing = Number(exp?.missing ?? 0);

  const nowHour = new Date().getHours();
  const greeting =
    nowHour < 12 ? "Good morning" : nowHour < 17 ? "Good afternoon" : "Good evening";

  const draftInvoices = parseN(draftInvoiceCountRows[0]);
  const deposits = parseN(depositCountRows[0]);
  const materialCount = parseN(materialCountRows[0]);
  const pendingSegments = parseN(pendingSegmentRows[0]);

  const outstandingInvoicesCents = parseN(outstandingInvoicesCentsRows[0]);
  const pendingDepositsCents = parseN(pendingDepositsCentsRows[0]);
  const paidThisMonthCents = parseN(paidThisMonthCentsRows[0]);

  const actionQueue = ([
    {
      label: "Review Draft Invoices",
      count: draftInvoices,
      href: "/app/invoices?status=draft" as Route,
      detail: "Draft invoices awaiting review",
      tone: "warning",
    },
    {
      label: "Schedule Approved Projects",
      count: parseN(scheduleApprovedCountRows[0]),
      href: "/app/jobs" as Route,
      detail: "Active work without a next visit",
      tone: "warning",
    },
    {
      label: "Follow Up Estimates",
      count: parseN(estimateFollowUpCountRows[0]),
      href: "/app/estimates?status=sent" as Route,
      detail: "Sent estimates awaiting response",
      tone: "warning",
    },
    {
      label: "Collect Deposits",
      count: deposits,
      href: "/app/invoices?kind=deposit" as Route,
      detail: "Deposit invoices not fully collected",
      tone: "danger",
    },
    {
      label: "Order Materials",
      count: materialCount,
      // Never dump into a bare estimates list — open the shopping list (1 job)
      // or scroll to the Materials panel (multiple jobs).
      href: (materialJobs.length === 1
        ? `/app/jobs/${materialJobs[0].job_id}/materials?tab=buy`
        : "/app#materials") as Route,
      detail:
        materialJobs.length === 1
          ? `Buy list: ${materialJobs[0].title}`
          : "Open buy lists for approved active projects",
      tone: "warning",
    },
    {
      label: "Label Captured Locations",
      count: pendingSegments,
      href: "/app/timeline" as Route,
      detail: "Auto-recorded stops & drives to log to your day",
      tone: "default",
    },
    customerPromiseBucket(toPromiseToneInput(openPromiseRows)),
  ] satisfies CountAction[])
    .filter((item) => item.count > 0)
    .sort((a, b) => ({ danger: 0, warning: 1, default: 2 })[a.tone] - ({ danger: 0, warning: 1, default: 2 })[b.tone]);

  const topAction = actionQueue[0] ?? null;

  return (
    <PageContainer>
      <PageHeader
        title={`${greeting} 👋`}
        subtitle="Here's your game plan for today."
        actions={
          <>
            <span style={{ color: "var(--fg-muted)", fontSize: "var(--text-sm)", alignSelf: "center", marginRight: "var(--space-2)" }}>{todayLabel}</span>
            <LinkButton href="/app/my-work" variant="secondary" size="sm">My Day</LinkButton>
            <LinkButton href="/app/intake/new" variant="primary" size="sm">+ New Request</LinkButton>
          </>
        }
      />
      <AttentionCard session={session} />
      {topAction ? (
        <WhatNext
          title={topAction.label}
          description={`${topAction.count} · ${topAction.detail}`}
          href={topAction.href}
          actionLabel="Handle now"
        />
      ) : null}
      <OwnerDashboard
        actionQueue={actionQueue}
        openPromiseRows={openPromiseRows}
        todayJobs={todayJobs}
        materialCount={materialCount}
        materialJobs={materialJobs}
        tomorrowJobs={tomorrowJobs}
        outstandingInvoicesCents={outstandingInvoicesCents}
        pendingDepositsCents={pendingDepositsCents}
        paidThisMonthCents={paidThisMonthCents}
        openSession={fieldDay.openSession}
        vehicles={fieldDay.vehicles}
        dayMileage={fieldDay.dayMileage}
        yesterdayMiles={fieldDay.yesterdayMiles}
        pendingSegments={pendingSegments}
        todayExpensesCents={todayExpensesCents}
        monthExpensesCents={monthExpensesCents}
        receiptsMissing={receiptsMissing}
      />
    </PageContainer>
  );
}
