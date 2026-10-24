import test from "node:test";
import assert from "node:assert/strict";
import { executionEvidenceToBusinessEvidence } from "./business-evidence-adapter.mjs";

const base={evidence_id:"ev-1",execution_id:"exec-1",company_id:"co-a",decision_id:"dec-1",work_id:"work-1",run_id:"run-1",agent_id:"agent-1",capability:"job.complete",provider:"native",execution_class:"native",state:"PROVIDER_ACKNOWLEDGED",finished_at:"2026-09-28T00:00:00.000Z",idempotency_key:"idem-1",external_ref:"provider-1",verification:null};

test("provider acknowledgement maps to factual execution evidence but not verified outcome",()=>{
 const e=executionEvidenceToBusinessEvidence(base);
 assert.equal(e.event_type,"execution.provider_acknowledged");assert.equal(e.verification_id,null);assert.equal(e.payload.final_outcome,null);
});

test("verified execution requires independent verification and carries verification lineage",()=>{
 assert.throws(()=>executionEvidenceToBusinessEvidence({...base,state:"VERIFIED",verification:null}),/verification-required/);
 assert.throws(()=>executionEvidenceToBusinessEvidence({...base,state:"VERIFIED",verification:{verified:true}}),/verification-id-required/);
 for(const verification_id of ["","   ",{},"verify-1\ninvalid"]){
  assert.throws(()=>executionEvidenceToBusinessEvidence({...base,state:"VERIFIED",verification:{verified:true,verification_id}}),/verification-id-(required|invalid)/);
 }
 const e=executionEvidenceToBusinessEvidence({...base,state:"VERIFIED",verification:{verified:true,verification_id:"verify-1",method:"canonical-reread"},final_outcome:"verified"});
 assert.equal(e.event_type,"execution.verified");assert.equal(e.verification_id,"verify-1");assert.equal(e.payload.final_outcome,"verified");
});

test("adapter preserves company and decision/work correlation",()=>{
 const e=executionEvidenceToBusinessEvidence(base);assert.equal(e.company_id,"co-a");assert.equal(e.correlation_id,"work-1");assert.equal(e.decision_id,"dec-1");assert.equal(e.execution_id,"exec-1");
});

test("uncertain execution is durable factual execution evidence, never a verified job fact",()=>{
 const e=executionEvidenceToBusinessEvidence({...base,state:"UNCERTAIN",verification:null,final_outcome:null});
 assert.equal(e.event_type,"execution.uncertain");
 assert.equal(e.subject_type,"execution");
 assert.equal(e.verification_id,null);
 assert.equal(e.acceptance_state,"accepted");
});
