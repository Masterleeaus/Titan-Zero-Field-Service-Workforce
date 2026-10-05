import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { compare, hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../env", () => ({
  getEnv: () => ({ DATABASE_URL: process.env.TEST_RUNTIME_DATABASE_URL }),
}));
import { getPool, withDbSession } from "../db";
import { withTenantTransaction } from "../db/portable";
import { loadAvailabilityForAccount } from "../workforce/availability";
import { loadTechnicianSkills } from "../workforce/skills";
import { loadFieldJobTemplates } from "../work-orders/field-job-templates";
import { loadCompanyMemberDirectory } from "../workforce/member-directory";
import { lockOwnerMembershipChanges } from "../db/owner-membership-lock";

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_RUNTIME_DATABASE_URL;
if (process.env.CI && !enabled) {
  throw new Error("RLS integration requires TEST_DATABASE_URL and TEST_RUNTIME_DATABASE_URL");
}

describe.skipIf(!enabled)("real restricted runtime database isolation", () => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const accountA = randomUUID();
  const accountB = randomUUID();
  const userA = randomUUID();
  const userAdminA = randomUUID();
  const userATech = randomUUID();
  const userBOwner = randomUUID();
  const extraOwnerA = randomUUID();
  const extraMemberA = randomUUID();
  const unassignedUserA = randomUUID();
  const clientB = randomUUID();
  const skillA = randomUUID();
  const skillB = randomUUID();
  const availabilityA = randomUUID();
  const availabilityB = randomUUID();
  const templateA = randomUUID();
  const templateB = randomUUID();
  const taskA = randomUUID();
  const taskB = randomUUID();
  const email = `rls-${randomUUID()}@test.invalid`;
  const duplicateEmail = `rls-duplicate-${randomUUID()}@test.invalid`;
  const session = { accountId: accountA, userId: userA, role: "owner" as const };
  const adminSession = { accountId: accountA, userId: userAdminA, role: "admin" as const };

  beforeAll(async () => {
    await admin.query("INSERT INTO accounts (id, name) VALUES ($1, 'RLS A'), ($2, 'RLS B')", [accountA, accountB]);
    const passwordHash = await hash("rls-test-password", 4);
    await admin.query(
      `INSERT INTO users (id, account_id, email, full_name, password_hash, role)
       VALUES ($1, $2, $3, 'RLS owner', $4, 'owner'),
              ($5, $2, $6, 'Duplicate A', $4, 'tech'),
              ($7, $8, $6, 'Duplicate B', $4, 'owner'),
              ($9, $2, $10, 'Extra A', $4, 'tech'),
              ($11, $2, $12, 'Unassigned A', $4, 'tech'),
              ($13, $2, $14, 'RLS admin', $4, 'admin'),
              ($15, $2, $16, 'Second RLS owner', $4, 'owner')`,
      [userA, accountA, email, passwordHash, userATech, duplicateEmail, userBOwner, accountB, extraMemberA, `extra-${randomUUID()}@test.invalid`, unassignedUserA, `unassigned-${randomUUID()}@test.invalid`, userAdminA, `admin-${randomUUID()}@test.invalid`, extraOwnerA, `second-owner-${randomUUID()}@test.invalid`],
    );
    // A principal may retain a membership in more than one company.
    // Do not add an account_id=user.account_id membership invariant.
    await admin.query(
      `INSERT INTO business_memberships (account_id, user_id, role, status)
       VALUES ($1, $3, 'owner', 'active'),
              ($1, $4, 'tech', 'active'),
              ($1, $5, 'tech', 'active'),
              ($2, $6, 'owner', 'active'),
              ($2, $3, 'tech', 'active'),
              ($1, $7, 'admin', 'active'),
              ($2, $7, 'tech', 'active'),
              ($1, $8, 'owner', 'active')`,
      [accountA, accountB, userA, userATech, extraMemberA, userBOwner, userAdminA, extraOwnerA],
    );
    await admin.query(
      "INSERT INTO clients (id, account_id, name) VALUES ($1, $2, 'Other account client')",
      [clientB, accountB],
    );
    await admin.query(
      `INSERT INTO workforce_skills (id, account_id, name, category)
       VALUES ($1, $2, 'A skill', 'field'), ($3, $4, 'B skill', 'field')`,
      [skillA, accountA, skillB, accountB],
    );
    await admin.query(
      `INSERT INTO technician_skills (account_id, user_id, skill_id, proficiency)
       VALUES ($1, $2, $3, 3), ($4, $5, $6, 4), ($4, $7, $6, 2), ($4, $8, $6, 2)`,
      [accountA, userATech, skillA, accountB, userBOwner, skillB, userA, userAdminA],
    );
    await admin.query(
      `INSERT INTO technician_availability (id, account_id, user_id, weekday, start_time, end_time)
       VALUES ($1, $2, $3, 1, '08:00', '16:00'),
              ($4, $5, $6, 2, '09:00', '17:00'),
              ($7, $5, $8, 3, '08:00', '16:00')`,
      [availabilityA, accountA, userATech, availabilityB, accountB, userA, randomUUID(), userAdminA],
    );
    await admin.query(
      `INSERT INTO field_job_templates (id, account_id, name)
       VALUES ($1, $2, 'A template'), ($3, $4, 'B template')`,
      [templateA, accountA, templateB, accountB],
    );
    await admin.query(
      `INSERT INTO field_job_template_tasks (id, account_id, template_id, label)
       VALUES ($1, $2, $3, 'A task'), ($4, $5, $6, 'B task')`,
      [taskA, accountA, templateA, taskB, accountB, templateB],
    );
  });

  afterAll(async () => {
    await admin.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [[accountA, accountB]]);
    await admin.end();
    await getPool().end();
  });

  it("connects as a non-owner, non-superuser role that cannot bypass RLS", async () => {
    const { rows: [role] } = await getPool().query(
      `SELECT current_user AS name, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
              (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'clients') AS owner
       FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role.name).toBe("ai_fsm_web");
    expect(role.owner).not.toBe(role.name);
    expect([role.rolsuper, role.rolbypassrls, role.rolcreaterole, role.rolcreatedb]).toEqual([false, false, false, false]);
    await expect(getPool().query("CREATE TABLE public.runtime_must_not_create (id int)"))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("denies users and client reads without session context, but supports bounded login", async () => {
    expect((await getPool().query("SELECT id FROM users")).rows).toEqual([]);
    expect((await getPool().query("SELECT id FROM clients")).rows).toEqual([]);
    expect((await getPool().query("SELECT has_column_privilege(current_user, 'public.users', 'password_hash', 'SELECT') AS can_read_hash")).rows[0].can_read_hash).toBe(false);
    await expect(getPool().query("SELECT password_hash FROM users"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("SELECT * FROM users"))
      .rejects.toMatchObject({ code: "42501" });
    const { rows } = await getPool().query("SELECT * FROM app_login_candidates($1)", [email.toUpperCase()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(userA);
    expect(await compare("rls-test-password", rows[0].password_hash)).toBe(true);
    expect(await compare("wrong-password", rows[0].password_hash)).toBe(false);
    expect((await getPool().query("SELECT * FROM app_login_candidates($1)", ["missing@test.invalid"])).rows).toEqual([]);
    expect((await getPool().query("SELECT * FROM app_login_candidates($1)", [duplicateEmail])).rows).toHaveLength(2);
  });

  it("returns only active selected-company members and exposes no hash in the directory", async () => {
    const companyA = await withTenantTransaction(session, async (client, accountId) =>
      loadCompanyMemberDirectory(client, accountId),
    );
    expect(companyA.map((member) => member.id).sort()).toEqual(
      [userA, userATech, extraMemberA, userAdminA, extraOwnerA].sort(),
    );
    expect(companyA.every((member) => member.status === "active")).toBe(true);
    expect(companyA[0]).not.toHaveProperty("password_hash");

    // userA's primary account is A, but its active membership in B makes the
    // principal visible in B. A-only members remain invisible there.
    const companyB = await withTenantTransaction(
      { ...session, accountId: accountB, role: "tech" },
      async (client, accountId) => loadCompanyMemberDirectory(client, accountId),
    );
    expect(companyB.map((member) => member.id).sort()).toEqual(
      [userA, userBOwner, userAdminA].sort(),
    );
    expect(companyB.some((member) => member.id === extraMemberA || member.id === userATech)).toBe(false);

    const selfHash = await withTenantTransaction(
      { ...session, userId: userATech, role: "tech" },
      async (client) => (await client.query<{ password_hash: string | null }>(
        "SELECT public.app_user_password_hash($1::uuid) AS password_hash", [userATech],
      )).rows[0]?.password_hash,
    );
    expect(selfHash).toBeTruthy();
    const otherMemberHashForAdmin = await withTenantTransaction(
      adminSession,
      async (client) => (await client.query<{ password_hash: string | null }>(
        "SELECT public.app_user_password_hash($1::uuid) AS password_hash", [userATech],
      )).rows[0]?.password_hash,
    );
    expect(otherMemberHashForAdmin).toBeNull();
  });

  it("reads and writes only its account even when queries omit account filters", async () => {
    await withDbSession(session, async (client) => {
      const own = await client.query("INSERT INTO clients (account_id, name) VALUES ($1, 'Own client') RETURNING id", [accountA]);
      const { rows } = await client.query("SELECT id, account_id FROM clients");
      expect(rows).toEqual([{ id: own.rows[0].id, account_id: accountA }]);
      expect((await client.query("UPDATE clients SET name = 'stolen' WHERE id = $1", [clientB])).rowCount).toBe(0);
      expect((await client.query("DELETE FROM clients WHERE id = $1", [clientB])).rowCount).toBe(0);
      expect((await client.query("SELECT id FROM users WHERE id = $1", [userA])).rows).toEqual([{ id: userA }]);
    });
    await expect(withDbSession(session, (client) =>
      client.query("INSERT INTO clients (account_id, name) VALUES ($1, 'Forbidden')", [accountB]),
    )).rejects.toMatchObject({ code: "42501" });
  });

  it("clears context after commit and failed writes before reusing the pool", async () => {
    await withDbSession(session, async (client) => {
      expect((await client.query("SELECT app_account_id() AS id")).rows[0].id).toBe(accountA);
    });
    expect((await getPool().query("SELECT app_account_id() AS id, app_user_id() AS user_id, app_role() AS role")).rows[0])
      .toEqual({ id: null, user_id: null, role: null });
    await expect(withDbSession({ ...session, role: "tech" }, (client) =>
      client.query("INSERT INTO clients (account_id, name) VALUES ($1, 'Forbidden tech write')", [accountA]),
    )).rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_CONTEXT_STALE" });
    expect((await getPool().query("SELECT id FROM clients")).rows).toEqual([]);
    await withDbSession({ ...session, accountId: accountB, role: "tech" }, async (client) => {
      expect((await client.query("SELECT id FROM clients")).rows).toEqual([{ id: clientB }]);
    });
  });

  it("keeps the six Workforce tables default-deny and reads one account through tenant helpers", async () => {
    const protectedTables = [
      "business_memberships",
      "workforce_skills",
      "technician_skills",
      "technician_availability",
      "field_job_templates",
      "field_job_template_tasks",
    ];
    const flags = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      [protectedTables],
    );
    expect(flags.rows).toHaveLength(protectedTables.length);
    expect(flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    const privileges = await getPool().query(
      `SELECT c.relname,
              has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
              has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
              has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
              has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      [protectedTables],
    );
    expect(privileges.rows).toHaveLength(protectedTables.length);
    expect(privileges.rows.every((row) => row.can_select && row.can_insert && row.can_update && row.can_delete)).toBe(true);

    const contextlessInserts: Array<{ table: string; sql: string; params: unknown[] }> = [
      {
        table: "business_memberships",
        sql: `INSERT INTO business_memberships (account_id, user_id, role, status) VALUES ($1, $2, 'tech', 'active')`,
        params: [accountA, unassignedUserA],
      },
      {
        table: "workforce_skills",
        sql: `INSERT INTO workforce_skills (id, account_id, name) VALUES ($1, $2, 'Contextless skill')`,
        params: [randomUUID(), accountA],
      },
      {
        table: "technician_skills",
        sql: `INSERT INTO technician_skills (account_id, user_id, skill_id, proficiency) VALUES ($1, $2, $3, 1)`,
        params: [accountA, userATech, skillA],
      },
      {
        table: "technician_availability",
        sql: `INSERT INTO technician_availability (id, account_id, user_id, weekday, start_time, end_time) VALUES ($1, $2, $3, 0, '08:00', '16:00')`,
        params: [randomUUID(), accountA, userATech],
      },
      {
        table: "field_job_templates",
        sql: `INSERT INTO field_job_templates (id, account_id, name) VALUES ($1, $2, 'Contextless template')`,
        params: [randomUUID(), accountA],
      },
      {
        table: "field_job_template_tasks",
        sql: `INSERT INTO field_job_template_tasks (id, account_id, template_id, label) VALUES ($1, $2, $3, 'Contextless task')`,
        params: [randomUUID(), accountA, templateA],
      },
    ];

    for (const table of protectedTables) {
      expect((await getPool().query(`SELECT account_id FROM ${table}`)).rows).toEqual([]);
      const insert = contextlessInserts.find((candidate) => candidate.table === table);
      expect(insert).toBeDefined();
      await expect(getPool().query(insert!.sql, insert!.params))
        .rejects.toMatchObject({ code: "42501" });
    }

    // This injects the session payload after authentication to exercise the DB
    // boundary. It is not a login/bootstrap test; #302 owns that resolver.
    await withTenantTransaction(session, async (client, accountId) => {
      expect(accountId).toBe(accountA);
      const memberships = await client.query<{ user_id: string }>(
        `SELECT user_id FROM business_memberships ORDER BY user_id`,
      );
      expect(memberships.rows.map((row) => row.user_id).sort()).toEqual([userA, userATech, extraMemberA, userAdminA, extraOwnerA].sort());

      const skillMap = await loadTechnicianSkills(client, accountId);
      expect(skillMap.get(userATech)?.map((skill) => skill.skillId)).toEqual([skillA]);
      const availability = await loadAvailabilityForAccount(client, accountId);
      expect(availability.map((window) => [window.id, window.userId])).toEqual([[availabilityA, userATech]]);
      const templates = await loadFieldJobTemplates(client, accountId);
      expect(templates.map((template) => [template.id, template.tasks.map((task) => task.id)])).toEqual([[templateA, [taskA]]]);

      for (const table of protectedTables) {
        expect((await client.query(`SELECT account_id FROM ${table} WHERE account_id = $1`, [accountB])).rows).toEqual([]);
        expect((await client.query(`UPDATE ${table} SET account_id = $1 WHERE account_id = $2`, [accountA, accountB])).rowCount).toBe(0);
        expect((await client.query(`DELETE FROM ${table} WHERE account_id = $1`, [accountB])).rowCount).toBe(0);
      }
    });

    // A verified selected-company context can view its own membership row for
    // the same principal even though legacy users.account_id points at A.
    await withTenantTransaction({ ...session, accountId: accountB, userId: userA, role: "tech" }, async (client) => {
      const { rows } = await client.query<{ user_id: string }>(
        `SELECT user_id FROM business_memberships WHERE user_id = $1`, [userA],
      );
      expect(rows).toEqual([{ user_id: userA }]);
    });
  });

  it("clears tenant transaction context after commit and rollback before pool reuse", async () => {
    await withTenantTransaction(session, async (client) => {
      expect((await client.query(
        `SELECT app_account_id() AS account_id, app_user_id() AS user_id, app_role() AS role`,
      )).rows[0]).toEqual({ account_id: accountA, user_id: userA, role: "owner" });
    });
    expect((await getPool().query(
      `SELECT app_account_id() AS account_id, app_user_id() AS user_id, app_role() AS role`,
    )).rows[0]).toEqual({ account_id: null, user_id: null, role: null });

    await expect(withTenantTransaction({ ...session, role: "tech" }, (client) => client.query(
      `INSERT INTO workforce_skills (id, account_id, name) VALUES ($1, $2, 'Rolled-back tech write')`,
      [randomUUID(), accountA],
    ))).rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_CONTEXT_STALE" });
    expect((await getPool().query(
      `SELECT app_account_id() AS account_id, app_user_id() AS user_id, app_role() AS role`,
    )).rows[0]).toEqual({ account_id: null, user_id: null, role: null });

    await withTenantTransaction({ ...session, accountId: accountB, role: "tech" }, async (client) => {
      expect((await client.query(`SELECT app_account_id() AS account_id`)).rows[0].account_id).toBe(accountB);
      expect((await client.query(`SELECT user_id FROM business_memberships WHERE user_id = $1`, [userA])).rows)
        .toEqual([{ user_id: userA }]);
    });
    expect((await getPool().query(
      `SELECT app_account_id() AS account_id, app_user_id() AS user_id, app_role() AS role`,
    )).rows[0]).toEqual({ account_id: null, user_id: null, role: null });
  });

  it("prevents admins from assigning owner/admin membership roles", async () => {
    for (const role of ["owner", "admin"] as const) {
      await expect(withTenantTransaction(adminSession, (client) => client.query(
        `INSERT INTO business_memberships (account_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
        [accountA, unassignedUserA, role],
      ))).rejects.toMatchObject({ code: "42501" });
    }
    await withTenantTransaction(adminSession, (client) => client.query(
      `INSERT INTO business_memberships (account_id, user_id, role, status) VALUES ($1, $2, 'tech', 'active')`,
      [accountA, unassignedUserA],
    ));
    await expect(withTenantTransaction(adminSession, (client) => client.query(
      `UPDATE business_memberships SET role = 'owner' WHERE account_id = $1 AND user_id = $2`,
      [accountA, extraMemberA],
    ))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenantTransaction(adminSession, (client) => client.query(
      `UPDATE business_memberships SET role = 'admin' WHERE account_id = $1 AND user_id = $2`,
      [accountA, extraMemberA],
    ))).rejects.toMatchObject({ code: "42501" });
    await withTenantTransaction(adminSession, async (client) => {
      expect((await client.query(
        `UPDATE business_memberships SET role = 'owner' WHERE account_id = $1 AND user_id = $2`,
        [accountA, userAdminA],
      )).rowCount).toBe(0);
    });
    await withTenantTransaction(session, (client) => client.query(
      `DELETE FROM business_memberships WHERE account_id = $1 AND user_id = $2`,
      [accountA, unassignedUserA],
    ));
  });

  it("serializes concurrent owner demotions so exactly one owner remains", async () => {
    await admin.query(
      `UPDATE business_memberships SET role = 'owner'
        WHERE account_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'active'`,
      [accountA, [userA, extraOwnerA]],
    );
    const demoteOwner = async (actorId: string, targetId: string) => withTenantTransaction(
      { ...session, userId: actorId },
      async (client, accountId) => {
        await lockOwnerMembershipChanges(client, accountId);
        const actor = await client.query<{ role: string }>(
          `SELECT role FROM business_memberships
            WHERE account_id = $1 AND user_id = $2 AND status = 'active'`,
          [accountId, actorId],
        );
        if (actor.rows[0]?.role !== "owner") return false;
        const owners = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM business_memberships
            WHERE account_id = $1 AND status = 'active' AND role = 'owner'`,
          [accountId],
        );
        if ((owners.rows[0]?.count ?? 0) <= 1) return false;
        return (await client.query(
          `UPDATE business_memberships SET role = 'tech', updated_at = now()
            WHERE account_id = $1 AND user_id = $2 AND status = 'active' AND role = 'owner'`,
          [accountId, targetId],
        )).rowCount === 1;
      },
    );

    const outcomes = await Promise.all([
      demoteOwner(userA, extraOwnerA),
      demoteOwner(extraOwnerA, userA),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const { rows } = await admin.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM business_memberships
        WHERE account_id = $1 AND status = 'active' AND role = 'owner'`,
      [accountA],
    );
    expect(rows[0]?.count).toBe(1);
    // Restore a deterministic fixture for later auth-context tests.
    await admin.query(
      `UPDATE business_memberships SET role = 'owner'
        WHERE account_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'active'`,
      [accountA, [userA, extraOwnerA]],
    );
  });

  it("repairs an orphan legacy role without creating selected-company membership", async () => {
    const { rows } = await withTenantTransaction(session, (client) =>
      client.query<{ updated: boolean }>(
        `SELECT public.app_update_legacy_user_role($1::uuid, 'admin') AS updated`,
        [unassignedUserA],
      ),
    );
    expect(rows[0]?.updated).toBe(true);
    expect((await admin.query(
      `SELECT role FROM users WHERE id = $1`, [unassignedUserA],
    )).rows[0]?.role).toBe("admin");
    expect((await admin.query(
      `SELECT id FROM business_memberships WHERE account_id = $1 AND user_id = $2`,
      [accountA, unassignedUserA],
    )).rows).toEqual([]);
  });

  it("rejects stale role and revoked selected-company contexts while preserving other-company membership", async () => {
    try {
      await admin.query(
        `UPDATE business_memberships SET role = 'tech'
          WHERE account_id = $1 AND user_id = $2 AND status = 'active'`,
        [accountA, userAdminA],
      );

      await expect(withTenantTransaction(adminSession, async () => "protected data"))
        .rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_CONTEXT_STALE" });
      await expect(withDbSession(adminSession, async () => "protected data"))
        .rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_CONTEXT_STALE" });
      await expect(withTenantTransaction({ ...adminSession, role: "tech" }, async () => "company A"))
        .resolves.toBe("company A");
      await expect(withTenantTransaction({ ...adminSession, accountId: accountB, role: "tech" }, async () => "company B"))
        .resolves.toBe("company B");

      await admin.query(
        `UPDATE business_memberships SET status = 'revoked'
          WHERE account_id = $1 AND user_id = $2 AND status = 'active'`,
        [accountA, userAdminA],
      );
      await expect(withTenantTransaction({ ...adminSession, role: "tech" }, async () => "protected data"))
        .rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_CONTEXT_STALE" });
      await expect(withDbSession({ ...adminSession, role: "tech" }, async () => "protected data"))
        .rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_CONTEXT_STALE" });
      await expect(withTenantTransaction({ ...adminSession, accountId: accountB, role: "tech" }, async () => "company B"))
        .resolves.toBe("company B");

      const memberships = await admin.query(
        `SELECT account_id, role, status FROM business_memberships
          WHERE user_id = $1 AND account_id = ANY($2::uuid[]) ORDER BY account_id`,
        [userAdminA, [accountA, accountB]],
      );
      expect(memberships.rows).toHaveLength(2);
      expect(memberships.rows).toEqual(expect.arrayContaining([
        { account_id: accountA, role: "tech", status: "revoked" },
        { account_id: accountB, role: "tech", status: "active" },
      ]));
    } finally {
      await admin.query(
        `UPDATE business_memberships SET role = 'admin', status = 'active'
          WHERE account_id = $1 AND user_id = $2`,
        [accountA, userAdminA],
      );
    }
  });

  it("revokes one company membership without removing another company's access or Workforce data", async () => {
    await withTenantTransaction(session, (client) => client.query(
      `UPDATE business_memberships SET status = 'revoked', updated_at = now()
        WHERE account_id = $1 AND user_id = $2 AND status = 'active'`,
      [accountA, userAdminA],
    ));
    const remaining = await admin.query(
      `SELECT m.status,
              (SELECT count(*) FROM technician_skills WHERE account_id = $1 AND user_id = $2) AS skills,
              (SELECT count(*) FROM technician_availability WHERE account_id = $1 AND user_id = $2) AS availability
         FROM business_memberships m WHERE m.account_id = $1 AND m.user_id = $2`,
      [accountB, userAdminA],
    );
    expect(remaining.rows).toEqual([{ status: "active", skills: "1", availability: "1" }]);
    const revoked = await admin.query(
      `SELECT status FROM business_memberships WHERE account_id = $1 AND user_id = $2`,
      [accountA, userAdminA],
    );
    expect(revoked.rows).toEqual([{ status: "revoked" }]);
    await withTenantTransaction(session, async (client) => {
      const staff = await client.query<{ id: string; role: string }>(
        `SELECT u.id, bm.role
           FROM users u
           JOIN business_memberships bm
             ON bm.user_id = u.id AND bm.account_id = $1 AND bm.status = 'active'
          WHERE u.account_id = $1`,
        [accountA],
      );
      expect(staff.rows.some((member) => member.id === userAdminA)).toBe(false);
    });
  });

  it("allows same-account owner CRUD and rejects forged account and parent references", async () => {
    const transientSkill = randomUUID();
    const transientTemplate = randomUUID();
    const transientTask = randomUUID();
    const transientAvailability = randomUUID();
    const inactiveSkill = randomUUID();

    await withTenantTransaction(session, async (client, accountId) => {
      await client.query(
        `INSERT INTO workforce_skills (id, account_id, name) VALUES ($1, $2, 'Inactive skill')`,
        [inactiveSkill, accountId],
      );
      await client.query(`UPDATE workforce_skills SET active = false WHERE id = $1 AND account_id = $2`, [inactiveSkill, accountId]);
    });
    await expect(withTenantTransaction(session, (client) => client.query(
      `INSERT INTO technician_skills (account_id, user_id, skill_id, proficiency) VALUES ($1, $2, $3, 1)`,
      [accountA, userATech, inactiveSkill],
    ))).rejects.toMatchObject({ code: "42501" });
    await withTenantTransaction(session, (client) => client.query(
      `DELETE FROM workforce_skills WHERE id = $1 AND account_id = $2`,
      [inactiveSkill, accountA],
    ));

    await withTenantTransaction(session, (client) => client.query(
      `UPDATE business_memberships SET status = 'revoked' WHERE account_id = $1 AND user_id = $2`,
      [accountA, userATech],
    ));
    await withTenantTransaction(session, async (client) => {
      expect((await client.query(
        `SELECT skill_id FROM technician_skills WHERE account_id = $1 AND user_id = $2`,
        [accountA, userATech],
      )).rows).toEqual([]);
      expect((await client.query(
        `SELECT id FROM technician_availability WHERE account_id = $1 AND user_id = $2`,
        [accountA, userATech],
      )).rows).toEqual([]);
    });
    await expect(withTenantTransaction(session, (client) => client.query(
      `INSERT INTO technician_skills (account_id, user_id, skill_id, proficiency) VALUES ($1, $2, $3, 1)`,
      [accountA, userATech, skillA],
    ))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenantTransaction(session, (client) => client.query(
      `INSERT INTO technician_availability (id, account_id, user_id, weekday, start_time, end_time)
       VALUES ($1, $2, $3, 6, '08:00', '16:00')`,
      [randomUUID(), accountA, userATech],
    ))).rejects.toMatchObject({ code: "42501" });
    await withTenantTransaction(session, (client) => client.query(
      `UPDATE business_memberships SET status = 'active' WHERE account_id = $1 AND user_id = $2`,
      [accountA, userATech],
    ));

    await withTenantTransaction(session, async (client, accountId) => {
      expect((await client.query(
        `UPDATE business_memberships SET role = 'admin' WHERE account_id = $1 AND user_id = $2`,
        [accountId, extraMemberA],
      )).rowCount).toBe(1);
      expect((await client.query(
        `DELETE FROM business_memberships WHERE account_id = $1 AND user_id = $2`,
        [accountId, extraMemberA],
      )).rowCount).toBe(1);

      await client.query(
        `INSERT INTO workforce_skills (id, account_id, name, category) VALUES ($1, $2, 'Transient skill', 'test')`,
        [transientSkill, accountId],
      );
      expect((await client.query(
        `UPDATE workforce_skills SET category = 'changed' WHERE id = $1 AND account_id = $2`,
        [transientSkill, accountId],
      )).rowCount).toBe(1);
      expect((await client.query(`DELETE FROM workforce_skills WHERE id = $1 AND account_id = $2`, [transientSkill, accountId])).rowCount).toBe(1);

      expect((await client.query(
        `UPDATE technician_skills SET proficiency = 1 WHERE account_id = $1 AND user_id = $2 AND skill_id = $3`,
        [accountId, userATech, skillA],
      )).rowCount).toBe(1);
      expect((await client.query(
        `DELETE FROM technician_skills WHERE account_id = $1 AND user_id = $2 AND skill_id = $3`,
        [accountId, userATech, skillA],
      )).rowCount).toBe(1);
      expect((await client.query(
        `INSERT INTO technician_skills (account_id, user_id, skill_id, proficiency) VALUES ($1, $2, $3, 3)`,
        [accountId, userATech, skillA],
      )).rowCount).toBe(1);

      await client.query(
        `INSERT INTO technician_availability (id, account_id, user_id, weekday, start_time, end_time, note)
         VALUES ($1, $2, $3, 3, '08:00', '16:00', 'before')`,
        [transientAvailability, accountId, userATech],
      );
      expect((await client.query(
        `UPDATE technician_availability SET note = 'after' WHERE id = $1 AND account_id = $2`,
        [transientAvailability, accountId],
      )).rowCount).toBe(1);
      expect((await client.query(
        `DELETE FROM technician_availability WHERE id = $1 AND account_id = $2`,
        [transientAvailability, accountId],
      )).rowCount).toBe(1);

      await client.query(
        `INSERT INTO field_job_templates (id, account_id, name) VALUES ($1, $2, 'Transient template')`,
        [transientTemplate, accountId],
      );
      await client.query(
        `INSERT INTO field_job_template_tasks (id, account_id, template_id, label) VALUES ($1, $2, $3, 'Transient task')`,
        [transientTask, accountId, transientTemplate],
      );
      expect((await client.query(
        `UPDATE field_job_template_tasks SET required = false WHERE id = $1 AND account_id = $2`,
        [transientTask, accountId],
      )).rowCount).toBe(1);
      expect((await client.query(
        `DELETE FROM field_job_template_tasks WHERE id = $1 AND account_id = $2`,
        [transientTask, accountId],
      )).rowCount).toBe(1);
      expect((await client.query(
        `UPDATE field_job_templates SET active = false WHERE id = $1 AND account_id = $2`,
        [transientTemplate, accountId],
      )).rowCount).toBe(1);
      expect((await client.query(
        `DELETE FROM field_job_templates WHERE id = $1 AND account_id = $2`,
        [transientTemplate, accountId],
      )).rowCount).toBe(1);
    });

    const denyFor = async (
      activeSession: { accountId: string; userId: string; role: "owner" | "admin" | "tech" },
      sql: string,
      params: unknown[],
    ) => {
      await expect(withTenantTransaction(activeSession, (client) => client.query(sql, params)))
        .rejects.toMatchObject({ code: "42501" });
    };
    const deny = (sql: string, params: unknown[]) => denyFor(session, sql, params);
    await deny(
      `INSERT INTO business_memberships (account_id, user_id, role, status) VALUES ($1, $2, 'tech', 'active')`,
      [accountB, userATech],
    );
    await deny(
      `INSERT INTO workforce_skills (id, account_id, name) VALUES ($1, $2, 'Forged B skill')`,
      [randomUUID(), accountB],
    );
    await deny(
      `INSERT INTO technician_skills (account_id, user_id, skill_id, proficiency) VALUES ($1, $2, $3, 1)`,
      [accountA, userBOwner, skillA],
    );
    await deny(
      `INSERT INTO technician_skills (account_id, user_id, skill_id, proficiency) VALUES ($1, $2, $3, 1)`,
      [accountA, userATech, skillB],
    );
    await deny(
      `INSERT INTO technician_availability (id, account_id, user_id, weekday, start_time, end_time) VALUES ($1, $2, $3, 4, '08:00', '16:00')`,
      [randomUUID(), accountA, userBOwner],
    );
    await deny(
      `INSERT INTO field_job_templates (id, account_id, name) VALUES ($1, $2, 'Forged B template')`,
      [randomUUID(), accountB],
    );
    await deny(
      `INSERT INTO field_job_template_tasks (id, account_id, template_id, label) VALUES ($1, $2, $3, 'Forged parent task')`,
      [randomUUID(), accountA, templateB],
    );

    const updatesToOtherAccount: Array<{ sql: string; params: unknown[] }> = [
      {
        sql: `UPDATE business_memberships SET account_id = $1 WHERE account_id = $2 AND user_id = $3`,
        params: [accountB, accountA, userATech],
      },
      {
        sql: `UPDATE workforce_skills SET account_id = $1 WHERE account_id = $2 AND id = $3`,
        params: [accountB, accountA, skillA],
      },
      {
        sql: `UPDATE technician_skills SET account_id = $1 WHERE account_id = $2 AND user_id = $3 AND skill_id = $4`,
        params: [accountB, accountA, userATech, skillA],
      },
      {
        sql: `UPDATE technician_availability SET account_id = $1 WHERE account_id = $2 AND id = $3`,
        params: [accountB, accountA, availabilityA],
      },
      {
        sql: `UPDATE field_job_templates SET account_id = $1 WHERE account_id = $2 AND id = $3`,
        params: [accountB, accountA, templateA],
      },
      {
        sql: `UPDATE field_job_template_tasks SET account_id = $1 WHERE account_id = $2 AND id = $3`,
        params: [accountB, accountA, taskA],
      },
    ];
    for (const { sql, params } of updatesToOtherAccount) await deny(sql, params);

    const techWriteAttempts: Array<{ sql: string; params: unknown[] }> = [
      {
        sql: `INSERT INTO business_memberships (account_id, user_id, role, status) VALUES ($1, $2, 'tech', 'active')`,
        params: [accountA, unassignedUserA],
      },
      {
        sql: `INSERT INTO workforce_skills (id, account_id, name) VALUES ($1, $2, 'Tech-forged skill')`,
        params: [randomUUID(), accountA],
      },
      {
        sql: `INSERT INTO technician_skills (account_id, user_id, skill_id, proficiency) VALUES ($1, $2, $3, 1)`,
        params: [accountA, userA, skillA],
      },
      {
        sql: `INSERT INTO technician_availability (id, account_id, user_id, weekday, start_time, end_time)
              VALUES ($1, $2, $3, 1, '08:00', '16:00')`,
        params: [randomUUID(), accountA, userATech],
      },
      {
        sql: `INSERT INTO field_job_templates (id, account_id, name) VALUES ($1, $2, 'Tech-forged template')`,
        params: [randomUUID(), accountA],
      },
      {
        sql: `INSERT INTO field_job_template_tasks (id, account_id, template_id, label) VALUES ($1, $2, $3, 'Tech-forged task')`,
        params: [randomUUID(), accountA, templateA],
      },
    ];
    for (const { sql, params } of techWriteAttempts) {
      await denyFor({ ...session, role: "tech", userId: userATech }, sql, params);
    }

    await expect(admin.query(
      `INSERT INTO technician_skills (account_id, user_id, skill_id) VALUES ($1, $2, $3)`,
      [accountA, userATech, skillB],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(admin.query(
      `INSERT INTO technician_skills (account_id, user_id, skill_id) VALUES ($1, $2, $3)`,
      [accountA, userBOwner, skillA],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(admin.query(
      `INSERT INTO technician_availability (id, account_id, user_id, weekday, start_time, end_time)
       VALUES ($1, $2, $3, 5, '08:00', '16:00')`,
      [randomUUID(), accountA, userBOwner],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(admin.query(
      `INSERT INTO field_job_template_tasks (id, account_id, template_id, label) VALUES ($1, $2, $3, 'Wrong account')`,
      [randomUUID(), accountA, templateB],
    )).rejects.toMatchObject({ code: "23503" });

    await admin.query(
      `INSERT INTO business_memberships (account_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
      [accountB, unassignedUserA],
    );
    await withTenantTransaction(session, async (client, accountId) => {
      await client.query(
        `INSERT INTO business_memberships (account_id, user_id, role, status) VALUES ($1, $2, 'tech', 'active')`,
        [accountId, unassignedUserA],
      );
      await client.query(
        `INSERT INTO technician_skills (account_id, user_id, skill_id, proficiency) VALUES ($1, $2, $3, 2)`,
        [accountId, unassignedUserA, skillA],
      );
      await client.query(
        `INSERT INTO technician_availability (id, account_id, user_id, weekday, start_time, end_time)
         VALUES ($1, $2, $3, 2, '08:00', '16:00')`,
        [randomUUID(), accountId, unassignedUserA],
      );
    });
    await expect(withTenantTransaction(session, (client, accountId) => client.query(
      `DELETE FROM users WHERE id = $1 AND account_id = $2`, [unassignedUserA, accountId],
    ))).rejects.toMatchObject({ code: "42501" });
    const afterDeniedUserDelete = await admin.query(
      `SELECT
         (SELECT count(*) FROM business_memberships WHERE account_id = $1 AND user_id = $2) AS primary_memberships,
         (SELECT count(*) FROM business_memberships WHERE account_id = $3 AND user_id = $2 AND status = 'active') AS other_company_memberships,
         (SELECT count(*) FROM technician_skills WHERE account_id = $1 AND user_id = $2) AS skills,
         (SELECT count(*) FROM technician_availability WHERE account_id = $1 AND user_id = $2) AS availability`,
      [accountA, unassignedUserA, accountB],
    );
    expect(afterDeniedUserDelete.rows[0]).toEqual({
      primary_memberships: "1", other_company_memberships: "1", skills: "1", availability: "1",
    });
    await withTenantTransaction(session, (client) => client.query(
      `DELETE FROM business_memberships WHERE account_id = $1 AND user_id = $2`,
      [accountA, unassignedUserA],
    ));
  });

  it("serializes competing owner downgrades so at least one owner remains", async () => {
    await admin.query(
      `UPDATE business_memberships SET role = 'owner' WHERE account_id = $1 AND user_id = $2 AND status = 'active'`,
      [accountA, userA],
    );
    await admin.query(
      `UPDATE business_memberships SET role = 'tech' WHERE account_id = $1 AND user_id = $2 AND status = 'active'`,
      [accountA, extraOwnerA],
    );
    await admin.query(
      `UPDATE business_memberships SET role = 'owner' WHERE account_id = $1 AND user_id = $2 AND status = 'active'`,
      [accountA, userATech],
    );
    const secondOwnerSession = { ...session, userId: userATech };
    let releaseFirst!: () => void;
    let signalFirstLocked!: () => void;
    let signalSecondRequested!: () => void;
    const firstLocked = new Promise<void>((resolve) => { signalFirstLocked = resolve; });
    const secondRequested = new Promise<void>((resolve) => { signalSecondRequested = resolve; });
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withTenantTransaction(session, async (client) => {
      await lockOwnerMembershipChanges(client, accountA);
      signalFirstLocked();
      await holdFirst;
      const { rows } = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM business_memberships
          WHERE account_id = $1 AND status = 'active' AND role = 'owner'`, [accountA],
      );
      expect(rows[0]?.cnt).toBe(2);
      await client.query(
        `UPDATE business_memberships SET role = 'tech'
          WHERE account_id = $1 AND user_id = $2 AND status = 'active'`,
        [accountA, userA],
      );
    });

    await firstLocked;
    let remainingOwners = 0;
    const second = withTenantTransaction(secondOwnerSession, async (client) => {
      const lockRequest = lockOwnerMembershipChanges(client, accountA);
      signalSecondRequested();
      await lockRequest;
      const { rows } = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM business_memberships
          WHERE account_id = $1 AND status = 'active' AND role = 'owner'`, [accountA],
      );
      remainingOwners = rows[0]?.cnt ?? 0;
      if (remainingOwners <= 1) return "blocked";
      await client.query(
        `UPDATE business_memberships SET role = 'tech'
          WHERE account_id = $1 AND user_id = $2 AND status = 'active'`,
        [accountA, userATech],
      );
      return "downgraded";
    });
    await secondRequested;
    releaseFirst();
    const [, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe("blocked");
    expect(remainingOwners).toBe(1);
    await withTenantTransaction(secondOwnerSession, async (client) => {
      expect((await client.query(
        `SELECT user_id FROM business_memberships WHERE account_id = $1 AND status = 'active' AND role = 'owner'`,
        [accountA],
      )).rows).toEqual([{ user_id: userATech }]);
    });
  });
});
