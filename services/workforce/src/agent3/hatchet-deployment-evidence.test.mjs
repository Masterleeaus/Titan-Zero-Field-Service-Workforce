import test from 'node:test';
import assert from 'node:assert/strict';
import {createHatchetDeploymentEvidenceVerifier} from './titan-hatchet-deployment-evidence.mjs';

const A='company-stage', T='hatchet-tenant-a', W='worker-stage', FLOW='titan-disposable-acceptance';
const now=Date.parse('2026-10-24T00:00:00Z');
const date=(delta=0)=>new Date(now+delta).toISOString();
function fixture(){
 const counters={registration:0,tenant:0,workers:0,workflows:0};
 let rev='rev-1';let state='READY';let allowed=true,workerState='HEALTHY',heartbeat=date(-10_000),observed=date(-2_000),wfObserved=date(-4_000),extraWorker=false,extraWorkflow=false,workflowId='wf-registered',tenantSeen=T,listComplete=true,workflowState='REGISTERED',revisionChange=false;
 const registration=()=>({schema:'titan.agent3.registered-deployment/v1',company_id:A,tenant:T,worker_id:W,workflow_name:FLOW,environment:'isolated-staging',state,deployment_ref:'deploy-isolated-01',revision:rev,workflow_id:'wf-registered',credential_ref:'vault/company-stage',approved_by:'human-security',live_execution_allowed:allowed});
 const make=()=>createHatchetDeploymentEvidenceVerifier({clock:()=>now,
  resolveRegistration:async()=>{counters.registration++;if(revisionChange&&counters.registration>1)rev='rev-2';return registration();},
  resolveTenantClient:async()=>({tenantId:T}),
  observeTenant:async()=>{counters.tenant++;return {tenant:tenantSeen,state:'ACTIVE',provider:'hatchet'}},
  enumerateWorkers:async()=>{counters.workers++;const w={worker_id:W,tenant:T,deployment_ref:'deploy-isolated-01',state:workerState,last_heartbeat_at:heartbeat,observed_at:observed};return {complete:listComplete,next_cursor:listComplete?null:'cursor',total:extraWorker?2:1,items:extraWorker?[w,{...w}]:[w]}},
  enumerateWorkflows:async()=>{counters.workflows++;const task={workflow_name:FLOW,workflow_id:workflowId,tenant:T,state:workflowState,observed_at:wfObserved};return {complete:true,next_cursor:null,total:extraWorkflow?2:1,items:extraWorkflow?[task,{...task}]:[task]}}
 });
 const subject={company_id:A,tenant:T,worker_id:W,workflow_name:FLOW};
 return {make,subject,counters,
  set rev(x){rev=x},set state(x){state=x},set allowed(x){allowed=x},set workerState(x){workerState=x},set heartbeat(x){heartbeat=x},set observed(x){observed=x},set wfObserved(x){wfObserved=x},set extraWorker(x){extraWorker=x},set extraWorkflow(x){extraWorkflow=x},set workflowId(x){workflowId=x},set tenantSeen(x){tenantSeen=x},set listComplete(x){listComplete=x},set workflowState(x){workflowState=x},set revisionChange(x){revisionChange=x}};
}
const deny=/agent3-deployment-evidence-/;
test('independently joins current registry, tenant, fresh worker and workflow identity',async()=>{
 const f=fixture(),proof=await f.make().verify(f.subject);
 assert.equal(proof.verified,true);assert.equal(proof.deployment_ref,'deploy-isolated-01');
 assert.equal(proof.business_outcome_verified,false);assert.equal(proof.safe_to_retry,false);
 assert.equal(Object.isFrozen(proof),true);assert.equal(f.counters.registration,2);
 for(const key of ['credential_ref','token','secret']) assert.equal(key in proof,false);
});
test('works as staging attestDeployment port without a caller-selected workflow',async()=>{
 const f=fixture();const v=f.make().createStagingAttestor(async()=>FLOW);
 const att=await v({company_id:A,tenant:T,worker_id:W});
 assert.deepEqual(att,{verified:true,company_id:A,tenant:T,worker_id:W,environment:'isolated-staging',deployment_ref:'deploy-isolated-01'});
});
test('no registration approval or revoked staging deployment blocks evidence',async()=>{
 for(const patch of [{state:'DISABLED'},{allowed:false}]){
  const f=fixture();Object.assign(f,patch);await assert.rejects(()=>f.make().verify(f.subject),deny);
 }
});
test('wrong Hatchet tenant observation is rejected',async()=>{const f=fixture();f.tenantSeen='other-tenant';await assert.rejects(()=>f.make().verify(f.subject),deny);});
test('provider worker unhealthy, stale or with future heartbeat is rejected',async()=>{
 for(const patch of [{workerState:'DISCONNECTED'},{heartbeat:date(-250_000)},{heartbeat:date(500_000)},{observed:date(-190_000)}]){
  const f=fixture();Object.assign(f,patch);await assert.rejects(()=>f.make().verify(f.subject),deny);
 }
});
test('unregistered workflow, inactive workflow and stale workflow catalog block',async()=>{
 for(const patch of [{workflowId:'unknown'},{workflowState:'DISABLED'},{wfObserved:date(-190_000)}]){
  const f=fixture();Object.assign(f,patch);await assert.rejects(()=>f.make().verify(f.subject),deny);
 }
});
test('provider worker and workflow inventory must be complete and unambiguous',async()=>{
 for(const patch of [{extraWorker:true},{extraWorkflow:true},{listComplete:false}]){
  const f=fixture();Object.assign(f,patch);await assert.rejects(()=>f.make().verify(f.subject),deny);
 }
});
test('staging registration revision mutation during provider reads fails closed',async()=>{
 const f=fixture();f.revisionChange=true;await assert.rejects(()=>f.make().verify(f.subject),/registration-changed/);
});
test('request cannot select an unknown company or use provider URL instead of trusted ports',async()=>{
 const f=fixture();for(const key of ['company_id','worker_id','workflow_name']){
  await assert.rejects(()=>f.make().verify({...f.subject,[key]:'bad\nvalue'}),deny);
 }
});
test('provider observations never launch or cancel a workflow',async()=>{
 const f=fixture();const gate=f.make();await gate.verify(f.subject);
 assert.deepEqual({tenant:f.counters.tenant,workers:f.counters.workers,workflows:f.counters.workflows},{tenant:1,workers:1,workflows:1});
 assert.equal('submit' in gate,false);assert.equal('cancel' in gate,false);
});
test('untrusted operator port configuration rejected before any remote action',()=>{
 assert.throws(()=>createHatchetDeploymentEvidenceVerifier({resolveRegistration:()=>{}}),/port-required/);
});
