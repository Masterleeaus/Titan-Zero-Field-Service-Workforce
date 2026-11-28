/**
 * Single-owned canonical Titan execution. Native remains the default.
 * Hatchet routing requires effective policy authorisation; both native and
 * Hatchet claim the SAME durable (company_id,work_id) slot before either starts.
 *
 * This MUST replace the native wake entrypoint for the company. Other callers
 * bypassing it defeat the invariant and must be disabled at commissioning.
 */
import { validId } from './titan-canonical-receiver.mjs';
export function createGovernedRuntimeSelector({nativeRuntime,hatchetRuntime,resolvePolicy,executionOwner,nativeRunLookup}) {
  if (typeof nativeRuntime?.wake !== 'function') throw new TypeError('canonical native runtime required');
  if (typeof hatchetRuntime?.wake !== 'function') throw new TypeError('Hatchet adapter required');
  if (typeof resolvePolicy !== 'function') throw new TypeError('canonical routing policy required');
  if (typeof nativeRunLookup !== 'function') throw new TypeError('canonical native run lookup required');
  for (const method of ['reserve','markDispatched','markUncertain']) {
    if (typeof executionOwner?.[method]!=='function') throw new TypeError(`execution-owner-port-required:${method}`);
  }
  return Object.freeze({
    async wake(input) {
      if (![input?.company_id,input?.work_id,input?.worker_id].every(validId))
        throw new Error('canonical-runtime-identity-invalid');
      const {company_id,work_id,worker_id}=input;
      const routing=await resolvePolicy({company_id,work_id,worker_id});
      if (!routing || routing.company_id!==company_id || routing.work_id!==work_id)
        throw new Error('canonical runtime routing unavailable');
      const selected = routing.mode==='native' ? nativeRuntime :
        routing.mode==='hatchet' && routing.authorized===true && validId(routing.effective_policy_ref)
          ? hatchetRuntime : null;
      if (!selected || routing.authorized===false) throw new Error('canonical runtime routing denied');
      if (routing.mode==='hatchet') {
        // Pre-upgrade native runs are not represented in the new ownership
        // table. Deny external dispatch for any existing native work history.
        // This does not replace quiescing old bypass entrypoints at rollout.
        const found=await nativeRunLookup({company_id,work_id});
        if (found !== null && found !== undefined) throw new Error('existing canonical native run blocks Hatchet');
      }
      // For native, this exact sentinel signifies the current effective default
      // decision. It is NOT derived from an incoming user/model payload.
      const policy_ref=routing.mode==='native' ?
        (validId(routing.effective_policy_ref)?routing.effective_policy_ref:'canonical-native-default') : routing.effective_policy_ref;
      const claim=await executionOwner.reserve({company_id,work_id,worker_id,engine:routing.mode,policy_ref});
      if (!claim || typeof claim.created!=='boolean' || !validId(claim.claim_id) || claim.engine!==routing.mode)
        throw new Error('canonical execution owner unavailable');
      if (!claim.created) return {state:'ALREADY_OWNED',execution_owner:claim.engine,claim_ref:claim.claim_id,
        owner_state:claim.state,work_id,safe_to_retry:false};
      try {
        const response=await selected.wake(input);
        if (routing.mode==='hatchet' && response?.state==='ALREADY_RESERVED') {
          // Importing an old Pass-06 transport reservation cannot turn it into
          // a new positive execution ACK or be re-enqueued by this selector.
          await executionOwner.markUncertain({company_id,work_id,claim_id:claim.claim_id});
          return {state:'PREEXISTING_TRANSPORT',work_id,claim_ref:claim.claim_id,
            dispatch_ref:response.dispatch_ref,safe_to_retry:false};
        }
        // Dispatched means the selected runtime ACKed the start call. It says
        // nothing about completed business outcomes or actual external effects.
        await executionOwner.markDispatched({company_id,work_id,claim_id:claim.claim_id});
        return response;
      } catch (cause) {
        // No release and no fallback: a received-but-lost ACK may have run work.
        try { await executionOwner.markUncertain({company_id,work_id,claim_id:claim.claim_id}); }
        catch { /* durable reservation continues to fence duplicate execution */ }
        throw new Error('canonical execution owner uncertain; reconcile before continuing',{cause});
      }
    },
  });
}
