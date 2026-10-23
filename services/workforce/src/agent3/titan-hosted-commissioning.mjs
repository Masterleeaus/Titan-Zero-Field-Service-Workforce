/**
 * Explicit operator-owned HOSTED commissioning gate. No public request or model
 * instruction can turn it on. This checks pre-existing per-company migrations
 * before a hosted Workforce process begins serving traffic; never auto-migrates.
 *
 * A trusted operator must independently attest current identity, authority,
 * evidence, transport, and native entrypoint reviews. This attestation is NOT
 * proof of live Hatchet availability or exhaustive bypass-path coverage.
 */
import { validId } from './titan-canonical-receiver.mjs';
import { createHostedPlacementFence } from './titan-hosted-placement-preflight.mjs';
import { assertAgent3SqliteMigrations } from './titan-hosted-schema-preflight.mjs';

const TABLES = Object.freeze(['agent3_bridge_nonces','agent3_hatchet_transport','agent3_execution_owner']);
const READY = Object.freeze(['identity','authority','evidence','transport','native_fences','placement']);
const fail = () => { throw new Error('agent3-hosted-commissioning-denied'); };

export async function resolveHostedAgent3Ports(setting, { signal, companyPlacementRegistry } = {}) {
  if (setting === undefined) return undefined; // Existing native host remains default.
  if (signal?.aborted) fail();
  if (!setting || setting.schema !== 'titan.agent3.hosted-commissioning/v1' ||
      setting.mode !== 'operator-authorized' || setting.enabled !== true ||
      !Array.isArray(setting.company_ids) || setting.company_ids.length === 0 || setting.company_ids.length > 1000 ||
      !setting.company_ids.every(validId) || new Set(setting.company_ids).size !== setting.company_ids.length ||
      typeof setting.assertReady !== 'function' || !setting.ports ||
      typeof setting.ports !== 'object' || Array.isArray(setting.ports) ||
      typeof setting.ports.resolveCompanyStorage !== 'function' ||
      typeof setting.ports.runtimeRoutingPolicy !== 'function' ||
      typeof setting.ports.acquirePlacementOperation !== 'function') fail();
  const companies = new Set(setting.company_ids);
  const attest = await setting.assertReady({company_ids: [...companies],signal});
  if (signal?.aborted || attest?.schema !== 'titan.agent3.hosted-readiness/v1' ||
      !Array.isArray(attest?.company_ids) || attest.company_ids.length !== companies.size ||
      !attest.company_ids.every(company_id => companies.has(company_id)) ||
      !READY.every(key => attest[key] === 'verified')) fail();
  const placement = await createHostedPlacementFence({company_ids:[...companies],companyPlacementRegistry,signal});
  const source = setting.ports.resolveCompanyStorage;
  const physicalAcquirer=setting.ports.acquirePlacementOperation;
  // Trusted operator selects the existing canonical cross-process gate.
  async function acquirePlacementOperation(company_id){
    if(!companies.has(company_id)||signal?.aborted)fail();
    const expected=await placement.assertCurrent(company_id);
    let lease;
    try{
      lease=await physicalAcquirer(expected,{signal});
      if(!lease||lease.company_id!==expected.company_id||
         lease.placement_id!==expected.placement_id||
         lease.placement_revision!==expected.placement_revision||
         typeof lease.assertPlacementBound!=='function'||typeof lease.release!=='function')fail();
      await lease.assertPlacementBound();
      await placement.assertCurrent(company_id);
      return Object.freeze({
        async assertCurrent(){
          if(signal?.aborted)fail();
          await lease.assertPlacementBound();
          await placement.assertCurrent(company_id);
        },
        release:async()=>lease.release(),
      });
    }catch(error){
      if(lease&&typeof lease.release==='function'){
        try{await lease.release();}catch{/* preserve original error */}
      }
      throw error;
    }
  }
  const seenStorage = new Set();
  for (const company_id of companies) {
    if (signal?.aborted) fail();
    await placement.assertCurrent(company_id);
    const storage=await source(company_id);
    if(seenStorage.has(storage))fail();
    seenStorage.add(storage);
    await assertAgent3SqliteMigrations(storage);
    const lease=await acquirePlacementOperation(company_id);
    try{await lease.assertCurrent();}finally{await lease.release();}
  }
  // Read-only post-startup diagnostic: verifies the same registered companies
  // still have the expected schema and placement. It does not test live Hatchet.
  async function verifyHostedPreflight({company_id:requestedCompany}={}){
    if(requestedCompany!==undefined && !companies.has(requestedCompany))fail();
    const targets=requestedCompany===undefined?[...companies]:[requestedCompany];
    const seen=new Set();
    for(const company_id of targets){
      if(signal?.aborted)fail();
      await placement.assertCurrent(company_id);
      const storage=await source(company_id);
      if(seen.has(storage))fail();
      seen.add(storage);
      await assertAgent3SqliteMigrations(storage);
      await placement.assertCurrent(company_id);
    }
    return Object.freeze({schema:'titan.agent3.hosted-preflight/v1',companies_verified:targets.length,status:'verified'});
  }
  return Object.freeze({
    ...setting.ports,
    verifyHostedPreflight,
    companyCount:companies.size,
    strictCommissioning:true,
    strictPhysicalFencing:true,
    acquirePlacementOperation,
    resolveCompanyStorage: async company_id => {
      if(!companies.has(company_id))fail();
      await placement.assertCurrent(company_id);
      const storage=await source(company_id);
      await placement.assertCurrent(company_id);
      if(typeof storage?.query!=='function')fail();
      return storage;
    },
    runtimeRoutingPolicy: async input => {
      if(!companies.has(input?.company_id))fail();
      await placement.assertCurrent(input.company_id);
      const decision=await setting.ports.runtimeRoutingPolicy(input);
      await placement.assertCurrent(input.company_id);
      if(decision?.company_id!==input.company_id||decision?.work_id!==input.work_id)fail();
      return decision;
    },
  });
}
