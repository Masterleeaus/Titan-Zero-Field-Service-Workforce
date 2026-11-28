/**
 * Operator-only, read-only crash reconciliation for a Hatchet staging intent.
 *
 * This lane NEVER submits, retries, reclaims, cancels, mutates a canonical
 * table, accepts a provider business outcome, or lifts commissioning gates.
 * It joins the fsynced staging intent with fresh company-scoped canonical
 * dispatch state and an independently COMPLETE provider run inventory.
 *
 * A provider's empty listing is NOT proof that a previously attempted effect
 * did not occur. All states remain unsafe to retry and require accountable
 * human/authority follow-up before any separate operational action.
 */
import {createHash} from 'node:crypto';
import {inspectStagingJournal} from './titan-hatchet-staging-journal.mjs';
import {validId} from './titan-canonical-receiver.mjs';

const deny=code=>{throw new Error(`agent3-staging-recovery-${code}`)};
const clean=x=>typeof x==='string'&&validId(x)&&x.length<=256&&!/[\u0000-\u001f\u007f]/.test(x);
const k=['company_id','work_id','worker_id','tenant','idempotency_key'];
const fingerprint=s=>createHash('sha256').update(JSON.stringify(Object.fromEntries(k.map(x=>[x,s[x]])))).digest('hex');
const STATE=Object.freeze({
  NO_TITAN_RESERVATION:'NO_TITAN_RESERVATION',
  TITAN_RESERVED:'TITAN_RESERVED',
  TITAN_UNCERTAIN:'TITAN_UNCERTAIN',
  TITAN_ACCEPTED:'TITAN_ACCEPTED',
  TITAN_UNKNOWN:'TITAN_UNKNOWN',
});
const outcome=Object.freeze({
  INCOMPLETE:'PROVIDER_INVENTORY_INCOMPLETE',
  UNAVAILABLE:'PROVIDER_INVENTORY_UNAVAILABLE',
  MULTIPLE:'DUPLICATE_PROVIDER_RUNS',
  NONE:'PROVIDER_RUN_NOT_PROVEN',
  SINGLE:'ONE_PROVIDER_RUN_OBSERVED',
  CONSISTENT:'EXISTING_ACCEPTED_RUN_MATCHES',
  DIVERGENT:'ACCEPTED_PROVIDER_RUN_MISMATCH',
});
const safeRow=(row,s)=>{
  if(row==null)return null;
  if(typeof row!=='object'||row.company_id!==s.company_id||row.work_id!==s.work_id||
     row.worker_id!==s.worker_id||row.idempotency_key!==s.idempotency_key||
     !clean(row.reservation_id)||!['RESERVED','UNCERTAIN','ACCEPTED','REJECTED','FAILED','CANCELLED'].includes(row.state) ||
     (row.hatchet_run_id!=null && !clean(row.hatchet_run_id)))deny('canonical-row-invalid');
  if(row.state==='ACCEPTED'&&!row.hatchet_run_id)deny('accepted-run-missing');
  return row;
};
const safePage=(page,s)=>{
  if(page?.complete!==true || page?.next_cursor!==null ||
     !Number.isSafeInteger(page.total)||page.total<0||page.total>100||
     !Array.isArray(page.runs)||page.total!==page.runs.length) return null;
  const ids=new Set();
  for(const run of page.runs){
    if(!run||run.company_id!==s.company_id||run.work_id!==s.work_id||
       run.tenant!==s.tenant||run.idempotency_key!==s.idempotency_key||
       !clean(run.hatchet_run_id) || ids.has(run.hatchet_run_id))return null;
    ids.add(run.hatchet_run_id);
  }
  return page.runs;
};
const category=(row,runs)=>{
  if(runs===null)return outcome.INCOMPLETE;
  if(runs.length>1)return outcome.MULTIPLE;
  if(runs.length===0)return outcome.NONE;
  if(row?.state==='ACCEPTED')return row.hatchet_run_id===runs[0].hatchet_run_id?outcome.CONSISTENT:outcome.DIVERGENT;
  return outcome.SINGLE;
};
const titanState=row=>!row?STATE.NO_TITAN_RESERVATION:row.state==='RESERVED'?STATE.TITAN_RESERVED:
  row.state==='UNCERTAIN'?STATE.TITAN_UNCERTAIN:row.state==='ACCEPTED'?STATE.TITAN_ACCEPTED:STATE.TITAN_UNKNOWN;

