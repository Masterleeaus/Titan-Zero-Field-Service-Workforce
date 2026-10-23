/**
 * Operator-only, opt-in live-staging acceptance. This harness can use an actual
 * self-hosted Hatchet v1 SDK via the trusted SDK transport created by Titan.
 * It does NOT expose an HTTP route, read env credentials or modify Titan's
 * business evidence ledger. No live mode is enabled by merely installing it.
 *
 * No mock or SDK health method may certify a deployed worker. A real operator
 * must supply independently verified staging deployment and effective authority.
 * All provider work uses a purpose-created disposable staging work identity.
 */
import { validId } from './titan-canonical-receiver.mjs';

const fail=code=>{throw new Error(`agent3-staging-${code}`)};
const required=(o,k)=>{if(typeof o?.[k]!=='function')throw new TypeError(`agent3-staging-port-required:${k}`)};
const fingerprint=x=>x && ['company_id','work_id','worker_id','reservation_id','idempotency_key','decision_ref']
  .every(k=>typeof x[k]==='string'&&validId(x[k]));
const safeSubject=s=>{
  if(!s||typeof s!=='object'||Array.isArray(s)||
     !['company_id','work_id','worker_id','tenant','actor_id','decision_ref','idempotency_key'].every(k=>validId(s[k]))||
     typeof s.credential_ref!=='string'||!/^[-A-Za-z0-9._:/]{1,256}$/.test(s.credential_ref)||
     ['token','secret','password','apiKey','url','payload'].some(k=>Object.hasOwn(s,k)))fail('input-invalid');
  if(s.environment!=='isolated-staging' || s.staging_confirmation!=='I_AUTHORIZE_A_DISPOSABLE_HATCHET_WORKFLOW')
    fail('explicit-nonproduction-confirmation-required');
  return s;
};
const verifiedApproval=(v,s)=>v?.allowed===true&&v.company_id===s.company_id&&v.work_id===s.work_id&&
  v.actor_id===s.actor_id&&v.decision_ref===s.decision_ref&&v.environment==='isolated-staging'&&
  v.expires_at && Number.isFinite(Date.parse(v.expires_at)) && Date.parse(v.expires_at)>Date.now();
const checkedList=(v,s)=>{
  if(!v||v.complete!==true||v.next_cursor!==null||!Number.isSafeInteger(v.total)||v.total<0||v.total>100||
     !Array.isArray(v.runs)||v.total!==v.runs.length || v.runs.some(r=>r.company_id!==s.company_id||
       r.work_id!==s.work_id||r.tenant!==s.tenant||r.idempotency_key!==s.idempotency_key||!validId(r.hatchet_run_id)))fail('provider-list-incomplete');
  return v;
};
/**
 * `authorizeStaging` MUST implement current human approval + independent
 * staging-only work and worker registration. It must NOT be derived from the
 * caller's object. `attestDeployment` comes from a real operator deployment
 * inventory, NOT the SDK's `workerHealth` response.
 */
