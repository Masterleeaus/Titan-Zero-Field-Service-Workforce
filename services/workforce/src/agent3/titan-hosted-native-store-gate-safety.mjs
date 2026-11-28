/**
 * Canonical native company-store lock compatibility gate — fail closed.
 *
 * Source audit of the current Titan native store opener (Git blob
 * 80ab3010f151e01c0133db0f13753e7d3369fce4) proved it calls
 * CompanyPlacementOperationGate.acquire() when opening and gate.run() for
 * each native company SQL query/transaction/close. The canonical placement
 * gate (blob 23d347b83ed876527cf6198ff9968b788ec29621) is exclusive,
 * non-reentrant, and cross-process. Agent 3 already acquires that SAME gate
 * across its hosted operation. Nested native open/query deadlocks.
 *
 * Therefore no trusted setting, readiness attestation, flag, or guessed
 * transport policy may turn this existing hosted composition on. A later
 * implementation must pass a new independently reviewed lock-interop contract
 * (e.g. borrowed lease support in the canonical opener), plus multi-process
 * and end-to-end tests; at that point THIS gate must be deliberately updated.
 * It is intentionally not bypassable by supplying another string or callback.
 *
 * Native-only default remains completely unchanged.
 */
export const NATIVE_GATE_INCOMPATIBILITY = 'agent3-hosted-native-store-gate-nonreentrant';
export const NATIVE_GATE_AUDIT = Object.freeze({
  schema:'titan.agent3.native-gate-audit/v1',
  native_opener_sha:'80ab3010f151e01c0133db0f13753e7d3369fce4',
  native_work_orders_sha:'268a2bb65c808461cac0e81851c8ac60698c54a5',
  canonical_gate_sha:'23d347b83ed876527cf6198ff9968b788ec29621',
  affected_company_gate:'exclusive-non-reentrant',
  status:'commissioning-blocked',
});
export function assertHostedNativeGateSafeToCommission(setting) {
  if (setting === undefined) return;
  // Explicitly configured even if disabled must fail closed: partial or stale
  // settings cannot silently behave as a commissioned installation.
  throw new Error(NATIVE_GATE_INCOMPATIBILITY);
}
