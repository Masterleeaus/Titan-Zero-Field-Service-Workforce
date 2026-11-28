/**
 * Hosted Agent 3 lock-order fence.
 *
 * The canonical company placement maintenance gate is exclusive and NOT
 * reentrant. Nested host actions through another guarded entrypoint can
 * self-deadlock while holding it; acquiring companies in opposite order can
 * also deadlock. Reject nested host entrypoints BEFORE attempting the lease.
 *
 * This protects the hosted Agent 3 wrapper, not raw canonical StorageClient
 * calls. Operators must independently certify that native work-order ports do
 * not try to reacquire the same physical placement gate under this wrapper.
 * No execution owner, scheduler, or business record is created by this fence.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const scopes = new AsyncLocalStorage();
const DENIED = 'agent3-hosted-nested-placement-operation-denied';

export function runWithHostedPlacementLockOrder(company_id, operation) {
  const parent = scopes.getStore();
  if (parent?.active) {
    throw new Error(DENIED, {cause:new Error('nested-placement-operation')});
  }
  if (typeof company_id !== 'string' || typeof operation !== 'function') {
    throw new Error(DENIED);
  }
  const scope = { company_id, active:true };
  return scopes.run(scope, async () => {
    try { return await operation(); }
    finally { scope.active=false; }
  });
}

// Explicit observation only. Never expose an owner that can mutate scope.
export function hostedPlacementLockOrderActive() {
  return scopes.getStore()?.active === true;
}
