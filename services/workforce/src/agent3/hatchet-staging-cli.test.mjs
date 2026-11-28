import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('./scripts/hatchet_live_staging_cli.mjs',import.meta.url));
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'titan-staging-cli-'));
 const module=join(dir,'ports.mjs'),request=join(dir,'request.json'),report=join(dir,'report.json');
 const ready={company_id:'test-company',work_id:'test-work',worker_id:'test-worker',tenant:'test-tenant',credential_ref:'vault/test-company',actor_id:'test-actor',decision_ref:'test-decision',idempotency_key:'test-key',environment:'isolated-staging',staging_confirmation:'I_AUTHORIZE_A_DISPOSABLE_HATCHET_WORKFLOW'};
 writeFileSync(request,JSON.stringify(ready));
 writeFileSync(module,`export async function createPorts(){
 return {
 durable:{reserveDispatch:async()=>({created:true,reservation_id:'reservation-cli'}),getDispatch:async()=>null,markAccepted:async()=>({hatchet_run_id:'run-cli'}),markUncertain:async()=>({state:'UNCERTAIN'})},
 transport:{submit:async()=>({hatchet_run_id:'run-cli'}),listRunsByMetadata:async()=>({complete:true,next_cursor:null,total:0,runs:[]}),runStatus:async()=>({status:'RUNNING'}),workerHealth:async()=>({worker_id:'test-worker',tenant:'test-tenant',state:'HEALTHY'})},
 authorizeStaging:async()=>({allowed:true,company_id:'test-company',work_id:'test-work',actor_id:'test-actor',decision_ref:'test-decision',environment:'isolated-staging',expires_at:new Date(Date.now()+300000).toISOString()}),
 attestDeployment:async()=>({verified:true,company_id:'test-company',tenant:'test-tenant',worker_id:'test-worker',environment:'isolated-staging',deployment_ref:'deployment-cli',registration_revision:'r1'}),
 };}`);
 const run=(env={},args=['--module',module,'--request',request,'--mode','inspect','--report',report])=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000,env:{...process.env,...env}});
 return {dir,module,request,report,run,close(){rmSync(dir,{recursive:true,force:true});}};
}
test('isolated staging flag is mandatory even for inspection',()=>{const f=fixture();try{const r=f.run({TITAN_AGENT3_STAGING_ENV:''});assert.notEqual(r.status,0);assert.match(r.stderr,/isolated-env-required/);}finally{f.close();}});
test('staging inspection is read-only and saves a bounded local report',()=>{const f=fixture();try{const r=f.run({TITAN_AGENT3_STAGING_ENV:'isolated-staging'});assert.equal(r.status,0,r.stderr);const q=JSON.parse(readFileSync(f.report));assert.equal(q.safe_to_retry,false);assert.equal(q.inspection_only,true);assert.equal(q.commissioning_approved,false);}finally{f.close();}});
test('explicit execute CLI switch is mandatory',()=>{const f=fixture();try{const r=f.run({TITAN_AGENT3_STAGING_ENV:'isolated-staging'},['--module',f.module,'--request',f.request,'--mode','execute','--report',f.report]);assert.notEqual(r.status,0);assert.match(r.stderr,/explicit-execution-approval-required/);}finally{f.close();}});
test('operator reports cannot be silently overwritten',()=>{const f=fixture();try{writeFileSync(f.report,'original');const r=f.run({TITAN_AGENT3_STAGING_ENV:'isolated-staging'});assert.notEqual(r.status,0);assert.equal(readFileSync(f.report,'utf8'),'original');}finally{f.close();}});
test('explicit staging execution cannot certify outcome without independently listed provider run',()=>{
 const f=fixture();try{
  const r=f.run({TITAN_AGENT3_STAGING_ENV:'isolated-staging'},
   ['--module',f.module,'--request',f.request,'--mode','execute','--approve-disposable-workflow','--report',f.report]);
  assert.equal(r.status,0,r.stderr);
  const q=JSON.parse(readFileSync(f.report));
  assert.equal(q.status,'REQUIRES_RECONCILIATION');
  assert.equal(q.safe_to_retry,false);
  assert.equal(q.business_outcome_verified,false);
  assert.equal(q.commissioning_approved,false);
 }finally{f.close();}
});
