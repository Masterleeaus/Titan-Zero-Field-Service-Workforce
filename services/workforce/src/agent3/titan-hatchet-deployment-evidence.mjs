/**
 * Read-only independent staging deployment evidence for an actual Hatchet
 * tenant, worker and registered workflow. Never starts jobs or reads tokens.
 *
 * Unlike a workerHealth() boolean, a genuine operator commissioning review
 * must join three separate authorities:
 *   1. Titan's registered, versioned staging-only deployment inventory;
 *   2. the credential-bound Hatchet tenant identity;
 *   3. complete provider worker/workflow inventories with fresh heartbeat.
 *
 * The adapter ports are privileged connectors to REAL external observations;
 * callers MUST NOT implement them by echoing the requested fields. Tests use
 * controlled observations, never claim that actual Hatchet has been contacted.
 */
import {validId} from './titan-canonical-receiver.mjs';
const deny=code=>{throw new Error(`agent3-deployment-evidence-${code}`);};
const checkId=value=>validId(value)&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
const deniedFields=['token','secret','password','api_key','apiKey','connectionString','url'];
const noSecrets=value=>!value||typeof value!=='object'||deniedFields.every(x=>!Object.hasOwn(value,x));
const assertList=(listing,where)=>{
  if(!listing||listing.complete!==true||listing.next_cursor!==null||
     !Number.isSafeInteger(listing.total)||listing.total<0||listing.total>100||
     !Array.isArray(listing.items)||listing.total!==listing.items.length)
    deny(`${where}-inventory-incomplete`);
  return listing.items;
};
const unixTime=(x,now)=>{
  const n=Date.parse(x);
  if(typeof x!=='string'||!Number.isFinite(n)||n>now+5000)return null;
  return n;
};
export function createHatchetDeploymentEvidenceVerifier({
  resolveRegistration,resolveTenantClient,observeTenant,enumerateWorkers,
  enumerateWorkflows,clock=()=>Date.now(),maxHeartbeatAgeMs=120_000,
}={}){
  for(const [key,fn] of Object.entries({resolveRegistration,resolveTenantClient,
    observeTenant,enumerateWorkers,enumerateWorkflows}))
    if(typeof fn!=='function')throw new TypeError(`agent3-evidence-port-required:${key}`);
  if(!Number.isSafeInteger(maxHeartbeatAgeMs)||maxHeartbeatAgeMs<10_000||maxHeartbeatAgeMs>300_000 ||
     typeof clock!=='function')deny('configuration-invalid');
  async function verify({company_id,tenant,worker_id,workflow_name}={}){
    for(const value of [company_id,tenant,worker_id,workflow_name])
      if(!checkId(value))deny('subject-invalid');
    const reg=await resolveRegistration({company_id,tenant,worker_id,workflow_name});
    if(!noSecrets(reg)||reg?.schema!=='titan.agent3.registered-deployment/v1'||
       reg.company_id!==company_id||reg.tenant!==tenant||
       reg.worker_id!==worker_id||reg.workflow_name!==workflow_name||
       reg.environment!=='isolated-staging'||reg.state!=='READY'||
       !checkId(reg.deployment_ref)||!checkId(reg.revision)||
       !checkId(reg.workflow_id)||typeof reg.credential_ref!=='string'||
       !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(reg.credential_ref)||
       !checkId(reg.approved_by)||reg.live_execution_allowed!==true)
      deny('registration-not-approved');
    const client=await resolveTenantClient({company_id,tenant,credential_ref:reg.credential_ref});
    if(!client||client.tenantId!==tenant||!noSecrets(client))deny('tenant-client-mismatch');
    const [tenantDetail,workerInventory,workflowInventory]=await Promise.all([
      observeTenant({client,company_id,tenant}),
      enumerateWorkers({client,company_id,tenant,limit:101}),
      enumerateWorkflows({client,company_id,tenant,limit:101}),
    ]);
    if(!noSecrets(tenantDetail)||tenantDetail?.tenant!==tenant||
       tenantDetail.state!=='ACTIVE'||tenantDetail.provider!=='hatchet')deny('tenant-not-observed');
    const workers=assertList(workerInventory,'workers');
    const workflows=assertList(workflowInventory,'workflows');
    // Duplicates are ambiguous even if their IDs agree: a provider listing
    // must establish one registered worker and one registered workflow.
    const candidates=workers.filter(x=>x?.worker_id===worker_id);
    const tasks=workflows.filter(x=>x?.workflow_name===workflow_name);
    if(candidates.length!==1||tasks.length!==1)deny('provider-identity-ambiguous');
    const w=candidates[0],task=tasks[0];
    if(!noSecrets(w)||!noSecrets(task)||w.tenant!==tenant||
       w.deployment_ref!==reg.deployment_ref||w.state!=='HEALTHY'||
       task.tenant!==tenant||task.workflow_id!==reg.workflow_id||
       task.state!=='REGISTERED')deny('deployment-not-observed');
    const now=clock();
    if(!Number.isSafeInteger(now)||now<1)deny('clock-invalid');
    const beat=unixTime(w.last_heartbeat_at,now);
    const providerObserved=unixTime(w.observed_at,now);
    const workflowObserved=unixTime(task.observed_at,now);
    if(beat===null||providerObserved===null||workflowObserved===null||
       now-beat>maxHeartbeatAgeMs||now-providerObserved>maxHeartbeatAgeMs||
       now-workflowObserved>maxHeartbeatAgeMs)deny('provider-observation-stale');
    // Prevent the operator registry from moving revisions between the two
    // provider reads and approval output. This is observation, not an
    // execution fence; runtime must still perform its own last-second checks.
    const current=await resolveRegistration({company_id,tenant,worker_id,workflow_name});
    if(current?.revision!==reg.revision||current?.state!=='READY'||
       current?.live_execution_allowed!==true||current?.credential_ref!==reg.credential_ref||
       current?.deployment_ref!==reg.deployment_ref)deny('registration-changed');
    return Object.freeze({verified:true,schema:'titan.agent3.live-deployment-evidence/v1',
      company_id,tenant,worker_id,workflow_name,deployment_ref:reg.deployment_ref,
      registration_revision:reg.revision,workflow_id:reg.workflow_id,
      environment:'isolated-staging',provider:'hatchet',last_heartbeat_at:w.last_heartbeat_at,
      provider_observed_at:w.observed_at,reviewer:reg.approved_by,
      safe_to_retry:false,business_outcome_verified:false,
      live_execution_permitted_by_registration:true});
  }
  return Object.freeze({verify,
    // One helper for createHatchetLiveStagingAcceptance.attestDeployment.
    // The registered workflow name is an OPERATOR port; never supplied by
    // an HTTP/request body or guessed from a user-facing worker alias.
    createStagingAttestor:resolveWorkflowName=>{
      if(typeof resolveWorkflowName!=='function')deny('trusted-workflow-resolver-required');
      return async({company_id,tenant,worker_id})=>{
        const workflow_name=await resolveWorkflowName({company_id,tenant,worker_id});
        const proof=await verify({company_id,tenant,worker_id,workflow_name});
        return Object.freeze({verified:proof.verified,company_id,tenant,worker_id,
          environment:'isolated-staging',deployment_ref:proof.deployment_ref});
      };
    },
  });
}
