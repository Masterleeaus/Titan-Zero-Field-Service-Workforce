import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostedAgent3Operations} from './titan-hosted-operational-guard.mjs';

const uncertain=/agent3-hosted-outcome-uncertain/;
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
function fixture(){
  const company='company-a';let enabled=true,epoch=1,checks=0,calls=0;
  const companyState={get current(){return enabled;},disable(){enabled=false;},rotate(){epoch++;}};
  const initialEpoch=epoch;
  const commissioning={strictCommissioning:true,strictPhysicalFencing:true,companyCount:1,acquirePlacementOperation:async()=>({assertCurrent:async()=>{},release:async()=>{}}),
    async verifyHostedPreflight({company_id}={}){checks++;if(company_id!==company||!enabled||epoch!==initialEpoch)throw Error('revoked');
      return {schema:'titan.agent3.hosted-preflight/v1',status:'verified',companies_verified:1};}};
  const pending=deferred(),started=deferred();
  const native={agent3:{privileged:true},events:{subscribe(){}},runtime:{start(){}},
    async dispatch(){calls++;started.resolve();return pending.promise;},
    async recover(){calls++;started.resolve();return pending.promise;},
    zeroDispatcher:{async dispatch(){calls++;started.resolve();return pending.promise;},
      async cancel(){calls++;started.resolve();return pending.promise;},
      async recoverInterrupted(){calls++;started.resolve();return pending.promise;},
      async reconcilePersistedWork(){calls++;started.resolve();return pending.promise;},
      forceRun(){throw Error('unsafe')}},
  };
  const guard=createHostedAgent3Operations({runtime:native,commissioning});
  return {company,pending,started,guard,native,companyState,get checks(){return checks;},get calls(){return calls;}};
}
test('in-flight dispatch loses success after tenant revocation',async()=>{
  const f=fixture(),p=f.guard.dispatch({company_id:f.company});await f.started.promise;
  f.companyState.disable();f.pending.resolve({accepted:true});await assert.rejects(()=>p,uncertain);
  assert.equal(f.calls,1);
});
test('in-flight recovery loses success after placement revision',async()=>{
  const f=fixture(),p=f.guard.recover({company_id:f.company});await f.started.promise;
  f.companyState.rotate();f.pending.resolve({recovered:true});await assert.rejects(()=>p,uncertain);
});
test('in-flight cancellation is uncertain, not confirmed',async()=>{
  const f=fixture(),p=f.guard.zeroDispatcher.cancel({company_id:f.company});await f.started.promise;
  f.companyState.disable();f.pending.resolve({cancelled:true});await assert.rejects(()=>p,uncertain);
});
test('unchanged company produces unchanged runtime result',async()=>{
  const f=fixture(),p=f.guard.dispatch({company_id:f.company});await f.started.promise;
  f.pending.resolve({accepted:true});assert.deepEqual(await p,{accepted:true});assert.equal(f.checks,3);
});
test('native errors remain native errors when company is still current',async()=>{
  const f=fixture(),original=new Error('native-provider-error');
  f.native.dispatch=async()=>{throw original;};
  const guarded=createHostedAgent3Operations({runtime:f.native,commissioning:{strictCommissioning:true,strictPhysicalFencing:true,companyCount:1,acquirePlacementOperation:async()=>({assertCurrent:async()=>{},release:async()=>{}}),
    async verifyHostedPreflight(){return {schema:'titan.agent3.hosted-preflight/v1',status:'verified',companies_verified:1};}}});
  await assert.rejects(()=>guarded.dispatch({company_id:f.company}),e=>e===original);
});
test('unknown privileged native methods are not exported',()=>{
  const f=fixture();for(const key of ['agent3','runtime','events','authorityGateway'])assert.equal(f.guard[key],undefined);
  assert.equal(f.guard.zeroDispatcher.forceRun,undefined);
});
test('no commissioning preserves exact native object identity',()=>{
  const x={dispatch(){}};assert.equal(createHostedAgent3Operations({runtime:x}),x);
});
test('denied company never calls the actual native executor',async()=>{
  const f=fixture();await assert.rejects(()=>f.guard.dispatch({company_id:'company-b'}),/agent3-hosted-operation-denied/);
  assert.equal(f.calls,0);
});
