/**
 * Canonical Titan StorageClient implementation for Hatchet TRANSPORT bookkeeping.
 * Company business work and evidence remain in Workforce/Evidence owners.
 *
 * A company-scoped resolver is mandatory. It returns Titan's EXISTING registered
 * StorageClient for that company; caller-controlled paths, SQLite filenames, and
 * global fallback databases are forbidden. The two additive tables below store
 * only replay prevention and outbound transport correlation metadata.
 *
 * Call migrate(company_id) through the canonical migration owner BEFORE serving
 * requests. This module does not create databases or automatically migrate while
 * accepting business requests.
 */
import { randomUUID } from 'node:crypto';
import { validId } from './titan-canonical-receiver.mjs';

const STATES = new Set(['RESERVED', 'ACCEPTED', 'UNCERTAIN']);
const id = (value, name) => { if (!validId(value)) throw new Error(`agent3-${name}-invalid`); return value; };
const queryPort = storage => {
  if (typeof storage?.query !== 'function') throw new Error('canonical-company-storage-required');
  return storage;
};
const nowIso = () => new Date().toISOString();
const fail = code => { throw new Error(`agent3-${code}`); };

export function createCanonicalDurableDispatch({ resolveCompanyStorage, clock = nowIso, makeId = randomUUID } = {}) {
  if (typeof resolveCompanyStorage !== 'function') throw new TypeError('canonical registered company storage resolver required');
  if (typeof clock !== 'function' || typeof makeId !== 'function') throw new TypeError('clock/id generator required');
  const storageFor = async company_id => queryPort(await resolveCompanyStorage(id(company_id, 'company-id')));
  const rowFor = async (storage, company_id, work_id) => {
    const r = await storage.query('SELECT company_id,work_id,worker_id,reservation_id,idempotency_key,decision_ref,hatchet_run_id,state,created_at,updated_at FROM agent3_hatchet_transport WHERE company_id=$1 AND work_id=$2', [company_id,work_id]);
    return r.rows[0] ?? null;
  };
  const matching = (record, request) => record && record.company_id === request.company_id && record.work_id === request.work_id && record.reservation_id === request.reservation_id;
  const migrate = async company_id => {
    const storage = await storageFor(company_id);
    await storage.query(`CREATE TABLE IF NOT EXISTS agent3_bridge_nonces (
      company_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at_unix INTEGER NOT NULL,
      PRIMARY KEY (company_id,nonce))`);
    await storage.query('CREATE INDEX IF NOT EXISTS agent3_bridge_nonces_expiry ON agent3_bridge_nonces(expires_at_unix)');
    await storage.query(`CREATE TABLE IF NOT EXISTS agent3_hatchet_transport (
      company_id TEXT NOT NULL,work_id TEXT NOT NULL,worker_id TEXT NOT NULL,
      reservation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, decision_ref TEXT NOT NULL,
      hatchet_run_id TEXT,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id,work_id),UNIQUE (company_id,reservation_id),
      UNIQUE (company_id,idempotency_key), CHECK (state IN ('RESERVED','ACCEPTED','UNCERTAIN')))`);
    await storage.query('CREATE INDEX IF NOT EXISTS agent3_hatchet_transport_state ON agent3_hatchet_transport(company_id,state,updated_at)');
    return { company_id, migrations: 'agent3-transport-v1' };
  };

  return Object.freeze({
    migrate,
    /** Atomic insert-if-absent; expired claims are not deleted during a request.
     * A separate maintenance job owned by Titan storage may purge them later.
     */
    async claimNonce({ company_id,nonce,expires_at_unix }) {
      id(company_id,'company-id');
      if (typeof nonce !== 'string' || !/^[a-f0-9]{40}$/.test(nonce)) fail('nonce-invalid');
      if (!Number.isSafeInteger(expires_at_unix) || expires_at_unix < 1) fail('nonce-expiry-invalid');
      const storage = await storageFor(company_id);
      const inserted = await storage.query('INSERT INTO agent3_bridge_nonces(company_id,nonce,expires_at_unix) VALUES($1,$2,$3) ON CONFLICT(company_id,nonce) DO NOTHING', [company_id,nonce,expires_at_unix]);
      return inserted.rowCount === 1;
    },
    async reserveDispatch({ company_id,work_id,worker_id,idempotency_key,decision_ref }) {
      for (const [name,value] of Object.entries({company_id,work_id,worker_id,idempotency_key,decision_ref})) id(value,name);
      const storage = await storageFor(company_id);
      const reservation_id = id(makeId(),'reservation-id');
      const timestamp = clock();
      const inserted = await storage.query(`INSERT INTO agent3_hatchet_transport
        (company_id,work_id,worker_id,reservation_id,idempotency_key,decision_ref,hatchet_run_id,state,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,NULL,'RESERVED',$7,$7) ON CONFLICT DO NOTHING`,
        [company_id,work_id,worker_id,reservation_id,idempotency_key,decision_ref,timestamp]);
      if (inserted.rowCount === 1) return {created:true,reservation_id};
      const existing = await rowFor(storage,company_id,work_id);
      if (!existing || existing.worker_id !== worker_id || existing.idempotency_key !== idempotency_key || existing.decision_ref !== decision_ref)
        fail('dispatch-collision-manual-review');
      return {created:false,reservation_id:existing.reservation_id,state:existing.state,hatchet_run_id:existing.hatchet_run_id ?? null};
    },
    /**
     * Single atomic, durable egress gate. A reservation alone proves identity
     * but does NOT serialize independent SDK submit callers: they could both
     * read RESERVED and both start an external Hatchet workflow. Move it to
     * UNCERTAIN by CAS BEFORE any provider effect. The existing schema/state
     * already treats UNCERTAIN as never safe to retry, even after a crash.
     *
     * A complete authoritative reservation fingerprint must match; neither a
     * different worker nor a stale decision may spend this reservation.
     */
    async claimSubmission({company_id,work_id,worker_id,reservation_id,idempotency_key,decision_ref}) {
      for (const [name,value] of Object.entries({company_id,work_id,worker_id,reservation_id,idempotency_key,decision_ref})) id(value,name);
      const storage = await storageFor(company_id);
      const result = await storage.query(`UPDATE agent3_hatchet_transport
        SET state='UNCERTAIN',updated_at=$7
        WHERE company_id=$1 AND work_id=$2 AND worker_id=$3 AND reservation_id=$4
        AND idempotency_key=$5 AND decision_ref=$6
        AND state='RESERVED' AND hatchet_run_id IS NULL`,
        [company_id,work_id,worker_id,reservation_id,idempotency_key,decision_ref,clock()]);
      if(result.rowCount!==1) fail('submission-already-claimed-or-stale');
      return Object.freeze({company_id,work_id,reservation_id,state:'UNCERTAIN',safe_to_retry:false});
    },
    async getDispatch({company_id,work_id}) {
      id(company_id,'company-id');id(work_id,'work-id');
      return rowFor(await storageFor(company_id),company_id,work_id);
    },
    async markAccepted({company_id,work_id,reservation_id,hatchet_run_id}) {
      for (const [name,value] of Object.entries({company_id,work_id,reservation_id,hatchet_run_id})) id(value,name);
      const storage=await storageFor(company_id);
      const updated=await storage.query(`UPDATE agent3_hatchet_transport
        SET state='ACCEPTED',hatchet_run_id=$4,updated_at=$5
        WHERE company_id=$1 AND work_id=$2 AND reservation_id=$3 AND state IN ('RESERVED','UNCERTAIN') AND hatchet_run_id IS NULL`,
        [company_id,work_id,reservation_id,hatchet_run_id,clock()]);
      if (updated.rowCount===1) return {state:'ACCEPTED',hatchet_run_id};
      const row=await rowFor(storage,company_id,work_id);
      if (matching(row,{company_id,work_id,reservation_id}) && row.state==='ACCEPTED' && row.hatchet_run_id===hatchet_run_id)
        return {state:'ACCEPTED',hatchet_run_id};
      fail('dispatch-acceptance-conflict');
    },
    async markUncertain({company_id,work_id,reservation_id}) {
      for (const [name,value] of Object.entries({company_id,work_id,reservation_id})) id(value,name);
      const storage=await storageFor(company_id);
      const updated=await storage.query(`UPDATE agent3_hatchet_transport SET state='UNCERTAIN',updated_at=$4
        WHERE company_id=$1 AND work_id=$2 AND reservation_id=$3 AND state='RESERVED' AND hatchet_run_id IS NULL`,
        [company_id,work_id,reservation_id,clock()]);
      if (updated.rowCount===1) return {state:'UNCERTAIN'};
      const row=await rowFor(storage,company_id,work_id);
      if (matching(row,{company_id,work_id,reservation_id}) && (row.state==='UNCERTAIN' || row.state==='ACCEPTED'))
        return {state:row.state,hatchet_run_id:row.hatchet_run_id ?? null};
      fail('dispatch-uncertain-conflict');
    },
    async linkReconciled({company_id,work_id,reservation_id,hatchet_run_id}) {
      // The read-only reconciler must first independently confirm one run.
      // This method only makes the durable CAS transition; it does not itself
      // assert provenance of the Hatchet run.
      return this.markAccepted({company_id,work_id,reservation_id,hatchet_run_id});
    },
    /** Storage-owner maintenance only; a request path must never purge its own
     * replay evidence before the signed request validity horizon has elapsed. */
    async purgeExpiredNonces({company_id,before_unix}) {
      id(company_id,'company-id');
      if (!Number.isSafeInteger(before_unix) || before_unix<1) fail('purge-boundary-invalid');
      const result=await (await storageFor(company_id)).query(
        'DELETE FROM agent3_bridge_nonces WHERE company_id=$1 AND expires_at_unix<$2',[company_id,before_unix]);
      return {deleted:result.rowCount};
    },
    async listUncertain({company_id,limit=100}) {
      id(company_id,'company-id');
      if (!Number.isSafeInteger(limit) || limit<1 || limit>100) fail('list-limit-invalid');
      const result=await (await storageFor(company_id)).query(`SELECT company_id,work_id,worker_id,reservation_id,idempotency_key,decision_ref,hatchet_run_id,state,created_at,updated_at
        FROM agent3_hatchet_transport WHERE company_id=$1 AND state IN ('RESERVED','UNCERTAIN') ORDER BY updated_at ASC LIMIT $2`,[company_id,limit]);
      if (!Array.isArray(result.rows) || result.rows.some(row=>row.company_id!==company_id || !STATES.has(row.state))) fail('company-isolation-violation');
      return result.rows;
    },
  });
}
