export type FieldWorkspace = "activity" | "locations" | "work" | "operations";

export type FieldWorkspaceTab = { label: string; href: string };

export type FieldMetricTone = "positive" | "attention" | "warning" | "critical" | "neutral";

export type FieldMetric = {
  value: string;
  label: string;
  href: string;
  tone: FieldMetricTone;
};

const WORKSPACE_ROUTES: Record<FieldWorkspace, readonly string[]> = {
  activity: ["/app/activity", "/app/requests"],
  locations: ["/app/timeline", "/app/mileage"],
  work: [
    "/app/my-work",
    "/app/jobs",
    "/app/work-orders",
    "/app/schedule",
    "/app/visits",
    "/app/dispatch",
  ],
  operations: ["/app/reports", "/app/day-review", "/app/settings/system-health"],
};

const WORKSPACE_TABS: Record<FieldWorkspace, readonly FieldWorkspaceTab[]> = {
  activity: [
    { label: "Messages", href: "/app/activity?tab=messages" },
    { label: "Notifications", href: "/app/activity?tab=notifications" },
  ],
  locations: [
    { label: "Map & timeline", href: "/app/timeline" },
    { label: "Mileage", href: "/app/mileage" },
    { label: "Vehicles", href: "/app/mileage/vehicles" },
  ],
  work: [
    { label: "Jobs", href: "/app/jobs" },
    { label: "Dispatch", href: "/app/dispatch" },
    { label: "Schedule", href: "/app/schedule" },
    { label: "Work orders", href: "/app/work-orders" },
    { label: "Visits", href: "/app/visits" },
    { label: "My day", href: "/app/my-work" },
  ],
  operations: [
    { label: "Analytics", href: "/app/reports" },
    { label: "System health", href: "/app/settings/system-health" },
    { label: "Day review", href: "/app/day-review" },
  ],
};

function matchesRoute(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/** Resolve the Field workspace from the current route without granting access. */
export function getFieldWorkspace(pathname: string, role: string): FieldWorkspace | null {
  // Technicians keep the existing focused Go/My Day projection.
  if (role === "tech") return null;

  for (const [workspace, routes] of Object.entries(WORKSPACE_ROUTES) as [FieldWorkspace, readonly string[]][]) {
    if (routes.some((route) => matchesRoute(pathname, route))) return workspace;
  }
  return null;
}

export function getFieldWorkspaceRoutes(workspace: FieldWorkspace): readonly string[] {
  return WORKSPACE_ROUTES[workspace];
}

export function getFieldWorkspaceTabs(workspace: FieldWorkspace): readonly FieldWorkspaceTab[] {
  return WORKSPACE_TABS[workspace];
}
