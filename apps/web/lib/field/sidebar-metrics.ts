import type { AuthSession } from "@/lib/auth/middleware";
import { loadAttentionSummary } from "@/lib/attention";
import { businessToday } from "@/lib/operations/business-day";
import { portableQuery } from "@/lib/db/portable";
import { withInvoiceContext } from "@/lib/invoices/db";
import { formatCents } from "@/lib/money";
import type { FieldMetric, FieldWorkspace } from "@/lib/navigation/field-workspaces";
import { loadFieldOperationsKpis } from "@/app/app/reports/queries";

type CountRow = { count: string | number };

function count(row: CountRow | undefined): number {
  return Number(row?.count ?? 0);
}

function fallbackMetrics(workspace: FieldWorkspace): FieldMetric[] {
  const labels: Record<FieldWorkspace, Array<Pick<FieldMetric, "label" | "href">>> = {
    activity: [
      { label: "unread notifications", href: "/app/activity?tab=notifications" },
      { label: "requests to review", href: "/app/requests?attention=1" },
      { label: "estimates awaiting reply", href: "/app/estimates?status=sent" },
      { label: "invoices to review", href: "/app/invoices?attention=1" },
    ],
    locations: [
      { label: "open field sessions", href: "/app/my-work" },
      { label: "visits today", href: "/app/visits" },
      { label: "stops to review", href: "/app/timeline" },
      { label: "activities to link", href: "/app/timeline" },
    ],
    work: [
      { label: "active jobs", href: "/app/jobs" },
      { label: "visits today", href: "/app/visits" },
      { label: "jobs without a visit", href: "/app/schedule" },
      { label: "estimates awaiting reply", href: "/app/estimates?status=sent" },
    ],
    operations: [
      { label: "outstanding invoices", href: "/app/invoices" },
      { label: "paid revenue this month", href: "/app/reports" },
      { label: "net this month", href: "/app/reports" },
      { label: "jobs opened this month", href: "/app/jobs" },
    ],
  };

  return labels[workspace].map((metric) => ({
    ...metric,
    value: "—",
    tone: "neutral",
  }));
}

function actionTone(value: number): FieldMetric["tone"] {
  return value > 0 ? "warning" : "positive";
}

