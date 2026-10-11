/** Consumer of the actual #1049 browser session. No authentication or fetch implementation. */
const REASSIGN_CAPABILITY = 'titan.workforce.reassign';
const CLEANING_ELIGIBILITY_SCHEMA = 'titan.directadmin.workforce-cleaning-assignment-eligibility.v1';

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validCurrentContext(context) {
  return validId(context?.company_id) && validId(context?.actor_id) &&
    Number.isSafeInteger(context?.session_revision) && context.session_revision > 0 && validId(context?.context_revision);
}

function sameCurrentContext(expected, current) {
  return validCurrentContext(expected) && validCurrentContext(current) &&
    expected.company_id === current.company_id && expected.actor_id === current.actor_id &&
    expected.session_revision === current.session_revision && expected.context_revision === current.context_revision;
}

function assessCanonicalSkillProof(skills, context, workerId, capabilityId) {
  const projection = skills?.projection;
  if (skills?.schema !== 'titan.directadmin.workforce-skills.v1' || skills.status !== 'available' ||
      skills.company_id !== context?.company_id || skills.context_revision !== context?.context_revision ||
      skills.source !== 'canonical-workforce-skill-capability-registry' ||
      !Number.isSafeInteger(skills.source_revision) || skills.source_revision < 0 ||
      !validId(skills.freshness) || !Number.isFinite(Date.parse(skills.freshness)) ||
      skills.read_only !== true || skills.grants_authority !== false ||
      skills.capability_presence_confers_authority !== false || skills.verification_confers_authority !== false ||
      skills.assignment_decision !== false || skills.routing_decision !== false ||
      skills.entitlement_decision !== false || skills.execution_permitted !== false ||
      projection?.schema !== 'titan.workforce.evidence-backed-skill-proof.v1' ||
      projection.company_id !== context?.company_id || projection.read_only !== true || projection.derived !== true ||
      projection.assignment_decision !== false || projection.routing_decision !== false ||
      projection.entitlement_decision !== false || projection.automatic_execution !== false ||
      projection.execution_permitted !== false || projection.grants_authority !== false ||
      !Array.isArray(projection.skill_proofs) || !Array.isArray(skills.evidence_refs)) {
    return { status: 'UNAVAILABLE', evidence_refs: [], source_revision: null };
  }

  const matches = projection.skill_proofs.filter(proof => proof?.worker_id === workerId && proof?.capability_id === capabilityId);
  if (matches.length !== 1) return { status: 'UNAVAILABLE', evidence_refs: [], source_revision: skills.source_revision };
  const proof = matches[0];
  const evidenceRefs = proof.evidence_refs;
  const usableEvidenceRefs = Array.isArray(evidenceRefs) && evidenceRefs.length > 0 &&
    evidenceRefs.every(ref => validId(ref) && skills.evidence_refs.includes(ref)) &&
    new Set(evidenceRefs).size === evidenceRefs.length && proof.evidence_count === evidenceRefs.length
    ? [...evidenceRefs] : [];
  if (proof.expired_or_revoked === true || ['EXPIRED', 'REVOKED'].includes(proof.verification_state)) {
    return { status: 'INELIGIBLE', evidence_refs: usableEvidenceRefs, source_revision: skills.source_revision };
  }
  if (proof.proof_state !== 'verified' || proof.verification_state !== 'VERIFIED' || proof.require_verified === false ||
      proof.meets_registry_requirement === false ||
      (Number.isFinite(proof.required_min_proficiency) && Number.isFinite(proof.proficiency) &&
        proof.proficiency < proof.required_min_proficiency)) {
    return { status: 'INELIGIBLE', evidence_refs: usableEvidenceRefs, source_revision: skills.source_revision };
  }
  if (proof.require_verified !== true || proof.meets_registry_requirement !== true ||
      !Number.isFinite(proof.required_min_proficiency) || proof.required_min_proficiency < 0 || proof.required_min_proficiency > 5 ||
      !Number.isFinite(proof.proficiency) || proof.proficiency < proof.required_min_proficiency ||
      proof.expired_or_revoked !== false || proof.capability_presence_confers_authority !== false ||
      proof.verification_confers_authority !== false || proof.grants_authority !== false ||
      !Array.isArray(evidenceRefs) || evidenceRefs.length === 0 || evidenceRefs.some(ref => !validId(ref)) ||
      new Set(evidenceRefs).size !== evidenceRefs.length || proof.evidence_count !== evidenceRefs.length ||
      evidenceRefs.some(ref => !skills.evidence_refs.includes(ref))) {
    return { status: 'UNAVAILABLE', evidence_refs: [], source_revision: skills.source_revision };
  }
  return { status: 'VERIFIED', evidence_refs: [...evidenceRefs], source_revision: skills.source_revision };
}

