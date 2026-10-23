/** Integration assembly over Titan canonical ports; never creates a second runtime.
 * Caller owns authentication, vault, evidence and company registry.
 * None of these composition functions may be called directly from untrusted
 * browser/process inputs: the ingress must be Titan's effective authenticated API.
 */
import { createCanonicalBridgeReceiver } from './titan-canonical-receiver.mjs';
import { createNodeBridgeHandler } from './titan-canonical-node-handler.mjs';
import { makeRuntimeReadPorts } from './titan-canonical-runtime-ports.mjs';
import { createCanonicalDurableDispatch } from './titan-canonical-durable-dispatch.mjs';
import { createCanonicalExecutionOwner } from './titan-canonical-execution-owner.mjs';
import { createHatchetWorkforceAdapter } from './titan-hatchet-workforce-adapter.mjs';
import { createGovernedRuntimeSelector } from './titan-runtime-dispatch-selector.mjs';
import { createHatchetRunReconciler } from './titan-hatchet-run-reconciler.mjs';
import { createAgent3RecoveryOperations } from './titan-hatchet-recovery-operations.mjs';
import { createFencedZeroRuntime } from './titan-fenced-zero-runtime.mjs';

const method = (o,n) => { if(typeof o?.[n]!=='function') throw new TypeError(`commissioning-port-required:${n}`); };
export function createCanonicalAgent3Commissioning({
  resolveCompanyStorage, workforceStore, workerStore, authorization,
  evidence, approvals, smartTasks, vault, hatchetTransport, placement,
  nativeRuntime, nativeRunLookup, runtimeRoutingPolicy, clock,
  zeroNativeRuntime, canonicalRunById, strictCommissioning=false,
} = {}) {
  method(workforceStore,'list');method(workforceStore,'get');
  method(workerStore,'getWorker');method(workforceStore,'listWorkers');
  method(authorization,'authorizeBridge');method(authorization,'authorizeHatchetDispatch');
  method(authorization,'authorizeReconciliation');method(evidence,'verifyAcceptedOutcome');
  method(approvals,'verifiedPendingCount');method(smartTasks,'verifiedTotals');
  method(vault,'keyForCompany');method(hatchetTransport,'submit');method(hatchetTransport,'listRunsByMetadata');
  method(hatchetTransport,'runStatus');method(placement,'resolvePlacement');
  method(nativeRuntime,'wake');
  if (typeof nativeRunLookup !== 'function') throw new TypeError('commissioning-native-run-lookup-required');
  if (typeof runtimeRoutingPolicy!=='function') throw new TypeError('commissioning-routing-policy-required');
  const durable=createCanonicalDurableDispatch({resolveCompanyStorage,clock});
  const executionOwner=createCanonicalExecutionOwner({resolveCompanyStorage,clock});
  const reads=makeRuntimeReadPorts({workforceStore,authorization,evidence,approvals,smartTasks});
  const receiver=createCanonicalBridgeReceiver({
    ...reads,keyForCompany:company_id=>vault.keyForCompany(company_id),
    claimNonce:input=>durable.claimNonce(input),
  });
  const hatchetRuntime=createHatchetWorkforceAdapter({
    workforceStore,workerStore,
    authorize:input=>authorization.authorizeHatchetDispatch(input),
    resolvePlacement:input=>placement.resolvePlacement(input),
    reserveDispatch:input=>durable.reserveDispatch(input),
    markAccepted:input=>durable.markAccepted(input),
    markUncertain:input=>durable.markUncertain(input),
    submitAuthorized:input=>hatchetTransport.submit(input),
  });
  const runtime=createGovernedRuntimeSelector({nativeRuntime,hatchetRuntime,resolvePolicy:runtimeRoutingPolicy,nativeRunLookup,executionOwner});
  // Reuse the same durable native-or-Hatchet owner for the Zero manager's
  // direct start/resume path. Strict commissioning rejects a partial cutover:
  // production must never publish an unguarded Zero start entrypoint.
  if (strictCommissioning!==false && strictCommissioning!==true)
    throw new TypeError('commissioning-strict-mode-invalid');
  if (strictCommissioning && (!zeroNativeRuntime || typeof canonicalRunById!=='function'))
    throw new Error('commissioning-zero-fence-required');
  if ((zeroNativeRuntime && typeof canonicalRunById!=='function') ||
      (!zeroNativeRuntime && canonicalRunById!==undefined))
    throw new Error('commissioning-zero-fence-ports-incomplete');
  const zeroRuntime=zeroNativeRuntime ? createFencedZeroRuntime({
    runtime:zeroNativeRuntime,executionOwner,getCanonicalRunById:canonicalRunById,
  }) : null;
  const reconciler=createHatchetRunReconciler({
    durable,resolvePlacement:input=>placement.resolvePlacement(input),
    listRunsByMetadata:input=>hatchetTransport.listRunsByMetadata(input),
    readRunStatus:input=>hatchetTransport.runStatus(input),
    authorizeReconcile:input=>authorization.authorizeReconciliation(input),
    requireCompletePage:strictCommissioning,
  });
  // A recovery lane is only surfaced when all operator-owned cancellation,
  // worker-health and effective-authority ports are available. It cannot be
  // silently replaced with a guessed provider cancellation API. This remains
  // a non-publishing observation/request port; Titan owns business evidence.
  const recovery = typeof authorization.authorizeRecovery === 'function' &&
    typeof hatchetTransport.requestCancellation === 'function' &&
    typeof hatchetTransport.workerHealth === 'function'
      ? createAgent3RecoveryOperations({durable,reconciler,transport:hatchetTransport,
          resolvePlacement:input=>placement.resolvePlacement(input),
          authorizeRecovery:input=>authorization.authorizeRecovery(input)}) : null;
  return Object.freeze({
    recovery,
    async migrate(company_id) {
      // Both migrations must finish before commissioning any execution ingress.
      await durable.migrate(company_id);
      await executionOwner.migrate(company_id);
      return {company_id,migrations:['agent3-transport-v1','agent3-execution-owner-v1']};
    },
    receiver,handleHttp:createNodeBridgeHandler(receiver),
    runtime,zeroRuntime,reconciler,durable,executionOwner,
    strictCommissioning,
  });
}
