import { ACCEPTED_EVIDENCE_SCHEMA, AcceptedEvidenceLedger } from '../../../packages/tools/accepted-evidence-ledger.mjs';

const DISPOSITIONS = new Set(['ok', 'fix_now', 'monitor', 'optional', 'refer']);

function required(value, name) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`accepted-evidence-reference-${name}-required`);
  return normalized;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parseObject(value, code) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const result = object(parsed);
    if (!result) throw new Error(code);
    return result;
  } catch {
    throw new Error(code);
  }
}

function sameJson(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  }
  if (left && typeof left === 'object' && right && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
      key === rightKeys[index] && sameJson(left[key], right[key]));
  }
  return left === right;
}

function requiredLineage(record, raw, row, provenance, input) {
  const requestInput = object(record.request_summary?.input);
  const operationContext = object(record.request_summary?.canonical_operation_context);
  const observed = object(record.observed_result);
  const verification = object(record.verification);
  const eventProvenance = object(raw.provenance);
  if (!requestInput || !operationContext || !observed || !verification || !eventProvenance) return false;

  const idFields = ['execution_id', 'decision_id'];
  if (idFields.some(field => typeof record[field] !== 'string' || !record[field].trim())) return false;
  if (record.company_id !== input.company_id || record.work_id !== input.work_id) return false;
  if (row.id !== record.evidence_id || row.company_id !== input.company_id
    || row.subject_type !== 'work' || row.subject_id !== input.work_id) return false;
  if (raw.company_id !== record.company_id || raw.evidence_id !== record.evidence_id
    || raw.execution_id !== record.execution_id || raw.decision_id !== record.decision_id
    || typeof raw.authority_decision_id !== 'string' || !raw.authority_decision_id.trim()
    || raw.authority_decision_id !== provenance.decision_id || raw.run_id !== record.run_id
    || typeof raw.correlation_id !== 'string' || !raw.correlation_id.trim()
    || (provenance.correlation_id && provenance.correlation_id !== raw.correlation_id)
    || raw.work_id !== record.work_id || raw.state !== record.state
    || raw.final_outcome !== record.final_outcome
    || !sameJson(raw.verification, record.verification)
    || !sameJson(raw.observed_result, record.observed_result)
    || !sameJson(raw.request_summary, record.request_summary)) return false;
  if (!sameJson(eventProvenance, provenance) || provenance.company_id !== input.company_id
    || provenance.work_id !== input.work_id || provenance.run_id !== record.run_id
    || provenance.decision_id !== record.decision_id
    || typeof provenance.execution_idempotency_key !== 'string'
    || !provenance.execution_idempotency_key.trim()
    || !Array.isArray(provenance.source_evidence_refs)
    || provenance.source_evidence_refs.some(value => typeof value !== 'string' || !value.trim())) return false;

  const target = ['visit_id', 'work_order_id', 'task_id', 'disposition'];
  return target.every(field => {
    const expected = input[field];
    return operationContext[field] === expected
      && (field !== 'work_order_id' || requestInput[field] === expected)
      && observed[field] === expected
      && verification[field] === expected
      && provenance[field] === expected;
  }) && verification.verified === true
    && typeof verification.verification_id === 'string' && verification.verification_id.trim().length > 0;
}

/**
 * Resolve accepted references from the caller's existing transaction. This
 * reads the production `evidence` base columns only; nested canonical accepted
 * records are validated by AcceptedEvidenceLedger and raw rows are never
 * promoted into accepted history by this consumer.
 */
export async function resolveAcceptedEvidenceReferencesInTransaction(tx, criteria) {
  if (!tx || typeof tx.query !== 'function') throw new Error('accepted-evidence-reference-transaction-required');
  const input = {
    company_id: required(criteria?.company_id, 'company-id'),
    work_id: required(criteria?.work_id, 'work-id'),
    visit_id: required(criteria?.visit_id, 'visit-id'),
    work_order_id: required(criteria?.work_order_id, 'work-order-id'),
    task_id: required(criteria?.task_id, 'task-id'),
    disposition: required(criteria?.disposition, 'disposition'),
  };
  if (!DISPOSITIONS.has(input.disposition)) throw new Error('accepted-evidence-reference-disposition-invalid');

  const rows = (await tx.query(
    `SELECT id,company_id,subject_type,subject_id,evidence_type,provenance,payload
       FROM evidence
      WHERE company_id=$1 AND subject_type='work' AND subject_id=$2 AND evidence_type='gateway_execution'
      ORDER BY rowid`,
    [input.company_id, input.work_id],
  )).rows;
  const ledger = new AcceptedEvidenceLedger();
  const persisted = [];
  for (const row of rows) {
    const payload = parseObject(row.payload, 'accepted-evidence-reference-record-invalid');
    const accepted = object(payload.accepted_evidence);
    // Older/raw gateway rows do not constitute accepted evidence. They are
    // intentionally invisible until the canonical ledger wrote its record.
    if (!accepted) continue;
    if (accepted.schema !== ACCEPTED_EVIDENCE_SCHEMA || accepted.factual !== true) {
      throw new Error('accepted-evidence-reference-record-invalid');
    }
    const provenance = parseObject(row.provenance, 'accepted-evidence-reference-record-invalid');
    if (!sameJson(payload.provenance, provenance)) throw new Error('accepted-evidence-reference-provenance-mismatch');
    ledger.now = () => accepted.recorded_at;
    const normalized = ledger.append(accepted);
    persisted.push({ row, raw: payload, provenance, accepted: normalized });
  }

  const projection = ledger.projectJob(input.company_id, input.work_id);
  if (projection.status !== 'VERIFIED') return [];
  const activeIds = new Set(projection.provenance.evidence_ids);
  return persisted
    .filter(({ row, raw, provenance, accepted }) => activeIds.has(accepted.evidence_id)
      && accepted.schema === ACCEPTED_EVIDENCE_SCHEMA
      && accepted.state === 'VERIFIED'
      && accepted.final_outcome === 'verified'
      && accepted.verification?.verified === true
      && requiredLineage(accepted, raw, row, provenance, input))
    .map(({ row, raw, provenance, accepted }) => Object.freeze({
      schema: 'titan.accepted-evidence-reference/v1',
      evidence_id: row.id,
      company_id: input.company_id,
      work_id: input.work_id,
      visit_id: input.visit_id,
      work_order_id: input.work_order_id,
      task_id: input.task_id,
      disposition: input.disposition,
      execution_id: accepted.execution_id,
      decision_id: accepted.decision_id,
      authority_decision_id: raw.authority_decision_id,
      verification_id: accepted.verification.verification_id,
      run_id: provenance.run_id,
      correlation_id: raw.correlation_id,
      accepted_at: accepted.recorded_at,
    }))
    .sort((a, b) => a.evidence_id.localeCompare(b.evidence_id));
}