/**
 * Project only what today's authenticated host contract can actually prove.
 * The current #811 WorkItem projection has no service/playbook/window/equipment
 * binding or work revision, so this function deliberately cannot emit ELIGIBLE.
 * It still reports current exact-company skill proofs and definite blockers.
 */
function projectCleaningAssignmentEligibility({ context, work, worker, skills, projectionFreshness, contextMatches = true }) {
  const reasons = new Set();
  const skillSummary = [];
  let ineligible = false;
  const result = {
    schema: CLEANING_ELIGIBILITY_SCHEMA,
    company_id: context?.company_id ?? null,
    session_revision: context?.session_revision ?? null,
    context_revision: context?.context_revision ?? null,
    work_id: work?.work_id ?? null,
    work_revision: validId(work?.work_revision) ? work.work_revision : null,
    work_state: validId(work?.state) ? work.state : null,
    expected_assignee_id: work?.assignee == null ? null : (validId(work.assignee) ? work.assignee : null),
    worker_id: worker?.worker_id ?? null,
    worker_kind: worker?.kind ?? null,
    service_id: null,
    retained_job_type_id: null,
    status: 'UNAVAILABLE',
    reason_codes: [],
    skill_requirements: skillSummary,
    equipment_status: 'UNAVAILABLE',
    equipment_requirements: null,
    projection_freshness: typeof projectionFreshness === 'string' ? projectionFreshness : null,
    read_only: true,
    derived: true,
    assignment_decision: false,
    routing_decision: false,
    entitlement_decision: false,
    automatic_execution: false,
    execution_permitted: false,
    grants_authority: false,
  };
  const unavailable = reason => reasons.add(reason);
  if (!contextMatches || !validCurrentContext(context)) unavailable('current-session-context-unavailable');
  if (!work || !validId(work.work_id) || work.company_id !== context?.company_id) unavailable('company-work-binding-unavailable');
  if (!worker || !validId(worker.worker_id) || worker.company_id !== context?.company_id) unavailable('company-worker-binding-unavailable');
  if (!Number.isFinite(Date.parse(String(projectionFreshness ?? '')))) unavailable('workforce-projection-freshness-unavailable');
  if (!validId(work?.work_revision)) unavailable('work-revision-unavailable');
  if (!validId(work?.service_id) || !validId(work?.retained_job_type_id)) unavailable('cleaning-service-playbook-binding-unavailable');
  if (!validId(work?.requested_window_revision)) unavailable('requested-work-window-unavailable');
  if (!validId(work?.equipment_revision) || !Array.isArray(work?.equipment_requirements) ||
      !Array.isArray(work?.equipment_availability)) unavailable('cleaning-equipment-availability-unavailable');

  if (work && work.company_id === context?.company_id) {
    if (!validId(work.state)) unavailable('work-state-unavailable');
    else if (work.state !== 'READY') { reasons.add('work-not-ready'); ineligible = true; }
    if (work.assignee !== undefined && work.assignee !== null && !validId(work.assignee)) unavailable('work-assignee-invalid');
  }
  if (worker && worker.company_id === context?.company_id) {
    if (worker.active === false) { reasons.add('worker-inactive'); ineligible = true; }
    else if (worker.active !== true) unavailable('worker-activity-unavailable');
    if (worker.kind === 'digital') { reasons.add('cleaning-worker-must-be-human'); ineligible = true; }
    else if (worker.kind !== 'human') unavailable('worker-kind-unavailable');
    if (work?.assignee === worker.worker_id) { reasons.add('worker-already-assigned'); ineligible = true; }
  }

  const requirements = work?.required_capabilities;
  if (!Array.isArray(requirements) || requirements.some(value => !validId(value))) {
    unavailable('cleaning-skill-requirements-unavailable');
  } else {
    const cleaningRequirements = requirements.filter(isCleaningSkillRequirement);
    if (cleaningRequirements.length === 0) unavailable('cleaning-service-skill-binding-unavailable');
    if (new Set(cleaningRequirements).size !== cleaningRequirements.length) unavailable('cleaning-skill-requirements-ambiguous');
    for (const capabilityId of new Set(cleaningRequirements)) {
      const proof = assessCanonicalSkillProof(skills, context, worker?.worker_id, capabilityId);
      skillSummary.push(Object.freeze({ capability_id: capabilityId, status: proof.status,
        source_revision: proof.source_revision, evidence_refs: Object.freeze(proof.evidence_refs) }));
      if (proof.status === 'INELIGIBLE') { reasons.add('canonical-skill-proof-ineligible'); ineligible = true; }
      else if (proof.status !== 'VERIFIED') unavailable('canonical-skill-proof-unavailable');
    }
  }
  // No current canonical #811 projection supplies service/playbook, requested
  // window or company equipment truth. Catalog labels and browser fixtures are
  // not substitutes; retain explicit blockers until those owners publish it.
  unavailable('cleaning-service-playbook-readiness-unavailable');
  unavailable('cleaning-equipment-source-unavailable');

  return Object.freeze({ ...result, status: ineligible ? 'INELIGIBLE' : 'UNAVAILABLE',
    reason_codes: Object.freeze([...reasons].sort()), skill_requirements: Object.freeze(skillSummary) });
}

