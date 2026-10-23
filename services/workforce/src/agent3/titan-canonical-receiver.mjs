/**
 * Titan Zero canonical Agent 3 integration receiver, protocol v1.
 *
 * This is a TRUST BOUNDARY, not an alternate workforce, task ledger, scheduler,
 * evidence ledger, or identity service. Mount inside the canonical Titan API
 * after binding its existing company storage / evidence / authority ports.
 * No network listener, database, or background worker is created here.
 *
 * Required ports are provided by the canonical owning service:
 *   keyForCompany(company_id) -> Buffer (>=32 bytes) | null
 *   authorizeBridge({company_id,operation,principal}) -> boolean
 *   claimNonce({company_id,nonce,expires_at_unix}) -> boolean [atomic, persistent]
 *   verifyOutcome({company_id,submission_id,hatchet_run_id,outcome_id,
 *      source_event_id,evidence_ref,minutes_saved}) -> accepted ledger receipt | null
 *   project({company_id,module}) -> exact canonical counts
 *
 * HMAC possession authenticates this connector, but does not grant effective
 * business authority. All successful responses additionally require authorizeBridge.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const BRIDGE = 'titan.canonical-bridge/v1';
const PROJECTION = 'titan.canonical-projection/v1';
const MODULES = new Set(['workforce', 'approvals', 'smart_tasks']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DENY_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const COMMON = new Set(['schema_version', 'nonce', 'issued_at_unix', 'company_id']);
const OUTCOME_KEYS = ['submission_id', 'hatchet_run_id', 'outcome_id', 'source_event_id', 'evidence_ref', 'minutes_saved'];
const OUTCOME_FIELDS = new Set([...COMMON, ...OUTCOME_KEYS]);
const PROJECT_FIELDS = new Set([...COMMON, 'module']);
const METRICS = Object.freeze({
  workforce: ['employees_active', 'running_workflows', 'waiting_workflows', 'failed_workflows'],
  approvals: ['pending_count'],
  smart_tasks: ['lifetime_completed', 'monthly_completed', 'minutes_saved'],
});

export const validId = value => typeof value === 'string' && ID.test(value) && !DENY_IDS.has(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const exactKeys = (value, expected) => object(value) && Object.keys(value).length === expected.size && Object.keys(value).every(k => expected.has(k));

// Identical to Python json.dumps(value, sort_keys=True, separators=(',', ':'),
// ensure_ascii=True) over the restricted bridge JSON types. Undefined and floats
// are rejected. UTF-16 surrogate escaping is intentionally retained.
export function compactAscii(value) {
  const encode = v => {
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v).replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
    if (Array.isArray(v)) return `[${v.map(encode).join(',')}]`;
    if (object(v)) return `{${Object.keys(v).sort().map(k => `${encode(k)}:${encode(v[k])}`).join(',')}}`;
    throw new TypeError('unsupported signing value');
  };
  return Buffer.from(encode(value), 'ascii');
}

export function signEnvelope(key, kind, nonce, body) {
  return createHmac('sha256', key).update(compactAscii({kind, nonce, body})).digest('hex');
}
function validSignature(presented, expected) {
  if (typeof presented !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(presented)) return false;
  const a = Buffer.from(presented.substring(7), 'ascii');
  const b = Buffer.from(expected, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}
function shapeRequest(route, body, now) {
  if (!exactKeys(body, route === '/v1/bridge/project' ? PROJECT_FIELDS : OUTCOME_FIELDS) || body.schema_version !== BRIDGE) return false;
  if (!validId(body.company_id) || typeof body.nonce !== 'string' || !/^[a-f0-9]{40}$/.test(body.nonce)) return false;
  if (!integer(body.issued_at_unix) || Math.abs(now - body.issued_at_unix) > 30) return false;
  if (route === '/v1/bridge/project') return MODULES.has(body.module);
  return OUTCOME_KEYS.slice(0, 5).every(k => validId(body[k]) || (k === 'evidence_ref' && typeof body[k] === 'string' && body[k].length >= 1 && body[k].length <= 255))
    && integer(body.minutes_saved) && body.minutes_saved <= 1440;
}
function outcomeMatches(outcome, body) {
  // A row is trusted only after it is fetched from the canonical, append-only
  // evidence owner, independently verified and company-resolved. Do not accept
  // flags fabricated by a provider/worker or unverified materialized views.
  if (!object(outcome) || outcome.state !== 'VERIFIED' || outcome.accepted_evidence !== true || !validId(outcome.canonical_receipt_id)) return false;
  if (!OUTCOME_KEYS.every(k => outcome[k] === body[k]) || outcome.company_id !== body.company_id) return false;
  if (!validId(outcome.submission_id) || !validId(outcome.hatchet_run_id)) return false;
  return true;
}
export function validateMetrics(module, result) {
  const names = METRICS[module];
  if (!names || !object(result) || Object.keys(result).length !== names.length || !names.every(k => Object.hasOwn(result, k) && integer(result[k]))) return false;
  return module !== 'smart_tasks' || result.monthly_completed <= result.lifetime_completed;
}

function failure(status = 403) {
  // Same response for mismatched credentials, unauthorized caller and bad
  // signatures; never reflect company/secret/evidence details in errors.
  return { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: { detail: 'bridge request denied' } };
}
function success(path, nonce, key, body) {
  return { status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'x-titan-signature': 'sha256=' + signEnvelope(key, 'response:' + path, nonce, body) }, body };
}

/** Returns a framework-neutral JSON HTTP reply. Every port MUST be real and fail closed. */
export function createCanonicalBridgeReceiver(ports, { clock = () => Math.floor(Date.now() / 1000), principal = 'titan-agent3' } = {}) {
  for (const name of ['keyForCompany', 'authorizeBridge', 'claimNonce', 'verifyOutcome', 'project']) {
    if (typeof ports?.[name] !== 'function') throw new TypeError(`canonical bridge port required: ${name}`);
  }
  if (typeof principal !== 'string' || !principal) throw new TypeError('principal required');
  return async ({ method, path, headers = {}, body }) => {
    if (method !== 'POST') return failure(405);
    if (!['/v1/bridge/project', '/v1/bridge/verify-outcome'].includes(path)) return failure(404);
    if (!object(headers) || typeof headers['content-type'] !== 'string' || !/^application\/json(?:;|$)/i.test(headers['content-type'])) return failure(415);
    let now;
    try { now = clock(); } catch { return failure(503); }
    if (!Number.isSafeInteger(now) || !shapeRequest(path, body, now)) return failure(400);
    try {
      const key = await ports.keyForCompany(body.company_id);
      if (!Buffer.isBuffer(key) || key.length < 32) return failure();
      const sig = signEnvelope(key, 'request:' + path, body.nonce, body);
      if (!validSignature(headers['x-titan-signature'], sig)) return failure();
      if (await ports.authorizeBridge({ company_id: body.company_id, operation: path, principal }) !== true) return failure();
      // Durable compare-and-set nonce claim. In-memory replay tables are NOT an
      // acceptable production implementation, particularly across replicas.
      if (await ports.claimNonce({ company_id: body.company_id, nonce: body.nonce, expires_at_unix: now + 90 }) !== true) return failure(409);
      if (path === '/v1/bridge/verify-outcome') {
        const canonical = await ports.verifyOutcome({ ...body });
        if (!outcomeMatches(canonical, body)) return failure(409);
        return success(path, body.nonce, key, {
          schema_version: BRIDGE, nonce: body.nonce, company_id: body.company_id,
          submission_id: body.submission_id, hatchet_run_id: body.hatchet_run_id,
          outcome_id: body.outcome_id, source_event_id: body.source_event_id,
          evidence_ref: body.evidence_ref, minutes_saved: body.minutes_saved,
          verified: true, canonical_receipt_id: canonical.canonical_receipt_id,
          expires_at_unix: now + 30,
        });
      }
      const result = await ports.project({ company_id: body.company_id, module: body.module });
      if (!validateMetrics(body.module, result)) return failure(503);
      return success(path, body.nonce, key, {
        schema_version: PROJECTION, nonce: body.nonce, company_id: body.company_id,
        module: body.module, observed_at_unix: now, expires_at_unix: now + 30, data: result,
      });
    } catch {
      // No connection details, raw records or company secrets in returned errors.
      return failure(503);
    }
  };
}
