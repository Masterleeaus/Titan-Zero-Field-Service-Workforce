import { randomUUID } from "node:crypto";
import { assertAuthorityDecisionAllowsExecution } from "./authority-evaluator.mjs";

const STATUS=Object.freeze({
  ALLOW:"approved",
  APPROVAL_REQUIRED:"approval_required",
});

const required=(value,code)=>{const text=String(value??"").trim();if(!text)throw new Error(code);return text;};

function nextEvaluationTime(previous){
  const now=Date.now();
  const prior=Date.parse(String(previous?.evaluated_at??""));
  return new Date(Number.isFinite(prior)&&prior>=now?prior+1:now).toISOString();
}

export class RuntimeAuthorityGateway {
  constructor({contextResolver,executionGateway,authorityStore}={}){
    if(!contextResolver?.evaluate)throw new Error("runtime-authority-context-resolver-required");
    if(!executionGateway?.execute)throw new Error("runtime-authority-execution-gateway-required");
    this.contextResolver=contextResolver;
    this.executionGateway=executionGateway;
    this.authorityStore=authorityStore;
  }

  async authorize(input){
    const canonical=await this.contextResolver.evaluate({
      ...input,
      operation_id:input.run_id??input.operation_id,
      action_id:input.idempotency_key??input.action_id??input.run_id??input.operation_id,
    });
    if(this.authorityStore?.appendDecision)await this.authorityStore.appendDecision(canonical);
    return Object.freeze({
      status:STATUS[canonical.decision]??"denied",
      decision_id:canonical.authority_decision_id,
      canonical,
    });
  }

  async execute({decision,capability,input,idempotency_key,company_id,actor_id,work_id,agent_id,run_id,correlation_id,signal}){
    const previous=decision?.canonical;
    if(!previous)throw new Error("runtime-canonical-authority-decision-required");
    const capabilityName=required(capability?.name??previous.capability,"runtime-capability-required");
    // Human and externally initiated operations may have no AI run. Preserve
    // run_id when one exists; otherwise bind the authority and execution to the
    // canonical operation_id instead of inventing a run identifier.
    const operationId=required(previous.operation_id??run_id,"runtime-operation-id-required");
    const actionId=required(previous.action_id??idempotency_key??run_id??operationId,"runtime-action-id-required");
    const idempotencyKey=required(idempotency_key??actionId,"runtime-idempotency-key-required");

    // The authorization decision is only a historical fact. Re-resolve current
    // authority at the consequential execution boundary so revocation, expiry,
    // risk/policy contraction, approval changes and connectivity changes take
    // effect even when they occur after planning/authorization.
    assertAuthorityDecisionAllowsExecution(previous,{
      company_id,
      capability:capabilityName,
      worker_id:agent_id,
    });

    const parent=this.authorityStore?.latestDecisionForBinding
      ? await this.authorityStore.latestDecisionForBinding({
          company_id,worker_id:agent_id,capability:capabilityName,
          operation_id:operationId,
          action_id:actionId,
        })??previous
      : previous;
    const current=await this.contextResolver.evaluate({
      company_id,
      actor_id:previous.actor_id,
      agent_id,
      worker_type:previous.worker_type,
      surface:previous.surface,
      capability:capabilityName,
      operation_id:parent.operation_id??operationId,
      action_id:parent.action_id??actionId,
      run_id,
      idempotency_key,
      execution_mode:"autonomous",
      input,
      execution_input:input,
      authority_decision_id:`authority:${operationId}:${idempotencyKey}:execute:${randomUUID()}`,
      supersedes_authority_decision_id:parent.authority_decision_id,
      now:nextEvaluationTime(parent),
    });

    if(actor_id!==undefined&&actor_id!==current.actor_id)throw new Error("runtime-actor-mismatch");

    if(this.authorityStore?.appendDecision)await this.authorityStore.appendDecision(current);
    assertAuthorityDecisionAllowsExecution(current,{
      company_id,
      capability:capabilityName,
      worker_id:agent_id,
    });
    signal?.throwIfAborted();

    return this.executionGateway.execute({
      execution_id:`execution:${company_id}:${operationId}:${idempotencyKey}`,
      company_id,
      decision_id:current.authority_decision_id,
      actor_id:current.actor_id,
      supersedes_decision_id:parent.authority_decision_id,
      work_id,
      run_id,
      ...(correlation_id === undefined ? {} : {correlation_id}),
      agent_id,
      capability:capabilityName,
      input,
      idempotency_key:idempotencyKey,
      authority:{status:"approved",revalidated:true,evaluated_at:current.evaluated_at},
      risk:{status:current.evaluated_risk?.level==="critical"?"denied":"approved",...current.evaluated_risk},
      signal,
    });
  }
}
