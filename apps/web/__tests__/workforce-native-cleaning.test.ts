import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rewriteSqliteParams } from "@/lib/db/sqlite-params";

const state = vi.hoisted(() => ({
  token: "",
  read: null as null | ((sql: string, params: unknown[]) => unknown[]),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => state.token ? { value: state.token } : undefined }),
}));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ AUTH_SECRET: "native-cleaning-session-test-secret-32-chars" }) }));
vi.mock("@/lib/db/dialect", () => ({ getDatabaseDialect: () => "postgres" }));
vi.mock("@/lib/db/portable", () => ({
  portableQueryOne: async (sql: string, params: unknown[]) => state.read!(sql, params)[0] ?? null,
}));

import { createSession } from "@/lib/auth/session";
import { GET as getCleaningProjection } from "@/app/api/v1/titan/workforce/native/cleaning/route";
import { POST as receptionPost } from "@/app/api/v1/titan/workforce/native/reception/route";
import { POST as salesPost } from "@/app/api/v1/titan/workforce/native/sales/route";
import { POST as bookingPost } from "@/app/api/v1/titan/workforce/native/booking/route";
import { POST as schedulingPost } from "@/app/api/v1/titan/workforce/native/scheduling/route";
import { POST as jobsPost } from "@/app/api/v1/titan/workforce/native/jobs/route";
import { POST as customerCarePost } from "@/app/api/v1/titan/workforce/native/customer-care/route";

let db: Database.Database;
const principal = "cleaning-owner";
const company = "company-cleaning-a";

