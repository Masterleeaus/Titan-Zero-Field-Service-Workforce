import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { WorkforceApi } from '../images/api.mjs';
import { CLEANING_SERVICE_BY_ID, CLEANING_SERVICE_CATALOGUE } from '../../../../packages/titan-platform/src/verticals/cleaning/catalogue.ts';
import { buildEvidenceBackedSkillProof } from '../../../../packages/titan-platform/src/ported/titan-workforce/capability/evidence-backed-skill-proof.mjs';

const company_id = 'company-cleaning-a';
const context_revision = 'ctx-cleaning-7';
const session_revision = 3;
const projection_freshness = new Date().toISOString();
const actor_id = 'actor-manager-a';
const target_worker_id = 'worker-cleaner-a';
const service = CLEANING_SERVICE_BY_ID.regular_clean;

function canonicalSkills({
  company = company_id,
  revision = context_revision,
  worker = target_worker_id,
  capability = service.skills[0],
  verification_state = 'VERIFIED',
  proficiency = 4,
  required_min_proficiency = 3,
  require_verified = true,
  meets_registry_requirement = true,
} = {}) {
  const registry = {
    schema: 'titan.workforce.skill-capability-registry.v1', company_id: company,
    graph_revision: 9, updated_at: projection_freshness,
    grants_authority: false, execution_permitted: false,
    worker_capabilities: [{ worker_id: worker, capability_id: capability, proficiency,
      proficiency_level: 'ADVANCED', verification_state,
      evidence: [{ evidence_id: 'proof:cleaning-a:worker-cleaner-a:general-cleaning' }] }],
  };
  const matrix = {
    schema: 'titan.workforce.capability-matrix.v1', company_id: company,
    grants_authority: false, execution_permitted: false,
    workers: [{ worker_id: worker, capabilities: [{ capability_id: capability,
      meets_registry_requirement, required_min_proficiency, require_verified }] }],
  };
  const proof = buildEvidenceBackedSkillProof(registry, null, matrix);
  return {
    schema: 'titan.directadmin.workforce-skills.v1', company_id: company, context_revision: revision,
    read_only: true, capability_presence_confers_authority: false, verification_confers_authority: false,
    assignment_decision: false, routing_decision: false, entitlement_decision: false,
    execution_permitted: false, grants_authority: false,
    status: 'available', source: 'canonical-workforce-skill-capability-registry',
    freshness: projection_freshness, source_revision: 9,
    evidence_refs: proof.skill_proofs.flatMap(skill => skill.evidence_refs), projection: proof,
  };
}

function sessionFixture({ skills = canonicalSkills(), required_capabilities = service.skills,
  worker_id = target_worker_id, worker_company_id = company_id, worker_capabilities = [],
  includeSkills = true, state = 'READY', active = true, worker_kind = 'human', work_company_id = company_id,
  workOverrides = {}, duplicateWork = false,
} = {}) {
  const calls = [];
  const workers = [{ company_id: worker_company_id, worker_id, kind: worker_kind, active,
    // These raw values are display metadata only; skill eligibility uses the canonical proof projection.
    capabilities: worker_capabilities }];
  const work = { company_id: work_company_id, work_id: 'work-regular-clean-a', state,
    assignee: 'worker-cleaner-previous', required_capabilities, context_refs: [], evidence_refs: [], ...workOverrides };
  return {
    calls,
    connect: async () => ({ company_id, actor_id, session_revision, context_revision }),
    projection: async plugin => {
      calls.push(['projection', plugin]);
      const discovery = { company_id, workers, controls: [{ action: 'reassign',
        capability_id: 'titan.workforce.reassign', requires_fresh_approval: true, grants_authority: false }] };
      if (includeSkills) discovery.skills = skills;
      const workItems = duplicateWork ? [work, { ...work }] : [work];
      return { company_id, source: 'canonical-workforce-runtime', freshness: projection_freshness,
        evidence_refs: [], data: { schema: 'titan.workforce-cockpit.v1', company_id, discovery,
          status: { company_id, work: workItems } } };
    },
    intent: async (plugin, intent) => {
      calls.push(['intent', plugin, intent]);
      return { status: 'REQUESTED', receipt_id: 'receipt-cleaning-a', correlation_id: intent.correlation_id };
    },
  };
}

function validBundleJobTypes() {
  const bundle = JSON.parse(readFileSync(new URL('../../../../packages/modules/bundles/cleaning-workforce.bundle.json', import.meta.url), 'utf8'));
  const cleaning = bundle.modules.find(module => module.id === 'titan.workforce.cleaning');
  return cleaning.contributes.projections.find(projection => projection.id === 'job-types').value;
}

const context = { company_id, actor_id, session_revision, context_revision };
const assignment = () => ({ action: 'reassign', work_id: 'work-regular-clean-a', target_worker_id,
  reason: 'Request a qualified cleaner' });

