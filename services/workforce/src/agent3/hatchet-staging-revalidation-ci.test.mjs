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
const provider=()=>({...s,hatchet_run_id:'run-1',status:'COMPLETED'});
const evidence=()=>({...s,schema:'titan.agent3.accepted-business-evidence/v1',
 verified:true,accepted:true,hatchet_run_id:'run-1',acceptance_ref:'evidence-1',
 authority_revision:'auth-1',staging_only:true,accepted_at:new Date(now).toISOString()});
const drill=()=>({...s,schema:'titan.agent3.operator-drill-evidence/v1',verified:true,
 hatchet_run_id:'run-1',drill_ref:'drill-1',observer_ref:'witness-1',
 rollback_ref:'rollback-1',observed_at:new Date(now).toISOString(),
 ack_loss:{observed:true,resubmissions:0},worker_restart:{observed:true,duplicate_runs:0},
 rollback:{tested:true,successful:true,production_modified:false,tenant:s.tenant}});
function fixture(overrides={}){
 const count={};const repeat=(name,fn)=>async()=>{count[name]=(count[name]??0)+1;
   return fn(count[name]);};
 const ports={authorizeReview:repeat('approval',approval),readDeployment:repeat('deployment',deploy),
 readCanonicalDispatch:repeat('row',row),listProviderRuns:repeat('page',page),
 readProviderRun:repeat('run',provider),readAcceptedBusinessEvidence:repeat('evidence',evidence),
 readMeasuredDrill:repeat('drill',drill),clock:()=>now,...overrides};
 return {verifier:createHatchetStagingDrillVerifier(ports),count};
}
const denied=/agent3-staging-drill-evidence-unverified/;
test('positive verdict re-observes all seven sources but never authorizes commissioning',async()=>{
 const f=fixture(),r=await f.verifier.assess(s);
 assert.equal(r.verdict,'STAGING_DRILL_REVIEWABLE');assert.equal(r.commissioning_approved,false);
 assert.equal(r.production_ready,false);
 for(const count of Object.values(f.count))assert.equal(count,2);
});
for(const [name,port,initial,changed] of [
 ['new duplicate','listProviderRuns',page,p=>({...p,total:2,runs:[...p.runs,...p.runs]})],
 ['provider revocation','readProviderRun',provider,p=>({...p,status:'RUNNING'})],
 ['business withdrawal','readAcceptedBusinessEvidence',evidence,p=>({...p,accepted:false})],
 ['business reference rewrite','readAcceptedBusinessEvidence',evidence,p=>({...p,acceptance_ref:'different'})],
 ['rollback no longer proven','readMeasuredDrill',drill,p=>({...p,rollback:{...p.rollback,successful:false}})],
 ['witness reference rewrite','readMeasuredDrill',drill,p=>({...p,observer_ref:'different'})]
 ]){
 test('second observation rejects '+name,async()=>{
  let calls=0;const f=fixture({[port]:async()=>++calls===1?initial():changed(initial())});
  await assert.rejects(()=>f.verifier.assess(s),denied);assert.equal(calls,2);
 });
}
test('mutable cached evidence objects cannot launder a changed reference',async()=>{
 const record=evidence();let calls=0;const f=fixture({readAcceptedBusinessEvidence:async()=>{
  if(++calls===2)record.acceptance_ref='rewritten';return record;
 }});await assert.rejects(()=>f.verifier.assess(s),denied);assert.equal(calls,2);
});
test('mutable cached deployment objects cannot launder revision replacement',async()=>{
 const record=deploy();let calls=0;const f=fixture({readDeployment:async()=>{
  if(++calls===2)record.registration_revision='rev-2';return record;
 }});await assert.rejects(()=>f.verifier.assess(s),denied);assert.equal(calls,2);
});
