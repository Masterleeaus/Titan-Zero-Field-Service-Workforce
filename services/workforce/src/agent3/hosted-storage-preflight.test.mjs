import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCanonicalExecutionOwner } from './titan-canonical-execution-owner.mjs';
import { createCanonicalDurableDispatch } from './titan-canonical-durable-dispatch.mjs';
import { resolveHostedAgent3Ports } from './titan-hosted-commissioning.mjs';
import { assertAgent3SqliteMigrations } from './titan-hosted-schema-preflight.mjs';
import { createHostedPlacementFence } from './titan-hosted-placement-preflight.mjs';
const C='company-a';
async function fixture() {
 const db=new DatabaseSync(':memory:');
 const storage={async query(sql,params=[]) {
  const stmt=db.prepare(sql),bound=Object.fromEntries(params.map((p,i)=>['$'+(i+1),p]));
  if(/^\s*(SELECT|PRAGMA)/i.test(sql)){const rows=stmt.all(bound);return {rows,rowCount:rows.length};}
  return {rows:[],rowCount:stmt.run(bound).changes};
 }};
 const company_id=C;
 const state={company_id,placement_id:'registered-company-a',placement_revision:1,provider:'sqlite',schema_version:'v1',status:'READY'};
 const registry={async findByCompanyId(id){return id===C?{...state}:null;}};
 const ports={resolveCompanyStorage:async id=>id===C?storage:null,
   runtimeRoutingPolicy:async({company_id,work_id})=>({company_id,work_id,mode:'native'})};
 const setting={schema:'titan.agent3.hosted-commissioning/v1',mode:'operator-authorized',enabled:true,company_ids:[C],ports,
  assertReady:async({company_ids})=>({schema:'titan.agent3.hosted-readiness/v1',company_ids,
   ...Object.fromEntries(['identity','authority','evidence','transport','native_fences','placement'].map(k=>[k,'verified']))})};
 await createCanonicalDurableDispatch({resolveCompanyStorage:ports.resolveCompanyStorage}).migrate(C);
 await createCanonicalExecutionOwner({resolveCompanyStorage:ports.resolveCompanyStorage}).migrate(C);
 return {db,storage,state,registry,ports,setting};
}
async function using(fn){const f=await fixture();try{await fn(f);}finally{f.db.close();}}
const denied=/agent3-hosted-(schema|placement|commissioning)-denied/;
const resolve=f=>resolveHostedAgent3Ports(f.setting,{companyPlacementRegistry:f.registry});
test('real migration schema passes and enforces strict mode',async()=>using(async f=>{
 assert.equal((await assertAgent3SqliteMigrations(f.storage)).status,'verified');
 const p=await resolve(f);assert.equal(p.strictCommissioning,true);
 assert.equal(await p.resolveCompanyStorage(C),f.storage);
}));
test('invalid migration schema blocks hosted startup',async()=>using(async f=>{
 f.db.exec('DROP TABLE agent3_bridge_nonces');
 f.db.exec('CREATE TABLE agent3_bridge_nonces(company_id TEXT,nonce TEXT,PRIMARY KEY(company_id,nonce))');
 await assert.rejects(()=>resolve(f),denied);
}));
test('missing transport uniqueness blocks commissioning',async()=>using(async f=>{
 f.db.exec('DROP TABLE agent3_hatchet_transport');
 f.db.exec("CREATE TABLE agent3_hatchet_transport(company_id TEXT NOT NULL,work_id TEXT NOT NULL,worker_id TEXT NOT NULL,reservation_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,decision_ref TEXT NOT NULL,hatchet_run_id TEXT,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(company_id,work_id),CHECK(state IN ('RESERVED','ACCEPTED','UNCERTAIN')))");
 await assert.rejects(()=>resolve(f),denied);
}));
test('company placement revision drift blocks existing route and storage access',async()=>using(async f=>{
 const p=await resolve(f);f.state.placement_revision++;
 await assert.rejects(()=>p.resolveCompanyStorage(C),denied);
 await assert.rejects(()=>p.runtimeRoutingPolicy({company_id:C,work_id:'work'}),denied);
}));
test('company DISABLED status blocks execution after startup',async()=>using(async f=>{
 const p=await resolve(f);f.state.status='DISABLED';
 await assert.rejects(()=>p.resolveCompanyStorage(C),denied);
}));
test('unregistered placement and missing registry fail closed',async()=>using(async f=>{
 await assert.rejects(()=>resolveHostedAgent3Ports(f.setting),denied);
 f.state.provider='postgres';
 await assert.rejects(()=>resolve(f),denied);
}));
test('duplicate physical placement across companies denied',async()=>using(async f=>{
 const registry={findByCompanyId:async company_id=>({...f.state,company_id})};
 await assert.rejects(()=>createHostedPlacementFence({company_ids:[C,'company-b'],companyPlacementRegistry:registry}),denied);
}));
test('different businesses cannot share one storage client in startup gate',async()=>using(async f=>{
 const registry={findByCompanyId:async company_id=>({...f.state,company_id,placement_id:company_id})};
 const setting={...f.setting,company_ids:[C,'company-b'],ports:{...f.ports,resolveCompanyStorage:async()=>f.storage}};
 await assert.rejects(()=>resolveHostedAgent3Ports(setting,{companyPlacementRegistry:registry}),denied);
}));


