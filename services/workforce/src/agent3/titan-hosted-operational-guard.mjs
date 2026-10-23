/**
 * Agent 3 ingress/readiness fence for the real hosted Workforce composition.
 *
 * The host holds both the canonical runtime and its operator-commissioned
 * company placement. A stale storage placement, broken Agent 3 migration or
 * revoked company must stop EVERY existing host execution entrypoint before
 * native/Hatchet work is admitted. The source runtime is never monkey-patched.
 *
 * The per-request check is intentionally uncached. A stale positive cached
 * health response cannot grant execution authority after a placement change.
 * An operator health check covers the entire allowlist, not only recent users.
 */
import { validId } from './titan-canonical-receiver.mjs';

const fail=()=>{throw new Error('agent3-hosted-operation-denied');};
const method=(owner,name)=>typeof owner?.[name]==='function';

export function createHostedAgent3Operations({runtime,commissioning,signal}={}) {
  if (commissioning===undefined) return runtime; // No Agent 3: preserve canonical behavior.
  if (!runtime || !method(runtime,'dispatch') || !method(runtime,'recover') ||
      !runtime.zeroDispatcher || !method(runtime.zeroDispatcher,'cancel') ||
      !method(runtime.zeroDispatcher,'dispatch') ||
      !method(runtime.zeroDispatcher,'recoverInterrupted') ||
      !method(runtime.zeroDispatcher,'reconcilePersistedWork') ||
      !method(commissioning,'verifyHostedPreflight') ||
      !method(commissioning,'acquirePlacementOperation') ||
      commissioning.strictCommissioning!==true || commissioning.strictPhysicalFencing!==true) fail();

  async function verify({company_id}={}) {
    if (signal?.aborted || (company_id!==undefined && !validId(company_id))) fail();
    try {
      const result=await commissioning.verifyHostedPreflight(company_id ? {company_id} : {});
      if (signal?.aborted || result?.schema!=='titan.agent3.hosted-preflight/v1' ||
          result.status!=='verified' || !Number.isSafeInteger(result.companies_verified) ||
          result.companies_verified !== (company_id===undefined ? commissioning.companyCount : 1)) fail();
      return result;
    } catch { fail(); }
  }
  /** The preflight is an admission boundary, not a durable execution lease.
   * Revalidate after the native/remote call too: if company placement changes
   * mid-flight we cannot undo a provider effect, and MUST NOT return success.
   * Mark outcome uncertain and require canonical evidence reconciliation; never
   * make an automatic retry from this error.
   */
  async function execute(input,operation){
    if(!validId(input?.company_id))fail();
    const company_id=input.company_id;
    await verify({company_id});
    let lease;
    try{
      lease=await commissioning.acquirePlacementOperation(company_id);
      if(!lease||!method(lease,'assertCurrent')||!method(lease,'release'))fail();
      await lease.assertCurrent();
      await verify({company_id});
    }catch(error){
      if(lease&&method(lease,'release'))await lease.release().catch(()=>undefined);
      throw new Error('agent3-hosted-operation-denied',{cause:error});
    }
    let result,operationError,operationFailed=false,postError;
    try{
      if(signal?.aborted)fail();
      try{result=await operation();}
      catch(error){operationError=error;operationFailed=true;}
      try{await lease.assertCurrent();await verify({company_id});}
      catch(error){postError=error;}
    }finally{
      try{await lease.release();}
      catch(error){postError??=error;}
    }
    if(postError)throw new Error('agent3-hosted-outcome-uncertain',{cause:operationFailed?operationError:postError});
    if(operationFailed)throw operationError;
    return result;
  }
  // Expose only the operational projections consumed by the existing hosted
  // Workforce/DirectAdmin composition. Do not spread raw runtime, authority,
  // execution gateway, Agent 3 transport, provider controls or method hooks.
  const projections=Object.create(null);
  for (const key of ['storage','workforceStore','runStore','skillCapabilitySource']) {
    if (Object.prototype.hasOwnProperty.call(runtime,key)) projections[key]=runtime[key];
  }
  if (typeof runtime.project==='function') {
    projections.project=input=>execute(input,()=>runtime.project(input));
  }

  const zero=runtime.zeroDispatcher;
  // Do not spread the original dispatcher prototype or export other privileged
  // methods; only the known entrypoints are made available to hosted HTTP.
  const zeroDispatcher=Object.freeze({
    dispatch:input=>execute(input,()=>zero.dispatch(input)),
    recoverInterrupted:input=>execute(input,()=>zero.recoverInterrupted(input)),
    cancel:input=>execute(input,()=>zero.cancel(input)),
    reconcilePersistedWork:input=>execute(input,()=>zero.reconcilePersistedWork(input)),
  });
  // No public agent3 object or raw native runtime is exported from the hosted
  // surface: those are internal privileged ports, not authentication endpoints.
  return Object.freeze({
    ...projections,
    dispatch:input=>execute(input,()=>runtime.dispatch(input)),
    recover:input=>execute(input,()=>runtime.recover(input)),
    zeroDispatcher,
    verifyOperationalReady:()=>verify(),
  });
}
