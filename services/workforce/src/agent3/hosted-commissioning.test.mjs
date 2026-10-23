import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCanonicalExecutionOwner } from './titan-canonical-execution-owner.mjs';
import { createCanonicalDurableDispatch } from './titan-canonical-durable-dispatch.mjs';
import { resolveHostedAgent3Ports } from './titan-hosted-commissioning.mjs';
const GOOD=['identity','authority','evidence','transport','native_fences','placement'];
function fixture(){
 const db=new DatabaseSync(':memory:');
 const storage={async query(sql,args=[]){const stmt=db.prepare(sql),bind=Object.fromEntries(args.map((x,i)=>['$'+(i+1),x]));if(/^\s*SELECT/i.test(sql)){const rows=stmt.all(bind);return {rows,rowCount:rows.length};}return {rows:[],rowCount:stmt.run(bind).changes};}};
 const resolver=async company=>company==='company-a'?storage:null;
 const ports={resolveCompanyStorage:resolver,runtimeRoutingPolicy:async ({company_id,work_id})=>({company_id,work_id,mode:'native'})};
 const setting={schema:'titan.agent3.hosted-commissioning/v1',mode:'operator-authorized',enabled:true,company_ids:['company-a'],ports,assertReady:async ({company_ids})=>({schema:'titan.agent3.hosted-readiness/v1',company_ids,...Object.fromEntries(GOOD.map(x=>[x,'verified']))})};
 return {db,storage,ports,setting};
}
async function using(fn){const f=fixture();try{await fn(f);}finally{f.db.close();}}
async function migrate(f){await createCanonicalDurableDispatch({resolveCompanyStorage:f.ports.resolveCompanyStorage}).migrate('company-a');await createCanonicalExecutionOwner({resolveCompanyStorage:f.ports.resolveCompanyStorage}).migrate('company-a');}
const denied=/agent3-hosted-commissioning-denied/;
test('native-only remains unchanged',async()=>assert.equal(await resolveHostedAgent3Ports(undefined),undefined));
test('commissioned company uses its actual registered SQLite store',async()=>using(async f=>{await migrate(f);const ports=await resolveHostedAgent3Ports(f.setting);assert.equal(await ports.resolveCompanyStorage('company-a'),f.storage);await assert.rejects(()=>ports.resolveCompanyStorage('company-b'),denied);}));
test('missing migrations fail before host startup and are not created',async()=>using(async f=>{await assert.rejects(()=>resolveHostedAgent3Ports(f.setting),denied);assert.equal((await f.storage.query("SELECT name FROM sqlite_master WHERE name='agent3_execution_owner'")).rowCount,0);}));
test('partially migrated company fails',async()=>using(async f=>{await createCanonicalExecutionOwner({resolveCompanyStorage:f.ports.resolveCompanyStorage}).migrate('company-a');await assert.rejects(()=>resolveHostedAgent3Ports(f.setting),denied);}));
test('missing verified identity or transport fails closed',async()=>using(async f=>{await migrate(f);for(const key of ['identity','transport','native_fences'])await assert.rejects(()=>resolveHostedAgent3Ports({...f.setting,assertReady:async()=>({...await f.setting.assertReady({company_ids:['company-a']}),[key]:'unknown'})}),denied);}));
test('operator company list must be unique and exact',async()=>using(async f=>{await migrate(f);for(const company_ids of [[],['company-a','company-a'],['company-b']])await assert.rejects(()=>resolveHostedAgent3Ports({...f.setting,company_ids}),denied);}));
test('route cannot be substituted into another company',async()=>using(async f=>{await migrate(f);const ports=await resolveHostedAgent3Ports({...f.setting,ports:{...f.ports,runtimeRoutingPolicy:async()=>({company_id:'company-b',work_id:'work-a',mode:'hatchet'})}});await assert.rejects(()=>ports.runtimeRoutingPolicy({company_id:'company-a',work_id:'work-a'}),denied);}));
test('startup abort and disabled config fail closed',async()=>using(async f=>{await migrate(f);const a=new AbortController();a.abort();await assert.rejects(()=>resolveHostedAgent3Ports(f.setting,{signal:a.signal}),denied);await assert.rejects(()=>resolveHostedAgent3Ports({...f.setting,enabled:false}),denied);}));

test('malformed attestation company list fails closed',async()=>using(async f=>{await migrate(f);await assert.rejects(()=>resolveHostedAgent3Ports({...f.setting,assertReady:async()=>({schema:'titan.agent3.hosted-readiness/v1',company_ids:'company-a',...Object.fromEntries(GOOD.map(x=>[x,'verified']))})}),denied);}));
