import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCanonicalDurableDispatch} from './titan-canonical-durable-dispatch.mjs';
import {createGovernedHatchetSdkTransport} from './titan-hatchet-sdk-transport.mjs';
import {createHatchetLiveStagingAcceptance} from './titan-hatchet-staging-acceptance.mjs';
const C='staging-company',W='staging-work',K='staging-worker',T='hatchet-stage';
const sample={company_id:C,work_id:W,worker_id:K,tenant:T,credential_ref:'vault/staging-company',actor_id:'human-staging-operator',
 decision_ref:'operator-approval',idempotency_key:'hatchet:staging-company:staging-work',environment:'isolated-staging',
 staging_confirmation:'I_AUTHORIZE_A_DISPOSABLE_HATCHET_WORKFLOW'};
const named=p=>Object.fromEntries(p.map((v,i)=>[`$${i+1}`,v]));
function fixture(){const db=new DatabaseSync(':memory:');let sends=0,complete=true,listComplete=true,health='HEALTHY',attested=true,allowed=true,lost=false,duplicate=false,revokeOnReserve=false,providerError=false, appearAfterReserve=false,rotateAfterReserve=false,expireAfterReserve=false,approvalExpiry=300000,deploymentRevision='rev-a',secondListIncomplete=false,listCalls=0;
 const durable=createCanonicalDurableDispatch({resolveCompanyStorage:async()=>({async query(sql,p=[]){const st=db.prepare(sql);if(/^\s*SELECT/i.test(sql)){const rows=st.all(named(p));return {rows,rowCount:rows.length};}return {rows:[],rowCount:st.run(named(p)).changes};}}),makeId:()=> 'reservation-stage'});
 const providerRuns=[];
 const transport=createGovernedHatchetSdkTransport({durable,resolveClient:async()=>({tenantId:T}),
  inspectRegisteredWorkflowIdempotency:async ({company_id,tenant,worker_id})=>({source:'trusted-registered-hatchet-workflow',verified:true,company_id,tenant,worker_id,workflow_name:'registered-staging-workflow',observed_at:new Date().toISOString(),idempotency:{strategy:'ttl',expression:'input.titan.idempotency_key',ttlMs:604800000}}),
  resolveRegisteredWorkflow:async()=>({async runNoWait(){sends++;providerRuns.push({hatchet_run_id:'run-stage',company_id:C,work_id:W,tenant:T,idempotency_key:sample.idempotency_key});if(lost)throw Error('lost ack');return {workflowRunId:'run-stage'};}}),
  listCompleteRuns:async()=>({complete:listComplete && !(secondListIncomplete&&++listCalls===2),next_cursor:listComplete?null:'next',total:providerRuns.length+(duplicate&&providerRuns.length?1:0),runs:duplicate&&providerRuns.length?[...providerRuns,{...providerRuns[0],hatchet_run_id:'duplicate'}]:providerRuns}),
  inspectRun:async()=>{if(providerError)throw new Error('supersecret Hatchet token: sk-live-DO-NOT-LEAK');return {company_id:C,work_id:W,tenant:T,hatchet_run_id:'run-stage',status:complete?'COMPLETED':'RUNNING'};},
  checkWorkerHealth:async()=>({tenant:T,worker_id:K,state:health}),cancelRun:async()=>{},authorizeCancel:async()=>({allowed:true,company_id:C,work_id:W,decision_ref:'can-cancel'})});
 const controlledDurable={...durable,reserveDispatch:async (...args)=>{const result=await durable.reserveDispatch(...args);if(revokeOnReserve)allowed=false; if(rotateAfterReserve)deploymentRevision='rev-b'; if(expireAfterReserve)approvalExpiry=-1000; if(appearAfterReserve)providerRuns.push({hatchet_run_id:'earlier-provider',company_id:C,work_id:W,tenant:T,idempotency_key:sample.idempotency_key});return result;}};
 const gate=createHatchetLiveStagingAcceptance({durable:controlledDurable,transport,
  authorizeStaging:async()=>({allowed,company_id:C,work_id:W,actor_id:sample.actor_id,decision_ref:sample.decision_ref,environment:'isolated-staging',expires_at:new Date(Date.now()+approvalExpiry).toISOString()}),
  attestDeployment:async()=>({verified:attested,company_id:C,tenant:T,worker_id:K,environment:'isolated-staging',deployment_ref:'attestation-ci',registration_revision:deploymentRevision})});
 return {db,durable,gate,get sends(){return sends},get providerRuns(){return providerRuns},set health(v){health=v},set allowed(v){allowed=v},set attested(v){attested=v},set lost(v){lost=v},set complete(v){complete=v},set listComplete(v){listComplete=v},set duplicate(v){duplicate=v},set providerError(v){providerError=v},set revokeOnReserve(v){revokeOnReserve=v},set appearAfterReserve(v){appearAfterReserve=v},set rotateAfterReserve(v){rotateAfterReserve=v},set expireAfterReserve(v){expireAfterReserve=v},set approvalExpiry(v){approvalExpiry=v},set secondListIncomplete(v){secondListIncomplete=v}};
}
const using=fn=>async()=>{const f=fixture();try{await f.durable.migrate(C);await fn(f);}finally{f.db.close();}};
test('live acceptance refuses implicit operation, unapproved operator or wrong tenant',using(async f=>{
 await assert.rejects(f.gate.executeOnce({...sample,staging_confirmation:undefined}),/explicit-nonproduction-confirmation-required/);
 await assert.rejects(f.gate.executeOnce({...sample,environment:'production'}),/explicit-nonproduction-confirmation-required/);
 f.allowed=false;await assert.rejects(f.gate.executeOnce(sample),/staging-authority-invalid/);assert.equal(f.sends,0);
}));
test('claimed healthy but unattested worker cannot enable staging',using(async f=>{
 f.attested=false;await assert.rejects(f.gate.executeOnce(sample),/live-deployment-not-attested/);
 f.attested=true;f.health='DISCONNECTED';await assert.rejects(f.gate.executeOnce(sample),/worker-not-healthy/);
 assert.equal(f.sends,0);
}));
test('approved isolated staging submits exactly once and does not manufacture business evidence',using(async f=>{
 const r=await f.gate.executeOnce(sample);assert.equal(r.status,'PROVIDER_COMPLETED');
 assert.equal(r.provider_uniqueness_verified,true);assert.equal(r.business_outcome_verified,false);
 assert.equal(r.commissioning_approved,false);assert.equal(f.sends,1);
 await assert.rejects(f.gate.executeOnce(sample),/reservation-exists-reconcile-first/);assert.equal(f.sends,1);
}));
test('pending Hatchet run is accepted but not a completed or verified business outcome',using(async f=>{
 f.complete=false;const r=await f.gate.executeOnce(sample);
 assert.equal(r.status,'PROVIDER_ACCEPTED');assert.equal(r.provider_status,'RUNNING');assert.equal(r.business_outcome_verified,false);
}));
test('lost ACK permanently blocks resubmit, inspection observes persisted UNCERTAIN',using(async f=>{
 f.lost=true;await assert.rejects(f.gate.executeOnce(sample),/outcome-uncertain-reconcile-only/);
 assert.equal((await f.durable.getDispatch(sample)).state,'UNCERTAIN');
 const q=await f.gate.inspect(sample);assert.equal(q.reserved_state,'UNCERTAIN');assert.equal(q.provider_run_count,1);
 await assert.rejects(f.gate.executeOnce(sample),/reservation-exists-reconcile-first/);assert.equal(f.sends,1);
}));
test('incomplete run listing before submit never consumes a reservation',using(async f=>{
 f.listComplete=false;await assert.rejects(f.gate.executeOnce(sample),/provider-list-incomplete|listing-not-complete/);
 assert.equal(f.sends,0);assert.equal(await f.durable.getDispatch(sample),null);
}));
test('duplicate provider runs after accepted submission demand reconciliation, not retry',using(async f=>{
 // duplicate response indicates a second run has appeared from outside Titan
 f.duplicate=true;const r=await f.gate.executeOnce(sample);
 assert.equal(r.status,'REQUIRES_RECONCILIATION');assert.equal(r.safe_to_retry,false);
 assert.equal(r.provider_uniqueness_verified,false);assert.equal(f.sends,1);
}));
test('read-only inspection never submits, even when provider listing is zero',using(async f=>{
 const r=await f.gate.inspect(sample);assert.equal(r.inspection_only,true);
 assert.equal(r.provider_run_count,0);assert.equal(r.safe_to_retry,false);assert.equal(f.sends,0);
}));
test('approval revoked after reservation prevents provider egress and remains reconciliable',using(async f=>{
 f.revokeOnReserve=true;
 await assert.rejects(f.gate.executeOnce(sample),/outcome-uncertain-reconcile-only/);
 assert.equal(f.sends,0);
 assert.equal((await f.durable.getDispatch(sample)).state,'UNCERTAIN');
}));
test('staging rejects raw provider credentials in its request structure',using(async f=>{
 await assert.rejects(f.gate.executeOnce({...sample,token:'secret'}),/input-invalid/);assert.equal(f.sends,0);
}));