/** Current supported Cleaning service requirements use cleaning-named skill
 * IDs, with linen_handling as the one shared turnover skill. Keep generic
 * Workforce capability preflight behavior separate; the canonical host still
 * owns every assignment decision. */
function isCleaningSkillRequirement(capabilityId) {
  return /cleaning/i.test(capabilityId) || capabilityId === 'linen_handling';
}

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
  /** Authority-neutral, current-session preflight. Host gaps stay UNAVAILABLE. */
  async cleaningAssignmentEligibility(context, workId, workerId) {
    const current = await this.session.connect();
    this.#snapshot = null;
    if (!sameCurrentContext(context, current)) {
      return projectCleaningAssignmentEligibility({ context: current, work: null, worker: null, skills: null,
        projectionFreshness: null, contextMatches: false });
    }
    let projection;
    try { projection = await this.#load(current); }
    catch {
      return projectCleaningAssignmentEligibility({ context: current, work: null, worker: null, skills: null,
        projectionFreshness: null });
    }
    const { discovery, status } = projection.data;
    const workMatches = status.work?.filter(item => item?.company_id === current.company_id && item.work_id === workId) ?? [];
    const workerMatches = discovery.workers?.filter(item => item?.company_id === current.company_id && item.worker_id === workerId) ?? [];
    const work = workMatches.length === 1 ? workMatches[0] : null;
    const worker = workerMatches.length === 1 ? workerMatches[0] : null;
    return projectCleaningAssignmentEligibility({ context: current, work, worker, skills: discovery.skills ?? null,
      projectionFreshness: projection.freshness });
  }
  async control(context, action) {
    const current = await this.session.connect();
    if (!sameCurrentContext(context, current)) throw new Error('workforce-context-changed');
    this.#snapshot = null;
    const projection = await this.#load(current);
    const discovery = projection.data.discovery;
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
      const status = projection.data.status;
      const workMatches = status?.work?.filter(work => work?.company_id === current.company_id && work.work_id === action.work_id) ?? [];
      const workerMatches = discovery.workers?.filter(worker => worker?.company_id === current.company_id && worker.worker_id === action.target_worker_id) ?? [];
      const item = workMatches.length === 1 ? workMatches[0] : null;
      const target = workerMatches.length === 1 ? workerMatches[0] : null;
      const required = item?.required_capabilities;
      const requiresCleaningReadiness = item?.cleaning_assignment_context !== undefined ||
        (Array.isArray(required) && required.some(isCleaningSkillRequirement));
      const cleaningEligibility = requiresCleaningReadiness
        ? projectCleaningAssignmentEligibility({ context: current, work: item, worker: target,
          skills: discovery.skills ?? null, projectionFreshness: projection.freshness }) : null;
      if (!item || item.state !== 'READY' || (item.assignee != null && (typeof item.assignee !== 'string' || !item.assignee.trim())) ||
          !Array.isArray(required) || required.some(value => typeof value !== 'string' || !value.trim()) ||
          !target || target.active !== true || target.worker_id === item.assignee ||
          (cleaningEligibility && cleaningEligibility.status !== 'ELIGIBLE') ||
          required.some(capability => !isCleaningSkillRequirement(capability) &&
            (!Array.isArray(target.capabilities) || !target.capabilities.includes(capability)))) {
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
        company_id: current.company_id, actor_id: current.actor_id, capability_id: descriptor.capability_id,
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
    if (receipt?.status !== 'REQUESTED' || receipt.correlation_id !== correlation_id || typeof receipt.receipt_id !== 'string' || !receipt.receipt_id) throw new Error('workforce-receipt-invalid');
    return { company_id: current.company_id, state: 'REQUESTED', receipt_id: receipt.receipt_id,
      operation_id, correlation_id, work_id: action.work_id, evidence_refs: [] };
  }
}
