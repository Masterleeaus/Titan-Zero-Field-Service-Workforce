import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { PageContainer, PageHeader, HubSubnav, SurfaceState } from "@/components/ui";
import { WORK_HUB_LINKS } from "@/lib/navigation/hubs";
import { loadDispatchBoard } from "@/lib/dispatch/capacity";
import { DispatchBoard } from "./DispatchBoard";
import { withTenantTransaction } from "@/lib/db/portable";

export const dynamic = "force-dynamic";

function mondayStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  d.setHours(0, 0, 0, 0);
  return d;
}

export default async function DispatchPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "admin"].includes(session.role)) redirect("/app/schedule");

  const rangeStart = mondayStart();
  const rangeEnd = new Date(rangeStart);
  rangeEnd.setDate(rangeEnd.getDate() + 7);
  const board = await withTenantTransaction(session, (client, accountId) =>
    loadDispatchBoard(client, accountId, rangeStart, rangeEnd),
  );

  return (
    <PageContainer>
      <PageHeader title="Dispatch" subtitle={`${board.visits.length} active visit${board.visits.length === 1 ? "" : "s"} this week · workload, skills, availability, travel and transfer slack`} />
      <HubSubnav hub="Work" links={WORK_HUB_LINKS} pathname="/app/dispatch" />
      {board.visits.length === 0 ? (
        <SurfaceState
          kind="empty"
          title="Nothing to dispatch this week"
          description="Active visits will appear here when they need allocation or capacity review."
          testId="dispatch-empty-state"
        />
      ) : (
        <DispatchBoard technicians={board.technicians} visits={board.visits} vehicles={board.fieldVehicles} />
      )}
    </PageContainer>
  );
}
