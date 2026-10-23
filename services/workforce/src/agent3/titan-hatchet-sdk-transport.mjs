/**
 * Titan's trusted Hatchet v1 SDK boundary.  An operator must supply the
 * credential-resolved client and registered workflow. This is a narrow port,
 * NOT a second scheduler/authority/evidence ledger, and cannot be driven by
 * external HTTP request bodies or caller-selected Hatchet URLs.
 *
 * SDK compatibility reference (2026-10): workflow.runNoWait(input) returns a
 * WorkflowRunRef; `runs.get` and `runs.cancel` inspect/cancel runs. Exact
 * list/search and worker-health implementations are deliberately supplied by
 * the trusted operator instead of guessing a version-specific REST endpoint.
 *
 * Our canonical reservation MUST exist before calling submit(). The adapter
 * cannot prove it by itself; require durable.getDispatch and compare every
 * authoritative reservation field before one external effect. If acknowledgement
 * is lost, the caller MUST mark the reservation uncertain, not retry it.
 */
import { validId } from './titan-canonical-receiver.mjs';
import {verifyProviderIdempotencyPolicy} from './titan-hatchet-provider-idempotency.mjs';

const fail = code => { throw new Error(`hatchet-sdk-${code}`); };
const bounded = (v, name) => {
  if (!validId(v) || v.length>256 || /[\u0000-\u001f\u007f]/.test(v)) fail(`${name}-invalid`);
  return v;
};
const noCredentials = record => {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      ['token','secret','password','apiKey','api_key'].some(x=>Object.hasOwn(record,x))) fail('raw-credential-denied');
};
function requiredFn(object,name) {
  if (typeof object?.[name] !== 'function') throw new TypeError(`hatchet-sdk-required:${name}`);
}
const identity = record => {
  noCredentials(record);
  for (const key of ['company_id','work_id','tenant']) bounded(record[key],key);
  if (typeof record.credential_ref!=='string' || record.credential_ref.length>256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]+$/.test(record.credential_ref)) fail('credential-ref-invalid');
  return record;
};
const verifyClient = (resolved,expectedTenant) => {
  if (!resolved || resolved.tenantId!==expectedTenant) fail('tenant-client-mismatch');
  return resolved;
};
const runId = ref => {
  // WorkflowRunRef exported by the Hatchet TS v1 SDK exposes workflowRunId.
  // Accept only this shape; never infer a run ID from a request or payload.
  const value=ref?.workflowRunId;
  return bounded(value,'run-ref');
};
const sameReservation = (row,input) => row &&
  row.company_id===input.company_id && row.work_id===input.work_id &&
  row.worker_id===input.worker_id && row.reservation_id===input.reservation_id &&
  row.idempotency_key===input.idempotency_key && row.decision_ref===input.decision_ref &&
  row.state==='RESERVED' && row.hatchet_run_id===null;

