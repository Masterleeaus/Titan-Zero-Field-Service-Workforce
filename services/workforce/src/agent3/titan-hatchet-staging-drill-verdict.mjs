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
        const row=await readCanonicalDispatch({company_id:subject.company_id,work_id:subject.work_id});
        if(!acceptedRow(row,subject))refused();
        const found=await listProviderRuns({company_id:subject.company_id,work_id:subject.work_id,
          tenant:subject.tenant,idempotency_key:subject.idempotency_key,limit:101});
        // Only a complete provider inventory can establish exactly one run.
        if(found?.complete!==true||found.next_cursor!==null||found.total!==1||
           !Array.isArray(found.runs)||found.runs.length!==1||
           !matching(found.runs[0],subject,['company_id','work_id','tenant','idempotency_key'])||
           found.runs[0].hatchet_run_id!==row.hatchet_run_id)refused();
        const run=await readProviderRun({company_id:subject.company_id,tenant:subject.tenant,
          work_id:subject.work_id,hatchet_run_id:row.hatchet_run_id});
        if(!matching(run,subject,['company_id','work_id','tenant'])||
           run.hatchet_run_id!==row.hatchet_run_id||run.status!=='COMPLETED')refused();
        const evidence=await readAcceptedBusinessEvidence({company_id:subject.company_id,
          work_id:subject.work_id,hatchet_run_id:row.hatchet_run_id});
        approvedEvidence(evidence,subject,row.hatchet_run_id,now);
        const drill=await readMeasuredDrill({company_id:subject.company_id,
          work_id:subject.work_id,tenant:subject.tenant,hatchet_run_id:row.hatchet_run_id});
        measuredDrill(drill,subject,row.hatchet_run_id,now);
        // Do not rely on the admission snapshot after slow provider/ledger IO.
        const [freshDeployment,freshRow,freshApproval]=await Promise.all([
          readDeployment(location),
          readCanonicalDispatch({company_id:subject.company_id,work_id:subject.work_id}),
          authorizeReview({company_id:subject.company_id,work_id:subject.work_id,
            actor_id:subject.actor_id,action:'hatchet.staging.drill.review'})]);
        if(freshDeployment?.verified!==true||
           freshDeployment.registration_revision!==deployment.registration_revision||
           freshDeployment.deployment_ref!==deployment.deployment_ref||
           freshDeployment.workflow_id!==deployment.workflow_id||
           !acceptedRow(freshRow,subject)||freshRow.hatchet_run_id!==row.hatchet_run_id||
           freshApproval?.allowed!==true||!matching(freshApproval,subject,
             ['company_id','work_id','actor_id','decision_ref']))refused();
        if(clock()-now>60_000||clock()<now)refused();
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
