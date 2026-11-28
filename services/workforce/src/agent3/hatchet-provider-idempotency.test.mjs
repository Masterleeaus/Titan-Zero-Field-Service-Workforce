import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyProviderIdempotencyPolicy} from './titan-hatchet-provider-idempotency.mjs';
import {createGovernedHatchetSdkTransport} from './titan-hatchet-sdk-transport.mjs';
const input={company_id:'company-a',tenant:'tenant-a',worker_id:'worker-a'};
const now=Date.parse('2026-10-24T00:01:00Z');
const evidence=()=>({source:'trusted-registered-hatchet-workflow',verified:true,
 company_id:input.company_id,tenant:input.tenant,worker_id:input.worker_id,
 workflow_name:'registered-a',observed_at:'2026-10-24T00:00:00Z',
 idempotency:{strategy:'ttl',expression:'input.titan.idempotency_key',ttlMs:604800000}});
test('registered TTL CEL key is a valid second layer but never permits a retry',()=>{
 const r=verifyProviderIdempotencyPolicy(evidence(),input,{now:()=>now});
 assert.equal(r.policy_verified,true);assert.equal(r.safe_to_retry,false);
 assert.equal(r.commissioning_approved,false);
});
for(const [name,change] of [
 ['wrong tenant',p=>p.tenant='foreign'],
 ['status-based release',p=>p.idempotency.strategy='status'],
 ['wrong CEL key',p=>p.idempotency.expression='input.work_id'],
 ['insufficient TTL',p=>p.idempotency.ttlMs=30000],
 ['stale evidence',p=>p.observed_at='2026-10-23T16:00:00Z'],
 ['unverified registration',p=>p.verified=false],
 ['raw credential leak',p=>p.secret='super-secret']]){
 test('denies '+name,()=>{const p=evidence();change(p);
 assert.throws(()=>verifyProviderIdempotencyPolicy(p,input,{now:()=>now}),/provider-idempotency-unverified/);});
}
test('SDK constructor refuses missing independent registered workflow inspector',()=>{
 assert.throws(()=>createGovernedHatchetSdkTransport({durable:{getDispatch(){},claimSubmission(){}},
 resolveClient(){},resolveRegisteredWorkflow(){},listCompleteRuns(){},
 inspectRun(){},cancelRun(){},checkWorkerHealth(){},authorizeCancel(){}}),/inspectRegisteredWorkflowIdempotency/);
});
