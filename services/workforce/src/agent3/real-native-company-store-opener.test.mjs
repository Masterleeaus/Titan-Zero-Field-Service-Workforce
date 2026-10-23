/**
 * Canonical native opener + better-sqlite3 borrowed-lease acceptance test.
 * Unlike native-*style* gate tests, this invokes the production
 * createSqliteCompanyStoreOpener/StorageClient implementation. The child uses
 * the repository's installed tsx (the default native opener is TypeScript).
 * No Hatchet token and no customer company data are used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);
const cwd=fileURLToPath(new URL('../',import.meta.url));
const store=fileURLToPath(new URL('../../../../packages/storage/src/company-store-opener.ts',import.meta.url));
const sqlite=fileURLToPath(new URL('../../../../packages/storage/src/sqlite-client.ts',import.meta.url));
const gate=fileURLToPath(new URL('../../../../packages/storage/src/company-placement-operation-gate.ts',import.meta.url));
const script=String.raw\`
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const importSource=path=>import(pathToFileURL(path).href);
const {createSqliteCompanyStoreOpener}=await importSource(process.env.TITAN_TEST_OPENER);
const {createSqliteStorage}=await importSource(process.env.TITAN_TEST_SQLITE);
const {createCompanyPlacementOperationGate}=await importSource(process.env.TITAN_TEST_GATE);
const root=await mkdtemp(join(tmpdir(),'titan-agent3-real-opener-'));
const company='company-test', placement_id='registered-a';
const filename=join(root,placement_id+'.sqlite');
const descriptor={company_id:company,placement_id,placement_revision:1,provider:'sqlite',schema_version:'v1'};
try {
 const initial=createSqliteStorage(filename);
 try {await initial.query("CREATE TABLE evidence_test(company_id TEXT, work_id TEXT, PRIMARY KEY(company_id,work_id))");}
 finally {await initial.close();}
 await chmod(filename,0o600);
 const opener=createSqliteCompanyStoreOpener({companyStoreRoot:root});
 const physical=createCompanyPlacementOperationGate(root,placement_id);
 const other=createCompanyPlacementOperationGate(root,placement_id);
 // Existing native-only API must remain usable independently of Agent 3.
 let opened=await opener.open(descriptor);
 try {assert.equal((await opened.client.query('SELECT COUNT(*) AS n FROM evidence_test')).rows[0].n,0);}
 finally {await opened.client.close();}
 const lease=await physical.acquireBorrowable({timeoutMs:1200});
 try {
   const result=await lease.run(async()=>{
     const native=await opener.open(descriptor);
     try{
       await native.assertPlacementBound();
       await native.client.transaction(async tx=>{
         await tx.query('INSERT INTO evidence_test(company_id,work_id) VALUES($1,$2)',[company,'work-1']);
       });
       const records=await native.client.query('SELECT work_id FROM evidence_test WHERE company_id=$1',[company]);
       assert.equal(records.rows.length,1);
       // A different gate instance must NOT be able to take maintenance
       // while the native business work is inside the borrowed scope.
       await assert.rejects(()=>other.acquireMaintenance({timeoutMs:75}),/borrowed-maintenance-denied/);
       return records.rows[0].work_id;
     } finally {await native.client.close();}
   });
   assert.equal(result,'work-1');
   await assert.rejects(()=>other.acquire({timeoutMs:75}),/lock-timeout/);
 } finally {await lease.release();}
 // Completion releases the real lock and native operation remains functional.
 opened=await opener.open(descriptor);
 try {assert.equal((await opened.client.query('SELECT COUNT(*) AS n FROM evidence_test')).rows[0].n,1);}
 finally {await opened.client.close();}
 // Maintenance is accepted after the outer lease has ended.
 const maintenance=await other.acquireMaintenance({timeoutMs:1000});
 try {
   await assert.rejects(()=>opener.open(descriptor,{signal:AbortSignal.timeout(130)}),/operation-aborted|lock-timeout|invalid/);
 } finally {await maintenance();}
 console.log('canonical-better-sqlite3-native-opener-borrowed-pass');
} finally {await rm(root,{recursive:true,force:true});}
\`;
test('actual better-sqlite3 native opener borrows the held gate and excludes maintenance',async()=>{
 const env={...process.env,TITAN_TEST_OPENER:store,TITAN_TEST_SQLITE:sqlite,TITAN_TEST_GATE:gate};
 const {stdout}=await exec(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd,env,timeout:15000});
 assert.match(stdout,/canonical-better-sqlite3-native-opener-borrowed-pass/);
});
