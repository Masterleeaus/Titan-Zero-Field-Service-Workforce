/**
 * Operator read/repair lane around Titan's already-authorized reconciler.
 * This does not schedule, resend, replay or mark business evidence verified.
 * All work stays in the company's registered canonical durable table.
 */
import { validId } from './titan-canonical-receiver.mjs';
const fail=code=>{throw new Error(`agent3-recovery-${code}`);};
const credentialRef=value=>typeof value==='string'&&value.length>0&&value.length<=256&&/^[A-Za-z0-9][A-Za-z0-9._:/-]+$/.test(value);
export function createAgent3RecoveryOperations({durable,reconciler,transport,resolvePlacement,authorizeRecovery}={}) {
  for(const [object,method] of [[durable,'listUncertain'],[reconciler,'reconcile'],
    [transport,'workerHealth'],[transport,'requestCancellation']]) {
    if(typeof object?.[method]!=='function') throw new TypeError(`agent3-recovery-port-required:${method}`);
  }
  if(typeof resolvePlacement!=='function'||typeof authorizeRecovery!=='function') throw new TypeError('agent3-recovery-trusted-ports-required');
  const assertScope=async({company_id,actor_id,action})=>{
    if(!validId(company_id)||!validId(actor_id)) fail('identity-invalid');
    const permission=await authorizeRecovery({company_id,actor_id,action});
    if(permission?.allowed!==true || permission.company_id!==company_id ||
       !validId(permission.decision_ref)) fail('authority-denied');
  };
  return Object.freeze({
    async inspect({company_id,actor_id,limit=50}) {
      if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('limit-invalid');
      await assertScope({company_id,actor_id,action:'hatchet.recovery.inspect'});
      const rows=await durable.listUncertain({company_id,limit});
      if(!Array.isArray(rows)||rows.length>limit || rows.some(r=>r.company_id!==company_id ||
          !['RESERVED','UNCERTAIN'].includes(r.state) || !validId(r.reservation_id))) fail('listing-invalid');
      return Object.freeze({company_id,total:rows.length,
        items:Object.freeze(rows.map(r=>Object.freeze({company_id:r.company_id,work_id:r.work_id,
          reservation_id:r.reservation_id,state:r.state,requires_reconciliation:true,safe_to_retry:false})))});
    },
    async reconcileOne({company_id,actor_id,work_id}) {
      if(!validId(work_id))fail('work-id-invalid');
      await assertScope({company_id,actor_id,action:'hatchet.recovery.reconcile'});
      return reconciler.reconcile({company_id,actor_id,work_id});
    },
    async cancelAccepted({company_id,actor_id,work_id}) {
      if(!validId(work_id))fail('work-id-invalid');
      await assertScope({company_id,actor_id,action:'hatchet.recovery.cancel'});
      const row=await durable.getDispatch({company_id,work_id});
      if(row?.state!=='ACCEPTED'||row.company_id!==company_id||!validId(row.hatchet_run_id))
        fail('run-not-accepted');
      const placement=await resolvePlacement({company_id,work_id});
      if(!placement || !validId(placement.hatchet_tenant_id)||
         !credentialRef(placement.credential_ref) || 'token' in placement || 'secret' in placement)
        fail('placement-invalid');
      return transport.requestCancellation({company_id,work_id,actor_id,
        tenant:placement.hatchet_tenant_id,credential_ref:placement.credential_ref,
        hatchet_run_id:row.hatchet_run_id});
    },
    async workerReady({company_id,actor_id,worker_id}) {
      if(!validId(worker_id))fail('worker-id-invalid');
      await assertScope({company_id,actor_id,action:'hatchet.workers.health'});
      const place=await resolvePlacement({company_id,worker_id});
      if(!place || !validId(place.hatchet_tenant_id)||!credentialRef(place.credential_ref)||
         'secret' in place || 'token' in place)fail('placement-invalid');
      return transport.workerHealth({company_id,work_id:'operator-health',worker_id,
        tenant:place.hatchet_tenant_id,credential_ref:place.credential_ref});
    },
  });
}