test('partial unique Hatchet indexes never count as global deduplication',async()=>using(async f=>{
 f.db.exec('DROP TABLE agent3_hatchet_transport');
 f.db.exec("CREATE TABLE agent3_hatchet_transport(company_id TEXT NOT NULL,work_id TEXT NOT NULL,worker_id TEXT NOT NULL,reservation_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,decision_ref TEXT NOT NULL,hatchet_run_id TEXT,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(company_id,work_id),CHECK(state IN ('RESERVED','ACCEPTED','UNCERTAIN')))");
 f.db.exec("CREATE UNIQUE INDEX res_partial ON agent3_hatchet_transport(company_id,reservation_id) WHERE state='RESERVED'");
 f.db.exec("CREATE UNIQUE INDEX key_partial ON agent3_hatchet_transport(company_id,idempotency_key) WHERE state='RESERVED'");
 await assert.rejects(()=>assertAgent3SqliteMigrations(f.storage),denied);
 await assert.rejects(()=>resolve(f),denied);
}));
test('partial execution claim index does not enforce sticky ownership',async()=>using(async f=>{
 f.db.exec('DROP TABLE agent3_execution_owner');
 f.db.exec("CREATE TABLE agent3_execution_owner(company_id TEXT NOT NULL,work_id TEXT NOT NULL,worker_id TEXT NOT NULL,engine TEXT NOT NULL,claim_id TEXT NOT NULL,policy_ref TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(company_id,work_id),CHECK(engine IN ('native','hatchet')),CHECK(state IN ('RESERVED','DISPATCHED','UNCERTAIN')))");
 f.db.exec("CREATE UNIQUE INDEX claim_partial ON agent3_execution_owner(company_id,claim_id) WHERE state='RESERVED'");
 await assert.rejects(()=>assertAgent3SqliteMigrations(f.storage),denied);
}));
test('nullable idempotency keys are rejected even with a UNIQUE index',async()=>using(async f=>{
 f.db.exec('DROP TABLE agent3_hatchet_transport');
 f.db.exec("CREATE TABLE agent3_hatchet_transport(company_id TEXT NOT NULL,work_id TEXT NOT NULL,worker_id TEXT NOT NULL,reservation_id TEXT NOT NULL,idempotency_key TEXT,decision_ref TEXT NOT NULL,hatchet_run_id TEXT,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(company_id,work_id),UNIQUE(company_id,reservation_id),UNIQUE(company_id,idempotency_key),CHECK(state IN ('RESERVED','ACCEPTED','UNCERTAIN')))");
 await assert.rejects(()=>assertAgent3SqliteMigrations(f.storage),denied);
}));
test('replay expiry must remain INTEGER',async()=>using(async f=>{
 f.db.exec('DROP TABLE agent3_bridge_nonces');
 f.db.exec('CREATE TABLE agent3_bridge_nonces(company_id TEXT NOT NULL,nonce TEXT NOT NULL,expires_at_unix TEXT NOT NULL,PRIMARY KEY(company_id,nonce))');
 await assert.rejects(()=>assertAgent3SqliteMigrations(f.storage),denied);
}));


test('post-startup preflight catches revoked company and deleted replay table',async()=>using(async f=>{
 const p=await resolve(f);
 assert.equal((await p.verifyHostedPreflight()).companies_verified,1);
 f.state.status='DISABLED';
 await assert.rejects(()=>p.verifyHostedPreflight(),denied);
 f.state.status='READY';
 f.db.exec('DROP TABLE agent3_bridge_nonces');
 await assert.rejects(()=>p.verifyHostedPreflight(),denied);
}));
