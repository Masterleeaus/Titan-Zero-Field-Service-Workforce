/**
 * Native Titan FSM human-workforce availability implementation.
 * Preserve availability behavior and improve storage/company-context portability.
 * Frappe HR may optionally extend/deepen HR capabilities, but does not replace
 * Titan availability or grant Titan Workforce authority by default.
 */
import type { DbClient } from "@/lib/db-contract";

export type AvailabilityKind = "available" | "unavailable";
export type AvailabilityWindow = {
  id: string;
  userId: string;
  weekday: number | null;
  specificDate: string | null;
  startTime: string;
  endTime: string;
  kind: AvailabilityKind;
  note: string | null;
};

type DbWindow = {
  id: string;
  user_id: string;
  weekday: number | null;
  specific_date: string | Date | null;
  start_time: string;
  end_time: string;
  availability_kind: AvailabilityKind;
  note: string | null;
};

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function minutesOfDay(value: string) {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function windowMinutesForDate(window: AvailabilityWindow, date: Date) {
  const key = dateKey(date);
  const applies = window.specificDate ? window.specificDate.slice(0, 10) === key : window.weekday === date.getDay();
  if (!applies) return 0;
  return Math.max(0, minutesOfDay(window.endTime) - minutesOfDay(window.startTime));
}

export function availableMinutesInRange(windows: AvailabilityWindow[], rangeStart: Date, rangeEnd: Date): number | null {
  if (!windows.length) return null;
  let total = 0;
  const cursor = new Date(rangeStart);
  cursor.setHours(0, 0, 0, 0);
  while (cursor < rangeEnd) {
    const dayKey = dateKey(cursor);
    const overrides = windows.filter((w) => w.specificDate?.slice(0, 10) === dayKey);
    const applicable = overrides.length ? overrides : windows.filter((w) => w.specificDate == null && w.weekday === cursor.getDay());
    const available = applicable.filter((w) => w.kind === "available").reduce((sum, w) => sum + windowMinutesForDate(w, cursor), 0);
    const unavailable = applicable.filter((w) => w.kind === "unavailable").reduce((sum, w) => sum + windowMinutesForDate(w, cursor), 0);
    total += Math.max(0, available - unavailable);
    cursor.setDate(cursor.getDate() + 1);
  }
  return total;
}

export function isWithinAvailability(windows: AvailabilityWindow[], start: Date, end: Date): boolean | null {
  if (!windows.length) return null;
  if (dateKey(start) !== dateKey(end)) return false;
  const key = dateKey(start);
  const overrides = windows.filter((w) => w.specificDate?.slice(0, 10) === key);
  const applicable = overrides.length ? overrides : windows.filter((w) => w.specificDate == null && w.weekday === start.getDay());
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end.getHours() * 60 + end.getMinutes();
  const blocked = applicable.some((w) => w.kind === "unavailable" && startMin < minutesOfDay(w.endTime) && endMin > minutesOfDay(w.startTime));
  if (blocked) return false;
  return applicable.some((w) => w.kind === "available" && startMin >= minutesOfDay(w.startTime) && endMin <= minutesOfDay(w.endTime));
}

export async function loadAvailabilityForAccount(client: DbClient, accountId: string): Promise<AvailabilityWindow[]> {
  const { rows } = await client.query<DbWindow>(
    `SELECT id, user_id, weekday, specific_date, start_time, end_time, availability_kind, note
       FROM technician_availability
      WHERE account_id = $1
      ORDER BY user_id, specific_date, weekday, start_time`,
    [accountId],
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    weekday: row.weekday == null ? null : Number(row.weekday),
    specificDate: row.specific_date == null ? null : (row.specific_date instanceof Date ? dateKey(row.specific_date) : String(row.specific_date).slice(0, 10)),
    startTime: String(row.start_time),
    endTime: String(row.end_time),
    kind: row.availability_kind,
    note: row.note,
  }));
}

export async function loadAvailability(client: DbClient, accountId: string, userIds?: string[]): Promise<AvailabilityWindow[]> {
  const result = await client.query<DbWindow>(
    `SELECT id, user_id, weekday, specific_date, start_time, end_time, availability_kind, note
       FROM technician_availability
      WHERE account_id = $1
      ORDER BY user_id, specific_date, weekday, start_time`,
    [accountId],
  );
  const filter = userIds?.length ? new Set(userIds) : null;
  return result.rows.filter((row) => !filter || filter.has(row.user_id)).map((row) => ({
    id: row.id,
    userId: row.user_id,
    weekday: row.weekday == null ? null : Number(row.weekday),
    specificDate: row.specific_date == null ? null : (row.specific_date instanceof Date ? dateKey(row.specific_date) : String(row.specific_date).slice(0, 10)),
    startTime: String(row.start_time),
    endTime: String(row.end_time),
    kind: row.availability_kind,
    note: row.note,
  }));
}
