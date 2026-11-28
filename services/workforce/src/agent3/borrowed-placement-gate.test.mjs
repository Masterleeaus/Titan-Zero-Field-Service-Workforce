/** Canonical repository integration: child loads real TypeScript gate via
 * Node's explicit type-strip mode, even when the parent uses node --test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const gateURL=new URL('../../../../packages/storage/src/company-placement-operation-gate.ts',import.meta.url).href;
const script=`
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCompanyPlacementOperationGate} from ${JSON.stringify(gateURL)};
const root=await mkdtemp(join(tmpdir(),'titan-borrowed-ci-'));
try {
 const gate=createCompanyPlacementOperationGate(root,'registered-company-a');
 const native=createCompanyPlacementOperationGate(root,'registered-company-a');
 const lease=await gate.acquireBorrowable({timeoutMs:450});
 try {
  await lease.run(async()=>{
   const release=await native.acquire({timeoutMs:65});
   try{assert.equal(await native.run(async()=>24,{timeoutMs:65}),24);}
   finally{await release();}
  });
  await assert.rejects(()=>native.run(async()=>1,{timeoutMs:75}),/lock-timeout/);
  await lease.run(async()=>{
    assert.equal(await lease.run(()=>native.run(async()=>55,{timeoutMs:65})),55);
    await assert.rejects(()=>native.acquireMaintenance({timeoutMs:65}),/borrowed-maintenance-denied/);
  });
 } finally {await lease.release();}
 assert.equal(await native.run(async()=>63,{timeoutMs:200}),63);
 const raw=await gate.acquire({timeoutMs:200});
 try {await assert.rejects(()=>native.run(async()=>1,{timeoutMs:65}),/lock-timeout/);}
 finally {await raw();}
 console.log('borrowed-gate-tests-passed');
} finally {await rm(root,{recursive:true,force:true});}
`;
test('canonical borrowed placement scope reuses native query gate but excludes maintenance',async()=>{
 const {stdout}=await exec(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{timeout:10000});
 assert.match(stdout,/borrowed-gate-tests-passed/);
});
