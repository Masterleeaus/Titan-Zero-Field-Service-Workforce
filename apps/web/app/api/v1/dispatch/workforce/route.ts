import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/middleware";
import type { AuthSession } from "@/lib/auth/middleware";
import { withTenantTransaction } from "@/lib/db/portable";
import { loadCompanyMemberDirectory } from "@/lib/workforce/member-directory";

export const dynamic = "force-dynamic";

const availabilitySchema = z.object({
  action: z.literal("add_availability"),
  user_id: z.string().uuid(),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  specific_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  availability_kind: z.enum(["available", "unavailable"]).default("available"),
  note: z.string().max(500).nullable().optional(),
}).refine((v) => (v.weekday == null) !== (v.specific_date == null), { message: "Provide exactly one of weekday or specific_date" });

const skillSchema = z.object({
  action: z.literal("assign_skill"),
  user_id: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().max(120).nullable().optional(),
  proficiency: z.number().int().min(1).max(5).nullable().optional(),
});
// availabilitySchema has a refinement, so Zod wraps it in ZodEffects and it
// cannot participate in discriminatedUnion. The literal action fields still
// provide the same safe narrowing after parsing.
const bodySchema = z.union([availabilitySchema, skillSchema]);

function requireManager(session: AuthSession) {
  return ["owner", "admin"].includes(session.role);
}

export const GET = withAuth(async (_request: NextRequest, session: AuthSession) => {
  if (!requireManager(session)) return NextResponse.json({ error: { code: "FORBIDDEN", message: "Owner or admin role required" } }, { status: 403 });
  const data = await withTenantTransaction(session, async (client, accountId) => {
    const [members, skills, availability] = await Promise.all([
      loadCompanyMemberDirectory(client, accountId),
      client.query(`SELECT ts.user_id, ws.id AS skill_id, ws.name, ws.category, ts.proficiency FROM technician_skills ts JOIN workforce_skills ws ON ws.id = ts.skill_id AND ws.account_id = ts.account_id WHERE ts.account_id = $1 AND ws.active = TRUE ORDER BY ts.user_id, ws.name`, [accountId]),
      client.query(`SELECT id, user_id, weekday, specific_date, start_time, end_time, availability_kind, note FROM technician_availability WHERE account_id = $1 ORDER BY user_id, specific_date, weekday, start_time`, [accountId]),
    ]);
    return {
      members: members.map(({ id, ...member }) => ({ user_id: id, ...member })),
      skills: skills.rows,
      availability: availability.rows,
    };
  });
  return NextResponse.json({ data });
});

export const POST = withAuth(async (request: NextRequest, session: AuthSession) => {
  if (!requireManager(session)) return NextResponse.json({ error: { code: "FORBIDDEN", message: "Owner or admin role required" } }, { status: 403 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "Invalid workforce update", details: parsed.error.flatten() } }, { status: 422 });

  try {
    await withTenantTransaction(session, async (client, accountId) => {
      const member = await client.query(`SELECT id FROM business_memberships WHERE account_id = $1 AND user_id = $2 AND status = 'active'`, [accountId, parsed.data.user_id]);
      if (!member.rows[0]) throw new Error("MEMBER_NOT_FOUND");
      if (parsed.data.action === "add_availability") {
        await client.query(
          `INSERT INTO technician_availability (id, account_id, user_id, weekday, specific_date, start_time, end_time, availability_kind, note, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          [randomUUID(), accountId, parsed.data.user_id, parsed.data.weekday ?? null, parsed.data.specific_date ?? null, parsed.data.start_time, parsed.data.end_time, parsed.data.availability_kind, parsed.data.note ?? null],
        );
      } else {
        const existing = await client.query<{ id: string }>(`SELECT id FROM workforce_skills WHERE account_id = $1 AND name = $2`, [accountId, parsed.data.name]);
        const skillId = existing.rows[0]?.id ?? randomUUID();
        if (!existing.rows[0]) await client.query(`INSERT INTO workforce_skills (id, account_id, name, category, active, created_at, updated_at) VALUES ($1,$2,$3,$4,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [skillId, accountId, parsed.data.name, parsed.data.category ?? null]);
        const assigned = await client.query(`SELECT skill_id FROM technician_skills WHERE account_id = $1 AND user_id = $2 AND skill_id = $3`, [accountId, parsed.data.user_id, skillId]);
        if (assigned.rows[0]) await client.query(`UPDATE technician_skills SET proficiency = $1, updated_at = CURRENT_TIMESTAMP WHERE account_id = $2 AND user_id = $3 AND skill_id = $4`, [parsed.data.proficiency ?? null, accountId, parsed.data.user_id, skillId]);
        else await client.query(`INSERT INTO technician_skills (account_id, user_id, skill_id, proficiency, created_at, updated_at) VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [accountId, parsed.data.user_id, skillId, parsed.data.proficiency ?? null]);
      }
    });
    return NextResponse.json({ data: { ok: true } });
  } catch (error) {
    if (error instanceof Error && error.message === "MEMBER_NOT_FOUND") return NextResponse.json({ error: { code: "NOT_FOUND", message: "Active business member not found" } }, { status: 404 });
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "Failed to update workforce configuration" } }, { status: 500 });
  }
});
