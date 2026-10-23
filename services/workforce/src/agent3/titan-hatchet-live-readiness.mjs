/**
 * Independent operator-only gate before a disposable Hatchet staging canary.
 * Never invokes runNoWait, reserves work, marks business evidence, acquires a
 * startup/commissioning right, retries uncertain work, or reads credentials.
 * All ports must be from trusted, independent provider/registry observations.
 */
import {validId} from './titan-canonical-receiver.mjs';
import {verifyProviderIdempotencyPolicy} from './titan-hatchet-provider-idempotency.mjs';
const deny=()=>{throw new Error('agent3-live-staging-readiness-denied');};
const safe=x=>validId(x)&&x.length<=256&&!/[\u0000-\u001f\u007f]/.test(x);
const noSecrets=x=>x&&typeof x==='object'&&!Array.isArray(x)&&
 !['token','secret','password','apiKey','api_key','endpoint','url','payload'].some(k=>Object.hasOwn(x,k));
const required=['company_id','work_id','worker_id','tenant','workflow_name','actor_id','idempotency_key','decision_ref'];
export function createLiveStagingReadinessGate({verifyDeployment,inspectRegisteredWorkflowIdempotency,
  getDispatch,listRunsByMetadata,authorizeStaging,clock=()=>Date.now()}={}){
  for(const f of [verifyDeployment,inspectRegisteredWorkflowIdempotency,getDispatch,listRunsByMetadata,authorizeStaging,clock])
    if(typeof f!=='function')throw new TypeError('agent3-readiness-trusted-port-required');
  return Object.freeze({
    async assess(input){
      if(!noSecrets(input)||input.environment!=='isolated-staging'||
        !required.every(k=>safe(input[k])))deny();
      // Authority comes from a privileged decision port, never from a supplied
      // consent flag or synthetic provider health boolean.
      try{
        const now=clock();
        if(!Number.isSafeInteger(now)||now<1)deny();
        const a=await authorizeStaging({company_id:input.company_id,work_id:input.work_id,
          worker_id:input.worker_id,actor_id:input.actor_id,action:'hatchet.staging.one-shot'});
        const expires=Date.parse(a?.expires_at);
        if(a?.allowed!==true||a.company_id!==input.company_id||a.work_id!==input.work_id||
           a.actor_id!==input.actor_id||a.decision_ref!==input.decision_ref||
           a.environment!=='isolated-staging'||!Number.isFinite(expires)||
           expires<=now||expires-now>900_000)deny();
        const subject={company_id:input.company_id,tenant:input.tenant,
          worker_id:input.worker_id,workflow_name:input.workflow_name};
        const proof=await verifyDeployment(subject);
        if(proof?.schema!=='titan.agent3.live-deployment-evidence/v1'||
           proof.verified!==true||proof.environment!=='isolated-staging'||
           proof.company_id!==input.company_id||proof.tenant!==input.tenant||
           proof.worker_id!==input.worker_id||proof.workflow_name!==input.workflow_name||
           !safe(proof.deployment_ref)||!safe(proof.registration_revision)||
           !safe(proof.workflow_id))deny();
        const policy=await inspectRegisteredWorkflowIdempotency(subject);
        verifyProviderIdempotencyPolicy(policy,subject,{now:()=>clock()});
        if(policy.workflow_name!==input.workflow_name)deny();
        // A missing reservation is necessary for a new disposable work ID;
        // it is not sufficient proof that an external provider never ran it.
        const stored=await getDispatch({company_id:input.company_id,work_id:input.work_id});
        if(stored!==null && stored!==undefined)deny();
        const page=await listRunsByMetadata({company_id:input.company_id,
          work_id:input.work_id,tenant:input.tenant,idempotency_key:input.idempotency_key,limit:101});
        if(page?.complete!==true||page.next_cursor!==null||page.total!==0||
           !Array.isArray(page.runs)||page.runs.length!==0)deny();
        // A second observation closes the simplest registration revision race
        // during the slow inventory checks. Actual executor revalidates again.
        const current=await verifyDeployment(subject);
        if(current?.verified!==true||current.registration_revision!==proof.registration_revision||
           current.deployment_ref!==proof.deployment_ref||current.workflow_id!==proof.workflow_id||
           current.company_id!==input.company_id||current.tenant!==input.tenant)deny();
        return Object.freeze({schema:'titan.agent3.live-readiness/v1',
          company_id:input.company_id,work_id:input.work_id,tenant:input.tenant,
          deployment_ref:proof.deployment_ref,registration_revision:proof.registration_revision,
          staging_disposable_one_shot_eligible:true,commissioning_approved:false,
          safe_to_retry:false,business_outcome_verified:false,
          live_hatchet_execution_observed:false});
      }catch {deny();}
    },
  });
}
