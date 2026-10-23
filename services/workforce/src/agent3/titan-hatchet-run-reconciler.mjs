/** Read-only Hatchet reconciliation of pre-reserved canonical dispatches.
 *
 * Not a scheduler; never resubmits work. The external list call is tenant
 * credential scoped by the approved placement. A zero-result read is NOT proof
 * Hatchet did not accept a job (e.g. eventual consistency or lost metadata).
 */
import { validId } from './titan-canonical-receiver.mjs';
const exactId = (value,name) => { if (!validId(value)) throw new Error(`reconcile-invalid-${name}`); return value; };
const required = (o,n) => { if (typeof o?.[n] !== 'function') throw new TypeError(`reconcile-port-required:${n}`); };

export function createHatchetRunReconciler({ durable, resolvePlacement, listRunsByMetadata, authorizeReconcile, readRunStatus, requireCompletePage=false }) {
  required(durable,'getDispatch'); required(durable,'linkReconciled');
  if (typeof requireCompletePage!=='boolean') throw new TypeError('reconcile-complete-page-policy-invalid');
  if (typeof resolvePlacement !== 'function' || typeof listRunsByMetadata !== 'function' ||
      typeof authorizeReconcile !== 'function' || typeof readRunStatus !== 'function') throw new TypeError('reconciliation policy/transport ports required');
  return Object.freeze({
    async reconcile({company_id,work_id,actor_id}) {
      for (const [name,value] of Object.entries({company_id,work_id,actor_id})) exactId(value,name);
      const reservation = await durable.getDispatch({company_id,work_id});
      if (!reservation || reservation.company_id!==company_id || reservation.work_id!==work_id ||
          !validId(reservation.reservation_id) || !validId(reservation.idempotency_key) ||
          !['RESERVED','UNCERTAIN','ACCEPTED'].includes(reservation.state)) throw new Error('reconcile-reservation-unavailable');
      const permission=await authorizeReconcile({company_id,work_id,actor_id,reservation_id:reservation.reservation_id});
      if (permission?.allowed!==true || permission.company_id!==company_id || permission.work_id!==work_id || !validId(permission.decision_ref))
        throw new Error('reconcile-authorization-denied');
      if (reservation.state==='ACCEPTED') return {state:'ALREADY_ACCEPTED',work_id,hatchet_run_id:reservation.hatchet_run_id,safe_to_retry:false};
      const placement=await resolvePlacement({company_id,work_id});
      if (!placement || !validId(placement.hatchet_tenant_id) || typeof placement.credential_ref!=='string' || !placement.credential_ref ||
          Object.hasOwn(placement,'token') || Object.hasOwn(placement,'secret')) throw new Error('reconcile-placement-denied');
      // listRunsByMetadata must return a FULL page or throw. Never truncate
      // to a single candidate and infer that it is unique.
      const page=await listRunsByMetadata({company_id,work_id,tenant:placement.hatchet_tenant_id,
        credential_ref:placement.credential_ref, idempotency_key:reservation.idempotency_key, limit:101});
      // An ordinary array does not prove the provider returned EVERY matching
      // run. Production reconciliation requires an explicit completeness proof,
      // otherwise a truncated one-item page could hide a duplicate execution.
      // Legacy test adapters may opt out, but strict commissioning cannot.
      const hasProof = page && !Array.isArray(page) && typeof page==='object' &&
        page.complete===true && page.next_cursor===null && Number.isSafeInteger(page.total) &&
        page.total>=0 && Array.isArray(page.runs) && page.total===page.runs.length;
      if (requireCompletePage && !hasProof) throw new Error('reconcile-page-completeness-unverified');
      const found=hasProof?page.runs:page;
      if (!Array.isArray(found) || found.length>100) throw new Error('reconcile-unbounded-or-incomplete-results');
      const runIds=new Set();
      for (const record of found) {
        if (!record || typeof record!=='object' || record.company_id!==company_id || record.work_id!==work_id ||
            record.idempotency_key!==reservation.idempotency_key || record.tenant!==placement.hatchet_tenant_id ||
            !validId(record.hatchet_run_id)) throw new Error('reconcile-unverifiable-run');
        runIds.add(record.hatchet_run_id);
      }
      // A provider inventory with repeated records is ambiguous, even when
      // those records carry the SAME Hatchet run ID. Never collapse them
      // into a unique run or release uncertain work for automatic retry.
      if (runIds.size!==found.length) return {state:'MULTIPLE_RUNS_REVIEW',work_id,count:found.length,safe_to_retry:false};
      if (runIds.size===0) return {state:'NOT_FOUND_INCONCLUSIVE',work_id,safe_to_retry:false};
      if (runIds.size!==1) return {state:'MULTIPLE_RUNS_REVIEW',work_id,count:runIds.size,safe_to_retry:false};
      const hatchet_run_id=[...runIds][0];
      const detail=await readRunStatus({company_id,work_id,tenant:placement.hatchet_tenant_id,
        credential_ref:placement.credential_ref,hatchet_run_id});
      if (!detail || detail.hatchet_run_id!==hatchet_run_id || detail.tenant!==placement.hatchet_tenant_id ||
          typeof detail.status!=='string' || !detail.status.trim()) throw new Error('reconcile-run-detail-unverified');
      await durable.linkReconciled({company_id,work_id,reservation_id:reservation.reservation_id,hatchet_run_id});
      return {state:'LINKED_EXISTING_RUN',work_id,hatchet_run_id,hatchet_status:detail.status,safe_to_retry:false,
        business_outcome_verified:false};
    },
  });
}
