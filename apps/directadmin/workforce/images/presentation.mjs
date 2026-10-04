/** Presentation only. These labels never decide execution authority. */
export function workState(value) {
  const state = String(value ?? 'UNKNOWN').toUpperCase();
  const labels = {
    REQUESTED: 'Requested', AUTHORIZED: 'Authorized — execution pending', EXECUTING: 'Executing', DENIED: 'Denied', EXPIRED: 'Expired',
    CREATED: 'Queued', READY: 'Ready', CLAIMED: 'Claimed', IN_PROGRESS: 'Active', RUNNING: 'Active',
    BLOCKED: 'Blocked', WAITING: 'Waiting', WAITING_APPROVAL: 'Approval needed', WAITING_EXTERNAL: 'Waiting for external result',
    WAITING_TOOL: 'Waiting for tool', WAITING_USER: 'Human input needed', SUSPENDED: 'Suspended',
    PROVIDER_ACKNOWLEDGED: 'Provider acknowledged — not verified', VERIFYING: 'Verifying',
    VERIFIED: 'Reported verified — inspect evidence', COMPLETED: 'Run completed — outcome verification separate',
    FAILED: 'Failed', CANCELLED: 'Cancelled', RECOVERED: 'Recovered', COMPENSATED: 'Compensated',
  };
  return labels[state] ?? `Unknown / attention (${state.slice(0, 64)})`;
}
export function position(worker) {
  if (worker.kind === 'human') return 'Human participant';
  const labels = { worker: 'Worker', specialist: 'Specialist', manager: 'Manager', orchestrator: 'Orchestrator', supervisor: 'Manager (legacy supervisor)' };
  return labels[String(worker.role ?? worker.tier).toLowerCase()] ?? 'Position not supplied';
}
export function identityType(worker) {
  return worker.kind === 'human' ? 'Human' : worker.kind === 'digital' ? 'AI / digital' : 'Unknown';
}
/** Derive memberships from the current company roster; this is not a second team registry. */
export function teamMemberships(workers) {
  const groups = new Map();
  for (const worker of workers) {
    const teamId = typeof worker.team_id === 'string' && worker.team_id.trim() ? worker.team_id : null;
    if (!groups.has(teamId)) groups.set(teamId, []);
    groups.get(teamId).push(worker);
  }
  return [...groups].map(([team_id, members]) => ({ team_id, members }));
}
export function verifiedOutcome(receipt) {
  // Never promote COMPLETED, provider acknowledgement, or agent self-report.
  return receipt?.state === 'VERIFIED' && receipt?.verification?.status === 'VERIFIED' &&
    Array.isArray(receipt.evidence_refs) && receipt.evidence_refs.length > 0 &&
    receipt.evidence_refs.every(ref => typeof ref === 'string' && ref.trim().length > 0);
}
export function scoped(value, companyId) {
  if (!value || typeof value !== 'object' || value.company_id !== companyId) throw new Error('workforce-company-mismatch');
  return value;
}
export function assertNestedCompany(value, companyId) {
  if (!value || typeof value !== 'object') return;
  if (Object.hasOwn(value, 'company_id') && value.company_id !== companyId) throw new Error('workforce-company-mismatch');
  for (const child of Object.values(value)) assertNestedCompany(child, companyId);
}
export function boundedText(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 4000) : 'Not supplied';
}

export function receiptState(receipt) {
  if (verifiedOutcome(receipt)) return 'Verified outcome with evidence';
  if (receipt?.state === 'VERIFIED') return 'Verification unproven — evidence or observed verification missing';
  if (receipt?.state === 'REQUESTED') return 'Request accepted — verified outcome not yet available';
  return workState(receipt?.state);
}

/** Shared SDK contribution shape; summary is rebuilt from the current hosted projection. */
export function workforceContribution(state, role = 'user') {
  const route = role === 'admin' ? '/CMD_PLUGINS_ADMIN/titan_workforce'
    : role === 'reseller' ? '/CMD_PLUGINS_RESELLER/titan_workforce' : '/CMD_PLUGINS/titan_workforce';
  return {
    plugin_id: 'titan_workforce', plugin_version: '0.1.6', sdk_compatibility: '1.0.0',
    navigation: [{ id: 'workforce', label: 'Workforce', route, roles: ['admin', 'reseller', 'user'] }],
    widgets: [{ id: 'workforce-status', title: 'Workforce',
      status: state.phase === 'ready' ? 'ready' : state.phase === 'denied' ? 'permission-denied' : state.phase === 'loading' ? 'loading' : 'unavailable',
      source: 'canonical-hosted-workforce', freshness: state.phase === 'ready' ? state.status?.observed_at ?? null : null,
      deep_link: route, permitted_actions: [],
      evidence_refs: state.phase === 'ready' ? [...new Set((state.status?.work ?? []).flatMap(item => item.evidence_refs ?? []))] : [],
    }],
  };
}
