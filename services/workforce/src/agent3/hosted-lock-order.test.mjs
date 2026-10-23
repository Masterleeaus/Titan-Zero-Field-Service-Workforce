import test from 'node:test';
import assert from 'node:assert/strict';
import {runWithHostedPlacementLockOrder,hostedPlacementLockOrderActive} from './titan-hosted-lock-order.mjs';
import {createHostedAgent3Operations} from './titan-hosted-operational-guard.mjs';
const deny=/agent3-hosted-nested-placement-operation-denied/;
const make=()=>{
 const events=[];
 const runtime={zeroDispatcher:{dispatch:async x=>x,cancel:async x=>x,recoverInterrupted:async x=>x,reconcilePersistedWork:async x=>x},dispatch:async x=>x,recover:async x=>x};
 const commissioned={strictCommissioning:true,strictPhysicalFencing:true,companyCount:2,
  verifyHostedPreflight:async x=>({schema:'titan.agent3.hosted-preflight/v1',status:'verified',companies_verified:x.company_id?1:2}),
  acquirePlacementOperation:async company_id=>{events.push('acquire:'+company_id);
   return {assertCurrent:async()=>{},release:async()=>events.push('release:'+company_id)};}};
 const guard=createHostedAgent3Operations({runtime,commissioning:commissioned});
 return {events,runtime,guard};
};
test('same-company nested operation fails before second physical gate acquisition',async()=>{
 const f=make();
 f.runtime.dispatch=()=>f.guard.zeroDispatcher.cancel({company_id:'company-a'});
 await assert.rejects(()=>f.guard.dispatch({company_id:'company-a'}),deny);
 assert.deepEqual(f.events,['acquire:company-a','release:company-a']);
});
test('cross-company nested operation fails before acquiring second company',async()=>{
 const f=make();
 f.runtime.dispatch=()=>f.guard.zeroDispatcher.dispatch({company_id:'company-b'});
 await assert.rejects(()=>f.guard.dispatch({company_id:'company-a'}),deny);
 assert.deepEqual(f.events,['acquire:company-a','release:company-a']);
});
test('async local context is active during execution and releases after',async()=>{
 assert.equal(hostedPlacementLockOrderActive(),false);
 assert.equal(await runWithHostedPlacementLockOrder('company-a',async()=>{assert.equal(hostedPlacementLockOrderActive(),true);await Promise.resolve();return 11;}),11);
 assert.equal(hostedPlacementLockOrderActive(),false);
});
test('sequential independent requests still work',async()=>{
 const f=make();
 await f.guard.dispatch({company_id:'company-a'});
 await f.guard.dispatch({company_id:'company-a'});
 assert.deepEqual(f.events,['acquire:company-a','release:company-a','acquire:company-a','release:company-a']);
});
test('native-only surface is unchanged',()=>{const x={};assert.equal(createHostedAgent3Operations({runtime:x}),x);});
