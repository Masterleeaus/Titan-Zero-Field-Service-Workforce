/** CI-bound acceptance for the operator-owned Hatchet v1 adapter.
 * The full file-backed restart/crash scenarios live in the Pass22 staging
 * lifecycle suite; this test intentionally has no real Hatchet credentials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCanonicalDurableDispatch } from './titan-canonical-durable-dispatch.mjs';
import { createGovernedHatchetSdkTransport } from './titan-hatchet-sdk-transport.mjs';

const COMPANY='co-ci',WORK='work-ci',TENANT='hatchet-ci',WORKER='worker-ci';
function fixture(){
 const db=new DatabaseSync(':memory:');let sends=0,cancels=0,rawPage=null;
 const storage={async query(sql,args=[]){const s=db.prepare(sql),bound=Object.fromEntries(args.map((v,i)=>[`$${i+1}`,v]));
  if(/^\s*SELECT\b/i.test(sql)){const rows=s.all(bound);return {rows,rowCount:rows.length};}
  return {rows:[],rowCount:s.run(bound).changes};}};
 const durable=createCanonicalDurableDispatch({resolveCompanyStorage:async()=>storage,makeId:()=> 'reservation-ci'});
 const sdk=createGovernedHatchetSdkTransport({durable,
  resolveClient:async()=>({tenantId:TENANT}),
  inspectRegisteredWorkflowIdempotency:async ({company_id,tenant,worker_id})=>({source:'trusted-registered-hatchet-workflow',verified:true,company_id,tenant,worker_id,workflow_name:'registered-staging-workflow',observed_at:new Date().toISOString(),idempotency:{strategy:'ttl',expression:'input.titan.idempotency_key',ttlMs:604800000}}),
  resolveRegisteredWorkflow:async()=>({async runNoWait(input){sends++;
   assert.equal(input.titan.schema,'titan.agent3.hatchet-input/v1');
   return {workflowRunId:'hatchet-run-ci'};}}),
  listCompleteRuns:async()=>rawPage??{complete:true,next_cursor:null,total:0,runs:[]},
  inspectRun:async()=>({tenant:TENANT,company_id:COMPANY,work_id:WORK,hatchet_run_id:'hatchet-run-ci',status:'COMPLETED'}),
  cancelRun:async()=>{cancels++;},
  checkWorkerHealth:async()=>({tenant:TENANT,worker_id:WORKER,state:'HEALTHY'}),
  authorizeCancel:async()=>({allowed:true,company_id:COMPANY,work_id:WORK,decision_ref:'cancel-approved'}),
 });
 const row={company_id:COMPANY,work_id:WORK,worker_id:WORKER,idempotency_key:`hatchet:${COMPANY}:${WORK}`,decision_ref:'authority-ci'};
 const subject={...row,tenant:TENANT,credential_ref:'vault/co-ci'};
 return {sdk,durable,row,subject,get sends(){return sends},get cancels(){return cancels},
  set page(x){rawPage=x}, async ready(){await durable.migrate(COMPANY);},close(){db.close()}};
}
const use=fn=>async()=>{const f=fixture();try{await f.ready();await fn(f);}finally{f.close();}};
test('SDK cannot launch a workflow without its real canonical SQLite reservation',use(async f=>{
 await assert.rejects(f.sdk.submit({...f.subject,reservation_id:'bad'}),/reservation-missing/);
 assert.equal(f.sends,0);
}));
test('only the exact new canonical reservation may trigger the registered Hatchet v1 workflow',use(async f=>{
 const r=await f.durable.reserveDispatch(f.row);
 const response=await f.sdk.submit({...f.subject,reservation_id:r.reservation_id});
 assert.equal(response.hatchet_run_id,'hatchet-run-ci');assert.equal(f.sends,1);
 await f.durable.markAccepted({company_id:COMPANY,work_id:WORK,reservation_id:r.reservation_id,hatchet_run_id:response.hatchet_run_id});
 await assert.rejects(f.sdk.submit({...f.subject,reservation_id:r.reservation_id}),/reservation-not-new-and-authorized/);
 assert.equal(f.sends,1);
}));
test('metadata reconciliation rejects incomplete provider listing without inventing uniqueness',use(async f=>{
 f.page={complete:false,next_cursor:'next',total:1,runs:[]};
 await assert.rejects(f.sdk.listRunsByMetadata({...f.subject,limit:101}),/listing-not-complete/);
}));
test('provider completion status does not imply canonical business outcome',use(async f=>{
 const status=await f.sdk.runStatus({...f.subject,hatchet_run_id:'hatchet-run-ci'});
 assert.equal(status.status,'COMPLETED');assert.equal('business_outcome_verified' in status,false);
}));
test('cancellation must target the exact accepted run, then remains unverified as business outcome',use(async f=>{
 const r=await f.durable.reserveDispatch(f.row);
 await assert.rejects(f.sdk.requestCancellation({...f.subject,actor_id:'actor-ci',hatchet_run_id:'hatchet-run-ci'}),/cancellation-unlinked-run/);
 await f.durable.markAccepted({company_id:COMPANY,work_id:WORK,reservation_id:r.reservation_id,hatchet_run_id:'hatchet-run-ci'});
 const result=await f.sdk.requestCancellation({...f.subject,actor_id:'actor-ci',hatchet_run_id:'hatchet-run-ci'});
 assert.equal(result.state,'CANCELLATION_REQUESTED');assert.equal(result.business_outcome_verified,false);
 assert.equal(f.cancels,1);
}));
test('wrong-company run context and raw credentials are rejected before provider call',use(async f=>{
 await assert.rejects(f.sdk.workerHealth({...f.subject,token:'secret'}),/raw-credential-denied/);
 await assert.rejects(f.sdk.runStatus({...f.subject,hatchet_run_id:'other-run'}),/run-status-unverified/);
 assert.equal(f.sends,0);
}));

test('parallel direct SDK submitters cannot spend one SQLite reservation twice',use(async f=>{
 const r=await f.durable.reserveDispatch(f.row);
 const results=await Promise.allSettled([
   f.sdk.submit({...f.subject,reservation_id:r.reservation_id}),
   f.sdk.submit({...f.subject,reservation_id:r.reservation_id})
 ]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(results.filter(x=>x.status==='rejected').length,1);
 assert.match(String(results.find(x=>x.status==='rejected').reason),/submission-already-claimed-or-stale|reservation-not-new-and-authorized/);
 assert.equal(f.sends,1);
 assert.equal((await f.durable.getDispatch({company_id:COMPANY,work_id:WORK})).state,'UNCERTAIN');
}));
test('durable pre-egress claim never becomes auto-retryable after a missing ACK',use(async f=>{
 const r=await f.durable.reserveDispatch(f.row);
 const claim=await f.durable.claimSubmission({...f.row,reservation_id:r.reservation_id});
 assert.equal(claim.safe_to_retry,false);
 await assert.rejects(f.sdk.submit({...f.subject,reservation_id:r.reservation_id}),/reservation-not-new-and-authorized/);
 assert.equal(f.sends,0);
 const pending=await f.durable.listUncertain({company_id:COMPANY});
 assert.equal(pending.length,1);
 assert.equal(pending[0].state,'UNCERTAIN');
}));