test('supported catalogue mapping and current verified skill proof remain unavailable without host service and equipment readiness', async () => {
  assert.equal(service.id, 'regular_clean');
  assert.deepEqual(service.skills, ['general_cleaning']);
  assert.equal(service.retained_job_type_id, 'domestic_recurring');
  assert.ok(validBundleJobTypes().some(jobType => jobType.id === service.retained_job_type_id));

  const session = sessionFixture();
  const api = new WorkforceApi(session, () => 'operation-cleaning');
  const eligibility = await api.cleaningAssignmentEligibility(context, 'work-regular-clean-a', target_worker_id);
  assert.equal(eligibility.schema, 'titan.directadmin.workforce-cleaning-assignment-eligibility.v1');
  assert.equal(eligibility.status, 'UNAVAILABLE');
  assert.equal(eligibility.company_id, company_id);
  assert.equal(eligibility.session_revision, session_revision);
  assert.equal(eligibility.context_revision, context_revision);
  assert.equal(eligibility.work_revision, null);
  assert.equal(eligibility.worker_id, target_worker_id);
  assert.equal(eligibility.service_id, null);
  assert.equal(eligibility.retained_job_type_id, null);
  assert.equal(eligibility.equipment_status, 'UNAVAILABLE');
  assert.equal(eligibility.equipment_requirements, null);
  assert.deepEqual(eligibility.skill_requirements.map(item => item.capability_id), service.skills);
  assert.equal(eligibility.skill_requirements[0].status, 'VERIFIED');
  assert.ok(eligibility.skill_requirements[0].evidence_refs.length > 0);
  assert.ok(eligibility.reason_codes.includes('work-revision-unavailable'));
  assert.ok(eligibility.reason_codes.includes('cleaning-service-playbook-readiness-unavailable'));
  assert.ok(eligibility.reason_codes.includes('cleaning-equipment-source-unavailable'));
  assert.equal(eligibility.assignment_decision, false);
  assert.equal(eligibility.grants_authority, false);

  await assert.rejects(api.control(context, assignment()), /denied/);
  assert.equal(session.calls.some(([kind]) => kind === 'intent'), false,
    'a verified skill and catalogue label cannot bypass missing service/equipment facts');
});

test('missing, stale, cross-company, wrong-worker, or unavailable canonical skill proof never qualifies a cleaner', async () => {
  const unavailable = { schema: 'titan.directadmin.workforce-skills.v1', company_id, context_revision,
    read_only: true, capability_presence_confers_authority: false, verification_confers_authority: false,
    assignment_decision: false, routing_decision: false, entitlement_decision: false,
    execution_permitted: false, grants_authority: false, status: 'unavailable',
    reason: 'canonical-skill-projection-unavailable', source: null, freshness: null,
    source_revision: null, evidence_refs: [] };
  const cases = [
    { includeSkills: false },
    { skills: unavailable },
    { skills: canonicalSkills({ revision: 'ctx-old' }) },
    { skills: canonicalSkills({ company: 'company-cleaning-b' }) },
    { skills: canonicalSkills({ worker: 'worker-from-company-b' }) },
    { skills: { ...canonicalSkills(), freshness: 'not-a-date' } },
    { skills: { ...canonicalSkills(), source_revision: null } },
  ];
  for (const value of cases) {
    const session = sessionFixture(value);
    const api = new WorkforceApi(session, () => 'operation-denied');
    const eligibility = await api.cleaningAssignmentEligibility(context, 'work-regular-clean-a', target_worker_id);
    assert.equal(eligibility.status, 'UNAVAILABLE');
    await assert.rejects(api.control(context, assignment()), /denied|invalid/);
    assert.equal(session.calls.some(([kind]) => kind === 'intent'), false);
  }
});

test('unverified, expired, revoked, or unmet canonical requirements are explicitly ineligible', async () => {
  const cases = [
    canonicalSkills({ verification_state: 'UNVERIFIED' }),
    canonicalSkills({ verification_state: 'EXPIRED' }),
    canonicalSkills({ verification_state: 'REVOKED' }),
    canonicalSkills({ meets_registry_requirement: false }),
    canonicalSkills({ proficiency: 2, required_min_proficiency: 3 }),
    canonicalSkills({ require_verified: false }),
  ];
  for (const skills of cases) {
    const session = sessionFixture({ skills });
    const api = new WorkforceApi(session, () => 'operation-denied');
    const eligibility = await api.cleaningAssignmentEligibility(context, 'work-regular-clean-a', target_worker_id);
    assert.equal(eligibility.status, 'INELIGIBLE');
    assert.ok(eligibility.reason_codes.includes('canonical-skill-proof-ineligible'));
    await assert.rejects(api.control(context, assignment()), /denied/);
    assert.equal(session.calls.some(([kind]) => kind === 'intent'), false);
  }
});