beforeEach(async () => {
  state.token = "";
  db = new Database(":memory:");
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE business_memberships (user_id TEXT, account_id TEXT, role TEXT, status TEXT, UNIQUE(user_id,account_id));
    INSERT INTO users VALUES ('cleaning-owner');
    INSERT INTO business_memberships VALUES ('cleaning-owner','company-cleaning-a','owner','active');`);
  state.read = (sql, params) => {
    const bound = rewriteSqliteParams(sql, params);
    return db.prepare(bound.sql).all(...bound.params);
  };
  state.token = await createSession({ userId: principal, accountId: company, role: "owner" });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function request(path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest(`https://cleaning.test${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      cookie: `fsm_session=${state.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function post(handler: (request: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) {
  return handler(request(path, body, { "x-titan-company-id": "company-attacker-b" }));
}

describe("cleaning Workforce native profile bindings", () => {
  it("projects canonical bundle entries as six suggest-only adapter bindings and ten unavailable profiles", async () => {
    const response = await getCleaningProjection(request("/api/v1/titan/workforce/native/cleaning", undefined, {
      "x-titan-company-id": "company-attacker-b",
    }));
    expect(response.status).toBe(200);
    const projection = await response.json();
    expect(projection.company_id).toBe(company);
    expect(projection.profile_count).toBe(16);
    expect(projection.bound_suggest_only_count).toBe(6);
    expect(projection.unavailable_count).toBe(10);
    expect(projection.identity_grants_authority).toBe(false);
    expect(projection.profiles.filter((profile: Record<string, unknown>) => profile.binding_status === "bound_suggest_only").map((profile: Record<string, unknown>) => profile.profile_id).sort()).toEqual([
      "titan.cleaning.keys_access",
      "titan.cleaning.quality_inspector",
      "titan.cleaning.quote_specialist",
      "titan.cleaning.scope_assessor",
      "titan.cleaning.service_recovery",
      "titan.cleaning.crew_planner",
    ].sort());
    for (const profile of projection.profiles) {
      expect(profile.autonomy).toBe("suggest");
      expect(profile.authority_granted).toBe(false);
      expect(profile.execution_permitted).toBe(false);
      expect(profile.team_eligibility.status).toBe("unavailable");
      expect(profile.record_kind).toBe("profile_metadata");
      expect(profile.company_worker_id).toBeNull();
      expect(profile.execution_mode).toBe("suggest_only");
      expect(profile).not.toHaveProperty("tools");
      expect(profile).not.toHaveProperty("workflow");
      if (profile.binding_status === "unavailable") {
        expect(profile.native_agent_key).toBeNull();
        expect(profile.allowed_operations).toEqual([]);
        expect(profile.unavailable_reason).toMatch(/metadata only/);
      } else {
        expect(profile.allowed_operations.length).toBeGreaterThan(0);
      }
    }
  });

  it("plans inquiry → estimate → booking conversion → one-off visit through the authenticated adapters", async () => {
    const calls = vi.spyOn(globalThis, "fetch");
    const steps = [
      {
        handler: receptionPost,
        route: "/api/v1/titan/workforce/native/reception",
        body: { action: "capture_service_request", cleaningProfileId: "titan.cleaning.scope_assessor", dryRun: true, payload: { name: "Cleaning inquiry fixture", email: "cleaning@example.test", service_id: "bond_end_of_lease" } },
        operation: "booking_requests.create",
        profile: "titan.cleaning.scope_assessor",
      },
      {
        handler: salesPost,
        route: "/api/v1/titan/workforce/native/sales",
        body: { action: "create_quote", cleaningProfileId: "titan.cleaning.quote_specialist", dryRun: true, payload: { client_id: "fixture-client", service_id: "bond_end_of_lease" } },
        operation: "estimates.create",
        profile: "titan.cleaning.quote_specialist",
      },
      {
        handler: bookingPost,
        route: "/api/v1/titan/workforce/native/booking",
        body: { action: "confirm_request", requestId: "fixture-request", cleaningProfileId: "titan.cleaning.keys_access", dryRun: true, payload: { preferred_date: "2030-02-10", preferred_time_slot: "morning" } },
        operation: "booking_requests.convert",
        profile: "titan.cleaning.keys_access",
      },
      {
        handler: schedulingPost,
        route: "/api/v1/titan/workforce/native/scheduling",
        body: { action: "schedule_visits", jobId: "fixture-job", cleaningProfileId: "titan.cleaning.crew_planner", dryRun: true, payload: { visit_type: "cleaning", days: [{ scheduled_start: "2030-02-10T09:00:00.000Z", scheduled_end: "2030-02-10T11:00:00.000Z" }] } },
        operation: "project_visits.bulk",
        profile: "titan.cleaning.crew_planner",
      },
    ];

    for (const step of steps) {
      const response = await post(step.handler, step.route, step.body);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.dryRun).toBe(true);
      expect(result.executed).toBe(false);
      expect(result.plan.company_id).toBe(company);
      expect(result.plan.actor_id).toBe(principal);
      expect(result.plan.operation.id).toBe(step.operation);
      expect(result.plan.cleaning_profile_binding.profileId).toBe(step.profile);
      expect(result.plan.cleaning_profile_binding.autonomy).toBe("suggest");
      expect(result.plan.cleaning_profile_binding.authorityGranted).toBe(false);
      expect(result.plan.authority.execution_permitted).toBe(false);
      expect(result.governance.grants_authority).toBe(false);
    }
    expect(calls).not.toHaveBeenCalled();
    calls.mockRestore();
  });

  it("consumes the bound cleaning intake through its authenticated read operation", async () => {
    const calls = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(new URL(String(input)).origin).toBe("https://cleaning.test");
      expect(new URL(String(input)).pathname).toBe("/api/v1/booking-requests");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("cookie")).toBe(`fsm_session=${state.token}`);
      expect(new Headers(init?.headers).get("x-titan-company-id")).toBe(company);
      return new Response(JSON.stringify({ company_id: company, requests: [{ id: "request-a" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await post(receptionPost, "/api/v1/titan/workforce/native/reception", {
      action: "list_service_requests",
      cleaningProfileId: "titan.cleaning.scope_assessor",
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.executed).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.plan.company_id).toBe(company);
    expect(result.plan.actor_id).toBe(principal);
    expect(result.plan.operation.id).toBe("booking_requests.list");
    expect(result.plan.cleaning_profile_binding.profileId).toBe("titan.cleaning.scope_assessor");
    expect(result.upstream.result).toEqual({ company_id: company, requests: [{ id: "request-a" }] });
    expect(calls).toHaveBeenCalledOnce();
    calls.mockRestore();
  });

  it("consumes the other two real native bindings without granting mutation authority", async () => {
    const cases = [
      {
        handler: jobsPost,
        route: "/api/v1/titan/workforce/native/jobs",
        body: { action: "complete_work_order", workOrderId: "fixture-work-order", cleaningProfileId: "titan.cleaning.quality_inspector", dryRun: true, payload: {} },
        operation: "work_orders.complete",
        profile: "titan.cleaning.quality_inspector",
      },
      {
        handler: customerCarePost,
        route: "/api/v1/titan/workforce/native/customer-care",
        body: { action: "record_property_issue", propertyId: "fixture-property", cleaningProfileId: "titan.cleaning.service_recovery", dryRun: true, payload: { title: "Cleaning exception fixture" } },
        operation: "property_issues.create",
        profile: "titan.cleaning.service_recovery",
      },
    ];
    for (const step of cases) {
      const response = await post(step.handler, step.route, step.body);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.plan.company_id).toBe(company);
      expect(result.plan.operation.id).toBe(step.operation);
      expect(result.plan.cleaning_profile_binding.profileId).toBe(step.profile);
      expect(result.plan.authority.execution_permitted).toBe(false);
    }
  });

  it("keeps consequential adapter calls fail-closed until governed execution authority is supplied", async () => {
    const calls = vi.spyOn(globalThis, "fetch");
    const response = await post(receptionPost, "/api/v1/titan/workforce/native/reception", {
      action: "capture_service_request",
      cleaningProfileId: "titan.cleaning.scope_assessor",
      payload: { name: "No-mutation fixture", email: "cleaning@example.test" },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("CANONICAL_EXECUTION_AUTHORITY_REQUIRED");
    expect(calls).not.toHaveBeenCalled();
    calls.mockRestore();
  });

  it("rejects profile-operation mismatches, revoked memberships, and caller-selected company context", async () => {
    const mismatch = await post(salesPost, "/api/v1/titan/workforce/native/sales", {
      action: "create_quote",
      cleaningProfileId: "titan.cleaning.scope_assessor",
      dryRun: true,
      payload: { client_id: "fixture-client" },
    });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error.message).toMatch(/cleaning-profile-agent-mismatch/);

    db.prepare("UPDATE business_memberships SET status='revoked' WHERE user_id=? AND account_id=?").run(principal, company);
    const revoked = await getCleaningProjection(request("/api/v1/titan/workforce/native/cleaning"));
    expect(revoked.status).toBe(401);
  });
});
