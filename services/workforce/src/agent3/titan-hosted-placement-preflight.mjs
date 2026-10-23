/** Trusted GLOBAL_REGISTRY freshness fence; requires a currently registered READY SQLite company placement. */
import { validId } from './titan-canonical-receiver.mjs';
const fail=()=>{throw new Error('agent3-hosted-placement-denied');};
const acceptable=p=>p&&validId(p.company_id)&&validId(p.placement_id)&&
 Number.isSafeInteger(p.placement_revision)&&p.placement_revision>0&&
 p.status==='READY'&&p.provider==='sqlite'&&validId(p.schema_version);
export async function createHostedPlacementFence({company_ids,companyPlacementRegistry,signal}={}){
 if(!Array.isArray(company_ids)||!company_ids.length||!company_ids.every(validId)||
    new Set(company_ids).size!==company_ids.length||
    typeof companyPlacementRegistry?.findByCompanyId!=='function')fail();
 const expected=new Map(),placements=new Set();
 for(const company_id of company_ids){
  signal?.throwIfAborted();
  const record=await companyPlacementRegistry.findByCompanyId(company_id,{signal});
  if(!acceptable(record)||record.company_id!==company_id||placements.has(record.placement_id))fail();
  placements.add(record.placement_id);
  expected.set(company_id,Object.freeze({company_id,placement_id:record.placement_id,
   placement_revision:record.placement_revision,provider:record.provider,schema_version:record.schema_version}));
 }
 async function assertCurrent(company_id){
  if(!expected.has(company_id))fail();
  signal?.throwIfAborted();
  const latest=await companyPlacementRegistry.findByCompanyId(company_id,{signal});
  const original=expected.get(company_id);
  if(!acceptable(latest)||Object.keys(original).some(key=>latest[key]!==original[key]))fail();
  return original;
 }
 return Object.freeze({assertCurrent,company_ids:Object.freeze([...expected.keys()])});
}