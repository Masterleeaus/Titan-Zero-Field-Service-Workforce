import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveStagingReadinessGate} from './titan-hatchet-live-readiness.mjs';
const now=Date.parse('2026-10-24T00:00:00Z');
const inp={company_id:'company-a',work_id:'disposable-a',worker_id:'worker-a',tenant:'tenant-a',
 workflow_name:'workflow-a',actor_id:'operator-a',idempotency_key:'hatchet:company-a:disposable-a',
 decision_ref:'decision-a',environment:'isolated-staging'};
const proof=()=>({schema:'titan.agent3.live-deployment-evidence/v1',verified:true,
 environment:'isolated-staging',company_id:inp.company_id,worker_id:inp.worker_id,
 tenant:inp.tenant,workflow_name:inp.workflow_name,workflow_id:'workflow-id-a',
 deployment_ref:'deployment-a',registration_revision:'revision-1'});
const policy=()=>({source:'trusted-registered-hatchet-workflow',verified:true,
 company_id:inp.company_id,tenant:inp.tenant,worker_id:inp.worker_id,
 workflow_name:inp.workflow_name,observed_at:new Date(now-1000).toISOString(),
 idempotency:{strategy:'ttl',expression:'input.titan.idempotency_key',ttlMs:604800000}});
function fixture(change={}){
 const calls=[];
 const p={verifyDeployment:async()=>{calls.push('deployment');return proof();},
 inspectRegisteredWorkflowIdempotency:async()=>{calls.push('policy');return policy();},
 getDispatch:async()=>{calls.push('titan');return null;},
 listRunsByMetadata:async()=>{calls.push('provider');return {complete:true,next_cursor:null,total:0,runs:[]};},
 authorizeStaging:async()=>{calls.push('authority');return {allowed:true,company_id:inp.company_id,
  work_id:inp.work_id,actor_id:inp.actor_id,decision_ref:inp.decision_ref,
  environment:'isolated-staging',expires_at:new Date(now+300000).toISOString()};},
 clock:()=>now,...change};
 return {gate:createLiveStagingReadinessGate(p),calls};
}
const denied=/agent3-live-staging-readiness-denied/;
test('read-only, current independently attested staging one-shot can be eligible but not commissioned',async()=>{
 const f=fixture(),r=await f.gate.assess(inp);
 assert.equal(r.staging_disposable_one_shot_eligible,true);
 for(const k of ['commissioning_approved','safe_to_retry','business_outcome_verified','live_hatchet_execution_observed'])assert.equal(r[k],false);
 assert.deepEqual(f.calls,['authority','deployment','policy','titan','provider','deployment','authority']);
 assert.equal(Object.isFrozen(r),true);
});
test('existing canonical reservation rejects before provider inventory',async()=>{
 const f=fixture({getDispatch:async()=>({state:'UNCERTAIN'})});
 await assert.rejects(()=>f.gate.assess(inp),denied);assert.equal(f.calls.includes('provider'),false);
});
for(const [name,field] of [['missing provider snapshot',{}],['incomplete snapshot',{complete:false,next_cursor:null,total:0,runs:[]}],
 ['nonzero provider runs',{complete:true,next_cursor:null,total:1,runs:[{hatchet_run_id:'x'}]}],
 ['provider pagination cursor',{complete:true,next_cursor:'next',total:0,runs:[]}]]){
 test(name+' prevents eligible staging',async()=>{
  const f=fixture({listRunsByMetadata:async()=>field});await assert.rejects(()=>f.gate.assess(inp),denied);
 });
}
test('untrusted operator approval rejected before other reads',async()=>{
 const f=fixture({authorizeStaging:async()=>({allowed:false})});await assert.rejects(()=>f.gate.assess(inp),denied);
 assert.deepEqual(f.calls,[]);
});
test('expiry must be near-term and current',async()=>{
 for(const delta of [-1,900001]){
  const f=fixture({authorizeStaging:async()=>({allowed:true,company_id:inp.company_id,work_id:inp.work_id,
   actor_id:inp.actor_id,decision_ref:inp.decision_ref,environment:'isolated-staging',expires_at:new Date(now+delta).toISOString()})});
  await assert.rejects(()=>f.gate.assess(inp),denied);
 }
});
test('registered deployment revision change during inspection rejects the one-shot',async()=>{
 let n=0;const f=fixture({verifyDeployment:async()=>({...proof(),registration_revision:++n===1?'revision-1':'revision-2'})});
 await assert.rejects(()=>f.gate.assess(inp),denied);
});
test('registered workflow idempotency mismatch rejects before consuming reserved identity',async()=>{
 const f=fixture({inspectRegisteredWorkflowIdempotency:async()=>({...policy(),idempotency:{strategy:'status',expression:'input.titan.idempotency_key',ttlMs:604800000}})});
 await assert.rejects(()=>f.gate.assess(inp),denied);assert.equal(f.calls.includes('titan'),false);
});
test('provider exceptions cannot leak secret material through error classification',async()=>{
 const f=fixture({listRunsByMetadata:async()=>{throw Error('password=secret raw-provider-body');}});
 await assert.rejects(()=>f.gate.assess(inp),e=>e.message==='agent3-live-staging-readiness-denied');
});
test('wrong tenant or caller-supplied token does not permit staging',async()=>{
 const f=fixture();await assert.rejects(()=>f.gate.assess({...inp,token:'password'}),denied);
 await assert.rejects(()=>f.gate.assess({...inp,tenant:'other-tenant'}),denied);
});
test('non-staging environment and malformed identity are denied',async()=>{
 const f=fixture();await assert.rejects(()=>f.gate.assess({...inp,environment:'production'}),denied);
 await assert.rejects(()=>f.gate.assess({...inp,company_id:''}),denied);
});
test('operator revocation during provider inventory denies final eligibility',async()=>{
 let approvals=0;
 const f=fixture({authorizeStaging:async()=>({...{
  allowed:++approvals===1,company_id:inp.company_id,work_id:inp.work_id,
  actor_id:inp.actor_id,decision_ref:inp.decision_ref,environment:'isolated-staging',
  expires_at:new Date(now+300000).toISOString()}})});
 await assert.rejects(()=>f.gate.assess(inp),denied);assert.equal(approvals,2);
});
test('approval that expires while external inventory is read must be rejected',async()=>{
 let calls=0;
 const f=fixture({clock:()=>now+(++calls>1?310000:0)});
 await assert.rejects(()=>f.gate.assess(inp),denied);
});
test('readiness refuses an observation window longer than 60 seconds',async()=>{
 let calls=0;
 const f=fixture({clock:()=>now+(++calls>1?61000:0)});
 await assert.rejects(()=>f.gate.assess(inp),denied);
});
test('port requirements are explicit and may not be inferred from untrusted input',()=>{
 assert.throws(()=>createLiveStagingReadinessGate({}),/trusted-port-required/);
});
