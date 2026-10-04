import Link from "next/link";
import type { Route } from "next";
import { Card, PageContainer, PageHeader, SectionHeader } from "@/components/ui";

/** Cleaning-first company home; service activation and pricing remain separate configuration. */
export function CleaningHome() {
  return (
    <PageContainer>
      <div data-testid="cleaning-home">
        <PageHeader
          title="Cleaning workspace"
          subtitle="Cleaning is your company’s selected work profile."
        />

        <Card>
          <SectionHeader title="Prepare cleaning work" />
          <p>
            Use the existing company jobs and visits to coordinate work. The selected profile does not
            activate catalogue services or create service prices, recurrence, bookings, or authority.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)" }}>
            <Link href={"/app/jobs" as Route}>Open jobs</Link>
            <Link href={"/app/visits" as Route}>Open visits</Link>
            <Link href={"/app/schedule" as Route}>Open schedule</Link>
          </div>
        </Card>

        <Card>
          <SectionHeader title="Service configuration" />
          <p data-testid="cleaning-service-config-boundary">
            Service availability, scope, recurrence, and company-provided prices are configured separately.
            Checklist access also depends on the company’s native store schema.
          </p>
        </Card>
      </div>
    </PageContainer>
  );
}
