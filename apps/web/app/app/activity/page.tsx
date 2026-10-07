import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { PageContainer } from "@/components/ui";
import { ActivityStream } from "./ActivityStream";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role === "tech") redirect("/app/my-work");

  return (
    <PageContainer>
      <ActivityStream />
    </PageContainer>
  );
}