/** Bind by trusted company/tenant only; only reads listed SDK capabilities. */
export function createGovernedHatchetSdkTransport({
  durable, resolveClient, resolveRegisteredWorkflow, listCompleteRuns,
  inspectRun, cancelRun, checkWorkerHealth, authorizeCancel, inspectRegisteredWorkflowIdempotency,
}={}) {
  requiredFn(durable,'getDispatch');
  requiredFn(durable,'claimSubmission');
  requiredFn({inspectRegisteredWorkflowIdempotency},'inspectRegisteredWorkflowIdempotency');
  for (const [port,method] of [[{resolveClient},'resolveClient'],[{resolveRegisteredWorkflow},'resolveRegisteredWorkflow'],
    [{listCompleteRuns},'listCompleteRuns'],[{inspectRun},'inspectRun'],
    [{cancelRun},'cancelRun'],[{checkWorkerHealth},'checkWorkerHealth'],[{authorizeCancel},'authorizeCancel']]) requiredFn(port,method);
  const clientFor = async request => verifyClient(await resolveClient({
    company_id:request.company_id,tenant:request.tenant,credential_ref:request.credential_ref,
  }),request.tenant);
  async function reservationFor(request) {
    const row=await durable.getDispatch({company_id:request.company_id,work_id:request.work_id});
    if (!row || row.company_id!==request.company_id || row.work_id!==request.work_id ||
        !validId(row.reservation_id) || !validId(row.idempotency_key)) fail('reservation-missing');
    return row;
  }
  return Object.freeze({
    async submit(input) {
      identity(input);
      for (const key of ['worker_id','idempotency_key','decision_ref','reservation_id']) bounded(input[key],key);
      const row=await reservationFor(input);
      if (!sameReservation(row,input)) fail('reservation-not-new-and-authorized');
      const client=await clientFor(input);
      const workflow=await resolveRegisteredWorkflow({company_id:input.company_id,
        tenant:input.tenant,worker_id:input.worker_id,client});
      requiredFn(workflow,'runNoWait');
      // Do not consume a canonical reservation until the provider's current
      // registered engine-side idempotency has been independently verified.
      let registeredPolicy;
      try {registeredPolicy=await inspectRegisteredWorkflowIdempotency({
        company_id:input.company_id,tenant:input.tenant,worker_id:input.worker_id,client,
      });}
      catch{fail('provider-idempotency-unavailable');}
      verifyProviderIdempotencyPolicy(registeredPolicy,input);
      // Atomically spend the RESERVED record before crossing the external
      // boundary. After this point a crash, lost SDK ACK or concurrent caller
      // MUST reconcile, never send a second workflow from this reservation.
      await durable.claimSubmission({company_id:input.company_id,work_id:input.work_id,
        worker_id:input.worker_id,reservation_id:input.reservation_id,
        idempotency_key:input.idempotency_key,decision_ref:input.decision_ref});
      // Do not carry arbitrary user/model payloads across the transport.
      // A fixed registered workflow reads Titan's authority/evidence by ID.
      const ref=await workflow.runNoWait(Object.freeze({titan: Object.freeze({
        schema:'titan.agent3.hatchet-input/v1',company_id:input.company_id,
        work_id:input.work_id,worker_id:input.worker_id,
        reservation_id:input.reservation_id, idempotency_key:input.idempotency_key,
        decision_ref:input.decision_ref,
      })}));
      return Object.freeze({hatchet_run_id:runId(ref)});
    },
    async listRunsByMetadata(request) {
      identity(request);bounded(request.idempotency_key,'idempotency-key');
      if (request.limit!==101) fail('search-boundary-invalid');
      const client=await clientFor(request);
      const response=await listCompleteRuns({client,company_id:request.company_id,
        work_id:request.work_id,tenant:request.tenant,idempotency_key:request.idempotency_key,limit:101});
      // The SDK's generic paginated list is NOT a uniqueness proof. Its
      // operator-owned adapter must demonstrate complete metadata enumeration.
      if (!response || response.complete!==true || response.next_cursor!==null ||
          !Number.isSafeInteger(response.total) || response.total<0 || response.total>100 ||
          !Array.isArray(response.runs) || response.total!==response.runs.length) fail('listing-not-complete');
      const records=response.runs.map(value=>{
        if (value?.company_id!==request.company_id || value.work_id!==request.work_id ||
            value.idempotency_key!==request.idempotency_key || value.tenant!==request.tenant ||
            !validId(value.hatchet_run_id)) fail('listing-tenant-mismatch');
        return Object.freeze({company_id:value.company_id,work_id:value.work_id,
          idempotency_key:value.idempotency_key,tenant:value.tenant,hatchet_run_id:value.hatchet_run_id});
      });
      return Object.freeze({complete:true,next_cursor:null,total:records.length,runs:Object.freeze(records)});
    },
    async runStatus(request) {
      identity(request);bounded(request.hatchet_run_id,'run-id');
      const client=await clientFor(request);
      const value=await inspectRun({client,company_id:request.company_id,tenant:request.tenant,
        work_id:request.work_id,hatchet_run_id:request.hatchet_run_id});
      if (value?.tenant!==request.tenant || value.hatchet_run_id!==request.hatchet_run_id ||
          value.company_id!==request.company_id || value.work_id!==request.work_id ||
          typeof value.status!=='string' || value.status.length>80 || !/^[A-Z_]+$/.test(value.status))
        fail('run-status-unverified');
      return Object.freeze({tenant:request.tenant,hatchet_run_id:request.hatchet_run_id,status:value.status});
    },
    async requestCancellation(request) {
      identity(request);
      for (const key of ['actor_id','hatchet_run_id']) bounded(request[key],key);
      const row=await reservationFor(request);
      if (row.state!=='ACCEPTED' || row.hatchet_run_id!==request.hatchet_run_id) fail('cancellation-unlinked-run');
      const permission=await authorizeCancel({company_id:request.company_id,work_id:request.work_id,
        actor_id:request.actor_id,reservation_id:row.reservation_id,hatchet_run_id:row.hatchet_run_id});
      if (permission?.allowed!==true || permission.company_id!==request.company_id ||
          permission.work_id!==request.work_id || !validId(permission.decision_ref)) fail('cancellation-unauthorized');
      const client=await clientFor(request);
      // Cancellation is not completion, evidence or absence of effects. If
      // cancellation's ACK is lost, the outcome is unknown and must be observed.
      try {
        await cancelRun({client,company_id:request.company_id,tenant:request.tenant,
          hatchet_run_id:row.hatchet_run_id});
      } catch (cause) {throw new Error('hatchet-sdk-cancellation-outcome-uncertain',{cause});}
      return Object.freeze({state:'CANCELLATION_REQUESTED',business_outcome_verified:false,safe_to_retry:false});
    },
    async workerHealth(request) {
      identity(request);bounded(request.worker_id,'worker-id');
      const client=await clientFor(request);
      const status=await checkWorkerHealth({client,company_id:request.company_id,
        tenant:request.tenant,worker_id:request.worker_id});
      if (status?.tenant!==request.tenant || status.worker_id!==request.worker_id ||
          !['HEALTHY','UNHEALTHY','DISCONNECTED'].includes(status.state)) fail('health-unverified');
      return Object.freeze({state:status.state,worker_id:request.worker_id,tenant:request.tenant,
        live_deployment_verified:false});
    },
  });
}
