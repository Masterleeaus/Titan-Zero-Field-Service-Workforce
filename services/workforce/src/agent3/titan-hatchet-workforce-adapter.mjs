/**
 * Adapter at Titan's existing WorkforceRuntimeAdapter.wake() boundary.
 *
 * The canonical workforce keeps work identity, assignment, durable history,
 * effective authority, evidence and recovery. Hatchet is only the external
 * orchestrator. All reservation/state methods belong to the existing Titan
 * runtime and MUST be implemented with its canonical durable storage.
 *
 * In particular: never call Hatchet before reserveDispatch has atomically
 * reserved (company_id, work_id) in canonical storage. If acknowledgement is
 * lost, mark it UNCERTAIN and reconcile out of band. No automatic redispatch.
 */
import { createHash } from 'node:crypto';
import { validId } from './titan-canonical-receiver.mjs';

const allowedPlacement = value => value && typeof value === 'object' && validId(value.hatchet_tenant_id)
  && typeof value.credential_ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\-/]{0,255}$/.test(value.credential_ref)
  && !('secret' in value) && !('token' in value) && !('password' in value);
function requireMethod(port, name) {
  if (typeof port?.[name] !== 'function') throw new TypeError(`canonical runtime port required: ${name}`);
}

/**
 * @param {Object} ports
 * @param {Object} ports.workforceStore - canonical get(company_id,work_id)
 * @param {Object} ports.workerStore - canonical getWorker(company_id,worker_id)
 * @param {Function} ports.authorize - effective decision from Titan authority owner
 * @param {Function} ports.resolvePlacement - fixed tenant + opaque credential ref
 * @param {Function} ports.reserveDispatch - atomic durable uniqueness reservation
 * @param {Function} ports.submitAuthorized - connector-owned transport to Hatchet
 * @param {Function} ports.markAccepted - durable run identity recording
 * @param {Function} ports.markUncertain - durable unknown-result recording
 */
export function createHatchetWorkforceAdapter(ports) {
  requireMethod(ports?.workforceStore,'get');
  requireMethod(ports?.workerStore,'getWorker');
  for (const method of ['authorize','resolvePlacement','reserveDispatch','submitAuthorized','markAccepted','markUncertain']) {
    requireMethod(ports,method);
  }
  return Object.freeze({
    async wake({company_id,work_id,worker_id}) {
      if (![company_id,work_id,worker_id].every(validId)) throw new Error('invalid canonical workforce identity');
      const [work,worker] = await Promise.all([
        ports.workforceStore.get(company_id,work_id), ports.workerStore.getWorker(company_id,worker_id),
      ]);
      if (!work || !worker || work.company_id !== company_id || worker.company_id !== company_id) throw new Error('company-bound worker/work missing');
      if (work.work_id !== work_id || worker.worker_id !== worker_id || work.assignee !== worker_id || work.state !== 'READY') throw new Error('canonical work is not assigned and ready');
      if (worker.kind !== 'digital' || worker.active !== true) throw new Error('canonical worker is not active digital worker');
      if (!Array.isArray(work.required_capabilities) || !Array.isArray(worker.capabilities) ||
          !work.required_capabilities.every(cap => worker.capabilities.includes(cap))) throw new Error('canonical worker missing capability');
      const authority = await ports.authorize({company_id,work_id,worker_id,action:'hatchet.workflow.enqueue'});
      if (!authority || authority.allowed !== true || !validId(authority.decision_ref) || authority.company_id !== company_id || authority.work_id !== work_id)
        throw new Error('effective authority denied');
      const placement = await ports.resolvePlacement({company_id,work_id,worker_id});
      if (!allowedPlacement(placement)) throw new Error('approved Hatchet placement unavailable');
      // Reserve a stable key before any external effect. This is canonical
      // transport state, not another Titan business-task ledger.
      const rawKey = `hatchet:${company_id}:${work_id}`;
      const key = validId(rawKey) ? rawKey : `hatchet-sha256:${createHash('sha256').update(rawKey).digest('hex')}`;
      const reservation = await ports.reserveDispatch({company_id,work_id,worker_id,idempotency_key:key,decision_ref:authority.decision_ref});
      if (!reservation || !validId(reservation.reservation_id) || typeof reservation.created !== 'boolean') throw new Error('canonical dispatch reservation unavailable');
      if (!reservation.created) return {state:'ALREADY_RESERVED',work_id,dispatch_ref:reservation.reservation_id};
      try {
        // The reservation prevents duplicate starts but does NOT itself
        // confer authority. Re-read canonical assignment, active worker,
        // effective decision and tenant placement directly before egress.
        const [currentWork,currentWorker]=await Promise.all([
          ports.workforceStore.get(company_id,work_id),ports.workerStore.getWorker(company_id,worker_id),
        ]);
        if (!currentWork || !currentWorker || currentWork.company_id!==company_id || currentWorker.company_id!==company_id ||
            currentWork.work_id!==work_id || currentWorker.worker_id!==worker_id ||
            currentWork.assignee!==worker_id || currentWork.state!=='READY' ||
            currentWorker.kind!=='digital' || currentWorker.active!==true ||
            !Array.isArray(currentWork.required_capabilities) || !Array.isArray(currentWorker.capabilities) ||
            !currentWork.required_capabilities.every(cap=>currentWorker.capabilities.includes(cap)))
          throw new Error('canonical assignment or worker changed after reservation');
        const latestAuthority=await ports.authorize({company_id,work_id,worker_id,action:'hatchet.workflow.enqueue'});
        if (latestAuthority?.allowed!==true || latestAuthority.company_id!==company_id || latestAuthority.work_id!==work_id ||
            latestAuthority.decision_ref!==authority.decision_ref)
          throw new Error('effective authority changed after reservation');
        const currentPlacement=await ports.resolvePlacement({company_id,work_id,worker_id});
        if (!allowedPlacement(currentPlacement) || currentPlacement.hatchet_tenant_id!==placement.hatchet_tenant_id ||
            currentPlacement.credential_ref!==placement.credential_ref)
          throw new Error('Hatchet placement changed after reservation');
        const result = await ports.submitAuthorized({company_id,work_id,worker_id,
          tenant:placement.hatchet_tenant_id, credential_ref:placement.credential_ref,
          idempotency_key:key, decision_ref:authority.decision_ref,
          reservation_id:reservation.reservation_id });
        if (!result || !validId(result.hatchet_run_id)) throw new Error('Hatchet run acknowledgement absent');
        await ports.markAccepted({company_id,work_id,reservation_id:reservation.reservation_id,hatchet_run_id:result.hatchet_run_id});
        return {state:'ACCEPTED',work_id,dispatch_ref:reservation.reservation_id,hatchet_run_id:result.hatchet_run_id};
      } catch (error) {
        // The external call may have succeeded. Even if marking UNCERTAIN fails,
        // the original durable reservation blocks a second submission.
        try { await ports.markUncertain({company_id,work_id,reservation_id:reservation.reservation_id}); }
        catch { /* report error, but never launch a duplicate */ }
        throw new Error('Hatchet dispatch uncertain; reconcile canonical reservation before retry', {cause:error});
      }
    },
  });
}
