/**
 * Fences the direct ZeroWorkforceRuntimeDispatcher -> TitanAgentRuntime path.
 *
 * Existing ZeroWorkforceRuntimeDispatcher.start() invokes runtime.start()
 * directly, bypassing Agent 3's WorkforceService.wake selector. Hand the
 * dispatcher THIS port instead of the unfenced TitanAgentRuntime. Both this
 * port and the Hatchet wake selector must share the SAME executionOwner.
 *
 * The owner record is transport fencing, not authority or completion. Legacy
 * runs may resume ONLY when confirmed by canonical SqliteRunStore.get() and
 * no contrary owner exists. Never infer permission from a caller-supplied
 * continuation token, worker, run ID or provider ACK.
 */
import { validId } from './titan-canonical-receiver.mjs';
const ZERO_POLICY = 'canonical-zero-native';
const requireId = (value, label) => {
  if (!validId(value)) throw new Error(`zero-fence-${label}-invalid`);
  return value;
};
const validateRun = (run,{company_id,work_id,agent_id,run_id}={}) => {
  if (!run || !validId(run.run_id) || run.company_id !== company_id ||
      (work_id !== undefined && run.work_id !== work_id) ||
      (agent_id !== undefined && run.agent_id !== agent_id) ||
      (run_id !== undefined && run.run_id !== run_id)) throw new Error('zero-fence-canonical-run-conflict');
  return run;
};
/**
 * @param {object} ports
 * @param {object} ports.runtime Existing canonical TitanAgentRuntime instance.
 * @param {object} ports.executionOwner Persistent company-scoped owner of native/hatchet execution.
 * @param {Function} ports.getCanonicalRunById Exact SqliteRunStore.get(company_id,run_id).
 */
export function createFencedZeroRuntime({runtime,executionOwner,getCanonicalRunById}={}) {
  for (const fn of ['start','resume','findByWork','findRecoverableByWork'])
    if (typeof runtime?.[fn]!=='function') throw new TypeError(`zero-fence-runtime-port-required:${fn}`);
  for (const fn of ['get','reserve','markDispatched','markUncertain'])
    if (typeof executionOwner?.[fn]!=='function') throw new TypeError(`zero-fence-execution-owner-required:${fn}`);
  if (typeof getCanonicalRunById!=='function') throw new TypeError('zero-fence-canonical-run-lookup-required');
  if (typeof runtime?.events?.subscribe!=='function') throw new TypeError('zero-fence-runtime-events-required');

  const getByWork = async ({company_id,work_id}) => {
    const r = await runtime.findByWork({company_id,work_id});
    if (r === undefined) throw new Error('zero-fence-authoritative-work-lookup-required');
    if (r === null) return null;
    return assertNative(validateRun(r,{company_id,work_id}));
  };
  const assertNative = async (run) => {
    validateRun(run,run);
    const owner = await executionOwner.get(run.company_id,run.work_id);
    if (owner && (owner.engine !== 'native' || owner.worker_id !== run.agent_id))
      throw new Error('zero-fence-non-native-owner-denied');
    return run;
  };
  const findForControl = async (input) => {
    const company_id=requireId(input?.company_id,'company-id');
    const run_id=requireId(input?.run_id,'run-id');
    const run=await getCanonicalRunById({company_id,run_id});
    if (!run) throw new Error('zero-fence-run-not-found');
    validateRun(run,{company_id,run_id});
    requireId(run.work_id,'work-id');requireId(run.agent_id,'agent-id');
    return assertNative(run);
  };
  const methods={
    async start(input) {
      const company_id=requireId(input?.company_id,'company-id');
      const work_id=requireId(input?.work_id,'work-id');
      const agent_id=requireId(input?.agent_id,'agent-id');
      const worker_id=agent_id;
      // Legacy/existing native run: let the canonical dispatcher reconcile it
      // instead of claiming a new execution or crossing to Hatchet.
      const found=await getByWork({company_id,work_id});
      if (found) {
        if (found.agent_id!==agent_id) throw new Error('zero-fence-assignee-conflict');
        await assertNative(found);
        throw new Error('runtime-run-exists');
      }
      const claim=await executionOwner.reserve({company_id,work_id,worker_id,engine:'native',policy_ref:ZERO_POLICY});
      if (!claim || !validId(claim.claim_id) || claim.engine!=='native' || typeof claim.created!=='boolean')
        throw new Error('zero-fence-ownership-unavailable');
      if (!claim.created) {
        // An existing reservation, even for our own route, cannot be taken as
        // evidence the original network/process start did not occur.
        const current=await getByWork({company_id,work_id});
        if (current && current.agent_id===agent_id) {
          await assertNative(current);
          throw new Error('runtime-run-exists');
        }
        throw new Error('zero-fence-preexisting-owner-reconciliation-required');
      }
      try {
        const response=await runtime.start(input);
        validateRun(response,{company_id,work_id,agent_id});
        await executionOwner.markDispatched({company_id,work_id,claim_id:claim.claim_id});
        return response;
      } catch(cause) {
        try {await executionOwner.markUncertain({company_id,work_id,claim_id:claim.claim_id});}
        catch { /* do not discard the original reservation */ }
        throw new Error('zero-fence-native-start-uncertain',{cause});
      }
    },
    async resume(input) {
      await findForControl(input);
      const run=await runtime.resume(input);
      validateRun(run,{company_id:input.company_id,run_id:input.run_id});
      return run;
    },
    async cancel(input) {
      if (typeof runtime.cancel!=='function') throw new Error('zero-fence-cancel-unavailable');
      await findForControl(input);
      const run=await runtime.cancel(input);
      validateRun(run,{company_id:input.company_id,run_id:input.run_id});
      return run;
    },
    async recoverInterrupted(input) {
      if (typeof runtime.recoverInterrupted!=='function') throw new Error('zero-fence-recovery-unavailable');
      await findForControl(input);
      const run=await runtime.recoverInterrupted(input);
      validateRun(run,{company_id:input.company_id,run_id:input.run_id});
      return run;
    },
    async findByWork(input) {return getByWork(input);},
    async findRecoverableByWork(input) {
      const company_id=requireId(input?.company_id,'company-id');
      const work_id=requireId(input?.work_id,'work-id');
      const run=await runtime.findRecoverableByWork({company_id,work_id});
      if (run === undefined) throw new Error('zero-fence-authoritative-recovery-lookup-required');
      return run===null ? null : assertNative(validateRun(run,{company_id,work_id}));
    },
    isWorkActive(input) {
      // Non-authoritative read only. Do not use as a substitute for persisted
      // run/owner checks in start, resume, cancel or recovery.
      return typeof runtime.isWorkActive==='function' && runtime.isWorkActive(input);
    },
  };
  // Strict capability surface: NEVER proxy unknown runtime properties or methods.
  // The underlying Titan runtime may grow privileged mutation entrypoints later;
  // a transparent Proxy would silently re-export those unfenced capabilities.
  // The Zero dispatcher needs only these methods and a subscribe-only event port.
  const events=Object.freeze({
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('zero-fence-event-subscriber-invalid');
      return runtime.events.subscribe(listener);
    },
  });
  return Object.freeze({...methods,events});
}
