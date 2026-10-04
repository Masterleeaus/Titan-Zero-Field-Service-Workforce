/** Consumer of the actual #1049 browser session. No authentication or fetch implementation. */
const REASSIGN_CAPABILITY = 'titan.workforce.reassign';
const RECEIPT_SCHEMA = 'titan.directadmin.workforce-receipt.v1';
const RECEIPT_VERIFICATION_METHOD = 'company-scoped-workforce-reread-and-reassignment-event';
const boundedOwnerId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
  value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const boundedReceiptId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  value === value.trim() && /^[A-Za-z0-9:._-]+$/.test(value) && value !== '.' && value !== '..' &&
  !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
const boundedContextRevision = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;

export class WorkforceApi {
  #snapshot;
  constructor(session, requestId = () => crypto.randomUUID()) { this.session = session; this.requestId = requestId; }
  async context() { this.#snapshot = null; return this.session.connect(); }
  async #load(context) {
    this.#snapshot ??= this.session.projection('titan_workforce');
    const projection = await this.#snapshot;
    const refs = projection?.evidence_refs;
    const freshness = projection?.freshness;
    if (projection?.company_id !== context.company_id || typeof projection.source !== 'string' || !projection.source.trim() ||
        !(freshness === null || (typeof freshness === 'string' && Number.isFinite(Date.parse(freshness)))) ||
        !Array.isArray(refs) || refs.some(ref => typeof ref !== 'string' || !ref.trim()) ||
        projection.data?.company_id !== context.company_id || projection.data?.discovery?.company_id !== context.company_id ||
        projection.data?.status?.company_id !== context.company_id || projection.data?.schema !== 'titan.workforce-cockpit.v1') {
      throw new Error('workforce-projection-invalid');
    }
    const skills = projection.data.discovery.skills;
    if (skills !== undefined && (!skills || skills.schema !== 'titan.directadmin.workforce-skills.v1' ||
        skills.company_id !== context.company_id || skills.context_revision !== context.context_revision ||
        skills.read_only !== true || skills.grants_authority !== false ||
        !['available', 'unavailable'].includes(skills.status))) {
      throw new Error('workforce-skills-projection-invalid');
    }
    return projection;
  }
  async discover(context) { return (await this.#load(context)).data.discovery; }
  /** Returns the typed canonical proof projection, or null when connected to an older host. */
  async skills(context) { return (await this.#load(context)).data.discovery.skills ?? null; }
  async status(context) { return (await this.#load(context)).data.status; }
  async metadata(context) {
    const projection = await this.#load(context);
    return { source: projection.source, freshness: projection.freshness, evidence_refs: [...projection.evidence_refs] };
  }
  /**
   * Read a receipt through the shared DirectAdmin SDK when the host publishes
   * its typed receipt route. Older hosts expose only the REQUESTED ingress ID;
   * in that case return null and never infer verification from a work ref.
   */
  async receipt(context, receiptId, expected = {}) {
    if (!boundedReceiptId(receiptId)) throw new Error('workforce-receipt-invalid');
    // Do not add a network round trip when the shared SDK has no receipt
    // route. The caller already holds a freshly validated context and no
    // receipt data will be read or returned in this compatibility case.
    if (typeof this.session.receipt !== 'function') return null;
    const current = await this.context();
    if (current.company_id !== context?.company_id || current.actor_id !== context?.actor_id ||
        current.session_revision !== context?.session_revision || current.context_revision !== context?.context_revision ||
        !boundedContextRevision(current.context_revision)) {
      throw new Error('workforce-context-changed');
    }
    // The shared SDK validates and accepts the `{context, receipt}` transport
    // envelope internally, then returns the typed receipt itself. Revalidate
    // our context on both sides of that read; do not require the SDK to expose
    // or duplicate its authenticated envelope to plugin consumers.
    const candidate = await this.session.receipt('titan_workforce', receiptId);
    const refs = candidate?.evidence_refs;
    if (!candidate || candidate.schema !== RECEIPT_SCHEMA || candidate.company_id !== context.company_id ||
        candidate.receipt_id !== receiptId || !boundedOwnerId(candidate.operation_id) || !boundedOwnerId(candidate.correlation_id) ||
        !boundedOwnerId(candidate.work_id) || candidate.state !== 'VERIFIED' ||
        candidate.verification_status !== 'verified' || candidate.verification_method !== RECEIPT_VERIFICATION_METHOD ||
        !Array.isArray(refs) || refs.length !== 1 || refs[0] !== receiptId ||
        (candidate.run_id !== undefined && !boundedOwnerId(candidate.run_id))) {
      throw new Error('workforce-receipt-invalid');
    }
    if ((expected.operation_id && candidate.operation_id !== expected.operation_id) ||
        (expected.correlation_id && candidate.correlation_id !== expected.correlation_id) ||
        (expected.work_id && candidate.work_id !== expected.work_id)) {
      throw new Error('workforce-receipt-binding-mismatch');
    }
    const after = await this.context();
    if (after.company_id !== current.company_id || after.actor_id !== current.actor_id ||
        after.session_revision !== current.session_revision || after.context_revision !== current.context_revision) {
      throw new Error('workforce-context-changed');
    }
    return Object.freeze({ schema: RECEIPT_SCHEMA, company_id: candidate.company_id,
      receipt_id: candidate.receipt_id, operation_id: candidate.operation_id,
      correlation_id: candidate.correlation_id, work_id: candidate.work_id, state: candidate.state,
      ...(candidate.run_id ? { run_id: candidate.run_id } : {}),
      verification: Object.freeze({ status: 'VERIFIED', method: RECEIPT_VERIFICATION_METHOD }),
      evidence_refs: Object.freeze([...refs]) });
  }
  async control(context, action) {
    const discovery = await this.discover(context);
    const supported = new Set(['pause', 'resume', 'cancel', 'reassign', 'escalate', 'revoke']);
    const descriptor = discovery.controls?.find(item => item.action === action.action);
    if (!supported.has(action.action) || typeof descriptor?.capability_id !== 'string' || !descriptor.capability_id ||
        typeof action.work_id !== 'string' || !action.work_id || typeof action.reason !== 'string' || !action.reason.trim()) {
      throw new Error('workforce-control-denied');
    }
    let input = { action: action.action, work_id: action.work_id, reason: action.reason.slice(0, 2000) };
    if (action.action === 'reassign') {
      if (descriptor.capability_id !== REASSIGN_CAPABILITY || descriptor.requires_fresh_approval !== true ||
          descriptor.grants_authority !== false || typeof action.target_worker_id !== 'string' || !action.target_worker_id.trim()) {
        throw new Error('workforce-control-denied');
      }
      const status = await this.status(context);
      const item = status?.work?.find(work => work?.company_id === context.company_id && work.work_id === action.work_id);
      const target = discovery.workers?.find(worker => worker?.company_id === context.company_id && worker.worker_id === action.target_worker_id);
      const required = item?.required_capabilities;
      if (!item || item.state !== 'READY' || (item.assignee != null && (typeof item.assignee !== 'string' || !item.assignee.trim())) ||
          (required !== undefined && (!Array.isArray(required) || required.some(value => typeof value !== 'string' || !value.trim()))) ||
          !target || target.active !== true || target.worker_id === item.assignee ||
          (required?.length && (!Array.isArray(target.capabilities) || required.some(capability => !target.capabilities.includes(capability))))) {
        throw new Error('workforce-control-denied');
      }
      // Bind the request to the assignee from this canonical projection. The
      // owner performs the authoritative READY/assignee CAS and rechecks all
      // authority in its transaction; the browser grants nothing.
      input = { ...input, expected_assignee_id: item.assignee ?? null, target_worker_id: target.worker_id };
    } else if (action.target_worker_id) {
      input = { ...input, target_worker_id: action.target_worker_id };
    }
    const operation_id = this.requestId(); const correlation_id = this.requestId();
    let receipt;
    try {
      receipt = await this.session.intent('titan_workforce', {
        company_id: context.company_id, actor_id: context.actor_id, capability_id: descriptor.capability_id,
        operation_id, correlation_id, input,
      });
    } catch (error) {
      // Scope denial to the governed intent route. A 403 from context or
      // projection reads must never be described as a denied action.
      if (error?.message === 'directadmin-http-403') throw new Error('directadmin-workforce-action-denied');
      throw error;
    }
    this.#snapshot = null;
    // The SDK gateway returns ingress acknowledgement only. Never forward an invented VERIFIED result.
    if (receipt?.status !== 'REQUESTED' || receipt.correlation_id !== correlation_id || !boundedReceiptId(receipt.receipt_id)) throw new Error('workforce-receipt-invalid');
    return { company_id: context.company_id, state: 'REQUESTED', receipt_id: receipt.receipt_id,
      operation_id, correlation_id, work_id: action.work_id, evidence_refs: [] };
  }
}
