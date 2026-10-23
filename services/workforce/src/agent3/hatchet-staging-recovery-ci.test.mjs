/** CI smoke for source-integrated, non-mutating staging recovery. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHatchetStagingJournal} from './titan-hatchet-staging-journal.mjs';
import {createStagingCrashRecovery} from './titan-hatchet-staging-recovery.mjs';
const subject={company_id:'company-ci',work_id:'work-ci',worker_id:'worker-ci',tenant:'tenant-ci',
  idempotency_key:'hatchet:company-ci:work-ci',credential_ref:'vault/company-ci'};
const record={company_id:'company-ci',work_id:'work-ci',worker_id:'worker-ci',
  idempotency_key:'hatchet:company-ci:work-ci',reservation_id:'reservation-ci',state:'UNCERTAIN',hatchet_run_id:null};
async function fixture(run){
 const dir=await mkdtemp(join(tmpdir(),'titan-agent3-ci-')),reportPath=join(dir,'stage.json');
 try{
  await createHatchetStagingJournal({reportPath,mode:'execute',subject}).begin();
  const state={list:[],complete:true,allowed:true,durableReads:0,providerReads:0};
  const recovery=createStagingCrashRecovery({
   durable:{async getDispatch(){state.durableReads++;return record;}},
   transport:{async listRunsByMetadata(){state.providerReads++;return {complete:state.complete,
     next_cursor:state.complete?null:'later',total:state.list.length,runs:state.list};}},
   authorizeInspect:async()=>({allowed:state.allowed,company_id:'company-ci',work_id:'work-ci',decision_ref:'approved'}),
   assertDeployment:async()=>({verified:true,company_id:'company-ci',tenant:'tenant-ci',worker_id:'worker-ci',
     environment:'isolated-staging',deployment_ref:'deployed'}),
  });
  await run({state,recovery,args:{reportPath,subject,actor_id:'operator-ci'}});
 } finally{await rm(dir,{recursive:true,force:true});}
}
const one={company_id:'company-ci',work_id:'work-ci',tenant:'tenant-ci',
 idempotency_key:'hatchet:company-ci:work-ci',hatchet_run_id:'run-a'};
test('crash journal and one matched provider run never permit automatic retry',()=>fixture(async f=>{
 f.state.list=[one];const x=await f.recovery.inspect(f.args);
 assert.equal(x.provider_finding,'ONE_PROVIDER_RUN_OBSERVED');assert.equal(x.safe_to_retry,false);
 assert.equal(x.business_outcome_verified,false);
}));
test('empty complete provider inventory is not a no-effect certificate',()=>fixture(async f=>{
 assert.equal((await f.recovery.inspect(f.args)).provider_finding,'PROVIDER_RUN_NOT_PROVEN');
}));
test('incomplete inventory and duplicate provider runs force reconciliation',()=>fixture(async f=>{
 f.state.complete=false;
 assert.equal((await f.recovery.inspect(f.args)).provider_finding,'PROVIDER_INVENTORY_INCOMPLETE');
 f.state.complete=true;f.state.list=[one,{...one,hatchet_run_id:'run-b'}];
 assert.equal((await f.recovery.inspect(f.args)).provider_finding,'DUPLICATE_PROVIDER_RUNS');
}));
test('stale company identity is refused before authority/provider effect',()=>fixture(async f=>{
 await assert.rejects(()=>f.recovery.inspect({...f.args,subject:{...subject,company_id:'foreign'}}),/intent-identity-mismatch/);
 assert.equal(f.state.durableReads,0);assert.equal(f.state.providerReads,0);
}));
test('denied authority never reads company state or provider inventory',()=>fixture(async f=>{
 f.state.allowed=false;
 await assert.rejects(()=>f.recovery.inspect(f.args),/authority-denied/);
 assert.equal(f.state.durableReads,0);assert.equal(f.state.providerReads,0);
}));
test('recorded staging report cannot declare business completion or commissioning',()=>fixture(async f=>{
 const journal=createHatchetStagingJournal({reportPath:f.args.reportPath+'.new',mode:'execute',subject});
 await journal.begin();const base={schema:'titan.agent3.live-staging-report/v1',company_id:'company-ci',work_id:'work-ci',
  worker_id:'worker-ci',tenant:'tenant-ci',status:'PROVIDER_ACCEPTED',safe_to_retry:false,
  business_outcome_verified:false,commissioning_approved:false};
 await assert.rejects(()=>journal.finalize({...base,business_outcome_verified:true}),/unsupported-outcome-claim/);
 await assert.rejects(()=>journal.finalize({...base,commissioning_approved:true}),/unsupported-outcome-claim/);
}));
