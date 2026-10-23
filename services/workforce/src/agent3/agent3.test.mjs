import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCanonicalExecutionOwner } from './titan-canonical-execution-owner.mjs';
import { createFencedZeroRuntime } from './titan-fenced-zero-runtime.mjs';
import { createGovernedRuntimeSelector } from './titan-runtime-dispatch-selector.mjs';

const COMPANY='company-test', WORK='work-test', WORKER='agent-test';
const scope={company_id:COMPANY,work_id:WORK,worker_id:WORKER};
function fixture() {
  const db=new DatabaseSync(':memory:');
  const storage={async query(sql,params=[]) {
    const stmt=db.prepare(sql), bound=Object.fromEntries(params.map((v,i)=>[`$${i+1}`,v]));
    if(/^\s*SELECT\b/i.test(sql)){const rows=stmt.all(bound);return {rows,rowCount:rows.length};}
    return {rows:[],rowCount:stmt.run(bound).changes};
  }};
  const executionOwner=createCanonicalExecutionOwner({resolveCompanyStorage:async c=>c===COMPANY?storage:null});
  const runs=new Map();let nativeStarts=0,hatchetStarts=0;
  const runtime={events:{subscribe(){return ()=>{}}},
    async findByWork({company_id,work_id}){return [...runs.values()].find(r=>r.company_id===company_id&&r.work_id===work_id)??null;},
    async findRecoverableByWork(input){return this.findByWork(input);},
    async start({company_id,work_id,agent_id}){nativeStarts++;const run={company_id,work_id,agent_id,run_id:`run-${nativeStarts}`,state:'QUEUED'};runs.set(run.run_id,run);return run;},
    async resume({run_id}){return runs.get(run_id);},
    async cancel({run_id}){return runs.get(run_id);},
    async recoverInterrupted({run_id}){return runs.get(run_id);},
    async forceRun(){throw new Error('forbidden-noncanonical-privileged-method');},
  };
  const zeroRuntime=createFencedZeroRuntime({runtime,executionOwner,getCanonicalRunById:async({company_id,run_id})=>runs.get(run_id)?.company_id===company_id?runs.get(run_id):null});
  const select=mode=>createGovernedRuntimeSelector({
    nativeRuntime:{async wake(input){return zeroRuntime.start({...input,agent_id:input.worker_id});}},
    hatchetRuntime:{async wake(){hatchetStarts++;return {state:'ACCEPTED',hatchet_run_id:`hatchet-${hatchetStarts}`};}},
    resolvePolicy:async({company_id,work_id})=>({company_id,work_id,mode,authorized:true,effective_policy_ref:'reviewed-decision'}),
    nativeRunLookup:async({company_id,work_id})=>runtime.findByWork({company_id,work_id}), executionOwner,
  });
  return {db,storage,executionOwner,runtime,zeroRuntime,select,get nativeStarts(){return nativeStarts;},get hatchetStarts(){return hatchetStarts;}};
}
async function using(fn){const f=fixture();await f.executionOwner.migrate(COMPANY);try{await fn(f);}finally{f.db.close();}}

test('transport ownership reserves exactly one engine under contention',async()=>using(async f=>{
  const res=await Promise.allSettled([f.select('hatchet').wake(scope),f.zeroRuntime.start({...scope,agent_id:WORKER})]);
  assert.equal(res.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(f.nativeStarts+f.hatchetStarts,1);
  const row=await f.executionOwner.get(COMPANY,WORK);assert.ok(row);assert.ok(['native','hatchet'].includes(row.engine));
}));
test('Hatchet-first blocks Zero start even if it bypasses the wake selector',async()=>using(async f=>{
  assert.equal((await f.select('hatchet').wake(scope)).state,'ACCEPTED');
  await assert.rejects(f.zeroRuntime.start({...scope,agent_id:WORKER}),/owner|reconciliation/i);
  assert.equal(f.nativeStarts,0);assert.equal(f.hatchetStarts,1);
}));
test('native-first blocks Hatchet transport, including when a canonical run already exists',async()=>using(async f=>{
  await f.zeroRuntime.start({...scope,agent_id:WORKER});
  await assert.rejects(f.select('hatchet').wake(scope),/existing canonical native run/i);
  assert.equal(f.nativeStarts,1);assert.equal(f.hatchetStarts,0);
}));
test('reserved owner is never released simply because dispatch is uncertain',async()=>using(async f=>{
  const claim=await f.executionOwner.reserve({...scope,engine:'hatchet',policy_ref:'reviewed-decision'});
  await f.executionOwner.markUncertain({...scope,claim_id:claim.claim_id});
  assert.equal((await f.executionOwner.get(COMPANY,WORK)).state,'UNCERTAIN');
  await assert.rejects(f.zeroRuntime.start({...scope,agent_id:WORKER}),/owner|reconciliation/i);
  assert.equal(f.nativeStarts,0);
}));
test('same-work same-engine replay does not submit another run',async()=>using(async f=>{
  const first=await f.select('hatchet').wake(scope),second=await f.select('hatchet').wake(scope);
  assert.equal(first.state,'ACCEPTED');assert.equal(second.state,'ALREADY_OWNED');assert.equal(f.hatchetStarts,1);
}));
test('cross-company lookup cannot read or release company owner',async()=>using(async f=>{
  await f.select('hatchet').wake(scope);
  await assert.rejects(f.executionOwner.get('other-company',WORK),/storage-unavailable/i);
  await assert.rejects(f.executionOwner.reserve({...scope,company_id:'other-company',engine:'native',policy_ref:'p-1'}),/storage-unavailable/i);
  assert.equal((await f.executionOwner.get(COMPANY,WORK)).engine,'hatchet');
}));
test('Zero continuation requires canonical persisted run',async()=>using(async f=>{
  await assert.rejects(f.zeroRuntime.resume({company_id:COMPANY,run_id:'invented'}),/run-not-found/);
  await assert.rejects(f.zeroRuntime.cancel({company_id:COMPANY,run_id:'invented'}),/run-not-found/);
  assert.equal(f.nativeStarts,0);
}));
test('Zero resumes only an existing canonical native run',async()=>using(async f=>{
  const run=await f.zeroRuntime.start({...scope,agent_id:WORKER});
  const state=await f.executionOwner.get(COMPANY,WORK);assert.equal(state.engine,'native');
  assert.equal((await f.zeroRuntime.resume({company_id:COMPANY,run_id:run.run_id})).run_id,run.run_id);
}));
test('unapproved Hatchet route cannot start either engine',async()=>using(async f=>{
  const selector=createGovernedRuntimeSelector({
    nativeRuntime:{wake:async()=>{throw new Error('must-not-run');}},
    hatchetRuntime:{wake:async()=>{throw new Error('must-not-run');}},
    resolvePolicy:async({company_id,work_id})=>({company_id,work_id,mode:'hatchet',authorized:false}),
    nativeRunLookup:async()=>null, executionOwner:f.executionOwner,
  });
  await assert.rejects(selector.wake(scope),/routing denied/);
  assert.equal(await f.executionOwner.get(COMPANY,WORK),null);
}));
test('unrecognized privileged native methods are not exported by guarded port',async()=>using(async f=>{
  assert.equal('forceRun' in f.zeroRuntime,false);
  assert.equal('start' in f.zeroRuntime,true);
  assert.equal(Object.isFrozen(f.zeroRuntime),true);
}));
