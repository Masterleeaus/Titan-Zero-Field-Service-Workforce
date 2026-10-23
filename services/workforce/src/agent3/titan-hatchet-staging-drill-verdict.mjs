/**
 * Read-only independent proof collation for an isolated self-hosted Hatchet
 * canary. No provider egress, cancellation, reservation, database mutation,
 * retry, business acceptance or commissioning authority is exposed here.
 *
 * This consumer ONLY accepts observations supplied by distinct privileged
 * sources: the Titan deployment registry; Hatchet's COMPLETE provider run
 * inventory; Titan's canonical durable dispatch; Titan's accepted business
 * evidence ledger; and the operator's measured crash/rollback drill ledger.
 * A provider COMPLETED status, or a test double, is not accepted evidence.
 */
import { validId } from './titan-canonical-receiver.mjs';

const refused=()=>{throw new Error('agent3-staging-drill-evidence-unverified');};
const clean=x=>typeof x==='string' && validId(x) && x.length<=256 &&
  !/[\u0000-\u001f\u007f]/.test(x);
const safeTime=(raw,now,maxAgeMs)=>{
  const value=typeof raw==='string'?Date.parse(raw):NaN;
  if(!Number.isFinite(value)||value>now+5000||now-value>maxAgeMs)refused();
  return value;
};
const inputKeys=['company_id','work_id','actor_id','tenant','worker_id','workflow_name','decision_ref'];
const noSecrets=value=>value&&typeof value==='object'&&!Array.isArray(value)&&
  !['token','secret','password','credential_ref','apiKey','api_key','endpoint','url','payload','client'].some(x=>Object.hasOwn(value,x));
const matching=(actual,subject,fields)=>fields.every(k=>actual?.[k]===subject[k]);
const acceptedRow=(row,s)=>row?.state==='ACCEPTED'&&
  matching(row,s,['company_id','work_id','worker_id','decision_ref'])&&
  clean(row.reservation_id)&&clean(row.hatchet_run_id)&&
  row.idempotency_key===s.idempotency_key;
// Every proof included in a positive verdict is re-observed after all other
// I/O completes. Never rely solely on a first-read provider/evidence/drill
// snapshot; those can be revoked or changed during an asynchronous review.
const sameProviderInventory=(page,s,run)=>page?.complete===true&&
  page.next_cursor===null&&page.total===1&&Array.isArray(page.runs)&&
  page.runs.length===1&&matching(page.runs[0],s,
    ['company_id','work_id','tenant','idempotency_key'])&&
  page.runs[0].hatchet_run_id===run;
const providerCompleted=(record,s,run)=>matching(record,s,
  ['company_id','work_id','tenant'])&&record?.hatchet_run_id===run&&
  record.status==='COMPLETED';
const evidenceIdentity=(r)=>Object.freeze({
  acceptance_ref:r.acceptance_ref,authority_revision:r.authority_revision,
  accepted_at:r.accepted_at,hatchet_run_id:r.hatchet_run_id,
});
const drillIdentity=(r)=>Object.freeze({
  drill_ref:r.drill_ref,observer_ref:r.observer_ref,rollback_ref:r.rollback_ref,
  observed_at:r.observed_at,hatchet_run_id:r.hatchet_run_id,
});
const sameFields=(a,b)=>Object.keys(a).every(k=>a[k]===b[k]);
const approvedEvidence=(record,s,run,now)=>{
  if(record?.schema!=='titan.agent3.accepted-business-evidence/v1'||
     record.verified!==true||record.accepted!==true||
     !matching(record,s,['company_id','work_id','decision_ref'])||
     record.hatchet_run_id!==run||!clean(record.acceptance_ref)||
     !clean(record.authority_revision)||record.staging_only!==true)refused();
  safeTime(record.accepted_at,now,86_400_000);
};
const measuredDrill=(drill,s,run,now)=>{
  if(drill?.schema!=='titan.agent3.operator-drill-evidence/v1'||
     drill.verified!==true||drill.environment!=='isolated-staging'||
     !matching(drill,s,['company_id','work_id','tenant'])||
     drill.hatchet_run_id!==run||!clean(drill.drill_ref)||
     !clean(drill.observer_ref)||!clean(drill.rollback_ref)||
     drill.ack_loss?.observed!==true||drill.ack_loss?.resubmissions!==0||
     drill.worker_restart?.observed!==true||drill.worker_restart?.duplicate_runs!==0||
     drill.rollback?.tested!==true||drill.rollback?.successful!==true||
     drill.rollback?.production_modified!==false||
     drill.rollback?.tenant!==s.tenant)refused();
  safeTime(drill.observed_at,now,86_400_000);
};
/** The operator may feed the result into a formal approval process, but no
 * capability, token, request or flag in it enables hosted commissioning. */
