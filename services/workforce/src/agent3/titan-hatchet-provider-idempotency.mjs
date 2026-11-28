/**
 * Provider-side Hatchet v1 registered workflow idempotency admission.
 * Independent operator registry MUST inspect the live registered workflow:
 * this is an additional collision window, never the canonical truth or a
 * reason to retry Titan work. TTL expiry can permit a new provider run.
 */
import {validId} from './titan-canonical-receiver.mjs';
export const HATCHET_IDEMPOTENCY_EXPRESSION='input.titan.idempotency_key';
export const HATCHET_IDEMPOTENCY_MIN_TTL_MS=86_400_000;
const deny=()=>{throw new Error('hatchet-sdk-provider-idempotency-unverified');};
const safeId=value=>validId(value)&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
export function verifyProviderIdempotencyPolicy(evidence,request,{now=()=>Date.now(),maxAgeMs=300_000}={}){
  if(!request||!['company_id','tenant','worker_id'].every(k=>safeId(request[k]))||
     !Number.isSafeInteger(maxAgeMs)||maxAgeMs<1000||maxAgeMs>3_600_000)deny();
  const stamp=Date.parse(evidence?.observed_at),time=now();
  if(evidence?.source!=='trusted-registered-hatchet-workflow'||evidence.verified!==true||
     evidence.company_id!==request.company_id||evidence.tenant!==request.tenant||
     evidence.worker_id!==request.worker_id||!safeId(evidence.workflow_name)||
     !Number.isFinite(stamp)||!Number.isFinite(time)||stamp>time+5_000||time-stamp>maxAgeMs||
     evidence.idempotency?.strategy!=='ttl'||
     evidence.idempotency.expression!==HATCHET_IDEMPOTENCY_EXPRESSION||
     !Number.isSafeInteger(evidence.idempotency.ttlMs)||
     evidence.idempotency.ttlMs<HATCHET_IDEMPOTENCY_MIN_TTL_MS||
     evidence.idempotency.ttlMs>31_536_000_000||
     Object.keys(evidence).some(k=>['token','secret','password','apiKey','api_key','endpoint','url'].includes(k)))deny();
  return Object.freeze({workflow_name:evidence.workflow_name,company_id:request.company_id,
    tenant:request.tenant,policy_verified:true,ttlMs:evidence.idempotency.ttlMs,
    safe_to_retry:false,business_outcome_verified:false,commissioning_approved:false});
}
