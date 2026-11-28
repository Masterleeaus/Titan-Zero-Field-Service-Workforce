/**
 * Small adapter for Titan's EXISTING CompanyPlacementOperationGate interface.
 *
 * The operator resolves the gate by the current GLOBAL_REGISTRY placement_id,
 * NOT by a client path, provider-supplied tenant, token or mutable work payload.
 * `resolveGate` must be the same implementation used by canonical company
 * backup, restore and storage placement maintenance (acquireMaintenance).
 * `assertPhysicalBinding` must observe the selected company's live placement
 * through the canonical CompanyStoreOpener / bound store lease.
 *
 * No engine, authority, task ledger, filesystem lock or key is created here.
 */
import { validId } from './titan-canonical-receiver.mjs';
const denied=()=>{throw new Error('agent3-hosted-physical-gate-denied');};
export function createCanonicalPlacementGateAcquirer({resolveGate,assertPhysicalBinding,timeoutMs=15000}={}) {
  if(typeof resolveGate!=='function'||typeof assertPhysicalBinding!=='function'||
     !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)denied();
  return async function acquirePlacementOperation(placement,{signal}={}) {
    if(signal?.aborted||!placement||!validId(placement.company_id)||
       !validId(placement.placement_id)||
       !Number.isSafeInteger(placement.placement_revision)||placement.placement_revision<1||
       placement.provider!=='sqlite'||!validId(placement.schema_version))denied();
    // Never pass caller-supplied object identity through into the operator's
    // gate registry. It receives the canonical five-field descriptor only.
    const bound=Object.freeze({company_id:placement.company_id,
      placement_id:placement.placement_id,
      placement_revision:placement.placement_revision,
      provider:placement.provider,
      schema_version:placement.schema_version});
    let release,acquired=false;
    try {
      const gate=await resolveGate(bound,{signal});
      if(typeof gate?.acquireBorrowable!=='function' || typeof gate.acquireMaintenance!=='function')denied();
      const borrowed=await gate.acquireBorrowable({signal,timeoutMs});
      if(typeof borrowed?.run!=='function'||typeof borrowed?.release!=='function')denied();
      release=()=>borrowed.release();
      const runWithContext=operation=>borrowed.run(operation);
      acquired=true;
      let closed=false;
      const assertPlacementBound=async()=>{
        if(closed||signal?.aborted)denied();
        const observed=await assertPhysicalBinding(bound,{signal});
        if(!observed||observed.company_id!==bound.company_id||
           observed.placement_id!==bound.placement_id||
           observed.placement_revision!==bound.placement_revision||
           observed.provider!==bound.provider||
           observed.schema_version!==bound.schema_version)denied();
      };
      // The binding verifier may use a normal canonical native opener/query.
      // Therefore it MUST be called within the same minted borrowed scope.
      await runWithContext(assertPlacementBound);
      return Object.freeze({...bound,
        assertPlacementBound:()=>runWithContext(assertPlacementBound),runWithContext,
        async release(){
          if(closed)denied();
          closed=true;
          await release();
        },
      });
    }catch(error){
      if(acquired){try{await release();}catch{/* Preserve original failure */}}
      throw error;
    }
  };
}
