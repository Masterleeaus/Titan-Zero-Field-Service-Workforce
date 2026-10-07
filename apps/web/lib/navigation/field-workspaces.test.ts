import { describe, expect, it } from "vitest";
import { getFieldWorkspace, getFieldWorkspaceTabs } from "./field-workspaces";

describe("Field workspace routing", () => {
  it("keeps Activity as the return destination for messages and requests", () => {
    expect(getFieldWorkspace("/app/activity", "owner")).toBe("activity");
    expect(getFieldWorkspace("/app/requests", "admin")).toBe("activity");
  });

  it("groups existing operational routes into the four Field workspaces", () => {
    expect(getFieldWorkspace("/app/timeline", "owner")).toBe("locations");
    expect(getFieldWorkspace("/app/mileage/vehicles", "owner")).toBe("locations");
    expect(getFieldWorkspace("/app/dispatch", "admin")).toBe("work");
    expect(getFieldWorkspace("/app/settings/system-health", "admin")).toBe("operations");
  });

  it("does not replace the technician's focused mobile workspace", () => {
    expect(getFieldWorkspace("/app/activity", "tech")).toBeNull();
  });

  it("retains links to the existing Work and Operations pages", () => {
    expect(getFieldWorkspaceTabs("work").map((tab) => tab.href)).toEqual([
      "/app/jobs",
      "/app/dispatch",
      "/app/schedule",
      "/app/work-orders",
      "/app/visits",
      "/app/my-work",
    ]);
    expect(getFieldWorkspaceTabs("operations").map((tab) => tab.href)).toEqual([
      "/app/reports",
      "/app/settings/system-health",
      "/app/day-review",
    ]);
  });
});
