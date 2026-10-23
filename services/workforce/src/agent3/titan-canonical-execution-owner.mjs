/**
 * One canonical execution ownership reservation for native Titan and Hatchet.
 *
 * This is a small, transport-only fencing record in Titan's registered
 * company storage, not an independent work queue, lease service or scheduler.
 * The assertion holds only when ALL entry points to both engines use the
 * governed selector. A separately callable native runtime is an integration
 * blocker, never something these records can magically fence out.
 *
 * Ownership is sticky after failures. Do not recycle it just because a process
 * died, an ACK timed out, or the caller presents a changed policy. A reviewed
 * migration must reconcile authoritative execution evidence first.
 */
import { randomUUID } from 'node:crypto';
import { validId } from './titan-canonical-receiver.mjs';

const STATES = new Set(['RESERVED','DISPATCHED','UNCERTAIN']);
const ENGINES = new Set(['native','hatchet']);
const id = (v,n) => { if (!validId(v)) throw new Error(`execution-owner-${n}-invalid`); return v; };
const requireState = (r,c,w) => {
  if (!r || r.company_id!==c || r.work_id!==w || !ENGINES.has(r.engine) || !STATES.has(r.state) ||
    !validId(r.claim_id) || !validId(r.worker_id) || !validId(r.policy_ref)) throw new Error('execution-owner-corrupt');
  return r;
};

export function createCanonicalExecutionOwner({ resolveCompanyStorage, clock=()=>new Date().toISOString(), makeId=randomUUID }={}) {
  if (typeof resolveCompanyStorage!=='function') throw new TypeError('execution-owner-company-storage-resolver-required');
  if (typeof clock!=='function' || typeof makeId!=='function') throw new TypeError('execution-owner-clock-required');
  async function storageFor(company_id) {
    const storage=await resolveCompanyStorage(id(company_id,'company-id'));
    if (typeof storage?.query!=='function') throw new Error('execution-owner-company-storage-unavailable');
    return storage;
  }
  async function get(c,w) {
    const result=await (await storageFor(c)).query(`SELECT company_id,work_id,worker_id,engine,claim_id,policy_ref,state,created_at,updated_at
      FROM agent3_execution_owner WHERE company_id=$1 AND work_id=$2`,[c,id(w,'work-id')]);
    return result.rows[0]?requireState(result.rows[0],c,w):null;
  }
  async function transition({company_id,work_id,claim_id},next) {
    id(company_id,'company-id');id(work_id,'work-id');id(claim_id,'claim-id');
    const storage=await storageFor(company_id);
    const from=next==='DISPATCHED'?['RESERVED']:['RESERVED'];
    const sql=`UPDATE agent3_execution_owner SET state=$4,updated_at=$5 WHERE company_id=$1 AND work_id=$2 AND claim_id=$3 AND state=$6`;
    const changed=await storage.query(sql,[company_id,work_id,claim_id,next,clock(),from[0]]);
    if (changed.rowCount===1) return {state:next,claim_id};
    const row=await get(company_id,work_id);
    if (row?.claim_id===claim_id && (row.state===next || (next==='UNCERTAIN' && row.state==='DISPATCHED')))
      return {state:row.state,claim_id};
    throw new Error('execution-owner-transition-conflict');
  }
  return Object.freeze({
    async migrate(company_id) {
      const storage=await storageFor(company_id);
      await storage.query(`CREATE TABLE IF NOT EXISTS agent3_execution_owner (
        company_id TEXT NOT NULL,work_id TEXT NOT NULL,worker_id TEXT NOT NULL,
        engine TEXT NOT NULL,claim_id TEXT NOT NULL,policy_ref TEXT NOT NULL,
        state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        PRIMARY KEY(company_id,work_id),UNIQUE(company_id,claim_id),
        CHECK(engine IN ('native','hatchet')),
        CHECK(state IN ('RESERVED','DISPATCHED','UNCERTAIN')))`);
      await storage.query('CREATE INDEX IF NOT EXISTS agent3_execution_owner_state ON agent3_execution_owner(company_id,state,updated_at)');
      return {company_id,migration:'agent3-execution-owner-v1'};
    },
    async reserve({company_id,work_id,worker_id,engine,policy_ref}) {
      for (const [n,v] of Object.entries({company_id,work_id,worker_id,policy_ref})) id(v,n);
      if (!ENGINES.has(engine)) throw new Error('execution-owner-invalid-engine');
      const storage=await storageFor(company_id);
      const claim_id=id(makeId(),'claim-id'),at=clock();
      const result=await storage.query(`INSERT INTO agent3_execution_owner
        (company_id,work_id,worker_id,engine,claim_id,policy_ref,state,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,'RESERVED',$7,$7) ON CONFLICT DO NOTHING`,
        [company_id,work_id,worker_id,engine,claim_id,policy_ref,at]);
      if (result.rowCount===1) return {created:true,claim_id,engine,state:'RESERVED'};
      const row=await get(company_id,work_id);
      if (!row || row.worker_id!==worker_id || row.engine!==engine || row.policy_ref!==policy_ref)
        throw new Error('execution-owner-conflict-manual-review');
      return {created:false,claim_id:row.claim_id,engine:row.engine,state:row.state};
    },
    get,
    async markDispatched(args) { return transition(args,'DISPATCHED'); },
    async markUncertain(args) { return transition(args,'UNCERTAIN'); },
    async listUncertain({company_id,limit=100}) {
      id(company_id,'company-id');
      if (!Number.isSafeInteger(limit) || limit<1 || limit>100) throw new Error('execution-owner-limit-invalid');
      const result=await (await storageFor(company_id)).query(`SELECT company_id,work_id,worker_id,engine,claim_id,policy_ref,state,created_at,updated_at
        FROM agent3_execution_owner WHERE company_id=$1 AND state IN ('RESERVED','UNCERTAIN') ORDER BY updated_at ASC LIMIT $2`,[company_id,limit]);
      if (!Array.isArray(result.rows)) throw new Error('execution-owner-read-invalid');
      return result.rows.map(r=>requireState(r,company_id,r.work_id));
    },
  });
}
