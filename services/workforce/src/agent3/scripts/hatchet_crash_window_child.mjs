/** CI crash fixture. Real separate OS process, two independent SQLite DB
 * connections and SIGKILL after the durable/provider effect boundaries.
 * NO network, cloud credentials, live Hatchet or customer business effects. */
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {createCanonicalDurableDispatch} from '../titan-canonical-durable-dispatch.mjs';
import {createGovernedHatchetSdkTransport} from '../titan-hatchet-sdk-transport.mjs';
const [root,mode]=process.argv.slice(2);
if(!root||!['after-claim','after-provider','outage','retry','normal'].includes(mode))process.exit(9);
const company_id='company-one',work_id='work-one',worker_id='worker-one',tenant='tenant-one';
const input={company_id,work_id,worker_id,tenant,credential_ref:'vault/staging',
 idempotency_key:'hatchet:company-one:work-one',decision_ref:'authority-one',reservation_id:'reservation-one'};
const company=new DatabaseSync(join(root,'company.sqlite'));
const provider=new DatabaseSync(join(root,'provider.sqlite'));
const sqlite={async query(sql,params=[]){const stmt=company.prepare(sql),
 values=Object.fromEntries(params.map((v,i)=>['$'+(i+1),v]));
 if(/^\s*(SELECT|PRAGMA)\b/i.test(sql)){const rows=stmt.all(values);return {rows,rowCount:rows.length};}
 return {rows:[],rowCount:stmt.run(values).changes};}};
const original=createCanonicalDurableDispatch({resolveCompanyStorage:async()=>sqlite});
const durable={...original,async claimSubmission(payload){
 const result=await original.claimSubmission(payload);
 if(mode==='after-claim')process.kill(process.pid,'SIGKILL');
 return result;
}};
const sdk=createGovernedHatchetSdkTransport({durable,
 resolveClient:async()=>({tenantId:tenant}),
 resolveRegisteredWorkflow:async()=>({async runNoWait({titan}){
  provider.prepare('INSERT INTO runs(hatchet_run_id,company_id,work_id,tenant,idempotency_key) VALUES(?,?,?,?,?)')
   .run('run-one',titan.company_id,titan.work_id,tenant,titan.idempotency_key);
  if(mode==='after-provider')process.kill(process.pid,'SIGKILL');
  if(mode==='outage')throw Error('provider-unavailable-after-persist');
  return {workflowRunId:'run-one'};
 }}),
 inspectRegisteredWorkflowIdempotency:async()=>({source:'trusted-registered-hatchet-workflow',verified:true,
  company_id,tenant,worker_id,workflow_name:'registered-staging',observed_at:new Date().toISOString(),
  idempotency:{strategy:'ttl',expression:'input.titan.idempotency_key',ttlMs:604800000}}),
 listCompleteRuns:async()=>({complete:true,next_cursor:null,total:0,runs:[]}),
 inspectRun:async()=>null,cancelRun:async()=>{},checkWorkerHealth:async()=>({tenant,worker_id,state:'HEALTHY'}),
 authorizeCancel:async()=>({allowed:true,company_id,work_id,decision_ref:'cancelled'}),
});
try{
 const out=await sdk.submit(input);
 if(mode==='retry')throw Error('RETRY_UNEXPECTEDLY_SUCCEEDED');
 if(out.hatchet_run_id!=='run-one')throw Error('bad-run-id');
 console.log('SUBMITTED_ONCE');process.exitCode=0;
}catch(error){
 if(mode==='retry'&&/reservation-not-new-and-authorized/.test(String(error))){
  console.log('RETRY_DENIED_AS_REQUIRED');process.exitCode=0;
 }else if(mode==='outage'&&/provider-unavailable-after-persist/.test(String(error))){
  console.log('OUTAGE_LEFT_UNCERTAIN');process.exitCode=0;
 }else{console.error('UNEXPECTED_CHILD_FAILURE');process.exitCode=23;}
}finally{provider.close();company.close();}