export function createHatchetLiveStagingAcceptance({durable,transport,authorizeStaging,attestDeployment,now=()=>new Date().toISOString()}={}){
  for(const name of ['reserveDispatch','markAccepted','markUncertain','getDispatch'])required(durable,name);
  for(const name of ['submit','listRunsByMetadata','runStatus','workerHealth'])required(transport,name);
  if(typeof authorizeStaging!=='function'||typeof attestDeployment!=='function')fail('trust-ports-required');
  const attest=async s=>{
    const [authority,deployment,health]=await Promise.all([
      authorizeStaging({company_id:s.company_id,work_id:s.work_id,actor_id:s.actor_id,worker_id:s.worker_id,
        action:'hatchet.staging.one-shot',environment:'isolated-staging'}),
      attestDeployment({company_id:s.company_id,tenant:s.tenant,worker_id:s.worker_id}),
      transport.workerHealth({company_id:s.company_id,work_id:s.work_id,tenant:s.tenant,credential_ref:s.credential_ref,worker_id:s.worker_id}),
    ]);
    if(!verifiedApproval(authority,s))fail('staging-authority-invalid');
    if(deployment?.verified!==true||deployment.environment!=='isolated-staging'||
       deployment.company_id!==s.company_id||deployment.tenant!==s.tenant||
       deployment.worker_id!==s.worker_id||!validId(deployment.deployment_ref))fail('live-deployment-not-attested');
    if(health?.state!=='HEALTHY'||health.tenant!==s.tenant||health.worker_id!==s.worker_id)fail('worker-not-healthy');
    return {deployment_ref:deployment.deployment_ref};
  };
  const list=s=>transport.listRunsByMetadata({company_id:s.company_id,work_id:s.work_id,tenant:s.tenant,
    credential_ref:s.credential_ref,idempotency_key:s.idempotency_key,limit:101});
  return Object.freeze({
    /** Read-only: never takes a new reservation or assumes a missing run is safe to retry. */
    async inspect(input){
      const s=safeSubject(input);
      const {deployment_ref}=await attest(s);
      const [durableRow,search]=await Promise.all([durable.getDispatch(s),list(s)]);
      const page=checkedList(search,s);
      return Object.freeze({schema:'titan.agent3.live-staging-report/v1',company_id:s.company_id,
        work_id:s.work_id,tenant:s.tenant,worker_id:s.worker_id,deployment_ref,
        reserved_state:durableRow?.state??null,provider_run_count:page.total,
        safe_to_retry:false,business_outcome_verified:false,inspection_only:true});
    },
    /** Single explicitly approved effect: no implicit retries, no polling storm. */
    async executeOnce(input){
      const s=safeSubject(input);
      const {deployment_ref}=await attest(s);
      const existing=await durable.getDispatch(s);
      if(existing)fail('reservation-exists-reconcile-first');
      const before=checkedList(await list(s),s);
      if(before.total!==0)fail('existing-provider-run-reconcile-first');
      const reservation=await durable.reserveDispatch({company_id:s.company_id,work_id:s.work_id,
        worker_id:s.worker_id,idempotency_key:s.idempotency_key,decision_ref:s.decision_ref});
      if(!reservation?.created || !validId(reservation.reservation_id))fail('reservation-not-new');
      const outbound={company_id:s.company_id,work_id:s.work_id,worker_id:s.worker_id,
        reservation_id:reservation.reservation_id,idempotency_key:s.idempotency_key,decision_ref:s.decision_ref,
        tenant:s.tenant,credential_ref:s.credential_ref};
      if(!fingerprint(outbound))fail('invalid-durable-fingerprint');
      let acknowledged;
      try {
        // Re-read operator approval, registered staging deployment and worker
        // health AFTER reservation and immediately before provider egress.
        // A revoked approval never launches a workflow. The reservation stays
        // UNCERTAIN for supervised cleanup, not automatic resubmission.
        await attest(s);
        // The SDK transport itself atomically claims this reservation before
        // provider egress. If ACK is lost, the permanent UNCERTAIN row remains.
        const response=await transport.submit(outbound);
        if(!validId(response?.hatchet_run_id))fail('provider-ack-missing');
        acknowledged=await durable.markAccepted({...outbound,hatchet_run_id:response.hatchet_run_id});
      } catch(cause) {
        await durable.markUncertain(outbound).catch(()=>undefined);
        throw new Error('agent3-staging-outcome-uncertain-reconcile-only',{cause});
      }
      // Do NOT automatically submit again even when the provider listing is
      // empty or its page cannot be proven complete.
      let observed=null, observation_error=null;
      try{
        const after=checkedList(await list(s),s);
        if(after.total!==1 || after.runs[0].hatchet_run_id!==acknowledged.hatchet_run_id)
          fail('provider-run-uniqueness-not-confirmed');
        const status=await transport.runStatus({...outbound,hatchet_run_id:acknowledged.hatchet_run_id});
        observed=status.status;
      }catch(error){
        // Provider exceptions can embed credentials, query text or tenant
        // metadata. Never include raw exception messages in a report.
        observation_error=error?.message==='agent3-staging-provider-list-incomplete'
          ? 'LIST_INCOMPLETE' : error?.message==='agent3-staging-provider-run-uniqueness-not-confirmed'
          ? 'PROVIDER_OBSERVATION_UNVERIFIED' : 'RUN_STATUS_UNAVAILABLE';
      }
      const status=observation_error?'REQUIRES_RECONCILIATION':observed==='COMPLETED'?'PROVIDER_COMPLETED':'PROVIDER_ACCEPTED';
      return Object.freeze({schema:'titan.agent3.live-staging-report/v1',company_id:s.company_id,
        work_id:s.work_id,worker_id:s.worker_id,tenant:s.tenant,deployment_ref,
        checked_at:now(),run_id:acknowledged.hatchet_run_id,status,
        provider_status:observed,observation_error,
        provider_uniqueness_verified:!observation_error,
        safe_to_retry:false,business_outcome_verified:false,
        commissioning_approved:false});
    },
  });
}