/**
 * All supplied ports are trusted, existing, read-only authority/data owners.
 * The operator has to resolve tenant credentials outside this function.
 */
export function createStagingCrashRecovery({durable,transport,authorizeInspect,assertDeployment,clock=()=>new Date().toISOString()}={}){
  if(typeof durable?.getDispatch!=='function'||typeof transport?.listRunsByMetadata!=='function'||
     typeof authorizeInspect!=='function'||typeof assertDeployment!=='function')deny('trusted-ports-required');
  return Object.freeze({
    async inspect({reportPath,subject,actor_id}){
      if(!subject||typeof subject!=='object'||!k.every(name=>clean(subject[name]))||
         !(typeof subject.credential_ref==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(subject.credential_ref))||!clean(actor_id)||
         ['token','secret','password','apiKey','api_key','payload','url'].some(x=>Object.hasOwn(subject,x)))deny('subject-invalid');
      // The journal is read first. A different report path cannot forge another
      // work identity; the five-field SHA binds the approved staging request.
      const journal=await inspectStagingJournal(reportPath);
      if(journal.request_sha256!==fingerprint(subject))deny('intent-identity-mismatch');
      let authority;
      try{authority=await authorizeInspect({company_id:subject.company_id,work_id:subject.work_id,
        actor_id,action:'hatchet.staging.recovery.inspect'});}
      catch{deny('authority-unavailable');}
      if(authority?.allowed!==true||authority.company_id!==subject.company_id||
         authority.work_id!==subject.work_id||!clean(authority.decision_ref))deny('authority-denied');
      let placement;
      try{placement=await assertDeployment({company_id:subject.company_id,work_id:subject.work_id,
        tenant:subject.tenant,worker_id:subject.worker_id});}
      catch{deny('deployment-unavailable');}
      if(placement?.verified!==true||placement.company_id!==subject.company_id||
         placement.tenant!==subject.tenant||placement.worker_id!==subject.worker_id||
         placement.environment!=='isolated-staging'||!clean(placement.deployment_ref))deny('deployment-not-verified');
      // This is an observation, not a claim or transaction. The existing durable
      // dispatch is never created or transitioned during inspection.
      let originalRow;
      try{originalRow=await durable.getDispatch({company_id:subject.company_id,work_id:subject.work_id});}
      catch{deny('canonical-read-unavailable');}
      const row=safeRow(originalRow,subject);
      let runs=null,providerFinding;
      try{
        const page=await transport.listRunsByMetadata({company_id:subject.company_id,
          work_id:subject.work_id,tenant:subject.tenant,credential_ref:subject.credential_ref,
          idempotency_key:subject.idempotency_key,limit:101});
        runs=safePage(page,subject);
        providerFinding=category(row,runs);
      }catch{providerFinding=outcome.UNAVAILABLE;}
      // Deliberately redact provider IDs, credentials and stack traces. A run
      // count/observation code is useful to an operator without disclosing a
      // sensitive cross-system reference to a report reader.
      return Object.freeze({schema:'titan.agent3.staging-recovery/v1',
        company_id:subject.company_id,work_id:subject.work_id,
        journal_state:journal.state,staging_mode:journal.mode,
        canonical_state:titanState(row),provider_finding:providerFinding,
        provider_run_count:runs?.length??null,checked_at:clock(),
        safe_to_retry:false,may_have_executed:journal.mode==='execute',
        business_outcome_verified:false,commissioning_approved:false,
        requires_operator_reconciliation:true});
    },
  });
}
