import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostedAgent3Operations} from './titan-hosted-operational-guard.mjs';
const deny=/agent3-hosted-operation-denied/;
function make(){
  const invoked=[];
  let valid=true, calls=0;
  const commissioner={strictCommissioning:true,strictPhysicalFencing:true,companyCount:2,acquirePlacementOperation:async()=>({assertCurrent:async()=>{},runWithContext:async operation=>operation(),release:async()=>{}}),async verifyHostedPreflight({company_id}={}){
    calls++;if(!valid)throw Error('revoked');
    if(company_id&&!['company-a','company-b'].includes(company_id))throw Error('foreign company');
    return {schema:'titan.agent3.hosted-preflight/v1',status:'verified',companies_verified:company_id?1:2};
  }};
  const native={agent3:{secret:true},dispatch:async i=>(invoked.push('dispatch'),i),
    recover:async i=>(invoked.push('recover'),i),
    zeroDispatcher:{dispatch:async i=>(invoked.push('zero.dispatch'),i),
      cancel:async i=>(invoked.push('cancel'),i),
      recoverInterrupted:async i=>(invoked.push('zero.recover'),i),
      reconcilePersistedWork:async i=>(invoked.push('read'),i),
      unsafe(){throw Error('privileged')}},
  };
  const surface=createHostedAgent3Operations({runtime:native,commissioning:commissioner});
  return {surface,native,commissioner,invoked,revoke(){valid=false;},get calls(){return calls;}};
}
test('commissioning absent preserves original native-only runtime',()=>{const r={};assert.equal(createHostedAgent3Operations({runtime:r}),r);});
test('ready probes all tenants before answering health',async()=>{const f=make();assert.equal((await f.surface.verifyOperationalReady()).companies_verified,2);assert.equal(f.calls,1);});
test('dispatch checks company freshness before actual runtime',async()=>{const f=make();const i={company_id:'company-a'};assert.equal(await f.surface.dispatch(i),i);assert.deepEqual(f.invoked,['dispatch']);});
test('recovery and cancellation honor revoked placements',async()=>{const f=make();f.revoke();for(const fn of [f.surface.recover,f.surface.zeroDispatcher.cancel,f.surface.zeroDispatcher.recoverInterrupted])await assert.rejects(()=>fn({company_id:'company-a'}),deny);assert.deepEqual(f.invoked,[]);});
test('company without verified registry placement cannot execute',async()=>{const f=make();await assert.rejects(()=>f.surface.dispatch({company_id:'company-z'}),deny);assert.deepEqual(f.invoked,[]);});
test('hosted API cannot expose raw Agent 3 runtime or unknown zero capabilities',()=>{const f=make();assert.equal(f.surface.agent3,undefined);assert.equal(f.surface.zeroDispatcher.unsafe,undefined);});
test('health revalidation revocation degrades, never starts work',async()=>{const f=make();f.revoke();await assert.rejects(()=>f.surface.verifyOperationalReady(),deny);assert.deepEqual(f.invoked,[]);});
test('malformed preflight claims cannot grant authority',async()=>{const f=make();f.commissioner.verifyHostedPreflight=async()=>({schema:'titan.agent3.hosted-preflight/v1',status:'verified',companies_verified:2});await assert.rejects(()=>f.surface.dispatch({company_id:'company-a'}),deny);assert.deepEqual(f.invoked,[]);});
test('each request verifies current placement again',async()=>{const f=make();await f.surface.dispatch({company_id:'company-a'});f.revoke();await assert.rejects(()=>f.surface.dispatch({company_id:'company-a'}),deny);assert.deepEqual(f.invoked,['dispatch']);});
