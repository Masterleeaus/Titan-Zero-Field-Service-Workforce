/**
 * Durable, exclusive operator-side Hatchet staging intent journal.
 *
 * A staging test is a possible external effect. Before even attempting it,
 * write and fsync an exclusive no-overwrite intent with no credentials. If a
 * process crashes after the external call but before the result is saved,
 * the intent survives and the next invocation refuses to repeat the effect.
 * The provider and Titan canonical durable table are still the authorities
 * for reconciliation; this journal is only an additional operator audit trail.
 *
 * The operator supplies an ABSOLUTE report path in a trusted local directory;
 * no arbitrary URLs, symlink output paths, environment-derived credentials or
 * overwrite operations are accepted. Uses same-directory atomic hard link to
 * commit the result without ever replacing an existing destination.
 */
import {open, lstat, readFile, link, rm, stat} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const fail = reason => {throw new Error(`agent3-staging-journal-${reason}`)};
const clean = value => typeof value==='string' && value.length>0 && value.length<=256 &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const safeKeys = ['schema','company_id','work_id','tenant','worker_id','deployment_ref',
  'checked_at','run_id','status','provider_status','observation_error','provider_uniqueness_verified',
  'safe_to_retry','business_outcome_verified','commissioning_approved','inspection_only',
  'provider_run_count','reserved_state'];
const missing=async path => {
  try { return await lstat(path); }
  catch(e){ if(e?.code==='ENOENT')return null; throw e; }
};
// fsync the parent directory after creating a journal entry or final link:
// syncing the file alone does not make new directory entries crash-durable.
async function syncParent(path){
  const fd=await open(dirname(path),'r');
  try{await fd.sync();}finally{await fd.close();}
}
const stableFingerprint=subject=>createHash('sha256').update(JSON.stringify({
  company_id:subject.company_id,work_id:subject.work_id,worker_id:subject.worker_id,
  tenant:subject.tenant,idempotency_key:subject.idempotency_key,
})).digest('hex');
async function writeExclusive(path,object){
  const handle=await open(path,'wx',0o600);
  let ok=false;
  try{ await handle.writeFile(JSON.stringify(object,null,2)+'\n','utf8');await handle.sync();ok=true;}
  finally {await handle.close();if(!ok)await rm(path,{force:true}).catch(()=>undefined);}
}
export function createHatchetStagingJournal({reportPath,mode,subject,clock=()=>new Date().toISOString()}={}){
  if(!['inspect','execute'].includes(mode)||!subject || typeof subject!=='object' ||
    !['company_id','work_id','worker_id','tenant','idempotency_key'].every(k=>clean(subject[k])) ||
    typeof reportPath!=='string'||!isAbsolute(reportPath)||
    reportPath!==resolve(reportPath)||basename(reportPath).startsWith('.')) fail('invalid-input');
  const parent=dirname(reportPath), intentPath=`${reportPath}.intent`;
  let stage='NEW';
  let fingerprint=stableFingerprint(subject);
  async function validateDirectory(){
    const directory=await stat(parent);
    if(!directory.isDirectory() || (directory.mode & 0o022)!==0)fail('directory-untrusted');
    const meta=await lstat(parent);
    if(meta.isSymbolicLink())fail('directory-symlink');
    if(await missing(reportPath))fail('report-exists');
    if(await missing(intentPath))fail('previous-attempt-exists');
  }
  async function begin(){
    if(stage!=='NEW')fail('already-started');
    await validateDirectory();
    const intent=Object.freeze({schema:'titan.agent3.staging-intent/v1',
      mode,request_sha256:fingerprint,recorded_at:clock(),
      state:mode==='execute'?'EFFECT_MAY_OCCUR':'READ_ONLY',
      safe_to_retry:false,commissioning_approved:false});
    try{await writeExclusive(intentPath,intent);}
    catch(e){ if(e.code==='EEXIST')fail('previous-attempt-exists');throw e; }
    await syncParent(intentPath);
    stage='INTENT_RECORDED';
    return Object.freeze({intentPath,request_sha256:fingerprint});
  }
  async function finalize(result){
    if(stage!=='INTENT_RECORDED')fail('intent-required');
    if(result?.schema!=='titan.agent3.live-staging-report/v1' ||
       result.company_id!==subject.company_id||result.work_id!==subject.work_id||
       result.tenant!==subject.tenant||result.worker_id!==subject.worker_id ||
       result.safe_to_retry!==false)fail('result-invalid');
    const payload=Object.fromEntries(safeKeys.filter(k=>Object.hasOwn(result,k)).map(k=>[k,result[k]]));
    // No provider stack/exception details in customer-visible or operator
    // artifacts: observation_error is a fixed category only.
    if(payload.observation_error!==undefined &&
       !['LIST_INCOMPLETE','RUN_STATUS_UNAVAILABLE','PROVIDER_OBSERVATION_UNVERIFIED'].includes(payload.observation_error))
      fail('untrusted-error-category');
    const tmp=join(parent,`.${basename(reportPath)}.${randomUUID()}.tmp`);
    try{
      await writeExclusive(tmp,{...payload,intent_sha256:fingerprint});
      // link() is atomic and must fail if target was created by another
      // process. rename() would silently overwrite on POSIX.
      await link(tmp,reportPath);
      await syncParent(reportPath);
    }catch(e){if(e?.code==='EEXIST')fail('report-exists');throw e;}
    finally {await rm(tmp,{force:true}).catch(()=>undefined);}
    stage='COMMITTED';
    return Object.freeze({reportPath,intentPath,status:payload.status??'INSPECTED',safe_to_retry:false});
  }
  return Object.freeze({begin,finalize,paths:Object.freeze({reportPath,intentPath})});
}

/** Offline, read-only operator reconciliation of the intent and report.
 * This does NOT call Hatchet, submit, retry, or certify business evidence. */
export async function inspectStagingJournal(reportPath){
  if(typeof reportPath!=='string'||!isAbsolute(reportPath))fail('path-invalid');
  const intentMeta=await lstat(`${reportPath}.intent`);
  if(!intentMeta.isFile() || intentMeta.isSymbolicLink())fail('intent-invalid');
  const intent=JSON.parse(await readFile(`${reportPath}.intent`,'utf8'));
  if(intent?.schema!=='titan.agent3.staging-intent/v1'||!/^[a-f0-9]{64}$/.test(intent.request_sha256))fail('intent-invalid');
  const reportStat=await missing(reportPath);
  if(!reportStat)return Object.freeze({state:'ATTEMPT_UNKNOWN_RECONCILE_ONLY',
    mode:intent.mode,request_sha256:intent.request_sha256,safe_to_retry:false});
  if(reportStat.isSymbolicLink()||!reportStat.isFile())fail('report-invalid');
  const report=JSON.parse(await readFile(reportPath,'utf8'));
  if(report?.schema!=='titan.agent3.live-staging-report/v1' ||
     report.intent_sha256!==intent.request_sha256 || report.safe_to_retry!==false)
    fail('report-mismatch');
  return Object.freeze({state:'REPORT_RECORDED',mode:intent.mode,
    request_sha256:intent.request_sha256,status:report.status??'INSPECTED',safe_to_retry:false});
}