test('each skill used by a retained Cleaning playbook requires its matching evidence-backed company proof', async () => {
  const requirements = [...new Set(CLEANING_SERVICE_CATALOGUE
    .filter(candidate => candidate.retained_job_type_id !== null)
    .flatMap(candidate => candidate.skills))];
  assert.ok(requirements.includes('general_cleaning'));
  assert.ok(requirements.includes('linen_handling'));
  for (const capability of requirements) {
    const session = sessionFixture({ skills: canonicalSkills({ capability }), required_capabilities: [capability] });
    const api = new WorkforceApi(session, () => 'operation-denied');
    const eligibility = await api.cleaningAssignmentEligibility(context, 'work-regular-clean-a', target_worker_id);
    assert.equal(eligibility.skill_requirements.length, 1);
    assert.equal(eligibility.skill_requirements[0].capability_id, capability);
    assert.equal(eligibility.skill_requirements[0].status, 'VERIFIED');
    assert.ok(eligibility.skill_requirements[0].evidence_refs.length > 0);
    assert.equal(eligibility.status, 'UNAVAILABLE', 'host service and equipment source remains absent');
    await assert.rejects(api.control(context, { ...assignment(), reason: 'test' }), /denied/);
    assert.equal(session.calls.some(([kind]) => kind === 'intent'), false, capability);
  }
});

test('worker capability strings and injected readiness labels cannot replace company-bound canonical facts', async () => {
  const session = sessionFixture({ includeSkills: false, worker_capabilities: service.skills,
    workOverrides: { service_id: 'custom_cleaning_service', retained_job_type_id: 'unreviewed_job_type',
      requested_window_revision: 'caller-window-label', equipment_revision: 'caller-equipment-label',
      equipment_requirements: service.equipment.map(equipment_type => ({ equipment_type, quantity: 1 })),
      equipment_availability: service.equipment.map((equipment_type, index) => ({ company_id,
        equipment_id: `fake-${index}`, equipment_type, state: 'AVAILABLE', evidence_refs: ['invented-evidence'] })),
      cleaning_assignment_context: { status: 'SUPPORTED', grants_authority: false } } });
  const api = new WorkforceApi(session, () => 'operation-denied');
  const eligibility = await api.cleaningAssignmentEligibility(context, 'work-regular-clean-a', target_worker_id);
  assert.equal(eligibility.status, 'UNAVAILABLE');
  assert.equal(eligibility.service_id, null);
  assert.equal(eligibility.equipment_status, 'UNAVAILABLE');
  assert.ok(eligibility.reason_codes.includes('canonical-skill-proof-unavailable'));
  await assert.rejects(api.control(context, assignment()), /denied/);
  assert.equal(session.calls.some(([kind]) => kind === 'intent'), false);
});

test('known work and worker disqualifiers report ineligible; ambiguous or cross-company bindings report unavailable', async () => {
  for (const options of [{ state: 'IN_PROGRESS' }, { active: false }, { worker_kind: 'digital' }]) {
    const session = sessionFixture(options);
    const api = new WorkforceApi(session, () => 'operation-denied');
    const eligibility = await api.cleaningAssignmentEligibility(context, 'work-regular-clean-a', target_worker_id);
    assert.equal(eligibility.status, 'INELIGIBLE');
    await assert.rejects(api.control(context, assignment()), /denied/);
    assert.equal(session.calls.some(([kind]) => kind === 'intent'), false);
  }
  for (const options of [
    { worker_company_id: 'company-cleaning-b' },
    { work_company_id: 'company-cleaning-b' },
    { duplicateWork: true },
  ]) {
    const session = sessionFixture(options);
    const api = new WorkforceApi(session, () => 'operation-denied');
    const eligibility = await api.cleaningAssignmentEligibility(context, 'work-regular-clean-a', target_worker_id);
    assert.equal(eligibility.status, 'UNAVAILABLE');
    await assert.rejects(api.control(context, assignment()), /denied/);
    assert.equal(session.calls.some(([kind]) => kind === 'intent'), false);
  }
});

test('a changed current DirectAdmin session invalidates the projection and blocks the control request', async () => {
  const session = sessionFixture();
  session.connect = async () => ({ ...context, company_id: 'company-cleaning-b', context_revision: 'ctx-b' });
  const api = new WorkforceApi(session, () => 'operation-denied');
  const eligibility = await api.cleaningAssignmentEligibility(context, 'work-regular-clean-a', target_worker_id);
  assert.equal(eligibility.status, 'UNAVAILABLE');
  assert.ok(eligibility.reason_codes.includes('current-session-context-unavailable'));
  await assert.rejects(api.control(context, assignment()), /context-changed/);
  assert.equal(session.calls.some(([kind]) => kind === 'intent'), false);
});
