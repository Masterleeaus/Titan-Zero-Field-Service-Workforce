/** Read-only bindings to EXISTING canonical workforce / evidence owners.
 *
 * The `workforceStore` contract mirrors SqliteWorkforceStore:
 *   list(companyId), listWorkers(companyId)
 * Execution records here are counted only for workforce display. Smart Tasks
 * and approvals must come from their OWN canonical projections/ledger owners.
 * The returned ports are intentionally not a persistence engine or scheduler.
 */
import { validId } from './titan-canonical-receiver.mjs';

// Cancellation is not a failure; keep distinct status classifications.
const TERMINAL_FAILURE = new Set(['FAILED']);
const RUNNING = new Set(['CLAIMED', 'IN_PROGRESS']);
const WAITING = new Set(['CREATED', 'READY', 'BLOCKED', 'WAITING', 'WAITING_APPROVAL', 'WAITING_EXTERNAL']);
function required(owner, name) {
  if (typeof owner?.[name] !== 'function') throw new TypeError(`canonical owner port required: ${name}`);
}
function assertCompany(rows, company_id) {
  if (!Array.isArray(rows) || rows.some(x => !x || x.company_id !== company_id)) throw new Error('company-isolated canonical query required');
  return rows;
}
/** All accessors must resolve via the caller's authorized canonical context. */
export function makeRuntimeReadPorts({ workforceStore, authorization, evidence, approvals, smartTasks }) {
  required(workforceStore, 'list'); required(workforceStore, 'listWorkers');
  required(authorization, 'authorizeBridge');
  required(evidence, 'verifyAcceptedOutcome');
  required(approvals, 'verifiedPendingCount');
  required(smartTasks, 'verifiedTotals');
  return Object.freeze({
    authorizeBridge: authorization.authorizeBridge.bind(authorization),
    async verifyOutcome(input) {
      if (!validId(input.company_id)) throw new Error('invalid company');
      // evidence owner looks up immutable accepted receipts and verifies the
      // matching business outcome; never accept a transient worker result.
      return evidence.verifyAcceptedOutcome(input);
    },
    async project({ company_id, module }) {
      if (!validId(company_id)) throw new Error('invalid company');
      if (module === 'workforce') {
        const [works, workers] = await Promise.all([workforceStore.list(company_id), workforceStore.listWorkers(company_id)]);
        assertCompany(works, company_id); assertCompany(workers, company_id);
        // Fail closed on duplicate identities, even if the underlying
        // canonical query accidentally duplicated rows through a join.
        const employeeIds=new Set();
        for (const worker of workers) {
          if (!validId(worker.worker_id) || employeeIds.has(worker.worker_id))
            throw new Error('canonical-worker-projection-identity-ambiguous');
          employeeIds.add(worker.worker_id);
        }
        const workIds=new Set();
        for (const work of works) {
          if (!validId(work.work_id) || workIds.has(work.work_id))
            throw new Error('canonical-work-projection-identity-ambiguous');
          workIds.add(work.work_id);
        }
        return {
          employees_active: workers.filter(w => w.active === true && w.kind === 'digital').length,
          running_workflows: works.filter(w => RUNNING.has(w.state)).length,
          waiting_workflows: works.filter(w => WAITING.has(w.state)).length,
          failed_workflows: works.filter(w => TERMINAL_FAILURE.has(w.state)).length,
        };
      }
      if (module === 'approvals') {
        const pending_count = await approvals.verifiedPendingCount({ company_id });
        return { pending_count };
      }
      if (module === 'smart_tasks') {
        const value = await smartTasks.verifiedTotals({ company_id });
        // No local fallback: this result must be a fold of accepted outcomes.
        return value;
      }
      throw new Error('unsupported projection');
    },
  });
}
