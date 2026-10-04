import { scoped, assertNestedCompany } from 'workforce-presentation';

/** Ephemeral view state only; canonical runtime and the shared SDK own all data/actions. */
const RECEIPT_BOOKMARK_KEY = 'titan.directadmin.workforce.receipt.v1';
const RECEIPT_BOOKMARK_SCHEMA = 'titan.directadmin.workforce-receipt-bookmark.v1';
const boundedOwnerId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
  value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const boundedReceiptId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  value === value.trim() && /^[A-Za-z0-9:._-]+$/.test(value) && value !== '.' && value !== '..' &&
  !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
const validReceiptBookmark = value => boundedOwnerId(value?.company_id) && boundedOwnerId(value?.actor_id) &&
  boundedReceiptId(value?.receipt_id) && boundedOwnerId(value?.operation_id) &&
  boundedOwnerId(value?.correlation_id) && boundedOwnerId(value?.work_id);

export class WorkforceController {
  #epoch = 0;
  #pending = null;
  #receiptRead = null;
  #receiptStorage;
  constructor(api, onChange = () => {}, receiptStorage) {
    this.api = api;
    this.onChange = onChange;
    if (receiptStorage !== undefined) this.#receiptStorage = receiptStorage;
    else { try { this.#receiptStorage = globalThis.sessionStorage ?? null; } catch { this.#receiptStorage = null; } }
    this.state = { phase: 'loading', context: null, discovery: null, status: null, skills: null, metadata: null,
      receipt: null, receiptLookupStatus: null, error: null };
  }
  #set(next) { this.state = { ...this.state, ...next }; this.onChange(this.state); }
  #clearReceiptBookmark() { try { this.#receiptStorage?.removeItem(RECEIPT_BOOKMARK_KEY); } catch { /* Optional UI convenience. */ } }
  /** The tab-scoped pointer contains IDs only and is revalidated against a fresh host context. */
  hasReceiptBookmark() { return this.#readReceiptBookmark() !== null; }
  #readReceiptBookmark() {
    try {
      const raw = this.#receiptStorage?.getItem(RECEIPT_BOOKMARK_KEY);
      if (!raw || raw.length > 16384) return null;
      const value = JSON.parse(raw);
      if (value?.schema !== RECEIPT_BOOKMARK_SCHEMA || !validReceiptBookmark(value)) {
        this.#clearReceiptBookmark(); return null;
      }
      return Object.freeze({ schema: RECEIPT_BOOKMARK_SCHEMA, company_id: value.company_id, actor_id: value.actor_id,
        receipt_id: value.receipt_id, operation_id: value.operation_id, correlation_id: value.correlation_id,
        work_id: value.work_id });
    } catch { this.#clearReceiptBookmark(); return null; }
  }
  #saveReceiptBookmark(context, receipt) {
    const bookmark = { schema: RECEIPT_BOOKMARK_SCHEMA, company_id: context?.company_id, actor_id: context?.actor_id,
      receipt_id: receipt?.receipt_id, operation_id: receipt?.operation_id,
      correlation_id: receipt?.correlation_id, work_id: receipt?.work_id };
    if (validReceiptBookmark(bookmark)) {
      try { this.#receiptStorage?.setItem(RECEIPT_BOOKMARK_KEY, JSON.stringify(bookmark)); } catch { /* Optional UI convenience. */ }
    } else this.#clearReceiptBookmark();
  }
  #receiptAck(bookmark) {
    return { company_id: bookmark.company_id, state: 'REQUESTED', receipt_id: bookmark.receipt_id,
      operation_id: bookmark.operation_id, correlation_id: bookmark.correlation_id, work_id: bookmark.work_id,
      evidence_refs: [] };
  }
  async #readReceipt(context, bookmark, epoch) {
    if (this.#receiptRead) return;
    const readToken = Symbol('receipt-read');
    this.#receiptRead = readToken;
    let receipt = this.#receiptAck(bookmark);
    this.#set({ receipt, receiptLookupStatus: 'loading' });
    let receiptLookupStatus;
    try {
      const detail = typeof this.api.receipt === 'function'
        ? await this.api.receipt(context, bookmark.receipt_id, bookmark) : null;
      if (epoch !== this.#epoch) return;
      if (detail) {
        scoped(detail, context.company_id); assertNestedCompany(detail, context.company_id);
        if (detail.receipt_id !== bookmark.receipt_id || detail.operation_id !== bookmark.operation_id ||
            detail.correlation_id !== bookmark.correlation_id || detail.work_id !== bookmark.work_id) {
          throw new Error('workforce-receipt-binding-mismatch');
        }
        receipt = detail;
        receiptLookupStatus = 'available';
      } else {
        receiptLookupStatus = 'unsupported';
      }
    } catch (error) {
      if (epoch !== this.#epoch) return;
      const message = String(error?.message ?? '');
      if (/401|403|409|expired|revok|context|company-mismatch/.test(message)) throw error;
      receiptLookupStatus = /404|not-found|pending/i.test(message) ? 'pending' : 'unavailable';
    } finally {
      if (this.#receiptRead === readToken) this.#receiptRead = null;
    }
    if (epoch === this.#epoch) this.#set({ receipt, receiptLookupStatus });
  }
  invalidate({ preserveReceiptBookmark = false } = {}) {
    this.#epoch++;
    this.#pending = null;
    this.#receiptRead = null;
    if (!preserveReceiptBookmark) this.#clearReceiptBookmark();
    this.#set({ phase: 'denied', context: null, discovery: null, status: null, skills: null, metadata: null,
      receipt: null, receiptLookupStatus: null, error: 'Context changed. Reconnect to load permitted Workforce.' });
  }
  async connect() {
    const epoch = ++this.#epoch;
    this.#receiptRead = null;
    let bookmark = this.#readReceiptBookmark();
    this.#pending = null;
    this.#set({ phase: 'loading', context: null, discovery: null, status: null, skills: null, metadata: null,
      receipt: null, receiptLookupStatus: null, error: null });
    try {
      const context = await this.api.context();
      if (epoch !== this.#epoch) return;
      if (!context?.company_id || !context.actor_id || !context.session_revision) throw new Error('workforce-context-denied');
      if (bookmark && (bookmark.company_id !== context.company_id || bookmark.actor_id !== context.actor_id)) {
        this.#clearReceiptBookmark(); bookmark = null;
      }
      const [discovery, status, skills, metadata] = await Promise.all([
        this.api.discover(context), this.api.status(context),
        typeof this.api.skills === 'function' ? this.api.skills(context) : null,
        this.api.metadata(context),
      ]);
      if (epoch !== this.#epoch) return;
      for (const value of [discovery, status]) { scoped(value, context.company_id); assertNestedCompany(value, context.company_id); }
      this.#validateProjection(discovery, status, context.company_id);
      this.#validateSkills(skills, discovery, context);
      if (skills) assertNestedCompany(skills, context.company_id);
      this.#set({ phase: 'ready', context, discovery, status, skills, metadata, receipt: null, receiptLookupStatus: null });
      if (bookmark) await this.#readReceipt(context, bookmark, epoch);
      return epoch;
    } catch (error) { if (epoch === this.#epoch) this.#fail(error); return null; }
  }
  #validateProjection(discovery, status, companyId) {
    const invalid = () => { throw new Error('workforce-projection-invalid'); };
    const strings = value => value === undefined || (Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim()));
    const optionalString = value => value == null || (typeof value === 'string' && value.trim().length > 0);
    if (!Array.isArray(discovery?.workers) || !Array.isArray(status?.work)) throw new Error('workforce-projection-invalid');
    if (discovery.controls !== undefined && (!Array.isArray(discovery.controls) || discovery.controls.some(control =>
      !control || typeof control.action !== 'string' || !control.action.trim() || typeof control.capability_id !== 'string' || !control.capability_id.trim()))) invalid();
    for (const worker of discovery.workers) {
      scoped(worker, companyId);
      if (typeof worker.worker_id !== 'string' || !worker.worker_id || !['digital', 'human'].includes(worker.kind)) throw new Error('workforce-projection-invalid');
      if (!strings(worker.capabilities) || typeof worker.active !== 'boolean') invalid();
      if (!optionalString(worker.role) || !optionalString(worker.tier) ||
          !optionalString(worker.manager_id) || !optionalString(worker.team_id)) invalid();
    }
    for (const item of status.work) {
      scoped(item, companyId);
      if (typeof item.work_id !== 'string' || !item.work_id || typeof item.state !== 'string') throw new Error('workforce-projection-invalid');
      if (!strings(item.context_refs) || !strings(item.evidence_refs) || !strings(item.required_capabilities)) invalid();
      if (!optionalString(item.run_id)) invalid();
    }
  }
  #validateSkills(skills, discovery, context) {
    if (skills == null) return; // Older compatible hosted projections may omit this field.
    const invalid = () => { throw new Error('workforce-skills-projection-invalid'); };
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const count = value => Number.isSafeInteger(value) && value >= 0;
    const text = value => typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
    const numericSummary = (value, keys) => record(value) && keys.every(key => count(value[key]));
    if (!skills || typeof skills !== 'object' || skills.schema !== 'titan.directadmin.workforce-skills.v1') invalid();
    if (skills.company_id !== context.company_id) throw new Error('workforce-company-mismatch');
    if (skills.context_revision !== context.context_revision) throw new Error('workforce-context-changed');
    if (skills.read_only !== true || skills.grants_authority !== false ||
        !['available', 'unavailable'].includes(skills.status)) invalid();
    if (skills.status === 'unavailable') {
      if (skills.source !== null || skills.projection !== undefined || !Array.isArray(skills.evidence_refs) || skills.evidence_refs.length) invalid();
      return;
    }
    const projection = skills.projection;
    const roster = new Set(discovery.workers.map(worker => worker.worker_id));
    if (skills.source !== 'canonical-workforce-skill-capability-registry' ||
        !(skills.freshness === null || (text(skills.freshness) && Number.isFinite(Date.parse(skills.freshness)))) ||
        !(skills.source_revision === null || (Number.isSafeInteger(skills.source_revision) && skills.source_revision >= 0)) ||
        !Array.isArray(skills.evidence_refs) || skills.evidence_refs.some(ref => !text(ref)) ||
        new Set(skills.evidence_refs).size !== skills.evidence_refs.length || !projection ||
        projection.schema !== 'titan.workforce.evidence-backed-skill-proof.v1' ||
        projection.company_id !== context.company_id || projection.read_only !== true ||
        projection.derived !== true || projection.performance_is_context_only !== true ||
        projection.grants_authority !== false || projection.execution_permitted !== false ||
        projection.automatic_execution !== false || projection.assignment_decision !== false ||
        projection.routing_decision !== false || projection.entitlement_decision !== false ||
        !Array.isArray(projection.workers) || !Array.isArray(projection.skill_proofs) ||
        !numericSummary(projection.summary, ['worker_count', 'skill_proof_count', 'verified_skill_proofs',
          'evidenced_skill_proofs', 'unverified_skill_proofs', 'invalid_skill_proofs', 'requirement_gaps',
          'workers_with_contextual_performance']) || projection.summary.worker_count !== projection.workers.length ||
        projection.summary.skill_proof_count !== projection.skill_proofs.length) invalid();
    const validateProof = (proof, expectedWorker) => {
      if (!record(proof) || !roster.has(proof.worker_id) || (expectedWorker && proof.worker_id !== expectedWorker) ||
          !text(proof.capability_id) || !text(proof.proof_state) ||
          !['verified', 'evidenced', 'unverified', 'expired', 'revoked'].includes(proof.proof_state) ||
          !text(proof.verification_state) || !text(proof.proficiency_level) ||
          typeof proof.proficiency !== 'number' || !Number.isFinite(proof.proficiency) || proof.proficiency < 0 || proof.proficiency > 5 ||
          !(proof.meets_registry_requirement === null || typeof proof.meets_registry_requirement === 'boolean') ||
          !Array.isArray(proof.evidence_refs) || proof.evidence_refs.some(ref => !text(ref)) ||
          proof.grants_authority !== false || proof.capability_presence_confers_authority !== false ||
          proof.verification_confers_authority !== false || proof.performance_confers_authority !== false) invalid();
      return JSON.stringify([proof.worker_id, proof.capability_id, proof.proof_state, proof.verification_state,
        proof.proficiency_level, proof.proficiency, proof.meets_registry_requirement, proof.evidence_refs]);
    };
    const workerBindings = new Map();
    const seenWorkers = new Set();
    for (const worker of projection.workers) {
      if (!record(worker) || !roster.has(worker.worker_id) || seenWorkers.has(worker.worker_id) ||
          !Array.isArray(worker.skills) || !numericSummary(worker.summary,
            ['skill_count', 'verified', 'evidenced', 'unverified', 'expired_or_revoked', 'requirement_gaps']) ||
          worker.summary.skill_count !== worker.skills.length || worker.grants_authority !== false ||
          worker.worker_identity_confers_authority !== false) invalid();
      seenWorkers.add(worker.worker_id);
      const bindings = new Map();
      for (const proof of worker.skills) {
        const key = validateProof(proof, worker.worker_id);
        const identity = `${proof.worker_id}\u0000${proof.capability_id}`;
        if (bindings.has(identity)) invalid();
        bindings.set(identity, key);
      }
      workerBindings.set(worker.worker_id, bindings);
    }
    const seenProofs = new Set();
    const proofStates = { verified: 0, evidenced: 0, unverified: 0, invalid: 0, requirementGaps: 0 };
    const proofEvidence = new Set();
    for (const proof of projection.skill_proofs) {
      const key = validateProof(proof);
      const workerSkills = workerBindings.get(proof.worker_id);
      const identity = `${proof.worker_id}\u0000${proof.capability_id}`;
      if (seenProofs.has(identity) || workerSkills?.get(identity) !== key) invalid();
      seenProofs.add(identity);
      proofStates[proof.proof_state === 'expired' || proof.proof_state === 'revoked' ? 'invalid' : proof.proof_state]++;
      if (proof.meets_registry_requirement === false) proofStates.requirementGaps++;
      for (const ref of proof.evidence_refs) proofEvidence.add(ref);
    }
    if (projection.skill_proofs.length !== [...workerBindings.values()].reduce((total, bindings) => total + bindings.size, 0)) invalid();
    if (projection.summary.verified_skill_proofs !== proofStates.verified ||
        projection.summary.evidenced_skill_proofs !== proofStates.evidenced ||
        projection.summary.unverified_skill_proofs !== proofStates.unverified ||
        projection.summary.invalid_skill_proofs !== proofStates.invalid ||
        projection.summary.requirement_gaps !== proofStates.requirementGaps ||
        skills.evidence_refs.length !== proofEvidence.size || skills.evidence_refs.some(ref => !proofEvidence.has(ref))) invalid();
  }
  #fail(error, submitted = false) {
    this.#epoch++;
    this.#pending = null;
    this.#receiptRead = null;
    const message = String(error?.message ?? '');
    const denied = /401|403|409|denied|expired|revok|context|company-mismatch/.test(message);
    // A temporary transport/projection failure must not lose the opaque IDs
    // needed to reread an accepted action after reconnect. Identity/authority
    // failures invalidate that pointer so it cannot cross a revoked context.
    if (denied) this.#clearReceiptBookmark();
    // Never render exception payloads (upstream errors may contain secrets or another company's IDs).
    this.#set({ phase: denied ? 'denied' : 'unavailable', context: null, discovery: null, status: null,
      skills: null, metadata: null, receipt: null, receiptLookupStatus: null,
      error: denied ? 'Access or company context changed. Reconnect to revalidate.' : submitted ? 'Request outcome is unknown. Reconnect and inspect canonical work/history before submitting again.' : 'Hosted Workforce is unavailable. Reconnect to retrieve current state.' });
  }
  async submit(action) {
    if (this.state.phase !== 'ready' || this.#pending || this.#receiptRead) return;
    const epoch = this.#epoch;
    const context = this.state.context;
    this.#clearReceiptBookmark();
    const pending = { token: Symbol('workforce-submit'), action: structuredClone(action), stage: 'preflight' };
    this.#pending = pending;
    this.#set({ phase: 'submitting', receipt: null, receiptLookupStatus: null, error: null });
    try {
      const current = await this.api.context();
      if (epoch !== this.#epoch) return;
      if (current.company_id !== context.company_id || current.actor_id !== context.actor_id ||
          current.session_revision !== context.session_revision || current.context_revision !== context.context_revision) throw new Error('workforce-context-changed');
      pending.stage = 'control';
      const receipt = await this.api.control(current, pending.action);
      if (epoch !== this.#epoch) return;
      scoped(receipt, context.company_id); assertNestedCompany(receipt, context.company_id);
      this.#saveReceiptBookmark(context, receipt);
      pending.stage = 'refresh';
      await this.#readReceipt(current, receipt, epoch);
      if (epoch !== this.#epoch) return;
      const displayedReceipt = this.state.receipt ?? receipt;
      const receiptLookupStatus = this.state.receiptLookupStatus;
      // Do not optimistically edit canonical status; reload it after a receipt.
      const [status, skills, metadata] = await Promise.all([
        this.api.status(current), typeof this.api.skills === 'function' ? this.api.skills(current) : null,
        this.api.metadata(current),
      ]);
      if (epoch !== this.#epoch) return;
      scoped(status, context.company_id); assertNestedCompany(status, context.company_id);
      this.#validateProjection(this.state.discovery, status, context.company_id);
      this.#validateSkills(skills, this.state.discovery, current);
      if (skills) assertNestedCompany(skills, context.company_id);
      if (this.#pending === pending) this.#pending = null;
      this.#set({ phase: 'ready', status, skills, metadata, receipt: displayedReceipt, receiptLookupStatus });
    } catch (error) {
      if (error?.message === 'directadmin-workforce-action-denied' &&
          epoch === this.#epoch && this.#pending === pending) {
        // #1049 classifies this 403 at the shared governed-intent route and
        // retains valid session context. Revalidate before restoring the view;
        // an invalidation/switch makes this operation stale and cannot recover.
        const recoveryEpoch = await this.connect();
        if (recoveryEpoch !== null && recoveryEpoch === this.#epoch && this.state.phase === 'ready') {
          this.#set({ receipt: null, receiptLookupStatus: null,
            error: 'The host returned a denial without a receipt. Current company data was refreshed; outcome is unverified. Inspect canonical history before retrying.' });
        }
      } else if (error?.message === 'directadmin-http-403' &&
          pending.stage === 'refresh' && epoch === this.#epoch && this.#pending === pending) {
        // A request was accepted, then the read-only refresh was denied. Do
        // not mislabel it as an action denial or retain cleared company data.
        this.#fail(error, true);
        this.#set({ error: 'A request was submitted, but current state could not be refreshed. Reconnect and inspect canonical history before retrying.' });
      } else {
        if (this.#pending === pending) this.#pending = null;
        if (epoch === this.#epoch) this.#fail(error, true);
      }
    }
  }
  async refreshReceipt() {
    if (this.state.phase !== 'ready' || !this.state.context || !this.state.receipt?.receipt_id ||
        this.state.receiptLookupStatus === 'loading' || this.#pending || this.#receiptRead) return;
    const epoch = this.#epoch;
    const context = this.state.context;
    const bookmark = this.#readReceiptBookmark();
    if (!bookmark || bookmark.company_id !== context.company_id || bookmark.actor_id !== context.actor_id ||
        bookmark.receipt_id !== this.state.receipt.receipt_id) return;
    const readToken = Symbol('receipt-refresh');
    this.#receiptRead = readToken;
    this.#set({ receipt: this.#receiptAck(bookmark), receiptLookupStatus: 'loading' });
    try {
      const current = await this.api.context();
      if (epoch !== this.#epoch) return;
      if (current.company_id !== context.company_id || current.actor_id !== context.actor_id ||
          current.session_revision !== context.session_revision || current.context_revision !== context.context_revision) {
        throw new Error('workforce-context-changed');
      }
      this.#receiptRead = null;
      await this.#readReceipt(current, bookmark, epoch);
    } catch (error) {
      if (epoch === this.#epoch) {
        const message = String(error?.message ?? '');
        if (/401|403|409|expired|revok|context|company-mismatch/.test(message)) this.#fail(error);
        else this.#set({ receipt: this.#receiptAck(bookmark), receiptLookupStatus: /404|not-found|pending/i.test(message) ? 'pending' : 'unavailable' });
      }
    } finally {
      if (this.#receiptRead === readToken) this.#receiptRead = null;
    }
  }
}
