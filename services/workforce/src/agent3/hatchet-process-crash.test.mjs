import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createCanonicalDurableDispatch} from './titan-canonical-durable-dispatch.mjs';
const child=new URL('./scripts/hatchet_crash_window_child.mjs',import.meta.url);
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'agent3-pass27-child-kill-'));
 const db=new DatabaseSync(join(root,'company.sqlite'));
 const provider=new DatabaseSync(join(root,'provider.sqlite'));
 provider.exec('CREATE TABLE runs(hatchet_run_id TEXT PRIMARY KEY,company_id TEXT NOT NULL,work_id TEXT NOT NULL,tenant TEXT NOT NULL,idempotency_key TEXT NOT NULL)');
 const store={async query(sql,args=[]){const st=db.prepare(sql),values=Object.fromEntries(args.map((v,i)=>['$'+(i+1),v]));
  if(/^\s*(SELECT|PRAGMA)\b/i.test(sql)){const rows=st.all(values);return {rows,rowCount:rows.length};}
  return {rows:[],rowCount:st.run(values).changes};}};
 const durable=createCanonicalDurableDispatch({resolveCompanyStorage:async()=>store,makeId:()=> 'reservation-one'});
 const identity={company_id:'company-one',work_id:'work-one',worker_id:'worker-one',idempotency_key:'hatchet:company-one:work-one',decision_ref:'authority-one'};
 const run=mode=>spawnSync(process.execPath,[child.pathname,root,mode],{timeout:8000,encoding:'utf8'});
 const close=()=>{provider.close();db.close();rmSync(root,{recursive:true,force:true});};
 return {provider,durable,identity,run,close,async prepare(){await durable.migrate(identity.company_id);assert.equal((await durable.reserveDispatch(identity)).created,true)},
  state:async()=> (await durable.getDispatch(identity)).state,
  count:()=>provider.prepare('SELECT COUNT(*) AS n FROM runs').get().n};
}
const use=fn=>async()=>{const f=fixture();try{await f.prepare();await fn(f);}finally{f.close();}};
test('SIGKILL after provider accepted before SDK ACK leaves one run and a non-retryable claim',use(async f=>{
 const r=f.run('after-provider');assert.equal(r.signal,'SIGKILL');assert.equal(await f.state(),'UNCERTAIN');assert.equal(f.count(),1);
 const retry=f.run('retry');assert.equal(retry.status,0,retry.stderr);assert.match(retry.stdout,/RETRY_DENIED_AS_REQUIRED/);
 assert.equal(f.count(),1);assert.equal(await f.state(),'UNCERTAIN');
}));
test('SIGKILL after durable claim before provider effect preserves uncertainty',use(async f=>{
 const r=f.run('after-claim');assert.equal(r.signal,'SIGKILL');assert.equal(f.count(),0);assert.equal(await f.state(),'UNCERTAIN');
 const retry=f.run('retry');assert.equal(retry.status,0,retry.stderr);assert.equal(f.count(),0);
}));
test('provider loses ACK after persisting run; restart cannot submit a second run',use(async f=>{
 const r=f.run('outage');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/OUTAGE_LEFT_UNCERTAIN/);
 assert.equal(f.count(),1);assert.equal(await f.state(),'UNCERTAIN');
 assert.equal(f.run('retry').status,0);assert.equal(f.count(),1);
}));
test('a normal single launch cannot consume its reservation twice',use(async f=>{
 const r=f.run('normal');assert.equal(r.status,0,r.stderr);assert.equal(f.count(),1);
 assert.equal(await f.state(),'UNCERTAIN');assert.equal(f.run('retry').status,0);
}));
