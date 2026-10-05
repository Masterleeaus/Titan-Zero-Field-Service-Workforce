/**
 * Native Titan FSM technician-skill implementation.
 * Preserve skill/proficiency behavior and converge it with the broader Titan
 * Workforce capability graph. Optional Frappe HR skill records are provider data,
 * not Titan execution authority and not a default replacement.
 */
import type { DbClient } from "@/lib/db-contract";

export type TechnicianSkill = {
  skillId: string;
  name: string;
  category: string | null;
  proficiency: number | null;
};

type SkillRow = {
  user_id: string;
  skill_id: string;
  name: string;
  category: string | null;
  proficiency: number | null;
};

export async function loadTechnicianSkills(client: DbClient, accountId: string) {
  const { rows } = await client.query<SkillRow>(
    `SELECT ts.user_id, ts.skill_id, ws.name, ws.category, ts.proficiency
       FROM technician_skills ts
       JOIN workforce_skills ws ON ws.id = ts.skill_id AND ws.account_id = ts.account_id
      WHERE ts.account_id = $1 AND ws.active = TRUE
      ORDER BY ts.user_id, ws.category, ws.name`,
    [accountId],
  );
  const byUser = new Map<string, TechnicianSkill[]>();
  for (const row of rows) {
    const current = byUser.get(row.user_id) ?? [];
    current.push({ skillId: row.skill_id, name: row.name, category: row.category, proficiency: row.proficiency == null ? null : Number(row.proficiency) });
    byUser.set(row.user_id, current);
  }
  return byUser;
}
