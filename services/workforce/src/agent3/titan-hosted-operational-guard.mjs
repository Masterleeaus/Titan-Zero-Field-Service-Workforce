/**
 * Guard the hosted Workforce ingress after the operator has commissioned
 * Agent 3. Per-operation verification is deliberately uncached: an old
 * positive health result cannot authorize execution after placement revocation.
 */
import { validId } from './titan-canonical-receiver.mjs';
const fail=()=>{throw new Error('agent3-hosted-operation-denied');};
const method=(o,n)=>typeof o?.[n]==='function';
export function createHostedAgent3Operations({runtime,commissioning,signal}={}) {
  if(commissioning===undefined)return runtime;
  if(!runtime||!method(runtime,'dispatch')||!method(runtime,'recover')||
    !runtime.zeroDispatcher||!method(runtime.zeroDispatcher,'dispatch')||
    !method(runtime.zeroDispatcher,'recoverInterrupted')||
    !method(runtime.zeroDispatcher,'cancel')||
    !method(runtime.zeroDispatcher,'reconcilePersistedWork')||
    !method(commissioning,'verifyHostedPreflight')||
    commissioning.strictCommissioning!==true)fail();
  async function verify({company_id}={}) {
    if(signal?.aborted||(company_id!==undefined&&!validId(company_id)))fail();
    try {
      const result=await commissioning.verifyHostedPreflight(company_id?{company_id}:{});
      if(signal?.aborted||result?.schema!=='titan.agent3.hosted-preflight/v1'||
         result.status!=='verified'||!Number.isSafeInteger(result.companies_verified)||
         result.companies_verified!==(company_id===undefined?commissioning.companyCount:1))fail();
      return result;
    }catch{fail();}
  }
  async function execute(input,operation){
    if(!validId(input?.company_id))fail();
    await verify({company_id:input.company_id});
    if(signal?.aborted)fail();
    return operation();
  }
  const zero=runtime.zeroDispatcher;
  const zeroDispatcher=Object.freeze({
    dispatch:input=>execute(input,()=>zero.dispatch(input)),
    recoverInterrupted:input=>execute(input,()=>zero.recoverInterrupted(input)),
    cancel:input=>execute(input,()=>zero.cancel(input)),
    reconcilePersistedWork:input=>execute(input,()=>zero.reconcilePersistedWork(input)),
  });
  // Raw runtime/Agent 3 engine ports are privileged, not hosted HTTP APIs.
  const {agent3:_privileged,...surface}=runtime;
  return Object.freeze({...surface,
    dispatch:input=>execute(input,()=>runtime.dispatch(input)),
    recover:input=>execute(input,()=>runtime.recover(input)),
    zeroDispatcher,
    verifyOperationalReady:()=>verify(),
  });
}