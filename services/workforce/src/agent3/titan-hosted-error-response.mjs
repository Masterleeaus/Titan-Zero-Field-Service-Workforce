/** A bounded public failure contract for Agent 3 hosted HTTP endpoints.
 * Never expose provider/placement/internal exception messages to callers.
 * The uncertain case is not permission for a client, proxy or host to resubmit
 * the same external action; it requires explicit evidence-led reconciliation.
 */
const failCodes=new Set([
  'agent3-hosted-operation-denied',
  'agent3-hosted-commissioning-denied',
  'agent3-hosted-placement-denied',
  'agent3-hosted-schema-denied',
]);
export function agent3HostedErrorResponse(error) {
  if (!(error instanceof Error)) return null;
  if (error.message==='agent3-hosted-outcome-uncertain') {
    return Object.freeze({status:503, body:Object.freeze({
      error:'conversation-outcome-uncertain',
      retryable:false,
      reconciliation_required:true,
    })});
  }
  if (failCodes.has(error.message)) {
    return Object.freeze({status:503,body:Object.freeze({
      error:'conversation-execution-unavailable',
      retryable:false,
    })});
  }
  return null;
}
