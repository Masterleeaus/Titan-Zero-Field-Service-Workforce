import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanonicalPlacementGateAcquirer} from './titan-canonical-placement-gate-adapter.mjs';
const id={company_id:'company-a',placement_id:'placement-a',placement_revision:3,provider:'sqlite',schema_version:'v1'};
test('selects trusted registered placement and not caller-supplied paths',async()=>{
 let observed;let held=false;
 const a=createCanonicalPlacementGateAcquirer({resolveGate:async p=>{observed=p;return {acquireBorrowable:async()=>{held=true;return {run:async op=>op(),release:async()=>{held=false;}};},acquireMaintenance:async()=>{}};},assertPhysicalBinding:async()=>id});
 const lease=await a({...id,path:'/attacker'});
 assert.deepEqual(observed,id);assert.equal(held,true);await lease.release();assert.equal(held,false);
});
test('physical company binding drift denies and releases acquired gate',async()=>{
 let held=false;
 const a=createCanonicalPlacementGateAcquirer({resolveGate:async()=>({acquireBorrowable:async()=>{held=true;return {run:async op=>op(),release:async()=>{held=false;}};},acquireMaintenance:async()=>{}}),assertPhysicalBinding:async()=>({...id,company_id:'foreign'})});
 await assert.rejects(()=>a(id),/agent3-hosted-physical-gate-denied/);assert.equal(held,false);
});
test('missing canonical maintenance gate fails closed',async()=>{
 const a=createCanonicalPlacementGateAcquirer({resolveGate:async()=>({acquireBorrowable:async()=>({run:async op=>op(),release:async()=>{}})}),assertPhysicalBinding:async()=>id});
 await assert.rejects(()=>a(id),/agent3-hosted-physical-gate-denied/);
});
test('a physical lease is released at most once',async()=>{
 const a=createCanonicalPlacementGateAcquirer({resolveGate:async()=>({acquireBorrowable:async()=>({run:async op=>op(),release:async()=>{}}),acquireMaintenance:async()=>{}}),assertPhysicalBinding:async()=>id});
 const lease=await a(id);await lease.release();await assert.rejects(()=>lease.release(),/agent3-hosted-physical-gate-denied/);
});
