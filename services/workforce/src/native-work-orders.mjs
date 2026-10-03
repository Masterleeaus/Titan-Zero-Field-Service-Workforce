import * as leadAccess from "../../../apps/web/lib/work-orders/lead-access.ts";

const completeAssignedWorkOrder = leadAccess.completeAssignedWorkOrder
  ?? leadAccess.default?.completeAssignedWorkOrder;
if (typeof completeAssignedWorkOrder !== "function") throw new Error("workforce-native-work-order-owner-unavailable");

const dispositions = new Set(["ok", "fix_now", "monitor", "optional", "refer"]);

/** Read task lineage from the attested company's canonical visit/task rows.
 * Older schema profiles have no persisted visit-local disposition and therefore
 * cannot produce a task reference. A whole work order can map to one task only
 * when the completed company rows identify exactly one eligible link.
 */
async function readEvidenceContext(storage, input) {
  const columns = await storage.query("PRAGMA table_info(visit_tasks)");
  if (!columns.rows.some(column => column.name === "disposition")) return null;
  const rows = await storage.query(
    `SELECT v.id AS visit_id, vt.task_id, vt.disposition
       FROM visits v
       JOIN visit_tasks vt ON vt.company_id=v.company_id AND vt.visit_id=v.id AND vt.work_order_id=v.work_order_id
       JOIN work_order_tasks task ON task.company_id=vt.company_id AND task.id=vt.task_id AND task.work_order_id=vt.work_order_id
      WHERE v.company_id=$1 AND v.work_order_id=$2 AND v.assigned_user_id=$3
        AND v.status='completed' AND v.completed_at IS NOT NULL
        AND task.completed=1 AND task.status='done'
        AND vt.disposition IN ('ok','fix_now','monitor','optional','refer')
      ORDER BY v.id,vt.task_id`,
    [input.company_id, input.work_order_id, input.actor_id],
  );
  if (rows.rowCount !== 1) return null;
  const row = rows.rows[0];
  if (typeof row.visit_id !== "string" || !row.visit_id.trim()
    || typeof row.task_id !== "string" || !row.task_id.trim()
    || !dispositions.has(row.disposition)) return null;
  return Object.freeze({ company_id: input.company_id, work_order_id: input.work_order_id,
    visit_id: row.visit_id, task_id: row.task_id, disposition: row.disposition });
}

/** Thin production adapter over the existing native TypeScript owner. */
export function createNativeWorkOrders() {
  return Object.freeze({
    async read(input) {
      input.signal?.throwIfAborted();
      const rows = await input.companyStorage.query(
        "SELECT id,status,completed_at FROM work_orders WHERE company_id=$1 AND id=$2 AND assigned_user_id=$3",
        [input.company_id, input.work_order_id, input.actor_id],
      );
      input.signal?.throwIfAborted();
      const row = rows.rows[0];
      if (!row) return null;
      const evidence_context = await readEvidenceContext(input.companyStorage, input);
      input.signal?.throwIfAborted();
      return { ...row, evidence_context };
    },
    async complete(input) {
      input.signal?.throwIfAborted();
      if (typeof input.authorityFence?.assertCurrent !== "function") {
        throw new Error("workforce-authority-fence-required");
      }
      const result = await input.companyStorage.transaction(async tx => {
        const completed = await completeAssignedWorkOrder(
          tx, input.work_order_id, input.company_id, input.actor_id, input.authorityFence,
        );
        const evidence_context = completed.kind === "ok" ? await readEvidenceContext(tx, input) : null;
        return { ...completed, evidence_context };
      });
      input.signal?.throwIfAborted();
      return result;
    },
  });
}
