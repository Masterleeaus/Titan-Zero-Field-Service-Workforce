import type { VisitChecklistItem } from "@titan-zero/domain";
import type { CurrentWebSession } from "../auth/current-session";
import type { StorageClient } from "../../../../packages/storage/src/index";

export type NativeVisitChecklistItem = VisitChecklistItem & Readonly<{ company_id: string }>;

export type ChecklistPatch = Readonly<{
  disposition?: "ok" | "fix_now" | "monitor" | "optional" | "refer" | null;
  note?: string | null;
}>;

type VisitRow = {
  id: string;
  job_id: string;
  property_id: string | null;
  resolved_property_id: string | null;
  assigned_user_id: string | null;
  work_order_id: string | null;
};
type ItemRow = {
  id: string;
  company_id: string;
  visit_id: string;
  section: string;
  item_key: string;
  label: string;
  disposition: NativeVisitChecklistItem["disposition"];
  note: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function timestamp(value: string): string {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) throw new Error("native-checklist-timestamp-invalid");
  return parsed.toISOString();
}

function checklistItem(row: ItemRow): NativeVisitChecklistItem {
  return Object.freeze({
    id: row.id,
    company_id: row.company_id,
    account_id: row.company_id,
    visit_id: row.visit_id,
    section: row.section,
    item_key: row.item_key,
    label: row.label,
    disposition: row.disposition ?? null,
    note: row.note,
    sort_order: row.sort_order,
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  });
}

async function authorizedVisit(
  storage: StorageClient,
  currentSession: CurrentWebSession,
  visitId: string,
): Promise<VisitRow | null> {
  const companyId = currentSession.context.company_id;
  const rows = await storage.query<VisitRow>(
    `SELECT v.id, v.job_id, j.property_id, p.id AS resolved_property_id,
            v.assigned_user_id, v.work_order_id
       FROM visits v
       JOIN jobs j ON j.company_id = v.company_id AND j.id = v.job_id
       LEFT JOIN properties p ON p.company_id = j.company_id AND p.id = j.property_id
      WHERE v.company_id = $1 AND v.id = $2`,
    [companyId, visitId],
  );
  const visit = rows.rows[0];
  if (!visit) return null;
  if (visit.property_id !== visit.resolved_property_id) return null;
  if (currentSession.session.role === "tech" && visit.assigned_user_id !== currentSession.context.actor_id) return null;
  return visit;
}

async function readChecklist(
  storage: StorageClient,
  currentSession: CurrentWebSession,
  visitId: string,
): Promise<NativeVisitChecklistItem[]> {
  const visit = await authorizedVisit(storage, currentSession, visitId);
  if (!visit) return [];
  if (!visit.work_order_id) return [];
  const rows = await storage.query<ItemRow>(
    `SELECT task.id, vt.company_id, vt.visit_id, vt.section, vt.item_key, task.label,
            vt.disposition, vt.note, task.sort_order, vt.created_at, vt.updated_at
       FROM visit_tasks vt
       JOIN work_order_tasks task
         ON task.company_id = vt.company_id
        AND task.id = vt.task_id
        AND task.work_order_id = vt.work_order_id
      WHERE vt.company_id = $1 AND vt.visit_id = $2 AND vt.work_order_id = $3
      ORDER BY vt.section, task.sort_order, vt.item_key`,
    [currentSession.context.company_id, visitId, visit.work_order_id],
  );
  return rows.rows.map(checklistItem);
}

/** Read the visit's already-configured visit_tasks relation; never seeds or
 * fabricates a cleaning template from a surface request. */
export async function listNativeVisitChecklist(
  storage: StorageClient,
  currentSession: CurrentWebSession,
  visitId: string,
): Promise<Readonly<{
  visit: Readonly<{ company_id: string; visit_id: string; job_id: string; property_id: string | null; work_order_id: string | null }>;
  items: NativeVisitChecklistItem[];
}> | null> {
  const visit = await authorizedVisit(storage, currentSession, visitId);
  if (!visit) return null;
  return Object.freeze({
    visit: Object.freeze({
      company_id: currentSession.context.company_id,
      visit_id: visit.id,
      job_id: visit.job_id,
      property_id: visit.property_id,
      work_order_id: visit.work_order_id,
    }),
    items: await readChecklist(storage, currentSession, visitId),
  });
}

/** Update visit-local checklist state while keeping work-order task lifecycle
 * fields independent. The relation's company/visit/task/work-order keys are
 * checked together in the update predicate. */
export async function updateNativeVisitChecklistItem(
  storage: StorageClient,
  currentSession: CurrentWebSession,
  visitId: string,
  taskId: string,
  patch: ChecklistPatch,
): Promise<NativeVisitChecklistItem | null> {
  const companyId = currentSession.context.company_id;
  return storage.transaction(async tx => {
    const visit = await authorizedVisit(tx, currentSession, visitId);
    if (!visit?.work_order_id) return null;
    const values: unknown[] = [companyId, visitId, visit.work_order_id, taskId];
    const fields: string[] = [];
    if (patch.disposition !== undefined) {
      values.push(patch.disposition);
      fields.push(`disposition = $${values.length}`);
    }
    if (patch.note !== undefined) {
      values.push(patch.note);
      fields.push(`note = $${values.length}`);
    }
    if (fields.length === 0) return null;
    fields.push("updated_at = CURRENT_TIMESTAMP");
    const updated = await tx.query(
      `UPDATE visit_tasks SET ${fields.join(", ")}
        WHERE company_id = $1 AND visit_id = $2 AND work_order_id = $3 AND task_id = $4`,
      values,
    );
    if (updated.rowCount !== 1) return null;
    const items = await readChecklist(tx, currentSession, visitId);
    return items.find(item => item.id === taskId) ?? null;
  });
}
