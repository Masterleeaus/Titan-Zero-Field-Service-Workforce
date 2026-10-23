import test from 'node:test';
import assert from 'node:assert/strict';
import {createHatchetStagingDrillVerifier} from './titan-hatchet-staging-drill-verdict.mjs';
const now=Date.parse('2026-10-24T01:00:00Z');
const s={company_id:'co',work_id:'disposable',actor_id:'operator',tenant:'tenant',
 worker_id:'worker',workflow_name:'workflow',decision_ref:'decision',
 idempotency_key:'hatchet:co:disposable',environment:'isolated-staging'};
const row=()=>({...s,state:'ACCEPTED',reservation_id:'res-1',hatchet_run_id:'run-1'});
const deploy=()=>({...s,schema:'titan.agent3.live-deployment-evidence/v1',verified:true,
 registration_revision:'rev-1',deployment_ref:'deploy-1',workflow_id:'workflow-1'});
const approval=()=>({...s,allowed:true});
const page=()=>({complete:true,next_cursor:null,total:1,runs:[{...s,hatchet_run_id:'run-1'}]});
const effect=()=>({...s,hatchet_run_id:'run-1',status:'COMPLETED'});
const evidence=()=>({...s,schema:'titan.agent3.accepted-business-evidence/v1',
 verified:true,accepted:true,hatchet_run_id:'run-1',acceptance_ref:'evidence-1',
 authority_revision:'auth-1',staging_only:true,accepted_at:new Date(now).toISOString()});
const drill=()=>({...s,schema:'titan.agent3.operator-drill-evidence/v1',
 verified:true,hatchet_run_id:'run-1',drill_ref:'drill-1',observer_ref:'witness-1',
 rollback_ref:'rollback-1',observed_at:new Date(now).toISOString(),
 ack_loss:{observed:true,resubmissions:0},worker_restart:{observed:true,duplicate_runs:0},
 rollback:{tested:true,successful:true,production_modified:false,tenant:s.tenant}});
function fixture(change={}){return createHatchetStagingDrillVerifier({
 authorizeReview:async()=>approval(),readDeployment:async()=>deploy(),
 readCanonicalDispatch:async()=>row(),listProviderRuns:async()=>page(),
 readProviderRun:async()=>effect(),readAcceptedBusinessEvidence:async()=>evidence(),
 readMeasuredDrill:async()=>drill(),clock:()=>now,...change});}
const denied=/agent3-staging-drill-evidence-unverified/;
test('verified staging drill can be reviewed but never commissions production',async()=>{
 const result=await fixture().assess(s);
 assert.equal(result.verdict,'STAGING_DRILL_REVIEWABLE');
 assert.equal(result.canonical_business_evidence_accepted,true);
 assert.equal(result.production_ready,false);assert.equal(result.commissioning_approved,false);
 assert.equal(result.requires_independent_release_approval,true);
});
test('provider COMPLETED without Titan accepted business evidence is rejected',async()=>{
 await assert.rejects(()=>fixture({readAcceptedBusinessEvidence:async()=>null}).assess(s),denied);
});
test('lost ACK state UNCERTAIN cannot be recorded as accepted business evidence',async()=>{
 await assert.rejects(()=>fixture({readCanonicalDispatch:async()=>({...row(),state:'UNCERTAIN'})}).assess(s),denied);
});
test('provider duplicate or partial listing cannot prove exactly one run',async()=>{
 await assert.rejects(()=>fixture({listProviderRuns:async()=>({...page(),total:2,runs:[page().runs[0],page().runs[0]]})}).assess(s),denied);
});
test('rollback that changed production and repeated a workflow fails closed',async()=>{
 await assert.rejects(()=>fixture({readMeasuredDrill:async()=>({...drill(),rollback:{...drill().rollback,production_modified:true}})}).assess(s),denied);
});
test('effective authority revocation before final verification denies',async()=>{
 let calls=0;await assert.rejects(()=>fixture({authorizeReview:async()=>({...approval(),allowed:++calls===1})}).assess(s),denied);
});
