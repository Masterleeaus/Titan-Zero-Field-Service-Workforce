const required=(value,name)=>{const text=String(value??"").trim();if(!text)throw new Error(`execution-evidence-${name}-required`);return text;};
const reference=(value,name)=>{if(typeof value!=="string")throw new Error(`execution-evidence-${name}-required`);const text=value.trim();if(!text||text.length>512||/[\u0000-\u001f\u007f]/.test(text))throw new Error(`execution-evidence-${name}-invalid`);return text;};

const FACTUAL_STATES=new Set(["REQUESTED","AUTHORIZED","EXECUTING","PROVIDER_ACKNOWLEDGED","VERIFYING","VERIFIED","FAILED","UNCERTAIN"]);

export function executionEvidenceToBusinessEvidence(evidence,{projection_version="execution-reality.v1",accepted_at=evidence?.finished_at}={}){
 const state=required(evidence?.state,"state");
 if(!FACTUAL_STATES.has(state))throw new Error("execution-evidence-state-unsupported");
 const company_id=required(evidence?.company_id,"company-id");
 const execution_id=required(evidence?.execution_id,"execution-id");
 const verified=state==="VERIFIED";
 if(verified && evidence?.verification?.verified!==true)throw new Error("execution-evidence-verification-required");
 if(state==="PROVIDER_ACKNOWLEDGED" && evidence?.verification)throw new Error("execution-evidence-provider-ack-cannot-carry-verification");
 return Object.freeze({
  evidence_id:required(evidence?.evidence_id,"evidence-id"),
  evidence_version:1,
  company_id,
  event_type:verified?"execution.verified":state==="PROVIDER_ACKNOWLEDGED"?"execution.provider_acknowledged":`execution.${state.toLowerCase()}`,
  subject_type:"execution",
  subject_id:execution_id,
  classification:"factual",
  acceptance_state:"accepted",
  source_type:"execution-gateway",
  source_id:required(evidence?.provider,"provider"),
  actor_id:evidence?.actor_id??null,
  agent_id:evidence?.agent_id??null,
  correlation_id:String(evidence?.correlation_id??evidence?.work_id??evidence?.run_id??execution_id),
  causation_id:evidence?.causation_id??evidence?.decision_id??null,
  decision_id:evidence?.decision_id??null,
  authority_decision_id:evidence?.authority_decision_id??null,
  execution_id,
  verification_id:verified?reference(evidence?.verification?.verification_id??evidence?.verification?.id,"verification-id"):null,
  projection_version,
  supersedes_evidence_id:null,
  provenance:Object.freeze({provider:evidence.provider,execution_class:evidence.execution_class,idempotency_key:evidence.idempotency_key,external_ref:evidence.external_ref??null}),
  payload:Object.freeze({state,capability:evidence.capability,observed_result:evidence.observed_result??null,failure:evidence.failure??null,final_outcome:evidence.final_outcome??null}),
  occurred_at:required(evidence?.finished_at,"finished-at"),
  accepted_at:required(accepted_at,"accepted-at"),
 });
}
