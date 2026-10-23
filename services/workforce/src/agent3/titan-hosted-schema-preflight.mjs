/** Read-only canonical Agent 3 SQLite migration verification. Never creates tables. */
const fail=()=>{throw new Error('agent3-hosted-schema-denied');};
const SCHEMAS=Object.freeze({
 agent3_bridge_nonces:{columns:['company_id','nonce','expires_at_unix'],pk:['company_id','nonce'],unique:[]},
 agent3_hatchet_transport:{columns:['company_id','work_id','worker_id','reservation_id','idempotency_key','decision_ref','hatchet_run_id','state','created_at','updated_at'],pk:['company_id','work_id'],unique:[['company_id','reservation_id'],['company_id','idempotency_key']]},
 agent3_execution_owner:{columns:['company_id','work_id','worker_id','engine','claim_id','policy_ref','state','created_at','updated_at'],pk:['company_id','work_id'],unique:[['company_id','claim_id']]},
});
const match=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const rows=async(storage,sql)=>{const r=await storage.query(sql);if(!Array.isArray(r?.rows))fail();return r.rows;};
const ordered=r=>r.filter(x=>Number.isSafeInteger(x.pk)&&x.pk>0).sort((a,b)=>a.pk-b.pk).map(x=>x.name);
export async function assertAgent3SqliteMigrations(storage){
 if(typeof storage?.query!=='function')fail();
 for(const [table,contract] of Object.entries(SCHEMAS)){
  const tableRows=await rows(storage,`SELECT name,sql FROM sqlite_master WHERE type='table' AND name='${table}'`);
  if(tableRows.length!==1||tableRows[0].name!==table||typeof tableRows[0].sql!=='string')fail();
  const cols=await rows(storage,`PRAGMA table_info('${table}')`);
  if(!match(cols.map(x=>x.name),contract.columns)||!match(ordered(cols),contract.pk))fail();
  const indexes=await rows(storage,`PRAGMA index_list('${table}')`);
  for(const uniqueColumns of contract.unique){
   let found=false;
   for(const index of indexes){
    if(index.unique!==1||typeof index.name!=='string'||!/^[A-Za-z_0-9]+$/.test(index.name))continue;
    const fields=await rows(storage,`PRAGMA index_info('${index.name}')`);
    if(match(fields.sort((a,b)=>a.seqno-b.seqno).map(x=>x.name),uniqueColumns))found=true;
   }
   if(!found)fail();
  }
  const ddl=tableRows[0].sql.replace(/\s+/g,'').toLowerCase();
  if(table==='agent3_hatchet_transport'&&!ddl.includes("check(statein('reserved','accepted','uncertain'))"))fail();
  if(table==='agent3_execution_owner'&&(!ddl.includes("check(enginein('native','hatchet'))")||
    !ddl.includes("check(statein('reserved','dispatched','uncertain'))")))fail();
 }
 return Object.freeze({schema:'titan.agent3.sqlite-preflight/v1',status:'verified'});
}