import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHatchetStagingJournal,inspectStagingJournal} from './titan-hatchet-staging-journal.mjs';
const subject={company_id:'co-stage',work_id:'work-stage',worker_id:'worker-stage',tenant:'hatchet-stage',idempotency_key:'hatchet:co-stage:work-stage'};
const result={schema:'titan.agent3.live-staging-report/v1',company_id:subject.company_id,work_id:subject.work_id,
 tenant:subject.tenant,worker_id:subject.worker_id,status:'REQUIRES_RECONCILIATION',safe_to_retry:false,
 commissioning_approved:false,business_outcome_verified:false};
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'titan-staging-journal-'));try{await fn({dir,path:join(dir,'report.json')})}finally{await rm(dir,{recursive:true,force:true})}}
const journal=/agent3-staging-journal-/;
test('intent persists before possible external operation, with safe recovery marker',()=>fixture(async({path})=>{
 const j=createHatchetStagingJournal({reportPath:path,mode:'execute',subject});
 await j.begin();const data=JSON.parse(await readFile(path+'.intent','utf8'));
 assert.equal(data.state,'EFFECT_MAY_OCCUR');assert.equal(data.safe_to_retry,false);
 assert.equal('credential_ref' in data,false);assert.match(data.request_sha256,/^[a-f0-9]{64}$/);
 assert.equal((await inspectStagingJournal(path)).state,'ATTEMPT_UNKNOWN_RECONCILE_ONLY');
}));
test('final report must atomically link to the exact preflight intent',()=>fixture(async({path})=>{
 const j=createHatchetStagingJournal({reportPath:path,mode:'execute',subject});await j.begin();
 await j.finalize(result);
 const report=JSON.parse(await readFile(path,'utf8'));
 assert.equal(report.safe_to_retry,false);assert.equal(report.commissioning_approved,false);
 assert.equal(report.intent_sha256,(JSON.parse(await readFile(path+'.intent','utf8'))).request_sha256);
 assert.equal((await inspectStagingJournal(path)).state,'REPORT_RECORDED');
}));
test('restarting a staging attempt cannot reuse an existing intent or report',()=>fixture(async({path})=>{
 const a=createHatchetStagingJournal({reportPath:path,mode:'execute',subject});await a.begin();
 await assert.rejects(()=>createHatchetStagingJournal({reportPath:path,mode:'execute',subject}).begin(),journal);
 await a.finalize(result);
 await assert.rejects(()=>createHatchetStagingJournal({reportPath:path,mode:'execute',subject}).begin(),journal);
}));
test('separate concurrent operators cannot both create exclusive intent',()=>fixture(async({path})=>{
 const a=createHatchetStagingJournal({reportPath:path,mode:'execute',subject});
 const b=createHatchetStagingJournal({reportPath:path,mode:'execute',subject});
 const responses=await Promise.allSettled([a.begin(),b.begin()]);
 assert.equal(responses.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(responses.filter(x=>x.status==='rejected').length,1);
}));
test('output commit never overwrites another process report',()=>fixture(async({path})=>{
 const j=createHatchetStagingJournal({reportPath:path,mode:'execute',subject});await j.begin();
 await writeFile(path,'original',{flag:'wx'});
 await assert.rejects(()=>j.finalize(result),journal);assert.equal(await readFile(path,'utf8'),'original');
}));
test('provider exception content is refused as observation_error',()=>fixture(async({path})=>{
 const j=createHatchetStagingJournal({reportPath:path,mode:'execute',subject});await j.begin();
 await assert.rejects(()=>j.finalize({...result,observation_error:'token:TOPSECRET'}),/untrusted-error-category/);
 assert.equal((await inspectStagingJournal(path)).state,'ATTEMPT_UNKNOWN_RECONCILE_ONLY');
}));
test('approved fixed error code is allowed but never claims business outcome',()=>fixture(async({path})=>{
 const j=createHatchetStagingJournal({reportPath:path,mode:'execute',subject});await j.begin();
 await j.finalize({...result,observation_error:'LIST_INCOMPLETE'});
 const r=JSON.parse(await readFile(path,'utf8'));
 assert.equal(r.observation_error,'LIST_INCOMPLETE');assert.equal(r.business_outcome_verified,false);
}));
test('report with mismatching company or work is rejected after intent',()=>fixture(async({path})=>{
 const j=createHatchetStagingJournal({reportPath:path,mode:'execute',subject});await j.begin();
 for(const patch of [{work_id:'foreign-work'},{company_id:'foreign-company'},{safe_to_retry:true}])
   await assert.rejects(()=>j.finalize({...result,...patch}),journal);
}));
test('read-only intent is clearly distinguished from potential provider effect',()=>fixture(async({path})=>{
 const j=createHatchetStagingJournal({reportPath:path,mode:'inspect',subject});await j.begin();
 assert.equal((JSON.parse(await readFile(path+'.intent','utf8'))).state,'READ_ONLY');
}));
test('missing or malicious request identity cannot create an intent',()=>fixture(async({path})=>{
 for(const patch of [{company_id:''},{worker_id:'bad\nworker'},{tenant:null}])
  assert.throws(()=>createHatchetStagingJournal({reportPath:path,mode:'execute',subject:{...subject,...patch}}),journal);
}));
test('group/world-writable report directory fails closed',()=>fixture(async({dir,path})=>{
 const untrusted=join(dir,'untrusted');await mkdir(untrusted,{mode:0o777});
 // The process umask may narrow requested perms, change explicitly.
 const {chmod}=await import('node:fs/promises');await chmod(untrusted,0o777);
 await assert.rejects(()=>createHatchetStagingJournal({reportPath:join(untrusted,'report.json'),mode:'execute',subject}).begin(),journal);
}));
test('tampering the final report breaks read-only journal integrity check',()=>fixture(async({path})=>{
 const j=createHatchetStagingJournal({reportPath:path,mode:'execute',subject});await j.begin();await j.finalize(result);
 await writeFile(path,JSON.stringify({...result,intent_sha256:'f'.repeat(64)}));
 await assert.rejects(()=>inspectStagingJournal(path),/report-mismatch/);
}));