export function createHatchetStagingDrillVerifier({authorizeReview,readDeployment,
  readCanonicalDispatch,listProviderRuns,readProviderRun,readAcceptedBusinessEvidence,
  readMeasuredDrill,clock=()=>Date.now()}={}) {
  for(const fn of [authorizeReview,readDeployment,readCanonicalDispatch,listProviderRuns,
    readProviderRun,readAcceptedBusinessEvidence,readMeasuredDrill,clock]){
    if(typeof fn!=='function')throw new TypeError('agent3-staging-drill-trusted-port-required');
  }
  return Object.freeze({
    async assess(subject) {
      if(!noSecrets(subject)||subject.environment!=='isolated-staging'||
         !inputKeys.every(k=>clean(subject[k]))||!clean(subject.idempotency_key))refused();
      try{
        const now=clock();
        if(!Number.isSafeInteger(now)||now<1)refused();
        const approved=await authorizeReview({company_id:subject.company_id,
          work_id:subject.work_id,actor_id:subject.actor_id,action:'hatchet.staging.drill.review'});
        if(approved?.allowed!==true||!matching(approved,subject,['company_id','work_id','actor_id','decision_ref']))refused();
        const location={company_id:subject.company_id,tenant:subject.tenant,
          worker_id:subject.worker_id,workflow_name:subject.workflow_name};
        const deployment=await readDeployment(location);
        if(deployment?.schema!=='titan.agent3.live-deployment-evidence/v1'||
           deployment.verified!==true||deployment.environment!=='isolated-staging'||
           !matching(deployment,subject,['company_id','tenant','worker_id','workflow_name'])||
           !clean(deployment.registration_revision)||!clean(deployment.deployment_ref)||
           !clean(deployment.workflow_id))refused();
        // Snapshot identity immediately: operators may return mutable cached
        // objects that change in-place during later provider observation.
        const initialDeployment=Object.freeze({
          registration_revision:deployment.registration_revision,
          deployment_ref:deployment.deployment_ref,workflow_id:deployment.workflow_id});
        const row=await readCanonicalDispatch({company_id:subject.company_id,work_id:subject.work_id});
        if(!acceptedRow(row,subject))refused();
        const runId=row.hatchet_run_id;
        const found=await listProviderRuns({company_id:subject.company_id,work_id:subject.work_id,
          tenant:subject.tenant,idempotency_key:subject.idempotency_key,limit:101});
        // Only a complete provider inventory can establish exactly one run.
        if(!sameProviderInventory(found,subject,runId))refused();
        const run=await readProviderRun({company_id:subject.company_id,tenant:subject.tenant,
          work_id:subject.work_id,hatchet_run_id:runId});
        if(!providerCompleted(run,subject,runId))refused();
        const evidence=await readAcceptedBusinessEvidence({company_id:subject.company_id,
          work_id:subject.work_id,hatchet_run_id:runId});
        approvedEvidence(evidence,subject,runId,now);
        const initialEvidence=evidenceIdentity(evidence);
        const drill=await readMeasuredDrill({company_id:subject.company_id,
          work_id:subject.work_id,tenant:subject.tenant,hatchet_run_id:runId});
        measuredDrill(drill,subject,runId,now);
        const initialDrill=drillIdentity(drill);
        // Final observation includes EVERY positive source, not just the
        // company registry and reviewer approval. A status revocation,
        // provider duplicate, evidence withdrawal or rollback drift must
        // prevent a positive report even if an earlier snapshot passed.
        const [freshDeployment,freshRow,freshApproval,freshInventory,
          freshRun,freshEvidence,freshDrill]=await Promise.all([
          readDeployment(location),
          readCanonicalDispatch({company_id:subject.company_id,work_id:subject.work_id}),
          authorizeReview({company_id:subject.company_id,work_id:subject.work_id,
            actor_id:subject.actor_id,action:'hatchet.staging.drill.review'}),
          listProviderRuns({company_id:subject.company_id,work_id:subject.work_id,
            tenant:subject.tenant,idempotency_key:subject.idempotency_key,limit:101}),
          readProviderRun({company_id:subject.company_id,tenant:subject.tenant,
            work_id:subject.work_id,hatchet_run_id:runId}),
          readAcceptedBusinessEvidence({company_id:subject.company_id,
            work_id:subject.work_id,hatchet_run_id:runId}),
          readMeasuredDrill({company_id:subject.company_id,
            work_id:subject.work_id,tenant:subject.tenant,hatchet_run_id:runId})]);
        if(freshDeployment?.verified!==true||
           freshDeployment.registration_revision!==initialDeployment.registration_revision||
           freshDeployment.deployment_ref!==initialDeployment.deployment_ref||
           freshDeployment.workflow_id!==initialDeployment.workflow_id||
           !acceptedRow(freshRow,subject)||freshRow.hatchet_run_id!==runId||
           freshApproval?.allowed!==true||!matching(freshApproval,subject,
             ['company_id','work_id','actor_id','decision_ref'])||
           !sameProviderInventory(freshInventory,subject,runId)||
           !providerCompleted(freshRun,subject,runId))refused();
        approvedEvidence(freshEvidence,subject,runId,now);
        measuredDrill(freshDrill,subject,runId,now);
        if(!sameFields(evidenceIdentity(freshEvidence),initialEvidence)||
           !sameFields(drillIdentity(freshDrill),initialDrill))refused();
        const completedAt=clock();
        if(!Number.isSafeInteger(completedAt)||completedAt<now||completedAt-now>60_000)refused();
        return Object.freeze({schema:'titan.agent3.staging-drill-verdict/v1',
          company_id:subject.company_id,work_id:subject.work_id,tenant:subject.tenant,
          deployment_ref:deployment.deployment_ref,registration_revision:deployment.registration_revision,
          provider_run_count:1,canonical_dispatch_accepted:true,
          canonical_business_evidence_accepted:true,independent_crash_drill_observed:true,
          isolated_rollback_observed:true,verdict:'STAGING_DRILL_REVIEWABLE',
          safe_to_retry:false,business_outcome_verified:true,
          commissioning_approved:false,production_ready:false,
          requires_independent_release_approval:true});
      }catch{refused();}
    },
  });
}