/** Read-only, company-scoped sidebar summaries for the currently active workspace. */
export async function loadFieldSidebarMetrics(
  session: AuthSession,
  workspace: FieldWorkspace,
): Promise<FieldMetric[]> {
  const accountId = session.accountId;
  const today = businessToday();

  try {
    if (workspace === "activity") {
      const summary = await withInvoiceContext(session, (client) =>
        loadAttentionSummary(client, accountId),
      );
      return [
        { value: String(summary.unreadEventCount), label: "unread notifications", href: "/app/activity?tab=notifications", tone: actionTone(summary.unreadEventCount) },
        { value: String(summary.requestsCount), label: "requests to review", href: "/app/requests?attention=1", tone: actionTone(summary.requestsCount) },
        { value: String(summary.estimatesCount), label: "estimates awaiting reply", href: "/app/estimates?status=sent", tone: actionTone(summary.estimatesCount) },
        { value: String(summary.invoicesCount), label: "invoices to review", href: "/app/invoices?attention=1", tone: actionTone(summary.invoicesCount) },
      ];
    }

    if (workspace === "locations") {
      const [openSessions, visitsToday, stopsToReview, unlinkedActivities] = await Promise.all([
        portableQuery<CountRow>(
          `SELECT COUNT(DISTINCT user_id) AS count FROM activity_entries
           WHERE account_id = $1 AND session_date = $2 AND ended_at IS NULL AND voided_at IS NULL`,
          [accountId, today],
        ),
        portableQuery<CountRow>(
          `SELECT COUNT(*) AS count FROM visits
           WHERE account_id = $1 AND status IN ('scheduled','arrived','in_progress')
             AND DATE(scheduled_start) = $2`,
          [accountId, today],
        ),
        portableQuery<CountRow>(
          `SELECT COUNT(*) AS count FROM location_segments
           WHERE account_id = $1 AND segment_date = $2 AND status = 'provisional'
             AND ended_at IS NOT NULL
             AND LOWER(COALESCE(zone, '')) NOT IN ('home', 'private')
             AND LOWER(COALESCE(place_label, '')) NOT IN ('home', 'private')`,
          [accountId, today],
        ),
        portableQuery<CountRow>(
          `SELECT COUNT(*) AS count FROM activity_entries
           WHERE account_id = $1 AND session_date = $2 AND voided_at IS NULL
             AND entity_id IS NULL AND ended_at IS NOT NULL
             AND activity_type IN ('job_work','travel','material_run','estimate_visit','follow_up')`,
          [accountId, today],
        ),
      ]);
      return [
        { value: String(count(openSessions[0])), label: "open field sessions", href: "/app/my-work", tone: count(openSessions[0]) > 0 ? "positive" : "neutral" },
        { value: String(count(visitsToday[0])), label: "visits today", href: "/app/visits", tone: "neutral" },
        { value: String(count(stopsToReview[0])), label: "stops to review", href: "/app/timeline", tone: actionTone(count(stopsToReview[0])) },
        { value: String(count(unlinkedActivities[0])), label: "activities to link", href: "/app/timeline", tone: actionTone(count(unlinkedActivities[0])) },
      ];
    }

    if (workspace === "work") {
      const [activeJobs, visitsToday, unscheduledJobs, estimatesAwaitingReply] = await Promise.all([
        portableQuery<CountRow>(
          `SELECT COUNT(*) AS count FROM jobs WHERE account_id = $1 AND status IN ('scheduled','in_progress')`,
          [accountId],
        ),
        portableQuery<CountRow>(
          `SELECT COUNT(*) AS count FROM visits
           WHERE account_id = $1 AND status IN ('scheduled','arrived','in_progress')
             AND DATE(scheduled_start) = $2`,
          [accountId, today],
        ),
        portableQuery<CountRow>(
          `SELECT COUNT(*) AS count FROM jobs j
           WHERE j.account_id = $1 AND j.status IN ('draft','quoted','scheduled','in_progress')
             AND NOT EXISTS (
               SELECT 1 FROM visits v WHERE v.job_id = j.id AND v.account_id = j.account_id
                 AND v.status IN ('scheduled','arrived','in_progress') AND v.scheduled_start >= $2
             )`,
          [accountId, today],
        ),
        portableQuery<CountRow>(
          `SELECT COUNT(*) AS count FROM estimates
           WHERE account_id = $1 AND status = 'sent'
             AND (expires_at IS NULL OR expires_at >= $2)`,
          [accountId, today],
        ),
      ]);
      return [
        { value: String(count(activeJobs[0])), label: "active jobs", href: "/app/jobs", tone: "neutral" },
        { value: String(count(visitsToday[0])), label: "visits today", href: "/app/visits", tone: "neutral" },
        { value: String(count(unscheduledJobs[0])), label: "jobs without a visit", href: "/app/schedule", tone: actionTone(count(unscheduledJobs[0])) },
        { value: String(count(estimatesAwaitingReply[0])), label: "estimates awaiting reply", href: "/app/estimates?status=sent", tone: actionTone(count(estimatesAwaitingReply[0])) },
      ];
    }

    const reports = await loadFieldOperationsKpis(accountId, today.slice(0, 7));
    return [
      { value: formatCents(reports.outstandingReceivablesCents), label: "outstanding invoices", href: "/app/invoices", tone: reports.outstandingReceivablesCents > 0 ? "critical" : "positive" },
      { value: formatCents(reports.paidRevenueCents), label: "paid revenue this month", href: "/app/reports", tone: reports.paidRevenueCents > 0 ? "positive" : "neutral" },
      { value: formatCents(reports.netCents), label: "net this month", href: "/app/reports", tone: reports.netCents < 0 ? "critical" : reports.netCents > 0 ? "positive" : "neutral" },
      { value: String(reports.jobsOpened), label: "jobs opened this month", href: "/app/jobs", tone: "neutral" },
    ];
  } catch {
    return fallbackMetrics(workspace);
  }
}