test('provider exception content is never copied into staging observation report',using(async f=>{
 f.providerError=true;
 const report=await f.gate.executeOnce(sample);
 assert.equal(report.status,'REQUIRES_RECONCILIATION');
 assert.equal(report.observation_error,'RUN_STATUS_UNAVAILABLE');
 assert.doesNotMatch(JSON.stringify(report),/supersecret|sk-live|DO-NOT-LEAK/);
 assert.equal(report.safe_to_retry,false);
}));

test('provider run appears after reservation but before Hatchet egress; no second submission',using(async f=>{
 f.appearAfterReserve=true;
 await assert.rejects(f.gate.executeOnce(sample),/outcome-uncertain-reconcile-only/);
 assert.equal(f.sends,0);assert.equal((await f.durable.getDispatch(sample)).state,'UNCERTAIN');
 assert.equal(f.providerRuns.length,1);
}));
test('deployment registration changes during reserved admission; no workflow launched',using(async f=>{
 f.rotateAfterReserve=true;
 await assert.rejects(f.gate.executeOnce(sample),/outcome-uncertain-reconcile-only/);
 assert.equal(f.sends,0);assert.equal((await f.durable.getDispatch(sample)).state,'UNCERTAIN');
}));
test('operator one-shot authority expires during slow preflight; egress denied',using(async f=>{
 f.expireAfterReserve=true;
 await assert.rejects(f.gate.executeOnce(sample),/outcome-uncertain-reconcile-only/);
 assert.equal(f.sends,0);assert.equal((await f.durable.getDispatch(sample)).state,'UNCERTAIN');
}));
test('unbounded blanket approval is refused before any durable reservation',using(async f=>{
 f.approvalExpiry=1000*60*60*24*30;
 await assert.rejects(f.gate.executeOnce(sample),/staging-authority-invalid/);
 assert.equal(await f.durable.getDispatch(sample),null);assert.equal(f.sends,0);
}));
test('incomplete provider inventory after reservation blocks egress as uncertain',using(async f=>{
 f.secondListIncomplete=true;
 await assert.rejects(f.gate.executeOnce(sample),/outcome-uncertain-reconcile-only/);
 assert.equal(f.sends,0);assert.equal((await f.durable.getDispatch(sample)).state,'UNCERTAIN');
}));
