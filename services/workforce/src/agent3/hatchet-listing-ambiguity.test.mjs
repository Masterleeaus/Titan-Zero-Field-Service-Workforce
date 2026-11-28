import test from 'node:test';
import assert from 'node:assert/strict';
import {createHatchetRunReconciler} from './titan-hatchet-run-reconciler.mjs';
import {createGovernedHatchetSdkTransport} from './titan-hatchet-sdk-transport.mjs';
const company_id='company-test',work_id='work-test',actor_id='operator-test',tenant='tenant-test';
const idempotency_key='hatchet:company-test:work-test';
const record={company_id,work_id,tenant,idempotency_key,hatchet_run_id:'repeated-hatchet-run'};
function reconcilerFixture(runs){
 let linked=0,detail=0;
 const reconciler=createHatchetRunReconciler({
  durable:{getDispatch:async()=>({company_id,work_id,reservation_id:'reservation-test',idempotency_key,state:'UNCERTAIN'}),
   linkReconciled:async()=>{linked++;}},
  resolvePlacement:async()=>({hatchet_tenant_id:tenant,credential_ref:'vault/test'}),
  listRunsByMetadata:async()=>({complete:true,next_cursor:null,total:runs.length,runs}),
  readRunStatus:async()=>{detail++;return {tenant,hatchet_run_id:record.hatchet_run_id,status:'RUNNING'};},
  authorizeReconcile:async()=>({allowed:true,company_id,work_id,decision_ref:'decision-test'}),
  requireCompletePage:true,
 });
 return {reconciler,get linked(){return linked;},get detail(){return detail;}};
}
test('proved-complete duplicate identical run IDs never authorize a canonical link',async()=>{
 const f=reconcilerFixture([record,{...record}]);
 const result=await f.reconciler.reconcile({company_id,work_id,actor_id});
 assert.equal(result.state,'MULTIPLE_RUNS_REVIEW');assert.equal(result.count,2);
 assert.equal(result.safe_to_retry,false);assert.equal(f.linked,0);assert.equal(f.detail,0);
});
test('distinct IDs in a complete page also require manual review',async()=>{
 const f=reconcilerFixture([record,{...record,hatchet_run_id:'other-run'}]);
 const result=await f.reconciler.reconcile({company_id,work_id,actor_id});
 assert.equal(result.state,'MULTIPLE_RUNS_REVIEW');assert.equal(f.linked,0);
});
test('SDK rejects duplicated run IDs even if the provider claims a complete page',async()=>{
 let submits=0;
 const sdk=createGovernedHatchetSdkTransport({
  durable:{getDispatch:async()=>null,claimSubmission:async()=>{}},
  resolveClient:async()=>({tenantId:tenant}),
  resolveRegisteredWorkflow:async()=>({runNoWait:async()=>{submits++;return {workflowRunId:'new-run'};}}),
  inspectRegisteredWorkflowIdempotency:async()=>({}),
  listCompleteRuns:async()=>({complete:true,next_cursor:null,total:2,runs:[record,{...record}]}),
  inspectRun:async()=>null,cancelRun:async()=>{},checkWorkerHealth:async()=>({tenant,worker_id:'worker-test',state:'HEALTHY'}),
  authorizeCancel:async()=>({allowed:false}),
 });
 await assert.rejects(()=>sdk.listRunsByMetadata({company_id,work_id,tenant,idempotency_key,
  credential_ref:'vault/test',limit:101}),/listing-duplicate-run-id/);
 assert.equal(submits,0);
});
test('a unique complete page remains readable, with no implied business verification',async()=>{
 const sdk=createGovernedHatchetSdkTransport({
  durable:{getDispatch:async()=>null,claimSubmission:async()=>{}},resolveClient:async()=>({tenantId:tenant}),
  resolveRegisteredWorkflow:async()=>({runNoWait:async()=>({workflowRunId:'new-run'})}),
  inspectRegisteredWorkflowIdempotency:async()=>({}),
  listCompleteRuns:async()=>({complete:true,next_cursor:null,total:1,runs:[record]}),
  inspectRun:async()=>null,cancelRun:async()=>{},checkWorkerHealth:async()=>({tenant,worker_id:'worker-test',state:'HEALTHY'}),
  authorizeCancel:async()=>({allowed:false}),
 });
 const result=await sdk.listRunsByMetadata({company_id,work_id,tenant,idempotency_key,credential_ref:'vault/test',limit:101});
 assert.equal(result.total,1);assert.equal(result.runs[0].hatchet_run_id,record.hatchet_run_id);
 assert.equal(result.business_outcome_verified,undefined);
});
